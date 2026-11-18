"use strict";

// User-facing card template store: a SQLite database at
// <dataRoot>/card-templates.db holding templates installed from the built-in
// catalog (source "store") and templates saved from real cards (source
// "user"). card-templates.js merges these entries into listCardTemplates()/
// templatePatch() so installs and saved designs flow to the same picker and
// patch.template expansion.
//
// All calls are synchronous (DatabaseSync) like the rest of lib: the table is
// small and read on demand by IPC handlers and MCP tools.

const fs = require("fs");
const path = require("path");
// node:sqlite is only present on newer Node builds; resolve it lazily so
// loading this module does not crash processes that never touch the store.
let DatabaseSync = null;
function dbSyncCtor() {
  if (!DatabaseSync) ({ DatabaseSync } = require("node:sqlite"));
  return DatabaseSync;
}

const STORE_VERSION = 1;
const USER_CATEGORY = "My templates";
const BUSY_MS = 5000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS card_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  placement TEXT NOT NULL DEFAULT 'auto',
  duration_ms INTEGER NOT NULL DEFAULT 3000,
  card_json TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL CHECK (source IN ('store', 'user')),
  installed_at TEXT NOT NULL
);
`;

function storePath(dataRoot) {
  return path.join(String(dataRoot || ""), "card-templates.db");
}

const openDbs = new Map();
function dbFor(dataRoot) {
  const file = storePath(dataRoot);
  let db = openDbs.get(file);
  if (db) return db;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new (dbSyncCtor())(file);
  db.exec("PRAGMA busy_timeout = " + BUSY_MS);
  db.exec(SCHEMA);
  openDbs.set(file, db);
  return db;
}

// For app quit and tests that delete their data root (Windows keeps the file
// locked while a handle is open).
function closeCardTemplateStores() {
  for (const db of openDbs.values()) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
  openDbs.clear();
}

function rowToEntry(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description || "",
    category: row.category || "",
    placement: row.placement || "auto",
    durationMs: row.duration_ms,
    card: JSON.parse(row.card_json || "{}"),
    source: row.source,
    installedAt: row.installed_at,
  };
}

// The persisted shape used by card-templates.js merge: a versioned list of
// template entries including the card payload.
function readStore(dataRoot) {
  const rows = dbFor(dataRoot)
    .prepare("SELECT * FROM card_templates ORDER BY installed_at ASC, id ASC")
    .all();
  return { version: STORE_VERSION, templates: rows.map(rowToEntry) };
}

// Raw stored entries (including the card payload), for card-templates.js merge.
function readStoreEntries(dataRoot) {
  return readStore(dataRoot).templates;
}

// One-shot legacy migration: the pre-SQLite store was
// <dataRoot>/card-template-store.json. Import its entries once, then rename
// the file aside so it is not imported twice.
function migrateLegacyJson(dataRoot) {
  const legacy = path.join(String(dataRoot || ""), "card-template-store.json");
  let raw;
  try {
    raw = fs.readFileSync(legacy, "utf8");
  } catch {
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  const entries = parsed && Array.isArray(parsed.templates) ? parsed.templates : [];
  const db = dbFor(dataRoot);
  const insert = db.prepare(
    "INSERT OR IGNORE INTO card_templates" +
      " (id, name, description, category, placement, duration_ms, card_json, source, installed_at)" +
      " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const item of entries) {
    if (!item || !item.id) continue;
    insert.run(
      String(item.id),
      String(item.name || item.id),
      String(item.description || ""),
      String(item.category || ""),
      String(item.placement || "auto"),
      item.durationMs != null ? item.durationMs : 3000,
      JSON.stringify(item.card && typeof item.card === "object" ? item.card : {}),
      item.source === "user" ? "user" : "store",
      String(item.installedAt || new Date().toISOString()),
    );
  }
  try {
    fs.renameSync(legacy, legacy + ".migrated");
  } catch {
    /* a leftover import file is harmless */
  }
}

function storeEntrySummary(entry, source, installed) {
  const colors = entry.card && entry.card.colors ? entry.card.colors : null;
  return {
    id: entry.id,
    name: entry.name || entry.id,
    category: entry.category || "",
    description: entry.description || "",
    placement: entry.placement || "auto",
    durationMs: entry.durationMs != null ? entry.durationMs : 3000,
    colors: colors || undefined,
    installed: Boolean(installed),
    source,
  };
}

// Built-in catalog + store rows, deduped by id. A stored copy (install or user
// save) shadows its builtin so the merged list reports source store|user and
// installed:true for it; builtins not in the store stay source "builtin".
function listStoreTemplates(dataRoot) {
  migrateLegacyJson(dataRoot);
  const { TEMPLATES } = require("./card-templates");
  const stored = readStoreEntries(dataRoot);
  const storedIds = new Set(stored.map((entry) => entry.id));
  const out = [];
  for (const item of TEMPLATES) {
    if (storedIds.has(item.id)) continue;
    out.push(storeEntrySummary(item, "builtin", false));
  }
  for (const entry of stored) {
    out.push(storeEntrySummary(entry, entry.source === "user" ? "user" : "store", true));
  }
  return out;
}

function listStoreCategories(dataRoot) {
  const seen = new Set();
  const categories = [];
  for (const item of listStoreTemplates(dataRoot)) {
    const category = item.category || "";
    if (seen.has(category)) continue;
    seen.add(category);
    categories.push(category);
  }
  return categories;
}

function insertEntry(dataRoot, entry) {
  dbFor(dataRoot)
    .prepare(
      "INSERT INTO card_templates" +
        " (id, name, description, category, placement, duration_ms, card_json, source, installed_at)" +
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      entry.id,
      entry.name,
      entry.description,
      entry.category,
      entry.placement,
      entry.durationMs,
      JSON.stringify(entry.card || {}),
      entry.source,
      entry.installedAt,
    );
}

// Copy a catalog template into the store. Idempotent: an id already in the
// store returns its existing entry.
function installTemplate(dataRoot, id) {
  migrateLegacyJson(dataRoot);
  const row = dbFor(dataRoot)
    .prepare("SELECT * FROM card_templates WHERE id = ?")
    .get(String(id));
  if (row) {
    const existing = rowToEntry(row);
    return storeEntrySummary(existing, existing.source === "user" ? "user" : "store", true);
  }
  const { findTemplate } = require("./card-templates");
  const found = findTemplate(id);
  if (!found) throw new Error("Unknown template id: " + id);
  const entry = {
    id: found.id,
    name: found.name,
    description: found.description || "",
    category: found.category || "",
    placement: found.placement || "auto",
    durationMs: found.durationMs != null ? found.durationMs : 3000,
    card: JSON.parse(JSON.stringify(found.card)),
    source: "store",
    installedAt: new Date().toISOString(),
  };
  insertEntry(dataRoot, entry);
  return storeEntrySummary(entry, "store", true);
}

function slugify(name) {
  const slug = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "card";
}

function uniqueUserId(dataRoot, name) {
  const { findAnyTemplate } = require("./card-templates");
  const base = "user-" + slugify(name);
  let id = base;
  let n = 2;
  while (findAnyTemplate(id, dataRoot)) {
    id = base + "-" + n;
    n += 1;
  }
  return id;
}

// Snapshot a saved card's design into a reusable user template.
function saveCardAsTemplate(dataRoot, card) {
  if (!card || typeof card !== "object") throw new Error("card is required");
  const entry = {
    id: uniqueUserId(dataRoot, card.name),
    name: String(card.name || "Untitled card").trim() || "Untitled card",
    description: String(card.description || "").slice(0, 500),
    category: USER_CATEGORY,
    placement: card.placement || "auto",
    durationMs: card.durationMs != null ? card.durationMs : 3000,
    card: {
      name: String(card.name || "Untitled card").trim() || "Untitled card",
      kind: card.kind || "title_card",
      colors: card.colors ? JSON.parse(JSON.stringify(card.colors)) : undefined,
      composition: card.composition ? JSON.parse(JSON.stringify(card.composition)) : undefined,
    },
    source: "user",
    installedAt: new Date().toISOString(),
  };
  insertEntry(dataRoot, entry);
  return storeEntrySummary(entry, "user", true);
}

module.exports = {
  STORE_VERSION,
  USER_CATEGORY,
  storePath,
  readStore,
  readStoreEntries,
  listStoreTemplates,
  listStoreCategories,
  installTemplate,
  saveCardAsTemplate,
  closeCardTemplateStores,
};
