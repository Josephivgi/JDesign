"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { dbPath: resolveDbPath, parseTargetId } = require("./recorder-contract");

const SQLITE_HEADER = Buffer.from("SQLite format 3\0");
const SELECTED_KEY = "current";
// Recorder chats keep the original "current" active key; News gets its own so
// switching tabs never swaps the other agent's open chat.
const ACTIVE_CHAT_KEYS = { recorder: "current", news: "news" };
const CHAT_KINDS = new Set(["recorder", "news"]);
const DEFAULT_CHAT_KIND = "recorder";
const DEFAULT_CHAT_TITLES = { recorder: "New recording", news: "New chat" };
const CHAT_ROLES = new Set(["user", "recorder", "assistant", "system"]);
const BUSY_MS = 5000;

const SESSION_STATUSES = new Set(["idle", "recording", "paused", "stopped", "error"]);
const IMPORT_STATUSES = new Set(["ok", "error", "pending"]);

const SESSION_PATCH_COLUMNS = {
  status: "status",
  model: "model",
  startedAt: "started_at",
  started_at: "started_at",
  stoppedAt: "stopped_at",
  stopped_at: "stopped_at",
  takePath: "take_path",
  take_path: "take_path",
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_name TEXT NOT NULL,
  model TEXT,
  status TEXT NOT NULL CHECK (status IN ('idle', 'recording', 'paused', 'stopped', 'error')),
  started_at TEXT,
  stopped_at TEXT,
  take_path TEXT
);
CREATE TABLE IF NOT EXISTS takes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  path TEXT,
  started_at TEXT,
  stopped_at TEXT,
  duration_ms INTEGER,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);
CREATE TABLE IF NOT EXISTS imports (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  from_target TEXT NOT NULL,
  to_target TEXT NOT NULL,
  source_path TEXT NOT NULL,
  dest_path TEXT,
  status TEXT NOT NULL CHECK (status IN ('ok', 'error', 'pending')),
  error TEXT
);
CREATE TABLE IF NOT EXISTS selected (
  k TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_created_at ON sessions(created_at DESC);
CREATE INDEX IF NOT EXISTS takes_session_id ON takes(session_id, started_at);
CREATE INDEX IF NOT EXISTS imports_created_at ON imports(created_at DESC);
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  target_id TEXT NOT NULL,
  model TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'recorder' CHECK (kind IN ('recorder', 'news'))
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'recorder', 'assistant', 'system')),
  text TEXT NOT NULL,
  thinking TEXT,
  meta TEXT,
  created_at TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS chat_active (
  k TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chats_updated_at ON chats(updated_at DESC);
CREATE INDEX IF NOT EXISTS chat_messages_chat_id ON chat_messages(chat_id, sort_order);
`;

// Older databases predate News chats: chats had no kind column and the
// message role check only knew the recorder. Both migrations keep every row.
function migrateChatSchema(db) {
  const columns = db.prepare("PRAGMA table_info(chats)").all().map((row) => row.name);
  if (!columns.includes("kind")) {
    db.exec("ALTER TABLE chats ADD COLUMN kind TEXT NOT NULL DEFAULT 'recorder'");
  }
  if (!columns.includes("session_file")) {
    // Path to the pi session JSONL that holds this chat's full model context;
    // agent restarts resume it so the model keeps real history.
    db.exec("ALTER TABLE chats ADD COLUMN session_file TEXT");
  }
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chat_messages'").get();
  const sql = table && table.sql ? String(table.sql) : "";
  if (sql && !sql.includes("'assistant'")) {
    db.exec("PRAGMA foreign_keys=OFF;");
    try {
      withTxn(db, () => {
        db.exec(
          "CREATE TABLE chat_messages_next (" +
            "id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, " +
            "role TEXT NOT NULL CHECK (role IN ('user', 'recorder', 'assistant', 'system')), " +
            "text TEXT NOT NULL, thinking TEXT, created_at TEXT NOT NULL, sort_order INTEGER NOT NULL, " +
            "FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE)",
        );
        db.exec(
          "INSERT INTO chat_messages_next (id, chat_id, role, text, created_at, sort_order) " +
            "SELECT id, chat_id, role, text, created_at, sort_order FROM chat_messages",
        );
        db.exec("DROP TABLE chat_messages");
        db.exec("ALTER TABLE chat_messages_next RENAME TO chat_messages");
        db.exec("CREATE INDEX IF NOT EXISTS chat_messages_chat_id ON chat_messages(chat_id, sort_order)");
      });
    } finally {
      db.exec("PRAGMA foreign_keys=ON;");
    }
  }
  const msgCols = db.prepare("PRAGMA table_info(chat_messages)").all().map((row) => row.name);
  if (!msgCols.includes("thinking")) {
    db.exec("ALTER TABLE chat_messages ADD COLUMN thinking TEXT");
  }
  if (!msgCols.includes("meta")) {
    // JSON blob for tool-card rows (args, output, timing, subagent children)
    // so a reopened chat restores the same card instead of a bare label.
    db.exec("ALTER TABLE chat_messages ADD COLUMN meta TEXT");
  }
}

function nowIso() {
  return new Date().toISOString();
}

function notSqliteError(file) {
  return new Error("Recorder store file is not a SQLite database: " + file);
}

function wrapOpenError(file, error) {
  const msg = String(error && error.message ? error.message : error);
  if (/not a database/i.test(msg) || /SQLITE_NOTADB/i.test(msg) || error && error.errcode === 26) {
    return notSqliteError(file);
  }
  return new Error("Recorder store could not open " + file + ": " + msg);
}

function assertExistingSqlite(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch (error) {
    if (error && error.code === "ENOENT") return;
    throw error;
  }
  if (!st.isFile()) {
    throw new Error("Recorder store path is not a file: " + file);
  }
  if (st.size === 0) return;
  const fd = fs.openSync(file, "r");
  let header;
  try {
    header = Buffer.alloc(16);
    const n = fs.readSync(fd, header, 0, 16, 0);
    if (n < 16) throw notSqliteError(file);
  } finally {
    fs.closeSync(fd);
  }
  if (!header.equals(SQLITE_HEADER)) throw notSqliteError(file);
}

function requireTarget(targetId) {
  const parsed = parseTargetId(targetId);
  if (!parsed) {
    throw new Error("Invalid recorder target id: " + String(targetId == null ? "" : targetId));
  }
  return parsed;
}

function requireStatus(status, allowed, label) {
  const value = String(status == null ? "" : status);
  if (!allowed.has(value)) {
    throw new Error("Invalid " + label + " status: " + value);
  }
  return value;
}

function optionalText(value) {
  if (value == null) return null;
  return String(value);
}

function optionalInt(value) {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error("durationMs must be an integer");
  }
  return n;
}

function limitValue(opts) {
  if (!opts || opts.limit == null) return null;
  const n = Number(opts.limit);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error("limit must be a non-negative integer");
  }
  return n;
}

function mapSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    createdAt: row.created_at,
    targetId: row.target_id,
    targetType: row.target_type,
    targetName: row.target_name,
    model: row.model,
    status: row.status,
    startedAt: row.started_at,
    stoppedAt: row.stopped_at,
    takePath: row.take_path,
  };
}

function mapTake(row) {
  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.session_id,
    path: row.path,
    startedAt: row.started_at,
    stoppedAt: row.stopped_at,
    durationMs: row.duration_ms,
  };
}

function mapChat(row) {
  if (!row) return null;
  const chat = {
    id: row.id,
    kind: row.kind || DEFAULT_CHAT_KIND,
    title: row.title,
    targetId: row.target_id,
    model: row.model,
    sessionFile: row.session_file || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.message_count != null) chat.messageCount = Number(row.message_count) || 0;
  return chat;
}

const ALL_CHAT_KINDS = "all";

function requireChatKind(kind) {
  const value = String(kind == null ? "" : kind).trim().toLowerCase() || DEFAULT_CHAT_KIND;
  if (value === ALL_CHAT_KINDS) return value;
  if (!CHAT_KINDS.has(value)) throw new Error("Invalid chat kind: " + value);
  return value;
}

function defaultChatTitle(kind) {
  return DEFAULT_CHAT_TITLES[kind] || DEFAULT_CHAT_TITLES[DEFAULT_CHAT_KIND];
}

function isDefaultChatTitle(title) {
  return Object.values(DEFAULT_CHAT_TITLES).includes(String(title || ""));
}

function mapChatMessage(row) {
  if (!row) return null;
  const message = {
    id: row.id,
    chatId: row.chat_id,
    role: row.role,
    text: row.text,
    createdAt: row.created_at,
    sortOrder: row.sort_order,
  };
  if (row.thinking) message.thinking = String(row.thinking);
  if (row.meta) {
    try {
      const meta = JSON.parse(row.meta);
      if (meta && typeof meta === "object") message.meta = meta;
    } catch {
      /* malformed meta drops to a plain row */
    }
  }
  return message;
}

function serializeMeta(item) {
  if (!item || typeof item !== "object" || item.meta == null) return null;
  try {
    const text = JSON.stringify(item.meta);
    return text && text !== "null" ? text : null;
  } catch {
    return null;
  }
}

function requireChatRole(role) {
  const value = String(role == null ? "" : role);
  if (!CHAT_ROLES.has(value)) throw new Error("Invalid chat message role: " + value);
  return value;
}

function chatTitleFromText(text, kind) {
  const line = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!line) return defaultChatTitle(kind);
  return line.length > 48 ? line.slice(0, 45) + "..." : line;
}

function mapImport(row) {
  if (!row) return null;
  return {
    id: row.id,
    createdAt: row.created_at,
    fromTarget: row.from_target,
    toTarget: row.to_target,
    sourcePath: row.source_path,
    destPath: row.dest_path,
    status: row.status,
    error: row.error,
  };
}

function withTxn(db, fn) {
  if (db.isTransaction) return fn();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.isTransaction) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Keep the original write error.
      }
    }
    throw error;
  }
}

function openDatabase(file) {
  assertExistingSqlite(file);
  let db;
  try {
    db = new DatabaseSync(file, {
      timeout: BUSY_MS,
      enableForeignKeyConstraints: true,
    });
  } catch (error) {
    throw wrapOpenError(file, error);
  }
  try {
    db.exec("PRAGMA journal_mode=WAL;");
    db.exec("PRAGMA foreign_keys=ON;");
    db.exec("PRAGMA busy_timeout=" + BUSY_MS + ";");
    db.exec(SCHEMA);
    migrateChatSchema(db);
  } catch (error) {
    try {
      if (db.isOpen) db.close();
    } catch {
      // Close is best-effort after a failed open.
    }
    throw wrapOpenError(file, error);
  }
  return db;
}

function openRecorderStore(dataRoot) {
  const file = resolveDbPath(dataRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = openDatabase(file);
  // One prepared statement per SQL text for the life of the connection; the
  // shared store in recorder-chats.js keeps this connection open across calls.
  const stmts = new Map();
  function stmt(sql) {
    let prepared = stmts.get(sql);
    if (!prepared) stmts.set(sql, (prepared = db.prepare(sql)));
    return prepared;
  }

  function requireOpen() {
    if (!db.isOpen) throw new Error("Recorder store is closed");
  }

  function getSession(id) {
    requireOpen();
    const key = String(id == null ? "" : id);
    if (!key) return null;
    return mapSession(stmt("SELECT * FROM sessions WHERE id = ?").get(key));
  }

  function selectTarget(targetId) {
    requireOpen();
    const target = requireTarget(targetId);
    const updatedAt = nowIso();
    withTxn(db, () => {
      stmt(
        "INSERT INTO selected (k, target_id, updated_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(k) DO UPDATE SET target_id = excluded.target_id, updated_at = excluded.updated_at",
      ).run(SELECTED_KEY, target.id, updatedAt);
    });
    return { targetId: target.id, type: target.type, name: target.name };
  }

  function getSelected() {
    requireOpen();
    const row = stmt("SELECT target_id FROM selected WHERE k = ?").get(SELECTED_KEY);
    if (!row) return null;
    const target = parseTargetId(row.target_id);
    if (!target) return null;
    return { targetId: target.id, type: target.type, name: target.name };
  }

  function createSession(input) {
    requireOpen();
    const src = input && typeof input === "object" ? input : {};
    const target = requireTarget(src.targetId);
    const id = randomUUID();
    const createdAt = nowIso();
    const model = optionalText(src.model);
    withTxn(db, () => {
      stmt(
        "INSERT INTO sessions (id, created_at, target_id, target_type, target_name, model, status, started_at, stopped_at, take_path) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(id, createdAt, target.id, target.type, target.name, model, "idle", null, null, null);
    });
    return getSession(id);
  }

  function updateSession(id, patch) {
    requireOpen();
    const key = String(id == null ? "" : id);
    if (!key) throw new Error("Session not found: ");
    const src = patch && typeof patch === "object" ? patch : {};
    const fields = Object.keys(src);
    if (!fields.length) {
      const current = getSession(key);
      if (!current) throw new Error("Session not found: " + key);
      return current;
    }
    const sets = [];
    const values = [];
    for (const field of fields) {
      const column = SESSION_PATCH_COLUMNS[field];
      if (!column) throw new Error("Unknown session column: " + field);
      let value = src[field];
      if (column === "status") value = requireStatus(value, SESSION_STATUSES, "session");
      else if (column === "model") value = optionalText(value);
      else value = value == null ? null : String(value);
      sets.push(column + " = ?");
      values.push(value);
    }
    values.push(key);
    return withTxn(db, () => {
      const result = stmt("UPDATE sessions SET " + sets.join(", ") + " WHERE id = ?").run(...values);
      if (!result.changes) throw new Error("Session not found: " + key);
      return getSession(key);
    });
  }

  function listSessions(opts) {
    requireOpen();
    const limit = limitValue(opts);
    const sql = "SELECT * FROM sessions ORDER BY created_at DESC, id DESC" + (limit == null ? "" : " LIMIT ?");
    const rows = limit == null ? stmt(sql).all() : stmt(sql).all(limit);
    return rows.map(mapSession);
  }

  function addTake(input) {
    requireOpen();
    const src = input && typeof input === "object" ? input : {};
    const sessionId = String(src.sessionId == null ? "" : src.sessionId);
    if (!sessionId) throw new Error("sessionId is required");
    const id = randomUUID();
    const takePath = optionalText(src.path);
    const startedAt = optionalText(src.startedAt);
    const stoppedAt = optionalText(src.stoppedAt);
    const durationMs = optionalInt(src.durationMs);
    return withTxn(db, () => {
      const session = stmt("SELECT id FROM sessions WHERE id = ?").get(sessionId);
      if (!session) throw new Error("Session not found: " + sessionId);
      stmt(
        "INSERT INTO takes (id, session_id, path, started_at, stopped_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(id, sessionId, takePath, startedAt, stoppedAt, durationMs);
      return mapTake(stmt("SELECT * FROM takes WHERE id = ?").get(id));
    });
  }

  function listTakes(sessionId) {
    requireOpen();
    const key = String(sessionId == null ? "" : sessionId);
    if (!key) throw new Error("sessionId is required");
    return stmt("SELECT * FROM takes WHERE session_id = ? ORDER BY started_at ASC, id ASC")
      .all(key)
      .map(mapTake);
  }

  function addImport(input) {
    requireOpen();
    const src = input && typeof input === "object" ? input : {};
    const fromTarget = requireTarget(src.fromTarget);
    const toTarget = requireTarget(src.toTarget);
    const sourcePath = String(src.sourcePath == null ? "" : src.sourcePath);
    if (!sourcePath) throw new Error("sourcePath is required");
    const destPath = optionalText(src.destPath);
    const status = src.status == null ? "pending" : requireStatus(src.status, IMPORT_STATUSES, "import");
    const error = optionalText(src.error);
    const id = randomUUID();
    const createdAt = nowIso();
    return withTxn(db, () => {
      stmt(
        "INSERT INTO imports (id, created_at, from_target, to_target, source_path, dest_path, status, error) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(id, createdAt, fromTarget.id, toTarget.id, sourcePath, destPath, status, error);
      return mapImport(stmt("SELECT * FROM imports WHERE id = ?").get(id));
    });
  }

  function listImports(opts) {
    requireOpen();
    const limit = limitValue(opts);
    const sql = "SELECT * FROM imports ORDER BY created_at DESC, id DESC" + (limit == null ? "" : " LIMIT ?");
    const rows = limit == null ? stmt(sql).all() : stmt(sql).all(limit);
    return rows.map(mapImport);
  }

  function activeSession() {
    requireOpen();
    return mapSession(
      stmt(
        "SELECT * FROM sessions WHERE status IN ('recording', 'paused') ORDER BY created_at DESC, id DESC LIMIT 1",
      ).get(),
    );
  }

  function activeKeyFor(kind) {
    return ACTIVE_CHAT_KEYS[requireChatKind(kind)];
  }

  function markActive(kind, chatId, at) {
    stmt(
      "INSERT INTO chat_active (k, chat_id, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(k) DO UPDATE SET chat_id = excluded.chat_id, updated_at = excluded.updated_at",
    ).run(activeKeyFor(kind), chatId, at);
  }

  function listChats(opts) {
    requireOpen();
    const src = opts && typeof opts === "object" ? opts : {};
    const limit = limitValue(src);
    const kind = requireChatKind(src.kind);
    // The merged agent surface lists every chat the agents own: "all" drops
    // the kind filter so old News and Recorder chats sit in one history.
    const where = kind === ALL_CHAT_KINDS ? "" : " WHERE kind = ?";
    const sql =
      "SELECT chats.*, (SELECT COUNT(*) FROM chat_messages WHERE chat_messages.chat_id = chats.id) AS message_count" +
      " FROM chats" + where + " ORDER BY updated_at DESC, id DESC" +
      (limit == null ? "" : " LIMIT ?");
    const args = kind === ALL_CHAT_KINDS ? (limit == null ? [] : [limit]) : (limit == null ? [kind] : [kind, limit]);
    const rows = stmt(sql).all(...args);
    return rows.map(mapChat);
  }

  function getChat(id) {
    requireOpen();
    const key = String(id == null ? "" : id);
    if (!key) return null;
    const chat = mapChat(stmt("SELECT * FROM chats WHERE id = ?").get(key));
    if (!chat) return null;
    const messages = stmt("SELECT * FROM chat_messages WHERE chat_id = ? ORDER BY sort_order ASC, created_at ASC, id ASC")
      .all(key)
      .map(mapChatMessage);
    return { chat, messages };
  }

  function createChat(input) {
    requireOpen();
    const src = input && typeof input === "object" ? input : {};
    // "all" is a read filter, never a row kind.
    const kind = src.kind === ALL_CHAT_KINDS ? DEFAULT_CHAT_KIND : requireChatKind(src.kind);
    const target = requireTarget(src.targetId || (kind === "news" ? "browser:chromium" : "local:this-computer"));
    const id = randomUUID();
    const createdAt = nowIso();
    const fallback = defaultChatTitle(kind);
    const title = String(src.title || fallback).trim() || fallback;
    const model = optionalText(src.model);
    withTxn(db, () => {
      stmt(
        "INSERT INTO chats (id, kind, title, target_id, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(id, kind, title, target.id, model, createdAt, createdAt);
      markActive(kind, id, createdAt);
    });
    return getChat(id);
  }

  function touchChat(chatId) {
    requireOpen();
    const key = String(chatId == null ? "" : chatId);
    if (!key) throw new Error("chatId is required");
    const updatedAt = nowIso();
    return withTxn(db, () => {
      const result = stmt("UPDATE chats SET updated_at = ? WHERE id = ?").run(updatedAt, key);
      if (!result.changes) throw new Error("Chat not found: " + key);
      const chat = mapChat(stmt("SELECT * FROM chats WHERE id = ?").get(key));
      markActive(chat.kind, key, updatedAt);
      return chat;
    });
  }

  function updateChat(id, patch) {
    requireOpen();
    const key = String(id == null ? "" : id);
    if (!key) throw new Error("Chat not found: ");
    const src = patch && typeof patch === "object" ? patch : {};
    const sets = [];
    const values = [];
    if (src.title != null) {
      const row = stmt("SELECT kind FROM chats WHERE id = ?").get(key);
      sets.push("title = ?");
      values.push(String(src.title).trim() || defaultChatTitle(row && row.kind));
    }
    if (src.targetId != null) {
      const target = requireTarget(src.targetId);
      sets.push("target_id = ?");
      values.push(target.id);
    }
    if (src.model != null) {
      sets.push("model = ?");
      values.push(optionalText(src.model));
    }
    if (src.sessionFile != null) {
      sets.push("session_file = ?");
      values.push(optionalText(src.sessionFile));
    }
    if (!sets.length) return mapChat(stmt("SELECT * FROM chats WHERE id = ?").get(key));
    sets.push("updated_at = ?");
    values.push(nowIso());
    values.push(key);
    return withTxn(db, () => {
      const result = stmt("UPDATE chats SET " + sets.join(", ") + " WHERE id = ?").run(...values);
      if (!result.changes) throw new Error("Chat not found: " + key);
      return mapChat(stmt("SELECT * FROM chats WHERE id = ?").get(key));
    });
  }

  function appendChatMessage(input) {
    requireOpen();
    const src = input && typeof input === "object" ? input : {};
    const chatId = String(src.chatId == null ? "" : src.chatId);
    if (!chatId) throw new Error("chatId is required");
    const role = requireChatRole(src.role);
    const text = String(src.text == null ? "" : src.text);
    const thinking = src.thinking != null ? String(src.thinking) : "";
    const id = randomUUID();
    const createdAt = nowIso();
    return withTxn(db, () => {
      const chat = stmt("SELECT id, title, kind FROM chats WHERE id = ?").get(chatId);
      if (!chat) throw new Error("Chat not found: " + chatId);
      const row = stmt("SELECT COALESCE(MAX(sort_order), -1) AS max_order FROM chat_messages WHERE chat_id = ?").get(chatId);
      const sortOrder = (row && row.max_order != null ? Number(row.max_order) : -1) + 1;
      stmt(
        "INSERT INTO chat_messages (id, chat_id, role, text, thinking, meta, created_at, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(id, chatId, role, text, thinking || null, serializeMeta(src), createdAt, sortOrder);
      const title =
        isDefaultChatTitle(chat.title) && role === "user" ? chatTitleFromText(text, chat.kind) : chat.title;
      stmt("UPDATE chats SET title = ?, updated_at = ? WHERE id = ?").run(title, createdAt, chatId);
      markActive(chat.kind, chatId, createdAt);
      return mapChatMessage(stmt("SELECT * FROM chat_messages WHERE id = ?").get(id));
    });
  }

  function replaceChatMessages(chatId, messages) {
    requireOpen();
    const key = String(chatId == null ? "" : chatId);
    if (!key) throw new Error("chatId is required");
    const list = Array.isArray(messages) ? messages : [];
    const createdAt = nowIso();
    return withTxn(db, () => {
      const chat = stmt("SELECT id, kind FROM chats WHERE id = ?").get(key);
      if (!chat) throw new Error("Chat not found: " + key);
      stmt("DELETE FROM chat_messages WHERE chat_id = ?").run(key);
      let sortOrder = 0;
      const insert = stmt(
        "INSERT INTO chat_messages (id, chat_id, role, text, thinking, meta, created_at, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const item of list) {
        if (!item || typeof item !== "object") continue;
        const role = requireChatRole(item.role);
        const text = String(item.text == null ? "" : item.text);
        const thinking = item.thinking != null ? String(item.thinking) : "";
        insert.run(randomUUID(), key, role, text, thinking || null, serializeMeta(item), createdAt, sortOrder);
        sortOrder += 1;
      }
      const chatRow = stmt("SELECT title FROM chats WHERE id = ?").get(key);
      let title = chatRow && chatRow.title ? chatRow.title : defaultChatTitle(chat.kind);
      if (isDefaultChatTitle(title)) {
        const firstUser = list.find((item) => item && item.role === "user");
        if (firstUser) title = chatTitleFromText(firstUser.text, chat.kind);
      }
      stmt("UPDATE chats SET title = ?, updated_at = ? WHERE id = ?").run(title, createdAt, key);
      return getChat(key);
    });
  }

  function deleteChat(id) {
    requireOpen();
    const key = String(id == null ? "" : id);
    if (!key) throw new Error("Chat not found: ");
    return withTxn(db, () => {
      const result = stmt("DELETE FROM chats WHERE id = ?").run(key);
      if (!result.changes) throw new Error("Chat not found: " + key);
      stmt("DELETE FROM chat_active WHERE chat_id = ?").run(key);
      return { ok: true, id: key };
    });
  }

  function getActiveChat(kind) {
    requireOpen();
    const wanted = requireChatKind(kind);
    // The merged agent restores whichever chat either agent opened last;
    // per-kind keys stay as the tiebreaker history.
    if (wanted === ALL_CHAT_KINDS) {
      const row = stmt("SELECT chat_id FROM chat_active ORDER BY updated_at DESC LIMIT 1").get();
      const record = row ? getChat(row.chat_id) : null;
      if (record) return record;
      // A missing or dead pointer must not strand live history: adopt the
      // most recent chat so resume never lands on a fresh empty one.
      const latest = stmt("SELECT id, kind FROM chats ORDER BY updated_at DESC, id DESC LIMIT 1").get();
      if (!latest) return null;
      markActive(latest.kind, latest.id, nowIso());
      return getChat(latest.id);
    }
    const row = stmt("SELECT chat_id FROM chat_active WHERE k = ?").get(activeKeyFor(wanted));
    const record = row ? getChat(row.chat_id) : null;
    if (record && record.chat.kind === wanted) return record;
    // Same fallback per kind: the pointer is gone or points across kinds, so
    // resume the kind's newest chat rather than reporting nothing.
    const latest = stmt("SELECT id FROM chats WHERE kind = ? ORDER BY updated_at DESC, id DESC LIMIT 1").get(wanted);
    if (!latest) return null;
    markActive(wanted, latest.id, nowIso());
    return getChat(latest.id);
  }

  function setActiveChat(id) {
    requireOpen();
    const key = String(id == null ? "" : id);
    if (!key) throw new Error("Chat not found: ");
    const chat = mapChat(stmt("SELECT * FROM chats WHERE id = ?").get(key));
    if (!chat) throw new Error("Chat not found: " + key);
    const updatedAt = nowIso();
    withTxn(db, () => {
      markActive(chat.kind, key, updatedAt);
    });
    return getChat(key);
  }

  function close() {
    if (db.isOpen) db.close();
  }

  return {
    close,
    isOpen: () => db.isOpen !== false,
    dbPath() {
      return file;
    },
    selectTarget,
    getSelected,
    createSession,
    getSession,
    updateSession,
    listSessions,
    addTake,
    listTakes,
    addImport,
    listImports,
    activeSession,
    listChats,
    getChat,
    createChat,
    touchChat,
    updateChat,
    appendChatMessage,
    replaceChatMessages,
    deleteChat,
    getActiveChat,
    setActiveChat,
  };
}

module.exports = {
  openRecorderStore,
};
