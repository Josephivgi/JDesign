import { api, store, on, emit, refreshSnapshot, refreshProjects, mediaUrlFor, thumbFor } from "../store.js";
import { esc, icon, toast, showMenu, confirmDialog, promptDialog, openDialog, formatBytes, timeAgo, errorText } from "../ui.js";
import { thumbMarkup, mediaMeta, pickAndImport, importPaths, wireDrop, backfillPosters, displayName } from "../media.js";

const view = { kind: "all", query: "", sort: "new", from: "all" };

// Files an agent made (voice lines, renders, scratch clips) versus files the
// person brought in, so agent output can be filtered out of the way.
const AGENT_SOURCES = new Set(["agent", "animation", "compose", "finished-export", "tts", "music", "render"]);
const madeByAgent = (item) => AGENT_SOURCES.has(String(item.source || ""));
const FROM = [
  { id: "all", label: "Anyone" },
  { id: "you", label: "You" },
  { id: "agents", label: "Agents" },
];

// "video/webm" -> "Video (WebM)".
function typeLabel(item) {
  const kind = item.kind === "audio" ? "Audio" : item.kind === "image" ? "Image" : "Video";
  const sub = String(item.mime || "").split("/")[1] || "";
  const pretty = { webm: "WebM", mp4: "MP4", quicktime: "MOV", mpeg: "MP3", wav: "WAV", "x-wav": "WAV", ogg: "OGG", png: "PNG", jpeg: "JPEG", webp: "WebP", gif: "GIF", aac: "AAC", flac: "FLAC", "x-m4a": "M4A", mp3: "MP3" }[sub.toLowerCase()];
  return kind + (pretty ? " (" + pretty + ")" : "");
}

let player = null;
let playingId = "";

const SORTS = [
  { id: "new", label: "Newest first" },
  { id: "old", label: "Oldest first" },
  { id: "name", label: "Name" },
  { id: "size", label: "Largest first" },
];

function filtered() {
  const q = view.query.toLowerCase();
  const list = store.library
    .filter((item) => view.kind === "all" || item.kind === view.kind)
    .filter((item) => view.from === "all" || (view.from === "agents") === madeByAgent(item))
    .filter((item) => !q || displayName(item).toLowerCase().includes(q) || String(item.description || "").toLowerCase().includes(q));
  const by = {
    new: (a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")),
    old: (a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")),
    name: (a, b) => String(a.name || "").localeCompare(String(b.name || "")),
    size: (a, b) => (Number(b.size) || 0) - (Number(a.size) || 0),
  };
  return list.sort(by[view.sort] || by.new);
}

function preview(item) {
  const url = mediaUrlFor(item);
  // The player takes the video's own shape and shows its still at once, so
  // the dialog opens at its final size instead of jumping when the file loads.
  const poster = thumbFor(item);
  const shape = item.videoWidth && item.videoHeight ? ";aspect-ratio:" + Number(item.videoWidth) + " / " + Number(item.videoHeight) : "";
  const media =
    item.kind === "video"
      ? '<video src="' + esc(url) + '" controls autoplay' + (poster ? ' poster="' + esc(poster) + '"' : "") + ' style="width:100%;max-height:62vh;background:var(--stage);border-radius:8px' + shape + '"></video>'
      : item.kind === "audio"
        ? '<audio src="' + esc(url) + '" controls autoplay style="width:100%"></audio>'
        : '<img src="' + esc(url) + '" alt="" style="max-width:100%;max-height:62vh;margin:auto;border-radius:8px">';
  openDialog({
    title: displayName(item),
    wide: true,
    body:
      media +
      '<dl class="kv" style="margin-top:14px">' +
      "<dt>Type</dt><dd>" + esc(typeLabel(item)) + "</dd>" +
      (item.durationMs ? "<dt>Length</dt><dd>" + esc(mediaMeta(item)) + "</dd>" : "") +
      (item.videoWidth ? "<dt>Size</dt><dd>" + item.videoWidth + " × " + item.videoHeight + "</dd>" : "") +
      "<dt>File size</dt><dd>" + esc(formatBytes(item.size)) + "</dd>" +
      "<dt>Added</dt><dd>" + esc(timeAgo(item.createdAt)) + "</dd>" +
      "<dt>Made by</dt><dd>" + (madeByAgent(item) ? "An agent" : "You") + "</dd>" +
      (item.name && item.name !== displayName(item) ? '<dt>File name</dt><dd class="mono">' + esc(item.name) + "</dd>" : "") +
      "</dl>",
  });
}

export function renderLibrary(main) {
  main.innerHTML =
    '<div class="page" data-lib><div class="page-inner">' +
    // The count belongs with the title; the filter bar holds only controls.
    '<div class="page-head"><div class="grow"><h1>Library <span class="count" data-total></span></h1><p>Every video, image, and sound JV and your agents can use.</p></div>' +
    '<button class="btn btn-primary" data-import>' + icon("upload") + "Import</button></div>" +
    '<div class="toolbar">' +
    '<div class="search">' + icon("search") + '<input class="input" data-q placeholder="Search library" aria-label="Search library" value="' + esc(view.query) + '"></div>' +
    '<div class="seg" data-kinds>' +
    [["all", "All"], ["video", "Videos"], ["image", "Images"], ["audio", "Audio"]].map(([k, l]) => '<button data-kind="' + k + '"' + (view.kind === k ? ' class="is-on"' : "") + ">" + l + "</button>").join("") +
    "</div>" +
    '<button class="picker is-boxed" data-from title="Who made it">' + icon("user", "i-sm") + '<span data-from-label></span>' + icon("chevDown", "i-sm chev") + "</button>" +
    '<button class="picker is-boxed" data-sort title="Sort">' + icon("sort", "i-sm") + '<span data-sort-label></span>' + icon("chevDown", "i-sm chev") + "</button>" +
    "</div>" +
    '<div data-grid></div>' +
    "</div></div>";

  const grid = main.querySelector("[data-grid]");
  const paint = () => {
    const items = filtered();
    const all = store.library;
    main.querySelector("[data-total]").textContent = all.length + " items · " + formatBytes(all.reduce((sum, item) => sum + (Number(item.size) || 0), 0));
    main.querySelector("[data-sort-label]").textContent = (SORTS.find((s) => s.id === view.sort) || SORTS[0]).label;
    main.querySelector("[data-from-label]").textContent = "Made by: " + (FROM.find((f) => f.id === view.from) || FROM[0]).label;
    if (!all.length) {
      // No button here: Import lives in the header, and the whole page is the
      // drop target. The dashed plate is the one affordance this state needs.
      grid.innerHTML = '<div class="empty is-dropzone">' + icon("upload", "i-xl") + "<h3>Your library is empty</h3>" +
        "<p>Drop video, image, or audio files anywhere on this page, or use Import at the top right. Agents can also add media they make.</p></div>";
      return;
    }
    if (!items.length) {
      // Filtered to nothing is a different state from an empty library: say
      // which filter did it and offer the way back.
      const kindWord = { all: "items", video: "videos", image: "images", audio: "audio" }[view.kind] || "items";
      const fromWord = view.from === "you" ? " made by you" : view.from === "agents" ? " made by agents" : "";
      const qWord = view.query ? " matching “" + esc(view.query) + "”" : "";
      grid.innerHTML = '<div class="empty">' + icon("search", "i-xl") + "<h3>No matches</h3>" +
        "<p>No " + kindWord + fromWord + qWord + ". Your library has " + all.length + (all.length === 1 ? " item" : " items") + ".</p>" +
        '<button type="button" class="btn btn-sm" data-clear>Clear filters</button></div>';
      grid.querySelector("[data-clear]").addEventListener("click", clearFilters);
      return;
    }
    grid.innerHTML =
      '<div class="media-grid">' +
      items.map((item) =>
        '<div class="tile' + (item.kind === "audio" ? " is-audio" : "") + '" data-id="' + esc(item.id) + '" role="button" tabindex="0" draggable="false">' +
        '<div class="tile-shot">' + thumbMarkup(item) +
        // Audio plays right on the tile; its big music icon already says what it is.
        (item.kind === "audio"
          ? '<button class="icon-btn tile-play" data-play="' + esc(item.id) + '" title="' + (playingId === item.id ? "Stop" : "Play") + '" aria-label="' + (playingId === item.id ? "Stop " : "Play ") + esc(displayName(item)) + '">' + icon(playingId === item.id ? "stop" : "play") + "</button>"
          : '<span class="tile-kind">' + icon(item.kind === "video" ? "film" : "image", "i-sm") + "</span>") +
        (item.durationMs ? '<span class="tile-badge">' + esc(mediaMeta(item)) + "</span>" : "") + "</div>" +
        '<div class="tile-meta"><div class="grow"><strong title="' + esc(displayName(item)) + '">' + esc(displayName(item)) + "</strong>" + ((meta) => "<small title=\"" + esc(meta) + "\">" + esc(meta) + "</small>")(formatBytes(item.size) + " · " + timeAgo(item.createdAt) + (madeByAgent(item) ? " · agent" : "") + (item.aiCanUse === false ? " · hidden from agents" : "")) + "</div>" +
        '<button class="icon-btn icon-btn-sm tile-more" data-more="' + esc(item.id) + '" title="More" aria-label="More for ' + esc(displayName(item)) + '">' + icon("more") + "</button></div></div>",
      ).join("") +
      "</div>";
  };

  // Back to the whole library in one click, focus in the search box it cleared.
  const clearFilters = () => {
    view.query = "";
    view.kind = "all";
    view.from = "all";
    const box = main.querySelector("[data-q]");
    box.value = "";
    main.querySelectorAll("[data-kind]").forEach((b) => b.classList.toggle("is-on", b.dataset.kind === "all"));
    paint();
    box.focus();
  };

  grid.addEventListener("click", (event) => {
    const more = event.target.closest("[data-more]");
    const tile = event.target.closest("[data-id]");
    if (!tile) return;
    const item = store.mediaById(tile.dataset.id);
    if (!item) return;
    if (event.target.closest("[data-play]")) {
      event.stopPropagation();
      const again = playingId === item.id;
      if (player) { player.pause(); player = null; }
      playingId = "";
      if (!again) {
        player = new Audio(mediaUrlFor(item));
        playingId = item.id;
        player.addEventListener("ended", () => { playingId = ""; player = null; if (grid.isConnected) paint(); });
        player.play().catch((e) => { playingId = ""; toast(errorText(e), true); paint(); });
      }
      paint();
      return;
    }
    if (!more) return preview(item);
    event.stopPropagation();
    showMenu(more, [
      { label: "Preview", icon: "eye", onSelect: () => preview(item) },
      { label: "Add to project", icon: "plus", onSelect: () => addToProject(more, item) },
      { label: "Rename", icon: "pencil", onSelect: async () => {
        const name = await promptDialog({ title: "Rename", value: displayName(item) });
        if (!name) return;
        try {
          store.snapshot = await api.updateLibraryItem(item.id, { name });
          paint();
        } catch (error) {
          toast(errorText(error), true);
        }
      } },
      { label: item.aiCanUse === false ? "Let agents use this" : "Hide from agents", icon: item.aiCanUse === false ? "eye" : "eyeOff", onSelect: async () => {
        store.snapshot = await api.updateLibraryItem(item.id, { aiCanUse: item.aiCanUse === false });
        toast(item.aiCanUse === false ? "Agents can use it" : "Hidden from agents");
        paint();
      } },
      "sep",
      { label: "Delete", icon: "trash", danger: true, onSelect: async () => {
        const ok = await confirmDialog({ title: "Delete " + displayName(item) + "?", body: "The file is removed from your library. Projects that use it lose this media.", confirm: "Delete", danger: true });
        if (!ok) return;
        try {
          await api.deleteLibraryItem(item.id);
          await refreshSnapshot();
          toast("Deleted");
        } catch (error) {
          toast(errorText(error), true);
        }
      } },
    ], { align: "end" });
  });
  grid.addEventListener("keydown", (event) => {
    const tile = event.target.closest("[data-id]");
    if (tile && event.key === "Enter") preview(store.mediaById(tile.dataset.id));
  });
  main.querySelector("[data-q]").addEventListener("input", (event) => {
    view.query = event.target.value.trim();
    paint();
  });
  main.querySelector("[data-kinds]").addEventListener("click", (event) => {
    const b = event.target.closest("[data-kind]");
    if (!b) return;
    view.kind = b.dataset.kind;
    main.querySelectorAll("[data-kind]").forEach((x) => x.classList.toggle("is-on", x === b));
    paint();
  });
  // Puts a library item into a project without opening it.
  async function addToProject(anchor, item) {
    const projects = store.projects || (await refreshProjects().catch(() => [])) || [];
    const rows = projects.slice().sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    const items = [{ heading: "Add to project" }].concat(rows.length ? rows.map((p) => {
      const has = (p.assets || []).some((a) => a.id === item.id);
      return { label: p.name, sub: has ? "Already in it" : timeAgo(p.updatedAt), icon: "film", disabled: has, onSelect: async () => {
        try {
          await api.aiProjectAddAssets({ id: p.id, assetIds: [item.id] });
          await refreshProjects();
          toast("Added to " + p.name);
        } catch (error) {
          toast(errorText(error), true);
        }
      } };
    }) : [{ label: "No projects yet", disabled: true }]);
    items.push("sep", { label: "New project with this", icon: "plus", onSelect: async () => {
      try {
        const project = await api.aiProjectCreate({ name: displayName(item), aspectRatio: item.videoWidth && item.videoHeight > item.videoWidth ? "9/16" : "16/9", assetIds: [item.id] });
        await refreshProjects();
        emit("navigate", { page: "editor", params: { projectId: project.id } });
      } catch (error) {
        toast(errorText(error), true);
      }
    } });
    showMenu(anchor, items, { align: "end", width: 280, search: rows.length > 8 ? "Search projects" : "" });
  }

  main.querySelector("[data-from]").addEventListener("click", (event) => {
    showMenu(event.currentTarget, FROM.map((f) => ({ label: f.label, sub: f.id === "agents" ? "Voice lines, renders and clips agents made" : f.id === "you" ? "Files you imported" : "", checked: f.id === view.from, onSelect: () => { view.from = f.id; paint(); } })), { width: 260 });
  });
  main.querySelector("[data-sort]").addEventListener("click", (event) => {
    showMenu(event.currentTarget, SORTS.map((s) => ({ label: s.label, checked: s.id === view.sort, onSelect: () => { view.sort = s.id; paint(); } })), { align: "end" });
  });
  main.querySelector("[data-import]").addEventListener("click", () => pickAndImport().then(paint));
  wireDrop(main.querySelector("[data-lib]"), (paths) => importPaths(paths).then(paint), "is-drop");

  paint();
  backfillPosters().then((changed) => changed && refreshSnapshot());
  const off = on("snapshot", paint);
  return () => {
    off();
    if (player) player.pause();
    player = null;
    playingId = "";
  };
}
