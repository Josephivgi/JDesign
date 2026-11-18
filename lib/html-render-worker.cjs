"use strict";

// Electron-side worker for html-render.js. Runs as `electron html-render-worker.cjs
// --job <job.json>` (spawned by lib/html-render.js when no Electron is already
// running) and is also imported in-process by the bridge path. It opens one
// hidden window on the card document and captures a frame per requested time.

const fs = require("fs");
const path = require("path");

// Freezes every CSS animation/transition at the given page-time (ms) so each
// captured frame is the exact moment the video frame will show.
const FREEZE_FN =
  "(function(t){" +
  "var n=0;" +
  "try{" +
  "var list=document.getAnimations({subtree:true});" +
  "n=list.length;" +
  "for(var i=0;i<list.length;i++){try{list[i].pause();list[i].currentTime=t;}catch(e){}}" +
  "}catch(e){}" +
  "return n;" +
  "})";

// A document with its own script (a code-made animation, not an edit card)
// carries the runtime lib/animation-render.js injects: window.__cutlineSeek(t)
// moves its virtual clock to t and runs whatever it queued. Calling it after
// the CSS freeze puts both kinds of motion on the same page-time.
//
// Script changes (a counter's text, a bar's width, a canvas) only reach the
// picture after the page paints. A fixed 12 ms wait was not always enough, so
// a frame could show the previous frame's script state: frames asked for at
// 25% and 90% came back showing 0% and 25%. The seek now waits for two real
// animation frames (the runtime keeps the browser's own requestAnimationFrame
// as __cutlineRaf before it swaps in the virtual clock), capped at 250 ms.
const SEEK_FN =
  "(function(t){try{if(typeof window.__cutlineSeek!=='function')return 0;window.__cutlineSeek(t);" +
  // A CSS animation or transition the script started during the seek runs on
  // the wall clock, not the frame clock: report it so the agent sets the
  // styles from drawAt(t) instead.
  "try{var live=document.getAnimations({subtree:true}).filter(function(a){return a.playState==='running';});" +
  "if(live.length&&window.__jvError)window.__jvError('css motion at '+Math.round(t)+' ms','a CSS animation or transition was started by script; it does not follow the frame clock. Set the styles from drawAt(t) (JV.tween) instead');" +
  "live.forEach(function(a){try{a.finish();}catch(e){try{a.pause();a.currentTime=0;}catch(_){}}});}catch(e){}" +
  "var raf=window.__cutlineRaf;if(typeof raf!=='function')return 1;" +
  "var wait=window.__jvNativeTimeout||setTimeout;" +
  "return new Promise(function(done){var settled=false;function end(){if(!settled){settled=true;done(1);}}" +
  "wait(end,250);raf(function(){raf(end);});});}catch(e){}return 0;})";

// Older documents without __cutlineRaf still get a short beat to paint.
const SCRIPT_SETTLE_MS = 12;

// Frame files are written in the background (a few in flight) so disk I/O
// overlaps the next seek and capture.
const WORKER_MODE = process.argv.includes("--job");

async function captureFrames(win, timesMs, outDir, pattern, singlePath, size, indexOffset) {
  const written = [];
  const first = 1 + (Number(indexOffset) || 0);
  const writes = new Set();
  try {
    // One discarded capture first. The window's first grab lands before the
    // compositor has settled (and on a HiDPI display through a resize), which
    // made frame 1 a few pixels different on every run: the same document then
    // produced a different first frame, so a re-render of identical code did
    // not match the file already on disk.
    //
    // The first real frame also came back stale: the page still showed t=0
    // when frame 1 was asked for at 1.1 s, while the same time asked for
    // again was right. Seek to the first time and wait for two painted frames
    // before that throwaway grab, so the compositor is live when frame 1 lands.
    if (timesMs.length) {
      await win.webContents.executeJavaScript(FREEZE_FN + "(" + timesMs[0] + ")", true).catch(() => {});
      await win.webContents.executeJavaScript(SEEK_FN + "(" + timesMs[0] + ")", true).catch(() => 0);
      await win.webContents
        .executeJavaScript(
          "new Promise(function(done){var raf=window.__cutlineRaf||window.requestAnimationFrame;(window.__jvNativeTimeout||setTimeout)(done,300);raf(function(){raf(function(){done();});});})",
          true,
        )
        .catch(() => {});
    }
    await win.webContents.capturePage().catch(() => {});
    for (let i = 0; i < timesMs.length; i += 1) {
      await win.webContents.executeJavaScript(FREEZE_FN + "(" + timesMs[i] + ")", true);
      const scripted = await win.webContents
        .executeJavaScript(SEEK_FN + "(" + timesMs[i] + ")", true)
        .catch(() => 0);
      if (scripted) await new Promise((resolve) => setTimeout(resolve, SCRIPT_SETTLE_MS));
      let image = await win.webContents.capturePage();
      // A HiDPI display captures at its scale factor; frames must match the job.
      const got = image.getSize();
      if (size && (got.width !== size.width || got.height !== size.height)) image = image.resize(Object.assign({ quality: "best" }, size));
      const target = singlePath || path.join(outDir, pattern.replace("%05d", String(i + first).padStart(5, "0")));
      const write = fs.promises.writeFile(target, image.toPNG()).finally(() => writes.delete(write));
      writes.add(write);
      if (writes.size >= 4) await Promise.race(writes);
      written.push(target);
      // Progress for the parent's stall clock (spawnWorker in html-render.js).
      if (WORKER_MODE) process.stdout.write("\nFRAME\n");
    }
    await Promise.all(writes);
  } catch (error) {
    for (const write of writes) write.catch(() => {});
    throw error;
  }
  return written;
}

async function runJobInApp(app, BrowserWindow, job) {
  await app.whenReady();
  const size = { width: Math.max(2, Math.round(job.width)), height: Math.max(2, Math.round(job.height)) };
  const win = new BrowserWindow({
    show: false,
    frame: false,
    transparent: Boolean(job.transparent),
    backgroundColor: job.transparent ? "#00000000" : "#000000",
    skipTaskbar: true,
    width: size.width,
    height: size.height,
    webPreferences: {
      sandbox: true,
      partition: "jv-render-" + Date.now().toString(36) + Math.random().toString(36).slice(2),
      backgroundThrottling: false,
      webSecurity: false,
    },
  });
  try {
    // The constructor clamps a window to the screen's work area (a 1080x1920
    // card came out 1080x1152 on a 1200px tall display); a resize after
    // creation is not clamped, so the page lays out at the card's real size.
    win.setContentSize(size.width, size.height);
    // Frames must come from the document alone: no network, no other local
    // file. Regex cleaning upstream is the first line; this is the wall.
    try {
      const own = require("url").pathToFileURL(job.htmlPath).href;
      win.webContents.session.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, done) => {
        const url = String(details.url || "");
        const ok = url === own || /^(data|blob|about|devtools|chrome|chrome-extension):/i.test(url);
        done({ cancel: !ok });
      });
    } catch {
      /* blocking is best effort; the sanitizers still ran */
    }
    await win.loadFile(job.htmlPath);
    // A card's own @media (prefers-reduced-motion) or dark-scheme CSS must not
    // change what lands in the video: emulate a neutral page so the effect the
    // author wrote is the effect that renders. Best effort and bounded: a hung
    // debugger reply must not stall the render.
    try {
      win.webContents.debugger.attach("1.3");
      await Promise.race([
        win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", {
          features: [
            { name: "prefers-reduced-motion", value: "no-preference" },
            { name: "prefers-color-scheme", value: "light" },
          ],
        }),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
    } catch {
      /* media emulation is best effort */
    }
    // Let layout and web fonts settle before the first frame.
    await win.webContents
      .executeJavaScript("Promise.all([document.fonts ? document.fonts.ready : null]).then(function(){return true})", true)
      .catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 80));
    const times = (job.timesMs || [0]).map((v) => Math.max(0, Number(v) || 0));
    const written = await captureFrames(win, times, job.outDir, job.pattern || "frame-%05d.png", job.outPath || "", size, job.indexOffset);
    const pageErrors = await win.webContents
      .executeJavaScript("(Array.isArray(window.__jvErrors)?window.__jvErrors:[]).slice(0,10).map(String)", true)
      .catch(() => []);
    return { ok: true, frames: written, pageErrors: Array.isArray(pageErrors) ? pageErrors : [] };
  } finally {
    try {
      win.destroy();
    } catch {
      /* window is best effort */
    }
  }
}

// Standalone entry: electron html-render-worker.cjs --job <file>
async function main() {
  const { app, BrowserWindow } = require("electron");
  const argv = process.argv.slice(1);
  const idx = argv.indexOf("--job");
  const jobPath = idx >= 0 ? argv[idx + 1] : argv[argv.length - 1];
  const job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
  app.disableHardwareAcceleration();
  try {
    const result = await runJobInApp(app, BrowserWindow, job);
    process.stdout.write("\nRESULT:" + JSON.stringify(result) + "\n");
    app.exit(0);
  } catch (error) {
    process.stdout.write(
      "\nRESULT:" + JSON.stringify({ ok: false, error: error && error.message ? error.message : String(error) }) + "\n",
    );
    app.exit(1);
  }
}

// Spawned as `electron html-render-worker.cjs --job <file>`: the --job flag is
// the marker that this process is a worker (the in-app import path never has
// it, and Electron does not set require.main to the app entry file).
if (process.argv.includes("--job")) {
  main().catch((error) => {
    process.stdout.write("\nRESULT:" + JSON.stringify({ ok: false, error: String(error && error.message) }) + "\n");
    process.exit(1);
  });
}

module.exports = { runJobInApp };
