"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { dbPath: projectsDbPath } = require("./ai-projects-store");
const { dbPath: chatsDbPath } = require("./editor-chats-store");

let DatabaseSync = null;
function dbSyncCtor() {
  if (!DatabaseSync) ({ DatabaseSync } = require("node:sqlite"));
  return DatabaseSync;
}

function drawDbPath(dataRoot) {
  return path.join(path.dirname(path.resolve(String(dataRoot || ""))), "draw", "jdraw.db");
}

function attachIfPresent(db, file, alias) {
  if (!fs.existsSync(file)) return false;
  db.prepare("ATTACH DATABASE ? AS " + alias).run(file);
  return true;
}

// Projects, project chats, and drawings live in different SQLite files. One
// connection attaches all three so a cleanup failure rolls the whole delete
// back instead of leaving the project visible with pieces already removed.
function deleteProjectCascade({ dataRoot, workspaceId, projectId, prepareDrawings, drawingsDeleted }) {
  const root = String(dataRoot || "");
  const ws = String(workspaceId || "").trim();
  const id = String(projectId || "").trim();
  if (!root) throw new Error("dataRoot is required");
  if (!ws) throw new Error("workspaceId is required");
  if (!id) throw new Error("projectId is required");

  if (typeof prepareDrawings === "function") prepareDrawings(id);

  const db = new (dbSyncCtor())(projectsDbPath(root), {
    timeout: 5000,
    enableForeignKeyConstraints: true,
  });
  try {
    db.exec("PRAGMA foreign_keys=ON;");
    db.exec("PRAGMA busy_timeout=5000;");
    const hasChats = attachIfPresent(db, chatsDbPath(root), "project_chats");
    const hasDrawings = attachIfPresent(db, drawDbPath(root), "project_drawings");
    const counts = { drawings: 0, drawingChats: 0, chats: 0 };

    db.exec("BEGIN IMMEDIATE");
    try {
      if (hasDrawings) {
        counts.drawingChats = Number(
          db
            .prepare("DELETE FROM project_drawings.chat_threads WHERE drawing_id IN (SELECT id FROM project_drawings.drawings WHERE project_id = ?)")
            .run(id).changes,
        ) || 0;
        counts.drawings = Number(db.prepare("DELETE FROM project_drawings.drawings WHERE project_id = ?").run(id).changes) || 0;
      }
      if (hasChats) {
        counts.chats = Number(
          db.prepare("DELETE FROM project_chats.editor_chats WHERE workspace_id = ? AND page = 'ai' AND project_id = ?").run(ws, id).changes,
        ) || 0;
      }
      const result = db.prepare("DELETE FROM main.ai_video_projects WHERE id = ?").run(id);
      if (!result.changes) throw new Error("Project not found: " + id);
      db.exec("COMMIT");
    } catch (error) {
      if (db.isTransaction) {
        try {
          db.exec("ROLLBACK");
        } catch {}
      }
      throw error;
    }

    if (typeof drawingsDeleted === "function") {
      try {
        drawingsDeleted(id);
      } catch (error) {
        console.error("[project-delete] drawing state cleanup failed", error);
      }
    }
    return { ok: true, id, counts };
  } finally {
    if (db.isOpen) db.close();
  }
}

module.exports = { deleteProjectCascade, drawDbPath };
