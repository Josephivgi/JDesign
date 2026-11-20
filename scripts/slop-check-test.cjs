#!/usr/bin/env node
"use strict";

// Checks the measured slop check on clips it can be sure about:
//   node scripts/slop-check-test.cjs
// ffmpeg builds small synthetic clips in a scratch folder (a flat purple clip,
// neon cyan on black, evenly cut scenes, unevenly cut scenes with motion, a
// centered and an off-center layout, a flat tone against shaped sound), then
// lib/slop/frame-check.js has to find the tell in each and stay quiet on the
// clean ones. The second half runs lib/slop/check.js on saved sources in a
// scratch data folder: a card, a clip with its animation source, a project.
// Prints PASS or FAIL per case and exits 1 on any failure. Every child process
// is hidden and nothing is written outside the scratch folder.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const appRoot = path.join(__dirname, "..");
const frameCheck = require(path.join(appRoot, "lib", "slop", "frame-check"));
const { checkSlop, issuesText, verdictOf, sceneStarts } = require(path.join(appRoot, "lib", "slop", "check"));

const SIZE = "640x360";
let failed = 0;
let passed = 0;

function report(ok, name, detail) {
  if (ok) passed += 1;
  else failed += 1;
  console.log((ok ? "PASS " : "FAIL ") + name + (detail ? "  " + detail : ""));
}

function rulesOf(result) {
  return (result.issues || []).map((issue) => issue.rule);
}

function ffmpeg(bin, args) {
  const out = spawnSync(bin, ["-hide_banner", "-loglevel", "error", "-y"].concat(args), { windowsHide: true, encoding: "utf8" });
  if (out.status !== 0) throw new Error("ffmpeg could not build a test clip: " + String(out.stderr || out.error || "").trim().split(/\r?\n/).pop());
}

const ENCODE = ["-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-r", "24"];

// Solid scenes joined with hard cuts. scenes: [[hexColor, seconds], ...]
function cutClip(bin, file, scenes, extra) {
  const args = [];
  scenes.forEach(([color, seconds]) => args.push("-f", "lavfi", "-i", "color=c=" + color + ":s=" + SIZE + ":r=24:d=" + seconds));
  let graph = scenes.map((_, i) => "[" + i + ":v]").join("") + "concat=n=" + scenes.length + ":v=1:a=0[joined]";
  graph += extra ? ";" + extra : ";[joined]null[out]";
  ffmpeg(bin, args.concat(["-filter_complex", graph, "-map", "[out]"], ENCODE, [file]));
}

function buildClips(bin, dir) {
  const clips = {};
  const p = (name) => (clips[name] = path.join(dir, name + ".mp4"));
  // 1. One flat indigo purple picture.
  ffmpeg(bin, ["-f", "lavfi", "-i", "color=c=0x6d28d9:s=" + SIZE + ":r=24:d=8"].concat(ENCODE, [p("purple")]));
  // 2. Neon cyan block on black.
  ffmpeg(bin, [
    "-f", "lavfi", "-i", "color=c=black:s=" + SIZE + ":r=24:d=8",
    "-f", "lavfi", "-i", "color=c=0x00e5ff:s=220x70:r=24:d=8",
    "-filter_complex", "[0:v][1:v]overlay=x='60+mod(t*30,300)':y=140[out]", "-map", "[out]",
  ].concat(ENCODE, [p("cyan")]));
  // 3. Four scenes of 2 s each: cuts on a metronome.
  cutClip(bin, p("even"), [["0xb5651d", 2], ["0x1f6f56", 2], ["0xe9e4d4", 2], ["0x14213d", 2]]);
  // 4. Four scenes of different lengths with a block that keeps moving, on
  //    muted colors: nothing to find.
  ffmpeg(bin, [
    "-f", "lavfi", "-i", "color=c=0xb5651d:s=" + SIZE + ":r=24:d=1.2",
    "-f", "lavfi", "-i", "color=c=0x1f6f56:s=" + SIZE + ":r=24:d=4",
    "-f", "lavfi", "-i", "color=c=0xe9e4d4:s=" + SIZE + ":r=24:d=2",
    "-f", "lavfi", "-i", "color=c=0x14213d:s=" + SIZE + ":r=24:d=5.5",
    "-f", "lavfi", "-i", "color=c=0xf2f2f2:s=90x60:r=24:d=12.7",
    "-filter_complex", "[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0[joined];[joined][4:v]overlay=x='30+mod(t*45,480)':y='40+20*floor(t/3)'[out]", "-map", "[out]",
  ].concat(ENCODE, [p("varied")]));
  // 5. A dark block dead center on paper, still for 8 s.
  ffmpeg(bin, [
    "-f", "lavfi", "-i", "color=c=0xefe9dc:s=" + SIZE + ":r=24:d=8",
    "-f", "lavfi", "-i", "color=c=0x2b2b2b:s=280x120:r=24:d=8",
    "-filter_complex", "[0:v][1:v]overlay=x=(W-w)/2:y=(H-h)/2[out]", "-map", "[out]",
  ].concat(ENCODE, [p("centered")]));
  // 6. The same block anchored to the left edge, sliding in now and then.
  ffmpeg(bin, [
    "-f", "lavfi", "-i", "color=c=0xefe9dc:s=" + SIZE + ":r=24:d=8",
    "-f", "lavfi", "-i", "color=c=0x2b2b2b:s=280x120:r=24:d=8",
    "-filter_complex", "[0:v][1:v]overlay=x='40+12*sin(t*3)*lt(mod(t,2),1)':y=60[out]", "-map", "[out]",
  ].concat(ENCODE, [p("offcenter")]));
  // 7 and 8. A tone at one level, and a tone that fades in, lifts and ducks.
  clips.tone = path.join(dir, "tone.wav");
  ffmpeg(bin, ["-f", "lavfi", "-i", "sine=frequency=330:duration=10", clips.tone]);
  clips.shaped = path.join(dir, "shaped.wav");
  ffmpeg(bin, ["-f", "lavfi", "-i", "sine=frequency=330:duration=10", "-af", "volume='if(lt(t,3),0.08+0.1*t,if(lt(t,6),1,0.25))':eval=frame", clips.shaped]);
  return clips;
}

async function frameCases(bin, clips) {
  const run = (name, opts) => frameCheck.checkFrames(clips[name], Object.assign({ ffmpeg: bin }, opts || {}));
  const has = (result, rule) => rulesOf(result).includes(rule);
  const line = (result) => "found: " + (rulesOf(result).join(", ") || "nothing");

  let r = await run("purple");
  report(has(r, "purple-dominant"), "flat purple clip is purple-dominant", line(r));
  report(has(r, "static-picture"), "flat purple clip is a static picture", line(r));
  const purple = r.issues.find((i) => i.rule === "purple-dominant");
  report(Boolean(purple && purple.hard && purple.what && purple.fix && purple.where && purple.source === "frames"), "an issue carries rule, hard, what, fix, where and source");

  r = await run("purple", { asked: "Make the whole thing deep purple please." });
  report(!has(r, "purple-dominant"), "purple the person asked for is not an issue", line(r));

  r = await run("purple", { asked: "DON'T: Use the default AI look: purple or blue gradients, glow, everything centered. Make a promo." });
  report(has(r, "purple-dominant"), "purple the person turned down is still an issue", line(r));
  report(frameCheck.askedFor("all-centered", "No purple, but keep it centered.") && !frameCheck.askedFor("purple-dominant", "No purple, but keep it centered."), "asked for is read per sentence and per clause");

  r = await run("purple", { allow: ["purple-dominant", "oversaturated", "static-picture"] });
  report(r.issues.length === 0 && r.ok === true, "allow drops the named rules", line(r));

  r = await run("cyan");
  report(has(r, "cyan-on-black"), "neon cyan on black is found", line(r));
  report(!has(r, "purple-dominant"), "cyan clip is not called purple", line(r));

  r = await run("even");
  report(has(r, "even-cuts"), "four 2 s scenes are even cuts", line(r) + ", cuts at " + JSON.stringify(r.stats.cuts));
  report(Array.isArray(r.stats.cuts) && r.stats.cuts.length === 3, "three cuts detected in the even clip", JSON.stringify(r.stats.cuts));

  r = await run("varied");
  report(r.issues.length === 0, "uneven scenes with motion on muted colors are clean", line(r) + ", cuts at " + JSON.stringify(r.stats.cuts));
  report(Array.isArray(r.stats.cuts) && r.stats.cuts.length === 3, "three cuts detected in the varied clip", JSON.stringify(r.stats.cuts));

  r = await run("centered");
  report(has(r, "all-centered"), "a block held dead center is all-centered", line(r) + " " + JSON.stringify({ centered: r.stats.centeredFrames, judged: r.stats.judgedFrames }));

  r = await run("offcenter");
  report(!has(r, "all-centered"), "a block on the left edge is not all-centered", line(r) + " " + JSON.stringify({ centered: r.stats.centeredFrames, judged: r.stats.judgedFrames }));
  report(!has(r, "static-picture"), "a block that slides now and then is not a static picture", line(r) + " still " + r.stats.stillShare);

  r = await run("tone");
  report(has(r, "flat-audio"), "a tone at one level is flat audio", line(r));
  const flat = r.issues.find((i) => i.rule === "flat-audio");
  report(Boolean(flat && flat.source === "audio"), "the audio issue says it came from the sound");

  r = await run("shaped");
  report(!has(r, "flat-audio"), "a tone that fades in and ducks is not flat", line(r) + " spread " + r.stats.loudnessSpreadLu + " LU");

  r = await frameCheck.checkFrames(path.join(path.dirname(clips.tone), "missing.mp4"), { ffmpeg: bin });
  report(r.issues.length === 0 && r.skipped.length === 1, "a missing file is skipped with a reason, not passed", JSON.stringify(r.skipped));

  const controller = new AbortController();
  controller.abort();
  r = await run("varied", { signal: controller.signal });
  report(r.aborted === true && r.issues.length === 0, "an aborted check stops and says so");

  const brief = frameCheck.checkTextTiming([
    { text: "Twelve whole words flash by here far too fast to ever be read", durationMs: 900, where: "scene 2" },
    { text: "Four words, long hold", durationMs: 3000, where: "scene 3" },
    { text: "NEW", durationMs: 300, where: "scene 4" },
  ]);
  report(brief.length === 1 && brief[0].rule === "text-too-brief" && brief[0].where === "scene 2", "text held too briefly is found once", JSON.stringify(brief.map((i) => i.where)));
}

async function sourceCases(bin, clips, dataRoot) {
  const { loadState } = require(path.join(appRoot, "lib", "workspace-store"));
  const { applyCardEdit } = require(path.join(appRoot, "lib", "card-apply"));
  const { copyPathIntoLibrary } = require(path.join(appRoot, "lib", "library-io"));
  const { saveAnimationSource } = require(path.join(appRoot, "lib", "animation-source"));
  const projects = require(path.join(appRoot, "lib", "ai-projects"));
  const state = await loadState(dataRoot);
  const workspaceId = state.activeWorkspaceId;
  // The static linters belong to other files. A linter counts as here once it
  // loads and exports its entry function; until then checkSlop must skip it.
  const entry = { "design-lint": "lintDesign", "copy-lint": "lintCopy", "pacing-lint": "lintVideoPlan" };
  const lintersHere = Object.keys(entry).filter((name) => {
    try {
      return typeof require(path.join(appRoot, "lib", "slop", name))[entry[name]] === "function";
    } catch {
      return false;
    }
  });
  console.log("     static linters ready: " + (lintersHere.join(", ") || "none"));

  // A card with the default look in its saved source.
  const made = await applyCardEdit({
    dataRoot,
    workspaceId,
    patch: {
      name: "Slop test card",
      kind: "title_card",
      durationMs: 3000,
      composition: {
        html: '<div class="wrap"><h1>Unlock seamless productivity</h1><p>Elevate your workflow today</p><button>Get Started</button></div>',
        css: ".wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;background:linear-gradient(135deg,#4f46e5,#a855f7);font-family:Inter,system-ui;color:#fff;text-align:center}h1{background:linear-gradient(90deg,#fff,#c4b5fd);-webkit-background-clip:text;color:transparent}button{border-radius:999px;box-shadow:0 0 40px #a855f7}",
      },
    },
  });
  let r = await checkSlop({ dataRoot, appRoot }, { cardId: made.card.id });
  report(["ok", "tells", "slop"].includes(r.verdict) && Array.isArray(r.issues) && Array.isArray(r.checked) && Array.isArray(r.skipped), "checkSlop on a card returns verdict, issues, checked and skipped", r.verdict + ", checked: " + (r.checked.join(", ") || "nothing") + ", issues: " + (rulesOf(r).join(", ") || "none"));
  report(r.skipped.some((s) => s.check === "frames" && /jeditor_render_card/.test(s.why)), "a card with no rendered picture says to render it", JSON.stringify(r.skipped.filter((s) => s.check === "frames")));
  for (const name of ["design-lint", "copy-lint"]) {
    const kind = name.replace("-lint", "");
    if (lintersHere.includes(name)) report(r.checked.includes(kind) && r.issues.some((i) => i.source === kind), "the " + kind + " linter ran on the card and found the default look", rulesOf({ issues: r.issues.filter((i) => i.source === kind) }).join(", "));
    else report(r.skipped.some((s) => s.check === kind), "a missing " + kind + " linter is skipped, not an error", JSON.stringify(r.skipped.filter((s) => s.check === kind)));
  }

  // A clip with a saved animation source, in a project.
  const clip = await copyPathIntoLibrary(dataRoot, clips.purple, { workspaceId, name: "Purple promo", mime: "video/mp4", source: "animation" });
  saveAnimationSource(dataRoot, workspaceId, clip.item.id, {
    html: '<div class="stage"><h1>Notes that keep up</h1></div>',
    css: ".stage{position:absolute;inset:0;background:#6d28d9;color:#fff;display:grid;place-items:center;font-family:Georgia,serif}",
    js: "",
    aspectRatio: "16/9",
    durationMs: 8000,
  }, { durationMs: 8000, fps: 24, aspectRatio: "16/9" });
  const project = projects.createProject(dataRoot, { workspaceId, name: "Slop test project", aspectRatio: "16/9", assets: [{ id: clip.item.id, kind: "video" }] });

  r = await checkSlop({ dataRoot, appRoot }, { projectId: project.id });
  const purple = r.issues.find((i) => i.rule === "purple-dominant");
  report(Boolean(purple) && purple.source === "frames" && r.verdict === "slop" && r.ok === false, "checkSlop on a project measures its clip and calls purple slop", r.verdict + ", issues: " + rulesOf(r).join(", "));
  report(r.checked.includes("frames"), "the project check lists frames as checked", r.checked.join(", "));

  r = await checkSlop({ dataRoot, appRoot, frames: false }, { projectId: project.id });
  report(!r.issues.some((i) => i.source === "frames") && r.skipped.some((s) => s.check === "frames"), "frames false skips the measurement and says so", JSON.stringify(r.skipped.filter((s) => s.check === "frames")));

  r = await checkSlop({ dataRoot, appRoot, asked: "I want a purple background, static, one title." }, { libraryId: clip.item.id });
  report(!r.issues.some((i) => i.rule === "purple-dominant" || i.rule === "static-picture"), "what the person asked for is left alone on a clip", rulesOf(r).join(", ") || "nothing");

  // Burned-in text with too little time.
  projects.updateProject(dataRoot, project.id, { state: { selectedAssetId: clip.item.id, studio: { texts: [{ id: "t1", kind: "caption", text: "Every note you take lands in one place and stays there", startMs: 1000, durationMs: 800, videoId: clip.item.id }] } } });
  r = await checkSlop({ dataRoot, appRoot, frames: false }, { projectId: project.id });
  report(r.issues.some((i) => i.rule === "text-too-brief" && /burned-in text at 1 s/.test(i.where)), "burned-in text held too briefly is found from the project state", JSON.stringify(r.issues.filter((i) => i.rule === "text-too-brief").map((i) => i.where)));

  for (const [label, target] of [["card", { cardId: "does-not-exist" }], ["project", { projectId: "does-not-exist" }], ["clip", { libraryId: "does-not-exist" }], ["nothing", {}]]) {
    let message = "";
    try {
      await checkSlop({ dataRoot, appRoot }, target);
    } catch (error) {
      message = error && error.notFound ? String(error.message) : "";
    }
    report(/^[A-Z].*\.$/.test(message) && message.length <= 300 && /jeditor_/.test(message), "an unknown " + label + " id is refused with one sentence", message);
  }

  const text = issuesText([
    { rule: "a", what: "First thing.", fix: "Do this.", where: "scene 2" },
    { rule: "b", what: "Second thing", fix: "Do that.", where: "the whole video" },
  ]);
  report(text === "1. First thing. Where: scene 2. Fix: Do this.\n2. Second thing. Fix: Do that.", "issuesText is a numbered list with where and fix", JSON.stringify(text));
  report(verdictOf([{ rule: "a", hard: false }, { rule: "b", hard: false }]) === "tells" && verdictOf([{ rule: "a", hard: true }]) === "slop" && verdictOf([{ rule: "a" }, { rule: "b" }, { rule: "c" }]) === "slop" && verdictOf([]) === "ok", "one hard issue or three tells is slop, fewer is tells");
  const starts = sceneStarts({ scenes: [{ durationMs: 3000 }, { durationMs: 2000, transition: "cut" }, { durationMs: 4000 }], transitionMs: 400 });
  report(JSON.stringify(starts) === "[0,2600,4600]", "scene starts follow the renderer's overlap rule", JSON.stringify(starts));

  // The tool spec, as the MCP server would call it.
  const { slopToolSpecs } = require(path.join(appRoot, "lib", "slop", "check-tool"));
  const spec = slopToolSpecs()[0];
  let refusal = "";
  try {
    spec.validate({});
  } catch (error) {
    refusal = String(error.message);
  }
  report(/^Pass projectId, cardId or libraryId/.test(refusal), "jeditor_check_slop refuses a call with no id", refusal);
  const out = await spec.run({ dataRoot, appRoot, meta: {} }, { projectId: project.id });
  report(out.verdict === "slop" && out.issues.length > 0 && typeof out.note === "string", "jeditor_check_slop returns the verdict, the issues and a next step", out.verdict + ", " + out.issues.length + " issues");

  await gateCases(clips, dataRoot, { workspaceId, project, clip, projects });
  projects.closeAiProjectStores();
}

// The after-turn gate's decisions, with the agent played by a callback. This
// covers when it runs and when it stops; the real agent turn is the smoke.
async function gateCases(clips, dataRoot, made) {
  const gate = require(path.join(appRoot, "lib", "slop", "after-turn"));
  const { recordAction } = require(path.join(appRoot, "lib", "agent-activity"));
  const { libraryFilePath } = require(path.join(appRoot, "lib", "library-io"));
  const { workspaceId, project, clip, projects } = made;
  projects.updateProject(dataRoot, project.id, { state: { selectedAssetId: clip.item.id, studio: { texts: [] } } });
  const base = { dataRoot, appRoot, harnessId: "test-agent", projectId: project.id, workspaceId, asked: "Make a promo for a notes app." };
  const run = async (extra) => {
    const lines = [];
    const sends = [];
    const opts = Object.assign({}, base, { say: (text, more) => lines.push(Object.assign({ text }, more)), send: async (text) => (sends.push(text), { ok: true }) }, extra || {});
    const report = await gate.runAfterTurn(opts);
    return { report, lines, sends };
  };
  const saved = process.env.JEDITOR_GATE_ROUNDS;
  delete process.env.JEDITOR_GATE_ROUNDS;
  try {
    let since = new Date(Date.now() - 1000).toISOString();
    let r = await run({ since });
    report(r.report.ran === false && r.sends.length === 0 && /no design or render tool/.test(r.report.why), "the gate does nothing after a turn with no design or render tool", r.report.why);

    recordAction(dataRoot, { tool: "jeditor_render_animation", client: "acp", harness: "test-agent", projectId: project.id, workspaceId, args: { projectId: project.id }, ok: true, summary: "{}" });
    recordAction(dataRoot, { tool: "jeditor_render_animation", client: "acp", harness: "other-agent", projectId: "another-project", workspaceId, args: {}, ok: true, summary: "{}" });

    r = await run({ since, harnessId: "someone-else", projectId: "no-such-project" });
    report(r.report.ran === false, "another agent's render in another project does not start the gate here", r.report.why);

    // An agent that changes nothing: one fix request, then the gate gives up.
    r = await run({ since });
    report(r.report.ran && r.sends.length === 1 && r.report.rounds === 1 && /did not shrink/.test(r.report.why), "a fix turn that fixes nothing ends the gate after one round", r.report.why + ", sends " + r.sends.length);
    report(r.lines.length === 2 && /^Turn stopped: JV checked the result and asked for \d+ fix(es)?: .*purple dominant/.test(r.lines[0].text) && /^Turn stopped: JV checked again and \d+ issues? (is|are) left: /.test(r.lines[1].text), "the chat gets one line for the request and one for what is left", JSON.stringify(r.lines.map((l) => l.text)));
    report(r.lines[0].kind === "slop-gate" && r.lines[0].sent === r.sends[0], "the request line carries what was sent to the agent");
    const sent = r.sends[0] || "";
    report(/automatic check, not a message from the person/.test(sent) && sent.includes('jeditor_check_slop {"projectId":"' + project.id + '"}') && /Make a promo for a notes app\./.test(sent) && /^1\. /m.test(sent), "the fix request lists the issues, names the tool call and keeps what was asked");

    // An agent that fixes the picture: the measured issue is gone afterwards.
    const file = libraryFilePath(dataRoot, workspaceId, clip.item);
    const original = fs.readFileSync(file);
    r = await run({ since, send: async () => (fs.copyFileSync(clips.varied, file), { ok: true }) });
    report(r.report.rounds >= 1 && !(r.report.issues || []).some((i) => i.rule === "purple-dominant"), "after a real fix the measured issue is gone", r.report.why + ", left: " + ((r.report.issues || []).map((i) => i.rule).join(", ") || "nothing"));
    fs.writeFileSync(file, original);

    r = await run({ since, asked: "Deep purple background, one still title, loud color.", send: async () => ({ ok: true }) });
    report(!r.lines.some((l) => /purple dominant|static picture|oversaturated/.test(l.text)), "the gate never asks to undo what the person asked for", r.report.why + ", lines: " + JSON.stringify(r.lines.map((l) => l.text)));

    r = await run({ since, send: async () => ({ stopped: true }) });
    report(r.report.stopped === true && r.lines.length === 1, "Stop during the fix turn ends the gate", r.report.why);
    r = await run({ since, stopped: () => true });
    report(r.report.stopped === true && r.sends.length === 0 && r.lines.length === 0, "Stop during the check ends the gate before anything is sent", r.report.why);

    r = await run({ since, send: async () => ({ failed: true, why: "agent died" }) });
    report(r.report.failed === true && r.report.rounds === 1, "a fix turn that fails ends the gate without throwing", r.report.why);

    process.env.JEDITOR_GATE_ROUNDS = "0";
    r = await run({ since });
    report(r.report.ran === false && r.sends.length === 0, "JEDITOR_GATE_ROUNDS=0 turns the gate off", r.report.why);
    delete process.env.JEDITOR_GATE_ROUNDS;

    fs.writeFileSync(path.join(dataRoot, "jeditor-prefs.json"), JSON.stringify({ slopGate: false }));
    r = await run({ since });
    report(r.report.ran === false && /off/.test(r.report.why), "the slopGate pref turned off stops the gate", r.report.why);
    fs.rmSync(path.join(dataRoot, "jeditor-prefs.json"));

    const logged = fs.readFileSync(path.join(dataRoot, "slop-gate.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    report(logged.length >= 8 && logged.every((entry) => entry.at && entry.report), "every gate run leaves one line in slop-gate.log", logged.length + " lines");
  } finally {
    if (saved == null) delete process.env.JEDITOR_GATE_ROUNDS;
    else process.env.JEDITOR_GATE_ROUNDS = saved;
  }
}

async function main() {
  const bin = frameCheck.findFfmpeg();
  if (!bin) {
    console.log("FAIL ffmpeg is not installed, so nothing could be measured");
    process.exitCode = 1;
    return;
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "jv-slop-test-"));
  try {
    const clips = buildClips(bin, scratch);
    await frameCases(bin, clips);
    const dataRoot = path.join(scratch, "data");
    fs.mkdirSync(dataRoot, { recursive: true });
    await sourceCases(bin, clips, dataRoot);
  } finally {
    try {
      require(path.join(appRoot, "lib", "agent-activity")).closeActivityStores();
    } catch {
      /* never opened */
    }
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
  console.log(passed + " passed, " + failed + " failed");
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  console.log("FAIL run  " + ((error && error.stack) || error));
  process.exitCode = 1;
});
