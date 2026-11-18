"use strict";

// The ACP marketplace: extra agents a user adds on top of the shipped picks
// (Cursor, Devin, Codex, Claude Code in acp-harnesses.js). Catalog entries
// resolve from common install spots just like the shipped ones; custom
// entries are user-typed commands kept in SQLite (acp-agents.db) in the data
// root. Everything added here flows into the chat picker through
// listAcpHarnesses, and spawns through acpSpawnSpec like a built-in agent.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { resolveProgram, isFile } = require("./win-command");

function localAppData() {
  return process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
}

function versionKey(name) {
  const digits = String(name).match(/\d+/g) || [];
  return digits.slice(0, 6).map((d) => d.padStart(4, "0")).join("");
}

// The Cursor CLI ships a node.exe and index.js per version; its .ps1 shim picks
// the newest folder. Doing the same here avoids spawning PowerShell.
function cursorAgentSpec() {
  const root = path.join(localAppData(), "cursor-agent", "versions");
  try {
    const versions = fs
      .readdirSync(root)
      .filter((name) => fs.existsSync(path.join(root, name, "node.exe")) && fs.existsSync(path.join(root, name, "index.js")))
      .sort((a, b) => (versionKey(a) < versionKey(b) ? 1 : -1));
    if (versions.length) {
      const dir = path.join(root, versions[0]);
      return { command: path.join(dir, "node.exe"), args: [path.join(dir, "index.js"), "acp"], env: { CURSOR_INVOKED_AS: "cursor-agent" } };
    }
  } catch {
    /* fall through to PATH */
  }
  const onPath = resolveProgram("cursor-agent");
  if (onPath && onPath !== "cursor-agent") return { command: onPath, args: ["acp"], env: {} };
  return null;
}

// OpenAI Codex through the codex-acp adapter (stdio ACP server that wraps the
// Codex app server). The npm package bundles a compatible Codex binary, so a
// global install is all that is needed.
function codexSpec() {
  const command = findProgram("codex-acp", [path.join(os.homedir(), ".cargo", "bin")]);
  return command ? { command, args: [], env: {} } : null;
}

// Claude Code through its ACP adapter. The current package installs
// claude-agent-acp; the older Zed package installed claude-code-acp and the
// community one cc-acp.
// Claude Code gives up on a JV tool call after its own short default, while
// a render keeps going and lands anyway; the agent then retries and the
// project gets the clip twice. Renders can run for minutes, so allow 30.
const CLAUDE_TOOL_TIMEOUT_MS = "1800000";

function claudeCodeSpec() {
  const command = findProgram(["claude-agent-acp", "claude-code-acp", "cc-acp"]);
  return command ? { command, args: [], env: { MCP_TOOL_TIMEOUT: process.env.MCP_TOOL_TIMEOUT || CLAUDE_TOOL_TIMEOUT_MS } } : null;
}

let DatabaseSync = null;
function dbSyncCtor() {
  if (!DatabaseSync) ({ DatabaseSync } = require("node:sqlite"));
  return DatabaseSync;
}

const BUSY_MS = 5000;
const NAME_MAX = 60;
const COMMAND_MAX = 500;
const ARGS_MAX = 4000;
const CUSTOM_MAX = 40;

function npmGlobalDir() {
  if (process.platform === "win32") return process.env.APPDATA ? path.join(process.env.APPDATA, "npm") : "";
  return "/usr/local/bin";
}

// A program that may be an npm global (.cmd shim on Windows), a PATH hit, or a
// binary in a well-known spot. spawnArgv already unwraps npm shims, so the
// returned path can go straight to spawnHidden.
const RESOLVE_CACHE_MS = 15000;
const resolveCache = new Map();

function findProgram(names, extraDirs) {
  const cacheKey = JSON.stringify([names, extraDirs]);
  const hit = resolveCache.get(cacheKey);
  // Every picker refresh resolves every agent on the main process; a dead
  // PATH share would stall each one serially, so memoize briefly.
  if (hit && hit.at > Date.now() - RESOLVE_CACHE_MS) return hit.value;
  const value = findProgramUncached(names, extraDirs);
  resolveCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

function findProgramUncached(names, extraDirs) {
  const list = Array.isArray(names) ? names : [names];
  const dirs = [npmGlobalDir()].concat(Array.isArray(extraDirs) ? extraDirs : []);
  for (const name of list) {
    const raw = String(name || "").trim().replace(/^"+|"+$/g, "");
    if (!raw) continue;
    // An absolute path resolves to itself, so the onPath !== raw check could
    // never find it; check the file directly instead. A missing file should
    // not stop a names list from trying its fallback entries.
    if (path.isAbsolute(raw)) {
      if (/\.ps1$/i.test(raw)) return null;
      if (isFile(raw)) return raw;
      continue;
    }
    const onPath = resolveProgram(raw);
    if (onPath && onPath !== raw) return onPath;
    for (const dir of dirs.filter(Boolean)) {
      for (const candidate of process.platform === "win32" ? [raw + ".cmd", raw + ".exe", raw] : [raw]) {
        const file = path.join(dir, candidate);
        if (isFile(file) && !/\.ps1$/i.test(file)) return file;
      }
    }
  }
  return null;
}

function programSpec(names, args, extraDirs) {
  const command = findProgram(names, extraDirs);
  return command ? { command, args: Array.isArray(args) ? args.slice() : [], env: {} } : null;
}

// Catalog agents are opt-in extras: they show on the MCP setup marketplace and
// join the chat picker once added. Keep ids away from the shipped harness ids
// in acp-harnesses.js (Devin, the local agent) and the native ids in
// harness-registry.js. Cursor, Codex, and Claude Code live here too: only
// Devin and the built-in agent ship enabled.
const MARKETPLACE_CATALOG = [
  {
    id: "cursor",
    name: "Cursor",
    description: "Cursor's AI agent. Sign in once with cursor-agent login.",
    commandLabel: "cursor-agent acp",
    resolve: () => cursorAgentSpec(),
    install: "Install the Cursor CLI, then run cursor-agent login.",
  },
  {
    id: "codex",
    name: "Codex",
    description: "OpenAI's Codex agent. Sign in once with codex.",
    commandLabel: "codex-acp",
    resolve: () => codexSpec(),
    install: "Install the adapter: npm install -g @agentclientprotocol/codex-acp, then sign in with codex.",
  },
  {
    id: "claude-code",
    name: "Claude Code",
    description: "Anthropic's Claude, a strong all round editor.",
    commandLabel: "claude-agent-acp",
    resolve: () => claudeCodeSpec(),
    install: "Install the adapter: npm install -g @agentclientprotocol/claude-agent-acp, then sign in with claude.",
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    description: "Google's Gemini agent.",
    commandLabel: "gemini --acp",
    resolve: () => programSpec("gemini", ["--acp"]),
    install: "Install or update the Gemini CLI, then sign in with gemini.",
  },
  {
    id: "opencode",
    name: "OpenCode",
    description: "OpenCode, works with many AI models.",
    commandLabel: "opencode acp",
    resolve: () => programSpec("opencode", ["acp"]),
    install: "Install OpenCode, then run opencode once to sign in.",
  },
  {
    id: "kimi",
    name: "Kimi CLI",
    description: "Moonshot's Kimi agent.",
    commandLabel: "kimi acp",
    resolve: () => programSpec("kimi", ["acp"]),
    install: "Install the Kimi CLI, then sign in with kimi.",
  },
  {
    id: "copilot",
    name: "GitHub Copilot CLI",
    description: "GitHub Copilot's agent.",
    commandLabel: "copilot --acp --stdio",
    resolve: () => programSpec("copilot", ["--acp", "--stdio"]),
    install: "Install the Copilot CLI, then sign in with copilot.",
  },
  {
    id: "junie",
    name: "Junie",
    description: "JetBrains' Junie agent.",
    commandLabel: "junie --acp true",
    resolve: () => programSpec("junie", ["--acp", "true"]),
    install: "Install Junie, then sign in once.",
  },
];

function catalogEntry(id) {
  return MARKETPLACE_CATALOG.find((item) => item.id === id) || null;
}

// Catalog ids must never collide with shipped ACP harness ids or the native
// registry ids; a collision would share session slots in acp-host.
const RESERVED_IDS = new Set(["devin", "editorpi", "news", "recorder"]);
for (const item of MARKETPLACE_CATALOG) {
  if (RESERVED_IDS.has(item.id)) throw new Error("Marketplace catalog id collides with a built-in agent: " + item.id);
}

function dbPath(dataRoot) {
  if (!dataRoot || !String(dataRoot).trim()) throw new Error("dataRoot is required");
  return path.join(String(dataRoot), "acp-agents.db");
}

function openDb(dataRoot) {
  const file = dbPath(dataRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new (dbSyncCtor())(file, { timeout: BUSY_MS });
  try {
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA busy_timeout=" + BUSY_MS);
  } catch {
    /* non-fatal: the timeout option still bounds locks */
  }
  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS acp_agents (" +
        "id TEXT PRIMARY KEY," +
        "kind TEXT NOT NULL," +
        "name TEXT NOT NULL," +
        "command TEXT NOT NULL DEFAULT ''," +
        "args_json TEXT NOT NULL DEFAULT '[]'," +
        "env_json TEXT NOT NULL DEFAULT '{}'," +
        "created_at TEXT NOT NULL" +
        ")"
    );
    const cols = db.prepare("PRAGMA table_info(acp_agents)").all().map((c) => c.name);
    if (!cols.includes("meta_json")) db.exec("ALTER TABLE acp_agents ADD COLUMN meta_json TEXT NOT NULL DEFAULT '{}'");
  } catch (error) {
    try {
      db.close();
    } catch {
      /* half-open handle */
    }
    throw error;
  }
  return db;
}

// The picker resolves extra harnesses on every refresh and spawn, so the
// connection is opened once per database file and reused.
const dbs = new Map();

function openDbSafe(dataRoot) {
  const key = path.resolve(dbPath(dataRoot));
  let db = dbs.get(key);
  if (!db) dbs.set(key, (db = openDbFresh(dataRoot)));
  return db;
}

// For app quit and tests that delete their data root (Windows keeps the file
// locked while a handle is open).
function closeAcpAgentDbs() {
  for (const db of dbs.values()) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
  dbs.clear();
}

// A corrupt store hides every saved agent and blocks repairs; move the file
// aside once (never delete) and rebuild. Only corruption-looking errors
// quarantine: a healthy-but-unwritable db must not be parked as corrupt.
function openDbFresh(dataRoot) {
  try {
    return openDb(dataRoot);
  } catch (error) {
    if (!/corrupt|malform|not a database|disk image|isdir/i.test(String((error && error.message) || ""))) throw error;
    const stamp = ".corrupt-" + Date.now();
    try {
      // Rename the journal sidecars too: a hot journal left beside the new
      // empty db can replay over it on next open.
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        try {
          fs.renameSync(dbPath(dataRoot) + suffix, dbPath(dataRoot) + suffix + stamp);
        } catch (renameError) {
          if (suffix === "") throw renameError;
        }
      }
    } catch {
      /* could not quarantine; surface the original failure */
      throw error;
    }
    return openDb(dataRoot);
  }
}

function readRows(dataRoot) {
  return openDbSafe(dataRoot).prepare("SELECT * FROM acp_agents ORDER BY created_at").all();
}

function parseArgs(raw) {
  try {
    const list = JSON.parse(raw || "[]");
    return Array.isArray(list) ? list.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

function parseEnv(raw) {
  try {
    const env = JSON.parse(raw || "{}");
    return env && typeof env === "object" && !Array.isArray(env) ? env : {};
  } catch {
    return {};
  }
}

function rowsByKind(dataRoot) {
  const rows = readRows(dataRoot);
  const catalog = new Set();
  const custom = [];
  const registry = [];
  for (const row of rows) {
    if (row.kind === "catalog" && catalogEntry(row.id)) catalog.add(row.id);
    else if (row.kind === "registry" && row.id && row.command) {
      registry.push({
        id: String(row.id),
        name: String(row.name || row.id),
        command: String(row.command),
        args: parseArgs(row.args_json),
        env: parseEnv(row.env_json),
        meta: parseEnv(row.meta_json),
      });
    }
    else if (row.kind === "custom" && row.id && row.command) {
      custom.push({
        id: String(row.id),
        name: String(row.name || row.id),
        command: String(row.command),
        args: parseArgs(row.args_json),
        env: parseEnv(row.env_json),
      });
    }
  }
  return { catalog, custom, registry };
}

// What the MCP setup page draws: every catalog agent with add state, plus the
// user's custom agents.
function marketplaceList(options) {
  const opts = options || {};
  const dataRoot = opts.dataRoot;
  let grouped = { catalog: new Set(), custom: [] };
  try {
    grouped = dataRoot ? rowsByKind(dataRoot) : grouped;
  } catch {
    /* a broken store should not take the whole page down */
  }
  const { catalog, custom } = grouped;
  return {
    catalog: MARKETPLACE_CATALOG.map((item) => {
      const spec = item.resolve();
      return {
        id: item.id,
        name: item.name,
        description: item.description,
        commandLabel: item.commandLabel,
        available: Boolean(spec),
        added: catalog.has(item.id),
        install: spec ? "" : item.install,
      };
    }),
    custom: custom.map((item) => ({
      id: item.id,
      name: item.name,
      commandLabel: item.command + (item.args.length ? " " + item.args.join(" ") : ""),
      added: true,
      available: Boolean(findProgram(item.command)),
    })),
  };
}

function addCatalogAgent(dataRoot, catalogId) {
  const entry = catalogEntry(String(catalogId || ""));
  if (!entry) throw new Error("Unknown marketplace agent: " + catalogId);
  openDbSafe(dataRoot).prepare("INSERT OR IGNORE INTO acp_agents (id, kind, name, command, args_json, env_json, created_at) VALUES (?, 'catalog', ?, '', '[]', '{}', ?)").run(
    entry.id,
    entry.name,
    new Date().toISOString(),
  );
  return entry;
}

// Splits an args field on whitespace, honoring double and single quotes.
function splitArgs(text) {
  const out = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = pattern.exec(String(text || "")))) out.push(match[1] != null ? match[1] : match[2] != null ? match[2] : match[3]);
  return out;
}

function addCustomAgent(dataRoot, body) {
  const input = body && typeof body === "object" ? body : {};
  const name = String(input.name || "").trim();
  const command = String(input.command || "").trim().replace(/^"+|"+$/g, "");
  const args = Array.isArray(input.args) ? input.args.map((item) => String(item)) : splitArgs(input.args);
  if (!name || name.length > NAME_MAX) throw new Error("Name the agent (60 characters or fewer).");
  // A bare word resolves through PATH; a spaced command must be a full path
  // (for example a binary under Program Files).
  if (!command || command.length > COMMAND_MAX || (/\s/.test(command) && !path.isAbsolute(command))) {
    throw new Error("Give the agent command: one program name or a full path. Paths with spaces need no quotes.");
  }
  if (/\.ps1$/i.test(command)) throw new Error("PowerShell scripts cannot run as ACP agents; wrap the call in a .cmd or .exe.");
  // Scripts that cannot spawn without an interpreter fail at start with a
  // cryptic error; reject them up front. (.bat/.cmd do spawn through cmd.)
  const nogoExt = process.platform === "win32" ? /\.(vbs|wsf|hta|py|sh|js)$/i : /\.(vbs|wsf|hta)$/i;
  if (nogoExt.test(command)) throw new Error("That kind of file cannot run as an ACP agent; use an .exe, .cmd, or a bare command name.");
  if (JSON.stringify(args).length > ARGS_MAX) throw new Error("The argument list is too long.");
  if (args.some((arg) => arg == null)) throw new Error("Arguments must be text.");
  // When a .cmd agent runs through cmd.exe, metacharacters in an arg become
  // operators: & | < > are separators, % expands env vars (a value can hold
  // its own &), ^ escapes, " unbalances quoting, and a newline splits the
  // command line. A flag never needs any of them.
  if (args.some((arg) => /[&|<>%"^\r\n]/.test(String(arg)))) throw new Error("Arguments cannot contain &, |, <, >, \", %, ^, or line breaks.");
  const existing = dataRoot ? readRows(dataRoot) : [];
  const customs = existing.filter((row) => row.kind === "custom");
  if (customs.length >= CUSTOM_MAX) throw new Error("The agent list is full.");
  // A retried Add after a failed UI refresh would otherwise mint a twin.
  const argsJson = JSON.stringify(args);
  const dup = customs.find((row) => String(row.command) === command && String(row.args_json) === argsJson);
  if (dup) return { id: String(dup.id), name: String(dup.name || name), command, args, existing: true };
  const insert = openDbSafe(dataRoot).prepare(
    "INSERT INTO acp_agents (id, kind, name, command, args_json, env_json, created_at) VALUES (?, 'custom', ?, ?, ?, '{}', ?)",
  );
  let id = "custom-" + randomUUID().slice(0, 8);
  try {
    insert.run(id, name, command, argsJson, new Date().toISOString());
  } catch (error) {
    if (!/constraint|unique/i.test(String((error && error.message) || ""))) throw error;
    id = "custom-" + randomUUID().slice(0, 8);
    insert.run(id, name, command, argsJson, new Date().toISOString());
  }
  return { id, name, command, args };
}

function removeAgent(dataRoot, id) {
  const key = String(id || "");
  if (!key) throw new Error("Missing agent id.");
  const result = openDbSafe(dataRoot).prepare("DELETE FROM acp_agents WHERE id = ?").run(key);
  return Number(result && result.changes) || 0;
}

// Harness-shaped entries for the picker and the spawn path. A catalog agent
// resolves to null when its binary is missing so the picker marks it not
// installed; a custom agent always "resolves" because the user typed the
// command and owns fixing it.
function extraHarnesses(dataRoot) {
  if (!dataRoot) return [];
  let grouped;
  try {
    grouped = rowsByKind(dataRoot);
  } catch {
    return [];
  }
  const out = [];
  for (const id of grouped.catalog) {
    const entry = catalogEntry(id);
    if (!entry) continue;
    out.push({
      id: entry.id,
      name: entry.name,
      description: entry.description,
      connects: "the JV MCP",
      reach: "every JV tool: cards, library, projects, recording, and the browser",
      resolve: entry.resolve,
      install: entry.install,
      marketplace: true,
    });
  }
  for (const item of grouped.custom) {
    out.push({
      id: item.id,
      name: item.name,
      description: "Custom ACP agent: " + item.command + (item.args.length ? " " + item.args.join(" ") : ""),
      connects: "the JV MCP",
      reach: "every JV tool: cards, library, projects, recording, and the browser",
      // Resolves only when the typed command points at something real; a name
      // that is not on PATH marks the picker entry Not installed instead of
      // dying on spawn.
      resolve: () => {
        const command = findProgram(item.command);
        return command ? { command, args: item.args.slice(), env: item.env } : null;
      },
      install: "The command was not found. Fix it or remove the agent on the MCP setup page.",
      marketplace: true,
      custom: true,
    });
  }
  return out.concat(registryHarnesses(grouped));
}

// A registry install runs the program JV put in its data folder (or
// uvx). It shows as not installed when that program is gone.
function registryHarnesses(grouped) {
  return (grouped.registry || []).map((item) => ({
    id: item.id,
    name: item.name,
    description: String(item.meta.description || "From the ACP Registry") + (item.meta.version ? " (" + item.meta.version + ")" : ""),
    connects: "the JV MCP",
    reach: "every JV tool: cards, library, projects, recording, and the browser",
    resolve: () => {
      const command = path.isAbsolute(item.command) ? (isFile(item.command) ? item.command : null) : findProgram(item.command);
      return command ? { command, args: item.args.slice(), env: item.env } : null;
    },
    install: "Its files are missing. Install it again from the Marketplace on the Agents page.",
    marketplace: true,
    registry: true,
    registryId: String(item.meta.registryId || ""),
    icon: String(item.meta.icon || ""),
  }));
}

const REGISTRY_ID_PREFIX = "registry-";

function registryHarnessId(registryId) {
  return REGISTRY_ID_PREFIX + String(registryId);
}

// Saves (or updates) a registry install. The id is fixed per registry agent so
// an update keeps every chat bound to it.
function addRegistryAgent(dataRoot, agent, installed) {
  const id = registryHarnessId(agent.id);
  const meta = {
    registryId: agent.id,
    version: installed.version || "",
    kind: installed.kind,
    dir: installed.dir || "",
    description: String(agent.description || "").slice(0, 300),
    icon: String(installed.icon || "").slice(0, 70000),
  };
  openDbSafe(dataRoot)
    .prepare(
      "INSERT INTO acp_agents (id, kind, name, command, args_json, env_json, meta_json, created_at) VALUES (?, 'registry', ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET name = excluded.name, command = excluded.command, args_json = excluded.args_json, env_json = excluded.env_json, meta_json = excluded.meta_json",
    )
    .run(id, String(agent.name).slice(0, NAME_MAX), installed.command, JSON.stringify(installed.args || []), JSON.stringify(installed.env || {}), JSON.stringify(meta), new Date().toISOString());
  return { id, name: agent.name };
}

function registryInstalls(dataRoot) {
  try {
    return rowsByKind(dataRoot).registry;
  } catch {
    return [];
  }
}

function marketplaceHarness(id, dataRoot) {
  return extraHarnesses(dataRoot).find((item) => item.id === id) || null;
}

module.exports = {
  MARKETPLACE_CATALOG,
  catalogEntry,
  findProgram,
  marketplaceList,
  addCatalogAgent,
  addCustomAgent,
  removeAgent,
  extraHarnesses,
  marketplaceHarness,
  splitArgs,
  closeAcpAgentDbs,
  addRegistryAgent,
  registryInstalls,
  registryHarnessId,
  cursorAgentSpec,
  codexSpec,
  claudeCodeSpec,
};
