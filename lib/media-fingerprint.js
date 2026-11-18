"use strict";

// Perceptual fingerprints for "these look the same" checks. A dHash is 64
// bits from a 9x8 grayscale thumbnail: each bit says whether a pixel is
// brighter than its right neighbour. Two pictures that differ only by
// re-encoding, a resize, or a tiny change land a few bits apart.

const path = require("path");
const fsp = require("fs/promises");
const { spawn } = require("child_process");

const DHASH_W = 9;
const DHASH_H = 8;
// Images use a 17x16 grid (256 bits). Screenshots of one app share most of
// their layout, and 64 bits cannot tell two different chats apart.
const IMAGE_W = 17;
const IMAGE_H = 16;
const NATIVE_EXT = new Set([".png", ".jpg", ".jpeg"]);

function dhashFromGray(gray, w, h) {
  const width = w || DHASH_W;
  const height = h || DHASH_H;
  let bits = "";
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      const left = gray[y * width + x];
      const right = gray[y * width + x + 1];
      bits += left > right ? "1" : "0";
    }
  }
  let hex = "";
  for (let i = 0; i < bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

// BGRA (nativeImage.toBitmap on Windows/Linux) to luma.
function grayFromBgra(buf, width, height) {
  const out = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i += 1) {
    const b = buf[i * 4];
    const g = buf[i * 4 + 1];
    const r = buf[i * 4 + 2];
    out[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }
  return out;
}

const POPCOUNT = Array.from({ length: 16 }, (_, n) => (n & 1) + ((n >> 1) & 1) + ((n >> 2) & 1) + ((n >> 3) & 1));

function hamming(a, b) {
  const x = String(a || "");
  const y = String(b || "");
  if (!x || x.length !== y.length) return Infinity;
  let d = 0;
  for (let i = 0; i < x.length; i += 1) d += POPCOUNT[parseInt(x[i], 16) ^ parseInt(y[i], 16)];
  return d;
}

function runCapture(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    const timer = setTimeout(() => child.kill(), timeoutMs || 20000);
    const done = (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? Buffer.concat(chunks) : null);
    };
    child.on("error", () => done(1));
    child.on("close", done);
  });
}

async function ffmpegGray(ffmpeg, file, seekSeconds, w, h) {
  const width = w || DHASH_W;
  const height = h || DHASH_H;
  const args = ["-hide_banner", "-v", "error"];
  if (seekSeconds > 0) args.push("-ss", seekSeconds.toFixed(3));
  args.push(
    "-i",
    file,
    "-frames:v",
    "1",
    "-vf",
    "scale=" + width + ":" + height + ":flags=area,format=gray",
    "-f",
    "rawvideo",
    "-",
  );
  const buf = await runCapture(ffmpeg, args);
  return buf && buf.length >= width * height ? buf : null;
}

// Fingerprints keyed by path, size, and mtime. Workspace rows cache a good
// hash, but a clip ffmpeg cannot read (or a run that failed) used to be
// retried with fresh spawns on every Cleanup open. Misses expire so a
// transient failure is retried later in the session.
const memo = new Map();
const MEMO_MAX = 5000;
const MISS_TTL_MS = 10 * 60 * 1000;

async function memoized(kind, file, extra, compute) {
  let st = null;
  try {
    st = await fsp.stat(file);
  } catch {
    return compute();
  }
  const key = kind + "|" + file + "|" + st.size + "|" + st.mtimeMs + "|" + extra;
  const hit = memo.get(key);
  const copy = (value) => (value && typeof value === "object" ? Object.assign({}, value) : value);
  if (hit && (hit.ok || Date.now() - hit.at < MISS_TTL_MS)) return copy(hit.value);
  const value = await compute();
  if (memo.size >= MEMO_MAX) memo.delete(memo.keys().next().value);
  memo.set(key, { value, ok: Boolean(value), at: Date.now() });
  return copy(value);
}

async function imageDhash(file, opts) {
  const options = opts || {};
  if (!options.nativeImage && !options.ffmpeg) return null;
  return memoized("image", String(file || ""), (options.nativeImage ? "n" : "") + (options.ffmpeg ? "f" : ""), () => computeImageDhash(file, options));
}

async function videoSignature(file, durationMs, opts) {
  const options = opts || {};
  if (!options.ffmpeg) return "";
  return memoized("video", String(file || ""), String(Number(durationMs) || 0), () => computeVideoSignature(file, durationMs, options));
}

// nativeImage decodes PNG and JPEG in-process, which matters with hundreds of
// screenshots: one ffmpeg spawn costs about half a second on Windows.
async function computeImageDhash(file, opts) {
  const options = opts || {};
  const ext = path.extname(String(file || "")).toLowerCase();
  if (options.nativeImage && NATIVE_EXT.has(ext)) {
    try {
      const img = options.nativeImage.createFromPath(file);
      if (img && !img.isEmpty()) {
        const small = img.resize({ width: IMAGE_W, height: IMAGE_H, quality: "good" });
        const size = small.getSize();
        if (size.width === IMAGE_W && size.height === IMAGE_H) {
          const full = img.getSize();
          const gray = grayFromBgra(small.toBitmap(), IMAGE_W, IMAGE_H);
          return { hash: dhashFromGray(gray, IMAGE_W, IMAGE_H), width: full.width, height: full.height };
        }
      }
    } catch {
      /* fall back to ffmpeg */
    }
  }
  if (!options.ffmpeg) return null;
  const gray = await ffmpegGray(options.ffmpeg, file, 0, IMAGE_W, IMAGE_H);
  return gray ? { hash: dhashFromGray(gray, IMAGE_W, IMAGE_H), width: 0, height: 0 } : null;
}

// Three frames spread through the clip. A re-encode, a remux, or the same
// cut rendered twice keeps all three close; different footage does not.
// One ffmpeg spawn for all three frames: each seek is its own input and the
// thumbnails stack into one 9x24 gray frame.
async function computeVideoSignature(file, durationMs, opts) {
  const options = opts || {};
  if (!options.ffmpeg) return "";
  const seconds = Math.max(0, Number(durationMs) || 0) / 1000;
  if (seconds <= 1) {
    const gray = await ffmpegGray(options.ffmpeg, file, 0);
    return gray ? dhashFromGray(gray) : "";
  }
  const points = [0.15, 0.5, 0.85].map((f) => seconds * f);
  const args = ["-hide_banner", "-v", "error"];
  points.forEach((at) => args.push("-ss", at.toFixed(3), "-i", file));
  const scale = "scale=" + DHASH_W + ":" + DHASH_H + ":flags=area,format=gray,trim=end_frame=1,setpts=0";
  const graph = points.map((_, i) => "[" + i + ":v:0]" + scale + "[v" + i + "]").join(";") + ";[v0][v1][v2]vstack=inputs=3[out]";
  args.push("-filter_complex", graph, "-map", "[out]", "-frames:v", "1", "-f", "rawvideo", "-");
  const buf = await runCapture(options.ffmpeg, args, 30000);
  const cell = DHASH_W * DHASH_H;
  if (!buf || buf.length < cell * 3) return "";
  return [0, 1, 2].map((i) => dhashFromGray(buf.subarray(i * cell, (i + 1) * cell))).join(":");
}

function signatureDistance(a, b) {
  const x = String(a || "").split(":");
  const y = String(b || "").split(":");
  if (!x[0] || x.length !== y.length) return Infinity;
  let total = 0;
  for (let i = 0; i < x.length; i += 1) total += hamming(x[i], y[i]);
  return total / x.length;
}

// Image hashes are 256 bits; video hashes are three 64-bit frames averaged.
// Checked on real screenshots: 5 bits apart was the same screen with the
// playhead moved; 7 bits apart was already a different page.
const IMAGE_MAX_BITS = 5;
const VIDEO_MAX_BITS = 6;

function hashBits(hash) {
  return String(hash || "").split(":")[0].length * 4 || 64;
}

function similarAspect(a, b) {
  if (!a.width || !a.height || !b.width || !b.height) return true;
  return Math.abs(a.width / a.height - b.width / b.height) < 0.03;
}

function similarDuration(a, b) {
  const x = Number(a.durationMs) || 0;
  const y = Number(b.durationMs) || 0;
  if (!x || !y) return false;
  return Math.abs(x - y) <= Math.max(500, 0.02 * Math.max(x, y));
}

function bitCount(hex) {
  let n = 0;
  for (const ch of String(hex || "")) n += POPCOUNT[parseInt(ch, 16)] || 0;
  return n;
}

// A black, white, or single-colour frame has no edges, so its hash is all
// zeros and every blank clip would "look alike". Keep those out; a frame
// with structure sets far more than a few bits.
function informative(row) {
  const parts = String(row.phash || "").split(":");
  return parts.some((part) => bitCount(part) > Math.max(2, (part.length * 4) / 64));
}

function distance(a, b) {
  return a.mediaKind === "image" ? hamming(a.phash, b.phash) : signatureDistance(a.phash, b.phash);
}

function alike(a, b, imageBits, videoBits) {
  if (a.mediaKind !== b.mediaKind) return false;
  if (a.mediaKind === "image") return similarAspect(a, b) && hamming(a.phash, b.phash) <= imageBits;
  return similarDuration(a, b) && signatureDistance(a.phash, b.phash) <= videoBits;
}

// Rows carry { mediaKind, phash, width, height, durationMs }. Each group has a
// leader (the earliest row in the given order, so callers pass the best copy
// first) and every member must look like the leader itself. Chaining by
// neighbours would pull a slow scroll through a chat into one giant group.
function groupNearDuplicates(rows, opts) {
  const options = opts || {};
  const imageBits = Number.isFinite(options.imageBits) ? options.imageBits : IMAGE_MAX_BITS;
  const videoBits = Number.isFinite(options.videoBits) ? options.videoBits : VIDEO_MAX_BITS;
  const list = (rows || []).filter((row) => row && row.phash && (row.mediaKind === "image" || row.mediaKind === "video") && informative(row));
  const taken = new Array(list.length).fill(false);
  const groups = [];
  for (let i = 0; i < list.length; i += 1) {
    if (taken[i]) continue;
    const group = [list[i]];
    for (let j = i + 1; j < list.length; j += 1) {
      if (!taken[j] && alike(list[i], list[j], imageBits, videoBits)) {
        group.push(list[j]);
        taken[j] = true;
      }
    }
    if (group.length > 1) {
      taken[i] = true;
      groups.push(group);
    }
  }
  return groups;
}

module.exports = {
  dhashFromGray,
  grayFromBgra,
  hamming,
  imageDhash,
  videoSignature,
  signatureDistance,
  distance,
  hashBits,
  groupNearDuplicates,
  IMAGE_MAX_BITS,
  VIDEO_MAX_BITS,
};
