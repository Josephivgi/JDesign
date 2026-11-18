// Small UI helpers: elements, menus, dialogs, toasts, theme.
(function () {
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  function el(html) {
    const t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  let openMenu = null;
  function closeMenu() {
    if (openMenu) { openMenu.remove(); openMenu = null; }
  }

  // items: [{label, icon, hint, danger, check, desc, onClick} | "sep" | {label: "...", heading: true}]
  function showMenu(anchor, items, opts) {
    closeMenu();
    const o = opts || {};
    const menu = el('<div class="menu" role="menu"></div>');
    for (const item of items) {
      if (item === "sep") { menu.appendChild(el('<div class="sep"></div>')); continue; }
      if (item.heading) { menu.appendChild(el(`<div class="label">${esc(item.label)}</div>`)); continue; }
      const b = el(`<button type="button" role="menuitem" class="${item.danger ? "danger" : ""}${item.check ? " selected" : ""}">${item.icon ? icon(item.icon) : ""}<span class="txt">${esc(item.label)}${item.desc ? `<span class="desc">${esc(item.desc)}</span>` : ""}</span>${item.check ? `<span class="check">${icon("check")}</span>` : item.hint ? `<span class="hint">${esc(item.hint)}</span>` : ""}</button>`);
      if (item.desc) b.style.height = "auto", (b.style.padding = "6px 8px");
      b.addEventListener("click", (e) => { e.stopPropagation(); closeMenu(); item.onClick && item.onClick(); });
      menu.appendChild(b);
    }
    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    const M = 12; // keep clear of the window edges
    // Open on the side with more room; long menus scroll inside that room.
    const roomBelow = innerHeight - r.bottom - 6 - M, roomAbove = r.top - 6 - M;
    let above = o.above ? roomAbove >= Math.min(menu.offsetHeight, 240) || roomAbove > roomBelow : roomBelow < Math.min(menu.offsetHeight, 240) && roomAbove > roomBelow;
    const room = above ? roomAbove : roomBelow;
    menu.style.maxHeight = Math.max(120, Math.min(room, Math.round(innerHeight * 0.6))) + "px";
    if (o.width) menu.style.width = o.width + "px";
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    let x = o.align === "right" ? r.right - mw : r.left;
    let y = above ? r.top - mh - 6 : r.bottom + 6;
    x = Math.max(M, Math.min(innerWidth - mw - M, x));
    y = Math.max(M, Math.min(innerHeight - mh - M, y));
    menu.style.left = x + "px";
    menu.style.top = y + "px";
    openMenu = menu;
    const sel = menu.querySelector("button.selected");
    if (sel) sel.scrollIntoView({ block: "nearest" });
    const first = sel || menu.querySelector("button");
    if (first && o.focus !== false) first.focus({ preventScroll: true });
    menu.addEventListener("keydown", (e) => {
      const btns = [...menu.querySelectorAll("button")];
      const i = btns.indexOf(document.activeElement);
      if (e.key === "ArrowDown") { e.preventDefault(); btns[(i + 1) % btns.length].focus(); }
      if (e.key === "ArrowUp") { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length].focus(); }
      if (e.key === "Escape") { closeMenu(); anchor.focus && anchor.focus(); }
    });
    return menu;
  }
  document.addEventListener("pointerdown", (e) => { if (openMenu && !openMenu.contains(e.target)) closeMenu(); }, true);
  window.addEventListener("blur", closeMenu);

  // Returns a promise with the value of the pressed button (or null).
  function openDialog({ title, body, buttons, onOpen }) {
    return new Promise((resolve) => {
      const scrim = el(`<div class="scrim"><div class="dialog" role="dialog" aria-modal="true" aria-label="${esc(title)}"><h2>${esc(title)}</h2><div class="dbody"></div><div class="row"></div></div></div>`);
      const dbody = scrim.querySelector(".dbody");
      if (typeof body === "string") dbody.innerHTML = body;
      else if (body) dbody.appendChild(body);
      const row = scrim.querySelector(".row");
      const done = (v) => { scrim.remove(); document.removeEventListener("keydown", onKey, true); resolve(v); };
      for (const b of buttons || [{ label: "OK", value: true, primary: true }]) {
        const btn = el(`<button type="button" class="btn ${b.primary ? "primary" : ""} ${b.danger ? "danger" : ""}">${esc(b.label)}</button>`);
        btn.addEventListener("click", () => done(typeof b.value === "function" ? b.value(scrim) : b.value));
        row.appendChild(btn);
      }
      const onKey = (e) => {
        if (e.key === "Escape") { e.stopPropagation(); done(null); }
        if (e.key === "Enter" && e.target.tagName !== "TEXTAREA") {
          const primary = (buttons || []).find((b) => b.primary);
          if (primary) { e.preventDefault(); e.stopPropagation(); done(typeof primary.value === "function" ? primary.value(scrim) : primary.value); }
        }
      };
      document.addEventListener("keydown", onKey, true);
      scrim.addEventListener("pointerdown", (e) => { if (e.target === scrim) done(null); });
      document.body.appendChild(scrim);
      const focusEl = scrim.querySelector("input, textarea") || row.querySelector(".primary") || row.querySelector("button");
      if (focusEl) { focusEl.focus(); if (focusEl.select) focusEl.select(); }
      onOpen && onOpen(scrim);
    });
  }

  let toastBox = null;
  function toast(text, opts) {
    const o = opts || {};
    if (!toastBox) { toastBox = el('<div class="toasts" aria-live="polite"></div>'); document.body.appendChild(toastBox); }
    const t = el(`<div class="toast ${o.problem ? "problem" : ""}">${o.problem ? icon("alert") : ""}<span>${esc(text)}</span></div>`);
    if (o.action) {
      const b = el(`<button type="button">${esc(o.action.label)}</button>`);
      b.addEventListener("click", () => { t.remove(); o.action.onClick(); });
      t.appendChild(b);
    }
    toastBox.appendChild(t);
    setTimeout(() => t.remove(), o.ms || (o.action ? 6000 : 2600));
  }

  async function applyTheme(mode) {
    const m = mode || "system";
    const dark = m === "dark" || (m === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.documentElement.dataset.mode = m;
    const cs = getComputedStyle(document.documentElement);
    try { await jdraw.call("window:overlay", { color: cs.getPropertyValue("--bg").trim(), symbolColor: cs.getPropertyValue("--text").trim() }); } catch {}
  }
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applyTheme(document.documentElement.dataset.mode));

  function timeAgo(ms) {
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 60) return "just now";
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} h ago`;
    const d = Math.round(h / 24);
    if (d < 7) return `${d} d ago`;
    return new Date(ms).toLocaleDateString();
  }

  window.UI = { esc, el, showMenu, closeMenu, openDialog, toast, applyTheme, timeAgo };
})();
