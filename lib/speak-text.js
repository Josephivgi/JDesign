"use strict";

// Reads agent replies aloud. Two voices:
//   windows     Voices built into Windows (System.Speech), free and offline.
//   elevenlabs  The ElevenLabs voice picked in Settings > ElevenLabs (spends
//               account characters, so replies are capped shorter).
// Both return audio bytes the window plays, so a reply can be stopped at once.

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const WINDOWS_MAX = 2500;
const ELEVEN_MAX = 900;

const SPEAK_SCRIPT = [
  "param([string]$textFile, [string]$out, [string]$voice)",
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName System.Speech",
  "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
  "if ($voice) { try { $s.SelectVoice($voice) } catch { } }",
  "$s.SetOutputToWaveFile($out)",
  "$s.Speak([IO.File]::ReadAllText($textFile, [Text.Encoding]::UTF8))",
  "$s.Dispose()",
].join("\r\n");

const VOICES_SCRIPT = [
  "Add-Type -AssemblyName System.Speech",
  "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
  "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
  "$s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { [Console]::Out.WriteLine($_.VoiceInfo.Name) }",
  "$s.Dispose()",
].join("\r\n");

function runPs(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", ...args], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Windows speech took too long."));
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
      else reject(new Error((err || "exit " + code).trim().split(/\r?\n/)[0].slice(0, 200)));
    });
  });
}

// Markdown, code and links read badly out loud. Keep the words.
function speakable(text, max) {
  let t = String(text || "");
  t = t.replace(/```[\s\S]*?```/g, " (code skipped) ");
  t = t.replace(/`([^`]+)`/g, "$1");
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  t = t.replace(/https?:\/\/\S+/g, " link ");
  t = t.replace(/[A-Za-z]:\\[^\s,;)]+/g, (m) => path.win32.basename(m));
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  t = t.replace(/^\s*[-*+]\s+/gm, "");
  t = t.replace(/^\s*\|.*\|\s*$/gm, " ");
  t = t.replace(/[*_~>#|]+/g, " ");
  t = t.replace(/\s*\n+\s*/g, ". ").replace(/\.\s*\./g, ".");
  t = t.replace(/\s{2,}/g, " ").trim();
  if (t.length > max) {
    const cut = t.slice(0, max);
    const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    t = (end > max * 0.5 ? cut.slice(0, end + 1) : cut) + " The rest is in the chat.";
  }
  return t;
}

async function listWindowsVoices() {
  if (process.platform !== "win32") return [];
  const out = await runPs(["-Command", VOICES_SCRIPT], 30000);
  return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

async function speakWindows(text, voice) {
  if (process.platform !== "win32") throw new Error("Windows voices are only on Windows.");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jv-say-"));
  try {
    const textFile = path.join(dir, "text.txt");
    const script = path.join(dir, "speak.ps1");
    const out = path.join(dir, "reply.wav");
    await fs.writeFile(textFile, text, "utf8");
    await fs.writeFile(script, SPEAK_SCRIPT, "utf8");
    await runPs(["-File", script, textFile, out, String(voice || "")], 120000);
    return { bytes: await fs.readFile(out), mime: "audio/wav" };
  } finally {
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function speakReply(dataRoot, { text, engine, voice } = {}) {
  const use = engine === "elevenlabs" ? "elevenlabs" : "windows";
  const line = speakable(text, use === "elevenlabs" ? ELEVEN_MAX : WINDOWS_MAX);
  if (!line) return { empty: true };
  if (use === "windows") {
    const r = await speakWindows(line, voice);
    return { dataBase64: r.bytes.toString("base64"), mime: r.mime, engine: use, characters: line.length };
  }
  const { synthesize } = require("./elevenlabs");
  const out = await synthesize(dataRoot, { text: line });
  try {
    const bytes = await fs.readFile(out.path);
    return { dataBase64: bytes.toString("base64"), mime: "audio/mpeg", engine: use, characters: line.length };
  } finally {
    fs.rm(out.path, { force: true }).catch(() => {});
  }
}

module.exports = { speakable, listWindowsVoices, speakReply };
