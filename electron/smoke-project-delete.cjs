"use strict";

// Project-delete regression gate for the hidden app smoke. These are plain
// checks inside that end-to-end run, not a separate test suite: they seed real
// rows in scratch SQLite stores, force real delete failures, and inspect what
// survived.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { openAiProjectsStore, dbPath: projectsDbPath } = require("../lib/ai-projects-store");
const { openEditorChatsStore, dbPath: chatsDbPath } = require("../lib/editor-chats-store");
const workspaceStore = require("../lib/workspace-store");
const { deleteProjectCascade, cleanupOrphanedProjectData, drawDbPath } = require("../lib/project-delete");
const { DrawingStore } = require("../draw/lib/store.cjs");

function fail(message) {
  throw new Error("project delete smoke: " + message);
}

function assert(value, message) {
  if (!value) fail(message);
}

function count(file, sql, ...values) {
  const db = new DatabaseSync(file);
  try {
    return db.prepare(sql).get(...values).n;
  } finally {
    db.close();
  }
}

function countsFor(fixture) {
  const projectId = fixture.project.id;
  return {
    projects: count(projectsDbPath(fixture.dataRoot), "SELECT COUNT(*) AS n FROM ai_video_projects WHERE id = ?", projectId),
    chats: count(chatsDbPath(fixture.dataRoot), "SELECT COUNT(*) AS n FROM editor_chats WHERE project_id = ?", projectId),
    activeChats: count(chatsDbPath(fixture.dataRoot), "SELECT COUNT(*) AS n FROM editor_chat_active_v2 WHERE project_id = ?", projectId),
    drawings: count(drawDbPath(fixture.dataRoot), "SELECT COUNT(*) AS n FROM drawings WHERE project_id = ?", projectId),
    drawingChats: count(drawDbPath(fixture.dataRoot), "SELECT COUNT(*) AS n FROM chat_threads WHERE drawing_id = ?", fixture.drawing.id),
  };
}

function assertCounts(fixture, expected, label) {
  const actual = countsFor(fixture);
  for (const key of Object.keys(expected)) {
    assert(actual[key] === expected[key], label + " left " + key + "=" + actual[key] + ", expected " + expected[key] + " (" + JSON.stringify(actual) + ")");
  }
}

function seedFixture(dataRoot, workspaceId, name, opts) {
  const projectStore = openAiProjectsStore(dataRoot);
  const chatStore = openEditorChatsStore(dataRoot);
  const drawingStore = new DrawingStore(path.dirname(drawDbPath(dataRoot)));
  try {
    const project = projectStore.createProject({ workspaceId, name });
    const chat = chatStore.createChat({ workspaceId, page: "ai", projectId: project.id, title: name + " chat" });
    const drawing = drawingStore.create({ name: name + " drawing", projectId: project.id });
    drawingStore.createChat(drawing.id, { title: name + " drawing chat" });
    const loose = opts && opts.loose ? drawingStore.create({ name: name + " loose drawing" }) : null;
    return {
      dataRoot,
      project,
      chat,
      drawing,
      loose,
      close() {
        try {
          drawingStore.db.close();
        } catch {}
        try {
          chatStore.close();
        } catch {}
        try {
          projectStore.close();
        } catch {}
      },
    };
  } catch (error) {
    try {
      drawingStore.db.close();
    } catch {}
    try {
      chatStore.close();
    } catch {}
    try {
      projectStore.close();
    } catch {}
    throw error;
  }
}

function createTrigger(file, name, table) {
  const db = new DatabaseSync(file);
  try {
    db.exec("CREATE TRIGGER " + name + " BEFORE DELETE ON " + table + " BEGIN SELECT RAISE(FAIL, 'delete failed'); END");
  } finally {
    db.close();
  }
}

function dropTrigger(file, name) {
  const db = new DatabaseSync(file);
  try {
    db.exec("DROP TRIGGER " + name);
  } finally {
    db.close();
  }
}

async function verifyIpcDelete(root, workspaceId, js) {
  const fixture = seedFixture(root, workspaceId, "Smoke delete");
  fixture.close();
  const trigger = "smoke_fail_project_chat_delete";
  createTrigger(chatsDbPath(root), trigger, "editor_chats");
  let failure = "";
  try {
    failure = await js(
      "window.cutline.aiProjectDelete({ id: " + JSON.stringify(fixture.project.id) + " }).then(() => 'resolved', (e) => 'rejected: ' + String((e && e.message) || e))",
    );
    assert(String(failure).startsWith("rejected:"), "forced IPC deletion did not reject: " + failure);
    assertCounts(fixture, { projects: 1, chats: 1, activeChats: 1, drawings: 1, drawingChats: 1 }, "forced IPC deletion");
  } finally {
    dropTrigger(chatsDbPath(root), trigger);
  }

  const success = await js(
    "window.cutline.aiProjectDelete({ id: " + JSON.stringify(fixture.project.id) + " }).then(() => 'resolved', (e) => 'rejected: ' + String((e && e.message) || e))",
  );
  assert(success === "resolved", "unblocked IPC deletion did not resolve: " + success);
  assertCounts(fixture, { projects: 0, chats: 0, activeChats: 0, drawings: 0, drawingChats: 0 }, "successful IPC deletion");
  return { failure, success };
}

function verifyProjectRowRollback(dataRoot) {
  const fixture = seedFixture(dataRoot, "w1", "Smoke row rollback");
  const trigger = "smoke_fail_project_row_delete";
  createTrigger(projectsDbPath(dataRoot), trigger, "ai_video_projects");
  try {
    let message = "";
    try {
      deleteProjectCascade({ dataRoot, workspaceId: "w1", projectId: fixture.project.id });
    } catch (error) {
      message = String((error && error.message) || error);
    }
    assert(/delete failed/.test(message), "project row failure did not reject: " + message);
    assertCounts(fixture, { projects: 1, chats: 1, activeChats: 1, drawings: 1, drawingChats: 1 }, "project row failure");
  } finally {
    dropTrigger(projectsDbPath(dataRoot), trigger);
    fixture.close();
  }
  return true;
}

function verifyInterruptedDelete(dataRoot) {
  const fixture = seedFixture(dataRoot, "w1", "Smoke orphan cleanup", { loose: true });
  fixture.close();

  const db = new DatabaseSync(projectsDbPath(dataRoot), { enableForeignKeyConstraints: false });
  db.prepare("DELETE FROM ai_video_projects WHERE id = ?").run(fixture.project.id);
  db.close();
  const result = cleanupOrphanedProjectData(dataRoot);
  assert(result.counts.drawings === 1 && result.counts.drawingChats === 1 && result.counts.chats === 1, "interrupted deletion counts wrong: " + JSON.stringify(result.counts));
  assertCounts(fixture, { projects: 0, chats: 0, activeChats: 0, drawings: 0, drawingChats: 0 }, "interrupted deletion");
  assert(count(drawDbPath(dataRoot), "SELECT COUNT(*) AS n FROM drawings WHERE id = ?", fixture.loose.id) === 1, "loose drawing was incorrectly cleaned");
  return true;
}

function verifyMissingProjectDatabase() {
  for (const mode of ["missing", "empty"]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jdesign-smoke-delete-"));
    const dataRoot = path.join(root, "data");
    fs.mkdirSync(dataRoot, { recursive: true });
    const fixture = seedFixture(dataRoot, "w1", "Smoke recovery guard");
    fixture.close();
    const file = projectsDbPath(dataRoot);
    if (mode === "missing") fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, "");
    const result = cleanupOrphanedProjectData(dataRoot);
    assert(result.skipped === true, mode + " project database did not skip recovery");
    assert(result.counts.drawings === 0 && result.counts.drawingChats === 0 && result.counts.chats === 0, mode + " project database deleted dependents");
    assert(count(chatsDbPath(dataRoot), "SELECT COUNT(*) AS n FROM editor_chats WHERE project_id = ?", fixture.project.id) === 1, mode + " project database lost project chat");
    assert(count(drawDbPath(dataRoot), "SELECT COUNT(*) AS n FROM drawings WHERE project_id = ?", fixture.project.id) === 1, mode + " project database lost drawing");
    assert(count(drawDbPath(dataRoot), "SELECT COUNT(*) AS n FROM chat_threads WHERE drawing_id = ?", fixture.drawing.id) === 1, mode + " project database lost drawing chat");
    fs.rmSync(root, { recursive: true, force: true });
  }
  return true;
}

async function verifyAgentHooks(dataRoot) {
  const fixture = seedFixture(dataRoot, "w1", "Smoke agent delete");
  fixture.close();
  const events = [];
  const spec = require("../lib/agent-tools")
    .agentToolSpecs({
      prepareDrawings(projectId) {
        events.push(["prepare", projectId]);
      },
      drawingsDeleted(projectId) {
        events.push(["deleted", projectId]);
      },
    })
    .find((tool) => tool.name === "jeditor_delete_project");
  const result = await spec.run({ dataRoot }, { projectId: fixture.project.id, confirm: true });
  assert(result && result.ok === true, "agent delete did not succeed");
  assert(events.length === 2 && events[0][0] === "prepare" && events[1][0] === "deleted" && events[0][1] === fixture.project.id && events[1][1] === fixture.project.id, "agent delete did not use drawing hooks: " + JSON.stringify(events));
  assertCounts(fixture, { projects: 0, chats: 0, activeChats: 0, drawings: 0, drawingChats: 0 }, "agent deletion");
  return true;
}

async function verifyProjectDelete({ dataRoot, js }) {
  const root = String(dataRoot || "");
  const state = await workspaceStore.loadState(root);
  const report = {};
  report.ipc = await verifyIpcDelete(root, state.activeWorkspaceId, js);

  const directRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jdesign-smoke-delete-"));
  const directData = path.join(directRoot, "data");
  fs.mkdirSync(directData, { recursive: true });
  report.projectRowRollback = verifyProjectRowRollback(directData);
  fs.rmSync(directRoot, { recursive: true, force: true });

  const orphanRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jdesign-smoke-delete-"));
  const orphanData = path.join(orphanRoot, "data");
  fs.mkdirSync(orphanData, { recursive: true });
  report.interruptedDelete = verifyInterruptedDelete(orphanData);
  fs.rmSync(orphanRoot, { recursive: true, force: true });

  report.recoveryGuard = verifyMissingProjectDatabase();

  const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jdesign-smoke-delete-"));
  const agentData = path.join(agentRoot, "data");
  fs.mkdirSync(agentData, { recursive: true });
  report.agentHooks = await verifyAgentHooks(agentData);
  // The agent tool uses the shared cached stores; close them before removing
  // its scratch root on platforms that lock open SQLite files. The app reopens
  // its own stores lazily on the next IPC call.
  require("../lib/ai-projects").closeAiProjectStores();
  require("../lib/editor-chats").closeEditorChatStores();
  fs.rmSync(agentRoot, { recursive: true, force: true });

  report.ok = true;
  return report;
}

module.exports = { verifyProjectDelete };
