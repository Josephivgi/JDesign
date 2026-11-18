"use strict";

// ElevenLabs text-to-speech for JV agents. The key lives in the data
// root (integrations/elevenlabs.json), never in the repo and never in tool
// output; ELEVENLABS_API_KEY works as a fallback. Every request is pinned to
// the api.elevenlabs.io origin with redirects refused, timeouts, byte caps,
// and an MP3 signature check before the bytes reach the library.

const fs = require("fs");
const fsp = require("node:fs/promises");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");
const { writeJsonAtomic } = require("./workspace-store");

const ORIGIN = "https://api.elevenlabs.io";
const DEFAULT_MODEL = "eleven_flash_v2_5";
const REQUEST_TIMEOUT_MS = 30000;
const SYNTH_TIMEOUT_MS = 120000;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_AUDIO_BYTES = 40 * 1024 * 1024;
const MAX_TEXT_CHARS = 5000;
const MAX_VOICES = 100;

// Music generation. The length bounds are the API's; a bed is usually short,
// so the cap is generous but the timeout still fits an agent tool call.
const MUSIC_MODELS = ["music_v1", "music_v2", "music_v2_5"];
const DEFAULT_MUSIC_MODEL = "music_v2_5";
const MUSIC_TIMEOUT_MS = 120000;
const MAX_MUSIC_PROMPT_CHARS = 2000;
const MIN_MUSIC_MS = 3000;
const MAX_MUSIC_MS = 600000;

function configPath(dataRoot) {
  return path.join(dataRoot, "integrations", "elevenlabs.json");
}

// How agents may spend the account's characters. "ask" routes each
// voiceover through an approval card in the AI video editor, "always" lets
// agents call TTS freely, "never" refuses every agent call.
const AGENT_ACCESS_MODES = ["ask", "always", "never"];

// Music generation has no side-effect-free probe (any well-formed request
// composes audio), so the key's music permission is remembered from the last
// real music call instead of guessed at.
const MUSIC_PERMISSION_STATES = ["ok", "missing"];

function prefsFromFile(file) {
  const f = file && typeof file === "object" ? file : {};
  return {
    voiceId: String(f.voiceId || ""),
    voiceName: String(f.voiceName || ""),
    model: String(f.model || ""),
    agentAccess: AGENT_ACCESS_MODES.includes(f.agentAccess) ? f.agentAccess : "ask",
    musicPermission: MUSIC_PERMISSION_STATES.includes(f.musicPermission) ? f.musicPermission : "",
  };
}

async function readConfig(dataRoot) {
  const file = await readFileBody(dataRoot);
  const prefs = prefsFromFile(file);
  const fileKey = file && typeof file.apiKey === "string" ? file.apiKey.trim() : "";
  if (fileKey) {
    return Object.assign({ apiKey: fileKey, keyTail: file.keyTail || "", source: "file" }, prefs);
  }
  const envKey = String(process.env.ELEVENLABS_API_KEY || "").trim();
  if (envKey) return Object.assign({ apiKey: envKey, keyTail: envKey.slice(-4), source: "env" }, prefs);
  return Object.assign({ apiKey: "", keyTail: "", source: null }, prefs);
}

// Merge non-key preferences (default voice, agent access mode) into the
// integration file without touching the stored key.
async function savePrefs(dataRoot, prefs) {
  const patch = prefs || {};
  const file = await readFileBody(dataRoot);
  if (patch.voiceId !== undefined) {
    const voiceId = String(patch.voiceId || "").trim();
    if (voiceId && !/^[A-Za-z0-9]{8,64}$/.test(voiceId)) throw new Error("That does not look like an ElevenLabs voice id.");
    file.voiceId = voiceId;
    file.voiceName = String(patch.voiceName || "").slice(0, 120);
  }
  if (patch.model !== undefined) {
    const model = String(patch.model || "").trim();
    if (model && !/^[A-Za-z0-9_.-]{4,80}$/.test(model)) throw new Error("That does not look like an ElevenLabs model id.");
    file.model = model;
  }
  if (patch.agentAccess !== undefined) {
    if (!AGENT_ACCESS_MODES.includes(patch.agentAccess)) throw new Error("Unknown agent access mode.");
    file.agentAccess = patch.agentAccess;
  }
  file.updatedAt = new Date().toISOString();
  await fsp.mkdir(path.dirname(configPath(dataRoot)), { recursive: true });
  await writeJsonAtomic(configPath(dataRoot), file);
  return readConfig(dataRoot);
}

// Remember whether the key can make music. A 401 or 403 on a real music call
// means it cannot; a success clears the mark. This is the only way to know,
// because probing the endpoint would compose audio and spend the plan.
async function setMusicPermission(dataRoot, state) {
  const file = await readFileBody(dataRoot);
  if (MUSIC_PERMISSION_STATES.includes(state)) file.musicPermission = state;
  else delete file.musicPermission;
  file.updatedAt = new Date().toISOString();
  await fsp.mkdir(path.dirname(configPath(dataRoot)), { recursive: true });
  await writeJsonAtomic(configPath(dataRoot), file);
}

// Single-use, short-lived approvals. The ACP permission prompt grants one;
// the next agent TTS call in this process consumes it. Each process keeps
// its own map, so a stdio MCP client can never piggyback on an in-app yes.
const GRANT_TTL_MS = 120000;
const ttsGrants = new Map();

function grantTtsApproval(scope) {
  const key = String(scope || "");
  if (!ttsGrants.has(key)) ttsGrants.set(key, []);
  ttsGrants.get(key).push(Date.now() + GRANT_TTL_MS);
}

function consumeTtsGrant(scope) {
  const key = String(scope || "");
  const list = ttsGrants.get(key);
  if (!list || !list.length) return false;
  const now = Date.now();
  const fresh = list.filter((at) => at > now);
  if (!fresh.length) {
    ttsGrants.delete(key);
    return false;
  }
  fresh.shift();
  if (fresh.length) ttsGrants.set(key, fresh);
  else ttsGrants.delete(key);
  return true;
}

function checkKeyShape(key) {
  const k = String(key || "").trim();
  if (k.length < 12 || k.length > 200 || /\s/.test(k)) {
    throw new Error("That does not look like an ElevenLabs API key.");
  }
  return k;
}

async function readFileBody(dataRoot) {
  try {
    const file = JSON.parse(await fsp.readFile(configPath(dataRoot), "utf8"));
    return file && typeof file === "object" ? file : {};
  } catch {
    return {};
  }
}

async function saveKey(dataRoot, apiKey, extra) {
  const key = checkKeyShape(apiKey);
  const body = Object.assign(
    // Voice and access prefs survive a key swap; they are settings, not
    // credentials.
    await readFileBody(dataRoot),
    {
      apiKey: key,
      keyTail: key.slice(-4),
      updatedAt: new Date().toISOString(),
    },
    extra || {},
  );
  await fsp.mkdir(path.dirname(configPath(dataRoot)), { recursive: true });
  await writeJsonAtomic(configPath(dataRoot), body);
  try {
    await fsp.chmod(configPath(dataRoot), 0o600);
  } catch {
    /* Windows ACLs make chmod best effort */
  }
  return { configured: true, keyTail: body.keyTail };
}

// Removing the key keeps the voice and access prefs; deleting the whole file
// would silently reset the user's "never" back to "ask".
async function clearKey(dataRoot) {
  const file = await readFileBody(dataRoot);
  delete file.apiKey;
  delete file.keyTail;
  file.updatedAt = new Date().toISOString();
  try {
    if (Object.keys(file).length > 1) {
      await writeJsonAtomic(configPath(dataRoot), file);
    } else {
      await fsp.unlink(configPath(dataRoot));
    }
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
  return { configured: false };
}

function providerError(status, body) {
  let detail = "";
  try {
    const parsed = JSON.parse(body);
    detail = (parsed && (parsed.detail && (parsed.detail.message || parsed.detail.status) || parsed.message)) || "";
  } catch {
    detail = "";
  }
  const hint = detail && typeof detail === "object" ? JSON.stringify(detail) : detail;
  const withStatus = (error) => {
    error.status = status;
    return error;
  };
  if (status === 401) {
    // 401 is not always a bad key: ElevenLabs scopes keys per permission, so
    // a key without the endpoint's scope answers 401 too. Keep the provider
    // detail so the message says which.
    return withStatus(
      new Error("ElevenLabs rejected the key (401)" + (hint ? ": " + String(hint).slice(0, 160) : "") + "."),
    );
  }
  if (status === 403) {
    return withStatus(new Error("ElevenLabs refused this request (403): the key is missing a permission."));
  }
  if (status === 429) return withStatus(new Error("ElevenLabs rate limit hit (429). Wait a moment and retry."));
  return withStatus(
    new Error("ElevenLabs request failed (HTTP " + status + ")" + (hint ? ": " + String(hint).slice(0, 160) : "")),
  );
}

// One bounded request to the fixed ElevenLabs origin. Redirects are refused:
// the API never legitimately redirects, and following one could leak the key.
// This returns the status instead of throwing so the key check can read a 401
// as "this key is missing that permission" rather than as a failed call.
async function send(apiKey, pathname, options) {
  const opts = options || {};
  const method = opts.method || "GET";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(ORIGIN + pathname, {
      method,
      redirect: "manual",
      signal: controller.signal,
      headers: Object.assign(
        {
          "xi-api-key": apiKey,
          Accept: opts.binary ? "audio/mpeg, application/octet-stream" : "application/json",
        },
        opts.body ? { "Content-Type": "application/json" } : {},
      ),
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch (error) {
    clearTimeout(timer);
    const network = error && error.name === "AbortError" ? "timeout" : (error && error.message) || "network error";
    return { status: 0, ok: false, network, bytes: Buffer.alloc(0) };
  }
  clearTimeout(timer);
  const cap = opts.binary ? MAX_AUDIO_BYTES : MAX_JSON_BYTES;
  const length = Number(res.headers.get("content-length") || 0);
  if (length > cap) return { status: res.status, ok: false, tooLarge: true, bytes: Buffer.alloc(0) };
  let bytes = Buffer.alloc(0);
  try {
    bytes = Buffer.from(await res.arrayBuffer());
  } catch {
    bytes = Buffer.alloc(0);
  }
  if (bytes.length > cap) return { status: res.status, ok: false, tooLarge: true, bytes: Buffer.alloc(0) };
  return { status: res.status, ok: res.ok, redirected: res.status >= 300 && res.status < 400, bytes };
}

async function request(apiKey, pathname, options) {
  const r = await send(apiKey, pathname, options);
  if (r.network) {
    if (r.network === "timeout") throw new Error("ElevenLabs request timed out.");
    throw new Error("Could not reach ElevenLabs: " + r.network);
  }
  if (r.redirected) throw new Error("ElevenLabs redirected unexpectedly; refusing to follow.");
  if (r.tooLarge) throw new Error("ElevenLabs response is too large.");
  if (!r.ok) throw providerError(r.status, r.bytes.toString("utf8").slice(0, 4000));
  return r.bytes;
}

async function listVoices(dataRoot) {
  const cfg = await readConfig(dataRoot);
  if (!cfg.apiKey) throw new Error("No ElevenLabs API key. Call jeditor_elevenlabs_setup with your key first.");
  const bytes = await request(cfg.apiKey, "/v2/voices?page_size=" + MAX_VOICES);
  const parsed = JSON.parse(bytes.toString("utf8"));
  const voices = (parsed && Array.isArray(parsed.voices) ? parsed.voices : []).slice(0, MAX_VOICES).map((v) => ({
    id: v.voice_id,
    name: v.name,
    category: v.category || "",
    description: String(v.description || "").slice(0, 200),
    labels: v.labels && typeof v.labels === "object" ? v.labels : {},
    // Sample clip on ElevenLabs' CDN; playing it costs no characters.
    preview: typeof v.preview_url === "string" && v.preview_url.startsWith("https://") ? v.preview_url : "",
  }));
  return { voices };
}

// TTS models the key's account can use. can_do_text_to_speech filters out
// speech-to-text and voice-design entries that cannot synthesize speech.
async function listModels(dataRoot) {
  const cfg = await readConfig(dataRoot);
  if (!cfg.apiKey) throw new Error("No ElevenLabs API key. Save one on the ElevenLabs page first.");
  const bytes = await request(cfg.apiKey, "/v1/models");
  const parsed = JSON.parse(bytes.toString("utf8"));
  const models = (Array.isArray(parsed) ? parsed : [])
    .filter((m) => m && m.model_id && m.can_do_text_to_speech !== false)
    .map((m) => ({
      id: String(m.model_id),
      name: String(m.name || m.model_id),
      description: String(m.description || "").slice(0, 200),
    }));
  return { models };
}

const PREVIEW_MAX_BYTES = 1024 * 1024;

// Voice sample clips. Only ElevenLabs-hosted https URLs are fetched: the
// renderer passes the preview URL we handed it, and anything else is refused
// rather than turning this into an open fetch endpoint.
async function voicePreview(dataRoot, url) {
  const cfg = await readConfig(dataRoot);
  if (!cfg.apiKey) throw new Error("No ElevenLabs API key. Save one on the ElevenLabs page first.");
  let host;
  try {
    const parsed = new URL(String(url || ""));
    if (parsed.protocol !== "https:") throw new Error("bad scheme");
    host = parsed.hostname.toLowerCase();
  } catch {
    throw new Error("That does not look like an ElevenLabs preview link.");
  }
  if (host !== "elevenlabs.io" && !host.endsWith(".elevenlabs.io")) {
    throw new Error("Only ElevenLabs preview links can be played.");
  }
  const res = await fetch(String(url), { redirect: "error", signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error("ElevenLabs preview failed (" + res.status + ").");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > PREVIEW_MAX_BYTES) throw new Error("ElevenLabs preview is larger than expected.");
  if (!looksLikeMp3(buf)) throw new Error("ElevenLabs preview did not return audio.");
  return { dataBase64: buf.toString("base64"), mime: "audio/mpeg" };
}

// A cheap key check. Returns only safe account metadata; the key itself never
// comes back out. Every scope that has a side-effect-free endpoint is probed:
// a 401 or 403 there means the key is missing that scope, which is how the page
// flags an old key that needs new permissions, or a dead one that needs a new
// key. Music is deliberately absent: every well-formed request to it composes
// audio, so it is reported from the last real music call instead (see
// setMusicPermission).
const KEY_SCOPE_PROBES = [
  { scope: "user_read", label: "User", path: "/v1/user" },
  { scope: "voices_read", label: "Voices", path: "/v2/voices?page_size=1" },
  { scope: "models_read", label: "Models", path: "/v1/models" },
];

function scopeState(result) {
  if (!result || result.network || result.status === 0) return "unknown";
  if (result.status === 401 || result.status === 403) return "missing";
  return "ok";
}

async function probeScopes(apiKey) {
  const permissions = {};
  const bodies = {};
  for (const probe of KEY_SCOPE_PROBES) {
    const result = await send(apiKey, probe.path);
    permissions[probe.scope] = scopeState(result);
    bodies[probe.scope] = result;
  }
  return { permissions, bodies };
}

// Labels for the flag copy. Music is here even though it is not probed, so a
// recorded music failure names the permission the way the page does.
const SCOPE_LABELS = {
  user_read: "User",
  voices_read: "Voices",
  models_read: "Models",
  music_generation: "Music",
};

function scopeLabel(scope) {
  return SCOPE_LABELS[scope] || scope;
}

// One flag the page can show. A key that fails every probe was rotated or
// revoked and needs replacing; a key missing a permission the app needs has to
// be edited on elevenlabs.io or replaced; a key without music_generation still
// makes voiceovers, so that one is only a warning. A missing user_read is not
// flagged: it only hides the plan numbers, which the page already explains.
function keyFlag(permissions) {
  const missing = Object.keys(permissions).filter((scope) => permissions[scope] === "missing");
  const anyOk = Object.keys(permissions).some((scope) => permissions[scope] === "ok");
  if (missing.length && !anyOk) {
    return {
      level: "error",
      title: "This key was rejected",
      message:
        "ElevenLabs turned it down on every check. It may have been rotated or revoked. Create a new key and paste it here.",
      missing,
    };
  }
  if (missing.includes("voices_read")) {
    return {
      level: "error",
      title: "This key is missing the Voices permission",
      message:
        "Voiceovers need it. Open the key on elevenlabs.io, tick voices_read, or create a new key with it on, then paste it here.",
      missing,
    };
  }
  const warn = missing.filter((scope) => scope !== "user_read");
  if (warn.length) {
    const labels = warn.map(scopeLabel).join(" and ");
    return {
      level: "warn",
      title: "This key is missing " + (warn.length > 1 ? "permissions" : "a permission"),
      message:
        "It cannot use " +
        labels +
        (missing.includes("music_generation") ? " (background music needs music_generation)" : "") +
        ". Add " +
        (warn.length > 1 ? "those permissions" : "that permission") +
        " on elevenlabs.io, or create a new key with them on.",
      missing,
    };
  }
  return null;
}

// Probes a candidate key before it is saved. Throws when ElevenLabs turns it
// down on every check; a network failure lets the save go ahead (the page
// checks again after saving).
async function checkKeyedProbe(apiKey) {
  const key = checkKeyShape(apiKey);
  const { permissions } = await probeScopes(key);
  const states = Object.values(permissions);
  if (states.length && !states.includes("ok") && states.includes("missing")) {
    throw new Error("ElevenLabs turned this key down. Copy it again from the API keys page, or create a new one. Nothing was saved.");
  }
  return permissions;
}

async function testKey(dataRoot) {
  const cfg = await readConfig(dataRoot);
  if (!cfg.apiKey) throw new Error("No ElevenLabs API key. Call jeditor_elevenlabs_setup with your key first.");
  const { permissions, bodies } = await probeScopes(cfg.apiKey);
  // Music is not probed (it would compose audio), so it is reported from the
  // last real music call: "missing" after a 401/403, "ok" after a success, and
  // "unknown" until a bed is made.
  permissions.music_generation = cfg.musicPermission || "unknown";
  const states = Object.values(permissions);
  if (states.every((state) => state === "unknown")) {
    throw new Error("Could not reach ElevenLabs to check the key.");
  }
  const anyOk = states.includes("ok");
  let user = null;
  if (permissions.user_read === "ok") {
    try {
      user = JSON.parse(bodies.user_read.bytes.toString("utf8"));
    } catch {
      user = null;
    }
  }
  const sub = user && user.subscription && typeof user.subscription === "object" ? user.subscription : {};
  return {
    // A key that fails every probe still returns its permissions so the page
    // can mark each row, with the flag carrying the "make a new key" advice.
    ok: anyOk,
    tier: sub.tier || "",
    characterCount: sub.character_count,
    characterLimit: sub.character_limit,
    source: cfg.source,
    keyTail: cfg.keyTail,
    scopeLimited: !user,
    permissions,
    flag: keyFlag(permissions),
  };
}

function looksLikeMp3(bytes) {
  if (!bytes || bytes.length < 3) return false;
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return true; // ID3
  return bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0; // MPEG frame sync
}

async function resolveVoice(dataRoot, cfg, input) {
  const wanted = String(input.voiceId || "").trim();
  if (wanted) {
    if (!/^[A-Za-z0-9]{8,64}$/.test(wanted)) throw new Error("voiceId should look like an ElevenLabs voice id.");
    return wanted;
  }
  const name = String(input.voiceName || "").trim();
  const { voices } = await listVoices(dataRoot);
  if (name) {
    const found = voices.find((v) => String(v.name).toLowerCase() === name.toLowerCase());
    if (!found) throw new Error("No ElevenLabs voice named " + name + ". Call jeditor_elevenlabs_voices for the list.");
    return found.id;
  }
  if (cfg.voiceId) return cfg.voiceId;
  const premade = voices.find((v) => v.category === "premade") || voices[0];
  if (!premade) throw new Error("This ElevenLabs account lists no voices.");
  return premade.id;
}

// Turn text into MP3 bytes. Voice defaults to the saved default, then the
// first premade voice. The returned bytes are checked as MP3 before use.
async function synthesize(dataRoot, input) {
  const cfg = await readConfig(dataRoot);
  if (!cfg.apiKey) throw new Error("No ElevenLabs API key. Call jeditor_elevenlabs_setup with your key first.");
  const text = String(input.text || "").trim();
  if (!text) throw new Error("text is required.");
  if (text.length > MAX_TEXT_CHARS) throw new Error("text is too long (max " + MAX_TEXT_CHARS + " characters).");
  const voiceId = await resolveVoice(dataRoot, cfg, input);
  const model = String(input.model || cfg.model || DEFAULT_MODEL).trim();
  const settings = {};
  if (input.stability != null) settings.stability = Math.max(0, Math.min(1, Number(input.stability)));
  if (input.similarity != null) settings.similarity_boost = Math.max(0, Math.min(1, Number(input.similarity)));
  if (input.style != null) settings.style = Math.max(0, Math.min(1, Number(input.style)));
  if (input.speed != null) settings.speed = Math.max(0.7, Math.min(1.2, Number(input.speed)));
  const body = { text, model_id: model };
  if (Object.keys(settings).length) body.voice_settings = settings;
  const bytes = await request(cfg.apiKey, "/v1/text-to-speech/" + encodeURIComponent(voiceId) + "?output_format=mp3_44100_128", {
    method: "POST",
    body,
    binary: true,
    timeoutMs: SYNTH_TIMEOUT_MS,
  });
  if (!looksLikeMp3(bytes)) throw new Error("ElevenLabs returned something that is not MP3 audio.");
  const tmp = path.join(os.tmpdir(), "cutline-tts-" + randomUUID() + ".mp3");
  await fsp.writeFile(tmp, bytes);
  return { path: tmp, bytes: bytes.length, voiceId, model, text: text.slice(0, 200) };
}

// Turn a prompt into a music bed. Returns MP3 bytes checked the same way as
// speech. The endpoint streams audio, so it is requested as binary with the
// same origin pin, redirect refusal, and byte cap as TTS.
async function composeMusic(dataRoot, input) {
  const cfg = await readConfig(dataRoot);
  if (!cfg.apiKey) throw new Error("No ElevenLabs API key. Call jeditor_elevenlabs_setup with your key first.");
  const prompt = String(input.prompt || input.text || "").trim();
  if (!prompt) throw new Error("prompt is required.");
  if (prompt.length > MAX_MUSIC_PROMPT_CHARS) {
    throw new Error("prompt is too long (max " + MAX_MUSIC_PROMPT_CHARS + " characters).");
  }
  const model = String(input.model || DEFAULT_MUSIC_MODEL).trim();
  if (!MUSIC_MODELS.includes(model)) {
    throw new Error("Unknown music model. Use one of " + MUSIC_MODELS.join(", ") + ".");
  }
  const body = { prompt, model_id: model };
  const rawLength = input.lengthMs != null ? input.lengthMs : input.musicLengthMs;
  let lengthMs = null;
  if (rawLength != null && rawLength !== "") {
    lengthMs = Math.round(Number(rawLength));
    if (!Number.isFinite(lengthMs) || lengthMs < MIN_MUSIC_MS || lengthMs > MAX_MUSIC_MS) {
      throw new Error("lengthMs must be between " + MIN_MUSIC_MS + " and " + MAX_MUSIC_MS + " milliseconds.");
    }
    body.music_length_ms = lengthMs;
  }
  // force_instrumental only works with a prompt, which is always the case here.
  if (input.instrumental === true || input.forceInstrumental === true) body.force_instrumental = true;
  if (input.seed != null && Number.isFinite(Number(input.seed))) body.seed = Math.trunc(Number(input.seed));
  let bytes;
  try {
    bytes = await request(cfg.apiKey, "/v1/music?output_format=mp3_44100_128", {
      method: "POST",
      body,
      binary: true,
      timeoutMs: MUSIC_TIMEOUT_MS,
    });
  } catch (error) {
    const status = error && error.status;
    if (status === 401 || status === 403) {
      // Remember it so the ElevenLabs page can flag the key until it is fixed.
      await setMusicPermission(dataRoot, "missing").catch(() => {});
      throw new Error(
        "ElevenLabs refused this music request (HTTP " +
          status +
          "). The key is missing the music_generation permission, or it is out of date. " +
          "Add the permission on elevenlabs.io, or create a new key with it on, then retry.",
      );
    }
    throw error;
  }
  if (!looksLikeMp3(bytes)) throw new Error("ElevenLabs returned something that is not MP3 audio.");
  await setMusicPermission(dataRoot, "ok").catch(() => {});
  const tmp = path.join(os.tmpdir(), "cutline-music-" + randomUUID() + ".mp3");
  await fsp.writeFile(tmp, bytes);
  return {
    path: tmp,
    bytes: bytes.length,
    model,
    prompt: prompt.slice(0, 200),
    lengthMs,
    instrumental: Boolean(body.force_instrumental),
  };
}

module.exports = {
  ORIGIN,
  DEFAULT_MODEL,
  AGENT_ACCESS_MODES,
  MUSIC_MODELS,
  DEFAULT_MUSIC_MODEL,
  MIN_MUSIC_MS,
  MAX_MUSIC_MS,
  KEY_SCOPE_PROBES,
  keyFlag,
  checkKeyedProbe,
  configPath,
  readConfig,
  saveKey,
  clearKey,
  savePrefs,
  setMusicPermission,
  grantTtsApproval,
  consumeTtsGrant,
  listVoices,
  listModels,
  voicePreview,
  testKey,
  synthesize,
  composeMusic,
  looksLikeMp3,
};
