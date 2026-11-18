"use strict";

const path = require("node:path");
const { dbPath, openEditorChatsStore } = require("./editor-chats-store");

// One long-lived store per database file. Opening runs the pragmas, schema,
// and migrations, which is far too slow to repeat on every IPC call. A closed
// handle reopens on the next use.
const stores = new Map();

function storeFor(dataRoot) {
  const key = path.resolve(dbPath(dataRoot));
  const cached = stores.get(key);
  if (cached && cached.isOpen()) return cached;
  const store = openEditorChatsStore(dataRoot);
  stores.set(key, store);
  return store;
}

function withStore(dataRoot, fn) {
  return fn(storeFor(dataRoot));
}

// Closes every cached store: app quit, and tests that touch the file directly.
function closeEditorChatStores() {
  for (const store of stores.values()) {
    try {
      store.close();
    } catch {
      /* closing is best-effort */
    }
  }
  stores.clear();
}

function listChats(dataRoot, opts) {
  return withStore(dataRoot, (store) => store.listChats(opts));
}

function getChat(dataRoot, chatId, opts) {
  return withStore(dataRoot, (store) => store.getChat(chatId, opts));
}

function createChat(dataRoot, input) {
  return withStore(dataRoot, (store) => store.createChat(input));
}

function appendChatMessage(dataRoot, input) {
  return withStore(dataRoot, (store) => store.appendChatMessage(input));
}

function replaceChatMessages(dataRoot, chatId, messages, opts) {
  return withStore(dataRoot, (store) => store.replaceChatMessages(chatId, messages, opts));
}

function deleteChat(dataRoot, chatId) {
  return withStore(dataRoot, (store) => store.deleteChat(chatId));
}

function getActiveChat(dataRoot, workspaceId, page, projectId) {
  return withStore(dataRoot, (store) => store.getActiveChat(workspaceId, page, projectId));
}

function setActiveChat(dataRoot, chatId) {
  return withStore(dataRoot, (store) => store.setActiveChat(chatId));
}

function updateChat(dataRoot, chatId, patch, opts) {
  return withStore(dataRoot, (store) => store.updateChat(chatId, patch, opts));
}

function switchChatHarness(dataRoot, chatId, input) {
  return withStore(dataRoot, (store) => store.switchChatHarness(chatId, input));
}

function deleteChatsForProject(dataRoot, workspaceId, projectId) {
  return withStore(dataRoot, (store) => store.deleteChatsForProject(workspaceId, projectId));
}

function getAcpModelCache(dataRoot) {
  return withStore(dataRoot, (store) => store.getAcpModelCache());
}

function setAcpModelCache(dataRoot, harnessId, models) {
  return withStore(dataRoot, (store) => store.setAcpModelCache(harnessId, models));
}

module.exports = {
  listChats,
  getChat,
  createChat,
  appendChatMessage,
  replaceChatMessages,
  deleteChat,
  getActiveChat,
  setActiveChat,
  updateChat,
  switchChatHarness,
  deleteChatsForProject,
  getAcpModelCache,
  setAcpModelCache,
  closeEditorChatStores,
};
