// Agent identity bits shared by Home, the chat, and the Agents page.

import { api, store, on, emit, harnessById } from "./store.js";
import { esc, icon, initials, showMenu, showPopover } from "./ui.js";

// Marks that have a color of their own. The colors are the --brand-* tokens in
// app.css; a mark that is not listed stays in the text color (OpenAI, Devin,
// Grok and the rest are one-color marks by design).
const BRANDS = [[/claude|anthropic/i, "claude"], [/gemini/i, "gemini"], [/mistral/i, "mistral"], [/qwen/i, "qwen"], [/\bmuse\b/i, "muse"], [/kiro/i, "kiro"]];

export function brandAttr(text) {
  const hit = BRANDS.find(([re]) => re.test(text));
  return hit ? ' data-brand="' + hit[1] + '"' : "";
}

// The agent's mark in a tinted square: chat rows and other places where it
// stands for the agent as a speaker.
export function agentAvatar(id, cls = "agent-avatar") {
  const h = harnessById(id);
  if (h && h.icon) return '<span class="' + cls + ' has-icon"' + brandAttr(h.id + " " + h.name) + ">" + agentIcon(h.icon) + "</span>";
  return '<span class="' + cls + '">' + esc(initials(h ? h.name : id || "AI")) + "</span>";
}

// The agent's mark with nothing behind it, for pickers. plain drops the color.
export function agentGlyph(id, size = "", plain = false) {
  const h = harnessById(id);
  const cls = "glyph" + (size ? " glyph-" + size : "") + (plain ? " is-plain" : "");
  if (h && h.icon) return '<span class="' + cls + '"' + (plain ? "" : brandAttr(h.id + " " + h.name)) + ">" + agentIcon(h.icon) + "</span>";
  return '<span class="' + cls + ' glyph-text">' + esc(initials(h ? h.name : id || "AI")) + "</span>";
}

// Who made a model, read from its name: the registry mark to show beside it.
const MAKERS = [
  [/^fusion\b|\bswe-|^adaptive\b|devin/i, "devin"],
  [/claude|opus|sonnet|haiku|fable|anthropic/i, "claude-acp"],
  [/gpt|codex|openai|\bo[134]\b/i, "codex-acp"],
  [/gemini|gemma|google/i, "gemini"],
  [/grok|xai/i, "grok-build"],
  [/kimi|moonshot/i, "kimi"],
  [/glm|zhipu/i, "glm-acp-agent"],
  [/mistral|devstral|codestral|magistral/i, "mistral-vibe"],
  [/qwen/i, "qwen-code"],
  [/\bmuse\b/i, "muse-code"],
  [/minimax/i, "minimax-code"],
];

// A model row's mark: its maker's when the name says who, else the agent's
// own, kept quiet.
function makerGlyph(model, harnessId) {
  const text = String((model && model.name) || "") + " " + String((model && model.modelId) || "");
  const hit = MAKERS.find(([re]) => re.test(text));
  const url = hit ? (store.registryIcons || {})[hit[1]] : "";
  const mark = url ? agentIcon(url) : "";
  if (!mark) return agentGlyph(harnessId, "", true);
  return '<span class="glyph"' + brandAttr(hit[1]) + ">" + mark + "</span>";
}

// Registry icons are one-color SVGs; a mask paints them in the text color so
// they read in light and dark themes.
export function agentIcon(dataUrl) {
  if (!/^data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+$/.test(String(dataUrl || ""))) return "";
  return '<i class="reg-icon" style="-webkit-mask-image:url(' + dataUrl + ');mask-image:url(' + dataUrl + ')"></i>';
}

export function agentName(id) {
  const h = harnessById(id);
  return h ? h.name : id || "Agent";
}

// Opens the agent list. Not-installed agents stay visible with how to get
// them, so the list explains itself instead of hiding choices.
export function openAgentMenu(anchor, currentId, onPick, opts = {}) {
  const installed = store.harnesses.filter((h) => h.available);
  const missing = store.harnesses.filter((h) => !h.available);
  const items = [{ heading: "Agents" }];
  for (const h of installed) {
    items.push({ label: h.name, sub: h.description ? String(h.description).slice(0, 70) : "Ready", icon: agentAvatar(h.id), checked: h.id === currentId, onSelect: () => onPick(h.id) });
  }
  if (!installed.length) items.push({ label: "No agents installed yet", disabled: true });
  if (missing.length) {
    items.push("sep", { heading: "Not installed" });
    for (const h of missing.slice(0, 6)) items.push({ label: h.name, sub: "Set up on the Agents page", icon: agentAvatar(h.id), onSelect: () => emit("navigate", { page: "agents" }) });
  }
  items.push("sep", { label: "Add or manage agents", icon: "bot", onSelect: () => emit("navigate", { page: "agents" }) });
  showMenu(anchor, items, Object.assign({ width: 260 }, opts));
}

export function agentPickerButton(id, attrs = "") {
  return (
    '<button type="button" class="picker" ' + attrs + ' title="Choose agent">' + agentAvatar(id, "agent-avatar") +
    '<span class="ellipsis">' + esc(id ? agentName(id) : "Choose agent") + "</span>" + icon("chevDown", "i-sm chev") + "</button>"
  );
}

// ---------- models ----------
// The model list comes from the agent itself (acp-models runs initialize and
// session/new, or returns what the last live session reported). Each agent
// loads once per window; a "models" event repaints the pickers when it lands.

const modelState = new Map();

export function modelsState(harnessId) {
  return modelState.get(harnessId) || { loading: false, error: "", models: null };
}

export function loadModels(harnessId, opts = {}) {
  const h = harnessById(harnessId);
  if (!harnessId || !h || !h.available) return Promise.resolve(null);
  const cur = modelState.get(harnessId);
  if (cur && cur.loading) return cur.promise;
  if (cur && cur.models && !opts.refresh) return Promise.resolve(cur.models);
  const next = { loading: true, error: "", models: cur ? cur.models : null };
  next.promise = api.acpModels({ harnessId, refresh: Boolean(opts.refresh) }).then(
    (result) => {
      const models = result && Array.isArray(result.availableModels) ? { availableModels: result.availableModels, currentModelId: result.currentModelId || "", effort: result.effort || null } : null;
      modelState.set(harnessId, { loading: false, error: models && models.availableModels.length ? "" : "This agent does not offer a model choice.", models });
      emit("models", { harnessId });
      // A cached list paints at once; a fresh read from the agent follows so
      // new models show up without a restart.
      if (result && result.source === "cache" && !opts.refresh) setTimeout(() => void loadModels(harnessId, { refresh: true, quiet: true }), 0);
      return models;
    },
    (error) => {
      const prev = modelState.get(harnessId);
      modelState.set(harnessId, { loading: false, error: String((error && error.message) || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""), models: prev && prev.models });
      emit("models", { harnessId });
      return prev && prev.models;
    },
  );
  modelState.set(harnessId, next);
  if (!opts.quiet) emit("models", { harnessId });
  return next.promise;
}

// Live session models win; otherwise the loaded list for the agent.
export function modelsFor(harnessId, live) {
  if (live && live.models && Array.isArray(live.models.availableModels) && live.models.availableModels.length) return live.models;
  const m = modelsState(harnessId).models;
  return m && m.availableModels.length ? m : null;
}

// "openai/GPT-4o (2024-08-06)" -> provider "openai", name "GPT-4o (2024-08-06)".
function splitModel(m) {
  const raw = String((m && (m.name || m.modelId)) || "");
  const id = String((m && m.modelId) || raw);
  const cut = raw.indexOf("/");
  const idCut = id.indexOf("/");
  return { provider: cut > 0 ? raw.slice(0, cut) : idCut > 0 ? id.slice(0, idCut) : "", name: cut > 0 ? raw.slice(cut + 1) : raw };
}
// Models that cannot drive a video edit (pictures, speech, embeddings).
const NOT_FOR_EDITING = /\b(image|audio|tts|whisper|embed(ding)?s?|dall-?e|realtime|transcribe|speech|moderation|imagen|veo|sora)\b/i;

// The agent's own "Default" entry is the same choice as picking nothing, so
// the list shows it once.
function ownDefault(models) {
  return (models && models.availableModels.find((m) => /^default$/i.test(String(m.modelId)) || /^default\b/i.test(String(m.name || "")))) || null;
}

function isDefaultPick(models, modelId) {
  const own = ownDefault(models);
  return !modelId || Boolean(own && own.modelId === modelId);
}

// What the button and the menus call the picked model. No pick is "Default":
// the agent's own default can change between visits, so no moving name.
function modelLabel(models, modelId) {
  if (isDefaultPick(models, modelId)) return "Default";
  const model = models ? models.availableModels.find((m) => m.modelId === modelId) : null;
  return splitModel(model || { modelId }).name;
}

// The model the agent uses when nothing is picked, when it says so.
function defaultNow(models) {
  const own = ownDefault(models);
  if (own && own.description) return String(own.description).slice(0, 60);
  const cur = models.availableModels.find((m) => m.modelId === models.currentModelId);
  return cur && cur !== own ? splitModel(cur).name : "";
}

// "Opus 5.5" -> family "opus", version [5, 5]. "GPT-6.2 Astra" -> "gpt- astra", [6, 2].
function familyOf(name) {
  const s = String(name || "");
  const m = s.match(/\d+(?:\.\d+)*/);
  if (!m) return { family: s.toLowerCase().trim(), version: null };
  return { family: (s.slice(0, m.index) + " " + s.slice(m.index + m[0].length)).toLowerCase().replace(/\s+/g, " ").trim(), version: m[0].split(".").map(Number) };
}

function newerThan(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

// The list as short sections: providers when the agent names them, else the
// newest version of each family first, with older versions and bundles like
// "Fusion (...)" folded away until asked for.
function shapeModels(models, modelId) {
  const own = ownDefault(models);
  const usable = models.availableModels.filter((m) => m !== own && (!NOT_FOR_EDITING.test((m.name || "") + " " + m.modelId) || m.modelId === modelId));
  const hidden = models.availableModels.length - usable.length - (own ? 1 : 0);
  const sections = [];
  const byProvider = new Map();
  for (const m of usable) {
    const p = splitModel(m).provider;
    if (!byProvider.has(p)) byProvider.set(p, []);
    byProvider.get(p).push(m);
  }
  if (byProvider.size > 1 || (byProvider.size === 1 && !byProvider.has(""))) {
    for (const [provider, list] of byProvider) sections.push({ key: "p:" + provider, title: provider || "Other", models: list, fold: false });
    return { usable, hidden, sections };
  }
  // Bundles: three or more names that open with the same word and a bracket.
  const prefix = (m) => {
    const x = String(m.name || "").match(/^([A-Za-z][\w-]*) \(/);
    return x ? x[1] : "";
  };
  const prefixCount = new Map();
  for (const m of usable) {
    const p = prefix(m);
    if (p) prefixCount.set(p, (prefixCount.get(p) || 0) + 1);
  }
  const bundled = (m) => {
    const p = prefix(m);
    return p && prefixCount.get(p) >= 3 ? p : "";
  };
  const plain = usable.filter((m) => !bundled(m));
  const newest = new Map();
  for (const m of plain) {
    const f = familyOf(splitModel(m).name);
    if (!f.version) continue;
    const best = newest.get(f.family);
    if (!best || newerThan(f.version, best.version)) newest.set(f.family, { version: f.version, model: m });
  }
  const isOlder = (m) => {
    const f = familyOf(splitModel(m).name);
    return Boolean(f.version && newest.get(f.family) && newest.get(f.family).model !== m);
  };
  const latest = plain.filter((m) => !isOlder(m));
  const older = plain.filter(isOlder);
  if (latest.length) sections.push({ key: "latest", title: older.length ? "Latest" : "Models", models: latest, fold: false });
  if (older.length) sections.push({ key: "older", title: "Older versions", models: older, fold: true });
  for (const [p, n] of prefixCount) if (n >= 3) sections.push({ key: "b:" + p, title: p, models: usable.filter((m) => bundled(m) === p), fold: true });
  return { usable, hidden, sections };
}

// ---------- agent and model: one picker ----------

// The button reads agent, then model. Where the row is narrow the agent name
// goes first: its mark still says which agent.
export function agentModelPickerButton(harnessId, modelId, live, attrs = "data-agent") {
  const h = harnessById(harnessId);
  const models = modelsFor(harnessId, live);
  const state = modelsState(harnessId);
  if (!h) {
    return '<button type="button" class="picker picker-am" ' + attrs + ' data-models="none" title="Choose agent" aria-label="Choose agent" aria-haspopup="dialog">' + agentGlyph(harnessId) +
      '<span class="pk-agent">Choose agent</span>' + icon("chevDown", "i-sm chev") + "</button>";
  }
  const label = modelLabel(models, modelId);
  const now = models && label === "Default" ? defaultNow(models) : "";
  const tip = "Agent: " + h.name + ". Model: " + (label === "Default" ? "the agent's default" + (now ? " (now " + now + ")" : "") : label);
  return (
    '<button type="button" class="picker picker-am" ' + attrs + ' data-models="' + (models ? "ready" : state.loading ? "loading" : "none") + '" title="' + esc(tip) + '" aria-label="' + esc(tip) + '" aria-haspopup="dialog">' +
    agentGlyph(harnessId) + '<span class="pk-agent">' + esc(h.name) + '</span><span class="pk-model">' + esc(label) + "</span>" + icon("chevDown", "i-sm chev") + "</button>"
  );
}

let amPopover = null;

// A small popover: a rail of agent marks and the picked agent's models, names
// only. Its size is fixed, so switching agents never moves it under the
// pointer. Picking an agent keeps it open on that agent's models; picking a
// model closes it, as does an outside press, Escape or the button.
// live is the session whose model list wins, or a function that returns it
// (the chat's session changes with the agent).
export function openAgentModelMenu(anchor, harnessId, modelId, live, handlers, opts = {}) {
  if (amPopover && amPopover.isOpen()) {
    amPopover.close();
    return;
  }
  const onAgent = (handlers && handlers.onAgent) || (() => {});
  const onModel = (handlers && handlers.onModel) || (() => {});
  const st = { agentId: harnessId, pick: modelId || "", query: "", more: false, active: -1 };
  const liveNow = () => (typeof live === "function" ? live() : st.agentId === harnessId ? live : null);
  let rows = [];
  const offs = [];
  const pop = showPopover(anchor, {
    className: "mp",
    label: "Agent and model",
    above: opts.above,
    align: opts.align,
    isAnchor: (target) => Boolean(target && target.closest && target.closest(".picker-am")),
    onClose: () => {
      offs.forEach((off) => off());
      if (amPopover === pop) amPopover = null;
    },
    onKey: (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (!rows.length) return;
        const step = event.key === "ArrowDown" ? 1 : -1;
        st.active = st.active < 0 ? (step > 0 ? 0 : rows.length - 1) : (st.active + step + rows.length) % rows.length;
        paintModels();
        const btn = pop.el.querySelector('[data-mp-row="' + st.active + '"]');
        if (btn) btn.scrollIntoView({ block: "nearest" });
      } else if (event.key === "Enter" && st.active >= 0 && rows[st.active]) {
        event.preventDefault();
        act(rows[st.active]);
      }
    },
  });
  amPopover = pop;
  pop.el.innerHTML =
    '<div class="mp-rail" data-mp-agents role="toolbar" aria-label="Agents" aria-orientation="vertical"></div>' +
    '<div class="mp-models"><div class="mp-search">' + icon("search", "i-sm") + '<input data-mp-q placeholder="Search models" aria-label="Search models" spellcheck="false" autocomplete="off"></div>' +
    '<div class="mp-list" data-mp-list></div></div>';
  const agentsEl = pop.el.querySelector("[data-mp-agents]");
  const listEl = pop.el.querySelector("[data-mp-list]");
  const q = pop.el.querySelector("[data-mp-q]");

  const paintAgents = () => {
    const installed = store.harnesses.filter((h) => h.available);
    const missing = store.harnesses.filter((h) => !h.available);
    let html = '<div class="mp-rail-scroll">';
    for (const h of installed) {
      const cur = h.id === st.agentId;
      html += '<button type="button" class="mp-rail-btn' + (cur ? " is-on" : "") + '" data-mp-agent="' + esc(h.id) + '" aria-pressed="' + cur + '" aria-label="' + esc(h.name) + '" title="' + esc(h.name) + '">' + agentGlyph(h.id, "lg") + "</button>";
    }
    for (const h of missing.slice(0, 6)) {
      html += '<button type="button" class="mp-rail-btn is-missing" data-mp-setup aria-label="' + esc(h.name + ", not installed") + '" title="' + esc(h.name + ": not installed. Set it up on the Agents page.") + '">' + agentGlyph(h.id, "lg") + "</button>";
    }
    html += '</div><button type="button" class="mp-rail-btn mp-rail-add" data-mp-setup aria-label="Add or manage agents" title="Add or manage agents">' + icon("plus") + "</button>";
    agentsEl.innerHTML = html;
    const h = harnessById(st.agentId);
    q.placeholder = h ? "Search " + h.name + " models" : "Search models";
  };

  // A row is the model's mark and its name. What the agent says about a model
  // stays in the tooltip.
  const modelRow = (r, i) =>
    '<button type="button" class="menu-item mp-row' + (i === st.active ? " is-active" : "") + '" data-mp-row="' + i + '" title="' + esc(r.tip || r.label) + '">' +
    r.glyph + '<span class="mp-name">' + esc(r.label) + "</span>" + (r.checked ? '<span class="check">' + icon("check", "i-sm") + "</span>" : "") + "</button>";

  const paintModels = () => {
    const h = harnessById(st.agentId);
    const models = h && h.available ? modelsFor(st.agentId, liveNow()) : null;
    const state = modelsState(st.agentId);
    const keep = listEl.scrollTop;
    rows = [];
    let html = "";
    const push = (r) => {
      rows.push(r);
      return rows.length - 1;
    };
    if (!h || !h.available) {
      html = '<div class="mp-note">Pick an agent</div>';
    } else if (!models) {
      if (state.loading) html = '<div class="mp-note">' + icon("loader", "i-sm spin") + "<span>Loading models</span></div>";
      else {
        const i = push({ kind: "retry" });
        html = '<div class="mp-note"><span>' + esc(state.error || "No models reported") + "</span></div>" +
          '<button type="button" class="menu-item mp-row' + (i === st.active ? " is-active" : "") + '" data-mp-row="' + i + '">' + icon("refresh", "i-sm") + '<span class="mp-name">Try again</span></button>';
      }
    } else {
      const shaped = shapeModels(models, st.pick);
      const now = defaultNow(models);
      const def = { kind: "model", id: "", label: "Default", tip: now ? "Default: now " + now : "Default: the agent picks", find: "default " + now, glyph: agentGlyph(st.agentId), checked: isDefaultPick(models, st.pick) };
      const toRow = (m) => {
        const name = splitModel(m).name;
        return { kind: "model", id: m.modelId, label: name, tip: m.description ? name + ": " + String(m.description).slice(0, 120) : name, find: name + " " + m.modelId, glyph: makerGlyph(m, st.agentId), checked: m.modelId === st.pick };
      };
      const rowsOf = (list) => list.map((m) => {
        const r = toRow(m);
        return modelRow(r, push(r));
      }).join("");
      if (st.query) {
        const found = [def].concat(shaped.usable.map(toRow)).filter((r) => r.find.toLowerCase().includes(st.query));
        html = found.length ? found.map((r) => modelRow(r, push(r))).join("") : '<div class="mp-note">No models found</div>';
      } else {
        const shown = shaped.sections.filter((sec) => !sec.fold);
        const folded = shaped.sections.filter((sec) => sec.fold);
        const open = st.more || folded.some((sec) => sec.models.some((m) => m.modelId === st.pick));
        html = modelRow(def, push(def));
        for (const sec of shown) {
          if (shown.length > 1) html += '<div class="menu-label">' + esc(sec.title) + "</div>";
          html += rowsOf(sec.models);
        }
        if (open) for (const sec of folded) html += '<div class="menu-label">' + esc(sec.title) + "</div>" + rowsOf(sec.models);
        // The toggle trails the list, so opening it shows the older models above it.
        if (folded.length) {
          const i = push({ kind: "more", open });
          html += '<button type="button" class="menu-item mp-row mp-more' + (i === st.active ? " is-active" : "") + '" data-mp-row="' + i + '" aria-expanded="' + open + '">' +
            '<span class="mp-name">' + (open ? "Show less" : "Show more") + "</span></button>";
        }
      }
    }
    listEl.innerHTML = html;
    listEl.scrollTop = keep;
  };

  const act = (r) => {
    if (r.kind === "retry") void loadModels(st.agentId, { refresh: true });
    else if (r.kind === "more") {
      st.more = !r.open;
      st.active = -1;
      paintModels();
    } else {
      pop.close();
      onModel(r.id);
    }
  };

  pop.el.addEventListener("click", (event) => {
    const agent = event.target.closest("[data-mp-agent]");
    if (agent) {
      const id = agent.dataset.mpAgent;
      if (id !== st.agentId) {
        st.agentId = id;
        st.pick = "";
        st.query = "";
        st.active = -1;
        st.more = false;
        q.value = "";
        listEl.scrollTop = 0;
        onAgent(id);
        void loadModels(id);
        paintAgents();
        paintModels();
      }
      q.focus();
      return;
    }
    if (event.target.closest("[data-mp-setup]")) {
      pop.close();
      emit("navigate", { page: "agents" });
      return;
    }
    const row = event.target.closest("[data-mp-row]");
    if (row && rows[Number(row.dataset.mpRow)]) act(rows[Number(row.dataset.mpRow)]);
  });
  q.addEventListener("input", () => {
    st.query = q.value.trim().toLowerCase();
    st.active = st.query ? 0 : -1;
    listEl.scrollTop = 0;
    paintModels();
  });
  offs.push(
    on("models", ({ harnessId: id }) => {
      if (id === st.agentId && pop.isOpen()) paintModels();
    }),
    on("harnesses", () => {
      if (pop.isOpen()) paintAgents();
    }),
  );
  paintAgents();
  paintModels();
  pop.place();
  if (st.agentId) void loadModels(st.agentId);
  setTimeout(() => {
    if (pop.isOpen()) q.focus();
  }, 0);
}

// ---------- effort: its own small picker ----------
// Some agents report a thinking-effort select option (Claude Code calls it
// "thought_level"). It rides along with the model list; an agent without one
// gets no effort button.

export function effortsFor(harnessId, live) {
  if (live && live.effort && Array.isArray(live.effort.options) && live.effort.options.length) return live.effort;
  const m = modelsState(harnessId).models;
  return m && m.effort && Array.isArray(m.effort.options) && m.effort.options.length ? m.effort : null;
}

// The effort the next send asks for: the last one picked, kept in the
// preferences so it does not fall back to Medium on every visit.
export function effortPref() {
  return String(store.prefs.effort || "medium");
}

const EFFORT_NAMES = { none: "None", minimal: "Minimal", xhigh: "Extra high" };
const isAutoEffort = (value) => /^(default|auto)$/i.test(String(value));

function effortName(o) {
  return EFFORT_NAMES[String(o.value).toLowerCase()] || o.name || o.value;
}

// The option in use: the pick when the agent offers it, else the agent's own.
function effortOption(effort, value) {
  return effort.options.find((o) => o.value === value) || effort.options.find((o) => o.value === effort.currentValue) || null;
}

// Rising bars on whole pixels, filled up to the level: the scale reads
// without the word. One bar per level the agent offers.
function effortBars(effort, value) {
  const levels = effort.options.filter((o) => !isAutoEffort(o.value));
  const count = Math.max(1, Math.min(7, levels.length));
  const at = levels.findIndex((o) => o.value === value);
  const filled = at < 0 ? 0 : Math.max(1, Math.round(((at + 1) / levels.length) * count));
  const width = 4 * count - 2;
  const top = 12;
  const step = Math.max(1, Math.round(top / 2 / Math.max(count - 1, 1)));
  let bars = "";
  for (let i = 0; i < count; i += 1) {
    const h = top - (count - 1 - i) * step;
    bars += '<rect x="' + i * 4 + '" y="' + (top - h) + '" width="2" height="' + h + '"' + (i < filled ? "" : ' opacity="0.32"') + "/>";
  }
  return '<svg class="fx-bars" width="' + width + '" height="14" viewBox="0 0 ' + width + ' 14" aria-hidden="true">' + bars + "</svg>";
}

export function effortPickerButton(harnessId, value, live, attrs = "data-effort") {
  const effort = effortsFor(harnessId, live);
  if (!effort) return "";
  const o = effortOption(effort, value);
  const name = o ? effortName(o) : "Default";
  const tip = "Effort: " + name;
  return '<button type="button" class="picker picker-fx" ' + attrs + ' title="' + esc(tip) + '" aria-label="' + esc(tip) + '" aria-haspopup="menu">' +
    effortBars(effort, o ? o.value : "") + '<span class="pk-fx-name">' + esc(name) + "</span>" + icon("chevDown", "i-sm chev") + "</button>";
}

// A plain menu of the levels: bars and a name each.
export function openEffortMenu(anchor, harnessId, value, live, onPick, opts = {}) {
  const effort = effortsFor(harnessId, live);
  if (!effort) return;
  const cur = effortOption(effort, value);
  const items = effort.options.map((o) => ({
    label: effortName(o),
    icon: effortBars(effort, o.value),
    checked: Boolean(cur && o.value === cur.value),
    onSelect: () => onPick(o.value),
  }));
  showMenu(anchor, items, Object.assign({ width: 164 }, opts));
}
