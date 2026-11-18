const fs = require("fs/promises");
const fssync = require("fs");
const path = require("path");
const { randomUUID, createHash } = require("crypto");
const {
  loadWorkspace,
  saveWorkspace,
  snapshot,
  workspaceDir,
  ensureDir,
  loadState,
} = require("./workspace-store");
const { kindFromMime } = require("./library-io");

const EXT_FOR_MIME = {
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
};

function extFor(mime, name) {
  const mapped = EXT_FOR_MIME[String(mime || "").toLowerCase()];
  if (mapped) return mapped;
  const match = String(name || "").match(/(\.[a-z0-9]{2,5})$/i);
  return match ? match[1].toLowerCase() : "";
}

function displayNameFrom(name) {
  const base = path.basename(String(name || ""));
  return base.replace(/\.[^.]+$/, "") || base;
}

async function hashFile(filePath) {
  const hash = createHash("sha256");
  const stream = fssync.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

function posterBytes(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (Array.isArray(data)) return Buffer.from(data);
  if (data && Array.isArray(data.data)) return Buffer.from(data.data);
  return Buffer.from(data);
}

async function resolveWorkspace(dataRoot, workspaceId) {
  const state = await loadState(dataRoot);
  const id = workspaceId || state.activeWorkspaceId;
  const ws = await loadWorkspace(dataRoot, id);
  if (!Array.isArray(ws.finished)) ws.finished = [];
  return { id, ws };
}

function findByHash(finished, contentHash) {
  return (
    (finished || []).find(
      (item) =>
        item && (item.contentHash === contentHash || (Array.isArray(item.formerHashes) && item.formerHashes.includes(contentHash))),
    ) || null
  );
}

function finishedFilePath(dataRoot, workspaceId, item) {
  return path.join(workspaceDir(dataRoot, workspaceId), item.file);
}

async function copyPathIntoFinished(dataRoot, sourcePath, meta) {
  const opts = meta || {};
  const name = opts.name || path.basename(sourcePath);
  const mime = opts.mime || "";
  const kind = kindFromMime(mime, path.basename(sourcePath)) || kindFromMime(mime, name);
  if (kind !== "video") throw new Error("Renders only accept video files.");

  const { id: workspaceId, ws } = await resolveWorkspace(dataRoot, opts.workspaceId);
  const stat = await fs.stat(sourcePath);
  const contentHash = await hashFile(sourcePath);
  const existing = findByHash(ws.finished, contentHash);
  if (existing) {
    return {
      skipped: true,
      existingId: existing.id,
      item: existing,
      snapshot: await snapshot(dataRoot, workspaceId),
    };
  }

  const id = randomUUID();
  let ext = extFor(mime, path.basename(sourcePath)) || extFor("", name);
  if (!ext) ext = ".mp4";
  const rel = path.join("finished", id + ext);
  const dest = path.join(workspaceDir(dataRoot, workspaceId), rel);
  await ensureDir(path.dirname(dest));
  await fs.copyFile(sourcePath, dest);

  const item = {
    id,
    kind: "video",
    name: displayNameFrom(name),
    file: rel,
    mime: mime || "video/mp4",
    size: stat.size,
    durationMs: 0,
    posterFile: "",
    contentHash,
    createdAt: new Date().toISOString(),
    source: opts.source || "tui",
  };
  // The projects a render was made for. One file can serve several projects
  // (identical cuts dedupe by hash), so this is a list, not a single owner.
  if (opts.projectId) item.projectIds = [String(opts.projectId)];
  ws.finished.unshift(item);
  await saveWorkspace(dataRoot, ws);
  return {
    item,
    snapshot: await snapshot(dataRoot, workspaceId),
    skipped: false,
  };
}

async function listFinished(dataRoot, workspaceId) {
  const { ws } = await resolveWorkspace(dataRoot, workspaceId);
  return ws.finished.slice();
}

async function getFinishedItem(dataRoot, id, workspaceId) {
  const { id: wsId, ws } = await resolveWorkspace(dataRoot, workspaceId);
  const item = (ws.finished || []).find((entry) => entry && entry.id === id) || null;
  if (!item) return null;
  // The stored row keeps a relative file, and an agent that wants to inspect a
  // render needs the absolute path on this computer, same as a library item.
  return Object.assign({}, item, { path: finishedFilePath(dataRoot, wsId, item) });
}

async function updateFinishedItem(dataRoot, id, patch, workspaceId) {
  const { id: wsId, ws } = await resolveWorkspace(dataRoot, workspaceId);
  const item = (ws.finished || []).find((entry) => entry.id === id);
  if (!item) throw new Error("Finished video not found.");
  const next = patch || {};
  if (typeof next.name === "string") item.name = next.name.trim() || item.name;
  if (Number.isFinite(next.durationMs)) item.durationMs = Math.max(0, Math.round(next.durationMs));
  if (Number.isFinite(next.videoWidth)) item.videoWidth = Math.max(0, Math.round(next.videoWidth));
  if (Number.isFinite(next.videoHeight)) item.videoHeight = Math.max(0, Math.round(next.videoHeight));
  // The library clips this render was made from (one file can serve several
  // after dedupe), so replacing a clip can unlink every render of it.
  if (typeof next.sourceId === "string" && next.sourceId) {
    const list = Array.isArray(item.sourceIds) ? item.sourceIds.map(String) : [];
    if (!list.includes(next.sourceId)) item.sourceIds = list.concat([next.sourceId]);
  }
  if (next.poster && next.poster.data != null) {
    const posterRel = path.join("finished-posters", item.id + ".jpg");
    const posterDest = path.join(workspaceDir(dataRoot, wsId), posterRel);
    await ensureDir(path.dirname(posterDest));
    const tmp = posterDest + ".tmp";
    await fs.writeFile(tmp, posterBytes(next.poster.data));
    await fs.rename(tmp, posterDest);
    item.posterFile = posterRel;
  }
  await saveWorkspace(dataRoot, ws);
  return snapshot(dataRoot, wsId);
}

// Record that a project uses this render. Dedupe means the same file can be
// the output of several projects, so the list is merged, never replaced.
async function addFinishedProject(dataRoot, id, projectId, workspaceId) {
  const key = String(projectId || "").trim();
  if (!key) return null;
  const { id: wsId, ws } = await resolveWorkspace(dataRoot, workspaceId);
  const item = (ws.finished || []).find((entry) => entry.id === id);
  if (!item) return null;
  const list = Array.isArray(item.projectIds) ? item.projectIds.map(String) : [];
  if (!list.includes(key)) {
    item.projectIds = list.concat([key]);
    await saveWorkspace(dataRoot, ws);
  }
  return item;
}

// The reverse: a project stops listing this render (the file stays, and so
// does its link to any other project).
async function removeFinishedProject(dataRoot, id, projectId, workspaceId) {
  const key = String(projectId || "").trim();
  if (!key) return null;
  const { ws } = await resolveWorkspace(dataRoot, workspaceId);
  const item = (ws.finished || []).find((entry) => entry.id === id);
  if (!item || !Array.isArray(item.projectIds) || !item.projectIds.map(String).includes(key)) return item || null;
  item.projectIds = item.projectIds.map(String).filter((p) => p !== key);
  await saveWorkspace(dataRoot, ws);
  return item;
}

// Unlinks from a project every render made from one library clip.
async function unlinkProjectSource(dataRoot, projectId, sourceId, workspaceId) {
  const key = String(projectId || "").trim();
  const src = String(sourceId || "").trim();
  if (!key || !src) return 0;
  const { ws } = await resolveWorkspace(dataRoot, workspaceId);
  let n = 0;
  for (const item of ws.finished || []) {
    const projectsOf = Array.isArray(item.projectIds) ? item.projectIds.map(String) : [];
    const sources = Array.isArray(item.sourceIds) ? item.sourceIds.map(String) : [];
    if (projectsOf.includes(key) && sources.includes(src)) {
      item.projectIds = projectsOf.filter((p) => p !== key);
      n += 1;
    }
  }
  if (n) await saveWorkspace(dataRoot, ws);
  return n;
}

async function deleteFinishedItem(dataRoot, id, workspaceId) {
  const { id: wsId, ws } = await resolveWorkspace(dataRoot, workspaceId);
  const item = (ws.finished || []).find((entry) => entry.id === id);
  if (!item) return snapshot(dataRoot, wsId);
  ws.finished = ws.finished.filter((entry) => entry.id !== id);
  try {
    await fs.unlink(path.join(workspaceDir(dataRoot, wsId), item.file));
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
  if (item.posterFile) {
    try {
      await fs.unlink(path.join(workspaceDir(dataRoot, wsId), item.posterFile));
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
    }
  }
  await saveWorkspace(dataRoot, ws);
  return snapshot(dataRoot, wsId);
}

module.exports = {
  copyPathIntoFinished,
  listFinished,
  getFinishedItem,
  finishedFilePath,
  updateFinishedItem,
  addFinishedProject,
  removeFinishedProject,
  unlinkProjectSource,
  deleteFinishedItem,
};
