"use strict";

// The design gallery: ready-made animations a person can make without
// writing a prompt. Thumbnails are real frames of each preset (rendered once
// per ratio and preset version, then kept under <data>/preset-thumbs), and
// "Make it" renders the preset straight into a project with the same code an
// agent would use, so the result is ordinary footage the agent can keep
// editing.

const { ipcMain, nativeImage } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

// The moment each preset looks finished, as a share of its length.
const POSE_AT = {
  "lower-third": 0.55,
  "typewriter-quote": 0.95,
  "word-slam": 0.97,
  "logo-sting": 0.8,
};

const RATIOS = new Set(["16/9", "9/16", "1/1", "4/5"]);
const THUMB_COLORS = { primary: "#111a33", secondary: "#ffb454", text: "#ffffff" };
// Gallery stills render small (the presets size everything in vmin, so a
// small page is the same picture): far less work than a 1080p frame.
const SMALL = { "16/9": [640, 360], "9/16": [360, 640], "1/1": [480, 480], "4/5": [432, 540] };

function cleanColors(input) {
  const colors = {};
  for (const key of ["primary", "secondary", "text"]) {
    const v = input && input[key];
    if (typeof v === "string" && /^#[0-9a-f]{3,8}$/i.test(v)) colors[key] = v;
  }
  return colors;
}

function attachPresetsIpc(host) {
  const dataRoot = host.dataRoot;
  const appRoot = host.appRoot;
  let thumbsRun = null;
  // Dialog previews: one render at a time, and a request that a newer one
  // replaced while it waited is skipped instead of rendered.
  let stillRun = Promise.resolve();
  let stillLatest = 0;
  // Play has its own queue, so pressing it never cancels the still.
  let motionRun = Promise.resolve();
  let motionLatest = 0;

  ipcMain.handle("animation-presets", () => require("../lib/animation-presets").listPresets());

  // One small frame of a preset as PNG bytes.
  async function stillOf(name, params, colors, ratio, atMs, big, extra) {
    const { animationFrames } = require("../lib/animation-render");
    const [width, height] = SMALL[ratio] || SMALL["16/9"];
    const more = extra || {};
    const shot = await animationFrames({ dataRoot: dataRoot(), appRoot, preset: name, presetParams: params, css: more.css || undefined, js: more.js || undefined, aspectRatio: ratio, colors, width, height, timesMs: [atMs] });
    const file = shot.files && shot.files[0] && shot.files[0].path;
    if (!file) return null;
    try {
      const img = nativeImage.createFromPath(file);
      const size = img.getSize();
      const width = big ? (size.width >= size.height ? 640 : 360) : size.width >= size.height ? 360 : 220;
      return (size.width > width ? img.resize({ width, quality: "good" }) : img).toPNG();
    } finally {
      await fsp.unlink(file).catch(() => {});
    }
  }

  async function thumbsFor(ratio) {
    const { listPresets, buildPreset } = require("../lib/animation-presets");
    const dir = path.join(dataRoot(), "preset-thumbs");
    await fsp.mkdir(dir, { recursive: true });
    const out = {};
    const { SCRIPT_RUNTIME } = require("../lib/animation-render");
    const { MOTION_RUNTIME } = require("../lib/animation-motion");
    const runtimeKey = "small1" + crypto.createHash("sha1").update(SCRIPT_RUNTIME + MOTION_RUNTIME).digest("hex");
    const one = async (preset) => {
      const code = buildPreset(preset.name, {});
      // The file name carries a hash of the code, so a changed preset gets a
      // fresh thumbnail and the old one is never shown for it.
      // The runtimes are in the hash too, so a fix to the clock or the
      // motion kit redraws every thumbnail.
      const hash = crypto.createHash("sha1").update(runtimeKey + code.html + code.css + code.js + ratio).digest("hex").slice(0, 12);
      const prefix = preset.name + "-" + ratio.replace("/", "x") + "-";
      const file = path.join(dir, prefix + hash + ".png");
      if (!fs.existsSync(file)) {
        try {
          const at = Math.round(preset.durationMs * (POSE_AT[preset.name] || 0.75));
          const still = await stillOf(preset.name, {}, THUMB_COLORS, ratio, at);
          if (still) {
            await fsp.writeFile(file, still);
            // Older thumbnails of the same design and frame are never shown again.
            for (const name of await fsp.readdir(dir).catch(() => [])) {
              if (name.startsWith(prefix) && name !== path.basename(file)) await fsp.unlink(path.join(dir, name)).catch(() => {});
            }
          }
        } catch {
          /* a thumbnail that fails to render leaves a plain tile */
        }
      }
      // An empty value tells the page this one failed, so it draws a plain
      // tile instead of waiting on it forever.
      out[preset.name] = fs.existsSync(file) ? "data:image/png;base64," + (await fsp.readFile(file)).toString("base64") : "";
    };
    // Three hidden render workers at a time: a cold start is one wait, not eight.
    const queue = listPresets().slice();
    await Promise.all([0, 1, 2].map(async () => {
      while (queue.length) await one(queue.shift());
    }));
    // Thumbnails of designs that no longer exist go too.
    // Matched on name and frame, so a removed "stat-counter" is not kept
    // alive by a "stat" that still exists.
    const prefixes = [];
    for (const p of listPresets()) for (const r of RATIOS) prefixes.push(p.name + "-" + r.replace("/", "x") + "-");
    for (const name of await fsp.readdir(dir).catch(() => [])) {
      if (name.endsWith(".png") && !prefixes.some((prefix) => name.startsWith(prefix))) await fsp.unlink(path.join(dir, name)).catch(() => {});
    }
    return out;
  }

  // A live preview for the design dialog: the person's own words, colors,
  // and frame, at the moment the design looks finished.
  ipcMain.handle("animation-preset-still", async (_event, payload) => {
    const body = payload || {};
    const { listPresets } = require("../lib/animation-presets");
    const preset = listPresets().find((p) => p.name === body.preset);
    if (!preset) throw new Error("Unknown design.");
    const ratio = RATIOS.has(body.aspectRatio) ? body.aspectRatio : "16/9";
    const at = Math.round(preset.durationMs * (POSE_AT[preset.name] || 0.75));
    const mine = ++stillLatest;
    const run = stillRun.catch(() => {}).then(async () => {
      if (mine !== stillLatest) return null;
      const extra = { css: typeof body.css === "string" ? body.css : "", js: typeof body.js === "string" ? body.js : "" };
      return stillOf(preset.name, body.params || {}, cleanColors(body.colors), ratio, at, true, extra);
    });
    stillRun = run;
    const png = await run;
    return png ? "data:image/png;base64," + png.toString("base64") : "";
  });

  // Motion for the dialog's Play button: about 12 frames a second across the
  // whole design, small and as JPEG, so the person sees the timing and the
  // entrance before a full render. Shares the still queue (one at a time).
  ipcMain.handle("animation-preset-motion", async (_event, payload) => {
    const body = payload || {};
    const { listPresets } = require("../lib/animation-presets");
    const { animationFrames } = require("../lib/animation-render");
    const preset = listPresets().find((p) => p.name === body.preset);
    if (!preset) throw new Error("Unknown design.");
    const ratio = RATIOS.has(body.aspectRatio) ? body.aspectRatio : "16/9";
    const length = Math.min(20000, Number(body.extras && body.extras.durationMs) || preset.durationMs);
    // 12 frames a second, thinned for long designs so the strip stays at 120
    // frames and still covers the whole length.
    const step = Math.max(1000 / 12, length / 120);
    const times = [];
    for (let t = 0; t < length; t += step) times.push(Math.round(t));
    const mine = ++motionLatest;
    const run = motionRun.catch(() => {}).then(async () => {
      if (mine !== motionLatest) return null;
      const [width, height] = SMALL[ratio] || SMALL["16/9"];
      let files = [];
      try {
        // One worker job for the whole strip (the renderer shards it).
        const shot = await animationFrames({
          dataRoot: dataRoot(),
          appRoot,
          preset: preset.name,
          presetParams: body.params || {},
          durationMs: length,
          css: typeof body.css === "string" && body.css ? body.css : undefined,
          js: typeof body.js === "string" && body.js ? body.js : undefined,
          colors: cleanColors(body.colors),
          aspectRatio: ratio,
          width,
          height,
          timesMs: times,
          maxFrames: times.length,
        });
        files = (shot.files || []).map((f) => f.path);
        if (mine !== motionLatest) return null;
        return files.map((file) => "data:image/jpeg;base64," + nativeImage.createFromPath(file).toJPEG(78).toString("base64"));
      } finally {
        // Frames never outlive the call, whatever happened.
        await Promise.all(files.map((file) => fsp.unlink(file).catch(() => {})));
      }
    });
    motionRun = run;
    const frames = await run;
    return frames ? { frames, intervalMs: Math.round(step) } : null;
  });

  ipcMain.handle("animation-preset-thumbs", async (_event, payload) => {
    const ratio = RATIOS.has(payload && payload.ratio) ? payload.ratio : "16/9";
    // One run at a time: Home can ask again while the first set renders.
    const prev = thumbsRun || Promise.resolve();
    const run = prev.catch(() => {}).then(() => thumbsFor(ratio));
    thumbsRun = run;
    try {
      return await run;
    } finally {
      if (thumbsRun === run) thumbsRun = null;
    }
  });

  // Renders the preset into the project and bakes the project, so the
  // finished video shows in the preview and can be exported right away.
  ipcMain.handle("animation-preset-render", async (_event, payload) => {
    const body = payload || {};
    const { buildPreset } = require("../lib/animation-presets");
    buildPreset(body.preset, body.params); // unknown names fail here, with the list
    const { renderAnimation } = require("../lib/animation-render");
    const { registerClipAsRender } = require("../lib/video-render");
    const colors = cleanColors(body.colors);
    // An edited design keeps the code an agent layered on top of it.
    const extraCss = typeof body.css === "string" ? body.css.slice(0, 200000) : "";
    const extraJs = typeof body.js === "string" ? body.js.slice(0, 200000) : "";
    const extras = require("../lib/project-design").pickExtras(body.extras);
    const made = await renderAnimation({
      dataRoot: dataRoot(),
      appRoot,
      preset: body.preset,
      presetParams: body.params || {},
      css: extraCss || undefined,
      js: extraJs || undefined,
      ...extras,
      colors,
      aspectRatio: RATIOS.has(body.aspectRatio) ? body.aspectRatio : "16/9",
      projectId: body.projectId,
      workspaceId: body.workspaceId,
      name: String(body.name || "").slice(0, 80) || undefined,
    });
    // The animation is already the finished cut, so it becomes the project's
    // render as is: no second encode, and Export works straight away.
    let finished = null;
    // Cuts or captions on the old design clip move to the new one, and only a
    // project render bakes them in, so the bare clip is not the finished cut.
    const designMod = require("../lib/project-design");
    const before = body.projectId ? require("../lib/ai-projects").getProject(dataRoot(), body.projectId) : null;
    const oldDesign = before && before.state && before.state.design;
    const needsRender = Boolean(oldDesign && oldDesign.assetId && designMod.clipHasEdits(before, oldDesign.assetId));
    if (body.projectId && made.item && made.path && !needsRender) {
      finished = await registerClipAsRender(dataRoot(), {
        projectId: body.projectId,
        sourceId: made.item.id,
        file: made.path,
        name: made.item.name,
        width: made.width,
        height: made.height,
        durationMs: made.durationMs,
        posterMs: Math.round((made.durationMs || 0) * (POSE_AT[body.preset] || 0.75)),
      });
    }
    // The project remembers the design it came from, so the editor can
    // reopen the same form and update the video without a prompt. An update
    // swaps the old clip out of the project (it stays in the library).
    if (body.projectId && made.item) {
      await require("../lib/project-design").adoptDesign(dataRoot(), body.projectId, {
        preset: body.preset,
        params: body.params || {},
        colors,
        aspectRatio: body.aspectRatio,
        css: extraCss,
        js: extraJs,
        extras,
        assetId: made.item.id,
      });
    }
    return { itemId: made.item && made.item.id, finishedId: finished && finished.id, render: Boolean(finished), needsRender, durationMs: made.durationMs, scriptErrors: made.scriptErrors || [] };
  });
}

module.exports = { attachPresetsIpc };
