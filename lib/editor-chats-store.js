"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { handoffRow } = require("./acp-handoff");

// Edit videos and AI Video editing each keep their own chat thread per workspace.
const SQLITE_HEADER = Buffer.from("SQLite format 3\0");
const EDITOR_PAGES = new Set(["edit", "ai"]);
const CHAT_ROLES = new Set(["user", "assistant", "system"]);
const BUSY_MS = 5000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS editor_chats (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  page TEXT NOT NULL CHECK (page IN ('edit', 'ai')),
  project_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  model TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS editor_chat_messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  text TEXT NOT NULL,
  attachments_json TEXT,
  created_at TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  FOREIGN KEY (chat_id) REFERENCES editor_chats(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS editor_chat_active (
  workspace_id TEXT NOT NULL,
  page TEXT NOT NULL CHECK (page IN ('edit', 'ai')),
  chat_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, page),
  FOREIGN KEY (chat_id) REFERENCES editor_chats(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS editor_chat_active_v2 (
  workspace_id TEXT NOT NULL,
  page TEXT NOT NULL CHECK (page IN ('edit', 'ai')),
  project_id TEXT NOT NULL DEFAULT '',
  chat_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, page, project_id),
  FOREIGN KEY (chat_id) REFERENCES editor_chats(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS editor_chats_scope ON editor_chats(workspace_id, page, updated_at DESC);
CREATE INDEX IF NOT EXISTS editor_chat_messages_chat_id ON editor_chat_messages(chat_id, sort_order);
CREATE TABLE IF NOT EXISTS acp_model_cache (
  harness_id TEXT PRIMARY KEY,
  models_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

function dbPath(dataRoot) {
  return path.join(String(dataRoot || ""), "editor-chats.db");
}

function nowIso() {
  return new Date().toISOString();
}

function notSqliteError(file) {
  return new Error("Editor chat store file is not a SQLite database: " + file);
}

function wrapOpenError(file, error) {
  const msg = String(error && error.message ? error.message : error);
  if (/not a database/i.test(msg) || /SQLITE_NOTADB/i.test(msg) || (error && error.errcode === 26)) {
    return notSqliteError(file);
  }
  return new Error("Editor chat store could not open " + file + ": " + msg);
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
    throw new Error("Editor chat store path is not a file: " + file);
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

function requireWorkspaceId(workspaceId) {
  const value = String(workspaceId == null ? "" : workspaceId).trim();
  if (!value) throw new Error("workspaceId is required");
  return value;
}

function requirePage(page) {
  const value = String(page == null ? "" : page).trim().toLowerCase();
  if (!EDITOR_PAGES.has(value)) throw new Error("Invalid editor chat page: " + value);
  return value;
}

function requireChatRole(role) {
  const value = String(role == null ? "" : role);
  if (!CHAT_ROLES.has(value)) throw new Error("Invalid chat message role: " + value);
  return value;
}

function optionalText(value) {
  if (value == null) return null;
  return String(value);
}

function limitValue(opts) {
  if (!opts || opts.limit == null) return null;
  const n = Number(opts.limit);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error("limit must be a non-negative integer");
  }
  return n;
}

// A short title from the first message: drop the asking words, keep the
// first clause, cut at a word, and never end on "the" or "with".
const TITLE_FILLER = /^(hey|hi|ok|okay|so|please|pls|can you|could you|would you|will you|i want( you)? to|i need( you)? to|i'?d like( you)? to|help me|let'?s|go( in(to)?)?|make( me)? an?|make me|create an?|an?|for me)\b[\s,]*/i;
const TITLE_TRAILING = /\s+(a|an|the|and|or|of|to|in|on|at|with|for|from|about|how|that|this|my|i|it|is|are|be|so|but|by|as)$/i;
function chatTitleFromText(text) {
  let line = String(text || "").split(/\n/)[0].replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim();
  if (!line) return "New chat";
  // "/captions bigger text" keeps the command readable: "Captions: bigger text".
  const cmd = line.match(/^\/([a-z0-9-]+)\s*(.*)$/i);
  if (cmd) line = cmd[1].charAt(0).toUpperCase() + cmd[1].slice(1) + (cmd[2] ? ": " + cmd[2] : "");
  for (let i = 0; i < 4 && TITLE_FILLER.test(line); i += 1) line = line.replace(TITLE_FILLER, "");
  line = line.split(/[.;!?](?=\s|$)|,\s/)[0].trim();
  if (!line) return "New chat";
  const words = line.split(" ");
  let out = "";
  for (const w of words) {
    if ((out + " " + w).trim().length > 40) break;
    out = (out + " " + w).trim();
  }
  if (!out) out = words[0].slice(0, 40);
  while (TITLE_TRAILING.test(out)) out = out.replace(TITLE_TRAILING, "");
  return out.charAt(0).toUpperCase() + out.slice(1);
}

function mapChat(row) {
  if (!row) return null;
  let acpTranscript = null;
  if (row.acp_transcript) {
    try {
      const parsed = JSON.parse(row.acp_transcript);
      acpTranscript = Array.isArray(parsed) ? parsed : null;
    } catch {
      acpTranscript = null;
    }
  }
  const chat = {
    id: row.id,
    workspaceId: row.workspace_id,
    page: row.page,
    projectId: row.project_id || "",
    title: row.title,
    model: row.model,
    sessionFile: row.session_file || "",
    harnessId: row.harness_id || "",
    acpSessionId: row.acp_session_id || "",
    acpTranscript,
    messageCount: row.message_count == null ? undefined : Number(row.message_count) || 0,
    hasAcp: Boolean(row.has_acp),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.acp_tail_at != null) chat.acpTranscriptTailAt = Number(row.acp_tail_at) || 0;
  return chat;
}

// The chat row without its transcript blob, for reads that never need the
// full session stream (lists, light reads, scope lookups).
const CHAT_COLUMNS =
  "id, workspace_id, page, project_id, title, model, session_file, harness_id, acp_session_id, created_at, updated_at";
// Newest numeric row time in the stored transcript, so a light read returns
// one number instead of the whole stream. The stored column answers when set;
// rows written before it existed fall back to scanning the JSON in SQLite.
const ACP_TAIL_AT =
  "COALESCE(acp_tail_at, " +
  "(SELECT MAX(json_extract(j.value, '$.at')) FROM json_each(CASE WHEN json_valid(acp_transcript) THEN " +
  "CASE WHEN json_type(acp_transcript) = 'array' THEN acp_transcript ELSE '[]' END ELSE '[]' END) j " +
  "WHERE json_type(j.value, '$.at') IN ('integer', 'real')), 0) AS acp_tail_at";

function transcriptTailAt(rows) {
  let tail = 0;
  for (const row of rows) if (row && Number.isFinite(row.at) && row.at > tail) tail = row.at;
  return tail;
}

const MESSAGES_SQL =
  "SELECT * FROM editor_chat_messages WHERE chat_id = ? ORDER BY sort_order ASC, created_at ASC, id ASC";
const INSERT_MESSAGE_SQL =
  "INSERT INTO editor_chat_messages (id, chat_id, role, text, attachments_json, created_at, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)";
const UPSERT_ACTIVE_SQL =
  "INSERT INTO editor_chat_active_v2 (workspace_id, page, project_id, chat_id, updated_at) VALUES (?, ?, ?, ?, ?) " +
  "ON CONFLICT(workspace_id, page, project_id) DO UPDATE SET chat_id = excluded.chat_id, updated_at = excluded.updated_at";

function mapChatMessage(row) {
  if (!row) return null;
  let attachments = null;
  if (row.attachments_json) {
    try {
      attachments = JSON.parse(row.attachments_json);
    } catch {
      attachments = null;
    }
  }
  return {
    id: row.id,
    chatId: row.chat_id,
    role: row.role,
    text: row.text,
    attachments,
    createdAt: row.created_at,
    sortOrder: row.sort_order,
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

// The built-in JV agent (editorpi) is gone. A chat that was locked to it
// keeps every message it had, unlocks so another agent can take it over, and
// gains one notice so the old thread explains why the agent stopped answering.
// Runs on every open and is idempotent: unlocking removes the chat from the
// next pass, and the notice is only inserted when it is not already there.
const LEGACY_AGENT_NOTICE =
  "The JV agent is no longer supported. Agents now run over ACP, and JV tools are added to them automatically. " +
  "Pick an agent from the ACP marketplace to continue this chat.";

function convertLegacyAgentChats(db) {
  const legacy = db.prepare("SELECT id FROM editor_chats WHERE harness_id = 'editorpi'").all();
  if (!legacy.length) return;
  const at = nowIso();
  const seen = db.prepare(
    "SELECT 1 AS found FROM editor_chat_messages WHERE chat_id = ? AND role = 'system' AND text = ? LIMIT 1",
  );
  const maxOrder = db.prepare("SELECT COALESCE(MAX(sort_order), 0) AS n FROM editor_chat_messages WHERE chat_id = ?");
  const insert = db.prepare(
    "INSERT INTO editor_chat_messages (id, chat_id, role, text, created_at, sort_order) VALUES (?, ?, 'system', ?, ?, ?)",
  );
  const unlock = db.prepare("UPDATE editor_chats SET harness_id = '' WHERE id = ?");
  for (const row of legacy) {
    if (!seen.get(row.id, LEGACY_AGENT_NOTICE)) {
      const next = Number(maxOrder.get(row.id).n || 0) + 1;
      insert.run(randomUUID(), row.id, LEGACY_AGENT_NOTICE, at, next);
    }
    unlock.run(row.id);
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
    const columns = db.prepare("PRAGMA table_info(editor_chats)").all();
    if (!columns.some((column) => column.name === "project_id")) {
      db.exec("ALTER TABLE editor_chats ADD COLUMN project_id TEXT NOT NULL DEFAULT '';");
    }
    if (!columns.some((column) => column.name === "session_file")) {
      // Path to the pi session JSONL that holds this chat's full model
      // context; agent restarts resume it.
      db.exec("ALTER TABLE editor_chats ADD COLUMN session_file TEXT;");
    }
    if (!columns.some((column) => column.name === "harness_id")) {
      // The agent a chat is bound to. Set once, on the first send; a locked
      // chat never switches agents (a Devin chat cannot become a Cursor chat).
      db.exec("ALTER TABLE editor_chats ADD COLUMN harness_id TEXT;");
      // Chats that already hold messages predate outside agents and ran on the
      // built-in agent, so they inherit its lock.
      db.exec(
        "UPDATE editor_chats SET harness_id = 'editorpi' WHERE EXISTS " +
          "(SELECT 1 FROM editor_chat_messages m WHERE m.chat_id = editor_chats.id)",
      );
    }
    if (!columns.some((column) => column.name === "acp_session_id")) {
      // The ACP sessionId the harness created for this chat; session/load can
      // resume it so reopening a chat restores real agent context.
      db.exec("ALTER TABLE editor_chats ADD COLUMN acp_session_id TEXT;");
    }
    if (!columns.some((column) => column.name === "acp_transcript")) {
      // Raw ACP transcript rows for the chat; the message table holds the
      // display copy, this holds the session stream exactly for restores.
      db.exec("ALTER TABLE editor_chats ADD COLUMN acp_transcript TEXT;");
    }
    if (!columns.some((column) => column.name === "acp_tail_at")) {
      // Newest row time in acp_transcript, written with it so a light read
      // never parses the blob. NULL means unknown: readers compute it.
      db.exec("ALTER TABLE editor_chats ADD COLUMN acp_tail_at REAL;");
    }
    convertLegacyAgentChats(db);
    // Databases written before project scoping keep the active pointer in
    // editor_chat_active (no project_id). Fold those rows into v2, taking the
    // chat row's own project id, so an upgrade never orphans the open chat.
    // OR IGNORE keeps an existing v2 pointer authoritative.
    db.exec(
      "INSERT OR IGNORE INTO editor_chat_active_v2 (workspace_id, page, project_id, chat_id, updated_at) " +
        "SELECT a.workspace_id, c.page, c.project_id, a.chat_id, a.updated_at " +
        "FROM editor_chat_active a JOIN editor_chats c ON c.id = a.chat_id",
    );
    // Cutline kept one chat per project and folded extras on every open, so
    // an imported Cutline database already has one. JV allows several
    // and never folds: folding deleted chats.
    db.exec("PRAGMA user_version = 1");
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

function serializeAttachments(item) {
  if (!item || typeof item !== "object") return null;
  const attachments = Array.isArray(item.attachments) ? item.attachments : undefined;
  const videoId = item.videoId != null ? String(item.videoId) : "";
  const thinking = item.thinking != null ? String(item.thinking) : "";
  // Tool-card rows carry their render state (args rows, output, timing,
  // subagent children) in `activity`; error rows carry the error card fields.
  const activity =
    item.activity && typeof item.activity === "object" && !Array.isArray(item.activity) ? item.activity : null;
  const error = item.error && typeof item.error === "object" && !Array.isArray(item.error) ? item.error : null;
  if (!attachments && !videoId && !thinking && !activity && !error) return null;
  const body = {
    attachments: attachments || [],
    videoId: videoId || undefined,
  };
  if (thinking) body.thinking = thinking;
  if (activity) body.activity = activity;
  if (error) body.error = error;
  return JSON.stringify(body);
}

function openEditorChatsStore(dataRoot) {
  const file = dbPath(dataRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = openDatabase(file);
  // Prepared statements live as long as the connection, keyed by SQL text.
  const stmts = new Map();

  function q(sql) {
    let stmt = stmts.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      stmts.set(sql, stmt);
    }
    return stmt;
  }

  function requireOpen() {
    if (!db.isOpen) throw new Error("Editor chat store is closed");
  }

  // opts.light reads the row without parsing the transcript blob.
  function chatRow(key, opts) {
    return mapChat(
      q(opts && opts.light ? "SELECT " + CHAT_COLUMNS + " FROM editor_chats WHERE id = ?" : "SELECT * FROM editor_chats WHERE id = ?").get(key),
    );
  }

  // opts.transcript === "tail" swaps the transcript for its newest row time
  // (chat.acpTranscriptTailAt); messages are always included.
  function getChat(id, opts) {
    requireOpen();
    const key = String(id == null ? "" : id);
    if (!key) return null;
    const tail = opts && opts.transcript === "tail";
    const chat = tail
      ? mapChat(q("SELECT " + CHAT_COLUMNS + ", " + ACP_TAIL_AT + " FROM editor_chats WHERE id = ?").get(key))
      : chatRow(key);
    if (!chat) return null;
    const messages = q(MESSAGES_SQL).all(key).map(mapChatMessage);
    return { chat, messages };
  }

  function listChats(opts) {
    requireOpen();
    const src = opts && typeof opts === "object" ? opts : {};
    const workspaceId = src.workspaceId != null ? requireWorkspaceId(src.workspaceId) : null;
    const page = src.page != null ? requirePage(src.page) : null;
    const projectId = src.projectId != null ? String(src.projectId) : null;
    const limit = limitValue(src);
    const clauses = [];
    const values = [];
    if (workspaceId) {
      clauses.push("workspace_id = ?");
      values.push(workspaceId);
    }
    if (page) {
      clauses.push("page = ?");
      values.push(page);
    }
    if (projectId != null) {
      clauses.push("project_id = ?");
      values.push(projectId);
    }
    const where = clauses.length ? " WHERE " + clauses.join(" AND ") : "";
    const sql =
      "SELECT " + CHAT_COLUMNS + ", " +
      "(SELECT COUNT(*) FROM editor_chat_messages m WHERE m.chat_id = editor_chats.id) AS message_count, " +
      // An ACP chat that connected but never messaged still owns session
      // data; list it so the thread is reachable from history. octet_length
      // reads only the stored size, so long transcripts are never loaded;
      // just the few short values are compared.
      "(CASE WHEN octet_length(acp_transcript) > 4 OR acp_transcript NOT IN ('', '[]', 'null') THEN 1 ELSE 0 END) AS has_acp " +
      "FROM editor_chats" + where + " ORDER BY updated_at DESC, id DESC" + (limit == null ? "" : " LIMIT ?");
    const rows = limit == null ? q(sql).all(...values) : q(sql).all(...values, limit);
    return rows.map(mapChat);
  }

  function createChat(input) {
    requireOpen();
    const src = input && typeof input === "object" ? input : {};
    const workspaceId = requireWorkspaceId(src.workspaceId);
    const page = requirePage(src.page);
    const projectId = String(src.projectId || "");
    const id = randomUUID();
    const createdAt = nowIso();
    const title = String(src.title || "New chat").trim() || "New chat";
    const model = optionalText(src.model);
    withTxn(db, () => {
      q(
        "INSERT INTO editor_chats (id, workspace_id, page, project_id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(id, workspaceId, page, projectId, title, model, createdAt, createdAt);
      q(UPSERT_ACTIVE_SQL).run(workspaceId, page, projectId, id, createdAt);
    });
    return getChat(id);
  }

  // opts.light returns the chat row without its transcript.
  function updateChat(id, patch, opts) {
    requireOpen();
    const key = String(id == null ? "" : id);
    if (!key) throw new Error("Chat not found: ");
    const src = patch && typeof patch === "object" ? patch : {};
    return withTxn(db, () => {
      const sets = [];
      const values = [];
      // forHarness names the agent the write comes from. After a handoff the
      // outgoing agent's late persist must not put its session id or stream
      // back over the chat the incoming agent now owns.
      let foreign = false;
      if (src.forHarness != null && (src.acpSessionId != null || src.acpTranscript != null)) {
        const bound = q("SELECT harness_id FROM editor_chats WHERE id = ?").get(key);
        const owner = String((bound && bound.harness_id) || "");
        foreign = Boolean(owner && String(src.forHarness || "") !== owner);
      }
      if (src.title != null) {
        sets.push("title = ?");
        values.push(String(src.title).trim() || "New chat");
      }
      if (src.model != null) {
        sets.push("model = ?");
        values.push(optionalText(src.model));
      }
      if (src.sessionFile != null) {
        sets.push("session_file = ?");
        values.push(optionalText(src.sessionFile));
      }
      if (src.acpSessionId != null && !foreign) {
        sets.push("acp_session_id = ?");
        values.push(optionalText(src.acpSessionId));
      }
      if (src.acpTranscript != null && !foreign) {
        const rows = Array.isArray(src.acpTranscript) ? src.acpTranscript : [];
        sets.push("acp_transcript = ?", "acp_tail_at = ?");
        values.push(JSON.stringify(rows), transcriptTailAt(rows));
      }
      // The agent lock is write-once: the first sender's harness sticks for the
      // life of the chat and a different agent id gets rejected instead of
      // silently rebinding the thread.
      if (src.harnessId != null) {
        const current = q("SELECT harness_id FROM editor_chats WHERE id = ?").get(key);
        if (!current) throw new Error("Chat not found: " + key);
        const existing = String(current.harness_id || "");
        const next = String(src.harnessId || "");
        if (existing && next && existing !== next) {
          throw new Error("This chat is locked to agent " + existing + ".");
        }
        if (next && next !== existing) {
          sets.push("harness_id = ?");
          values.push(next);
        }
      }
      if (!sets.length) return chatRow(key, opts);
      // Saving only an agent session id (it happens when a chat is opened)
      // is not a change to the conversation: the chat keeps its place in history.
      // Opening a chat also saves its stream with the agent's "session ready"
      // rows: that only moves the date when a person or the agent wrote
      // something newer than the chat's last change.
      let quiet = sets.every((set) => set === "acp_session_id = ?" || set === "acp_transcript = ?" || set === "acp_tail_at = ?");
      if (quiet && sets.some((set) => set === "acp_transcript = ?")) {
        const prior = q("SELECT updated_at FROM editor_chats WHERE id = ?").get(key);
        const since = prior ? Date.parse(prior.updated_at) || 0 : 0;
        const rows = Array.isArray(src.acpTranscript) ? src.acpTranscript : [];
        quiet = !rows.some((row) => row && (row.type === "user" || row.type === "agent" || row.type === "steps") && Number.isFinite(row.at) && row.at > since);
      }
      const sessionOnly = quiet;
      if (!sessionOnly) {
        sets.push("updated_at = ?");
        values.push(nowIso());
      }
      values.push(key);
      const result = q("UPDATE editor_chats SET " + sets.join(", ") + " WHERE id = ?").run(...values);
      if (!result.changes) throw new Error("Chat not found: " + key);
      return chatRow(key, opts);
    });
  }

  // The one way to rebind an agent-locked chat: a context handoff. The new
  // agent owns the chat from here, the old session id is dropped (another
  // agent cannot resume it), and a handoff row marks the switch so the next
  // session's first prompt carries the prior conversation. liveTranscript is
  // the outgoing session's in-memory stream, which can be ahead of the
  // debounced persist.
  function switchChatHarness(id, input) {
    requireOpen();
    const key = String(id == null ? "" : id);
    const src = input && typeof input === "object" ? input : {};
    const next = String(src.harnessId || "").trim();
    if (!next) throw new Error("harnessId is required");
    return withTxn(db, () => {
      const row = q("SELECT harness_id, acp_transcript FROM editor_chats WHERE id = ?").get(key);
      if (!row) throw new Error("Chat not found: " + key);
      const from = String(row.harness_id || "");
      if (from === next) return { chat: chatRow(key) };
      let rows = [];
      try {
        const parsed = row.acp_transcript ? JSON.parse(row.acp_transcript) : [];
        rows = Array.isArray(parsed) ? parsed : [];
      } catch {
        rows = [];
      }
      const live = Array.isArray(src.liveTranscript) ? src.liveTranscript.filter((item) => item && typeof item === "object") : [];
      if (live.length && transcriptTailAt(live) >= transcriptTailAt(rows)) rows = live.slice();
      if (from) {
        rows.push(handoffRow({
          from,
          to: next,
          fromName: src.fromName,
          toName: src.toName,
          at: Math.max(Date.now(), transcriptTailAt(rows) + 1),
        }));
      }
      q("UPDATE editor_chats SET harness_id = ?, acp_session_id = NULL, acp_transcript = ?, acp_tail_at = ?, updated_at = ? WHERE id = ?")
        .run(next, JSON.stringify(rows), transcriptTailAt(rows), nowIso(), key);
      return { chat: chatRow(key) };
    });
  }

  function appendChatMessage(input) {
    requireOpen();
    const src = input && typeof input === "object" ? input : {};
    const chatId = String(src.chatId == null ? "" : src.chatId);
    if (!chatId) throw new Error("chatId is required");
    const role = requireChatRole(src.role);
    const text = String(src.text == null ? "" : src.text);
    const attachmentsJson = serializeAttachments(src);
    const id = randomUUID();
    const createdAt = nowIso();
    return withTxn(db, () => {
      const chat = q("SELECT id, title, workspace_id, page, project_id FROM editor_chats WHERE id = ?").get(chatId);
      if (!chat) throw new Error("Chat not found: " + chatId);
      const row = q("SELECT COALESCE(MAX(sort_order), -1) AS max_order FROM editor_chat_messages WHERE chat_id = ?").get(chatId);
      const sortOrder = (row && row.max_order != null ? Number(row.max_order) : -1) + 1;
      q(INSERT_MESSAGE_SQL).run(id, chatId, role, text, attachmentsJson, createdAt, sortOrder);
      const title = chat.title === "New chat" && role === "user" ? chatTitleFromText(text) : chat.title;
      q("UPDATE editor_chats SET title = ?, updated_at = ? WHERE id = ?").run(title, createdAt, chatId);
      q(UPSERT_ACTIVE_SQL).run(chat.workspace_id, chat.page, chat.project_id || "", chatId, createdAt);
      return mapChatMessage(q("SELECT * FROM editor_chat_messages WHERE id = ?").get(id));
    });
  }

  // Rows are matched to the stored thread by position: unchanged rows are
  // left alone (id and created_at kept), edited rows update in place, new
  // tail rows insert, and stored rows past the new end are deleted. A save
  // that only grew the tail touches just those rows. opts.light returns
  // { ok, id, count } instead of re-reading the whole chat.
  function replaceChatMessages(chatId, messages, opts) {
    requireOpen();
    const key = String(chatId == null ? "" : chatId);
    if (!key) throw new Error("chatId is required");
    const list = Array.isArray(messages) ? messages : [];
    const createdAt = nowIso();
    return withTxn(db, () => {
      const chat = q("SELECT id, title, workspace_id, page, project_id FROM editor_chats WHERE id = ?").get(key);
      if (!chat) throw new Error("Chat not found: " + key);
      const rows = [];
      for (const item of list) {
        if (!item || typeof item !== "object") continue;
        rows.push({
          role: requireChatRole(item.role),
          text: String(item.text == null ? "" : item.text),
          attachmentsJson: serializeAttachments(item),
          // A message may carry the time it was first written.
          createdAt: typeof item.createdAt === "string" && Number.isFinite(Date.parse(item.createdAt)) ? item.createdAt : "",
        });
      }
      const count = rows.length;
      // One row past the new length is enough to know whether a tail exists
      // and where it starts; a bloated thread never loads its whole tail.
      const stored = q(
        "SELECT id, role, text, attachments_json, sort_order FROM editor_chat_messages WHERE chat_id = ? " +
          "ORDER BY sort_order ASC, created_at ASC, id ASC LIMIT ?",
      ).all(key, count + 1);
      // Kept rows end up holding 0..n-1, so a range delete is exact whenever
      // the dropped tail (sorted, so its first row is lowest) already sits at
      // n or above. Odd legacy orders collect the tail ids before rows move.
      const hasTail = stored.length > count;
      const rangeDelete = hasTail && Number(stored[count].sort_order) >= count;
      const dropIds =
        hasTail && !rangeDelete
          ? q(
              "SELECT id FROM editor_chat_messages WHERE chat_id = ? ORDER BY sort_order ASC, created_at ASC, id ASC LIMIT -1 OFFSET ?",
            ).all(key, count)
          : [];
      const insert = q(INSERT_MESSAGE_SQL);
      const update = q(
        "UPDATE editor_chat_messages SET role = ?, text = ?, attachments_json = ?, created_at = ?, sort_order = ? WHERE id = ?",
      );
      const reorder = q("UPDATE editor_chat_messages SET sort_order = ? WHERE id = ?");
      for (let i = 0; i < count; i += 1) {
        const row = rows[i];
        const prev = i < stored.length ? stored[i] : null;
        if (!prev) {
          insert.run(randomUUID(), key, row.role, row.text, row.attachmentsJson, row.createdAt || createdAt, i);
        } else if (prev.role !== row.role || prev.text !== row.text || (prev.attachments_json == null ? null : prev.attachments_json) !== row.attachmentsJson) {
          update.run(row.role, row.text, row.attachmentsJson, row.createdAt || createdAt, i, prev.id);
        } else if (Number(prev.sort_order) !== i) {
          reorder.run(i, prev.id);
        }
      }
      if (rangeDelete) q("DELETE FROM editor_chat_messages WHERE chat_id = ? AND sort_order >= ?").run(key, count);
      const drop = q("DELETE FROM editor_chat_messages WHERE id = ?");
      for (const row of dropIds) drop.run(row.id);
      let title = chat.title ? chat.title : "New chat";
      if (title === "New chat") {
        const firstUser = list.find((item) => item && item.role === "user");
        if (firstUser) title = chatTitleFromText(firstUser.text);
      }
      q("UPDATE editor_chats SET title = ?, updated_at = ? WHERE id = ?").run(title, createdAt, key);
      q(UPSERT_ACTIVE_SQL).run(chat.workspace_id, chat.page, chat.project_id || "", key, createdAt);
      return opts && opts.light ? { ok: true, id: key, count } : getChat(key);
    });
  }

  function deleteChat(id) {
    requireOpen();
    const key = String(id == null ? "" : id);
    if (!key) throw new Error("Chat not found: ");
    return withTxn(db, () => {
      const chat = q("SELECT workspace_id, page, project_id FROM editor_chats WHERE id = ?").get(key);
      const result = q("DELETE FROM editor_chats WHERE id = ?").run(key);
      if (!result.changes) throw new Error("Chat not found: " + key);
      if (chat) {
        const active = q(
          "SELECT chat_id FROM editor_chat_active_v2 WHERE workspace_id = ? AND page = ? AND project_id = ?",
        ).get(chat.workspace_id, chat.page, chat.project_id || "");
        if (active && active.chat_id === key) {
          q("DELETE FROM editor_chat_active_v2 WHERE workspace_id = ? AND page = ? AND project_id = ?").run(
            chat.workspace_id,
            chat.page,
            chat.project_id || "",
          );
        }
      }
      return { ok: true, id: key };
    });
  }

  function getActiveChat(workspaceId, page, projectId) {
    requireOpen();
    const ws = requireWorkspaceId(workspaceId);
    const pg = requirePage(page);
    const project = String(projectId || "");
    const row = q(
      "SELECT chat_id FROM editor_chat_active_v2 WHERE workspace_id = ? AND page = ? AND project_id = ?",
    ).get(ws, pg, project);
    if (row) {
      const record = getChat(row.chat_id);
      if (record) return record;
      // A pointer at a deleted chat must not hide the chats still on disk.
      q(
        "DELETE FROM editor_chat_active_v2 WHERE workspace_id = ? AND page = ? AND project_id = ?",
      ).run(ws, pg, project);
    }
    // No live pointer for this scope: adopt the most recent chat instead of
    // answering null, which the renderer reads as "create a new chat".
    const latest = q(
      "SELECT id FROM editor_chats WHERE workspace_id = ? AND page = ? AND project_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1",
    ).get(ws, pg, project);
    if (!latest) return null;
    q(UPSERT_ACTIVE_SQL).run(ws, pg, project, latest.id, nowIso());
    return getChat(latest.id);
  }

  function setActiveChat(id) {
    requireOpen();
    const key = String(id == null ? "" : id);
    if (!key) throw new Error("Chat not found: ");
    const chat = chatRow(key, { light: true });
    if (!chat) throw new Error("Chat not found: " + key);
    const updatedAt = nowIso();
    withTxn(db, () => {
      q(UPSERT_ACTIVE_SQL).run(chat.workspaceId, chat.page, chat.projectId || "", key, updatedAt);
    });
    return getChat(key);
  }

  function deleteChatsForProject(workspaceId, projectId) {
    requireOpen();
    const ws = requireWorkspaceId(workspaceId);
    const project = String(projectId || "").trim();
    if (!project) throw new Error("projectId is required");
    return withTxn(db, () => {
      const result = q("DELETE FROM editor_chats WHERE workspace_id = ? AND page = 'ai' AND project_id = ?").run(ws, project);
      return { ok: true, changes: Number(result.changes) || 0 };
    });
  }

  function close() {
    stmts.clear();
    if (db.isOpen) db.close();
  }

  function getAcpModelCache() {
    requireOpen();
    const rows = q("SELECT harness_id, models_json FROM acp_model_cache").all();
    const map = {};
    for (const row of rows) {
      try {
        map[row.harness_id] = JSON.parse(row.models_json);
      } catch {
        /* a torn row just misses the cache */
      }
    }
    return map;
  }

  // The model list an outside agent advertised last time it connected. The
  // launch composer and chats seed from it so the picker fills instantly
  // while the real session connects in the background.
  function setAcpModelCache(harnessId, models) {
    requireOpen();
    const id = String(harnessId || "").trim();
    if (!id || !models || typeof models !== "object" || Array.isArray(models)) return;
    q(
      "INSERT INTO acp_model_cache (harness_id, models_json, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(harness_id) DO UPDATE SET models_json = excluded.models_json, updated_at = excluded.updated_at",
    ).run(id, JSON.stringify(models), nowIso());
  }

  return {
    close,
    isOpen() {
      return db.isOpen;
    },
    dbPath() {
      return file;
    },
    listChats,
    getChat,
    createChat,
    updateChat,
    switchChatHarness,
    appendChatMessage,
    replaceChatMessages,
    deleteChat,
    getActiveChat,
    setActiveChat,
    deleteChatsForProject,
    getAcpModelCache,
    setAcpModelCache,
  };
}

module.exports = {
  dbPath,
  openEditorChatsStore,
  chatTitleFromText,
};
