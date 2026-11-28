"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function loadDeleteHandler(deleteProjectCascade) {
  const handlers = new Map();
  const ipcMain = {
    removeHandler() {},
    handle(name, fn) {
      handlers.set(name, fn);
    },
  };
  const projects = {
    getProjectMeta() {
      return { id: "p1", workspaceId: "w1" };
    },
  };
  const workspaceStore = {
    async loadState() {
      return { activeWorkspaceId: "w1" };
    },
    async loadWorkspace() {
      return { id: "w1" };
    },
  };
  const originalLoad = Module._load;
  const patchedLoad = function (request, ...rest) {
    if (request === "electron") return { ipcMain };
    if (request === "../lib/ai-projects") return projects;
    if (request === "../lib/workspace-store") return workspaceStore;
    if (request === "../lib/project-delete") return { deleteProjectCascade };
    return originalLoad.call(this, request, ...rest);
  };

  Module._load = patchedLoad;
  try {
    const modulePath = require.resolve("../electron/ai-projects-ipc.cjs");
    delete require.cache[modulePath];
    require(modulePath).attachAiProjectsIpc({
      dataRoot: () => "/data",
      prepareDrawingsForProjectDelete() {
        return ["d1"];
      },
      projectDrawingsDeleted() {},
    });
    return handlers.get("ai-project-delete");
  } finally {
    Module._load = originalLoad;
  }
}

test("ai-project-delete propagates cascade failures", async () => {
  const invoke = loadDeleteHandler(() => {
    throw new Error("delete failed");
  });
  await assert.rejects(invoke({}, { id: "p1" }), /delete failed/);
});

test("ai-project-delete passes the project scope and drawing hooks to the cascade", async () => {
  const calls = [];
  const result = { ok: true, id: "p1" };
  const invoke = loadDeleteHandler((input) => {
    calls.push(input);
    return result;
  });

  assert.equal(await invoke({}, { id: "p1" }), result);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].dataRoot, "/data");
  assert.equal(calls[0].workspaceId, "w1");
  assert.equal(calls[0].projectId, "p1");
  assert.equal(typeof calls[0].prepareDrawings, "function");
  assert.equal(typeof calls[0].drawingsDeleted, "function");
});
