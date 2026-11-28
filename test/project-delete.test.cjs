"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const projects = require("../lib/ai-projects");
const chats = require("../lib/editor-chats");
const { dbPath: chatsDbPath } = require("../lib/editor-chats-store");
const { dbPath: projectsDbPath } = require("../lib/ai-projects-store");
const { deleteProjectCascade, cleanupOrphanedProjectData, drawDbPath } = require("../lib/project-delete");
const { DrawingStore } = require("../draw/lib/store.cjs");

function seedFixture(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), label));
  const dataRoot = path.join(root, "data");
  const drawDir = path.join(root, "draw");
  const project = projects.createProject(dataRoot, { workspaceId: "w1", name: "Delete me" });
  const chat = chats.createChat(dataRoot, { workspaceId: "w1", page: "ai", projectId: project.id, title: "Project chat" });
  const store = new DrawingStore(drawDir);
  const drawing = store.create({ name: "Drawing", projectId: project.id });
  store.createChat(drawing.id, { title: "Drawing chat" });
  return { root, dataRoot, drawDir, project, chat, store, drawing };
}

function cleanupFixture(fixture) {
  try {
    fixture.store.db.close();
  } catch {}
  projects.closeAiProjectStores();
  chats.closeEditorChatStores();
  fs.rmSync(fixture.root, { recursive: true, force: true });
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

function withTrigger(file, name, table, fn) {
  const db = new DatabaseSync(file);
  db.exec("CREATE TRIGGER " + name + " BEFORE DELETE ON " + table + " BEGIN SELECT RAISE(FAIL, 'delete failed'); END");
  db.close();
  try {
    return fn();
  } finally {
    const cleanup = new DatabaseSync(file);
    cleanup.exec("DROP TRIGGER " + name);
    cleanup.close();
  }
}

test("project chat cleanup failure rolls back every store", () => {
  const fixture = seedFixture("jdesign-delete-chat-fail-");
  try {
    const events = [];
    withTrigger(chatsDbPath(fixture.dataRoot), "fail_project_chat_delete", "editor_chats", () => {
      assert.throws(
        () =>
          deleteProjectCascade({
            dataRoot: fixture.dataRoot,
            workspaceId: "w1",
            projectId: fixture.project.id,
            prepareDrawings() {
              events.push("prepare");
              return [fixture.drawing.id];
            },
            drawingsDeleted() {
              events.push("deleted");
            },
          }),
        /delete failed/,
      );
    });
    assert.deepEqual(events, ["prepare"]);
    assert.deepEqual(countsFor(fixture), { projects: 1, chats: 1, activeChats: 1, drawings: 1, drawingChats: 1 });
  } finally {
    cleanupFixture(fixture);
  }
});

test("project row failure rolls back drawing and chat cleanup", () => {
  const fixture = seedFixture("jdesign-delete-project-fail-");
  try {
    withTrigger(projectsDbPath(fixture.dataRoot), "fail_project_row_delete", "ai_video_projects", () => {
      assert.throws(
        () => deleteProjectCascade({ dataRoot: fixture.dataRoot, workspaceId: "w1", projectId: fixture.project.id }),
        /delete failed/,
      );
    });
    assert.deepEqual(countsFor(fixture), { projects: 1, chats: 1, activeChats: 1, drawings: 1, drawingChats: 1 });
  } finally {
    cleanupFixture(fixture);
  }
});

test("successful cascade deletes the project, chats, drawings, and drawing chats", () => {
  const fixture = seedFixture("jdesign-delete-success-");
  try {
    const events = [];
    const result = deleteProjectCascade({
      dataRoot: fixture.dataRoot,
      workspaceId: "w1",
      projectId: fixture.project.id,
      prepareDrawings(projectId) {
        events.push(["prepare", projectId]);
        return [fixture.drawing.id];
      },
      drawingsDeleted(projectId) {
        events.push(["deleted", projectId]);
      },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.counts, { drawings: 1, drawingChats: 1, chats: 1 });
    assert.deepEqual(events, [
      ["prepare", fixture.project.id],
      ["deleted", fixture.project.id],
    ]);
    assert.deepEqual(countsFor(fixture), { projects: 0, chats: 0, activeChats: 0, drawings: 0, drawingChats: 0 });
  } finally {
    cleanupFixture(fixture);
  }
});


test("orphan cleanup removes interrupted deletion leftovers but keeps loose drawings", () => {
  const fixture = seedFixture("jdesign-delete-orphans-");
  try {
    const loose = fixture.store.create({ name: "Loose" });
    const db = new DatabaseSync(projectsDbPath(fixture.dataRoot), { enableForeignKeyConstraints: false });
    db.prepare("DELETE FROM ai_video_projects WHERE id = ?").run(fixture.project.id);
    db.close();

    const result = cleanupOrphanedProjectData(fixture.dataRoot);

    assert.deepEqual(result.counts, { drawings: 1, drawingChats: 1, chats: 1 });
    assert.deepEqual(countsFor(fixture), { projects: 0, chats: 0, activeChats: 0, drawings: 0, drawingChats: 0 });
    assert.equal(count(drawDbPath(fixture.dataRoot), "SELECT COUNT(*) AS n FROM drawings WHERE id = ?", loose.id), 1);
  } finally {
    cleanupFixture(fixture);
  }
});

test("agent project deletion uses the live drawing hooks when provided", async () => {
  const fixture = seedFixture("jdesign-delete-agent-hooks-");
  try {
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

    const result = await spec.run({ dataRoot: fixture.dataRoot }, { projectId: fixture.project.id, confirm: true });

    assert.equal(result.ok, true);
    assert.deepEqual(events, [
      ["prepare", fixture.project.id],
      ["deleted", fixture.project.id],
    ]);
    assert.deepEqual(countsFor(fixture), { projects: 0, chats: 0, activeChats: 0, drawings: 0, drawingChats: 0 });
  } finally {
    cleanupFixture(fixture);
  }
});
