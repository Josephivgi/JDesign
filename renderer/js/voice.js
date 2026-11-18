// Voice for the chat: a mic that types what you say into the message box, and
// agent replies read aloud. Recording happens here (MediaRecorder); the main
// process turns it into text (Windows recognizer or ElevenLabs Scribe) and
// makes the reply audio (Windows voices or ElevenLabs). See lib/speech-to-text
// and lib/speak-text.

import { api, store } from "./store.js";
import { icon, toast, errorText } from "./ui.js";

const MAX_RECORD_MS = 3 * 60 * 1000;

let current = null; // the one live recording across the app

function pickMime() {
  const options = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
  for (const m of options) if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  return "";
}

function micError(error) {
  const name = error && error.name;
  if (name === "NotAllowedError" || name === "SecurityError") return "Windows blocked the microphone. Turn on Settings > Privacy & security > Microphone > Let desktop apps access your microphone.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone found. Plug one in or pick it in Windows sound settings.";
  if (name === "NotReadableError") return "Another app is using the microphone.";
  return errorText(error);
}

// Wires a mic button to a textarea. Click to start, click again (or Enter) to
// stop and type the words in; Esc throws the recording away.
// opts.onState(state, info) with state idle | listening | working.
// opts.onText(text) runs after the words land in the box.
export function attachMic(button, input, opts = {}) {
  let state = "idle";
  let rec = null;
  let tick = 0;
  let destroyed = false;

  const setState = (next, info) => {
    state = next;
    button.classList.toggle("is-on", next === "listening");
    button.setAttribute("aria-pressed", next === "listening" ? "true" : "false");
    button.disabled = next === "working";
    button.innerHTML = next === "listening" ? icon("stop") : next === "working" ? icon("loader", "spin") : icon("mic");
    button.title = next === "listening" ? "Stop and type what I said (Esc to throw away)" : next === "working" ? "Turning your voice into text" : "Talk instead of typing";
    if (opts.onState) opts.onState(next, info || {});
  };

  const cleanup = () => {
    clearInterval(tick);
    tick = 0;
    if (rec && rec.stream) rec.stream.getTracks().forEach((t) => t.stop());
    if (current === rec) current = null;
    rec = null;
  };

  const start = async () => {
    if (current && current !== rec) current.cancel();
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (error) {
      toast(micError(error), true);
      setState("idle");
      return;
    }
    if (destroyed) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    // A reply being read aloud would end up in the recording.
    stopSpeaking();
    const mime = pickMime();
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    const startedAt = Date.now();
    const r = { stream, recorder, chunks, startedAt, discard: false, cancel: () => stop(true) };
    rec = r;
    current = r;
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };
    recorder.onstop = () => void finish(r, recorder.mimeType || mime);
    recorder.start(250);
    setState("listening", { ms: 0 });
    tick = setInterval(() => {
      const ms = Date.now() - startedAt;
      if (ms >= MAX_RECORD_MS) stop(false);
      else if (state === "listening") opts.onState && opts.onState("listening", { ms });
    }, 500);
  };

  const stop = (discard) => {
    if (!rec) return;
    rec.discard = Boolean(discard);
    clearInterval(tick);
    tick = 0;
    try {
      if (rec.recorder.state !== "inactive") rec.recorder.stop();
      else void finish(rec, "");
    } catch {
      cleanup();
      setState("idle");
    }
  };

  const finish = async (r, mime) => {
    if (r.finished) return;
    r.finished = true;
    const discard = r.discard;
    const blob = new Blob(r.chunks, { type: mime || "audio/webm" });
    if (rec === r) cleanup();
    else if (r.stream) r.stream.getTracks().forEach((t) => t.stop());
    if (discard || destroyed) {
      if (!destroyed) setState("idle");
      return;
    }
    if (blob.size < 1200) {
      setState("idle");
      toast("Nothing was heard. Hold the mic button a little longer.", true);
      return;
    }
    setState("working");
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const out = await api.voiceTranscribe({ bytes, mime: blob.type });
      if (destroyed) return;
      const text = String((out && out.text) || "").trim();
      if (!text) {
        setState("idle");
        toast("Couldn't make out any words. Try again a little closer to the mic.", true);
        return;
      }
      const before = input.value;
      input.value = before && !/\s$/.test(before) ? before + " " + text : before + text;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      setState("idle");
      if (opts.onText) opts.onText(text, out.engine);
    } catch (error) {
      if (destroyed) return;
      setState("idle");
      toast(errorText(error), true);
    }
  };

  const onClick = () => {
    if (state === "listening") stop(false);
    else if (state === "idle") void start();
  };
  const onKey = (event) => {
    if (state !== "listening") return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      stop(true);
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      stop(false);
    }
  };
  button.addEventListener("click", onClick);
  document.addEventListener("keydown", onKey, true);
  setState("idle");

  return {
    get state() {
      return state;
    },
    start: () => (state === "idle" ? start() : undefined),
    stop: () => stop(false),
    cancel: () => stop(true),
    destroy: () => {
      destroyed = true;
      stop(true);
      cleanup();
      button.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey, true);
    },
  };
}

// ---------- replies read aloud ----------

let audio = null;
let audioUrl = "";
let speakSeq = 0;
const speakListeners = new Set();

function notifySpeaking() {
  const on = isSpeaking();
  speakListeners.forEach((fn) => {
    try {
      fn(on);
    } catch {
      /* listener errors stay local */
    }
  });
}

export function onSpeakingChange(fn) {
  speakListeners.add(fn);
  return () => speakListeners.delete(fn);
}

export function isSpeaking() {
  return Boolean(audio && !audio.paused);
}

export function stopSpeaking() {
  speakSeq++;
  if (audio) {
    audio.pause();
    audio.removeAttribute("src");
    audio = null;
  }
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = "";
  notifySpeaking();
}

// Reads `text` aloud with the voice picked in Settings > Voice. Resolves when
// playback starts (or nothing was spoken). opts.engine overrides the pref.
export async function speak(text, opts = {}) {
  stopSpeaking();
  const seq = speakSeq;
  let out;
  try {
    out = await api.voiceSpeak({ text: String(text || ""), engine: opts.engine || store.prefs.replyVoice });
  } catch (error) {
    if (!opts.quiet) toast("Couldn't read the reply aloud: " + errorText(error), true);
    return { ok: false, error: errorText(error) };
  }
  if (seq !== speakSeq || !out || out.empty || !out.dataBase64) return { ok: false };
  const bin = atob(out.dataBase64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  audioUrl = URL.createObjectURL(new Blob([bytes], { type: out.mime || "audio/wav" }));
  audio = new Audio(audioUrl);
  if (Number.isFinite(opts.volume)) audio.volume = Math.max(0, Math.min(1, opts.volume));
  const mine = audio;
  mine.addEventListener("ended", () => {
    if (audio === mine) stopSpeaking();
  });
  try {
    await mine.play();
  } catch (error) {
    if (audio === mine) stopSpeaking();
    return { ok: false, error: errorText(error) };
  }
  notifySpeaking();
  return { ok: true, bytes: bytes.length, engine: out.engine, characters: out.characters };
}
