import { api, store, on, emit, setPrefs, refreshProjects, refreshSnapshot, mediaUrlFor, thumbFor } from "../store.js";
import { esc, icon, toast, showMenu, confirmDialog, formatTimecode, timeAgo, errorText, kindIcon, modalOpen } from "../ui.js";
import { thumbMarkup, mediaMeta, pickMedia, wireDrop, importPaths, backfillPosters, displayName } from "../media.js";
import { mountChat } from "../chat.js";
import { editDesign } from "../gallery.js";
import { paintProjectButtons } from "../plugins.js";
import { mountCutStrip } from "../cut-strip.js";

const RATIOS = [
  { id: "16/9", label: "16:9" },
  { id: "9/16", label: "9:16" },
  { id: "1/1", label: "1:1" },
  { id: "4/5", label: "4:5" },
];

// The open editor, so bridge commands from agents can reach its stage.
let live = null;

// Same test as clipHasEdits in lib/project-design.js: edits, captions, or
// overlays on this clip that only a project render bakes in.
// Same as editSig in lib/video-render.js.
function editSig(state, clipId) {
  const st = state || {};
  const studio = st.studio || {};
  const own = (row) => row && typeof row === "object" && (row.videoId ? row.videoId === clipId : !st.selectedAssetId || st.selectedAssetId === clipId);
  const rows = (list) => (Array.isArray(list) ? list.filter(own) : []);
  return JSON.stringify([(st.videoEdits && st.videoEdits[clipId]) || null, rows(studio.texts), rows(studio.overlays)]);
}

function clipHasEdits(project, clipId) {
  const st = (project && project.state) || {};
  if (st.videoEdits && st.videoEdits[clipId] && Object.keys(st.videoEdits[clipId]).length) return true;
  const studio = st.studio || {};
  const own = (row) => row && typeof row === "object" && (row.videoId ? row.videoId === clipId : !st.selectedAssetId || st.selectedAssetId === clipId);
  return [studio.texts, studio.overlays].some((rows) => Array.isArray(rows) && rows.some(own));
}

export const editorBridge = {
  stagePreview(args) {
    if (!live) return { ok: false, error: "No project is open." };
    return live.stagePreview(args || {});
  },
};

// Renders the project owns: the per-clip pointers first, then older versions.
function projectRenders(project) {
  if (!project) return [];
  const finished = (store.workspace.finished || []).filter((item) => item && item.kind === "video");
  const byId = new Map(finished.map((item) => [String(item.id), item]));
  const out = [];
  const seen = new Set();
  const renders = project.state && project.state.renders && typeof project.state.renders === "object" ? project.state.renders : {};
  for (const [sourceId, renderId] of Object.entries(renders)) {
    const item = byId.get(String(renderId)) || store.mediaById(renderId);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(Object.assign({}, item, { sourceId, current: true }));
  }
  for (const item of finished) {
    if (seen.has(item.id)) continue;
    if (!(Array.isArray(item.projectIds) ? item.projectIds.map(String) : []).includes(String(project.id))) continue;
    seen.add(item.id);
    out.push(Object.assign({}, item, { sourceId: "", current: false }));
  }
  return out.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
}

export function renderEditor(main, projectId, opts) {
  const st = {
    project: null,
    mode: "source",
    outputId: "",
    // Only one side panel opens at a time. The chat wins unless it was closed.
    chatOpen: store.prefs.chatOpen !== false,
    mediaOpen: store.prefs.mediaRailOpen !== false && store.prefs.chatOpen === false,
    // The first paint opens on the finished video when there is one.
    firstPaint: true,
    playing: false,
    loop: false,
    muted: false,
    volume: 1,
    rate: 1,
    // The stage switches between the video and one tab per drawing.
    tab: "video",
    drawings: [],
    canUndoDraw: false,
    destroyed: false,
  };
  let chat = null;
  let player = null;
  let cut = null;

  main.innerHTML =
    '<div class="editor">' +
    // Left: the media panel toggle (next to the panel) and where you are.
    // Right: project actions, then the chat toggle (next to the chat).
    '<header class="topbar">' +
    '<button class="icon-btn" data-toggle-media title="Show or hide media (Ctrl B)" aria-label="Media panel">' + icon("panelLeft") + "</button>" +
    '<span class="topbar-sep"></span>' +
    '<button class="crumb-link" data-home title="Back to all projects">' + icon("chevLeft", "i-sm") + "<span>Projects</span></button>" +
    '<span class="crumb-sep">/</span>' +
    '<input class="title-input" data-title spellcheck="false" aria-label="Project name" title="Click to rename">' +
    '<span class="grow"></span>' +
    '<button class="picker is-boxed hidden" data-ratio title="Frame shape for the finished video"></button>' +
    '<span class="topbar-sep"></span>' +
    // Buttons added by plugins (Settings > Plugins).
    '<span class="topbar-plugins hidden" data-plugin-slot></span>' +
    '<button class="btn hidden" data-render-now title="Make the finished video with your cuts and captions">' + icon("film") + "<span>Render video</span></button>" +
    '<button class="btn hidden" data-edit-design title="Change the words, colors, or frame of this design">' + icon("palette") + "<span>Edit design</span></button>" +
    // The wrapper carries the reason Export is off: a disabled button cannot
    // show its own tooltip in every engine.
    '<span class="export-wrap" data-export-wrap>' +
    '<button class="btn btn-primary" data-export disabled>' + icon("download") + "<span>Export</span></button>" +
    "</span>" +
    '<span class="topbar-sep"></span>' +
    '<button class="icon-btn" data-toggle-chat title="Show or hide the chat (Ctrl J)" aria-label="Chat panel">' + icon("message") + "</button>" +
    "</header>" +
    // No tips banner: the empty stage, the chat starters and each button's own
    // tooltip already say what it said, and it took a row from the picture.
    '<div class="workbench" data-bench>' +
    '<aside class="media-rail" data-rail>' +
    '<div class="panel-head"><h3>Media</h3><span class="panel-count" data-media-count></span><button class="icon-btn icon-btn-sm" data-add-media title="Add media from your library" aria-label="Add media">' + icon("plus") + "</button></div>" +
    '<div class="panel-body" data-assets></div>' +
    '<div class="rail-drop" data-rail-drop>Drop files to add them</div>' +
    "</aside>" +
    '<section class="stage-col">' +
    '<div class="art-tabs" data-art-tabs></div>' +
    '<div class="stage-wrap" data-stage-wrap>' +
    '<div class="seg stage-tabs" data-tabs><button data-mode="source" title="Your original clip">Original</button><button data-mode="output" title="The video the agent made">Finished video</button></div>' +
    '<div class="stage-actions"><button class="btn btn-sm hidden" data-previous title="Go back to the clip from before the last change">' + icon("undo", "i-sm") + "<span>Previous version</span></button></div>" +
    '<div class="stage" data-stage></div>' +
    // While a menu or dialog is up, the live draw view swaps for this still.
    '<div class="draw-freeze hidden" data-freeze></div>' +
    "</div>" +
    '<div class="transport" data-transport></div>' +
    '<div class="cutstrip hidden" data-cut></div>' +
    '<div class="outputs" data-outputs></div>' +
    "</section>" +
    '<div class="resizer" data-resizer title="Drag to resize"></div>' +
    '<aside class="chat" data-chat></aside>' +
    "</div></div>";

  const $ = (sel) => main.querySelector(sel);
  const bench = $("[data-bench]");

  // ---------- artifact tabs: Video plus one tab per drawing ----------
  const hasVideoContent = () => !!(st.project && ((st.project.assets || []).length || projectRenders(st.project).length));
  const loadDrawings = async () => {
    st.drawings = (await api.projectDrawings(projectId).catch(() => [])) || [];
    st.canUndoDraw = await api.jdrawCanUndoTurn(projectId).catch(() => false);
  };
  const paintArtTabs = () => {
    const bar = $("[data-art-tabs]");
    if (!bar) return;
    const tabs = [];
    if (hasVideoContent() || st.videoOn || !st.drawings.length) tabs.push('<button class="art-tab' + (st.tab === "video" ? " is-on" : "") + '" data-art="video" title="The project video">' + icon("film", "i-sm") + "<span>Video</span></button>");
    for (const d of st.drawings) tabs.push('<button class="art-tab' + (st.tab === d.id ? " is-on" : "") + '" data-art="' + esc(d.id) + '" title="' + esc(d.name) + '">' + icon("pencil", "i-sm") + '<span class="ellipsis">' + esc(d.name) + "</span></button>");
    tabs.push('<button class="art-tab" data-art-new title="Add a drawing or a video to this project (Ctrl D adds a drawing)">' + icon("plus", "i-sm") + "<span>New</span></button>");
    if (st.tab !== "video") {
      tabs.push('<span class="grow"></span>');
      tabs.push('<button class="btn btn-sm" data-use-video title="Add this drawing to the project footage">' + icon("film", "i-sm") + "<span>Use in video</span></button>");
      if (st.canUndoDraw) tabs.push('<button class="btn btn-sm" data-undo-draw title="Undo the changes the agent made to project drawings">' + icon("undo", "i-sm") + "<span>Undo agent changes</span></button>");
    }
    bar.innerHTML = tabs.join("");
  };

  // The Draw WebContentsView sits above the page at this rect. A JV dialog or
  // menu would land under it, so the view swaps for a captured still then.
  let placeQueued = false;
  let frozen = false;
  const hideDrawView = () => { api.jdrawViewHide().catch(() => {}); };
  const schedulePlace = () => {
    if (placeQueued || st.destroyed || frozen) return;
    placeQueued = true;
    requestAnimationFrame(() => {
      placeQueued = false;
      if (st.destroyed || st.tab === "video" || frozen) return;
      const wrap = $("[data-stage-wrap]");
      if (!wrap) return;
      const r = wrap.getBoundingClientRect();
      api.jdrawViewPlace({ rect: { x: r.x, y: r.y, width: r.width, height: r.height }, drawingId: st.tab }).catch(() => {});
    });
  };
  const setTab = (id) => {
    st.tab = id === "video" || st.drawings.some((d) => d.id === id) ? id : "video";
    bench.classList.toggle("is-draw", st.tab !== "video");
    paintArtTabs();
    if (st.tab === "video") hideDrawView();
    else schedulePlace();
    if (typeof chat !== "undefined" && chat && chat.stage) chat.stage();
  };
  const newDrawing = async () => {
    const d = await api.jdrawDrawingCreate({ projectId, name: "Drawing " + (st.drawings.length + 1) }).catch(() => null);
    if (!d || !d.id) return;
    await loadDrawings();
    setTab(d.id);
  };
  const useInVideo = async () => {
    const id = st.tab === "video" ? "" : st.tab;
    if (!id) return;
    const r = await api.jdrawUseInVideo(id).catch((error) => { toast((error && error.message) || "Could not add it", true); return null; });
    if (!r || !r.added || !r.id) { if (r && r.reason) toast("Already in the library"); return; }
    await api.aiProjectAddAssets({ id: projectId, assetIds: [r.id] });
    toast("Added to the project footage");
    await load();
    paintAll();
    paintArtTabs();
  };
  const undoDraw = async () => {
    const n = await api.jdrawUndoTurn(projectId).catch(() => 0);
    toast(n ? "Undid the agent's drawing changes" : "Nothing to undo");
    st.canUndoDraw = false;
    await loadDrawings();
    paintArtTabs();
  };
  const syncOverlay = async () => {
    const want = st.tab !== "video" && !!document.querySelector(".dialog, .menu");
    if (want === frozen) return;
    frozen = want;
    const el = $("[data-freeze]");
    if (frozen) {
      const url = await api.jdrawViewFreeze().catch(() => null);
      if (el && url && frozen) {
        el.style.backgroundImage = 'url("' + url + '")';
        el.classList.remove("hidden");
      }
    } else {
      if (el) el.classList.add("hidden");
      await api.jdrawViewUnfreeze().catch(() => {});
      schedulePlace();
    }
  };
  const overlayWatch = new MutationObserver(() => { if (st.tab !== "video") void syncOverlay(); });
  overlayWatch.observe(document.body, { childList: true, subtree: true });

  main.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-art]");
    if (tab) {
      setTab(tab.dataset.art);
      return;
    }
    const addBtn = event.target.closest("[data-art-new]");
    if (addBtn) {
      showMenu(addBtn, [
        { label: "New drawing", sub: "A blank drawing in this project", onSelect: () => { void newDrawing(); } },
        { label: "Video", sub: "Show this project's video", onSelect: () => { st.videoOn = true; setTab("video"); } },
      ], { width: 240 });
      return;
    }
    if (event.target.closest("[data-use-video]")) {
      void useInVideo();
      return;
    }
    if (event.target.closest("[data-undo-draw]")) {
      void undoDraw();
    }
  });
  bench.style.setProperty("--chat-w", (Number(store.prefs.chatWidth) || 420) + "px");

  // ---------- data ----------

  const load = async () => {
    try {
      st.project = await api.aiProjectGet({ id: projectId });
    } catch (error) {
      st.project = null;
      main.innerHTML = '<div class="page"><div class="empty" style="margin-top:12vh">' + icon("alert", "i-xl") + "<h3>This project could not be opened</h3><p>" + esc(errorText(error)) + '</p><button class="btn" data-nav="home">Back to projects</button></div></div>';
      return false;
    }
    return true;
  };

  const assets = () => (st.project && st.project.assets ? st.project.assets : []).map((a) => store.mediaById(a.id) || Object.assign({ missing: true, name: "Missing media" }, a));

  const selectedAsset = () => {
    const list = assets().filter((a) => !a.missing);
    const id = st.project && st.project.state && st.project.state.selectedAssetId;
    return list.find((a) => a.id === id) || list.find((a) => a.kind === "video") || list[0] || null;
  };

  const currentOutput = () => {
    const renders = projectRenders(st.project);
    if (st.outputId) {
      const pick = renders.find((r) => r.id === st.outputId) || store.mediaById(st.outputId);
      if (pick) return pick;
    }
    const sel = selectedAsset();
    return (sel && renders.find((r) => r.sourceId === sel.id)) || renders.find((r) => r.current) || renders[0] || null;
  };

  // State writes re-read the row first so an agent's change in between is
  // never written over.
  const patchState = async (patch) => {
    try {
      const fresh = await api.aiProjectGet({ id: projectId });
      const state = Object.assign({}, (fresh && fresh.state) || {}, patch);
      st.project = await api.aiProjectUpdate({ id: projectId, patch: { state } });
    } catch (error) {
      toast(errorText(error), true);
    }
  };

  // ---------- painting ----------

  const paintTop = () => {
    const title = $("[data-title]");
    if (document.activeElement !== title) title.value = st.project.name;
    const ratio = RATIOS.find((r) => r.id === st.project.aspectRatio) || RATIOS[0];
    $("[data-ratio]").classList.remove("hidden");
    $("[data-ratio]").innerHTML = icon("ratio", "i-sm") + "<span>" + ratio.label + "</span>" + icon("chevDown", "i-sm chev");
    $("[data-toggle-media]").classList.toggle("is-on", st.mediaOpen);
    $("[data-toggle-chat]").classList.toggle("is-on", st.chatOpen);
    const design = st.project.state && st.project.state.design;
    const designLive = Boolean(design && design.preset && (st.project.assets || []).some((a) => a.id === design.assetId));
    $("[data-edit-design]").classList.toggle("hidden", !designLive);
    // Offered while the clip the last change made is still in the project.
    const prev = st.project.state && st.project.state.previousVersion;
    const canGoBack = Boolean(prev && prev.clipId && (st.project.assets || []).some((a) => a.id === prev.newId));
    $("[data-previous]").classList.toggle("hidden", !canGoBack);
    if (canGoBack) {
      $("[data-previous] span").textContent = prev.forward ? "Newer version" : "Previous version";
      $("[data-previous]").title = prev.forward ? "Go back to the clip from after the change" : "Go back to the clip from before the last change";
    }
    const out = currentOutput();
    const exportable = Boolean(out);
    const count = projectRenders(st.project).length;
    $("[data-export]").disabled = !exportable;
    // Say which video Export saves: the one on the stage, or the current one.
    const exportReason = exportable
      ? "Save \u201c" + (out.name || "the finished video") + "\u201d to your computer" + (count > 1 ? ". Pick another under Finished videos to export that one." : "")
      : "Nothing to export yet. Ask the agent to make the video first.";
    $("[data-export]").title = exportReason;
    const exportWrap = $("[data-export-wrap]");
    if (exportWrap) {
      // The wrapper is what the pointer reaches while the button is disabled.
      exportWrap.title = exportReason;
      exportWrap.classList.toggle("is-off", !exportable);
    }
    // This clip has edits only a render bakes in, and no finished video of
    // its own, or one made before the latest edits.
    const clip = selectedAsset();
    const pstate = st.project.state || {};
    const own = clip && pstate.renders && pstate.renders[clip.id];
    const savedSig = clip && pstate.renderSigs && pstate.renderSigs[clip.id];
    const stale = Boolean(own && savedSig != null && savedSig !== editSig(pstate, clip.id));
    const showRender = Boolean(clip && clip.kind === "video" && clipHasEdits(st.project, clip.id) && (!own || stale));
    $("[data-render-now]").classList.toggle("hidden", !showRender);
    $("[data-render-now]").title = stale ? "Your latest edits are not in the finished video yet. Render it again." : "Make the finished video with your cuts and captions";
    $("[data-rail]").classList.toggle("is-closed", !st.mediaOpen);
    bench.classList.toggle("no-chat", !st.chatOpen);
  };

  const paintAssets = () => {
    const list = assets();
    const sel = selectedAsset();
    const el = $("[data-assets]");
    const count = $("[data-media-count]");
    if (count) {
      count.textContent = list.length ? String(list.length) : "";
      count.title = list.length ? list.length + (list.length === 1 ? " clip on this timeline" : " clips on this timeline") : "";
    }
    if (!list.length) {
      // Same action as the + in the header, so the empty panel is not a dead end.
      el.innerHTML =
        '<div class="panel-empty">' + icon("film", "i-lg") +
        "<p><strong>No clips on this timeline</strong></p>" +
        '<p class="faint">Add clips from your library, or drag files onto this panel.</p>' +
        '<button type="button" class="btn btn-sm" data-panel-add>' + icon("plus", "i-sm") + "Add media</button></div>";
      const add = el.querySelector("[data-panel-add]");
      if (add) add.addEventListener("click", addMedia);
      return;
    }
    const kindLabel = (kind) => (kind === "video" ? "Video" : kind === "audio" ? "Audio" : kind === "image" ? "Image" : "File");
    el.innerHTML = list.map((a) => {
      const on = Boolean(sel && sel.id === a.id);
      const edited = !a.missing && clipHasEdits(st.project, a.id);
      // Kind and length in one line, plus the state that would otherwise look
      // the same as any other clip: on the stage, or carrying cuts.
      const meta = a.missing ? "Removed from library" : [kindLabel(a.kind), mediaMeta(a)].filter(Boolean).join(" \u00b7 ");
      const flags = [];
      if (on) flags.push("On stage");
      if (edited) flags.push("Edited");
      // The state goes first: it is the part that must never be the text the
      // narrow panel cuts off.
      const line = (flags.length ? '<span class="asset-flag">' + esc(flags.join(" \u00b7 ")) + "</span>" + (meta ? " \u00b7 " : "") : "") + esc(meta);
      return (
        '<div class="asset' + (on ? " is-on" : "") + (a.missing ? " is-missing" : "") + '" data-asset="' + esc(a.id) + '" role="button" tabindex="0">' +
        (a.missing ? '<div class="asset-thumb">' + icon("alert", "i-sm") + "</div>" : thumbMarkup(a, "asset-thumb")) +
        '<div class="asset-text"><strong title="' + esc(displayName(a)) + '">' + esc(displayName(a)) + "</strong>" +
        '<small title="' + esc((flags.length ? flags.join(" \u00b7 ") + " \u00b7 " : "") + meta) + '">' + line + "</small></div>" +
        '<button class="icon-btn icon-btn-sm" data-asset-more="' + esc(a.id) + '" title="More" aria-label="More for ' + esc(displayName(a)) + '">' + icon("more") + "</button></div>"
      );
    }).join("");
  };

  const paintTabs = () => {
    const out = currentOutput();
    const tabs = $("[data-tabs]");
    // Always shown once there is something to look at, so the stage does not
    // jump after the first render. With no clip and no video, both tabs are
    // dead ends, so the whole control stays out of the way.
    if (!out && st.mode === "output") st.mode = "source";
    const hasSource = Boolean(selectedAsset());
    tabs.classList.toggle("hidden", !out && !hasSource);
    const outTab = tabs.querySelector('[data-mode="output"]');
    outTab.disabled = !out;
    outTab.title = out ? "The video the agent made" : "No finished video yet";
    tabs.querySelectorAll("[data-mode]").forEach((b) => b.classList.toggle("is-on", b.dataset.mode === st.mode));
  };

  let stageSig = "";
  let outputsSeen = 0;
  let outputsPainted = false;
  const paintStage = (force) => {
    paintTabs();
    const stage = $("[data-stage]");
    const item = st.mode === "output" ? currentOutput() : selectedAsset();
    const sig = st.mode + "|" + (item ? item.id + ":" + (item.contentHash || item.size || "") : "") + "|" + st.project.aspectRatio;
    if (!force && sig === stageSig) return;
    stageSig = sig;
    if (player) player.destroy();
    player = null;
    const [rw, rh] = String(st.project.aspectRatio || "16/9").split("/").map(Number);
    stage.dataset.ratio = rw / rh;
    if (!item) {
      // A new project: the dark frame the video will fill, in the project's
      // shape, with the two ways to start. Not a numbered guide.
      stage.classList.add("is-empty");
      stage.removeAttribute("tabindex");
      stage.removeAttribute("role");
      stage.removeAttribute("aria-label");
      stage.innerHTML =
        '<div class="stage-empty stage-start">' + icon("film", "i-xl") +
        "<strong>Your video plays here</strong>" +
        "<p>Add clips to edit, or ask the agent to make a video from scratch.</p>" +
        '<div class="stage-start-actions">' +
        '<button type="button" class="btn" data-guide-add>' + icon("plus", "i-sm") + "Add media</button>" +
        '<button type="button" class="btn btn-primary" data-guide-ask>' + icon("message", "i-sm") + "Ask the agent</button>" +
        "</div></div>";
      stage.querySelector("[data-guide-add]").addEventListener("click", addMedia);
      stage.querySelector("[data-guide-ask]").addEventListener("click", () => {
        if (!st.chatOpen) toggleChat();
        if (chat) chat.focus();
      });
      fitStage();
      paintTransport();
      return;
    }
    stage.classList.remove("is-empty");
    // The frame is not a button any more: a real play button sits inside it, so
    // the picture keeps its own focus and the keyboard path is a button.
    stage.removeAttribute("tabindex");
    stage.removeAttribute("role");
    stage.removeAttribute("aria-label");
    const url = mediaUrlFor(item);
    const label = st.mode === "output" ? "Finished: " + (item.name || "Video") : "Original: " + displayName(item);
    const fps = Number(item.fps) || 0;
    if (item.kind === "image") {
      stage.innerHTML = '<img src="' + esc(url) + '" alt="" draggable="false"><span class="stage-label" title="' + esc(label) + '">' + esc(label) + "</span>";
    } else {
      const poster = thumbFor(item);
      stage.innerHTML =
        (item.kind === "audio" ? '<div class="stage-empty" style="position:absolute;inset:0;place-content:center">' + icon("music", "i-xl") + "<strong>" + esc(item.name) + "</strong></div>" : "") +
        '<video data-video preload="metadata" playsinline src="' + esc(url) + '"' + (poster ? ' poster="' + esc(poster) + '"' : "") + (item.kind === "audio" ? ' style="opacity:0"' : "") + "></video>" +
        '<span class="stage-label" title="' + esc(label) + '">' + esc(label) + "</span>" +
        '<button type="button" class="stage-play" data-stage-play title="Play (Space)" aria-label="Play">' + icon("play") + "</button>";
      player = makePlayer(stage.querySelector("[data-video]"), fps);
    }
    fitStage();
    paintTransport();
  };

  const fitStage = () => {
    const wrap = $("[data-stage-wrap]");
    const stage = $("[data-stage]");
    if (!wrap || !stage) return;
    const ratio = Number(stage.dataset.ratio) || 16 / 9;
    const pad = 36;
    // The empty frame keeps the project's shape, so the ratio picker shows what
    // it does before there is a picture. The shape is a floor, not a fixed
    // size: a frame too short for its own words grows to hold them.
    if (stage.classList.contains("is-empty")) {
      const maxW = Math.max(80, wrap.clientWidth - pad);
      const maxH = Math.max(60, wrap.clientHeight - pad);
      let ew = Math.min(maxW, 720);
      let eh = ew / ratio;
      if (eh > maxH) {
        eh = maxH;
        ew = eh * ratio;
      }
      stage.style.width = Math.floor(Math.max(ew, Math.min(maxW, 264))) + "px";
      stage.style.height = "";
      stage.style.minHeight = Math.floor(eh) + "px";
      stage.style.marginTop = "";
      return;
    }
    stage.style.minHeight = "";
    const top = 34;
    const W = Math.max(80, wrap.clientWidth - pad);
    const H = Math.max(60, wrap.clientHeight - pad - top);
    let w = W;
    let h = w / ratio;
    if (h > H) {
      h = H;
      w = h * ratio;
    }
    stage.style.width = Math.floor(w) + "px";
    stage.style.height = Math.floor(h) + "px";
    stage.style.marginTop = top + "px";
  };

  const paintTransport = () => {
    const el = $("[data-transport]");
    // Play controls only mean something once there is a clip or a video.
    el.classList.toggle("hidden", !player);
    const disabled = player ? "" : " disabled";
    el.innerHTML =
      '<div class="scrub" data-scrub><div class="scrub-track"><div class="scrub-buf" data-buf></div><div class="scrub-fill" data-fill></div></div><div class="scrub-knob" data-knob></div></div>' +
      '<div class="left"><span class="timecode" data-time>00:00.00 / 00:00.00</span><span class="timecode-frames" data-frames></span></div>' +
      '<div class="center">' +
      '<button class="icon-btn" data-t="start" title="Go to start"' + disabled + ">" + icon("skipBack") + "</button>" +
      '<button class="icon-btn" data-t="back" title="Back 5 seconds"' + disabled + ">" + icon("back5") + "</button>" +
      '<button class="icon-btn play-btn" data-t="play" title="Play (Space)"' + disabled + ">" + icon(st.playing ? "pause" : "play") + "</button>" +
      '<button class="icon-btn" data-t="fwd" title="Forward 5 seconds"' + disabled + ">" + icon("fwd5") + "</button>" +
      '<button class="icon-btn" data-t="end" title="Go to end"' + disabled + ">" + icon("skipFwd") + "</button>" +
      "</div>" +
      '<div class="right">' +
      '<button class="icon-btn' + (st.loop ? " is-on" : "") + '" data-t="loop" title="Loop"' + disabled + ">" + icon("repeat") + "</button>" +
      '<button class="picker" data-t="rate" title="Speed"' + disabled + ">" + st.rate + "×</button>" +
      '<button class="icon-btn" data-t="mute" title="' + (st.muted || st.volume === 0 ? "Unmute" : "Mute") + '"' + disabled + ">" + icon(st.muted || st.volume === 0 ? "volumeX" : "volume") + "</button>" +
      '<input class="vol" type="range" min="0" max="1" step="0.05" value="' + (st.muted ? 0 : st.volume) + '" data-vol title="Volume"' + disabled + ">" +
      '<button class="icon-btn" data-t="full" title="Full screen (F)"' + disabled + ">" + icon("maximize") + "</button>" +
      "</div>";
    if (player) player.sync();
    if (cut) cut.paint();
  };

  const paintOutputs = () => {
    const el = $("[data-outputs]");
    const renders = projectRenders(st.project);
    const on = st.mode === "output" ? currentOutput() : null;
    // Nothing to list yet: the strip stays out of the way until a video exists.
    el.classList.toggle("hidden", !renders.length);
    // First render after the page is already open: ease the strip in, so the
    // picture above it resizes smoothly instead of the row appearing in one
    // frame. On the first paint the strip is simply there.
    if (renders.length && !outputsSeen && outputsPainted) {
      el.classList.add("is-reveal");
      el.addEventListener("animationend", () => el.classList.remove("is-reveal"), { once: true });
    }
    outputsSeen = renders.length;
    outputsPainted = true;
    const saves = currentOutput();
    el.innerHTML =
      '<div class="outputs-head"><strong>Finished videos</strong><span class="faint" style="font-size:var(--fs-sm)">' +
      (renders.length ? renders.length + (renders.length === 1 ? " video" : " videos") : "") + "</span>" +
      (saves ? '<span class="outputs-saves" title="The video Export saves">Export saves <strong>' + esc(saves.name || "this video") + "</strong></span>" : "") +
      "</div>" +
      (renders.length
        ? '<div class="outputs-list">' + renders.map((r) =>
            '<div class="output' + (on && on.id === r.id ? " is-on" : "") + '" data-output="' + esc(r.id) + '" role="button" tabindex="0">' +
            '<div class="output-thumb">' + thumbMarkup(r) + (r.durationMs ? '<span class="tile-badge">' + esc(mediaMeta(r)) + "</span>" : "") + "</div>" +
            '<div class="output-meta"><div class="grow"><strong title="' + esc(r.name || "Video") + '">' + esc(r.name || "Video") + '</strong><small class="faint">' + (r.current ? '<span class="pill pill-accent" title="The newest video of a clip in this project">Current</span>' : "") + "<span>" + esc(timeAgo(r.createdAt)) + (r.current ? "" : " · earlier version") + "</span></small></div>" +
            '<button class="icon-btn icon-btn-sm" data-output-more="' + esc(r.id) + '" title="More" aria-label="More for this video">' + icon("more") + "</button></div></div>").join("") + "</div>"
        : '<div class="outputs-empty">Videos the agent makes show up here. Ask it to make the video when the edit looks right.</div>');
  };

  const paintAll = () => {
    if (!st.project || st.destroyed) return;
    if (st.firstPaint) {
      st.firstPaint = false;
      if (currentOutput()) st.mode = "output";
    }
    paintTop();
    paintAssets();
    paintStage();
    paintOutputs();
    if (cut) cut.paint();
    if (chat && chat.refresh) chat.refresh();
  };

  // ---------- player ----------

  function makePlayer(video, fps) {
    video.loop = st.loop;
    video.muted = st.muted;
    video.volume = st.volume;
    video.playbackRate = st.rate;
    let raf = 0;
    const frames = (seconds) => (fps > 0 ? Math.round((Number(seconds) || 0) * fps) : 0);
    // The play affordance on the frame follows the same state as the transport.
    const paintPlay = () => {
      const b = $("[data-stage-play]");
      if (!b) return;
      b.innerHTML = icon(st.playing ? "pause" : "play");
      b.setAttribute("aria-label", st.playing ? "Pause" : "Play");
      b.title = st.playing ? "Pause (Space)" : "Play (Space)";
    };
    const tick = () => {
      if (cut) cut.steer(video, st.rate, st.muted, st.loop);
      sync();
      if (!video.paused) raf = requestAnimationFrame(tick);
    };
    const sync = () => {
      const t = $("[data-time]");
      const fill = $("[data-fill]");
      const knob = $("[data-knob]");
      const buf = $("[data-buf]");
      const d = Number.isFinite(video.duration) ? video.duration : 0;
      if (t) t.textContent = formatTimecode(video.currentTime) + " / " + formatTimecode(d);
      // Frames ride beside the time, and drop out when the column is too narrow
      // to hold the whole line (see the container query in app.css).
      const fm = $("[data-frames]");
      if (fm) fm.textContent = fps > 0 ? "\u00b7 f " + frames(video.currentTime) + " / " + frames(d) : "";
      const pct = d ? (video.currentTime / d) * 100 : 0;
      if (fill) fill.style.width = pct + "%";
      if (knob) knob.style.left = pct + "%";
      if (buf && d && video.buffered.length) buf.style.width = (video.buffered.end(video.buffered.length - 1) / d) * 100 + "%";
      if (cut) cut.playhead(video.currentTime);
    };
    const onPlay = () => {
      st.playing = true;
      const b = $('[data-t="play"]');
      if (b) b.innerHTML = icon("pause");
      paintPlay();
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(tick);
    };
    const onPause = () => {
      st.playing = false;
      const b = $('[data-t="play"]');
      if (b) b.innerHTML = icon("play");
      paintPlay();
      sync();
    };
    paintPlay();
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("ended", onPause);
    video.addEventListener("loadedmetadata", sync);
    video.addEventListener("seeked", sync);
    // Backup for the cut preview when frames are held back (hidden window).
    video.addEventListener("timeupdate", () => { if (cut) cut.steer(video, st.rate, st.muted, st.loop); });
    video.addEventListener("progress", sync);
    video.addEventListener("click", () => toggle());
    const toggle = () => (video.paused ? video.play().catch(() => {}) : video.pause());
    return {
      video,
      sync,
      toggle,
      seek: (t) => {
        const d = Number.isFinite(video.duration) ? video.duration : 0;
        video.currentTime = Math.max(0, Math.min(d || 0, t));
        sync();
      },
      destroy: () => {
        cancelAnimationFrame(raf);
        video.pause();
        video.removeAttribute("src");
        video.load();
      },
    };
  }

  // ---------- actions ----------

  const select = async (id) => {
    st.mode = "source";
    st.outputId = "";
    st.project.state = Object.assign({}, st.project.state, { selectedAssetId: id });
    paintAll();
    await patchState({ selectedAssetId: id });
  };

  const showOutput = (id) => {
    st.outputId = id;
    st.mode = "output";
    paintAll();
  };

  const addMedia = async () => {
    const items = await pickMedia({ title: "Add media to this project", exclude: (st.project.assets || []).map((a) => a.id), excludeLabel: "In project" });
    if (!items.length) return;
    await addAssets(items.map((i) => i.id));
  };

  const addAssets = async (ids) => {
    try {
      st.project = await api.aiProjectAddAssets({ id: projectId, assetIds: ids });
      if (!(st.project.state && st.project.state.selectedAssetId)) await patchState({ selectedAssetId: ids[0] });
      paintAll();
    } catch (error) {
      toast(errorText(error), true);
    }
  };

  const exportItem = async (item) => {
    if (!item) return;
    try {
      const result = await api.exportFinishedItem(item.id);
      if (result && (result.saved || result.path || result.filePath)) toast("Exported");
    } catch (error) {
      toast(errorText(error), true);
    }
  };

  // ---------- wiring ----------

  $("[data-home]").addEventListener("click", () => emit("navigate", { page: "home" }));
  // Playing hides the stage label so it never covers the picture.
  main.addEventListener("play", (e) => { const s = e.target.closest && e.target.closest("[data-stage]"); if (s) s.classList.add("is-playing"); }, true);
  main.addEventListener("pause", (e) => { const s = e.target.closest && e.target.closest("[data-stage]"); if (s) s.classList.remove("is-playing"); }, true);
  const title = $("[data-title]");
  const saveTitle = async () => {
    const name = title.value.trim();
    if (!name || !st.project || name === st.project.name) return;
    try {
      st.project = await api.aiProjectUpdate({ id: projectId, patch: { name } });
      void refreshProjects();
    } catch (error) {
      toast(errorText(error), true);
    }
  };
  title.addEventListener("blur", saveTitle);
  title.addEventListener("keydown", (event) => {
    if (event.key === "Enter") title.blur();
    if (event.key === "Escape") {
      title.value = st.project.name;
      title.blur();
    }
  });
  $("[data-ratio]").addEventListener("click", (event) => {
    showMenu(event.currentTarget, [{ heading: "Frame for the next render" }].concat(RATIOS.map((r) => ({
      label: r.label,
      sub: r.id === "16/9" ? "Landscape" : r.id === "9/16" ? "Vertical, for Shorts and Reels" : r.id === "1/1" ? "Square" : "Portrait feed",
      checked: r.id === st.project.aspectRatio,
      onSelect: async () => {
        try {
          st.project = await api.aiProjectUpdate({ id: projectId, patch: { aspectRatio: r.id } });
          paintAll();
          if (projectRenders(st.project).length || assets().some((a) => a.kind === "video")) toast("Frame set to " + r.label + ". Clips fit inside it with bars, not cropped. Render again, or ask the agent to fill the frame.", "info");
        } catch (error) {
          toast(errorText(error), true);
        }
      },
    }))), { align: "end", width: 260 });
  });
  // Only one side panel is open at a time: opening one closes the other.
  const toggleMedia = () => {
    st.mediaOpen = !st.mediaOpen;
    const patch = { mediaRailOpen: st.mediaOpen };
    if (st.mediaOpen && st.chatOpen) {
      st.chatOpen = false;
      patch.chatOpen = false;
    }
    void setPrefs(patch);
    paintTop();
    requestAnimationFrame(fitStage);
  };
  const toggleChat = () => {
    st.chatOpen = !st.chatOpen;
    const patch = { chatOpen: st.chatOpen };
    if (st.chatOpen && st.mediaOpen) {
      st.mediaOpen = false;
      patch.mediaRailOpen = false;
    }
    void setPrefs(patch);
    paintTop();
    requestAnimationFrame(fitStage);
  };
  $("[data-toggle-media]").addEventListener("click", toggleMedia);
  $("[data-toggle-chat]").addEventListener("click", toggleChat);
  $("[data-export]").addEventListener("click", () => exportItem(currentOutput()));
  $("[data-edit-design]").addEventListener("click", () => {
    const design = st.project && st.project.state && st.project.state.design;
    if (!design) return;
    void editDesign(projectId, design, async (_id, made) => {
      st.outputId = "";
      if (!(await load()) || st.destroyed) return;
      paintAll();
      if (made && made.scriptErrors && made.scriptErrors.length) return;
      toast(made && made.needsRender ? "Design updated. Click Render video to add your cuts and captions." : "Video updated. Previous version brings back the old one.");
    });
  });
  // The agent may be swapping clips right now; a second writer would undo it.
  const agentBusy = () => {
    if (!document.querySelector("[data-send].is-stop")) return false;
    toast("Wait for the agent to finish, or stop it first.", true);
    return true;
  };
  $("[data-render-now]").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    if (button.disabled || agentBusy()) return;
    button.disabled = true;
    button.querySelector("span").textContent = "Rendering";
    try {
      await api.aiProjectRender({ id: projectId });
      await refreshSnapshot();
      st.outputId = "";
      if (!(await load()) || st.destroyed) return;
      paintAll();
      toast("Video rendered");
    } catch (error) {
      toast(errorText(error), true);
    } finally {
      button.disabled = false;
      button.querySelector("span").textContent = "Render video";
    }
  });
  $("[data-previous]").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    if (button.disabled || agentBusy()) return;
    button.disabled = true;
    try {
      st.restoring = true;
      const restored = await api.aiProjectRestorePrevious({ id: projectId }).finally(() => {
        setTimeout(() => (st.restoring = false), 1500);
      });
      await refreshSnapshot();
      st.outputId = "";
      if (!(await load()) || st.destroyed) return;
      paintAll();
      const wentBack = Boolean(restored && restored.state && restored.state.previousVersion && restored.state.previousVersion.forward);
      toast(
        (wentBack ? "Back to the earlier version. " : "Back to the newer version. ") +
          (restored && restored.needsRender ? "Click Render video to add your cuts and captions." : wentBack ? "Click again to return." : ""),
      );
    } catch (error) {
      toast(errorText(error), true);
      if ((await load()) && !st.destroyed) paintAll();
    } finally {
      button.disabled = false;
    }
  });
  $("[data-add-media]").addEventListener("click", addMedia);
  // Play on the frame itself: a real button, so it is a keyboard stop and the
  // tooltip and label carry the state in words.
  $("[data-stage]").addEventListener("click", (event) => {
    if (!event.target.closest("[data-stage-play]") || !player) return;
    player.toggle();
  });
  $("[data-tabs]").addEventListener("click", (event) => {
    const b = event.target.closest("[data-mode]");
    if (!b || b.disabled) return;
    st.mode = b.dataset.mode;
    paintAll();
  });

  $("[data-assets]").addEventListener("click", (event) => {
    const more = event.target.closest("[data-asset-more]");
    const row = event.target.closest("[data-asset]");
    if (!row) return;
    const id = row.dataset.asset;
    if (!more) return void select(id);
    event.stopPropagation();
    showMenu(more, [
      { label: "Show on stage", icon: "eye", onSelect: () => select(id) },
      { label: "Attach to chat message", icon: "paperclip", onSelect: () => {
        if (!st.chatOpen) toggleChat();
        if (chat) chat.attach([id]);
      } },
      "sep",
      { label: "Remove from project", icon: "x", danger: true, onSelect: async () => {
        try {
          st.project = await api.aiProjectRemoveAsset({ id: projectId, libraryId: id });
          paintAll();
        } catch (error) {
          toast(errorText(error), true);
        }
      } },
    ], { align: "end" });
  });

  $("[data-outputs]").addEventListener("click", (event) => {
    const more = event.target.closest("[data-output-more]");
    const card = event.target.closest("[data-output]");
    if (!card) return;
    const item = store.mediaById(card.dataset.output);
    if (!more) return showOutput(card.dataset.output);
    event.stopPropagation();
    showMenu(more, [
      { label: "Show on stage", icon: "eye", onSelect: () => showOutput(item.id) },
      { label: "Export file", icon: "download", onSelect: () => exportItem(item) },
      { label: "Open in your video player", sub: "Opens outside JV", icon: "external", onSelect: () => api.openFinishedItem(item.id).catch((e) => toast(errorText(e), true)) },
      { label: "Edit this video further", sub: "Adds it to this project's media as a new clip", icon: "film", onSelect: async () => {
        try {
          // The handler reads projectId; without it, it made a whole new project.
          const res = await api.aiProjectAddFinished({ projectId, finishedId: item.id });
          if (res.project && res.project.id === projectId) st.project = res.project;
          await refreshSnapshot();
          if (res.item && res.item.id) await patchState({ selectedAssetId: res.item.id });
          st.mode = "source";
          paintAll();
          toast("Added to the project's media");
        } catch (error) {
          toast(errorText(error), true);
        }
      } },
      "sep",
      { label: "Delete video", icon: "trash", danger: true, onSelect: async () => {
        const ok = await confirmDialog({ title: "Delete this video?", body: "The finished video file is removed. The project and its clips stay.", confirm: "Delete", danger: true });
        if (!ok) return;
        try {
          await api.deleteFinishedItem(item.id);
          if (st.outputId === item.id) st.outputId = "";
          await refreshSnapshot();
          await load();
          paintAll();
        } catch (error) {
          toast(errorText(error), true);
        }
      } },
    ], { align: "end" });
  });

  $("[data-transport]").addEventListener("click", (event) => {
    const b = event.target.closest("[data-t]");
    if (!b || !player) return;
    const v = player.video;
    const t = b.dataset.t;
    if (t === "play") player.toggle();
    else if (t === "start") player.seek(0);
    else if (t === "end") player.seek(v.duration || 0);
    else if (t === "back") player.seek(v.currentTime - 5);
    else if (t === "fwd") player.seek(v.currentTime + 5);
    else if (t === "loop") {
      st.loop = !st.loop;
      v.loop = st.loop;
      b.classList.toggle("is-on", st.loop);
    } else if (t === "mute") {
      st.muted = !st.muted;
      v.muted = st.muted;
      paintTransport();
    } else if (t === "full") {
      const stage = $("[data-stage]");
      if (document.fullscreenElement) document.exitFullscreen();
      else stage.requestFullscreen().catch(() => {});
    } else if (t === "rate") {
      showMenu(b, [0.25, 0.5, 1, 1.5, 2].map((r) => ({ label: r + "×", checked: r === st.rate, onSelect: () => { st.rate = r; v.playbackRate = r; paintTransport(); } })), { above: true, width: 100 });
    }
  });
  $("[data-transport]").addEventListener("input", (event) => {
    if (!event.target.matches("[data-vol]") || !player) return;
    st.volume = Number(event.target.value);
    st.muted = st.volume === 0;
    player.video.volume = st.volume;
    player.video.muted = st.muted;
  });
  // scrubbing
  $("[data-transport]").addEventListener("pointerdown", (event) => {
    const bar = event.target.closest("[data-scrub]");
    if (!bar || !player) return;
    const move = (e) => {
      const r = bar.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      player.seek(pct * (player.video.duration || 0));
    };
    bar.classList.add("is-drag");
    bar.setPointerCapture(event.pointerId);
    move(event);
    const up = () => {
      bar.classList.remove("is-drag");
      bar.removeEventListener("pointermove", move);
      bar.removeEventListener("pointerup", up);
    };
    bar.addEventListener("pointermove", move);
    bar.addEventListener("pointerup", up);
  });

  // chat resize
  const resizer = $("[data-resizer]");
  resizer.addEventListener("pointerdown", (event) => {
    const startX = event.clientX;
    const startW = $("[data-chat]").getBoundingClientRect().width;
    resizer.classList.add("is-drag");
    resizer.setPointerCapture(event.pointerId);
    let w = startW;
    const move = (e) => {
      w = Math.max(300, Math.min(760, window.innerWidth * (window.innerWidth <= 1100 ? 0.38 : 0.46), startW + (startX - e.clientX)));
      bench.style.setProperty("--chat-w", w + "px");
      fitStage();
    };
    const up = () => {
      resizer.classList.remove("is-drag");
      resizer.removeEventListener("pointermove", move);
      resizer.removeEventListener("pointerup", up);
      void setPrefs({ chatWidth: Math.round(w) });
    };
    resizer.addEventListener("pointermove", move);
    resizer.addEventListener("pointerup", up);
  });

  wireDrop($("[data-rail]"), async (paths) => {
    const items = await importPaths(paths);
    if (items.length) await addAssets(items.map((i) => i.id));
  }, "is-over-rail");
  $("[data-rail]").addEventListener("dragenter", () => $("[data-rail-drop]").classList.add("is-over"));
  $("[data-rail]").addEventListener("dragleave", (e) => {
    if (!$("[data-rail]").contains(e.relatedTarget)) $("[data-rail-drop]").classList.remove("is-over");
  });
  $("[data-rail]").addEventListener("drop", () => $("[data-rail-drop]").classList.remove("is-over"));

  const onKey = (event) => {
    if (modalOpen()) return;
    const el = document.activeElement;
    const typing = el && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && el.type !== "range"));
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === "b") {
      event.preventDefault();
      toggleMedia();
      return;
    }
    if (mod && event.key.toLowerCase() === "j") {
      event.preventDefault();
      toggleChat();
      return;
    }
    if (mod && event.key.toLowerCase() === "l") {
      event.preventDefault();
      if (!st.chatOpen) toggleChat();
      if (chat) chat.focus();
      return;
    }
    if (mod && !typing && event.key.toLowerCase() === "z" && cut && cut.canUndo()) {
      event.preventDefault();
      cut.undo();
      return;
    }
    if (typing || mod || document.querySelector(".scrim")) return;
    if (cut && cut.hasSelection() && (event.key === "Delete" || event.key === "Backspace")) {
      event.preventDefault();
      cut.cutSelection();
      return;
    }
    if (cut && event.key === "Escape") cut.clearSelection();
    if (!player) return;
    if (event.key === " ") {
      event.preventDefault();
      player.toggle();
    } else if (event.key === "ArrowLeft") player.seek(player.video.currentTime - 5);
    else if (event.key === "ArrowRight") player.seek(player.video.currentTime + 5);
    else if (event.key.toLowerCase() === "f") {
      const stage = $("[data-stage]");
      if (document.fullscreenElement) document.exitFullscreen();
      else stage.requestFullscreen().catch(() => {});
    }
  };
  document.addEventListener("keydown", onKey);

  // Fit in the observer callback itself: it already runs once per layout,
  // and a frame callback can be held back (hidden or occluded windows).
  // The stage cannot resize the wrap it is measured from (min-width: 0).
  const ro = new ResizeObserver(() => {
    fitStage();
    if (st.tab !== "video") schedulePlace();
  });
  ro.observe($("[data-stage-wrap]"));

  // ---------- live updates ----------

  const paintPluginSlot = () => paintProjectButtons($("[data-plugin-slot]"), () => st.project);
  const offs = [
    on("plugin-buttons", paintPluginSlot),
    // Ctrl D or the palette: a new drawing in this project, straight to its tab.
    on("new-drawing", () => { if (!st.destroyed) void newDrawing(); }),
    on("draw-event", (msg) => {
      if (st.destroyed || !msg) return;
      // open_drawing from an agent brings its tab up in this project.
      if (msg.kind === "draw:select" && msg.drawingId && (!msg.projectId || msg.projectId === projectId)) {
        void loadDrawings().then(() => { if (st.drawings.some((d) => d.id === msg.drawingId)) setTab(msg.drawingId); });
      } else if (msg.kind === "draw:artifact" || msg.kind === "draw:list-changed") {
        void loadDrawings().then(() => paintArtTabs());
      }
    }),
    on("workspace-changed", async (info) => {
      if (st.destroyed) return;
      const before = st.project && JSON.stringify([st.project.state && st.project.state.renders, st.project.assets]);
      const prevAt = st.project && st.project.state && st.project.state.previousVersion && st.project.state.previousVersion.at;
      await load();
      if (!st.project) return;
      const nowPrev = st.project.state && st.project.state.previousVersion;
      if (nowPrev && nowPrev.at && nowPrev.at !== prevAt && !st.restoring && info && info.tool) {
        toast("The agent replaced the clip. Previous version brings back the old one.");
      }
      // A render the agent just made goes straight onto the stage.
      const made = (info && info.newRenders) || [];
      const mine = projectRenders(st.project).filter((r) => made.includes(r.id));
      if (mine.length) {
        st.outputId = mine[0].id;
        st.mode = "output";
      }
      const after = JSON.stringify([st.project.state && st.project.state.renders, st.project.assets]);
      paintAll();
      if (before !== after) void backfillPosters();
    }),
    on("snapshot", () => {
      if (!st.project || st.destroyed) return;
      paintAssets();
      paintOutputs();
      paintTabs();
    }),
  ];

  live = {
    stagePreview(args) {
      const renderId = args.renderId ? String(args.renderId) : "";
      if (renderId) {
        if (!store.mediaById(renderId)) return { ok: false, error: "That render was not found." };
        showOutput(renderId);
      } else if (args.mode === "source") {
        st.mode = "source";
        paintAll();
      } else {
        if (!currentOutput()) return { ok: false, error: "No render exists yet, so the stage shows Source." };
        st.mode = "output";
        paintAll();
      }
      const out = currentOutput();
      const sel = selectedAsset();
      return { ok: true, mode: st.mode, selectedId: sel ? sel.id : "", outputId: out ? out.id : "" };
    },
  };

  (async () => {
    if (!(await load())) return;
    if (st.destroyed) return;
    paintAll();
    paintPluginSlot();
    await loadDrawings();
    // A history row or the palette can land straight on a drawing's tab.
    if (opts && opts.drawingId && st.drawings.some((d) => d.id === opts.drawingId)) setTab(opts.drawingId);
    else if (!hasVideoContent() && st.drawings.length) setTab(st.drawings[0].id);
    else setTab("video");
    emit("project-open", st.project);
    cut = mountCutStrip($("[data-cut]"), {
      projectId,
      getProject: () => st.project,
      getClip: () => selectedAsset(),
      getPlayer: () => player,
      isSourceMode: () => st.mode === "source",
      onEdited: (project) => {
        if (project) st.project = project;
        paintAll();
      },
    });
    cut.paint();
    void backfillPosters(assets().filter((a) => !a.missing));
    chat = mountChat($("[data-chat]"), {
      projectId,
      // A chat id comes from the Home history list: the editor opens on it.
      chatId: (opts && opts.chatId) || "",
      getProject: () => st.project,
      selectedAssetId: () => (selectedAsset() || {}).id || "",
      // The prompt names what is on stage: the video or the open drawing.
      drawings: () => st.drawings || [],
      openDrawingId: () => (st.tab === "video" ? "" : st.tab),
      // An artifact card in the transcript opens its drawing's tab.
      onOpenDrawing: (drawingId) => setTab(drawingId),
      onProjectChanged: async () => {
        await load();
        await loadDrawings();
        paintAll();
        paintArtTabs();
      },
    });
  })();

  return () => {
    st.destroyed = true;
    live = null;
    ro.disconnect();
    overlayWatch.disconnect();
    api.jdrawViewHide().catch(() => {});
    document.removeEventListener("keydown", onKey);
    offs.forEach((off) => off());
    if (player) player.destroy();
    if (cut) cut.destroy();
    if (chat) chat.destroy();
  };
}
