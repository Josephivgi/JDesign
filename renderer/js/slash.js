// The / menu for prompt boxes. Typing "/" at the start of a message lists JV
// workflows (skills that name a command, like /improve) and the commands the
// chosen agent advertised. Arrow keys move, Enter or Tab picks, Esc closes.
// Picking a command fills "/name " and leaves the caret after it, so the user
// can add what they want before sending.

import { api, emit } from "./store.js";
import { esc, icon } from "./ui.js";

const CACHE_MS = 4000;
const cache = new Map(); // harnessId -> { at, data }

export async function fetchSlashCommands(scope) {
  const harnessId = (scope && scope.harnessId) || "";
  const hit = cache.get(harnessId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  let data = { workflows: [], agent: [] };
  try {
    data = (await api.acpSlashCommands(scope || {})) || data;
  } catch {
    /* an old main process without the handler: no commands */
  }
  data = { workflows: Array.isArray(data.workflows) ? data.workflows : [], agent: Array.isArray(data.agent) ? data.agent : [] };
  cache.set(harnessId, { at: Date.now(), data });
  return data;
}

// The workflow the text starts with, if any, from the last fetched list.
export function workflowFor(text, harnessId) {
  const m = String(text || "").match(/^\/([a-z0-9][a-z0-9-]*)(\s|$)/i);
  if (!m) return null;
  const hit = cache.get(harnessId || "") || cache.get("");
  const name = m[1].toLowerCase();
  if (!hit) return null;
  return hit.data.workflows.find((c) => c.name === name) || null;
}

// What a person sees under a command: the plain `about` line for JV
// workflows (their description is written for the agent), the agent's own
// description for its commands.
function helpText(it) {
  if (it.kind === "agent") return String(it.description || "");
  return String(it.about || it.hint || "");
}

function score(cmd, q) {
  if (!q) return 1;
  const name = cmd.name;
  if (name === q) return 100;
  if (name.startsWith(q)) return 80 - name.length / 100;
  if (name.includes(q)) return 50;
  const words = (String(cmd.label || "") + " " + String(cmd.about || "") + " " + String(cmd.description || "")).toLowerCase();
  return words.includes(q) ? 20 : 0;
}

// opts: { scope(): {harnessId,...}, agentLabel(): string, onPick(cmd), host }
// host is the element the menu is placed above (it needs position:relative).
export function attachSlashMenu(textarea, opts) {
  const host = opts.host || textarea.parentElement;
  const el = document.createElement("div");
  el.className = "slash-menu" + (opts.below ? " below" : "");
  el.setAttribute("role", "listbox");
  el.hidden = true;
  host.appendChild(el);
  let items = [];
  let active = 0;
  let open = false;
  let token = 0;
  // A draft typed before the menu button was pressed; it follows the command.
  let tail = "";

  const query = () => {
    const m = textarea.value.match(/^\/([a-z0-9-]*)$/i);
    return m ? m[1].toLowerCase() : null;
  };

  const close = (restore) => {
    if (restore === true && tail && textarea.value === "/") {
      textarea.value = tail;
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    }
    if (restore === true) tail = "";
    open = false;
    el.hidden = true;
    textarea.removeAttribute("aria-activedescendant");
  };

  const paint = () => {
    if (!items.length) {
      el.innerHTML = '<div class="slash-empty">No command starts with that. Keep typing to send it as a message.</div>';
      return;
    }
    let group = "";
    // One reason shared by several rows (no clip yet) is said once on top.
    const reasons = new Map();
    items.forEach((it) => { if (it.disabled) reasons.set(it.disabled, (reasons.get(it.disabled) || 0) + 1); });
    const shared = new Set([...reasons].filter(([, n]) => n > 1).map(([r]) => r));
    el.innerHTML = [...shared].map((r) => '<div class="slash-note">' + icon("info", "i-sm") + "<span>" + esc(r) + ". Greyed workflows need it.</span>" + (/ElevenLabs/.test(r) ? '<button type="button" class="link-btn" data-slash-setup>Set up</button>' : "") + "</div>").join("") + items
      .map((it, i) => {
        const head = it.group !== group ? '<div class="slash-group">' + esc((group = it.group)) + "</div>" : "";
        return (
          head +
          '<button type="button" role="option" class="slash-item' + (i === active ? " is-active" : "") + '" data-slash="' + i + '" id="slash-opt-' + i + '"' +
          (it.disabled ? ' aria-disabled="true" disabled' : "") + ">" +
          '<span class="slash-icon">' + icon(it.kind === "agent" ? "bot" : it.icon || "slash", "i-sm") + "</span>" +
          '<span class="slash-name">/' + esc(it.name) + "</span>" +
          '<span class="slash-text"><span class="slash-label">' + esc(it.label || "") + "</span>" +
          (it.disabled && !shared.has(it.disabled) ? '<span class="slash-desc">' + esc(it.disabled) + "</span>" : helpText(it) ? '<span class="slash-desc">' + esc(helpText(it)) + "</span>" : "") + "</span>" +
          "</button>"
        );
      })
      .join("") +
      '<div class="slash-foot"><kbd>↑</kbd><kbd>↓</kbd> move <kbd>Enter</kbd> pick <kbd>Esc</kbd> close</div>';
    const cur = el.querySelector(".slash-item.is-active");
    if (cur) {
      textarea.setAttribute("aria-activedescendant", cur.id);
      cur.scrollIntoView({ block: "nearest" });
    }
  };

  const refresh = async () => {
    const q = query();
    if (q === null) return close();
    const mine = ++token;
    const data = await fetchSlashCommands(opts.scope());
    if (mine !== token) return;
    if (query() === null) return close();
    const agentLabel = (opts.agentLabel && opts.agentLabel()) || "Agent";
    const keep = opts.filter || (() => true);
    const all = data.workflows
      .map((c) => Object.assign({ kind: "workflow" }, c, { group: c.group || "Workflows" }))
      .concat(
        opts.agentCommands === false
          ? []
          : data.agent
              .filter((a) => !data.workflows.some((w) => w.name === a.name))
              .map((a) => ({ kind: "agent", name: a.name, label: a.description ? "" : a.name, description: a.description, hint: a.hint, group: agentLabel + " commands" })),
      )
      .filter((c) => keep(c))
      // A command that cannot run here yet stays listed, greyed, with why.
      .map((c) => {
        const why = opts.disabled ? opts.disabled(c) : "";
        return why ? Object.assign({}, c, { disabled: why }) : c;
      });
    // Groups keep the order the main process sends (the order people work
    // in); inside a group the best match comes first.
    const groupAt = new Map();
    all.forEach((c, i) => { if (!groupAt.has(c.group)) groupAt.set(c.group, i); });
    const ranked = all
      .map((c, i) => ({ c, s: score(c, query()), i }))
      .filter((x) => x.s > 0)
      .sort((a, b) => groupAt.get(a.c.group) - groupAt.get(b.c.group) || b.s - a.s || a.i - b.i);
    items = ranked.map((x) => x.c);
    active = firstEnabled();
    open = true;
    el.hidden = false;
    paint();
  };

  const firstEnabled = () => {
    const i = items.findIndex((it) => !it.disabled);
    return i < 0 ? -1 : i;
  };
  const enabledCount = () => items.filter((it) => !it.disabled).length;

  const pick = (i) => {
    const it = items[i];
    if (!it || it.disabled) return;
    textarea.value = "/" + it.name + " " + tail;
    tail = "";
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    close();
    textarea.focus();
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    if (opts.onPick) opts.onPick(it);
  };

  textarea.addEventListener("input", () => void refresh());
  // Capture phase, so Enter picks a command instead of sending the message.
  textarea.addEventListener(
    "keydown",
    (event) => {
      if (!open) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (!enabledCount()) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const step = event.key === "ArrowDown" ? 1 : items.length - 1;
        let next = active < 0 ? 0 : active;
        for (let n = 0; n < items.length; n += 1) {
          next = (next + step) % items.length;
          if (!items[next].disabled) break;
        }
        active = next;
        paint();
      } else if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey && active >= 0 && enabledCount()) {
        event.preventDefault();
        event.stopImmediatePropagation();
        pick(active);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        close(true);
      }
    },
    true,
  );
  textarea.addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== textarea) close(true); }, 120));
  el.addEventListener("mousedown", (event) => event.preventDefault());
  el.addEventListener("click", (event) => {
    if (event.target.closest("[data-slash-setup]")) {
      close(true);
      emit("navigate", { page: "settings", params: { section: "voice" } });
      return;
    }
    const b = event.target.closest("[data-slash]");
    if (b) pick(Number(b.dataset.slash));
  });

  return {
    // Opens the menu from a button: starts a "/" and lists everything.
    openFromButton() {
      const cur = textarea.value;
      if (!/^\/[a-z0-9-]*$/i.test(cur)) {
        tail = cur.trim();
        textarea.value = "/";
      }
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      void refresh();
    },
    isOpen: () => open,
    close,
    destroy() {
      close();
      el.remove();
    },
  };
}

// The workflow named `name`, from the last list fetched for this agent.
export function workflowByName(name, harnessId) {
  const hit = cache.get(harnessId || "") || cache.get("");
  if (!hit) return null;
  return hit.data.workflows.find((c) => c.name === name) || null;
}

// Follow-up commands after a finished turn: the ones the last command names
// as its next steps, or, after a plain message that produced a video, the
// usual review and improve passes. Returns [{name, label}].
export function followUps(lastUserText, harnessId, hasRender, project) {
  const ran = workflowFor(lastUserText, harnessId);
  let names = ran && ran.next && ran.next.length ? ran.next : hasRender ? ["review", "improve", "short"] : [];
  // Already vertical: no point offering a vertical short.
  if (project && project.aspectRatio === "9/16") names = names.filter((n) => n !== "short");
  const out = [];
  for (const name of names) {
    if (ran && name === ran.name) continue;
    const flow = workflowByName(name, harnessId);
    if (flow) out.push({ name: flow.name, label: flow.label, icon: flow.icon, about: flow.about });
  }
  return out.slice(0, 3);
}
