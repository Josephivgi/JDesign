// Windows microphone, camera, and screen capture.
//
// Keep this file small and about permissions only. Do not fold it back into
// electron/main.cjs. Record Center UI lives in renderer/js/record-center.js.
// Persisted setup and OS status live in lib/capture-setup.js. This file is the
// live Chromium session, OS prompt, and IPC.
//
// Why permissions keep breaking
// -----------------------------
// Windows has two JV identities that share %APPDATA%\JEditor:
//   1. AppX JEditor.Desktop (Start menu / npm start). Privacy rows name Cutline.
//   2. Unpackaged Electron.exe (npm run start:electron). Privacy rows name Electron
//      under "Let desktop apps access".
// Approving one does not grant the other. Persist is { electron, store } in
// capture-setup.json. If Settings has no JV row, the process was Electron,
// or the AppX never registered the capability.
//
// Origin timeline (do not replay):
//   81d16db  in-app Allow wrote OS privacy keys. Settings showed On; camsvc still denied.
//   8eb7a37  stopped writing those keys. OS privacy page is the only grant.
//   aa0943d  AppX identity so Windows lists JV by name and can prompt.
//   a3c5491  same-version reinstall restores Allow. Restore-AppPrivacy takes two
//            space-separated args. Restore-AppPrivacy($a, $b) is one array and
//            drops Allow.
// Same-version Remove-AppxPackage still drops the real camsvc grant. A registry
// restore is not a grant. build-appx.cjs bumps Identity Version so install:appx
// updates in place. Remove only when the incoming version matches.
//
// Do not
// ------
// - Write HKCU CapabilityAccessManager privacy keys from JS. Product code never
//   grants OS consent. install-appx.ps1 may restore a backup after Remove-AppxPackage
//   only. That is not a grant.
// - Gate Chromium on JV's Allow dialog. The session must allow "media"
//   and "display-capture" or getUserMedia never reaches Windows, so no prompt
//   and no JV row.
// - Change identityName JEditor.Desktop, publisher CN=JEditor Dev, or drop
//   DeviceCapability microphone / webcam / graphicsCaptureProgrammatic from
//   build/appxmanifest.xml.
// - Launch electron.exe for daily mic/camera use. npm start must open the AppX
//   when it is installed (scripts/start.cjs).
// - Treat askForMediaAccess as a Windows prompt. On Windows it does not ask;
//   it rereads status. The OS prompt is packaged-app first use, or Settings.
// - Treat unknown or not-determined as a grant after a denial. Windows often
//   flickers denied to unknown. That is how a permission failure disappears.
// Do
// --
// - Daily mic/camera: installed AppX, then Record Center Approve.
// - Source runs: npm run start:electron, then the Electron desktop-apps switch.
// - After Record Center main-process edits: rebuild and reinstall AppX before
//   expecting the installed build to match.
// - JV Allow or Block is once per device. Do not require osMediaOk to skip
//   it. Windows often never reports screen as granted, so that check popped the
//   same dialog again on getDisplayMedia and on Record.
// - Keep the last mic or camera denial until OS granted or a probe succeeds
//   (mark-capture-approved). wait-capture-access needs granted, or a stable
//   stretch of unknown, not the first flicker.
const fssync = require("fs");
const { execFile } = require("child_process");
const {
  readCaptureSetup,
  markCaptureApproved,
  saveRecordCenterPrefs,
  captureSetupStatus,
  osMediaOk: osMediaOkWith,
  fakeMediaPrefs,
  osSettingsUrl,
  persistIdentity,
  permissionKind,
  rememberOsDenied,
  noteCaptureDenied,
  clearCaptureDenied,
  isOsDeniedNow,
  waitAccessDecision,
  WAIT_ACCESS_STEP_MS,
  WAIT_ACCESS_STABLE_MS,
} = require("../lib/capture-setup");
const { keepCaptureSource } = require("../lib/capture-source-filter.cjs");

const APPX_PACKAGE_NAME = "JEditor.Desktop";
const CAPTURE_SOURCES_MS = 8000;
const CAPTURE_SOURCE_TYPES = ["screen", "window"];
const THUMBNAIL_SIZE = { width: 960, height: 540 };
const THUMBNAIL_TAB_SIZE = { width: 480, height: 270 };
const THUMBNAIL_JPEG_QUALITY = 80;
const THUMBNAIL_TAB_JPEG_QUALITY = 72;
const WAIT_ACCESS_MAX_MS = 5 * 60 * 1000;
const STORE_SIBLING_MS = 2000;
const STORE_SIBLING_CACHE_MS = 60000;
const CAPTURE_STATUS_CACHE_MS = 2500;

function loadElectron(host) {
  if (host && host.electron) return host.electron;
  return require("electron");
}

function attachMediaCapture(host) {
  const electron = loadElectron(host);
  const { app, BrowserWindow, dialog, shell, desktopCapturer, systemPreferences, screen } = electron;
  const ipcMain = (host && host.ipcMain) || electron.ipcMain;
  const dataRoot = host.dataRoot;
  const isOverlayWindow = host.isOverlayWindow || (() => false);
  const SMOKE = Boolean(host.smoke);
  const waitStepMs = Number(host && host.waitStepMs) > 0 ? Number(host.waitStepMs) : WAIT_ACCESS_STEP_MS;
  const waitStableMs = Number(host && host.waitStableMs) > 0 ? Number(host.waitStableMs) : WAIT_ACCESS_STABLE_MS;

  let preferredCaptureSourceId = "auto";
  // The recorder bar pins its take to the display it opened on so a take
  // cannot land on the screen the pointer drifted to mid-load.
  let pinnedDisplayId = "";
  let cachedCaptureSources = [];
  let captureSourcesLock = null;
  // Bumped on invalidate so an enumeration in flight cannot repopulate the
  // cache with the pre-change list.
  let captureSourcesGen = 0;
  let captureThumbnailsLock = null;
  let captureThumbnailsKey = "";
  let captureSessionWired = false;
  let captureSessionRef = null;
  let captureConsent = emptyCaptureConsent();
  const capturePrompts = { screen: null, camera: null, mic: null };
  let captureIntent = { source: "screen", mic: true };
  let storeSiblingCache = null;
  let storeSiblingPending = false;
  let storeSiblingCacheAt = 0;
  let captureStatusCache = null;
  const waitGeneration = { mic: 0, camera: 0 };
  const lastDenied = { mic: false, camera: false };
  let lastPermissionKind = "";

  function emptyCaptureConsent() {
    return { screen: false, camera: false, mic: false };
  }

  function denyDisplayMedia(callback) {
    callback({});
  }

  function allowCapturePermission(permission) {
    if (permission === "fullscreen" || permission === "media" || permission === "display-capture") return true;
    return false;
  }

  function rememberPermission(permission, details) {
    lastPermissionKind = permissionKind(permission, details || {}, captureIntent, captureConsent);
    return lastPermissionKind;
  }

  // JEDITOR_OS_MEDIA_FILE, or the old CUTLINE_OS_MEDIA_FILE, points at a JSON
  // file that fakes the OS answer (see fakeMediaPrefs). Only guest test runs set
  // it. Tests may also pass host.osMedia so Node can drive the same path
  // without a tempfile.
  function osMediaOverride() {
    if (host && host.osMedia && typeof host.osMedia === "object") return host.osMedia;
    const file = process.env.JEDITOR_OS_MEDIA_FILE || process.env.CUTLINE_OS_MEDIA_FILE;
    if (!file) return null;
    try {
      const parsed = JSON.parse(fssync.readFileSync(file, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  function osPrefs() {
    const override = osMediaOverride();
    return override ? fakeMediaPrefs(override, systemPreferences) : systemPreferences;
  }

  function osPlatform() {
    const override = osMediaOverride();
    return override && typeof override.platform === "string" ? override.platform : process.platform;
  }

  function osMediaOk(kind) {
    return osMediaOkWith(kind, osPrefs());
  }

  // True inside an AppX (MSIX) or Mac App Store install: the OS knows the app by
  // package identity and lists it by name with its own privacy switch.
  function osStoreInstall() {
    const override = osMediaOverride();
    if (override && typeof override.store === "boolean") return override.store;
    return Boolean(process.windowsStore || process.mas);
  }

  function windowsStoreSiblingInstalled() {
    if (host && host.skipStoreSibling) return false;
    if (osStoreInstall()) return false;
    if (process.platform !== "win32" || SMOKE) return false;
    // A synchronous powershell here froze the whole app for up to two
    // seconds (Windows showed Not Responding). The lookup runs in the
    // background and status reads the last answer; the answer rarely changes.
    const fresh = storeSiblingCache !== null && Date.now() - storeSiblingCacheAt < STORE_SIBLING_CACHE_MS;
    if (!fresh && !storeSiblingPending) {
      storeSiblingPending = true;
      execFile(
        "powershell.exe",
        ["-NoProfile", "-Command", "(Get-AppxPackage -Name " + APPX_PACKAGE_NAME + " -ErrorAction SilentlyContinue).PackageFamilyName"],
        { encoding: "utf8", timeout: STORE_SIBLING_MS, windowsHide: true },
        (error, out) => {
          storeSiblingPending = false;
          const next = !error && Boolean(String(out || "").trim());
          const changed = next !== storeSiblingCache;
          storeSiblingCache = next;
          storeSiblingCacheAt = Date.now();
          if (changed) invalidateSetupStatusCache();
        },
      );
    }
    return Boolean(storeSiblingCache);
  }

  function persistId() {
    return persistIdentity({ store: osStoreInstall(), packaged: app.isPackaged });
  }

  function captureStatus(persisted, opts) {
    const prefs = osPrefs();
    rememberOsDenied(lastDenied, "mic", prefs);
    rememberOsDenied(lastDenied, "camera", prefs);
    const skipSibling = Boolean(opts && opts.skipStoreSibling);
    return captureSetupStatus(persisted, prefs, osPlatform(), {
      packaged: app.isPackaged,
      store: osStoreInstall(),
      storeSibling: skipSibling ? false : windowsStoreSiblingInstalled(),
      lastDenied,
    });
  }

  // Status polls run on a timer while agent pages are open. Reading OS media
  // consent touches the Windows capability stack each call, so identical
  // polls inside a short window reuse the last computed answer. Consent
  // changes always invalidate (invalidateSetupStatusCache).
  function captureStatusCached(persisted, opts) {
    // Test/dev overrides feed live OS answers; those must stay fresh.
    if (osMediaOverride()) return captureStatus(persisted, opts);
    const key = [
      persisted && persisted.screen,
      persisted && persisted.mic,
      persisted && persisted.camera,
      Boolean(opts && opts.skipStoreSibling),
      lastDenied.mic,
      lastDenied.camera,
    ].join(",");
    if (captureStatusCache && captureStatusCache.key === key && Date.now() - captureStatusCache.at < CAPTURE_STATUS_CACHE_MS) {
      return captureStatusCache.value;
    }
    const value = captureStatus(persisted, opts);
    captureStatusCache = { key, at: Date.now(), value };
    return value;
  }

  let cachedPersistedConsent = null;
  let persistedConsentInflight = null;

  function invalidateSetupStatusCache() {
    cachedPersistedConsent = null;
    persistedConsentInflight = null;
    captureStatusCache = null;
  }

  function publishSetupStatus(persisted) {
    cachedPersistedConsent = persisted;
    persistedConsentInflight = null;
    return captureStatus(persisted, { skipStoreSibling: true });
  }

  async function readPersistedConsent() {
    if (cachedPersistedConsent) return cachedPersistedConsent;
    if (persistedConsentInflight) return persistedConsentInflight;
    persistedConsentInflight = restoreApprovedConsent().then((persisted) => {
      cachedPersistedConsent = persisted;
      persistedConsentInflight = null;
      return persisted;
    });
    return persistedConsentInflight;
  }

  async function resolveSetupStatus(opts) {
    const skipSibling = !(opts && opts.full);
    let persisted = await readPersistedConsent();
    let status = captureStatusCached(persisted, { skipStoreSibling: skipSibling });
    if (status.ready && !persisted.screen) {
      persisted = await markCaptureApproved(dataRoot(), "screen", persistId());
      cachedPersistedConsent = persisted;
      captureStatusCache = null;
      status = captureStatusCached(persisted, { skipStoreSibling: skipSibling });
    }
    return status;
  }

  // JV never writes OS privacy state. On Windows the CapabilityAccessManager
  // registry mirror is not what camsvc enforces, so a "reg add Allow" leaves the
  // mic blocked while Settings shows it on. Consent is read here and changed by
  // the user in the OS privacy page (see open-capture-settings).
  async function restoreApprovedConsent() {
    const persisted = await readCaptureSetup(dataRoot(), persistId());
    if (persisted.screen) captureConsent.screen = true;
    const prefs = osPrefs();
    rememberOsDenied(lastDenied, "mic", prefs);
    rememberOsDenied(lastDenied, "camera", prefs);
    if (persisted.mic && !isOsDeniedNow("mic", prefs, lastDenied)) captureConsent.mic = true;
    if (persisted.camera && !isOsDeniedNow("camera", prefs, lastDenied)) captureConsent.camera = true;
    return persisted;
  }

  // Poll the OS consent until it stops being denied. The user is flipping the
  // switch in Windows Settings or macOS System Settings while this runs. Stop
  // waiting (cancel-capture-wait) ends it early.
  async function waitForOsAccess(kind, timeoutMs) {
    const limit = Math.min(WAIT_ACCESS_MAX_MS, Math.max(waitStepMs, Number(timeoutMs) || 120000));
    const until = Date.now() + limit;
    const gen = ++waitGeneration[kind];
    let stableMs = 0;
    while (true) {
      if (waitGeneration[kind] !== gen) return false;
      const decision = waitAccessDecision(kind, osPrefs(), lastDenied, stableMs, {
        stepMs: waitStepMs,
        stableMs: waitStableMs,
      });
      stableMs = decision.stableMs;
      if (decision.done) return decision.ok;
      if (Date.now() >= until) return false;
      await new Promise((resolve) => setTimeout(resolve, waitStepMs));
    }
  }

  function cancelOsAccessWait(kind) {
    if (kind !== "mic" && kind !== "camera") return false;
    waitGeneration[kind] += 1;
    return true;
  }

  function consentKey(kind) {
    return kind === "camera" || kind === "mic" ? kind : "screen";
  }

  // On macOS this raises the system prompt. On Windows there is nothing to ask;
  // the status comes back as it is. Packaged first use is what creates the
  // JV row on the privacy page.
  async function askOsMediaAccess(kind) {
    if (kind !== "mic" && kind !== "camera") return true;
    if (typeof systemPreferences.askForMediaAccess !== "function") return true;
    const media = kind === "mic" ? "microphone" : "camera";
    try {
      return Boolean(await systemPreferences.askForMediaAccess(media));
    } catch {
      return osMediaOk(kind) !== false;
    }
  }

  function promptCopyForKind(kind) {
    if (kind === "camera") {
      return {
        message: "JV wants to use the camera.",
        detail: "The take is saved to Videos on this computer.",
      };
    }
    if (kind === "mic") {
      return {
        message: "JV wants to use the microphone.",
        detail: "Turn Sound off on the recorder bar if you do not want sound.",
      };
    }
    return {
      message: "JV wants to record this screen.",
      detail: "The take is saved to Videos on this computer.",
    };
  }

  function resetCaptureConsent(kinds) {
    if (!kinds || kinds.all) {
      captureConsent = emptyCaptureConsent();
      invalidateSetupStatusCache();
      return;
    }
    if (kinds.screen) captureConsent.screen = false;
    if (kinds.camera) captureConsent.camera = false;
    if (kinds.mic) captureConsent.mic = false;
    invalidateSetupStatusCache();
  }

  function parentWindow(win) {
    if (win && !win.isDestroyed() && !isOverlayWindow(win)) return win;
    const focused = BrowserWindow.getFocusedWindow();
    if (focused && !focused.isDestroyed() && !isOverlayWindow(focused)) return focused;
    const all = BrowserWindow.getAllWindows().filter((w) => w && !w.isDestroyed() && !isOverlayWindow(w));
    return all[0];
  }

  async function promptKind(win, kind, opts) {
    const key = consentKey(kind);
    if (SMOKE) {
      captureConsent[key] = true;
      return true;
    }
    // A held consent answers first so the bar does not wait on a sync OS
    // capability read every time a capture opens.
    if (captureConsent[key]) return true;
    if (osMediaOk(key) === true) {
      captureConsent[key] = true;
      return true;
    }
    // Pressing Sound on the recorder bar is the consent. A second Allow or
    // Block box can sit hidden behind the bar, so the OS check is the only ask.
    if (opts && opts.implied && key === "mic") {
      captureConsent[key] = true;
      await askOsMediaAccess(key);
      return true;
    }
    // A prompt already in flight answers for every caller; a second force
    // would stack a hidden Allow/Block behind the first.
    if (capturePrompts[key]) return capturePrompts[key];
    capturePrompts[key] = (async () => {
      const copy = promptCopyForKind(key);
      // A modal child of a hidden or occluded main window is invisible, so
      // the bar sits loading until it times out. Parent only when the window
      // can actually be seen.
      const parent = parentWindow(win);
      const box = {
        type: "question",
        buttons: ["Allow", "Block"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
        title: "Record Center",
        message: copy.message,
        detail: copy.detail,
      };
      const result =
        parent && !parent.isDestroyed() && parent.isVisible()
          ? await dialog.showMessageBox(parent, box)
          : await dialog.showMessageBox(box);
      const ok = result.response === 0;
      if (ok) {
        captureConsent[key] = true;
        if (key === "mic" || key === "camera") {
          await askOsMediaAccess(key);
        }
      }
      return ok;
    })().finally(() => {
      capturePrompts[key] = null;
    });
    return capturePrompts[key];
  }

  function captureSourceKind(id) {
    return String(id).startsWith("window:") ? "window" : "screen";
  }

  function mapCaptureSource(item) {
    const id = String(item.id);
    const kind = captureSourceKind(id);
    return { id, name: item.name || (kind === "window" ? "Window" : "Screen"), kind };
  }

  function mapCaptureSourceWithThumb(item, quality) {
    const mapped = mapCaptureSource(item);
    mapped.thumbnail = sourceThumbData(item.thumbnail, quality);
    return mapped;
  }

  function sourceThumbData(image, quality) {
    if (!image || typeof image.isEmpty !== "function" || image.isEmpty()) return "";
    const q = Number(quality) > 0 ? Number(quality) : THUMBNAIL_JPEG_QUALITY;
    try {
      const jpeg = image.toJPEG(q);
      if (!jpeg || !jpeg.length) return "";
      return "data:image/jpeg;base64," + jpeg.toString("base64");
    } catch {
      try {
        return image.toDataURL() || "";
      } catch {
        return "";
      }
    }
  }

  // "auto" is the screen under the pointer, the one the user is on. While
  // the recorder bar is up it is the pinned display instead.
  function autoScreenPick(list) {
    const screens = list.filter((item) => String(item && item.id).startsWith("screen:"));
    if (pinnedDisplayId) {
      const pinned = screens.find((item) => String(item.display_id || "") === pinnedDisplayId);
      if (pinned) return pinned;
    }
    try {
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      const id = String(display && display.id);
      return (
        screens.find((item) => String(item.display_id || "") === id) ||
        screens.find((item) => item.id === "screen:" + id) ||
        screens[0] ||
        null
      );
    } catch {
      return null;
    }
  }

  // Auto and area takes record a screen; a Window take records the picked
  // window. A stale window id (the window closed) falls back to Auto's
  // screen rather than failing the take.
  function captureSourcePick(sources) {
    const list = Array.isArray(sources) ? sources : [];
    if (preferredCaptureSourceId.startsWith("window:")) {
      const win = list.find((item) => item.id === preferredCaptureSourceId);
      if (win) return win;
    }
    const screens = list.filter((item) => String(item && item.id).startsWith("screen:"));
    const named = preferredCaptureSourceId.startsWith("screen:")
      ? screens.find((item) => item.id === preferredCaptureSourceId)
      : null;
    return named || autoScreenPick(screens) || screens[0] || null;
  }

  function captureSourcesTimeout(promise) {
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("timed out")), CAPTURE_SOURCES_MS);
      }),
    ]);
  }

  function getCaptureSources() {
    if (!captureSourcesLock) {
      const gen = captureSourcesGen;
      captureSourcesLock = captureSourcesTimeout(
        desktopCapturer
          .getSources({
            types: CAPTURE_SOURCE_TYPES,
            thumbnailSize: { width: 0, height: 0 },
            fetchWindowIcons: false,
          })
          .then((sources) => {
            const list = (Array.isArray(sources) ? sources : []).filter(keepCaptureSource);
            if (gen === captureSourcesGen) cachedCaptureSources = list;
            return list;
          }),
      ).finally(() => {
        captureSourcesLock = null;
      });
    }
    return captureSourcesLock;
  }

  function normalizeThumbMode(payload) {
    const mode = payload && payload.mode ? String(payload.mode) : "all";
    if (mode === "selected" || mode === "tabs" || mode === "windows") return mode;
    return "all";
  }

  function thumbSizeForMode(mode) {
    return mode === "tabs" ? THUMBNAIL_TAB_SIZE : THUMBNAIL_SIZE;
  }

  function thumbQualityForMode(mode) {
    return mode === "tabs" ? THUMBNAIL_TAB_JPEG_QUALITY : THUMBNAIL_JPEG_QUALITY;
  }

  function mapSourcesWithThumbs(sources, mode, sourceId, screensOnly, gen) {
    let list = (Array.isArray(sources) ? sources : []).filter(keepCaptureSource);
    if (mode === "windows") {
      // The window picker shows every recordable window; screen sources are
      // left out and stay in the cache for screen takes.
      const windows = list.filter((item) => String(item && item.id).startsWith("window:"));
      const quality = thumbQualityForMode(mode);
      return windows.map((item) => mapCaptureSourceWithThumb(item, quality));
    }
    if (screensOnly) {
      // Only screens were grabbed; keep the known windows (names only) so
      // the source tabs do not lose them.
      const windows = cachedCaptureSources.filter((item) => String(item && item.id).startsWith("window:"));
      list = list.filter((item) => !String(item.id).startsWith("window:")).concat(windows);
    }
    // An enumeration that spans a display change must not repopulate the
    // cache the invalidation just cleared.
    if (gen === captureSourcesGen) cachedCaptureSources = list;
    const quality = thumbQualityForMode(mode);
    const pickId = sourceId ? String(sourceId) : preferredCaptureSourceId;
    if (mode === "selected") {
      return list.map((item) => {
        const mapped = mapCaptureSource(item);
        if (!pickId || String(item.id) === pickId) {
          mapped.thumbnail = sourceThumbData(item.thumbnail, quality);
        }
        return mapped;
      });
    }
    if (mode === "tabs") {
      return list.map((item) => {
        const mapped = mapCaptureSource(item);
        if (pickId && String(item.id) === pickId) return mapped;
        mapped.thumbnail = sourceThumbData(item.thumbnail, quality);
        return mapped;
      });
    }
    return list.map((item) => mapCaptureSourceWithThumb(item, quality));
  }

  function getCaptureSourceThumbnails(payload) {
    const mode = normalizeThumbMode(payload);
    const sourceId = payload && payload.sourceId ? String(payload.sourceId) : "";
    const key = mode + " " + sourceId;
    if (captureThumbnailsLock && captureThumbnailsKey === key) return captureThumbnailsLock;
    // A picture of one screen does not need every window grabbed at 960x540,
    // which was the heaviest thing the preview did on the main process.
    const pickId = sourceId || preferredCaptureSourceId || "";
    const screensOnly = mode === "selected" && pickId.startsWith("screen:") && cachedCaptureSources.length > 0;
    const start = () => {
      const gen = captureSourcesGen;
      captureThumbnailsKey = key;
      captureThumbnailsLock = captureSourcesTimeout(
        desktopCapturer.getSources({
          types: mode === "windows" ? ["window"] : screensOnly ? ["screen"] : CAPTURE_SOURCE_TYPES,
          thumbnailSize: thumbSizeForMode(mode),
          fetchWindowIcons: false,
        }),
      )
        .then((sources) => mapSourcesWithThumbs(sources, mode, sourceId, screensOnly, gen))
        .finally(() => {
          captureThumbnailsLock = null;
          captureThumbnailsKey = "";
        });
      return captureThumbnailsLock;
    };
    if (captureThumbnailsLock) {
      // A different mode or sourceId cannot share the in-flight result; run
      // right after it instead of answering with the wrong thumbnails.
      return captureThumbnailsLock.catch(() => {}).then(start);
    }
    return start();
  }

  async function sourcesForDisplayMedia() {
    if (
      cachedCaptureSources.length &&
      (preferredCaptureSourceId === "auto" ||
        !preferredCaptureSourceId ||
        cachedCaptureSources.some((item) => item.id === preferredCaptureSourceId))
    ) {
      return cachedCaptureSources;
    }
    try {
      return await getCaptureSources();
    } catch {
      return cachedCaptureSources;
    }
  }

  function registerHandle(channel, handler) {
    if (typeof ipcMain.removeHandler === "function") {
      try {
        ipcMain.removeHandler(channel);
      } catch {
        /* channel was not registered yet */
      }
    }
    ipcMain.handle(channel, handler);
  }

  function wireMediaCapture(win) {
    if (!win || !win.webContents || !win.webContents.session) return;
    const sess = win.webContents.session;
    if (captureSessionWired && captureSessionRef === sess) return;
    captureSessionWired = true;
    captureSessionRef = sess;
    sess.setPermissionCheckHandler((_wc, permission, _origin, details) => {
      rememberPermission(permission, details);
      return allowCapturePermission(permission);
    });
    sess.setPermissionRequestHandler((_wc, permission, callback, details) => {
      rememberPermission(permission, details);
      callback(allowCapturePermission(permission));
    });
    if (typeof sess.setDevicePermissionHandler === "function") {
      sess.setDevicePermissionHandler((details) => {
        const type = String((details && (details.deviceType || details.mediaType)) || "").toLowerCase();
        if (type.includes("hid") || type.includes("serial") || type.includes("usb") || type.includes("bluetooth")) {
          return false;
        }
        return true;
      });
    }
    sess.setDisplayMediaRequestHandler(async (_request, callback) => {
      try {
        const allowed = await promptKind(win, "screen");
        if (!allowed) {
          denyDisplayMedia(callback);
          return;
        }
        let sources = await sourcesForDisplayMedia();
        let picked = captureSourcePick(sources);
        if (!picked) {
          // A transient getSources failure or timeout must not read as a
          // user denial: once more, fresh, before giving up.
          try {
            sources = await getCaptureSources();
            picked = captureSourcePick(sources);
          } catch {
            /* still nothing */
          }
        }
        if (!picked) {
          denyDisplayMedia(callback);
          return;
        }
        callback({ video: picked });
      } catch {
        denyDisplayMedia(callback);
      }
    });
  }

  registerHandle("list-capture-sources", async () => {
    try {
      const sources = await getCaptureSources();
      return sources.map(mapCaptureSource);
    } catch {
      return cachedCaptureSources.map(mapCaptureSource);
    }
  });

  registerHandle("capture-source-thumbnails", async (_event, payload) => {
    const mode = normalizeThumbMode(payload);
    const sourceId = payload && payload.sourceId ? String(payload.sourceId) : "";
    try {
      return await getCaptureSourceThumbnails(payload);
    } catch {
      return mapSourcesWithThumbs(cachedCaptureSources, mode, sourceId);
    }
  });

  registerHandle("set-capture-source", (_event, payload) => {
    preferredCaptureSourceId = payload && payload.id ? String(payload.id) : "auto";
    return { ok: true };
  });

  registerHandle("set-capture-intent", (_event, payload) => {
    const source = payload && payload.source ? String(payload.source) : "screen";
    const normalized = source === "camera" || source === "both" || source === "mic" ? source : "screen";
    const mic =
      payload && Object.prototype.hasOwnProperty.call(payload, "mic") ? Boolean(payload.mic) : normalized === "mic";
    captureIntent = { source: normalized, mic };
    return { ok: true, intent: captureIntent };
  });

  registerHandle("reset-capture-consent", (_event, payload) => {
    resetCaptureConsent(payload || { all: true });
    return { ok: true };
  });

  registerHandle("capture-setup-status", async (_event, payload) => {
    if (SMOKE) {
      return {
        ready: true,
        screen: { ok: true },
        camera: { ok: true },
        mic: { ok: true },
      };
    }
    return resolveSetupStatus({ full: Boolean(payload && payload.full) });
  });

  // Re-read OS consent. On macOS this also raises the system prompt. On Windows
  // there is nothing to ask; the status comes back as it is.
  registerHandle("ensure-capture-access", async (_event, payload) => {
    invalidateSetupStatusCache();
    const kind = payload && payload.kind ? String(payload.kind) : "";
    if (kind === "mic" || kind === "camera") {
      await askOsMediaAccess(kind);
    }
    const persisted = await readCaptureSetup(dataRoot(), persistId());
    return publishSetupStatus(persisted);
  });

  registerHandle("open-capture-settings", async (_event, payload) => {
    invalidateSetupStatusCache();
    const kind = payload && payload.kind ? String(payload.kind) : "";
    const url = osSettingsUrl(kind, osPlatform(), { store: osStoreInstall() });
    if (!url) return { ok: false, status: publishSetupStatus(await readCaptureSetup(dataRoot(), persistId())) };
    try {
      await shell.openExternal(url);
    } catch {
      return { ok: false, status: publishSetupStatus(await readCaptureSetup(dataRoot(), persistId())) };
    }
    return { ok: true, status: publishSetupStatus(await readCaptureSetup(dataRoot(), persistId())) };
  });

  registerHandle("wait-capture-access", async (_event, payload) => {
    invalidateSetupStatusCache();
    const kind = payload && payload.kind ? String(payload.kind) : "";
    if (kind !== "mic" && kind !== "camera") {
      return { ok: false, status: publishSetupStatus(await readCaptureSetup(dataRoot(), persistId())) };
    }
    const ok = await waitForOsAccess(kind, payload && payload.timeoutMs);
    return { ok, status: publishSetupStatus(await readCaptureSetup(dataRoot(), persistId())) };
  });

  registerHandle("cancel-capture-wait", async (_event, payload) => {
    const kind = payload && payload.kind ? String(payload.kind) : "";
    return { ok: cancelOsAccessWait(kind) };
  });

  // Renderer saw getUserMedia fail with an OS denial. Windows may still report
  // unknown. Stick the denial so capture-setup-status cannot flip back to ok
  // from persist alone.
  registerHandle("report-capture-denied", async (_event, payload) => {
    invalidateSetupStatusCache();
    const kind = payload && payload.kind ? String(payload.kind) : "";
    if (kind === "mic" || kind === "camera") {
      noteCaptureDenied(lastDenied, kind);
      captureConsent[kind] = false;
    }
    const persisted = await readCaptureSetup(dataRoot(), persistId());
    return publishSetupStatus(persisted);
  });

  registerHandle("prompt-capture-access", async (event, payload) => {
    invalidateSetupStatusCache();
    const kind = payload && payload.kind ? String(payload.kind) : "";
    if (kind !== "screen" && kind !== "camera" && kind !== "mic") {
      return { ok: false, status: publishSetupStatus(await readCaptureSetup(dataRoot(), persistId())) };
    }
    const win = BrowserWindow.fromWebContents(event.sender);
    const ok = await promptKind(parentWindow(win), kind, {
      force: Boolean(payload && payload.force),
      implied: Boolean(payload && payload.implied),
    });
    if (ok && (kind === "mic" || kind === "camera")) {
      await askOsMediaAccess(kind);
    }
    // Screen consent is JV's own. Mic and camera persist only after the
    // renderer probe succeeds (mark-capture-approved), so an OS block never
    // shows as Approved.
    const persisted =
      ok && kind === "screen" ? await markCaptureApproved(dataRoot(), kind, persistId()) : await readCaptureSetup(dataRoot(), persistId());
    const status = publishSetupStatus(persisted);
    const osDenied = ok && kind !== "screen" && Boolean(status[kind] && status[kind].osDenied);
    return { ok, osDenied, status };
  });

  registerHandle("mark-capture-approved", async (_event, payload) => {
    invalidateSetupStatusCache();
    const kind = payload && payload.kind ? String(payload.kind) : "";
    if (kind !== "screen" && kind !== "camera" && kind !== "mic") {
      return publishSetupStatus(await readCaptureSetup(dataRoot(), persistId()));
    }
    if (kind === "screen") captureConsent.screen = true;
    if (kind === "camera") {
      captureConsent.camera = true;
      clearCaptureDenied(lastDenied, "camera");
    }
    if (kind === "mic") {
      captureConsent.mic = true;
      clearCaptureDenied(lastDenied, "mic");
    }
    const persisted = await markCaptureApproved(dataRoot(), kind, persistId());
    return publishSetupStatus(persisted);
  });

  registerHandle("save-record-center-prefs", async (_event, payload) => {
    invalidateSetupStatusCache();
    const prefs = payload && typeof payload === "object" ? payload : {};
    const next = {};
    if (typeof prefs.soundOn === "boolean") next.soundOn = prefs.soundOn;
    if (typeof prefs.micDeviceId === "string") next.micDeviceId = prefs.micDeviceId;
    if (prefs.recordTarget === "full" || prefs.recordTarget === "area") next.recordTarget = prefs.recordTarget;
    if ("recordArea" in prefs) next.recordArea = prefs.recordArea;
    if (Number.isFinite(Number(prefs.recordFps))) {
      next.recordFps = Math.min(60, Math.max(24, Math.round(Number(prefs.recordFps))));
    }
    const persisted = await saveRecordCenterPrefs(dataRoot(), next, persistId());
    return publishSetupStatus(persisted);
  });

  async function restoreOnReady() {
    if (SMOKE) {
      captureConsent = { screen: true, camera: true, mic: true };
      return;
    }
    await readPersistedConsent();
  }

  return {
    wireMediaCapture,
    captureSourcePick,
    setPinnedDisplayId(id) {
      pinnedDisplayId = id ? String(id) : "";
    },
    invalidateCaptureSources() {
      cachedCaptureSources = [];
      captureSourcesGen += 1;
    },
    restoreOnReady,
    warmCaptureSources() {
      void getCaptureSources().catch(() => {});
    },
    getCachedCaptureSources() {
      return cachedCaptureSources;
    },
    windowThumbnails() {
      return getCaptureSourceThumbnails({ mode: "windows" });
    },
    listWindowSources() {
      return getCaptureSources()
        .then((sources) =>
          (Array.isArray(sources) ? sources : [])
            .map(mapCaptureSource)
            .filter((item) => item.kind === "window"),
        )
        .catch(() =>
          cachedCaptureSources.map(mapCaptureSource).filter((item) => item.kind === "window"),
        );
    },
    getLastDenied() {
      return { mic: lastDenied.mic, camera: lastDenied.camera };
    },
    getLastPermissionKind() {
      return lastPermissionKind;
    },
    getCaptureIntent() {
      return { source: captureIntent.source, mic: captureIntent.mic };
    },
  };
}

module.exports = { attachMediaCapture, APPX_PACKAGE_NAME };
