"use strict";

// One slop check for a card, a clip, a finished video or a whole project. It
// gathers everything JV knows about the target (the saved html, css and vars,
// the animation source and its scenes, the narration scripts, the burned-in
// texts, the rendered file) and runs every check that applies: the static
// linters beside this file on the source, and frame-check on what was
// actually rendered.
//
// The linters are written separately and may be missing: each is required
// lazily and a missing one is listed in `skipped`, never an error. A check
// that could not run is always listed there with the reason, so "nothing
// found" is never confused with "nothing measured".

const fs = require("node:fs");
const path = require("node:path");

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
const frameCheck = lazy("./frame-check");

const MAX_CLIPS = 4;
const MAX_ISSUES = 24;

const str = (v) => (typeof v === "string" ? v : "");
const plain = (v) => Boolean(v && typeof v === "object" && !Array.isArray(v));

function sizeFor(aspect) {
  const a = String(aspect || "").toLowerCase();
  if (a === "9/16" || a === "vertical") return { width: 1080, height: 1920 };
  if (a === "1/1" || a === "square") return { width: 1080, height: 1080 };
  if (a === "4/5") return { width: 1080, height: 1350 };
  return { width: 1920, height: 1080 };
}

function quoted(id) {
  const text = String(id == null ? "" : id).trim();
  return JSON.stringify(text.length > 60 ? text.slice(0, 57) + "..." : text);
}

// A refusal an agent can act on: one sentence, the id, where the ids come from.
function notFound(message) {
  const error = new Error(message);
  error.notFound = true;
  return error;
}

// ---------------------------------------------------------------- collector

function collector(ctx) {
  const out = { issues: [], checked: [], skipped: [] };
  const opts = { asked: str(ctx.asked), style: str(ctx.style), styles: Array.isArray(ctx.styles) ? ctx.styles : [], allow: Array.isArray(ctx.allow) ? ctx.allow : [] };
  const ran = (label) => {
    if (!out.checked.includes(label)) out.checked.push(label);
  };
  const skip = (check, why) => {
    if (!out.skipped.some((s) => s.check === check && s.why === why)) out.skipped.push({ check, why });
  };
  const add = (source, problems, where) => {
    for (const p of Array.isArray(problems) ? problems : []) {
      if (!p || !p.rule) continue;
      out.issues.push({
        rule: String(p.rule),
        hard: Boolean(p.hard),
        what: String(p.what || "").trim(),
        fix: String(p.fix || "").trim(),
        where: [where, p.where].map((w) => String(w || "").trim()).filter(Boolean).join(", "),
        source: p.source && ["design", "copy", "pacing", "frames", "audio"].includes(p.source) ? p.source : source,
      });
    }
  };
  return { out, opts, ran, skip, add };
}

// ------------------------------------------------------- the static linters

// Runs a linter and never lets it take the check down: a throw inside one is
// a skipped check with the reason.
function guarded(c, label, fn) {
  try {
    return fn();
  } catch (error) {
    c.skip(label, "the check failed: " + String((error && error.message) || error).split(/\r?\n/)[0].slice(0, 120));
    return null;
  }
}

function lintDesignInto(c, design, base, where) {
  const mod = designLint();
  if (!mod || typeof mod.lintDesign !== "function") return c.skip("design", "the design linter is not installed");
  if (!str(design.html).trim() && !str(design.css).trim() && !str(design.js).trim()) return undefined;
  const result = guarded(c, "design", () => mod.lintDesign(design, c.opts));
  if (!result) return undefined;
  let problems = Array.isArray(result.problems) ? result.problems : [];
  if (base && problems.length) {
    // What ships inside a preset is the app's to fix, not the agent's.
    const shipped = guarded(c, "design", () => (mod.lintDesign(base, c.opts) || {}).problems) || [];
    problems = problems.filter((p) => !shipped.some((q) => q.rule === p.rule));
  }
  c.ran("design");
  c.add("design", problems, where);
  return undefined;
}

function visibleTexts(design) {
  const mod = copyLint();
  if (!design) return [];
  if (mod && typeof mod.visibleText === "function") {
    try {
      const html = design.js ? design.html + "\n<script>" + design.js + "</script>" : design.html;
      const texts = mod.visibleText(html);
      if (Array.isArray(texts)) return texts.map(String).filter((t) => t.trim());
    } catch {
      /* fall through to the plain strip */
    }
  }
  return str(design.html)
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .split(/<[^>]+>/)
    .map((t) => t.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function lintCopyInto(c, texts, kind, where, baseTexts) {
  const list = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t || "")).filter((t) => t.trim());
  if (!list.length) return undefined;
  const mod = copyLint();
  if (!mod || typeof mod.lintCopy !== "function") return c.skip("copy", "the copy linter is not installed");
  const result = guarded(c, "copy", () => mod.lintCopy(list, Object.assign({ kind }, c.opts)));
  if (!result) return undefined;
  let problems = Array.isArray(result.problems) ? result.problems : [];
  if (baseTexts && baseTexts.length && problems.length) {
    const shipped = guarded(c, "copy", () => (mod.lintCopy(baseTexts, Object.assign({ kind }, c.opts)) || {}).problems) || [];
    problems = problems.filter((p) => !shipped.some((q) => q.rule === p.rule && String(q.what) === String(p.what)));
  }
  c.ran("copy");
  c.add("copy", problems, where);
  return undefined;
}

function lintPlanInto(c, renderArgs, where) {
  const mod = pacingLint();
  if (!mod || typeof mod.lintVideoPlan !== "function") return c.skip("pacing", "the pacing linter is not installed");
  const result = guarded(c, "pacing", () => mod.lintVideoPlan(renderArgs, c.opts));
  if (!result) return undefined;
  c.ran("pacing");
  c.add("pacing", result.problems, where);
  return undefined;
}

function lintNarrationInto(c, lines, where) {
  const mod = pacingLint();
  if (!mod || typeof mod.lintNarration !== "function" || lines.length < 2) return;
  const result = guarded(c, "pacing", () => mod.lintNarration(lines, c.opts));
  if (!result) return;
  c.ran("pacing");
  c.add("pacing", result.problems, where);
}

// ------------------------------------------------------------ saved sources

// One beat of an animation as the page the renderer builds, plus the same
// preset with nothing changed.
async function beatDesign(ctx, workspaceId, raw, shared) {
  const opts = Object.assign({}, shared, raw, {
    colors: Object.assign({}, shared.colors, plain(raw.colors) ? raw.colors : {}),
    vars: Object.assign({}, shared.vars, plain(raw.vars) ? raw.vars : {}),
  });
  delete opts.scenes;
  delete opts.cardId;
  const size = sizeFor(opts.aspectRatio);
  const shape = (src) => ({ html: str(src.html), css: str(src.css), js: str(src.js), vars: src.vars || {}, colors: src.colors || {}, kind: "animation", width: size.width, height: size.height, durationMs: Number(src.durationMs) || undefined });
  const render = require("../animation-render");
  const build = async (o) => {
    // The renderer's own resolver when it is exported; else the preset as is.
    if (typeof render.animationSource === "function") return shape(await render.animationSource(Object.assign({}, o), ctx.dataRoot, workspaceId));
    if (o.preset) {
      const built = require("../animation-presets").buildPreset(o.preset, o.presetParams, { durationMs: o.durationMs });
      const own = str(o.html).trim();
      return shape({
        html: own ? o.html : built.html,
        css: own ? str(o.css) : str(built.css) + (o.css ? "\n" + o.css : ""),
        js: own ? str(o.js) : str(built.js) + (o.js ? "\n" + o.js : ""),
        vars: o.vars,
        colors: o.colors,
        durationMs: o.durationMs == null ? built.durationMs : o.durationMs,
      });
    }
    return shape(o);
  };
  const design = await build(opts);
  let base = null;
  if (opts.preset) {
    try {
      base = await build({ preset: opts.preset, aspectRatio: opts.aspectRatio });
    } catch {
      base = null;
    }
  }
  return { design, base };
}

// The scene starts of a multi scene source, the way the renderer lays them
// out: each scene overlaps the one before it by its transition.
function sceneStarts(src) {
  const scenes = Array.isArray(src && src.scenes) ? src.scenes.filter(plain) : [];
  if (scenes.length < 2) return [];
  const fallbackMs = src.transitionMs == null ? 450 : Number(src.transitionMs);
  const fallbackName = String(src.transition || "fade").toLowerCase();
  const starts = [0];
  let total = Math.max(600, Number(scenes[0].durationMs) || 3000);
  for (let i = 0; i < scenes.length - 1; i += 1) {
    const name = String(scenes[i].transition || fallbackName).toLowerCase();
    const nextMs = Math.max(600, Number(scenes[i + 1].durationMs) || 3000);
    const wanted = Number.isFinite(Number(scenes[i].transitionMs)) && scenes[i].transitionMs != null ? Number(scenes[i].transitionMs) : Number.isFinite(fallbackMs) ? fallbackMs : 450;
    const thisMs = Math.max(600, Number(scenes[i].durationMs) || 3000);
    const ms = name === "cut" ? 0 : Math.max(100, Math.min(1200, Math.floor(Math.min(thisMs, nextMs) / 2), wanted));
    const start = total - ms;
    starts.push(start);
    total = start + nextMs;
  }
  return starts;
}

function audioIdsOf(src) {
  const ids = [];
  if (!src) return ids;
  if (src.audioId) ids.push(String(src.audioId));
  for (const id of Array.isArray(src.audioIds) ? src.audioIds : []) ids.push(String(id));
  for (const a of Array.isArray(src.audios) ? src.audios : []) if (a && a.audioId) ids.push(String(a.audioId));
  return Array.from(new Set(ids));
}

// A voiceover keeps its words in the item's description ("... Script: ...").
function scriptOf(item) {
  const m = /Script:\s*([\s\S]+)$/.exec(str(item && item.description));
  return m ? m[1].trim() : "";
}

// Static checks on one animation source (what jeditor_render_animation saved
// beside the clip). Returns the scene starts for the picture checks.
async function checkAnimationSource(c, ctx, ws, workspaceId, src, where) {
  const fc = frameCheck();
  const shared = { colors: plain(src.colors) ? src.colors : {}, vars: plain(src.vars) ? src.vars : {}, aspectRatio: src.aspectRatio };
  const scenes = Array.isArray(src.scenes) ? src.scenes.filter(plain) : [];
  const beats = scenes.length ? scenes.map((scene, i) => ({ raw: scene, where: "scene " + (i + 1), durationMs: Number(scene.durationMs) || 0 })) : [{ raw: src, where: "", durationMs: Number(src.durationMs) || 0 }];
  const timing = [];
  for (const beat of beats) {
    if (!beat.raw.preset && !str(beat.raw.html).trim() && !str(beat.raw.css).trim() && !str(beat.raw.js).trim()) continue;
    let built;
    try {
      built = await beatDesign(ctx, workspaceId, beat.raw, shared);
    } catch (error) {
      c.skip("design", "the saved source of " + (beat.where || "the clip") + " could not be rebuilt: " + String((error && error.message) || error).slice(0, 100));
      continue;
    }
    const at = [where, beat.where].filter(Boolean).join(", ");
    lintDesignInto(c, built.design, built.base, at);
    const texts = visibleTexts(built.design);
    lintCopyInto(c, texts, "card", at, built.base ? visibleTexts(built.base) : null);
    // Words a scene shows against how long the scene is up. The markup of a
    // preset holds labels the page may never draw, so only code scenes count.
    if (scenes.length && !beat.raw.preset && beat.durationMs && texts.length) timing.push({ text: texts.join(" "), durationMs: beat.durationMs, where: at });
  }
  lintPlanInto(c, src, where);
  const scripts = audioIdsOf(src)
    .map((id) => scriptOf((ws.library || []).find((item) => item && item.id === id)))
    .filter(Boolean);
  if (scripts.length) {
    lintCopyInto(c, scripts, "script", [where, "narration"].filter(Boolean).join(", "));
    lintNarrationInto(c, scripts, [where, "narration"].filter(Boolean).join(", "));
  }
  if (fc && timing.length) {
    c.ran("text timing");
    c.add("pacing", fc.checkTextTiming(timing, c.opts), "");
  }
  return sceneStarts(src);
}

// --------------------------------------------------------- measured checks

async function measure(c, ctx, file, where, options) {
  if (ctx.frames === false) return c.skip("frames", "frames was false, so the rendered file was not measured");
  const fc = frameCheck();
  if (!fc) return c.skip("frames", "the frame checker is not installed");
  if (!file || !fs.existsSync(file)) return c.skip("frames", "there is no rendered file for " + (where || "this target") + " yet");
  const run = options && options.still ? fc.checkStill : fc.checkFrames;
  let result;
  try {
    result = await run(file, Object.assign({ asked: c.opts.asked, allow: c.opts.allow, signal: ctx.signal }, options || {}));
  } catch (error) {
    return c.skip("frames", "the measurement failed: " + String((error && error.message) || error).split(/\r?\n/)[0].slice(0, 120));
  }
  for (const label of result.checked || []) c.ran(label.replace(/\s*\(.*$/, ""));
  for (const s of result.skipped || []) c.skip(s.check, s.why);
  c.add("frames", result.issues, where);
  if (result.aborted) c.out.aborted = true;
  return result;
}

// ------------------------------------------------------------------ targets

async function checkCard(c, ctx, ws, workspaceId, card) {
  const { workspaceDir } = require("../workspace-store");
  const comp = plain(card.composition) ? card.composition : {};
  const size = sizeFor(comp.aspectRatio || card.aspectRatio || "vertical");
  const where = "card " + quoted(card.name || card.id);
  const design = { html: str(comp.html), css: str(comp.css), js: "", vars: plain(comp.vars) ? comp.vars : {}, colors: plain(card.colors) ? card.colors : {}, kind: "card", width: size.width, height: size.height, durationMs: Number(card.durationMs) || undefined };
  lintDesignInto(c, design, null, where);
  const texts = design.html.trim() ? visibleTexts(design) : [];
  // A text card keeps its words in fields, not markup.
  for (const key of ["eyebrow", "headline", "body"]) if (str(comp[key]).trim()) texts.push(comp[key]);
  if (plain(comp.copy)) for (const v of Object.values(comp.copy)) if (typeof v === "string" && v.trim()) texts.push(v);
  lintCopyInto(c, texts, "card", where);
  if (str(comp.cta).trim()) lintCopyInto(c, [comp.cta], "cta", where);
  const fc = frameCheck();
  if (fc && texts.length && Number(card.durationMs)) {
    c.ran("text timing");
    c.add("pacing", fc.checkTextTiming([{ text: texts.join(" "), durationMs: Number(card.durationMs), where }], c.opts), "");
  }
  // The PNG jeditor_render_card wrote, when it is not older than the card.
  const png = path.join(workspaceDir(ctx.dataRoot, workspaceId), "renders", card.id + ".png");
  let fresh = false;
  try {
    fresh = fs.statSync(png).mtimeMs + 2000 >= (Date.parse(card.updatedAt) || 0);
  } catch {
    fresh = false;
  }
  if (ctx.frames === false) c.skip("frames", "frames was false, so the rendered file was not measured");
  else if (!fresh) c.skip("frames", "the card has no current picture: call jeditor_render_card with this cardId, then check again");
  else await measure(c, ctx, png, where, { still: true });
}

// A library clip: its saved source, and the file given (the clip itself, or
// the finished video baked from it).
async function checkClip(c, ctx, ws, workspaceId, item, file, where, project) {
  const { readAnimationSource } = require("../animation-source");
  const src = readAnimationSource(ctx.dataRoot, workspaceId, item.id);
  let starts = [];
  if (src) starts = await checkAnimationSource(c, ctx, ws, workspaceId, src, where);
  else c.skip("design", (where || "the clip") + " has no saved source (it is footage, or was rendered before sources were kept)");
  // Texts burned in by the project render, scoped to this clip.
  if (project) {
    const st = (project.state && project.state.studio) || {};
    const selected = project.state && project.state.selectedAssetId;
    const own = (row) => row && typeof row === "object" && (row.videoId ? row.videoId === item.id : !selected || selected === item.id);
    const rows = (Array.isArray(st.texts) ? st.texts : []).filter(own).filter((row) => str(row.text).trim());
    if (rows.length) {
      lintCopyInto(c, rows.map((row) => row.text), "caption", [where, "burned-in text"].filter(Boolean).join(", "));
      const fc = frameCheck();
      if (fc) {
        c.ran("text timing");
        c.add("pacing", fc.checkTextTiming(rows.map((row) => ({ text: row.text, durationMs: Number(row.durationMs) || 3000, where: "burned-in text at " + (Math.round((Number(row.startMs) || 0) / 100) / 10) + " s" })), c.opts), where);
      }
    }
  }
  await measure(c, ctx, file, where, { sceneStartsMs: starts, generated: Boolean(src) });
}

async function checkProject(c, ctx, project) {
  const { loadWorkspace } = require("../workspace-store");
  const { libraryFilePath } = require("../library-io");
  const { finishedFilePath } = require("../finished-io");
  const ws = await loadWorkspace(ctx.dataRoot, project.workspaceId);
  const state = plain(project.state) ? project.state : {};
  const renders = plain(state.renders) ? state.renders : {};
  const videoIds = (project.assets || []).filter((a) => a && a.kind === "video").map((a) => a.id);
  const ordered = Array.from(new Set([state.selectedAssetId].concat(videoIds).filter((id) => id && videoIds.includes(id))));
  if (!ordered.length) {
    c.skip("frames", "the project has no clip yet");
    return;
  }
  if (ordered.length > MAX_CLIPS) c.skip("clips", "the project has " + ordered.length + " clips; the first " + MAX_CLIPS + " were checked");
  for (const id of ordered.slice(0, MAX_CLIPS)) {
    const item = (ws.library || []).find((entry) => entry && entry.id === id);
    if (!item) continue;
    const where = ordered.length > 1 ? "clip " + quoted(item.name || item.id) : "";
    // The finished video baked from this clip when there is one; the clip
    // itself is what the person sees until then.
    const finished = renders[id] ? (ws.finished || []).find((entry) => entry && entry.id === String(renders[id])) : null;
    let file = finished ? finishedFilePath(ctx.dataRoot, project.workspaceId, finished) : "";
    if (!file || !fs.existsSync(file)) {
      const libraryRender = renders[id] ? (ws.library || []).find((entry) => entry && entry.id === String(renders[id])) : null;
      file = libraryFilePath(ctx.dataRoot, project.workspaceId, libraryRender || item);
    }
    await checkClip(c, ctx, ws, project.workspaceId, item, file, where, project);
    if (c.out.aborted) return;
  }
}

async function checkLibraryId(c, ctx, workspaceId, id) {
  const { loadWorkspace } = require("../workspace-store");
  const { libraryFilePath } = require("../library-io");
  const { finishedFilePath } = require("../finished-io");
  const projects = require("../ai-projects");
  const ws = await loadWorkspace(ctx.dataRoot, workspaceId);
  const item = (ws.library || []).find((entry) => entry && entry.id === id);
  if (item) {
    if (item.kind === "audio") {
      const script = scriptOf(item);
      if (script) lintCopyInto(c, [script], "script", "narration " + quoted(item.name || item.id));
      await measure(c, ctx, libraryFilePath(ctx.dataRoot, workspaceId, item), "audio " + quoted(item.name || item.id), {});
      return;
    }
    if (item.kind === "image") {
      await measure(c, ctx, libraryFilePath(ctx.dataRoot, workspaceId, item), "image " + quoted(item.name || item.id), { still: true });
      return;
    }
    await checkClip(c, ctx, ws, workspaceId, item, libraryFilePath(ctx.dataRoot, workspaceId, item), "", null);
    return;
  }
  const finished = (ws.finished || []).find((entry) => entry && entry.id === id);
  if (!finished) throw notFound("No clip or finished video with id " + quoted(id) + " in this workspace. Call jeditor_snapshot for the library and finished ids.");
  const file = finishedFilePath(ctx.dataRoot, workspaceId, finished);
  // The clip it was baked from, when a project still points at it.
  let source = null;
  let owner = null;
  for (const projectId of Array.isArray(finished.projectIds) ? finished.projectIds : []) {
    const project = projects.getProject(ctx.dataRoot, String(projectId));
    const renders = (project && project.state && project.state.renders) || {};
    const sourceId = Object.keys(renders).find((key) => String(renders[key]) === id);
    source = sourceId ? (ws.library || []).find((entry) => entry && entry.id === sourceId) : null;
    if (source) {
      owner = project;
      break;
    }
  }
  if (source) await checkClip(c, ctx, ws, workspaceId, source, file, "", owner);
  else {
    c.skip("design", "this finished video is not linked to a clip with a saved source");
    await measure(c, ctx, file, "", {});
  }
}

// --------------------------------------------------------------- the result

// One tell alone is fine; a hard problem or three different tells is slop.
// The same rule the call-time gate uses (lib/slop/gate.js verdictOf).
function verdictOf(issues) {
  if (issues.some((i) => i.hard)) return "slop";
  const soft = new Set(issues.map((i) => i.rule));
  if (soft.size >= 3) return "slop";
  return soft.size ? "tells" : "ok";
}

function finish(c) {
  // One entry per finding: the same tell in two scenes is one problem, and
  // even pacing found in the plan is not repeated from the picture.
  const seen = new Map();
  const planSaysEven = c.out.issues.some((i) => i.source === "pacing" && /even|uniform|same.?length|metronome/i.test(i.rule));
  const planSaysBrief = c.out.issues.some((i) => i.source === "pacing" && i.rule !== "text-too-brief" && /brief|read|too.?fast|too.?short/i.test(i.rule));
  for (const issue of c.out.issues) {
    if (issue.rule === "even-cuts" && planSaysEven) continue;
    if (issue.rule === "text-too-brief" && planSaysBrief && /^scene |, scene /.test(issue.where)) continue;
    const key = issue.rule + "\n" + issue.what;
    const had = seen.get(key);
    if (!had) seen.set(key, issue);
    else if (issue.where && !had.where.includes(issue.where)) had.where = [had.where, issue.where].filter(Boolean).join("; ");
  }
  const issues = [...seen.values()].sort((a, b) => Number(b.hard) - Number(a.hard)).slice(0, MAX_ISSUES);
  const verdict = verdictOf(issues);
  const result = { ok: verdict === "ok", verdict, issues, checked: c.out.checked, skipped: c.out.skipped };
  if (c.out.aborted) result.aborted = true;
  return result;
}

// ctx: { dataRoot, appRoot, asked, style, styles, allow, frames, signal }.
// target: { projectId } or { cardId } or { libraryId } (a clip or a finished
// video), with an optional workspaceId. Several may be given at once.
// Throws only for a target that does not exist (error.notFound).
async function checkSlop(ctx, target) {
  const context = Object.assign({}, ctx || {});
  if (!context.dataRoot) throw new Error("dataRoot is required");
  const t = target || {};
  const c = collector(context);
  const { loadState, loadWorkspace } = require("../workspace-store");
  const projects = require("../ai-projects");
  const projectId = str(t.projectId).trim();
  const cardId = str(t.cardId).trim();
  const libraryId = str(t.libraryId).trim();
  if (!projectId && !cardId && !libraryId) throw notFound("Pass projectId, cardId or libraryId: jeditor_list_projects, jeditor_list_cards and jeditor_snapshot list the ids.");
  let project = null;
  if (projectId) {
    project = projects.getProject(context.dataRoot, projectId);
    if (!project) throw notFound("No project with id " + quoted(projectId) + ". Call jeditor_list_projects for the ids.");
  }
  const workspaceId = str(t.workspaceId).trim() || (project && project.workspaceId) || (await loadState(context.dataRoot)).activeWorkspaceId;
  if (cardId) {
    const ws = await loadWorkspace(context.dataRoot, workspaceId);
    const card = (ws.cards || []).find((entry) => entry && entry.id === cardId);
    if (!card) throw notFound("No card with id " + quoted(cardId) + " in this workspace. Call jeditor_list_cards for the ids it has.");
    await checkCard(c, context, ws, workspaceId, card);
  }
  if (libraryId && !c.out.aborted) await checkLibraryId(c, context, workspaceId, libraryId);
  if (project && !c.out.aborted) await checkProject(c, context, project);
  return finish(c);
}

// The findings as a numbered list an agent can act on.
function issuesText(issues) {
  return (Array.isArray(issues) ? issues : [])
    .map((i, n) => {
      const what = String(i.what || "").trim().replace(/[.\s]+$/, "") + ".";
      const where = i.where && !/^the whole (video|soundtrack)$/.test(i.where) ? " Where: " + String(i.where).replace(/[.\s]+$/, "") + "." : "";
      return n + 1 + ". " + what + where + (i.fix ? " Fix: " + String(i.fix).trim() : "");
    })
    .join("\n");
}

module.exports = { checkSlop, issuesText, verdictOf, sceneStarts };
