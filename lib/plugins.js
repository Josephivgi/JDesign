"use strict";

// Plugins extend the JV window. Each one is a folder under <data>/plugins
// with plugin.json (name, description) and plugin.js (an ES module that
// exports activate(jv)). Agents write them with the jeditor_plugin_* tools;
// the person turns them on in Settings > Plugins.
//
// The safety rule: a plugin runs only when the person turned it on AND its
// code still matches the code they turned on (approvedHash). An agent that
// changes an approved plugin turns it back into "changed", and it stays off
// until the person looks at it again. The jvplugin: protocol serves code
// through pluginCodeIfApproved, so nothing else can load unapproved code.

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
const MAX_CODE_BYTES = 256 * 1024;
const MAX_DATA_BYTES = 1024 * 1024;
const MAX_ERRORS = 20;

function pluginsDir(dataRoot) {
  return path.join(dataRoot, "plugins");
}

function statePath(dataRoot) {
  return path.join(pluginsDir(dataRoot), "plugins-state.json");
}

function checkId(id) {
  const value = String(id || "").trim();
  if (!ID_RE.test(value)) throw new Error("Plugin id must be 2 to 40 characters: lowercase letters, digits and dashes, starting with a letter or digit.");
  return value;
}

function hashCode(code) {
  return crypto.createHash("sha256").update(String(code), "utf8").digest("hex").slice(0, 24);
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + "." + process.pid + "." + Date.now() + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2));
  await fsp.rename(tmp, file);
}

async function readState(dataRoot) {
  const state = await readJson(statePath(dataRoot), {});
  return state && typeof state === "object" ? state : {};
}

// One writer at a time, so a toggle and an error report never drop each other.
let stateQueue = Promise.resolve();
function updateState(dataRoot, change) {
  const run = stateQueue.then(async () => {
    const state = await readState(dataRoot);
    const out = (await change(state)) || state;
    await writeJson(statePath(dataRoot), out);
    return out;
  });
  stateQueue = run.catch(() => {});
  return run;
}

async function readPluginFiles(dataRoot, id) {
  const dir = path.join(pluginsDir(dataRoot), id);
  const meta = await readJson(path.join(dir, "plugin.json"), null);
  let code = null;
  try {
    code = await fsp.readFile(path.join(dir, "plugin.js"), "utf8");
  } catch {
    code = null;
  }
  return { dir, meta, code };
}

function statusOf(entry, hash) {
  if (!entry || !entry.enabled) return entry && entry.approvedHash && entry.approvedHash !== hash ? "changed" : "off";
  return entry.approvedHash === hash ? "on" : "changed";
}

function summary(id, meta, code, entry) {
  const hash = code == null ? "" : hashCode(code);
  return {
    id,
    name: String((meta && meta.name) || id),
    description: String((meta && meta.description) || ""),
    version: String((meta && meta.version) || "1"),
    author: String((meta && meta.author) || ""),
    createdAt: (meta && meta.createdAt) || "",
    updatedAt: (meta && meta.updatedAt) || "",
    hash,
    size: code == null ? 0 : Buffer.byteLength(code, "utf8"),
    status: code == null ? "broken" : statusOf(entry, hash),
    enabled: Boolean(entry && entry.enabled),
    errors: Array.isArray(entry && entry.errors) ? entry.errors.slice(-MAX_ERRORS) : [],
  };
}

async function listPlugins(dataRoot) {
  const dir = pluginsDir(dataRoot);
  let names = [];
  try {
    names = (await fsp.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory() && ID_RE.test(e.name)).map((e) => e.name);
  } catch {
    return [];
  }
  const state = await readState(dataRoot);
  const out = [];
  for (const id of names.sort()) {
    const { meta, code } = await readPluginFiles(dataRoot, id);
    if (!meta && code == null) continue;
    out.push(summary(id, meta, code, state[id]));
  }
  return out;
}

async function readPlugin(dataRoot, id) {
  const safe = checkId(id);
  const { meta, code } = await readPluginFiles(dataRoot, safe);
  if (!meta && code == null) throw new Error("No plugin named " + safe + ".");
  const state = await readState(dataRoot);
  return Object.assign(summary(safe, meta, code, state[safe]), { code: code || "" });
}

// Syntax check with the real JS parser: Electron runs as Node for one
// --check pass over the module source. Returns "" when it parses.
function syntaxError(code) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, ["--check", "--input-type=module"], {
        env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: "1" }),
        windowsHide: true,
        stdio: ["pipe", "ignore", "pipe"],
      });
    } catch {
      resolve("");
      return;
    }
    let err = "";
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolve("");
    }, 15000);
    child.stderr.on("data", (d) => {
      err += d.toString("utf8");
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve("");
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      if (!status) return resolve("");
      // Keep the useful lines: the location and the SyntaxError message.
      const lines = err.split(/\r?\n/).filter((l) => l.trim() && !/^\s+at |^Node\.js v/.test(l));
      resolve(lines.join("\n").replace(/\[stdin\]/g, "plugin.js").slice(0, 1200) || "plugin.js does not parse.");
    });
    child.stdin.end(code);
  });
}

async function writePlugin(dataRoot, input) {
  const id = checkId(input && input.id);
  const code = String((input && input.code) || "");
  if (!code.trim()) throw new Error("code is required: an ES module that exports activate(jv).");
  if (Buffer.byteLength(code, "utf8") > MAX_CODE_BYTES) throw new Error("code is too long (max " + MAX_CODE_BYTES / 1024 + " KB).");
  if (!/export\s+(default\s+)?(async\s+)?function\s*(activate)?\s*\(|export\s*\{[^}]*\bactivate\b|export\s+const\s+activate\b|export\s+default\b/.test(code)) {
    throw new Error("plugin.js must export activate(jv): `export function activate(jv) { ... }`.");
  }
  const problem = await syntaxError(code);
  if (problem) throw new Error("plugin.js has a syntax error, nothing was saved:\n" + problem);
  const dir = path.join(pluginsDir(dataRoot), id);
  const old = await readPluginFiles(dataRoot, id);
  const now = new Date().toISOString();
  const name = String((input && input.name) || (old.meta && old.meta.name) || id).trim().slice(0, 60);
  const description = String((input && input.description) || (old.meta && old.meta.description) || "").trim().slice(0, 300);
  const meta = {
    id,
    name,
    description,
    version: String(Number((old.meta && old.meta.version) || 0) + 1),
    author: String((input && input.author) || (old.meta && old.meta.author) || "").slice(0, 60),
    createdAt: (old.meta && old.meta.createdAt) || now,
    updatedAt: now,
  };
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, "plugin.js"), code);
  await writeJson(path.join(dir, "plugin.json"), meta);
  // A rewrite starts with a clean error list; old errors were for old code.
  const state = await updateState(dataRoot, (s) => {
    if (s[id]) s[id].errors = [];
    return s;
  });
  const out = summary(id, meta, code, state[id]);
  return Object.assign(out, { created: !old.meta });
}

async function setEnabled(dataRoot, id, enabled) {
  const safe = checkId(id);
  const { meta, code } = await readPluginFiles(dataRoot, safe);
  if (code == null) throw new Error("No plugin named " + safe + ".");
  const hash = hashCode(code);
  const state = await updateState(dataRoot, (s) => {
    const entry = s[safe] || {};
    entry.enabled = Boolean(enabled);
    // Turning a plugin on is the approval of the code as it is right now.
    if (enabled) {
      entry.approvedHash = hash;
      entry.errors = [];
    }
    s[safe] = entry;
    return s;
  });
  return summary(safe, meta, code, state[safe]);
}

async function removePlugin(dataRoot, id) {
  const safe = checkId(id);
  await fsp.rm(path.join(pluginsDir(dataRoot), safe), { recursive: true, force: true });
  await updateState(dataRoot, (s) => {
    delete s[safe];
    return s;
  });
  return { ok: true };
}

async function recordError(dataRoot, id, message) {
  const safe = checkId(id);
  const text = String(message || "").slice(0, 2000);
  if (!text) return { ok: false };
  await updateState(dataRoot, (s) => {
    const entry = s[safe] || {};
    const errors = Array.isArray(entry.errors) ? entry.errors : [];
    // The same error twice in a row only bumps its count.
    const last = errors[errors.length - 1];
    if (last && last.message === text) {
      last.count = (last.count || 1) + 1;
      last.at = new Date().toISOString();
    } else {
      errors.push({ at: new Date().toISOString(), message: text, count: 1 });
    }
    entry.errors = errors.slice(-MAX_ERRORS);
    s[safe] = entry;
    return s;
  });
  return { ok: true };
}

// The code the window may run: only an enabled plugin whose code still
// matches the approved hash, and only when the caller asks for that hash.
async function pluginCodeIfApproved(dataRoot, id, hash) {
  if (!ID_RE.test(String(id || ""))) return null;
  const { code } = await readPluginFiles(dataRoot, id);
  if (code == null) return null;
  const current = hashCode(code);
  const state = await readState(dataRoot);
  const entry = state[id];
  if (!entry || !entry.enabled || entry.approvedHash !== current) return null;
  if (hash && hash !== current) return null;
  return code;
}

function dataFile(dataRoot, id) {
  return path.join(pluginsDir(dataRoot), checkId(id), "data.json");
}

async function readData(dataRoot, id) {
  return readJson(dataFile(dataRoot, id), {});
}

async function writeData(dataRoot, id, value) {
  const text = JSON.stringify(value == null ? {} : value);
  if (Buffer.byteLength(text, "utf8") > MAX_DATA_BYTES) throw new Error("Plugin data is limited to 1 MB.");
  await writeJson(dataFile(dataRoot, id), JSON.parse(text));
  return { ok: true };
}

module.exports = {
  ID_RE,
  MAX_CODE_BYTES,
  pluginsDir,
  hashCode,
  listPlugins,
  readPlugin,
  writePlugin,
  setEnabled,
  removePlugin,
  recordError,
  pluginCodeIfApproved,
  readData,
  writeData,
  syntaxError,
};
