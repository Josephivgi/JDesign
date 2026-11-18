"use strict";

// A project made from a gallery design remembers it in state.design
// ({ preset, params, colors, aspectRatio, assetId }), so the editor can reopen
// the form and the agent knows what to change. A new render of the same design
// takes the old clip's place: the old one leaves the project (it stays in the
// library) and its render link goes with it, so the project keeps one version.

const projects = require("./ai-projects");

const RATIOS = new Set(["16/9", "9/16", "1/1", "4/5"]);
// Render settings beyond the preset that a design keeps between edits.
const EXTRA_KEYS = ["durationMs", "fps", "audioId", "audioVolume", "audioLoop", "audioIds", "audios"];

// True when a clip has timeline edits, captions, or overlays the project
// render bakes in (untagged legacy rows belong to the selected clip), so the
// bare clip is not the finished video.
function clipHasEdits(project, clipId) {
  const st = (project && project.state) || {};
  if (st.videoEdits && st.videoEdits[clipId] && Object.keys(st.videoEdits[clipId]).length) return true;
  const studio = st.studio || {};
  const own = (row) => row && typeof row === "object" && (row.videoId ? row.videoId === clipId : !st.selectedAssetId || st.selectedAssetId === clipId);
  return [studio.texts, studio.overlays].some((rows) => Array.isArray(rows) && rows.some(own));
}

// Moves a clip's edits and tagged captions to the clip that replaces it.
function carryEdits(state, oldId, newId) {
  if (!oldId || !newId || oldId === newId) return;
  if (state.videoEdits && state.videoEdits[oldId]) {
    state.videoEdits = Object.assign({}, state.videoEdits);
    state.videoEdits[newId] = Object.assign({}, state.videoEdits[newId], state.videoEdits[oldId]);
    delete state.videoEdits[oldId];
  }
  if (state.studio && typeof state.studio === "object") {
    const retag = (rows) => (Array.isArray(rows) ? rows.map((row) => (row && row.videoId === oldId ? Object.assign({}, row, { videoId: newId }) : row)) : rows);
    const studio = Object.assign({}, state.studio);
    if (Array.isArray(studio.texts)) studio.texts = retag(studio.texts);
    if (Array.isArray(studio.overlays)) studio.overlays = retag(studio.overlays);
    state.studio = studio;
  }
}

// Puts newId in oldId's place in a project: the old clip leaves the project
// (it stays in the library), every render made from it leaves the project's
// list, and the new clip is selected. opts.moveEdits carries the old clip's
// timeline edits (cuts, framing, text, sound) over to the new one, for a fixed
// version of the same clip. Returns the updated project.
async function swapClip(dataRoot, projectId, oldId, newId, extraState, opts) {
  const before = projects.getProject(dataRoot, projectId);
  if (!before) return null;
  const oldRow = (before.assets || []).find((a) => a.id === oldId);
  if (oldId && oldId !== newId) {
    try {
      projects.removeAsset(dataRoot, projectId, oldId);
    } catch {
      /* already gone */
    }
    if (oldRow && newId) projects.setAssetPosition(dataRoot, projectId, newId, oldRow.position);
  }
  const fresh = projects.getProject(dataRoot, projectId);
  const state = Object.assign({}, (fresh && fresh.state) || {}, extraState || {});
  let oldRender = "";
  if (oldId && oldId !== newId && state.renders && state.renders[oldId]) {
    oldRender = String(state.renders[oldId]);
    state.renders = Object.assign({}, state.renders);
    delete state.renders[oldId];
  }
  if (newId) state.selectedAssetId = newId;
  if (oldId && newId && oldId !== newId && !(opts && opts.noHistory)) {
    state.previousVersion = { clipId: oldId, newId, at: new Date().toISOString() };
    if (state.design && state.design.assetId === oldId) state.previousVersion.design = state.design;
  }
  if (opts && opts.moveEdits) carryEdits(state, oldId, newId);
  else if (oldId && oldId !== newId && state.videoEdits && state.videoEdits[oldId]) {
    state.videoEdits = Object.assign({}, state.videoEdits);
    delete state.videoEdits[oldId];
  }
  // Code that replaced a gallery design's clip is no longer that design.
  if (!(extraState && extraState.design) && state.design && state.design.assetId === oldId) delete state.design;
  const updated = projects.updateProject(dataRoot, projectId, { state });
  const keep = Object.values(state.renders || {}).map(String);
  const io = require("./finished-io");
  try {
    if (oldId && oldId !== newId) await io.unlinkProjectSource(dataRoot, projectId, oldId, fresh && fresh.workspaceId);
    if (oldRender && !keep.includes(oldRender)) await io.removeFinishedProject(dataRoot, oldRender, projectId, fresh && fresh.workspaceId);
  } catch {
    /* the render links are best effort */
  }
  return updated;
}

async function adoptDesign(dataRoot, projectId, design) {
  const before = projects.getProject(dataRoot, projectId);
  if (!before) return null;
  const oldId = before.state && before.state.design && before.state.design.assetId;
  const newId = design.assetId;
  const oldRow = (before.assets || []).find((a) => a.id === oldId);
  if (oldId && oldId !== newId) {
    try {
      projects.removeAsset(dataRoot, projectId, oldId);
    } catch {
      /* already gone */
    }
    if (oldRow && newId) projects.setAssetPosition(dataRoot, projectId, newId, oldRow.position);
  }
  const fresh = projects.getProject(dataRoot, projectId);
  const state = Object.assign({}, (fresh && fresh.state) || {});
  let oldRender = "";
  if (oldId && oldId !== newId && state.renders && state.renders[oldId]) {
    oldRender = String(state.renders[oldId]);
    state.renders = Object.assign({}, state.renders);
    delete state.renders[oldId];
  }
  // A new version of the design keeps the cuts, framing, and captions made
  // on the old one.
  carryEdits(state, oldId, newId);
  if (oldId && oldId !== newId) {
    state.previousVersion = { clipId: oldId, newId, at: new Date().toISOString() };
    if (before.state && before.state.design) state.previousVersion.design = before.state.design;
  }
  state.selectedAssetId = newId;
  state.design = {
    preset: design.preset,
    params: design.params || {},
    colors: design.colors || {},
    aspectRatio: RATIOS.has(design.aspectRatio) ? design.aspectRatio : "16/9",
    // Extra code an agent added on top of the preset, so "Update video"
    // keeps it instead of dropping back to the plain design.
    css: typeof design.css === "string" ? design.css : "",
    js: typeof design.js === "string" ? design.js : "",
    extras: pickExtras(design.extras),
    assetId: newId,
  };
  const patch = { state };
  // A project the gallery named after the design's first words follows them,
  // so fixing a typo in the headline fixes the project name (and the names
  // of later renders) too. A name the person chose is left alone.
  const oldName = firstWords(before.state && before.state.design && before.state.design.params);
  const newName = firstWords(design.params);
  if (oldName && newName && oldName !== newName && before.name === oldName) patch.name = newName;
  const updated = projects.updateProject(dataRoot, projectId, patch);
  // The replaced clip's finished video leaves the project's list too, so
  // Finished videos does not fill with old versions of one design.
  const keep = Object.values(state.renders || {}).map(String);
  const io = require("./finished-io");
  try {
    if (oldId && oldId !== newId) await io.unlinkProjectSource(dataRoot, projectId, oldId, fresh && fresh.workspaceId);
    // Renders from before source tracking: the one the old clip pointed at.
    if (oldRender && !keep.includes(oldRender)) await io.removeFinishedProject(dataRoot, oldRender, projectId, fresh && fresh.workspaceId);
  } catch {
    /* the render links are best effort */
  }
  return updated;
}

// The name the gallery gives a project: its first text param, cut to 48.
function firstWords(params) {
  const first = Object.values(params || {}).find((v) => typeof v === "string" && v.trim());
  return first ? first.slice(0, 48) : "";
}

function pickExtras(input) {
  const out = {};
  for (const key of EXTRA_KEYS) if (input && input[key] != null) out[key] = input[key];
  return out;
}

// The design a project shows, when its clip is still in the project.
function liveDesign(project) {
  const design = project && project.state && project.state.design;
  if (!design || !design.preset) return null;
  return (project.assets || []).some((a) => a.id === design.assetId) ? design : null;
}

// The clip the last fix or design edit replaced, when it can come back: the
// new clip is still in the project and the old one is still in the library.
async function previousVersion(dataRoot, project) {
  const prev = project && project.state && project.state.previousVersion;
  if (!prev || !prev.clipId || !prev.newId) return null;
  if (!(project.assets || []).some((a) => a.id === prev.newId)) return null;
  const { getLibraryItem } = require("./library-io");
  const item = await getLibraryItem(dataRoot, prev.clipId, project.workspaceId).catch(() => null);
  return item ? { prev, item } : null;
}

// Puts the replaced clip (and the design it carried) back. Undoing again
// swaps forward, since the swap records the clip it replaced.
async function restorePreviousVersion(dataRoot, projectId) {
  const project = projects.getProject(dataRoot, projectId);
  const found = await previousVersion(dataRoot, project);
  if (!found) {
    // The earlier clip is gone (deleted from the library): stop offering it.
    if (project && project.state && project.state.previousVersion) {
      const state = Object.assign({}, project.state);
      delete state.previousVersion;
      projects.updateProject(dataRoot, projectId, { state });
    }
    throw new Error("The earlier version is no longer in your library.");
  }
  const { prev, item } = found;
  // Edits on the newer clip move back with it; read them before the swap.
  const needsRender = clipHasEdits(project, prev.newId);
  const live = project.state && project.state.design;
  projects.addAssets(dataRoot, projectId, [{ id: item.id, kind: item.kind }]);
  const extra = prev.design ? { design: prev.design } : {};
  let updated = await swapClip(dataRoot, projectId, prev.newId, item.id, extra, { moveEdits: true });
  // Undoing a design edit restores the design; the design the newer clip
  // carried is kept so going forward again brings it back.
  const state = Object.assign({}, updated.state);
  if (!prev.design && live && live.assetId === prev.newId) delete state.design;
  state.previousVersion = Object.assign({}, state.previousVersion);
  if (live && live.assetId === prev.newId) state.previousVersion.design = live;
  else delete state.previousVersion.design;
  // The next click goes forward again, unless the step it undid was itself
  // a return.
  state.previousVersion.forward = !prev.forward;
  updated = projects.updateProject(dataRoot, projectId, { state });
  // The restored clip is the finished video again unless it has edits to bake.
  if (!needsRender) {
    try {
      const { libraryFilePath } = require("./library-io");
      await require("./video-render").registerClipAsRender(dataRoot, {
        projectId,
        sourceId: item.id,
        file: libraryFilePath(dataRoot, project.workspaceId, item),
        name: item.name,
        width: item.videoWidth || item.width,
        height: item.videoHeight || item.height,
        durationMs: item.durationMs,
        posterMs: Math.round((Number(item.durationMs) || 0) * 0.75),
      });
      updated = projects.getProject(dataRoot, projectId) || updated;
    } catch {
      /* Export waits for a project render */
    }
  }
  return Object.assign({}, updated, { needsRender });
}

module.exports = { adoptDesign, swapClip, liveDesign, pickExtras, clipHasEdits, previousVersion, restorePreviousVersion, EXTRA_KEYS };
