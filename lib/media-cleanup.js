"use strict";

const fs = require("fs/promises");
const fssync = require("fs");
const path = require("path");
const { createHash } = require("crypto");
const {
  loadState,
  loadWorkspace,
  saveWorkspace,
  snapshot,
  workspaceDir,
} = require("./workspace-store");
const { libraryFilePath, deleteLibraryItem } = require("./library-io");
const { finishedFilePath, deleteFinishedItem } = require("./finished-io");
const projects = require("./ai-projects");
const fingerprint = require("./media-fingerprint");

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_STALE_DAYS = 30;

function daysBetween(fromIso, toMs) {
  const time = Date.parse(fromIso || "");
  if (!Number.isFinite(time)) return 0;
  return Math.max(0, Math.floor((toMs - time) / DAY_MS));
}

async function hashFile(filePath) {
  const hash = createHash("sha256");
  const stream = fssync.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

async function resolveWorkspace(dataRoot, workspaceId) {
  const state = await loadState(dataRoot);
  const id = workspaceId || state.activeWorkspaceId;
  const ws = await loadWorkspace(dataRoot, id);
  if (!Array.isArray(ws.library)) ws.library = [];
  if (!Array.isArray(ws.finished)) ws.finished = [];
  return { id, ws };
}

// Which projects point at this media: a pinned asset row for library items,
// a render pointer in project state for renders. Card references count too,
// because deleting media a card still draws would leave a hole.
function usageIndex(dataRoot, ws) {
  const usage = new Map();
  const note = (id, label) => {
    if (!id) return;
    const key = String(id);
    if (!usage.has(key)) usage.set(key, { projects: new Set(), cards: new Set(), labels: new Set() });
    const entry = usage.get(key);
    if (label.project) entry.projects.add(label.project);
    if (label.card) entry.cards.add(label.card);
    if (label.where) entry.labels.add(label.where);
  };
  for (const card of ws.cards || []) {
    if (!card) continue;
    const name = card.name || "card";
    if (Array.isArray(card.imageIds)) card.imageIds.forEach((id) => note(id, { card: name, where: "card" }));
    if (card.composition && card.composition.backgroundId) note(card.composition.backgroundId, { card: name, where: "card" });
    if (card.endScreenBackgroundId) note(card.endScreenBackgroundId, { card: name, where: "card" });
  }
  for (const image of ws.cardImages || []) {
    if (image && image.id) note(image.id, { where: "card image" });
  }
  for (const link of ws.links || []) {
    for (const ref of (link && link.refs) || []) note(ref, { where: "link" });
  }
  let listed = [];
  try {
    listed = projects.listProjects(dataRoot, ws.id);
  } catch {
    listed = [];
  }
  const projectTime = new Map();
  for (const project of listed) {
    if (!project) continue;
    const name = project.name || "project";
    const updatedAt = project.updatedAt || "";
    const seen = new Set();
    for (const asset of project.assets || []) {
      if (!asset || !asset.id) continue;
      seen.add(String(asset.id));
      note(asset.id, { project: name, where: "project" });
    }
    const renders = project.state && project.state.renders && typeof project.state.renders === "object" ? project.state.renders : {};
    for (const value of Object.values(renders)) {
      if (!value) continue;
      seen.add(String(value));
      note(value, { project: name, where: "project render" });
    }
    for (const id of seen) {
      const prior = projectTime.get(id) || "";
      if (updatedAt > prior) projectTime.set(id, updatedAt);
    }
  }
  return { usage, projectTime };
}

function mediaRow(kind, item, dataRoot, wsId, extra) {
  const info = extra || {};
  const file = kind === "render" ? finishedFilePath(dataRoot, wsId, item) : libraryFilePath(dataRoot, wsId, item);
  return {
    kind,
    id: String(item.id),
    name: item.name || (kind === "render" ? "Render" : "Media"),
    mediaKind: item.kind || (kind === "render" ? "video" : ""),
    file: item.file || "",
    size: Number(item.size) || 0,
    hash: item.contentHash || "",
    durationMs: Number(item.durationMs) || 0,
    createdAt: item.createdAt || "",
    source: item.source || "",
    mime: item.mime || "",
    hasPoster: Boolean(item.posterFile),
    width: Number(item.width || item.videoWidth) || 0,
    height: Number(item.height || item.videoHeight) || 0,
    phash: item.phash || "",
    shrink: item.shrink && item.shrink.at ? { method: item.shrink.method || "", fromBytes: Number(item.shrink.fromBytes) || 0 } : null,
    projectIds: info.projectIds || [],
    projectNames: info.projectNames || [],
    cardNames: info.cardNames || [],
    where: info.where || [],
    used: Boolean((info.projectNames && info.projectNames.length) || (info.cardNames && info.cardNames.length) || (info.where && info.where.length)),
    usedAt: info.usedAt || item.createdAt || "",
    path: file,
  };
}

// Videos nobody has touched in a while, and byte-identical copies of the same
// clip. The scan never deletes; it reports what could go and what it would free.
async function scanMedia(dataRoot, workspaceId, opts) {
  const options = opts || {};
  const staleDays = Number.isFinite(Number(options.staleDays)) ? Math.max(0, Number(options.staleDays)) : DEFAULT_STALE_DAYS;
  const now = Date.now();
  const { id: wsId, ws } = await resolveWorkspace(dataRoot, workspaceId);
  const { usage, projectTime } = usageIndex(dataRoot, ws);

  const rows = [];
  let hashed = false;
  for (const item of ws.library) {
    if (!item || !item.id) continue;
    const entry = usage.get(String(item.id));
    rows.push(
      mediaRow("library", item, dataRoot, wsId, {
        projectNames: entry ? Array.from(entry.projects) : [],
        cardNames: entry ? Array.from(entry.cards) : [],
        where: entry ? Array.from(entry.labels) : [],
        usedAt: (entry && projectTime.get(String(item.id))) || item.createdAt,
      }),
    );
  }
  for (const item of ws.finished) {
    if (!item || !item.id) continue;
    const entry = usage.get(String(item.id));
    const owners = Array.isArray(item.projectIds) ? item.projectIds : [];
    const names = entry ? Array.from(entry.projects) : [];
    for (const owner of owners) {
      if (!names.includes(owner) && !/^[0-9a-f-]{8,}$/i.test(owner)) names.push(owner);
    }
    rows.push(
      mediaRow("render", item, dataRoot, wsId, {
        projectIds: owners,
        projectNames: names,
        cardNames: entry ? Array.from(entry.cards) : [],
        where: entry ? Array.from(entry.labels) : [],
        usedAt: (entry && projectTime.get(String(item.id))) || item.createdAt,
      }),
    );
  }

  // Fill in a missing hash so two copies of the same bytes are recognised.
  // The value is cached in the workspace so the next scan is a read.
  for (const row of rows) {
    if (row.hash) continue;
    const abs = row.path || path.join(workspaceDir(dataRoot, wsId), row.file);
    try {
      row.hash = await hashFile(abs);
      const list = row.kind === "render" ? ws.finished : ws.library;
      const item = list.find((entry) => entry && String(entry.id) === row.id);
      if (item) {
        item.contentHash = row.hash;
        hashed = true;
      }
    } catch {
      row.hash = "";
    }
  }
  if (await fillFingerprints(dataRoot, wsId, ws, rows, options)) hashed = true;
  if (hashed) await saveWorkspace(dataRoot, ws);

  for (const row of rows) row.daysIdle = daysBetween(row.usedAt, now);

  const groups = new Map();
  for (const row of rows) {
    if (!row.hash) continue;
    const key = row.hash + "|" + row.mediaKind;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const duplicates = [];
  for (const [key, list] of groups) {
    if (list.length < 2) continue;
    const sorted = list.slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const bytes = sorted.reduce((sum, row) => sum + row.size, 0);
    const keep = chooseKeeper(sorted);
    duplicates.push({
      hash: key.split("|")[0],
      mediaKind: sorted[0].mediaKind,
      items: sorted,
      count: sorted.length,
      bytes,
      recoverableBytes: bytes - keep.size,
      keep: { kind: keep.kind, id: keep.id, name: keep.name },
    });
  }
  duplicates.sort((a, b) => b.recoverableBytes - a.recoverableBytes);

  const stale = rows
    .filter((row) => !row.used && row.daysIdle >= staleDays)
    .sort((a, b) => b.daysIdle - a.daysIdle);

  const nearDuplicates = lookAlikeGroups(rows);
  const totalBytes = rows.reduce((sum, row) => sum + row.size, 0);
  return {
    workspaceId: wsId,
    scannedAt: new Date(now).toISOString(),
    staleDays,
    totals: {
      count: rows.length,
      bytes: totalBytes,
      duplicates: duplicates.length,
      duplicateBytes: duplicates.reduce((sum, group) => sum + group.recoverableBytes, 0),
      stale: stale.length,
      staleBytes: stale.reduce((sum, row) => sum + row.size, 0),
      nearDuplicates: nearDuplicates.length,
      nearDuplicateBytes: nearDuplicates.reduce((sum, group) => sum + group.recoverableBytes, 0),
    },
    items: rows,
    duplicates,
    nearDuplicates,
    stale,
  };
}

function pixels(row) {
  return (row.width || 0) * (row.height || 0);
}

// Cards can only draw library images, so a group holding a card's image must
// keep a library copy. A render can never be the survivor that a card ends
// up pointing at.
function mustKeepLibrary(list) {
  return list.some((row) => row.kind === "library" && Array.isArray(row.cardNames) && row.cardNames.length);
}

function chooseKeeper(list) {
  const allowed = mustKeepLibrary(list) ? list.filter((row) => row.kind === "library") : list;
  return allowed.find((row) => row.used) || allowed[0];
}

// The copy to keep from a look-alike set: one something already uses, then
// the sharpest (most pixels), then the biggest file, then the newest.
function keeperOrder(list) {
  return list.slice().sort((a, b) => {
    if (a.used !== b.used) return a.used ? -1 : 1;
    if (pixels(a) !== pixels(b)) return pixels(b) - pixels(a);
    if (a.size !== b.size) return b.size - a.size;
    return String(b.createdAt).localeCompare(String(a.createdAt));
  });
}

// Media that looks the same but is not byte-identical: a re-export, the same
// cut rendered twice, a run of screenshots of a screen that did not change.
// Groups that are only exact copies already show under Duplicates.
function lookAlikeGroups(rows) {
  const out = [];
  // Exact copies already have their own group; one row per hash here.
  const seen = new Set();
  const unique = [];
  for (const row of keeperOrder(rows)) {
    const key = (row.hash || row.kind + ":" + row.id) + "|" + row.mediaKind;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(row);
  }
  for (const group of fingerprint.groupNearDuplicates(unique)) {
    const keep = chooseKeeper(group);
    const sorted = group.slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const bytes = sorted.reduce((sum, row) => sum + row.size, 0);
    let worst = 0;
    for (const row of sorted) {
      if (row === keep) continue;
      const d = fingerprint.distance(row, keep);
      if (Number.isFinite(d)) worst = Math.max(worst, d / (row.mediaKind === "image" ? fingerprint.hashBits(keep.phash) : 64));
    }
    out.push({
      id: keep.kind + ":" + keep.id,
      mediaKind: keep.mediaKind,
      items: sorted,
      count: sorted.length,
      bytes,
      recoverableBytes: bytes - keep.size,
      keep: { kind: keep.kind, id: keep.id, name: keep.name },
      similarity: Math.max(0, Math.round((1 - worst) * 100)),
    });
  }
  return out.sort((a, b) => b.recoverableBytes - a.recoverableBytes);
}

async function mapLimit(list, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (next < list.length) {
      const index = next;
      next += 1;
      await fn(list[index]);
    }
  });
  await Promise.all(workers);
}

// Perceptual fingerprints for look-alike checks, and a poster still for any
// video without one. Both are cached on the workspace row, so only new media
// costs anything. Needs ffmpeg (and nativeImage for fast PNG/JPEG reads).
async function fillFingerprints(dataRoot, wsId, ws, rows, options) {
  if (!options.ffmpeg && !options.nativeImage) return false;
  const base = workspaceDir(dataRoot, wsId);
  const itemFor = (row) => (row.kind === "render" ? ws.finished : ws.library).find((entry) => entry && String(entry.id) === row.id);
  let changed = false;
  for (const row of rows) {
    if (row.phash || row.mediaKind !== "image") continue;
    const res = await fingerprint.imageDhash(row.path, { nativeImage: options.nativeImage, ffmpeg: options.ffmpeg });
    const item = itemFor(row);
    if (!res || !res.hash || !item) continue;
    row.phash = item.phash = res.hash;
    if (res.width && res.height) {
      row.width = item.width = res.width;
      row.height = item.height = res.height;
    }
    changed = true;
  }
  if (!options.ffmpeg) return changed;
  const { probeVideo, makePoster } = require("./media-shrink");
  const videos = rows.filter((row) => row.mediaKind === "video" && (!row.phash || !row.hasPoster));
  await mapLimit(videos, 3, async (row) => {
    const item = itemFor(row);
    if (!item) return;
    if (!row.durationMs || !row.width) {
      const probe = await probeVideo(options.ffmpeg, row.path);
      if (probe.durationMs && !row.durationMs) row.durationMs = item.durationMs = probe.durationMs;
      if (probe.width) {
        row.width = probe.width;
        row.height = probe.height;
      }
      changed = true;
    }
    if (!row.phash) {
      const sig = await fingerprint.videoSignature(row.path, row.durationMs, { ffmpeg: options.ffmpeg });
      if (sig) {
        row.phash = item.phash = sig;
        changed = true;
      }
    }
    if (!row.hasPoster) {
      const rel = path.join(row.kind === "render" ? "finished-posters" : "posters", row.id + ".jpg");
      await fs.mkdir(path.join(base, path.dirname(rel)), { recursive: true });
      if (await makePoster(options.ffmpeg, row.path, path.join(base, rel), row.durationMs)) {
        item.posterFile = rel;
        row.hasPoster = true;
        changed = true;
      }
    }
  });
  return changed;
}

// Cards draw library images by id. When a look-alike image goes, the cards
// that drew it switch to the kept image instead of losing it.
async function repointCards(dataRoot, wsId, fromId, toId) {
  const ws = await loadWorkspace(dataRoot, wsId);
  let changes = 0;
  for (const card of ws.cards || []) {
    if (!card) continue;
    if (Array.isArray(card.imageIds) && card.imageIds.includes(fromId)) {
      card.imageIds = Array.from(new Set(card.imageIds.map((id) => (id === fromId ? toId : id))));
      changes += 1;
    }
    const comp = card.composition;
    if (comp && comp.backgroundId === fromId) {
      comp.backgroundId = toId;
      changes += 1;
    }
    if (comp && comp.imageLayouts && comp.imageLayouts[fromId]) {
      if (!comp.imageLayouts[toId]) comp.imageLayouts[toId] = comp.imageLayouts[fromId];
      delete comp.imageLayouts[fromId];
      changes += 1;
    }
    if (card.endScreenBackgroundId === fromId) {
      card.endScreenBackgroundId = toId;
      changes += 1;
    }
  }
  if (changes) await saveWorkspace(dataRoot, ws);
  return changes;
}

// Delete one item. When a `keep` twin is given every project reference is
// pointed at the twin first, so a duplicate can go without breaking an edit.
async function deleteMedia(dataRoot, workspaceId, payload) {
  const body = payload || {};
  const kind = String(body.kind || "");
  const id = String(body.id || "");
  if (!id || (kind !== "library" && kind !== "render")) throw new Error("Pick a media item to delete.");
  const { id: wsId } = await resolveWorkspace(dataRoot, workspaceId);

  const keep = body.keep && body.keep.id ? body.keep : null;
  let repointed = null;
  if (keep && String(keep.id) !== id) {
    const keepKind = keep.kind === "render" ? "render" : "library";
    repointed = projects.repointMedia(
      dataRoot,
      wsId,
      { kind, id },
      { kind: keepKind, id: String(keep.id) },
    );
    if (kind === "library" && keepKind === "library") {
      const cards = await repointCards(dataRoot, wsId, id, String(keep.id));
      if (cards) repointed = Object.assign({}, repointed, { cards });
    }
  }

  if (kind === "library") {
    await deleteLibraryItem(dataRoot, id, wsId);
  } else {
    await deleteFinishedItem(dataRoot, id, wsId);
    if (!keep) {
      try {
        projects.dropRender(dataRoot, wsId, id);
      } catch {
        /* the render file removal stays authoritative */
      }
    }
  }
  return { deleted: { kind, id }, repointed, snapshot: await snapshot(dataRoot, wsId) };
}

// Several deletes from one click (a multi-select, or every extra in a group).
// Each item goes through deleteMedia so references stay right; one failure
// does not stop the rest, and the caller gets one fresh snapshot.
async function deleteMany(dataRoot, workspaceId, payload) {
  const list = Array.isArray(payload && payload.items) ? payload.items : [];
  if (!list.length) throw new Error("Pick media to delete.");
  const { id: wsId } = await resolveWorkspace(dataRoot, workspaceId);
  const deleted = [];
  const failed = [];
  let freedBytes = 0;
  for (const entry of list) {
    const ws = await loadWorkspace(dataRoot, wsId);
    const pool = entry && entry.kind === "render" ? ws.finished || [] : ws.library || [];
    const item = pool.find((row) => row && String(row.id) === String(entry && entry.id));
    const size = item ? Number(item.size) || 0 : 0;
    try {
      await deleteMedia(dataRoot, wsId, entry);
      deleted.push({ kind: entry.kind, id: String(entry.id) });
      freedBytes += size;
    } catch (error) {
      failed.push({ kind: entry && entry.kind, id: entry && entry.id, error: (error && error.message) || String(error) });
    }
  }
  return { deleted, failed, freedBytes, snapshot: await snapshot(dataRoot, wsId) };
}

module.exports = { scanMedia, deleteMedia, deleteMany, lookAlikeGroups, DEFAULT_STALE_DAYS };
