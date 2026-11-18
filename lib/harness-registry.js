"use strict";

// Every agent JV runs is an outside agent over ACP (acp-harnesses.js and
// the ACP marketplace). There is no built-in harness to spawn, so this module
// keeps only the shared session/MCP helpers the ACP client needs.

const path = require("path");

function mcpScriptPath(appRoot) {
  return path.join(appRoot || path.join(__dirname, ".."), "lib", "mcp-stdio.js");
}

function cutlineMcpServer(options) {
  const opts = options || {};
  const appRoot = opts.appRoot || path.join(__dirname, "..");
  const dataRoot = opts.dataRoot;
  if (!dataRoot) throw new Error("dataRoot is required for JV MCP");
  return {
    // Matches ACP_MCP_NAME in acp-harnesses.js, so an agent sees one server
    // name whether the session came from the host or the client.
    name: "jeditor-app",
    command: opts.nodePath || process.execPath,
    args: [mcpScriptPath(appRoot), "--data-root", dataRoot, "--app-root", appRoot],
    env: Object.assign(
      // Both spellings: the renamed one is read first, the old one keeps any
      // script or config written before the rename working.
      { JEDITOR_DATA_ROOT: dataRoot, CUTLINE_DATA_ROOT: dataRoot },
      opts.videoId ? { JEDITOR_VIDEO_ID: String(opts.videoId), CUTLINE_VIDEO_ID: String(opts.videoId) } : {},
      opts.cardId ? { JEDITOR_CARD_ID: String(opts.cardId), CUTLINE_CARD_ID: String(opts.cardId) } : {},
    ),
  };
}

function acpEnvList(env) {
  return Object.entries(env || {}).map(([name, value]) => ({ name, value: String(value) }));
}

function acpSessionNewParams(options) {
  const opts = options || {};
  const server = cutlineMcpServer(opts);
  return {
    cwd: opts.cwd || opts.dataRoot,
    mcpServers: [
      {
        name: server.name,
        command: server.command,
        args: server.args,
        env: acpEnvList(server.env),
      },
    ],
  };
}

function acpSessionLoadParams(options) {
  const params = acpSessionNewParams(options);
  if (options && options.sessionId) params.sessionId = options.sessionId;
  return params;
}

module.exports = {
  mcpScriptPath,
  cutlineMcpServer,
  acpEnvList,
  acpSessionNewParams,
  acpSessionLoadParams,
};
