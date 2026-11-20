"use strict";

// The after-turn slop gate for the Video studio's chat (the same job runGate
// does in draw/studio.cjs). electron/acp-host.cjs calls runAfterTurn once a
// turn has ended normally. It finds what the agent designed or rendered in
// that turn, runs every slop check on it (lib/slop/check.js), and when the
// result reads as slop it sends the findings back to the same session as a
// fix request. It never throws and never fails the person's turn.
//
// The host passes what only it can do as callbacks:
//   send(text)        sends a follow-up prompt, resolves { ok } | { stopped }
//                     | { failed, why }
//   say(text, extra)  adds one plain line to the chat
//   stopped()         true once the person pressed Stop
//   log(message)      a line for the error log

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_ROUNDS = 2;
const MAX_ROUNDS = 5;
const MAX_CARDS = 4;
const MAX_CLIPS = 3;

// Tools that change what a video looks, reads or sounds like. A turn that ran
// none of them has nothing new to check.
const DESIGN_TOOLS = new Set([
  "jeditor_set_card_html",
  "jeditor_apply_edit",
  "jeditor_duplicate_card",
  "jeditor_attach_card_image",
  "jeditor_template_store_install",
  "jeditor_render_card",
  "jeditor_render_animation",
  "jeditor_render_project",
  "jeditor_compose_finished",
  "jeditor_project_add_render",
  "jeditor_edit_timeline",
  "jeditor_tts",
  "jeditor_music",
  "jeditor_replace_audio",
  "jeditor_set_audio",
]);
const CARD_TOOLS = new Set(["jeditor_set_card_html", "jeditor_apply_edit", "jeditor_duplicate_card", "jeditor_attach_card_image", "jeditor_render_card", "jeditor_template_store_install"]);
// The card assistant's own tools change a card the same way.
for (const name of ["cards_create", "cards_update", "cards_set_text", "cards_set_style", "cards_set_block_layout", "cards_set_code", "cards_edit_code", "cards_set_end_screen", "cards_apply_template", "cards_duplicate", "cards_render"]) {
  DESIGN_TOOLS.add(name);
  CARD_TOOLS.add(name);
}

function rounds() {
  const raw = String(process.env.JEDITOR_GATE_ROUNDS == null ? "" : process.env.JEDITOR_GATE_ROUNDS).trim();
  if (!raw) return DEFAULT_ROUNDS;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) ? Math.max(0, Math.min(MAX_ROUNDS, n)) : DEFAULT_ROUNDS;
}

// The person's switch: pref slopGate (default on). lib/slop/gate.js reads it
// with a cache; the file is read here when that module is not there.
function enabled(dataRoot) {
  try {
    const gate = require("./gate");
    if (typeof gate.enabled === "function") return gate.enabled(dataRoot) !== false;
  } catch {
    /* fall through to the file */
  }
  try {
    return JSON.parse(fs.readFileSync(path.join(dataRoot, "jeditor-prefs.json"), "utf8")).slopGate !== false;
  } catch {
    return true;
  }
}

// Tool names in a chat's tool rows ("jeditor_render_animation", or a title
// such as "mcp__jeditor-app__jeditor_tts"), for agents whose calls did not
// reach the activity log.
function toolNamesIn(titles) {
  const out = new Set();
  for (const title of Array.isArray(titles) ? titles : []) {
    const hit = /\b(?:jeditor|cards)_[a-z0-9_]+/.exec(String(title || "").replace(/__/g, " "));
    if (hit) out.add(hit[0]);
  }
  return [...out];
}

function idsIn(summary, key) {
  const out = [];
  const re = new RegExp('"' + key + '"\\s*:\\s*"([^"\\\\]{1,80})"', "g");
  let m;
  while ((m = re.exec(String(summary || "")))) out.push(m[1]);
  return out;
}

// What changed in this turn, as targets for checkSlop. actions are rows from
// the activity log since the turn began (newest first).
function turnTargets(actions, scope, cards) {
  const s = scope || {};
  const mine = (Array.isArray(actions) ? actions : []).filter((row) => {
    if (!row || !row.ok || !DESIGN_TOOLS.has(row.tool)) return false;
    if (row.harness && s.harnessId && row.harness !== s.harnessId) return false;
    if (row.projectId && s.projectId && row.projectId !== s.projectId) return false;
    if (row.workspaceId && s.workspaceId && row.workspaceId !== s.workspaceId) return false;
    return true;
  });
  const tools = new Set(mine.map((row) => row.tool));
  for (const name of toolNamesIn(s.toolTitles)) if (DESIGN_TOOLS.has(name)) tools.add(name);
  const out = { tools: [...tools], projectIds: [], cardIds: [], libraryIds: [] };
  if (!tools.size) return out;
  const add = (list, id, max) => {
    const text = String(id || "").trim();
    if (text && !list.includes(text) && list.length < max) list.push(text);
  };
  add(out.projectIds, s.projectId, 1);
  for (const row of mine) {
    const args = row.args && typeof row.args === "object" ? row.args : {};
    add(out.projectIds, row.projectId || args.projectId, 2);
    if (CARD_TOOLS.has(row.tool)) {
      add(out.cardIds, args.cardId, MAX_CARDS);
      for (const id of Array.isArray(args.cardIds) ? args.cardIds : []) add(out.cardIds, id, MAX_CARDS);
      for (const id of idsIn(row.summary, "cardId")) add(out.cardIds, id, MAX_CARDS);
    }
    // A clip made outside a project is only reachable by its own id.
    if (!out.projectIds.length && (row.tool === "jeditor_render_animation" || row.tool === "jeditor_compose_finished" || row.tool === "jeditor_tts" || row.tool === "jeditor_music")) {
      for (const id of idsIn(row.summary, "libraryId").concat(idsIn(row.summary, "finishedId"))) add(out.libraryIds, id, MAX_CLIPS);
    }
  }
  // A card made in this turn has its id only in the tool result, so cards
  // saved since the turn began count too when a card tool ran.
  if ([...tools].some((name) => CARD_TOOLS.has(name))) {
    const since = Date.parse(s.since || "") || 0;
    for (const card of Array.isArray(cards) ? cards : []) {
      const at = Date.parse((card && card.updatedAt) || "") || 0;
      if (card && card.id && since && at >= since) add(out.cardIds, card.id, MAX_CARDS);
    }
  }
  return out;
}

function targetList(t) {
  return []
    .concat(t.projectIds.map((projectId) => ({ projectId })))
    .concat(t.cardIds.map((cardId) => ({ cardId })))
    .concat(t.libraryIds.map((libraryId) => ({ libraryId })));
}

function targetText(target) {
  if (target.projectId) return 'project "' + target.projectId + '"';
  if (target.cardId) return 'card "' + target.cardId + '"';
  return 'clip "' + target.libraryId + '"';
}

const issueKey = (issue) => String(issue.rule || "") + "|" + String(issue.where || "");

function ruleNames(issues) {
  const names = [];
  for (const issue of issues) {
    const name = String(issue.rule || "").replace(/[-_]+/g, " ").trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names.length > 4 ? names.slice(0, 4).join(", ") + " and " + (names.length - 4) + " more" : names.join(", ");
}

const count = (n, word) => n + " " + word + (n === 1 ? "" : (/x$/.test(word) ? "es" : "s"));

// The lines the person reads in the chat. The window draws a system row that
// starts with "Turn stopped: " as one plain line with the prefix removed, so
// these show without any change to the window.
function askedLine(issues) {
  return "Turn stopped: JV checked the result and asked for " + count(issues.length, "fix") + ": " + ruleNames(issues) + ".";
}
function leftLine(issues) {
  return "Turn stopped: JV checked again and " + (issues.length === 1 ? "1 issue is" : issues.length + " issues are") + " left: " + ruleNames(issues) + ".";
}

function fixPrompt(found, asked) {
  const { issuesText } = require("./check");
  const total = found.reduce((n, entry) => n + entry.issues.length, 0);
  const blocks = found.map((entry) => "On " + targetText(entry.target) + ":\n" + issuesText(entry.issues));
  const call = found.map((entry) => "jeditor_check_slop " + JSON.stringify(entry.target)).join(", then ");
  const said = String(asked || "").trim().replace(/\s+/g, " ").slice(-600);
  return [
    "JV checked what you just made and found " + count(total, "thing") + " that read as AI slop. This is an automatic check, not a message from the person.",
    blocks.join("\n\n"),
    "Fix each one, render again where the fix changes the picture or the sound, then call " + call + " to confirm before you reply.",
    said ? "Keep everything the person asked for: \"" + said + "\". If a fix would undo something they asked for, leave it and say so in one line." : "If a fix would undo something the person asked for, leave it and say so in one line.",
    "Reply with one or two plain sentences on what you changed.",
  ].join("\n\n");
}

async function checkAll(opts, targets) {
  const { checkSlop } = require("./check");
  const found = [];
  let checked = 0;
  for (const target of targets) {
    if (opts.stopped()) return { stopped: true, found, checked };
    let result = null;
    try {
      result = await checkSlop({ dataRoot: opts.dataRoot, appRoot: opts.appRoot, asked: opts.askedAll, signal: opts.signal }, Object.assign({ workspaceId: opts.workspaceId || "" }, target));
    } catch (error) {
      // A card or clip deleted later in the turn is not a gate failure.
      if (!(error && error.notFound)) opts.log("slop gate: check of " + targetText(target) + " failed: " + String((error && error.message) || error));
      continue;
    }
    if (result.aborted) return { stopped: true, found, checked };
    checked += result.checked.length;
    // One or two tells can be a choice. Only work that reads as slop goes back.
    if (result.verdict === "slop" && result.issues.length) found.push({ target, issues: result.issues });
  }
  return { stopped: false, found, checked };
}

// One JSON line per gate run in <data>/slop-gate.log: what it checked, what it
// sent and why it stopped. Kept small; a failed write is ignored.
function logLine(dataRoot, entry) {
  try {
    const file = path.join(dataRoot, "slop-gate.log");
    try {
      if (fs.statSync(file).size > 512 * 1024) fs.renameSync(file, file + ".1");
    } catch {
      /* no log yet */
    }
    fs.appendFileSync(file, JSON.stringify(Object.assign({ at: new Date().toISOString() }, entry)) + "\n");
  } catch {
    /* the log is a convenience */
  }
}

async function runAfterTurn(options) {
  const report = await gateRun(options);
  if (options && options.dataRoot) logLine(options.dataRoot, { harness: options.harnessId || "", projectId: options.projectId || "", report });
  return report;
}

async function gateRun(options) {
  const opts = Object.assign({ stopped: () => false, log: () => {}, say: () => {}, asked: "" }, options || {});
  const report = { ran: false, rounds: 0, sent: 0, left: 0, stopped: false, why: "" };
  try {
    const max = rounds();
    if (!max) return Object.assign(report, { why: "JEDITOR_GATE_ROUNDS is 0" });
    if (!enabled(opts.dataRoot)) return Object.assign(report, { why: "the slop gate is off" });
    let actions = [];
    try {
      actions = require("../agent-activity").listActions(opts.dataRoot, { since: opts.since, limit: 200 });
    } catch (error) {
      opts.log("slop gate: could not read the activity log: " + String((error && error.message) || error));
    }
    let cards = [];
    try {
      const { loadState, loadWorkspace } = require("../workspace-store");
      const workspaceId = opts.workspaceId || (await loadState(opts.dataRoot)).activeWorkspaceId;
      cards = (await loadWorkspace(opts.dataRoot, workspaceId)).cards || [];
    } catch {
      /* no cards to add */
    }
    const picked = turnTargets(actions, opts, cards);
    const targets = targetList(picked);
    if (!picked.tools.length) return Object.assign(report, { why: "no design or render tool ran in this turn" });
    if (!targets.length) return Object.assign(report, { why: "nothing to check was found for " + picked.tools.join(", ") });
    report.ran = true;
    report.targets = targets;
    // What the person asked for is never an issue: their lines in this chat
    // plus their standing instructions.
    let standing = "";
    try {
      standing = fs.readFileSync(path.join(opts.dataRoot, "user-instructions.md"), "utf8").slice(0, 8000);
    } catch {
      /* none saved */
    }
    opts.askedAll = [String(opts.asked || ""), standing].filter(Boolean).join("\n");
    const sentTimes = new Map();
    let before = Infinity;
    for (;;) {
      const round = await checkAll(opts, targets);
      if (round.stopped || opts.stopped()) return Object.assign(report, { stopped: true, why: "the person stopped it" });
      const issues = round.found.reduce((all, entry) => all.concat(entry.issues), []);
      report.left = issues.length;
      report.issues = issues.map((issue) => ({ rule: issue.rule, hard: issue.hard, where: issue.where, source: issue.source }));
      if (!issues.length) return Object.assign(report, { why: report.sent ? "the fixes cleared it" : round.checked ? "nothing read as slop" : "nothing could be checked" });
      let why = "";
      if (report.rounds >= max) why = "the round limit (" + max + ") was reached";
      else if (report.rounds && issues.length >= before) why = "the fixes did not shrink the list";
      else if (issues.some((issue) => (sentTimes.get(issueKey(issue)) || 0) >= 2)) why = "the same issue came back twice";
      if (why) {
        if (report.sent) opts.say(leftLine(issues), { kind: "slop-gate", left: issues.length });
        return Object.assign(report, { why });
      }
      before = issues.length;
      for (const issue of issues) sentTimes.set(issueKey(issue), (sentTimes.get(issueKey(issue)) || 0) + 1);
      const text = fixPrompt(round.found, opts.asked);
      opts.say(askedLine(issues), { kind: "slop-gate", sent: text, fixes: issues.length });
      report.rounds += 1;
      report.sent += issues.length;
      const reply = await opts.send(text);
      if (reply && reply.stopped) return Object.assign(report, { stopped: true, why: "the person stopped it" });
      if (!reply || !reply.ok) return Object.assign(report, { failed: true, why: "the fix turn did not finish: " + String((reply && reply.why) || "no reply") });
    }
  } catch (error) {
    opts.log("slop gate: " + String((error && error.stack) || error));
    return Object.assign(report, { failed: true, why: String((error && error.message) || error) });
  }
}

module.exports = { runAfterTurn, turnTargets, fixPrompt, askedLine, leftLine, rounds, enabled, logLine, DESIGN_TOOLS };
