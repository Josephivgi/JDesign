"use strict";

const path = require("node:path");
const { dbPath, openAiProjectsStore } = require("./ai-projects-store");

// One long-lived connection per database file. The renderer autosaves every
// 250ms, and reopening ran the PRAGMAs, schema, and migration check each time.
const stores = new Map();

function withStore(dataRoot, fn) {
  const key = path.resolve(dbPath(dataRoot));
  let store = stores.get(key);
  if (!store || !store.isOpen()) {
    store = openAiProjectsStore(dataRoot);
    stores.set(key, store);
  }
  return fn(store);
}

// For app quit and tests that delete their data root (Windows keeps the file
// locked while a handle is open).
function closeAiProjectStores() {
  for (const store of stores.values()) store.close();
  stores.clear();
}

function listProjects(dataRoot, workspaceId) {
  return withStore(dataRoot, (store) => store.listProjects(workspaceId));
}

function getProject(dataRoot, id) {
  return withStore(dataRoot, (store) => store.getProject(id));
}

// Identity/workspace lookup that never parses state_json, so corrupt state can
// still be checked, listed, and deleted instead of bricking the project.
function getProjectMeta(dataRoot, id) {
  return withStore(dataRoot, (store) => store.getProjectMeta(id));
}

function createProject(dataRoot, input) {
  return withStore(dataRoot, (store) => store.createProject(input));
}

function updateProject(dataRoot, id, patch) {
  return withStore(dataRoot, (store) => store.updateProject(id, patch));
}

function addAssets(dataRoot, id, assets) {
  return withStore(dataRoot, (store) => store.addAssets(id, assets));
}

function setAssetPosition(dataRoot, id, libraryId, position) {
  return withStore(dataRoot, (store) => store.setAssetPosition(id, libraryId, position));
}

function removeAsset(dataRoot, id, libraryId) {
  return withStore(dataRoot, (store) => store.removeAsset(id, libraryId));
}

function removeLibraryAsset(dataRoot, workspaceId, libraryId) {
  return withStore(dataRoot, (store) => store.removeLibraryAsset(workspaceId, libraryId));
}

function repointMedia(dataRoot, workspaceId, from, to) {
  return withStore(dataRoot, (store) => store.repointMedia(workspaceId, from, to));
}

function dropRender(dataRoot, workspaceId, renderId) {
  return withStore(dataRoot, (store) => store.dropRender(workspaceId, renderId));
}


module.exports = {
  listProjects,
  getProject,
  getProjectMeta,
  createProject,
  updateProject,
  addAssets,
  setAssetPosition,
  removeAsset,
  removeLibraryAsset,
  repointMedia,
  dropRender,
  closeAiProjectStores,
};
