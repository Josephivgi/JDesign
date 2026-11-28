"use strict";

const { ipcMain, BrowserWindow, clipboard, powerSaveBlocker } = require("electron");
const { createAgentBridge } = require("./agent-bridge.cjs");
const { createAcpHost } = require("./acp-host.cjs");

// A live agent turn has no length limit: a slow model call or a long render can
// run for minutes after the user walks away. Hold off system suspension while
// any turn is running so the machine sleeping cannot cut the agent's network
// stream and surface a cancel. The display is still free to turn off.
let powerHolds = 0;
let powerBlockerId = -1;
function holdSystemAwake() {
  powerHolds += 1;
  if (powerHolds === 1 && powerSaveBlocker && !powerSaveBlocker.isStarted(powerBlockerId)) {
    try {
      powerBlockerId = powerSaveBlocker.start("prevent-app-suspension");
    } catch {
      powerBlockerId = -1;
    }
  }
}
function releaseSystemAwake() {
  powerHolds = Math.max(0, powerHolds - 1);
  if (powerHolds === 0 && powerBlockerId >= 0) {
    try {
      powerSaveBlocker.stop(powerBlockerId);
    } catch {
      /* already stopped */
    }
    powerBlockerId = -1;
  }
}

function attachAgentHub(options) {
  const dataRoot = options.dataRoot();
  const appRoot = options.appRoot;

  const windows = () => BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed());
  const mainWindow = () =>
    windows().find((win) => {
      try {
        return /renderer[\\/]+index\.html/.test(decodeURIComponent(win.webContents.getURL()));
      } catch {
        return false;
      }
    }) || null;

  const bridge = createAgentBridge({
    dataRoot,
    appRoot,
    windows,
    mainWindow,
    prepareDrawingsForProjectDelete: options.prepareDrawingsForProjectDelete,
    projectDrawingsDeleted: options.projectDrawingsDeleted,
  });
  const acp = createAcpHost({
    dataRoot,
    appRoot,
    windows,
    powerHold: holdSystemAwake,
    powerRelease: releaseSystemAwake,
    bridgeInfo: () => {
      const info = bridge.info();
      return info.running ? { url: info.url, token: info.token } : null;
    },
    // Every project chat session gets the drawing tools bound to its project.
    drawMcp: (ids) => (typeof options.drawMcp === "function" ? options.drawMcp(ids) : null),
    drawTurnChanged: (projectId) => (typeof options.drawTurnChanged === "function" ? options.drawTurnChanged(projectId) : Promise.resolve([])),
    drawCheckDrawing: (docId, o) => (typeof options.drawCheckDrawing === "function" ? options.drawCheckDrawing(docId, o) : Promise.resolve(null)),
  });

  function register(channel, handler) {
    try {
      ipcMain.removeHandler(channel);
    } catch {
      /* not registered yet */
    }
    ipcMain.handle(channel, handler);
  }

  register("agent-bridge-info", () => bridge.info());
  register("clipboard-write-text", (_event, text) => {
    clipboard.writeText(String(text == null ? "" : text));
    return { ok: true };
  });
  register("bridge-command-reply", (_event, payload) => {
    bridge.commandReply(payload);
    return { ok: true };
  });
  register("agent-activity", (_event, payload) => {
    const { listActions } = require("../lib/agent-activity");
    return { actions: listActions(dataRoot, payload || {}) };
  });
  register("acp-harnesses", () => {
    const list = acp.list();
    const icons = require("../lib/acp-registry").cachedBuiltinIcons(dataRoot);
    for (const item of list) if (!item.icon && icons[item.id]) item.icon = icons[item.id];
    return list;
  });
  register("acp-session", (_event, payload) => acp.snapshot(payload || {}));
  register("acp-start", (_event, payload) => acp.start(payload));
  register("acp-models", (_event, payload) => acp.models(payload));
  register("acp-slash-commands", (_event, payload) => acp.slashCommands(payload || {}));
  register("acp-authenticate", (_event, payload) => acp.authenticate(payload));
  register("acp-prompt", (_event, payload) => acp.prompt(payload));
  register("acp-cancel", (_event, payload) => acp.cancel(payload));
  register("acp-permission-answer", (_event, payload) => acp.answerPermission(payload));
  register("acp-stop", (_event, payload) => acp.stop(payload));
  register("acp-handoff", (_event, payload) => acp.handoff(payload));
  register("acp-marketplace", () => {
    const { marketplaceList } = require("../lib/acp-marketplace");
    return marketplaceList({ dataRoot });
  });
  register("acp-agent-add", (_event, payload) => {
    const market = require("../lib/acp-marketplace");
    const body = payload || {};
    if (body.custom) return { added: market.addCustomAgent(dataRoot, body.custom) };
    return { added: { id: market.addCatalogAgent(dataRoot, body.catalogId).id } };
  });
  // ACP Registry marketplace: every public ACP agent, with what Add would do
  // on this computer.
  const registryInstalling = new Map();
  register("acp-registry", async (_event, payload) => {
    const reg = require("../lib/acp-registry");
    const market = require("../lib/acp-marketplace");
    const loaded = await reg.loadRegistry(dataRoot, { refresh: Boolean(payload && payload.refresh) });
    const harnesses = acp.list();
    const byId = new Map(harnesses.map((h) => [h.id, h]));
    const installs = new Map(market.registryInstalls(dataRoot).map((r) => [r.meta.registryId, r]));
    const icons = await reg.mapLimit(loaded.agents, 8, (agent) => reg.iconData(dataRoot, agent));
    const agents = loaded.agents.map((agent, i) => {
      const method = reg.installMethod(agent);
      const builtinId = reg.BUILTIN_IDS[agent.id] || "";
      const builtin = builtinId ? byId.get(builtinId) : null;
      const entry = builtinId ? market.catalogEntry(builtinId) : null;
      const localReady = Boolean((builtin && builtin.available) || (entry && entry.resolve()));
      const install = installs.get(agent.id);
      const harnessId = install ? install.id : builtin && builtin.available ? builtinId : "";
      const added = Boolean(harnessId && byId.get(harnessId) && byId.get(harnessId).available);
      return {
        id: agent.id,
        name: agent.name,
        version: String(agent.version || ""),
        description: String(agent.description || ""),
        website: String(agent.website || agent.repository || ""),
        authors: Array.isArray(agent.authors) ? agent.authors.slice(0, 3).map(String) : [],
        license: String(agent.license || ""),
        icon: icons[i] || "",
        method: method ? method.kind : "",
        builtin: localReady && !install ? builtinId : "",
        harnessId,
        added,
        installedVersion: install ? String(install.meta.version || "") : "",
        update: Boolean(install && agent.version && install.meta.version !== String(agent.version)),
        installing: registryInstalling.has(agent.id),
      };
    });
    return { agents, fetchedAt: loaded.fetchedAt, stale: Boolean(loaded.stale), error: loaded.error || "" };
  });
  register("acp-registry-install", async (event, payload) => {
    const reg = require("../lib/acp-registry");
    const market = require("../lib/acp-marketplace");
    const id = String((payload && payload.id) || "");
    if (registryInstalling.has(id)) return registryInstalling.get(id);
    const job = (async () => {
      const send = (p) => {
        if (!event.sender.isDestroyed()) event.sender.send("acp-registry-progress", Object.assign({ id }, p));
      };
      const loaded = await reg.loadRegistry(dataRoot);
      const agent = loaded.agents.find((a) => a.id === id);
      if (!agent) throw new Error("That agent is not in the ACP Registry.");
      // Already on this computer as a built-in agent: use that copy.
      const builtinId = reg.BUILTIN_IDS[id];
      const entry = builtinId ? market.catalogEntry(builtinId) : null;
      const update = market.registryInstalls(dataRoot).some((r) => r.meta.registryId === id);
      if (!update && builtinId === "devin" && acp.list().some((h) => h.id === "devin" && h.available)) return { id: "devin", builtin: true };
      if (!update && entry && entry.resolve()) {
        market.addCatalogAgent(dataRoot, builtinId);
        return { id: builtinId, builtin: true };
      }
      const installed = await reg.installAgent(dataRoot, agent, { findProgram: market.findProgram }, (p) => send(p));
      installed.icon = await reg.iconData(dataRoot, agent);
      const added = market.addRegistryAgent(dataRoot, agent, installed);
      // An update restarts the agent so the next message runs the new version.
      if (update && typeof acp.stopHarness === "function") acp.stopHarness({ harnessId: added.id });
      send({ phase: "done" });
      return { id: added.id, version: installed.version, kind: installed.kind };
    })();
    registryInstalling.set(id, job);
    try {
      return await job;
    } finally {
      registryInstalling.delete(id);
    }
  });
  register("acp-agent-remove", (_event, payload) => {
    const { removeAgent } = require("../lib/acp-marketplace");
    const removed = removeAgent(dataRoot, payload && payload.id);
    // A removed agent can have a live session; kill it or it keeps running
    // with no picker entry left to stop it. Only a real delete counts:
    // removing an id that was never added must not kill its live sessions.
    if (removed && acp && typeof acp.stopHarness === "function") acp.stopHarness({ harnessId: payload && payload.id });
    return { ok: true };
  });

  const ready = bridge.start().catch((error) => {
    if (options.log) options.log("agent-bridge", (error && (error.stack || error.message)) || error);
    return null;
  });

  function stop() {
    acp.stopAll();
    powerHolds = 0;
    if (powerBlockerId >= 0) {
      try {
        powerSaveBlocker.stop(powerBlockerId);
      } catch {
        /* already stopped */
      }
      powerBlockerId = -1;
    }
    bridge.stop();
  }

  return { bridge, acp, ready, stop };
}

module.exports = { attachAgentHub };
