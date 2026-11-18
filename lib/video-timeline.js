"use strict";

// The cut timeline is a list of kept segments: { startMs, endMs, speed,
// muted, volume }. Each segment is a part of the source clip that ships in
// the output, in order. Parts of the source no segment covers are cut out.
// speed is the playback rate for that range (2 doubles it), muted drops the
// sound, volume scales it (0 to 2).
//
// videoEdits[clipId].segments stores the model on the project state. Older
// edits that only carry trimInMs/trimOutMs normalize to a single segment, so
// nothing an agent or a user made before is lost.

const SPEED_MIN = 0.25;
const SPEED_MAX = 8;
const VOLUME_MIN = 0;
const VOLUME_MAX = 2;
const MAX_OPS = 200;
const MIN_SEGMENT_MS = 40;

const SEGMENT_KEYS = ["speed", "muted", "volume"];

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Agent-friendly time input: start/end in seconds, startMs/endMs directly, or
// whole frames. Frames are what actually survive a render, so an edit that
// names a frame lands exactly there instead of a millisecond that rounds into
// the middle of one.
function ms(input, short, long) {
  const msVal = num(input && input[long]);
  if (msVal != null) return Math.round(msVal);
  const sVal = num(input && input[short]);
  return sVal == null ? null : Math.round(sVal * 1000);
}

function frameMs(frame, fps) {
  const value = num(frame);
  if (value == null) return null;
  const rate = num(fps);
  if (rate == null || rate <= 0) {
    throw new Error("frame positions need the clip's frame rate; pass frame.fps or read jeditor_get_timeline first.");
  }
  return Math.round((value / rate) * 1000);
}

// A segment boundary on the source frame grid, in whole milliseconds. Cuts and
// frame-accurate trims only agree when both sides round the same way.
function snapMsToFrame(value, fps) {
  const msVal = num(value);
  const rate = num(fps);
  if (msVal == null || rate == null || rate <= 0) return msVal == null ? null : Math.round(msVal);
  return Math.round((Math.round((msVal * rate) / 1000) / rate) * 1000);
}

function snapSegmentsToFrames(segments, fps) {
  const rate = num(fps);
  if (rate == null || rate <= 0) return segments;
  return segments.map((seg) => {
    const startMs = snapMsToFrame(seg.startMs, rate);
    const endMs = snapMsToFrame(seg.endMs, rate);
    const next = Object.assign({}, seg, { startMs, endMs });
    // A snap must never collapse a kept part into nothing.
    return endMs - startMs < MIN_SEGMENT_MS ? seg : next;
  });
}

// Every op that takes a time also takes a frame: fromFrame/toFrame for ranges,
// frame/atFrame for a point, inFrame/outFrame for a fade. Frames win when both
// are given, because a frame is the precise form.
const FRAME_ALIASES = [
  { frames: ["fromFrame", "startFrame"], msField: "startMs", secField: "start" },
  { frames: ["toFrame", "endFrame"], msField: "endMs", secField: "end" },
  { frames: ["frame", "atFrame"], msField: "atMs", secField: "at" },
  { frames: ["inFrame"], msField: "inMs", secField: "in" },
  { frames: ["outFrame"], msField: "outMs", secField: "out" },
];

function firstFrame(op, keys) {
  for (const key of keys) {
    const value = num(op[key]);
    if (value != null) return value;
  }
  return null;
}

// Frames win over seconds when an op gives both, because a frame is the precise
// form: the op keeps its shape and every handler below reads it unchanged.
function resolveFrameTimes(op, fps) {
  if (!op || typeof op !== "object") return op;
  let next = null;
  for (const alias of FRAME_ALIASES) {
    const given = firstFrame(op, alias.frames);
    if (given == null) continue;
    const resolved = frameMs(given, fps);
    if (resolved == null) continue;
    next = next || Object.assign({}, op);
    next[alias.msField] = resolved;
    next[alias.secField] = resolved / 1000;
  }
  return next || op;
}

function clampSpeed(rate) {
  const n = num(rate);
  if (n == null || n <= 0) throw new Error("speed must be a positive number (0.25 to 8).");
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, n));
}

function clampVolume(gain) {
  const n = num(gain);
  if (n == null) throw new Error("volume must be a number (0 to 2).");
  return Math.min(VOLUME_MAX, Math.max(VOLUME_MIN, n));
}

function cleanSegment(seg, durationMs) {
  const startMs = num(seg && seg.startMs);
  const endMs = num(seg && seg.endMs);
  if (startMs == null || endMs == null) return null;
  const cap = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : Infinity;
  const start = Math.min(Math.max(0, Math.round(startMs)), cap);
  const end = Math.min(Math.max(0, Math.round(endMs)), cap);
  if (end - start < MIN_SEGMENT_MS) return null;
  const out = { startMs: start, endMs: end };
  const speed = num(seg.speed);
  if (speed != null && speed !== 1) out.speed = Math.min(SPEED_MAX, Math.max(SPEED_MIN, speed));
  if (seg.muted === true) out.muted = true;
  const volume = num(seg.volume);
  if (volume != null && volume !== 1) out.volume = Math.min(VOLUME_MAX, Math.max(VOLUME_MIN, volume));
  return out;
}

// Two kept segments that touch and play identically are one part; merging them
// keeps the model readable in prompts and the render graph small.
function sameAttrs(a, b) {
  return SEGMENT_KEYS.every((key) => (a[key] == null ? baseAttr(key) : a[key]) === (b[key] == null ? baseAttr(key) : b[key]));
}

function baseAttr(key) {
  if (key === "muted") return false;
  return 1;
}

function sortMerge(segments) {
  const sorted = segments.slice().sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const out = [];
  for (const seg of sorted) {
    const last = out[out.length - 1];
    if (last && seg.startMs <= last.endMs && sameAttrs(last, seg)) {
      last.endMs = Math.max(last.endMs, seg.endMs);
      continue;
    }
    out.push(seg);
  }
  return out;
}

// Resolve the working segment list: explicit segments win, otherwise legacy
// trim/mute fields become the single kept part.
function normalizeSegments(edit, durationMs) {
  const e = edit && typeof edit === "object" ? edit : {};
  const cap = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : Infinity;
  if (Array.isArray(e.segments) && e.segments.length) {
    const segs = e.segments.map((seg) => cleanSegment(seg, durationMs)).filter(Boolean);
    if (segs.length) return sortMerge(segs);
    return [];
  }
  const trimIn = num(e.trimInMs) || 0;
  const trimOut = num(e.trimOutMs);
  const endMs = trimOut != null ? trimOut : cap;
  const start = Math.min(Math.max(0, Math.round(trimIn)), cap);
  const end = Math.min(Math.max(0, Math.round(endMs)), cap);
  if (!Number.isFinite(end) || end - start < MIN_SEGMENT_MS) return [];
  const seg = { startMs: start, endMs: end };
  if (e.muted === true) seg.muted = true;
  const volume = num(e.volume);
  if (volume != null && volume !== 1) seg.volume = Math.min(VOLUME_MAX, Math.max(VOLUME_MIN, volume));
  return [seg];
}

function splitSegmentAt(segments, msPoint) {
  const out = [];
  for (const seg of segments) {
    if (msPoint > seg.startMs && msPoint < seg.endMs) {
      const head = Object.assign({}, seg, { endMs: msPoint });
      const tail = Object.assign({}, seg, { startMs: msPoint });
      out.push(head, tail);
    } else {
      out.push(seg);
    }
  }
  return out;
}

function rangesOverlap(seg, start, end) {
  return seg.startMs < end && seg.endMs > start;
}

function applyCut(segments, start, end) {
  if (start >= end) throw new Error("cut needs start before end.");
  let next = splitSegmentAt(segments, start);
  next = splitSegmentAt(next, end);
  return next.filter((seg) => !rangesOverlap(seg, start, end));
}

// Split the kept timeline at a boundary without removing anything, so later
// speed or audio ops can aim at that part alone.
function applySplit(segments, at) {
  if (!segments.some((seg) => at > seg.startMs && at < seg.endMs)) {
    throw new Error("split point must land inside a kept part.");
  }
  return splitSegmentAt(segments, at);
}

function applyKeep(segments, start, end) {
  if (start >= end) throw new Error("keep needs start before end.");
  let next = splitSegmentAt(segments, start);
  next = splitSegmentAt(next, end);
  return next.filter((seg) => rangesOverlap(seg, start, end));
}

function applyToRange(segments, start, end, patch) {
  let next = start == null ? segments : splitSegmentAt(segments, start);
  if (end != null) next = splitSegmentAt(next, end);
  return next.map((seg) => {
    const inRange =
      (start == null && end == null) ||
      rangesOverlap(seg, start == null ? seg.startMs : start, end == null ? seg.endMs : end);
    if (!inRange) return seg;
    const copy = Object.assign({}, seg, patch);
    for (const key of SEGMENT_KEYS) if (copy[key] === baseAttr(key)) delete copy[key];
    return copy;
  });
}

const OP_HANDLERS = {
  cut(segments, op) {
    const [start, end] = requiredRange(op);
    return applyCut(segments, start, end);
  },
  keep(segments, op) {
    const [start, end] = requiredRange(op);
    return applyKeep(segments, start, end);
  },
  split(segments, op) {
    const at = ms(op, "at", "atMs");
    if (at == null) throw new Error("split needs at (seconds) or atMs.");
    return applySplit(segments, at);
  },
  speed(segments, op) {
    return applyToRange(segments, ms(op, "start", "startMs"), ms(op, "end", "endMs"), {
      speed: clampSpeed(op.rate != null ? op.rate : op.speed),
    });
  },
  audio(segments, op) {
    const patch = {};
    if (op.muted !== undefined) patch.muted = op.muted === true;
    if (op.volume !== undefined) patch.volume = clampVolume(op.volume);
    if (!Object.keys(patch).length) throw new Error("audio needs muted or volume.");
    return applyToRange(segments, ms(op, "start", "startMs"), ms(op, "end", "endMs"), patch);
  },
  // reset restores the whole clip as one untouched part; ranges of earlier
  // ops in the same call still apply after it.
  reset(segments, op, durationMs) {
    const cap = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : null;
    if (cap == null) throw new Error("reset needs a known clip duration.");
    return [{ startMs: 0, endMs: cap }];
  },
};

function requiredRange(op) {
  const start = ms(op, "start", "startMs");
  const end = ms(op, "end", "endMs");
  if (start == null || end == null) throw new Error("op needs start/end in seconds or startMs/endMs.");
  if (start < 0 || end <= start) throw new Error("op range must be start before end, both inside the clip.");
  return [start, end];
}

// Apply a batch of ops against the current edit and return the next edit
// object. Nothing writes until every op validates and applies, so a bad op
// leaves the project timeline untouched. options.fps snaps the kept boundaries
// onto the source frame grid.
function applyTimelineOps(edit, ops, durationMs, options) {
  if (!Array.isArray(ops) || !ops.length) throw new Error("ops must be a non-empty array.");
  if (ops.length > MAX_OPS) throw new Error("too many ops in one call (max " + MAX_OPS + ").");
  const opts = options || {};
  const fps = num(opts.fps);
  let segments = normalizeSegments(edit, durationMs);
  for (const raw of ops) {
    const op = resolveFrameTimes(raw, fps);
    const type = op && typeof op === "object" ? String(op.type || "") : "";
    const handler = OP_HANDLERS[type];
    if (!handler) throw new Error("Unknown timeline op: " + (type || "missing type") + ".");
    segments = handler(segments, op, durationMs);
    segments = sortMerge(segments);
    if (!segments.length) throw new Error("That edit removes the whole clip. Keep at least " + MIN_SEGMENT_MS + "ms.");
  }
  if (fps != null && fps > 0 && opts.snap !== false) segments = snapSegmentsToFrames(segments, fps);
  const next = Object.assign({}, edit && typeof edit === "object" ? edit : {});
  next.segments = segments;
  // Keep the legacy trim fields in step: the editor timeline, playhead clamp,
  // and prompt lines still read them. First kept start becomes trim in, last
  // kept end becomes trim out.
  next.trimInMs = segments[0].startMs;
  next.trimOutMs = segments[segments.length - 1].endMs;
  return next;
}

function segOutputMs(seg) {
  const speed = num(seg.speed) || 1;
  return (seg.endMs - seg.startMs) / speed;
}

// What the timeline bakes down to: kept source time, finished length, and the
// removed spans so prompts and UI can describe the cut.
function timelineStats(segments) {
  const list = Array.isArray(segments) ? segments : [];
  let outputMs = 0;
  let keptMs = 0;
  let top = 0;
  for (const seg of list) {
    keptMs += seg.endMs - seg.startMs;
    outputMs += segOutputMs(seg);
    if (seg.endMs > top) top = seg.endMs;
  }
  const cuts = [];
  for (let i = 1; i < list.length; i += 1) {
    const prevEnd = list[i - 1].endMs;
    const nextStart = list[i].startMs;
    if (nextStart > prevEnd) cuts.push({ startMs: prevEnd, endMs: nextStart });
  }
  return {
    segments: list,
    keptMs,
    outputMs: Math.round(outputMs),
    cutCount: cuts.length,
    cuts,
    spanEndMs: top,
  };
}

// Human one-liner for prompts and the stage chip: "kept 24s of 60s · 2 cuts ·
// 2x on 5-8s · audio off".
function fmtS(msValue) {
  const s = Math.round(msValue / 100) / 10;
  return s + "s";
}

function timelineSummaryText(segments, durationMs) {
  const list = Array.isArray(segments) ? segments : [];
  if (!list.length) return "";
  const parts = [];
  const stats = timelineStats(list);
  if (Number.isFinite(durationMs) && durationMs > 0) {
    parts.push("kept " + fmtS(stats.keptMs) + " of " + fmtS(durationMs));
  } else {
    parts.push("kept " + fmtS(stats.keptMs));
  }
  if (stats.cutCount) parts.push(stats.cutCount + (stats.cutCount === 1 ? " cut" : " cuts"));
  const speeds = list.filter((seg) => (num(seg.speed) || 1) !== 1);
  if (speeds.length) {
    parts.push(
      speeds.map((seg) => fmtSpeedLabel(num(seg.speed) || 1) + " on " + fmtS(seg.startMs) + "-" + fmtS(seg.endMs)).join(", "),
    );
  }
  const allMuted = list.every((seg) => seg.muted === true || num(seg.volume) === 0);
  const someMuted = !allMuted && list.some((seg) => seg.muted === true || num(seg.volume) === 0);
  if (allMuted) parts.push("audio off");
  else if (someMuted) parts.push("audio partly off");
  else {
    const gains = list.filter((seg) => num(seg.volume) != null && num(seg.volume) !== 1);
    if (gains.length) parts.push("volume adjusted");
  }
  return parts.join(" · ");
}

function fmtSpeedLabel(rate) {
  const rounded = Math.round(rate * 100) / 100;
  return String(rounded) + "x";
}

module.exports = {
  normalizeSegments,
  applyTimelineOps,
  timelineStats,
  timelineSummaryText,
  cleanSegment,
  resolveFrameTimes,
  snapMsToFrame,
  snapSegmentsToFrames,
  frameMs,
  SPEED_MIN,
  SPEED_MAX,
  MIN_SEGMENT_MS,
};
