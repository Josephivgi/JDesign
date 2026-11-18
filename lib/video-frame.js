"use strict";

// The look of a project's clip: how the source picture sits in the project's
// frame (ratio, fit or fill, focus point), camera moves (punch-in, push-in,
// pan), on-screen text, flashes, and fades. Everything is keyed to source
// time, like the cut segments, so a later cut never shifts a zoom or a
// caption off the moment it belongs to.
//
// Storage on the project state:
//   videoEdits[clipId].frame   { fit: "fit"|"fill", x, y, background: "blur"|"black" }
//   videoEdits[clipId].camera  [{ startMs, endMs, zoom, x, y, style, fromZoom?, fromX?, fromY? }]
//   videoEdits[clipId].flashes [ms, ...]
//   videoEdits[clipId].fades   { inMs, outMs }
//   studio.texts               [{ id, kind, text, x, y, startMs, durationMs, anim }]
//   project.aspectRatio        "9/16", "16/9", "1/1", "4/5"
//
// renderer/js/video-frame.js mirrors the geometry for the live preview, so
// the stage and the render frame the same picture.

const ZOOM_MIN = 1;
const ZOOM_MAX = 4;
const MAX_CAMERA = 80;
const MAX_TEXTS = 80;
const MAX_FLASHES = 40;
const TEXT_MAX_CHARS = 140;
const CAMERA_STYLES = ["punch", "push", "pan"];
const TEXT_STYLES = ["hook", "caption", "bubbly", "title"];
const TEXT_ANIMS = ["slide", "fade", "none"];
// Same set the project store accepts (ai-projects-store.js).
const RATIOS = ["16/9", "9/16", "1/1", "4/5"];

// Text centers stay inside these margins (fractions of the frame) so a
// caption never runs off the edge or under a phone app's buttons.
const SAFE = { left: 0.06, right: 0.06, top: 0.08, bottom: 0.12 };

const TEXT_POSITIONS = {
  top: 0.16,
  upper: 0.3,
  center: 0.5,
  middle: 0.5,
  lower: 0.68,
  bottom: 0.8,
};

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

function clamp01(value, fallback) {
  const n = num(value);
  return n == null ? (fallback == null ? 0.5 : fallback) : clamp(n, 0, 1);
}

function ms(input, short, long) {
  const msVal = num(input && input[long]);
  if (msVal != null) return Math.round(msVal);
  const sVal = num(input && input[short]);
  return sVal == null ? null : Math.round(sVal * 1000);
}

function parseRatio(value) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*[/:x]\s*(\d+(?:\.\d+)?)\s*$/i.exec(String(value || ""));
  if (!m) return { w: 16, h: 9 };
  const w = Number(m[1]);
  const h = Number(m[2]);
  return w > 0 && h > 0 ? { w, h } : { w: 16, h: 9 };
}

function normalizeRatio(value) {
  const r = parseRatio(value);
  return r.w + "/" + r.h;
}

function even(n) {
  return Math.max(2, Math.round(n / 2) * 2);
}

// Short side 1080, so a 9/16 project renders 1080x1920 and 16/9 1920x1080.
function outputSize(ratio) {
  const r = parseRatio(ratio);
  if (r.w >= r.h) return { w: even(Math.min(3840, (1080 * r.w) / r.h)), h: 1080 };
  return { w: 1080, h: even(Math.min(3840, (1080 * r.h) / r.w)) };
}

function normalizeFrame(frame) {
  const f = frame && typeof frame === "object" ? frame : {};
  return {
    fit: f.fit === "fill" ? "fill" : "fit",
    x: clamp01(f.x),
    y: clamp01(f.y),
    background: f.background === "black" ? "black" : "blur",
  };
}

function clampZoom(value, fallback) {
  const n = num(value);
  if (n == null) return fallback;
  return clamp(n, ZOOM_MIN, ZOOM_MAX);
}

function cleanMove(move, durationMs) {
  const m = move && typeof move === "object" ? move : {};
  const cap = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : Infinity;
  const start = num(m.startMs);
  const end = num(m.endMs);
  if (start == null || end == null) return null;
  const a = clamp(Math.round(start), 0, cap);
  const b = clamp(Math.round(end), 0, cap);
  if (b - a < 40) return null;
  const style = CAMERA_STYLES.includes(m.style) ? m.style : "punch";
  const out = { startMs: a, endMs: b, zoom: clampZoom(m.zoom, 1.5), x: clamp01(m.x), y: clamp01(m.y), style };
  if (style !== "punch") {
    const fz = clampZoom(m.fromZoom, null);
    if (fz != null) out.fromZoom = fz;
    if (num(m.fromX) != null) out.fromX = clamp01(m.fromX);
    if (num(m.fromY) != null) out.fromY = clamp01(m.fromY);
  }
  return out;
}

// Sorted, inside the clip, no overlaps: where two moves overlap the one that
// starts first keeps its range up to where the next begins.
function normalizeCamera(list, durationMs) {
  const moves = (Array.isArray(list) ? list : [])
    .map((m) => cleanMove(m, durationMs))
    .filter(Boolean)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const out = [];
  for (const move of moves) {
    const last = out[out.length - 1];
    if (last && move.startMs < last.endMs) {
      if (move.endMs <= last.endMs) continue;
      move.startMs = last.endMs;
      if (move.endMs - move.startMs < 40) continue;
    }
    out.push(move);
  }
  return out.slice(0, MAX_CAMERA);
}

function smoothstep(p) {
  const t = clamp(p, 0, 1);
  return t * t * (3 - 2 * t);
}

// The part of the source (in source pixels) the output frame shows. Fill
// crops to cover the frame; fit shows the whole picture with bars, so its
// window can extend past the source edges. Zoom shrinks the window around
// the focus point, and the window never slides off the picture on an axis
// where it is smaller than the source.
function viewRect(src, out, fit, zoom, fx, fy) {
  const sw = Math.max(1, Number(src && src.w) || 1);
  const sh = Math.max(1, Number(src && src.h) || 1);
  const outAspect = Math.max(0.01, (Number(out && out.w) || 16) / (Number(out && out.h) || 9));
  const srcAspect = sw / sh;
  let w;
  let h;
  const cover = fit === "fill";
  if ((srcAspect > outAspect) === cover) {
    h = sh;
    w = h * outAspect;
  } else {
    w = sw;
    h = w / outAspect;
  }
  const z = clamp(Number(zoom) || 1, ZOOM_MIN, ZOOM_MAX);
  w /= z;
  h /= z;
  const cx = clamp01(fx) * sw;
  const cy = clamp01(fy) * sh;
  const x = w <= sw ? clamp(cx - w / 2, 0, sw - w) : (sw - w) / 2;
  const y = h <= sh ? clamp(cy - h / 2, 0, sh - h) : (sh - h) / 2;
  return { x, y, w, h };
}

function rectInside(rect, src) {
  const eps = 0.5;
  return rect.x >= -eps && rect.y >= -eps && rect.x + rect.w <= src.w + eps && rect.y + rect.h <= src.h + eps;
}

// Source range -> finished-video ranges through the kept segments. A text or
// flash inside a cut gap simply has no output range.
function sourceToOutputRanges(segments, startMs, endMs) {
  const out = [];
  let cursor = 0;
  for (const seg of Array.isArray(segments) ? segments : []) {
    const rate = Number(seg.speed) || 1;
    const a = Math.max(seg.startMs, startMs);
    const b = Math.min(seg.endMs, endMs);
    if (b > a) {
      const oa = cursor + (a - seg.startMs) / rate;
      const ob = cursor + (b - seg.startMs) / rate;
      const last = out[out.length - 1];
      if (last && Math.abs(last.endMs - oa) < 1) last.endMs = ob;
      else out.push({ startMs: oa, endMs: ob });
    }
    cursor += (seg.endMs - seg.startMs) / rate;
  }
  return out.map((r) => ({ startMs: Math.round(r.startMs), endMs: Math.round(r.endMs) }));
}

function sourceToOutputMs(segments, atMs) {
  let cursor = 0;
  for (const seg of Array.isArray(segments) ? segments : []) {
    const rate = Number(seg.speed) || 1;
    if (atMs >= seg.startMs && atMs < seg.endMs) return Math.round(cursor + (atMs - seg.startMs) / rate);
    cursor += (seg.endMs - seg.startMs) / rate;
  }
  return null;
}

// Finished-video time -> source time, for agents that think in "the caption
// at 0:20 of the TikTok". Past the end clamps to the last kept frame.
function outputToSourceMs(segments, outMs) {
  let cursor = 0;
  const list = Array.isArray(segments) ? segments : [];
  for (const seg of list) {
    const rate = Number(seg.speed) || 1;
    const len = (seg.endMs - seg.startMs) / rate;
    if (outMs < cursor + len) return Math.round(seg.startMs + Math.max(0, outMs - cursor) * rate);
    cursor += len;
  }
  const last = list[list.length - 1];
  return last ? last.endMs : 0;
}

function textStyleOf(kind) {
  const k = String(kind || "").toLowerCase();
  if (TEXT_STYLES.includes(k)) return k;
  return k === "text" ? "hook" : "caption";
}

function defaultTextY(style) {
  if (style === "caption" || style === "bubbly") return TEXT_POSITIONS.bottom;
  if (style === "title") return TEXT_POSITIONS.center;
  return TEXT_POSITIONS.upper;
}

function safeX(x) {
  return clamp(clamp01(x), SAFE.left + 0.14, 1 - SAFE.right - 0.14);
}

function safeY(y) {
  return clamp(clamp01(y), SAFE.top + 0.04, 1 - SAFE.bottom - 0.04);
}

function normalizeTexts(list) {
  return (Array.isArray(list) ? list : [])
    .filter((t) => t && typeof t === "object" && String(t.text || "").trim())
    .slice(0, MAX_TEXTS)
    .map((t) => {
      const style = textStyleOf(t.kind);
      const startMs = Math.max(0, Math.round(num(t.startMs) || 0));
      const durationMs = Math.max(200, Math.round(num(t.durationMs) || 3000));
      return {
        id: String(t.id || ""),
        text: String(t.text).trim().slice(0, TEXT_MAX_CHARS),
        style,
        startMs,
        endMs: startMs + durationMs,
        x: safeX(num(t.x) == null ? 0.5 : t.x),
        y: safeY(num(t.y) == null ? defaultTextY(style) : t.y),
        anim: TEXT_ANIMS.includes(t.anim) ? t.anim : style === "caption" ? "fade" : "slide",
      };
    });
}

// Font size per style as a share of the frame's short side, so a 9/16 and a
// 16/9 render read the same.
function textFontSize(style, out) {
  const short = Math.min(out.w, out.h);
  const share = { title: 0.1, hook: 0.08, bubbly: 0.064, caption: 0.06 }[style] || 0.06;
  return Math.round(short * share);
}

function wrapLines(text, maxChars) {
  const limit = Math.max(6, Math.floor(maxChars));
  const lines = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    let line = "";
    for (const word of raw.trim().split(/\s+/).filter(Boolean)) {
      const next = line ? line + " " + word : word;
      if (next.length > limit && line) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    if (line) lines.push(line);
  }
  return lines.slice(0, 4);
}

// Lines, font size, and a block center that keeps the whole block inside the
// safe area. Width estimate is 0.56em per character for a bold sans.
function layoutText(entry, out) {
  const size = textFontSize(entry.style, out);
  const usable = out.w * (1 - SAFE.left - SAFE.right);
  const lines = wrapLines(entry.text, usable / (size * 0.56));
  const lineH = Math.round(size * 1.22);
  const blockH = lineH * lines.length;
  const widest = Math.max(1, ...lines.map((l) => l.length)) * size * 0.56;
  const halfW = Math.min(usable, widest) / 2;
  const cx = clamp(entry.x * out.w, out.w * SAFE.left + halfW, out.w * (1 - SAFE.right) - halfW);
  const top = clamp(entry.y * out.h - blockH / 2, out.h * SAFE.top, out.h * (1 - SAFE.bottom) - blockH);
  return { size, lines, lineH, cx: Math.round(cx), top: Math.round(top) };
}

function textId(prefix, list) {
  const used = new Set(list.map((t) => t && t.id));
  let i = list.length;
  while (used.has(prefix + "-" + i)) i += 1;
  return prefix + "-" + i;
}

function textYFor(op, style) {
  if (num(op.y) != null) return clamp01(op.y);
  const pos = String(op.position || "").toLowerCase();
  if (TEXT_POSITIONS[pos] != null) return TEXT_POSITIONS[pos];
  return defaultTextY(style);
}

// Removes the [start, end) range from every move, splitting a move that
// straddles it. A punch keeps its look; a push or pan keeps its own timing
// for the part that is left.
function carveCamera(camera, start, end) {
  const out = [];
  for (const m of camera) {
    if (m.endMs <= start || m.startMs >= end) {
      out.push(m);
      continue;
    }
    if (m.startMs < start) out.push(Object.assign({}, m, { endMs: start }));
    if (m.endMs > end) out.push(Object.assign({}, m, { startMs: end }));
  }
  return out;
}

// Look ops. Each takes the working look { frame, camera, flashes, fades,
// texts, aspectRatio } plus the current segments and source duration, and
// returns nothing; it mutates the working copy, which only persists when the
// whole batch applies.
const LOOK_OPS = {
  ratio(look, op) {
    const value = op.aspectRatio != null ? op.aspectRatio : op.ratio;
    const next = value ? normalizeRatio(value) : "";
    if (!RATIOS.includes(next)) throw new Error("ratio needs aspectRatio: " + RATIOS.join(", ") + ".");
    look.aspectRatio = next;
  },
  frame(look, op) {
    const next = Object.assign({}, look.frame);
    if (op.fit !== undefined) {
      if (op.fit !== "fit" && op.fit !== "fill") throw new Error("frame fit must be fit or fill.");
      next.fit = op.fit;
    }
    if (op.x !== undefined) next.x = clamp01(op.x);
    if (op.y !== undefined) next.y = clamp01(op.y);
    if (op.background !== undefined) next.background = op.background === "black" ? "black" : "blur";
    look.frame = normalizeFrame(next);
  },
  zoom(look, op, ctx) {
    const start = ms(op, "start", "startMs");
    const end = ms(op, "end", "endMs");
    if (start == null || end == null || end <= start) throw new Error("zoom needs start before end (seconds).");
    const style = op.style == null ? "punch" : String(op.style);
    if (!CAMERA_STYLES.includes(style)) throw new Error("zoom style must be punch, push, or pan.");
    const amount = num(op.amount != null ? op.amount : op.zoom);
    if (amount == null && style !== "pan") throw new Error("zoom needs amount (1.1 to 4).");
    const move = cleanMove(
      {
        startMs: start,
        endMs: end,
        zoom: amount == null ? 1 : amount,
        x: op.x,
        y: op.y,
        style,
        fromZoom: op.fromAmount != null ? op.fromAmount : op.fromZoom,
        fromX: op.fromX,
        fromY: op.fromY,
      },
      ctx.durationMs,
    );
    if (!move) throw new Error("zoom range must sit inside the clip.");
    look.camera = normalizeCamera(carveCamera(look.camera, move.startMs, move.endMs).concat(move), ctx.durationMs);
  },
  unzoom(look, op) {
    const start = ms(op, "start", "startMs");
    const end = ms(op, "end", "endMs");
    look.camera = start == null || end == null ? [] : carveCamera(look.camera, start, end);
  },
  text(look, op, ctx) {
    const text = String(op.text || "").trim();
    if (!text) throw new Error("text op needs text.");
    let start = ms(op, "start", "startMs");
    let end = ms(op, "end", "endMs");
    const outStart = ms(op, "outputStart", "outputStartMs");
    const outEnd = ms(op, "outputEnd", "outputEndMs");
    if (start == null && outStart != null) start = outputToSourceMs(ctx.segments, outStart);
    if (end == null && outEnd != null) end = outputToSourceMs(ctx.segments, outEnd);
    if (start == null) throw new Error("text op needs start (source seconds) or outputStart (finished-video seconds).");
    if (end == null) end = start + (outEnd != null && outStart != null ? outEnd - outStart : 3000);
    if (end <= start) throw new Error("text op needs end after start.");
    const style = textStyleOf(op.style || op.kind || "caption");
    const entry = {
      id: op.id ? String(op.id) : textId("text-" + style, look.texts),
      kind: style,
      text: text.slice(0, TEXT_MAX_CHARS),
      x: num(op.x) == null ? 0.5 : clamp01(op.x),
      y: textYFor(op, style),
      startMs: start,
      durationMs: end - start,
    };
    if (TEXT_ANIMS.includes(op.anim)) entry.anim = op.anim;
    const at = look.texts.findIndex((t) => t && t.id === entry.id);
    if (at >= 0) look.texts[at] = entry;
    else {
      if (look.texts.length >= MAX_TEXTS) throw new Error("too many texts (max " + MAX_TEXTS + ").");
      look.texts.push(entry);
    }
  },
  remove_text(look, op) {
    if (op.all === true) {
      look.texts = [];
      return;
    }
    if (op.id) {
      const before = look.texts.length;
      look.texts = look.texts.filter((t) => !t || t.id !== String(op.id));
      if (look.texts.length === before) throw new Error("No text with id " + op.id + ".");
      return;
    }
    const start = ms(op, "start", "startMs");
    const end = ms(op, "end", "endMs");
    if (start == null || end == null) throw new Error("remove_text needs id, all:true, or start/end.");
    look.texts = look.texts.filter((t) => {
      const a = Number(t.startMs) || 0;
      const b = a + (Number(t.durationMs) || 3000);
      return b <= start || a >= end;
    });
  },
  flash(look, op, ctx) {
    const at = ms(op, "at", "atMs");
    if (at == null || at < 0 || (ctx.durationMs && at > ctx.durationMs)) throw new Error("flash needs at (seconds) inside the clip.");
    if (look.flashes.length >= MAX_FLASHES) throw new Error("too many flashes (max " + MAX_FLASHES + ").");
    if (!look.flashes.includes(at)) look.flashes.push(at);
    look.flashes.sort((a, b) => a - b);
  },
  fade(look, op) {
    const next = Object.assign({ inMs: 0, outMs: 0 }, look.fades);
    const inMs = ms(op, "in", "inMs");
    const outMs = ms(op, "out", "outMs");
    if (inMs == null && outMs == null) throw new Error("fade needs in and/or out (seconds).");
    if (inMs != null) next.inMs = clamp(inMs, 0, 5000);
    if (outMs != null) next.outMs = clamp(outMs, 0, 5000);
    look.fades = next;
  },
  // Audio layers. `track` names the slot (voice is the default), so a second
  // sound op lands beside the first instead of silently replacing it. An empty
  // audioId clears that one track; without a track it clears them all, which is
  // what the single-slot op used to mean.
  sound(look, op) {
    const list = Array.isArray(look.sounds) ? look.sounds.slice() : [];
    const named = trackName(op && op.track);
    const explicit = op && op.track != null && String(op.track).trim() !== "";
    const audioId = String((op && (op.audioId || op.audio)) || "").trim();
    if (!audioId) {
      look.sounds = explicit ? list.filter((entry) => entry.track !== named) : [];
      return;
    }
    const next = normalizeSound(op, named);
    const at = list.findIndex((entry) => entry.track === named);
    if (at === -1) list.push(next);
    else list[at] = next;
    look.sounds = list;
  },
};

const LOOK_OP_TYPES = Object.keys(LOOK_OPS);

// Texts and image overlays sit on the shared studio blob for older projects;
// rows created after per-video edits carry a videoId. Only rows owned by the
// clip being read are in scope, so a second video never wears the first
// video's captions. Untagged legacy rows belong to the video the project had
// selected when they were saved.
function scopedStudio(studio, videoId, selectedId) {
  const s = studio && typeof studio === "object" ? studio : {};
  const own = (row) =>
    row && typeof row === "object"
      ? row.videoId
        ? row.videoId === videoId
        : !selectedId || videoId === selectedId
      : false;
  const copy = Object.assign({}, s);
  if (Array.isArray(s.texts)) copy.texts = s.texts.filter(own);
  if (Array.isArray(s.overlays)) copy.overlays = s.overlays.filter(own);
  return copy;
}

// Rows outside this clip's scope stay in the blob untouched; rows in scope
// come back tagged, so a write for video A cannot eat video B's captions.
function mergeScopedTexts(studio, videoId, selectedId, texts) {
  const s = studio && typeof studio === "object" ? studio : {};
  const keep = (s.texts || []).filter((t) => {
    if (!t || typeof t !== "object") return false;
    if (t.videoId) return t.videoId !== videoId;
    return Boolean(selectedId) && videoId !== selectedId;
  });
  return keep.concat((Array.isArray(texts) ? texts : []).map((t) => Object.assign({}, t, { videoId })));
}

// The clip's audio layers (voiceover, music bed) persisted on the edit: a
// library audio id, playback volume, whether a short bed loops to cover the
// cut, and how far the source audio ducks under it. layering them means a
// voiceover and a bed can play together, which is the normal way a narrated
// edit sounds; a single slot used to make the second one replace the first.
const AUDIO_TRACKS = ["voice", "music"];

function trackName(value) {
  const name = String(value == null ? "" : value).trim().toLowerCase();
  if (!name) return "voice";
  if (!AUDIO_TRACKS.includes(name)) {
    throw new Error("audio track must be " + AUDIO_TRACKS.join(" or ") + ", not " + name + ".");
  }
  return name;
}

function normalizeSound(value, track) {
  const s = value && typeof value === "object" ? value : {};
  const audioId = String(s.audioId || s.audio || "").trim();
  if (!audioId) return null;
  const duck = s.duck;
  const duckNum = duck == null || duck === false ? null : num(duck === true ? 0.3 : duck);
  return {
    audioId,
    volume: clamp(num(s.volume == null ? 1 : s.volume), 0, 4),
    loop: s.loop === true,
    duck: duckNum == null ? null : clamp(duckNum, 0, 1),
    track: trackName(track == null ? s.track : track),
  };
}

// Saved edits carry either the layered `sounds` array or the older single
// `sound` object, which becomes the voice track.
function normalizeSounds(edit) {
  const e = edit && typeof edit === "object" ? edit : {};
  const raw = Array.isArray(e.sounds) ? e.sounds : e.sound != null ? [e.sound] : [];
  const out = [];
  for (const value of raw) {
    const next = normalizeSound(value);
    if (!next) continue;
    const at = out.findIndex((entry) => entry.track === next.track);
    if (at === -1) out.push(next);
    else out[at] = next;
  }
  return out;
}

function readLook(edit, studio, aspectRatio, durationMs) {
  const e = edit && typeof edit === "object" ? edit : {};
  const s = studio && typeof studio === "object" ? studio : {};
  const sounds = normalizeSounds(e);
  return {
    aspectRatio: normalizeRatio(aspectRatio || "16/9"),
    frame: normalizeFrame(e.frame),
    camera: normalizeCamera(e.camera, durationMs),
    flashes: (Array.isArray(e.flashes) ? e.flashes : []).map(num).filter((v) => v != null && v >= 0),
    fades: {
      inMs: clamp(num(e.fades && e.fades.inMs) || 0, 0, 5000),
      outMs: clamp(num(e.fades && e.fades.outMs) || 0, 0, 5000),
    },
    sounds,
    texts: (Array.isArray(s.texts) ? s.texts : []).filter((t) => t && typeof t === "object").map((t) => Object.assign({}, t)),
  };
}

function applyLookOp(look, op, ctx) {
  const handler = LOOK_OPS[String(op && op.type)];
  if (!handler) return false;
  handler(look, op, ctx);
  return true;
}

// Base view outside every move: the frame's focus at zoom 1, or the older
// studio-wide zoom when a preset set one.
function baseView(look) {
  const frame = normalizeFrame(look && look.frame);
  const z = look && look.baseZoom;
  if (z && num(z.amount) != null && z.amount > 1) {
    return { zoom: clampZoom(z.amount, 1), x: clamp01(z.x), y: clamp01(z.y) };
  }
  return { zoom: 1, x: frame.x, y: frame.y };
}

function lerpRect(a, b, e) {
  return { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e, w: a.w + (b.w - a.w) * e, h: a.h + (b.h - a.h) * e };
}

// Start and end windows of a move. A punch has one window; push and pan
// travel from the from-state to the target.
function moveRects(look, src, out, move) {
  const frame = normalizeFrame(look && look.frame);
  const to = viewRect(src, out, frame.fit, move.zoom, move.x, move.y);
  if (move.style === "punch") return { from: to, to };
  const base = baseView(look);
  const fromZoom = move.fromZoom != null ? move.fromZoom : move.style === "pan" ? move.zoom : base.zoom;
  const from = viewRect(
    src,
    out,
    frame.fit,
    fromZoom,
    move.fromX != null ? move.fromX : base.x,
    move.fromY != null ? move.fromY : base.y,
  );
  return { from, to };
}

function moveProgress(move, atMs) {
  return smoothstep((atMs - move.startMs) / Math.max(1, move.endMs - move.startMs));
}

// The source window on screen at one source moment. Render and preview both
// call this, so a push-in eases the same way in both.
function rectAt(look, src, out, atMs) {
  const t = Number(atMs) || 0;
  const move = ((look && look.camera) || []).find((m) => t >= m.startMs && t < m.endMs);
  const frame = normalizeFrame(look && look.frame);
  if (!move) {
    const base = baseView(look);
    return viewRect(src, out, frame.fit, base.zoom, base.x, base.y);
  }
  const rects = moveRects(look, src, out, move);
  return move.style === "punch" ? rects.to : lerpRect(rects.from, rects.to, moveProgress(move, t));
}

// Everything the render and the preview draw, resolved from the editable look
// plus older studio fields: preset zoom, letterbox, flash frame, animation
// overlays (drawn as a top title), and fade presets.
function renderLook(look, studio) {
  const s = studio && typeof studio === "object" ? studio : {};
  const resolved = Object.assign({}, look);
  if (s.zoom && s.zoom.on !== false && num(s.zoom.amount) > 1) {
    resolved.baseZoom = { amount: num(s.zoom.amount), x: clamp01(s.zoom.x), y: clamp01(s.zoom.y) };
  }
  resolved.letterbox = s.letterbox === true;
  const flashes = look.flashes.slice();
  const flashUntil = num(s.flashUntilMs);
  if (flashUntil != null && flashUntil > 0) flashes.push(Math.max(0, flashUntil - 220));
  resolved.flashes = flashes.sort((a, b) => a - b);
  const overlays = (Array.isArray(s.overlays) ? s.overlays : [])
    .filter((o) => o && typeof o === "object" && o.kind !== "image" && !o.imageId && String(o.name || "").trim())
    .map((o, i) => ({
      id: "overlay-" + i,
      kind: "hook",
      text: String(o.name),
      x: 0.5,
      y: 0.16,
      startMs: num(o.startMs) || 0,
      durationMs: num(o.durationMs) || 1600,
      anim: "slide",
    }));
  resolved.drawTexts = normalizeTexts(look.texts.concat(overlays));
  const fades = Object.assign({}, look.fades);
  if (!fades.inMs && /fade/.test(String(s.introId || ""))) fades.inMs = Math.min(800, num(s.introDurationMs) || 800);
  if (!fades.outMs && /fade/.test(String(s.endId || ""))) fades.outMs = Math.min(2000, num(s.endDurationMs) || 1400);
  resolved.fades = fades;
  return resolved;
}

// Short human readout for prompts and tool results.
function lookSummary(look, segments) {
  const parts = [look.aspectRatio + " " + (look.frame.fit === "fill" ? "fill" : "fit")];
  if (look.frame.fit === "fill" && (look.frame.x !== 0.5 || look.frame.y !== 0.5)) {
    parts[0] += " at " + look.frame.x + "," + look.frame.y;
  }
  if (look.camera.length) parts.push(look.camera.length + (look.camera.length === 1 ? " zoom" : " zooms"));
  const shownTexts = look.texts.filter((t) => sourceToOutputRanges(segments, t.startMs || 0, (t.startMs || 0) + (t.durationMs || 3000)).length);
  if (look.texts.length) {
    parts.push(look.texts.length + (look.texts.length === 1 ? " text" : " texts") + (shownTexts.length < look.texts.length ? " (" + (look.texts.length - shownTexts.length) + " inside cuts)" : ""));
  }
  if (look.flashes.length) parts.push(look.flashes.length + (look.flashes.length === 1 ? " flash" : " flashes"));
  if (look.fades.inMs || look.fades.outMs) parts.push("fades");
  const tracks = Array.isArray(look.sounds) ? look.sounds : [];
  for (const track of tracks) parts.push((track.track === "music" ? "music " : "audio ") + track.audioId.slice(0, 8));
  return parts.join(" · ");
}

module.exports = {
  ZOOM_MIN,
  ZOOM_MAX,
  SAFE,
  RATIOS,
  CAMERA_STYLES,
  TEXT_STYLES,
  LOOK_OP_TYPES,
  parseRatio,
  normalizeRatio,
  outputSize,
  normalizeFrame,
  normalizeCamera,
  smoothstep,
  viewRect,
  rectInside,
  sourceToOutputRanges,
  sourceToOutputMs,
  outputToSourceMs,
  normalizeTexts,
  normalizeSound,
  normalizeSounds,
  AUDIO_TRACKS,
  layoutText,
  textFontSize,
  readLook,
  scopedStudio,
  mergeScopedTexts,
  applyLookOp,
  lookSummary,
  baseView,
  moveRects,
  moveProgress,
  rectAt,
  renderLook,
};
