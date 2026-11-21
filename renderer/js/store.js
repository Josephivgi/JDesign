// App-wide state and a tiny event bus. Pages read from `store` and repaint on
// the events they care about; nothing here touches the DOM.

export const api = window.cutline || null;

const listeners = new Map();

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}

export function emit(event, payload) {
  const set = listeners.get(event);
  if (!set) return;
  for (const fn of Array.from(set)) {
    try {
      fn(payload);
    } catch (error) {
      console.error("listener " + event, error);
    }
  }
}

export const store = {
  snapshot: null,
  prefs: {},
  harnesses: [],
  // Saved ACP Registry icons by registry id, for model maker marks.
  registryIcons: {},
  projects: null,
  route: { page: "home" },
  get workspaceId() {
    return String((this.snapshot && this.snapshot.activeWorkspaceId) || "");
  },
  get workspace() {
    return (this.snapshot && this.snapshot.workspace) || { library: [], finished: [], cards: [] };
  },
  get library() {
    return (this.workspace.library || []).filter(Boolean);
  },
  mediaById(id) {
    const key = String(id || "");
    return this.library.find((item) => item.id === key) || (this.workspace.finished || []).find((item) => item && item.id === key) || null;
  },
};

export async function refreshSnapshot() {
  if (!api) return null;
  store.snapshot = await api.snapshot();
  emit("snapshot", store.snapshot);
  return store.snapshot;
}

export async function refreshProjects() {
  if (!api) return [];
  const list = await api.aiProjects();
  store.projects = Array.isArray(list) ? list : (list && list.projects) || [];
  emit("projects", store.projects);
  return store.projects;
}

export async function refreshHarnesses() {
  if (!api) return [];
  try {
    const [list, icons] = await Promise.all([api.acpHarnesses(), api.acpRegistryIcons ? api.acpRegistryIcons().catch(() => null) : null]);
    store.harnesses = Array.isArray(list) ? list : [];
    if (icons && typeof icons === "object") store.registryIcons = icons;
  } catch {
    store.harnesses = [];
  }
  emit("harnesses", store.harnesses);
  return store.harnesses;
}

export function harnessById(id) {
  return store.harnesses.find((item) => item.id === id) || null;
}

export function defaultHarnessId() {
  const pref = store.prefs.defaultAgent;
  const available = store.harnesses.filter((item) => item.available);
  if (pref && available.some((item) => item.id === pref)) return pref;
  // Never a not-installed agent: with none ready the pickers say Choose agent.
  return (available[0] && available[0].id) || "";
}

export async function setPrefs(patch) {
  Object.assign(store.prefs, patch);
  applyLook();
  emit("prefs", store.prefs);
  if (api && api.setPrefs) {
    try {
      store.prefs = Object.assign(store.prefs, await api.setPrefs(patch));
    } catch (error) {
      console.error("prefs save failed", error);
    }
  }
}

const darkQuery = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

export function resolvedTheme() {
  const theme = store.prefs.theme || "system";
  if (theme === "system") return darkQuery && darkQuery.matches ? "dark" : "light";
  return theme;
}

export function applyLook() {
  const root = document.documentElement;
  const theme = resolvedTheme();
  root.dataset.theme = theme;
  root.dataset.accent = store.prefs.accent || "mono";
  root.dataset.density = store.prefs.density || "comfortable";
  root.dataset.chatSize = store.prefs.chatTextSize || "md";
  if (api && api.setChrome) api.setChrome({ theme, mode: store.prefs.theme || "system" }).catch(() => {});
}

if (darkQuery) darkQuery.addEventListener("change", () => applyLook());

export function libraryUrl(id) {
  return "cutline://library/" + store.workspaceId + "/" + id;
}
export function posterUrl(id) {
  return "cutline://poster/" + store.workspaceId + "/" + id;
}
export function renderUrl(id) {
  return "cutline://finished/" + store.workspaceId + "/" + id;
}
export function renderPosterUrl(id) {
  return "cutline://finished-poster/" + store.workspaceId + "/" + id;
}

// The best still for any media row: a poster for videos, the file for images.
export function thumbFor(item) {
  if (!item) return "";
  const finished = (store.workspace.finished || []).some((row) => row && row.id === item.id);
  if (finished) return item.posterFile ? renderPosterUrl(item.id) : "";
  if (item.kind === "image") return libraryUrl(item.id);
  if (item.kind === "video" && item.posterFile) return posterUrl(item.id);
  return "";
}

export function mediaUrlFor(item) {
  if (!item) return "";
  const finished = (store.workspace.finished || []).some((row) => row && row.id === item.id);
  return finished ? renderUrl(item.id) : libraryUrl(item.id);
}
