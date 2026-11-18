#!/usr/bin/env node
"use strict";

// Live ACP check against the installed agent CLIs (no Cutline window needed):
//   node scripts/acp-live-check.cjs cursor|devin|editorpi [--prompt]
// Starts the agent over ACP, passes the Cutline MCP in session/new, and with
// --prompt asks it to call jeditor_list_workspaces, then reads the activity log.
// Marketplace agents (cursor, codex, claude-code, gemini, ...) are added to the
// throwaway data root first so the harness resolves.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AcpClient } = require("../lib/acp-client");
const { acpSpawnSpec, cutlineMcpForAcp, writeCwdMcpConfig } = require("../lib/acp-harnesses");
const { listActions } = require("../lib/agent-activity");

async function main() {
  const harnessId = process.argv[2] || "cursor";
  const wantPrompt = process.argv.includes("--prompt");
  const appRoot = path.join(__dirname, "..");
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cutline-acp-live-"));
  const { addCatalogAgent } = require("../lib/acp-marketplace");
  try {
    addCatalogAgent(dataRoot, harnessId);
  } catch {
    /* shipped harness or unknown id; acpSpawnSpec reports it */
  }
  const cwd = path.join(dataRoot, "agent-workspace");
  fs.mkdirSync(cwd, { recursive: true });
  const spec = acpSpawnSpec(harnessId, { appRoot, dataRoot });
  writeCwdMcpConfig(harnessId, cwd, cutlineMcpForAcp({ dataRoot, appRoot, harnessId }));
  const updates = [];
  const tools = [];
  let reply = "";
  const onUpdate = (p) => {
    const u = (p && p.update) || {};
    updates.push(u.sessionUpdate);
    if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") tools.push({ id: u.toolCallId, title: u.title, status: u.status });
    if (u.sessionUpdate === "agent_message_chunk" && u.content && u.content.text) reply += u.content.text;
  };
  const client = new AcpClient({ harnessId, dataRoot, appRoot, cwd, onUpdate });
  // Both spellings, so the check exercises the same env the app passes.
  client.start({ command: spec.command, args: spec.args, cwd, env: Object.assign({ JEDITOR_DATA_ROOT: dataRoot, CUTLINE_DATA_ROOT: dataRoot, JEDITOR_HARNESS: harnessId, CUTLINE_HARNESS: harnessId }, spec.env) });
  let stderr = "";
  client.child.stderr.on("data", (c) => (stderr = (stderr + c).slice(-3000)));
  const out = { harnessId, command: spec.command };
  try {
    const init = await client.initialize();
    out.agent = init && init.agentInfo;
    out.mcpCapabilities = init && init.agentCapabilities && init.agentCapabilities.mcpCapabilities;
    out.authMethods = ((init && init.authMethods) || []).map((m) => m.id);
    const mcp = cutlineMcpForAcp({ dataRoot, appRoot, harnessId, agentCapabilities: init && init.agentCapabilities });
    // A plain node binary runs the stdio MCP; process.execPath is node here.
    const created = await client.request("session/new", { cwd, mcpServers: [mcp] });
    out.sessionId = created && created.sessionId;
    if (wantPrompt) {
      const result = await client.request(
        "session/prompt",
        {
          sessionId: out.sessionId,
          prompt: [{ type: "text", text: "Call the MCP tool jeditor_list_workspaces from the jeditor-app MCP server once, then reply with the workspace name only." }],
        },
        420000,
      );
      out.stopReason = result && result.stopReason;
      out.updates = Array.from(new Set(updates));
      out.tools = tools;
      out.reply = reply.slice(0, 500);
      out.activity = listActions(dataRoot).map((row) => ({ tool: row.tool, client: row.client, harness: row.harness, ok: row.ok }));
    }
    out.ok = true;
  } catch (error) {
    out.ok = false;
    out.error = error.message;
    out.updates = Array.from(new Set(updates));
    out.tools = tools;
    out.reply = reply.slice(0, 500);
    out.activity = listActions(dataRoot).map((row) => ({ tool: row.tool, client: row.client, harness: row.harness, ok: row.ok }));
    out.stderr = stderr.trim().split("\n").slice(-5).join("\n");
  } finally {
    client.stop();
  }
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  process.exit(out.ok ? 0 : 1);
}

main();
