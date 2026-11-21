// Agent identity bits shared by Home, the chat, and the Agents page.

import { api, store, on, emit, harnessById } from "./store.js";
import { esc, icon, initials, showMenu, showPopover } from "./ui.js";

export function agentAvatar(id, cls = "agent-avatar") {
  const h = harnessById(id);
  if (h && h.icon) return '<span class="' + cls + ' has-icon">' + agentIcon(h.icon) + "</span>";
  return '<span class="' + cls + '">' + esc(initials(h ? h.name : id || "AI")) + "</span>";
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

// ---------- agent and model, one picker ----------

// The button reads agent, then model: one control for the pair a send needs.
// Where the row is narrow the agent name goes first (its avatar still says
// which agent) and the model stays readable.
export function agentModelPickerButton(harnessId, modelId, live, attrs = "data-agent") {
  const h = harnessById(harnessId);
  const models = modelsFor(harnessId, live);
  const state = modelsState(harnessId);
  if (!h) {
    return '<button type="button" class="picker picker-am" ' + attrs + ' data-models="none" title="Choose agent" aria-label="Choose agent" aria-haspopup="dialog">' + agentAvatar(harnessId, "agent-avatar") +
      '<span class="pk-agent">Choose agent</span>' + icon("chevDown", "i-sm chev") + "</button>";
  }
  const label = modelLabel(models, modelId);
  const now = models && label === "Default" ? defaultNow(models) : "";
  const tip = "Agent: " + h.name + ". Model: " + (label === "Default" ? "the agent's default" + (now ? " (now " + now + ")" : "") : label);
  return (
    '<button type="button" class="picker picker-am" ' + attrs + ' data-models="' + (models ? "ready" : state.loading ? "loading" : "none") + '" title="' + esc(tip) + '" aria-label="' + esc(tip) + '" aria-haspopup="dialog">' +
    agentAvatar(harnessId, "agent-avatar") + '<span class="pk-agent">' + esc(h.name) + '</span><span class="pk-model">' + esc(label) + "</span>" + icon("chevDown", "i-sm chev") + "</button>"
  );
}

let amPopover = null;

// Agents on the left, the picked agent's models on the right. Picking an
// agent keeps the popover open and shows that agent's models; picking a
// model closes it. live is the session whose model list wins, or a function
// that returns it (the chat's session changes with the agent).
export function openAgentModelMenu(anchor, harnessId, modelId, live, handlers, opts = {}) {
  // A second press on the button closes the popover it opened.
  if (amPopover && amPopover.isOpen()) {
    amPopover.close();
    return;
  }
  const onAgent = (handlers && handlers.onAgent) || (() => {});
  const onModel = (handlers && handlers.onModel) || (() => {});
  const st = { agentId: harnessId, pick: modelId || "", query: "", open: new Set(), active: -1 };
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
    '<div class="mp-agents" data-mp-agents></div>' +
    '<div class="mp-models"><div class="menu-search" data-mp-search hidden><div class="search">' + icon("search") + '<input class="input" data-mp-q placeholder="Search models" aria-label="Search models"></div></div>' +
    '<div class="mp-list" data-mp-list></div></div>';
  const agentsEl = pop.el.querySelector("[data-mp-agents]");
  const listEl = pop.el.querySelector("[data-mp-list]");
  const searchEl = pop.el.querySelector("[data-mp-search]");
  const q = pop.el.querySelector("[data-mp-q]");

  const paintAgents = () => {
    const installed = store.harnesses.filter((h) => h.available);
    const missing = store.harnesses.filter((h) => !h.available);
    let html = '<div class="mp-scroll"><div class="menu-label">Agent</div>';
    for (const h of installed) {
      const cur = h.id === st.agentId;
      html += '<button type="button" class="menu-item' + (cur ? " is-on" : "") + '" data-mp-agent="' + esc(h.id) + '" aria-pressed="' + cur + '" title="' + esc(h.description ? String(h.description).slice(0, 120) : h.name) + '">' +
        agentAvatar(h.id) + '<span class="grow ellipsis">' + esc(h.name) + "</span>" + (cur ? '<span class="check">' + icon("check") + "</span>" : "") + "</button>";
    }
    if (!installed.length) html += '<div class="mp-note">No agents installed yet</div>';
    if (missing.length) {
      html += '<div class="menu-label">Not installed</div>';
      for (const h of missing.slice(0, 6)) html += '<button type="button" class="menu-item mp-missing" data-mp-setup title="Set up on the Agents page">' + agentAvatar(h.id) + '<span class="grow ellipsis">' + esc(h.name) + "</span></button>";
    }
    html += '</div><button type="button" class="menu-item mp-manage" data-mp-setup>' + icon("bot") + '<span class="grow ellipsis">Add or manage agents</span></button>';
    agentsEl.innerHTML = html;
  };

  const modelRow = (r, i) =>
    '<button type="button" class="menu-item' + (i === st.active ? " is-active" : "") + '" data-mp-row="' + i + '">' +
    '<span class="grow"><span class="ellipsis" style="display:block">' + esc(r.label) + "</span>" + (r.sub ? '<span class="sub ellipsis">' + esc(r.sub) + "</span>" : "") + "</span>" +
    (r.checked ? '<span class="check">' + icon("check") + "</span>" : "") + "</button>";

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
      html = '<div class="mp-note">Pick an agent to see its models.</div>';
    } else if (!models) {
      if (state.loading) html = '<div class="mp-note">' + icon("loader", "i-sm spin") + "<span>Asking " + esc(h.name) + " which models it offers</span></div>";
      else {
        const i = push({ kind: "retry" });
        html = '<div class="mp-note"><span>' + esc(state.error || "No models reported") + "</span></div>" +
          '<button type="button" class="menu-item' + (i === st.active ? " is-active" : "") + '" data-mp-row="' + i + '">' + icon("refresh") + '<span class="grow">Try again</span></button>';
      }
    } else {
      const shaped = shapeModels(models, st.pick);
      const now = defaultNow(models);
      const def = { kind: "model", id: "", label: "Default", sub: "The agent picks" + (now ? ". Now " + now : ""), checked: isDefaultPick(models, st.pick) };
      const toRow = (m) => ({ kind: "model", id: m.modelId, label: splitModel(m).name, sub: m.description ? String(m.description).slice(0, 90) : "", checked: m.modelId === st.pick });
      searchEl.hidden = shaped.usable.length <= 8;
      if (st.query) {
        const hit = (r) => (r.label + " " + r.sub + " " + r.id).toLowerCase().includes(st.query);
        const found = [def].concat(shaped.usable.map(toRow)).filter(hit);
        html = found.length ? found.map((r) => modelRow(r, push(r))).join("") : '<div class="menu-empty">No model matches</div>';
      } else {
        html = '<div class="menu-label">' + esc(h.name) + " model</div>" + modelRow(def, push(def));
        for (const sec of shaped.sections) {
          const open = !sec.fold || st.open.has(sec.key) || sec.models.some((m) => m.modelId === st.pick);
          if (sec.fold) {
            const i = push({ kind: "group", key: sec.key, open });
            html += '<button type="button" class="menu-item mp-group' + (i === st.active ? " is-active" : "") + '" data-mp-row="' + i + '" aria-expanded="' + open + '">' +
              icon(open ? "chevDown" : "chevRight", "i-sm") + '<span class="grow">' + esc(sec.title) + '</span><span class="mp-count">' + sec.models.length + "</span></button>";
          } else if (shaped.sections.length > 1) html += '<div class="menu-label">' + esc(sec.title) + "</div>";
          if (open) {
            html += sec.models.map((m) => {
              const r = toRow(m);
              return modelRow(r, push(r));
            }).join("");
          }
        }
        if (shaped.hidden > 0) html += '<div class="mp-foot">' + shaped.hidden + " image, audio and speech models hidden</div>";
      }
    }
    if (!models) searchEl.hidden = true;
    listEl.innerHTML = html;
    listEl.scrollTop = keep;
    pop.place();
  };

  const act = (r) => {
    if (r.kind === "retry") void loadModels(st.agentId, { refresh: true });
    else if (r.kind === "group") {
      if (r.open) st.open.delete(r.key);
      else st.open.add(r.key);
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
      if (id === st.agentId) return;
      st.agentId = id;
      st.pick = "";
      st.query = "";
      st.active = -1;
      st.open.clear();
      q.value = "";
      onAgent(id);
      void loadModels(id);
      paintAgents();
      paintModels();
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
    st.active = -1;
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
  if (st.agentId) void loadModels(st.agentId);
  setTimeout(() => {
    if (pop.isOpen() && !searchEl.hidden) q.focus();
  }, 0);
}

// ---------- effort ----------
// Some agents report a thinking-effort select option (Claude Code calls it
// "thought_level"). It rides along with the model list; an agent without one
// shows no button at all.

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
const EFFORT_HELP = {
  default: "The model's own setting",
  auto: "The model decides each time",
  none: "No thinking first",
  minimal: "Almost no thinking",
  low: "Fastest, least careful",
  medium: "Balanced speed and care",
  high: "More careful, slower",
  xhigh: "Very careful, slower still",
  max: "Most careful, slowest",
};
const isAutoEffort = (value) => /^(default|auto)$/i.test(String(value));

function effortName(o) {
  return EFFORT_NAMES[String(o.value).toLowerCase()] || o.name || o.value;
}

// The option in use: the pick when the agent offers it, else the agent's own.
function effortOption(effort, value) {
  return effort.options.find((o) => o.value === value) || effort.options.find((o) => o.value === effort.currentValue) || null;
}

// Rising bars, filled up to the level: the scale reads without the word.
function effortBars(effort, value) {
  const levels = effort.options.filter((o) => !isAutoEffort(o.value));
  const of = Math.max(1, Math.min(6, levels.length));
  const at = levels.findIndex((o) => o.value === value);
  const step = at < 0 ? 0 : Math.max(1, Math.round(((at + 1) / levels.length) * of));
  const gap = of > 4 ? 1.2 : 1.6;
  const w = (14 - gap * (of - 1)) / of;
  let bars = "";
  for (let i = 0; i < of; i += 1) {
    const hgt = of === 1 ? 12 : 4 + (8 * i) / (of - 1);
    bars += '<rect x="' + (1 + i * (w + gap)).toFixed(2) + '" y="' + (14 - hgt).toFixed(2) + '" width="' + w.toFixed(2) + '" height="' + hgt.toFixed(2) + '" rx="0.7"' + (i < step ? "" : ' opacity="0.28"') + "/>";
  }
  return '<svg class="fx-bars" viewBox="0 0 16 16" aria-hidden="true">' + bars + "</svg>";
}

export function effortPickerButton(harnessId, value, live, attrs = "data-effort") {
  const effort = effortsFor(harnessId, live);
  if (!effort) return "";
  const o = effortOption(effort, value);
  const name = o ? effortName(o) : "Default";
  const tip = "Thinking effort: " + name + ". How hard the model thinks before it answers.";
  return '<button type="button" class="picker picker-fx" ' + attrs + ' title="' + esc(tip) + '" aria-label="' + esc(tip) + '" aria-haspopup="menu">' +
    effortBars(effort, o ? o.value : "") + '<span class="pk-fx-name">' + esc(name) + "</span>" + icon("chevDown", "i-sm chev") + "</button>";
}

export function openEffortMenu(anchor, harnessId, value, live, onPick, opts = {}) {
  const effort = effortsFor(harnessId, live);
  if (!effort) return;
  const cur = effortOption(effort, value);
  const items = [{ heading: "Thinking effort" }];
  for (const o of effort.options) {
    items.push({
      label: effortName(o),
      sub: o.description ? String(o.description).slice(0, 80) : EFFORT_HELP[String(o.value).toLowerCase()] || "",
      icon: effortBars(effort, o.value),
      checked: Boolean(cur && o.value === cur.value),
      onSelect: () => onPick(o.value),
    });
  }
  showMenu(anchor, items, Object.assign({ width: 250 }, opts));
}
