const { randomUUID } = require("crypto");
const {
  defaultCard,
  loadState,
  loadWorkspace,
  saveWorkspace,
  snapshot,
} = require("./workspace-store");

const { templatePatch } = require("./card-templates");
const { normalizeMotion } = require("./html-card");

const TOP_FIELDS = [
  "name",
  "description",
  "kind",
  "placement",
  "durationMs",
  "templateId",
  "endScreen",
  "endScreenDurationMs",
  "endScreenBackgroundId",
  "endScreenFit",
  "endScreenTreatment",
  "drawing",
  "editingBlock",
  "motion",
];

const COMPOSITION_FIELDS = [
  "aspectRatio",
  "headline",
  "body",
  "eyebrow",
  "cta",
  "align",
  "surface",
  "backgroundId",
  "html",
  "css",
  "vars",
];

const COLOR_FIELDS = ["primary", "secondary", "text"];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const PLACEMENTS = ["auto", "intro", "overlay", "end"];

function mergePatchDeep(base, over) {
  const out = isPlainObject(base) ? clone(base) : {};
  if (!isPlainObject(over)) return out;
  for (const key of Object.keys(over)) {
    const value = over[key];
    if (isPlainObject(value) && isPlainObject(out[key])) out[key] = mergePatchDeep(out[key], value);
    else out[key] = value;
  }
  return out;
}

function applyCardPatch(card, patch, options) {
  const expandTemplate = Boolean(options && options.expandTemplate);
  const next = clone(card || defaultCard());
  let src = patch && typeof patch === "object" ? patch : {};
  // patch.template expands a template's defaults under the patch. The stored
  // templateId alone never expands: saved cards keep their edited design.
  // dataRoot lets templates installed or saved in the store resolve too.
  const templateName = src.template || (expandTemplate ? src.templateId : "");
  if (typeof templateName === "string" && templateName) {
    const defaults = templatePatch(templateName, options && options.dataRoot);
    if (defaults) {
      src = mergePatchDeep(defaults, src);
      src.templateId = templateName;
      delete src.template;
    }
  }

  for (const key of TOP_FIELDS) {
    if (src[key] !== undefined) next[key] = src[key];
  }
  if (src.why !== undefined && src.description === undefined) {
    next.description = src.why;
  }
  if (typeof next.name === "string") next.name = next.name.trim() || next.name;
  if (typeof next.description === "string") next.description = next.description.slice(0, 2000);
  if (!PLACEMENTS.includes(next.placement)) next.placement = "auto";
  const dur = Number(next.durationMs);
  next.durationMs = Number.isFinite(dur) ? Math.min(60000, Math.max(500, Math.round(dur))) : 3000;
  if (typeof next.templateId !== "string") next.templateId = "";

  if (!isPlainObject(next.composition)) next.composition = defaultCard().composition;
  if (!isPlainObject(next.composition.blockLayout)) next.composition.blockLayout = {};
  if (!isPlainObject(next.composition.imageLayouts)) next.composition.imageLayouts = {};
  if (!isPlainObject(next.composition.vars)) next.composition.vars = {};
  if (typeof next.composition.html !== "string") next.composition.html = "";
  if (typeof next.composition.css !== "string") next.composition.css = "";
  next.motion = normalizeMotion(next.motion);

  if (isPlainObject(src.composition)) {
    for (const key of COMPOSITION_FIELDS) {
      if (src.composition[key] !== undefined) next.composition[key] = src.composition[key];
    }
    if (isPlainObject(src.composition.blockLayout)) {
      next.composition.blockLayout = Object.assign({}, next.composition.blockLayout, src.composition.blockLayout);
    }
    if (isPlainObject(src.composition.imageLayouts)) {
      next.composition.imageLayouts = Object.assign({}, next.composition.imageLayouts, src.composition.imageLayouts);
    }
    if (src.composition.layout && isPlainObject(src.composition.layout)) {
      next.composition.blockLayout = Object.assign({}, next.composition.blockLayout, src.composition.layout);
    }
  }

  if (src.layout && isPlainObject(src.layout)) {
    next.composition.blockLayout = Object.assign({}, next.composition.blockLayout, src.layout);
  }
  if (typeof src.align === "string") next.composition.align = src.align;
  if (typeof src.aspectRatio === "string") next.composition.aspectRatio = src.aspectRatio;

  if (!isPlainObject(next.colors)) next.colors = defaultCard().colors;
  if (isPlainObject(src.colors)) {
    for (const key of COLOR_FIELDS) {
      if (typeof src.colors[key] === "string") next.colors[key] = src.colors[key];
    }
  }
  if (typeof src.primary === "string") next.colors.primary = src.primary;

  if (Array.isArray(src.imageIds)) next.imageIds = src.imageIds.slice();

  return next;
}

async function applyCardEdit(options) {
  const opts = options || {};
  const dataRoot = opts.dataRoot;
  if (!dataRoot) throw new Error("dataRoot is required");
  const patch = opts.patch && typeof opts.patch === "object" ? opts.patch : {};
  const state = await loadState(dataRoot);
  const workspaceId = opts.workspaceId || state.activeWorkspaceId;
  const ws = await loadWorkspace(dataRoot, workspaceId);
  if (!Array.isArray(ws.cards)) ws.cards = [];
  const now = new Date().toISOString();
  const cardId = opts.cardId || patch.id || "";
  let created = false;
  let card;
  if (!cardId) {
    card = Object.assign({}, defaultCard(), { id: randomUUID(), createdAt: now, updatedAt: now });
    card = applyCardPatch(card, patch, { expandTemplate: true, dataRoot });
    card.id = card.id || randomUUID();
    card.createdAt = now;
    card.updatedAt = now;
    ws.cards.unshift(card);
    created = true;
  } else {
    const index = ws.cards.findIndex((entry) => entry.id === cardId);
    if (index === -1) {
      card = applyCardPatch(
        Object.assign({}, defaultCard(), { id: cardId, createdAt: now, updatedAt: now }),
        patch,
        { dataRoot },
      );
      card.id = cardId;
      card.updatedAt = now;
      ws.cards.unshift(card);
      created = true;
    } else {
      card = applyCardPatch(ws.cards[index], patch, { expandTemplate: false, dataRoot });
      card.id = cardId;
      card.createdAt = ws.cards[index].createdAt || now;
      card.updatedAt = now;
      ws.cards[index] = card;
    }
  }
  await saveWorkspace(dataRoot, ws);
  const snap = await snapshot(dataRoot, workspaceId);
  const persisted = snap.workspace.cards.find((entry) => entry.id === card.id);
  return { snapshot: snap, card: persisted || card, created };
}

module.exports = {
  TOP_FIELDS,
  COMPOSITION_FIELDS,
  COLOR_FIELDS,
  applyCardPatch,
  applyCardEdit,
  defaultCard,
};
