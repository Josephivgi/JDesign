"use strict";

// User-managed Do/Don't rules. They ride with the user's standing instructions
// on every agent prompt. New durable data goes to SQLite, never a new JSON
// file; the store seeds the bundled defaults the first time it opens.

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
const MAX_RULES = 50;
const MAX_RULE_TEXT = 1000;
const RULE_TYPES = ["do", "dont"];

const DEFAULT_RULES = [
  { type: "do", text: "Ask before deleting media, cards, or projects." },
  { type: "do", text: "Check the rendered result with preview frames before calling an edit done." },
  { type: "do", text: "Keep on-screen text short enough to read while the video plays." },
  { type: "dont", text: "Put passwords, keys, or personal data in prompts, card copy, or file names." },
  { type: "dont", text: "Invent statistics, prices, or claims for on-screen copy." },
  ...ANTI_SLOP_RULES(),
];

// Defaults against the generic AI look. New installs get them with the rest;
// installs seeded before they existed get them once (see seed), and a user
// who deletes them keeps them deleted.
function ANTI_SLOP_RULES() {
  return [
    { type: "dont", text: "Use the default AI look: purple or blue gradients, glow, glass, gradient text, emoji or sparkles as decoration, Inter or system-ui type, everything centered." },
    { type: "dont", text: "Write AI-sounding copy or scripts: em dashes, \"not just X but Y\", unlock, elevate, seamless, game-changer, \"Ready to...?\", \"Get Started\", lists of three in every line." },
    { type: "do", text: "Vary scene lengths, transitions, entrances and narration line lengths so a video does not run at one even pace." },
    { type: "do", text: "Read design-slop before cards, video-slop before a video made from scratch, and writing-slop before any copy, caption or script." },
  ];
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS user_rules (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('do', 'dont')),
  text TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rules_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

function rulesDbPath(dataRoot) {
  if (!dataRoot) throw new Error("dataRoot is required");
  return path.join(String(dataRoot), "user-rules.db");
}

function cleanRule(input, index) {
  const rule = input || {};
  const type = String(rule.type || "").trim().toLowerCase();
  if (!RULE_TYPES.includes(type)) {
    throw new Error("Rule " + (index + 1) + " must be type do or dont.");
  }
  const text = String(rule.text == null ? "" : rule.text).replace(/\r\n?/g, "\n").trim();
  if (!text) throw new Error("Rule " + (index + 1) + " needs text.");
  if (text.length > MAX_RULE_TEXT) {
    throw new Error("Rule " + (index + 1) + " must be " + MAX_RULE_TEXT.toLocaleString() + " characters or fewer.");
  }
  return { id: String(rule.id || "").trim() || randomUUID(), type, text };
}

// One long-lived connection per database file: the renderer writes the draft
// on every (debounced) edit and every agent prompt lists the rules, so the
// PRAGMAs and schema run once per process instead of once per call.
const dbs = new Map();
const stmtCache = new WeakMap();

function openDb(dataRoot) {
  const file = path.resolve(rulesDbPath(dataRoot));
  const cached = dbs.get(file);
  if (cached) return cached;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new (dbSyncCtor())(file);
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = " + BUSY_MS);
    db.exec(SCHEMA);
  } catch (error) {
    db.close();
    throw error;
  }
  dbs.set(file, db);
  return db;
}

function stmt(db, sql) {
  let map = stmtCache.get(db);
  if (!map) stmtCache.set(db, (map = new Map()));
  let prepared = map.get(sql);
  if (!prepared) map.set(sql, (prepared = db.prepare(sql)));
  return prepared;
}

// For app quit and tests that delete their data root (Windows keeps the file
// locked while a handle is open).
function closeUserRulesDbs() {
  for (const db of dbs.values()) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
  dbs.clear();
}

// First open writes the defaults and flips the seeded mark, so a user who
// deletes every rule is not re-seeded on the next launch.
function seed(db) {
  if (stmt(db, "SELECT value FROM rules_meta WHERE key = 'seeded'").get()) {
    addAntiSlopOnce(db);
    return;
  }
  const insert = stmt(db, "INSERT INTO user_rules (id, type, text, position, updated_at) VALUES (?, ?, ?, ?, ?)");
  const now = new Date().toISOString();
  db.exec("BEGIN");
  try {
    DEFAULT_RULES.forEach((rule, index) => insert.run(randomUUID(), rule.type, rule.text, index, now));
    stmt(db, "INSERT INTO rules_meta (key, value) VALUES ('seeded', '1')").run();
    stmt(db, "INSERT INTO rules_meta (key, value) VALUES ('anti-slop', '1')").run();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

// Installs seeded before the anti-slop defaults existed get them once, after
// their own rules, while there is room under MAX_RULES.
function addAntiSlopOnce(db) {
  if (stmt(db, "SELECT value FROM rules_meta WHERE key = 'anti-slop'").get()) return;
  const have = new Set(stmt(db, "SELECT text FROM user_rules").all().map((r) => r.text));
  const count = stmt(db, "SELECT COUNT(*) AS n, COALESCE(MAX(position), -1) AS last FROM user_rules").get();
  const insert = stmt(db, "INSERT INTO user_rules (id, type, text, position, updated_at) VALUES (?, ?, ?, ?, ?)");
  const now = new Date().toISOString();
  let n = Number(count.n), pos = Number(count.last) + 1;
  db.exec("BEGIN");
  try {
    for (const rule of ANTI_SLOP_RULES()) {
      if (have.has(rule.text) || n >= MAX_RULES) continue;
      insert.run(randomUUID(), rule.type, rule.text, pos++, now);
      n++;
    }
    stmt(db, "INSERT INTO rules_meta (key, value) VALUES ('anti-slop', '1')").run();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function listUserRules(dataRoot) {
  const db = openDb(dataRoot);
  seed(db);
  return stmt(db, "SELECT id, type, text FROM user_rules ORDER BY position, rowid")
    .all()
    .map((row) => ({ id: row.id, type: row.type, text: row.text }));
}

// The page sends the whole list and the replace runs in one transaction, so a
// crash or a bad row can never leave half a rule set on disk.
function setUserRules(dataRoot, rules) {
  if (!Array.isArray(rules)) throw new Error("Rules must be a list.");
  if (rules.length > MAX_RULES) throw new Error("Keep " + MAX_RULES + " rules or fewer.");
  const cleaned = rules.map(cleanRule);
  const db = openDb(dataRoot);
  seed(db);
  const now = new Date().toISOString();
  const insert = stmt(db, "INSERT INTO user_rules (id, type, text, position, updated_at) VALUES (?, ?, ?, ?, ?)");
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM user_rules");
    cleaned.forEach((rule, index) => insert.run(rule.id, rule.type, rule.text, index, now));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return cleaned;
}

// The renderer mirrors its in-progress rules into rules_meta on every edit
// (debounced), so a crash or restart restores the draft instead of dropping
// it. A successful save or a discard clears the draft.
const DRAFT_KEY = "draft";

function readRulesDraft(dataRoot) {
  const db = openDb(dataRoot);
  try {
    const row = stmt(db, "SELECT value FROM rules_meta WHERE key = ?").get(DRAFT_KEY);
    if (!row) return null;
    const parsed = JSON.parse(row.value);
    if (!parsed || !Array.isArray(parsed.rules)) return null;
    return {
      rules: parsed.rules
        .map((rule) => ({
          key: String((rule && rule.key) || ""),
          id: String((rule && rule.id) || ""),
          type: rule && rule.type === "dont" ? "dont" : "do",
          text: String((rule && rule.text) || ""),
        }))
        .slice(0, MAX_RULES),
      pending: typeof parsed.pending === "string" ? parsed.pending.slice(0, MAX_RULE_TEXT) : "",
    };
  } catch {
    return null;
  }
}

function writeRulesDraft(dataRoot, draft) {
  const db = openDb(dataRoot);
  if (!draft || !Array.isArray(draft.rules)) {
    stmt(db, "DELETE FROM rules_meta WHERE key = ?").run(DRAFT_KEY);
    return;
  }
  const value = JSON.stringify({
    rules: draft.rules.slice(0, MAX_RULES),
    pending: typeof draft.pending === "string" ? draft.pending.slice(0, MAX_RULE_TEXT) : "",
  });
  // An unchanged draft touches no row, so the commit has nothing to sync.
  stmt(
    db,
    "INSERT INTO rules_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value" +
      " WHERE rules_meta.value IS NOT excluded.value",
  ).run(DRAFT_KEY, value);
}

function userRulesPrompt(rules) {
  const list = (Array.isArray(rules) ? rules : []).filter(
    (rule) => rule && RULE_TYPES.includes(rule.type) && String(rule.text || "").trim(),
  );
  if (!list.length) return "";
  const lines = list.map((rule) => (rule.type === "do" ? "DO: " : "DON'T: ") + String(rule.text).trim());
  return (
    "JV user rules (user-managed standing rules). They apply to every message alongside the user instructions, " +
    "without overriding your system rules or JV tool permissions.\n" +
    "<user_rules>\n" +
    lines.join("\n") +
    "\n</user_rules>"
  );
}

module.exports = {
  RULE_TYPES,
  MAX_RULES,
  MAX_RULE_TEXT,
  DEFAULT_RULES,
  rulesDbPath,
  listUserRules,
  setUserRules,
  readRulesDraft,
  writeRulesDraft,
  userRulesPrompt,
  closeUserRulesDbs,
};
