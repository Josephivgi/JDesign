import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ITER = 12;

function median(nums) {
  const sorted = nums.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function benchAsync(fn, times = ITER) {
  const samples = [];
  for (let i = 0; i < times; i += 1) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  return median(samples);
}

function benchSync(fn, times = ITER) {
  const samples = [];
  for (let i = 0; i < times; i += 1) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  return median(samples);
}

async function runBench() {
  const mod = require(path.join(root, "lib", "recorder-session.js"));
  const bench = mod.benchFfmpeg;
  if (!bench) {
    throw new Error("recorder-session.js must export benchFfmpeg for this harness");
  }

  const ffmpeg = bench.findFfmpeg();
  const results = {};

  results["findFfmpeg resolve"] = benchSync(() => {
    for (let i = 0; i < 50; i += 1) bench.findFfmpeg();
  }, 20);

  if (!ffmpeg) {
    results["spawn alive check"] = 0;
    results["stopChild kill"] = 0;
    results["start stop cycle"] = 0;
    results._note = "ffmpeg not installed; spawn/kill areas skipped";
    return results;
  }

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "cutline-ffmpeg-bench-"));

  results["spawn alive check"] = await benchAsync(async () => {
    const outBase = path.join(tmpBase, "spawn-" + Date.now());
    const video = await bench.startLocalVideo(outBase);
    if (video && video.child) await bench.stopChild(video.child);
  }, 8);

  results["stopChild kill"] = await benchAsync(async () => {
    const outBase = path.join(tmpBase, "kill-" + Date.now());
    const video = await bench.startLocalVideo(outBase);
    if (!video || !video.child) return;
    await bench.stopChild(video.child);
  }, 8);

  results["start stop cycle"] = await benchAsync(async () => {
    const outBase = path.join(tmpBase, "cycle-" + Date.now());
    const video = await bench.startLocalVideo(outBase);
    if (!video || !video.child) return;
    await bench.stopChild(video.child);
  }, 6);

  try {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup.
  }

  return results;
}

async function main() {
  const results = await runBench();
  const outPath = process.argv[2];
  const payload = { ffmpeg: results, at: new Date().toISOString() };
  if (outPath) fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  else console.log(JSON.stringify(payload, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
