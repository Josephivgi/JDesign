// Shared UI primitives: escaping, icons, toasts, popover menus, dialogs.

export function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// Stroke icons drawn on a 24 grid.
const PATHS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/>',
  film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m21 16-5-5-9 9"/>',
  music: '<path d="M9 18V5l11-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
  library: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  bot: '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 4v4M9 13v1.5M15 13v1.5M2 13v3M22 13v3"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  chevDown: '<path d="m6 9 6 6 6-6"/>',
  chevUp: '<path d="m6 15 6-6 6 6"/>',
  chevLeft: '<path d="m15 18-6-6 6-6"/>',
  chevRight: '<path d="m9 18 6-6-6-6"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
  play: '<path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none"/>',
  skipBack: '<path d="M19 20 9 12l10-8zM5 19V5"/>',
  skipFwd: '<path d="m5 4 10 8-10 8zM19 5v14"/>',
  back5: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  fwd5: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  volume: '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>',
  volumeX: '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="m22 9-6 6M16 9l6 6"/>',
  repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  maximize: '<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>',
  panelLeft: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  panelRight: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  arrowUp: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
  paperclip: '<path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/>',
  trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  pencil: '<path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
  external: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  circle: '<circle cx="12" cy="12" r="8"/>',
  circleDot: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  xCircle: '<circle cx="12" cy="12" r="9"/><path d="m15 9-6 6M9 9l6 6"/>',
  loader: '<path d="M21 12a9 9 0 1 1-6.2-8.6"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  alertCircle: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>',
  sparkles: '<path d="m12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15v4M17 17h4M5 3v3M3.5 4.5h3"/>',
  brain: '<path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 4.44-1.04Z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-4.44-1.04Z"/>',
  tool: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.8-9.8M17 6l3 3M14 9l2 2"/>',
  palette: '<circle cx="13.5" cy="6.5" r="1"/><circle cx="17.5" cy="10.5" r="1"/><circle cx="8.5" cy="7.5" r="1"/><circle cx="6.5" cy="12.5" r="1"/><path d="M12 2a10 10 0 0 0 0 20 2 2 0 0 0 2-2v-.5a2 2 0 0 1 2-2h2a4 4 0 0 0 4-4C22 7 17.5 2 12 2z"/>',
  drive: '<path d="M22 12H2M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z"/><path d="M6 16h.01M10 16h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
  scissors: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12"/>',
  gauge: '<path d="m12 14 4-4"/><path d="M3.3 19a10 10 0 1 1 17.4 0"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  refresh: '<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5M3 21v-5h5"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  folder: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  keyboard: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M18 13h.01M8 16h8M10 13h4"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V2H6.5A2.5 2.5 0 0 0 4 4.5v15A2.5 2.5 0 0 0 6.5 22H20v-5"/>',
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4"/>',
  layers: '<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/>',
  wand: '<path d="m15 4-1 1M21 10l-1 1M18 2v2M22 6h-2M14 14 3 21l7-11zM12.5 7.5l4 4"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  logIn: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3"/>',
  power: '<path d="M18.4 6.6a9 9 0 1 1-12.8 0M12 2v10"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  command: '<path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 0 0 0-6z"/>',
  ratio: '<rect x="3" y="6" width="18" height="12" rx="2"/>',
  slash: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="m14.5 7-5 10"/>',
  captions: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M10 11.2a2 2 0 1 0 0 1.6M17 11.2a2 2 0 1 0 0 1.6"/>',
  phone: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>',
  eyeOff: '<path d="M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-2.4 3.2M6.6 6.6C3.9 8.4 2 12 2 12s3.6 7 10 7a9.6 9.6 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2M2 2l20 20"/>',
  sort: '<path d="M7 4v16M3 16l4 4 4-4M17 20V4M13 8l4-4 4 4"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01"/>',
  presentation: '<rect x="2" y="3" width="20" height="13" rx="2"/><path d="M12 16v5M8 21h8M7 12l3-3 2 2 4-4"/>',
  pin: '<path d="M12 17v5M5 17h14l-1.8-2.7a2 2 0 0 1-.3-1.1V7a2 2 0 0 0-2-2H9a2 2 0 0 0-2 2v6.2a2 2 0 0 1-.3 1.1z"/>',
  puzzle: '<path d="M19.4 13a2 2 0 1 0 0-4H18V6a2 2 0 0 0-2-2h-3V2.6a2 2 0 1 0-4 0V4H6a2 2 0 0 0-2 2v3h1.4a2 2 0 1 1 0 4H4v3a2 2 0 0 0 2 2h3v-1.4a2 2 0 1 1 4 0V18h3a2 2 0 0 0 2-2v-3z"/>',
};

export function icon(name, cls = "") {
  return '<svg class="i ' + cls + '" viewBox="0 0 24 24" aria-hidden="true">' + (PATHS[name] || PATHS.circle) + "</svg>";
}

export function kindIcon(kind, cls = "") {
  return icon(kind === "video" ? "film" : kind === "audio" ? "music" : kind === "image" ? "image" : "file", cls);
}

// ---------- formatting ----------

export function formatDuration(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0") : m + ":" + String(s).padStart(2, "0");
}

export function formatTimecode(seconds) {
  const t = Math.max(0, Number(seconds) || 0);
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const f = Math.floor((t % 1) * 100);
  return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0") + "." + String(f).padStart(2, "0");
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + " B";
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return (v >= 100 ? Math.round(v) : v.toFixed(1)) + " " + units[i];
}

export function timeAgo(value) {
  const at = typeof value === "number" ? value : Date.parse(value || "");
  if (!Number.isFinite(at)) return "";
  const s = Math.round((Date.now() - at) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.round(m / 60);
  if (h < 24) return h + "h ago";
  const d = Math.round(h / 24);
  if (d < 7) return d + "d ago";
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: d > 300 ? "numeric" : undefined });
}

export function initials(name) {
  const words = String(name || "?").replace(/[^A-Za-z0-9 ]/g, " ").trim().split(/\s+/);
  return ((words[0] || "?")[0] + (words[1] ? words[1][0] : "")).toUpperCase();
}

// ---------- toasts ----------

// kind: false = done (check), true = error, "info" = a neutral note.
// action: optional { label, run } shown as a button; it keeps the toast up longer.
export function toast(message, kind = false, action = null) {
  const root = document.getElementById("toasts");
  if (!root || !message) return;
  const info = kind === "info";
  const bad = kind === true;
  const el = document.createElement("div");
  el.className = "toast" + (bad ? " is-bad" : info ? " is-info" : "");
  el.innerHTML = (bad ? icon("alertCircle") : info ? icon("info") : icon("check")) + "<span>" + esc(message) + "</span>" +
    (action && action.label ? '<button type="button" class="toast-action">' + esc(action.label) + "</button>" : "");
  root.appendChild(el);
  const out = () => {
    el.classList.add("is-out");
    setTimeout(() => el.remove(), 220);
  };
  const btn = el.querySelector(".toast-action");
  if (btn) btn.addEventListener("click", () => {
    out();
    action.run();
  });
  setTimeout(out, action ? 9000 : bad ? 5200 : info ? 4200 : 2800);
}

export function errorText(error) {
  const raw = String((error && error.message) || error || "Something went wrong.");
  // IPC wraps main-process errors; show the sentence the user can act on.
  return raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, "").replace(/[A-Z]:\\[^\s"']+/g, "a local file").slice(0, 400);
}

// ---------- popover menus ----------

let openMenu = null;

export function closeMenu() {
  if (!openMenu) return;
  const m = openMenu;
  openMenu = null;
  m.el.remove();
  document.removeEventListener("pointerdown", m.outside, true);
  document.removeEventListener("keydown", m.key, true);
  window.removeEventListener("resize", m.close);
  window.removeEventListener("blur", m.close);
  if (m.onClose) m.onClose();
}

// items: [{label, sub, icon, checked, danger, disabled, onSelect}] | "sep" | {heading}
// opts.search adds a filter box; opts.align "start" | "end"; opts.above opens upward.
export function showMenu(anchor, items, opts = {}) {
  closeMenu();
  const el = document.createElement("div");
  el.className = "menu";
  el.setAttribute("role", "menu");
  if (opts.width) el.style.minWidth = opts.width + "px";
  const layer = document.getElementById("layer");
  layer.appendChild(el);
  let query = "";
  let active = -1;
  const visible = () =>
    items.filter((item) => {
      if (!query) return true;
      if (!item || typeof item !== "object" || item.heading) return false;
      return (String(item.label || "") + " " + String(item.sub || "")).toLowerCase().includes(query);
    });
  const paint = () => {
    const list = visible();
    const body = list
      .map((item, index) => {
        if (item === "sep") return '<div class="menu-sep"></div>';
        if (item.heading) return '<div class="menu-label">' + esc(item.heading) + "</div>";
        return (
          '<button type="button" role="menuitem" class="menu-item' + (item.danger ? " danger" : "") + (index === active ? " is-active" : "") +
          '" data-index="' + index + '"' + (item.disabled ? " disabled" : "") + ">" +
          (item.icon ? (item.icon.startsWith("<") ? item.icon : icon(item.icon)) : "") +
          '<span class="grow"><span class="ellipsis" style="display:block">' + esc(item.label) + "</span>" +
          (item.sub ? '<span class="sub">' + esc(item.sub) + "</span>" : "") + "</span>" +
          (item.checked ? '<span class="check">' + icon("check") + "</span>" : "") +
          (item.kbd ? "<kbd>" + esc(item.kbd) + "</kbd>" : "") +
          "</button>"
        );
      })
      .join("");
    const search = opts.search
      ? '<div class="menu-search"><div class="search">' + icon("search") + '<input class="input" data-menu-q placeholder="' + esc(opts.search) + '" value="' + esc(query) + '"></div></div>'
      : "";
    const listHtml = body || '<div class="menu-empty">' + esc(opts.empty || "Nothing here") + "</div>";
    if (opts.search && el.querySelector("[data-menu-q]")) {
      el.querySelector("[data-menu-list]").innerHTML = listHtml;
    } else {
      el.innerHTML = search + '<div data-menu-list>' + listHtml + "</div>";
      const q = el.querySelector("[data-menu-q]");
      if (q) {
        q.addEventListener("input", () => {
          query = q.value.trim().toLowerCase();
          active = -1;
          paint();
        });
        setTimeout(() => q.focus(), 0);
      }
    }
    return list;
  };
  paint();
  el.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-index]");
    if (!btn) return;
    const item = visible()[Number(btn.dataset.index)];
    closeMenu();
    if (item && typeof item.onSelect === "function") item.onSelect();
  });
  // position
  const rect = anchor.getBoundingClientRect();
  const mw = el.offsetWidth;
  const mh = el.offsetHeight;
  let left = opts.align === "end" ? rect.right - mw : rect.left;
  left = Math.max(8, Math.min(left, window.innerWidth - mw - 8));
  let top = opts.above ? rect.top - mh - 6 : rect.bottom + 6;
  if (!opts.above && top + mh > window.innerHeight - 8) top = Math.max(8, rect.top - mh - 6);
  if (opts.above && top < 8) top = rect.bottom + 6;
  el.style.left = left + "px";
  el.style.top = top + "px";
  const m = {
    el,
    onClose: opts.onClose,
    close: () => closeMenu(),
    outside: (event) => {
      if (!el.contains(event.target) && !anchor.contains(event.target)) closeMenu();
    },
    key: (event) => {
      const list = visible();
      const selectable = list.map((item, i) => (item && item !== "sep" && !item.heading && !item.disabled ? i : -1)).filter((i) => i >= 0);
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeMenu();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (!selectable.length) return;
        const pos = selectable.indexOf(active);
        const next = event.key === "ArrowDown" ? selectable[(pos + 1) % selectable.length] : selectable[(pos - 1 + selectable.length) % selectable.length];
        active = next;
        paint();
        const btn = el.querySelector('[data-index="' + active + '"]');
        if (btn) btn.scrollIntoView({ block: "nearest" });
      } else if (event.key === "Enter" && active >= 0) {
        event.preventDefault();
        const item = list[active];
        closeMenu();
        if (item && item.onSelect) item.onSelect();
      }
    },
  };
  openMenu = m;
  setTimeout(() => {
    document.addEventListener("pointerdown", m.outside, true);
    document.addEventListener("keydown", m.key, true);
    window.addEventListener("resize", m.close);
    window.addEventListener("blur", m.close);
  }, 0);
  return el;
}

// A free-form popover in the menu slot: opening one closes any open menu, and
// it closes the same ways a menu does (outside press, Escape, resize, blur).
// The caller paints into the returned element and calls place() after a
// repaint that changed its size. opts.isAnchor(target) says a press belongs
// to the control that opened it, for a control that is redrawn while open.
export function showPopover(anchor, opts = {}) {
  closeMenu();
  const el = document.createElement("div");
  el.className = "menu" + (opts.className ? " " + opts.className : "");
  el.setAttribute("role", "dialog");
  if (opts.label) el.setAttribute("aria-label", opts.label);
  document.getElementById("layer").appendChild(el);
  // Measured once: the anchor may be redrawn (and so detached) while open.
  const rect = anchor.getBoundingClientRect();
  const place = () => {
    const room = { below: window.innerHeight - rect.bottom - 14, above: rect.top - 14 };
    // The asked side when it fits, else the side with more room, and never
    // taller than that room: the popover scrolls inside instead.
    const want = opts.above ? "above" : "below";
    const other = opts.above ? "below" : "above";
    el.style.maxHeight = "";
    const natural = el.offsetHeight;
    const side = natural <= room[want] || room[want] >= room[other] ? want : other;
    el.style.maxHeight = Math.max(160, Math.min(natural, room[side])) + "px";
    const mw = el.offsetWidth;
    const mh = el.offsetHeight;
    let left = opts.align === "end" ? rect.right - mw : rect.left;
    left = Math.max(8, Math.min(left, window.innerWidth - mw - 8));
    el.style.left = left + "px";
    el.style.top = Math.max(8, side === "above" ? rect.top - mh - 6 : rect.bottom + 6) + "px";
  };
  const m = {
    el,
    onClose: opts.onClose,
    close: () => closeMenu(),
    outside: (event) => {
      if (el.contains(event.target) || anchor.contains(event.target)) return;
      if (opts.isAnchor && opts.isAnchor(event.target)) return;
      closeMenu();
    },
    key: (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeMenu();
      } else if (opts.onKey) opts.onKey(event);
    },
  };
  openMenu = m;
  setTimeout(() => {
    if (openMenu !== m) return;
    document.addEventListener("pointerdown", m.outside, true);
    document.addEventListener("keydown", m.key, true);
    window.addEventListener("resize", m.close);
    window.addEventListener("blur", m.close);
  }, 0);
  return { el, place, isOpen: () => openMenu === m, close: () => { if (openMenu === m) closeMenu(); } };
}

// ---------- dialogs ----------

let dialogStack = [];

const FOCUSABLE = 'video[controls], audio[controls], button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
let dialogSeq = 0;

// Only the top dialog takes input; the app and dialogs under it are inert.
// True while any dialog is open; page shortcuts stay off behind it.
export function modalOpen() {
  return dialogStack.length > 0;
}

function syncInert() {
  const app = document.getElementById("app");
  if (app) app.inert = dialogStack.length > 0;
  dialogStack.forEach((d, i) => (d.el.inert = i !== dialogStack.length - 1));
}

export function closeDialog() {
  const top = dialogStack.pop();
  if (!top) return;
  top.el.remove();
  document.removeEventListener("keydown", top.key, true);
  document.removeEventListener("focusin", top.focusin, true);
  syncInert();
  if (top.returnTo && top.returnTo.isConnected) top.returnTo.focus({ preventScroll: true });
  if (top.onClose) top.onClose();
}

export function openDialog({ title, body, foot, wide, className, onClose, dismissable = true }) {
  // A menu left open would sit above the scrim and stay clickable.
  closeMenu();
  const el = document.createElement("div");
  el.className = "scrim";
  el.innerHTML =
    '<div class="dialog ' + (wide ? "dialog-wide " : "") + (className || "") + '" role="dialog" aria-modal="true" tabindex="-1"' + (title ? ' aria-labelledby="dlg-title-' + ++dialogSeq + '"' : ' aria-label="Dialog"') + ">" +
    (title ? '<div class="dialog-head"><h2 id="dlg-title-' + dialogSeq + '">' + esc(title) + '</h2><button class="icon-btn" data-dialog-x aria-label="Close">' + icon("x") + "</button></div>" : "") +
    '<div class="dialog-body">' + (body || "") + "</div>" +
    (foot ? '<div class="dialog-foot">' + foot + "</div>" : "") +
    "</div>";
  document.getElementById("layer").appendChild(el);
  const dialog = el.querySelector(".dialog");
  const entry = {
    el,
    onClose,
    returnTo: document.activeElement instanceof HTMLElement ? document.activeElement : null,
    key: (event) => {
      if (dialogStack[dialogStack.length - 1] !== entry) return;
      if (event.key === "Tab") {
        // Native media controls move focus among their own buttons while
        // reporting the media element as focused; let them, and catch focus
        // that leaves the dialog in the focusin guard below instead.
        const act = document.activeElement;
        if (act && (act.tagName === "VIDEO" || act.tagName === "AUDIO") && dialog.contains(act)) return;
        // Keep keyboard focus inside the dialog.
        const items = Array.from(dialog.querySelectorAll(FOCUSABLE)).filter((n) => n.getClientRects().length);
        if (!items.length) {
          event.preventDefault();
          dialog.focus();
          return;
        }
        const first = items[0];
        const last = items[items.length - 1];
        const inside = dialog.contains(document.activeElement);
        if (event.shiftKey && (document.activeElement === first || !inside)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !inside)) {
          event.preventDefault();
          first.focus();
        }
        return;
      }
      if (event.key === "Escape" && dialogStack[dialogStack.length - 1] === entry && dismissable) {
        event.preventDefault();
        event.stopPropagation();
        closeDialog();
      }
    },
  };
  entry.focusin = (event) => {
    if (dialogStack[dialogStack.length - 1] !== entry) return;
    const t = event.target;
    if (dialog.contains(t) || (t && t.closest && t.closest(".menu"))) return;
    const first = dialog.querySelector(FOCUSABLE);
    (first || dialog).focus({ preventScroll: true });
  };
  dialogStack.push(entry);
  syncInert();
  document.addEventListener("keydown", entry.key, true);
  document.addEventListener("focusin", entry.focusin, true);
  el.addEventListener("pointerdown", (event) => {
    if (event.target === el && dismissable) closeDialog();
  });
  const x = el.querySelector("[data-dialog-x]");
  if (x) x.addEventListener("click", () => closeDialog());
  // Start on the first field in the body, else the main action, else the dialog.
  const start = dialog.querySelector(".dialog-body input, .dialog-body textarea, .dialog-body select") || dialog.querySelector(".dialog-foot .btn-primary") || dialog.querySelector(".dialog-foot [data-no]") || dialog;
  start.focus({ preventScroll: true });
  return dialog;
}

export function confirmDialog({ title, body, confirm = "Confirm", danger = false }) {
  return new Promise((resolve) => {
    let answered = false;
    const dlg = openDialog({
      title,
      body: '<p class="dialog-text">' + esc(body) + "</p>",
      foot:
        '<button class="btn btn-ghost" data-no>Cancel</button><button class="btn ' + (danger ? "btn-danger" : "btn-primary") + '" data-yes>' + esc(confirm) + "</button>",
      onClose: () => {
        if (!answered) resolve(false);
      },
    });
    dlg.querySelector("[data-no]").addEventListener("click", () => closeDialog());
    const yes = dlg.querySelector("[data-yes]");
    yes.addEventListener("click", () => {
      answered = true;
      resolve(true);
      closeDialog();
    });
    // A danger dialog starts on Cancel, so Enter or Space never deletes by accident.
    setTimeout(() => (danger ? dlg.querySelector("[data-no]") || yes : yes).focus(), 0);
  });
}

export function promptDialog({ title, label, value = "", confirm = "Save", placeholder = "" }) {
  return new Promise((resolve) => {
    let answered = false;
    const dlg = openDialog({
      title,
      body: '<div class="field">' + (label ? "<label>" + esc(label) + "</label>" : "") + '<input class="input" data-q placeholder="' + esc(placeholder) + '" value="' + esc(value) + '"></div>',
      foot: '<button class="btn btn-ghost" data-no>Cancel</button><button class="btn btn-primary" data-yes>' + esc(confirm) + "</button>",
      onClose: () => {
        if (!answered) resolve(null);
      },
    });
    const input = dlg.querySelector("[data-q]");
    const done = () => {
      answered = true;
      resolve(input.value.trim());
      closeDialog();
    };
    dlg.querySelector("[data-no]").addEventListener("click", () => closeDialog());
    dlg.querySelector("[data-yes]").addEventListener("click", done);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") done();
    });
    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  });
}

export function autosize(textarea, max = 240) {
  textarea.style.height = "auto";
  textarea.style.height = Math.min(max, textarea.scrollHeight) + "px";
}

export function debounce(fn, ms) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
