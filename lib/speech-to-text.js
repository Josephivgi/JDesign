"use strict";

// Turns a short voice recording from the chat mic into text.
//
// Two engines:
//   elevenlabs  ElevenLabs Scribe, when a key is saved (better accuracy,
//               spends account credits).
//   windows     The speech recognizer built into Windows (System.Speech),
//               offline and free. ffmpeg converts the browser's webm/opus
//               recording to the 16 kHz mono WAV it reads.
// "auto" picks ElevenLabs when a key is saved and Windows otherwise.

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const MAX_BYTES = 25 * 1024 * 1024;
const ENGINES = ["auto", "windows", "elevenlabs"];

const WINDOWS_SCRIPT = [
  "param([string]$wav)",
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName System.Speech",
  "$r = New-Object System.Speech.Recognition.SpeechRecognitionEngine",
  "$r.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))",
  "$r.SetInputToWaveFile($wav)",
  "$parts = New-Object System.Collections.Generic.List[string]",
  "for ($i = 0; $i -lt 400; $i++) {",
  "  try { $res = $r.Recognize() } catch { break }",
  "  if ($null -eq $res) { if ($r.AudioState -eq 'Stopped') { break } else { continue } }",
  "  $parts.Add($res.Text)",
  "}",
  "$r.Dispose()",
  "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
  "[Console]::Out.Write(($parts -join ' '))",
].join("\r\n");

function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(path.basename(cmd) + " took too long."));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d.toString("utf8")));
    child.stderr.on("data", (d) => (err += d.toString("utf8")));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error((err || out || "exit " + code).trim().split(/\r?\n/).slice(-3).join(" ").slice(0, 300)));
    });
  });
}

function extFor(mime) {
  const m = String(mime || "").toLowerCase();
  if (m.includes("ogg")) return ".ogg";
  if (m.includes("mp4") || m.includes("m4a")) return ".m4a";
  if (m.includes("wav")) return ".wav";
  if (m.includes("mpeg")) return ".mp3";
  return ".webm";
}

async function transcribeWindows(file) {
  if (process.platform !== "win32") throw new Error("The built-in recognizer needs Windows. Save an ElevenLabs key to use voice input here.");
  const { findFfmpeg } = require("./card-render");
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error("Voice input needs ffmpeg on this computer.");
  const dir = path.dirname(file);
  const wav = path.join(dir, "speech16.wav");
  const script = path.join(dir, "recognize.ps1");
  await run(ffmpeg, ["-y", "-loglevel", "error", "-i", file, "-ar", "16000", "-ac", "1", "-sample_fmt", "s16", wav], 60000);
  await fs.writeFile(script, WINDOWS_SCRIPT, "utf8");
  const text = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, wav], 120000);
  return text.trim();
}

async function transcribeElevenLabs(apiKey, bytes, mime) {
  const form = new FormData();
  form.append("model_id", "scribe_v1");
  form.append("file", new Blob([bytes], { type: mime || "audio/webm" }), "speech" + extFor(mime));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  let res;
  try {
    res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: { "xi-api-key": apiKey, Accept: "application/json" },
      body: form,
    });
  } catch (error) {
    throw new Error(error && error.name === "AbortError" ? "ElevenLabs speech to text timed out." : "Could not reach ElevenLabs: " + ((error && error.message) || error));
  } finally {
    clearTimeout(timer);
  }
  const body = await res.text().catch(() => "");
  if (!res.ok) {
    let detail = "";
    try {
      const j = JSON.parse(body);
      detail = (j.detail && (j.detail.message || j.detail.status)) || j.message || "";
    } catch {
      detail = "";
    }
    if (res.status === 401 || res.status === 403) throw new Error("ElevenLabs refused speech to text (" + res.status + "): the key may be missing the Speech to Text permission.");
    throw new Error("ElevenLabs speech to text failed (HTTP " + res.status + ")" + (detail ? ": " + String(detail).slice(0, 160) : "") + ".");
  }
  let parsed = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = null;
  }
  return String((parsed && parsed.text) || "").trim();
}

// bytes: Buffer of the recording. engine: auto | windows | elevenlabs.
async function transcribe(dataRoot, { bytes, mime, engine } = {}) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (!buf.length) throw new Error("Nothing was recorded. Check that the right microphone is picked in Windows sound settings.");
  if (buf.length > MAX_BYTES) throw new Error("That recording is too long. Keep voice messages under a few minutes.");
  const want = ENGINES.includes(engine) ? engine : "auto";
  const { readConfig } = require("./elevenlabs");
  const cfg = await readConfig(dataRoot);
  let use = want;
  if (use === "auto") use = cfg.apiKey ? "elevenlabs" : "windows";
  if (use === "elevenlabs" && !cfg.apiKey) throw new Error("No ElevenLabs key is saved. Add one in Settings > ElevenLabs, or switch voice input to Windows.");
  if (use === "elevenlabs") return { text: await transcribeElevenLabs(cfg.apiKey, buf, mime), engine: "elevenlabs" };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jv-voice-"));
  try {
    const file = path.join(dir, "speech" + extFor(mime));
    await fs.writeFile(file, buf);
    return { text: await transcribeWindows(file), engine: "windows" };
  } finally {
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { transcribe, ENGINES, WINDOWS_SCRIPT };
