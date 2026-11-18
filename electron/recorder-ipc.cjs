"use strict";

// The recorder agent and its machine/session channels are gone. What remains
// is the shared chat store the browser agent and legacy agent chats live in.

const {
  listRecorderChats,
  getRecorderChat,
  createRecorderChat,
  appendRecorderChatMessage,
  deleteRecorderChat,
  getActiveRecorderChat,
  setActiveRecorderChat,
  replaceRecorderChatMessages,
  updateRecorderChat,
} = require("../lib/recorder");

function attachRecorderIpc(host) {
  const ipcMain = (host && host.ipcMain) || require("electron").ipcMain;
  const dataRoot = host.dataRoot;

  function registerHandle(channel, handler) {
    if (typeof ipcMain.removeHandler === "function") {
      try {
        ipcMain.removeHandler(channel);
      } catch {
        /* channel was not registered yet */
      }
    }
    ipcMain.handle(channel, handler);
  }

  registerHandle("recorder-chats", async (_event, payload) => {
    return listRecorderChats(dataRoot(), payload || {});
  });

  registerHandle("recorder-chat-get", async (_event, payload) => {
    const id = payload && payload.id;
    if (!id) throw new Error("Chat id is required.");
    return getRecorderChat(dataRoot(), id);
  });

  // All agent chats share the store; `kind` marks which surface wrote them.
  registerHandle("recorder-chat-create", async (_event, payload) => {
    const body = payload || {};
    const kind = body.kind || "news";
    return createRecorderChat(dataRoot(), {
      kind,
      targetId: body.targetId || "browser:chromium",
      model: body.model,
      title: body.title,
    });
  });

  registerHandle("recorder-chat-active", async (_event, payload) => {
    return getActiveRecorderChat(dataRoot(), (payload && payload.kind) || "news");
  });

  registerHandle("recorder-chat-open", async (_event, payload) => {
    const id = payload && payload.id;
    if (!id) throw new Error("Chat id is required.");
    return setActiveRecorderChat(dataRoot(), id);
  });

  registerHandle("recorder-chat-append", async (_event, payload) => {
    const body = payload || {};
    if (!body.chatId) throw new Error("Chat id is required.");
    return appendRecorderChatMessage(dataRoot(), body);
  });

  registerHandle("recorder-chat-update", async (_event, payload) => {
    const body = payload || {};
    if (!body.id) throw new Error("Chat id is required.");
    return updateRecorderChat(dataRoot(), body.id, body);
  });

  registerHandle("recorder-chat-save", async (_event, payload) => {
    const body = payload || {};
    if (!body.chatId) throw new Error("Chat id is required.");
    return replaceRecorderChatMessages(dataRoot(), body.chatId, body.messages || []);
  });

  registerHandle("recorder-chat-delete", async (_event, payload) => {
    const id = payload && payload.id;
    if (!id) throw new Error("Chat id is required.");
    return deleteRecorderChat(dataRoot(), id);
  });
}

module.exports = { attachRecorderIpc };
