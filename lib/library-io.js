const fs = require("fs/promises");
const fssync = require("fs");
const path = require("path");
const { randomUUID, createHash } = require("crypto");
const {
  loadState,
  loadWorkspace,
  saveWorkspace,
  snapshot,
  workspaceDir,
  ensureDir,
} = require("./workspace-store");

const EXT_FOR_MIME = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/wav": ".wav",
  "audio/webm": ".webm",
  "audio/ogg": ".ogg",
  "audio/mp4": ".m4a",
};

function kindFromMime(mime, name) {
  const type = String(mime || "").toLowerCase();
  const lower = String(name || "").toLowerCase();
  if (type.startsWith("image/") || /\.(png|jpe?g|webp)$/.test(lower)) return "image";
  if (type.startsWith("video/") || /\.(mp4|m4v|mov|webm|avi|mkv)$/.test(lower)) return "video";
  if (type.startsWith("audio/") || /\.(mp3|wav|ogg|m4a|aac|flac)$/.test(lower)) return "audio";
  return null;
}

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

const LIBRARY_SOURCES = Object.freeze([
  "recorder-agent",
  "recorder",
  "upload",
  "import",
  "finished-export",
  "agent",
  "animation",
]);

function normalizeLibrarySource(value) {
  const source = String(value || "").trim();
  if (!source) return "";
  if (!LIBRARY_SOURCES.includes(source)) {
    throw new Error("Unknown library source: " + source);
  }
  return source;
}

function librarySourceFrom(opts) {
  const o = opts || {};
  if (o.source) return normalizeLibrarySource(o.source);
  if (o.madeIn === "recorder") return "recorder";
  return "";
}

// Items the Recorder agent produces remember which chat made them so the
// library row can reopen that chat. Explicit chatId wins; otherwise read the
// active chat from the recorder store. Best effort: a missing store is fine.
function recorderChatIdFor(dataRoot, opts, source) {
  const o = opts || {};
  const explicit = String(o.chatId || "").trim();
  if (explicit) return explicit;
  if (source !== "recorder-agent") return "";
  try {
    // The merged agent records from whichever chat is open, so the clip
    // links to the latest active chat across kinds, not only recorder rows.
    // recorder-chats reuses its cached connection instead of opening one.
    const active = require("./recorder-chats").getActiveChat(dataRoot, "all");
    return active && active.chat && active.chat.id ? String(active.chat.id) : "";
  } catch {
    return "";
  }
}

async function hashFile(filePath) {
  const hash = createHash("sha256");
  const stream = fssync.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

// A dropped video can be hundreds of MB. fs.copyFile gives no feedback for
// however long the disk takes, so a page that shows a progress bar has nothing
// to paint. Stream the copy and report bytes as they land. Resolves once the
// destination is fully written.
function copyFileWithProgress(sourcePath, dest, onProgress, totalBytes) {
  return new Promise((resolve, reject) => {
    const read = fssync.createReadStream(sourcePath, { highWaterMark: 1024 * 1024 });
    const write = fssync.createWriteStream(dest);
    const total = Number(totalBytes) || 0;
    let copied = 0;
    let lastReport = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      read.destroy();
      write.destroy();
      reject(error);
    };
    read.on("error", fail);
    write.on("error", fail);
    if (typeof onProgress === "function") {
      read.on("data", (chunk) => {
        copied += chunk.length;
        const now = Date.now();
        // Throttle: one report per 80 ms keeps the page's paint cheap while
        // still moving the bar on a slow disk.
        if (now - lastReport < 80 && copied < total) return;
        lastReport = now;
        onProgress(copied);
      });
    }
    write.on("finish", () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    read.pipe(write);
  });
}

function libraryFilePath(dataRoot, workspaceId, item) {
  return path.join(workspaceDir(dataRoot, workspaceId), item.file);
}

async function resolveWorkspace(dataRoot, workspaceId) {
  const state = await loadState(dataRoot);
  const id = workspaceId || state.activeWorkspaceId;
  const ws = await loadWorkspace(dataRoot, id);
  if (!Array.isArray(ws.library)) ws.library = [];
  return { id, ws };
}

// A shrunk item keeps the hashes of the files it replaced, so importing the
// original again finds the smaller copy instead of adding a second one.
function findByHash(library, kind, contentHash) {
  return (
    (library || []).find(
      (item) =>
        item &&
        item.kind === kind &&
        (item.contentHash === contentHash || (Array.isArray(item.formerHashes) && item.formerHashes.includes(contentHash))),
    ) || null
  );
}

function clipKeyName(name) {
  return String(name || "")
    .replace(/\.[^.]+$/, "")
    .trim()
    .toLowerCase();
}

// The same file arriving twice is a duplicate. The same *name* is not: a take
// called "Screen take 1" from September and a 563 MB "Screen take 1" dropped in
// October are two different videos. Matching on the name alone threw the second
// one away and the drop looked like it did nothing, so the name only decides
// when the stored row has no hash to compare (items imported before hashes were
// recorded, where the size has to agree too).
function findDuplicateItem(library, { kind, name, size, contentHash } = {}) {
  const items = Array.isArray(library) ? library : [];
  const hash = String(contentHash || "");
  if (hash) {
    const byHash = items.find(
      (item) =>
        item &&
        item.kind === kind &&
        (item.contentHash === hash || (Array.isArray(item.formerHashes) && item.formerHashes.includes(hash))),
    );
    if (byHash) return byHash;
  }
  const key = clipKeyName(name);
  if (!key) return null;
  return (
    items.find(
      (item) =>
        item &&
        item.kind === kind &&
        !item.contentHash &&
        Number(item.size) === Number(size) &&
        clipKeyName(item.name) === key,
    ) || null
  );
}

// Videos land with durationMs 0 otherwise; the renderer used to be the only
// place that filled it, which left agents unable to tell how long a clip is.
// Best effort: no ffmpeg on the machine keeps 0 instead of failing uploads.
async function probeVideoDurationMs(file) {
  try {
    const { findFfmpeg, probeMedia } = require("./card-render");
    const bin = findFfmpeg();
    if (!bin) return 0;
    const media = await probeMedia(bin, file);
    const ms = media && Number(media.durationMs);
    return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 0;
  } catch {
    return 0;
  }
}

async function copyPathIntoLibrary(dataRoot, sourcePath, meta) {
  const opts = meta || {};
  const name = opts.name || path.basename(sourcePath);
  const mime = opts.mime || "";
  // name is a display string agents can set freely and often has no extension;
  // the file's own path is the reliable type hint.
  const kind = kindFromMime(mime, path.basename(sourcePath)) || kindFromMime(mime, name);
  if (!kind) throw new Error("That file type is not supported.");

  const { id: workspaceId, ws } = await resolveWorkspace(dataRoot, opts.workspaceId);
  const stat = await fs.stat(sourcePath);
  const contentHash = await hashFile(sourcePath);
  const existing = findByHash(ws.library, kind, contentHash);
  if (existing) {
    // Items uploaded before durations were probed still say 0; fill the gap
    // when the same file shows up again.
    if (existing.kind === "video" && !Number(existing.durationMs)) {
      const probed = await probeVideoDurationMs(libraryFilePath(dataRoot, workspaceId, existing));
      if (probed) {
        existing.durationMs = probed;
        await saveWorkspace(dataRoot, ws);
      }
    }
    return {
      skipped: true,
      existingId: existing.id,
      item: existing,
      snapshot: await snapshot(dataRoot, workspaceId),
    };
  }

  const id = randomUUID();
  let ext = extFor(mime, path.basename(sourcePath)) || extFor("", name);
  if (!ext) ext = kind === "image" ? ".png" : kind === "audio" ? ".mp3" : ".mp4";
  const rel = path.join("library", id + ext);
  const dest = path.join(workspaceDir(dataRoot, workspaceId), rel);
  await ensureDir(path.dirname(dest));
  await fs.copyFile(sourcePath, dest);

  const item = {
    id,
    kind,
    name: displayNameFrom(name),
    file: rel,
    mime: mime || kind + "/*",
    size: stat.size,
    durationMs: 0,
    description: "",
    aiCanUse: true,
    posterFile: "",
    contentHash,
    createdAt: new Date().toISOString(),
  };
  const source = librarySourceFrom(opts);
  if (source) item.source = source;
  if (opts.madeIn) item.madeIn = String(opts.madeIn);
  const chatId = recorderChatIdFor(dataRoot, opts, source);
  if (chatId) item.chatId = chatId;
  ws.library.unshift(item);
  if (kind === "video") item.durationMs = await probeVideoDurationMs(dest);
  await saveWorkspace(dataRoot, ws);
  return {
    item,
    snapshot: await snapshot(dataRoot, workspaceId),
    skipped: false,
  };
}

async function listLibrary(dataRoot, kind, workspaceId) {
  const { ws } = await resolveWorkspace(dataRoot, workspaceId);
  const items = ws.library.slice();
  if (!kind) return items;
  return items.filter((item) => item && item.kind === kind);
}

async function getLibraryItem(dataRoot, id, workspaceId) {
  const { id: wsId, ws } = await resolveWorkspace(dataRoot, workspaceId);
  const item = (ws.library || []).find((entry) => entry && entry.id === id) || null;
  if (!item) return null;
  return Object.assign({}, item, {
    path: libraryFilePath(dataRoot, wsId, item),
  });
}

// Read one item and make sure a video's duration is real: items uploaded
// before probing landed with durationMs 0, and agents planning cuts need the
// exact length. The probed value is saved back so snapshots agree later.
async function getLibraryItemProbed(dataRoot, id, workspaceId) {
  const { id: wsId, ws } = await resolveWorkspace(dataRoot, workspaceId);
  const item = (ws.library || []).find((entry) => entry && entry.id === id);
  if (!item) return null;
  let saved = false;
  if (item.kind === "video" && !Number(item.durationMs)) {
    const probed = await probeVideoDurationMs(libraryFilePath(dataRoot, wsId, item));
    if (probed) {
      item.durationMs = probed;
      saved = true;
    }
  }
  if (saved) await saveWorkspace(dataRoot, ws);
  return Object.assign({}, item, {
    path: libraryFilePath(dataRoot, wsId, item),
    durationSeconds: item.kind === "video" ? (Number(item.durationMs) || 0) / 1000 : undefined,
  });
}

// One delete path for the IPC handler, the agent tool, and the cleanup page:
// the row, its file, the card references, and every project that pinned it.
async function deleteLibraryItem(dataRoot, id, workspaceId) {
  const { id: wsId, ws } = await resolveWorkspace(dataRoot, workspaceId);
  const item = (ws.library || []).find((entry) => entry && entry.id === id);
  if (!item) throw new Error("Library item not found.");
  ws.library = ws.library.filter((entry) => entry.id !== id);
  ws.cardImages = (ws.cardImages || []).filter((entry) => entry.id !== id);
  ws.links = (ws.links || []).filter((link) => !Array.isArray(link.refs) || !link.refs.includes(id));
  (ws.cards || []).forEach((card) => {
    if (Array.isArray(card.imageIds)) card.imageIds = card.imageIds.filter((entry) => entry !== id);
    if (card.composition) {
      if (card.composition.backgroundId === id) card.composition.backgroundId = "";
      if (card.composition.imageLayouts) delete card.composition.imageLayouts[id];
    }
    if (card.endScreenBackgroundId === id) card.endScreenBackgroundId = "";
  });
  for (const rel of [item.file, item.posterFile]) {
    if (!rel) continue;
    try {
      await fs.unlink(path.join(workspaceDir(dataRoot, wsId), rel));
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
    }
  }
  await saveWorkspace(dataRoot, ws);
  require("./animation-source").deleteAnimationSource(dataRoot, wsId, id);
  try {
    require("./ai-projects").removeLibraryAsset(dataRoot, wsId, id);
  } catch {
    /* the library removal stays authoritative */
  }
  return { deleted: id, workspaceId: wsId };
}

module.exports = {
  LIBRARY_SOURCES,
  kindFromMime,
  normalizeLibrarySource,
  librarySourceFrom,
  copyPathIntoLibrary,
  copyFileWithProgress,
  listLibrary,
  getLibraryItem,
  getLibraryItemProbed,
  deleteLibraryItem,
  libraryFilePath,
  findByHash,
  findDuplicateItem,
  clipKeyName,
};
