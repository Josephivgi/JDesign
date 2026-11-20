"use strict";

// The call-time slop gate for the Video MCP server. A design, a script or a
// video plan that reads as the default AI look is turned down at the tool
// call, with what was found and what to write instead, the way Draw's lint
// turns down a sloppy SVG. The linters are pure modules beside this file;
// this one decides when they run, what the person asked for, how many times
// one thing may be refused, and what goes back to the agent.
//
// Nothing here may fail a tool call by accident: a missing linter or a throw
// inside one means the call goes through unchecked.

const fs = require("node:fs");
const path = require("node:path");

// Refusals in a row for one thing before it lands with its problems listed.
// An in-app agent has a turn to spend them in. An outside agent (a terminal,
// T3 Code) has no turn and no record of what its person asked for, so it gets
// one refusal and then the benefit of the doubt.
const TRIES_IN_APP = 3;
const TRIES_OUTSIDE = 1;
const MAX_LISTED = 5;
const MAX_TELLS = 3;
const ASKED_LIMIT = 24000;
const SCOPE_TTL_MS = 6 * 60 * 60 * 1000;

function lazy(name) {
  let mod;
  let tried = false;
  return () => {
    if (!tried) {
      tried = true;
      try {
        mod = require(name);
      } catch {
        mod = null;
      }
    }
    return mod;
  };
}
const designLint = lazy("./design-lint");
const copyLint = lazy("./copy-lint");
const pacingLint = lazy("./pacing-lint");

// ---------------------------------------------------------------- the pref

const prefCache = new Map(); // dataRoot -> { mtimeMs, on }

// slopGate in jeditor-prefs.json, default on. Read from the file because this
// also runs in the stdio server, where Electron's prefs module cannot load.
function enabled(dataRoot) {
  const env = String(process.env.JEDITOR_SLOP_GATE || "").trim().toLowerCase();
  if (env === "0" || env === "off" || env === "false") return false;
  if (!dataRoot) return true;
  const file = path.join(dataRoot, "jeditor-prefs.json");
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return true;
  }
  const hit = prefCache.get(dataRoot);
  if (hit && hit.mtimeMs === mtimeMs) return hit.on;
  let on = true;
  try {
    on = JSON.parse(fs.readFileSync(file, "utf8")).slopGate !== false;
  } catch {
    on = true;
  }
  prefCache.set(dataRoot, { mtimeMs, on });
  return on;
}

// ------------------------------------------------- what the person asked for

// scope -> { asked, styles: Set, tries: Map, at }
const scopes = new Map();

function scopeKey(meta) {
  const m = meta || {};
  return String(m.chatId || m.projectId || m.workspaceId || m.sessionId || "");
}

function scopeFor(key, create) {
  if (!key) return null;
  let s = scopes.get(key);
  if (!s && create) {
    if (scopes.size > 200) {
      const cutoff = Date.now() - SCOPE_TTL_MS;
      for (const [k, v] of scopes) if (v.at < cutoff) scopes.delete(k);
    }
    s = { asked: "", styles: new Set(), tries: new Map(), at: Date.now() };
    scopes.set(key, s);
  }
  if (s) s.at = Date.now();
  return s;
}

// Called by the ACP host when the person sends a message: every line they
// typed in this chat so far. A look they asked for two turns ago is still
// asked for. A new message also gives every object a fresh refusal budget.
function setAsked(ids, texts) {
  const list = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t || "").trim()).filter(Boolean);
  const text = list.join("\n").slice(-ASKED_LIMIT);
  for (const key of new Set([ids && ids.chatId, ids && ids.projectId].map((k) => String(k || "")).filter(Boolean))) {
    const s = scopeFor(key, true);
    s.asked = text;
    s.tries.clear();
  }
}

function getAsked(meta) {
  const m = meta || {};
  for (const key of [m.chatId, m.projectId, m.workspaceId, m.sessionId]) {
    const s = key ? scopes.get(String(key)) : null;
    if (s && s.asked) return s.asked;
  }
  return "";
}

// A style skill the agent read in this chat (style-neon and friends) unlocks
// what that skill says it unlocks.
function noteSkill(meta, name) {
  const id = String(name || "").trim().toLowerCase();
  if (!id.startsWith("style-")) return;
  const s = scopeFor(scopeKey(meta), true);
  if (s) s.styles.add(id.slice(6));
}

function stylesFor(meta) {
  const s = scopes.get(scopeKey(meta));
  return s ? [...s.styles] : [];
}

// The person's standing instructions count as asked too ("our brand color is
// violet"). The shipped default rules do not: they name the looks to avoid.
function standingText(dataRoot) {
  if (!dataRoot) return "";
  try {
    return String(fs.readFileSync(path.join(dataRoot, "user-instructions.md"), "utf8")).slice(0, 8000);
  } catch {
    return "";
  }
}

// ------------------------------------------------------------ gathering input

const str = (v) => (typeof v === "string" ? v : "");
const plain = (v) => Boolean(v && typeof v === "object" && !Array.isArray(v));

function sizeFor(aspect) {
  const a = String(aspect || "").toLowerCase();
  if (a === "9/16" || a === "vertical") return { width: 1080, height: 1920 };
  if (a === "1/1" || a === "square") return { width: 1080, height: 1080 };
  if (a === "4/5") return { width: 1080, height: 1350 };
  return { width: 1920, height: 1080 };
}

async function savedCard(dataRoot, workspaceId, cardId) {
  if (!cardId) return null;
  try {
    const { snapshot } = require("../workspace-store");
    const snap = await snapshot(dataRoot, workspaceId);
    return (snap.workspace.cards || []).find((c) => c && c.id === cardId) || null;
  } catch {
    return null;
  }
}

// A card call as one design: what the call sends on top of what is saved, so
// a css-only change is judged with its markup.
async function cardDesign(dataRoot, input, fields) {
  const sends = ["html", "css", "vars", "colors"].some((k) => fields[k] !== undefined && fields[k] !== null);
  if (!sends) return null;
  const card = await savedCard(dataRoot, input.workspaceId, str(input.cardId));
  const comp = (card && card.composition) || {};
  const html = fields.html != null ? str(fields.html) : str(comp.html);
  const css = fields.css != null ? str(fields.css) : str(comp.css);
  if (!html.trim() && !css.trim()) return null;
  const size = sizeFor(input.aspectRatio || (card && card.aspectRatio));
  return {
    html,
    css,
    vars: Object.assign({}, plain(comp.vars) ? comp.vars : {}, plain(fields.vars) ? fields.vars : {}),
    colors: Object.assign({}, card && plain(card.colors) ? card.colors : {}, plain(fields.colors) ? fields.colors : {}),
    kind: "card",
    width: size.width,
    height: size.height,
    durationMs: Number(input.durationMs) || (card && card.durationMs) || undefined,
  };
}

// One beat of an animation as the page the renderer will build, plus the same
// preset with nothing changed, so a problem that ships inside a preset is
// never blamed on the agent that used it.
async function beatDesign(dataRoot, workspaceId, opts) {
  const { animationSource } = require("../animation-render");
  const size = sizeFor(opts.aspectRatio);
  const one = async (o) => {
    const src = await animationSource(Object.assign({}, o), dataRoot, workspaceId);
    return { html: str(src.html), css: str(src.css), js: str(src.js), vars: src.vars || {}, colors: src.colors || {}, kind: "animation", width: size.width, height: size.height, durationMs: Number(src.durationMs) || undefined };
  };
  const design = await one(opts);
  let base = null;
  if (opts.preset && !opts.cardId) {
    try {
      base = await one({ preset: opts.preset, aspectRatio: opts.aspectRatio });
    } catch {
      base = null;
    }
  }
  return { design, base };
}

async function animationBeats(dataRoot, input) {
  const beats = [];
  const shared = { colors: plain(input.colors) ? input.colors : {}, vars: plain(input.vars) ? input.vars : {}, aspectRatio: input.aspectRatio };
  const scenes = Array.isArray(input.scenes) ? input.scenes.filter(plain) : [];
  if (scenes.length) {
    for (let i = 0; i < scenes.length; i += 1) {
      const raw = scenes[i];
      if (!raw.preset && !str(raw.html).trim()) continue;
      const opts = Object.assign({}, shared, raw, { colors: Object.assign({}, shared.colors, plain(raw.colors) ? raw.colors : {}), vars: shared.vars, aspectRatio: input.aspectRatio });
      delete opts.scenes;
      delete opts.cardId;
      try {
        beats.push(Object.assign({ where: "scene " + (i + 1) }, await beatDesign(dataRoot, input.workspaceId, opts)));
      } catch {
        /* the tool reports a broken scene itself */
      }
    }
    return beats;
  }
  if (!input.preset && !input.cardId && !str(input.html).trim() && !str(input.css).trim() && !str(input.js).trim()) return beats;
  try {
    beats.push(Object.assign({ where: "" }, await beatDesign(dataRoot, input.workspaceId, input)));
  } catch {
    /* the tool reports it */
  }
  return beats;
}

// --------------------------------------------------------------- the linters

const sameProblem = (a, b) => a.rule === b.rule && String(a.what) === String(b.what);

function runDesign(design, base, opts, where) {
  const mod = designLint();
  if (!mod || typeof mod.lintDesign !== "function") return [];
  let problems = (mod.lintDesign(design, opts) || {}).problems || [];
  if (base && problems.length) {
    const shipped = (mod.lintDesign(base, opts) || {}).problems || [];
    // The preset's own look is the app's to fix, not the agent's. What stays
    // is what this call added or changed.
    problems = problems.filter((p) => !shipped.some((q) => q.rule === p.rule));
  }
  return problems.map((p) => Object.assign({}, p, { source: "design", where: [where, p.where].filter(Boolean).join(", ") }));
}

function runCopy(texts, kind, opts, where, baseTexts) {
  const mod = copyLint();
  if (!mod || typeof mod.lintCopy !== "function") return [];
  const list = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t || "")).filter((t) => t.trim());
  if (!list.length) return [];
  let problems = (mod.lintCopy(list, Object.assign({ kind }, opts)) || {}).problems || [];
  if (baseTexts && baseTexts.length && problems.length) {
    const shipped = (mod.lintCopy(baseTexts, Object.assign({ kind }, opts)) || {}).problems || [];
    problems = problems.filter((p) => !shipped.some((q) => sameProblem(p, q)));
  }
  return problems.map((p) => Object.assign({}, p, { source: "copy", where: [where, p.where].filter(Boolean).join(", ") }));
}

function textsOf(design) {
  const mod = copyLint();
  if (!mod || typeof mod.visibleText !== "function" || !design) return [];
  try {
    const html = design.js ? design.html + "\n<script>" + design.js + "</script>" : design.html;
    return mod.visibleText(html) || [];
  } catch {
    return [];
  }
}

function runPlan(input, opts) {
  const mod = pacingLint();
  if (!mod || typeof mod.lintVideoPlan !== "function") return [];
  const problems = (mod.lintVideoPlan(input, opts) || {}).problems || [];
  return problems.map((p) => Object.assign({}, p, { source: "pacing" }));
}

function runNarration(lines, opts) {
  const mod = pacingLint();
  if (!mod || typeof mod.lintNarration !== "function" || !Array.isArray(lines) || lines.length < 2) return [];
  const problems = (mod.lintNarration(lines, opts) || {}).problems || [];
  return problems.map((p) => Object.assign({}, p, { source: "pacing" }));
}

// One tell alone is fine; three or four make slop. A hard problem is enough
// on its own. The same rule the linters use, applied across all of them so
// two small tells in the look and two in the words still add up.
function verdictOf(problems) {
  if (problems.some((p) => p.hard)) return "slop";
  const soft = new Set(problems.map((p) => p.rule));
  if (soft.size >= 3) return "slop";
  return soft.size ? "tells" : "ok";
}

// ------------------------------------------------------- what each tool sends

const COVERED = new Set([
  "jeditor_set_card_html",
  "jeditor_apply_edit",
  "jeditor_render_card",
  "jeditor_render_animation",
  "jeditor_animation_frames",
  "jeditor_tts",
  "cards_set_code",
  "cards_set_text",
]);

// Tools that only show the agent a picture. They are never refused: the
// problems ride along with the stills so the agent sees both at once.
const PREVIEW = new Set(["jeditor_animation_frames", "jeditor_render_card"]);

const NOUN = {
  jeditor_set_card_html: ["save this card", "card"],
  jeditor_apply_edit: ["save this card", "card"],
  cards_set_code: ["save this card", "card"],
  cards_set_text: ["save this text", "text"],
  jeditor_render_animation: ["render this animation", "animation"],
  jeditor_tts: ["make this voiceover", "script"],
};

function covers(name) {
  return COVERED.has(name);
}

async function gather(name, input, ctx, opts) {
  const dataRoot = ctx.dataRoot;
  const problems = [];
  let object = "";
  if (name === "jeditor_set_card_html" || name === "cards_set_code") {
    const design = await cardDesign(dataRoot, input, input);
    object = "card:" + (str(input.cardId) || str(input.name) || "new");
    if (design) {
      problems.push(...runDesign(design, null, opts, ""));
      // Words are only judged when this call sends markup: a css change does
      // not make the agent answer for copy that was already there.
      if (input.html != null) problems.push(...runCopy(textsOf(design), "card", opts, ""));
    }
  } else if (name === "jeditor_apply_edit" || name === "jeditor_render_card") {
    const patch = plain(input.patch) ? input.patch : {};
    const comp = plain(patch.composition) ? patch.composition : {};
    const fields = { html: comp.html, css: comp.css, vars: comp.vars, colors: patch.colors };
    const design = await cardDesign(dataRoot, Object.assign({}, input, { cardId: input.cardId || patch.id, durationMs: patch.durationMs }), fields);
    object = "card:" + (str(input.cardId) || str(patch.id) || str(input.name) || str(input.template) || "new");
    if (design) {
      problems.push(...runDesign(design, null, opts, ""));
      if (comp.html != null) problems.push(...runCopy(textsOf(design), "card", opts, ""));
    }
    // A text card keeps its words in composition.copy.
    if (plain(comp.copy)) problems.push(...runCopy(Object.values(comp.copy).filter((v) => typeof v === "string"), "card", opts, ""));
  } else if (name === "cards_set_text") {
    object = "text:" + str(input.cardId);
    const texts = [];
    for (const key of Object.keys(input)) if (!/id$/i.test(key) && typeof input[key] === "string") texts.push(input[key]);
    if (plain(input.copy)) for (const v of Object.values(input.copy)) if (typeof v === "string") texts.push(v);
    problems.push(...runCopy(texts, "card", opts, ""));
  } else if (name === "jeditor_render_animation" || name === "jeditor_animation_frames") {
    object = "animation:" + (str(input.replaceClipId) || str(input.name) || str(input.projectId) || "new");
    for (const beat of await animationBeats(dataRoot, input)) {
      problems.push(...runDesign(beat.design, beat.base, opts, beat.where));
      problems.push(...runCopy(textsOf(beat.design), "card", opts, beat.where, textsOf(beat.base)));
    }
    problems.push(...runPlan(input, opts));
  } else if (name === "jeditor_tts") {
    object = "script:" + (str(input.name) || "voiceover");
    const lines = Array.isArray(input.lines) && input.lines.length ? input.lines.map((l) => String(typeof l === "string" ? l : (l && l.text) || "")).filter((t) => t.trim()) : [];
    const texts = lines.length ? lines : [str(input.text)];
    problems.push(...runCopy(texts, "script", opts, ""));
    problems.push(...runNarration(lines, opts));
  }
  // One entry per finding: two scenes with the same tell are one problem.
  const seen = new Map();
  for (const p of problems) {
    const key = p.rule + "\n" + p.what;
    if (!seen.has(key)) seen.set(key, p);
  }
  return { object, problems: [...seen.values()] };
}

const line = (p) => String(p.what || "").replace(/\s+$/, "") + (p.fix ? " Fix: " + String(p.fix).trim() : "");

// Returns null (nothing to say), { refuse: {...} } (send this back instead of
// running the tool) or { note: {...} } (run it and attach this to the result).
async function review(name, input, ctx) {
  if (!covers(name)) return null;
  const context = ctx || {};
  try {
    if (!enabled(context.dataRoot)) return null;
    const meta = context.meta || {};
    const args = plain(input) ? input : {};
    const asked = [getAsked(meta), standingText(context.dataRoot)].filter(Boolean).join("\n");
    const styles = stylesFor(meta);
    const opts = { asked, style: styles[styles.length - 1] || "", styles, allow: [] };
    const found = await gather(name, args, context, opts);
    const problems = found.problems.slice().sort((a, b) => Number(Boolean(b.hard)) - Number(Boolean(a.hard)));
    const verdict = verdictOf(problems);
    const s = scopeFor(scopeKey(meta) || "outside", true);
    const key = name.replace(/^jeditor_animation_frames$/, "jeditor_render_animation") + "\n" + found.object;
    if (verdict === "ok") {
      s.tries.delete(key);
      return null;
    }
    if (verdict === "tells") {
      s.tries.delete(key);
      return { note: { tells: problems.slice(0, MAX_TELLS).map(line), note: "One or two of these are fine when they are a choice. Fix them if they were not." } };
    }
    const listed = problems.slice(0, MAX_LISTED).map(line);
    const more = problems.length > listed.length ? problems.length - listed.length : 0;
    if (PREVIEW.has(name)) {
      return { note: { verdict: "slop", problems: listed, more: more || undefined, note: "This reads as the default AI look. Fix these before you render or save it: the same check runs there and turns it down." } };
    }
    const limit = meta.harness ? TRIES_IN_APP : TRIES_OUTSIDE;
    const used = s.tries.get(key) || 0;
    if (used >= limit) {
      s.tries.delete(key);
      return { note: { verdict: "slop", landedWithProblems: listed, more: more || undefined, note: "It was kept after " + limit + (limit === 1 ? " refusal" : " refusals") + ". Tell the person what is still off instead of calling it done." } };
    }
    s.tries.set(key, used + 1);
    const [verb] = NOUN[name] || ["run this", "design"];
    const left = limit - used - 1;
    return {
      refuse: {
        error: "JV did not " + verb + ": it reads as the default AI look. Fix what is listed in problems and send it again.",
        problems: listed,
        more: more || undefined,
        next: left > 0
          ? "Change the design, not just the values that were named. If the person asked for one of these in their own words, keep it and fix the rest."
          : meta.harness
            ? "Last refusal for this one: the next call is kept as it is, with its problems listed."
            : "If the person asked for this look, send the same call again and it is kept.",
      },
    };
  } catch {
    return null;
  }
}

// The gate's note as one more text block on a tool result.
function attach(result, note) {
  if (!note || !result || !Array.isArray(result.content)) return result;
  const content = result.content.slice();
  content.push({ type: "text", text: JSON.stringify({ slopCheck: note }) });
  return Object.assign({}, result, { content });
}

function resetForTests() {
  scopes.clear();
  prefCache.clear();
}

module.exports = { enabled, setAsked, getAsked, noteSkill, stylesFor, covers, review, attach, verdictOf, resetForTests, TRIES_IN_APP, TRIES_OUTSIDE };
