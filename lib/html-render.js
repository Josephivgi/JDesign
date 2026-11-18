"use strict";

// Rasterizes HTML/CSS card documents with a real browser engine. Inside the
// app it borrows the running Electron (one hidden window per job). From the
// file-backed MCP path it spawns the repo's own Electron binary on
// html-render-worker.cjs so HTML cards still render while the app is closed.
// Frames are deterministic: CSS animations and transitions are paused and
// seeked, so frame N is exactly page-time N/fps.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { randomUUID } = require("crypto");

const MAX_SEQUENCE_FRAMES = 900; // 30 s at 30 fps is the hard ceiling
const DEFAULT_FPS = 24;

function inElectron() {
  return typeof process.versions === "object" && Boolean(process.versions && process.versions.electron);
}

const STALL_MS = 60000;

function packagedApp() {
  try {
    return Boolean(require("electron").app.isPackaged);
  } catch {
    return false;
  }
}

function findElectronBinary(appRoot) {
  const forced = process.env.JEDITOR_ELECTRON_BIN || process.env.CUTLINE_ELECTRON_BIN;
  if (forced && fs.existsSync(forced)) {
    return forced;
  }
  const name = process.platform === "win32" ? "electron.exe" : "electron";
  const roots = [appRoot, path.join(__dirname, "..")];
  for (const root of roots) {
    if (!root) continue;
    const full = path.join(root, "node_modules", "electron", "dist", name);
    if (fs.existsSync(full)) return full;
  }
  return "";
}

function writeJobDoc(tempRoot, doc) {
  const htmlPath = path.join(tempRoot, "card.html");
  fs.writeFileSync(htmlPath, doc, "utf8");
  return htmlPath;
}

function spawnWorker(electronBin, workerPath, jobPath, frameCount, lead = []) {
  return new Promise((resolve, reject) => {
    // A leaked ELECTRON_RUN_AS_NODE would make the binary run as plain Node
    // and choke on the Electron switches, so scrub it from the child's env.
    const env = Object.assign({}, process.env, { ELECTRON_ENABLE_LOGGING: "" });
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electronBin, [...lead, "--no-sandbox", "--disable-gpu", workerPath, "--job", jobPath], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      // The worker prints FRAME after each capture: a slow page that is still
      // making frames is not stuck, so every frame restarts the stall clock.
      if (text.includes("FRAME")) arm();
      stdout += text.replace(/\nFRAME\n/g, "\n");
      if (stdout.length > 200000) stdout = stdout.slice(-100000);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 16000) stderr = stderr.slice(-8000);
    });
    // A worker is killed only when it stops making frames (60 s with no new
    // frame, more for the first one while the page loads), or after a hard
    // ceiling. Heavy pages under software rendering can take seconds a frame.
    let timedOut = false;
    let timer = null;
    const kill = () => {
      timedOut = true;
      clearTimeout(ceiling);
      child.kill();
      setTimeout(() => reject(new Error("HTML card render stalled: no new frame for a minute.")), 5000).unref();
    };
    function arm(ms = STALL_MS) {
      clearTimeout(timer);
      timer = setTimeout(kill, ms);
    }
    const ceiling = setTimeout(kill, Math.max(STALL_MS * 2, frameCount * 6000));
    arm(STALL_MS * 2);
    child.on("error", (error) => {
      clearTimeout(timer);
      clearTimeout(ceiling);
      reject(error);
    });
    child.on("close", () => {
      clearTimeout(timer);
      clearTimeout(ceiling);
      if (timedOut) {
        reject(new Error("HTML card render stalled: no new frame for a minute."));
        return;
      }
      const match = /RESULT:(\{[^\n]*\})/.exec(stdout);
      if (!match) {
        reject(new Error("HTML card render failed" + (stderr ? ": " + stderr.trim().split(/\r?\n/).pop() : ".")));
        return;
      }
      let result;
      try {
        result = JSON.parse(match[1]);
      } catch {
        reject(new Error("HTML card render returned unreadable output."));
        return;
      }
      if (!result.ok) {
        reject(new Error(result.error || "HTML card render failed."));
        return;
      }
      resolve(result);
    });
  });
}

// One render job: writes the document, runs whichever engine is available,
// and returns the captured frames.
async function runRenderJob(options) {
  const opts = options || {};
  if (!opts.doc) throw new Error("HTML card document is required.");
  const appRoot = opts.appRoot || path.join(__dirname, "..");
  const tempRoot = opts.tempRoot || fs.mkdtempSync(path.join(os.tmpdir(), "cutline-html-"));
  const ownTemp = !opts.tempRoot;
  try {
    const htmlPath = writeJobDoc(tempRoot, opts.doc);
    const job = {
      htmlPath,
      width: opts.width,
      height: opts.height,
      transparent: opts.transparent !== false,
      outDir: opts.outDir || tempRoot,
      pattern: opts.pattern || "frame-%05d.png",
      outPath: opts.outPath || "",
      timesMs: opts.timesMs && opts.timesMs.length ? opts.timesMs : [0],
    };
    // Frames render in separate hidden worker processes, even inside the app.
    // Rendering in the app's own process blocked its main thread for most of
    // a second per frame (a 5 s title took over two minutes and froze the
    // window); sharded workers do the same job in seconds. A packaged build
    // has no separate Electron binary, so it relaunches itself in worker mode
    // (see the --html-render-worker branch at the top of electron/main.cjs).
    let electronBin = findElectronBinary(appRoot);
    let lead = [];
    if (!electronBin && inElectron() && packagedApp()) {
      electronBin = process.execPath;
      lead = ["--html-render-worker"];
    }
    if (!electronBin && inElectron()) {
      const { app, BrowserWindow } = require("electron");
      const { runJobInApp } = require("./html-render-worker.cjs");
      const result = await runJobInApp(app, BrowserWindow, job);
      return withErrors(result.frames, [result.pageErrors]);
    }
    if (!electronBin) {
      throw new Error(
        "HTML cards need a browser engine to rasterize. Open the JV app, or set JEDITOR_ELECTRON_BIN to an Electron binary.",
      );
    }
    // Long sequences split across a few workers: PNG encoding is single
    // threaded per process, and every frame seeks its own page-time, so the
    // shards write the same frames a single worker would.
    const workerPath = path.join(__dirname, "html-render-worker.cjs");
    const shards = job.outPath ? 1 : sequenceShards(job.timesMs.length);
    const per = Math.ceil(job.timesMs.length / shards);
    const runs = [];
    for (let s = 0; s < shards; s += 1) {
      const part = Object.assign({}, job, { timesMs: job.timesMs.slice(s * per, (s + 1) * per), indexOffset: s * per });
      if (part.timesMs.length) runs.push(spawnWorker(electronBin, workerPath, writeJobPath(tempRoot, part), part.timesMs.length, lead));
    }
    // Wait for every shard before failing, so no worker is still writing
    // frames when the caller cleans the temp dir.
    const settled = await Promise.allSettled(runs);
    const failed = settled.find((entry) => entry.status === "rejected");
    if (failed) throw failed.reason;
    return withErrors(
      settled.flatMap((entry) => entry.value.frames),
      settled.map((entry) => entry.value.pageErrors),
    );
  } finally {
    if (ownTemp && !opts.keepTemp) {
      fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 3 }, () => {});
    }
  }
}

// Frame paths with the page's script errors from every shard, deduped.
function withErrors(frames, lists) {
  const out = Array.isArray(frames) ? frames : [];
  // Each shard reports its own first frame for one broken drawAt; keep one.
  const seen = new Map();
  for (const list of lists || []) {
    for (const e of Array.isArray(list) ? list : []) {
      const key = String(e).replace(/ at \d+ ms:/, ":");
      if (!seen.has(key) && seen.size < 10) seen.set(key, String(e));
    }
  }
  out.pageErrors = Array.from(seen.values());
  return out;
}

// One worker per second of 24 fps frames, at most 4 and at most a quarter of
// the cores, so a render leaves room for the app and the encoder. Each extra
// worker costs about half a second of Electron startup, run in parallel.
function sequenceShards(frameCount) {
  const cores = (os.cpus() || []).length || 4;
  return Math.max(1, Math.min(4, Math.floor(cores / 4), Math.ceil(frameCount / 24)));
}

function writeJobPath(tempRoot, job) {
  const jobPath = path.join(tempRoot, "job-" + randomUUID() + ".json");
  fs.writeFileSync(jobPath, JSON.stringify(job), "utf8");
  return jobPath;
}

// Rasterize one frame to a PNG. atMs freezes CSS animation at that page-time
// (defaults to 0.6s so mid-animation cards preview their design, not frame 0).
async function renderHtmlPng(options) {
  const opts = options || {};
  const frames = await runRenderJob({
    doc: opts.doc,
    width: opts.width,
    height: opts.height,
    transparent: opts.transparent,
    outPath: opts.outPath,
    tempRoot: opts.tempRoot,
    keepTemp: opts.keepTemp,
    appRoot: opts.appRoot,
    timesMs: [opts.atMs != null ? opts.atMs : 600],
  });
  const file = frames[0];
  if (!file || !fs.existsSync(file) || fs.statSync(file).size < 16) {
    throw new Error("HTML card render produced no image.");
  }
  return { path: file, width: opts.width, height: opts.height };
}

// A few moments of the same document, for looking at the motion. The animation
// tools use this to show a model what it wrote before a full render.
async function renderHtmlFrames(options) {
  const opts = options || {};
  const timesMs = (Array.isArray(opts.timesMs) && opts.timesMs.length ? opts.timesMs : [0]).map((value) =>
    Math.max(0, Number(value) || 0),
  );
  const files = await runRenderJob({
    doc: opts.doc,
    width: opts.width,
    height: opts.height,
    transparent: opts.transparent !== false,
    outDir: opts.outDir,
    pattern: opts.pattern || "still-%05d.png",
    timesMs,
    appRoot: opts.appRoot,
    tempRoot: opts.tempRoot,
    keepTemp: !opts.outDir,
  });
  return { timesMs, files, pageErrors: files.pageErrors || [] };
}

// Rasterize an animated card to a numbered PNG sequence for the compose step.
async function renderHtmlSequence(options) {
  const opts = options || {};
  const durationMs = Math.max(200, Math.round(Number(opts.durationMs) || 3000));
  const fps = Math.max(10, Math.min(30, Math.round(Number(opts.fps) || DEFAULT_FPS)));
  const frames = Math.max(1, Math.min(MAX_SEQUENCE_FRAMES, Math.round((durationMs / 1000) * fps)));
  const times = [];
  for (let i = 0; i < frames; i += 1) times.push((i / fps) * 1000);
  const files = await runRenderJob({
    doc: opts.doc,
    width: opts.width,
    height: opts.height,
    transparent: opts.transparent,
    outDir: opts.outDir,
    pattern: "frame-%05d.png",
    timesMs: times,
    appRoot: opts.appRoot,
    tempRoot: opts.tempRoot,
    // Frames written to the caller's outDir leave only the job files behind,
    // so an owned temp dir is removed; without outDir the frames live there.
    keepTemp: !opts.outDir,
  });
  const dir = files.length ? path.dirname(files[0]) : opts.outDir;
  return { dir, pattern: "frame-%05d.png", fps, frames: files.length, files, pageErrors: files.pageErrors || [] };
}

module.exports = {
  inElectron,
  findElectronBinary,
  renderHtmlPng,
  renderHtmlFrames,
  renderHtmlSequence,
  MAX_SEQUENCE_FRAMES,
  DEFAULT_FPS,
};
