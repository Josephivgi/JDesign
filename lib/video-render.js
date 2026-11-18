"use strict";

// Bakes a project's edit into a real video file: the cut timeline (kept
// parts, speed, audio) plus the look (the project's ratio, fit or fill
// framing, zoom and pan moves, texts, flashes, letterbox, fades). The graph
// lives in video-look-graph.js. The result plays on the project's stage and
// joins that project's render list.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { libraryFilePath } = require("./library-io");
const { copyPathIntoFinished, getFinishedItem, updateFinishedItem, finishedFilePath, addFinishedProject } = require("./finished-io");
const { findFfmpeg, findBoldFont, runFfmpeg, probeMedia } = require("./card-render");
const { normalizeSegments, timelineStats, applyTimelineOps, timelineSummaryText, resolveFrameTimes } = require("./video-timeline");
const frameLib = require("./video-frame");
const graph = require("./video-look-graph");
const projects = require("./ai-projects");
const { loadWorkspace, saveWorkspace } = require("./workspace-store");

const MAX_OPS = 200;
const MAX_PREVIEW_FRAMES = 8;

function resolveProjectVideo(project, state, ws, videoId) {
  const wanted = String(videoId || "").trim();
  const stateSel = state && state.selectedAssetId ? String(state.selectedAssetId) : "";
  const candidates = [];
  if (wanted) candidates.push(wanted);
  if (stateSel && !candidates.includes(stateSel)) candidates.push(stateSel);
  for (const ref of project.assets || []) {
    if (ref && ref.kind === "video" && !candidates.includes(ref.id)) candidates.push(ref.id);
  }
  for (const id of candidates) {
    const item = (ws.library || []).find((entry) => entry && entry.id === id && entry.kind === "video");
    if (item) return item;
  }
  return null;
}

// Shared resolve: project, workspace, and the clip the ops land on. The clip
// is the explicit videoId, else the canvas clip, else the first video asset.
async function timelineContext(dataRoot, projectId, videoId) {
  const project = projects.getProject(dataRoot, projectId);
  if (!project) throw new Error("Project not found.");
  const ws = await loadWorkspace(dataRoot, project.workspaceId);
  const state = project.state && typeof project.state === "object" ? project.state : {};
  const item = resolveProjectVideo(project, state, ws, videoId);
  if (!item) throw new Error("The project has no video on its timeline.");
  // Library rows land with durationMs 0 when the file was added by an agent;
  // the renderer fills it on preview. Editing needs it now, so probe once and
  // write it back to the workspace row. The frame rate rides along: it decides
  // where a cut lands and how the readout counts frames.
  let fps = Number(item.fps) || 0;
  if (!item.durationMs || !fps) {
    const file = libraryFilePath(dataRoot, project.workspaceId, item);
    const ffmpeg = findFfmpeg();
    if (ffmpeg && fs.existsSync(file)) {
      const media = await probeMedia(ffmpeg, file);
      if (media && (media.durationMs || media.fps)) {
        if (media.durationMs && !item.durationMs) item.durationMs = media.durationMs;
        if (media.fps) {
          item.fps = media.fps;
          fps = media.fps;
        }
        // Whether there is audio at all is the first thing a sound decision
        // needs, and nothing used to report it.
        item.hasAudio = media.hasAudio === true;
        try {
          await saveWorkspace(dataRoot, ws);
        } catch {
          /* duration and fps backfill are best effort */
        }
      }
    }
  }
  const edits = state.videoEdits && typeof state.videoEdits === "object" ? state.videoEdits : {};
  const edit = edits[item.id] && typeof edits[item.id] === "object" ? edits[item.id] : {};
  return { project, ws, state, item, edits, edit, fps };
}

// state.renders maps a source clip id to its latest finished render, so the
// project stage opens on the edited video instead of the raw footage.
// What a project's timeline clip sounds like right now: the latest render when
// there is one (that is what the user hears), else the raw source. Used by
// jeditor_probe_audio so the agent checks the mix it just made.
async function timelineContextForAudio(dataRoot, projectId, videoId) {
  const ctx = await timelineContext(dataRoot, projectId, videoId);
  const rendered = projectRenders(ctx.state)[ctx.item.id];
  if (rendered) {
    const finished = await getFinishedItem(dataRoot, rendered, ctx.project.workspaceId);
    if (finished) {
      const file = finishedFilePath(dataRoot, finished.workspaceId || ctx.project.workspaceId, finished);
      if (fs.existsSync(file)) {
        // A render made before the latest edits does not have their sound.
        const sigs = ctx.state.renderSigs || {};
        const stale = Boolean(sigs[ctx.item.id]) && sigs[ctx.item.id] !== editSig(ctx.state, ctx.item.id);
        return { project: ctx.project, item: ctx.item, file, finishedId: finished.id, source: false, stale };
      }
    }
  }
  const source = libraryFilePath(dataRoot, ctx.project.workspaceId, ctx.item);
  if (!fs.existsSync(source)) throw new Error("The source clip file is missing.");
  return { project: ctx.project, item: ctx.item, file: source, finishedId: "", source: true };
}

function projectRenders(state) {
  const renders = state && state.renders;
  return renders && typeof renders === "object" && !Array.isArray(renders) ? renders : {};
}

// A fingerprint of what a project render bakes into one clip (its edits and
// its captions and overlays). The editor compares it with the one saved at
// render time to tell a current finished video from an out of date one.
// renderer/js/pages/editor.js has the same function.
function editSig(state, clipId) {
  const st = state || {};
  const studio = st.studio || {};
  const own = (row) => row && typeof row === "object" && (row.videoId ? row.videoId === clipId : !st.selectedAssetId || st.selectedAssetId === clipId);
  const rows = (list) => (Array.isArray(list) ? list.filter(own) : []);
  return JSON.stringify([(st.videoEdits && st.videoEdits[clipId]) || null, rows(studio.texts), rows(studio.overlays)]);
}

// sig: editSig of the state the render was made from (defaults to now).
function rememberRender(dataRoot, projectId, sourceId, finishedId, sig) {
  // Re-read: a render can run for minutes and the project may have changed.
  const fresh = projects.getProject(dataRoot, projectId);
  if (!fresh) return;
  const state = fresh.state && typeof fresh.state === "object" ? fresh.state : {};
  const renders = Object.assign({}, projectRenders(state), { [sourceId]: finishedId });
  const renderSigs = Object.assign({}, state.renderSigs || {}, { [sourceId]: sig == null ? editSig(state, sourceId) : sig });
  projects.updateProject(dataRoot, projectId, { state: Object.assign({}, state, { renders, renderSigs }) });
}

function lookOf(ctx, durationMs) {
  // Scope the shared studio blob to this clip: texts and overlays from other
  // project videos must not burn onto this one's render or preview.
  return frameLib.readLook(
    ctx.edit,
    frameLib.scopedStudio(ctx.state.studio, ctx.item.id, ctx.state.selectedAssetId),
    ctx.project.aspectRatio,
    durationMs,
  );
}

function secs(ms) {
  return Math.round(ms) / 1000;
}

// The look in the timeline readout: frame, moves, and each text with both its
// source time and where it lands in the finished video.
function describeLook(lk, segments) {
  const size = frameLib.outputSize(lk.aspectRatio);
  return {
    aspectRatio: lk.aspectRatio,
    output: { width: size.w, height: size.h },
    frame: lk.frame,
    zooms: lk.camera.map((m) => Object.assign({ start: secs(m.startMs), end: secs(m.endMs) }, m)),
    texts: lk.texts.map((t) => {
      const startMs = Number(t.startMs) || 0;
      const endMs = startMs + (Number(t.durationMs) || 3000);
      const shown = frameLib.sourceToOutputRanges(segments, startMs, endMs);
      return {
        id: t.id,
        text: t.text,
        style: t.kind,
        start: secs(startMs),
        end: secs(endMs),
        x: t.x,
        y: t.y,
        output: shown.length ? { start: secs(shown[0].startMs), end: secs(shown[shown.length - 1].endMs) } : null,
      };
    }),
    flashes: lk.flashes.map(secs),
    fades: { in: secs(lk.fades.inMs), out: secs(lk.fades.outMs) },
    sound: lk.sounds.length ? lk.sounds[0] : null,
    sounds: lk.sounds.map((entry) => ({
      track: entry.track,
      audioId: entry.audioId,
      volume: entry.volume,
      loop: entry.loop,
      duck: entry.duck,
    })),
    summary: frameLib.lookSummary(lk, segments),
  };
}

function describeTimeline(item, segments, lk) {
  const stats = timelineStats(segments);
  // Whole frames are what a cut can actually land on, so the readout gives the
  // agent frames as well as seconds.
  const fps = Number(item.fps) || 0;
  const frameAt = (value) => (fps > 0 ? Math.round((Number(value) * fps) / 1000) : null);
  return {
    videoId: item.id,
    source: {
      name: item.name,
      durationMs: item.durationMs || 0,
      fps,
      frames: fps > 0 ? frameAt(item.durationMs || 0) : null,
      hasAudio: item.hasAudio === true ? true : item.hasAudio === false ? false : undefined,
    },
    look: lk ? describeLook(lk, segments) : undefined,
    segments: stats.segments.map((seg) => ({
      startMs: seg.startMs,
      endMs: seg.endMs,
      start: seg.startMs / 1000,
      end: seg.endMs / 1000,
      startFrame: frameAt(seg.startMs),
      endFrame: frameAt(seg.endMs),
      speed: Number(seg.speed) || 1,
      muted: seg.muted === true,
      volume: seg.volume == null ? 1 : seg.volume,
    })),
    keptMs: stats.keptMs,
    outputMs: stats.outputMs,
    cuts: stats.cuts,
    summary: timelineSummaryText(stats.segments, item.durationMs || 0),
  };
}

async function sourceSize(dataRoot, ctx) {
  const ffmpeg = findFfmpeg();
  const file = libraryFilePath(dataRoot, ctx.project.workspaceId, ctx.item);
  if (!ffmpeg || !fs.existsSync(file)) return null;
  const media = await probeMedia(ffmpeg, file);
  return media.width && media.height ? { width: media.width, height: media.height } : null;
}

async function describeProjectTimeline(dataRoot, projectId, videoId) {
  const ctx = await timelineContext(dataRoot, projectId, videoId);
  const durationMs = ctx.item.durationMs || 0;
  const segments = normalizeSegments(ctx.edit, durationMs);
  const out = Object.assign({ projectId: ctx.project.id }, describeTimeline(ctx.item, segments, lookOf(ctx, durationMs)));
  const size = await sourceSize(dataRoot, ctx);
  if (size) Object.assign(out.source, size);
  return out;
}

// Timeline ops (cut, keep, split, speed, audio, reset) write the clip's
// segments; look ops (ratio, frame, zoom, unzoom, text, remove_text, flash,
// fade) write its framing, camera, texts, and effects. All ops apply in order
// and nothing persists unless every one succeeds.
async function editProjectTimeline(dataRoot, input) {
  const opts = input || {};
  const ops = opts.ops;
  if (!Array.isArray(ops) || !ops.length) throw new Error("ops must be a non-empty array.");
  if (ops.length > MAX_OPS) throw new Error("too many ops in one call (max " + MAX_OPS + ").");
  const ctx = await timelineContext(dataRoot, opts.projectId, opts.videoId);
  const durationMs = ctx.item.durationMs || 0;
  // The frame grid the cuts land on: an explicit override, else the probed
  // source frame rate. snap:false cuts on raw milliseconds.
  const frameOpts = opts.frame && typeof opts.frame === "object" ? opts.frame : {};
  const fps = Number(frameOpts.fps) || ctx.fps || 0;
  const snap = frameOpts.snap === false ? false : true;
  let edit = Object.assign({}, ctx.edit);
  const lk = lookOf(ctx, durationMs);
  let cutTouched = false;
  let lookTouched = false;
  let pending = [];
  const flushCuts = () => {
    if (!pending.length) return;
    edit = applyTimelineOps(edit, pending, durationMs, { fps, snap });
    pending = [];
    cutTouched = true;
  };
  for (const raw of ops) {
    // Frame positions resolve for look ops too, so a flash or a zoom can name a
    // frame (and a swipe can name both ends).
    const op = resolveFrameTimes(raw, fps);
    const type = op && typeof op === "object" ? String(op.type || "") : "";
    if (frameLib.LOOK_OP_TYPES.includes(type)) {
      flushCuts();
      frameLib.applyLookOp(lk, op, { durationMs, segments: normalizeSegments(edit, durationMs) });
      lookTouched = true;
    } else pending.push(op);
  }
  flushCuts();
  if (!cutTouched && !lookTouched) throw new Error("No ops applied.");
  edit.frame = lk.frame;
  edit.camera = lk.camera;
  edit.flashes = lk.flashes;
  edit.fades = lk.fades;
  if (lk.sounds.length) edit.sounds = lk.sounds;
  else delete edit.sounds;
  // The single-slot field is history; the layered list is the model now.
  delete edit.sound;
  const videoEdits = Object.assign({}, ctx.edits, { [ctx.item.id]: edit });
  // Any edit makes the last render stale, so the stage falls back to the
  // live preview until the agent renders again.
  const renders = Object.assign({}, projectRenders(ctx.state));
  delete renders[ctx.item.id];
  const studio = Object.assign({}, ctx.state.studio || {}, {
    texts: frameLib.mergeScopedTexts(ctx.state.studio, ctx.item.id, ctx.state.selectedAssetId, lk.texts),
  });
  const state = Object.assign({}, ctx.state, { videoEdits, renders, studio });
  const patch = { state };
  if (lk.aspectRatio !== frameLib.normalizeRatio(ctx.project.aspectRatio || "16/9")) patch.aspectRatio = lk.aspectRatio;
  projects.updateProject(dataRoot, ctx.project.id, patch);
  const segments = normalizeSegments(edit, durationMs);
  return Object.assign({ projectId: ctx.project.id, applied: ops.length }, describeTimeline(ctx.item, segments, lk));
}

// How much of the source the frame shows, and whether bars are left over.
function framingReport(size, aspectRatio, frame) {
  if (!size) return { sourceShown: null, emptyBars: null };
  const src = { w: size.width, h: size.height };
  const rect = frameLib.viewRect(src, frameLib.outputSize(aspectRatio), frame.fit, 1, frame.x, frame.y);
  const share = (part, whole) => Math.round(Math.min(1, part / whole) * 1000) / 1000;
  return {
    sourceShown: { width: share(rect.w, src.w), height: share(rect.h, src.h) },
    emptyBars: !frameLib.rectInside(rect, src),
  };
}

// Explicit agent framing operation: fill scales the picture up until it covers
// the project's frame, while off restores fit. A clip already in the requested
// state is left alone, so its render is not dropped for nothing.
async function autoScaleProject(dataRoot, input) {
  const opts = input || {};
  const on = opts.on !== false;
  const fit = on ? "fill" : "fit";
  const project = projects.getProject(dataRoot, opts.projectId);
  if (!project) throw new Error("Project not found.");
  const ids =
    opts.all === true
      ? (project.assets || []).filter((ref) => ref && ref.kind === "video").map((ref) => ref.id)
      : [opts.videoId];
  if (!ids.length) throw new Error("The project has no video on its timeline.");
  const clips = [];
  for (const id of ids) {
    let ctx;
    try {
      ctx = await timelineContext(dataRoot, project.id, id);
    } catch (error) {
      if (opts.all === true) continue;
      throw error;
    }
    const before = frameLib.normalizeFrame(ctx.edit.frame);
    const changed = before.fit !== fit;
    if (changed) await editProjectTimeline(dataRoot, { projectId: project.id, videoId: ctx.item.id, ops: [{ type: "frame", fit }] });
    const frame = Object.assign({}, before, { fit });
    const ratio = frameLib.normalizeRatio(project.aspectRatio || "16/9");
    clips.push(
      Object.assign(
        { videoId: ctx.item.id, name: ctx.item.name, autoScale: on, changed, previous: before.fit === "fill" },
        framingReport(await sourceSize(dataRoot, ctx), ratio, frame),
      ),
    );
  }
  return {
    projectId: project.id,
    aspectRatio: frameLib.normalizeRatio(project.aspectRatio || "16/9"),
    autoScale: on,
    clips,
    note: clips.some((c) => c.changed)
      ? "The clip's last render no longer matches, so the stage shows the live preview. Render again to bake it in. Call with on:" +
        (on ? "false" : "true") +
        " to undo."
      : "Nothing changed: every clip was already " + (on ? "auto scaled." : "showing the whole picture."),
  };
}

// Everything a render or a still needs: probed source, kept segments, the
// resolved look, the output frame, and a font.
async function renderSetup(dataRoot, options) {
  const ctx = await timelineContext(dataRoot, options.projectId, options.videoId);
  const source = libraryFilePath(dataRoot, ctx.project.workspaceId, ctx.item);
  if (!fs.existsSync(source)) throw new Error("The source clip file is missing.");
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error("ffmpeg is not installed. Rendering needs ffmpeg on this computer.");
  const media = await probeMedia(ffmpeg, source);
  const durationMs = media.durationMs || ctx.item.durationMs || 0;
  if (!durationMs) throw new Error("Could not read the clip's duration.");
  const segments = normalizeSegments(ctx.edit, durationMs);
  if (!segments.length) throw new Error("The timeline has no kept parts to render.");
  const lk = frameLib.renderLook(
    lookOf(ctx, durationMs),
    frameLib.scopedStudio(ctx.state.studio, ctx.item.id, ctx.state.selectedAssetId),
  );
  const size = frameLib.outputSize(lk.aspectRatio);
  const src = media.width && media.height ? { w: media.width, h: media.height } : { w: size.w, h: size.h };
  const fps = Math.max(15, Math.min(60, Math.round(media.fps) || 30));
  // The source rate is what a trim has to land on; fps above is the output rate.
  const srcFps = Number(media.fps) || 0;
  return { ctx, source, ffmpeg, media, durationMs, segments, lk, size, src, fps, srcFps, font: findBoldFont() };
}

// One project render at a time per project: the editor's Render video and
// the agent's jeditor_render_project would otherwise overwrite each other's
// finished video.
const renderLocks = new Map();
function renderProjectVideo(dataRoot, opts) {
  const key = String((opts && opts.projectId) || "");
  const before = renderLocks.get(key) || Promise.resolve();
  const run = before.catch(() => {}).then(() => renderProjectVideoNow(dataRoot, opts));
  const tail = run.catch(() => {});
  renderLocks.set(key, tail);
  tail.then(() => {
    if (renderLocks.get(key) === tail) renderLocks.delete(key);
  });
  return run;
}

async function renderProjectVideoNow(dataRoot, opts) {
  const options = opts || {};
  const setup = await renderSetup(dataRoot, options);
  const { ctx, source, ffmpeg, media, segments, lk, size, src, fps, srcFps } = setup;
  const project = ctx.project;
  const item = ctx.item;
  const stats = timelineStats(segments);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cutline-render-"));
  const outFile = path.join(tempRoot, "render.mp4");
  try {
    const texts = graph.prepareTexts(lk.drawTexts, size, segments, tempRoot);
    // Overlay audio comes from an explicit render call first (one track, several
    // audioIds at one gain, or audios with their own gains), then the tracks
    // saved on the timeline, so a re-render keeps the voiceover (and the music
    // bed) the agent attached earlier.
    const { resolveAudioOverlay, resolveAudioTracks } = require("./compose-finished");
    const namesTracks =
      String(options.audioId || "").trim() ||
      (Array.isArray(options.audioIds) && options.audioIds.length) ||
      (Array.isArray(options.audios) && options.audios.length);
    let overlayAudio = [];
    if (namesTracks) {
      overlayAudio = await resolveAudioTracks(options, dataRoot, project.workspaceId);
    } else {
      for (const entry of lk.sounds) {
        const resolved = await resolveAudioOverlay(
          {
            audioId: entry.audioId,
            audioVolume: entry.volume,
            audioLoop: entry.loop,
            duck: entry.duck == null ? undefined : entry.duck,
            track: entry.track,
          },
          dataRoot,
          project.workspaceId,
        );
        if (resolved) overlayAudio.push(resolved);
      }
    }
    const args = graph.buildLookArgs({
      source,
      outFile,
      hasAudio: Boolean(media.hasAudio),
      srcFps,
      audios: overlayAudio.length
        ? overlayAudio.map((entry) => ({
            file: entry.file,
            volume: entry.volume,
            loop: entry.loop,
            duck: entry.duck,
          }))
        : null,
      segments,
      src,
      size,
      fps,
      look: lk,
      texts,
      font: setup.font,
      outputMs: stats.outputMs,
    });
    await runFfmpeg(ffmpeg, args, 900000);
    if (!fs.existsSync(outFile) || !fs.statSync(outFile).size) throw new Error("ffmpeg produced no output.");
    const name = String(options.name || "").trim() || (project.name || "Untitled") + " (edited)";
    const result = await copyPathIntoFinished(dataRoot, outFile, {
      name,
      mime: "video/mp4",
      workspaceId: project.workspaceId,
      source: "agent",
      // A render belongs to the project that asked for it. The file is still
      // shared by content hash, so two projects that render the same cut keep
      // one copy on disk.
      projectId: project.id,
    });
    const finished = result.item || null;
    if (finished && finished.id) {
      const patch = { videoWidth: size.w, videoHeight: size.h, sourceId: item.id };
      if (stats.outputMs && !finished.durationMs) patch.durationMs = stats.outputMs;
      // Poster from just past the fade-in, so the stage never opens on a
      // black first frame.
      const posterFile = path.join(tempRoot, "poster.jpg");
      const posterMs = Math.min(Math.max(400, (lk.fades.inMs || 0) + 200), Math.max(0, stats.outputMs - 100));
      try {
        await runFfmpeg(ffmpeg, ["-y", "-hide_banner", "-ss", (posterMs / 1000).toFixed(3), "-i", outFile, "-frames:v", "1", "-vf", "scale=-2:720", "-q:v", "4", posterFile], 60000);
        if (fs.existsSync(posterFile)) patch.poster = { data: fs.readFileSync(posterFile) };
      } catch {
        /* the poster is best effort */
      }
      try {
        await updateFinishedItem(dataRoot, finished.id, patch, project.workspaceId);
        await addFinishedProject(dataRoot, finished.id, project.id, project.workspaceId);
        const fresh = await getFinishedItem(dataRoot, finished.id, project.workspaceId);
        if (fresh) Object.assign(finished, fresh);
      } catch {
        /* size, duration, and poster backfill are best effort */
      }
    }
    if (finished && finished.id) rememberRender(dataRoot, project.id, item.id, finished.id, editSig(ctx.state, item.id));
    return {
      projectId: project.id,
      videoId: item.id,
      item: finished,
      skipped: result.skipped === true,
      outputMs: stats.outputMs,
      segments: segments.length,
      hasAudio: Boolean(media.hasAudio),
      output: { width: size.w, height: size.h, aspectRatio: lk.aspectRatio },
      look: frameLib.lookSummary(lk, segments),
      shownOnStage: Boolean(finished && finished.id),
      note: "The edited video is now playing in the project's preview. Tell the user to look at the preview.",
    };
  } finally {
    fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 3 }, () => {});
  }
}

function frameTimes(options, segments) {
  const stats = timelineStats(segments);
  const toMs = (list) => (Array.isArray(list) ? list.map(Number).filter((v) => Number.isFinite(v) && v >= 0).map((v) => Math.round(v * 1000)) : []);
  let times = toMs(options.times);
  if (!times.length) {
    const outs = toMs(options.outputTimes);
    const count = Math.max(1, Math.min(MAX_PREVIEW_FRAMES, Math.round(Number(options.count) || 4)));
    const list = outs.length
      ? outs
      : Array.from({ length: count }, (_, i) => ((i + 0.5) * stats.outputMs) / count);
    times = list.map((o) => frameLib.outputToSourceMs(segments, o));
  }
  return times.slice(0, MAX_PREVIEW_FRAMES);
}

// Stills an agent can look at before rendering: each moment framed exactly as
// the render will frame it (ratio, fill or fit, zoom, texts), plus the raw
// source frame with a quarter grid for picking focus points. Times are source
// seconds (`times`) or finished-video seconds (`outputTimes`); with neither,
// `count` moments spread over the finished video.
async function previewProjectFrames(dataRoot, opts) {
  const options = opts || {};
  const setup = await renderSetup(dataRoot, options);
  const { ctx, source, ffmpeg, segments, lk, size, src } = setup;
  const withSource = options.source !== false;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cutline-frames-"));
  try {
    // Each still is its own short ffmpeg run dominated by startup and seek, so
    // a few run at once; frames keep their requested order.
    const jobs = [];
    const frames = frameTimes(options, segments).map((atMs, i) => {
      const dir = path.join(tempRoot, String(i));
      fs.mkdirSync(dir);
      const framedFile = path.join(dir, "framed.jpg");
      const texts = graph.prepareTexts(lk.drawTexts, size, segments, dir, { atMs });
      const o = frameLib.sourceToOutputMs(segments, atMs);
      const frame = { at: atMs / 1000, output: o == null ? null : o / 1000, framed: null };
      if (withSource) frame.source = null;
      jobs.push(async () => {
        await runFfmpeg(
          ffmpeg,
          graph.buildStillArgs({ source, outFile: framedFile, src, size, atMs, look: lk, texts, font: setup.font }),
          60000,
        );
        frame.framed = { mimeType: "image/jpeg", data: (await fs.promises.readFile(framedFile)).toString("base64") };
      });
      if (withSource) {
        const srcFile = path.join(dir, "source.jpg");
        jobs.push(async () => {
          await runFfmpeg(ffmpeg, graph.buildSourceStillArgs(source, atMs, srcFile), 60000);
          frame.source = { mimeType: "image/jpeg", data: (await fs.promises.readFile(srcFile)).toString("base64") };
        });
      }
      return frame;
    });
    await runLimited(jobs, 4);
    return {
      projectId: ctx.project.id,
      videoId: ctx.item.id,
      aspectRatio: lk.aspectRatio,
      output: { width: size.w, height: size.h },
      source: { width: src.w, height: src.h },
      look: frameLib.lookSummary(lk, segments),
      frames,
      note:
        "framed = the finished frame at that moment (ratio, framing, zoom, texts). source = the raw frame with grid lines at x and y 0.25, 0.5, 0.75; read focus points off it for frame and zoom ops.",
    };
  } finally {
    fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 3 }, () => {});
  }
}

// Runs async jobs with at most `limit` in flight. After a failure no new job
// starts, and the error surfaces once the running ones finish, so nothing is
// still writing into the temp dir when the caller removes it.
async function runLimited(jobs, limit) {
  let next = 0;
  let error = null;
  const lane = async () => {
    while (!error && next < jobs.length) {
      const job = jobs[next];
      next += 1;
      try {
        await job();
      } catch (err) {
        if (!error) error = err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, lane));
  if (error) throw error;
}

// MCP and native tool results: a JSON text block, then each still as an
// image so vision models see the frames.
function framesToContent(result) {
  const meta = Object.assign({}, result, {
    frames: result.frames.map((f) => ({ at: f.at, output: f.output, images: f.source ? ["framed", "source"] : ["framed"] })),
  });
  const content = [{ type: "text", text: JSON.stringify(meta, null, 2) }];
  for (const f of result.frames) {
    content.push({ type: "image", data: f.framed.data, mimeType: f.framed.mimeType });
    if (f.source) content.push({ type: "image", data: f.source.data, mimeType: f.source.mimeType });
  }
  return { content, meta };
}

// A clip that is already the finished cut (a gallery animation with no edits)
// becomes the project's render without a second encode: same file, linked to
// the project, with a poster, so the preview and Export pick it up at once.
async function registerClipAsRender(dataRoot, opts) {
  const project = projects.getProject(dataRoot, opts.projectId);
  if (!project) throw new Error("Project not found.");
  const result = await copyPathIntoFinished(dataRoot, opts.file, {
    name: String(opts.name || project.name || "Untitled").trim(),
    mime: "video/mp4",
    workspaceId: project.workspaceId,
    source: "agent",
    projectId: project.id,
  });
  const finished = result.item || null;
  if (!finished || !finished.id) throw new Error("Could not save the finished video.");
  const patch = { sourceId: String(opts.sourceId || "") };
  if (opts.width && opts.height) Object.assign(patch, { videoWidth: opts.width, videoHeight: opts.height });
  if (opts.durationMs && !finished.durationMs) patch.durationMs = opts.durationMs;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cutline-poster-"));
  try {
    const ffmpeg = findFfmpeg();
    const posterFile = path.join(tempRoot, "poster.jpg");
    const at = Math.max(0, Number(opts.posterMs) || 0) / 1000;
    if (ffmpeg) {
      await runFfmpeg(ffmpeg, ["-y", "-hide_banner", "-ss", at.toFixed(3), "-i", opts.file, "-frames:v", "1", "-vf", "scale=-2:720", "-q:v", "4", posterFile], 60000);
      if (fs.existsSync(posterFile)) patch.poster = { data: fs.readFileSync(posterFile) };
    }
  } catch {
    /* the poster is best effort */
  } finally {
    fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 3 }, () => {});
  }
  await updateFinishedItem(dataRoot, finished.id, patch, project.workspaceId);
  await addFinishedProject(dataRoot, finished.id, project.id, project.workspaceId);
  // The bare clip baked none of the project's edits on it.
  rememberRender(dataRoot, project.id, opts.sourceId, finished.id, editSig({}, opts.sourceId));
  return (await getFinishedItem(dataRoot, finished.id, project.workspaceId)) || finished;
}

module.exports = {
  registerClipAsRender,
  renderProjectVideo,
  describeProjectTimeline,
  editProjectTimeline,
  autoScaleProject,
  previewProjectFrames,
  framesToContent,
  timelineContextForAudio,
  atempoChain: graph.atempoChain,
};
