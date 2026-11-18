"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
// node:sqlite is only present on newer Node builds; resolve it lazily so
// loading this module (e.g. inside mcp-stdio) does not crash on older ones.
let DatabaseSync = null;
function dbSyncCtor() {
  if (!DatabaseSync) ({ DatabaseSync } = require("node:sqlite"));
  return DatabaseSync;
}

const BUSY_MS = 5000;
const MAX_ARGS_BYTES = 16 * 1024;
const MAX_SUMMARY = 500;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_actions (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  client TEXT NOT NULL DEFAULT '',
  harness TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL DEFAULT '',
  workspace_id TEXT NOT NULL DEFAULT '',
  project_id TEXT NOT NULL DEFAULT '',
  tool TEXT NOT NULL,
  args_json TEXT NOT NULL DEFAULT '{}',
  ok INTEGER NOT NULL DEFAULT 1,
  summary TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS agent_actions_at ON agent_actions(at DESC);
CREATE INDEX IF NOT EXISTS agent_actions_project ON agent_actions(project_id, at DESC);
`;

// Every agent tool call adds a row and nothing read it past the newest 500,
// so the log keeps the newest KEEP_ROWS and prunes every PRUNE_EVERY inserts.
const KEEP_ROWS = 50000;
const PRUNE_EVERY = 1000;

function dbPath(dataRoot) {
  return path.join(String(dataRoot || ""), "agent-activity.db");
}

// Secrets never belong in the log: cookie values, tokens, and inline cookie
// arrays are replaced before the row is written.
function redactArgs(args) {
  const seen = new WeakSet();
  const walk = (value, key) => {
    if (/cookie|token|password|secret|authorization|api[_-]?key/i.test(String(key || ""))) {
      if (value == null) return value;
      if (Array.isArray(value)) return "[redacted " + value.length + "]";
      return "[redacted]";
    }
    if (!value || typeof value !== "object") return value;
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    if (Array.isArray(value)) return value.slice(0, 50).map((item) => walk(item, ""));
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = walk(v, k);
    return out;
  };
  let json = JSON.stringify(walk(args || {}, "") || {});
  if (Buffer.byteLength(json, "utf8") > MAX_ARGS_BYTES) {
    json = JSON.stringify({ truncated: true, preview: json.slice(0, 2000) });
  }
  return json;
}

function rowOut(row) {
  let args = {};
  try {
    args = JSON.parse(row.args_json || "{}");
  } catch {
    args = {};
  }
  return {
    id: row.id,
    at: row.at,
    client: row.client,
    harness: row.harness,
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    tool: row.tool,
    args,
    ok: Boolean(row.ok),
    summary: row.summary,
    durationMs: row.duration_ms,
  };
}

function openActivityStore(dataRoot) {
  if (!dataRoot) throw new Error("dataRoot is required");
  fs.mkdirSync(dataRoot, { recursive: true });
  const db = new (dbSyncCtor())(dbPath(dataRoot));
  db.exec("PRAGMA journal_mode = WAL");
  // An audit log row lost to a power cut is acceptable; an fsync per tool
  // call on the main process is not. WAL keeps the file consistent either way.
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = " + BUSY_MS);
  db.exec(SCHEMA);
  const insert = db.prepare(
    `INSERT INTO agent_actions
      (id, at, client, harness, session_id, workspace_id, project_id, tool, args_json, ok, summary, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const prune = db.prepare(
    "DELETE FROM agent_actions WHERE at < (SELECT at FROM agent_actions ORDER BY at DESC LIMIT 1 OFFSET ?)",
  );
  const listStmts = new Map();
  let sincePrune = 0;
  function trim() {
    sincePrune = 0;
    try {
      prune.run(KEEP_ROWS - 1);
    } catch {
      /* a busy or locked prune retries on a later insert */
    }
  }
  trim();

  function record(entry) {
    const e = entry || {};
    if (!e.tool) throw new Error("tool is required");
    const row = {
      id: randomUUID(),
      at: e.at || new Date().toISOString(),
      client: String(e.client || "").slice(0, 120),
      harness: String(e.harness || "").slice(0, 60),
      session_id: String(e.sessionId || "").slice(0, 120),
      workspace_id: String(e.workspaceId || ""),
      project_id: String(e.projectId || ""),
      tool: String(e.tool).slice(0, 120),
      args_json: redactArgs(e.args),
      ok: e.ok === false ? 0 : 1,
      summary: String(e.summary || "").slice(0, MAX_SUMMARY),
      duration_ms: Math.max(0, Math.round(Number(e.durationMs) || 0)),
    };
    insert.run(
      row.id,
      row.at,
      row.client,
      row.harness,
      row.session_id,
      row.workspace_id,
      row.project_id,
      row.tool,
      row.args_json,
      row.ok,
      row.summary,
      row.duration_ms,
    );
    if (++sincePrune >= PRUNE_EVERY) trim();
    return rowOut(row);
  }

  function list(options) {
    const opts = options || {};
    const limit = Math.min(500, Math.max(1, Number(opts.limit) || 100));
    const where = [];
    const params = [];
    if (opts.projectId) {
      where.push("project_id = ?");
      params.push(String(opts.projectId));
    }
    if (opts.workspaceId) {
      where.push("workspace_id = ?");
      params.push(String(opts.workspaceId));
    }
    if (opts.since) {
      where.push("at > ?");
      params.push(String(opts.since));
    }
    if (Array.isArray(opts.tools) && opts.tools.length) {
      where.push("tool IN (" + opts.tools.map(() => "?").join(",") + ")");
      params.push.apply(params, opts.tools.map(String));
    }
    if (opts.toolPrefix) {
      where.push("tool LIKE ?");
      params.push(String(opts.toolPrefix) + "%");
    }
    const sql =
      "SELECT * FROM agent_actions" +
      (where.length ? " WHERE " + where.join(" AND ") : "") +
      " ORDER BY at DESC LIMIT " +
      limit;
    let prepared = listStmts.get(sql);
    if (!prepared) {
      // Filter combinations are few, but tools IN (...) varies in arity.
      if (listStmts.size >= 64) listStmts.clear();
      listStmts.set(sql, (prepared = db.prepare(sql)));
    }
    return prepared.all(...params).map(rowOut);
  }

  // Tracked here: older node:sqlite builds have no db.isOpen.
  let open = true;
  function close() {
    open = false;
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }

  return { record, list, close, isOpen: () => open, path: dbPath(dataRoot) };
}

// Every MCP tool call is logged here, so the connection, schema, and
// statements live for the process instead of being rebuilt per row.
const stores = new Map();

function withActivity(dataRoot, fn) {
  if (!dataRoot) throw new Error("dataRoot is required");
  const key = path.resolve(dbPath(dataRoot));
  let store = stores.get(key);
  if (!store || !store.isOpen()) {
    store = openActivityStore(dataRoot);
    stores.set(key, store);
  }
  return fn(store);
}

// For app quit and tests that delete their data root (Windows keeps the file
// locked while a handle is open).
function closeActivityStores() {
  for (const store of stores.values()) store.close();
  stores.clear();
}

function recordAction(dataRoot, entry) {
  return withActivity(dataRoot, (store) => store.record(entry));
}

function listActions(dataRoot, options) {
  return withActivity(dataRoot, (store) => store.list(options));
}

// A new project's id only exists in the tool result, so the create row is
// tagged from there to count toward that project's export.
function callProjectId(call) {
  const args = (call && call.args) || {};
  if (args.projectId) return String(args.projectId);
  if (!call || call.name !== "jeditor_create_project" || !call.ok || !call.result) return "";
  const text = (call.result.content || []).find((item) => item && item.type === "text");
  try {
    return String((text && JSON.parse(text.text).id) || "");
  } catch {
    return "";
  }
}

module.exports = { dbPath, redactArgs, openActivityStore, recordAction, listActions, callProjectId, closeActivityStores };
