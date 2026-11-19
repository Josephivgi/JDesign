"use strict";

// JV-only IPC: app preferences, the about box, the data folder, and the
// one-time import of a Cutline Desktop library. Preferences live in
// jeditor-prefs.json under the data root so the main process and every window
// read the same copy; the renderer never keeps them in browser storage.

const { app, ipcMain, shell } = require("electron");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const PREF_DEFAULTS = Object.freeze({
  theme: "system", // system | light | dark
  accent: "mono", // mono | iris | blue | teal | green | amber | rose
  density: "comfortable", // comfortable | compact
  chatTextSize: "md", // sm | md | lg
  sendKey: "enter", // enter | ctrl-enter
  defaultAgent: "",
  autoConnect: true,
  showToolDetails: false,
  showThinking: false,
  chatWidth: 420,
  mediaRailOpen: true,
  editorTipsSeen: false,
  speakReplies: false, // read agent replies aloud; off by default
  replyVoice: "windows", // windows | elevenlabs
  windowsVoice: "", // a Windows voice name, empty = the system default
  micEngine: "auto", // auto | windows | elevenlabs
  micAutoSend: false, // send the message as soon as the words come back
});

const ENUMS = {
  theme: ["system", "light", "dark"],
  accent: ["mono", "iris", "blue", "teal", "green", "amber", "rose"],
  density: ["comfortable", "compact"],
  chatTextSize: ["sm", "md", "lg"],
  sendKey: ["enter", "ctrl-enter"],
  replyVoice: ["windows", "elevenlabs"],
  micEngine: ["auto", "windows", "elevenlabs"],
};

function prefsFile(dataRoot) {
  return path.join(dataRoot, "jeditor-prefs.json");
}

function cleanPrefs(input) {
  const src = input && typeof input === "object" ? input : {};
  const out = {};
  for (const [key, fallback] of Object.entries(PREF_DEFAULTS)) {
    if (!(key in src)) continue;
    const value = src[key];
    if (ENUMS[key]) {
      if (ENUMS[key].includes(value)) out[key] = value;
    } else if (typeof fallback === "boolean") {
      out[key] = Boolean(value);
    } else if (typeof fallback === "number") {
      const n = Number(value);
      if (Number.isFinite(n)) out[key] = Math.round(Math.min(760, Math.max(320, n)));
    } else {
      out[key] = String(value == null ? "" : value).slice(0, 120);
    }
  }
  return out;
}

function readPrefs(dataRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(prefsFile(dataRoot), "utf8"));
    return Object.assign({}, PREF_DEFAULTS, cleanPrefs(raw));
  } catch {
    return Object.assign({}, PREF_DEFAULTS);
  }
}

function writePrefs(dataRoot, patch) {
  const next = Object.assign(readPrefs(dataRoot), cleanPrefs(patch));
  fs.mkdirSync(dataRoot, { recursive: true });
  const file = prefsFile(dataRoot);
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, file);
  return next;
}

function cutlineDataRoot() {
  const base = process.env.APPDATA || path.join(app.getPath("home"), "AppData", "Roaming");
  return path.join(base, "Cutline", "data");
}

// Files that belong to one running install and must not be copied over.
const IMPORT_SKIP = new Set(["agent-bridge.json", "cutline-mcp.cjs", "jeditor-mcp.cjs", "logs", "jeditor-prefs.json", "inflight-takes"]);

async function dirBytes(dir) {
  let total = 0;
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirBytes(full);
    else {
      try {
        total += (await fsp.stat(full)).size;
      } catch {
        /* vanished */
      }
    }
  }
  return total;
}

// JV has nothing worth keeping yet when it has no projects, no media,
// and no chats. Only then may an import write into the data root.
// Counts real rows and fails closed: anything it cannot read counts as data,
// so an import can never replace a project or chat the user already has.
function jeditorIsEmpty(dataRoot) {
  const statePath = path.join(dataRoot, "state.json");
  if (fs.existsSync(statePath)) {
    try {
      const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      for (const ws of state.workspaces || []) {
        const file = path.join(dataRoot, "workspaces", ws.id, "workspace.json");
        if (!fs.existsSync(file)) continue;
        const doc = JSON.parse(fs.readFileSync(file, "utf8"));
        if ((doc.library || []).length || (doc.finished || []).length) return false;
      }
    } catch {
      return false;
    }
  }
  const tables = { "ai-video-projects.db": ["ai_video_projects"], "editor-chats.db": ["editor_chats", "editor_chat_messages"] };
  for (const [file, names] of Object.entries(tables)) {
    const full = path.join(dataRoot, file);
    if (!fs.existsSync(full)) continue;
    let db = null;
    try {
      const { DatabaseSync } = require("node:sqlite");
      db = new DatabaseSync(full, { readOnly: true });
      for (const name of names) {
        const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
        if (exists && db.prepare("SELECT 1 FROM " + name + " LIMIT 1").get()) return false;
      }
    } catch {
      return false;
    } finally {
      try {
        if (db) db.close();
      } catch {
        /* closing is best effort */
      }
    }
  }
  return true;
}

function attachJeditorIpc(host) {
  const dataRoot = host.dataRoot;
  let importing = false;

  ipcMain.handle("jeditor-prefs-get", () => readPrefs(dataRoot()));
  ipcMain.handle("jeditor-prefs-set", (_event, patch) => writePrefs(dataRoot(), patch));
  // Voice: the chat mic (speech to text) and replies read aloud.
  ipcMain.handle("voice-transcribe", async (_event, payload) => {
    const p = payload || {};
    const bytes = p.bytes instanceof Uint8Array ? Buffer.from(p.bytes) : Buffer.alloc(0);
    return require("../lib/speech-to-text").transcribe(dataRoot(), { bytes, mime: String(p.mime || ""), engine: readPrefs(dataRoot()).micEngine });
  });
  ipcMain.handle("voice-speak", async (_event, payload) => {
    const prefs = readPrefs(dataRoot());
    const p = payload || {};
    return require("../lib/speak-text").speakReply(dataRoot(), {
      text: String(p.text || ""),
      engine: p.engine || prefs.replyVoice,
      voice: p.voice != null ? String(p.voice) : prefs.windowsVoice,
    });
  });
  ipcMain.handle("voice-windows-voices", async () => require("../lib/speak-text").listWindowsVoices());
  ipcMain.handle("jeditor-about", () => ({
    name: "JV",
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    dataRoot: dataRoot(),
    platform: process.platform,
  }));
  ipcMain.handle("jeditor-open-data-folder", async () => {
    const error = await shell.openPath(dataRoot());
    if (error) throw new Error(error);
    return { ok: true };
  });

  ipcMain.handle("jeditor-cutline-import-status", async () => {
    const src = cutlineDataRoot();
    const exists = fs.existsSync(path.join(src, "state.json"));
    return {
      exists,
      source: src,
      bytes: exists ? await dirBytes(src) : 0,
      canImport: exists && jeditorIsEmpty(dataRoot()),
      importing,
    };
  });

  // Copies, never moves: Cutline Desktop keeps working on its own copy.
  ipcMain.handle("jeditor-cutline-import", async (event) => {
    if (importing) throw new Error("An import is already running.");
    const src = cutlineDataRoot();
    const dest = dataRoot();
    if (!fs.existsSync(path.join(src, "state.json"))) throw new Error("No Cutline Desktop library was found on this computer.");
    if (!jeditorIsEmpty(dest)) throw new Error("JV already has projects or media. Import only works into an empty JV.");
    importing = true;
    try {
      const total = await dirBytes(src);
      let done = 0;
      let lastSent = 0;
      const send = (force) => {
        const now = Date.now();
        if (!force && now - lastSent < 200) return;
        lastSent = now;
        if (!event.sender.isDestroyed()) event.sender.send("jeditor-import-progress", { done, total });
      };
      const isDbFamily = (name) => /\.db(-wal|-shm)?$/i.test(name);
      const copyOne = async (a, b) => {
        await fsp.copyFile(a, b);
        try {
          done += (await fsp.stat(a)).size;
        } catch {
          /* counted as zero */
        }
        send(false);
      };
      // The files that say what JV holds (state, each workspace's list,
      // the databases) are written last, after a second emptiness check.
      const deferred = [];
      const copyDir = async (from, to, top) => {
        await fsp.mkdir(to, { recursive: true });
        for (const entry of await fsp.readdir(from, { withFileTypes: true })) {
          if (top && (IMPORT_SKIP.has(entry.name) || isDbFamily(entry.name))) continue;
          const a = path.join(from, entry.name);
          const b = path.join(to, entry.name);
          if (entry.isDirectory()) await copyDir(a, b, false);
          else if (entry.isFile() && (entry.name === "workspace.json" || (top && entry.name === "state.json"))) deferred.push([a, b]);
          else if (entry.isFile()) await copyOne(a, b);
        }
      };
      // Media first: the long part, with JV still usable.
      await copyDir(src, dest, true);
      // Everything that says what JV holds (state, workspace lists, the
      // databases) is copied in under a temporary name first.
      const STAGE = ".jeditor-import";
      const staged = [];
      let dbNames = [];
      // Removes only this import's own temporary copies; the real files are
      // never touched before the swap.
      const dropStaged = () => {
        for (const [stagedPath] of staged) {
          try {
            fs.rmSync(stagedPath, { force: true });
          } catch {
            /* a leftover temporary copy is harmless */
          }
        }
      };
      // Each path is recorded before its copy starts, so a copy that fails
      // halfway (disk full) is cleaned up too.
      const stageOne = async (a, b) => {
        staged.push([b + STAGE, b]);
        await copyOne(a, b + STAGE);
      };
      try {
        for (const [a, b] of deferred) await stageOne(a, b);
        dbNames = (await fsp.readdir(src)).filter((name) => /\.db$/i.test(name));
        for (const name of dbNames) {
          for (const suffix of ["", "-wal", "-shm"]) {
            const a = path.join(src, name + suffix);
            if (!fs.existsSync(a)) continue;
            await stageOne(a, path.join(dest, name + suffix));
          }
        }
        // Commit. The stores close, then the emptiness check and the swap run
        // with no await between them: no other request can add a project or
        // clip after the check, so the import can never replace new work.
        if (typeof host.closeStores === "function") await host.closeStores();
      } catch (error) {
        dropStaged();
        throw error;
      }
      if (!jeditorIsEmpty(dest)) {
        dropStaged();
        throw new Error("Something was added to JV while the import ran, so the import stopped before replacing anything. Your new work is kept. The copied Cutline media stays in the JV data folder.");
      }
      // JV's own -wal/-shm files go first: a stale write-ahead log from
      // the empty store would otherwise replay onto the imported database.
      for (const name of dbNames) {
        for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(path.join(dest, name + suffix), { force: true });
      }
      for (const [stagedPath, finalPath] of staged) fs.renameSync(stagedPath, finalPath);
      send(true);
      return { ok: true, bytes: done };
    } finally {
      importing = false;
    }
  });

  ipcMain.handle("jeditor-relaunch", () => {
    app.relaunch();
    app.exit(0);
  });
}

module.exports = { attachJeditorIpc, readPrefs, writePrefs, cleanPrefs, PREF_DEFAULTS, jeditorIsEmpty };
