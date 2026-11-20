"use strict";

// Measures what was actually rendered. The linters beside this file read the
// saved code and words; this one decodes the finished picture and sound with
// the ffmpeg the app already renders with, at about 160 px wide, and reports
// the tells that only show up there: one color family owning the picture,
// cuts on a metronome, a picture that never moves, sound at one level from
// start to end.
//
// Every issue is { rule, hard, what, fix, where, source, measured }. Nothing
// here throws for a file ffmpeg cannot read: the check is listed in `skipped`
// with the reason, so a caller never mistakes "not measured" for "clean".

const { spawn } = require("node:child_process");
const fs = require("node:fs");

const WIDTH = 160;
const MAX_FPS = 8;
const MAX_FRAMES = 480;
const GRID = 12; // GRID x GRID blocks per frame for cuts and palettes
const DECODE_TIMEOUT_MS = 120000;

// ---- thresholds, tuned on real renders (see scripts/slop-check-test.cjs) ----

// A pixel counts as colored when it has both saturation and light.
const COLORED_SAT = 0.25;
const COLORED_VAL = 0.2;
// Indigo through purple, where the default AI gradient lives (#4f46e5 is 243,
// #8b5cf6 is 258, #a855f7 is 271, #c026d3 is 293).
const PURPLE_FROM = 232;
const PURPLE_TO = 300;
// Purple owns the picture: this share of every pixel, or this share of the
// colored ones when at least a fifth of the picture is colored.
const PURPLE_ALL = 0.38;
const PURPLE_OF_COLORED = 0.62;
const PURPLE_MIN_COLORED = 0.2;
// Neon cyan on black: most of the picture near black, and what color there is
// sits in the cyan band.
const DARK_VAL = 0.14;
const CYAN_FROM = 165;
const CYAN_TO = 200;
const CYAN_DARK_SHARE = 0.55;
const CYAN_OF_COLORED = 0.6;
const CYAN_MIN_COLORED = 0.025;
// Oversaturated everywhere: vivid pixels cover most of the picture in almost
// every frame.
const VIVID_SAT = 0.72;
const VIVID_VAL = 0.5;
const VIVID_SHARE = 0.55;
const VIVID_FRAMES = 0.8;
// Light and palette: scenes whose mean brightness and hue mix all sit this
// close together.
const LIGHT_MIN_SCENES = 3;
const LIGHT_LUMA_RANGE = 0.05;
const LIGHT_PALETTE_DIST = 0.14;
// Centered and symmetric.
const CENTER_OFFSET = 0.025;
const CENTER_MARGIN_DIFF = 0.035;
const CENTER_MAX_SPAN = 0.92;
const CENTER_FRAMES = 0.9;
const CENTER_MIN_JUDGED = 0.6;
const CENTER_MIN_SECONDS = 6;
// Motion: a frame pair is still under STILL and moving over MOVING (mean
// absolute luma change, 0..1).
const STILL_DIFF = 0.0012;
const STATIC_SHARE = 0.9;
const STATIC_MIN_SECONDS = 5;
// Cuts.
const CUT_BLOCK_DELTA = 0.1;
const CUT_BLOCK_SHARE = 0.5;
const CUT_WINDOW_S = 0.5;
const CUT_MAX_RUN_S = 1.4;
const EVEN_MIN_GAPS = 3;
const EVEN_RATIO = 1.6;
// Sound: momentary loudness that stays inside this band for the whole clip.
const FLAT_MIN_SECONDS = 6;
const FLAT_SPREAD_LU = 2.5;
const FLAT_EDGE_LU = 2;
// Reading time for on screen text.
const READ_BASE_MS = 500;
const READ_PER_WORD_MS = 260;
const READ_SLACK = 0.7;

function findFfmpeg() {
  try {
    return require("../card-render").findFfmpeg() || "";
  } catch {
    return "";
  }
}

function pct(share) {
  return Math.round(share * 100) + "%";
}

function secs(value) {
  return (Math.round(value * 10) / 10).toFixed(1) + " s";
}

function even(n) {
  return Math.max(2, Math.round(n / 2) * 2);
}

// `ffmpeg -i` prints the stream table to stderr; that is enough for size,
// length and whether there is sound (the app has no ffprobe).
function probe(ffmpeg, file, signal) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(ffmpeg, ["-hide_banner", "-nostdin", "-i", file], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    } catch {
      return resolve({});
    }
    let stderr = "";
    const timer = setTimeout(() => child.kill(), 20000);
    const onAbort = () => child.kill();
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 40000) stderr = stderr.slice(-20000);
    });
    const done = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      const dims = /Video:[^\n]*? (\d{2,5})x(\d{2,5})/.exec(stderr);
      const duration = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
      const turned = /rotation of -?(90|270)\.00 degrees|rotate\s*:\s*-?(90|270)\b/.test(stderr);
      const w = dims ? Number(dims[1]) : 0;
      const h = dims ? Number(dims[2]) : 0;
      resolve({
        width: turned ? h : w,
        height: turned ? w : h,
        hasAudio: /Audio:/.test(stderr),
        hasVideo: Boolean(dims),
        durationMs: duration ? Math.round((Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])) * 1000) : 0,
      });
    };
    child.on("error", done);
    child.on("close", done);
  });
}

// Raw frames from ffmpeg's stdout, one callback per frame. No temp files.
function decode(ffmpeg, args, frameBytes, onFrame, signal) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(ffmpeg, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      return resolve({ frames: 0, error: String((error && error.message) || error) });
    }
    let stderr = "";
    let frames = 0;
    let settled = false;
    let stopped = false;
    let pending = Buffer.alloc(0);
    const finish = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve(Object.assign({ frames, stderr }, extra));
    };
    const timer = setTimeout(() => {
      stopped = true;
      child.kill();
      finish({ error: "ffmpeg took too long to decode the file." });
    }, DECODE_TIMEOUT_MS);
    const onAbort = () => {
      stopped = true;
      child.kill();
      finish({ aborted: true });
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
    }
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-2000);
    });
    child.stdout.on("data", (chunk) => {
      if (stopped) return;
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let at = 0;
      while (pending.length - at >= frameBytes) {
        onFrame(pending.subarray(at, at + frameBytes), frames);
        frames += 1;
        at += frameBytes;
        if (frames >= MAX_FRAMES * 2) {
          stopped = true;
          child.kill();
          break;
        }
      }
      pending = at ? pending.subarray(at) : pending;
    });
    child.on("error", (error) => finish({ error: String((error && error.message) || error) }));
    child.on("close", () => finish({}));
  });
}

// One frame boiled down to what the checks need. `bpp` is 3 (video) or 4 (a
// still with alpha, where see-through pixels are left out).
function frameStats(buf, w, h, bpp) {
  const total = w * h;
  const luma = new Uint8Array(total);
  const blocks = new Float32Array(GRID * GRID * 3);
  const blockN = new Uint16Array(GRID * GRID);
  const hues = new Float32Array(12);
  let n = 0;
  let sumLuma = 0;
  let dark = 0;
  let colored = 0;
  let purple = 0;
  let cyan = 0;
  let vivid = 0;
  for (let y = 0; y < h; y += 1) {
    const by = Math.min(GRID - 1, Math.floor((y * GRID) / h));
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * bpp;
      if (bpp === 4 && buf[i + 3] < 128) continue;
      const r = buf[i];
      const g = buf[i + 1];
      const b = buf[i + 2];
      const max = r > g ? (r > b ? r : b) : g > b ? g : b;
      const min = r < g ? (r < b ? r : b) : g < b ? g : b;
      const l = (r * 54 + g * 183 + b * 19) >> 8;
      luma[y * w + x] = l;
      sumLuma += l;
      n += 1;
      const bi = (by * GRID + Math.min(GRID - 1, Math.floor((x * GRID) / w))) * 3;
      blocks[bi] += r;
      blocks[bi + 1] += g;
      blocks[bi + 2] += b;
      blockN[bi / 3] += 1;
      const v = max / 255;
      const s = max ? (max - min) / max : 0;
      if (v < DARK_VAL) dark += 1;
      if (s >= COLORED_SAT && v >= COLORED_VAL) {
        const d = max - min;
        let hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
        hue *= 60;
        if (hue < 0) hue += 360;
        colored += 1;
        hues[Math.min(11, Math.floor(hue / 30))] += 1;
        if (hue >= PURPLE_FROM && hue < PURPLE_TO) purple += 1;
        if (hue >= CYAN_FROM && hue < CYAN_TO && s >= 0.5 && v >= 0.5) cyan += 1;
        if (s >= VIVID_SAT && v >= VIVID_VAL) vivid += 1;
      }
    }
  }
  for (let k = 0; k < GRID * GRID; k += 1) {
    const c = blockN[k] || 1;
    blocks[k * 3] /= c * 255;
    blocks[k * 3 + 1] /= c * 255;
    blocks[k * 3 + 2] /= c * 255;
  }
  const count = n || 1;
  // 12 hue bins plus one for everything without color, as shares of the frame.
  const palette = new Float32Array(13);
  for (let k = 0; k < 12; k += 1) palette[k] = hues[k] / count;
  palette[12] = (count - colored) / count;
  return {
    luma,
    blocks,
    palette,
    opaque: n / total,
    meanLuma: sumLuma / count / 255,
    dark: dark / count,
    colored: colored / count,
    purple: purple / count,
    cyan: cyan / count,
    vivid: vivid / count,
    layout: layoutOf(luma, w, h),
  };
}

// Where the drawn content sits, read from edges so a gradient background does
// not count as content. Returns null for a frame that cannot be judged (empty,
// or edges wall to wall as in footage).
function layoutOf(luma, w, h) {
  const cols = new Float32Array(w);
  let mass = 0;
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const i = y * w + x;
      const e = Math.abs(luma[i + 1] - luma[i - 1]) + Math.abs(luma[i + w] - luma[i - w]);
      if (e < 48) continue;
      cols[x] += 1;
      mass += 1;
    }
  }
  if (mass < w * h * 0.004) return null;
  let peak = 0;
  for (let x = 0; x < w; x += 1) if (cols[x] > peak) peak = cols[x];
  const floor = Math.max(1, peak * 0.06);
  let left = -1;
  let right = -1;
  let cx = 0;
  for (let x = 0; x < w; x += 1) {
    cx += cols[x] * x;
    if (cols[x] >= floor) {
      if (left < 0) left = x;
      right = x;
    }
  }
  if (left < 0) return null;
  const span = (right - left + 1) / w;
  if (span > CENTER_MAX_SPAN) return null;
  const offset = Math.abs(cx / mass / (w - 1) - 0.5);
  const marginDiff = Math.abs(left - (w - 1 - right)) / w;
  return { centered: offset <= CENTER_OFFSET && marginDiff <= CENTER_MARGIN_DIFF, offset, marginDiff, span };
}

function lumaDiff(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] > b[i] ? a[i] - b[i] : b[i] - a[i];
  return sum / a.length / 255;
}

// Share of blocks whose color moved by more than CUT_BLOCK_DELTA.
function blockChange(a, b) {
  let changed = 0;
  const cells = GRID * GRID;
  for (let k = 0; k < cells; k += 1) {
    const d = Math.abs(a[k * 3] - b[k * 3]) + Math.abs(a[k * 3 + 1] - b[k * 3 + 1]) + Math.abs(a[k * 3 + 2] - b[k * 3 + 2]);
    if (d / 3 > CUT_BLOCK_DELTA) changed += 1;
  }
  return changed / cells;
}

// Cut times in seconds. A hard cut and a crossfade both show as most of the
// picture changing across a short window with a steady picture either side; a
// long run of change is camera motion, not a cut.
function detectCuts(frames, fps) {
  const k = Math.max(1, Math.round(CUT_WINDOW_S * fps));
  const hits = [];
  for (let i = 0; i + k < frames.length; i += 1) hits.push(blockChange(frames[i].blocks, frames[i + k].blocks) >= CUT_BLOCK_SHARE);
  const cuts = [];
  let start = -1;
  for (let i = 0; i <= hits.length; i += 1) {
    if (hits[i]) {
      if (start < 0) start = i;
      continue;
    }
    if (start < 0) continue;
    const run = i - start;
    if (run <= k + Math.round(CUT_MAX_RUN_S * fps)) cuts.push((start + run / 2 + k / 2) / fps);
    start = -1;
  }
  return cuts;
}

function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const at = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[at];
}

function paletteDist(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += Math.abs(a[i] - b[i]);
  return sum / 2;
}

// What the person asked for is never an issue. `asked` is their own words.
const ASKED = {
  "purple-dominant": /\b(purple|violet|indigo|lavender|lilac|magenta|plum|amethyst)\b/i,
  "cyan-on-black": /\b(cyan|teal|aqua|turquoise|neon|cyberpunk|synthwave|terminal|hacker|matrix|tron)\b/i,
  oversaturated: /\b(saturated|vivid|vibrant|neon|bold colou?rs?|loud colou?rs?|candy|pop art|psychedelic)\b/i,
  "same-light": /\b(same (background|colou?r|look|palette)|one (background|colou?r|palette)|consistent (background|colou?r|look|palette)|monochrome|single colou?r|brand colou?r)\b/i,
  "all-centered": /\b(cent(er|re)(e?d)?|symmetr\w+|middle of the (screen|frame))\b/i,
  "static-picture": /\b(static|still (image|frame|picture)|no (motion|animation|movement)|slideshow|slide show|freeze|hold on)\b/i,
  "even-cuts": /\b(even(ly)?|same length|equal (length|time)|every \d+(\.\d+)? ?(s|sec|seconds?)\b|\d+ ?(s|sec|seconds?) each|on the beat|metronome|steady (pace|rhythm))\b/i,
  "flat-audio": /\b(drone|constant (tone|level|volume)|flat (tone|level|volume)|steady (tone|level|volume)|test tone|white noise|ambient)\b/i,
  "text-too-brief": /\b(flash(es|ing)?|subliminal|rapid.?fire|blink)\b/i,
};

// "No purple" and "DON'T: purple gradients, glow, everything centered" name the
// thing without asking for it, so a mention only counts when nothing before it
// in the same sentence turns it down.
const TURNED_DOWN = /\b(no|not|never|don'?t|do not|doesn'?t|avoid|without|isn'?t|aren'?t|stop|less|fewer|remove|drop|ban|hate|tired of|sick of|too|anything but)\b/i;

function askedFor(rule, asked) {
  const source = ASKED[rule];
  const text = String(asked || "");
  if (!source || !text) return false;
  const re = new RegExp(source.source, "gi");
  let hit;
  while ((hit = re.exec(text))) {
    const before = text.slice(0, hit.index);
    const start = Math.max(before.lastIndexOf("."), before.lastIndexOf("!"), before.lastIndexOf("?"), before.lastIndexOf("\n"), before.lastIndexOf(";"), before.toLowerCase().lastIndexOf(" but "), before.toLowerCase().lastIndexOf(" instead "));
    if (!TURNED_DOWN.test(before.slice(start + 1))) return true;
    if (!hit[0].length) re.lastIndex += 1;
  }
  return false;
}

function keep(issues, opts) {
  const asked = String((opts && opts.asked) || "");
  const allow = new Set(((opts && opts.allow) || []).map(String));
  return issues.filter((issue) => !allow.has(issue.rule) && !askedFor(issue.rule, asked));
}

// ------------------------------------------------------------- color checks

// frames: the per-frame stats. Used for a video and for a single still.
function colorIssues(frames, where) {
  const issues = [];
  const purpleAll = mean(frames.map((f) => f.purple));
  const coloredAll = mean(frames.map((f) => f.colored));
  const purpleOfColored = coloredAll > 0 ? purpleAll / coloredAll : 0;
  if (purpleAll >= PURPLE_ALL || (coloredAll >= PURPLE_MIN_COLORED && purpleOfColored >= PURPLE_OF_COLORED)) {
    issues.push({
      rule: "purple-dominant",
      hard: true,
      what: "Purple and indigo own the picture: " + pct(purpleAll) + " of every pixel and " + pct(purpleOfColored) + " of the colored ones.",
      fix: "Take the palette from the subject (its product, place or material) and keep purple to one small accent or drop it.",
      where,
      source: "frames",
      measured: { purpleShare: round(purpleAll), purpleOfColored: round(purpleOfColored) },
    });
  }
  const darkAll = mean(frames.map((f) => f.dark));
  const cyanAll = mean(frames.map((f) => f.cyan));
  const cyanOfColored = coloredAll > 0 ? cyanAll / coloredAll : 0;
  if (darkAll >= CYAN_DARK_SHARE && coloredAll >= CYAN_MIN_COLORED && cyanOfColored >= CYAN_OF_COLORED) {
    issues.push({
      rule: "cyan-on-black",
      hard: true,
      what: "The picture is neon cyan on near black: " + pct(darkAll) + " of it is black and " + pct(cyanOfColored) + " of the color is cyan.",
      fix: "Give the background a real tone (a paper, a material, a place) and choose an accent that comes from the subject.",
      where,
      source: "frames",
      measured: { darkShare: round(darkAll), cyanOfColored: round(cyanOfColored) },
    });
  }
  const vividFrames = frames.filter((f) => f.vivid >= VIVID_SHARE).length / frames.length;
  if (vividFrames >= VIVID_FRAMES) {
    issues.push({
      rule: "oversaturated",
      hard: false,
      what: "Full strength color covers most of the picture in " + pct(vividFrames) + " of the frames, so nothing stands out.",
      fix: "Mute the large areas (lower their saturation or darken them) and keep full strength color for the one thing that matters.",
      where,
      source: "frames",
      measured: { vividFrames: round(vividFrames), vividShare: round(mean(frames.map((f) => f.vivid))) },
    });
  }
  return issues;
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

// -------------------------------------------------------------- video checks

// sceneStartsMs: scene starts known from the saved source (an animation's
// scene list). Without them, scenes are the cuts found in the picture.
function sceneRanges(durationS, cuts, sceneStartsMs) {
  const hinted = (Array.isArray(sceneStartsMs) ? sceneStartsMs : []).map((ms) => Number(ms) / 1000).filter((s) => Number.isFinite(s) && s >= 0 && s < durationS);
  const marks = (hinted.length >= 2 ? hinted : [0].concat(cuts)).slice().sort((a, b) => a - b);
  if (marks[0] > 0.2) marks.unshift(0);
  const ranges = [];
  for (let i = 0; i < marks.length; i += 1) {
    const from = marks[i];
    const to = i + 1 < marks.length ? marks[i + 1] : durationS;
    if (to - from >= 0.4) ranges.push({ from, to });
  }
  return ranges;
}

function videoIssues(frames, fps, opts) {
  const issues = [];
  const diag = {};
  const durationS = frames.length / fps;
  const where = "the whole video";
  issues.push(...colorIssues(frames, where));

  const diffs = [];
  for (let i = 1; i < frames.length; i += 1) diffs.push(lumaDiff(frames[i - 1].luma, frames[i].luma));
  const cuts = detectCuts(frames, fps);
  const scenes = sceneRanges(durationS, cuts, opts && opts.sceneStartsMs);

  // The same light in every scene.
  if (scenes.length >= LIGHT_MIN_SCENES) {
    const per = scenes.map((scene) => {
      const pad = (scene.to - scene.from) * 0.15;
      const from = Math.floor((scene.from + pad) * fps);
      const to = Math.max(from + 1, Math.ceil((scene.to - pad) * fps));
      const part = frames.slice(from, Math.min(frames.length, to));
      if (!part.length) return null;
      const palette = new Float32Array(13);
      for (const f of part) for (let k = 0; k < 13; k += 1) palette[k] += f.palette[k] / part.length;
      return { luma: mean(part.map((f) => f.meanLuma)), palette };
    }).filter(Boolean);
    if (per.length >= LIGHT_MIN_SCENES) {
      const lumas = per.map((s) => s.luma);
      const lumaRange = Math.max(...lumas) - Math.min(...lumas);
      let dist = 0;
      for (let a = 0; a < per.length; a += 1) for (let b = a + 1; b < per.length; b += 1) dist = Math.max(dist, paletteDist(per[a].palette, per[b].palette));
      diag.lightLumaRange = round(lumaRange);
      diag.lightPaletteDistance = round(dist);
      if (lumaRange < LIGHT_LUMA_RANGE && dist < LIGHT_PALETTE_DIST) {
        issues.push({
          rule: "same-light",
          hard: false,
          what: "All " + per.length + " scenes have the same brightness and the same palette, so the light never changes.",
          fix: "Give one scene a different light: a darker or lighter background, a second palette color, or a full bleed image for the key beat.",
          where: per.length + " scenes",
          source: "frames",
          measured: { scenes: per.length, lumaRange: round(lumaRange), paletteDistance: round(dist) },
        });
      }
    }
  }

  // Everything centered and symmetric.
  const judged = frames.map((f) => f.layout).filter(Boolean);
  diag.judgedFrames = round(judged.length / frames.length);
  diag.centeredFrames = judged.length ? round(judged.filter((l) => l.centered).length / judged.length) : null;
  if (durationS >= CENTER_MIN_SECONDS && judged.length / frames.length >= CENTER_MIN_JUDGED) {
    const centered = judged.filter((l) => l.centered).length / judged.length;
    if (centered >= CENTER_FRAMES) {
      issues.push({
        rule: "all-centered",
        hard: false,
        what: "Everything sits centered and symmetric in " + pct(centered) + " of the frames.",
        fix: "Move at least one beat off the axis: anchor the type to the left edge or a corner, or let an element run off the frame.",
        where,
        source: "frames",
        measured: { centeredFrames: round(centered), judgedFrames: round(judged.length / frames.length) },
      });
    }
  }

  // A picture that never moves, or never rests.
  if (diffs.length) {
    const still = diffs.filter((d) => d < STILL_DIFF).length / diffs.length;
    let rest = 0;
    let run = 0;
    for (const d of diffs) {
      run = d < STILL_DIFF ? run + 1 : 0;
      if (run > rest) rest = run;
    }
    const longestRestS = rest / fps;
    diag.stillShare = round(still);
    diag.longestRestSeconds = round(longestRestS);
    if (durationS >= STATIC_MIN_SECONDS && still >= STATIC_SHARE) {
      issues.push({
        rule: "static-picture",
        hard: false,
        what: "The picture does not move for " + pct(still) + " of the " + secs(durationS) + " runtime.",
        fix: "Give the long holds motion that carries meaning: bring points in one at a time, move the camera across the layout, or cut the hold shorter.",
        where,
        source: "frames",
        measured: { stillShare: round(still), seconds: round(durationS) },
      });
    }
    // "Motion that never rests" was measured here and dropped: on real renders
    // it fired on every clip with a slow push-in (which the renderer adds to
    // long holds itself) or a drifting background, and frame differences
    // cannot tell that from nervous motion. longestRestSeconds stays in the
    // stats for anyone who wants to look.
  }

  // Cuts on a metronome.
  if (cuts.length + 1 >= EVEN_MIN_GAPS) {
    const marks = [0].concat(cuts, [durationS]);
    const gaps = [];
    for (let i = 1; i < marks.length; i += 1) gaps.push(marks[i] - marks[i - 1]);
    const shortest = Math.min(...gaps);
    const longest = Math.max(...gaps);
    if (gaps.length >= EVEN_MIN_GAPS && shortest > 0.3 && longest < shortest * EVEN_RATIO) {
      issues.push({
        rule: "even-cuts",
        // The same line the plan check draws (pacing-lint): near-equal
        // scenes are enough on their own, a small spread is one tell.
        hard: longest < shortest * 1.15,
        what: "The " + cuts.length + " cuts are evenly spaced: every scene runs " + secs(shortest) + " to " + secs(longest) + ".",
        fix: "Vary the scene lengths: hold the key beat at least twice as long as the shortest scene and make one beat short.",
        where: "cuts at " + cuts.map((c) => secs(c)).join(", "),
        source: "frames",
        measured: { cuts: cuts.map(round), shortest: round(shortest), longest: round(longest) },
      });
    }
  }
  return { issues, cuts, scenes: scenes.length, durationS, diag };
}

// --------------------------------------------------------------------- sound

// Momentary loudness (400 ms window, one reading per 100 ms) from ebur128.
function loudnessSeries(ffmpeg, file, signal) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(ffmpeg, ["-hide_banner", "-nostdin", "-i", file, "-vn", "-af", "ebur128", "-f", "null", "-"], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    } catch (error) {
      return resolve({ error: String((error && error.message) || error) });
    }
    const values = [];
    let tail = "";
    let last = "";
    const timer = setTimeout(() => child.kill(), DECODE_TIMEOUT_MS);
    const onAbort = () => child.kill();
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    child.stderr.on("data", (chunk) => {
      const text = tail + String(chunk);
      const lines = text.split(/\r?\n/);
      tail = lines.pop() || "";
      for (const line of lines) {
        const m = /\bM:\s*(-?\d+(?:\.\d+)?)\s+S:/.exec(line);
        if (m) values.push(Number(m[1]));
      }
      last = (last + String(chunk)).slice(-3000);
    });
    const done = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      const integrated = [...last.matchAll(/I:\s*(-?\d+(?:\.\d+)?) LUFS/g)].map((m) => Number(m[1])).pop();
      const range = [...last.matchAll(/LRA:\s*(-?\d+(?:\.\d+)?) LU/g)].map((m) => Number(m[1])).pop();
      resolve({ values, integrated: Number.isFinite(integrated) ? integrated : null, range: Number.isFinite(range) ? range : null });
    };
    child.on("error", done);
    child.on("close", done);
  });
}

function audioIssues(series) {
  // The first readings are the meter filling its window.
  const values = (series.values || []).slice(4);
  const seconds = values.length / 10;
  if (seconds < FLAT_MIN_SECONDS) return { issues: [], seconds, measured: false };
  const loudest = Math.max(...values);
  // Silence is audio-probe's business, not a flat level.
  if (!Number.isFinite(loudest) || loudest < -50) return { issues: [], seconds, measured: false };
  const sorted = values.slice().sort((a, b) => a - b);
  const median = quantile(sorted, 0.5);
  const spread = quantile(sorted, 0.95) - quantile(sorted, 0.05);
  const head = mean(values.slice(0, 10));
  const foot = mean(values.slice(-10));
  const issues = [];
  if (spread < FLAT_SPREAD_LU && Math.abs(head - median) < FLAT_EDGE_LU && Math.abs(foot - median) < FLAT_EDGE_LU) {
    issues.push({
      rule: "flat-audio",
      hard: false,
      what: "The sound stays at one level for all " + secs(seconds) + ": loudness moves only " + (Math.round(spread * 10) / 10) + " LU and there is no fade in or out.",
      fix: "Shape the sound: fade the bed in and out, duck it under the voice, and lift it for the key beat.",
      where: "the whole soundtrack",
      source: "audio",
      measured: { spreadLu: round(spread), medianLufs: round(median), seconds: round(seconds) },
    });
  }
  return { issues, seconds, measured: true, spread, median };
}

// ----------------------------------------------------------------- text time

// entries: [{ text, durationMs, where }] from the saved source (a burned-in
// text and its window, a scene's words and its length).
function checkTextTiming(entries, opts) {
  const issues = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const text = String((entry && entry.text) || "").replace(/\s+/g, " ").trim();
    const durationMs = Number(entry && entry.durationMs);
    if (!text || !Number.isFinite(durationMs) || durationMs <= 0) continue;
    const words = text.split(" ").filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
    if (words < 3) continue;
    const needMs = READ_BASE_MS + words * READ_PER_WORD_MS;
    if (durationMs >= needMs * READ_SLACK) continue;
    issues.push({
      rule: "text-too-brief",
      hard: true,
      what: "The " + words + " words \"" + (text.length > 60 ? text.slice(0, 57) + "..." : text) + "\" are on screen for " + secs(durationMs / 1000) + ", and reading them takes about " + secs(needMs / 1000) + ".",
      fix: "Hold it for at least " + secs(needMs / 1000) + ", or cut it to " + Math.max(2, Math.floor((durationMs / READ_SLACK - READ_BASE_MS) / READ_PER_WORD_MS)) + " words or fewer.",
      where: String((entry && entry.where) || "on screen text"),
      source: "pacing",
      measured: { words, durationMs: Math.round(durationMs), needMs: Math.round(needMs) },
    });
  }
  return keep(issues, opts);
}

// ------------------------------------------------------------------- entries

// A finished video or clip: picture checks and, when it has sound, the level
// over time. opts: { ffmpeg, sceneStartsMs, generated, asked, allow, signal,
// audio (false to skip the sound) }.
async function checkFrames(file, opts) {
  const options = opts || {};
  const out = { ok: true, issues: [], checked: [], skipped: [], stats: {} };
  const skip = (what, why) => out.skipped.push({ check: what, why });
  const ffmpeg = options.ffmpeg || findFfmpeg();
  if (!ffmpeg) {
    skip("frames", "ffmpeg is not installed on this computer");
    return out;
  }
  let stat = null;
  try {
    stat = fs.statSync(file);
  } catch {
    /* reported below */
  }
  if (!stat || !stat.isFile() || !stat.size) {
    skip("frames", "the rendered file is missing or empty");
    return out;
  }
  const media = await probe(ffmpeg, file, options.signal);
  if (options.signal && options.signal.aborted) return Object.assign(out, { aborted: true });
  if (!media.hasVideo || !media.width || !media.height) {
    skip("frames", "ffmpeg found no picture in the file");
  } else {
    const durationS = Math.max(0.04, (media.durationMs || 0) / 1000);
    const fps = Math.max(1, Math.min(MAX_FPS, Math.floor(MAX_FRAMES / durationS) || 1));
    const w = WIDTH;
    const h = even((WIDTH * media.height) / media.width);
    const frames = [];
    const args = ["-hide_banner", "-nostdin", "-loglevel", "error", "-i", file, "-an", "-vf", "fps=" + fps + ",scale=" + w + ":" + h + ":flags=area", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"];
    const decoded = await decode(ffmpeg, args, w * h * 3, (buf) => {
      if (frames.length < MAX_FRAMES) frames.push(frameStats(buf, w, h, 3));
    }, options.signal);
    if (decoded.aborted) return Object.assign(out, { aborted: true });
    if (!frames.length) {
      skip("frames", decoded.error || "ffmpeg decoded no frames from the file");
    } else {
      const video = videoIssues(frames, fps, options);
      out.issues.push(...video.issues);
      out.checked.push("frames (" + frames.length + " frames at " + fps + " fps, " + video.cuts.length + " cuts)");
      out.stats.frames = frames.length;
      out.stats.fps = fps;
      out.stats.seconds = round(video.durationS);
      out.stats.cuts = video.cuts.map(round);
      out.stats.scenes = video.scenes;
      out.stats.purple = round(mean(frames.map((f) => f.purple)));
      out.stats.colored = round(mean(frames.map((f) => f.colored)));
      out.stats.dark = round(mean(frames.map((f) => f.dark)));
      out.stats.vivid = round(mean(frames.map((f) => f.vivid)));
      Object.assign(out.stats, video.diag);
    }
  }
  if (options.audio === false) {
    /* the caller asked for the picture only */
  } else if (!media.hasAudio) {
    skip("audio", "the file has no sound");
  } else {
    const series = await loudnessSeries(ffmpeg, file, options.signal);
    if (options.signal && options.signal.aborted) return Object.assign(out, { aborted: true });
    if (series.error || !series.values || !series.values.length) skip("audio", series.error || "ffmpeg read no loudness from the file");
    else {
      const audio = audioIssues(series);
      if (!audio.measured) skip("audio", audio.seconds < FLAT_MIN_SECONDS ? "the sound is shorter than " + FLAT_MIN_SECONDS + " s" : "the sound is silent");
      else {
        out.issues.push(...audio.issues);
        out.checked.push("audio (loudness over " + secs(audio.seconds) + ")");
        out.stats.loudnessSpreadLu = round(audio.spread);
      }
    }
  }
  out.issues = keep(out.issues, options);
  out.ok = out.issues.length === 0;
  return out;
}

// A still (a card's PNG): the color checks only.
async function checkStill(file, opts) {
  const options = opts || {};
  const out = { ok: true, issues: [], checked: [], skipped: [], stats: {} };
  const ffmpeg = options.ffmpeg || findFfmpeg();
  if (!ffmpeg) {
    out.skipped.push({ check: "frames", why: "ffmpeg is not installed on this computer" });
    return out;
  }
  if (!fs.existsSync(file)) {
    out.skipped.push({ check: "frames", why: "the rendered picture is missing" });
    return out;
  }
  const media = await probe(ffmpeg, file, options.signal);
  if (!media.width || !media.height) {
    out.skipped.push({ check: "frames", why: "ffmpeg could not read the picture" });
    return out;
  }
  const w = WIDTH;
  const h = even((WIDTH * media.height) / media.width);
  const frames = [];
  const args = ["-hide_banner", "-nostdin", "-loglevel", "error", "-i", file, "-frames:v", "1", "-vf", "scale=" + w + ":" + h + ":flags=area", "-pix_fmt", "rgba", "-f", "rawvideo", "-"];
  const decoded = await decode(ffmpeg, args, w * h * 4, (buf) => {
    if (!frames.length) frames.push(frameStats(buf, w, h, 4));
  }, options.signal);
  if (decoded.aborted) return Object.assign(out, { aborted: true });
  if (!frames.length) {
    out.skipped.push({ check: "frames", why: decoded.error || "ffmpeg decoded nothing from the picture" });
    return out;
  }
  if (frames[0].opaque < 0.2) {
    out.skipped.push({ check: "frames", why: "the picture is mostly see-through, so its color is the footage under it" });
    return out;
  }
  out.issues = keep(colorIssues(frames, "the card"), options);
  out.checked.push("frames (1 still)");
  out.stats = { purple: round(frames[0].purple), colored: round(frames[0].colored), dark: round(frames[0].dark), vivid: round(frames[0].vivid) };
  out.ok = out.issues.length === 0;
  return out;
}

module.exports = {
  checkFrames,
  checkStill,
  checkTextTiming,
  askedFor,
  findFfmpeg,
  // for the test runner and for tuning
  _internal: { frameStats, detectCuts, audioIssues, loudnessSeries, layoutOf, sceneRanges },
};
