"use strict";

const path = require("node:path");
const { openRecorderStore } = require("./recorder-store");
const { dbPath } = require("./recorder-contract");

// One long-lived connection per database file, so a chat append no longer
// reruns the PRAGMAs, schema, and chat migrations on every call.
const stores = new Map();

function withStore(dataRoot, fn) {
  const key = path.resolve(dbPath(dataRoot));
  let store = stores.get(key);
  if (!store || !store.isOpen()) {
    store = openRecorderStore(dataRoot);
    stores.set(key, store);
  }
  return fn(store);
}

// For app quit and tests that delete their data root (Windows keeps the file
// locked while a handle is open).
function closeRecorderChatStores() {
  for (const store of stores.values()) store.close();
  stores.clear();
}

function listChats(dataRoot, opts) {
  return withStore(dataRoot, (store) => store.listChats(opts));
}

function getChat(dataRoot, chatId) {
  return withStore(dataRoot, (store) => store.getChat(chatId));
}

function createChat(dataRoot, input) {
  return withStore(dataRoot, (store) => store.createChat(input));
}

function appendChatMessage(dataRoot, input) {
  return withStore(dataRoot, (store) => store.appendChatMessage(input));
}

function replaceChatMessages(dataRoot, chatId, messages) {
  return withStore(dataRoot, (store) => store.replaceChatMessages(chatId, messages));
}

function deleteChat(dataRoot, chatId) {
  return withStore(dataRoot, (store) => store.deleteChat(chatId));
}

function getActiveChat(dataRoot, kind) {
  return withStore(dataRoot, (store) => store.getActiveChat(kind));
}

function setActiveChat(dataRoot, chatId) {
  return withStore(dataRoot, (store) => store.setActiveChat(chatId));
}

function updateChat(dataRoot, chatId, patch) {
  return withStore(dataRoot, (store) => store.updateChat(chatId, patch));
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
  closeRecorderChatStores,
};
