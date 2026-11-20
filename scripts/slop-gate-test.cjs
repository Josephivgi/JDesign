#!/usr/bin/env node
"use strict";

// The slop gate at the tool call, driven through the real MCP handler on a
// scratch data folder:
//   node scripts/slop-gate-test.cjs
// Proves a design that reads as the default AI look is turned down with
// problems an agent can act on, that the refusal budget ends, that a look the
// person asked for is let through, that the pref turns it off, and that no
// shipped preset is ever refused when used as it comes.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const appRoot = path.join(__dirname, "..");
const { createMcpHandler } = require(path.join(appRoot, "lib", "mcp-server"));
const { agentToolSpecs } = require(path.join(appRoot, "lib", "agent-tools"));
const gate = require(path.join(appRoot, "lib", "slop", "gate"));

let failed = 0;
function check(name, ok, detail) {
  if (!ok) failed += 1;
  console.log((ok ? "PASS " : "FAIL ") + name + (ok || !detail ? "" : "\n     " + String(detail).slice(0, 600)));
}

const SLOP_CARD = {
  name: "Hero",
  kind: "title_card",
  html: '<div class="hero"><span class="badge">✨ NEW</span><h1>Unlock Your Potential</h1><p>Seamless notes. Elevated thinking. Effortless flow.</p><button>Get Started 🚀</button></div>',
  css:
    ".hero{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;height:100%;" +
    "background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);font-family:Inter,system-ui,sans-serif}" +
    "h1{font-size:96px;background:linear-gradient(90deg,#a78bfa,#22d3ee);-webkit-background-clip:text;background-clip:text;color:transparent;text-shadow:0 0 40px #a78bfa}" +
    ".badge{backdrop-filter:blur(12px);background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.2);border-radius:999px;padding:8px 20px}" +
    "button{border-radius:999px;box-shadow:0 0 40px #8b5cf6;animation:pulse 2s infinite}" +
    "@keyframes pulse{50%{transform:scale(1.06)}}",
};

const CLEAN_CARD = {
  name: "Bread, day two",
  kind: "title_card",
  html: '<div class="plate"><h1>Day two: the fold</h1><p>Wet hands. Four turns. Then leave it alone.</p></div>',
  css:
    ".plate{height:100%;box-sizing:border-box;padding:120px 140px;background:#23301f;color:#f3ead7;display:flex;flex-direction:column;justify-content:flex-end}" +
    'h1{font:700 132px/1.02 Georgia,"Palatino Linotype",serif;margin:0 0 28px;max-width:11em}' +
    'p{font:400 46px/1.3 Corbel,"Segoe UI",sans-serif;margin:0;color:#c9d6b4;max-width:22em}',
};

const text = (result) => (result && result.content && result.content.map((b) => b.text || "").join("\n")) || "";
const first = (result) => {
  try {
    return JSON.parse(result.content[0].text);
  } catch {
    return {};
  }
};

function scratch(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jv-slop-gate-" + name + "-"));
  return dir;
}

async function main() {
  const lints = ["design-lint", "copy-lint", "pacing-lint"].filter((n) => {
    try {
      require(path.join(appRoot, "lib", "slop", n));
      return true;
    } catch {
      return false;
    }
  });
  check("linters load (design, copy, pacing)", lints.length === 3, "loaded: " + lints.join(", "));

  const approvals = [];
  const dataRoot = scratch("a");
  const handler = createMcpHandler({ dataRoot, appRoot, extraTools: agentToolSpecs(), approveTool: async (call) => { approvals.push(call.name); } });

  // An outside agent: one refusal, then the same call is kept with its problems.
  let r = await handler.callTool("jeditor_set_card_html", SLOP_CARD, { client: "terminal" });
  let body = first(r);
  check("outside agent: slop card is turned down", r.isError === true && Array.isArray(body.problems) && body.problems.length >= 2, text(r));
  check("refusal names a fix for each problem", (body.problems || []).every((p) => / Fix: /.test(p)), JSON.stringify(body.problems));
  check("refusal wording has no em dash", !/—/.test(text(r)), text(r));
  r = await handler.callTool("jeditor_set_card_html", SLOP_CARD, { client: "terminal" });
  check("outside agent: second try is kept, problems listed", !r.isError && /landedWithProblems/.test(text(r)), text(r));

  // An in-app agent: three refusals, then kept.
  const inApp = { harness: "claude-code", chatId: "chat-1", projectId: "" };
  gate.setAsked({ chatId: "chat-1" }, ["Make a title card for my notes app"]);
  const outcomes = [];
  for (let i = 0; i < 4; i += 1) outcomes.push((await handler.callTool("jeditor_set_card_html", SLOP_CARD, inApp)).isError === true);
  check("in-app agent: refused three times, kept on the fourth", outcomes.join() === "true,true,true,false", outcomes.join());
  // A new message from the person gives a fresh budget.
  gate.setAsked({ chatId: "chat-1" }, ["Make a title card for my notes app", "try again"]);
  r = await handler.callTool("jeditor_set_card_html", SLOP_CARD, inApp);
  check("a new message resets the budget", r.isError === true, text(r));

  // A clean card is saved and nothing is said about it.
  r = await handler.callTool("jeditor_set_card_html", CLEAN_CARD, { harness: "claude-code", chatId: "chat-2" });
  check("clean card is saved", !r.isError && Boolean(first(r).card || first(r).cardId || first(r).id || /"id"/.test(text(r))), text(r));
  check("clean card carries no slop verdict", !/"verdict":"slop"|landedWithProblems/.test(text(r)), text(r));

  // What the person asked for is theirs to have.
  gate.setAsked({ chatId: "chat-3" }, ["I want a purple to blue gradient background with a glass badge, the Inter font, gradient text with a glow, emoji, everything centered, a pulsing pill button. Use the words Unlock Your Potential, Get Started, seamless, elevated and effortless."]);
  r = await handler.callTool("jeditor_set_card_html", SLOP_CARD, { harness: "claude-code", chatId: "chat-3" });
  check("a look the person asked for is not turned down", !r.isError, text(r));

  // The pref turns the gate off.
  const offRoot = scratch("off");
  fs.writeFileSync(path.join(offRoot, "jeditor-prefs.json"), JSON.stringify({ slopGate: false }));
  const off = createMcpHandler({ dataRoot: offRoot, appRoot, extraTools: agentToolSpecs() });
  r = await off.callTool("jeditor_set_card_html", SLOP_CARD, { client: "terminal" });
  check("slopGate off: the card is saved unchecked", !r.isError && !/slopCheck/.test(text(r)), text(r));

  // A script is turned down before anyone is asked to pay for it.
  approvals.length = 0;
  r = await handler.callTool("jeditor_tts", { lines: [
    { text: "In today's fast-paced world, your notes deserve more — they deserve Quill." },
    { text: "It's not just an app, it's a game-changer that will elevate your workflow." },
    { text: "Unlock seamless productivity and take your ideas to the next level." },
    { text: "Ready to transform the way you think? Get started today." },
  ] }, { client: "terminal" });
  check("slop script is turned down", r.isError === true && Array.isArray(first(r).problems), text(r));
  check("no approval was asked for a script that was turned down", approvals.length === 0, approvals.join());

  // An animation render is refused; the preview only carries the note.
  gate.resetForTests();
  const anim = { html: SLOP_CARD.html, css: SLOP_CARD.css, durationMs: 4000 };
  let v = await gate.review("jeditor_render_animation", anim, { dataRoot, appRoot, meta: { client: "terminal" } });
  check("slop animation render is refused", Boolean(v && v.refuse && v.refuse.problems.length), JSON.stringify(v));
  v = await gate.review("jeditor_animation_frames", anim, { dataRoot, appRoot, meta: { client: "terminal" } });
  check("slop animation preview is shown with the problems, not refused", Boolean(v && v.note && !v.refuse && v.note.verdict === "slop"), JSON.stringify(v));

  // A plan with one even pace.
  gate.resetForTests();
  const even = {
    scenes: [1, 2, 3, 4, 5].map((n) => ({ html: '<div class="p"><h1>Fold ' + n + "</h1></div>", css: CLEAN_CARD.css.replace(".plate", ".p"), durationMs: 3000, transition: "fade" })),
  };
  v = await gate.review("jeditor_render_animation", even, { dataRoot, appRoot, meta: { client: "terminal" } });
  const said = JSON.stringify(v || {});
  check("five equal scenes joined by fades are called out", /scene/i.test(said) && Boolean(v && (v.refuse || v.note)), said);

  // No shipped preset is refused when used as it comes, alone or as a scene.
  gate.resetForTests();
  const presets = require(path.join(appRoot, "lib", "animation-presets")).PRESET_NAMES;
  const refusedPresets = [];
  for (const preset of presets) {
    v = await gate.review("jeditor_render_animation", { preset, name: preset }, { dataRoot, appRoot, meta: { client: "terminal" } });
    if (v && v.refuse) refusedPresets.push(preset + ": " + v.refuse.problems.join(" | "));
  }
  check("no shipped preset is refused as it comes (" + presets.length + " presets)", refusedPresets.length === 0, refusedPresets.join("\n     "));

  // The gate is quick enough to sit in front of every call.
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 20; i += 1) await gate.review("jeditor_set_card_html", Object.assign({}, CLEAN_CARD, { name: "t" + i }), { dataRoot, appRoot, meta: { client: "terminal" } });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 20;
  check("a card review takes under 60 ms (" + ms.toFixed(1) + " ms)", ms < 60);

  for (const dir of [dataRoot, offRoot]) fs.rmSync(dir, { recursive: true, force: true });
  console.log(failed ? "\n" + failed + " failed" : "\nall passed");
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
