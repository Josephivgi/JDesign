#!/usr/bin/env node
"use strict";

// Checks every MCP tool surface JV runs, so slop cannot creep back in:
//   node scripts/mcp-tools-check.cjs
// Loads the same spec sources the servers load: base tools from
// lib/mcp-server.js, the rest from lib/agent-tools.js, then the two profile
// servers in lib/card-editor-tools.js and lib/content-research-tools.js. Fails
// on a tool name that repeats inside one server, a missing or long
// description, an undocumented parameter, a skill that calls a tool the agent
// surface does not have, and a skill that still uses an old cutline_ name.
// Exits 1 on any failure, so it can run in a script before a release.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createMcpHandler } = require("../lib/mcp-server");
const { agentToolSpecs } = require("../lib/agent-tools");
const { cardEditorSpecs } = require("../lib/card-editor-tools");
const { contentResearchToolSpecs } = require("../lib/content-research-tools");

const appRoot = path.join(__dirname, "..");
// The agent surface is one server to an agent, so it gets the looser limit the
// two rounds held it to. The profile servers are graded against the tighter
// bar they were written to.
const MAX_DESCRIPTION = { base: 400, agent: 400, cards: 300, content: 300 };

// Old tool names, and what an agent should call now. Only the ones that were
// removed need a real target; the rest of the rename is a prefix swap. Kept so
// a stale skill mention fails with the name to use instead.
const RETIRED = new Map([
  ["cutline_add_video", "jeditor_add_files"],
  ["cutline_get_media", "jeditor_get_media"],
  ["cutline_list_card_templates", "jeditor_template_store_list"],
  ["cutline_set_card_style", "jeditor_apply_edit"],
  ["cutline_set_card_text", "jeditor_apply_edit"],
]);

function newToolName(old) {
  return RETIRED.get(old) || old.replace(/^cutline_/, "jeditor_");
}

// Base tools come through the handler so this check reads the same list an
// agent gets from tools/list, not a second copy of the definitions.
async function baseToolSpecs() {
  const dataRoot = path.join(os.tmpdir(), "jv-mcp-tools-check");
  const handler = createMcpHandler({ dataRoot, appRoot, extraTools: [], baseTools: true });
  const reply = await handler.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }, {});
  const tools = reply && reply.result && reply.result.tools;
  if (!Array.isArray(tools)) throw new Error("tools/list returned no tools");
  return tools;
}

// A repeat inside one server breaks the tool lookup. The same suffix on two
// different servers (cards_* and jeditor_* for the same concept) is a design
// question, not a broken build, so each server is checked on its own.
function checkNames(specs) {
  const seen = new Map();
  for (const spec of specs) seen.set(spec.name, (seen.get(spec.name) || 0) + 1);
  const repeats = [...seen].filter(([, count]) => count > 1).map(([name]) => name);
  return {
    ok: repeats.length === 0,
    line:
      specs.length +
      " tools, " +
      (repeats.length ? repeats.length + " repeated: " + repeats.join(" ") : "no repeated names"),
  };
}

// A bridge tool with the same name as a local one makes the answer depend on
// which side is up. The names must stay disjoint.
function checkBridgeCollisions(toolNames) {
  const bridge = bridgeToolNames();
  const collisions = [...bridge].filter((name) => toolNames.has(name));
  return {
    ok: collisions.length === 0,
    line: collisions.length
      ? collisions.length + " names in both the bridge and the local tools: " + collisions.join(" ")
      : bridge.size + " live bridge tools, none shadowed by a local tool",
  };
}

function checkDescriptions(specs, max) {
  const missing = specs.filter((spec) => !spec.description || !spec.description.trim()).map((spec) => spec.name);
  const long = specs
    .filter((spec) => spec.description && spec.description.length > max)
    .map((spec) => spec.name + ":" + spec.description.length);
  const ok = !missing.length && !long.length;
  const parts = [];
  if (missing.length) parts.push(missing.length + " with no description: " + missing.join(" "));
  if (long.length) parts.push(long.length + " over " + max + ": " + long.join(" "));
  return { ok, line: ok ? "every description under " + max + " characters" : parts.join(", ") };
}

function checkParameters(specs) {
  const bare = [];
  for (const spec of specs) {
    const properties = (spec.inputSchema && spec.inputSchema.properties) || {};
    for (const [key, value] of Object.entries(properties)) {
      // a nested object carries its own properties, which get checked by hand
      if (value && typeof value === "object" && !value.description && value.type !== "object") {
        bare.push(spec.name + "." + key);
      }
    }
  }
  const ok = !bare.length;
  return {
    ok,
    line: ok
      ? "every parameter has a description"
      : bare.length + " parameters with no description: " + bare.slice(0, 20).join(" ") + (bare.length > 20 ? " ..." : ""),
  };
}

function skillFiles(dir) {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...skillFiles(full));
    else if (entry.name === "SKILL.md") out.push(full);
  }
  return out;
}

// The bridge names are read from its source, not required, so this check runs
// without Electron.
function bridgeToolNames() {
  let text = "";
  try {
    text = fs.readFileSync(path.join(appRoot, "electron", "agent-bridge.cjs"), "utf8");
  } catch {
    return new Set();
  }
  const names = new Set();
  for (const match of text.matchAll(/name:\s*"(jeditor_[a-z0-9_]+)"/g)) names.add(match[1]);
  return names;
}

// Every tool is jeditor_ now, so a skill that still says cutline_ is stale even
// when the old name never existed in a spec. The cutline:// scheme and the
// CUTLINE_ variables do not match the pattern.
function checkSkills(toolNames) {
  const files = skillFiles(path.join(appRoot, "skills"));
  files.push(path.join(appRoot, "AGENTS.md"));
  const bridge = bridgeToolNames();
  const stale = [];
  const unknown = [];
  let mentions = 0;
  for (const file of files) {
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const rel = path.relative(appRoot, file);
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const match of line.matchAll(/(?:jeditor|cutline)_[a-z0-9_]+/g)) {
        mentions++;
        const name = match[0];
        if (name.startsWith("cutline_")) {
          stale.push(rel + ":" + (index + 1) + " " + name + " -> " + newToolName(name));
          continue;
        }
        if (toolNames.has(name) || bridge.has(name)) continue;
        unknown.push(rel + ":" + (index + 1) + " " + name);
      }
    });
  }
  const ok = !stale.length && !unknown.length;
  const parts = [];
  if (stale.length) parts.push(stale.length + " old cutline_ names: " + stale.slice(0, 5).join(", "));
  if (unknown.length) parts.push(unknown.length + " unknown jeditor_ names: " + unknown.slice(0, 5).join(", "));
  return {
    ok,
    line: ok
      ? mentions + " tool mentions in " + files.length + " files, all jeditor_ and all known"
      : parts.join("; "),
  };
}

async function main() {
  const base = await baseToolSpecs();
  const agent = agentToolSpecs();
  const cards = cardEditorSpecs();
  const content = contentResearchToolSpecs();
  const servers = [
    ["base", base],
    ["agent", agent],
    ["cards", cards],
    ["content", content],
  ];
  // What one agent sees when it talks to JV: the base tools, the agent tools,
  // and the bridge. The profile servers are separate surfaces with their own
  // skills, so the skill scan only has to know about this set.
  const agentFacing = new Set(base.concat(agent).map((spec) => spec.name));

  const results = [];
  for (const [label, specs] of servers) {
    const max = MAX_DESCRIPTION[label];
    for (const check of [checkNames(specs), checkDescriptions(specs, max), checkParameters(specs)]) {
      results.push([label, check]);
    }
  }
  results.push(["skills", checkSkills(agentFacing)]);
  results.push(["bridge", checkBridgeCollisions(agentFacing)]);

  let failed = 0;
  for (const [label, result] of results) {
    if (!result.ok) failed++;
    console.log((result.ok ? "ok   " : "FAIL ") + label.padEnd(8) + result.line);
  }
  console.log(
    "jv mcp tools: " +
      servers.map(([label, specs]) => specs.length + " " + label).join(", ") +
      ", " +
      failed +
      " check(s) failed",
  );
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.log("FAIL load  " + (err && err.message ? err.message : err));
  process.exitCode = 1;
});
