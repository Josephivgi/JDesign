// Plugins: approved modules that extend the window. Each one is served by
// the jvplugin: protocol (main process) only while it is on and its code
// still matches what the person approved, then activate(jv) runs here.
//
// Everything a plugin adds is recorded per plugin, so turning it off removes
// it without a restart. Every plugin callback runs inside guard(): errors are
// caught, shown once, reported to the main process (agents can read them with
// jeditor_plugin_read), and a plugin that keeps failing is turned off.

import { api, store, on, emit, refreshProjects } from "./store.js";
import { icon, esc, toast, openDialog, closeDialog, confirmDialog, promptDialog, showMenu, errorText, timeAgo, formatBytes } from "./ui.js";

const loaded = new Map(); // id -> { hash, name, commands, pages, buttons, offs, cleanup }
const failures = new Map(); // id -> recent error times
const FAIL_LIMIT = 5; // errors within FAIL_WINDOW turn the plugin off
const FAIL_WINDOW = 60 * 1000;
const START_LIMIT_MS = 10000;
const SLOW = Symbol("slow");
let navigateFn = null;
let repaintRail = null;

export function pluginState() {
  return loaded;
}

function report(id, error, where) {
  const message = (where ? where + ": " : "") + ((error && (error.stack || error.message)) || String(error));
  console.error("[plugin " + id + "]", message);
  if (api && api.pluginsError) api.pluginsError({ id, message }).catch(() => {});
  const now = Date.now();
  const times = (failures.get(id) || []).filter((t) => now - t < FAIL_WINDOW);
  times.push(now);
  failures.set(id, times);
  const entry = loaded.get(id);
  const name = (entry && entry.name) || id;
  const details = { label: "Details", run: () => navigateFn && navigateFn("settings", { section: "plugins" }) };
  if (times.length >= FAIL_LIMIT) {
    failures.delete(id);
    toast("Turned off the " + name + " plugin because it kept failing.", true, details);
    unload(id);
    if (api && api.pluginsSetEnabled) api.pluginsSetEnabled({ id, enabled: false }).then(() => emit("plugins-changed", { id })).catch(() => {});
  } else if (times.length === 1) {
    toast("The " + name + " plugin hit an error.", true, details);
  }
}

// Runs a plugin callback and catches what it throws, sync or async.
function guard(id, where, fn) {
  return (...args) => {
    try {
      const out = fn(...args);
      if (out && typeof out.then === "function") return out.catch((error) => report(id, error, where));
      return out;
    } catch (error) {
      report(id, error, where);
      return undefined;
    }
  };
}

function cleanText(value, max) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, max);
}

function makeJv(id, entry) {
  const ui = { icon, esc, toast, openDialog, closeDialog, confirmDialog, promptDialog, showMenu, errorText, timeAgo, formatBytes };
  const jv = {
    id,
    version: 1,
    ui,
    toast: (message, kind, action) => toast(cleanText(message, 300), kind, action && typeof action.run === "function" ? { label: cleanText(action.label, 24) || "Open", run: guard(id, "toast action", action.run) } : null),
    // Palette entry (Ctrl K). Returns a function that removes it.
    addCommand(spec) {
      if (!spec || typeof spec.run !== "function") throw new Error("addCommand needs { label, run }.");
      const label = cleanText(spec.label, 60) || "Plugin command";
      // The palette names the plugin on the right, unless the command already says it.
      const cmd = { id: id + ":" + cleanText(spec.id || spec.label, 40), label, icon: cleanText(spec.icon, 30) || "puzzle", sub: label.toLowerCase() === entry.name.toLowerCase() ? "Plugin" : entry.name, run: guard(id, "command " + spec.label, spec.run) };
      entry.commands.push(cmd);
      return () => {
        entry.commands = entry.commands.filter((c) => c !== cmd);
      };
    },
    // A page with its own button on the left rail. render(el) fills el and
    // may return a cleanup function, called when the person leaves the page.
    addPage(spec) {
      if (!spec || typeof spec.render !== "function") throw new Error("addPage needs { id, label, render(el) }.");
      const pageId = cleanText(spec.id || spec.label, 40).toLowerCase().replace(/[^a-z0-9-]+/g, "-") || "page";
      const page = { key: id + "/" + pageId, plugin: id, pageId, label: cleanText(spec.label, 14) || entry.name.slice(0, 14), title: cleanText(spec.title || spec.label, 80), icon: cleanText(spec.icon, 30) || "puzzle", render: spec.render };
      entry.pages = entry.pages.filter((p) => p.key !== page.key).concat(page);
      if (repaintRail) repaintRail();
      return () => {
        entry.pages = entry.pages.filter((p) => p !== page);
        if (repaintRail) repaintRail();
      };
    },
    // A button in the project top bar. onClick gets the open project.
    addProjectButton(spec) {
      if (!spec || typeof spec.onClick !== "function") throw new Error("addProjectButton needs { label, onClick(project) }.");
      const btn = { key: id + ":" + cleanText(spec.id || spec.label, 40), label: cleanText(spec.label, 24), title: cleanText(spec.title || spec.label, 120), icon: cleanText(spec.icon, 30) || "puzzle", onClick: guard(id, "button " + spec.label, spec.onClick) };
      entry.buttons = entry.buttons.filter((b) => b.key !== btn.key).concat(btn);
      emit("plugin-buttons");
      return () => {
        entry.buttons = entry.buttons.filter((b) => b !== btn);
        emit("plugin-buttons");
      };
    },
    // App events: "page" ({ page }), "project-open" (project),
    // "workspace-changed" ({ newRenders, tool }). Returns an unsubscribe.
    on(event, handler) {
      const allowed = ["page", "project-open", "workspace-changed"];
      if (!allowed.includes(event)) throw new Error("jv.on supports: " + allowed.join(", ") + ".");
      const off = on(event, guard(id, "on " + event, handler));
      entry.offs.push(off);
      return off;
    },
    // Read-only views of app data, plus the moves a person can make.
    app: {
      route: () => Object.assign({}, store.route),
      navigate: (page, params) => navigateFn && navigateFn(page, params || {}),
      openProject: (projectId) => navigateFn && navigateFn("editor", { projectId }),
      projects: async () => (await refreshProjects().catch(() => store.projects)) || [],
      project: (projectId) => api.aiProjectGet({ id: projectId }),
      library: () => (store.workspace && store.workspace.library ? store.workspace.library.slice() : []),
      finished: () => (store.workspace && store.workspace.finished ? store.workspace.finished.slice() : []),
      theme: () => document.documentElement.dataset.theme || "dark",
    },
    // Small per-plugin store saved in <data>/plugins/<id>/data.json (1 MB).
    data: {
      get: async () => (await api.pluginsDataGet({ id })) || {},
      set: (value) => api.pluginsDataSet({ id, value }),
    },
    // The full app bridge, for plugins that need more than the helpers above.
    api,
  };
  return Object.freeze(jv);
}

function unload(id) {
  const entry = loaded.get(id);
  if (!entry) return;
  loaded.delete(id);
  for (const off of entry.offs) {
    try {
      off();
    } catch {
      /* already gone */
    }
  }
  if (typeof entry.cleanup === "function") {
    try {
      entry.cleanup();
    } catch (error) {
      console.error("[plugin " + id + "] cleanup", error);
    }
  }
  if (store.route.page === "plugin" && store.route.plugin === id && navigateFn) navigateFn("home");
  emit("plugin-buttons");
  if (repaintRail) repaintRail();
}

async function load(info) {
  const entry = { hash: info.hash, name: info.name, commands: [], pages: [], buttons: [], offs: [], cleanup: null };
  loaded.set(info.id, entry);
  try {
    const mod = await import("jvplugin://p/" + encodeURIComponent(info.id) + "/" + info.hash + ".js");
    const activate = mod.activate || mod.default;
    if (typeof activate !== "function") throw new Error("plugin.js does not export activate(jv).");
    // A start that never finishes must not hold up the plugins after it.
    let timer = 0;
    const slow = new Promise((resolve) => {
      timer = setTimeout(() => resolve(SLOW), START_LIMIT_MS);
    });
    const out = await Promise.race([Promise.resolve(activate(makeJv(info.id, entry))), slow]);
    clearTimeout(timer);
    if (out === SLOW) throw new Error("activate did not finish within " + START_LIMIT_MS / 1000 + " seconds.");
    if (typeof out === "function") entry.cleanup = out;
    else if (out && typeof out.deactivate === "function") entry.cleanup = () => out.deactivate();
  } catch (error) {
    report(info.id, error, "start");
  }
}

// Loads every plugin that is on, unloads ones turned off or changed. Safe to
// call any time; a plugin whose code did not change is left running.
// Syncs run one at a time: an agent write and a Settings toggle arriving
// together must not load the same plugin twice.
let syncChain = Promise.resolve();
export function syncPlugins() {
  const run = syncChain.then(syncNow, syncNow);
  syncChain = run.catch(() => {});
  return run;
}

async function syncNow() {
  if (!api || !api.pluginsList) return [];
  let list = [];
  try {
    list = await api.pluginsList();
  } catch (error) {
    console.error("plugins-list", error);
    return [];
  }
  const want = new Map(list.filter((p) => p.status === "on").map((p) => [p.id, p]));
  for (const [id, entry] of Array.from(loaded)) {
    const next = want.get(id);
    if (!next || next.hash !== entry.hash) unload(id);
  }
  for (const [id, info] of want) {
    if (!loaded.has(id)) await load(info);
  }
  emit("plugin-buttons");
  if (repaintRail) repaintRail();
  return list;
}

export function pluginCommands() {
  return Array.from(loaded.values()).flatMap((e) => e.commands);
}

export function pluginPages() {
  return Array.from(loaded.values()).flatMap((e) => e.pages);
}

export function renderPluginPage(main, pluginId, pageId) {
  const page = pluginPages().find((p) => p.plugin === pluginId && p.pageId === pageId);
  if (!page) {
    main.innerHTML = '<div class="page"><div class="page-inner"><div class="empty">' + icon("puzzle", "i-xl") + "<h3>This plugin page is not available</h3><p>The plugin may be off. Check Settings > Plugins.</p></div></div></div>";
    return null;
  }
  main.innerHTML = '<div class="page"><div class="page-inner plugin-page" data-plugin-page="' + esc(page.key) + '"></div></div>';
  const el = main.querySelector("[data-plugin-page]");
  const cleanup = guard(pluginId, "page " + page.label, page.render)(el);
  return () => {
    if (typeof cleanup === "function") guard(pluginId, "page cleanup", cleanup)();
  };
}

// Paints plugin buttons into the editor top bar slot. Idempotent: the slot is
// only rewritten when the set of buttons changed.
export function paintProjectButtons(slot, getProject) {
  if (!slot) return;
  const buttons = Array.from(loaded.values()).flatMap((e) => e.buttons);
  const sig = buttons.map((b) => b.key + "|" + b.label + "|" + b.icon).join(",");
  if (slot.dataset.sig === sig) return;
  slot.dataset.sig = sig;
  slot.innerHTML = buttons.map((b, i) => '<button class="btn" data-plugin-btn="' + i + '" title="' + esc(b.title) + '">' + icon(b.icon) + (b.label ? "<span>" + esc(b.label) + "</span>" : "") + "</button>").join("");
  slot.classList.toggle("hidden", !buttons.length);
  slot.onclick = (event) => {
    const el = event.target.closest("[data-plugin-btn]");
    if (!el) return;
    const btn = buttons[Number(el.dataset.pluginBtn)];
    if (btn) btn.onClick(getProject());
  };
}

export function initPlugins({ navigate, onRailChange }) {
  navigateFn = navigate;
  repaintRail = onRailChange;
  if (api && api.onAgentEvent) {
    api.onAgentEvent((message) => {
      if (!message || message.event !== "plugins-changed") return;
      const p = message.payload || {};
      emit("plugins-changed", p);
      if (p.name) {
        const verb = p.created ? "made" : "updated";
        const open = () => navigateFn && navigateFn("settings", { section: "plugins" });
        toast("An agent " + verb + " the " + p.name + " plugin." + (p.status === "on" ? "" : " It is off until you turn it on."), "info", p.status === "on" ? null : { label: "Review", run: open });
      }
    });
  }
  on("plugins-changed", () => void syncPlugins());
  return syncPlugins();
}
