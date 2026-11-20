import { api, store, on, emit, refreshSnapshot, refreshProjects, refreshHarnesses, applyLook, setPrefs } from "./store.js";
import { wireSessions } from "./sessions.js";
import { icon, esc, toast, openDialog, closeDialog, confirmDialog, closeMenu, modalOpen, timeAgo, $ } from "./ui.js";
import { renderHome } from "./pages/home.js";
import { renderLibrary } from "./pages/library.js";
import { renderAgents } from "./pages/agents.js";
import { renderSettings } from "./pages/settings.js";
import { renderEditor, editorBridge } from "./pages/editor.js";
import { initPlugins, pluginCommands, pluginPages, renderPluginPage } from "./plugins.js";

const NAV = [
  { page: "library", label: "Library", icon: "library", key: "1" },
  { page: "agents", label: "Agents", icon: "bot", key: "2" },
];

let teardown = null;

export function navigate(page, params = {}) {
  const next = Object.assign({ page }, params);
  const same = store.route.page === next.page && store.route.projectId === next.projectId && store.route.section === next.section && store.route.plugin === next.plugin && store.route.pageId === next.pageId;
  store.route = next;
  if (same && page !== "settings") return;
  closeMenu();
  paint();
}

// Which studio is on show. Draw runs in a view beside the rail, so the rail stays usable.
let studioNow = "video";
// JV pages and dialogs sit under the Draw view while Draw is up: anything
// opened from the rail brings the Video studio back first.
const toVideo = () => { if (studioNow === "draw" && api.setStudio) api.setStudio("video"); };

function railMarkup() {
  // Inside a project nothing is highlighted: the editor is not one of the rail pages.
  const inDraw = studioNow === "draw";
  const page = inDraw ? "" : store.route.page;
  return (
    '<nav class="rail" aria-label="Main">' +
    '<div class="rail-logo" aria-label="JDesign">JD</div>' +
    // The studio pair is one selection: Video Editor or Drawing. It is shown by
    // a filled tile, never the page marker bar, so only one bar shows at a time.
    '<button class="rail-link is-studio' + (inDraw ? "" : " is-on") + '" data-studio="video" title="Video Editor">' + icon("film") + "<span>Video Editor</span></button>" +
    '<button class="rail-link is-studio' + (inDraw ? " is-on" : "") + '" data-studio="draw" title="Drawing (Ctrl D)">' + icon("pencil") + "<span>Drawing</span></button>" +
    '<div class="rail-sep" role="separator"></div>' +
    NAV.map((item) =>
      '<button class="rail-link' + (page === item.page ? " is-on" : "") + '" data-nav="' + item.page + '" title="' + item.label + " (Ctrl " + item.key + ')">' +
      icon(item.icon) + "<span>" + item.label + "</span></button>",
    ).join("") +
    // Pages added by plugins sit under the built-in ones.
    pluginPages().map((p) =>
      '<button class="rail-link' + (page === "plugin" && store.route.plugin === p.plugin && store.route.pageId === p.pageId ? " is-on" : "") + '" data-plugin-nav="' + esc(p.plugin) + '" data-plugin-page-id="' + esc(p.pageId) + '" title="' + esc(p.title + " (plugin)") + '">' +
      icon(p.icon) + "<span>" + esc(p.label) + "</span></button>",
    ).join("") +
    '<div class="rail-spacer"></div>' +
    '<button class="rail-link" data-palette title="Search projects and commands (Ctrl K)">' + icon("search") + "<span>Search</span></button>" +
    '<button class="rail-link" data-help title="Keyboard shortcuts (?)">' + icon("help") + "<span>Help</span></button>" +
    '<button class="rail-link' + (page === "settings" ? " is-on" : "") + '" data-nav="settings" title="Settings (Ctrl ,)">' + icon("settings") + "<span>Settings</span></button>" +
    "</nav>"
  );
}

function paint() {
  const root = document.getElementById("app");
  if (typeof teardown === "function") {
    try {
      teardown();
    } catch (error) {
      console.error(error);
    }
  }
  teardown = null;
  root.innerHTML = railMarkup() + '<main class="main" id="main"></main>';
  const main = document.getElementById("main");
  const page = store.route.page;
  if (page === "editor") teardown = renderEditor(main, store.route.projectId);
  else if (page === "library") teardown = renderLibrary(main);
  else if (page === "agents") teardown = renderAgents(main);
  else if (page === "settings") teardown = renderSettings(main, store.route.section);
  else if (page === "plugin") teardown = renderPluginPage(main, store.route.plugin, store.route.pageId);
  else teardown = renderHome(main);
  emit("page", { page });
}

// A plugin added or removed a rail page: swap only the rail, keep the page.
function repaintRail() {
  const rail = document.querySelector(".rail");
  if (!rail) return;
  const html = railMarkup();
  if (rail.outerHTML !== html) rail.outerHTML = html;
}

document.addEventListener("click", (event) => {
  const studio = event.target.closest("[data-studio]");
  if (studio) {
    event.preventDefault();
    if (studio.dataset.studio === "draw") {
      if (api.setStudio) api.setStudio("draw");
    } else if (studioNow === "draw") {
      if (api.setStudio) api.setStudio("video");
    } else {
      // Home has no rail button of its own: the Video Editor tile is the way
      // back to the launcher, so both are never marked at once.
      navigate("home");
    }
    return;
  }
  const nav = event.target.closest("[data-nav]");
  if (nav) {
    event.preventDefault();
    if (studioNow === "draw" && api.setStudio) api.setStudio("video");
    navigate(nav.dataset.nav);
    return;
  }
  const pnav = event.target.closest("[data-plugin-nav]");
  if (pnav) {
    event.preventDefault();
    toVideo();
    navigate("plugin", { plugin: pnav.dataset.pluginNav, pageId: pnav.dataset.pluginPageId });
    return;
  }
  if (event.target.closest("[data-palette]")) {
    toVideo();
    openPalette();
    return;
  }
  if (event.target.closest("[data-help]")) {
    toVideo();
    showShortcuts();
    return;
  }
  // Agent replies and help text never navigate the app window.
  const link = event.target.closest("a[data-href]");
  if (link) {
    event.preventDefault();
    if (api) api.openExternal(link.dataset.href).catch(() => {});
    return;
  }
  const copy = event.target.closest("[data-copy-code]");
  if (copy) {
    const code = copy.parentElement.querySelector("code");
    if (code && api) api.copyText(code.textContent).then(() => toast("Copied"));
  }
});

// ---------- keyboard ----------

function typing() {
  const el = document.activeElement;
  return el && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && !["checkbox", "radio", "range", "button"].includes(el.type)) || el.isContentEditable);
}

document.addEventListener("keydown", (event) => {
  if (modalOpen()) return;
  const mod = event.ctrlKey || event.metaKey;
  if (mod && event.key.toLowerCase() === "k") {
    event.preventDefault();
    toVideo();
    openPalette();
    return;
  }
  if (mod && !event.shiftKey && event.key.toLowerCase() === "d" && !typing() && api.setStudio) {
    event.preventDefault();
    api.setStudio("draw");
    return;
  }
  if (mod && event.key === ",") {
    event.preventDefault();
    toVideo();
    navigate("settings");
    return;
  }
  if (mod && !event.shiftKey && /^[1-9]$/.test(event.key)) {
    const item = NAV[Number(event.key) - 1];
    if (item) {
      event.preventDefault();
      toVideo();
      navigate(item.page);
    }
    return;
  }
  if (mod && event.key.toLowerCase() === "n" && !typing()) {
    event.preventDefault();
    toVideo();
    navigate("home");
    setTimeout(() => {
      const box = $("[data-launch-input]");
      if (box) box.focus();
    }, 0);
    return;
  }
  if (event.key === "?" && !typing() && !mod) {
    event.preventDefault();
    toVideo();
    showShortcuts();
  }
});

function showShortcuts() {
  const groups = [
    ["Anywhere", [
      ["Ctrl K", "Search projects and commands"],
      ["Ctrl N", "Start a new video"],
      ["Ctrl 1 / 2", "Library, Agents"],
      ["Ctrl ,", "Settings"],
      ["?", "This list"],
    ]],
    ["In a project", [
      ["Space", "Play or pause the preview"],
      ["Left / Right", "Step the preview by 5 seconds"],
      ["F", "Full screen preview"],
      ["Ctrl B", "Show or hide the media panel"],
      ["Ctrl J", "Show or hide the chat"],
      ["Ctrl L", "Focus the chat box"],
      ["Esc in the chat box", "Stop the agent while it works"],
    ]],
  ];
  openDialog({
    title: "Keyboard shortcuts",
    body: groups.map(([name, rows]) => '<div class="set-group-title" style="padding:6px 0 8px">' + esc(name) + '</div><dl class="kv" style="margin-bottom:14px">' + rows.map(([k, v]) => "<dt><kbd>" + esc(k) + "</kbd></dt><dd>" + esc(v) + "</dd>").join("") + "</dl>").join(""),
  });
}

// ---------- command palette ----------

function openPalette() {
  closeMenu();
  const projects = store.projects || [];
  const commands = [
    { label: "Start a new video", icon: "plus", kbd: "Ctrl N", run: () => { navigate("home"); setTimeout(() => { const b = $("[data-launch-input]"); if (b) b.focus(); }, 0); } },
    { label: "Open the Draw studio", icon: "pencil", kbd: "Ctrl D", run: () => api.setStudio && api.setStudio("draw") },
    { label: "Home", icon: "home", run: () => navigate("home") },
    { label: "Library", icon: "library", kbd: "Ctrl 1", run: () => navigate("library") },
    { label: "Agents", icon: "bot", kbd: "Ctrl 2", run: () => navigate("agents") },
    { label: "Settings", icon: "settings", kbd: "Ctrl ,", run: () => navigate("settings") },
    { label: "Appearance settings", icon: "palette", run: () => navigate("settings", { section: "appearance" }) },
    { label: "Instructions and rules", icon: "book", run: () => navigate("settings", { section: "instructions" }) },
    { label: "Voice and music (ElevenLabs)", icon: "mic", run: () => navigate("settings", { section: "voice" }) },
    { label: "Storage", icon: "drive", run: () => navigate("settings", { section: "storage" }) },
    { label: "Plugins", icon: "puzzle", run: () => navigate("settings", { section: "plugins" }) },
    { label: "Keyboard shortcuts", icon: "keyboard", kbd: "?", run: showShortcuts },
  ];
  const dlg = openDialog({
    className: "palette",
    body:
      '<div class="search">' + icon("search") + '<input class="input" data-pq placeholder="Search projects and commands"></div><div class="palette-list" data-pl></div>',
  });
  dlg.querySelector(".dialog-body").style.padding = "0";
  const input = dlg.querySelector("[data-pq]");
  const listEl = dlg.querySelector("[data-pl]");
  let active = 0;
  let items = [];
  const paintList = () => {
    const q = input.value.trim().toLowerCase();
    const projectItems = projects.map((p) => ({ label: p.name, sub: timeAgo(p.updatedAt) || "Project", icon: "film", run: () => navigate("editor", { projectId: p.id }) }));
    items = commands.concat(pluginCommands(), projectItems).filter((item) => !q || item.label.toLowerCase().includes(q)).slice(0, 40);
    if (active >= items.length) active = Math.max(0, items.length - 1);
    listEl.innerHTML = items.length
      ? items.map((item, i) =>
          '<button class="menu-item' + (i === active ? " is-active" : "") + '" data-pi="' + i + '">' + icon(item.icon) +
          '<span class="grow ellipsis">' + esc(item.label) + "</span>" + (item.sub ? '<span class="faint">' + esc(item.sub) + "</span>" : "") +
          (item.kbd ? "<kbd>" + esc(item.kbd) + "</kbd>" : "") + "</button>").join("")
      : '<div class="menu-empty">No matches</div>';
  };
  const runAt = (i) => {
    const item = items[i];
    closeDialog();
    if (item) item.run();
  };
  input.addEventListener("input", () => {
    active = 0;
    paintList();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      active = (active + (event.key === "ArrowDown" ? 1 : -1) + items.length) % Math.max(1, items.length);
      paintList();
      const el = listEl.querySelector(".is-active");
      if (el) el.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter") {
      event.preventDefault();
      runAt(active);
    }
  });
  listEl.addEventListener("click", (event) => {
    const b = event.target.closest("[data-pi]");
    if (b) runAt(Number(b.dataset.pi));
  });
  paintList();
  setTimeout(() => input.focus(), 0);
  if (!store.projects) refreshProjects().then(() => paintList()).catch(() => {});
}

// ---------- agent bridge (MCP tools that drive the app) ----------

function coalesce(run, delay = 180, maxWait = 1000) {
  let timer = 0;
  let first = 0;
  let running = false;
  let again = false;
  const fire = () => {
    timer = 0;
    first = 0;
    if (running) {
      again = true;
      return;
    }
    running = true;
    Promise.resolve().then(run).catch(() => {}).then(() => {
      running = false;
      if (again) {
        again = false;
        schedule();
      }
    });
  };
  const schedule = () => {
    const now = Date.now();
    if (!first) first = now;
    clearTimeout(timer);
    timer = setTimeout(fire, Math.max(0, Math.min(delay, first + maxWait - now)));
  };
  return schedule;
}

function wireBridge() {
  if (!api) return;
  // The tool that changed the workspace rides along, so pages can tell an
  // agent's change from their own.
  let lastTool = "";
  let mixed = false;
  const refreshNow = coalesce(async () => {
    // A refresh of the person's own change in the same run is not the agent's.
    const tool = mixed ? "" : lastTool;
    lastTool = "";
    mixed = false;
    const beforeRenders = new Set((store.workspace.finished || []).map((item) => item && item.id));
    await refreshSnapshot();
    await refreshProjects();
    const made = (store.workspace.finished || []).filter((item) => item && item.kind === "video" && !beforeRenders.has(item.id));
    emit("workspace-changed", { newRenders: made.map((item) => item.id), tool });
  });
  const refresh = (tool) => {
    if (tool) lastTool = String(tool);
    else if (lastTool) mixed = true;
    refreshNow();
  };
  if (api.onAgentEvent) {
    api.onAgentEvent((message) => {
      const event = message && message.event;
      if (event === "instructions-changed") {
        toast("An agent updated your instructions.", "info");
        emit("instructions-changed");
        return;
      }
      if (event === "workspace-changed" || event === "cards-changed") refresh(message.payload && message.payload.tool);
    });
  }
  if (api.onStorageJob) {
    api.onStorageJob((message) => {
      emit("storage-job", message);
      if (message && message.type === "changed") refresh();
    });
  }
  api.onBridgeCommand(async (message) => {
    const { id, command, args } = message || {};
    try {
      const result = await runBridge(command, args || {});
      await api.bridgeCommandReply({ id, ok: true, result });
    } catch (error) {
      await api.bridgeCommandReply({ id, ok: false, error: (error && error.message) || String(error) });
    }
  });
}

const BRIDGE_PAGES = { ai: "home", clips: "library", acpMarketplace: "agents", cleanup: "settings", home: "home", library: "library", agents: "agents", settings: "settings" };

async function runBridge(command, args) {
  if (command === "state") {
    return { page: store.route.page === "editor" ? "ai" : store.route.page, workspaceId: store.workspaceId, aiProjectId: store.route.projectId || "", editingCardId: "" };
  }
  if (command === "navigate") {
    const page = BRIDGE_PAGES[args.page];
    if (!page) throw new Error("JV has no " + args.page + " page.");
    await refreshSnapshot().catch(() => {});
    navigate(page, page === "settings" ? { section: "storage" } : {});
    return { page: args.page };
  }
  if (command === "open-project") {
    const project = await api.aiProjectGet({ id: args.projectId });
    if (!project) throw new Error("Project not found.");
    await refreshSnapshot().catch(() => {});
    navigate("editor", { projectId: project.id });
    return { page: "ai", projectId: project.id };
  }
  if (command === "stage-preview") return editorBridge.stagePreview(args);
  if (command === "open-card") throw new Error("Card editing is not in this JV build yet. Edit cards with the cards_* tools and render them onto video.");
  if (command === "record-status") return { state: "unavailable", message: "Recording is not in this JV build yet." };
  if (command === "record-start" || command === "record-stop") throw new Error("Recording is not in this JV build yet.");
  if (command === "approve-elevenlabs") {
    const chars = Number(args.chars) || 0;
    const preview = String(args.text || "").trim();
    const approved = await confirmDialog({
      title: "Generate a voiceover?",
      body: String(args.client || "An outside agent") + " wants to generate " + (chars ? chars + " characters of speech" : "a voiceover") + " with your ElevenLabs account." + (preview ? " Script:\n" + preview.slice(0, 1800) + (preview.length > 1800 ? "..." : "") : ""),
      confirm: "Generate",
    });
    return { approved };
  }
  if (command === "approve-instructions") {
    const preview = String(args.text || "").trim();
    const approved = await confirmDialog({
      title: "Change your instructions?",
      body: String(args.client || "An outside agent") + " wants to replace your standing instructions, the text sent with every message." + (preview ? ' New text: "' + preview.slice(0, 500) + (preview.length > 500 ? "..." : "") + '"' : ""),
      confirm: "Approve",
    });
    return { approved };
  }
  if (command === "approve-card-delete") {
    const names = (Array.isArray(args.names) ? args.names : []).map(String);
    const approved = await confirmDialog({
      title: names.length > 1 ? "Delete " + names.length + " cards?" : "Delete this card?",
      body: String(args.client || "An agent") + " wants to delete " + names.map((n) => '"' + n + '"').join(", ") + ". Images stay in your library.",
      confirm: "Delete",
      danger: true,
    });
    return { approved };
  }
  throw new Error("Unknown command: " + command);
}

// ---------- boot ----------

async function boot() {
  const root = document.getElementById("app");
  if (!api) {
    root.innerHTML = '<div class="empty" style="grid-column:1/-1;margin:auto"><h3>JV</h3><p>Start this app with npm start.</p></div>';
    return;
  }
  try {
    store.prefs = (await api.prefs()) || {};
  } catch {
    store.prefs = {};
  }
  applyLook();
  try {
    await refreshSnapshot();
  } catch (error) {
    root.innerHTML = '<div class="empty" style="grid-column:1/-1;margin:auto">' + icon("alert", "i-xl") + "<h3>JV could not open its library</h3><p>" + esc((error && error.message) || error) + "</p></div>";
    return;
  }
  wireSessions();
  wireBridge();
  // Voice and music workflows are greyed out until an ElevenLabs key is saved.
  api.elevenlabsStatus().then((s) => { store.elevenlabsReady = Boolean(s && s.configured); }).catch(() => {});
  await Promise.all([refreshHarnesses(), refreshProjects().catch(() => [])]);
  paint();
  // Plugins load after the first paint, so a slow or broken one never holds up the window.
  void initPlugins({ navigate, onRailChange: repaintRail });
  window.__jeditor = { store, navigate, refreshHarnesses, refreshProjects, refreshSnapshot };
}

// A failure anywhere surfaces as a toast instead of a silently stuck page.
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  console.error("Unhandled:", (reason && (reason.stack || reason.message)) || reason);
  toast((reason && reason.message) || "Something went wrong.", true);
});
window.addEventListener("error", (event) => {
  if (!event.error) return;
  console.error("Error:", event.error.stack || event.error.message);
});

on("navigate", ({ page, params }) => navigate(page, params));
if (api.onStudioChanged) api.onStudioChanged((message) => {
  if (message && message.library) refreshSnapshot().catch(() => {});
  if (message && message.studio) { studioNow = message.studio === "draw" ? "draw" : "video"; repaintRail(); }
});
if (api.currentStudio) api.currentStudio().then((r) => { if (r && r.studio === "draw") { studioNow = "draw"; repaintRail(); } }).catch(() => {});
if (api.onStudioTheme) api.onStudioTheme(({ mode }) => { if (["light", "dark", "system"].includes(mode)) setPrefs({ theme: mode }); });
boot();
