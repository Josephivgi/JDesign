// Persisted Record Center setup and OS media status.
// Live Chromium / Windows prompt wiring is electron/media-capture.cjs.
// This file must stay read-only toward the OS. Do not write privacy keys here.
// AppX JV and unpackaged Electron share %APPDATA%\JEditor but not persist:
// capture-setup.json holds { electron, store } buckets. Approving one identity
// does not mark the other approved.

const fs = require("fs/promises");
const path = require("path");
const { randomUUID } = require("crypto");

function setupPath(dataRoot) {
  return path.join(dataRoot, "capture-setup.json");
}

function emptySetup() {
  return {
    screen: false,
    camera: false,
    mic: false,
    soundOn: true,
    micDeviceId: "",
    recordTarget: "full",
    recordArea: null,
    recordFps: 30,
  };
}

const RECORD_FPS_STEPS = [24, 30, 60];

// The bar offers 24, 30, and 60. A stored value lands on the nearest step so
// a hand-edited file cannot produce an unsupported rate.
function normalizeRecordFps(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 30;
  return RECORD_FPS_STEPS.reduce((best, step) => (Math.abs(step - n) < Math.abs(best - n) ? step : best), 30);
}

// The recorder bar's last area, as fractions of the screen. Anything odd
// falls back to no area so a bad file never breaks the bar.
function normalizeRecordArea(raw) {
  if (!raw || typeof raw !== "object") return null;
  const n = (v) => Number(v);
  const x = n(raw.x);
  const y = n(raw.y);
  const w = n(raw.w);
  const h = n(raw.h);
  if (![x, y, w, h].every(Number.isFinite)) return null;
  if (w <= 0.01 || h <= 0.01 || x < 0 || y < 0 || x + w > 1.0001 || y + h > 1.0001) return null;
  return { x, y, w, h };
}

function normalizeSetup(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    screen: Boolean(src.screen),
    camera: Boolean(src.camera),
    mic: Boolean(src.mic),
    soundOn: src.soundOn !== false,
    micDeviceId: typeof src.micDeviceId === "string" ? src.micDeviceId : "",
    recordTarget: src.recordTarget === "area" && normalizeRecordArea(src.recordArea) ? "area" : "full",
    recordArea: normalizeRecordArea(src.recordArea),
    recordFps: normalizeRecordFps(src.recordFps),
  };
}

function recordCenterPrefs(persisted) {
  const src = persisted && typeof persisted === "object" ? persisted : {};
  const recordArea = normalizeRecordArea(src.recordArea);
  return {
    soundOn: src.soundOn !== false,
    micDeviceId: typeof src.micDeviceId === "string" ? src.micDeviceId : "",
    recordTarget: src.recordTarget === "area" && recordArea ? "area" : "full",
    recordArea,
    recordFps: normalizeRecordFps(src.recordFps),
  };
}

function emptyBuckets() {
  return { electron: emptySetup(), store: emptySetup() };
}

function persistIdentity(opts) {
  if (opts && (opts.store || opts.packaged)) return "store";
  return "electron";
}

function identityName(identity) {
  return identity === "store" ? "store" : "electron";
}

function parseBuckets(raw) {
  if (!raw || typeof raw !== "object") return emptyBuckets();
  if (raw.electron || raw.store) {
    return { electron: normalizeSetup(raw.electron), store: normalizeSetup(raw.store) };
  }
  return { electron: emptySetup(), store: normalizeSetup(raw) };
}

async function readBuckets(dataRoot) {
  try {
    const text = await fs.readFile(setupPath(dataRoot), "utf8");
    return parseBuckets(JSON.parse(text));
  } catch {
    return emptyBuckets();
  }
}

async function readCaptureSetup(dataRoot, identity) {
  const all = await readBuckets(dataRoot);
  return normalizeSetup(all[identityName(identity)]);
}

async function writeCaptureSetup(dataRoot, next, identity) {
  const all = await readBuckets(dataRoot);
  const id = identityName(identity);
  all[id] = normalizeSetup(next);
  await fs.mkdir(dataRoot, { recursive: true });
  const dest = setupPath(dataRoot);
  // A pid-only name collides for concurrent writers in one process; the
  // loser's cleanup then deleted the file the winner had just committed.
  const tmp = dest + "." + process.pid + "." + randomUUID() + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(all), "utf8");
  try {
    await fs.rename(tmp, dest);
  } catch {
    await fs.rm(dest, { force: true });
    try {
      await fs.rename(tmp, dest);
    } catch (error) {
      try {
        await fs.unlink(tmp);
      } catch {
        /* tmp already gone */
      }
      throw error;
    }
  }
  return all[id];
}

async function markCaptureApproved(dataRoot, kind, identity) {
  const cur = await readCaptureSetup(dataRoot, identity);
  if (kind === "screen" || kind === "camera" || kind === "mic") cur[kind] = true;
  return writeCaptureSetup(dataRoot, cur, identity);
}

async function saveRecordCenterPrefs(dataRoot, prefs, identity) {
  const cur = await readCaptureSetup(dataRoot, identity);
  if (prefs && typeof prefs.soundOn === "boolean") cur.soundOn = prefs.soundOn;
  if (prefs && typeof prefs.micDeviceId === "string") cur.micDeviceId = prefs.micDeviceId;
  if (prefs && (prefs.recordTarget === "full" || prefs.recordTarget === "area")) cur.recordTarget = prefs.recordTarget;
  if (prefs && "recordArea" in prefs) cur.recordArea = normalizeRecordArea(prefs.recordArea);
  if (prefs && "recordFps" in prefs) cur.recordFps = normalizeRecordFps(prefs.recordFps);
  return writeCaptureSetup(dataRoot, cur, identity);
}

function osMediaStatus(kind, prefs) {
  if (!prefs || typeof prefs.getMediaAccessStatus !== "function") return "";
  const map = { screen: "screen", camera: "camera", mic: "microphone" };
  const media = map[kind];
  if (!media) return "";
  try {
    return String(prefs.getMediaAccessStatus(media) || "");
  } catch {
    return "";
  }
}

// Test hook. A JSON file like {"platform":"win32","microphone":"denied"}
// stands in for the OS answer so the blocked flow can be driven on a guest
// that has no Windows privacy store. Unset in normal runs.
function fakeMediaPrefs(override, real) {
  const src = override && typeof override === "object" ? override : {};
  return {
    getMediaAccessStatus(media) {
      if (typeof src[media] === "string") return src[media];
      if (real && typeof real.getMediaAccessStatus === "function") return real.getMediaAccessStatus(media);
      return "";
    },
    askForMediaAccess: real && typeof real.askForMediaAccess === "function" ? real.askForMediaAccess.bind(real) : undefined,
  };
}

function osMediaOk(kind, prefs) {
  const status = osMediaStatus(kind, prefs);
  if (status === "granted") return true;
  if (status === "denied" || status === "restricted") return false;
  return null;
}

// The OS owns microphone and camera consent for desktop apps. JV cannot
// grant it. Writing the CapabilityAccessManager registry keys does not change
// what Windows enforces (camsvc keeps its own state), it only desyncs the
// Settings display from the real state. The only working path is the OS
// privacy page, so we deep link to it and wait for the status to flip.
function osSettingsUrl(kind, platform, opts) {
  const os = platform || process.platform;
  const store = Boolean(opts && opts.store);
  if (kind === "screen") {
    if (os === "win32" && store) return "ms-settings:privacy-graphicscaptureprogrammatic";
    return "";
  }
  if (kind !== "mic" && kind !== "camera") return "";
  if (os === "win32") return kind === "mic" ? "ms-settings:privacy-microphone" : "ms-settings:privacy-webcam";
  if (os === "darwin") {
    return (
      "x-apple.systempreferences:com.apple.preference.security?" +
      (kind === "mic" ? "Privacy_Microphone" : "Privacy_Camera")
    );
  }
  return "";
}

function osSettingsLabel(platform) {
  const os = platform || process.platform;
  if (os === "win32") return "Windows Settings";
  if (os === "darwin") return "System Settings";
  return "system settings";
}

// Chromium reports an OS level block as NotAllowedError with a message that
// names the system. Our own permission handler always grants "media", so a
// NotAllowedError on mic or camera can only come from the OS.
function isOsDeniedError(err) {
  const name = err && err.name;
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") return true;
  return /denied by system/i.test(String((err && err.message) || ""));
}

// Windows getMediaAccessStatus often flickers denied to unknown or
// not-determined. Unknown is not a grant. Keep the last denial until the OS
// reports granted or a successful probe clears it.
const WAIT_ACCESS_STEP_MS = 500;
const WAIT_ACCESS_STABLE_MS = 1500;

function emptyLastDenied() {
  return { mic: false, camera: false };
}

function lastDeniedMap(lastDenied) {
  if (lastDenied && typeof lastDenied === "object") return lastDenied;
  return emptyLastDenied();
}

function rememberOsDenied(lastDenied, kind, prefs) {
  const next = lastDeniedMap(lastDenied);
  if (kind !== "mic" && kind !== "camera") return next;
  const os = osMediaOk(kind, prefs);
  if (os === false) next[kind] = true;
  if (os === true) next[kind] = false;
  return next;
}

function noteCaptureDenied(lastDenied, kind) {
  const next = lastDeniedMap(lastDenied);
  if (kind === "mic" || kind === "camera") next[kind] = true;
  return next;
}

function clearCaptureDenied(lastDenied, kind) {
  const next = lastDeniedMap(lastDenied);
  if (kind === "mic" || kind === "camera") next[kind] = false;
  return next;
}

function isOsDeniedNow(kind, prefs, lastDenied) {
  const os = osMediaOk(kind, prefs);
  if (os === false) return true;
  if (os === true) return false;
  return Boolean(lastDenied && lastDenied[kind]);
}

// Wait until granted, or until unknown stays off denied long enough that a
// single flicker cannot end the wait. A denial that is still sticky does not
// count as success on the first unknown poll.
function waitAccessDecision(kind, prefs, lastDenied, stableMs, opts) {
  rememberOsDenied(lastDenied, kind, prefs);
  const step = opts && opts.stepMs != null ? Number(opts.stepMs) : WAIT_ACCESS_STEP_MS;
  const need = opts && opts.stableMs != null ? Number(opts.stableMs) : WAIT_ACCESS_STABLE_MS;
  const os = osMediaOk(kind, prefs);
  if (os === true) return { done: true, ok: true, stableMs: 0 };
  if (os === false) return { done: false, ok: false, stableMs: 0 };
  if (!lastDenied || !lastDenied[kind]) return { done: true, ok: true, stableMs: 0 };
  const next = (Number(stableMs) || 0) + Math.max(1, step);
  if (next >= need) return { done: true, ok: true, stableMs: next };
  return { done: false, ok: false, stableMs: next };
}

function mediaTypesFrom(details) {
  if (details && Array.isArray(details.mediaTypes) && details.mediaTypes.length) {
    return details.mediaTypes;
  }
  const one = details && details.mediaType;
  if (one === "audio" || one === "video") return [one];
  return [];
}

function permissionKind(permission, details, intent, consent) {
  if (permission === "display-capture") return "screen";
  const types = mediaTypesFrom(details);
  const source = intent && intent.source;
  const wantsMic = Boolean(intent && (intent.mic || source === "mic"));
  const screenOk = Boolean(consent && consent.screen);
  if (types.includes("video")) {
    if (source === "camera") return "camera";
    if (!screenOk) return "screen";
    return "camera";
  }
  if (types.includes("audio")) return "mic";
  if (wantsMic) return "mic";
  if (source === "camera") return "camera";
  if (!screenOk && source !== "camera") return "screen";
  return "mic";
}

function kindOk(persisted, kind, prefs, lastDenied) {
  const os = osMediaOk(kind, prefs);
  if (os === false) return false;
  if (os === true) return true;
  if ((kind === "mic" || kind === "camera") && lastDenied && lastDenied[kind]) return false;
  return Boolean(persisted && persisted[kind]);
}

// Name Windows shows for this process in the privacy page app list. A packaged
// build is "JV". From source it is the Electron binary, so the list says
// "Electron" and people looking for JV do not find it.
function osAppLabel(packaged) {
  return packaged ? "JV" : "Electron";
}

function captureSetupStatus(persisted, prefs, platform, opts) {
  const os = platform || process.platform;
  const lastDenied = opts && opts.lastDenied;
  if (lastDenied) {
    rememberOsDenied(lastDenied, "mic", prefs);
    rememberOsDenied(lastDenied, "camera", prefs);
  }
  const screen = kindOk(persisted, "screen", prefs, lastDenied);
  const camera = kindOk(persisted, "camera", prefs, lastDenied);
  const mic = kindOk(persisted, "mic", prefs, lastDenied);
  const packaged = Boolean(opts && opts.packaged);
  // An AppX (MSIX) install has package identity. Windows then lists JV by
  // name under "Let apps access your microphone" with its own switch, and shows
  // the consent prompt on first use. The desktop-apps switch does not apply.
  const store = Boolean(opts && opts.store);
  const storeSibling = Boolean(opts && opts.storeSibling);
  return {
    ready: screen,
    platform: os,
    settingsLabel: osSettingsLabel(os),
    appLabel: osAppLabel(packaged || store),
    store,
    storeSibling,
    screen: {
      ok: screen,
      settingsUrl: osSettingsUrl("screen", os, { store }),
    },
    camera: {
      ok: camera,
      os: osMediaStatus("camera", prefs),
      osDenied: isOsDeniedNow("camera", prefs, lastDenied),
      settingsUrl: osSettingsUrl("camera", os, { store }),
    },
    mic: {
      ok: mic,
      os: osMediaStatus("mic", prefs),
      osDenied: isOsDeniedNow("mic", prefs, lastDenied),
      settingsUrl: osSettingsUrl("mic", os, { store }),
    },
    prefs: recordCenterPrefs(persisted),
  };
}

module.exports = {
  emptySetup,
  persistIdentity,
  readCaptureSetup,
  writeCaptureSetup,
  markCaptureApproved,
  saveRecordCenterPrefs,
  recordCenterPrefs,
  captureSetupStatus,
  osMediaOk,
  osMediaStatus,
  fakeMediaPrefs,
  osSettingsUrl,
  osSettingsLabel,
  osAppLabel,
  isOsDeniedError,
  mediaTypesFrom,
  permissionKind,
  kindOk,
  emptyLastDenied,
  rememberOsDenied,
  noteCaptureDenied,
  clearCaptureDenied,
  isOsDeniedNow,
  waitAccessDecision,
  WAIT_ACCESS_STEP_MS,
  WAIT_ACCESS_STABLE_MS,
};
