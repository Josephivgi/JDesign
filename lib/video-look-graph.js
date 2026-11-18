"use strict";

// ffmpeg graphs for a project's look: every kept part is framed into the
// project's ratio (fill crop at a focus point, or fit with a blurred
// background), camera moves become crops (punch) or eased zoompan (push,
// pan), and texts, flashes, letterbox, and fades draw on the joined video.
// Pure string building; video-render.js writes the text files and runs it.

const fs = require("fs");
const path = require("path");
const look = require("./video-frame");

function sec(ms) {
  return (ms / 1000).toFixed(3);
}

function n4(v) {
  return Number(v.toFixed(4)).toString();
}

function even(v) {
  return Math.max(2, Math.round(v / 2) * 2);
}

function pathArg(file) {
  return "'" + String(file).replace(/\\/g, "/").replace(/:/g, "\\:") + "'";
}

function atempoChain(rate) {
  const parts = [];
  let left = rate;
  while (left > 2) {
    parts.push("atempo=2.0");
    left /= 2;
  }
  while (left < 0.5) {
    parts.push("atempo=0.5");
    left /= 0.5;
  }
  parts.push("atempo=" + left.toFixed(4));
  return parts.join(",");
}

function backgroundChain(inLabel, outLabel, size, background) {
  if (background === "black") {
    return (
      "[" + inLabel + "]scale=" + size.w + ":" + size.h + ":force_original_aspect_ratio=increase,crop=" + size.w + ":" + size.h +
      ",drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill,setsar=1[" + outLabel + "]"
    );
  }
  // Blur at 1/8 size, then scale up: cheap and smooth at any frame size.
  const bw = even(size.w / 8);
  const bh = even(size.h / 8);
  return (
    "[" + inLabel + "]scale=" + bw + ":" + bh + ":force_original_aspect_ratio=increase,crop=" + bw + ":" + bh +
    ",boxblur=6:2,scale=" + size.w + ":" + size.h + ",eq=brightness=-0.06,setsar=1[" + outLabel + "]"
  );
}

// One source window -> one frame of `size`. Inside the picture it is a crop
// and a scale; past an edge (fit) the visible part sits on a background.
function frameChain(inLabel, outLabel, rect, src, size, background, tag) {
  if (look.rectInside(rect, src)) {
    const w = Math.max(2, Math.min(src.w, Math.round(rect.w)));
    const h = Math.max(2, Math.min(src.h, Math.round(rect.h)));
    const x = Math.max(0, Math.min(src.w - w, Math.round(rect.x)));
    const y = Math.max(0, Math.min(src.h - h, Math.round(rect.y)));
    return [
      "[" + inLabel + "]crop=" + w + ":" + h + ":" + x + ":" + y + ",scale=" + size.w + ":" + size.h + ":flags=lanczos,setsar=1[" + outLabel + "]",
    ];
  }
  const k = size.w / rect.w;
  const ix = Math.max(0, rect.x);
  const iy = Math.max(0, rect.y);
  const iw = Math.min(src.w, rect.x + rect.w) - ix;
  const ih = Math.min(src.h, rect.y + rect.h) - iy;
  const cw = Math.max(2, Math.min(src.w, Math.round(iw)));
  const ch = Math.max(2, Math.min(src.h, Math.round(ih)));
  const cx = Math.max(0, Math.min(src.w - cw, Math.round(ix)));
  const cy = Math.max(0, Math.min(src.h - ch, Math.round(iy)));
  const sw = Math.min(size.w, even(iw * k));
  const sh = Math.min(size.h, even(ih * k));
  const px = Math.max(0, Math.min(size.w - sw, Math.round((ix - rect.x) * k)));
  const py = Math.max(0, Math.min(size.h - sh, Math.round((iy - rect.y) * k)));
  return [
    "[" + inLabel + "]split=2[" + tag + "a][" + tag + "b]",
    backgroundChain(tag + "a", tag + "g", size, background),
    "[" + tag + "b]crop=" + cw + ":" + ch + ":" + cx + ":" + cy + ",scale=" + sw + ":" + sh + ":flags=lanczos,setsar=1[" + tag + "f]",
    "[" + tag + "g][" + tag + "f]overlay=" + px + ":" + py + ",setsar=1[" + outLabel + "]",
  ];
}

function unionRect(a, b, aspect) {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  let w = Math.max(a.x + a.w, b.x + b.w) - x0;
  let h = Math.max(a.y + a.h, b.y + b.h) - y0;
  const cx = x0 + w / 2;
  const cy = y0 + h / 2;
  if (w / h > aspect) h = w / aspect;
  else w = h * aspect;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

// Push and pan: frame the union of the start and end windows onto a canvas
// up to 2x the output (so zoompan's whole-pixel steps stay smooth), then ease
// zoompan from the start window to the end one. Progress runs in source time
// so a move cut in two by a removed range still eases as one.
function moveChain(inLabel, outLabel, rects, src, size, background, tag, prog) {
  const aspect = size.w / size.h;
  const u = unionRect(rects.from, rects.to, aspect);
  let ss = Math.max(1, Math.min(2, u.w / Math.max(1, Math.min(rects.from.w, rects.to.w))));
  if (Math.max(size.w, size.h) * ss > 3840) ss = 3840 / Math.max(size.w, size.h);
  const canvas = { w: even(size.w * Math.max(1, ss)), h: even(size.h * Math.max(1, ss)) };
  const chain = frameChain(inLabel, tag + "u", u, src, canvas, background, tag + "s");
  const p = "clip((" + n4(prog.offsetSec) + "+on/" + prog.fps + "*" + n4(prog.rate) + ")/" + n4(prog.durSec) + "\\,0\\,1)";
  const e = "(" + p + "*" + p + "*(3-2*" + p + "))";
  const f = rects.from;
  const t = rects.to;
  const rw = "(" + n4(f.w) + "+" + n4(t.w - f.w) + "*" + e + ")";
  const z = n4(u.w) + "/" + rw;
  const kx = canvas.w / u.w;
  const ky = canvas.h / u.h;
  const x = "((" + n4(f.x) + "+" + n4(t.x - f.x) + "*" + e + ")-" + n4(u.x) + ")*" + n4(kx);
  const y = "((" + n4(f.y) + "+" + n4(t.y - f.y) + "*" + e + ")-" + n4(u.y) + ")*" + n4(ky);
  chain.push(
    "[" + tag + "u]zoompan=z=" + z + ":x=" + x + ":y=" + y + ":d=1:s=" + size.w + "x" + size.h + ":fps=" + prog.fps + ",setsar=1[" + outLabel + "]",
  );
  return chain;
}

// Each kept segment split at camera-move edges. Edges closer than 80ms to a
// segment edge are dropped so no piece is shorter than a couple of frames.
function renderPieces(segments, camera) {
  const pieces = [];
  for (const seg of segments) {
    const marks = [seg.startMs];
    for (const m of camera) {
      for (const edge of [m.startMs, m.endMs]) {
        if (edge > seg.startMs + 80 && edge < seg.endMs - 80) marks.push(edge);
      }
    }
    marks.push(seg.endMs);
    const sorted = Array.from(new Set(marks)).sort((a, b) => a - b);
    for (let i = 0; i < sorted.length - 1; i += 1) {
      const a = sorted[i];
      const b = sorted[i + 1];
      if (b - a < 40) continue;
      const mid = (a + b) / 2;
      const move = camera.find((m) => mid >= m.startMs && mid < m.endMs) || null;
      pieces.push({ startMs: a, endMs: b, rate: Number(seg.speed) || 1, move });
    }
  }
  return pieces;
}

function textStyleArgs(style, size) {
  if (style === "caption") {
    return ":fontcolor=white:box=1:boxcolor=black@0.62:boxborderw=" + Math.round(size * 0.3);
  }
  if (style === "bubbly") {
    return ":fontcolor=0x111111:box=1:boxcolor=white@0.95:boxborderw=" + Math.round(size * 0.34);
  }
  return (
    ":fontcolor=white:borderw=" + Math.max(2, Math.round(size * 0.09)) + ":bordercolor=black@0.9:shadowcolor=black@0.45:shadowx=0:shadowy=" +
    Math.max(1, Math.round(size * 0.06))
  );
}

// drawtext filters for prepared text entries. Each entry carries its lines'
// text files, layout, and output-time ranges. `still` draws every entry
// without timing, for single preview frames.
function textFilters(entries, font, opts) {
  const still = Boolean(opts && opts.still);
  const out = [];
  for (const entry of entries) {
    const ranges = still ? [null] : entry.ranges;
    for (const range of ranges) {
      entry.lines.forEach((line, i) => {
        const yBase = entry.top + i * entry.lineH;
        let y = String(yBase);
        let timing = "";
        if (range) {
          const a = n4(range.startMs / 1000);
          const b = n4(range.endMs / 1000);
          timing = ":enable='between(t," + a + "," + b + ")'";
          if (entry.anim !== "none") {
            timing += ":alpha='clip(min((t-" + a + ")/0.18,(" + b + "-t)/0.18),0,1)'";
          }
          if (entry.anim === "slide") {
            y = "'" + yBase + "+" + Math.round(entry.size * 0.6) + "*(1-clip((t-" + a + ")/0.25,0,1))'";
          }
        }
        out.push(
          "drawtext=" + (font ? "fontfile=" + pathArg(font) + ":" : "") + "textfile=" + pathArg(line.file) +
            ":expansion=none:fontsize=" + entry.size + textStyleArgs(entry.style, entry.size) +
            ":x='" + entry.cx + "-text_w/2':y=" + y + timing,
        );
      });
    }
  }
  return out;
}

// Lay out every text, map it to output time, and write one file per line
// (textfile sidesteps drawtext escaping for quotes, colons, and percents).
// Texts that sit entirely inside a cut are dropped.
function prepareTexts(drawTexts, size, segments, dir, opts) {
  const still = opts && opts.atMs != null ? opts.atMs : null;
  const entries = [];
  drawTexts.forEach((t, index) => {
    if (still != null && (still < t.startMs || still >= t.endMs)) return;
    const ranges = still != null ? [] : look.sourceToOutputRanges(segments, t.startMs, t.endMs);
    if (still == null && !ranges.length) return;
    const lay = look.layoutText(t, size);
    const lines = lay.lines.map((text, i) => {
      const file = path.join(dir, "text-" + index + "-" + i + ".txt");
      if (dir) fs.writeFileSync(file, text, "utf8");
      return { text, file };
    });
    entries.push(Object.assign({}, lay, { style: t.style, anim: t.anim, ranges, lines }));
  });
  return entries;
}

function letterboxFilters(size) {
  const bar = Math.round(size.h * 0.12);
  return [
    "drawbox=x=0:y=0:w=iw:h=" + bar + ":color=black:t=fill",
    "drawbox=x=0:y=ih-" + bar + ":w=iw:h=" + bar + ":color=black:t=fill",
  ];
}

function flashFilters(flashes, segments) {
  const out = [];
  for (const at of flashes) {
    const o = look.sourceToOutputMs(segments, at);
    if (o == null) continue;
    const a = o / 1000;
    out.push("drawbox=x=0:y=0:w=iw:h=ih:color=white@0.85:t=fill:enable='between(t," + n4(a) + "," + n4(a + 0.06) + ")'");
    out.push("drawbox=x=0:y=0:w=iw:h=ih:color=white@0.4:t=fill:enable='between(t," + n4(a + 0.06) + "," + n4(a + 0.16) + ")'");
  }
  return out;
}

// plan: { source, outFile, hasAudio, audios, segments, src, size, fps, srcFps,
// look (from renderLook), texts (prepareTexts), font, outputMs }
function buildLookArgs(plan) {
  const { segments, src, size, fps } = plan;
  const lk = plan.look;
  const frame = look.normalizeFrame(lk.frame);
  // Trimming on a frame boundary, in seconds. `sec` alone cuts by a
  // millisecond that can land inside a frame, which shifts the trim by a frame
  // and leaves the kept parts a frame out of step with what the timeline says.
  // A known source rate makes the boundary exact: frame / rate.
  const srcFps = Number(plan.srcFps) || 0;
  const boundary = (value) => {
    const ms = Number(value) || 0;
    if (!(srcFps > 0)) return sec(ms);
    const frameNumber = Math.round((ms * srcFps) / 1000);
    return (frameNumber / srcFps).toFixed(6);
  };
  const filters = [];
  const pieces = renderPieces(segments, lk.camera || []);
  pieces.forEach((piece, i) => {
    const tag = "p" + i;
    filters.push(
      "[0:v]trim=start=" + boundary(piece.startMs) + ":end=" + boundary(piece.endMs) + ",setpts=(PTS-STARTPTS)/" + piece.rate + ",fps=" + fps + "[" + tag + "i]",
    );
    const move = piece.move;
    if (move && move.style !== "punch") {
      const rects = look.moveRects(lk, src, size, move);
      filters.push(
        ...moveChain(tag + "i", tag, rects, src, size, frame.background, tag, {
          offsetSec: (piece.startMs - move.startMs) / 1000,
          rate: piece.rate,
          durSec: Math.max(0.04, (move.endMs - move.startMs) / 1000),
          fps,
        }),
      );
    } else {
      const rect = look.rectAt(lk, src, size, (piece.startMs + piece.endMs) / 2);
      filters.push(...frameChain(tag + "i", tag, rect, src, size, frame.background, tag));
    }
  });
  filters.push(pieces.map((_, i) => "[p" + i + "]").join("") + "concat=n=" + pieces.length + ":v=1:a=0[vcat]");

  const post = [];
  if (lk.letterbox) post.push(...letterboxFilters(size));
  post.push(...flashFilters(lk.flashes || [], segments));
  post.push(...textFilters(plan.texts || [], plan.font));
  const totalSec = (plan.outputMs || 0) / 1000;
  const fades = lk.fades || {};
  if (fades.inMs) post.push("fade=t=in:st=0:d=" + n4(fades.inMs / 1000));
  if (fades.outMs && totalSec) post.push("fade=t=out:st=" + n4(Math.max(0, totalSec - fades.outMs / 1000)) + ":d=" + n4(fades.outMs / 1000));
  post.push("format=yuv420p");
  filters.push("[vcat]" + post.join(",") + "[vout]");

  // plan.audio = one library track, plan.audios = several (voiceover + music
  // bed). Each is laid over the whole cut. duck lowers the source audio under
  // them; loop repeats a short bed. Several tracks mix together without
  // attenuating: amix's default normalize=1 divides every input by the input
  // count, which made one voiceover 6 dB quieter than its own file.
  const audioTracks = Array.isArray(plan.audios) ? plan.audios.filter(Boolean) : plan.audio ? [plan.audio] : [];

  if (plan.hasAudio) {
    segments.forEach((seg, i) => {
      const rate = Number(seg.speed) || 1;
      let chain = "atrim=start=" + boundary(seg.startMs) + ":end=" + boundary(seg.endMs) + ",asetpts=PTS-STARTPTS," + atempoChain(rate);
      const gain = seg.muted === true ? 0 : seg.volume == null ? 1 : Number(seg.volume);
      if (Number.isFinite(gain) && gain !== 1) chain += ",volume=" + gain;
      filters.push("[0:a]" + chain + "[a" + i + "]");
    });
    let audioPost = "";
    if (fades.inMs) audioPost += ",afade=t=in:st=0:d=" + n4(fades.inMs / 1000);
    if (fades.outMs && totalSec) audioPost += ",afade=t=out:st=" + n4(Math.max(0, totalSec - fades.outMs / 1000)) + ":d=" + n4(fades.outMs / 1000);
    // With tracks to mix in, the source leg is the base they duck under.
    const baseLabel = audioTracks.length ? "abase" : "aout";
    filters.push(segments.map((_, i) => "[a" + i + "]").join("") + "concat=n=" + segments.length + ":v=0:a=1" + audioPost + "[" + baseLabel + "]");
  }

  const audioLabels = [];
  audioTracks.forEach((track, i) => {
    const vol = Number.isFinite(track.volume) && track.volume !== 1 ? ",volume=" + n4(track.volume) : "";
    const label = "vox" + (audioTracks.length === 1 ? "" : String(i));
    filters.push(
      "[" +
        (i + 1) +
        ":a]aresample=48000,aformat=channel_layouts=stereo,atrim=duration=" +
        n4(Math.max(0.05, totalSec)) +
        ",asetpts=PTS-STARTPTS" +
        vol +
        "[" +
        label +
        "]",
    );
    audioLabels.push("[" + label + "]");
  });
  if (audioTracks.length) {
    // The deepest duck wins: with a voiceover and a bed over the same source,
    // the source has to get out of the way of both.
    const ducks = audioTracks.map((track) => (track.duck == null || track.duck >= 1 ? 1 : track.duck));
    const duck = ducks.length ? Math.min.apply(null, ducks) : 1;
    if (plan.hasAudio) {
      let base = "abase";
      if (duck < 1) {
        filters.push("[abase]volume=" + n4(duck) + "[aduck]");
        base = "aduck";
      }
      filters.push(
        "[" + base + "]" + audioLabels.join("") + "amix=inputs=" + (audioLabels.length + 1) + ":duration=first:dropout_transition=0:normalize=0[aout]",
      );
    } else if (audioLabels.length === 1) {
      // Nothing to mix against: the track is the finished audio. A pass-through
      // keeps the single-track case on the graph it always had (no amix).
      filters.push(audioLabels[0] + "anull[aout]");
    } else {
      filters.push(audioLabels.join("") + "amix=inputs=" + audioLabels.length + ":duration=first:dropout_transition=0:normalize=0[aout]");
    }
  }
  const wantAudio = plan.hasAudio || audioTracks.length;
  // A render that mixes in a voiceover or a music bed lands at the social
  // loudness target; a source on its own keeps its own level, and only the
  // encode settings change for it.
  let audioOut = "aout";
  if (wantAudio && audioTracks.length) {
    filters.push("[" + audioOut + "]loudnorm=I=-14:TP=-1.5:LRA=11[aoutn]");
    audioOut = "aoutn";
  }

  const args = ["-y", "-hide_banner", "-i", plan.source];
  for (const track of audioTracks) {
    if (track.loop) args.push("-stream_loop", "-1");
    args.push("-i", track.file);
  }
  args.push("-filter_complex", filters.join(";"), "-map", "[vout]");
  // One audio format everywhere: 48 kHz stereo AAC. A 44.1 kHz mono source
  // used to carry its own rate and channel count into the finished file.
  if (wantAudio) args.push("-map", "[" + audioOut + "]", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2");
  // Delivery target: H.264 High 4.1, yuv420p, crf 18 at the veryfast preset.
  // crf 18 keeps small text and sharp edges intact where 20 smoothed them; the
  // preset is unchanged, so the render time does not move.
  args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-profile:v", "high", "-level", "4.1", "-pix_fmt", "yuv420p", "-r", String(fps));
  args.push("-movflags", "+faststart", plan.outFile);
  return args;
}

// One framed frame at a source moment, with the texts showing at that
// moment, scaled down for an agent to look at.
function buildStillArgs(plan) {
  const { src, size, atMs } = plan;
  const lk = plan.look;
  const frame = look.normalizeFrame(lk.frame);
  const rect = look.rectAt(lk, src, size, atMs);
  const filters = frameChain("0:v", "framed", rect, src, size, frame.background, "s");
  const post = [];
  if (lk.letterbox) post.push(...letterboxFilters(size));
  post.push(...textFilters(plan.texts || [], plan.font, { still: true }));
  post.push("scale=-2:" + (plan.height || 640), "format=yuvj420p");
  filters.push("[framed]" + post.join(",") + "[vout]");
  return [
    "-y", "-hide_banner", "-ss", sec(atMs), "-i", plan.source, "-filter_complex", filters.join(";"),
    "-map", "[vout]", "-frames:v", "1", "-q:v", "5", plan.outFile,
  ];
}

// The raw source frame with a quarter grid, so an agent can read focus
// points (x and y from 0 to 1) straight off the picture.
function buildSourceStillArgs(source, atMs, outFile) {
  return [
    "-y", "-hide_banner", "-ss", sec(atMs), "-i", source,
    "-vf", "scale=640:-2,drawgrid=w=iw/4:h=ih/4:t=2:c=white@0.55,format=yuvj420p",
    "-frames:v", "1", "-q:v", "5", outFile,
  ];
}

module.exports = {
  atempoChain,
  frameChain,
  moveChain,
  renderPieces,
  prepareTexts,
  textFilters,
  buildLookArgs,
  buildStillArgs,
  buildSourceStillArgs,
};
