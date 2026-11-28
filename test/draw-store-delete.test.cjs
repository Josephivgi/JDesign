"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DrawingStore } = require("../draw/lib/store.cjs");

test("project drawing cleanup is atomic across drawings and their chats", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jdesign-draw-delete-"));
  const store = new DrawingStore(dir);
  try {
    const drawing = store.create({ name: "Mine", projectId: "p1" });
    const other = store.create({ name: "Other", projectId: "p2" });
    store.createChat(drawing.id, { title: "Project chat" });
    store.db.exec("CREATE TRIGGER fail_project_drawing_delete BEFORE DELETE ON drawings BEGIN SELECT RAISE(FAIL, 'cannot delete drawings'); END");

    assert.throws(() => store.removeProjectDrawings("p1"), /cannot delete drawings/);
    assert.equal(store.listByProject("p1").length, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM chat_threads WHERE drawing_id = ?").get(drawing.id).n, 1);

    store.db.exec("DROP TRIGGER fail_project_drawing_delete");
    assert.equal(store.removeProjectDrawings("p1"), 1);
    assert.equal(store.listByProject("p1").length, 0);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM chat_threads WHERE drawing_id = ?").get(drawing.id).n, 0);
    assert.equal(store.listByProject("p2").length, 1);
    assert.equal(store.listByProject("p2")[0].id, other.id);
  } finally {
    store.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
