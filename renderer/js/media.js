// Media helpers shared by Home, Library, and the editor: thumbnails, the
// import flow (drop or picker, with real byte progress), poster backfill,
// and the library picker dialog.

import { api, store, refreshSnapshot, thumbFor, libraryUrl } from "./store.js";
import { esc, icon, kindIcon, formatDuration, formatBytes, toast, openDialog, closeDialog, errorText } from "./ui.js";

export function thumbMarkup(item, cls = "tile-thumb") {
  const src = thumbFor(item);
  return (
    '<div class="' + cls + '" data-kind="' + esc((item && item.kind) || "") + '">' +
    (src ? '<img src="' + esc(src) + '" alt="" loading="lazy" draggable="false">' : kindIcon(item && item.kind, "i-lg")) +
    "</div>"
  );
}

// A file saved under a random id ("1ba28e02-6c82-...") gets a readable name.
const ID_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[a-z0-9]+)?$/i;
export function displayName(item) {
  if (!item) return "";
  const name = String(item.name || "");
  if (name && !ID_NAME.test(name)) return name;
  const kind = item.kind === "audio" ? "Audio" : item.kind === "image" ? "Image" : "Video";
  const at = Date.parse(item.createdAt || "");
  return kind + (Number.isFinite(at) ? " from " + new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " + new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "");
}

export const KIND_LABEL = { all: "All", video: "Videos", image: "Images", audio: "Audio" };

export function mediaMeta(item) {
  if (!item) return "";
  // No length known yet: the file size says more than the word "video".
  if (item.kind === "video" || item.kind === "audio") return item.durationMs ? formatDuration(item.durationMs) : item.size ? formatBytes(item.size) : "";
  if (item.kind === "image") return item.videoWidth ? item.videoWidth + "×" + item.videoHeight : formatBytes(item.size);
  return formatBytes(item.size);
}

export function mediaChip(item, removable = true) {
  const src = thumbFor(item);
  return (
    '<span class="media-chip" data-pin="' + esc(item.id) + '">' +
    (src ? '<img src="' + esc(src) + '" alt="">' : '<span class="ph">' + kindIcon(item.kind, "i-sm") + "</span>") +
    '<span class="ellipsis" title="' + esc(displayName(item)) + '">' + esc(displayName(item)) + "</span>" +
    (removable ? '<button class="x" data-unpin="' + esc(item.id) + '" title="Remove">' + icon("x", "i-sm") + "</button>" : "") +
    "</span>"
  );
}

// ---------- import ----------

let progressEl = null;
function showProgress(text, pct) {
  if (!progressEl) {
    progressEl = document.createElement("div");
    progressEl.className = "toast";
    progressEl.style.minWidth = "280px";
    progressEl.style.display = "grid";
    progressEl.style.gap = "8px";
    document.getElementById("toasts").appendChild(progressEl);
  }
  progressEl.innerHTML = '<div class="row">' + icon("upload") + '<span class="grow">' + esc(text) + '</span></div><div class="progress"><span style="width:' + Math.round(pct * 100) + '%"></span></div>';
}
function hideProgress() {
  if (progressEl) progressEl.remove();
  progressEl = null;
}

const KIND_BY_EXT = {
  video: ["mp4", "m4v", "mov", "webm", "avi", "mkv"],
  image: ["png", "jpg", "jpeg", "webp", "gif"],
  audio: ["mp3", "wav", "ogg", "m4a", "aac", "flac"],
};

function kindOf(path) {
  const ext = String(path).split(".").pop().toLowerCase();
  for (const [kind, list] of Object.entries(KIND_BY_EXT)) if (list.includes(ext)) return kind;
  return "";
}

// Copies files into the library. Returns the library items now holding them
// (new ones and ones that were already there), so callers can pin them.
export async function importPaths(paths) {
  const list = (paths || []).filter(Boolean);
  if (!list.length || !api) return [];
  const before = new Set(store.library.map((item) => item.id));
  const off = api.onAddFilesProgress
    ? api.onAddFilesProgress((m) => {
        if (!m) return;
        const bytes = Number(m.bytes) || 0;
        const fileShare = bytes ? (Number(m.copied) || 0) / bytes : m.phase === "done" ? 1 : 0;
        const files = Number(m.total) || 1;
        const index = m.phase === "done" ? Math.max(0, (Number(m.index) || 1) - 1) : Number(m.index) || 0;
        showProgress((m.skipped ? "Already have " : "Importing ") + (m.name || "media"), Math.min(1, (index + fileShare) / files));
      })
    : null;
  showProgress("Importing " + list.length + (list.length === 1 ? " file" : " files"), 0);
  try {
    const usable = list.filter((p) => kindOf(p));
    if (!usable.length) {
      toast("Those files are not video, image, or audio.", true);
      return [];
    }
    if (usable.length < list.length) toast(list.length - usable.length + " file(s) skipped: not video, image, or audio.", true);
    const result = await api.addFiles({ paths: usable });
    const skipped = result && Array.isArray(result.skipped) ? result.skipped : [];
    const snap = await refreshSnapshot();
    const added = (snap.workspace.library || []).filter((item) => !before.has(item.id));
    const kept = skipped.map((s) => store.mediaById(s && (s.existingId || s.id))).filter(Boolean);
    if (added.length) toast(added.length === 1 ? "Imported " + added[0].name : "Imported " + added.length + " files");
    else if (kept.length) toast("Already in your library");
    void backfillPosters(added);
    return added.concat(kept);
  } catch (error) {
    toast(errorText(error), true);
    return [];
  } finally {
    if (off) off();
    hideProgress();
  }
}

export async function pickAndImport(kind) {
  if (!api) return [];
  const picked = await api.pickFiles(kind || "media");
  const paths = Array.isArray(picked) ? picked : (picked && picked.paths) || [];
  if (!paths.length) return [];
  return importPaths(paths);
}

export function pathsFromDrop(event) {
  const files = Array.from((event.dataTransfer && event.dataTransfer.files) || []);
  return files.map((file) => (api && api.pathForFile ? api.pathForFile(file) : "")).filter(Boolean);
}

// Makes an element accept dropped files. onPaths gets the local paths.
export function wireDrop(el, onPaths, overClass = "is-over") {
  let depth = 0;
  const hasFiles = (event) => Array.from((event.dataTransfer && event.dataTransfer.types) || []).includes("Files");
  el.addEventListener("dragenter", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth += 1;
    el.classList.add(overClass);
  });
  el.addEventListener("dragover", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  });
  el.addEventListener("dragleave", () => {
    depth = Math.max(0, depth - 1);
    if (!depth) el.classList.remove(overClass);
  });
  el.addEventListener("drop", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth = 0;
    el.classList.remove(overClass);
    const paths = pathsFromDrop(event);
    if (paths.length) onPaths(paths);
  });
}

// ---------- posters ----------

// A video row needs a still, a length, and a frame size before it reads
// right everywhere. Grab the brightest of a few early frames and store it.
const filling = new Set();
const POSTER_TIMES = [0.15, 0.5, 1.0];

function grabPoster(url) {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.preload = "auto";
    video.src = url;
    let best = null;
    let i = 0;
    const done = (value) => {
      video.removeAttribute("src");
      video.load();
      resolve(value);
    };
    const timer = setTimeout(() => done(best), 12000);
    video.addEventListener("error", () => {
      clearTimeout(timer);
      done(null);
    });
    video.addEventListener("loadedmetadata", () => {
      video.currentTime = Math.min(POSTER_TIMES[0], Math.max(0, video.duration - 0.05));
    });
    video.addEventListener("seeked", () => {
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (w && h) {
        const scale = Math.min(1, 640 / w);
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(w * scale);
        canvas.height = Math.round(h * scale);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        let light = 0;
        try {
          const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          for (let p = 0; p < px.length; p += 64) light += px[p] + px[p + 1] + px[p + 2];
        } catch {
          light = 0;
        }
        if (!best || light > best.light) best = { canvas, light, width: w, height: h, durationMs: Math.round(video.duration * 1000) };
      }
      i += 1;
      if (i < POSTER_TIMES.length && POSTER_TIMES[i] < video.duration) video.currentTime = POSTER_TIMES[i];
      else {
        clearTimeout(timer);
        if (!best) return done(null);
        best.canvas.toBlob(async (blob) => {
          const buffer = blob ? new Uint8Array(await blob.arrayBuffer()) : null;
          done({ buffer, width: best.width, height: best.height, durationMs: best.durationMs });
        }, "image/jpeg", 0.82);
      }
    });
  });
}

export async function backfillPosters(items) {
  const list = (items || store.library).filter(
    (item) => item && item.kind === "video" && (!item.posterFile || !item.videoWidth || !item.durationMs) && !filling.has(item.id),
  );
  let changed = false;
  for (const item of list.slice(0, 24)) {
    filling.add(item.id);
    try {
      const shot = await grabPoster(libraryUrl(item.id));
      if (!shot) continue;
      const patch = {};
      if (!item.posterFile && shot.buffer) patch.poster = { mime: "image/jpeg", data: shot.buffer };
      if (!item.videoWidth && shot.width) {
        patch.videoWidth = shot.width;
        patch.videoHeight = shot.height;
      }
      if (!item.durationMs && shot.durationMs) patch.durationMs = shot.durationMs;
      if (Object.keys(patch).length) {
        store.snapshot = await api.updateLibraryItem(item.id, patch);
        changed = true;
      }
    } catch {
      /* the next open tries again */
    } finally {
      filling.delete(item.id);
    }
  }
  return changed;
}

// ---------- picker ----------

// Lets the user choose library items. Resolves with the chosen items.
// `exclude` items stay visible but greyed with `excludeLabel`, so nobody
// thinks media went missing.
export function pickMedia({ title = "Add media", confirm = "Add", exclude = [], excludeLabel = "Already added", kinds = ["video", "image", "audio"] } = {}) {
  return new Promise((resolve) => {
    const chosen = new Set();
    const skip = new Set(exclude.map(String));
    let kind = "all";
    let query = "";
    let answered = false;
    const dlg = openDialog({
      title,
      wide: true,
      body:
        '<div class="toolbar">' +
        '<div class="search grow">' + icon("search") + '<input class="input" data-q placeholder="Search media"></div>' +
        '<div class="seg" data-kinds' + (kinds.length < 2 ? ' style="display:none"' : "") + '>' +
        ["all"].concat(kinds).map((k) => '<button data-kind="' + k + '"' + (k === "all" ? ' class="is-on"' : "") + ">" + KIND_LABEL[k] + "</button>").join("") +
        "</div>" +
        '<button class="btn" data-import>' + icon("upload") + "Import files</button>" +
        "</div>" +
        '<div class="media-grid" data-grid style="max-height:52vh;overflow:auto;padding:2px"></div>',
      foot: '<span class="faint grow" data-count></span><button class="btn btn-ghost" data-no>Cancel</button><button class="btn btn-primary" data-yes disabled>' + esc(confirm) + "</button>",
      onClose: () => {
        if (!answered) resolve([]);
      },
    });
    const grid = dlg.querySelector("[data-grid]");
    const paintGrid = () => {
      const items = store.library
        .filter((item) => kinds.includes(item.kind))
        .filter((item) => kind === "all" || item.kind === kind)
        .filter((item) => !query || displayName(item).toLowerCase().includes(query))
        .sort((a, b) => Number(skip.has(a.id)) - Number(skip.has(b.id)) || String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
      grid.innerHTML = items.length
        ? items.map((item) =>
            '<button class="tile' + (chosen.has(item.id) ? " is-selected" : "") + (skip.has(item.id) ? " is-taken" : "") + '"' + (skip.has(item.id) ? " disabled" : ' data-pick="' + esc(item.id) + '"') + ' title="' + esc(displayName(item)) + '">' +
            thumbMarkup(item) + '<div class="tile-meta"><div class="grow"><strong>' + esc(displayName(item)) + "</strong><small>" + esc(skip.has(item.id) ? excludeLabel : mediaMeta(item)) + "</small></div>" +
            (chosen.has(item.id) ? '<span class="pill pill-accent">' + icon("check", "i-sm") + "</span>" : "") + "</div></button>").join("")
        : '<div class="empty" style="grid-column:1/-1">' + icon("library", "i-xl") + "<h3>No media here</h3><p>Import videos, images, or audio to use them in projects.</p></div>";
      dlg.querySelector("[data-count]").textContent = chosen.size ? chosen.size + " selected" : "";
      dlg.querySelector("[data-yes]").disabled = !chosen.size;
    };
    grid.addEventListener("click", (event) => {
      const tile = event.target.closest("[data-pick]");
      if (!tile) return;
      const id = tile.dataset.pick;
      if (chosen.has(id)) chosen.delete(id);
      else chosen.add(id);
      paintGrid();
    });
    grid.addEventListener("dblclick", (event) => {
      const tile = event.target.closest("[data-pick]");
      if (!tile) return;
      chosen.add(tile.dataset.pick);
      finish();
    });
    dlg.querySelector("[data-q]").addEventListener("input", (event) => {
      query = event.target.value.trim().toLowerCase();
      paintGrid();
    });
    dlg.querySelector("[data-kinds]").addEventListener("click", (event) => {
      const b = event.target.closest("[data-kind]");
      if (!b) return;
      kind = b.dataset.kind;
      dlg.querySelectorAll("[data-kind]").forEach((x) => x.classList.toggle("is-on", x === b));
      paintGrid();
    });
    dlg.querySelector("[data-import]").addEventListener("click", async () => {
      const added = await pickAndImport();
      for (const item of added) chosen.add(item.id);
      paintGrid();
    });
    const finish = () => {
      answered = true;
      const items = Array.from(chosen).map((id) => store.mediaById(id)).filter(Boolean);
      resolve(items);
      closeDialog();
    };
    dlg.querySelector("[data-no]").addEventListener("click", () => closeDialog());
    dlg.querySelector("[data-yes]").addEventListener("click", finish);
    paintGrid();
    setTimeout(() => dlg.querySelector("[data-q]").focus(), 0);
  });
}
