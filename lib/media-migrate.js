"use strict";

// Storage migration and repair for workspace media rows.
//
// The shrink job points a row at a new file name before removing the old one,
// so a crash can leave either an extra file on disk (the sweep picks it up) or
// a row still pointing at the old name (this check heals it). Rows from before
// the store layout existed get one verification pass; a row keeps a
// `mediaOk` stamp so it is never checked twice. Nothing is deleted here, and
// the workspace file is backed up once before the first repair.

const fs = require("fs/promises");
const fssync = require("fs");
const path = require("path");
const { createHash } = require("crypto");

const STORE_VERSION = 1;
const MEDIA_DIRS = ["library", "finished", "posters", "finished-posters"];
const HASH_TAIL = /-[0-9a-f]{6}\.[^.]+$/i;
// Files above this are hashed after the load returns (fillMissingHashes), not
// inline, so a multi-GB legacy take never holds up the first snapshot.
const INLINE_HASH_MAX = 64 * 1024 * 1024;

// A file whose size and mtime match a previous read has the same digest.
const hashCache = new Map();
const HASH_CACHE_MAX = 4000;

async function hashFile(file, stat) {
  const st = stat || (await fs.stat(file));
  const key = file + "|" + st.size + "|" + st.mtimeMs;
  if (hashCache.has(key)) return hashCache.get(key);
  const hash = createHash("sha256");
  for await (const chunk of fssync.createReadStream(file, { highWaterMark: 1024 * 1024 })) hash.update(chunk);
  const digest = hash.digest("hex");
  if (hashCache.size >= HASH_CACHE_MAX) hashCache.delete(hashCache.keys().next().value);
  hashCache.set(key, digest);
  return digest;
}

function mediaRows(ws) {
  return [...((ws && ws.library) || []), ...((ws && ws.finished) || [])].filter(Boolean);
}

function needsCheck(ws) {
  const store = ws && ws.store;
  return !(store && store.version >= STORE_VERSION) || mediaRows(ws).some((row) => row.mediaOk !== STORE_VERSION);
}

function statSync(file) {
  try {
    return fssync.statSync(file);
  } catch {
    return null;
  }
}

async function statAsync(file) {
  try {
    return await fs.stat(file);
  } catch {
    return null;
  }
}

// Async and stat-free for plain entries: a library of thousands of files no
// longer costs one blocking stat each on the main thread.
async function indexDir(dir) {
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const names = [];
  for (const entry of entries) {
    if (entry.isFile()) names.push(entry.name);
    else if (entry.isSymbolicLink()) {
      const st = await statAsync(path.join(dir, entry.name));
      if (st && st.isFile()) names.push(entry.name);
    }
  }
  return names;
}

async function mediaIndex(base) {
  const files = [];
  for (const sub of MEDIA_DIRS) for (const name of await indexDir(path.join(base, sub))) files.push(sub + "/" + name);
  return files;
}

// A replacement file keeps the row id at the start of its name, so a row can
// only be healed by a file named after it. Anything named after a different
// live row is never touched.
function healCandidates(row, files, base, ids) {
  const rel = String(row.file || "");
  const stem = path.dirname(rel);
  const dirPrefix = stem && stem !== "." ? stem + "/" : "";
  const id = String(row.id || "");
  const tail = HASH_TAIL.exec(rel);
  return files.filter((candidate) => {
    if (!dirPrefix || !candidate.startsWith(dirPrefix)) return false;
    const baseName = candidate.slice(dirPrefix.length);
    const nameId = baseName.slice(0, 36);
    if (ids.has(nameId) && nameId !== id) return false;
    if (id && baseName.startsWith(id)) return true;
    if (tail) {
      const candTail = HASH_TAIL.exec(baseName);
      if (candTail && candTail[0] === tail[0]) return true;
    }
    return false;
  });
}

async function backupWorkspace(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await fs.copyFile(file, file + ".backup-" + stamp).catch(() => {});
}

async function verifyWorkspace(dataRoot, ws, deps) {
  const file = deps && deps.workspacePath;
  const base = deps && deps.workspaceDir;
  const rows = mediaRows(ws).filter((row) => row.mediaOk !== STORE_VERSION);
  if (!rows.length) return { changed: false, healed: 0, missing: 0 };
  const ids = new Set(mediaRows(ws).map((row) => String(row.id || "")));
  let files = null;
  let backedUp = false;
  let healed = 0;
  let missing = 0;
  let deferred = 0;
  let changed = false;
  for (const row of rows) {
    const rel = String(row.file || "");
    let stat = rel ? await statAsync(path.join(base, rel)) : null;
    if (!stat) {
      if (files === null) files = await mediaIndex(base);
      const candidates = healCandidates(row, files, base, ids);
      if (candidates.length === 1) {
        if (!backedUp) {
          backedUp = true;
          await backupWorkspace(file);
        }
        row.file = candidates[0];
        stat = await statAsync(path.join(base, row.file));
        healed += 1;
        changed = true;
      } else {
        missing += 1;
        continue;
      }
    }
    if (stat && row.size !== stat.size) {
      row.size = stat.size;
      changed = true;
    }
    if (!row.contentHash && stat && stat.size > INLINE_HASH_MAX) deferred += 1;
    else if (!row.contentHash) {
      const hash = await hashFile(path.join(base, row.file), stat).catch(() => "");
      if (hash) {
        row.contentHash = hash;
        changed = true;
      }
    }
    if (row.posterFile && !(await statAsync(path.join(base, row.posterFile)))) {
      row.posterFile = null;
      changed = true;
    }
    row.mediaOk = STORE_VERSION;
    changed = true;
  }
  return { changed, healed, missing, deferred };
}

// Background pass for rows verified without a hash. One file at a time, and
// a file read before (same size and mtime) is not read again.
async function fillMissingHashes(ws, base) {
  let changed = false;
  for (const row of mediaRows(ws)) {
    if (row.contentHash || row.mediaOk !== STORE_VERSION || !row.file) continue;
    const rel = String(row.file);
    const file = path.join(base, rel);
    const stat = await statAsync(file);
    if (!stat || !stat.isFile()) continue;
    const hash = await hashFile(file, stat).catch(() => "");
    if (hash && !row.contentHash && row.file === rel) {
      row.contentHash = hash;
      changed = true;
    }
  }
  return changed;
}

// Stat-only pass for the synchronous reader. Rows whose files exist get
// stamped; rows pointing at nothing stay unstamped so the async pass can heal
// them on the next load.
function verifyWorkspaceSync(dataRoot, ws, deps) {
  const base = deps && deps.workspaceDir;
  for (const row of mediaRows(ws)) {
    if (row.mediaOk === STORE_VERSION) continue;
    const rel = String(row.file || "");
    if (rel && statSync(path.join(base, rel))) row.mediaOk = STORE_VERSION;
  }
  ws.store = Object.assign({}, ws.store, { version: STORE_VERSION });
  return ws;
}

module.exports = { STORE_VERSION, INLINE_HASH_MAX, needsCheck, verifyWorkspace, verifyWorkspaceSync, fillMissingHashes, hashFile };
