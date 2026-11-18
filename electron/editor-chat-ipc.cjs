"use strict";

const { ipcMain } = require("electron");
const {
  listChats,
  getChat,
  createChat,
  appendChatMessage,
  replaceChatMessages,
  deleteChat,
  getActiveChat,
  setActiveChat,
  updateChat,
  getAcpModelCache,
  setAcpModelCache,
} = require("../lib/editor-chats");

function attachEditorChatIpc(host) {
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

  registerHandle("editor-chats", async (_event, payload) => {
    return listChats(dataRoot(), payload || {});
  });

  // transcript: "tail" swaps the transcript blob for its newest row time.
  registerHandle("editor-chat-get", async (_event, payload) => {
    const id = payload && payload.id;
    if (!id) throw new Error("Chat id is required.");
    return getChat(dataRoot(), id, payload.transcript === "tail" ? { transcript: "tail" } : undefined);
  });

  registerHandle("editor-chat-create", async (_event, payload) => {
    const body = payload || {};
    return createChat(dataRoot(), {
      workspaceId: body.workspaceId,
      page: body.page,
      model: body.model,
      title: body.title,
      projectId: body.projectId,
    });
  });

  registerHandle("editor-chat-active", async (_event, payload) => {
    const body = payload || {};
    if (!body.workspaceId) throw new Error("workspaceId is required.");
    if (!body.page) throw new Error("page is required.");
    return getActiveChat(dataRoot(), body.workspaceId, body.page, body.projectId);
  });

  registerHandle("editor-chat-open", async (_event, payload) => {
    const id = payload && payload.id;
    if (!id) throw new Error("Chat id is required.");
    return setActiveChat(dataRoot(), id);
  });

  registerHandle("editor-chat-append", async (_event, payload) => {
    const body = payload || {};
    if (!body.chatId) throw new Error("Chat id is required.");
    return appendChatMessage(dataRoot(), body);
  });

  // light: true skips echoing the whole chat back over IPC.
  registerHandle("editor-chat-save", async (_event, payload) => {
    const body = payload || {};
    if (!body.chatId) throw new Error("Chat id is required.");
    return replaceChatMessages(dataRoot(), body.chatId, body.messages || [], body.light ? { light: true } : undefined);
  });

  registerHandle("editor-chat-delete", async (_event, payload) => {
    const id = payload && payload.id;
    if (!id) throw new Error("Chat id is required.");
    return deleteChat(dataRoot(), id);
  });

  registerHandle("editor-chat-update", async (_event, payload) => {
    const body = payload || {};
    if (!body.id) throw new Error("Chat id is required.");
    return updateChat(dataRoot(), body.id, body.patch || {}, body.light ? { light: true } : undefined);
  });

  registerHandle("acp-models-cache", async () => {
    return getAcpModelCache(dataRoot());
  });

  registerHandle("acp-models-cache-set", async (_event, payload) => {
    const body = payload || {};
    if (!body.harnessId) throw new Error("harnessId is required.");
    setAcpModelCache(dataRoot(), body.harnessId, body.models);
    return { ok: true };
  });
}

module.exports = { attachEditorChatIpc };
