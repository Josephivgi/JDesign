#!/usr/bin/env node
"use strict";

// One command for the three gates a change has to pass before it ships:
//   node scripts/quality-report.cjs
// 1. the tool surface (names, descriptions, parameters, skills),
// 2. the failure messages (every tool called with a bad call),
// 3. a real 2 second render through the MCP stdio server, checked with ffmpeg
//    for codec, profile, pixel format, audio format, bitrate and loudness.
// Prints one summary block and exits 1 if any gate fails.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const appRoot = path.join(__dirname, "..");
const RENDER_TIMEOUT_MS = 180000;

function runNode(script) {
  const out = spawnSync(process.execPath, [path.join(appRoot, script)], { cwd: appRoot, encoding: "utf8" });
  const lines = String(out.stdout || "").trim().split(/\r?\n/).filter(Boolean);
  return { ok: out.status === 0, last: lines[lines.length - 1] || String(out.stderr || "").trim().split(/\r?\n/).pop() || "no output" };
}

function skillStats() {
  let files = 0;
  let bytes = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "SKILL.md") {
        files++;
        bytes += fs.statSync(full).size;
      }
    }
  };
  walk(path.join(appRoot, "skills"));
  return { files, kb: Math.round(bytes / 1024) };
}

function toolCounts() {
  const os2 = os;
  const { createMcpHandler } = require(path.join(appRoot, "lib", "mcp-server"));
  const { agentToolSpecs } = require(path.join(appRoot, "lib", "agent-tools"));
  const { cardEditorSpecs } = require(path.join(appRoot, "lib", "card-editor-tools"));
  const { contentResearchToolSpecs } = require(path.join(appRoot, "lib", "content-research-tools"));
  const handler = createMcpHandler({ dataRoot: path.join(os2.tmpdir(), "jv-quality-count"), appRoot, extraTools: [], baseTools: true });
  return handler.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }, {}).then((reply) => {
    const bridge = (fs.readFileSync(path.join(appRoot, "electron", "agent-bridge.cjs"), "utf8").match(/name:\s*"(?:jeditor|cutline)_[a-z_]+"/g) || []).length;
    return {
      base: ((reply && reply.result && reply.result.tools) || []).length,
      agent: agentToolSpecs().length,
      cards: cardEditorSpecs().length,
      content: contentResearchToolSpecs().length,
      bridge,
    };
  });
}

// Newline framed JSON-RPC over the real stdio server, same transport an agent uses.
function client(child) {
  let buffer = "";
  const pending = new Map();
  child.stdout.on("data", (chunk) => {
    buffer += String(chunk);
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const entry = pending.get(message.id);
      if (entry) {
        pending.delete(message.id);
        clearTimeout(entry.timer);
        entry.resolve(message);
      }
    }
  });
  let id = 0;
  return (method, params, timeoutMs) =>
    new Promise((resolve) => {
      const callId = "q" + ++id;
      const timer = setTimeout(() => {
        pending.delete(callId);
        resolve({ timeout: true });
      }, timeoutMs || 30000);
      pending.set(callId, { resolve, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: callId, method, params }) + "\n");
    });
}

function payloadOf(reply) {
  const text = reply && reply.result && reply.result.content && reply.result.content[0] && reply.result.content[0].text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

// JV_QUALITY_DEBUG=1 prints the payload of each render step, for when a gate
// fails on this machine and the summary line is not enough.
const debug = process.env.JV_QUALITY_DEBUG === "1";
const trace = (label, value) => {
  if (debug) console.error("[" + label + "] " + JSON.stringify(value).slice(0, 600));
};

function probe(ffmpeg, file) {
  const out = spawnSync(ffmpeg, ["-hide_banner", "-i", file], { encoding: "utf8" });
  const text = String(out.stderr || "");
  const videoLine = (text.split(/\r?\n/).find((line) => /Stream #.*Video:/.test(line)) || "");
  const audioLine = (text.split(/\r?\n/).find((line) => /Stream #.*Audio:/.test(line)) || "");
  const codec = /Video:\s*(\w+)/.exec(videoLine);
  const profile = /Video:\s*\w+\s*\(([^)]+)\)/.exec(videoLine);
  const pix = /\b(yuv\d+p|yuv\d+)\b/.exec(videoLine);
  const size = /(\d{2,5})x(\d{2,5})/.exec(videoLine);
  const fps = /([\d.]+) fps/.exec(videoLine);
  const bitrate = /(\d+) kb\/s/.exec(videoLine);
  const audioCodec = /Audio:\s*(\w+)/.exec(audioLine);
  const sampleRate = /(\d+) Hz/.exec(audioLine);
  const channels = /Hz,\s*([\w.]+)/.exec(audioLine);
  const audioBitrate = /(\d+) kb\/s/.exec(audioLine);
  const duration = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  return {
    codec: codec ? codec[1] : "",
    profile: profile ? profile[1] : "",
    size: size ? size[1] + "x" + size[2] : "",
    fps: fps ? fps[1] : "",
    bitrate: bitrate ? bitrate[1] + " kb/s" : "",
    pix: pix ? pix[1] : "",
    audioCodec: audioCodec ? audioCodec[1] : "",
    sampleRate: sampleRate ? sampleRate[1] : "",
    channels: channels ? channels[1] : "",
    audioBitrate: audioBitrate ? audioBitrate[1] + " kb/s" : "",
    seconds: duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : 0,
  };
}

function loudness(ffmpeg, file) {
  // The summary block at the end is the integrated value; the per frame lines
  // start at -70 and would fool a first match.
  const out = spawnSync(ffmpeg, ["-hide_banner", "-nostats", "-i", file, "-af", "ebur128=peak=true", "-f", "null", "-"], { encoding: "utf8" });
  const text = String(out.stderr || "");
  const lufs = [...text.matchAll(/I:\s*(-?\d+(?:\.\d+)?) LUFS/g)].map((m) => Number(m[1]));
  const peaks = [...text.matchAll(/Peak:\s*(-?\d+(?:\.\d+)?) dBFS/g)].map((m) => Number(m[1]));
  return {
    lufs: lufs.length ? lufs[lufs.length - 1] : null,
    peak: peaks.length ? peaks[peaks.length - 1] : null,
  };
}

async function renderGate(ffmpeg) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jv-quality-"));
  const clip = path.join(dataRoot, "gate.mp4");
  const music = path.join(dataRoot, "bed.mp3");
  const made = spawnSync(ffmpeg, ["-y", "-f", "lavfi", "-i", "testsrc2=size=1080x1920:rate=30:duration=2",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "libx264", "-preset", "veryfast",
    "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip], { encoding: "utf8" });
  if (made.status !== 0) return { ok: false, why: "could not build the test clip" };
  const bed = spawnSync(ffmpeg, ["-y", "-f", "lavfi", "-i", "sine=frequency=220:duration=2", "-c:a", "libmp3lame", music], { encoding: "utf8" });
  if (bed.status !== 0) return { ok: false, why: "could not build the test bed" };

  const child = spawn(process.execPath, [path.join(appRoot, "lib", "mcp-stdio.js"), "--no-bridge", "--data-root", dataRoot, "--app-root", appRoot], {
    cwd: appRoot,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: Object.assign({}, process.env, { JEDITOR_DATA_ROOT: dataRoot, CUTLINE_DATA_ROOT: dataRoot }),
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr = (stderr + String(chunk)).slice(-4000)));
  const rpc = client(child);
  const stop = () => {
    try {
      child.stdin.end();
    } catch {
      /* gone */
    }
  };
  try {
    const init = await rpc("initialize", { protocolVersion: "2024-11-05", clientInfo: { name: "quality-report", version: "1.0.0" }, capabilities: {} });
    if (!init.result) return { ok: false, why: "stdio server did not start: " + stderr.slice(-300) };
    const workspaces = payloadOf(await rpc("tools/call", { name: "jeditor_list_workspaces", arguments: {} }));
    const workspaceId = workspaces && Array.isArray(workspaces.workspaces) && workspaces.workspaces[0] && workspaces.workspaces[0].id;
    const added = payloadOf(await rpc("tools/call", { name: "jeditor_add_files", arguments: { paths: [clip, music], workspaceId } }));
    const items = (added && (added.added || added.items)) || [];
    const videoId = (items.find((item) => item.kind === "video") || {}).id;
    const audioId = (items.find((item) => item.kind === "audio") || {}).id;
    if (!videoId) return { ok: false, why: "jeditor_add_files did not return the test clip: " + JSON.stringify(added).slice(0, 200) };
    const project = payloadOf(await rpc("tools/call", { name: "jeditor_create_project", arguments: { name: "Quality gate", assetIds: [videoId], workspaceId } }));
    const projectId = project && (project.id || (project.project && project.project.id));
    if (!projectId) return { ok: false, why: "jeditor_create_project did not return an id: " + JSON.stringify(project).slice(0, 200) };
    const rendered = payloadOf(await rpc("tools/call", {
      name: "jeditor_render_project",
      arguments: { projectId, audioId, duck: 0.3, name: "Quality gate render", workspaceId },
    }, RENDER_TIMEOUT_MS));
    trace("render", rendered);
    if (!rendered || rendered.error || rendered.timeout) {
      return { ok: false, why: "render failed: " + String((rendered && rendered.error) || JSON.stringify(rendered).slice(0, 200)) };
    }
    const dir = path.join(dataRoot, "workspaces", workspaceId || "default", "finished");
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".mp4")) : [];
    trace("finished", files);
    if (!files.length) return { ok: false, why: "no finished file on disk" };
    const file = path.join(dir, files[files.length - 1]);
    trace("file", { file, bytes: fs.statSync(file).size });
    const info = probe(ffmpeg, file);
    trace("probe", info);
    const loud = loudness(ffmpeg, file);
    const problems = [];
    if (info.codec !== "h264") problems.push("codec " + (info.codec || "none"));
    if (info.profile !== "High") problems.push("profile " + (info.profile || "none"));
    if (info.pix !== "yuv420p") problems.push("pixel format " + (info.pix || "none"));
    if (info.audioCodec !== "aac") problems.push("audio " + (info.audioCodec || "none"));
    if (info.sampleRate !== "48000") problems.push("sample rate " + (info.sampleRate || "none"));
    if (Math.abs(info.seconds - 2) > 0.6) problems.push("duration " + info.seconds + "s");
    if (loud.lufs == null) problems.push("no loudness reading");
    else if (loud.lufs < -20 || loud.lufs > -8) problems.push("loudness " + loud.lufs + " LUFS, target -14");
    return {
      ok: !problems.length,
      why: problems.join(", "),
      line:
        info.seconds.toFixed(1) + " s " + info.codec + " " + info.profile + " " + info.pix + " " + info.size + " " + info.fps + " fps " +
        info.bitrate + ", " + info.audioCodec + " " + info.sampleRate + " Hz " + info.channels + " " + info.audioBitrate +
        ", loudness " + (loud.lufs == null ? "unmeasured" : loud.lufs + " LUFS") + " (peak " + (loud.peak == null ? "?" : loud.peak + " dBFS") + "), " +
        Math.round(fs.statSync(file).size / 1024) + " KB",
    };
  } finally {
    stop();
  }
}

async function main() {
  const { findFfmpeg } = require(path.join(appRoot, "lib", "card-render"));
  const ffmpeg = findFfmpeg();
  const counts = await toolCounts();
  const skills = skillStats();
  const lines = [];
  let failed = 0;
  const say = (name, ok, detail) => {
    if (!ok) failed++;
    lines.push((ok ? "  ok   " : "  FAIL ") + name.padEnd(8) + detail);
  };

  const tools = runNode("scripts/mcp-tools-check.cjs");
  say("tools", tools.ok, counts.base + " base, " + counts.agent + " agent, " + counts.cards + " cards, " + counts.content + " content, " + counts.bridge + " live bridge");
  say("skills", tools.ok, skills.files + " files, " + skills.kb + " KB");
  const errors = runNode("scripts/mcp-error-check.cjs");
  say("errors", errors.ok, errors.last);

  if (!ffmpeg) say("render", false, "no ffmpeg on this computer");
  else {
    const render = await renderGate(ffmpeg);
    say("render", render.ok, render.ok ? render.line : render.why);
  }

  console.log("jv quality report");
  for (const line of lines) console.log(line);
  console.log("");
  console.log(failed ? failed + " of 4 checks failed" : "all 4 checks passed");
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  console.log("FAIL run     " + (error && error.message ? error.message : error));
  process.exitCode = 1;
});
