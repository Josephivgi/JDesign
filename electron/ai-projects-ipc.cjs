"use strict";

const { ipcMain } = require("electron");
const projects = require("../lib/ai-projects");
const workspaceStore = require("../lib/workspace-store");

function attachAiProjectsIpc(host) {
  const dataRoot = host.dataRoot;

  function register(channel, handler) {
    if (typeof ipcMain.removeHandler === "function") {
      try {
        ipcMain.removeHandler(channel);
      } catch {}
    }
    ipcMain.handle(channel, handler);
  }

  async function activeWorkspace() {
    const state = await workspaceStore.loadState(dataRoot());
    return workspaceStore.loadWorkspace(dataRoot(), state.activeWorkspaceId);
  }

  // Resolve requested ids against the workspace library in the caller's order
  // (library order would silently reshuffle a multi-asset request). A missing
  // id throws before any project write, so nothing is half applied.
  function sourceAssets(workspace, ids) {
    const byId = new Map();
    for (const item of (workspace && workspace.library) || []) {
      if (!item || item.id == null) continue;
      const key = String(item.id);
      if (!byId.has(key)) byId.set(key, item);
    }
    const seen = new Set();
    const assets = [];
    for (const raw of Array.isArray(ids) ? ids : []) {
      const id = String(raw);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const item = byId.get(id);
      if (!item) throw new Error("Media must already exist in Videos and images.");
      assets.push({ id: item.id, kind: item.kind });
    }
    return assets;
  }

  // Workspace check on metadata only: state_json stays unparsed here so a
  // project with a damaged state blob can still be deleted (and can be healed
  // by an update that writes fresh state).
  async function projectInActiveWorkspace(id) {
    const workspace = await activeWorkspace();
    const meta = projects.getProjectMeta(dataRoot(), id);
    if (!meta || meta.workspaceId !== workspace.id) throw new Error("Project not found.");
    return { workspace, project: meta };
  }

  register("ai-projects-list", async () => {
    const workspace = await activeWorkspace();
    return projects.listProjects(dataRoot(), workspace.id);
  });

  register("ai-project-get", async (_event, payload) => {
    await projectInActiveWorkspace(payload && payload.id);
    return projects.getProject(dataRoot(), payload && payload.id);
  });

  register("ai-project-create", async (_event, payload) => {
    const body = payload || {};
    const workspace = await activeWorkspace();
    const assets = sourceAssets(workspace, body.assetIds);
    return projects.createProject(dataRoot(), {
      workspaceId: workspace.id,
      name: body.name,
      aspectRatio: body.aspectRatio,
      assets,
      state: body.state,
    });
  });

  register("ai-project-update", async (_event, payload) => {
    const body = payload || {};
    await projectInActiveWorkspace(body.id);
    return projects.updateProject(dataRoot(), body.id, body.patch || {});
  });

  // Bakes the selected clip's cuts, framing, and captions into a finished
  // video, the same render the agent's jeditor_render_project makes.
  register("ai-project-render", async (_event, payload) => {
    const body = payload || {};
    await projectInActiveWorkspace(body.id);
    return require("../lib/video-render").renderProjectVideo(dataRoot(), { projectId: body.id });
  });

  // Hand edits from the timeline strip under the stage. They run through the
  // same jeditor_edit_timeline code the agent uses, so both edit one cut. Each
  // edit leaves a plain note the next chat turn hands to the agent, so it
  // builds on the user's cut instead of redoing it.
  register("ai-project-edit-timeline", async (_event, payload) => {
    const body = payload || {};
    await projectInActiveWorkspace(body.id);
    const result = await require("../lib/video-render").editProjectTimeline(dataRoot(), {
      projectId: body.id,
      videoId: body.videoId || undefined,
      ops: body.ops,
    });
    const note = String(body.note || "").trim().slice(0, 300);
    const fresh = projects.getProject(dataRoot(), body.id);
    if (note && fresh) {
      const state = Object.assign({}, fresh.state || {});
      const log = Array.isArray(state.userTimelineEdits) ? state.userTimelineEdits.slice(-19) : [];
      log.push({ at: new Date().toISOString(), clipId: String(body.videoId || state.selectedAssetId || ""), note });
      state.userTimelineEdits = log;
      projects.updateProject(dataRoot(), body.id, { state });
    }
    return { project: projects.getProject(dataRoot(), body.id), timeline: result };
  });

  // The hand edits the agent has not been told about yet. Reading them clears
  // them, so each note goes out with exactly one chat message.
  register("ai-project-take-user-edits", async (_event, payload) => {
    const body = payload || {};
    await projectInActiveWorkspace(body.id);
    const fresh = projects.getProject(dataRoot(), body.id);
    const log = fresh && fresh.state && Array.isArray(fresh.state.userTimelineEdits) ? fresh.state.userTimelineEdits : [];
    if (!log.length) return [];
    const state = Object.assign({}, fresh.state);
    delete state.userTimelineEdits;
    projects.updateProject(dataRoot(), body.id, { state });
    return log;
  });

  register("ai-project-restore-previous", async (_event, payload) => {
    const body = payload || {};
    await projectInActiveWorkspace(body.id);
    return require("../lib/project-design").restorePreviousVersion(dataRoot(), body.id);
  });

  register("ai-project-add-assets", async (_event, payload) => {
    const body = payload || {};
    const found = await projectInActiveWorkspace(body.id);
    const assets = sourceAssets(found.workspace, body.assetIds);
    return projects.addAssets(dataRoot(), body.id, assets);
  });

  register("ai-project-remove-asset", async (_event, payload) => {
    const body = payload || {};
    await projectInActiveWorkspace(body.id);
    return projects.removeAsset(dataRoot(), body.id, body.libraryId);
  });

  register("ai-project-add-finished", async (_event, payload) => {
    const body = payload || {};
    const workspace = await activeWorkspace();
    const { getFinishedItem, finishedFilePath } = require("../lib/finished-io");
    const { copyPathIntoLibrary } = require("../lib/library-io");
    const finished = await getFinishedItem(dataRoot(), body.finishedId, workspace.id);
    if (!finished) throw new Error("Finished video not found.");
    const copied = await copyPathIntoLibrary(dataRoot(), finishedFilePath(dataRoot(), workspace.id, finished), {
      workspaceId: workspace.id,
      name: finished.name + (finished.file ? require("node:path").extname(finished.file) : ".mp4"),
      mime: finished.mime || "video/mp4",
      source: "finished-export",
    });
    const item = copied.item;
    let project;
    if (body.projectId) {
      await projectInActiveWorkspace(body.projectId);
      project = projects.addAssets(dataRoot(), body.projectId, [{ id: item.id, kind: item.kind }]);
    } else {
      project = projects.createProject(dataRoot(), {
        workspaceId: workspace.id,
        name: (finished.name || "Finished video") + " edit",
        assets: [{ id: item.id, kind: item.kind }],
      });
    }
    return { project, snapshot: copied.snapshot, item };
  });

  register("ai-project-delete", async (_event, payload) => {
    const body = payload || {};
    const found = await projectInActiveWorkspace(body.id);
    // Dependents go first: when any cleanup fails the project row stays, so
    // drawings and chats never point at a project the app no longer shows.
    if (typeof host.deleteDrawingsForProject === "function") host.deleteDrawingsForProject(body.id);
    const { deleteChatsForProject } = require("../lib/editor-chats");
    deleteChatsForProject(dataRoot(), found.workspace.id, body.id);
    return projects.deleteProject(dataRoot(), body.id);
  });
}

module.exports = { attachAiProjectsIpc };
