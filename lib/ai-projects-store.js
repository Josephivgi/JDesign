"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
// node:sqlite is only present on newer Node builds; resolve it lazily so
// loading this module does not crash processes that never touch the store.
let DatabaseSync = null;
function dbSyncCtor() {
  if (!DatabaseSync) ({ DatabaseSync } = require("node:sqlite"));
  return DatabaseSync;
}

const BUSY_MS = 5000;
const SQLITE_HEADER = Buffer.from("SQLite format 3\0");
const RATIOS = new Set(["16/9", "9/16", "1/1", "4/5"]);
const ASSET_KINDS = new Set(["video", "image", "audio"]);
const MAX_STATE_BYTES = 1024 * 1024;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ai_video_projects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  aspect_ratio TEXT NOT NULL,
  state_json TEXT NOT NULL DEFAULT '{}',
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_video_project_assets (
  project_id TEXT NOT NULL,
  library_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('video', 'image', 'audio')),
  position INTEGER NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (project_id, library_id),
  FOREIGN KEY (project_id) REFERENCES ai_video_projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ai_video_projects_workspace
  ON ai_video_projects(workspace_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS ai_video_project_assets_order
  ON ai_video_project_assets(project_id, position ASC);
`;

function dbPath(dataRoot) {
  return path.join(String(dataRoot || ""), "ai-video-projects.db");
}

function nowIso() {
  return new Date().toISOString();
}

function required(value, label) {
  const text = String(value == null ? "" : value).trim();
  if (!text) throw new Error(label + " is required");
  return text;
}

function ratio(value) {
  const next = String(value || "16/9");
  return RATIOS.has(next) ? next : "16/9";
}

// State must be a plain object. Anything else (arrays, numbers, raw JSON
// strings) is rejected instead of silently wiping the saved blob to {}.
function stateJson(value) {
  if (value == null) return "{}";
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("AI video project state must be an object");
  }
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, "utf8") > MAX_STATE_BYTES) {
    throw new Error("AI video project state is too large");
  }
  return json;
}

function parseState(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    throw new Error("AI video project state is invalid: " + error.message);
  }
}

// For paths that repair references inside the state blob: a corrupt blob must
// not block the row-level cleanup, so parse failures degrade to "no fixup".
function safeParseState(value) {
  try {
    return parseState(value);
  } catch {
    return null;
  }
}

function assertExistingSqlite(file) {
  if (!fs.existsSync(file)) return;
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error("AI video project store path is not a file: " + file);
  if (!stat.size) return;
  const fd = fs.openSync(file, "r");
  try {
    const header = Buffer.alloc(16);
    if (fs.readSync(fd, header, 0, 16, 0) < 16 || !header.equals(SQLITE_HEADER)) {
      throw new Error("AI video project store file is not a SQLite database: " + file);
    }
  } finally {
    fs.closeSync(fd);
  }
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
      } catch {}
    }
    throw error;
  }
}

// tolerantState keeps one corrupt state blob from hiding every project in the
// list; getProject stays strict so damage is reported, never silently reset.
function mapProject(row, assets, opts) {
  if (!row) return null;
  let state;
  try {
    state = parseState(row.state_json);
  } catch (error) {
    if (!opts || !opts.tolerantState) throw error;
    state = {};
  }
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    aspectRatio: row.aspect_ratio,
    pinned: !!row.pinned,
    state,
    assets: assets || [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapProjectMeta(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    aspectRatio: row.aspect_ratio,
    pinned: !!row.pinned,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAsset(row) {
  return {
    id: row.library_id,
    kind: row.kind,
    position: Number(row.position) || 0,
    addedAt: row.added_at,
  };
}

function openAiProjectsStore(dataRoot) {
  const file = dbPath(dataRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  assertExistingSqlite(file);
  const db = new (dbSyncCtor())(file, {
    timeout: BUSY_MS,
    enableForeignKeyConstraints: true,
  });
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA foreign_keys=ON;");
  db.exec("PRAGMA busy_timeout=" + BUSY_MS + ";");
  db.exec(SCHEMA);
  const columns = db.prepare("PRAGMA table_info(ai_video_projects)").all();
  if (!columns.some((column) => column.name === "pinned")) {
    db.exec("ALTER TABLE ai_video_projects ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
  }
  // One prepared statement per SQL text for the life of the connection; the
  // shared store in ai-projects.js keeps this connection open across calls.
  const stmts = new Map();
  function stmt(sql) {
    let prepared = stmts.get(sql);
    if (!prepared) stmts.set(sql, (prepared = db.prepare(sql)));
    return prepared;
  }

  function assetsFor(projectId) {
    return stmt("SELECT * FROM ai_video_project_assets WHERE project_id = ? ORDER BY position ASC, added_at ASC")
      .all(projectId)
      .map(mapAsset);
  }

  function getProject(id) {
    const key = required(id, "Project id");
    const row = stmt("SELECT * FROM ai_video_projects WHERE id = ?").get(key);
    return row ? mapProject(row, assetsFor(key)) : null;
  }

  function getProjectMeta(id) {
    const key = required(id, "Project id");
    return mapProjectMeta(
      stmt(
        "SELECT id, workspace_id, name, aspect_ratio, pinned, created_at, updated_at FROM ai_video_projects WHERE id = ?",
      ).get(key),
    );
  }

  function listProjects(workspaceId) {
    const ws = required(workspaceId, "workspaceId");
    return stmt("SELECT * FROM ai_video_projects WHERE workspace_id = ? ORDER BY pinned DESC, updated_at DESC, id DESC")
      .all(ws)
      .map((row) => mapProject(row, assetsFor(row.id), { tolerantState: true }));
  }

  function createProject(input) {
    const src = input && typeof input === "object" ? input : {};
    const id = randomUUID();
    const workspaceId = required(src.workspaceId, "workspaceId");
    const name = String(src.name || "Untitled project").trim().slice(0, 120) || "Untitled project";
    const createdAt = nowIso();
    withTxn(db, () => {
      stmt(
        "INSERT INTO ai_video_projects (id, workspace_id, name, aspect_ratio, state_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(id, workspaceId, name, ratio(src.aspectRatio), stateJson(src.state), createdAt, createdAt);
      addAssets(id, src.assets || [], false);
    });
    return getProject(id);
  }

  // Puts a clip at a given place in the project's order (a replacement takes
  // the replaced clip's place instead of joining the end).
  function setAssetPosition(projectId, libraryId, position) {
    const key = required(projectId, "Project id");
    const assetId = required(libraryId, "Library id");
    stmt("UPDATE ai_video_project_assets SET position = ? WHERE project_id = ? AND library_id = ?").run(Number(position) || 0, key, assetId);
    return getProject(key);
  }

  function addAssets(projectId, assets, touch = true) {
    const key = required(projectId, "Project id");
    const project = stmt("SELECT id FROM ai_video_projects WHERE id = ?").get(key);
    if (!project) throw new Error("Project not found: " + key);
    const list = Array.isArray(assets) ? assets : [];
    return withTxn(db, () => {
      const row = stmt("SELECT COALESCE(MAX(position), -1) AS max_position FROM ai_video_project_assets WHERE project_id = ?").get(key);
      let position = Number(row && row.max_position) + 1;
      let inserted = 0;
      const insert = stmt(
        "INSERT OR IGNORE INTO ai_video_project_assets (project_id, library_id, kind, position, added_at) VALUES (?, ?, ?, ?, ?)",
      );
      for (const asset of list) {
        const assetId = required(asset && asset.id, "Library id");
        const kind = String(asset && asset.kind ? asset.kind : "");
        if (!ASSET_KINDS.has(kind)) {
          throw new Error("Unsupported project asset kind: " + (kind || "unknown"));
        }
        const result = insert.run(key, assetId, kind, position, nowIso());
        if (result.changes) {
          position += 1;
          inserted += 1;
        }
      }
      // A pure duplicate add changes nothing; it must not jump the project to
      // the top of the updated_at ordering.
      if (touch && inserted) {
        stmt("UPDATE ai_video_projects SET updated_at = ? WHERE id = ?").run(nowIso(), key);
      }
      return getProject(key);
    });
  }

  function updateProject(id, patch) {
    const key = required(id, "Project id");
    const src = patch && typeof patch === "object" ? patch : {};
    // The re-read via getProject can throw on a previously corrupt state blob;
    // wrapping the write keeps a reported failure from silently persisting.
    return withTxn(db, () => {
      const exists = stmt("SELECT id FROM ai_video_projects WHERE id = ?").get(key);
      if (!exists) throw new Error("Project not found: " + key);
      const sets = [];
      const values = [];
      let touchesContent = false;
      if (src.name != null) {
        sets.push("name = ?");
        values.push(String(src.name).trim().slice(0, 120) || "Untitled project");
        touchesContent = true;
      }
      if (src.aspectRatio != null) {
        sets.push("aspect_ratio = ?");
        values.push(ratio(src.aspectRatio));
        touchesContent = true;
      }
      if (src.state != null) {
        sets.push("state_json = ?");
        values.push(stateJson(src.state));
        touchesContent = true;
      }
      if (src.pinned != null) {
        sets.push("pinned = ?");
        values.push(src.pinned ? 1 : 0);
      }
      if (!sets.length) return getProject(key);
      if (touchesContent) {
        sets.push("updated_at = ?");
        values.push(nowIso());
      }
      values.push(key);
      stmt("UPDATE ai_video_projects SET " + sets.join(", ") + " WHERE id = ?").run(...values);
      return getProject(key);
    });
  }

  function removeAsset(projectId, libraryId) {
    const key = required(projectId, "Project id");
    const assetId = required(libraryId, "Library id");
    return withTxn(db, () => {
      const row = stmt("SELECT state_json FROM ai_video_projects WHERE id = ?").get(key);
      if (!row) throw new Error("Project not found: " + key);
      const result = stmt("DELETE FROM ai_video_project_assets WHERE project_id = ? AND library_id = ?").run(key, assetId);
      if (result.changes) {
        // A dangling selectedAssetId outlives the asset; clear it so a project
        // that is never saved again does not keep pointing at removed media.
        const state = safeParseState(row.state_json);
        if (state && state.selectedAssetId === assetId) {
          state.selectedAssetId = "";
          stmt("UPDATE ai_video_projects SET state_json = ?, updated_at = ? WHERE id = ?").run(
            JSON.stringify(state),
            nowIso(),
            key,
          );
        } else {
          stmt("UPDATE ai_video_projects SET updated_at = ? WHERE id = ?").run(nowIso(), key);
        }
      }
      return getProject(key);
    });
  }

  function removeLibraryAsset(workspaceId, libraryId) {
    const ws = required(workspaceId, "workspaceId");
    const assetId = required(libraryId, "Library id");
    return withTxn(db, () => {
      const rows = stmt("SELECT id, state_json FROM ai_video_projects WHERE workspace_id = ?").all(ws);
      const remove = stmt(
        "DELETE FROM ai_video_project_assets WHERE project_id = ? AND library_id = ?",
      );
      const touch = stmt("UPDATE ai_video_projects SET updated_at = ? WHERE id = ?");
      const fixState = stmt("UPDATE ai_video_projects SET state_json = ?, updated_at = ? WHERE id = ?");
      let changes = 0;
      for (const row of rows) {
        const result = remove.run(row.id, assetId);
        if (!result.changes) continue;
        changes += Number(result.changes);
        // Library deletion is authoritative: clear a dangling selection even
        // here, but never let a corrupt state blob block the row delete.
        const state = safeParseState(row.state_json);
        if (state && state.selectedAssetId === assetId) {
          state.selectedAssetId = "";
          fixState.run(JSON.stringify(state), nowIso(), row.id);
        } else {
          touch.run(nowIso(), row.id);
        }
      }
      return { ok: true, changes };
    });
  }

  // Deleting a duplicate must not break the projects that used it. Every
  // reference to `from` (the pinned asset row, the selected clip, per-clip
  // edits, and render pointers) is rewritten to `to` before the file goes.
  function repointMedia(workspaceId, from, to) {
    const ws = required(workspaceId, "workspaceId");
    const src = from && typeof from === "object" ? from : {};
    const dst = to && typeof to === "object" ? to : {};
    const fromId = required(src.id, "Library id");
    const toId = required(dst.id, "Library id");
    if (fromId === toId) return { ok: true, changes: 0 };
    const fromKind = String(src.kind || "");
    const toKind = String(dst.kind || "");
    return withTxn(db, () => {
      let changes = 0;
      const rows = stmt("SELECT id, state_json FROM ai_video_projects WHERE workspace_id = ?").all(ws);
      const selectRows = stmt(
        "SELECT project_id, kind, position FROM ai_video_project_assets WHERE project_id = ? AND library_id = ?",
      );
      const dropRow = stmt("DELETE FROM ai_video_project_assets WHERE project_id = ? AND library_id = ?");
      const putRow = stmt(
        "INSERT OR IGNORE INTO ai_video_project_assets (project_id, library_id, kind, position, added_at) VALUES (?, ?, ?, ?, ?)",
      );
      const touch = stmt("UPDATE ai_video_projects SET updated_at = ? WHERE id = ?");
      const writeState = stmt("UPDATE ai_video_projects SET state_json = ?, updated_at = ? WHERE id = ?");
      for (const row of rows) {
        const moved = selectRows.all(row.id, fromId);
        for (const asset of moved) {
          const kind = toKind && ASSET_KINDS.has(toKind) ? toKind : asset.kind;
          putRow.run(row.id, toId, kind, Number(asset.position) || 0, nowIso());
          dropRow.run(row.id, fromId);
          changes += 1;
        }
        const state = safeParseState(row.state_json);
        if (!state) continue;
        let dirty = false;
        if (state.selectedAssetId === fromId) {
          state.selectedAssetId = toId;
          dirty = true;
        }
        if (fromKind === toKind || !fromKind || !toKind) {
          if (state.videoEdits && typeof state.videoEdits === "object" && state.videoEdits[fromId]) {
            state.videoEdits[toId] = Object.assign({}, state.videoEdits[toId], state.videoEdits[fromId]);
            delete state.videoEdits[fromId];
            dirty = true;
          }
        }
        if (state.renders && typeof state.renders === "object") {
          const next = {};
          let rendersDirty = false;
          for (const [key, value] of Object.entries(state.renders)) {
            const nextKey = key === fromId ? toId : key;
            const nextValue = value === fromId ? toId : value;
            if (nextKey !== key || nextValue !== value) rendersDirty = true;
            next[nextKey] = nextValue;
          }
          if (rendersDirty) {
            state.renders = next;
            dirty = true;
          }
        }
        const audio = state.timelineAudio && Array.isArray(state.timelineAudio.audioClips) ? state.timelineAudio.audioClips : null;
        if (audio && fromKind === "audio" && toKind === "audio") {
          for (const clip of audio) {
            if (!clip || typeof clip !== "object") continue;
            for (const key of ["id", "audioId", "libraryId"]) {
              if (clip[key] === fromId) {
                clip[key] = toId;
                dirty = true;
              }
            }
          }
        }
        if (dirty) {
          writeState.run(JSON.stringify(state), nowIso(), row.id);
          changes += 1;
        } else if (moved.length) {
          touch.run(nowIso(), row.id);
        }
      }
      return { ok: true, changes };
    });
  }

  // A render that is deleted for good must stop being the stage output of the
  // projects that pointed at it, or the stage would ask for a missing clip.
  function dropRender(workspaceId, renderId) {
    const ws = required(workspaceId, "workspaceId");
    const id = required(renderId, "Render id");
    return withTxn(db, () => {
      let changes = 0;
      const rows = stmt("SELECT id, state_json FROM ai_video_projects WHERE workspace_id = ?").all(ws);
      const writeState = stmt("UPDATE ai_video_projects SET state_json = ?, updated_at = ? WHERE id = ?");
      for (const row of rows) {
        const state = safeParseState(row.state_json);
        if (!state) continue;
        const renders = state.renders && typeof state.renders === "object" ? state.renders : null;
        if (!renders) continue;
        let dirty = false;
        for (const [key, value] of Object.entries(renders)) {
          if (value === id) {
            delete renders[key];
            dirty = true;
          }
        }
        if (!dirty) continue;
        writeState.run(JSON.stringify(state), nowIso(), row.id);
        changes += 1;
      }
      return { ok: true, changes };
    });
  }

  function deleteProject(id) {
    const key = required(id, "Project id");
    const result = stmt("DELETE FROM ai_video_projects WHERE id = ?").run(key);
    if (!result.changes) throw new Error("Project not found: " + key);
    return { ok: true, id: key };
  }

  return {
    dbPath: () => file,
    isOpen: () => db.isOpen !== false,
    close: () => {
      if (db.isOpen) db.close();
    },
    listProjects,
    getProject,
    getProjectMeta,
    createProject,
    updateProject,
    addAssets,
    setAssetPosition,
    removeAsset,
    removeLibraryAsset,
    repointMedia,
    dropRender,
    deleteProject,
  };
}

module.exports = { dbPath, openAiProjectsStore };
