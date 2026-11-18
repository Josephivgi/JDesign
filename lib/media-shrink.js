"use strict";

// Shrinks media files without changing what the user sees.
//
// Videos: screen takes come out of the browser's hardware H.264 encoder at a
// fixed ~6 Mbps Baseline stream, which spends the same bits on a still screen
// as on motion. x264 High at CRF 21 keeps the picture and drops 60 to 75% of
// the bytes. Every output is checked before it may replace the original: same
// frame count, same length, and a frame-by-frame SSIM of at least 0.985
// (0.99+ is not visible). A file that fails a check, or saves under 15%, is
// thrown away and the original stays.
//
// Images: PNG to lossless WebP. The decoded RGBA pixels of both files are
// hashed and must match exactly, so not one pixel changes.

const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { randomUUID } = require("crypto");

const VIDEO_CRF = 21;
const VIDEO_PRESET = "slow";
const MIN_SSIM = 0.985;
const MIN_SAVING = 0.15;
const STALL_MS = 180000;

function lowerPriority(child) {
  try {
    os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    /* best effort */
  }
}

function run(bin, args, opts) {
  const options = opts || {};
  return new Promise((resolve) => {
    const child = spawn(bin, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    if (options.background) lowerPriority(child);
    let stdout = "";
    let stderr = "";
    let lastBeat = Date.now();
    let killed = "";
    const onAbort = () => {
      killed = "canceled";
      child.kill();
    };
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }
    const stall = setInterval(() => {
      if (Date.now() - lastBeat > (options.stallMs || STALL_MS)) {
        killed = "stalled";
        child.kill();
      }
    }, 5000);
    child.stdout.on("data", (chunk) => {
      lastBeat = Date.now();
      const text = String(chunk);
      if (options.onStdout) options.onStdout(text);
      if (!options.dropStdout) stdout += text;
      if (stdout.length > 200000) stdout = stdout.slice(-100000);
    });
    child.stderr.on("data", (chunk) => {
      lastBeat = Date.now();
      stderr += String(chunk);
      if (stderr.length > 200000) stderr = stderr.slice(-100000);
    });
    const finish = (code) => {
      clearInterval(stall);
      if (options.signal) options.signal.removeEventListener("abort", onAbort);
      resolve({ code: killed ? -1 : code, stdout, stderr, killed });
    };
    child.on("error", (error) => {
      stderr += String((error && error.message) || error);
      finish(1);
    });
    child.on("close", finish);
  });
}

// `ffmpeg -i` prints the stream table even without an output; enough to
// decide whether a re-encode can help.
async function probeVideo(ffmpeg, file) {
  const { stderr } = await run(ffmpeg, ["-hide_banner", "-i", file], { stallMs: 20000 });
  const video = /Stream #\d+:\d+[^:]*: Video: ([^\n]+)/.exec(stderr);
  const audio = /Stream #\d+:\d+[^:]*: Audio: ([a-z0-9_]+)/.exec(stderr);
  const duration = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  const bitrate = /Duration:[^\n]*bitrate: (\d+) kb\/s/.exec(stderr);
  const line = video ? video[1] : "";
  const codec = (/^([a-z0-9_]+)/.exec(line) || [])[1] || "";
  const profile = (/^[a-z0-9_]+ \(([^)]+)\)/.exec(line) || [])[1] || "";
  const dims = / (\d{2,5})x(\d{2,5})[ ,[]/.exec(line);
  const fps = / (\d+(?:\.\d+)?) fps/.exec(line);
  const pixFmt = (/\b(yuv[a-z0-9]+|yuvj[a-z0-9]+|rgb[a-z0-9]*|bgr[a-z0-9]*|gbr[a-z0-9]*|nv12|p010[a-z]*)\b/.exec(line) || [])[1] || "";
  return {
    codec,
    profile,
    pixFmt,
    width: dims ? Number(dims[1]) : 0,
    height: dims ? Number(dims[2]) : 0,
    fps: fps ? Number(fps[1]) : 0,
    bitrate: bitrate ? Number(bitrate[1]) * 1000 : 0,
    durationMs: duration ? Math.round((Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])) * 1000) : 0,
    audio: audio ? audio[1] : "",
    hdr: /smpte2084|arib-std-b67|bt2020/.test(line),
    highBitDepth: /p(9|10|12|14|16)(le|be)?\b/.test(pixFmt),
  };
}

const EFFICIENT_CODECS = new Set(["hevc", "h265", "av1", "vvc"]);

// Decide before spending minutes of CPU. Bits per pixel per frame tells a
// wasteful stream from a tight one; Baseline H.264 and VP8 are always loose.
function shrinkPlan(probe, sizeBytes) {
  const p = probe || {};
  const size = Number(sizeBytes) || 0;
  if (!p.codec || !p.width || !p.height) return { ok: false, reason: "unreadable" };
  if (EFFICIENT_CODECS.has(p.codec)) return { ok: false, reason: "already efficient" };
  if (p.hdr || p.highBitDepth) return { ok: false, reason: "HDR or high bit depth" };
  if (size < 4 * 1024 * 1024) return { ok: false, reason: "small" };
  const fps = p.fps > 0 && p.fps < 241 ? p.fps : 30;
  const seconds = (p.durationMs || 0) / 1000;
  const bitrate = p.bitrate || (seconds > 0 ? (size * 8) / seconds : 0);
  const bpp = bitrate / (p.width * p.height * fps);
  const loose = /baseline/i.test(p.profile) || p.codec === "vp8" || p.codec === "mjpeg" || p.codec === "mpeg4";
  if (!loose && bpp < 0.05) return { ok: false, reason: "already tight", bpp };
  // Screen takes landed near 0.025 bpp after the re-encode; assume a little
  // more so the estimate does not oversell.
  const target = seconds > 0 ? (p.width * p.height * fps * 0.03 * seconds) / 8 : size * 0.4;
  const estimate = Math.max(0, Math.round(size - Math.min(size * 0.85, target)));
  return { ok: true, bpp, estimateBytes: estimate };
}

async function countVideoPackets(ffmpeg, file, signal) {
  const res = await run(ffmpeg, ["-hide_banner", "-nostats", "-progress", "pipe:1", "-i", file, "-map", "0:v:0", "-c", "copy", "-f", "null", "-"], { signal, background: true });
  const all = res.stdout.match(/frame=(\d+)/g);
  return all && all.length ? Number(all[all.length - 1].slice(6)) : 0;
}

async function ssimOf(ffmpeg, encoded, original, opts) {
  const options = opts || {};
  const graph = options.byIndex
    ? "[0:v]setpts=N/30/TB[a];[1:v]setpts=N/30/TB[b];[a][b]ssim"
    : "[0:v]settb=AVTB,setpts=PTS-STARTPTS[a];[1:v]settb=AVTB,setpts=PTS-STARTPTS[b];[a][b]ssim";
  const res = await run(ffmpeg, ["-hide_banner", "-nostats", "-i", encoded, "-i", original, "-lavfi", graph, "-f", "null", "-"], {
    signal: options.signal,
    background: true,
  });
  const match = /All:([\d.]+)/.exec(res.stderr);
  return match ? Number(match[1]) : 0;
}

function audioArgs(codec) {
  if (!codec) return [];
  if (["aac", "mp3", "opus", "ac3", "eac3", "alac", "flac"].includes(codec)) return ["-c:a", "copy"];
  return ["-c:a", "aac", "-b:a", "192k"];
}

// Writes `dest` (an .mp4) and returns { ok, bytes, ssim } or { ok:false, reason }.
// Never touches `src`. `dest` is removed on any failure.
async function shrinkVideo(opts) {
  const { ffmpeg, src, dest, signal, onProgress } = opts || {};
  const probe = opts.probe || (await probeVideo(ffmpeg, src));
  const srcStat = await fs.stat(src);
  const fail = async (reason) => {
    await fs.unlink(dest).catch(() => {});
    return { ok: false, reason, probe };
  };
  const durationMs = probe.durationMs || 0;
  const args = [
    "-hide_banner",
    "-nostats",
    "-y",
    "-i",
    src,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-map_metadata",
    "0",
    "-c:v",
    "libx264",
    "-preset",
    VIDEO_PRESET,
    "-crf",
    String(VIDEO_CRF),
    "-profile:v",
    "high",
    "-pix_fmt",
    "yuv420p",
    "-fps_mode",
    "passthrough",
    ...audioArgs(probe.audio),
    "-movflags",
    "+faststart",
    "-progress",
    "pipe:1",
    dest,
  ];
  let reported = -1;
  const res = await run(ffmpeg, args, {
    signal,
    background: true,
    dropStdout: true,
    onStdout: (text) => {
      if (!onProgress || !durationMs) return;
      const all = text.match(/out_time_us=(\d+)/g);
      if (!all) return;
      const us = Number(all[all.length - 1].slice(12));
      const pct = Math.min(99, Math.floor((us / 1000 / durationMs) * 100));
      if (pct !== reported) {
        reported = pct;
        onProgress({ phase: "encode", percent: pct });
      }
    },
  });
  if (res.killed === "canceled") return fail("canceled");
  if (res.code !== 0) return fail("encode failed: " + (res.stderr.split(/\r?\n/).filter(Boolean).pop() || res.code));
  const outStat = await fs.stat(dest).catch(() => null);
  if (!outStat || !outStat.size) return fail("empty output");
  if (outStat.size > srcStat.size * (1 - MIN_SAVING)) return fail("no real saving");

  if (onProgress) onProgress({ phase: "verify", percent: 0 });
  const after = await probeVideo(ffmpeg, dest);
  if (durationMs && Math.abs((after.durationMs || 0) - durationMs) > Math.max(300, durationMs * 0.005)) {
    return fail("length changed");
  }
  if (Boolean(probe.audio) !== Boolean(after.audio)) return fail("audio track changed");
  const [srcFrames, outFrames] = await Promise.all([countVideoPackets(ffmpeg, src, signal), countVideoPackets(ffmpeg, dest, signal)]);
  if (signal && signal.aborted) return fail("canceled");
  const sameFrames = srcFrames > 0 && Math.abs(srcFrames - outFrames) <= 1;
  if (srcFrames > 0 && !sameFrames && Math.abs(srcFrames - outFrames) > Math.max(2, srcFrames * 0.001)) {
    return fail("frame count changed");
  }
  if (onProgress) onProgress({ phase: "verify", percent: 50 });
  const ssim = await ssimOf(ffmpeg, dest, src, { byIndex: sameFrames, signal });
  if (signal && signal.aborted) return fail("canceled");
  if (!(ssim >= MIN_SSIM)) return fail("picture changed (SSIM " + ssim.toFixed(3) + ")");
  return { ok: true, bytes: outStat.size, fromBytes: srcStat.size, ssim, probe, frames: outFrames };
}

async function rgbaHashes(ffmpeg, files, signal) {
  const dir = path.join(os.tmpdir(), "cutline-hash-" + randomUUID());
  await fs.mkdir(dir, { recursive: true });
  try {
    const args = ["-hide_banner", "-v", "error", "-y"];
    files.forEach((file) => args.push("-i", file));
    files.forEach((_, i) => args.push("-map", i + ":v:0", "-frames:v", "1", "-pix_fmt", "rgba", "-f", "hash", "-hash", "sha256", path.join(dir, i + ".txt")));
    const res = await run(ffmpeg, args, { signal, background: true });
    if (res.code !== 0) return files.map(() => "");
    return Promise.all(files.map((_, i) => fs.readFile(path.join(dir, i + ".txt"), "utf8").then((s) => s.trim(), () => "")));
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// Batch of { src, dest } PNG to lossless WebP. Two ffmpeg runs per batch: one
// encode, one decode of both sides; spawning per file costs ~0.5 s on Windows.
// Returns one { ok, bytes, fromBytes, reason } per job.
async function shrinkImagesLossless(ffmpeg, jobs, signal) {
  const list = jobs || [];
  if (!list.length) return [];
  const args = ["-hide_banner", "-v", "error", "-y"];
  list.forEach((job) => args.push("-i", job.src));
  list.forEach((job, i) =>
    args.push("-map", i + ":v:0", "-frames:v", "1", "-c:v", "libwebp", "-lossless", "1", "-compression_level", "6", "-pix_fmt", "bgra", job.dest),
  );
  const enc = await run(ffmpeg, args, { signal, background: true });
  const results = [];
  if (enc.code !== 0) {
    for (const job of list) await fs.unlink(job.dest).catch(() => {});
    if (enc.killed === "canceled") return list.map(() => ({ ok: false, reason: "canceled" }));
    // One bad file fails the whole batch; retry one by one so the rest still shrink.
    if (list.length > 1) {
      for (const job of list) results.push(...(await shrinkImagesLossless(ffmpeg, [job], signal)));
      return results;
    }
    return [{ ok: false, reason: "encode failed" }];
  }
  const files = [];
  list.forEach((job) => files.push(job.src, job.dest));
  const hashes = await rgbaHashes(ffmpeg, files, signal);
  for (let i = 0; i < list.length; i += 1) {
    const job = list[i];
    const a = hashes[i * 2];
    const b = hashes[i * 2 + 1];
    const [srcStat, outStat] = await Promise.all([fs.stat(job.src).catch(() => null), fs.stat(job.dest).catch(() => null)]);
    let reason = "";
    if (!a || !b || a !== b) reason = "pixels differ";
    else if (!srcStat || !outStat || !outStat.size) reason = "missing output";
    else if (outStat.size >= srcStat.size * 0.95) reason = "no real saving";
    if (reason) {
      await fs.unlink(job.dest).catch(() => {});
      results.push({ ok: false, reason });
    } else {
      results.push({ ok: true, bytes: outStat.size, fromBytes: srcStat.size });
    }
  }
  return results;
}

// A small JPEG still for videos that never got one, so every tile has a face.
async function makePoster(ffmpeg, src, dest, durationMs) {
  const at = Math.min(3, Math.max(0, ((Number(durationMs) || 0) / 1000) * 0.1));
  const res = await run(ffmpeg, ["-hide_banner", "-v", "error", "-y", "-ss", at.toFixed(2), "-i", src, "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4", dest], {
    stallMs: 30000,
    background: true,
  });
  if (res.code !== 0) {
    await fs.unlink(dest).catch(() => {});
    return false;
  }
  return true;
}

module.exports = {
  probeVideo,
  shrinkPlan,
  shrinkVideo,
  shrinkImagesLossless,
  makePoster,
  ssimOf,
  countVideoPackets,
  VIDEO_CRF,
  MIN_SSIM,
  MIN_SAVING,
};
