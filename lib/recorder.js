"use strict";

// Chat-store barrel. The recorder agent is gone; what survives here is the
// shared chat store (SQLite) that the browser agent and editor chats read.

const { openRecorderStore } = require("./recorder-store");
const recorderChats = require("./recorder-chats");

module.exports = {
  openRecorderStore,
  listRecorderChats: recorderChats.listChats,
  getRecorderChat: recorderChats.getChat,
  createRecorderChat: recorderChats.createChat,
  appendRecorderChatMessage: recorderChats.appendChatMessage,
  replaceRecorderChatMessages: recorderChats.replaceChatMessages,
  deleteRecorderChat: recorderChats.deleteChat,
  getActiveRecorderChat: recorderChats.getActiveChat,
  setActiveRecorderChat: recorderChats.setActiveChat,
  updateRecorderChat: recorderChats.updateChat,
};
