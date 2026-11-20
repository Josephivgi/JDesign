"use strict";

// Outside coding agents that JV can drive over ACP (Agent Client
// Protocol). Each one gets the JV MCP server in session/new so its edits
// land in the running app. This is the only agent list: there is no built-in
// agent left to spawn.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { resolveProgram } = require("./win-command");
const { extraHarnesses, marketplaceHarness, findProgram, cursorAgentSpec, codexSpec, claudeCodeSpec } = require("./acp-marketplace");
const { CONTENT_RESEARCH_MCP_NAME } = require("./content-research-tools");

function localAppData() {
  return process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
}

function devinSpec() {
  const bundled = path.join(localAppData(), "devin", "cli", "bin", process.platform === "win32" ? "devin.exe" : "devin");
  if (fs.existsSync(bundled)) return { command: bundled, args: ["acp"], env: {} };
  const onPath = resolveProgram("devin");
  if (onPath && onPath !== "devin") return { command: onPath, args: ["acp"], env: {} };
  return null;
}

// Devin ships enabled. Cursor, Codex, Claude Code, and the rest install
// through the ACP marketplace (acp-marketplace.js).
const ACP_HARNESSES = [
  {
    id: "devin",
    name: "Devin",
    description: "Cognition's Devin agent. Sign in once with devin auth.",
    connects: "the JV MCP",
    reach: "every JV tool: cards, library, projects, recording, and the browser",
    resolve: () => devinSpec(),
    install: "Install the Devin CLI, then run devin auth login.",
  },
];

function acpHarness(id, options) {
  const shipped = ACP_HARNESSES.find((item) => item.id === id);
  if (shipped) return shipped;
  const dataRoot = options && options.dataRoot;
  return dataRoot ? marketplaceHarness(id, dataRoot) : null;
}

function listAcpHarnesses(options) {
  const opts = options || {};
  const marketplace = opts.dataRoot ? extraHarnesses(opts.dataRoot) : [];
  return ACP_HARNESSES.concat(marketplace).map((item) => {
    const spec = item.resolve(opts);
    return {
      id: item.id,
      name: item.name,
      description: item.description,
      connects: item.connects,
      reach: item.reach,
      available: Boolean(spec),
      command: spec ? spec.command : "",
      install: spec ? "" : item.install,
      icon: item.icon || "",
    };
  });
}

function acpSpawnSpec(id, options) {
  const harness = acpHarness(id, options);
  if (!harness) throw new Error("Unknown ACP agent: " + id);
  const spec = harness.resolve(options || {});
  if (!spec) throw new Error(harness.name + " is not installed. " + harness.install);
  return spec;
}

// MCP server entry for ACP session/new. Agents that advertise HTTP MCP get the
// live bridge URL; the rest get the stdio proxy, which reaches the same bridge.
// The name differs from "jeditor" because an agent's own config entry with the
// same name wins over the one passed in session/new.
const ACP_MCP_NAME = "jeditor-app";
const { CARD_MCP_NAME, bridgeUrlForProfile } = require("./card-assistant");

function cutlineMcpForAcp(options) {
  const opts = options || {};
  const bridge = opts.bridge || null;
  const caps = (opts.agentCapabilities && opts.agentCapabilities.mcpCapabilities) || {};
  const cards = opts.profile === "cards";
  const contentResearch = opts.profile === "content-research";
  const name = cards ? CARD_MCP_NAME : contentResearch ? CONTENT_RESEARCH_MCP_NAME : ACP_MCP_NAME;
  if (bridge && bridge.url && caps.http) {
    return {
      type: "http",
      name,
      url: bridgeUrlForProfile(bridge.url, opts.profile),
      headers: [
        { name: "Authorization", value: "Bearer " + bridge.token },
        { name: "x-cutline-harness", value: String(opts.harnessId || "") },
        { name: "x-cutline-harness-key", value: String(bridge.harnessKey || "") },
        { name: "x-cutline-project-id", value: String(opts.projectId || "") },
        { name: "x-cutline-workspace-id", value: String(opts.workspaceId || "") },
        { name: "x-cutline-chat-id", value: String(opts.chatId || "") },
      ],
    };
  }
  const appRoot = opts.appRoot || path.join(__dirname, "..");
  return {
    name,
    command: process.execPath,
    args: [path.join(appRoot, "lib", "mcp-stdio.js"), "--data-root", opts.dataRoot, "--app-root", appRoot].concat(opts.profile ? ["--profile", opts.profile] : []),
    env: [
      { name: "ELECTRON_RUN_AS_NODE", value: "1" },
      // Both spellings: the renamed one is what the server reads first, the old
      // one keeps configs and scripts written before the rename working.
      { name: "JEDITOR_DATA_ROOT", value: String(opts.dataRoot || "") },
      { name: "CUTLINE_DATA_ROOT", value: String(opts.dataRoot || "") },
      { name: "JEDITOR_HARNESS", value: String(opts.harnessId || "") },
      { name: "CUTLINE_HARNESS", value: String(opts.harnessId || "") },
      { name: "JEDITOR_HARNESS_KEY", value: String((opts.bridge && opts.bridge.harnessKey) || "") },
      { name: "CUTLINE_HARNESS_KEY", value: String((opts.bridge && opts.bridge.harnessKey) || "") },
      { name: "JEDITOR_PROJECT_ID", value: String(opts.projectId || "") },
      { name: "CUTLINE_PROJECT_ID", value: String(opts.projectId || "") },
      { name: "JEDITOR_WORKSPACE_ID", value: String(opts.workspaceId || "") },
      { name: "CUTLINE_WORKSPACE_ID", value: String(opts.workspaceId || "") },
      { name: "JEDITOR_CHAT_ID", value: String(opts.chatId || "") },
      { name: "CUTLINE_CHAT_ID", value: String(opts.chatId || "") },
    ],
  };
}

// The Draw MCP entry for a JV project chat session, bound to that project and
// chat. opts.drawMcp is { url, token } from the live studio; when the agent
// cannot take HTTP servers it gets a stdio proxy carrying the same binding in
// env, which is also what writeCwdMcpConfig writes for Devin.
function drawMcpForAcp(options) {
  const opts = options || {};
  const mcp = opts.drawMcp;
  if (!mcp || !mcp.url) return null;
  const caps = (opts.agentCapabilities && opts.agentCapabilities.mcpCapabilities) || {};
  if (caps.http) {
    return {
      type: "http",
      name: "jdraw",
      url: mcp.url,
      headers: [
        { name: "Authorization", value: "Bearer " + mcp.token },
        { name: "x-jdraw-project", value: String(opts.projectId || "") },
        { name: "x-jdraw-chat-id", value: String(opts.chatId || "") },
      ],
    };
  }
  const appRoot = opts.appRoot || path.join(__dirname, "..");
  return {
    name: "jdraw",
    command: process.execPath,
    args: [path.join(appRoot, "draw", "lib", "mcp-stdio.cjs")],
    env: [
      { name: "ELECTRON_RUN_AS_NODE", value: "1" },
      { name: "JDRAW_MCP_URL", value: String(mcp.url || "") },
      { name: "JDRAW_MCP_TOKEN", value: String(mcp.token || "") },
      { name: "JDRAW_PROJECT_ID", value: String(opts.projectId || "") },
      { name: "JDRAW_CHAT_ID", value: String(opts.chatId || "") },
    ],
  };
}

// The card studio assistant is limited to the card editor. Every other chat
// gets the full app server, card editor, shared content research server, and
// the project-bound drawing tools.
function cutlineMcpServersForAcp(options) {
  const opts = options || {};
  if (opts.profile === "cards") return [cutlineMcpForAcp(opts)];
  const list = [
    cutlineMcpForAcp(Object.assign({}, opts, { profile: "" })),
    cutlineMcpForAcp(Object.assign({}, opts, { profile: "cards" })),
    cutlineMcpForAcp(Object.assign({}, opts, { profile: "content-research" })),
  ];
  const draw = drawMcpForAcp(opts);
  if (draw) list.push(draw);
  return list;
}

// Devin's ACP server ignores session/new mcpServers and only loads its config
// files, so the stdio entry also goes into the session cwd's local config.
function writeCwdMcpConfig(harnessId, cwd, entry) {
  if (harnessId !== "devin" || !cwd || !entry || !entry.command) return "";
  const dir = path.join(cwd, ".devin");
  const file = path.join(dir, "mcp_config.local.json");
  fs.mkdirSync(dir, { recursive: true });
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("Cannot read Devin MCP config. Existing config was not changed.");
  }
  if (!current || typeof current !== "object" || Array.isArray(current) || (current.mcpServers && (typeof current.mcpServers !== "object" || Array.isArray(current.mcpServers)))) {
    throw new Error("Invalid Devin MCP config. Existing config was not changed.");
  }
  const env = {};
  for (const item of entry.env || []) env[item.name] = item.value;
  const servers = Object.assign({}, current.mcpServers, {
    [entry.name]: { command: entry.command, args: entry.args || [], env },
  });
  const tmp = file + "." + randomUUID() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(Object.assign({}, current, { mcpServers: servers }), null, 2));
  fs.renameSync(tmp, file);
  return file;
}

async function preflightCutlineMcp(options) {
  const opts = options || {};
  const bridge = opts.bridge;
  if (!bridge || !bridge.url || !bridge.token) throw new Error("The live JV MCP bridge is not available. Keep JV open and try again.");
  let url;
  try {
    url = new URL(bridgeUrlForProfile(bridge.url, opts.profile));
  } catch {
    throw new Error("The live JV MCP bridge address is invalid.");
  }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password || url.search) throw new Error("The live JV MCP bridge address is invalid.");
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (opts.signal && opts.signal.aborted) abort();
  if (opts.signal) opts.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, opts.timeoutMs || 8000);
  let sessionId = "";
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: "Bearer " + bridge.token,
    "x-cutline-client": "cutline-acp-preflight",
    "x-cutline-harness": String(opts.harnessId || ""),
    // The probe is a few calls and then done. Without this the runtime keeps
    // the socket in its pool, and a later probe that reaches a restarted app
    // on the same port reuses the dead socket and fails with ECONNRESET.
    Connection: "close",
  };
  async function post(method, params, id) {
    const response = await fetch(url, {
      method: "POST", redirect: "error", headers,
      body: JSON.stringify({ jsonrpc: "2.0", method, params: params || {}, ...(id === undefined ? {} : { id }) }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("JV MCP preflight failed: HTTP " + response.status + ".");
    if (method === "initialize") {
      sessionId = response.headers.get("mcp-session-id") || "";
      if (sessionId) headers["Mcp-Session-Id"] = sessionId;
    }
    if (id === undefined) return;
    let reply;
    try {
      reply = await response.json();
    } catch {
      throw new Error("JV MCP preflight received an invalid " + method + " response.");
    }
    if (!reply || reply.id !== id || reply.error || !reply.result || typeof reply.result !== "object") throw new Error("JV MCP preflight failed during " + method + ".");
    return reply.result;
  }
  try {
    const init = await post("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "cutline-acp-preflight", version: "1.0.0" } }, 1);
    if (typeof init.protocolVersion !== "string" || !init.protocolVersion || !init.serverInfo || typeof init.serverInfo.name !== "string" || !init.capabilities || !init.capabilities.tools) throw new Error("JV MCP preflight received an invalid initialize response.");
    headers["MCP-Protocol-Version"] = init.protocolVersion;
    await post("notifications/initialized", {});
    const names = new Set();
    let cursor;
    for (let page = 0; page < 20; page++) {
      const result = await post("tools/list", cursor ? { cursor } : {}, page + 2);
      if (!Array.isArray(result.tools) || result.tools.some((tool) => !tool || typeof tool.name !== "string")) throw new Error("JV MCP preflight received an invalid tools/list response.");
      for (const tool of result.tools) names.add(tool.name);
      cursor = result.nextCursor;
      if (!cursor) break;
      if (page === 19) throw new Error("JV MCP preflight tools/list did not finish.");
    }
    if (!names.has(opts.profile === "cards" ? "cards_list" : "jeditor_app_state")) throw new Error("JV MCP preflight did not find the running app tools.");
    return { status: "ready", checkedAt: Date.now(), toolCount: names.size };
  } catch (error) {
    if (controller.signal.aborted) throw new Error(opts.signal && opts.signal.aborted ? "JV MCP preflight cancelled." : "JV MCP preflight timed out.");
    if (String(error.message || "").startsWith("JV MCP preflight")) throw error;
    throw new Error("JV MCP preflight could not reach the running app.");
  } finally {
    if (sessionId) {
      try {
        await fetch(url, { method: "DELETE", redirect: "error", headers, signal: AbortSignal.timeout(1000) });
      } catch {}
    }
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener("abort", abort);
  }
}

module.exports = { ACP_HARNESSES, ACP_MCP_NAME, acpHarness, listAcpHarnesses, acpSpawnSpec, cutlineMcpForAcp, cutlineMcpServersForAcp, drawMcpForAcp, writeCwdMcpConfig, preflightCutlineMcp, cursorAgentSpec, devinSpec, codexSpec, claudeCodeSpec };
