// Agent identity bits shared by Home, the chat, and the Agents page.

import { api, store, emit, harnessById } from "./store.js";
import { esc, icon, initials, showMenu } from "./ui.js";

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
      const models = result && Array.isArray(result.availableModels) ? { availableModels: result.availableModels, currentModelId: result.currentModelId || "" } : null;
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

export function modelPickerButton(harnessId, modelId, live, attrs = "data-model") {
  const models = modelsFor(harnessId, live);
  const state = modelsState(harnessId);
  if (!models) {
    if (state.loading) return '<button type="button" class="picker" ' + attrs + ' disabled title="Asking the agent which models it offers">' + icon("loader", "i-sm spin") + "<span>Loading models</span></button>";
    if (state.error && harnessById(harnessId) && harnessById(harnessId).available) return '<button type="button" class="picker" ' + attrs + ' title="' + esc(state.error) + '"><span>Model unavailable</span>' + icon("chevDown", "i-sm chev") + "</button>";
    return "";
  }
  // No pick: the agent's own default. Its current model can change between
  // visits, so the button says Default instead of a name that moves.
  const model = modelId ? models.availableModels.find((m) => m.modelId === modelId) : null;
  const label = model ? splitModel(model).name : modelId ? splitModel({ modelId }).name : "Default model";
  const cur = models.availableModels.find((m) => m.modelId === models.currentModelId);
  const tip = model ? "Model: " + (model.name || model.modelId) : "Model: the agent's default" + (cur ? " (now " + splitModel(cur).name + ")" : "");
  return '<button type="button" class="picker" ' + attrs + ' title="' + esc(tip) + '"><span class="ellipsis">' + esc(label) + "</span>" + icon("chevDown", "i-sm chev") + "</button>";
}

export function openModelMenu(anchor, harnessId, modelId, live, onPick, opts = {}) {
  const models = modelsFor(harnessId, live);
  const state = modelsState(harnessId);
  if (!models) {
    showMenu(anchor, [{ heading: "Model" }, { label: state.error || "No models reported", disabled: true }, "sep", { label: "Try again", icon: "refresh", onSelect: () => void loadModels(harnessId, { refresh: true }) }], Object.assign({ width: 280 }, opts));
    return;
  }
  const cur = models.availableModels.find((m) => m.modelId === models.currentModelId);
  const usable = models.availableModels.filter((m) => !NOT_FOR_EDITING.test((m.name || "") + " " + m.modelId) || m.modelId === modelId);
  const hidden = models.availableModels.length - usable.length;
  const items = [{ label: "Default model", sub: "Recommended. The agent picks" + (cur ? ", now " + splitModel(cur).name : ""), checked: !modelId, onSelect: () => onPick("") }];
  // Grouped by provider, so a long list reads as a few short ones.
  const groups = new Map();
  for (const m of usable) {
    const p = splitModel(m).provider;
    if (!groups.has(p)) groups.set(p, []);
    groups.get(p).push(m);
  }
  for (const [provider, list] of groups) {
    items.push({ heading: provider || "Models" });
    for (const m of list) items.push({ label: splitModel(m).name, sub: m.description ? String(m.description).slice(0, 80) : "", checked: m.modelId === modelId, onSelect: () => onPick(m.modelId) });
  }
  if (hidden) items.push("sep", { label: hidden + " image, audio and speech models hidden", disabled: true });
  showMenu(anchor, items, Object.assign({ width: 300, search: usable.length > 8 ? "Search models" : "" }, opts));
}
