"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function loadDeleteHandler({ dataRoot = "/unused", deleteProject, deleteDrawingsForProject, deleteChatsForProject }) {
  const handlers = new Map();
  const ipcMain = {
    removeHandler() {},
    handle(name, fn) {
      handlers.set(name, fn);
    },
  };
  const projects = deleteProject
    ? {
        getProjectMeta() {
          return { id: "p1", workspaceId: "w1" };
        },
        deleteProject,
      }
    : null;
  const workspaceStore = {
    async loadState() {
      return { activeWorkspaceId: "w1" };
    },
    async loadWorkspace() {
      return { id: "w1" };
    },
  };
  const editorChats = deleteChatsForProject ? { deleteChatsForProject } : null;
  const originalLoad = Module._load;
  const patchedLoad = function (request, ...rest) {
    if (request === "electron") return { ipcMain };
    if (projects && request === "../lib/ai-projects") return projects;
    if (request === "../lib/workspace-store") return workspaceStore;
    if (editorChats && request === "../lib/editor-chats") return editorChats;
    return originalLoad.call(this, request, ...rest);
  };

  Module._load = patchedLoad;
  let handler;
  try {
    const modulePath = require.resolve("../electron/ai-projects-ipc.cjs");
    delete require.cache[modulePath];
    require(modulePath).attachAiProjectsIpc({
      dataRoot: () => dataRoot,
      deleteDrawingsForProject,
    });
    handler = handlers.get("ai-project-delete");
  } finally {
    Module._load = originalLoad;
  }

  return async (...args) => {
    Module._load = patchedLoad;
    try {
      return await handler(...args);
    } finally {
      Module._load = originalLoad;
    }
  };
}

test("drawing cleanup failure aborts before the project row is deleted", async () => {
  const calls = [];
  const invoke = loadDeleteHandler({
    deleteDrawingsForProject() {
      calls.push("drawings");
      throw new Error("drawing store unavailable");
    },
    deleteChatsForProject() {
      calls.push("chats");
    },
    deleteProject() {
      calls.push("project");
      return { ok: true, id: "p1" };
    },
  });

  await assert.rejects(invoke({}, { id: "p1" }), /drawing store unavailable/);
  assert.deepEqual(calls, ["drawings"]);
});

test("chat cleanup failure aborts before the project row is deleted", async () => {
  const calls = [];
  const invoke = loadDeleteHandler({
    deleteDrawingsForProject() {
      calls.push("drawings");
      return 1;
    },
    deleteChatsForProject() {
      calls.push("chats");
      throw new Error("chat store unavailable");
    },
    deleteProject() {
      calls.push("project");
      return { ok: true, id: "p1" };
    },
  });

  await assert.rejects(invoke({}, { id: "p1" }), /chat store unavailable/);
  assert.deepEqual(calls, ["drawings", "chats"]);
});

test("successful project deletion cleans dependents before the project row", async () => {
  const calls = [];
  const invoke = loadDeleteHandler({
    deleteDrawingsForProject() {
      calls.push("drawings");
      return 1;
    },
    deleteChatsForProject() {
      calls.push("chats");
      return { ok: true, changes: 1 };
    },
    deleteProject() {
      calls.push("project");
      return { ok: true, id: "p1" };
    },
  });

  assert.deepEqual(await invoke({}, { id: "p1" }), { ok: true, id: "p1" });
  assert.deepEqual(calls, ["drawings", "chats", "project"]);
});

test("a failed delete leaves real project and chat rows readable", async () => {
  const projects = require("../lib/ai-projects");
  const chats = require("../lib/editor-chats");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jdesign-delete-failure-"));
  try {
    const project = projects.createProject(dir, { workspaceId: "w1", name: "Keep me" });
    chats.createChat(dir, { workspaceId: "w1", page: "ai", projectId: project.id, title: "Project chat" });
    const invoke = loadDeleteHandler({
      dataRoot: dir,
      deleteDrawingsForProject() {
        throw new Error("drawing store unavailable");
      },
    });

    await assert.rejects(invoke({}, { id: project.id }), /drawing store unavailable/);
    assert.equal(projects.getProjectMeta(dir, project.id).name, "Keep me");
    assert.equal(chats.listChats(dir, { workspaceId: "w1", page: "ai", projectId: project.id }).length, 1);
  } finally {
    projects.closeAiProjectStores();
    chats.closeEditorChatStores();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a successful delete removes real project and chat rows", async () => {
  const projects = require("../lib/ai-projects");
  const chats = require("../lib/editor-chats");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jdesign-delete-success-"));
  try {
    const project = projects.createProject(dir, { workspaceId: "w1", name: "Delete me" });
    chats.createChat(dir, { workspaceId: "w1", page: "ai", projectId: project.id, title: "Project chat" });
    const drawings = [];
    const invoke = loadDeleteHandler({
      dataRoot: dir,
      deleteDrawingsForProject(id) {
        drawings.push(id);
        return 1;
      },
    });

    assert.deepEqual(await invoke({}, { id: project.id }), { ok: true, id: project.id });
    assert.deepEqual(drawings, [project.id]);
    assert.equal(projects.getProjectMeta(dir, project.id), null);
    assert.equal(chats.listChats(dir, { workspaceId: "w1", page: "ai", projectId: project.id }).length, 0);
  } finally {
    projects.closeAiProjectStores();
    chats.closeEditorChatStores();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
