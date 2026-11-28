"use strict";

// A packaged build has no separate Electron binary for the HTML frame
// renderer, so lib/html-render.js relaunches this exe in worker mode. That
// process renders one job hidden and exits; it never opens the app.
if (process.argv.includes("--html-render-worker")) {
  require("../lib/html-render-worker.cjs");
  return;
}

const { app, BrowserWindow, ipcMain, dialog, protocol, net, nativeImage, screen, shell, nativeTheme, globalShortcut } = require("electron");
const path = require("path");
const fs = require("fs/promises");
const fssync = require("fs");
const { randomUUID, createHash } = require("crypto");
const { pathToFileURL, fileURLToPath } = require("url");
const { Readable } = require("stream");
const { nextMaximumSize, clampedNormalBounds, usableWorkArea } = require("../lib/window-bounds");
const store = require("../lib/workspace-store");
const { discoverBundledSkills } = require("../lib/skills");
const { MAX_INSTRUCTIONS_LENGTH, readUserInstructions, writeUserInstructions } = require("../lib/user-instructions");
const { MAX_RULES, MAX_RULE_TEXT, listUserRules, setUserRules, readRulesDraft, writeRulesDraft } = require("../lib/user-rules");
const { MAX_SKILL_LENGTH, listUserSkills, saveUserSkill, createUserSkill, removeUserSkill, pruneBundledDuplicates } = require("../lib/user-skills");
const { trackWindow, registerOn, shutdownRegistry } = require("../lib/main-ipc-registry.cjs");
const { copyFileWithProgress, findDuplicateItem } = require("../lib/library-io");

const disposers = [];

function track(target, event, handler) {
  if (!target || typeof target.on !== "function") return;
  target.on(event, handler);
  disposers.push(() => {
    try {
      if (typeof target.removeListener === "function") target.removeListener(event, handler);
    } catch {
      /* target may already be gone */
    }
  });
}

let mainShutdownDone = false;

function shutdownMainProcess() {
  if (mainShutdownDone) return;
  mainShutdownDone = true;
  destroyCountdownOverlay();
  for (const dispose of disposers) {
    try {
      dispose();
    } catch {
      /* best effort */
    }
  }
  disposers.length = 0;
  shutdownRegistry();
  if (agentHub) {
    try {
      agentHub.stop();
    } catch {
      /* best effort */
    }
  }
  // The SQLite stores keep one connection open per process; closing them
  // checkpoints the WAL so the next start does not replay it.
  for (const [mod, close] of [
    ["../lib/editor-chats", "closeEditorChatStores"],
    ["../lib/agent-activity", "closeActivityStores"],
    ["../lib/ai-projects", "closeAiProjectStores"],
    ["../lib/recorder-chats", "closeRecorderChatStores"],
    ["../lib/user-rules", "closeUserRulesDbs"],
    ["../lib/acp-marketplace", "closeAcpAgentDbs"],
    ["../lib/card-template-store", "closeCardTemplateStores"],
  ]) {
    try {
      require(mod)[close]();
    } catch {
      /* best effort */
    }
  }
}
protocol.registerSchemesAsPrivileged([
  // Approved plugin code only (lib/plugins.js pluginCodeIfApproved).
  { scheme: "jvplugin", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  {
    scheme: "cutline",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
      bypassCSP: true,
    },
  },
]);

app.setName(process.env.JDEV_NAME_DEV === "1" || process.env.JEDITOR_DEV === "1" ? "JDesign Dev" : "JDesign");

// The development version (npm run dev) keeps its own data folder and title,
// so it runs beside the everyday app without touching its projects or chats.
const DEV_BUILD = process.env.JEDITOR_DEV === "1";

// First dev launch copies the agent list from the everyday data folder, so
// agents added there are in the dev copy too.
function seedDevData(devUserData) {
  const devData = path.join(devUserData, "data");
  const target = path.join(devData, "acp-agents.db");
  const source = path.join(app.getPath("appData"), "JEditor", "data", "acp-agents.db");
  if (fssync.existsSync(target) || !fssync.existsSync(source)) return;
  try {
    fssync.mkdirSync(devData, { recursive: true });
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(source, { readOnly: true });
    try {
      db.exec("VACUUM INTO '" + target.replace(/'/g, "''") + "'");
    } finally {
      db.close();
    }
  } catch {
    /* the dev copy starts with no copied agents */
  }
}

// The first launch on a data folder adds every catalog agent already
// installed on this computer (Claude Code, OpenCode, Codex...), so a new
// user can make a video right away instead of finding the Agents page first.
// It runs once per folder: an agent the person removes later stays removed.
function addInstalledAgents(dataDir) {
  const marker = path.join(dataDir, ".agents-detected");
  if (fssync.existsSync(marker)) return;
  try {
    fssync.mkdirSync(dataDir, { recursive: true });
    const market = require("../lib/acp-marketplace");
    for (const item of market.marketplaceList({ dataRoot: dataDir }).catalog) {
      if (item.available && !item.added) market.addCatalogAgent(dataDir, item.id);
    }
    fssync.writeFileSync(marker, new Date().toISOString());
  } catch {
    /* the Agents page still lists what is on this computer */
  }
}

// JDesign keeps its own data folder (video data in <folder>/data, Draw in
// <folder>/draw). It never reads or writes the JEditor or JDraw folders.
if (process.env.JDESIGN_USER_DATA || process.env.JEDITOR_USER_DATA || process.env.CUTLINE_USER_DATA) {
  app.setPath("userData", process.env.JDESIGN_USER_DATA || process.env.JEDITOR_USER_DATA || process.env.CUTLINE_USER_DATA);
} else if (DEV_BUILD) {
  app.setPath("userData", path.join(app.getPath("appData"), "JDesign Dev"));
  seedDevData(app.getPath("userData"));
} else {
  app.setPath("userData", path.join(app.getPath("appData"), "JDesign"));
}

addInstalledAgents(path.join(app.getPath("userData"), "data"));

const SMOKE = process.argv.includes("--smoke");
// --draw-smoke runs the Draw studio's own hidden smoke (draw/renderer/js/smoke.js).
const DRAW_SMOKE = process.argv.includes("--draw-smoke");

// One JDesign per data folder: both studios share the window, the database
// owners and the agent bridge. Hidden test runs use their own folder.
if (!SMOKE && !DRAW_SMOKE && !app.requestSingleInstanceLock()) {
  app.quit();
}
let currentStudio = "video";
let drawStudio = null;
let themeMode = null;
let themeAccent = null;
function switchStudio(to) {
  const target = to === "draw" ? "draw" : "video";
  currentStudio = target;
  // Drawings live on project tabs now: nothing shows the Draw view full
  // size. The project editor's stage rect places it, so a switch only hides.
  if (drawStudio) drawStudio.show(false);
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || isCountdownOverlay(win)) continue;
    try { win.webContents.send("studio-changed", { studio: target }); } catch {}
  }
  return target;
}

// Drawings saved before the unified Projects page have no project. Each one
// becomes its own project (same name) in the active workspace; nothing is
// deleted and both databases are backed up first.
async function migrateLooseDrawings() {
  if (!drawStudio || typeof drawStudio.looseDrawings !== "function") return;
  const loose = drawStudio.looseDrawings();
  if (!loose.length) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dbFiles = [path.join(app.getPath("userData"), "draw", "jdraw.db"), path.join(dataRoot(), "ai-video-projects.db")];
  for (const file of dbFiles) {
    for (const ext of ["", "-wal", "-shm"]) {
      const src = file + ext;
      try {
        if (fssync.existsSync(src)) fssync.copyFileSync(src, src + ".bak-" + stamp);
      } catch (error) {
        logCrash("migration backup", src + ": " + ((error && error.message) || error));
      }
    }
  }
  const state = await loadState();
  const projects = require("../lib/ai-projects");
  for (const d of loose) {
    try {
      const project = await Promise.resolve(projects.createProject(dataRoot(), { workspaceId: state.activeWorkspaceId, name: d.name || "Drawing", aspectRatio: "16/9" }));
      if (project && project.id) drawStudio.setDrawingProject(d.id, project.id);
    } catch (error) {
      logCrash("drawing migration", d.id + ": " + ((error && error.message) || error));
    }
  }
  try {
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send("studio-changed", { studio: currentStudio, projects: true });
  } catch {}
}

// The packaged app has died invisibly (no WER record, no dumps), so exits
// and crashes are logged to a file that outlives the process.
const CRASH_LOG_MAX = 512 * 1024;
function crashLogPath() {
  try {
    return path.join(app.getPath("userData"), "data", "logs", "main-crash.log");
  } catch {
    return path.join(require("os").tmpdir(), "cutline-main-crash.log");
  }
}
function logCrash(kind, detail) {
  try {
    const file = crashLogPath();
    fssync.mkdirSync(path.dirname(file), { recursive: true });
    const text = String(detail == null ? "" : detail).replace(/\s+/g, " ").slice(0, 4000);
    if (fssync.existsSync(file) && fssync.statSync(file).size > CRASH_LOG_MAX) fssync.truncateSync(file, 0);
    fssync.appendFileSync(file, new Date().toISOString() + " " + kind + " " + text + "\n");
  } catch {
    /* logging must never take the app down */
  }
}
// Recorder bar presses and capture failures. Written async, off the click
// path, so a press that did nothing still leaves a line to read.
const RECORDER_LOG_MAX = 256 * 1024;
let recorderLogChain = Promise.resolve();
function logRecorder(event, detail) {
  const text = detail == null || detail === "" ? "" : " " + String(detail).replace(/\s+/g, " ").slice(0, 500);
  const line = new Date().toISOString() + " " + event + text + "\n";
  recorderLogChain = recorderLogChain.then(async () => {
    try {
      const file = path.join(path.dirname(crashLogPath()), "recorder.log");
      await fs.mkdir(path.dirname(file), { recursive: true });
      const st = await fs.stat(file).catch(() => null);
      if (st && st.size > RECORDER_LOG_MAX) await fs.rename(file, file + ".1");
      await fs.appendFile(file, line);
    } catch {
      /* logging must never take the app down */
    }
  });
}
// Native faults bypass every JS handler, so this journal is overwritten on
// each risky step: after a silent crash it still names what was in flight.
function lastActionPath() {
  try {
    return path.join(app.getPath("userData"), "data", "logs", "last-action.txt");
  } catch {
    return path.join(require("os").tmpdir(), "cutline-last-action.txt");
  }
}
function noteActivity(text) {
  try {
    const file = lastActionPath();
    fssync.mkdirSync(path.dirname(file), { recursive: true });
    fssync.writeFileSync(file, new Date().toISOString() + " " + String(text).replace(/\s+/g, " ").slice(0, 1000) + "\n");
  } catch {
    /* best effort */
  }
}
globalThis.cutlineNoteActivity = noteActivity;
process.on("uncaughtException", (error) => {
  logCrash("uncaughtException", (error && (error.stack || error.message)) || error);
});
process.on("unhandledRejection", (reason) => {
  logCrash("unhandledRejection", (reason && (reason.stack || reason.message)) || reason);
});
try {
  require("electron").crashReporter.start({ submitURL: "", uploadToServer: false });
} catch {
  /* dumps are best effort */
}
app.on("child-process-gone", (_event, details) => {
  logCrash("child-process-gone", JSON.stringify(details || {}));
});

let mediaCapture = null;

// Media capture attaches first because createWindow wires it into the window.
// The rest attach right after createWindow in the same tick: no IPC can be
// dispatched before the tick ends, so every handler is still registered before
// the page calls it, and the renderer process starts about 80ms sooner.
function bootDeferredMain() {
  if (mediaCapture) return;
  const { attachMediaCapture } = require("./media-capture.cjs");
  mediaCapture = attachMediaCapture({
    dataRoot,
    isOverlayWindow: isCountdownOverlay,
    smoke: SMOKE,
  });
}

let mainIpcAttached = false;

function attachMainIpc() {
  if (mainIpcAttached) return;
  mainIpcAttached = true;
  const { attachRecorderIpc } = require("./recorder-ipc.cjs");
  const { attachEditorChatIpc } = require("./editor-chat-ipc.cjs");
  const { attachAiProjectsIpc } = require("./ai-projects-ipc.cjs");
  attachRecorderIpc({ dataRoot });
  attachEditorChatIpc({ dataRoot });
  attachAiProjectsIpc({
    dataRoot,
    prepareDrawingsForProjectDelete: (projectId) => (drawStudio ? drawStudio.prepareDrawingsForProjectDelete(projectId) : []),
    projectDrawingsDeleted: (projectId) => {
      if (drawStudio) drawStudio.projectDrawingsDeleted(projectId);
    },
  });
  require("./presets-ipc.cjs").attachPresetsIpc({ dataRoot, appRoot: path.join(__dirname, "..") });
  const { attachJeditorIpc } = require("./jeditor-ipc.cjs");
  attachJeditorIpc({
    dataRoot,
    // The Cutline import swaps the SQLite files; every cached handle closes
    // first and the renderer relaunches the app right after.
    closeStores: async () => {
      if (agentHub && agentHub.acp && typeof agentHub.acp.stopAll === "function") agentHub.acp.stopAll();
      const closers = [
        ["../lib/editor-chats", "closeEditorChatStores"],
        ["../lib/ai-projects", "closeAiProjectStores"],
        ["../lib/user-rules", "closeUserRulesDbs"],
        ["../lib/acp-marketplace", "closeAcpAgentDbs"],
        ["../lib/agent-activity", "closeActivityStores"],
        ["../lib/card-template-store", "closeCardTemplateStores"],
        ["../lib/recorder-chats", "closeRecorderChatStores"],
      ];
      for (const [mod, fn] of closers) {
        try {
          const lib = require(mod);
          if (typeof lib[fn] === "function") lib[fn]();
        } catch (error) {
          logCrash("import close " + fn, (error && error.message) || error);
        }
      }
    },
  });
  // The agent hub is attached in smoke runs too: ACP is the only agent route,
  // so the smoke has to list real harnesses and open the real marketplace. It
  // starts the MCP bridge but never spawns an agent until a prompt asks.
  const { attachAgentHub } = require("./agent-hub-ipc.cjs");
  agentHub = attachAgentHub({
    dataRoot,
    appRoot: path.join(__dirname, ".."),
    log: logCrash,
    // Every project chat gets the drawing tools bound to its project. The
    // closures read drawStudio lazily because it initializes after the hub.
    drawMcp: (ids) => (drawStudio && typeof drawStudio.mcpEntryFor === "function" ? drawStudio.mcpEntryFor(ids) : null),
    drawTurnChanged: (projectId) => Promise.resolve(drawStudio && typeof drawStudio.turnChangedDocs === "function" ? drawStudio.turnChangedDocs(projectId) : []),
    drawCheckDrawing: (docId, o) => Promise.resolve(drawStudio && typeof drawStudio.checkProjectDrawing === "function" ? drawStudio.checkProjectDrawing(docId, o) : null),
    prepareDrawingsForProjectDelete: (projectId) => (drawStudio ? drawStudio.prepareDrawingsForProjectDelete(projectId) : []),
    projectDrawingsDeleted: (projectId) => {
      if (drawStudio) drawStudio.projectDrawingsDeleted(projectId);
    },
  });
}

let agentHub = null;

const EXT_FOR_MIME = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/wav": ".wav",
  "audio/webm": ".webm",
  "audio/ogg": ".ogg",
  "audio/mp4": ".m4a",
};

function dataRoot() {
  return path.join(app.getPath("userData"), "data");
}

function workspaceDir(id) {
  return path.join(dataRoot(), "workspaces", id);
}

// A take streams to this dir as it records. A renderer crash can never take
// the footage with it: anything left here is adopted as a Recovered take.
function inflightTakesDir() {
  return path.join(dataRoot(), "inflight-takes");
}
const inflightTakes = new Map();

function workspacePath(id) {
  return path.join(workspaceDir(id), "workspace.json");
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

function defaultCard() {
  return {
    name: "Untitled card",
    description: "",
    kind: "overlay",
    endScreen: false,
    endScreenDurationMs: 3000,
    composition: {
      aspectRatio: "vertical",
      headline: "",
      body: "",
      eyebrow: "",
      cta: "",
      align: "left",
      backgroundId: "",
      blockLayout: {},
      imageLayouts: {},
    },
    colors: {
      primary: "#1F3A5F",
      secondary: "#C9D4E3",
      text: "#F4F7FA",
    },
    imageIds: [],
  };
}

async function loadState() {
  return store.loadState(dataRoot());
}

async function loadWorkspace(id) {
  return store.loadWorkspace(dataRoot(), id);
}

async function saveWorkspace(ws) {
  return store.saveWorkspace(dataRoot(), ws);
}

async function snapshot() {
  return store.snapshot(dataRoot());
}

function kindFromMime(mime, name) {
  const type = String(mime || "").toLowerCase();
  const lower = String(name || "").toLowerCase();
  if (type.startsWith("image/") || /\.(png|jpe?g|webp)$/.test(lower)) return "image";
  if (type.startsWith("video/") || /\.(mp4|m4v|mov|webm|avi|mkv)$/.test(lower)) return "video";
  if (type.startsWith("audio/") || /\.(mp3|wav|ogg|m4a|aac|flac)$/.test(lower)) return "audio";
  return null;
}

function extFor(mime, name) {
  const type = String(mime || "")
    .toLowerCase()
    .split(";")[0]
    .trim();
  if (EXT_FOR_MIME[type]) return EXT_FOR_MIME[type];
  const match = String(name || "").match(/(\.[a-z0-9]{2,5})$/i);
  return match ? match[1].toLowerCase() : "";
}

async function hashFile(filePath) {
  const hash = createHash("sha256");
  const stream = fssync.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

// A whole recording handed over as one buffer can be hundreds of MB; hashing
// it in one call held the main thread for hundreds of ms. Slices with a
// yield between them keep IPC and the media protocol answering.
const HASH_SLICE = 16 * 1024 * 1024;
async function hashBuffer(buf) {
  const hash = createHash("sha256");
  for (let at = 0; at < buf.length; at += HASH_SLICE) {
    hash.update(buf.subarray(at, at + HASH_SLICE));
    if (at + HASH_SLICE < buf.length) await new Promise((resolve) => setImmediate(resolve));
  }
  return hash.digest("hex");
}

// Dedupe lives in lib/library-io.js so the drop, the picker, the agent copy, and
// the tests all judge "already in the library" the same way.
function findDuplicate(workspace, meta) {
  return findDuplicateItem((workspace && workspace.library) || [], meta);
}

function posterBytes(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (Array.isArray(data)) return Buffer.from(data);
  if (data && Array.isArray(data.data)) return Buffer.from(data.data);
  return Buffer.from(data);
}

function bufferFromPayload(data) {
  if (data == null) throw new Error("Missing recording bytes.");
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (Array.isArray(data)) return Buffer.from(data);
  if (data && Array.isArray(data.data)) return Buffer.from(data.data);
  throw new Error("Missing recording bytes.");
}

async function copyIntoLibrary(workspace, sourcePath, meta) {
  meta = meta || {};
  const name = meta.name || path.basename(sourcePath);
  const mime = meta.mime || "";
  const kind = kindFromMime(mime, name);
  if (!kind) throw new Error("That file type is not supported.");
  const stat = await fs.stat(sourcePath);
  const report = typeof meta.onProgress === "function" ? meta.onProgress : null;
  // Hashing reads the whole file too, so it is part of the wait the user sees.
  if (report) report({ phase: "checking", copied: 0, total: stat.size });
  const contentHash = await hashFile(sourcePath);
  const displayName = name.replace(/\.[^.]+$/, "") || name;
  const existing = findDuplicate(workspace, {
    kind,
    name: displayName,
    size: stat.size,
    contentHash,
  });
  if (existing) {
    return { skipped: true, name: existing.name, existingId: existing.id };
  }
  if (kind === "image") {
    const size = nativeImage.createFromPath(sourcePath).getSize();
    if (size.width > 0 && size.height > 0 && (size.width < 32 || size.height < 32)) {
      return {
        skipped: true,
        tooSmall: true,
        name: displayName,
        width: size.width,
        height: size.height,
      };
    }
  }
  const id = randomUUID();
  let ext = extFor(mime, name);
  if (!ext) ext = kind === "image" ? ".png" : kind === "audio" ? ".mp3" : ".mp4";
  const rel = path.join("library", id + ext);
  const dest = path.join(workspaceDir(workspace.id), rel);
  await ensureDir(path.dirname(dest));
  if (report) report({ phase: "copying", copied: 0, total: stat.size });
  await copyFileWithProgress(
    sourcePath,
    dest,
    report ? (copied) => report({ phase: "copying", copied, total: stat.size }) : null,
    stat.size,
  );
  const item = {
    id,
    kind,
    name: displayName,
    file: rel,
    mime: mime || kind + "/*",
    size: stat.size,
    durationMs: 0,
    description: "",
    aiCanUse: true,
    posterFile: "",
    contentHash,
    createdAt: new Date().toISOString(),
  };
  if (meta.source) item.source = String(meta.source);
  workspace.library.unshift(item);
  return item;
}

async function writeBufferIntoLibrary(workspace, payload) {
  payload = payload || {};
  const name = payload.name || "Recording";
  const mime = payload.mime || "video/webm";
  const kind = kindFromMime(mime, name);
  if (!kind) throw new Error("That file type is not supported.");
  const buf = bufferFromPayload(payload.buffer);
  const contentHash = await hashBuffer(buf);
  const displayName = name.replace(/\.[^.]+$/, "") || name;
  const existing = findDuplicate(workspace, {
    kind,
    name: displayName,
    size: buf.length,
    contentHash,
  });
  if (existing) {
    return { skipped: true, name: existing.name, existingId: existing.id };
  }
  if (kind === "image") {
    const size = nativeImage.createFromBuffer(buf).getSize();
    if (size.width > 0 && size.height > 0 && (size.width < 32 || size.height < 32)) {
      return {
        skipped: true,
        tooSmall: true,
        name: displayName,
        width: size.width,
        height: size.height,
      };
    }
  }
  const id = randomUUID();
  const ext = extFor(mime, name) || ".webm";
  const rel = path.join("library", id + ext);
  const dest = path.join(workspaceDir(workspace.id), rel);
  await ensureDir(path.dirname(dest));
  await fs.writeFile(dest, buf);
  const stat = await fs.stat(dest);
  const item = {
    id,
    kind,
    name: displayName,
    file: rel,
    mime: String(mime).split(";")[0].trim() || mime,
    size: stat.size,
    durationMs: payload.durationMs || 0,
    description: "",
    aiCanUse: true,
    posterFile: "",
    contentHash,
    createdAt: new Date().toISOString(),
    madeIn: payload.madeIn === "record-center" ? "record-center" : "",
  };
  if (payload.source) item.source = String(payload.source);
  workspace.library.unshift(item);
  return item;
}

// Same registration as writeBufferIntoLibrary but for a file already on
// disk: hash and move stream so a long take never lands in renderer or main
// memory at once.
async function writeFileIntoLibrary(workspace, payload) {
  payload = payload || {};
  const name = payload.name || "Recording";
  const mime = payload.mime || "video/webm";
  const kind = kindFromMime(mime, name);
  if (!kind) throw new Error("That file type is not supported.");
  const src = String(payload.path || "");
  if (!src) throw new Error("Missing take file.");
  // Chunk-written takes arrive with the hash already computed; anything else
  // (copied files, orphaned takes) still gets a full read.
  const contentHash =
    typeof payload.contentHash === "string" && payload.contentHash
      ? payload.contentHash
      : await new Promise((resolve, reject) => {
          const hash = createHash("sha256");
          const rs = fssync.createReadStream(src);
          rs.on("data", (chunk) => hash.update(chunk));
          rs.on("end", () => resolve(hash.digest("hex")));
          rs.on("error", reject);
        });
  const stat = await fs.stat(src);
  const displayName = name.replace(/\.[^.]+$/, "") || name;
  const existing = findDuplicate(workspace, {
    kind,
    name: displayName,
    size: stat.size,
    contentHash,
  });
  if (existing) {
    await fs.unlink(src).catch(() => {});
    return { skipped: true, name: existing.name, existingId: existing.id };
  }
  const id = randomUUID();
  const ext = extFor(mime, name) || ".webm";
  const rel = path.join("library", id + ext);
  const dest = path.join(workspaceDir(workspace.id), rel);
  await ensureDir(path.dirname(dest));
  try {
    await fs.rename(src, dest);
  } catch (error) {
    if (!error || error.code !== "EXDEV") throw error;
    await fs.copyFile(src, dest);
    await fs.unlink(src).catch(() => {});
  }
  const item = {
    id,
    kind,
    name: displayName,
    file: rel,
    mime: String(mime).split(";")[0].trim() || mime,
    size: stat.size,
    durationMs: payload.durationMs || 0,
    description: "",
    aiCanUse: true,
    posterFile: "",
    contentHash,
    createdAt: new Date().toISOString(),
    madeIn: payload.madeIn === "record-center" ? "record-center" : "",
  };
  if (payload.source) item.source = String(payload.source);
  workspace.library.unshift(item);
  return item;
}

function confinedPath(root, rel) {
  if (!rel) return null;
  const base = path.resolve(root);
  const abs = path.resolve(base, rel);
  const relToBase = path.relative(base, abs);
  if (!relToBase || relToBase.startsWith("..") || path.isAbsolute(relToBase)) return null;
  return abs;
}

function decodePathPart(part) {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

function parseCutlineMediaUrl(requestUrl) {
  const url = new URL(requestUrl);
  const rest = url.pathname.split("/").filter(Boolean).map(decodePathPart);
  const kind = String(url.hostname || rest.shift() || "").toLowerCase();
  return { kind, workspaceId: rest[0] || "", id: rest[1] || "" };
}

function mimeFromFile(file, fallback) {
  const ext = path.extname(file).toLowerCase();
  const type = String(fallback || "")
    .toLowerCase()
    .split(";")[0]
    .trim();
  if (ext === ".webm") return type.startsWith("audio/") ? "audio/webm" : "video/webm";
  const byExt = {
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".mov": "video/quicktime",
    ".avi": "video/x-msvideo",
    ".mkv": "video/x-matroska",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".flac": "audio/flac",
  };
  if (byExt[ext]) return byExt[ext];
  return type || "application/octet-stream";
}

// Every poster and video range request lands here, so the lookup is async:
// a cache miss after an outside write used to read and parse the whole
// workspace file synchronously on the main thread.
async function resolveMedia(workspaceId, kind, id) {
  if (!workspaceId || !id) return null;
  const ws = await store.loadWorkspaceIfExists(dataRoot(), workspaceId);
  if (!ws) return null;
  const fromList = (list, field) => {
    const item = (list || []).find((entry) => entry && entry.id === id);
    const rel = item && item[field];
    if (!item || !rel) return null;
    const abs = confinedPath(workspaceDir(workspaceId), rel);
    if (!abs) return null;
    return { file: abs, mime: item.mime || "" };
  };
  if (kind === "library") return fromList(ws.library, "file") || fromList(ws.cardImages, "file");
  if (kind === "card-image") return fromList(ws.cardImages, "file") || fromList(ws.library, "file");
  if (kind === "finished") return fromList(ws.finished, "file");
  if (kind === "poster") return fromList(ws.library, "posterFile");
  if (kind === "finished-poster") return fromList(ws.finished, "posterFile");
  return null;
}

function parseByteRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(String(header || "").trim());
  if (!match) return null;
  const hasStart = match[1] !== "";
  const hasEnd = match[2] !== "";
  if (!hasStart && !hasEnd) return null;
  let start;
  let end;
  if (!hasStart) {
    const suffix = Number(match[2]);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = hasEnd ? Number(match[2]) : size - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  }
  if (size <= 0 || start < 0 || start >= size || end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}

// Range requests can span whole takes. Reply with a stream rather than a
// buffer: the whole requested range must be delivered or the player reads the
// short response as end-of-stream, and a fixed cap would allocate freely for
// huge files. The stream keeps memory bounded regardless of range length.
function streamFileRange(file, start, end) {
  return Readable.toWeb(fssync.createReadStream(file, { start, end }));
}

async function serveCutlineMedia(request) {
  const { kind, workspaceId, id } = parseCutlineMediaUrl(request.url);
  const resolved = await resolveMedia(workspaceId, kind, id);
  const stat = resolved ? await fs.stat(resolved.file).catch(() => null) : null;
  if (!resolved || !stat || !stat.isFile()) {
    return new Response("Not found", { status: 404 });
  }
  const mime = mimeFromFile(resolved.file, resolved.mime);
  const size = stat.size;
  const rangeHeader = request.headers.get("Range");
  const range = rangeHeader ? parseByteRange(rangeHeader, size) : null;
  if (rangeHeader && !range) {
    return new Response(null, {
      status: 416,
      headers: {
        "Content-Range": "bytes */" + size,
        "Accept-Ranges": "bytes",
      },
    });
  }
  if (request.method === "HEAD") {
    const headers = {
      "Content-Type": mime,
      "Accept-Ranges": "bytes",
    };
    if (range) {
      headers["Content-Range"] = "bytes " + range.start + "-" + range.end + "/" + size;
      headers["Content-Length"] = String(range.end - range.start + 1);
      return new Response(null, { status: 206, headers });
    }
    headers["Content-Length"] = String(size);
    return new Response(null, { status: 200, headers });
  }
  if (range) {
    const body = streamFileRange(resolved.file, range.start, range.end);
    return new Response(body, {
      status: 206,
      headers: {
        "Content-Type": mime,
        "Accept-Ranges": "bytes",
        "Content-Range": "bytes " + range.start + "-" + range.end + "/" + size,
        "Content-Length": String(range.end - range.start + 1),
      },
    });
  }
  const response = await net.fetch(pathToFileURL(resolved.file).href);
  const got = String(response.headers.get("content-type") || "")
    .toLowerCase()
    .split(";")[0]
    .trim();
  if (got === mime) return response;
  const headers = new Headers(response.headers);
  headers.set("Content-Type", mime);
  headers.set("Accept-Ranges", "bytes");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function displayWorkArea(bounds) {
  const display = bounds ? screen.getDisplayMatching(bounds) : screen.getPrimaryDisplay();
  return usableWorkArea(display.workArea, display.bounds);
}

const WINDOW_BG = {
  light: "#f7f7f9",
  dark: "#121317",
};

// The first paint matches the saved look so the window never flashes the
// wrong theme before the page applies it.
function initialWindowBg() {
  try {
    const { readPrefs } = require("./jeditor-ipc.cjs");
    const theme = readPrefs(dataRoot()).theme;
    const dark = theme === "dark" || (theme !== "light" && nativeTheme.shouldUseDarkColors);
    return dark ? WINDOW_BG.dark : WINDOW_BG.light;
  } catch {
    return WINDOW_BG.dark;
  }
}

function chromeTheme(value) {
  return value === "dark" ? "dark" : "light";
}

const COUNTDOWN_OVERLAY_WIDTH = 208;
const COUNTDOWN_OVERLAY_HEIGHT = 92;
const COUNTDOWN_WAIT_WIDTH = 240;
const COUNTDOWN_RECORD_WIDTH = 288;
const COUNTDOWN_WAIT_HEIGHT = 108;
const COUNTDOWN_BAR_HEIGHT = 52;
const BAR_MIN_WIDTH = 640;
const BAR_MAX_WIDTH = 860;
const AREA_MIN_PX = 32;
const RECORDER_PREWARM_DELAY_MS = 2500;
const RECORDER_PREWARM_STEP_MS = 700;
const FULL_CROP = { x: 0, y: 0, w: 1, h: 1 };
const COUNTDOWN_FILE = path.join(__dirname, "..", "renderer", "countdown.html");

let countdownOverlay = null;
// The take outline is four thin opaque windows, not one transparent window
// spanning the take: per-pixel alpha on a screen-sized always-on-top window
// was the biggest steady DWM cost of an area take.
let countdownFrameStrips = [];
let countdownTakeRect = null;
let areaPickerWin = null;
let areaPickerReady = false;
let areaPickerBounds = null;
// The bar only shows once its page has painted; until then the window is
// invisible so it cannot eat clicks.
let countdownOverlayLoaded = false;
// A dead bar rebuilds itself mid-session, but a renderer that keeps dying
// must not loop create/destroy forever.
let barRebuildTries = 0;
// The bar and the take stay on the display the bar opened on, even if the
// pointer moves to another screen mid-session.
let countdownDisplayId = 0;
// finishCountdown tears the setup state down before the page turns the take
// on; the recording card keeps the display the take is on.
let recordingPinStash = 0;
let recordingPinStashAt = 0;
// The picker reports whether a drag or a pinned corner is in flight so a
// stray focus loss does not destroy the pick.
let areaPickerGesture = false;
let pickerBlurTimer = null;
let countdownCaptureReady = true;
let placingOverlay = false;
let countdownTimer = null;
let countdownGen = 0;
let countdownSender = null;
let countdownThrottled = null;
let countdownSenderWatch = null;
let countdownLeftMs = 0;
let countdownEndsAt = 0;
let countdownWait = false;
let countdownSize = false;
// What the take covers: the screen under the pointer (Auto), a dragged area
// of it, or the one window picked in Record Center.
let countdownTarget = "auto";
let countdownSizeCrop = null;
let areaPicker = null;
let countdownAreaDisplayId = 0;
let countdownDelayMs = 0;
let countdownDelayLabel = "Off";
let countdownFps = 30;
let countdownMicOn = false;
let countdownMicNote = "";
let countdownArming = false;
let countdownArmingAt = 0;
let overlayClickThrough = true;
let countdownRecording = false;
let countdownStartedAt = 0;
// Pause freezes the card clock at the same point the take freezes.
let countdownPaused = false;
let countdownPausedAt = 0;
let countdownPausedTotal = 0;
// A Window take records one window instead of the whole display.
let countdownWindowId = "";
let countdownWindowName = "";
// The picker window doubles as the window list; this says which it shows.
let pickerMode = "area";

// A Stop that still lands while another app has focus. Only registered
// while a take is rolling so it never steals the chord from other apps.
const RECORD_STOP_ACCELERATOR = "CommandOrControl+Shift+Alt+S";

function registerRecordStopHotkey() {
  try {
    globalShortcut.unregister(RECORD_STOP_ACCELERATOR);
    globalShortcut.register(RECORD_STOP_ACCELERATOR, () => {
      if (!countdownRecording) return;
      logRecorder("stop hotkey", barStateText());
      stopOverlayKeepDesktop("recording-overlay-stop", { reason: "hotkey" });
    });
  } catch (error) {
    logRecorder("stop hotkey register failed", (error && error.message) || error);
  }
}

function unregisterRecordStopHotkey() {
  try {
    globalShortcut.unregister(RECORD_STOP_ACCELERATOR);
  } catch (_) {}
}

function pausedMsExtra() {
  return countdownPausedTotal + (countdownPaused ? Date.now() - countdownPausedAt : 0);
}

function setRecordingPaused(paused) {
  const next = Boolean(paused);
  if (next === countdownPaused) return;
  countdownPaused = next;
  if (next) countdownPausedAt = Date.now();
  else countdownPausedTotal += Date.now() - countdownPausedAt;
  paintCountdownOverlay();
}

function formatOverlayClock(ms) {
  const total = Math.max(0, Math.round(Number(ms) / 1000) || 0);
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, "0");
  return m + ":" + s;
}

function isCountdownOverlay(win) {
  return Boolean(
    win &&
      ((countdownOverlay && win === countdownOverlay) ||
        countdownFrameStrips.includes(win) ||
        (areaPicker && win === areaPicker) ||
        (areaPickerWin && win === areaPickerWin)),
  );
}

// On X11 blur() deactivates by lowering the window, which dropped the bar
// under JV Desktop. The bar is not focusable there, so skip it.
function blurOverlay(win) {
  if (!win || win.isDestroyed() || process.platform === "linux") return;
  try {
    win.blur();
  } catch (_) {}
}

function displayForCountdown() {
  const displays = screen.getAllDisplays();
  // While an overlay session is up the display is pinned; the bar must not
  // teleport to the cursor's screen between presses.
  if (countdownDisplayId) {
    const pinned = displays.find((item) => item.id === countdownDisplayId);
    if (pinned) return pinned;
  }
  // Area stays on the display where it was picked.
  if (countdownTarget === "area" && countdownAreaDisplayId) {
    const hit = displays.find((item) => item.id === countdownAreaDisplayId);
    if (hit) return hit;
  }
  // Auto follows the user: the screen under the pointer is the screen in use.
  if (countdownTarget === "auto") {
    try {
      return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    } catch (_) {}
  }
  const src = mediaCapture ? mediaCapture.captureSourcePick(mediaCapture.getCachedCaptureSources()) : null;
  const displayId = src && src.display_id;
  if (displayId != null && displayId !== "") {
    const hit = displays.find((item) => String(item.id) === String(displayId));
    if (hit) return hit;
  }
  const main = BrowserWindow.getAllWindows().find((win) => !isCountdownOverlay(win) && !win.isDestroyed());
  if (main) return screen.getDisplayMatching(main.getBounds());
  return screen.getPrimaryDisplay();
}

function overlayCropFromBounds(bounds) {
  const display = displayForCountdown();
  const area = display && display.bounds;
  if (!bounds || !area || !area.width || !area.height) return null;
  const left = Math.max(bounds.x, area.x);
  const top = Math.max(bounds.y, area.y);
  const right = Math.min(bounds.x + bounds.width, area.x + area.width);
  const bottom = Math.min(bounds.y + bounds.height, area.y + area.height);
  const w = right - left;
  const h = bottom - top;
  if (w <= 0 || h <= 0) return null;
  return {
    x: (left - area.x) / area.width,
    y: (top - area.y) / area.height,
    w: w / area.width,
    h: h / area.height,
  };
}

function intersectRect(a, b) {
  if (!a || !b) return null;
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0) return null;
  return { x: left, y: top, width, height };
}

function applyCropToRect(rect, crop) {
  if (!rect || !crop) return rect;
  const w = Number(crop.w);
  const h = Number(crop.h);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return rect;
  const x = Number(crop.x);
  const y = Number(crop.y);
  return {
    x: Math.round(rect.x + (Number.isFinite(x) ? x : 0) * rect.width),
    y: Math.round(rect.y + (Number.isFinite(y) ? y : 0) * rect.height),
    width: Math.round(w * rect.width),
    height: Math.round(h * rect.height),
  };
}

function countdownOverlayBounds() {
  const display = displayForCountdown();
  const work = usableWorkArea(display.workArea, display.bounds);
  if (!countdownSize) {
    const width = countdownRecording ? COUNTDOWN_RECORD_WIDTH : countdownWait ? COUNTDOWN_WAIT_WIDTH : COUNTDOWN_OVERLAY_WIDTH;
    const height = countdownWait || countdownRecording ? COUNTDOWN_WAIT_HEIGHT : COUNTDOWN_OVERLAY_HEIGHT;
    return {
      x: Math.round(work.x + (work.width - width) / 2),
      y: Math.round(work.y + 16),
      width,
      height,
    };
  }
  if (countdownTarget === "area" && countdownSizeCrop) {
    const rect = intersectRect(applyCropToRect(display.bounds, countdownSizeCrop), display.bounds);
    if (rect) return rect;
  }
  return { ...display.bounds };
}

function setSenderThrottling(enabled) {
  if (!countdownThrottled || countdownThrottled.isDestroyed()) return;
  try {
    countdownThrottled.setBackgroundThrottling(enabled);
  } catch (_) {}
}

function overlayStatePayload() {
  const wait = countdownWait;
  const size = countdownSize;
  const recording = countdownRecording;
  const mode = recording ? "recording" : size ? "size" : wait ? "wait" : "timer";
  const label = recording ? "Recording" : size ? "This line is the take" : wait ? "Record when ready" : "Starts in";
  const clock =
    countdownArming || recording || (!wait && !size) ? formatOverlayClock(countdownLeftMs) : "";
  return {
    mode,
    target: countdownTarget,
    areaLabel: countdownTarget === "window" ? countdownWindowName : areaSizeLabel(),
    arming: countdownArming,
    loading: size && !recording && !countdownCaptureReady,
    clock,
    label: recording && countdownPaused ? "Paused" : label,
    paused: countdownPaused,
    delayLabel: countdownDelayLabel,
    fps: countdownFps,
    micOn: countdownMicOn,
    micLabel: countdownMicNote || (countdownMicOn ? "On" : "Off"),
  };
}

let lastOverlayPaintKey = "";

function paintCountdownOverlay() {
  if (!countdownOverlay || countdownOverlay.isDestroyed()) return;
  const state = overlayStatePayload();
  const key = JSON.stringify(state);
  if (key === lastOverlayPaintKey) return;
  lastOverlayPaintKey = key;
  try {
    countdownOverlay.webContents.send("overlay-state", state);
  } catch (_) {}
}

function emitCountdownTick() {
  if (countdownSender && !countdownSender.isDestroyed()) {
    countdownSender.send("countdown-tick", { leftMs: countdownLeftMs });
  }
}

function emitOverlayBounds() {
  if (!countdownSize || !countdownSender || countdownSender.isDestroyed()) return;
  const take = countdownTarget === "area" ? countdownTakeRect : null;
  const crop = take ? overlayCropFromBounds(take) : FULL_CROP;
  if (crop) countdownSender.send("countdown-bounds", { crop });
}

function passClicksThrough(win, pass) {
  if (!win || win.isDestroyed()) return;
  try {
    win.setIgnoreMouseEvents(Boolean(pass));
  } catch (_) {}
}

function applyOverlayClickThrough() {
  for (const strip of countdownFrameStrips) passClicksThrough(strip, true);
  passClicksThrough(countdownOverlay, false);
}

function startOverlayDelayThenRecord() {
  const ms = Math.max(0, Math.round(Number(countdownDelayMs) || 0));
  if (ms <= 0) {
    finishCountdown(countdownGen);
    return;
  }
  countdownArming = true;
  countdownArmingAt = Date.now();
  overlayClickThrough = true;
  countdownLeftMs = ms;
  countdownEndsAt = Date.now() + ms;
  const gen = countdownGen;
  clearInterval(countdownTimer);
  paintCountdownOverlay();
  applyOverlayClickThrough();
  countdownTimer = setInterval(() => {
    try {
      if (gen !== countdownGen) return;
      countdownLeftMs = Math.max(0, countdownEndsAt - Date.now());
      paintCountdownOverlay();
      if (countdownLeftMs > 0) return;
      finishCountdown(gen);
    } catch (error) {
      logCrash("countdown tick", (error && (error.stack || error.message)) || error);
    }
  }, 250);
}



function hideCountdownOverlay() {
  if (countdownOverlay && !countdownOverlay.isDestroyed()) countdownOverlay.hide();
  hideFrameStrips();
}

function mainAppWindow() {
  return (
    BrowserWindow.getAllWindows().find((win) => !win.isDestroyed() && !isCountdownOverlay(win)) || null
  );
}

function hideOverlayWithoutRaisingMain() {
  const main = mainAppWindow();
  const lock = process.platform === "win32" && main && !main.isDestroyed() && !main.isFocused();
  if (lock) {
    try {
      main.setFocusable(false);
    } catch (_) {}
  }
  hideCountdownOverlay();
  if (lock) {
    setImmediate(() => {
      if (!main || main.isDestroyed()) return;
      try {
        main.setFocusable(true);
      } catch (_) {}
    });
  }
}

function overlaySender() {
  return countdownSender && !countdownSender.isDestroyed() ? countdownSender : null;
}

function stopOverlayKeepDesktop(message, payload) {
  const sender = overlaySender();
  stopCountdownOverlay();
  if (sender) sender.send(message, payload || {});
}

function closeRecorderBar(reason) {
  if (countdownRecording) {
    stopOverlayKeepDesktop("recording-overlay-stop", { reason: reason || "close" });
    return;
  }
  stopOverlayKeepDesktop("countdown-overlay-closed", { reason: reason || "close" });
}

// Auto or a dragged area. Both record the screen the bar sits on.
function applyOverlayTarget(target, crop) {
  countdownWindowId = "";
  countdownWindowName = "";
  countdownTarget = target === "area" && crop ? "area" : "auto";
  countdownSizeCrop = countdownTarget === "area" ? crop : null;
  if (countdownTarget !== "area") countdownAreaDisplayId = 0;
  countdownTakeRect = null;
  placeCountdownOverlay();
  raiseCountdownOverlay();
  paintCountdownOverlay();
  const sender = overlaySender();
  if (sender) {
    sender.send("overlay-set-target", {
      target: countdownTarget,
      crop: countdownSizeCrop || FULL_CROP,
    });
  }
}

function closeAreaPicker() {
  const win = areaPicker;
  areaPicker = null;
  areaPickerGesture = false;
  clearTimeout(pickerBlurTimer);
  pickerBlurTimer = null;
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send("area-pick-reset");
  } catch (_) {}
  win.hide();
}

function showAreaPicker(win) {
  if (!win || win.isDestroyed() || areaPicker !== win) return;
  areaPickerGesture = false;
  try {
    win.webContents.send("area-pick-reset");
  } catch (_) {}
  try {
    win.setAlwaysOnTop(true, "screen-saver");
  } catch (_) {}
  if (areaPickerBounds) win.setBounds(areaPickerBounds);
  win.show();
  try {
    win.moveTop();
  } catch (_) {}
  win.focus();
  if (pickerMode === "windows") sendWindowPickList(win);
}

// The picker window is built once, kept hidden, and reused. Building it on
// every Area press blocked the main process for over a second.
function ensureAreaPickerWindow() {
  if (areaPickerWin && !areaPickerWin.isDestroyed()) return areaPickerWin;
  const b = areaPickerBounds || displayForCountdown().bounds;
  const win = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    show: false,
    title: "JV area",
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "countdown-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  areaPickerWin = win;
  areaPickerReady = false;
  trackWindow(win, "countdown-pick");
  win.removeMenu();
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.on("render-process-gone", (_event, details) => {
    logCrash("area picker renderer gone", details && details.reason);
    const active = areaPicker === win;
    if (active) {
      areaPicker = null;
      areaPickerGesture = false;
    }
    if (!win.isDestroyed()) win.destroy();
    if (active && countdownSize) raiseCountdownOverlay();
  });
  const markReady = () => {
    if (win.isDestroyed()) return;
    areaPickerReady = true;
    showAreaPicker(win);
  };
  win.once("ready-to-show", markReady);
  // ready-to-show can be flaky for hidden transparent windows; the bar has
  // the same belt-and-suspenders.
  win.webContents.on("did-finish-load", markReady);
  // Switching away (Alt+Tab, Start menu) cancels the pick and brings the bar
  // back instead of leaving a dim layer over the screen. The cancel waits a
  // beat: a click on another monitor also blurs, and it must not destroy a
  // drag or a pinned corner that is in progress.
  win.on("blur", () => {
    if (areaPicker !== win) return;
    schedulePickerBlurCancel(win, 0);
  });
  win.on("closed", () => {
    if (areaPickerWin === win) {
      areaPickerWin = null;
      areaPickerReady = false;
    }
    if (areaPicker !== win) return;
    areaPicker = null;
    areaPickerGesture = false;
    if (countdownSize) raiseCountdownOverlay();
  });
  win.loadFile(COUNTDOWN_FILE, { query: { role: "pick" } }).catch((error) => {
    logCrash("area picker load", (error && error.message) || error);
    const active = areaPicker === win;
    if (active) {
      areaPicker = null;
      areaPickerGesture = false;
    }
    if (!win.isDestroyed()) win.destroy();
    if (active) raiseCountdownOverlay();
  });
  return win;
}

function schedulePickerBlurCancel(win, tries) {
  clearTimeout(pickerBlurTimer);
  pickerBlurTimer = setTimeout(() => {
    pickerBlurTimer = null;
    if (areaPicker !== win || win.isDestroyed() || win.isFocused()) return;
    // A drag or a pinned corner in progress survives the focus loss; check
    // again shortly. Bounded so a stuck flag still ends the pick.
    if (areaPickerGesture && tries < 30) {
      schedulePickerBlurCancel(win, tries + 1);
      return;
    }
    closeAreaPicker();
    if (countdownSize) raiseCountdownOverlay();
  }, 500);
}

// A dimmed full screen layer on the bar's display. Drag a box to pick the
// take area; Cancel, Esc, or switching away keeps the old one.
function openAreaPicker() {
  // Every press resets and shows the picker again, so a leftover pick
  // (hidden or behind another window) never eats a later Area press.
  closeAreaPicker();
  pickerMode = "area";
  areaPickerBounds = displayForCountdown().bounds;
  hideFrameStrips();
  if (countdownOverlay && !countdownOverlay.isDestroyed()) countdownOverlay.hide();
  const win = ensureAreaPickerWindow();
  areaPicker = win;
  if (areaPickerReady) showAreaPicker(win);
}

// The same fullscreen picker doubles as the window list for a Window take.
// The list itself is fetched here so the page never talks to desktopCapturer.
function openWindowPicker() {
  closeAreaPicker();
  pickerMode = "windows";
  areaPickerBounds = displayForCountdown().bounds;
  if (countdownFrame && !countdownFrame.isDestroyed()) countdownFrame.hide();
  if (countdownOverlay && !countdownOverlay.isDestroyed()) countdownOverlay.hide();
  const win = ensureAreaPickerWindow();
  areaPicker = win;
  if (areaPickerReady) showAreaPicker(win);
  sendWindowPickList(win);
}

function sendWindowPickList(win) {
  if (!win || win.isDestroyed() || !mediaCapture || typeof mediaCapture.windowThumbnails !== "function") return;
  mediaCapture
    .windowThumbnails()
    .then((windows) => {
      if (areaPicker !== win || win.isDestroyed()) return;
      win.webContents.send("pick-windows", { windows: Array.isArray(windows) ? windows : [] });
    })
    .catch(() => {
      if (areaPicker !== win || win.isDestroyed()) return;
      win.webContents.send("pick-windows", { windows: [] });
    });
}

function onWindowPicked(event, payload) {
  const win = areaPicker;
  if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
  closeAreaPicker();
  if (!countdownSize || countdownRecording || countdownArming) {
    raiseCountdownOverlay();
    return;
  }
  const id = payload && payload.id ? String(payload.id) : "";
  if (!id.startsWith("window:")) {
    logRecorder("window pick cancelled", "");
    raiseCountdownOverlay();
    return;
  }
  logRecorder("window picked", String(payload.name || "").slice(0, 60));
  applyWindowTarget(id, payload && payload.name ? String(payload.name) : "");
}

function applyWindowTarget(id, name) {
  countdownTarget = "window";
  countdownWindowId = id;
  countdownWindowName = String(name || "").slice(0, 120);
  countdownSizeCrop = null;
  countdownAreaDisplayId = 0;
  countdownTakeRect = null;
  placeCountdownOverlay();
  raiseCountdownOverlay();
  paintCountdownOverlay();
  const sender = overlaySender();
  if (sender) {
    sender.send("overlay-set-target", {
      target: "window",
      windowId: countdownWindowId,
      windowName: countdownWindowName,
      crop: FULL_CROP,
    });
  }
}

// Building an overlay window blocks the main process for about a second,
// and the bar needs three (bar, area outline, area picker). Built on the
// first Start, that was the 5 second wait. They are built hidden, one at a
// time, soon after launch, so Start Recorder Bar and Area only show them.
let recorderPrewarmTimer = null;
function prewarmRecorderWindows() {
  if (recorderPrewarmTimer || mainShutdownDone || SMOKE) return;
  const steps = [
    () => {
      if (mediaCapture && typeof mediaCapture.warmCaptureSources === "function") mediaCapture.warmCaptureSources();
    },
    ensureCountdownOverlay,
    ensureCountdownFrame,
    ensureAreaPickerWindow,
  ];
  const next = () => {
    recorderPrewarmTimer = null;
    if (mainShutdownDone || !mainAppWindow()) return;
    const step = steps.shift();
    if (!step) return;
    try {
      step();
    } catch (error) {
      logCrash("recorder prewarm", (error && (error.stack || error.message)) || error);
    }
    if (steps.length) recorderPrewarmTimer = setTimeout(next, RECORDER_PREWARM_STEP_MS);
  };
  recorderPrewarmTimer = setTimeout(next, 0);
}

function onAreaPicked(event, payload) {
  const win = areaPicker;
  if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
  const origin = win.getBounds();
  closeAreaPicker();
  if (!countdownSize || countdownRecording || countdownArming) return;
  const r = payload && payload.rect;
  const ok =
    r &&
    [r.x, r.y, r.width, r.height].every((n) => Number.isFinite(Number(n))) &&
    Number(r.width) >= AREA_MIN_PX &&
    Number(r.height) >= AREA_MIN_PX;
  const display = displayForCountdown();
  const b = display.bounds;
  const rect = ok
    ? intersectRect(
        {
          x: Math.round(origin.x + Number(r.x)),
          y: Math.round(origin.y + Number(r.y)),
          width: Math.round(Number(r.width)),
          height: Math.round(Number(r.height)),
        },
        b,
      )
    : null;
  if (!rect) {
    logRecorder("area cancelled", ok ? "outside the screen" : "");
    raiseCountdownOverlay();
    return;
  }
  logRecorder("area picked", rect.width + "x" + rect.height);
  countdownAreaDisplayId = display.id;
  applyOverlayTarget("area", {
    x: (rect.x - b.x) / b.width,
    y: (rect.y - b.y) / b.height,
    w: rect.width / b.width,
    h: rect.height / b.height,
  });
}

let areaLabelCache = { key: "", value: "" };
function areaSizeLabel() {
  if (countdownTarget !== "area" || !countdownTakeRect) return "";
  const r = countdownTakeRect;
  const key = r.x + "," + r.y + "," + r.width + "," + r.height;
  if (areaLabelCache.key === key) return areaLabelCache.value;
  // Display enumeration is a sync OS call; the label only changes on a new
  // pick, so keep the answer instead of re-reading it every paint.
  const scale = Number(displayForCountdown().scaleFactor) || 1;
  const value = Math.round(r.width * scale) + " x " + Math.round(r.height * scale);
  areaLabelCache = { key, value };
  return value;
}

// Anything that maps a hidden overlay outside the show paths (a window
// manager remap, a stray focus event) leaves an invisible full-screen click
// eater. Re-hide any overlay the session state says should not be up.
function hideStrayOverlays() {
  if (areaPickerWin && !areaPickerWin.isDestroyed() && areaPickerWin.isVisible() && areaPicker !== areaPickerWin) {
    areaPickerWin.hide();
  }
  const sessionUp =
    countdownSize ||
    countdownWait ||
    countdownRecording ||
    countdownArming ||
    countdownTimer ||
    countdownEndsAt;
  if (countdownOverlay && !countdownOverlay.isDestroyed() && countdownOverlay.isVisible() && !sessionUp) {
    countdownOverlay.hide();
  }
  if (countdownFrameStrips.some((win) => win && !win.isDestroyed() && win.isVisible())) {
    const needFrame = countdownSize && countdownTarget === "area" && !areaPicker;
    if (!needFrame) hideFrameStrips();
  }
}

function stopCountdownOverlay() {
  const hadOverlay =
    countdownTimer ||
    countdownWait ||
    countdownSize ||
    countdownRecording ||
    countdownArming ||
    countdownSender ||
    countdownThrottled ||
    countdownDisplayId ||
    (countdownOverlay && !countdownOverlay.isDestroyed() && countdownOverlay.isVisible());
  if (!hadOverlay) return;
  countdownGen += 1;
  clearInterval(countdownTimer);
  countdownTimer = null;
  setSenderThrottling(true);
  countdownThrottled = null;
  countdownSender = null;
  countdownEndsAt = 0;
  countdownLeftMs = 0;
  countdownWait = false;
  countdownSize = false;
  countdownTarget = "auto";
  countdownSizeCrop = null;
  countdownAreaDisplayId = 0;
  countdownDisplayId = 0;
  recordingPinStash = 0;
  recordingPinStashAt = 0;
  if (mediaCapture && typeof mediaCapture.setPinnedDisplayId === "function") {
    mediaCapture.setPinnedDisplayId(null);
  }
  closeAreaPicker();
  countdownDelayMs = 0;
  countdownDelayLabel = "Off";
  countdownFps = 30;
  countdownMicOn = false;
  countdownMicNote = "";
  countdownArming = false;
  countdownArmingAt = 0;
  overlayClickThrough = true;
  countdownRecording = false;
  countdownPaused = false;
  countdownPausedAt = 0;
  countdownPausedTotal = 0;
  countdownWindowId = "";
  countdownWindowName = "";
  unregisterRecordStopHotkey();
  countdownCaptureReady = true;
  countdownStartedAt = 0;
  countdownTakeRect = null;
  areaLabelCache = { key: "", value: "" };
  overlayDragPending = null;
  hideOverlayWithoutRaisingMain();
  hideStrayOverlays();
}

// A crashed or reloaded page never fires webContents 'destroyed'. Without
// this the bar keeps counting a take that no longer exists and the inflight
// file is only adopted on the next launch.
function onRecorderPageGone(sender) {
  if (!sender) return;
  if (countdownSender === sender) {
    logRecorder("page gone", "tearing down the recorder bar");
    stopCountdownOverlay();
  }
  for (const entry of inflightTakes.values()) {
    if (entry && entry.sender === sender && entry.onDead) entry.onDead();
  }
}

function destroyCountdownOverlay() {
  stopCountdownOverlay();
  if (countdownOverlay && !countdownOverlay.isDestroyed()) countdownOverlay.destroy();
  countdownOverlay = null;
  lastOverlayPaintKey = "";
  destroyFrameStrips();
  if (areaPickerWin && !areaPickerWin.isDestroyed()) areaPickerWin.destroy();
  areaPickerWin = null;
  areaPickerReady = false;
}

function finishCountdown(gen) {
  if (gen !== countdownGen) return;
  const sender = countdownSender;
  // Full screen and window takes record the whole source; only an area crops.
  let crop = null;
  if (countdownSize) {
    const take = countdownTarget === "area" ? countdownTakeRect || countdownOverlayBounds() : null;
    crop = (take && overlayCropFromBounds(take)) || FULL_CROP;
  }
  const keepPin = countdownDisplayId;
  stopCountdownOverlay();
  recordingPinStash = keepPin;
  // The recording card start lands right after this; a stale stash must not
  // survive to an unrelated take.
  recordingPinStashAt = Date.now();
  if (sender && !sender.isDestroyed()) sender.send("countdown-finished", crop ? { crop } : {});
}

function barBoundsFor(_take) {
  const display = displayForCountdown();
  const work = usableWorkArea(display.workArea, display.bounds);
  const height = COUNTDOWN_BAR_HEIGHT;
  const width = Math.max(
    Math.min(BAR_MAX_WIDTH, work.width),
    Math.min(BAR_MIN_WIDTH, work.width),
  );
  let x = Math.round(work.x + (work.width - width) / 2);
  x = Math.max(work.x, Math.min(work.x + work.width - width, x));
  return { x, y: work.y, width, height };
}

function placeCountdownOverlay() {
  if (!countdownOverlay || countdownOverlay.isDestroyed()) return;
  if (placingOverlay) return;
  placingOverlay = true;
  try {
    if (countdownSize) {
      const take = countdownTakeRect || countdownOverlayBounds();
      countdownTakeRect = take;
      if (countdownTarget === "area") {
        layoutFrameStrips(take);
      } else {
        hideFrameStrips();
      }
      countdownOverlay.setBounds(barBoundsFor(take));
    } else {
      countdownTakeRect = null;
      hideFrameStrips();
      countdownOverlay.setBounds(countdownOverlayBounds());
    }
  } finally {
    placingOverlay = false;
  }
}

function raiseOverlayWindow(win, clickThrough) {
  if (!win || win.isDestroyed()) return;
  try {
    win.setAlwaysOnTop(true, "screen-saver");
  } catch (_) {}
  try {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch (_) {}
  try {
    win.setContentProtection(true);
  } catch (_) {}
  try {
    win.setResizable(false);
  } catch (_) {}
  try {
    win.setFocusable(false);
  } catch (_) {}
  passClicksThrough(win, clickThrough);
  win.showInactive();
  try {
    win.moveTop();
  } catch (_) {}
  // Showing can reset the mouse style on Windows; set it again.
  passClicksThrough(win, clickThrough);
  blurOverlay(win);
}

function raiseCountdownOverlay() {
  if (!countdownOverlay || countdownOverlay.isDestroyed()) return;
  // The picker owns the screen while open, and a bar whose page has not
  // painted yet is an invisible click eater. Both shows happen later:
  // onAreaPicked re-raises after the picker closes, and did-finish-load /
  // ready-to-show raise once the page is up.
  if (areaPicker || !countdownOverlayLoaded) return;
  try {
    if (countdownSize) countdownOverlay.setMinimumSize(320, COUNTDOWN_BAR_HEIGHT);
    else countdownOverlay.setMinimumSize(COUNTDOWN_OVERLAY_WIDTH, COUNTDOWN_OVERLAY_HEIGHT);
  } catch (_) {}
  // The area outline goes up first so the bar always sits above it. An area
  // that starts at the top of the screen puts the outline under the bar, and
  // on Windows an outline above the bar swallowed Record, Area, and X.
  if (countdownSize && countdownTarget === "area" && !areaPicker) {
    ensureCountdownFrame();
    for (const strip of countdownFrameStrips) raiseOverlayWindow(strip, true);
  } else {
    hideFrameStrips();
  }
  raiseOverlayWindow(countdownOverlay, false);
}

function wireOverlayShell(win, role) {
  win.removeMenu();
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });
  win.on("focus", () => blurOverlay(win));
  // A dead renderer leaves a visible window whose buttons dispatch nothing.
  // Destroy it so the ensure functions rebuild a live one.
  win.webContents.on("render-process-gone", (_event, details) => {
    logCrash("overlay " + role + " renderer gone", details && details.reason);
    if (!win.isDestroyed()) win.destroy();
  });
  win.webContents.on("unresponsive", () => {
    logCrash("overlay " + role + " unresponsive", "");
  });
  if (role === "bar") {
    win.webContents.on("did-finish-load", () => {
      countdownOverlayLoaded = true;
      barRebuildTries = 0;
      lastOverlayPaintKey = "";
      paintCountdownOverlay();
      if (countdownTimer || countdownWait || countdownRecording || countdownSize) raiseCountdownOverlay();
    });
    win.on("ready-to-show", () => {
      countdownOverlayLoaded = true;
      if (countdownEndsAt || countdownWait || countdownRecording || countdownSize) raiseCountdownOverlay();
    });
    win.on("closed", () => {
      if (countdownOverlay !== win) return;
      countdownOverlay = null;
      countdownOverlayLoaded = false;
      // A dead bar mid-session rebuilds itself; a take must never lose its
      // Stop button for good. Capped so a renderer that keeps dying cannot
      // churn windows forever (the main window caps reloads the same way).
      if (
        barRebuildTries < 2 &&
        (countdownRecording || countdownSize || countdownWait || countdownArming || countdownTimer)
      ) {
        barRebuildTries += 1;
        ensureCountdownOverlay();
      }
    });
  } else {
    win.on("closed", () => {
      countdownFrameStrips = countdownFrameStrips.filter((strip) => strip !== win);
    });
  }
}

function newOverlayWindow(bounds, query) {
  const win = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    focusable: false,
    hasShadow: false,
    show: false,
    backgroundColor: "#00000000",
    title: "JV countdown",
    webPreferences: {
      preload: path.join(__dirname, "countdown-preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  try {
    win.setFocusable(false);
  } catch (_) {}
  wireOverlayShell(win, query && query.role === "frame" ? "frame" : "bar");
  trackWindow(win, query && query.role === "frame" ? "countdown-frame" : "countdown-bar");
  const overlayLoad = query ? win.loadFile(COUNTDOWN_FILE, { query }) : win.loadFile(COUNTDOWN_FILE);
  overlayLoad.catch((error) => {
    logCrash("overlay loadFile", (error && (error.stack || error.message)) || error);
    // A failed load leaves a live transparent window that swallows clicks.
    if (!win.isDestroyed()) win.destroy();
  });
  return win;
}

function ensureCountdownOverlay() {
  if (countdownOverlay && !countdownOverlay.isDestroyed()) return;
  const bounds = countdownSize ? barBoundsFor(countdownOverlayBounds()) : countdownOverlayBounds();
  countdownOverlay = newOverlayWindow(bounds, null);
}

// The outline never covers the bar. Click-through is not reliable on
// every platform, and an outline over the bar ate Record, Area, and X. When
// the area reaches under the bar, the outline starts at the bar's bottom
// edge. Only the outline moves; the take still records the whole area.
function frameBoundsFor(take) {
  const bar = barBoundsFor(take);
  const overlapsX = take.x < bar.x + bar.width && take.x + take.width > bar.x;
  const barBottom = bar.y + bar.height;
  if (!overlapsX || take.y >= barBottom) return take;
  const bottom = take.y + take.height;
  return { x: take.x, y: barBottom, width: take.width, height: Math.max(1, bottom - barBottom) };
}

const FRAME_STRIP_THICK = 3;
const FRAME_STRIP_COLOR = "#b8b8b8";

function frameStripRects(take) {
  const t = frameBoundsFor(take);
  if (!t || t.width < 12 || t.height < 12) return [];
  const n = FRAME_STRIP_THICK;
  return [
    { x: t.x, y: t.y, width: t.width, height: n },
    { x: t.x, y: t.y + t.height - n, width: t.width, height: n },
    { x: t.x, y: t.y + n, width: n, height: t.height - n * 2 },
    { x: t.x + t.width - n, y: t.y + n, width: n, height: t.height - n * 2 },
  ];
}

// A 3px opaque window per edge: same look as the old 2px transparent border,
// a fraction of the compositing cost.
function newFrameStrip(bounds) {
  const win = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: false,
    backgroundColor: FRAME_STRIP_COLOR,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    focusable: false,
    hasShadow: false,
    show: false,
    title: "JV take outline",
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  try {
    win.setFocusable(false);
  } catch (_) {}
  wireOverlayShell(win, "frame");
  trackWindow(win, "countdown-frame");
  win
    .loadURL(
      "data:text/html;charset=utf-8," +
        encodeURIComponent('<!doctype html><body style="margin:0;background:#b8b8b8">'),
    )
    .catch(() => {});
  return win;
}

function ensureCountdownFrame() {
  countdownFrameStrips = countdownFrameStrips.filter((win) => win && !win.isDestroyed());
  while (countdownFrameStrips.length < 4) {
    countdownFrameStrips.push(newFrameStrip({ x: 0, y: 0, width: 8, height: 8 }));
  }
}

function layoutFrameStrips(take) {
  const rects = frameStripRects(take);
  if (!rects.length) {
    hideFrameStrips();
    return;
  }
  ensureCountdownFrame();
  countdownFrameStrips.forEach((win, i) => {
    if (!win.isDestroyed() && rects[i]) win.setBounds(rects[i]);
  });
}

function hideFrameStrips() {
  countdownFrameStrips.forEach((win) => {
    if (win && !win.isDestroyed()) win.hide();
  });
}

function destroyFrameStrips() {
  countdownFrameStrips.forEach((win) => {
    if (win && !win.isDestroyed()) win.destroy();
  });
  countdownFrameStrips = [];
}
function startCountdownOverlay(event, payload) {
  const wait = Boolean(payload && payload.wait);
  const recording = Boolean(payload && payload.recording);
  const size = Boolean(payload && payload.size) || (recording && countdownSize);
  const ms = wait || size || recording ? 0 : Math.max(0, Math.round(Number(payload && payload.ms) || 0));
  const gen = ++countdownGen;
  clearInterval(countdownTimer);
  countdownTimer = null;
  countdownWait = wait || size;
  countdownSize = size;
  if (payload && payload.size) countdownTakeRect = null;
  countdownSizeCrop = size && payload && payload.crop ? payload.crop : null;
  if (!recording) {
    countdownAreaDisplayId = 0;
    if (payload && payload.target === "window" && String(payload.windowId || "").startsWith("window:")) {
      countdownTarget = "window";
      countdownWindowId = String(payload.windowId);
      countdownWindowName = String(payload.windowName || "").slice(0, 120);
    } else {
      countdownTarget = payload && payload.target === "area" && countdownSizeCrop ? "area" : "auto";
      if (countdownTarget !== "window") {
        countdownWindowId = "";
        countdownWindowName = "";
      }
    }
  }
  // The bar stays on the display it opened on until the session ends, and
  // an Auto take records that same screen. A recording start inherits the
  // pin its take used instead of re-reading the cursor's screen.
  if (!countdownDisplayId || (size && !recording)) {
    const stash = recordingPinStash && Date.now() - recordingPinStashAt < 20000 ? recordingPinStash : 0;
    countdownDisplayId = (recording && stash) ? stash : (Number(displayForCountdown().id) || 0);
  }
  recordingPinStash = 0;
  recordingPinStashAt = 0;
  if (mediaCapture && typeof mediaCapture.setPinnedDisplayId === "function") {
    mediaCapture.setPinnedDisplayId(countdownDisplayId || null);
  }
  countdownDelayMs = size && payload && Number.isFinite(Number(payload.delayMs)) ? Math.max(0, Math.round(Number(payload.delayMs))) : 0;
  countdownDelayLabel = payload && payload.delayLabel ? String(payload.delayLabel) : "Off";
  countdownFps = size && payload && Number.isFinite(Number(payload.fps))
    ? Math.min(60, Math.max(24, Math.round(Number(payload.fps))))
    : 30;
  // The page always reports what the take records; absent means off.
  countdownMicOn = Boolean(payload && payload.micOn);
  countdownMicNote = "";
  countdownArming = false;
  overlayClickThrough = true;
  countdownRecording = recording;
  countdownPaused = false;
  countdownPausedAt = 0;
  countdownPausedTotal = 0;
  if (recording) registerRecordStopHotkey();
  else unregisterRecordStopHotkey();
  // The bar shows at once and says Loading until the page has the screen.
  countdownCaptureReady = recording || !size || !payload || payload.captureReady !== false;
  const sender = event && event.sender;
  countdownSender = sender;
  countdownThrottled = sender;
  if (sender && !sender.isDestroyed() && countdownSenderWatch !== sender) {
    countdownSenderWatch = sender;
    sender.once("destroyed", () => {
      if (countdownSenderWatch === sender) countdownSenderWatch = null;
      if (countdownSender === sender) {
        countdownSender = null;
        // The page that owned the bar is gone; a bar it cannot hear is a
        // dead overlay that still swallows clicks.
        if (countdownRecording || countdownArming || countdownSize) {
          logRecorder("page died with the bar up", barStateText());
        }
        stopCountdownOverlay();
      }
    });
  }
  setSenderThrottling(false);
  countdownLeftMs = 0;
  countdownEndsAt = 0;
  countdownStartedAt = recording ? Date.now() : 0;
  if (!wait && !size && !recording) {
    countdownLeftMs = ms;
    countdownEndsAt = Date.now() + ms;
  }
  if (size && !recording) logRecorder("bar open", barStateText());
  ensureCountdownOverlay();
  placeCountdownOverlay();
  raiseCountdownOverlay();
  paintCountdownOverlay();
  hideStrayOverlays();
  if (!wait && !size && !recording) emitCountdownTick();
  if (size) emitOverlayBounds();
  if (wait || size) return;
  if (recording) {
    countdownTimer = setInterval(() => {
      try {
        if (gen !== countdownGen) return;
        countdownLeftMs = Date.now() - countdownStartedAt - pausedMsExtra();
        paintCountdownOverlay();
      } catch (error) {
        logCrash("countdown tick", (error && (error.stack || error.message)) || error);
      }
    }, 250);
    return;
  }
  if (ms <= 0) {
    finishCountdown(gen);
    return;
  }
  countdownTimer = setInterval(() => {
    try {
      if (gen !== countdownGen) return;
      countdownLeftMs = Math.max(0, countdownEndsAt - Date.now());
      paintCountdownOverlay();
      emitCountdownTick();
      if (countdownLeftMs > 0) return;
      finishCountdown(gen);
    } catch (error) {
      logCrash("countdown tick", (error && (error.stack || error.message)) || error);
    }
  }, 250);
}

function applyWindowChrome(theme) {
  const id = chromeTheme(theme);
  nativeTheme.themeSource = id;
  const bg = WINDOW_BG[id];
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || isCountdownOverlay(win)) continue;
    win.setBackgroundColor(bg);
  }
}

function createWindow() {
  const work = displayWorkArea();
  const width = Math.min(1280, work.width);
  const height = Math.min(800, work.height);
  const win = new BrowserWindow({
    width,
    height,
    minWidth: Math.min(900, width),
    minHeight: Math.min(640, height),
    maxWidth: work.width,
    maxHeight: work.height,
    backgroundColor: initialWindowBg(),
    title: DEV_BUILD ? "JDesign Dev" : "JDesign",
    icon: path.join(__dirname, "..", "renderer", "icon.ico"),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
      // A live agent turn streams for minutes. Chromium throttles a hidden or
      // occluded window, which stalled the transcript and the project refresh
      // the moment the user looked elsewhere. The work must keep running
      // unwatched, so the main window is never background-throttled.
      backgroundThrottling: false,
    },
  });
  if (DEV_BUILD) win.on("page-title-updated", (event) => event.preventDefault());
  mediaCapture.wireMediaCapture(win);
  trackWindow(win, "main");
  // Cap size with BrowserWindow maxWidth/maxHeight (and setMaximumSize on display
  // change only). Do not setBounds from maximize or from moved-while-maximized:
  // those bounce with will-resize and overflow the call stack.
  let capping = false;
  const capToWorkArea = () => {
    if (win.isDestroyed() || capping) return;
    const area = displayWorkArea(win.getBounds());
    const [maxW, maxH] = win.getMaximumSize();
    const nextMax = nextMaximumSize({ width: maxW, height: maxH }, area);
    if (nextMax) win.setMaximumSize(nextMax.width, nextMax.height);
    const next = clampedNormalBounds(win.getBounds(), area, win.isMaximized());
    if (!next) return;
    capping = true;
    try {
      win.setBounds(next);
    } finally {
      capping = false;
    }
  };
  const windowDisposers = [];
  function bindWindow(target, event, handler) {
    if (!target || typeof target.on !== "function") return;
    target.on(event, handler);
    windowDisposers.push(() => {
      try {
        if (typeof target.removeListener === "function") target.removeListener(event, handler);
      } catch {
        /* target may already be gone */
      }
    });
  }
  function bindWindowOnce(target, event, handler) {
    if (!target || typeof target.once !== "function") return;
    target.once(event, handler);
    windowDisposers.push(() => {
      try {
        if (typeof target.removeListener === "function") target.removeListener(event, handler);
      } catch {
        /* target may already be gone */
      }
    });
  }
  const onMaximize = () => {
    if (win.isDestroyed()) return;
    const area = displayWorkArea(win.getBounds());
    const [maxW, maxH] = win.getMaximumSize();
    const nextMax = nextMaximumSize({ width: maxW, height: maxH }, area);
    if (nextMax) win.setMaximumSize(nextMax.width, nextMax.height);
  };
  win.on("maximize", onMaximize);
  windowDisposers.push(() => {
    try {
      win.removeListener("maximize", onMaximize);
    } catch {
      /* window may already be gone */
    }
  });
  const onWillResize = (event, newBounds) => {
    const area = displayWorkArea(newBounds);
    if (newBounds.width > area.width || newBounds.height > area.height) {
      event.preventDefault();
    }
  };
  win.on("will-resize", onWillResize);
  windowDisposers.push(() => {
    try {
      win.removeListener("will-resize", onWillResize);
    } catch {
      /* window may already be gone */
    }
  });
  win.on("moved", capToWorkArea);
  windowDisposers.push(() => {
    try {
      win.removeListener("moved", capToWorkArea);
    } catch {
      /* window may already be gone */
    }
  });
  win.removeMenu();
  const indexFile = path.join(__dirname, "..", "renderer", "index.html");
  let rendererReloadInFlight = false;
  let rendererReloadTries = 0;
  const loadApp = () => {
    if (win.isDestroyed()) return;
    win.loadFile(indexFile, { query: { theme: initialWindowBg() === WINDOW_BG.light ? "light" : "dark" } }).catch((error) => logCrash("loadApp loadFile", (error && (error.stack || error.message)) || error));
  };
  const onRenderProcessGone = (_event, details) => {
    if (!details || details.reason === "clean-exit") return;
    logCrash("render-process-gone", JSON.stringify(details || {}));
    onRecorderPageGone(win.webContents);
    if (win.isDestroyed()) return;
    if (rendererReloadInFlight) return;
    if (rendererReloadTries >= 3) return;
    rendererReloadInFlight = true;
    rendererReloadTries += 1;
    setTimeout(() => {
      rendererReloadInFlight = false;
      loadApp();
    }, 300);
  };
  const onDidFinishLoad = () => {
    rendererReloadInFlight = false;
    rendererReloadTries = 0;
    // JV has no Record Center yet, so the recorder windows are not prewarmed.
    if (SMOKE) runSmoke(win);
  };
  const onReadyToShow = () => {
    if (!SMOKE && !DRAW_SMOKE) win.show();
  };
  const onWillNavigate = (event, url) => {
    if (!url.startsWith("file:")) {
      event.preventDefault();
      return;
    }
    let dest = "";
    try {
      dest = path.normalize(fileURLToPath(url));
    } catch (_) {
      event.preventDefault();
      return;
    }
    if (dest === path.normalize(indexFile)) return;
    event.preventDefault();
  };
  bindWindow(win.webContents, "render-process-gone", onRenderProcessGone);
  bindWindow(win.webContents, "did-finish-load", onDidFinishLoad);
  bindWindowOnce(win, "ready-to-show", onReadyToShow);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  bindWindow(win.webContents, "will-navigate", onWillNavigate);
  win.on("closed", () => {
    logCrash("main-window-closed", "main window destroyed");
    for (const dispose of windowDisposers) {
      try {
        dispose();
      } catch {
        /* best effort */
      }
    }
    destroyCountdownOverlay();
  });
  loadApp();
  return win;
}

// Runs fn a few seconds after the window first shows (or after a fallback if
// ready-to-show never fires, e.g. the window closed early).
const STARTUP_IDLE_MS = 3000;
function afterFirstShow(win, fn) {
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    clearTimeout(fallback);
    setTimeout(fn, STARTUP_IDLE_MS);
  };
  const fallback = setTimeout(start, 15000);
  if (win && !win.isDestroyed()) win.once("ready-to-show", start);
  else start();
}

app.whenReady().then(async () => {
  try {
  bootDeferredMain();
  protocol.handle("cutline", async (request) => {
    try {
      return await serveCutlineMedia(request);
    } catch {
      return new Response("Bad request", { status: 400 });
    }
  });
  // jvplugin://p/<id>/<hash>.js serves a plugin only while it is on and its
  // code still matches what the person approved.
  protocol.handle("jvplugin", async (request) => {
    try {
      const url = new URL(request.url);
      const parts = url.pathname.split("/").filter(Boolean);
      const id = parts[0] || "";
      const hash = String(parts[1] || "").replace(/\.js$/, "");
      const { pluginCodeIfApproved } = require("../lib/plugins");
      const code = await pluginCodeIfApproved(dataRoot(), id, hash);
      if (code == null) return new Response("Plugin is off or changed", { status: 403 });
      return new Response(code, { status: 200, headers: { "content-type": "text/javascript; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "no-store" } });
    } catch {
      return new Response("Bad request", { status: 400 });
    }
  });

  const mainWin = createWindow();
  attachMainIpc();
  try {
    drawStudio = await require("../draw/studio.cjs").init({
      window: mainWin,
      dataDir: path.join(app.getPath("userData"), "draw"),
      onSwitch: switchStudio,
      getThemeMode: () => themeMode,
      // The accent from Settings > Appearance; before the first set-chrome, the saved one.
      getAccent: () => {
        if (themeAccent) return themeAccent;
        try { return require("./jeditor-ipc.cjs").readPrefs(dataRoot()).accent; } catch { return "mono"; }
      },
      setThemeMode: (mode) => {
        try { mainWin.webContents.send("studio-theme", { mode }); } catch {}
      },
      onSmokeExit: (code) => app.exit(code),
      // A drawing an agent made or changed mid-turn becomes a card in the
      // project chat transcript.
      onArtifact: (info) => {
        try {
          if (agentHub && agentHub.acp && typeof agentHub.acp.recordDrawArtifact === "function") agentHub.acp.recordDrawArtifact(info);
        } catch {}
      },
      // Draw hands a finished drawing to the video library (same path as a dropped file).
      addToVideoLibrary: async (payload) => {
        const state = await loadState();
        const ws = await loadWorkspace(state.activeWorkspaceId);
        const item = await writeBufferIntoLibrary(ws, payload || {});
        if (item && item.skipped) return { added: false, name: item.name, reason: item.tooSmall ? "too small" : "already in the library" };
        await saveWorkspace(ws);
        try { mainWin.webContents.send("studio-changed", { studio: currentStudio, library: true }); } catch (_) {}
        return { added: true, name: item.name, id: item.id };
      },
    });
    if (DRAW_SMOKE) drawStudio.show(true);
    try {
      require("../lib/project-delete").cleanupOrphanedProjectData(dataRoot());
    } catch (error) {
      logCrash("orphaned project cleanup", (error && (error.stack || error.message)) || error);
    }
    void migrateLooseDrawings().catch((error) => logCrash("drawing migration", (error && (error.stack || error.message)) || error));
  } catch (error) {
    logCrash("draw init", (error && (error.stack || error.message)) || error);
  }
  void Promise.all([loadState(), mediaCapture.restoreOnReady()]).catch((error) => logCrash("startup restore", (error && (error.stack || error.message)) || error));
  // Housekeeping waits until the window has painted so it never competes
  // with the page load and the first snapshot.
  afterFirstShow(mainWin, () => {
    void pruneBundledDuplicates(dataRoot(), path.join(__dirname, ".."))
      .catch((error) => logCrash("skill vault prune", (error && error.message) || error));
    void recoverInflightTakes();
    void require("../lib/temp-sweep")
      .sweepStaleTemp()
      .then((result) => {
        if (result.removed || result.failed) logCrash("temp sweep", "removed=" + result.removed + " failed=" + result.failed);
      })
      .catch(() => {});
  });
  setTimeout(() => {
    if (storageJob) return;
    void require("../lib/storage-optimizer")
      .sweepSuperseded(dataRoot())
      .catch((error) => logCrash("storage sweep", (error && error.message) || error));
  }, 90000);
  // Dock/undock or a scaling change can leave the bar off its display or
  // split it from its take. Re-place the overlays on the new topology, and
  // drop the cached source list so a new screen can be picked.
  const onOverlayDisplayChange = () => {
    if (mediaCapture && typeof mediaCapture.invalidateCaptureSources === "function") {
      mediaCapture.invalidateCaptureSources();
    }
    if (!(countdownSize || countdownWait || countdownRecording || countdownArming || countdownTimer || areaPicker)) return;
    countdownTakeRect = null;
    areaPickerBounds = null;
    if (areaPicker) closeAreaPicker();
    placeCountdownOverlay();
    raiseCountdownOverlay();
    paintCountdownOverlay();
    hideStrayOverlays();
  };
  screen.on("display-added", onOverlayDisplayChange);
  screen.on("display-removed", onOverlayDisplayChange);
  screen.on("display-metrics-changed", onOverlayDisplayChange);
  app.on("activate", () => {
    const open = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed() && !isCountdownOverlay(win));
    if (open.length === 0) createWindow();
  });
  } catch (error) {
    logCrash("whenReady", (error && (error.stack || error.message)) || error);
  }
});

app.on("window-all-closed", () => {
  logCrash("window-all-closed", "last window closed; quitting");
  if (process.platform !== "darwin") app.quit();
});

app.on("second-instance", () => {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && !isCountdownOverlay(w));
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.on("before-quit", () => {
  logCrash("before-quit", "quit requested");
  try { require("../draw/studio.cjs").shutdown(); } catch (_) {}
  try {
    globalShortcut.unregisterAll();
  } catch (_) {}
  shutdownMainProcess();
});

app.on("quit", (_event, exitCode) => {
  logCrash("quit", "exitCode=" + exitCode);
});

ipcMain.handle("snapshot", async () => snapshot());

ipcMain.handle("bundled-skills", () =>
  discoverBundledSkills(path.join(__dirname, "..")).map(({ name, description, body, meta }) => ({ name, description, body, title: (meta && meta.title) || "", about: (meta && meta.about) || "" })),
);
ipcMain.handle("user-skills-list", async () => ({ skills: await listUserSkills(dataRoot()), maxLength: MAX_SKILL_LENGTH }));
ipcMain.handle("user-skill-save", (_event, payload) => saveUserSkill(dataRoot(), payload));
ipcMain.handle("user-skill-create", (_event, payload) => createUserSkill(dataRoot(), path.join(__dirname, ".."), payload));
ipcMain.handle("user-skill-remove", (_event, payload) => removeUserSkill(dataRoot(), payload));
ipcMain.handle("user-instructions-get", async () => ({
  text: await readUserInstructions(dataRoot()),
  maxLength: MAX_INSTRUCTIONS_LENGTH,
}));
ipcMain.handle("user-instructions-save", async (_event, text) => ({
  text: await writeUserInstructions(dataRoot(), text),
  maxLength: MAX_INSTRUCTIONS_LENGTH,
}));
ipcMain.handle("user-rules-get", () => ({
  rules: listUserRules(dataRoot()),
  maxRules: MAX_RULES,
  maxText: MAX_RULE_TEXT,
}));
ipcMain.handle("user-rules-save", (_event, payload) => ({
  rules: setUserRules(dataRoot(), payload && payload.rules),
  maxRules: MAX_RULES,
  maxText: MAX_RULE_TEXT,
}));
ipcMain.handle("user-rules-draft-get", () => ({ draft: readRulesDraft(dataRoot()) }));
ipcMain.handle("user-rules-draft-save", (_event, payload) => {
  writeRulesDraft(dataRoot(), payload && payload.draft);
  return { ok: true };
});

ipcMain.handle("studio-switch", (_event, to) => ({ studio: switchStudio(to) }));
ipcMain.handle("studio-current", () => ({ studio: currentStudio }));

ipcMain.handle("set-chrome", (_event, payload) => {
  const theme = payload && payload.theme;
  applyWindowChrome(theme);
  // The Draw studio follows the same Light / Dark / System choice and accent.
  if (payload && ["mono", "iris", "blue", "teal", "green", "amber", "rose"].includes(payload.accent)) themeAccent = payload.accent;
  if (payload && ["light", "dark", "system"].includes(payload.mode)) {
    themeMode = payload.mode;
    try {
      const wc = drawStudio && drawStudio.webContents();
      if (wc && !wc.isDestroyed()) wc.send("theme:set", { mode: themeMode, accent: themeAccent || undefined });
    } catch (_) {}
  }
  return { theme: chromeTheme(theme) };
});

ipcMain.handle("pick-files", async (event, kind) => {
  const filters = {
    image: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }],
    video: [{ name: "Videos", extensions: ["mp4", "m4v", "mov", "webm", "avi", "mkv"] }],
    audio: [{ name: "Audio", extensions: ["mp3", "wav", "ogg", "m4a", "aac", "flac"] }],
  };
  const win = BrowserWindow.fromWebContents(event.sender);
  const options = {
    properties: ["openFile", "multiSelections"],
    filters: filters[kind] || [{ name: "Media", extensions: ["*"] }],
  };
  const result = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled) return [];
  return result.filePaths || [];
});

ipcMain.handle("add-files", async (_event, payload) => {
  const state = await loadState();
  const ws = await loadWorkspace(state.activeWorkspaceId);
  const added = [];
  const skipped = [];
  const paths = payload.paths || [];
  // A dropped file copies at disk speed with nothing on screen to show for it,
  // so stream byte progress back to the window that asked. Only that window
  // gets it: another open window has no import in flight.
  const sender = _event && _event.sender;
  const sendProgress = (message) => {
    if (!sender || sender.isDestroyed()) return;
    sender.send("add-files-progress", message);
  };
  sendProgress({ phase: "start", index: 0, total: paths.length, copied: 0, bytes: 0, name: "" });
  for (let index = 0; index < paths.length; index += 1) {
    const source = paths[index];
    const name = path.basename(String(source || ""));
    const item = await copyIntoLibrary(ws, source, {
      name: payload.names ? payload.names[index] : undefined,
      mime: payload.mimes ? payload.mimes[index] : undefined,
      source: payload.source,
      onProgress: (progress) =>
        sendProgress({
          phase: progress.phase,
          index,
          total: paths.length,
          copied: progress.copied,
          bytes: progress.total,
          name,
        }),
    });
    if (item && item.skipped) skipped.push(item);
    else added.push(item);
    // A skipped file has no copy to show, so the panel says so instead of
    // reporting progress for a file that never landed.
    sendProgress({
      phase: "done",
      index: index + 1,
      total: paths.length,
      copied: 0,
      bytes: 0,
      name,
      skipped: Boolean(item && item.skipped),
    });
  }
  if (added.length) await saveWorkspace(ws);
  return { snapshot: await snapshot(), added, skipped };
});

ipcMain.handle("add-buffer", async (_event, payload) => {
  const state = await loadState();
  const ws = await loadWorkspace(state.activeWorkspaceId);
  const item = await writeBufferIntoLibrary(ws, payload || {});
  if (item && item.skipped) {
    return { snapshot: await snapshot(), added: [], skipped: [item] };
  }
  await saveWorkspace(ws);
  if (item && item.kind === "video" && payload && payload.madeIn === "record-center") scheduleTakeShrink(item.id);
  return { snapshot: await snapshot(), added: [item], skipped: [] };
});

// Take chunks stream here one by one so the page never buffers a whole
// recording in memory (a long take used to OOM the renderer and vanish).
ipcMain.handle("take-write-start", async (_event, payload) => {
  const id = randomUUID();
  const ext = String((payload && payload.mime) || "").startsWith("video/mp4") ? ".mp4" : ".webm";
  const file = path.join(inflightTakesDir(), id + ext);
  await ensureDir(inflightTakesDir());
  const stream = fssync.createWriteStream(file);
  const entry = { file, stream, sender: _event.sender, hash: createHash("sha256"), failed: false };
  // A write or open failure otherwise surfaces as uncaughtException spam for
  // every later chunk. Mark the take so finish can flag it partial instead.
  stream.on("error", (error) => {
    entry.failed = true;
    logRecorder("take stream error", (error && error.message) || error);
  });
  inflightTakes.set(id, entry);
  // If the page dies mid-take (the OOM crash that lost recordings), close the
  // file so the recovery sweep can adopt whatever footage reached disk.
  entry.onDead = () => {
    if (!inflightTakes.delete(id)) return;
    void closeTakeStream(entry).then(() => recoverInflightTakes());
  };
  if (entry.sender && typeof entry.sender.once === "function") {
    entry.sender.once("destroyed", entry.onDead);
  }
  // Older orphans get adopted while a new take runs, but not during the
  // encoder spin-up: hashing an old take there competed with the new one.
  setTimeout(() => void recoverInflightTakes(), 15000);
  return { id };
});

ipcMain.handle("take-write-chunk", async (_event, payload) => {
  const entry = inflightTakes.get(payload && payload.id);
  if (!entry || entry.failed) return { ok: false };
  const buf = bufferFromPayload(payload && payload.buffer);
  if (!buf || !buf.length) return { ok: true };
  try {
    // A slow disk used to buffer the whole take in the main process. Wait
    // for the drain so backpressure reaches the renderer, and only hash the
    // bytes the kernel actually accepted.
    if (entry.stream.write(buf) === false) {
      await new Promise((resolve, reject) => {
        entry.stream.once("drain", resolve);
        entry.stream.once("error", reject);
      });
    }
    entry.hash.update(buf);
    return { ok: true };
  } catch (error) {
    entry.failed = true;
    logRecorder("take chunk failed", (error && error.message) || error);
    return { ok: false, error: String((error && error.message) || error) };
  }
});

function closeTakeStream(entry) {
  return new Promise((resolve) => {
    try {
      entry.stream.end(() => resolve(true));
    } catch {
      resolve(false);
    }
  });
}

function releaseTakeStream(payload) {
  const entry = inflightTakes.get(payload && payload.id);
  if (!entry) return null;
  inflightTakes.delete(payload && payload.id);
  if (entry.sender && entry.onDead && typeof entry.sender.removeListener === "function") {
    entry.sender.removeListener("destroyed", entry.onDead);
  }
  return entry;
}

ipcMain.handle("take-write-finish", async (_event, payload) => {
  const entry = releaseTakeStream(payload);
  if (!entry) return { ok: false };
  await closeTakeStream(entry);
  const st = await fs.stat(entry.file).catch(() => null);
  const size = st ? st.size : 0;
  // An empty take file is junk: nothing was recorded, nothing to adopt later.
  if (!size) await fs.unlink(entry.file).catch(() => {});
  // The hash rode the chunk stream, so registering the take skips a full
  // second read of a multi-GB file. A failed stream's digest does not match
  // the truncated file, so it ships without a hash.
  return {
    ok: true,
    path: entry.file,
    size,
    failed: entry.failed === true,
    contentHash: entry.failed ? "" : entry.hash.digest("hex"),
  };
});

ipcMain.handle("take-write-abort", async (_event, payload) => {
  const entry = releaseTakeStream(payload);
  if (!entry) return { ok: false };
  await closeTakeStream(entry);
  await fs.unlink(entry.file).catch(() => {});
  return { ok: true };
});

ipcMain.handle("add-take-file", async (_event, payload) => {
  const state = await loadState();
  const ws = await loadWorkspace(state.activeWorkspaceId);
  const item = await writeFileIntoLibrary(ws, payload || {});
  if (item && item.skipped) {
    return { snapshot: await snapshot(), added: [], skipped: [item] };
  }
  await saveWorkspace(ws);
  if (item && item.kind === "video") scheduleTakeShrink(item.id);
  return { snapshot: await snapshot(), added: [item], skipped: [] };
});

// Any webm still in the inflight dir at boot or at the next take start is a
// take the renderer lost (OOM/crash). Register it instead of losing it.
let recoverInflightBusy = false;
async function recoverInflightTakes() {
  if (recoverInflightBusy) return;
  recoverInflightBusy = true;
  try {
    const dir = inflightTakesDir();
    const names = await fs.readdir(dir).catch(() => []);
    const orphans = names.filter(
      (name) =>
        /\.(webm|mp4)$/i.test(name) && !inflightTakes.has(name.slice(0, name.lastIndexOf("."))),
    );
    if (!orphans.length) return;
    const state = await loadState();
    const ws = await loadWorkspace(state.activeWorkspaceId);
    const lib = Array.isArray(ws.library) ? ws.library : [];
    let changed = false;
    for (const name of orphans) {
      const file = path.join(dir, name);
      const st = await fs.stat(file).catch(() => null);
      if (!st) continue;
      // A take shorter than the sweep delay finishes and hands its file to
      // add-take-file a moment before this runs; a fresh mtime means that
      // handoff is still in flight, not that the take is orphaned.
      if (Date.now() - st.mtimeMs < 60000) continue;
      if (st.size < 16384) {
        await fs.unlink(file).catch(() => {});
        continue;
      }
      let n = 1;
      while (lib.some((item) => item && item.name === "Recovered take " + n)) n += 1;
      const item = await writeFileIntoLibrary(ws, {
        name: "Recovered take " + n,
        mime: name.toLowerCase().endsWith(".mp4") ? "video/mp4" : "video/webm",
        path: file,
        madeIn: "record-center",
      }).catch((error) => {
        logRecorder("take recover failed", (error && error.message) || error);
        return null;
      });
      if (item && item.id) {
        changed = true;
        logRecorder("take recovered", item.name + " " + st.size + "B");
        scheduleTakeShrink(item.id);
      }
    }
    if (changed) await saveWorkspace(ws);
  } catch (error) {
    logRecorder("take recover sweep failed", (error && error.message) || error);
  } finally {
    recoverInflightBusy = false;
  }
}

// The floating card (bar or recording timer) drags by its non-button areas
// so it never has to sit on top of game HUD. Pointermove can fire far faster
// than the window moves, so pending deltas coalesce into one apply per tick.
let overlayDragPending = null;
let overlayDragFlush = null;
registerOn(ipcMain, "overlay-drag-by", (event, payload) => {
  const win = countdownOverlay;
  if (!win || win.isDestroyed()) return;
  if (event.sender !== win.webContents) return;
  const dx = Number(payload && payload.dx) || 0;
  const dy = Number(payload && payload.dy) || 0;
  if (!dx && !dy) return;
  overlayDragPending = overlayDragPending
    ? { dx: overlayDragPending.dx + dx, dy: overlayDragPending.dy + dy }
    : { dx, dy };
  if (overlayDragFlush) return;
  overlayDragFlush = setTimeout(() => {
    overlayDragFlush = null;
    const delta = overlayDragPending;
    overlayDragPending = null;
    if (!delta || win.isDestroyed()) return;
    const bounds = win.getBounds();
    const area = displayWorkArea(bounds);
    if (!area) return;
    const nx = Math.min(Math.max(bounds.x + delta.dx, area.x), area.x + Math.max(0, area.width - bounds.width));
    const ny = Math.min(Math.max(bounds.y + delta.dy, area.y), area.y + Math.max(0, area.height - bounds.height));
    win.setPosition(Math.round(nx), Math.round(ny));
  }, 33);
});

ipcMain.handle("start-countdown-overlay", (event, payload) => {
  startCountdownOverlay(event, payload);
});

registerOn(ipcMain, "prewarm-recorder-bar", () => {
  prewarmRecorderWindows();
});

ipcMain.handle("stop-countdown-overlay", () => {
  stopCountdownOverlay();
});

function barStateText() {
  return (
    "size=" + Boolean(countdownSize) +
    " recording=" + Boolean(countdownRecording) +
    " ready=" + Boolean(countdownCaptureReady) +
    " arming=" + Boolean(countdownArming) +
    " picker=" + Boolean(areaPicker) +
    " target=" + countdownTarget +
    " page=" + Boolean(overlaySender())
  );
}

// The bar and the area picker share countdown-preload.cjs, so any overlay
// window can send these channels. Only the live overlay windows may press;
// the page that owns the countdown may too, since its Record/Stop buttons
// mirror the bar's presses over the same channels.
function isOverlaySender(sender) {
  if (sender === countdownSender) return true;
  return [countdownOverlay, areaPickerWin].some(
    (win) => win && !win.isDestroyed() && win.webContents === sender,
  );
}

registerOn(ipcMain, "countdown-overlay-start", (event) => {
  if (!isOverlaySender(event.sender)) return;
  logRecorder("press record", barStateText());
  // A press while the delay counts down means "record now": skip the wait.
  // A press inside ~400ms of arming is the tail of a double-click, not an
  // intentional skip.
  if (countdownArming) {
    if (Date.now() - countdownArmingAt < 400) {
      logRecorder("ignored record", "arming just started");
      return;
    }
    finishCountdown(countdownGen);
    return;
  }
  if (countdownRecording) return;
  if (countdownSize && !countdownRecording && !countdownCaptureReady) {
    logRecorder("ignored record", "screen capture still opening");
    return;
  }
  if (areaPicker) {
    closeAreaPicker();
    raiseCountdownOverlay();
  }
  if (countdownSize && !countdownRecording && countdownDelayMs > 0) {
    startOverlayDelayThenRecord();
    return;
  }
  finishCountdown(countdownGen);
});

registerOn(ipcMain, "countdown-overlay-stop", (event) => {
  if (!isOverlaySender(event.sender)) return;
  logRecorder("press stop", barStateText());
  if (countdownRecording) {
    stopOverlayKeepDesktop("recording-overlay-stop", { reason: "stop" });
    return;
  }
  closeRecorderBar("stop");
});

registerOn(ipcMain, "countdown-overlay-close", (event) => {
  if (!isOverlaySender(event.sender)) return;
  logRecorder("press close", barStateText());
  closeRecorderBar("close");
});

registerOn(ipcMain, "overlay-set-target", (event, payload) => {
  if (!isOverlaySender(event.sender)) return;
  const wanted = payload && payload.target;
  const target = wanted === "area" || wanted === "window" ? wanted : "auto";
  logRecorder("press " + target, barStateText());
  if (!countdownSize || countdownRecording || countdownArming) {
    logRecorder("ignored " + target, "bar is not in setup");
    return;
  }
  if (payload && payload.target === "area") openAreaPicker();
  else if (payload && payload.target === "window") openWindowPicker();
  else applyOverlayTarget("auto", null);
});

registerOn(ipcMain, "overlay-window-picked", onWindowPicked);

// The bar's Pause button acts like Stop: forwarded to the page that owns
// the take, which pauses the MediaRecorder and reports the new state back
// through update-countdown-overlay.
registerOn(ipcMain, "countdown-overlay-pause", (event) => {
  if (!isOverlaySender(event.sender)) return;
  if (!countdownRecording) return;
  const sender = overlaySender();
  if (sender) sender.send("recording-overlay-pause");
});

registerOn(ipcMain, "overlay-area-picked", onAreaPicked);

// The picker reports whether a gesture (drag or pinned corner) is in flight
// so a blur does not cancel mid-pick.
registerOn(ipcMain, "area-pick-state", (_event, payload) => {
  // Only the live picker may hold the blur-cancel gesture flag.
  if (areaPicker && !areaPicker.isDestroyed() && _event.sender === areaPicker.webContents) {
    areaPickerGesture = Boolean(payload && payload.active);
  }
});

// The page reports capture failures and dropped captures for recorder.log.
registerOn(ipcMain, "recorder-log", (_event, payload) => {
  const event = payload && typeof payload.event === "string" ? payload.event.slice(0, 60) : "";
  if (!event) return;
  logRecorder("page " + event, payload && typeof payload.detail === "string" ? payload.detail : "");
});

ipcMain.on("overlay-nudge-delay", (event, payload) => {
  if (!isOverlaySender(event.sender)) return;
  if (countdownSender && !countdownSender.isDestroyed()) {
    countdownSender.send("overlay-nudge-delay", payload || {});
  }
});

ipcMain.on("overlay-nudge-fps", (event, payload) => {
  if (!isOverlaySender(event.sender)) return;
  if (countdownSender && !countdownSender.isDestroyed()) {
    countdownSender.send("overlay-nudge-fps", payload || {});
  }
});

ipcMain.on("overlay-toggle-sound", (event) => {
  if (!isOverlaySender(event.sender)) return;
  logRecorder("press sound", barStateText());
  if (countdownSender && !countdownSender.isDestroyed()) {
    countdownSender.send("overlay-toggle-sound");
  }
});

ipcMain.handle("update-countdown-overlay", (event, payload) => {
  // Only the page that owns the session may write overlay state; this payload
  // flips captureReady, which gates the Record press.
  if (!countdownSender || event.sender !== countdownSender) return { ok: false };
  if (payload && payload.delayLabel) countdownDelayLabel = String(payload.delayLabel);
  if (payload && Number.isFinite(Number(payload.delayMs))) {
    countdownDelayMs = Math.max(0, Math.round(Number(payload.delayMs)));
    // A nudge during arming moves the still-running countdown too.
    if (countdownArming) countdownEndsAt = Date.now() + countdownDelayMs;
  }
  if (payload && Number.isFinite(Number(payload.fps))) {
    countdownFps = Math.min(60, Math.max(24, Math.round(Number(payload.fps))));
  }
  if (payload && typeof payload.micOn === "boolean") countdownMicOn = payload.micOn;
  if (payload && typeof payload.micNote === "string") countdownMicNote = payload.micNote.slice(0, 12);
  if (payload && typeof payload.paused === "boolean") setRecordingPaused(payload.paused);
  if (payload && payload.captureReady === true) countdownCaptureReady = true;
  paintCountdownOverlay();
  return { ok: true };
});

ipcMain.handle("update-library-item", async (_event, payload) => {
  const state = await loadState();
  const ws = await loadWorkspace(state.activeWorkspaceId);
  const item = ws.library.find((entry) => entry.id === payload.id);
  if (!item) throw new Error("Item not found.");
  const patch = payload.patch || {};
  if (typeof patch.name === "string") item.name = patch.name.trim() || item.name;
  if (typeof patch.description === "string") item.description = patch.description.slice(0, 2000);
  if (typeof patch.aiCanUse === "boolean") item.aiCanUse = patch.aiCanUse;
  if (Number.isFinite(patch.durationMs)) item.durationMs = Math.max(0, Math.round(patch.durationMs));
  // The renderer learns a clip's real size when it grabs the poster frame.
  // Storing it is what lets the editor tell portrait from landscape, and what
  // stops the poster pass from running again on every page open.
  if (Number.isFinite(patch.videoWidth)) item.videoWidth = Math.max(0, Math.round(patch.videoWidth));
  if (Number.isFinite(patch.videoHeight)) item.videoHeight = Math.max(0, Math.round(patch.videoHeight));
  if (patch.poster && patch.poster.data != null) {
    const posterRel = path.join("posters", item.id + ".jpg");
    const posterDest = path.join(workspaceDir(ws.id), posterRel);
    await ensureDir(path.dirname(posterDest));
    const tmp = posterDest + ".tmp";
    await fs.writeFile(tmp, posterBytes(patch.poster.data));
    await fs.rename(tmp, posterDest);
    item.posterFile = posterRel;
  }
  await saveWorkspace(ws);
  return snapshot();
});

ipcMain.handle("media-cleanup-scan", async (_event, payload) => {
  const { scanMedia } = require("../lib/media-cleanup");
  const { findFfmpeg } = require("../lib/card-render");
  const state = await loadState();
  const body = payload || {};
  return scanMedia(dataRoot(), state.activeWorkspaceId, {
    staleDays: body.staleDays,
    ffmpeg: findFfmpeg(),
    nativeImage,
  });
});

ipcMain.handle("media-cleanup-delete", async (_event, payload) => {
  const { deleteMedia } = require("../lib/media-cleanup");
  const state = await loadState();
  return deleteMedia(dataRoot(), state.activeWorkspaceId, payload || {});
});

ipcMain.handle("media-cleanup-delete-many", async (_event, payload) => {
  const { deleteMany } = require("../lib/media-cleanup");
  const state = await loadState();
  return deleteMany(dataRoot(), state.activeWorkspaceId, payload || {});
});

// One free-up-space job at a time. New takes queue a video-only run of their
// own; it waits behind a running job and never runs while recording.
let storageJob = null;
let storageJobLast = null;
const storageTakeQueue = new Set();
let storageTakeTimer = null;

function storageBusy() {
  return Boolean(countdownRecording || countdownArming || inflightTakes.size);
}

function sendStorageJob(message) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !isCountdownOverlay(win)) win.webContents.send("storage-job", message);
  }
}

async function clearSessionCaches() {
  const { session } = require("electron");
  for (const ses of [session.defaultSession, session.fromPartition("persist:cutline-news")]) {
    await ses.clearCache().catch(() => {});
    if (typeof ses.clearCodeCaches === "function") await ses.clearCodeCaches({}).catch(() => {});
  }
}

function startStorageJob(steps, extra) {
  if (storageJob) return storageJob.status;
  const { runOptimize } = require("../lib/storage-optimizer");
  const { findFfmpeg } = require("../lib/card-render");
  const ffmpeg = findFfmpeg();
  if (!ffmpeg && (steps.videos || steps.images)) throw new Error("ffmpeg was not found, so videos and images cannot be shrunk.");
  const controller = new AbortController();
  const status = { running: true, auto: Boolean(extra && extra.auto), steps, progress: { step: "start", label: "Starting" }, startedAt: new Date().toISOString() };
  storageJob = { controller, status };
  sendStorageJob({ type: "progress", status });
  void runOptimize(dataRoot(), {
    steps,
    only: extra && extra.only,
    ffmpeg,
    nativeImage,
    clearSessionCaches,
    isBusy: storageBusy,
    signal: controller.signal,
    userDataDir: app.getPath("userData"),
    onProgress: (progress) => {
      status.progress = progress;
      sendStorageJob({ type: "progress", status });
    },
    onChanged: () => sendStorageJob({ type: "changed" }),
  })
    .then((summary) => {
      storageJobLast = Object.assign({}, status, { running: false, summary, finishedAt: new Date().toISOString() });
    })
    .catch((error) => {
      logCrash("storage job", (error && (error.stack || error.message)) || error);
      storageJobLast = Object.assign({}, status, { running: false, error: (error && error.message) || String(error) });
    })
    .finally(() => {
      storageJob = null;
      sendStorageJob({ type: "done", status: storageJobLast });
      sendStorageJob({ type: "changed" });
      if (storageTakeQueue.size) scheduleTakeShrink();
    });
  return status;
}

// A new screen take is shrunk in the background a little after it lands, so
// recordings stop piling up at the browser encoder's bloated bitrate.
function scheduleTakeShrink(id) {
  if (id) storageTakeQueue.add(String(id));
  clearTimeout(storageTakeTimer);
  storageTakeTimer = setTimeout(() => {
    if (storageJob || !storageTakeQueue.size) return;
    if (storageBusy()) return scheduleTakeShrink();
    const only = Array.from(storageTakeQueue).map((itemId) => ({ list: "library", id: itemId }));
    storageTakeQueue.clear();
    try {
      startStorageJob({ videos: true }, { auto: true, only });
    } catch (error) {
      logRecorder("take shrink skipped", (error && error.message) || error);
    }
  }, 30000);
}

ipcMain.handle("storage-report", async () => {
  const { storageReport } = require("../lib/storage-optimizer");
  const { findFfmpeg } = require("../lib/card-render");
  return storageReport(dataRoot(), { ffmpeg: findFfmpeg(), userDataDir: app.getPath("userData") });
});

ipcMain.handle("storage-optimize-start", async (_event, payload) => {
  const body = payload || {};
  const pick = body.steps || {};
  const steps = { videos: pick.videos !== false, images: pick.images !== false, copies: pick.copies !== false, caches: pick.caches !== false };
  if (!steps.videos && !steps.images && !steps.copies && !steps.caches) throw new Error("Pick at least one thing to shrink.");
  return startStorageJob(steps);
});

ipcMain.handle("storage-optimize-cancel", async () => {
  if (storageJob) storageJob.controller.abort();
  return { ok: true };
});

ipcMain.handle("storage-optimize-status", async () => (storageJob ? storageJob.status : storageJobLast));

ipcMain.handle("storage-leftover-delete", async (_event, payload) => {
  const { deleteLeftover } = require("../lib/storage-optimizer");
  if (storageJob) throw new Error("Wait for the free-up-space job to finish.");
  return deleteLeftover(dataRoot(), payload || {});
});

ipcMain.handle("storage-leftover-open", async (_event, payload) => {
  const { leftoverDir } = require("../lib/storage-optimizer");
  const state = await loadState();
  const dir = leftoverDir(dataRoot(), String((payload && payload.id) || ""), state.activeWorkspaceId);
  if (!dir) throw new Error("Unknown leftover group.");
  const err = await shell.openPath(dir);
  if (err) throw new Error(err);
  return { ok: true };
});

ipcMain.handle("update-finished-item", async (_event, payload) => {
  const { updateFinishedItem } = require("../lib/finished-io");
  const state = await loadState();
  return updateFinishedItem(dataRoot(), payload.id, payload.patch || {}, state.activeWorkspaceId);
});

ipcMain.handle("delete-finished-item", async (_event, id) => {
  const { deleteFinishedItem } = require("../lib/finished-io");
  const state = await loadState();
  return deleteFinishedItem(dataRoot(), id, state.activeWorkspaceId);
});

ipcMain.handle("open-finished-item", async (_event, id) => {
  const { getFinishedItem, finishedFilePath } = require("../lib/finished-io");
  const state = await loadState();
  const item = await getFinishedItem(dataRoot(), id, state.activeWorkspaceId);
  if (!item) throw new Error("Finished video not found.");
  const file = finishedFilePath(dataRoot(), state.activeWorkspaceId, item);
  const err = await shell.openPath(file);
  if (err) throw new Error(err);
  return { ok: true };
});

ipcMain.handle("export-finished-item", async (event, id) => {
  const { getFinishedItem, finishedFilePath } = require("../lib/finished-io");
  const state = await loadState();
  const item = await getFinishedItem(dataRoot(), id, state.activeWorkspaceId);
  if (!item) throw new Error("Finished video not found.");
  const src = finishedFilePath(dataRoot(), state.activeWorkspaceId, item);
  const ext = path.extname(item.file || "") || ".mp4";
  const win = BrowserWindow.fromWebContents(event.sender);
  const options = {
    defaultPath: (item.name || "finished") + ext,
    filters: [{ name: "Video", extensions: [String(ext).replace(".", "") || "mp4"] }],
  };
  const result = win
    ? await dialog.showSaveDialog(win, options)
    : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return { canceled: true };
  await fs.copyFile(src, result.filePath);
  return { canceled: false, path: result.filePath };
});

ipcMain.handle("delete-library-item", async (_event, id) => {
  const state = await loadState();
  const { deleteLibraryItem } = require("../lib/library-io");
  const found = await loadWorkspace(state.activeWorkspaceId);
  if (!(found.library || []).some((entry) => entry.id === id)) return snapshot();
  await deleteLibraryItem(dataRoot(), id, state.activeWorkspaceId);
  return snapshot();
});

ipcMain.handle("create-link", async (_event, payload) => {
  const refs = payload.refs || [];
  if (refs.length !== 2 || refs[0] === refs[1]) throw new Error("Link two different items.");
  const state = await loadState();
  const ws = await loadWorkspace(state.activeWorkspaceId);
  const items = refs.map((id) => ws.library.find((entry) => entry.id === id));
  if (items.some((item) => !item)) throw new Error("Both items must be in this workspace.");
  const existing = ws.links.find((link) => link.refs.includes(refs[0]) && link.refs.includes(refs[1]));
  if (existing) return snapshot();
  ws.links.push({ id: randomUUID(), refs: [refs[0], refs[1]], createdAt: new Date().toISOString() });
  await saveWorkspace(ws);
  return snapshot();
});

ipcMain.handle("delete-link", async (_event, id) => {
  const state = await loadState();
  const ws = await loadWorkspace(state.activeWorkspaceId);
  ws.links = ws.links.filter((link) => link.id !== id);
  await saveWorkspace(ws);
  return snapshot();
});

ipcMain.handle("save-card", async (_event, card) => {
  const { applyCardEdit } = require("../lib/card-apply");
  const state = await loadState();
  const result = await applyCardEdit({
    dataRoot: dataRoot(),
    workspaceId: state.activeWorkspaceId,
    cardId: card && card.id,
    patch: card || {},
  });
  return result.snapshot;
});

function isHttpUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// One call serves both the chat error cards and the error list:
// no payload reads the log and the display preference, { advanced } saves the
// preference, { clear } empties the log.
ipcMain.handle("agent-errors", async (_event, payload) => {
  const { readErrors, clearErrors, readErrorDisplay, setErrorDisplay, errorsPath } = require("../lib/error-log");
  const body = payload && typeof payload === "object" ? payload : {};
  const opts = { dataRoot: dataRoot(), env: process.env };
  if (body.clear) return clearErrors(opts);
  const displayOpts = { env: process.env };
  if ("advanced" in body) return { display: setErrorDisplay(body, displayOpts) };
  const display = readErrorDisplay(displayOpts);
  const file = errorsPath(opts);
  const entries = readErrors(Object.assign({ limit: body.limit }, opts)).map((row) => Object.assign({ path: file }, row));
  return { entries, display, path: file };
});

ipcMain.handle("agent-errors-reveal", async () => {
  const { errorsPath } = require("../lib/error-log");
  const file = errorsPath({ dataRoot: dataRoot(), env: process.env });
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "", { encoding: "utf8", flag: "a" });
  } catch {
    return { ok: false, path: file };
  }
  shell.showItemInFolder(file);
  return { ok: true, path: file };
});

ipcMain.handle("open-external", async (_event, payload) => {
  const url = typeof payload === "string" ? payload : payload && payload.url;
  if (typeof url !== "string" || !isHttpUrl(url)) return { ok: false };
  await shell.openExternal(url);
  return { ok: true };
});

ipcMain.handle("delete-card", async (_event, id) => {
  const state = await loadState();
  const ws = await loadWorkspace(state.activeWorkspaceId);
  ws.cards = ws.cards.filter((entry) => entry.id !== id);
  await saveWorkspace(ws);
  return snapshot();
});

ipcMain.handle("list-card-templates", async () => {
  const { listCardTemplates } = require("../lib/card-templates");
  return { templates: listCardTemplates(dataRoot()) };
});

ipcMain.handle("list-card-template-store", async () => {
  const { listStoreTemplates, listStoreCategories } = require("../lib/card-template-store");
  return {
    templates: listStoreTemplates(dataRoot()),
    categories: listStoreCategories(dataRoot()),
  };
});

ipcMain.handle("install-card-template", async (_event, payload) => {
  const { installTemplate, listStoreTemplates } = require("../lib/card-template-store");
  const id = payload && typeof payload === "object" ? payload.id : payload;
  const template = installTemplate(dataRoot(), String(id || ""));
  return { template, templates: listStoreTemplates(dataRoot()) };
});

ipcMain.handle("save-card-template", async (_event, payload) => {
  const { saveCardAsTemplate, listStoreTemplates } = require("../lib/card-template-store");
  const body = payload && typeof payload === "object" ? payload : {};
  let card = body.card && typeof body.card === "object" ? body.card : null;
  const cardId = typeof payload === "string" ? payload : body.cardId;
  if (!card && cardId) {
    const state = await loadState();
    const ws = await loadWorkspace(state.activeWorkspaceId);
    card = (ws.cards || []).find((entry) => entry.id === cardId) || null;
    if (!card) throw new Error("Card not found.");
  }
  if (!card) throw new Error("cardId or card is required.");
  const template = saveCardAsTemplate(dataRoot(), card);
  return { template, templates: listStoreTemplates(dataRoot()) };
});

ipcMain.handle("render-card", async (_event, payload) => {
  const { renderCardPng, findFfmpeg, findFont } = require("../lib/card-render");
  const { applyCardPatch } = require("../lib/card-apply");
  const { defaultCard } = require("../lib/workspace-store");
  const state = await loadState();
  const workspaceId = state.activeWorkspaceId;
  let card = payload && payload.card;
  if (!card && payload && payload.cardId) {
    const ws = await loadWorkspace(workspaceId);
    card = (ws.cards || []).find((entry) => entry.id === payload.cardId) || null;
  }
  if (!card) throw new Error("Card not found.");
  card = applyCardPatch(defaultCard(), card, { expandTemplate: false });
  const outDir = path.join(workspaceDir(workspaceId), "renders");
  await fs.mkdir(outDir, { recursive: true });
  const outPath = (payload && payload.outPath) || path.join(outDir, (card.id || "preview") + "-" + Date.now() + ".png");
  return renderCardPng({
    dataRoot: dataRoot(),
    workspaceId,
    card,
    outPath,
    ffmpeg: findFfmpeg(),
    font: findFont(),
  });
});

ipcMain.handle("card-html-document", async (_event, payload) => {
  const { buildCardDocument } = require("../lib/html-card");
  const { htmlCardDataUris } = require("../lib/card-render");
  const { applyCardPatch } = require("../lib/card-apply");
  const { defaultCard } = require("../lib/workspace-store");
  const state = await loadState();
  const workspaceId = state.activeWorkspaceId;
  let card = payload && payload.card;
  if (!card && payload && payload.cardId) {
    const ws = await loadWorkspace(workspaceId);
    card = (ws.cards || []).find((entry) => entry.id === payload.cardId) || null;
  }
  if (!card) throw new Error("Card not found.");
  card = applyCardPatch(defaultCard(), card, { expandTemplate: false });
  const imageDataUris = await htmlCardDataUris(card, dataRoot(), workspaceId);
  return {
    html: buildCardDocument(card, { imageDataUris, transparent: payload && payload.transparent === true }),
  };
});

ipcMain.handle("export-card-png", async (event, payload) => {
  const { renderCardPng, findFfmpeg, findFont } = require("../lib/card-render");
  const { applyCardPatch } = require("../lib/card-apply");
  const { defaultCard } = require("../lib/workspace-store");
  const state = await loadState();
  const workspaceId = state.activeWorkspaceId;
  let card = payload && payload.card;
  if (!card && payload && payload.cardId) {
    const ws = await loadWorkspace(workspaceId);
    card = (ws.cards || []).find((entry) => entry.id === payload.cardId) || null;
  }
  if (!card) throw new Error("Card not found.");
  card = applyCardPatch(defaultCard(), card, { expandTemplate: false });
  const win = BrowserWindow.fromWebContents(event.sender);
  const options = {
    defaultPath: (card.name || "card") + ".png",
    filters: [{ name: "PNG image", extensions: ["png"] }],
  };
  const picked = win
    ? await dialog.showSaveDialog(win, options)
    : await dialog.showSaveDialog(options);
  if (picked.canceled || !picked.filePath) return { canceled: true };
  const rendered = await renderCardPng({
    dataRoot: dataRoot(),
    workspaceId,
    card,
    outPath: picked.filePath,
    ffmpeg: findFfmpeg(),
    font: findFont(),
  });
  return { canceled: false, path: rendered.path, width: rendered.width, height: rendered.height };
});

ipcMain.handle("compose-finished", async (_event, payload) => {
  const { composeFinished } = require("../lib/compose-finished");
  const state = await loadState();
  return composeFinished({
    dataRoot: dataRoot(),
    workspaceId: state.activeWorkspaceId,
    videoId: payload && payload.videoId,
    cardId: payload && payload.cardId,
    name: payload && payload.name,
    seconds: payload && payload.seconds,
    placement: payload && payload.placement,
    audioId: payload && payload.audioId,
    audioVolume: payload && payload.audioVolume,
    audioLoop: payload && payload.audioLoop,
    duck: payload && payload.duck,
  });
});

ipcMain.handle("elevenlabs-status", async () => {
  const { readConfig } = require("../lib/elevenlabs");
  const cfg = await readConfig(dataRoot());
  return {
    configured: Boolean(cfg.apiKey),
    source: cfg.source || "",
    keyTail: cfg.keyTail || "",
    voiceId: cfg.voiceId || "",
    voiceName: cfg.voiceName || "",
    model: cfg.model || "",
    agentAccess: cfg.agentAccess || "ask",
  };
});

ipcMain.handle("elevenlabs-set-voice", async (_event, payload) => {
  const { savePrefs } = require("../lib/elevenlabs");
  const body = payload || {};
  const cfg = await savePrefs(dataRoot(), { voiceId: body.voiceId, voiceName: body.voiceName });
  return { voiceId: cfg.voiceId, voiceName: cfg.voiceName };
});

ipcMain.handle("elevenlabs-set-access", async (_event, payload) => {
  const { savePrefs } = require("../lib/elevenlabs");
  const cfg = await savePrefs(dataRoot(), { agentAccess: payload && payload.mode });
  return { agentAccess: cfg.agentAccess };
});

ipcMain.handle("elevenlabs-history", async () => {
  const { listActions } = require("../lib/agent-activity");
  const actions = listActions(dataRoot(), {
    limit: 200,
    toolPrefix: "permission:",
  })
    .concat(
      listActions(dataRoot(), {
        limit: 200,
        tools: ["jeditor_tts", "jeditor_elevenlabs_setup", "jeditor_elevenlabs_voices", "jeditor_music"],
      }),
    )
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, 200);
  return {
    actions: actions.map((a) => ({
      id: a.id,
      at: a.at,
      tool: a.tool,
      client: a.client,
      harness: a.harness,
      projectId: a.projectId,
      ok: a.ok,
      summary: a.summary,
      text: a.args && a.args.text ? String(a.args.text).slice(0, 160) : "",
      voiceId: a.args && a.args.voiceId ? String(a.args.voiceId) : "",
    })),
  };
});

ipcMain.handle("elevenlabs-save", async (_event, payload) => {
  const { saveKey, checkKeyedProbe } = require("../lib/elevenlabs");
  // The setup page checks a new key with ElevenLabs first, so a key that is
  // turned down on every check is never saved over a working one.
  if (payload && payload.verify) await checkKeyedProbe(payload.apiKey);
  return saveKey(dataRoot(), payload && payload.apiKey);
});

ipcMain.handle("elevenlabs-clear", async () => {
  const { clearKey } = require("../lib/elevenlabs");
  return clearKey(dataRoot());
});

ipcMain.handle("elevenlabs-test", async () => {
  const { testKey } = require("../lib/elevenlabs");
  return testKey(dataRoot());
});

ipcMain.handle("elevenlabs-voices", async () => {
  const { listVoices } = require("../lib/elevenlabs");
  return listVoices(dataRoot());
});

ipcMain.handle("elevenlabs-voice-preview", async (_event, payload) => {
  const { voicePreview } = require("../lib/elevenlabs");
  return voicePreview(dataRoot(), payload && payload.url);
});

// Speak a short line with the saved voice so the setup page can play it.
// Nothing is saved to the library; the temp file is removed right away.
ipcMain.handle("elevenlabs-try", async (_event, payload) => {
  const { synthesize } = require("../lib/elevenlabs");
  const text = String((payload && payload.text) || "").trim().slice(0, 200);
  if (!text) throw new Error("Type a line to hear first.");
  const out = await synthesize(dataRoot(), { text, voiceId: payload && payload.voiceId });
  try {
    const bytes = await fs.readFile(out.path);
    return { dataBase64: bytes.toString("base64"), mime: "audio/mpeg", characters: text.length };
  } finally {
    fs.rm(out.path, { force: true }).catch(() => {});
  }
});

// ---------- plugins ----------

ipcMain.handle("plugins-list", async () => require("../lib/plugins").listPlugins(dataRoot()));
ipcMain.handle("plugins-read", async (_event, payload) => require("../lib/plugins").readPlugin(dataRoot(), payload && payload.id));
ipcMain.handle("plugins-set-enabled", async (_event, payload) => require("../lib/plugins").setEnabled(dataRoot(), payload && payload.id, Boolean(payload && payload.enabled)));
ipcMain.handle("plugins-remove", async (_event, payload) => require("../lib/plugins").removePlugin(dataRoot(), payload && payload.id));
ipcMain.handle("plugins-error", async (_event, payload) => require("../lib/plugins").recordError(dataRoot(), payload && payload.id, payload && payload.message));
ipcMain.handle("plugins-data-get", async (_event, payload) => require("../lib/plugins").readData(dataRoot(), payload && payload.id));
ipcMain.handle("plugins-data-set", async (_event, payload) => require("../lib/plugins").writeData(dataRoot(), payload && payload.id, payload && payload.value));
ipcMain.handle("plugins-open-folder", async (_event, payload) => {
  const { pluginsDir, ID_RE } = require("../lib/plugins");
  const id = payload && payload.id;
  const dir = id && ID_RE.test(String(id)) ? path.join(pluginsDir(dataRoot()), String(id)) : pluginsDir(dataRoot());
  await fs.mkdir(dir, { recursive: true });
  const err = await shell.openPath(dir);
  if (err) throw new Error(err);
  return { ok: true };
});

ipcMain.handle("elevenlabs-models", async () => {
  const { listModels } = require("../lib/elevenlabs");
  return listModels(dataRoot());
});

ipcMain.handle("elevenlabs-set-model", async (_event, payload) => {
  const { savePrefs } = require("../lib/elevenlabs");
  const cfg = await savePrefs(dataRoot(), { model: payload && payload.model });
  return { model: cfg.model };
});

ipcMain.handle("elevenlabs-tts", async (_event, payload) => {
  const { agentToolSpecs } = require("../lib/agent-tools");
  const spec = agentToolSpecs().find((tool) => tool.name === "jeditor_tts");
  if (!spec) throw new Error("The voiceover tool is unavailable.");
  return spec.run({ dataRoot: dataRoot(), appRoot: path.join(__dirname, "..") }, payload || {});
});

ipcMain.handle("elevenlabs-music", async (_event, payload) => {
  const { agentToolSpecs } = require("../lib/agent-tools");
  const spec = agentToolSpecs().find((tool) => tool.name === "jeditor_music");
  if (!spec) throw new Error("The music tool is unavailable.");
  return spec.run({ dataRoot: dataRoot(), appRoot: path.join(__dirname, "..") }, payload || {});
});

async function checkLibraryProtocol() {
  const state = await loadState();
  const ws = await loadWorkspace(state.activeWorkspaceId);
  const bytes = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
  const item = await writeBufferIntoLibrary(ws, {
    name: "Screen take protocol-check",
    mime: "video/webm;codecs=vp9,opus",
    buffer: bytes,
  });
  // A data folder an earlier smoke ran on already holds this clip; the
  // duplicate check skips the write, so test the copy that is there.
  const existing = item && item.skipped && item.existingId ? (ws.library || []).find((m) => m.id === item.existingId) : null;
  const media = existing || item;
  if (!media || media.skipped || !media.id) return { ok: false, error: "addBuffer" };
  if (!existing) await saveWorkspace(ws);
  const url = "cutline://library/" + ws.id + "/" + media.id;
  const res = await net.fetch(url);
  const body = Buffer.from(await res.arrayBuffer());
  const type = String(res.headers.get("content-type") || "").toLowerCase();
  const rangeRes = await net.fetch(url, { headers: { Range: "bytes=0-3" } });
  const rangeBody = Buffer.from(await rangeRes.arrayBuffer());
  const extOk = String(media.file || "").toLowerCase().endsWith(".webm");
  const ok =
    res.status === 200 &&
    type.includes("video/webm") &&
    body.equals(bytes) &&
    extOk &&
    rangeRes.status === 206 &&
    rangeBody.length === 4 &&
    rangeBody.equals(bytes.subarray(0, 4));
  return {
    ok,
    status: res.status,
    type,
    bytes: body.length,
    rangeStatus: rangeRes.status,
    rangeBytes: rangeBody.length,
  };
}

// Smoke: the embedded Draw view loaded, places on a stage rect exactly, and
// hides again. Embedded mode has no Home screen of its own.
async function drawProbe() {
  const wc = drawStudio && drawStudio.webContents();
  if (!wc || wc.isDestroyed()) return { ok: false, error: "no draw view" };
  for (let i = 0; i < 60 && wc.isLoading(); i++) await new Promise((r) => setTimeout(r, 250));
  const page = await wc.executeJavaScript("({ app: typeof window.App, title: document.title, home: !!document.querySelector('.home'), api: typeof window.jdraw, embedded: !!(window.App && window.App.embedded) })");
  const rect = { x: 68, y: 40, width: 640, height: 360 };
  const placed = drawStudio.place({ rect });
  const shown = drawStudio.viewState();
  drawStudio.hideView();
  const hidden = drawStudio.viewState();
  const boundsOk = shown && shown.bounds && ["x", "y", "width", "height"].every((k) => shown.bounds[k] === rect[k]);
  const ok = page.app === "object" && page.api === "object" && page.embedded === true && !page.home && placed && boundsOk && shown.visible === true && hidden.visible === false;
  return { ok, page, placed, shown, hidden };
}

async function runSmoke(win) {
  return require("./smoke.cjs").runJeditorSmoke(win, { app, checkLibraryProtocol, drawProbe, dataRoot });
}

ipcMain.handle("add-card-image", async (_event, payload) => {
  const state = await loadState();
  const ws = await loadWorkspace(state.activeWorkspaceId);
  await copyIntoLibrary(ws, payload.path, {
    name: payload.name || path.basename(payload.path),
    mime: payload.mime,
  });
  await saveWorkspace(ws);
  return snapshot();
});
