"use strict";

// Where JV's disk space goes, and the one job that wins it back without
// losing anything the user can see:
//
//   videos   re-encode wasteful streams, verified frame by frame (media-shrink)
//   images   PNG to lossless WebP, verified pixel for pixel
//   copies   extra byte-identical files the app no longer shows anywhere
//   caches   browser caches, crash dumps, and half-written temp files
//
// Every replacement writes a new file next to the old one, points the
// workspace row at it, and only then removes the old file. A crash at any
// point leaves either the old file in use or an orphan the next sweep removes.

const fs = require("fs/promises");
const fssync = require("fs");
const path = require("path");
const { createHash, randomBytes } = require("crypto");
const { loadState, loadWorkspace, saveWorkspace, workspaceDir } = require("./workspace-store");
const shrink = require("./media-shrink");
const fingerprint = require("./media-fingerprint");

const MEDIA_DIRS = ["library", "finished", "posters", "finished-posters"];
const ORPHAN_MIN_AGE_MS = 10 * 60 * 1000;
const TMP_MIN_AGE_MS = 60 * 60 * 1000;
const IMAGE_BATCH = 12;
const IMAGE_SAVING_GUESS = 0.42;

async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of fssync.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function statOrNull(file) {
  try {
    return await fs.stat(file);
  } catch {
    return null;
  }
}

async function walk(dir, out) {
  const list = out || [];
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return list;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, list);
    else if (entry.isFile()) {
      const st = await statOrNull(full);
      if (st) list.push({ file: full, size: st.size, mtimeMs: st.mtimeMs });
    }
  }
  return list;
}

function sumSize(files) {
  return files.reduce((total, entry) => total + entry.size, 0);
}

// Hashing hundreds of leftover frames on every report would be wasteful;
// a file is only re-read when its size or mtime moved.
const hashCache = new Map();
async function cachedHash(entry) {
  const key = entry.file + "|" + entry.size + "|" + entry.mtimeMs;
  if (hashCache.has(key)) return hashCache.get(key);
  const value = await hashFile(entry.file).catch(() => "");
  hashCache.set(key, value);
  return value;
}

async function activeWorkspace(dataRoot, workspaceId) {
  const state = await loadState(dataRoot);
  const id = workspaceId || state.activeWorkspaceId;
  const ws = await loadWorkspace(dataRoot, id);
  if (!Array.isArray(ws.library)) ws.library = [];
  if (!Array.isArray(ws.finished)) ws.finished = [];
  return { id, ws, state };
}

// Bytes that still exist somewhere the app shows. A lossless image shrink
// keeps every pixel, so its old PNG hash still counts as present.
function knownHashes(ws) {
  const set = new Set();
  for (const item of [...(ws.library || []), ...(ws.finished || [])]) {
    if (item && item.contentHash) set.add(item.contentHash);
    if (item && item.shrink && item.shrink.method === "webp-lossless" && Array.isArray(item.formerHashes)) {
      item.formerHashes.forEach((hash) => set.add(hash));
    }
  }
  return set;
}

function referencedFiles(ws) {
  const set = new Set();
  for (const item of [...(ws.library || []), ...(ws.finished || []), ...(ws.cardImages || [])]) {
    for (const rel of [item && item.file, item && item.posterFile]) {
      if (rel) set.add(path.normalize(rel).toLowerCase());
    }
  }
  return set;
}

// Files in the media folders no row points at. Ones named after a live row
// are an older version of that row (left by a shrink whose old file was
// still open) and can go; anything else is shown to the user, never removed
// on its own.
async function untrackedMedia(dataRoot, wsId, ws) {
  const base = workspaceDir(dataRoot, wsId);
  const refs = referencedFiles(ws);
  const ids = new Set([...(ws.library || []), ...(ws.finished || [])].map((item) => item && String(item.id)).filter(Boolean));
  const superseded = [];
  const unknown = [];
  const now = Date.now();
  for (const sub of MEDIA_DIRS) {
    const dir = path.join(base, sub);
    let names = [];
    try {
      names = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const rel = path.join(sub, name);
      if (refs.has(path.normalize(rel).toLowerCase())) continue;
      const full = path.join(dir, name);
      const st = await statOrNull(full);
      if (!st || !st.isFile()) continue;
      if (now - st.mtimeMs < ORPHAN_MIN_AGE_MS) continue;
      const stem = name.slice(0, 36);
      const entry = { file: full, size: st.size, mtimeMs: st.mtimeMs };
      if (ids.has(stem)) superseded.push(entry);
      else unknown.push(entry);
    }
  }
  return { superseded, unknown };
}

async function strayTempFiles(dataRoot) {
  const out = [];
  const now = Date.now();
  const roots = [dataRoot, path.join(dataRoot, "workspaces")];
  let wsDirs = [];
  try {
    wsDirs = (await fs.readdir(path.join(dataRoot, "workspaces"))).map((name) => path.join(dataRoot, "workspaces", name));
  } catch {
    wsDirs = [];
  }
  for (const dir of roots.concat(wsDirs)) {
    let names = [];
    try {
      names = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/\.json\.\d+\.[0-9a-f-]{36}\.tmp$/i.test(name)) continue;
      const full = path.join(dir, name);
      const st = await statOrNull(full);
      if (st && st.isFile() && now - st.mtimeMs > TMP_MIN_AGE_MS) out.push({ file: full, size: st.size, mtimeMs: st.mtimeMs });
    }
  }
  return out;
}

// The removed Recorder agent saved every screenshot here. Many are exact
// repeats of each other or of a library image; those copies can go with no
// loss. The rest is the only copy and stays until the user decides.
async function recorderFrameLeftovers(dataRoot, hashes) {
  const dir = path.join(dataRoot, "recorder-frames");
  const files = await walk(dir);
  const seen = new Set();
  const copies = [];
  for (const entry of files.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    const hash = await cachedHash(entry);
    if (!hash) continue;
    if (seen.has(hash) || hashes.has(hash)) copies.push(entry);
    else seen.add(hash);
  }
  return { dir, files, copies };
}

async function agentFolderCopies(dataRoot, hashes) {
  const dir = path.join(dataRoot, "agent-workspaces");
  const files = await walk(dir);
  const copies = [];
  for (const entry of files) {
    if (entry.size < 256 * 1024) continue;
    const hash = await cachedHash(entry);
    if (hash && hashes.has(hash)) copies.push(entry);
  }
  return { dir, files, copies };
}

function range(files) {
  if (!files.length) return { from: "", to: "" };
  const times = files.map((entry) => entry.mtimeMs).sort((a, b) => a - b);
  return { from: new Date(times[0]).toISOString(), to: new Date(times[times.length - 1]).toISOString() };
}

const CACHE_DIRS = ["Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache"];

async function cacheUsage(userDataDir) {
  const dirs = [];
  for (const name of CACHE_DIRS) dirs.push(path.join(userDataDir, name));
  let partitions = [];
  try {
    partitions = await fs.readdir(path.join(userDataDir, "Partitions"));
  } catch {
    partitions = [];
  }
  for (const part of partitions) for (const name of CACHE_DIRS) dirs.push(path.join(userDataDir, "Partitions", part, name));
  let cacheBytes = 0;
  for (const dir of dirs) cacheBytes += sumSize(await walk(dir));
  const crash = await walk(path.join(userDataDir, "Crashpad", "reports"));
  return { cacheBytes, crashFiles: crash, crashBytes: sumSize(crash) };
}

function isPng(item) {
  return item && item.kind === "image" && (/png/i.test(item.mime || "") || /\.png$/i.test(item.file || ""));
}

function needsShrinkMark(item) {
  return !(item && item.shrink && (item.shrink.at || item.shrink.skipped));
}

async function storageReport(dataRoot, opts) {
  const options = opts || {};
  const userDataDir = options.userDataDir || path.dirname(dataRoot);
  const { id: wsId, ws } = await activeWorkspace(dataRoot, options.workspaceId);
  const hashes = knownHashes(ws);
  const base = workspaceDir(dataRoot, wsId);

  const bucket = () => ({ count: 0, bytes: 0 });
  const media = { video: bucket(), image: bucket(), audio: bucket(), render: bucket(), poster: bucket() };
  const videoCandidates = [];
  let pngBytes = 0;
  let pngCount = 0;
  const addFile = async (list, item, kind) => {
    const abs = path.join(base, item.file || "");
    const st = await statOrNull(abs);
    const size = st ? st.size : 0;
    media[kind].count += 1;
    media[kind].bytes += size;
    if (item.posterFile) {
      const pst = await statOrNull(path.join(base, item.posterFile));
      if (pst) {
        media.poster.count += 1;
        media.poster.bytes += pst.size;
      }
    }
    if ((kind === "video" || kind === "render") && needsShrinkMark(item) && size > 4 * 1024 * 1024) {
      videoCandidates.push({ list, id: String(item.id), name: item.name || "Video", size, abs, durationMs: Number(item.durationMs) || 0 });
    }
    if (kind === "image" && isPng(item) && needsShrinkMark(item)) {
      pngBytes += size;
      pngCount += 1;
    }
  };
  for (const item of ws.library) {
    if (!item || !item.file) continue;
    const kind = item.kind === "video" || item.kind === "image" || item.kind === "audio" ? item.kind : "image";
    await addFile("library", item, kind);
  }
  for (const item of ws.finished) if (item && item.file) await addFile("finished", item, "render");

  // Probe candidates so the estimate reflects real bitrates, not file size.
  let videoEstimate = 0;
  const videoPlan = [];
  if (options.ffmpeg) {
    for (const cand of videoCandidates) {
      const probe = await shrink.probeVideo(options.ffmpeg, cand.abs);
      const plan = shrink.shrinkPlan(probe, cand.size);
      if (!plan.ok) continue;
      videoEstimate += plan.estimateBytes;
      videoPlan.push({ list: cand.list, id: cand.id, name: cand.name, size: cand.size, estimateBytes: plan.estimateBytes });
    }
  }
  videoPlan.sort((a, b) => b.size - a.size);

  const frames = await recorderFrameLeftovers(dataRoot, hashes);
  const takes = await walk(path.join(dataRoot, "recorder-takes"));
  const agents = await agentFolderCopies(dataRoot, hashes);
  const untracked = await untrackedMedia(dataRoot, wsId, ws);
  const tmp = await strayTempFiles(dataRoot);
  const caches = await cacheUsage(userDataDir);

  const dbFiles = (await fs.readdir(dataRoot).catch(() => [])).filter((name) => /\.db(-wal|-shm)?$/i.test(name));
  let dbBytes = 0;
  for (const name of dbFiles) {
    const st = await statOrNull(path.join(dataRoot, name));
    if (st) dbBytes += st.size;
  }

  const leftovers = [
    {
      id: "recorder-frames",
      label: "Old recording screenshots",
      note: "Saved by an old recording feature. Nothing in JV shows them.",
      files: frames.files.length,
      bytes: sumSize(frames.files),
      copyFiles: frames.copies.length,
      copyBytes: sumSize(frames.copies),
      dir: frames.dir,
      ...range(frames.files),
    },
    {
      id: "recorder-takes",
      label: "Old recording takes",
      note: "Zipped frames and notes from an old recording feature.",
      files: takes.length,
      bytes: sumSize(takes),
      copyFiles: 0,
      copyBytes: 0,
      dir: path.join(dataRoot, "recorder-takes"),
      ...range(takes),
    },
    {
      id: "agent-workspaces",
      label: "Agent work folders",
      note: "Scratch folders coding agents work in. Some files are already in your library.",
      files: agents.files.length,
      bytes: sumSize(agents.files),
      copyFiles: agents.copies.length,
      copyBytes: sumSize(agents.copies),
      dir: agents.dir,
      ...range(agents.files),
    },
    {
      id: "untracked",
      label: "Files not in the library",
      note: "Media files in JV's folders that no library row points at.",
      files: untracked.unknown.length,
      bytes: sumSize(untracked.unknown),
      copyFiles: 0,
      copyBytes: 0,
      dir: path.join(base, "library"),
      ...range(untracked.unknown),
    },
  ].filter((group) => group.files > 0);

  const copiesBytes = sumSize(frames.copies) + sumSize(untracked.superseded);
  const cacheBytes = caches.cacheBytes + caches.crashBytes + sumSize(tmp);
  const leftoverBytes = leftovers.reduce((total, group) => total + group.bytes, 0);
  const totalBytes =
    media.video.bytes + media.image.bytes + media.audio.bytes + media.render.bytes + media.poster.bytes + leftoverBytes + cacheBytes + dbBytes + sumSize(untracked.superseded);

  return {
    workspaceId: wsId,
    scannedAt: new Date().toISOString(),
    totalBytes,
    categories: [
      { id: "video", label: "Videos", bytes: media.video.bytes, count: media.video.count },
      { id: "render", label: "Renders", bytes: media.render.bytes, count: media.render.count },
      { id: "image", label: "Images", bytes: media.image.bytes, count: media.image.count },
      { id: "audio", label: "Audio", bytes: media.audio.bytes, count: media.audio.count },
      { id: "leftover", label: "Leftover files", bytes: leftoverBytes + sumSize(untracked.superseded), count: leftovers.reduce((n, g) => n + g.files, 0) },
      { id: "cache", label: "App caches", bytes: cacheBytes, count: 0 },
      { id: "other", label: "Posters and app data", bytes: media.poster.bytes + dbBytes, count: 0 },
    ].filter((cat) => cat.bytes > 0),
    plan: {
      videos: { count: videoPlan.length, estimateBytes: videoEstimate, items: videoPlan },
      images: { count: pngCount, bytes: pngBytes, estimateBytes: Math.round(pngBytes * IMAGE_SAVING_GUESS) },
      copies: { count: frames.copies.length + untracked.superseded.length, estimateBytes: copiesBytes },
      caches: { estimateBytes: cacheBytes },
    },
    leftovers,
  };
}

function newHashList(item) {
  const prior = Array.isArray(item.formerHashes) ? item.formerHashes : [];
  return Array.from(new Set(prior.concat(item.contentHash ? [item.contentHash] : []))).slice(-8);
}

// Point the row at `newAbs`, then drop the old file. The new file has its own
// name, so a player still holding the old one never blocks the swap.
async function commitReplacement(dataRoot, wsId, listName, id, newAbs, patch) {
  const ws = await loadWorkspace(dataRoot, wsId);
  const list = Array.isArray(ws[listName]) ? ws[listName] : [];
  const item = list.find((entry) => entry && String(entry.id) === String(id));
  if (!item) {
    await fs.unlink(newAbs).catch(() => {});
    return null;
  }
  const base = workspaceDir(dataRoot, wsId);
  const oldRel = item.file;
  const oldAbs = path.join(base, oldRel || "");
  const st = await fs.stat(newAbs);
  const hash = await hashFile(newAbs);
  item.formerHashes = newHashList(item);
  item.contentHash = hash;
  item.size = st.size;
  item.file = path.relative(base, newAbs);
  if (patch.mime) item.mime = patch.mime;
  item.shrink = patch.shrink;
  await saveWorkspace(dataRoot, ws);
  if (path.resolve(oldAbs) !== path.resolve(newAbs)) {
    await fs.unlink(oldAbs).catch(() => {
      /* still open in a player; the next sweep removes it */
    });
  }
  return item;
}

async function markSkipped(dataRoot, wsId, listName, id, reason) {
  const ws = await loadWorkspace(dataRoot, wsId);
  const item = (ws[listName] || []).find((entry) => entry && String(entry.id) === String(id));
  if (!item) return;
  item.shrink = { skipped: String(reason || "skipped"), checkedAt: new Date().toISOString() };
  await saveWorkspace(dataRoot, ws);
}

function shortId() {
  return randomBytes(3).toString("hex");
}

async function waitUntilIdle(isBusy, signal, onWait) {
  let told = false;
  while (typeof isBusy === "function" && isBusy()) {
    if (signal && signal.aborted) return false;
    if (!told && onWait) onWait();
    told = true;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  return !(signal && signal.aborted);
}

async function removeFiles(entries) {
  let freed = 0;
  for (const entry of entries) {
    try {
      await fs.unlink(entry.file);
      freed += entry.size;
    } catch {
      /* in use or already gone */
    }
  }
  return freed;
}

// opts: { steps: { videos, images, copies, caches }, ffmpeg, nativeImage,
// clearSessionCaches, isBusy, signal, onProgress, onChanged, userDataDir,
// only: [{ list, id }] to limit the video step }
async function runOptimize(dataRoot, opts) {
  const options = opts || {};
  const steps = options.steps || { videos: true, images: true, copies: true, caches: true };
  const signal = options.signal;
  const emit = (payload) => {
    if (options.onProgress) options.onProgress(payload);
  };
  const changed = () => {
    if (options.onChanged) options.onChanged();
  };
  const userDataDir = options.userDataDir || path.dirname(dataRoot);
  const summary = { freedBytes: 0, steps: {}, skipped: [], canceled: false };
  const { id: wsId } = await activeWorkspace(dataRoot, options.workspaceId);
  const base = workspaceDir(dataRoot, wsId);

  if (steps.caches && !(signal && signal.aborted)) {
    emit({ step: "caches", label: "Clearing app caches" });
    let freed = 0;
    if (typeof options.clearSessionCaches === "function") {
      const before = (await cacheUsage(userDataDir)).cacheBytes;
      await options.clearSessionCaches().catch(() => {});
      const after = (await cacheUsage(userDataDir)).cacheBytes;
      freed += Math.max(0, before - after);
    }
    freed += await removeFiles((await cacheUsage(userDataDir)).crashFiles);
    freed += await removeFiles(await strayTempFiles(dataRoot));
    summary.steps.caches = { freedBytes: freed };
    summary.freedBytes += freed;
  }

  if (steps.copies && !(signal && signal.aborted)) {
    emit({ step: "copies", label: "Removing extra copies" });
    const { ws } = await activeWorkspace(dataRoot, wsId);
    const frames = await recorderFrameLeftovers(dataRoot, knownHashes(ws));
    const untracked = await untrackedMedia(dataRoot, wsId, ws);
    const freed = (await removeFiles(frames.copies)) + (await removeFiles(untracked.superseded));
    summary.steps.copies = { freedBytes: freed, files: frames.copies.length + untracked.superseded.length };
    summary.freedBytes += freed;
  }

  if (steps.images && !(signal && signal.aborted)) {
    const { ws } = await activeWorkspace(dataRoot, wsId);
    const items = ws.library.filter((item) => isPng(item) && needsShrinkMark(item));
    let freed = 0;
    let done = 0;
    // The perceptual hash is read from the PNG before it turns into WebP,
    // because the in-process decoder used for look-alike checks reads PNG only.
    if (options.nativeImage) {
      let touched = false;
      for (const item of items) {
        if (item.phash) continue;
        const res = await fingerprint.imageDhash(path.join(base, item.file), { nativeImage: options.nativeImage });
        if (res && res.hash) {
          item.phash = res.hash;
          if (res.width) item.width = res.width;
          if (res.height) item.height = res.height;
          touched = true;
        }
      }
      if (touched) await saveWorkspace(dataRoot, ws);
    }
    for (let i = 0; i < items.length && !(signal && signal.aborted); i += IMAGE_BATCH) {
      if (!(await waitUntilIdle(options.isBusy, signal, () => emit({ step: "images", label: "Waiting for the recording to finish" })))) break;
      const batch = items.slice(i, i + IMAGE_BATCH).map((item) => ({
        id: String(item.id),
        src: path.join(base, item.file),
        dest: path.join(base, "library", item.id + "-" + shortId() + ".webp"),
      }));
      emit({ step: "images", label: "Storing images losslessly", done, total: items.length });
      const results = await shrink.shrinkImagesLossless(options.ffmpeg, batch, signal);
      for (let k = 0; k < batch.length; k += 1) {
        const res = results[k] || { ok: false, reason: "no result" };
        if (res.ok) {
          const item = await commitReplacement(dataRoot, wsId, "library", batch[k].id, batch[k].dest, {
            mime: "image/webp",
            shrink: { at: new Date().toISOString(), method: "webp-lossless", fromBytes: res.fromBytes },
          });
          if (item) freed += res.fromBytes - res.bytes;
        } else if (res.reason !== "canceled") {
          await markSkipped(dataRoot, wsId, "library", batch[k].id, res.reason);
        }
      }
      done += batch.length;
      changed();
    }
    summary.steps.images = { freedBytes: freed, files: done };
    summary.freedBytes += freed;
  }

  if (steps.videos && !(signal && signal.aborted)) {
    const { ws } = await activeWorkspace(dataRoot, wsId);
    const only = Array.isArray(options.only) && options.only.length ? new Set(options.only.map((entry) => entry.list + ":" + entry.id)) : null;
    const queue = [];
    for (const list of ["library", "finished"]) {
      for (const item of ws[list]) {
        if (!item || item.kind !== "video" || !needsShrinkMark(item)) continue;
        if (only && !only.has(list + ":" + item.id)) continue;
        queue.push({ list, id: String(item.id), name: item.name || "Video", size: Number(item.size) || 0 });
      }
    }
    queue.sort((a, b) => b.size - a.size);
    let freed = 0;
    let index = 0;
    for (const entry of queue) {
      index += 1;
      if (signal && signal.aborted) break;
      if (!(await waitUntilIdle(options.isBusy, signal, () => emit({ step: "videos", label: "Waiting for the recording to finish" })))) break;
      const fresh = await loadWorkspace(dataRoot, wsId);
      const item = (fresh[entry.list] || []).find((row) => row && String(row.id) === entry.id);
      if (!item || !needsShrinkMark(item)) continue;
      const src = path.join(base, item.file);
      const probe = await shrink.probeVideo(options.ffmpeg, src);
      const plan = shrink.shrinkPlan(probe, (await statOrNull(src) || {}).size);
      if (!plan.ok) {
        await markSkipped(dataRoot, wsId, entry.list, entry.id, plan.reason);
        continue;
      }
      const dest = path.join(base, entry.list, entry.id + "-" + shortId() + ".mp4");
      const label = "Shrinking " + entry.name;
      emit({ step: "videos", label, done: index - 1, total: queue.length, percent: 0 });
      const res = await shrink.shrinkVideo({
        ffmpeg: options.ffmpeg,
        src,
        dest,
        probe,
        signal,
        onProgress: (p) =>
          emit({ step: "videos", label: p.phase === "verify" ? "Checking " + entry.name : label, done: index - 1, total: queue.length, percent: p.percent }),
      });
      if (res.ok) {
        const saved = await commitReplacement(dataRoot, wsId, entry.list, entry.id, dest, {
          mime: "video/mp4",
          shrink: { at: new Date().toISOString(), method: "x264-crf" + shrink.VIDEO_CRF, fromBytes: res.fromBytes, ssim: Number(res.ssim.toFixed(4)) },
        });
        if (saved) freed += res.fromBytes - res.bytes;
        changed();
      } else if (res.reason === "canceled") {
        break;
      } else {
        summary.skipped.push({ name: entry.name, reason: res.reason });
        await markSkipped(dataRoot, wsId, entry.list, entry.id, res.reason);
      }
    }
    summary.steps.videos = { freedBytes: freed };
    summary.freedBytes += freed;
  }

  summary.canceled = Boolean(signal && signal.aborted);
  emit({ step: "done", label: summary.canceled ? "Stopped" : "Done", summary });
  return summary;
}

// Explicit deletes from the Leftover files list. "copies" removes only files
// whose bytes still exist elsewhere; "all" removes the whole group.
async function deleteLeftover(dataRoot, opts) {
  const options = opts || {};
  const id = String(options.id || "");
  const mode = options.mode === "all" ? "all" : "copies";
  const { id: wsId, ws } = await activeWorkspace(dataRoot, options.workspaceId);
  const hashes = knownHashes(ws);
  let entries = [];
  if (id === "recorder-frames") {
    const frames = await recorderFrameLeftovers(dataRoot, hashes);
    entries = mode === "all" ? frames.files : frames.copies;
  } else if (id === "agent-workspaces") {
    const agents = await agentFolderCopies(dataRoot, hashes);
    entries = mode === "all" ? agents.files : agents.copies;
  } else if (id === "recorder-takes") {
    entries = mode === "all" ? await walk(path.join(dataRoot, "recorder-takes")) : [];
  } else if (id === "untracked") {
    entries = mode === "all" ? (await untrackedMedia(dataRoot, wsId, ws)).unknown : [];
  } else {
    throw new Error("Unknown leftover group.");
  }
  const freed = await removeFiles(entries);
  if (mode === "all" && (id === "recorder-frames" || id === "recorder-takes" || id === "agent-workspaces")) {
    await removeEmptyDirs(path.join(dataRoot, id));
  }
  return { id, mode, files: entries.length, freedBytes: freed };
}

async function removeEmptyDirs(dir) {
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) if (entry.isDirectory()) await removeEmptyDirs(path.join(dir, entry.name));
  try {
    if (!(await fs.readdir(dir)).length) await fs.rmdir(dir);
  } catch {
    /* not empty */
  }
}

// Older versions of shrunk files that were still open when the swap ran, and
// half-written outputs from a job the app quit during. Both are named after a
// live row that points elsewhere, so nothing the user can see goes.
async function sweepSuperseded(dataRoot, workspaceId) {
  const { id: wsId, ws } = await activeWorkspace(dataRoot, workspaceId);
  const { superseded } = await untrackedMedia(dataRoot, wsId, ws);
  return removeFiles(superseded);
}

function leftoverDir(dataRoot, id, wsId) {
  if (id === "untracked") return path.join(workspaceDir(dataRoot, wsId), "library");
  if (["recorder-frames", "recorder-takes", "agent-workspaces"].includes(id)) return path.join(dataRoot, id);
  return "";
}

module.exports = {
  storageReport,
  runOptimize,
  deleteLeftover,
  leftoverDir,
  sweepSuperseded,
  commitReplacement,
  untrackedMedia,
  recorderFrameLeftovers,
};
