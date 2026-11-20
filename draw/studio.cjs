// The Draw studio of JDesign. JV's electron/main.cjs owns the app, the window
// and the single-instance lock; it calls init() here, and this module puts
// JDraw's renderer in a view inside that window.
const { app, WebContentsView, ipcMain, dialog, shell, clipboard, nativeImage } = require("electron");
const CLIP_MARK = "jdraw-items:";
const path = require("node:path");
const fs = require("node:fs");
const { DrawingStore, titleFor } = require("./lib/store.cjs");
const { createMcpServer } = require("./lib/mcp-server.cjs");
const { CATALOG, detectAgents, AgentSession, REVIEW_BRIEF } = require("./lib/acp.cjs");
const SlopCheck = require("./lib/slop-check.cjs");
const Finish = require("./lib/finish.cjs");
const G = require("./renderer/js/geom.js");

// Draw's own hidden smoke (renderer/js/smoke.js) runs with --draw-smoke, so
// JV's --smoke keeps meaning the video studio.
const SMOKE = process.argv.includes("--draw-smoke");
const DRIVE = false;
const DEV = process.env.JDESIGN_DEV === "1" || process.env.JEDITOR_DEV === "1";

let dataDir = null; // set by init(): <JDesign data>/draw
let logFile = null;
let hostWin = null; // JV's main window
let view = null; // the WebContentsView that shows Draw inside it
let win = null; // shim over the view so the code below reads as before
let viewShown = false;
let onSwitch = () => {};
let hostApi = {};
let themeHost = { getThemeMode: () => null, setThemeMode: () => {} };
let onSmokeExit = (code) => app.exit(code);
let store = null;
let mcp = null;
let agentsCache = null;
const sessions = new Map(); // chatId -> AgentSession
const contexts = new Map(); // docId -> { brush, selection }
const turnSnapshots = new Map(); // docId -> snapshot before the last AI turn
const chats = new Map(); // chatId -> live chat row { id, drawingId, title, agent, model, acpSessionId, messages }
const turnBusy = new Set(); // docIds with a turn running on any chat
const renderWaits = new Map();
let renderSeq = 0;
const gating = new Set(); // docIds whose turn is in the slop check loop
const gateStop = new Set(); // docIds whose loop the person stopped
const reviewers = new Map(); // docId -> reviewer AgentSession while it runs
const lastChecks = new Map(); // docId -> result of the last gate

function log(line) {
  const text = `${new Date().toISOString()} ${line}\n`;
  try { if (logFile) fs.appendFileSync(logFile, text); } catch {}
  if (SMOKE) process.stdout.write(text);
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// The drawing's chat threads live in the store; the map keeps the live copy
// that streaming events append to. chatId picks one thread; without it the
// drawing's active chat answers.
function chatFor(docId, chatId) {
  const row = chatId ? store.chatById(chatId) : store.getChat(docId);
  if (!row) return { id: "", drawingId: docId, title: "New chat", agent: null, model: null, acpSessionId: "", messages: [] };
  let chat = chats.get(row.id);
  if (!chat) {
    chat = row;
    chats.set(chat.id, chat);
  }
  return chat;
}

function sessionOf(docId) {
  return sessions.get(chatFor(docId).id) || null;
}

// Any agent session on the drawing that is mid-turn, no matter which chat
// owns it: two chats must not draw on one canvas at the same time.
function busySessionOn(docId) {
  for (const s of sessions.values()) if (s.docId === docId && s.busy) return s;
  return null;
}

function viewDrawing(docId, opts) {
  return new Promise((resolve, reject) => {
    if (!win || win.isDestroyed()) return reject(new Error("The JDraw window is closed."));
    const reqId = ++renderSeq;
    const timer = setTimeout(() => { renderWaits.delete(reqId); reject(new Error("The canvas did not answer in time. Is the drawing still open?")); }, 30000);
    renderWaits.set(reqId, { resolve, reject, timer });
    send("render:request", { reqId, docId, opts: opts || {} });
  });
}

async function agents(refresh) {
  if (!agentsCache || refresh) agentsCache = await detectAgents();
  return agentsCache;
}

async function sessionFor(docId, agentId, chatId) {
  let s = sessions.get(chatId);
  if (s && s.agent.id !== agentId) {
    s.stop();
    sessions.delete(chatId);
    s = null;
  }
  if (s) return s;
  const list = await agents();
  const found = list.find((a) => a.id === agentId);
  const spec = CATALOG.find((a) => a.id === agentId);
  if (!spec) throw new Error("Unknown agent.");
  if (!found || !found.installed) throw new Error(`${spec.name} is not installed on this PC. Install it with: ${spec.install}`);
  const chat = chatFor(docId, chatId);
  s = new AgentSession({
    docId,
    chatId: chat.id,
    agent: Object.assign({}, spec, { path: found.path }),
    workDir: path.join(dataDir, "agent-work", docId),
    mcpEntry: mcp.acpEntry(docId),
    // A reopened chat reloads its saved ACP session or replays its messages.
    wantSessionId: chat.acpSessionId,
    history: chat.messages.slice(),
    log: (l) => log(`[${docId}] ${l}`),
    emit: (ev) => onAgentEvent(docId, chat.id, ev),
  });
  sessions.set(chat.id, s);
  return s;
}

// The agent's own session id lands on the chat row so a later open reloads it.
function persistSessionId(chat, s) {
  if (!chat || !s || !s.sessionId || chat.acpSessionId === s.sessionId) return;
  chat.acpSessionId = s.sessionId;
  store.updateChat(chat.id, { acpSessionId: s.sessionId });
}

// The artist finish (lib/finish.cjs): color grade, painted edges, paper.
// Items that were on the drawing before the agent's turn, that no agent
// made, are the person's: the finish and the checker leave them alone.
const personItems = new Map(); // docId -> Set of item ids
const personTouched = new Set(); // docIds the person edited while the gate ran
const knownIds = new Map(); // docId -> ids on the drawing after the last change
const turnPrompts = new Map(); // docId -> what the person asked for this turn
function allIds(doc) {
  return doc.layers.flatMap((l) => l.items.map((i) => i.id));
}
function notePersonItems(docId) {
  const doc = store.getDoc(docId);
  const agent = new Set(doc.agentItems || []);
  personItems.set(docId, new Set(allIds(doc).filter((id) => !agent.has(id))));
  knownIds.set(docId, new Set(allIds(doc)));
}
// After a turn: everything new on the drawing was made by the agent.
function noteAgentItems(docId) {
  const doc = store.getDoc(docId);
  const person = personItems.get(docId) || new Set();
  const agent = allIds(doc).filter((id) => !person.has(id));
  if (JSON.stringify(agent) !== JSON.stringify(doc.agentItems || [])) store.apply(docId, [{ op: "set_doc", agentItems: agent }], "agent");
}

// Looks the agent may ask to turn the finish down for. Anything else (edges
// or grade off because its own drawing came out flat) is ignored: the work
// being judged does not get to switch off its own finish.
const CLEAN_LOOK = /\b(pixel art|pixel|low[\s-]?poly|blueprint|flat (vector|design|illustration|style|colou?rs?|graphic)|vector (art|style|illustration|graphic)|icon|logo|line art|diagram|ui|user interface|wireframe)\b/i;
// A clean look counts only when asked for, not when ruled out ("no pixel
// art", "not a logo", "without line art").
function askedCleanLook(prompt) {
  const re = new RegExp(CLEAN_LOOK.source, "gi");
  let m;
  while ((m = re.exec(prompt))) {
    const before = prompt.slice(Math.max(0, m.index - 24), m.index).toLowerCase();
    if (!/\b(no|not|never|without|avoid|don't|dont|nothing like|instead of)\b[^.,;]*$/.test(before)) return true;
  }
  return false;
}
// An icon or a logo gets the stock-mark rules; another clean look (a
// diagram, pixel art, flat vector) only the ones that hold for any clean
// work; everything else the full lint.
const MARK_LOOK = /\b(icons?|logos?|logotype|favicon|emblem)\b/i;
function lintModeFor(prompt) {
  if (!askedCleanLook(prompt)) return "full";
  const re = new RegExp(MARK_LOOK.source, "gi");
  let m;
  while ((m = re.exec(prompt))) {
    const before = prompt.slice(Math.max(0, m.index - 24), m.index).toLowerCase();
    if (!/\b(no|not|never|without|avoid|don't|dont|nothing like|instead of)\b[^.,;]*$/.test(before)) return "mark";
  }
  return "clean";
}
// Where the light in the picture is: the brightest patch of a small render
// (upper four fifths, where a sun, a glow or a lit sky sits). Canvas px.
async function sceneLight(docId) {
  const doc = store.getDoc(docId);
  // Measured once, and again whenever the items that carry the light (sky,
  // sun, glow) change, so a repainted sky moves the light with it.
  const skySig = (doc.layers || []).flatMap((l) => (l.visible === false ? [] : l.items || [])).filter((it) => /\b(sky|sun|moon|sunset|sunrise|dusk|dawn|glow)\b/i.test(it.name || "")).map((it) => it.id).join("|");
  if (doc.finished && Array.isArray(doc.finished.__light) && (doc.finished.__lightSky === undefined || doc.finished.__lightSky === skySig)) return null;
  let r;
  try { r = await viewDrawing(docId, { maxSize: 160 }); } catch { return null; }
  const img = r && r.base64 ? nativeImage.createFromBuffer(Buffer.from(r.base64, "base64")) : null;
  if (!img || img.isEmpty()) return null;
  const { width: w, height: h } = img.getSize();
  const px = img.toBitmap(); // BGRA
  // Big cells first, so one white object (a tower, a cloud rim) cannot
  // outshine a glow that fills a whole part of the sky.
  const lum = (x, y) => { const i = (y * w + x) * 4; return 0.0722 * px[i] + 0.7152 * px[i + 1] + 0.2126 * px[i + 2]; };
  const gx = 5, gy = 4, sums = new Float64Array(gx * gy), counts = new Float64Array(gx * gy);
  const yMax = Math.floor(h * 0.8);
  for (let y = 0; y < yMax; y++) for (let x = 0; x < w; x++) {
    const cell = Math.min(gy - 1, Math.floor((y / h) * gy)) * gx + Math.min(gx - 1, Math.floor((x / w) * gx));
    sums[cell] += lum(x, y);
    counts[cell]++;
  }
  let best = -1, at = 0;
  for (let k = 0; k < sums.length; k++) if (counts[k] && sums[k] / counts[k] > best) { best = sums[k] / counts[k]; at = k; }
  // Then the centre of the brightest tenth of that cell.
  const x0 = Math.floor(((at % gx) / gx) * w), x1 = Math.floor((((at % gx) + 1) / gx) * w);
  const y0 = Math.floor((Math.floor(at / gx) / gy) * h), y1 = Math.min(yMax, Math.floor(((Math.floor(at / gx) + 1) / gy) * h));
  const vals = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) vals.push(lum(x, y));
  vals.sort((a, b) => a - b);
  const cut = vals[Math.floor(vals.length * 0.9)] || 0;
  let sx = 0, sy = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (lum(x, y) >= cut) { sx += x; sy += y; n++; }
  if (!n) return null;
  return { x: ((sx / n + 0.5) / w) * doc.width, y: ((sy / n + 0.5) / h) * doc.height, sky: skySig };
}

function finishDrawing(docId, opts, fromAgent, extra) {
  const doc = store.getDoc(docId);
  const asked = Object.assign({}, opts || {});
  if (fromAgent && !askedCleanLook(turnPrompts.get(docId) || "")) {
    delete asked.edges; delete asked.grain; delete asked.grade;
    // A very light touch is the same as turning it off.
    if (asked.strength !== undefined) asked.strength = Math.max(0.7, Number(asked.strength) || 1);
  }
  const use = Object.assign({}, doc.finishOpts || {}, asked);
  const { ops, stats } = Finish.finishOps(doc, Object.assign({}, use, extra || {}), personItems.get(docId) || null);
  if (Object.keys(asked).length && JSON.stringify(use) !== JSON.stringify(doc.finishOpts || {})) ops.push({ op: "set_doc", finishOpts: use });
  if (ops.length) store.apply(docId, ops, "agent");
  log(`[${docId}] finish ${JSON.stringify(Object.assign({ options: use, ignored: Object.keys(opts || {}).filter((k) => !(k in asked)) }, stats))}`);
  return Object.assign({ changed: ops.length > 0, options: use }, stats);
}

// The checker's row rule groups shapes by their bottom edge, so the parts
// of one object (sail fragments, windows, small pieces that share a
// baseline) are reported as objects standing in a row. Distinct objects in
// a row stand side by side; fragments of one object overlap. Drop the issue
// when the boxes' union is much narrower than their summed widths.
function fragmentRow(issue) {
  if (!issue || issue.rule !== "row") return false;
  const boxes = [...String(issue.where || "").matchAll(/x (-?\d+) y (-?\d+) \((\d+)x(\d+)\)/g)].map((m) => ({ x: +m[1], w: +m[3] }));
  if (boxes.length < 3) return false;
  const union = Math.max(...boxes.map((b) => b.x + b.w)) - Math.min(...boxes.map((b) => b.x));
  const sum = boxes.reduce((n, b) => n + b.w, 0);
  return union < 0.7 * sum;
}

async function checkDrawing(docId) {
  const asked = turnPrompts.get(docId) || "";
  const r = await SlopCheck.checkDrawing(store.getDoc(docId), () => viewDrawing(docId, { maxSize: 1024 }), personItems.get(docId) || null, { ask: asked, clean: askedCleanLook(asked) });
  if (r && Array.isArray(r.issues)) {
    r.issues = r.issues.filter((i) => !fragmentRow(i));
    if (!r.issues.length && !r.ok) r.ok = true;
  }
  return r;
}

// Reads the reviewer's closing JSON block:
// { clean, issues: [{ what, where, box: [x, y, w, h], ids, severity, fix }] }.
function parseReview(text) {
  const blocks = [...String(text).matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  const last = String(text).search(/\{\s*"clean"[\s\S]*$/);
  if (last >= 0) blocks.push(String(text).slice(last));
  for (const b of blocks.reverse()) {
    try {
      const j = JSON.parse(b.trim());
      if (typeof j.clean === "boolean") {
        const issues = (Array.isArray(j.issues) ? j.issues : []).map((i) => Object.assign({}, i, { severity: Math.max(1, Math.min(3, Math.round(Number(i.severity) || 2))) }));
        return { clean: j.clean && !issues.length, issues };
      }
    } catch {}
  }
  return null;
}

// A fresh agent (same kind and model as the drawer) looks at the drawing
// with read-only tools and lists what still looks generated. It gets its
// own earlier list, so it says what was fixed instead of starting over.
// Its permission filter only allows the look-only jdraw tools.
async function reviewDrawing(docId, drawer, previous, checkerNotes, fixedEffort) {
  const id = `${docId}-review-${Date.now()}`;
  let text = "";
  const rv = new AgentSession({
    docId,
    agent: drawer.agent,
    workDir: path.join(dataDir, "agent-work", docId + "-review"),
    mcpEntry: mcp.acpEntry(docId),
    brief: REVIEW_BRIEF,
    allowTools: ["view_drawing", "get_drawing", "get_style", "list_styles"],
    log: (l) => log(`[${docId} review] ${l}`),
    emit: (ev) => {
      if (ev.type === "text") text += ev.text;
      if (ev.type === "error") log(`[${docId} review] error: ${ev.message}`);
    },
  });
  reviewers.set(docId, rv);
  try {
    await rv.start();
    const model = drawer.models && drawer.models.current;
    if (model) try { await rv.setModel(model); } catch (err) { log(`[${docId} review] model: ${err.message}`); }
    // Same strictness every round: the effort from before the gate raised it.
    const effort = fixedEffort || (drawer.effort && drawer.effort.current);
    if (effort) try { await rv.setEffort(effort); } catch (err) { log(`[${docId} review] effort: ${err.message}`); }
    const doc = store.getDoc(docId);
    let ask = `Review the drawing now. The canvas is ${doc.width}x${doc.height}.`;
    if (previous && previous.length) {
      ask += "\n\nYour last review listed these. The drawer has tried to fix one of them. Check each one first: leave it out if it is fixed; if it is still there, keep it with \"was\": its number below and \"change\": \"better\", \"same\" or \"worse\" compared with last time (judge the object as it is now, not your old words). Then add at most two new ones, only if they are worse than what is left.\n" + previous.map((i, n) => `${n + 1}. ${i.what}${i.where ? ` (where: ${i.where})` : ""}`).join("\n");
    }
    if (checkerNotes && checkerNotes.length) {
      ask += "\n\nJDraw's measuring script also flagged these. Include one only if you can see it is a real tell; leave out parts of objects (rails, window bars, masts, stripes):\n" + checkerNotes.map((i, n) => `${n + 1}. ${i.rule ? `[rule: ${i.rule}] ` : ""}${i.what}${i.where ? ` (where: ${i.where})` : ""}`).join("\n") + "\nWhen you include one, copy its rule into that issue as \"rule\": \"...\".";
    }
    const lookMode = lintModeFor(turnPrompts.get(docId) || "");
    if (lookMode !== "full") {
      ask += `\n\nThe person asked for ${lookMode === "mark" ? "an icon or a logo" : "a clean graphic look"}: "${(turnPrompts.get(docId) || "").slice(0, 300)}". Flat fills, plain geometric shapes, even outlines, symmetry and a centered mark are meant here, so do not report them. Report what is still a tell in clean work: ${lookMode === "mark" ? "the stock marks (a four-point sparkle, an orbit ring, a single letter in a rounded tile, a swoosh, a purple or pink gradient), " : "a four-point sparkle, "}parts that do not join, spacing or line weights that look like mistakes, text that reads as generated, and a mark that says nothing about its subject.`;
    }
    await rv.prompt(ask, null, false);
    if (!parseReview(text)) {
      log(`[${docId} review] no verdict in ${text.length} chars: ${JSON.stringify(text.slice(-300))}`);
      text = "";
      await rv.prompt("Send your verdict again as only the JSON block, in the form {\"clean\": false, \"issues\": [{\"what\": \"...\", \"where\": \"...\", \"box\": [x, y, w, h], \"ids\": [\"...\"], \"severity\": 3, \"fix\": \"...\"}]}. Nothing else.", null, false);
    }
  } catch (err) {
    return { error: `The reviewer could not run: ${err.message}` };
  } finally {
    rv.stop();
    reviewers.delete(docId);
  }
  const parsed = parseReview(text);
  log(`[${id}] ${parsed ? (parsed.clean ? "clean" : parsed.issues.length + " issues") : "no verdict"}`);
  if (!parsed) return { error: "The reviewer did not give a verdict.", text: text.slice(-600) };
  return parsed;
}

function gateEvent(docId, label) {
  send("agent:event", { docId, type: "gate", label });
}

// The gate's check pass for a JV project chat turn: artist finish (when the
// look wants it), the pixel checker, then the read-only reviewer running as
// the same agent kind that drew. runGate's whole fix loop lives in JV's
// acp-host; this is one round of measure plus review.
async function checkProjectDrawing(docId, o) {
  o = o || {};
  const prompt = String(o.prompt || "");
  turnPrompts.set(docId, prompt);
  if (store.getPref("artistFinish", true) !== false && !askedCleanLook(prompt)) {
    try { finishDrawing(docId); } catch (err) { log(`[${docId}] finish failed: ${err.message}`); }
  }
  const checker = await checkDrawing(docId);
  if (!checker || checker.ok === null) return { ok: null, error: (checker && checker.error) || "The checker could not run." };
  const checkerIssues = Array.isArray(checker.issues) ? checker.issues : [];
  const drawer = pseudoDrawer(o.harnessId);
  const review = drawer ? await reviewDrawing(docId, drawer, o.previous || null, checkerIssues, null) : { clean: checkerIssues.length === 0, issues: [] };
  if (review && review.error) return { ok: null, error: review.error };
  const issues = checkerIssues.concat((review && review.issues) || []).map((i) => ({ what: i.what || i.issue || "Issue", where: i.where || "", fix: i.fix || "" }));
  const row = store.list().find((d) => d.id === docId);
  return { ok: issues.length === 0, issues, name: (row && row.name) || "Drawing" };
}

// A JV harness id is not one of Draw's CATALOG ids, so the reviewer runs as
// the drawer's own kind when it matches and falls back to the first catalog
// agent installed here.
function pseudoDrawer(harnessId) {
  const spec = CATALOG.find((a) => a.id === harnessId) || CATALOG.find((a) => a.id === "claude-code") || CATALOG[0];
  if (!spec) return null;
  return { agent: spec, models: null, effort: null };
}

// Canvas-pixel box of an issue: the reviewer's box [x, y, w, h], else a
// "where" text like "x 940-1465 y 175-455" or "x 410 y 1040 (300x60)".
function issueBox(issue) {
  if (Array.isArray(issue.box) && issue.box.length === 4 && issue.box.every((v) => Number.isFinite(Number(v)))) {
    const [x, y, w, h] = issue.box.map(Number);
    return [x, y, x + w, y + h];
  }
  const w = String(issue.where || "");
  let m = w.match(/x\s*(-?\d+)\s*[-–]\s*(-?\d+)[,\s]+y\s*(-?\d+)\s*[-–]\s*(-?\d+)/i);
  if (m) return [+m[1], +m[3], +m[2], +m[4]];
  if ((m = w.match(/x\s*(-?\d+)\s*y\s*(-?\d+)\s*\((\d+)x(\d+)\)/i))) return [+m[1], +m[2], +m[1] + +m[3], +m[2] + +m[4]];
  return null;
}

// Where an item's drawing really is, in canvas px. Agents often place each
// object on a full-canvas SVG, so for SVG images this measures the shapes
// inside instead of the item's box.
// A sky or sea never covers the picture: a field that sits above an object
// in the stack moves under the first object, skies below seas. Run 25
// ended as a sky over everything because a redrawn sky landed on top.
function fieldsUnder(docId) {
  try {
    const d = store.getDoc(docId);
    const person = personItems.get(docId) || new Set();
    // Only what the agent drew and the person can see.
    const flat = d.layers.filter((l) => l.visible !== false).flatMap((l) => l.items.filter((it) => !it.hidden && !person.has(it.id) && !Finish.isPaper(it)).map((it) => ({ it, layerId: l.id })));
    if (!flat.length) return 0;
    // A sky draws its background as one canvas-wide rect, which the content
    // measure skips, so a sky or sea is known by its name too.
    const named = (it) => /\b(sky|skies|sea|ocean|water)\b/i.test(it.name || "") && !/\b(rocks?|boats?|ships?|birds?|gulls?|lighthouse|cliffs?|foam|spray|surf|glints?|sparkles?|reflections?|splash|clouds?|sun|moon|stars?|glow|mist|haze)\b/i.test(it.name || "") && (it.w || 0) >= 0.5 * d.width;
    const isField = (e) => named(e.it) || (!/\b(clouds?|glow|sun|moon|stars?|mist|haze|birds?|gulls?)\b/i.test(e.it.name || "") && !!(contentBox(d, e.it) || {}).field);
    const isSky = (e) => /\b(sky|skies)\b/i.test(e.it.name || "") && !/\b(clouds?|glow|sun|moon|stars?|birds?|gulls?|mist|haze)\b/i.test(e.it.name || "") && (e.it.w || 0) >= 0.5 * d.width;
    // A sky above anything that is not sky goes to the very bottom.
    const skies = flat.filter((e, k) => isSky(e) && flat.slice(0, k).some((o) => !isSky(o)));
    // A sea or other field above an object goes under the first object.
    const first = flat.findIndex((e) => !isField(e));
    const rest = first < 0 ? [] : flat.filter((e, k) => k > first && isField(e) && !isSky(e));
    if (!skies.length && !rest.length) return 0;
    const ops = [];
    if (rest.length) {
      const tgt = flat[first], layer = d.layers.find((l) => l.id === tgt.layerId);
      ops.push({ op: "place_items", ids: rest.map((e) => e.it.id), layerId: tgt.layerId, index: layer.items.findIndex((i) => i.id === tgt.it.id) });
    }
    if (skies.length) ops.push({ op: "place_items", ids: skies.map((e) => e.it.id), layerId: flat[0].layerId, index: 0 });
    store.apply(docId, ops, "agent");
    log(`[${docId}] moved ${skies.concat(rest).map((e) => e.it.name).join(", ")} under the objects`);
    return skies.length + rest.length;
  } catch (err) { log(`[${docId}] fieldsUnder: ${err.message}`); return 0; }
}
function contentBox(doc, it) {
  try {
    if (it.type === "image") {
      const svg = Finish.unpaintEdges(Finish.decodeSvg(it.src) || "");
      if (svg) {
        const m = svg.match(/viewBox\s*=\s*["']\s*([-\d.]+)[\s,]+([-\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
        const vb = m ? { x: +m[1], y: +m[2], w: +m[3], h: +m[4] } : { x: 0, y: 0, w: it.w, h: it.h };
        const c = Finish.contentOf(svg, it, vb, doc.width, doc.height);
        return { x: c.x, y: c.y, w: c.w, h: c.h, field: c.field };
      }
    }
    const b = G.bounds(it);
    return b ? { x: b.x, y: b.y, w: b.w, h: b.h, field: b.w >= 0.9 * doc.width && b.h >= 0.4 * doc.height } : null;
  } catch { return null; }
}

// The agent's items an issue is about. The reviewer's named ids come first
// (a named sky or sea can be replaced too, one at a time); a whole-scene
// issue (light, composition) deletes nothing unless it names a field; else
// the agent items whose drawing lies mostly inside the issue's box. Ids
// another open issue names are left alone.
function itemsFor(docId, issue, others = []) {
  const doc = store.getDoc(docId);
  const person = personItems.get(docId) || new Set();
  const canvas = doc.width * doc.height;
  const all = [];
  for (const l of doc.layers) {
    if (l.visible === false || l.paper) continue;
    for (const it of l.items) if (!person.has(it.id) && !Finish.isPaper(it)) all.push(it);
  }
  const byId = new Map(all.map((it) => [it.id, it]));
  const box = issueBox(issue);
  const boxArea = box ? Math.max(1, (box[2] - box[0]) * (box[3] - box[1])) : canvas;
  const scene = !box || boxArea > 0.5 * canvas;
  const elsewhere = new Set(others.filter((o) => o !== issue).flatMap((o) => (Array.isArray(o.ids) ? o.ids : [])));
  const info = (it) => { const c = contentBox(doc, it); return c ? Object.assign(c, { area: c.w * c.h }) : null; };
  const holds = (c) => !!box && !!c && c.x >= box[0] - 0.05 * (box[2] - box[0]) && c.y >= box[1] - 0.05 * (box[3] - box[1]) && c.x + c.w <= box[2] + 0.05 * (box[2] - box[0]) && c.y + c.h <= box[3] + 0.05 * (box[3] - box[1]);
  const named = (Array.isArray(issue.ids) ? issue.ids : []).filter((id) => byId.has(id) && (!elsewhere.has(id) || (!scene && holds(info(byId.get(id)))))).map((id) => ({ it: byId.get(id), c: info(byId.get(id)) })).filter((x) => x.c);
  // A named object wins over a named field, so an issue about the boat
  // that also lists the sea redraws the boat, not the sea.
  // ...unless the issue is about the horizon or a field's edge: then the field is redrawn.
  const aboutField = /\b(horizon|sea|water|sky|ocean|field)\b/i.test(String(issue.what || "").split(/[.;:,]/)[0]);
  const sized = scene || aboutField ? [] : named.filter((x) => !x.c.field && x.c.area <= 4 * boxArea);
  if (sized.length) return sized.slice(0, 3).map((x) => ({ id: x.it.id, name: x.it.name || x.it.type }));
  const fields = named.filter((x) => x.c.field);
  if (fields.length) return [{ id: fields[0].it.id, name: fields[0].it.name || "field", field: true }];
  if (scene) return [];
  const out = [];
  for (const it of all) {
    if (elsewhere.has(it.id)) continue;
    const c = info(it);
    if (!c || c.field || c.area > 4 * boxArea) continue;
    const ix = Math.min(c.x + c.w, box[2]) - Math.max(c.x, box[0]), iy = Math.min(c.y + c.h, box[3]) - Math.max(c.y, box[1]);
    if (ix > 0 && iy > 0 && ix * iy >= 0.5 * Math.max(1, c.area)) out.push({ id: it.id, name: it.name || it.type });
  }
  return out.slice(0, 4);
}

// The same problem keeps one id between rounds even when the reviewer
// rewords it: lib/gate-match.cjs matches by the checker's rule id, then by
// where the issue is, then by the item ids and the thing it is about.
const GateMatch = require("./lib/gate-match.cjs");
// Stock clouds JDraw left out, and draw-time refusals, during a gate fix turn.
const leftOut = new Map(); // docId -> names
const refusedIn = new Map(); // docId -> count
const roundScore = (issues) => issues.reduce((sum, i) => sum + (i.severity || 2), 0);
// A state is worse when its worst problem is worse; only then by total
// score. Comparing by score alone restores a round with one severe,
// known-bad object (a bad cliff or tower) over a round with two small
// problems, and ships the known-bad object.
const worstOf = (issues) => issues.reduce((m, i) => Math.max(m, i.severity || 2), 0);
const worseThan = (a, b) => worstOf(a) !== worstOf(b) ? worstOf(a) > worstOf(b) : roundScore(a) > roundScore(b);
function iou(a, b) {
  if (!a || !b) return 0;
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]), h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter);
}
// A redraw stays unless the reviewer says that problem got worse (a "same"
// redraw stays too; the gate gives it one more try, then counts it failed).
function redrawFailed(still, pick) {
  if (!still) return false;
  const change = String(still.change || "").toLowerCase();
  if (change === "better") return false;
  if (change === "same") return false;
  if (change === "worse") return true;
  return (still.severity || 2) >= (pick.severity || 2);
}

// A fixed recipe for any rock redraw, so the drawer gets concrete steps instead of a general wish for "less facets".
const ROCK_RECIPE = "\n\nRock recipe (follow each step): 1) outline one closed path of 14 or more points with uneven spacing, a ledge that steps out and back, and no edge longer than 15% of the canvas width. 2) fill it with a mid tone. 3) add 2 to 3 more closed paths inside it, each a different size, each a lighter tone on the sun side, with its own uneven outline (not a straight edge). 4) add 3 to 5 cracks as single open curved strokes, following the rock's layers. 5) at the waterline, a broken band of foam or wet darker rock, several pieces, never one smooth stripe.";

// Runs after a turn that changed the drawing: finish, checker, reviewer.
// One object per round goes back to the drawer with its old items removed.
// Each redraw is judged on its own: if the next review still finds that
// problem (as bad or worse), JDraw puts the old object back; otherwise the
// redraw stays. It ends when the drawing passes, the rounds run out, or
// three redraws in a row fixed nothing (put back, or kept as "same").
async function runGate(docId, s, chat) {
  const maxFix = Number(process.env.JDRAW_GATE_ROUNDS) || 6;
  // A logo, an icon, a diagram or pixel art keeps its clean edges: painted
  // outlines and paper grain on a mark are a flaw, not a finish.
  const finishOn = store.getPref("artistFinish", true) !== false && !askedCleanLook(turnPrompts.get(docId) || "");
  const doc0 = store.getDoc(docId);
  const history = [];
  // One id per problem for the whole gate run, so the counts below follow
  // the problem through reworded reviews.
  const matchCtx = { box: issueBox, canvasArea: doc0.width * doc0.height };
  const problems = GateMatch.tracker(matchCtx);
  const issueKey = (i) => problems.idOf(i);
  const sent = new Map(); // issueKey -> times sent to the drawer
  const refunded = new Set();
  const sameOnce = new Set(); // issueKeys whose redraw already came back "same" once
  let lastReview = null;
  let pending = null; // { pick, snap, issues, checker }
  let reuse = null; // the review to use again after a redraw was put back
  let failed = 0;
  let best = null; // { score, snap }: the best-reviewed state, restored if the gate ends worse
  personTouched.delete(docId);
  // Fix turns think harder; the person's own setting comes back after.
  const effortBefore = s.effort && s.effort.current;
  const fixEffort = s.effort && s.effort.available && ["high", "xhigh", "max"].find((e) => s.effort.available.some((o) => o.id === e));
  let raised = false;
  const putBack = (snap, why) => {
    if (personTouched.has(docId)) { log(`[${docId}] gate: the person edited the drawing, not putting back (${why})`); return false; }
    store.restore(docId, snap, "agent");
    log(`[${docId}] gate put the old version back: ${why}`);
    // The reply just above describes the discarded redraw, not the canvas.
    chat.messages.push({ role: "user", auto: true, text: `JDraw put the earlier version back: ${why}.`, at: Date.now() });
    store.saveChat(chat);
    send("agent:event", { docId, chatId: chat.id, type: "chat", chat });
    return true;
  };
  const end = async (r) => {
    try { fieldsUnder(docId); } catch {}
    if (raised && effortBefore) try { await s.setEffort(effortBefore); } catch {}
    // A gate that ends not clean keeps the best state any review saw.
    // Only issues that review also had count, so a late new finding does not undo the fix turns.
    if (r && r.ok === false && !r.stopped && best && Array.isArray(r.issues) && worseThan(r.issues, best.issues) && putBack(best.snap, `the best version the reviewer saw (score ${best.score})`)) {
      history.push({ stage: "restored", score: best.score, issues: best.issues });
      r = Object.assign({}, r, { issues: best.issues, restoredBest: best.score });
    }
    return r;
  };
  for (let fixes = 0; ; fixes++) {
    if (gateStop.has(docId)) return end({ ok: false, stopped: true, rounds: fixes, history });
    fieldsUnder(docId);
    let issues, checkerIssues;
    if (reuse) {
      ({ issues, checker: checkerIssues } = reuse);
      reuse = null;
    } else {
      // The finish runs first, so the checker and reviewer judge what the person sees.
      if (finishOn) {
        gateEvent(docId, "The artist finish");
        const lightAt = await sceneLight(docId);
        if (lightAt) log(`[${docId}] scene light at ${Math.round(lightAt.x)},${Math.round(lightAt.y)}`);
        try { finishDrawing(docId, null, false, lightAt ? { lightAt } : null); } catch (err) { log(`[${docId}] finish failed: ${err.message}`); }
      }
      gateEvent(docId, "The slop check");
      const c = await checkDrawing(docId);
      if (c.ok === null) return end({ ok: null, error: c.error, rounds: fixes, history });
      const glowX = (() => { const d = store.getDoc(docId); const L = d.finished && d.finished.__light; return Array.isArray(L) ? (100 * L[0]) / d.width : null; })();
      const ownGlow = (i) => { if (i.rule !== "half-sun" || glowX === null) return false; const m = String(i.where || "").match(/x (\d+)-(\d+)%/); return !!m && glowX >= +m[1] - 4 && glowX <= +m[2] + 4; };
      checkerIssues = c.issues.filter((i) => !ownGlow(i)).map((i) => ({ what: i.title + ". " + i.detail, where: i.where, fix: i.fix, rule: i.rule }));
      if (gateStop.has(docId)) return end({ ok: false, stopped: true, rounds: fixes, history });
      gateEvent(docId, "The reviewer");
      const review = await reviewDrawing(docId, s, lastReview, checkerIssues, effortBefore);
      if (review.error) return end({ ok: null, error: review.error, rounds: fixes, history });
      // "was" numbers count in the list the reviewer was shown, so problem
      // ids are given before the sort.
      GateMatch.attachRules(review.issues, checkerIssues, matchCtx);
      problems.assign(review.issues, lastReview);
      issues = review.issues.slice().sort((a, b) => (b.severity || 2) - (a.severity || 2)).slice(0, 6);
      if (!issues.length && !review.clean) {
        history.push({ stage: "reviewer", issues: [], checker: checkerIssues });
        return end({ ok: null, error: "The reviewer said the drawing is not clean but listed nothing.", rounds: fixes, history });
      }
      // Judge the last redraw on its own.
      let reverted = false;
      if (pending) {
        const still = problems.find(issues, pending.pick);
        if (redrawFailed(still, pending.pick) && putBack(pending.snap, `the redraw did not fix "${pending.pick.what}"`)) {
          history.push({ stage: "reviewer", issues, checker: checkerIssues, reverted: pending.pick.what, score: roundScore(issues) });
          issues = pending.issues;
          checkerIssues = pending.checker;
          failed++;
          reverted = true;
        } else if (still && String(still.change || "").toLowerCase() === "same") {
          const k = issueKey(pending.pick);
          if (sameOnce.has(k)) { sent.set(k, 3); failed++; }
          else { sameOnce.add(k); sent.set(k, 2); log(`[${docId}] gate: the redraw of "${pending.pick.what.slice(0, 60)}" came back the same; it gets one more try`); }
        } else {
          failed = 0;
        }
        pending = null;
      }
      lastReview = issues;
      if (!issues.length) {
        history.push({ stage: "reviewer", issues: [], checker: checkerIssues });
        return end({ ok: true, rounds: fixes, history });
      }
      if (!reverted) history.push({ stage: "reviewer", issues, checker: checkerIssues, score: roundScore(issues) });
      // Ties keep the later state, so fix turns that only uncovered a new issue are not thrown away.
      // A state that drops drawn items is not a better state: deleting the
      // lighthouse or the headland lowers the issue count, so it must not win.
      const itemCount = (() => { try { return store.getDoc(docId).layers.reduce((n, l) => n + ((l.items || []).length), 0); } catch { return 0; } })();
      if (!reverted && (!best || (itemCount >= best.count && !worseThan(issues, best.issues)))) best = { score: roundScore(issues), snap: store.checkpoint(docId), issues, keys: new Set(issues.map(issueKey)), count: itemCount };
    }
    const stage = "reviewer";
    log(`[${docId}] gate round ${fixes + 1}: ${issues.length} issues (score ${roundScore(issues)}), ${failed} redraws in a row that fixed nothing`);
    if (fixes >= maxFix) return end({ ok: false, stage, issues, rounds: fixes, history });
    if (failed >= 3) { log(`[${docId}] gate stopped: 3 redraws in a row did not fix their problem`); return end({ ok: false, stage, issues, rounds: fixes, history, stalled: true }); }

    // One object per round: the worst problem first, and it keeps the
    // rounds until it is fixed or has had three tries. Only severity 1
    // extras are ever left out of the picture.
    const open = issues.filter((i) => (sent.get(issueKey(i)) || 0) < 3);
    if (!open.length) { log(`[${docId}] gate stopped: every problem has had its tries`); return end({ ok: false, stage, issues, rounds: fixes, history, stalled: true }); }
    // Every open problem gets one try before any gets a second, so one
    // stubborn object cannot use up all the rounds.
    const pick = open.slice().sort((a, b) => (sent.get(issueKey(a)) || 0) - (sent.get(issueKey(b)) || 0) || (b.severity || 2) - (a.severity || 2))[0];
    const times = sent.get(issueKey(pick)) || 0;
    sent.set(issueKey(pick), times + 1);
    // Only small extras (severity 1) are ever left out; the subject and
    // main objects (severity 2-3) are only redrawn.
    const removeOnly = times >= 2 && (pick.severity || 2) < 2;
    const items = itemsFor(docId, pick, issues);
    const snap = store.checkpoint(docId);
    let removed = [];
    // Where the old object sat in the stack, so the redraw takes its place.
    let slot = null;
    if (items.length) {
      const d0 = store.getDoc(docId);
      const gone = new Set(items.map((i) => i.id));
      for (const l of d0.layers) {
        const k = l.items.findIndex((it) => gone.has(it.id));
        // Index among the items that stay, since the old ones are deleted first.
        if (k >= 0) { slot = { layerId: l.id, index: l.items.slice(0, k).filter((it) => !gone.has(it.id)).length }; break; }
      }
    }
    if (items.length) {
      // JDraw deletes the old object itself, so it cannot be patched.
      try { store.apply(docId, [{ op: "delete_items", ids: items.map((i) => i.id) }], "agent"); removed = items; } catch (err) { log(`[${docId}] gate delete failed: ${err.message}`); }
    }
    const box = issueBox(pick);
    const where = box ? `x ${Math.round(box[0])}-${Math.round(box[2])}, y ${Math.round(box[1])}-${Math.round(box[3])} (canvas pixels)` : pick.where || "";
    const gone = removed.length ? `JDraw removed the old version (${removed.map((r) => r.name).join(", ")}). ` : "";
    const fixText = removeOnly
      ? `The reviewer still finds this after two tries: ${pick.what}. ${gone}Leave it out of the picture, or replace it with something much simpler that fits. Where: ${where}. Then call view_drawing to check the area and reply in one short sentence.`
      : removed.some((r) => r.field)
      ? `The reviewer found this, the worst problem left: ${pick.what}.${pick.fix ? ` What to do: ${pick.fix}` : ""}\n\n${gone}Paint that whole field again with one draw_svg call over the full canvas (same name): soft gradual light from one light source, no hard bands or stripes, no stock shapes.${/\b(sea|water|ocean|lake|bay)\b/i.test(removed.filter((r) => r.field).map((r) => r.name).join(" ")) ? " Water is shaped, not a plain gradient: swells that grow larger and darker toward the front, an uneven far edge, and light on it only as broken glints under the light source." : ""}${/\b(layout|composition|empty|balance|props?|crowded|centered|placement)\b/i.test(pick.what + " " + (pick.fix || "")) ? " If the problem is the layout, you may also add one new object with draw_svg or move one object to fix it; change nothing else." : " Do not change anything else."} Then view_drawing and reply in one short sentence.`
      : !removed.length && !box
      ? `The reviewer found this across the whole picture: ${pick.what}.${pick.fix ? ` What to do: ${pick.fix}` : ""}\n\nFix it with the fewest changes (adjust colors, add one shared light, or replace one object with draw_svg). Then view_drawing and reply in one short sentence.`
      : `The reviewer found this, the worst problem left: ${pick.what}. Where: ${where}.${pick.fix ? ` What to do: ${pick.fix}` : ""}\n\n${gone}Draw that one object again from scratch with one draw_svg call (or with stroke items when this drawing is stroke-paint): plan its silhouette first, one outline path with many points following the real shape, attached to what it rests on, with light and shadow as planes that follow its form: several of different sizes, seams that bend and break, ledges and cracks, never two or three flat polygons split along straight lines. Do not change anything else. view_drawing cropped to the area to check it, then reply in one short sentence.${/\b(rocks?|rocky|cliffs?|crags?|headland|outcrop|boulders?|stones?|bluffs?)\b/i.test(`${pick.what} ${removed.map((r) => r.name).join(" ")}`) ? ROCK_RECIPE : ""}`;
    const note = `${removeOnly ? "Still there after two tries, so leaving it out" : "Redrawing the worst problem"}: ${pick.what}${removed.length ? ` (removed ${removed.length} item${removed.length === 1 ? "" : "s"})` : ""}`;
    chat.messages.push({ role: "user", auto: true, text: note, at: Date.now() });
    chat.messages.push({ role: "agent", agent: s.agent.name, text: "", tools: [], open: true, at: Date.now() });
    store.saveChat(chat);
    send("agent:event", { docId, chatId: chat.id, type: "chat", chat });
    if (fixEffort && !raised && !removeOnly) { try { raised = await s.setEffort(fixEffort); } catch (err) { log(`[${docId}] fix effort: ${err.message}`); } }
    const afterDelete = JSON.stringify(store.getDoc(docId).layers);
    leftOut.delete(docId);
    refusedIn.set(docId, 0);
    let res;
    try { res = await s.prompt(fixText, null, false); } catch (err) {
      if (removed.length) putBack(snap, "the fix turn failed");
      return end({ ok: null, error: err.message, rounds: fixes + 1, history });
    }
    if (gateStop.has(docId) || (res && res.stopReason === "cancelled")) {
      if (removed.length) putBack(snap, "the fix turn was stopped");
      return end({ ok: false, stopped: true, rounds: fixes + 1, history });
    }
    const added = JSON.stringify(store.getDoc(docId).layers) !== afterDelete;
    if (!added && !removeOnly) {
      // A redraw that drew nothing: put the old object back and try another problem.
      // JDraw left a stock cloud out on purpose: the removal stands.
      const left = leftOut.get(docId) || [];
      if (removed.length && left.length) {
        log(`[${docId}] gate: kept the removal, JDraw left out ${left.join(", ")}`);
        leftOut.delete(docId);
        history.push({ stage: "left-out", items: left });
        continue;
      } else if (removed.length) putBack(snap, "the fix turn drew nothing");
      else { log(`[${docId}] gate stopped: the fix turn changed nothing`); return end({ ok: false, stage, issues, rounds: fixes + 1, history, stalled: true }); }
      // A turn spent on draw-time refusals never got the object on the
      // canvas: its try and its round are given back, once per problem.
      if (!refunded.has(issueKey(pick)) && refusedIn.get(docId)) { refunded.add(issueKey(pick)); sent.set(issueKey(pick), times); fixes--; }
      else failed++;
      reuse = { issues, checker: checkerIssues };
      continue;
    }
    // The redraw takes the old object's place in the stack.
    if (slot && removed.length) {
      const before = new Set(JSON.parse(afterDelete).flatMap((l) => l.items.map((i) => i.id)));
      const person = personItems.get(docId) || new Set();
      const fresh = allIds(store.getDoc(docId)).filter((id) => !before.has(id) && !person.has(id));
      if (fresh.length) try { store.apply(docId, [{ op: "place_items", ids: fresh, layerId: slot.layerId, index: slot.index }], "agent"); } catch (err) { log(`[${docId}] gate place failed: ${err.message}`); }
    }
    if (!removeOnly) pending = { pick, snap, issues, checker: checkerIssues };
  }
}

function onAgentEvent(docId, chatId, ev) {
  if (ev.type === "done" && gating.has(docId)) ev = Object.assign({}, ev, { gating: true });
  const chat = chatFor(docId, chatId);
  const last = chat.messages[chat.messages.length - 1];
  const agentMsg = last && last.role === "agent" && last.open ? last : null;
  if (agentMsg) {
    if (ev.type === "text") {
      if (agentMsg.gap && agentMsg.text.trim()) agentMsg.text = agentMsg.text.trimEnd() + "\n\n";
      agentMsg.gap = false;
      agentMsg.text += ev.text;
    } else if (ev.type === "tool") {
      agentMsg.gap = true;
      const t = agentMsg.tools.find((x) => x.id === ev.id);
      if (t) { if (ev.title) t.title = ev.title; if (ev.status) t.status = ev.status; }
      else agentMsg.tools.push({ id: ev.id, title: ev.title || "Tool", status: ev.status || "pending" });
    } else if (ev.type === "done" || ev.type === "error") {
      agentMsg.open = false;
      if (ev.type === "error") agentMsg.error = ev.message;
      agentMsg.stopReason = ev.stopReason;
      agentMsg.finished = Date.now();
      store.saveChat(chat);
    }
  }
  if (ev.type === "status" && ev.state === "ready") {
    const s = sessions.get(chatId);
    if (s) persistSessionId(chat, s);
    if (s && ev.models && ev.models.available && ev.models.available.length) {
      const cache = store.getPref("modelCache", {});
      cache[s.agent.id] = ev.models;
      store.setPref("modelCache", cache);
    }
    if (s && ev.models) {
      const cache = store.getPref("effortCache", {});
      cache[s.agent.id] = ev.effort || null;
      store.setPref("effortCache", cache);
    }
  }
  if (ev.type === "error" || ev.type === "status") log(`[${docId}] agent ${ev.type}: ${ev.state || ""} ${ev.message || ""}`);
  send("agent:event", Object.assign({ docId, chatId }, ev));
}

const TOOL_LABELS = {
  view_drawing: "Looked at the drawing",
  get_drawing: "Read the layers",
  draw: "Drew",
  draw_svg: "Painted an illustration",
  edit_items: "Edited items",
  delete_items: "Removed items",
  recolor: "Recolored",
  set_palette: "Added colors",
  set_brush: "Set your brush",
  canvas: "Changed the canvas",
  layers: "Changed layers",
  arrange: "Arranged items",
  fill_area: "Filled an area",
  check_drawing: "Ran the slop check",
  finish_drawing: "Gave it the artist finish",
};

// Tools that mean a project drawing changed: each one leaves an artifact card
// in the project chat transcript.
const ARTIFACT_TOOLS = new Set(["new_drawing", "draw", "draw_svg", "draw_text", "draw_path", "fill_area", "erase_items", "edit_items", "arrange", "import_svg", "place_image", "remove_items", "merge_down", "finish_drawing", "canvas"]);

function createView() {
  if (SMOKE) return createSmokeWindow();
  view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  const wc = view.webContents;
  win = { get webContents() { return wc; }, isDestroyed: () => wc.isDestroyed() };
  hostWin.contentView.addChildView(view);
  view.setVisible(false);
  layoutView();
  hostWin.on("resize", layoutView);
  hostWin.on("maximize", layoutView);
  hostWin.on("unmaximize", layoutView);
  hostWin.on("enter-full-screen", layoutView);
  hostWin.on("leave-full-screen", layoutView);
  wc.loadFile(path.join(__dirname, "renderer", "index.html"), { query: { embedded: "1" } });
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  wc.on("will-navigate", (e) => e.preventDefault());
  wc.on("console-message", (e) => {
    const { level, message } = e;
    if (SMOKE || level === "error" || level === 3) log(`[renderer] ${message}`);
  });
  wc.on("render-process-gone", (_e, d) => log(`renderer gone: ${d.reason}`));
}

// The hidden smoke runs Draw in its own never-shown window, as JDraw always
// did: a view inside a window that is never shown gets no frames from
// Chromium, so the canvas would never measure itself. Everything else
// (IPC, store, MCP, agents, the renderer code) is the same code as in the app.
function createSmokeWindow() {
  const { BrowserWindow } = require("electron");
  // JDRAW_SMOKE_WIN=1100x720 runs the smoke in a smaller window.
  const size = /^(\d{3,4})x(\d{3,4})$/.exec(process.env.JDRAW_SMOKE_WIN || "") || [];
  const w = new BrowserWindow({
    width: Number(size[1]) || 1480,
    height: Number(size[2]) || 920,
    show: false,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true, backgroundThrottling: false, spellcheck: false },
  });
  const wc = w.webContents;
  win = { get webContents() { return wc; }, isDestroyed: () => wc.isDestroyed() };
  wc.loadFile(path.join(__dirname, "renderer", "index.html"));
  wc.on("will-navigate", (e) => e.preventDefault());
  wc.on("console-message", (e) => log(`[renderer] ${e.message}`));
  wc.on("render-process-gone", (_e, d) => log(`renderer gone: ${d.reason}`));
}

// The view is embedded in JV's project editor: the renderer measures its
// stage area and places the view there (draw-view:place). Hidden, it keeps
// running (an agent can still be drawing). The rail-wide fallback stays for
// the hidden smoke path.
const RAIL_WIDTH = 68;
let placedRect = null;
let placedDoc = "";
function layoutView() {
  if (!view || !hostWin || hostWin.isDestroyed()) return;
  if (placedRect) { view.setBounds(placedRect); return; }
  const [width, height] = hostWin.getContentSize();
  view.setBounds({ x: RAIL_WIDTH, y: 0, width: Math.max(0, width - RAIL_WIDTH), height });
}

// JV project editor -> this view's live position and which drawing it shows.
function placeView(opts) {
  const o = opts || {};
  const r = o.rect || null;
  if (!view || view.webContents.isDestroyed()) return false;
  if (!r || !(r.width > 20 && r.height > 20)) {
    placedRect = null;
    placedDoc = "";
    view.setVisible(false);
    viewShown = false;
    return false;
  }
  placedRect = { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  placedDoc = String(o.drawingId || "");
  view.setBounds(placedRect);
  view.setVisible(true);
  viewShown = true;
  if (placedDoc) send("doc:open", { id: placedDoc });
  return true;
}

// While a JV menu, dialog or palette is open it would sit under the canvas,
// so the view swaps for a still frame until the overlay closes.
async function freezeView() {
  if (!view || !placedRect || !viewShown) return null;
  try {
    const img = await view.webContents.capturePage();
    view.setVisible(false);
    return img.toDataURL();
  } catch {
    return null;
  }
}
function unfreezeView() {
  if (!view || !placedRect) return false;
  view.setBounds(placedRect);
  view.setVisible(true);
  viewShown = true;
  return true;
}

// JV side events the project editor listens for (jdraw:event).
function notifyApp(kind, payload) {
  try {
    if (hostWin && !hostWin.isDestroyed()) hostWin.webContents.send("jdraw:event", Object.assign({ kind }, payload || {}));
  } catch {}
}

// Tabs and project cards relist whenever a drawing appears, is renamed or goes.
function drawingsChanged() {
  send("drawings:changed", {});
  notifyApp("draw:list-changed", {});
}

// Drawings a project chat turn touched: the gate checks them and "undo agent
// changes" restores them. A doc is snapshotted the first time a turn mutates
// it; a drawing the turn created is deleted by the undo.
const projectTurns = new Map(); // projectId -> { changed:Set, created:Set, snaps:Map }
function projectTurn(projectId) {
  const pid = String(projectId || "");
  let t = projectTurns.get(pid);
  if (!t) { t = { changed: new Set(), created: new Set(), snaps: new Map() }; projectTurns.set(pid, t); }
  return t;
}
function markProjectDoc(projectId, docId) {
  if (!projectId || !docId) return;
  const t = projectTurn(projectId);
  if (!t.snaps.has(docId) && !t.created.has(docId)) {
    try { t.snaps.set(docId, store.checkpoint(docId)); } catch {}
  }
  t.changed.add(docId);
}
function turnChangedDocs(projectId) {
  const t = projectTurns.get(String(projectId || ""));
  return t ? [...t.changed] : [];
}
function canUndoProjectTurn(projectId) {
  const t = projectTurns.get(String(projectId || ""));
  return !!(t && (t.snaps.size || t.created.size));
}
async function undoProjectTurn(projectId) {
  const t = projectTurns.get(String(projectId || ""));
  if (!t) return 0;
  let n = 0;
  for (const id of t.created) {
    try { store.remove(id); n++; } catch {}
  }
  for (const [id, snap] of t.snaps) {
    try { store.restore(id, snap, "undo-ai"); n++; } catch {}
  }
  t.changed.clear();
  t.created.clear();
  t.snaps.clear();
  drawingsChanged();
  return n;
}

function showView(on) {
  if (SMOKE) return true;
  if (!view || view.webContents.isDestroyed()) return false;
  viewShown = !!on;
  if (!on) placedRect = null;
  view.setVisible(viewShown);
  layoutView();
  if (viewShown) { try { view.webContents.focus(); } catch {} }
  else { try { hostWin.webContents.focus(); } catch {} }
  return viewShown;
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (err) {
      log(`[ipc ${channel}] ${err && err.stack ? err.stack.split("\n").slice(0, 3).join(" | ") : err}`);
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });
}

function registerIpc() {
  handle("app:info", () => ({ version: app.getVersion(), dev: DEV, smoke: SMOKE, dataDir }));
  handle("skills:list", () => require("./lib/styles.cjs").listSkills());
  // One Light / Dark / System choice for the whole app: JV's setting wins.
  handle("prefs:get", (key, fallback) => {
    if (key === "theme" && themeHost.getThemeMode()) return themeHost.getThemeMode();
    // The accent is JV's (Settings > Appearance); Draw keeps no accent of its own.
    if (key === "accent") return (themeHost.getAccent && themeHost.getAccent()) || fallback;
    return store.getPref(key, fallback);
  });
  handle("studio:to-video-library", async (name, dataUrl) => {
    if (!hostApi.addToVideoLibrary) throw new Error("The video library is not available.");
    const buf = Buffer.from(String(dataUrl).split(",")[1] || "", "base64");
    if (!buf.length) throw new Error("Nothing to add.");
    const safe = String(name || "drawing").replace(/[\/:*?"<>|]/g, "_");
    return hostApi.addToVideoLibrary({ name: safe + ".png", mime: "image/png", buffer: buf });
  });
  handle("studio:theme", (mode) => { themeHost.setThemeMode(mode); return true; });
  handle("prefs:set", (key, value) => { store.setPref(key, value); return true; });
  handle("window:overlay", () => true); // JV's window has the normal title bar
  handle("studio:switch", (to) => { onSwitch(to === "draw" ? "draw" : "video"); return true; });

  handle("drawings:list", () => store.list());
  handle("drawings:create", (opts) => { const d = store.create(opts); drawingsChanged(); return d; });
  // The unified Projects flow: JV owns placement of the embedded view.
  handle("drawings:for-project", (projectId) => store.listByProject(projectId));
  handle("drawing:new", (opts) => { const d = store.create(opts || {}); drawingsChanged(); return d; });
  handle("drawing:thumb", async (id) => {
    const row = store.list().find((d) => d.id === id);
    if (row && row.thumb) return row.thumb;
    const shot = await viewDrawing(id, { kind: "full" }).catch(() => null);
    return shot && shot.png ? "data:image/png;base64," + shot.png : null;
  });
  handle("drawing:project-of", (id) => store.projectOf(id));
  handle("draw:undo-turn", (projectId) => undoProjectTurn(projectId));
  handle("draw:can-undo", (projectId) => canUndoProjectTurn(projectId));
  handle("draw:to-video", async (docId) => {
    if (!hostApi.addToVideoLibrary) throw new Error("The video library is not available.");
    const shot = await viewDrawing(docId, { kind: "full" });
    if (!shot || !shot.png) throw new Error("The drawing did not render.");
    const row = store.list().find((d) => d.id === docId);
    const safe = String((row && row.name) || "drawing").replace(/[\/:*?"<>|]/g, "_");
    return hostApi.addToVideoLibrary({ name: safe + ".png", mime: "image/png", buffer: Buffer.from(shot.png, "base64") });
  });
  handle("draw-view:place", (opts) => placeView(opts));
  handle("draw-view:hide", () => {
    placedRect = null;
    placedDoc = "";
    viewShown = false;
    if (view) view.setVisible(false);
    return true;
  });
  handle("draw-view:freeze", () => freezeView());
  handle("draw-view:unfreeze", () => unfreezeView());
  handle("draw-view:state", () => ({ visible: !!(view && viewShown), bounds: placedRect, drawingId: placedDoc }));
  handle("drawings:rename", (id, name) => { const r = store.rename(id, name); drawingsChanged(); return r; });
  handle("drawings:duplicate", (id) => { const d = store.duplicate(id); drawingsChanged(); return d; });
  handle("drawings:remove", (id) => {
    for (const [key, s] of [...sessions]) if (s.docId === id) { s.stop(); sessions.delete(key); }
    for (const [key, chat] of [...chats]) if (chat.drawingId === id) chats.delete(key);
    store.remove(id);
    drawingsChanged();
    return true;
  });
  handle("drawings:open", (id) => {
    const entry = store.load(id);
    const chat = chatFor(id);
    for (const m of chat.messages) if (m.open && !sessions.get(chat.id)?.busy) m.open = false;
    return { meta: store.meta(id), doc: entry.doc, canUndo: entry.undo.length > 0, canRedo: entry.redo.length > 0, chat, chats: store.chatList(id), canUndoTurn: turnSnapshots.has(id), busy: !!sessions.get(chat.id)?.busy };
  });
  handle("drawings:close", (id) => { store.saveNow(id); return true; });
  handle("drawings:thumb", (id, dataUrl) => { store.setThumb(id, dataUrl); return true; });

  handle("doc:apply", (id, ops) => store.apply(id, ops, "user"));
  handle("doc:undo", (id) => store.undo(id));
  handle("doc:redo", (id) => store.redo(id));
  handle("ctx:update", (id, ctx) => { contexts.set(id, Object.assign(contexts.get(id) || {}, ctx)); return true; });

  ipcMain.on("render:reply", (_e, msg) => {
    const w = renderWaits.get(msg && msg.reqId);
    if (!w) return;
    renderWaits.delete(msg.reqId);
    clearTimeout(w.timer);
    if (msg.error) w.reject(new Error(msg.error));
    else w.resolve(msg);
  });

  handle("agents:list", async (refresh) => ({
    agents: await agents(!!refresh),
    preferred: store.getPref("agent", null),
    models: store.getPref("models", {}),
    modelCache: store.getPref("modelCache", {}),
    efforts: store.getPref("efforts", {}),
    effortCache: store.getPref("effortCache", {}),
  }));
  handle("agent:prompt", async (id, req) => {
    const r = req || {};
    const text = String(r.text || "").trim();
    if (!text) throw new Error("Type what you want first.");
    store.setPref("agent", r.agentId);
    const chat = chatFor(id);
    const s = await sessionFor(id, r.agentId, chat.id);
    if (s.busy || gating.has(id) || busySessionOn(id)) throw new Error("The agent is still working. Stop it first or wait.");
    // The slop gate is on unless turned off in prefs; slash commands skip it.
    const gate = !r.agentCommand && store.getPref("slopGate", true) !== false;
    if (gate) gating.add(id);
    turnBusy.add(id);
    gateStop.delete(id);
    chat.agent = r.agentId;
    if (!chat.title || chat.title === "New chat") {
      chat.title = titleFor(r.display || text);
      store.updateChat(chat.id, { title: chat.title });
    }
    chat.messages.push({ role: "user", text: r.display || text, at: Date.now() });
    chat.messages.push({ role: "agent", agent: s.agent.name, text: "", tools: [], open: true, at: Date.now() });
    store.saveChat(chat);
    send("agent:event", { docId: id, chatId: chat.id, type: "chat", chat });
    // Undo AI changes goes back to before the last turn that changed the
    // drawing; turns that only talk keep the earlier snapshot.
    const msg = chat.messages[chat.messages.length - 1];
    const snap = store.checkpoint(id);
    const before = JSON.stringify(store.getDoc(id));
    notePersonItems(id);
    try { mcp.resetLint(id); } catch {}
    turnPrompts.set(id, text);
    const t0 = Date.now();
    // Run in the background; progress arrives as agent:event.
    (async () => {
      try {
        if (r.model) {
          try { await s.start(); await s.setModel(r.model); } catch (err) { log(`[${id}] model switch failed: ${err.message}`); }
        }
        if (r.effort) {
          try { await s.start(); await s.setEffort(r.effort); } catch (err) { log(`[${id}] effort change failed: ${err.message}`); }
        }
        const res = await s.prompt(text, r.context, !!r.agentCommand);
        let drew = false;
        try { drew = JSON.stringify(store.getDoc(id)) !== before; } catch {}
        if (gate && drew && !gateStop.has(id) && !(res && res.stopReason === "cancelled")) {
          const result = await runGate(id, s, chat);
          // Anything drawn in the last fix round gets the finish too.
          if (!result.stopped && store.getPref("artistFinish", true) !== false && !askedCleanLook(turnPrompts.get(id) || "")) {
            try { result.finish = finishDrawing(id); } catch (err) { log(`[${id}] finish failed: ${err.message}`); }
          }
          result.at = Date.now();
          lastChecks.set(id, result);
          chat.check = result;
          log(`[${id}] gate ${result.ok === true ? "passed" : result.ok === false ? "did not pass" : "could not run: " + result.error} after ${result.rounds} fix rounds`);
          if (result.ok !== true) {
            const restored = result.restoredBest != null ? "The last fix round scored worse, so the drawing is the best version the reviewer saw, not that redraw. " : "";
            const left = result.stopped ? "Stopped before the slop check finished." : result.ok === null ? `The slop check could not run: ${result.error}` : restored + `The slop check still finds ${result.issues.length} problem${result.issues.length === 1 ? "" : "s"} after ${result.rounds} rounds of fixes:\n` + result.issues.map((i, n) => `${n + 1}. ${i.what}`).join("\n");
            chat.messages.push({ role: "user", auto: true, text: left, at: Date.now() });
          }
        }
      } catch (err) {
        log(`[${id}] turn failed: ${err.message}`);
      } finally {
        try { noteAgentItems(id); } catch (err) { log(`[${id}] agent items: ${err.message}`); }
        gating.delete(id);
        turnBusy.delete(id);
        persistSessionId(chat, s);
        msg.seconds = Math.round((Date.now() - t0) / 1000);
        let changed = false;
        try { changed = JSON.stringify(store.getDoc(id)) !== before; } catch {}
        if (changed) { turnSnapshots.set(id, snap); for (const m of chat.messages) delete m.changed; msg.changed = true; }
        store.saveChat(chat);
        send("agent:event", { docId: id, chatId: chat.id, type: "turn-end", changed, seconds: msg.seconds, canUndoTurn: turnSnapshots.has(id), check: lastChecks.get(id) || null });
      }
    })();
    return true;
  });
  handle("agent:cancel", (id) => {
    const s = busySessionOn(id) || sessionOf(id);
    if (s) s.cancel();
    if (gating.has(id)) gateStop.add(id);
    const rv = reviewers.get(id);
    if (rv) rv.cancel();
    return true;
  });
  handle("slop:check", (id) => checkDrawing(id));
  handle("slop:result", (id) => lastChecks.get(id) || null);
  handle("slop:finish", (id, opts) => finishDrawing(id, opts));
  handle("agent:stop", (id) => { const s = sessionOf(id); if (s) { s.stop(); sessions.delete(s.chatId); } return true; });
  handle("agent:start", async (id, agentId) => {
    const chat = chatFor(id);
    const s = await sessionFor(id, agentId, chat.id);
    store.setPref("agent", agentId);
    await s.start();
    // Apply the saved model choice right away so the first turn uses it.
    const want = store.getPref("models", {})[agentId];
    if (want && s.models && s.models.current !== want && s.models.available.some((m) => m.id === want)) {
      try { await s.setModel(want); } catch (err) { log(`[${id}] model switch failed: ${err.message}`); }
    }
    const effort = store.getPref("efforts", {})[agentId];
    if (effort) {
      try { await s.setEffort(effort); } catch (err) { log(`[${id}] effort change failed: ${err.message}`); }
    }
    return s.choices();
  });
  handle("agent:setEffort", async (id, agentId, effort) => {
    const prefs = store.getPref("efforts", {});
    prefs[agentId] = effort;
    store.setPref("efforts", prefs);
    const s = sessionOf(id);
    if (s && s.agent.id === agentId && s.client && !s.busy) await s.setEffort(effort);
    return true;
  });
  handle("agent:setModel", async (id, agentId, model) => {
    const prefs = store.getPref("models", {});
    prefs[agentId] = model;
    store.setPref("models", prefs);
    const s = sessionOf(id);
    if (s && s.agent.id === agentId && s.client && !s.busy) await s.setModel(model);
    return true;
  });
  handle("agent:undoTurn", (id) => {
    const snap = turnSnapshots.get(id);
    if (!snap) throw new Error("Nothing to undo from the assistant.");
    store.restore(id, snap, "undo-ai");
    turnSnapshots.delete(id);
    const chat = chatFor(id);
    for (const m of chat.messages) delete m.changed;
    store.saveChat(chat);
    return true;
  });

  // ---- chat threads
  // A drawing keeps every chat it ever had. "New chat" starts a fresh thread
  // and the old one stays in history; opening an old chat puts its transcript
  // back and reloads the agent session it used.
  handle("chats:list", (id) => {
    const activeId = chatFor(id).id;
    return store.chatList(id).map((c) => Object.assign({}, c, { active: c.id === activeId }));
  });
  // Every chat across every drawing, for the history lists on Home.
  handle("chats:all", () =>
    store.allChats().map((c) => Object.assign({}, c, { agentName: (CATALOG.find((a) => a.id === c.agent) || {}).name || c.agent || "" })),
  );
  // A Draw chat's conversation as plain user/assistant messages, so JV's
  // project chat can carry it on.
  handle("chats:messages", ({ drawingId, chatId }) => {
    const c = store.chatById(chatId);
    if (!c || c.drawingId !== drawingId) return [];
    return (c.messages || [])
      .filter((m) => m && (m.role === "user" || m.role === "agent") && !m.auto && !m.error && String(m.text || "").trim())
      .map((m) => ({ role: m.role === "user" ? "user" : "assistant", text: String(m.text) }));
  });
  handle("chats:imported", ({ chatId, jvChatId }) => {
    store.setJvChat(chatId, jvChatId);
    return true;
  });
  const openChat = (id, chatId) => {
    const chat = chatFor(id, chatId);
    if (!chat.id) throw new Error("That chat no longer exists.");
    if (chat.drawingId !== id) throw new Error("That chat is not in this drawing.");
    store.setActiveChat(id, chat.id);
    for (const m of chat.messages) if (m.open && !sessions.get(chat.id)?.busy) m.open = false;
    return { chat, chats: store.chatList(id), busy: !!sessions.get(chat.id)?.busy, canUndoTurn: turnSnapshots.has(id) };
  };
  handle("chat:open", (id, chatId) => openChat(id, chatId));
  handle("chat:new", (id) => {
    // An untouched chat is already a fresh start; do not stack empty threads.
    const active = chatFor(id);
    if (active.id && !active.messages.length) return openChat(id, active.id);
    const chat = store.createChat(id, {});
    chats.set(chat.id, chat);
    return { chat, chats: store.chatList(id), busy: false, canUndoTurn: turnSnapshots.has(id) };
  });
  handle("chat:rename", (id, chatId, title) => {
    const chat = chatFor(id, chatId);
    if (chat.drawingId !== id || !chat.id) throw new Error("That chat is not in this drawing.");
    store.updateChat(chatId, { title });
    chat.title = String(title || "").trim().slice(0, 120) || "New chat";
    return true;
  });
  handle("chat:delete", (id, chatId) => {
    const chat = chatFor(id, chatId);
    if (chat.drawingId !== id || !chat.id) throw new Error("That chat is not in this drawing.");
    const s = sessions.get(chatId);
    if (s) { s.stop(); sessions.delete(chatId); }
    chats.delete(chatId);
    store.deleteChat(chatId);
    // The chat that takes its place (the newest left, or a fresh empty one).
    return openChat(id, chatFor(id).id);
  });
  // JV's Chats list sends a legacy Draw chat here: it lands in the project
  // that owns the drawing, on that drawing's tab.
  handle("jdraw-open-chat", ({ drawingId, chatId }) => {
    store.setActiveChat(drawingId, chatId);
    notifyApp("draw:open-chat", { drawingId, chatId, projectId: store.projectOf(drawingId) });
    return { projectId: store.projectOf(drawingId) };
  });
  // Kept for callers of the old single-chat wipe: now it keeps the old chat
  // and starts a fresh thread.
  handle("chat:clear", (id) => {
    const chat = store.createChat(id, {});
    chats.set(chat.id, chat);
    turnSnapshots.delete(id);
    return { chat, chats: store.chatList(id), busy: false, canUndoTurn: turnSnapshots.has(id) };
  });

  handle("export:save", async (name, dataUrl, ext) => {
    const buf = Buffer.from(String(dataUrl).split(",")[1] || "", "base64");
    if (SMOKE) {
      const dir = process.env.JDRAW_SMOKE_SHOTS || path.join(dataDir, "smoke-shots");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${name}.${ext || "png"}`);
      fs.writeFileSync(file, buf);
      return file;
    }
    const res = await dialog.showSaveDialog(hostWin, {
      title: "Export drawing",
      defaultPath: path.join(app.getPath("pictures"), `${String(name || "drawing").replace(/[\\/:*?"<>|]/g, "_")}.${ext || "png"}`),
      filters: ext === "jpg" ? [{ name: "JPEG image", extensions: ["jpg"] }] : ext === "svg" ? [{ name: "SVG image", extensions: ["svg"] }] : [{ name: "PNG image", extensions: ["png"] }],
    });
    if (res.canceled || !res.filePath) return null;
    fs.writeFileSync(res.filePath, buf);
    return res.filePath;
  });
  handle("export:reveal", (file) => { shell.showItemInFolder(file); return true; });

  // Clipboard: JDraw items travel as text with a marker, plus a PNG so a
  // paste into another app gets the picture.
  // Hidden test runs keep their own clipboard so they never touch the real one.
  let testClip = null;
  handle("clipboard:write", ({ text, png }) => {
    if (SMOKE) { testClip = { text, png }; return true; }
    const data = {};
    if (text) data.text = text;
    if (png) { const img = nativeImage.createFromDataURL(png); if (!img.isEmpty()) data.image = img; }
    clipboard.write(data);
    return true;
  });
  handle("clipboard:read", () => {
    if (SMOKE) {
      const t = testClip || {};
      if (t.text && t.text.startsWith(CLIP_MARK)) return { items: t.text.slice(CLIP_MARK.length) };
      if (t.png) return { image: t.png };
      return { text: t.text || "" };
    }
    const text = clipboard.readText();
    const img = clipboard.readImage();
    const formats = clipboard.availableFormats();
    // Prefer our own items; then a picture; then text.
    if (text && text.startsWith(CLIP_MARK)) return { items: text.slice(CLIP_MARK.length) };
    if (!img.isEmpty()) return { image: img.toDataURL() };
    return { text, formats };
  });

  // Smoke: the window runs renderer/js/smoke.js and hands back a report.
  handle("smoke:config", () =>
    SMOKE
      ? {
          agent: process.env.JDRAW_SMOKE_AGENT || "",
          prompt: process.env.JDRAW_SMOKE_PROMPT || "",
          model: process.env.JDRAW_SMOKE_MODEL || "",
          ui: process.env.JDRAW_SMOKE_UI === "1",
          drawOnly: process.env.JDRAW_SMOKE_DRAW_ONLY === "1",
          effort: process.env.JDRAW_SMOKE_EFFORT || "",
          name: process.env.JDRAW_SMOKE_NAME || "",
          width: Number(process.env.JDRAW_SMOKE_WIDTH) || 0,
          height: Number(process.env.JDRAW_SMOKE_HEIGHT) || 0,
          timeoutMs: Number(process.env.JDRAW_SMOKE_TIMEOUT_MS) || 900000,
        }
      : null,
  );
  handle("smoke:mcp", async (id, name, args) => {
    if (!SMOKE) throw new Error("smoke only");
    return mcp.callTool(id, name, args);
  });
  handle("smoke:capture", async (name) => {
    if (!SMOKE || !win) throw new Error("smoke only");
    const img = await win.webContents.capturePage();
    const dir = process.env.JDRAW_SMOKE_SHOTS || path.join(dataDir, "smoke-shots");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}.png`);
    fs.writeFileSync(file, img.toPNG());
    return { file, size: img.getSize() };
  });
  handle("smoke:done", (report) => {
    const dir = process.env.JDRAW_SMOKE_SHOTS || path.join(dataDir, "smoke-shots");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify(report, null, 2));
    log(`smoke done: ${report && report.ok ? "ok" : "FAILED"}`);
    setTimeout(() => onSmokeExit(report && report.ok ? 0 : 1), 300);
    return true;
  });
}

async function init(opts) {
  hostWin = opts.window;
  dataDir = opts.dataDir;
  onSwitch = opts.onSwitch || onSwitch;
  hostApi = { addToVideoLibrary: opts.addToVideoLibrary, onArtifact: opts.onArtifact };
  if (opts.getThemeMode) themeHost = { getThemeMode: opts.getThemeMode, setThemeMode: opts.setThemeMode || (() => {}), getAccent: opts.getAccent };
  if (opts.onSmokeExit) onSmokeExit = opts.onSmokeExit;
  fs.mkdirSync(dataDir, { recursive: true });
  logFile = path.join(dataDir, "jdraw.log");
  store = new DrawingStore(dataDir);
  mcp = createMcpServer({
    store,
    viewDrawing,
    fillArea: (id, fill) => viewDrawing(id, { kind: "fill", fill }),
    checkDrawing,
    finishDrawing: (id, opts) => finishDrawing(id, opts, true),
    // draw_svg's shape lint is on with the slop gate, off for clean looks
    // (pixel art, flat vector, logos, diagrams) the person asked for.
    lintOn: (id) => store.getPref("slopGate", true) !== false && !askedCleanLook(turnPrompts.get(id) || ""),
    // Which rule set the draw tools use this turn: the full one, the short
    // one for icons and logos ("mark"), the one for other clean looks, or none.
    lintMode: (id) => (store.getPref("slopGate", true) === false ? "off" : lintModeFor(turnPrompts.get(id) || "")),
    turnPrompt: (id) => turnPrompts.get(id) || "",
    context: (id) => contexts.get(id) || {},
    // Project-scoped picking tools for JV chat sessions (mcp-server.cjs).
    listDrawings: (projectId) => (projectId ? store.listByProject(projectId) : store.list()),
    projectOf: (id) => store.projectOf(id),
    newDrawing: (opts) => {
      const d = store.create(opts || {});
      drawingsChanged();
      return d;
    },
    // open_drawing brings the drawing up as that project's artifact tab, not
    // a separate studio screen.
    openDrawing: (id) => {
      send("doc:open", { id });
      notifyApp("draw:select", { drawingId: id, projectId: store.projectOf(id) });
    },
    beforeTool: (ctx, docId) => {
      if (ctx && ctx.projectId) markProjectDoc(ctx.projectId, docId);
    },
    setBrush: (id, brush) => {
      const c = contexts.get(id) || {};
      c.brush = Object.assign({}, c.brush, brush);
      contexts.set(id, c);
      send("brush:set", { docId: id, brush });
    },
    onTool: (id, name, args, err, ctx) => {
      if (err && /^JDraw left this out \(([^)]*)\)/.test(err.message)) leftOut.set(id, (leftOut.get(id) || []).concat(err.message.match(/^JDraw left this out \(([^)]*)\)/)[1]));
      if (err && /^JDraw (did|will) not place/.test(err.message)) refusedIn.set(id, (refusedIn.get(id) || 0) + 1);
      log(`[${id}] tool ${name}${err ? " failed: " + err.message + " args=" + JSON.stringify(args).slice(0, 300) : ""}`);
      send("agent:tool-done", { docId: id, name, label: TOOL_LABELS[name] || name, error: err ? err.message : null });
      // A project chat drawing it makes or edits becomes an artifact card in
      // that chat and a tab on the stage.
      if (!err && ctx && ctx.projectId && id && ARTIFACT_TOOLS.has(name)) {
        const t = projectTurn(ctx.projectId);
        t.changed.add(id);
        if (name === "new_drawing") t.created.add(id);
        const row = store.list().find((d) => d.id === id);
        const info = { drawingId: id, drawingName: (row && row.name) || "Drawing", projectId: ctx.projectId, chatId: ctx.chatId };
        notifyApp("draw:artifact", info);
        if (hostApi.onArtifact) {
          try { hostApi.onArtifact(info); } catch {}
        }
      }
    },
  });
  await mcp.listen();
  log(`started ${app.getVersion()} data=${dataDir} mcp=${mcp.url}${SMOKE ? " smoke" : ""}`);
  // While the gate runs, anything the person adds is theirs, not the agent's.
  store.onChange((info) => {
    let ids;
    try { ids = allIds(info.doc || store.getDoc(info.id)); } catch { return; }
    if (gating.has(info.id) && ["user", "undo", "redo"].includes(info.origin)) personTouched.add(info.id);
    // Only new items the person drew count as theirs; undo can bring back
    // something the gate removed, and that stays the agent's.
    if (gating.has(info.id) && info.origin === "user" && knownIds.has(info.id)) {
      const known = knownIds.get(info.id);
      const person = personItems.get(info.id) || new Set();
      for (const id of ids) if (!known.has(id)) person.add(id);
      personItems.set(info.id, person);
    }
    knownIds.set(info.id, new Set(ids));
  });
  store.onChange((info) => send("doc:changed", { id: info.id, doc: info.doc, origin: info.origin, canUndo: info.canUndo, canRedo: info.canRedo }));
  registerIpc();
  createView();
  if (SMOKE) {
    setTimeout(() => { log("smoke timed out"); app.exit(2); }, (Number(process.env.JDRAW_SMOKE_TIMEOUT_MS) || 900000) + 60000);
  }
  return {
    show: showView,
    isShown: () => viewShown,
    webContents: () => view && view.webContents,
    // Placement probes for the smoke test and the editor's stage rect.
    place: (o) => placeView(o),
    hideView: () => { placedRect = null; if (view) view.setVisible(false); viewShown = false; return true; },
    viewState: () => ({ visible: !!viewShown, bounds: placedRect, drawingId: placedDoc }),
    // { url, token } for lib/acp-harnesses drawMcpForAcp: it builds the http
    // or stdio entry and stamps the project/chat binding onto it.
    mcpEntryFor: () => (mcp ? { url: mcp.url, token: mcp.token } : null),
    // Data for the unified Projects page and migration.
    looseDrawings: () => store.looseDrawings(),
    setDrawingProject: (id, projectId) => store.setProject(id, projectId),
    drawingsForProject: (projectId) => store.listByProject(projectId),
    deleteDrawingsForProject: (projectId) => {
      const rows = store.listByProject(projectId);
      for (const d of rows) store.remove(d.id);
      if (rows.length) drawingsChanged();
      return rows.length;
    },
    projectOf: (id) => store.projectOf(id),
    // Gate and undo for project chat turns.
    turnChangedDocs,
    canUndoProjectTurn,
    undoProjectTurn,
    checkProjectDrawing,
  };
}

function shutdown() {
  for (const s of sessions.values()) s.stop();
  try { store && store.closeAll(); } catch {}
  try { mcp && mcp.close(); } catch {}
}

module.exports = { init, shutdown, SMOKE };
