"use strict";

// Renders an edit card's real design with ffmpeg: background surface or image,
// image layers, the drawing layer, and every text block at its authored
// position. One graph builder feeds both the PNG export (renderCardPng) and
// video composition (compose-finished), so what the studio shows is what lands
// in the clip.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { randomUUID } = require("crypto");
const { getLibraryItem, libraryFilePath } = require("./library-io");
const { cardIsHtml, buildCardDocument, loadImageDataUris } = require("./html-card");

const TEXT_FIELDS = ["eyebrow", "headline", "body", "cta"];

// The studio authors blockLayout against these logical stage sizes.
const STAGE = {
  vertical: { w: 390, h: 693.3333 },
  landscape: { w: 1100, h: 618.75 },
  square: { w: 620, h: 620 },
};

// PNG/video renders come out at full resolution for the card's aspect.
const RENDER = {
  vertical: { w: 1080, h: 1920 },
  landscape: { w: 1920, h: 1080 },
  square: { w: 1080, h: 1080 },
};

const DEFAULT_COLORS = { primary: "#1F6F56", secondary: "#DFF56A", text: "#FFFFFF" };
const PLACEMENTS = ["auto", "intro", "overlay", "end"];

// Same fallback positions the studio canvas uses for a field with no layout.
const DEFAULT_LAYOUT = {
  headline: { x: 0.22, y: 0.38, width: 0.56, fontSize: 28 },
  body: { x: 0.22, y: 0.52, width: 0.56, fontSize: 16 },
  eyebrow: { x: 0.22, y: 0.26, width: 0.56, fontSize: 13 },
  cta: { x: 0.22, y: 0.66, width: 0.56, fontSize: 15 },
};

function aspectOf(card) {
  const value = card && card.composition && card.composition.aspectRatio;
  return value === "landscape" || value === "square" ? value : "vertical";
}

function stageSize(aspect) {
  return STAGE[aspect] || STAGE.vertical;
}

function renderSize(aspect) {
  return RENDER[aspect] || RENDER.vertical;
}

// Where the card lands on the timeline. "auto" falls back to the card's kind:
// overlay cards float on footage, everything else is a title card up front.
function cardPlacement(card) {
  const raw = card && card.placement;
  if (PLACEMENTS.includes(raw) && raw !== "auto") return raw;
  return card && card.kind === "overlay" ? "overlay" : "intro";
}

function cardDurationMs(card) {
  const n = Number(card && card.durationMs);
  if (!Number.isFinite(n)) return 3000;
  return Math.round(Math.min(60000, Math.max(500, n)));
}

function hexToRgb(hex) {
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ""));
  if (!match) return null;
  return [parseInt(match[1], 16), parseInt(match[2], 16), parseInt(match[3], 16)];
}

function rgbToHex(rgb) {
  return (
    "#" +
    rgb.map((ch) => Math.max(0, Math.min(255, Math.round(ch))).toString(16).padStart(2, "0")).join("").toUpperCase()
  );
}

function mixHex(a, b, t) {
  const ca = hexToRgb(a) || [0, 0, 0];
  const cb = hexToRgb(b) || [0, 0, 0];
  return rgbToHex(ca.map((v, i) => v + (cb[i] - v) * t));
}

// ffmpeg color literals: 0xRRGGBB with an optional @alpha suffix.
function ffColor(hex, alpha) {
  const rgb = hexToRgb(hex);
  const base = rgb ? "0x" + rgb.map((v) => v.toString(16).padStart(2, "0")).join("") : "0x000000";
  return alpha == null ? base : base + "@" + Number(alpha).toFixed(3);
}

function escapeDrawtext(value) {
  return String(value == null ? "" : value)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/:/g, "\\:")
    .replace(/%/g, "\\%")
    .replace(/\r?\n/g, "\n")
    .trim();
}

function plainText(value) {
  return String(value == null ? "" : value)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function fontfileEscape(file) {
  const unix = String(file || "").replace(/\\/g, "/");
  return "'" + unix.replace(/:/g, "\\:") + "'";
}

function findFfmpeg() {
  // Renamed variable first, old spelling second, for installs that set either.
  const forced = process.env.JEDITOR_FFMPEG || process.env.CUTLINE_FFMPEG;
  if (forced && fs.existsSync(forced)) {
    return forced;
  }
  const envPath = process.env.PATH || "";
  const parts = envPath.split(path.delimiter);
  const names = process.platform === "win32" ? ["ffmpeg.exe", "ffmpeg"] : ["ffmpeg"];
  for (const dir of parts) {
    for (const name of names) {
      const full = path.join(dir, name);
      if (dir && fs.existsSync(full)) return full;
    }
  }
  const extras = [
    path.join(
      os.homedir(),
      "AppData",
      "Local",
      "Microsoft",
      "WinGet",
      "Packages",
      "Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe",
      "ffmpeg-8.1.1-full_build",
      "bin",
      "ffmpeg.exe",
    ),
    "/usr/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
  ];
  for (const full of extras) {
    if (fs.existsSync(full)) return full;
  }
  return "";
}

function findFont() {
  const forced = process.env.JEDITOR_FONT || process.env.CUTLINE_FONT;
  if (forced && fs.existsSync(forced)) {
    return forced;
  }
  const extras = [
    "C:\\Windows\\Fonts\\segoeui.ttf",
    "C:\\Windows\\Fonts\\arial.ttf",
    "C:\\Windows\\Fonts\\segoeuib.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
  ];
  for (const full of extras) {
    if (fs.existsSync(full)) return full;
  }
  return "";
}

// Bold face for burned-in video titles and captions; falls back to the
// regular font.
function findBoldFont() {
  const extras = [
    "C:\\Windows\\Fonts\\segoeuib.ttf",
    "C:\\Windows\\Fonts\\arialbd.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
  ];
  return extras.find((full) => fs.existsSync(full)) || findFont();
}

// A render must never starve the UI. The child drops to below-normal priority
// and the encoder thread count is capped, so typing and the agent stay smooth
// while a long video encodes on a many-core machine.
function runFfmpegThreads() {
  const cores = (os.cpus() || []).length || 4;
  return Math.max(2, Math.min(8, cores - 2));
}

function withThreadCap(args) {
  if (!Array.isArray(args) || !args.length || args.includes("-threads")) return args;
  // Every caller ends its arg list with the output path; -threads is an output
  // option, so it has to land right before it.
  const out = args.slice();
  const dest = out.pop();
  out.push("-threads", String(runFfmpegThreads()), dest);
  return out;
}

function lowerPriority(child) {
  try {
    if (child.pid) os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    /* priority is best effort */
  }
}

function runFfmpeg(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, withThreadCap(args), {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    lowerPriority(child);
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 8000) stderr = stderr.slice(-4000);
    });
    let timedOut = false;
    // A killed ffmpeg still holds its output and inputs until it exits, so the
    // timeout rejects on close (5 s cap) and the caller's temp cleanup can
    // remove them.
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      setTimeout(() => reject(new Error("ffmpeg timed out.")), 5000).unref();
    }, timeoutMs || 120000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error("ffmpeg timed out."));
      else if (code === 0) resolve();
      else reject(new Error((stderr.split(/\r?\n/).filter(Boolean).pop() || "ffmpeg failed") + " (" + code + ")"));
    });
  });
}

// One render probes the same source more than once (timeline backfill, then
// render setup); results are reused while the file's path, size, and mtime
// hold. Failed or empty probes are not kept.
const PROBE_CACHE = new Map();
const PROBE_CACHE_MAX = 64;

function probeMedia(ffmpeg, src) {
  let key = "";
  try {
    const st = fs.statSync(src);
    key = path.resolve(String(src)) + "|" + st.size + "|" + st.mtimeMs;
  } catch {
    /* unreadable paths probe uncached */
  }
  const hit = key && PROBE_CACHE.get(key);
  if (hit) {
    PROBE_CACHE.delete(key);
    PROBE_CACHE.set(key, hit);
    return hit.then((media) => Object.assign({}, media));
  }
  const pending = probeMediaRaw(ffmpeg, src);
  if (!key) return pending;
  PROBE_CACHE.set(key, pending);
  if (PROBE_CACHE.size > PROBE_CACHE_MAX) PROBE_CACHE.delete(PROBE_CACHE.keys().next().value);
  pending.then((media) => {
    if (!media || !(media.durationMs || media.width)) PROBE_CACHE.delete(key);
  });
  return pending.then((media) => Object.assign({}, media));
}

// ffmpeg has no probe flag without ffprobe; `ffmpeg -i` still prints the stream
// table to stderr, which is enough for dimensions, duration, and audio.
function probeMediaRaw(ffmpeg, src) {
  return new Promise((resolve) => {
    const child = spawn(ffmpeg, ["-hide_banner", "-i", src], {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 40000) stderr = stderr.slice(-20000);
    });
    const timer = setTimeout(() => {
      child.kill();
      resolve({});
    }, 15000);
    const done = () => {
      clearTimeout(timer);
      const dims = /Video:[^\n]*? (\d{2,5})x(\d{2,5})/.exec(stderr);
      const duration = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
      const fps = /Video:[^\n]*? (\d+(?:\.\d+)?) fps/.exec(stderr);
      // Phone clips store landscape pixels plus a rotation; ffmpeg autorotates
      // on decode, so report the picture as it plays.
      const turned = /rotation of -?(90|270)\.00 degrees|rotate\s*:\s*-?(90|270)\b/.test(stderr);
      const w = dims ? Number(dims[1]) : 0;
      const h = dims ? Number(dims[2]) : 0;
      resolve({
        width: turned ? h : w,
        height: turned ? w : h,
        fps: fps ? Number(fps[1]) : 0,
        hasAudio: /Audio:/.test(stderr),
        durationMs: duration
          ? Math.round(
              (Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])) * 1000,
            )
          : 0,
      });
    };
    child.on("error", done);
    child.on("close", done);
  });
}

function surfaceBase(card, w, h) {
  const colors = Object.assign({}, DEFAULT_COLORS, (card && card.colors) || {});
  const surface = (card && card.composition && card.composition.surface) || "solid";
  if (surface === "soft") {
    const top = mixHex(colors.primary, "#FFFFFF", 0.91);
    const glow = mixHex(colors.secondary, "#FFFFFF", 0.76);
    // Linear gradient approximating the studio's soft surface wash.
    return "gradients=s=" + w + "x" + h + ":c0=" + ffColor(top) + ":c1=" + ffColor(glow) + ":type=linear:speed=0.01";
  }
  if (surface === "transparent") {
    return "color=c=" + ffColor("#0E1421", 0.55) + ":s=" + w + "x" + h + ":d=1";
  }
  const deep = mixHex(colors.primary, "#000000", 0.32);
  return "gradients=s=" + w + "x" + h + ":c0=" + ffColor(colors.primary) + ":c1=" + ffColor(deep) + ":type=linear:speed=0.01";
}

function textLines(value, maxChars) {
  const limit = Math.max(4, Math.floor(Number(maxChars) || 0));
  const out = [];
  for (const raw of plainText(value).split("\n")) {
    const words = raw.trim().split(/\s+/).filter(Boolean);
    let line = "";
    for (const word of words) {
      const next = line ? line + " " + word : word;
      if (limit && next.length > limit && line) {
        out.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    if (line) out.push(line);
    if (out.length >= 8) break;
  }
  return out.slice(0, 8);
}

// One drawtext per line so multiline copy keeps its block alignment. x uses a
// text_w expression for center/right alignment inside the block's width. Text
// drawn past the frame edge is clipped by the frame here exactly as it is in
// the PNG, so the burn never crops a card the person already saw; keeping copy
// inside the safe margin stays a design rule for the skills.
function drawtextFilters(card, dims, opts) {
  const options = opts || {};
  const font = options.font || "";
  const colors = Object.assign({}, DEFAULT_COLORS, card.colors || {});
  const composition = card.composition || {};
  const stage = stageSize(aspectOf(card));
  const scale = Math.min(dims.w / stage.w, dims.h / stage.h);
  const offsetX = (dims.w - stage.w * scale) / 2;
  const offsetY = (dims.h - stage.h * scale) / 2;
  const filters = [];
  const fields = options.fields || TEXT_FIELDS;
  for (const field of fields) {
    const layout = Object.assign(
      { x: 0, y: 0, width: 0.5, fontSize: 22 },
      DEFAULT_LAYOUT[field],
      composition.blockLayout && composition.blockLayout[field],
    );
    const fontSize = Math.max(8, Math.round((layout.fontSize || 22) * scale));
    const lineHeight = Math.round(fontSize * 1.2);
    const px = Math.round(offsetX + (layout.x || 0) * stage.w * scale);
    const py = Math.round(offsetY + (layout.y || 0) * stage.h * scale);
    const bw = Math.max(1, Math.round((layout.width || 0.5) * stage.w * scale));
    const lines = textLines(composition[field], bw / (fontSize * 0.52));
    if (!lines.length) continue;
    const align = layout.align || composition.align || "left";
    const color = ffColor(layout.color || colors.text);
    const fontArg = font ? "fontfile=" + fontfileEscape(font) + ":" : "";
    const bold = layout.bold !== false;
    const border = bold ? ":borderw=" + Math.max(1, Math.round(fontSize * 0.03)) + ":bordercolor=" + color : "";
    const box =
      layout.highlight && layout.highlight !== "transparent"
        ? ":box=1:boxcolor=" + ffColor(layout.highlight, 0.85) + ":boxborderw=" + Math.round(fontSize * 0.35)
        : "";
    const gate = options.gate || "";
    lines.forEach((line, index) => {
      let x = String(px);
      if (align === "center") x = px + "+(" + bw + "-text_w)/2";
      else if (align === "right") x = px + "+" + bw + "-text_w";
      const textAlign = align === "center" ? "C" : align === "right" ? "R" : "L";
      filters.push(
        "drawtext=" +
          fontArg +
          "text='" +
          escapeDrawtext(line) +
          "':x=" +
          x +
          ":y=" +
          (py + index * lineHeight) +
          ":fontsize=" +
          fontSize +
          ":fontcolor=" +
          color +
          ":text_align=" +
          textAlign +
          border +
          box +
          gate,
      );
    });
  }
  return filters;
}

function gateClause(context) {
  if (context && context.window) {
    return (
      ":enable='between(t," +
      Number(context.window.start).toFixed(2) +
      "," +
      Number(context.window.end).toFixed(2) +
      ")'"
    );
  }
  if (context && context.holdSecs != null) {
    return ":enable='lte(t," + Number(context.holdSecs).toFixed(2) + ")'";
  }
  return "";
}

// Build the inputs + filter_complex that draw the card design on top of a base
// stream. ctx.videoFile turns input 0 into the footage itself; otherwise input
// 0 is a background image or a lavfi surface. With ctx.noBase the caller's
// chain supplies the base: filters start from [ctx.baseLabel] and ctx.inputs
// is the shared input array (overlay input indices stay correct). Returns
// { inputs, filters, out }  -  lavfi inputs take "-f lavfi -i", files "-i".
function buildCardGraph(card, dims, ctx) {
  const context = ctx || {};
  const inputs = context.inputs || [];
  const filters = [];
  const composition = card.composition || {};
  // Without a font file, drawtext falls back to ffmpeg's own default, which is
  // not on this build and fails as "Fontconfig error" from inside the child.
  // Say what is wrong, and what to do, before spawning anything.
  if (!context.font && TEXT_FIELDS.some((field) => plainText(composition[field]))) {
    throw new Error("No font file found for card text. Install Segoe UI, or set JEDITOR_FONT to a .ttf file.");
  }
  const stage = stageSize(aspectOf(card));
  const scale = Math.min(dims.w / stage.w, dims.h / stage.h);
  const offsetX = Math.round((dims.w - stage.w * scale) / 2);
  const offsetY = Math.round((dims.h - stage.h * scale) / 2);
  const alpha = context.videoBase ? "yuv420p" : "rgba";
  const gate = gateClause(context);

  // Input 0: the base  -  the footage itself for overlays, else a covering
  // background image, else a lavfi source painting the card surface.
  let current;
  if (context.noBase) {
    current = context.baseLabel || "pipe";
  } else if (context.videoFile) {
    inputs.push({ file: context.videoFile });
    filters.push("[0:v]format=" + alpha + ",setsar=1[bg]");
    current = "bg";
  } else if (context.backgroundFile) {
    inputs.push({ file: context.backgroundFile, loop: true });
    filters.push("[0:v]scale=" + dims.w + ":" + dims.h + ":force_original_aspect_ratio=increase,crop=" + dims.w + ":" + dims.h + ",setsar=1,format=" + alpha + "[bg]");
    current = "bg";
  } else {
    inputs.push({ lavfi: context.base || surfaceBase(card, dims.w, dims.h) });
    filters.push("[0:v]format=" + alpha + ",setsar=1[bg]");
    current = "bg";
  }

  let step = 0;
  const labelPrefix = context.labelPrefix || "";
  const link = () => {
    const label = labelPrefix + "ly" + step;
    step += 1;
    return label;
  };

  const overlayInput = (file, rect, fitCover) => {
    inputs.push({ file, loop: true });
    const idx = inputs.length - 1;
    const out = link();
    const w = Math.max(2, Math.round(rect.w));
    const h = Math.max(2, Math.round(rect.h));
    const fit = fitCover === "stretch" ? "disable" : fitCover === false ? "decrease" : "increase";
    filters.push(
      "[" +
        idx +
        ":v]scale=" +
        w +
        ":" +
        h +
        ":force_original_aspect_ratio=" +
        fit +
        (fitCover === true ? ",crop=" + w + ":" + h : "") +
        ",setsar=1[ov" +
        idx +
        "]",
    );
    filters.push(
      "[" + current + "][ov" + idx + "]overlay=" + Math.round(rect.x) + ":" + Math.round(rect.y) + gate + "[" + out + "]",
    );
    current = out;
  };

  // Image layers sit at their authored rects on the stage.
  for (const layer of context.images || []) {
    const rect = {
      x: offsetX + layer.x * stage.w * scale,
      y: offsetY + layer.y * stage.h * scale,
      w: layer.width * stage.w * scale,
      h: layer.height * stage.h * scale,
    };
    overlayInput(layer.file, rect, true);
  }

  // The drawing layer is a transparent PNG authored on the stage rect.
  if (context.drawingFile) {
    overlayInput(
      context.drawingFile,
      { x: offsetX, y: offsetY, w: stage.w * scale, h: stage.h * scale },
      "stretch",
    );
  }

  const text = drawtextFilters(card, dims, { font: context.font, gate });
  if (text.length) {
    const out = link();
    filters.push("[" + current + "]" + text.join(",") + "[" + out + "]");
    current = out;
  } else {
    const out = link();
    filters.push("[" + current + "]null[" + out + "]");
    current = out;
  }
  return { inputs, filters, out: current };
}

async function resolveCardMedia(card, ctx) {
  const context = ctx;
  const composition = (card && card.composition) || {};
  const seen = new Set();
  const images = [];
  for (const id of card.imageIds || []) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const item = await getLibraryItem(ctx.dataRoot, id, ctx.workspaceId);
    if (!item || item.kind !== "image") continue;
    const file = libraryFilePath(ctx.dataRoot, ctx.workspaceId, item);
    if (!fs.existsSync(file)) continue;
    const layout = (composition.imageLayouts && composition.imageLayouts[id]) || { x: 0.05, y: 0.1, width: 0.4, height: 0.4 };
    images.push({ id, file, x: layout.x || 0, y: layout.y || 0, width: layout.width || 0.4, height: layout.height || 0.4 });
  }
  context.images = images;
  const bgId = composition.backgroundId;
  if (bgId && !context.backgroundFile) {
    const item = await getLibraryItem(ctx.dataRoot, bgId, ctx.workspaceId);
    if (item && item.kind === "image") {
      const file = libraryFilePath(ctx.dataRoot, ctx.workspaceId, item);
      if (fs.existsSync(file)) context.backgroundFile = file;
    }
  }
  if (!context.drawingFile && typeof card.drawing === "string" && card.drawing.startsWith("data:image/")) {
    const tmp = path.join(os.tmpdir(), "cutline-card-ink-" + randomUUID() + ".png");
    fs.writeFileSync(tmp, Buffer.from(card.drawing.replace(/^data:image\/[^;]+;base64,/, ""), "base64"));
    context.drawingFile = tmp;
    context.drawingTemp = tmp;
  }
  return context;
}

function ffmpegInputArgs(inputs) {
  const args = [];
  for (const input of inputs) {
    if (input.lavfi) args.push("-f", "lavfi", "-i", input.lavfi);
    else args.push("-loop", "1", "-framerate", "30", "-i", input.file);
  }
  return args;
}

// Resolves the {{image:id}} tokens an HTML card references to data URIs, so
// the rendered document stays fully self-contained for previews and exports.
async function htmlCardDataUris(card, dataRoot, workspaceId) {
  return loadImageDataUris(card, async (id) => {
    const item = await getLibraryItem(dataRoot, id, workspaceId);
    if (!item || item.kind !== "image") return "";
    return libraryFilePath(dataRoot, workspaceId, item);
  });
}

// Rasterize a card to PNG. HTML/CSS cards go through the browser renderer;
// everything else uses the ffmpeg design graph. opts.dims overrides the
// output size (overlay burning renders at the video's frame), and
// opts.transparent keeps the alpha channel for overlay use.
async function renderCardPng(options) {
  const opts = options || {};
  const card = opts.card;
  if (!card) throw new Error("card is required");
  const aspect = aspectOf(card);
  const dims = opts.dims || renderSize(aspect);
  if (cardIsHtml(card)) {
    const imageDataUris = await htmlCardDataUris(card, opts.dataRoot, opts.workspaceId);
    const doc = buildCardDocument(card, { imageDataUris, transparent: opts.transparent === true });
    const { renderHtmlPng } = require("./html-render");
    const outPath = opts.outPath || path.join(os.tmpdir(), "cutline-card-" + (card.id || "card") + "-" + randomUUID() + ".png");
    const rendered = await renderHtmlPng({
      doc,
      width: dims.w,
      height: dims.h,
      transparent: opts.transparent === true,
      outPath,
      atMs: opts.atMs,
      appRoot: opts.appRoot,
      tempRoot: opts.tempRoot,
    });
    return { path: rendered.path, width: dims.w, height: dims.h };
  }
  const ffmpeg = opts.ffmpeg || findFfmpeg();
  if (!ffmpeg) throw new Error("ffmpeg is not installed.");
  const ctx = await resolveCardMedia(card, {
    dataRoot: opts.dataRoot,
    workspaceId: opts.workspaceId,
    font: opts.font !== undefined ? opts.font : findFont(),
  });
  const graph = buildCardGraph(card, dims, ctx);
  const outPath = opts.outPath || path.join(os.tmpdir(), "cutline-card-" + (card.id || "card") + "-" + randomUUID() + ".png");
  const args = ["-y"]
    .concat(ffmpegInputArgs(graph.inputs))
    .concat(["-filter_complex", graph.filters.join(";"), "-map", "[" + graph.out + "]", "-frames:v", "1", "-pix_fmt", "rgba", outPath]);
  try {
    await runFfmpeg(ffmpeg, args);
  } finally {
    if (ctx.drawingTemp) fs.promises.unlink(ctx.drawingTemp).catch(() => {});
  }
  if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 16) {
    throw new Error("ffmpeg did not render the card.");
  }
  return { path: outPath, width: dims.w, height: dims.h };
}

// Rasterize a card's design onto a fully transparent frame at an arbitrary
// size. Compose uses this for overlay cards with motion (and for every HTML
// overlay), so the whole card animates as one layer over the footage. For
// non-HTML cards it is the same element drawing as renderCardPng, minus the
// opaque surface.
async function renderCardOverlayPng(options) {
  const opts = options || {};
  const card = opts.card;
  if (!card) throw new Error("card is required");
  const dims = opts.dims;
  if (!dims || !dims.w || !dims.h) throw new Error("dims {w,h} are required.");
  if (cardIsHtml(card)) {
    const imageDataUris = await htmlCardDataUris(card, opts.dataRoot, opts.workspaceId);
    const doc = buildCardDocument(card, { imageDataUris, transparent: true });
    const { renderHtmlPng } = require("./html-render");
    const outPath = opts.outPath || path.join(os.tmpdir(), "cutline-overlay-" + (card.id || "card") + "-" + randomUUID() + ".png");
    const rendered = await renderHtmlPng({
      doc,
      width: dims.w,
      height: dims.h,
      transparent: true,
      outPath,
      atMs: opts.atMs,
      appRoot: opts.appRoot,
      tempRoot: opts.tempRoot,
    });
    return { path: rendered.path, width: dims.w, height: dims.h };
  }
  const ffmpeg = opts.ffmpeg || findFfmpeg();
  if (!ffmpeg) throw new Error("ffmpeg is not installed.");
  const ctx = await resolveCardMedia(card, {
    dataRoot: opts.dataRoot,
    workspaceId: opts.workspaceId,
    font: opts.font !== undefined ? opts.font : findFont(),
  });
  ctx.base = "color=c=black@0:s=" + dims.w + "x" + dims.h + ":d=1";
  const graph = buildCardGraph(card, dims, ctx);
  const outPath = opts.outPath || path.join(os.tmpdir(), "cutline-overlay-" + (card.id || "card") + "-" + randomUUID() + ".png");
  const args = ["-y"]
    .concat(ffmpegInputArgs(graph.inputs))
    .concat(["-filter_complex", graph.filters.join(";"), "-map", "[" + graph.out + "]", "-frames:v", "1", "-pix_fmt", "rgba", outPath]);
  try {
    await runFfmpeg(ffmpeg, args);
  } finally {
    if (ctx.drawingTemp) fs.promises.unlink(ctx.drawingTemp).catch(() => {});
  }
  if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 16) {
    throw new Error("ffmpeg did not render the overlay card.");
  }
  return { path: outPath, width: dims.w, height: dims.h };
}

module.exports = {
  TEXT_FIELDS,
  STAGE,
  RENDER,
  PLACEMENTS,
  aspectOf,
  stageSize,
  renderSize,
  cardPlacement,
  cardDurationMs,
  mixHex,
  ffColor,
  escapeDrawtext,
  plainText,
  fontfileEscape,
  findFfmpeg,
  findFont,
  findBoldFont,
  runFfmpeg,
  withThreadCap,
  probeMedia,
  surfaceBase,
  drawtextFilters,
  buildCardGraph,
  resolveCardMedia,
  renderCardPng,
  renderCardOverlayPng,
  htmlCardDataUris,
};
