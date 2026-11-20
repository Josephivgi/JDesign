// Drawings live in SQLite (node:sqlite, built into Electron). The main
// process owns every open drawing: the window and the agent tools both send
// edits here, and every change is broadcast back to the window.
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const G = require("../renderer/js/geom.js");

const HISTORY_LIMIT = 150;

class DrawingStore {
  constructor(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, "jdraw.db"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS drawings (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        doc TEXT NOT NULL,
        thumb TEXT,
        created INTEGER NOT NULL,
        updated INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chat_threads (
        id TEXT PRIMARY KEY,
        drawing_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT 'New chat',
        agent TEXT,
        model TEXT,
        acp_session_id TEXT,
        messages TEXT NOT NULL DEFAULT '[]',
        created INTEGER NOT NULL,
        updated INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chat_threads_drawing ON chat_threads(drawing_id, updated DESC);
      CREATE TABLE IF NOT EXISTS prefs (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    if (!this.db.prepare("PRAGMA table_info(drawings)").all().some((c) => c.name === "active_chat_id")) {
      // The chat a drawing shows when it opens; one row in chat_threads.
      this.db.exec("ALTER TABLE drawings ADD COLUMN active_chat_id TEXT");
    }
    if (!this.db.prepare("PRAGMA table_info(drawings)").all().some((c) => c.name === "project_id")) {
      // The video project a drawing belongs to. Loose drawings from before
      // the unified Projects page have none; main migrates them.
      this.db.exec("ALTER TABLE drawings ADD COLUMN project_id TEXT");
    }
    if (!this.db.prepare("PRAGMA table_info(chat_threads)").all().some((c) => c.name === "jv_chat_id")) {
      // The project chat a legacy Draw chat was copied into (set once).
      this.db.exec("ALTER TABLE chat_threads ADD COLUMN jv_chat_id TEXT");
    }
    this.migrateChats();
    this.open = new Map(); // id -> { doc, undo: [], redo: [], dirty, timer }
    this.listeners = new Set();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(id, origin, extra) {
    const entry = this.open.get(id);
    if (!entry) return;
    const info = { id, doc: entry.doc, origin, canUndo: entry.undo.length > 0, canRedo: entry.redo.length > 0, ...(extra || {}) };
    for (const fn of this.listeners) {
      try { fn(info); } catch (err) { console.error("[store] listener", err); }
    }
  }

  // ---- prefs
  getPref(key, fallback) {
    const row = this.db.prepare("SELECT value FROM prefs WHERE key = ?").get(key);
    if (!row) return fallback;
    try { return JSON.parse(row.value); } catch { return fallback; }
  }

  setPref(key, value) {
    this.db.prepare("INSERT INTO prefs (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
  }

  // ---- drawings
  list() {
    return this.db.prepare("SELECT id, name, thumb, created, updated, project_id AS projectId FROM drawings ORDER BY updated DESC").all();
  }

  // The drawings one project holds, for its artifact tabs and card counts.
  listByProject(projectId) {
    return this.db.prepare("SELECT id, name, thumb, created, updated FROM drawings WHERE project_id = ? ORDER BY updated DESC").all(String(projectId || ""));
  }

  projectOf(id) {
    const row = this.db.prepare("SELECT project_id FROM drawings WHERE id = ?").get(String(id || ""));
    return row ? row.project_id || "" : "";
  }

  setProject(id, projectId) {
    this.db.prepare("UPDATE drawings SET project_id = ? WHERE id = ?").run(String(projectId || ""), String(id || ""));
  }

  // Saved before the Projects page existed: no project owns them yet.
  looseDrawings() {
    return this.db.prepare("SELECT id, name, thumb, created, updated FROM drawings WHERE project_id IS NULL OR project_id = '' ORDER BY updated DESC").all();
  }

  create(opts) {
    const o = opts || {};
    const id = G.uid("d");
    const doc = G.newDoc(o);
    const name = String(o.name || "Untitled drawing").slice(0, 120);
    const now = Date.now();
    this.db.prepare("INSERT INTO drawings (id, name, doc, thumb, created, updated, project_id) VALUES (?, ?, ?, NULL, ?, ?, ?)").run(id, name, JSON.stringify(doc), now, now, String(o.projectId || ""));
    return { id, name, created: now, updated: now, projectId: String(o.projectId || "") };
  }

  rename(id, name) {
    const clean = String(name || "").trim().slice(0, 120) || "Untitled drawing";
    this.db.prepare("UPDATE drawings SET name = ?, updated = ? WHERE id = ?").run(clean, Date.now(), id);
    return clean;
  }

  remove(id) {
    this.close(id);
    this.db.prepare("DELETE FROM drawings WHERE id = ?").run(id);
    this.db.prepare("DELETE FROM chat_threads WHERE drawing_id = ?").run(id);
  }

  duplicate(id) {
    const row = this.db.prepare("SELECT * FROM drawings WHERE id = ?").get(id);
    if (!row) throw new Error("That drawing no longer exists.");
    const entry = this.open.get(id);
    const doc = entry ? JSON.stringify(entry.doc) : row.doc;
    const nid = G.uid("d");
    const now = Date.now();
    this.db.prepare("INSERT INTO drawings (id, name, doc, thumb, created, updated) VALUES (?, ?, ?, ?, ?, ?)").run(nid, row.name + " copy", doc, row.thumb, now, now);
    return nid;
  }

  meta(id) {
    return this.db.prepare("SELECT id, name, created, updated FROM drawings WHERE id = ?").get(id) || null;
  }

  load(id) {
    let entry = this.open.get(id);
    if (entry) return entry;
    const row = this.db.prepare("SELECT doc FROM drawings WHERE id = ?").get(id);
    if (!row) throw new Error("That drawing no longer exists.");
    entry = { doc: JSON.parse(row.doc), undo: [], redo: [], timer: null };
    this.open.set(id, entry);
    return entry;
  }

  getDoc(id) {
    return this.load(id).doc;
  }

  saveNow(id) {
    const entry = this.open.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.timer = null;
    this.db.prepare("UPDATE drawings SET doc = ?, updated = ? WHERE id = ?").run(JSON.stringify(entry.doc), Date.now(), id);
  }

  scheduleSave(id) {
    const entry = this.open.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.saveNow(id), 400);
  }

  close(id) {
    if (!this.open.has(id)) return;
    this.saveNow(id);
    this.open.delete(id);
  }

  closeAll() {
    for (const id of [...this.open.keys()]) this.close(id);
  }

  setThumb(id, dataUrl) {
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) return;
    this.db.prepare("UPDATE drawings SET thumb = ? WHERE id = ?").run(dataUrl, id);
  }

  // A checkpoint is a snapshot the person can go back to with one press,
  // used for "Undo AI changes".
  checkpoint(id) {
    return JSON.stringify(this.load(id).doc);
  }

  restore(id, snapshot, origin) {
    const entry = this.load(id);
    entry.undo.push(JSON.stringify(entry.doc));
    if (entry.undo.length > HISTORY_LIMIT) entry.undo.shift();
    entry.redo = [];
    entry.doc = JSON.parse(snapshot);
    this.scheduleSave(id);
    this.emit(id, origin || "restore");
  }

  undo(id) {
    const entry = this.load(id);
    if (!entry.undo.length) return false;
    entry.redo.push(JSON.stringify(entry.doc));
    entry.doc = JSON.parse(entry.undo.pop());
    this.scheduleSave(id);
    this.emit(id, "undo");
    return true;
  }

  redo(id) {
    const entry = this.load(id);
    if (!entry.redo.length) return false;
    entry.undo.push(JSON.stringify(entry.doc));
    entry.doc = JSON.parse(entry.redo.pop());
    this.scheduleSave(id);
    this.emit(id, "redo");
    return true;
  }

  // Applies a list of edits as one undo step. Returns per-op results (new
  // ids and so on). Throws before changing anything if an op is invalid.
  apply(id, ops, origin) {
    const entry = this.load(id);
    const before = JSON.stringify(entry.doc);
    const doc = JSON.parse(before);
    const results = [];
    for (const op of ops) results.push(applyOp(doc, op));
    entry.undo.push(before);
    if (entry.undo.length > HISTORY_LIMIT) entry.undo.shift();
    entry.redo = [];
    entry.doc = doc;
    this.scheduleSave(id);
    this.emit(id, origin || "user", { ops: ops.map((o) => o.op) });
    return results;
  }

  // ---- chats
  // A drawing keeps a list of chat threads; one is active. Old chats stay in
  // history and reopen with their transcript (and their agent session when the
  // agent still has it).
  migrateChats() {
    const hasLegacy = this.db.prepare("SELECT 1 AS yes FROM sqlite_master WHERE type='table' AND name='chats'").get();
    if (!hasLegacy) return;
    const ins = this.db.prepare(
      "INSERT INTO chat_threads (id, drawing_id, title, agent, model, messages, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const act = this.db.prepare("UPDATE drawings SET active_chat_id = ? WHERE id = ? AND (active_chat_id IS NULL OR active_chat_id = '')");
    this.db.exec("BEGIN");
    try {
    for (const row of this.db.prepare("SELECT * FROM chats").all()) {
      const id = G.uid("c");
      let title = "New chat";
      try {
        const first = (JSON.parse(row.messages || "[]") || []).find((m) => m && m.role === "user" && m.text);
        if (first) title = titleFor(first.text);
      } catch {}
      ins.run(id, row.drawing_id, title, row.agent || null, row.model || null, row.messages || "[]", row.updated, row.updated);
      act.run(id, row.drawing_id);
    }
    this.db.exec("DROP TABLE chats");
    this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  mapChat(row) {
    if (!row) return null;
    let messages = [];
    try { messages = JSON.parse(row.messages || "[]") || []; } catch {}
    return {
      id: row.id,
      drawingId: row.drawing_id,
      title: row.title || "New chat",
      agent: row.agent || null,
      model: row.model || null,
      acpSessionId: row.acp_session_id || "",
      messages,
      created: row.created,
      updated: row.updated,
    };
  }

  chatById(chatId) {
    return this.mapChat(this.db.prepare("SELECT * FROM chat_threads WHERE id = ?").get(String(chatId || "")));
  }

  // The drawing's active chat. A drawing always has one, so the panel never
  // shows a blank state: the first open creates it.
  getChat(drawingId) {
    const row = this.db.prepare("SELECT active_chat_id FROM drawings WHERE id = ?").get(drawingId);
    let chat = row && row.active_chat_id ? this.chatById(row.active_chat_id) : null;
    if (!chat) {
      chat = this.mapChat(this.db.prepare("SELECT * FROM chat_threads WHERE drawing_id = ? ORDER BY updated DESC LIMIT 1").get(drawingId));
    }
    if (!chat) chat = this.createChat(drawingId, {});
    return chat;
  }

  // Rows for the chat menu, without the message blobs.
  chatList(drawingId) {
    return this.db
      .prepare("SELECT id, title, agent, updated, json_array_length(messages) AS messageCount FROM chat_threads WHERE drawing_id = ? ORDER BY updated DESC, id DESC")
      .all(drawingId);
  }

  // Every chat across drawings, for the history lists on both Home pages.
  setJvChat(chatId, jvChatId) {
    this.db.prepare("UPDATE chat_threads SET jv_chat_id = ? WHERE id = ?").run(String(jvChatId || ""), String(chatId || ""));
  }

  allChats() {
    return this.db
      .prepare(
        "SELECT c.id, c.drawing_id AS drawingId, c.title, c.agent, c.updated, json_array_length(c.messages) AS messageCount, c.jv_chat_id AS jvChatId, d.name AS drawingName " +
          "FROM chat_threads c JOIN drawings d ON d.id = c.drawing_id WHERE c.messages != '[]' ORDER BY c.updated DESC, c.id DESC",
      )
      .all();
  }

  createChat(drawingId, opts) {
    const o = opts || {};
    const id = G.uid("c");
    const now = Date.now();
    const title = String(o.title || "New chat").trim() || "New chat";
    this.db.prepare("BEGIN").run();
    try {
      this.db
        .prepare("INSERT INTO chat_threads (id, drawing_id, title, agent, model, messages, created, updated) VALUES (?, ?, ?, ?, ?, '[]', ?, ?)")
        .run(id, drawingId, title, o.agent || null, o.model || null, now, now);
      this.db.prepare("UPDATE drawings SET active_chat_id = ? WHERE id = ?").run(id, drawingId);
      this.db.prepare("COMMIT").run();
    } catch (err) {
      this.db.prepare("ROLLBACK").run();
      throw err;
    }
    return this.chatById(id);
  }

  updateChat(chatId, patch) {
    const o = patch || {};
    const sets = [];
    const values = [];
    if (o.title !== undefined) { sets.push("title = ?"); values.push(String(o.title || "").trim().slice(0, 120) || "New chat"); }
    if (o.agent !== undefined) { sets.push("agent = ?"); values.push(o.agent || null); }
    if (o.model !== undefined) { sets.push("model = ?"); values.push(o.model || null); }
    if (o.acpSessionId !== undefined) { sets.push("acp_session_id = ?"); values.push(o.acpSessionId || ""); }
    if (!sets.length) return;
    this.db.prepare("UPDATE chat_threads SET " + sets.join(", ") + " WHERE id = ?").run(...values, chatId);
  }

  setActiveChat(drawingId, chatId) {
    this.db.prepare("UPDATE drawings SET active_chat_id = ? WHERE id = ?").run(chatId, drawingId);
  }

  deleteChat(chatId) {
    const row = this.db.prepare("SELECT drawing_id FROM chat_threads WHERE id = ?").get(chatId);
    if (!row) return;
    this.db.prepare("DELETE FROM chat_threads WHERE id = ?").run(chatId);
    const active = this.db.prepare("SELECT active_chat_id FROM drawings WHERE id = ?").get(row.drawing_id);
    if (active && active.active_chat_id === chatId) {
      const next = this.db.prepare("SELECT id FROM chat_threads WHERE drawing_id = ? ORDER BY updated DESC LIMIT 1").get(row.drawing_id);
      this.db.prepare("UPDATE drawings SET active_chat_id = ? WHERE id = ?").run(next ? next.id : null, row.drawing_id);
    }
  }

  saveChat(chat) {
    const messages = JSON.stringify((chat.messages || []).slice(-200));
    this.db.prepare("UPDATE chat_threads SET agent = ?, model = ?, messages = ?, updated = ? WHERE id = ?")
      .run(chat.agent || null, chat.model || null, messages, Date.now(), chat.id);
  }
}

// The first user line becomes the chat's name, trimmed to a short clause.
function titleFor(text) {
  const line = String(text || "").split("\n")[0].replace(/\s+/g, " ").trim().replace(/^\/[a-z0-9-]+\s*/i, "");
  if (!line) return "New chat";
  const cut = line.slice(0, 60);
  return (cut.length < line.length ? cut.replace(/[\s,:;.!\-]+$/, "") + "..." : cut).replace(/^./, (c) => c.toUpperCase());
}

function layerOf(doc, layerId, create) {
  if (layerId) {
    const l = doc.layers.find((x) => x.id === layerId || x.name.toLowerCase() === String(layerId).toLowerCase());
    if (l) return l;
    if (create) {
      const nl = { id: G.uid("L"), name: String(layerId).slice(0, 60), visible: true, opacity: 1, items: [] };
      doc.layers.push(nl);
      return nl;
    }
    throw new Error(`No layer named "${layerId}".`);
  }
  // New drawing never lands on the artist-finish paper layer.
  const open = doc.layers.filter((l) => !l.paper && l.name !== "JDraw paper");
  return open.length ? open[open.length - 1] : doc.layers[doc.layers.length - 1];
}

const ITEM_PATCH_KEYS = ["fill", "stroke", "strokeWidth", "color", "size", "brush", "opacity", "rotation", "shadow", "blend", "name", "x", "y", "w", "h", "x1", "y1", "x2", "y2", "radius", "text", "font", "weight", "align", "points", "d", "scale", "closed", "smooth", "src", "flipX", "flipY", "dash", "arrowStart", "arrowEnd", "group"];

function foundAll(doc, ids) {
  return (ids || []).map((id) => {
    const f = G.findItem(doc, id);
    if (!f) throw new Error(`No item with id ${id}.`);
    return f;
  });
}

// Writes changed items back in place.
function putBack(found, items) {
  found.forEach((f, i) => { f.layer.items[f.layer.items.indexOf(f.item)] = items[i]; });
}

function applyOp(doc, op) {
  switch (op && op.op) {
    case "add_items": {
      let layer;
      if (op.newLayer) {
        layer = { id: G.uid("L"), name: String(op.newLayer).slice(0, 60), visible: true, opacity: 1, items: [] };
        const at = Number.isInteger(op.layerIndex) ? G.clamp(op.layerIndex, 0, doc.layers.length) : doc.layers.length;
        doc.layers.splice(at, 0, layer);
      } else layer = layerOf(doc, op.layerId, true);
      const items = (op.items || []).map(G.normItem);
      if (!items.length) throw new Error("Nothing to add.");
      const existing = new Set(doc.layers.flatMap((l) => l.items.map((i) => i.id)));
      for (const it of items) if (existing.has(it.id)) it.id = G.uid(it.type[0]);
      if (op.position === "bottom") layer.items.unshift(...items);
      else layer.items.push(...items);
      return { layerId: layer.id, ids: items.map((i) => i.id) };
    }
    case "update_items": {
      const changed = [];
      for (const id of op.ids || []) {
        const found = G.findItem(doc, id);
        if (!found) throw new Error(`No item with id ${id}.`);
        const merged = Object.assign({}, found.item);
        for (const k of ITEM_PATCH_KEYS) if (op.patch && op.patch[k] !== undefined) merged[k] = op.patch[k];
        if (op.patch && op.patch.shadow === null) delete merged.shadow;
        found.layer.items[found.index] = G.normItem(merged);
        changed.push(id);
      }
      return { ids: changed };
    }
    case "move_items": {
      for (const id of op.ids || []) {
        const found = G.findItem(doc, id);
        if (!found) throw new Error(`No item with id ${id}.`);
        let it = found.item;
        if (op.scale && op.scale !== 1) {
          const b = G.bounds(it);
          const ox = op.originX ?? b.x + b.w / 2;
          const oy = op.originY ?? b.y + b.h / 2;
          it = G.scaleItem(it, op.scale, ox, oy);
        }
        if (op.dx || op.dy) it = G.moveItem(it, op.dx || 0, op.dy || 0);
        if (op.rotate) it = G.rotateItem(it, Number(op.rotate));
        found.layer.items[found.index] = it;
      }
      return { ids: op.ids };
    }
    case "transform_items": {
      // Rotate (degrees) and/or flip ("x" mirrors left to right, "y" top to
      // bottom) around the center of all the items together.
      const found = foundAll(doc, op.ids);
      if (!found.length) return {};
      const box = G.unionBox(found.map((f) => G.bounds(f.item)));
      const ox = op.originX ?? box.x + box.w / 2, oy = op.originY ?? box.y + box.h / 2;
      let items = found.map((f) => f.item);
      if (op.flip === "x" || op.flip === "y") items = items.map((it) => G.flipItem(it, op.flip, ox, oy));
      if (op.rotate) items = items.map((it) => G.rotateItem(it, Number(op.rotate), ox, oy));
      putBack(found, items);
      return { ids: op.ids };
    }
    case "duplicate_items": {
      // Copies go above the topmost original on each layer, in the same
      // stacking order. Groups copy as new groups.
      const found = foundAll(doc, op.ids);
      const groupMap = new Map();
      const ids = [];
      for (const layer of new Set(found.map((f) => f.layer))) {
        const mine = found.filter((f) => f.layer === layer).map((f) => ({ f, i: layer.items.indexOf(f.item) })).sort((a, b) => a.i - b.i);
        const copies = mine.map(({ f }) => {
          const copy = G.moveItem(f.item, Number(op.dx) || 0, Number(op.dy) || 0);
          copy.id = G.uid(copy.type[0]);
          if (copy.group) {
            if (!groupMap.has(copy.group)) groupMap.set(copy.group, G.uid("g"));
            copy.group = groupMap.get(copy.group);
          }
          return copy;
        });
        layer.items.splice(mine[mine.length - 1].i + 1, 0, ...copies);
        ids.push(...copies.map((c) => c.id));
      }
      return { ids };
    }
    case "group_items": {
      const found = foundAll(doc, op.ids);
      if (found.length < 2) throw new Error("Pick at least two items to group.");
      const g = G.uid("g");
      for (const f of found) f.item.group = g;
      return { group: g, ids: op.ids };
    }
    case "ungroup_items": {
      const found = foundAll(doc, op.ids);
      const groups = new Set(found.map((f) => f.item.group).filter(Boolean));
      let n = 0;
      for (const layer of doc.layers) for (const it of layer.items) if (it.group && groups.has(it.group)) { delete it.group; n++; }
      return { ungrouped: n };
    }
    case "align_items": {
      // how: left|center|right|top|middle|bottom. to: "canvas" lines them up
      // with the canvas instead of with each other.
      const found = foundAll(doc, op.ids);
      if (!found.length) return {};
      const ref = op.to === "canvas" || found.length === 1 ? { x: 0, y: 0, w: doc.width, h: doc.height } : null;
      putBack(found, G.alignItems(found.map((f) => f.item), op.how, ref));
      return { ids: op.ids };
    }
    case "distribute_items": {
      const found = foundAll(doc, op.ids);
      if (found.length < 3) throw new Error("Pick at least three items to space out.");
      putBack(found, G.distributeItems(found.map((f) => f.item), op.dir));
      return { ids: op.ids };
    }
    case "replace_items": {
      // Swap whole items in place (used by the select tool after a drag).
      for (const raw of op.items || []) {
        const found = G.findItem(doc, raw.id);
        if (!found) continue;
        found.layer.items[found.index] = G.normItem(raw);
      }
      return {};
    }
    case "delete_items": {
      const ids = new Set(op.ids || []);
      let n = 0;
      for (const layer of doc.layers) {
        const before = layer.items.length;
        layer.items = layer.items.filter((it) => !ids.has(it.id));
        n += before - layer.items.length;
      }
      return { deleted: n };
    }
    case "order_items": {
      // to: "front" | "back" | "forward" | "backward"
      for (const id of op.ids || []) {
        const found = G.findItem(doc, id);
        if (!found) continue;
        const arr = found.layer.items;
        arr.splice(found.index, 1);
        let at = found.index;
        if (op.to === "front") at = arr.length;
        else if (op.to === "back") at = 0;
        else if (op.to === "forward") at = Math.min(arr.length, found.index + 1);
        else if (op.to === "backward") at = Math.max(0, found.index - 1);
        arr.splice(at, 0, found.item);
      }
      return {};
    }
    case "place_items": {
      // Moves items to one spot in a layer's stack (index counts from the
      // bottom), keeping their order: a redraw takes the old object's place.
      const target = layerOf(doc, op.layerId, true);
      const moving = [];
      for (const id of op.ids || []) {
        const found = G.findItem(doc, id);
        if (!found) continue;
        found.layer.items.splice(found.index, 1);
        moving.push(found.item);
      }
      const at = G.clamp(Number(op.index) || 0, 0, target.items.length);
      target.items.splice(at, 0, ...moving);
      return { layerId: target.id };
    }
    case "move_to_layer": {
      const target = layerOf(doc, op.layerId, true);
      for (const id of op.ids || []) {
        const found = G.findItem(doc, id);
        if (!found || found.layer === target) continue;
        found.layer.items.splice(found.index, 1);
        target.items.push(found.item);
      }
      return { layerId: target.id };
    }
    case "recolor": {
      const from = G.normColor(op.from);
      const to = G.normColor(op.to);
      if (!from || !to) throw new Error("recolor needs a from color and a to color.");
      const tol = G.clamp(Number(op.tolerance) || 24, 0, 442);
      const swap = (c) => (c && G.colorDistance(c, from) <= tol ? to : c);
      const swapPaint = (p) => {
        if (!p) return p;
        if (typeof p === "string") return swap(p);
        return Object.assign({}, p, { stops: p.stops.map((s) => [s[0], swap(s[1])]) });
      };
      let n = 0;
      for (const layer of doc.layers) {
        if (op.layerId && layer.id !== op.layerId) continue;
        layer.items = layer.items.map((it) => {
          const before = JSON.stringify(it);
          const out = Object.assign({}, it);
          if (out.type === "stroke") out.color = swap(out.color);
          if (out.fill) out.fill = swapPaint(out.fill);
          if (out.stroke) out.stroke = swapPaint(out.stroke);
          if (JSON.stringify(out) !== before) n++;
          return out;
        });
      }
      if (op.background !== false && doc.background && G.colorDistance(doc.background, from) <= tol) { doc.background = to; n++; }
      return { changed: n };
    }
    case "add_layer": {
      const layer = { id: G.uid("L"), name: String(op.name || `Layer ${doc.layers.length + 1}`).slice(0, 60), visible: true, opacity: 1, items: [] };
      const at = Number.isInteger(op.index) ? G.clamp(op.index, 0, doc.layers.length) : doc.layers.length;
      doc.layers.splice(at, 0, layer);
      return { layerId: layer.id };
    }
    case "update_layer": {
      const layer = layerOf(doc, op.layerId);
      if (op.name !== undefined) layer.name = String(op.name).slice(0, 60) || layer.name;
      if (op.visible !== undefined) layer.visible = !!op.visible;
      if (op.opacity !== undefined) layer.opacity = G.clamp(Number(op.opacity), 0, 1);
      if (op.locked !== undefined) layer.locked = !!op.locked;
      if (op.blend !== undefined) layer.blend = String(op.blend);
      if (op.paper !== undefined) layer.paper = !!op.paper;
      return { layerId: layer.id };
    }
    case "move_layer": {
      const layer = layerOf(doc, op.layerId);
      const from = doc.layers.indexOf(layer);
      doc.layers.splice(from, 1);
      const at = G.clamp(Number.isInteger(op.index) ? op.index : from, 0, doc.layers.length);
      doc.layers.splice(at, 0, layer);
      return { layerId: layer.id };
    }
    case "delete_layer": {
      const layer = layerOf(doc, op.layerId);
      if (doc.layers.length === 1) {
        layer.items = [];
        return { cleared: true };
      }
      doc.layers.splice(doc.layers.indexOf(layer), 1);
      return { deleted: layer.id };
    }
    case "duplicate_layer": {
      const layer = layerOf(doc, op.layerId);
      const copy = JSON.parse(JSON.stringify(layer));
      copy.id = G.uid("L");
      copy.name = (layer.name + " copy").slice(0, 60);
      copy.items = copy.items.map((it) => Object.assign(it, { id: G.uid(it.type[0]) }));
      doc.layers.splice(doc.layers.indexOf(layer) + 1, 0, copy);
      return { layerId: copy.id };
    }
    case "flatten_into": {
      // Replace a layer pair with a rendered image (merging a layer whose
      // erasers or blend mode would change meaning if its items moved).
      const upper = layerOf(doc, op.layerId);
      const i = doc.layers.indexOf(upper);
      if (i <= 0) throw new Error("There is no layer below to merge into.");
      const below = doc.layers[i - 1];
      below.items = [G.normItem(Object.assign({ type: "image", name: "Merged" }, op.image))];
      doc.layers.splice(i, 1);
      return { layerId: below.id };
    }
    case "merge_down": {
      const layer = layerOf(doc, op.layerId);
      const i = doc.layers.indexOf(layer);
      if (i <= 0) throw new Error("There is no layer below to merge into.");
      const below = doc.layers[i - 1];
      const fade = layer.opacity ?? 1;
      below.items.push(...layer.items.map((it) => (fade < 1 ? Object.assign({}, it, { opacity: (it.opacity ?? 1) * fade }) : it)));
      doc.layers.splice(i, 1);
      return { layerId: below.id };
    }
    case "set_doc": {
      if (op.background !== undefined && op.background !== null) doc.background = G.normColor(op.background) || doc.background;
      const ow = doc.width, oh = doc.height;
      if (op.width) doc.width = G.clamp(Math.round(op.width), 64, 8192);
      if (op.height) doc.height = G.clamp(Math.round(op.height), 64, 8192);
      // anchor "center" keeps the drawing in the middle when the canvas
      // grows or shrinks; the default keeps it at the top left.
      if (op.anchor === "center" && (doc.width !== ow || doc.height !== oh)) {
        const dx = Math.round((doc.width - ow) / 2), dy = Math.round((doc.height - oh) / 2);
        for (const layer of doc.layers) layer.items = layer.items.map((it) => G.moveItem(it, dx, dy));
      }
      if (Array.isArray(op.palette)) doc.palette = op.palette.map(G.normColor).filter(Boolean).slice(0, 48);
      if (Array.isArray(op.addColors)) {
        const set = new Set(doc.palette);
        for (const c of op.addColors.map(G.normColor).filter(Boolean)) if (!set.has(c)) { doc.palette.push(c); set.add(c); }
        doc.palette = doc.palette.slice(-48);
      }
      if (Array.isArray(op.paletteNames)) doc.paletteNames = op.paletteNames;
      // Items the artist finish already treated (lib/finish.cjs): id -> signature.
      if (op.finished && typeof op.finished === "object") doc.finished = op.finished;
      // How the agent asked for the finish on this drawing ({ edges, grain, grade, strength }).
      if (op.finishOpts && typeof op.finishOpts === "object") doc.finishOpts = op.finishOpts;
      // Items an agent made (main.cjs noteAgentItems); everything else is the person's.
      if (Array.isArray(op.agentItems)) doc.agentItems = op.agentItems.filter((x) => typeof x === "string").slice(0, 20000);
      return {};
    }
    default:
      throw new Error(`Unknown edit "${op && op.op}".`);
  }
}

module.exports = { DrawingStore, applyOp, titleFor };
