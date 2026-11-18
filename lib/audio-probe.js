"use strict";

// Reads what a clip or a render actually sounds like. The agent could check
// pictures (jeditor_preview_frames) but had no way to hear anything, so a
// silent render, a clipped mix, or an overlay that never got attached all
// looked like success. One ffmpeg pass reports the level, the peaks, and the
// silent stretches; the stream table reports whether there is audio at all.

const { spawn } = require("node:child_process");
const fs = require("node:fs");

const RUN_TIMEOUT_MS = 120000;
const NOISE_DB = -50;
const MIN_SILENCE_S = 0.35;
const MAX_SILENCES = 40;

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// ffmpeg prints every measurement to stderr while writing nothing.
function runAnalyse(ffmpeg, file, filter) {
  return new Promise((resolve) => {
    if (!file) return resolve({ stderr: "", missing: true });
    let stat = null;
    try {
      stat = fs.statSync(file);
    } catch {
      /* reported below */
    }
    if (!stat || !stat.isFile()) return resolve({ stderr: "", missing: true });
    if (!stat.size) return resolve({ stderr: "", empty: true });
    const child = spawn(
      ffmpeg,
      ["-hide_banner", "-nostdin", "-i", file, "-af", filter, "-f", "null", "-"],
      { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      done({ stderr, timedOut: true });
    }, RUN_TIMEOUT_MS);
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 400000) stderr = stderr.slice(-200000);
    });
    child.on("error", (error) => done({ stderr, error }));
    child.on("close", () => done({ stderr }));
  });
}

// The stream table: whether a real audio stream exists, how long, how wide.
function readStreams(stderr) {
  const audio = /Audio:\s*([^\n]*)/.exec(stderr);
  const duration = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  const stream = audio ? audio[1] : "";
  // ffmpeg names 1 and 2 channels mono/stereo and counts the rest.
  const counted = /(\d+) channels/.exec(stream);
  const named = /\bmono\b/.test(stream) ? 1 : /\bstereo\b/.test(stream) ? 2 : 0;
  const rate = /(\d+) Hz/.exec(stream);
  return {
    hasAudio: Boolean(audio),
    codec: stream ? (stream.split(",")[0] || "").trim() : "",
    channels: counted ? Number(counted[1]) : named,
    sampleRate: rate ? Number(rate[1]) : 0,
    durationMs: duration
      ? Math.round((Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])) * 1000)
      : 0,
  };
}

function readLevels(stderr) {
  const mean = /mean_volume:\s*(-?[\d.]+|-inf) dB/.exec(stderr);
  const peak = /max_volume:\s*(-?[\d.]+|-inf) dB/.exec(stderr);
  const parse = (match) => {
    if (!match) return null;
    return match[1] === "-inf" ? -Infinity : Number(match[1]);
  };
  return { meanDbfs: parse(mean), peakDbfs: parse(peak) };
}

function readSilences(stderr) {
  const spans = [];
  let open = null;
  for (const line of String(stderr).split(/\r?\n/)) {
    const start = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (start) {
      open = Math.max(0, Number(start[1]));
      continue;
    }
    const end = /silence_end:\s*(-?[\d.]+)/.exec(line);
    if (end && open != null) {
      spans.push({ start: open, end: Number(end[1]) });
      open = null;
    }
    if (spans.length >= MAX_SILENCES) break;
  }
  const end = /silence_end:\s*(-?[\d.]+)/.exec(stderr);
  if (open != null && !end) spans.push({ start: open, end: null });
  return spans.map((span) => ({
    start: Number(span.start.toFixed(3)),
    end: span.end == null ? null : Number(span.end.toFixed(3)),
    seconds: span.end == null ? null : Number((span.end - span.start).toFixed(3)),
  }));
}

// Level and silence in one pass; a second pass only for the rare file ffmpeg
// refuses to filter (no audio stream at all). A file that could not be read is
// never reported as silence: "silent" on an unreadable path would let an agent
// sign off on a render it never measured.
async function probeAudio(ffmpeg, file, options) {
  if (!ffmpeg) throw new Error("ffmpeg is not installed. Reading audio needs ffmpeg on this computer.");
  const opts = options || {};
  const noise = clampNumber(opts.noiseDbfs, -90, -10, NOISE_DB);
  const minSilence = clampNumber(opts.minSilenceSeconds, 0.05, 10, MIN_SILENCE_S);
  const filter = "volumedetect,silencedetect=noise=" + noise + "dB:d=" + minSilence;
  const pass = await runAnalyse(ffmpeg, file, filter);
  if (pass.missing || pass.empty) {
    return {
      file: String(file || ""),
      exists: false,
      readable: false,
      hasAudio: false,
      silent: null,
      error: pass.empty ? "The media file is empty." : "The media file is missing.",
      durationMs: 0,
      codec: "",
      channels: 0,
      sampleRate: 0,
      meanDbfs: null,
      peakDbfs: null,
      silences: [],
      clipped: false,
      headroomDb: null,
      noiseFloorDbfs: noise,
    };
  }
  const streams = readStreams(pass.stderr);
  const levels = readLevels(pass.stderr);
  const result = {
    file: String(file || ""),
    exists: true,
    readable: true,
    error: "",
    hasAudio: streams.hasAudio,
    silent: null,
    durationMs: streams.durationMs,
    codec: streams.codec,
    channels: streams.channels,
    sampleRate: streams.sampleRate,
    meanDbfs: levels.meanDbfs,
    peakDbfs: levels.peakDbfs,
    silences: streams.hasAudio ? readSilences(pass.stderr) : [],
    noiseFloorDbfs: noise,
  };
  if (result.hasAudio && result.meanDbfs == null) {
    // Some containers need the analysis split out of one chain.
    const level = await runAnalyse(ffmpeg, file, "volumedetect");
    const again = readLevels(level.stderr);
    result.meanDbfs = again.meanDbfs;
    result.peakDbfs = again.peakDbfs;
  }
  if (!result.hasAudio) {
    // A stream table ffmpeg never printed means the container was unreadable.
    // Report that instead of claiming the clip is silent.
    const broken = /Invalid data found|moov atom not found|Error opening input|does not contain any stream/i.test(pass.stderr);
    if (broken && !/Duration:/.test(pass.stderr)) {
      result.readable = false;
      result.error = "ffmpeg could not read this file.";
    }
    result.silent = result.readable ? true : null;
  } else {
    result.silent =
      result.meanDbfs == null || result.meanDbfs === -Infinity || result.meanDbfs < noise;
  }
  if (result.peakDbfs != null && Number.isFinite(result.peakDbfs)) {
    result.clipped = result.peakDbfs >= -0.2;
    result.headroomDb = Number((-result.peakDbfs).toFixed(1));
  } else {
    result.clipped = false;
    result.headroomDb = null;
  }
  return result;
}

// A one-line read for agents and logs.
function audioSummary(probe) {
  if (!probe) return "no audio reading";
  if (probe.silent === null) return "audio could not be read" + (probe.error ? " (" + probe.error + ")" : "");
  if (!probe.hasAudio) return "no audio stream";
  const mean =
    probe.meanDbfs == null || !Number.isFinite(probe.meanDbfs) ? "silent" : probe.meanDbfs.toFixed(1) + " dB mean";
  const peak = probe.peakDbfs == null || !Number.isFinite(probe.peakDbfs) ? "" : ", " + probe.peakDbfs.toFixed(1) + " dB peak";
  const quiet = probe.silences && probe.silences.length ? ", " + probe.silences.length + " silent stretch(es)" : "";
  return mean + peak + quiet;
}

module.exports = { probeAudio, audioSummary, NOISE_DB, MIN_SILENCE_S };
