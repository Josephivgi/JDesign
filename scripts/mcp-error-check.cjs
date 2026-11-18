#!/usr/bin/env node
"use strict";

// Checks what an agent gets back when a call is wrong: every tool is called
// once with no arguments, once with a made up id, and a few known bad shapes,
// all through the real stdio server on a scratch data root.
//   node scripts/mcp-error-check.cjs                 the main server
//   node scripts/mcp-error-check.cjs --profile cards the cards server
// A reply must be a real success or isError with { error: "<sentence>" }, the
// sentence must end with a period or a question mark, stay under 300
// characters, and carry no exception, temp path, "undefined" or error code on
// its own. Exits 1 on any failure.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const appRoot = path.join(__dirname, "..");
const CALL_TIMEOUT_MS = 25000;
const MAX_CHARS = 300;
const BANNED = [/undefined/, /\bNaN\b/, /\[object Object\]/, /at Object\./, /ENOENT/, /TypeError/];
const TEMP_PATH = /(?:[A-Za-z]:\\[^\s"]*\\(?:Temp|tmp)\\|^\/tmp\/)/i;

// The MCP profile to run: "" is the main server, "cards" the card studio's.
function profileFrom(argv) {
  const at = argv.indexOf("--profile");
  if (at === -1) return "";
  const value = String(argv[at + 1] || "");
  return value.startsWith("--") ? "" : value.trim();
}
const PROFILE = profileFrom(process.argv.slice(2));

function badWords(message) {
  const hits = BANNED.filter((re) => re.test(message)).map((re) => String(re));
  if (TEMP_PATH.test(message)) hits.push("temp path");
  // A capitalised tool name followed by a colon is an internal label, not a
  // sentence ("JeditorGetCard: card is required").
  if (/^[A-Za-z][A-Za-z0-9_]*:\s/.test(message)) hits.push("tool name prefix");
  return hits;
}

// The server reads newline framed JSON and answers in the same framing.
function makeClient(child) {
  let buffer = "";
  const pending = new Map();
  child.stdout.on("data", (chunk) => {
    buffer += String(chunk);
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const entry = pending.get(message.id);
      if (entry) {
        pending.delete(message.id);
        clearTimeout(entry.timer);
        entry.resolve(message);
      }
    }
  });
  let nextId = 1;
  return {
    call(method, params) {
      const id = "c" + nextId++;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve({ timeout: true });
        }, CALL_TIMEOUT_MS);
        pending.set(id, { resolve, timer });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    },
    stop() {
      try {
        child.stdin.end();
      } catch {
        /* already gone */
      }
    },
  };
}

function fakeValue(schema) {
  if (!schema || typeof schema !== "object") return "does-not-exist";
  if (schema.type === "array") return [];
  if (schema.type === "number" || schema.type === "integer") return 1;
  if (schema.type === "boolean") return true;
  if (schema.type === "object") return {};
  return "does-not-exist";
}

function fakeArgs(spec) {
  const schema = spec.inputSchema || {};
  const required = schema.required || [];
  const args = {};
  for (const key of required) args[key] = fakeValue((schema.properties || {})[key]);
  return args;
}

function summarise(args) {
  const text = JSON.stringify(args);
  return text.length > 44 ? text.slice(0, 41) + "..." : text;
}

function inspect(reply) {
  if (reply && reply.timeout) return { ok: false, why: "no answer within " + CALL_TIMEOUT_MS / 1000 + "s" };
  if (reply && reply.error) {
    const message = (reply.error && reply.error.message) || "";
    return { ok: false, why: "JSON-RPC error instead of {error}: " + message.slice(0, 120) };
  }
  const result = reply && reply.result;
  if (!result || !Array.isArray(result.content)) return { ok: false, why: "reply has no content" };
  if (!result.isError) return { ok: true, why: "success" };
  const text = (result.content[0] && result.content[0].text) || "";
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return { ok: false, why: "error text is not JSON: " + JSON.stringify(text.slice(0, 120)) };
  }
  const message = payload && typeof payload.error === "string" ? payload.error.trim() : "";
  if (!message) return { ok: false, why: "error payload has no error string: " + JSON.stringify(text.slice(0, 120)) };
  const problems = [];
  if (!/[.?]$/.test(message)) problems.push("no ending period or question mark");
  if (message.length > MAX_CHARS) problems.push(message.length + " characters");
  const words = badWords(message);
  if (words.length) problems.push(words.join(", "));
  return { ok: !problems.length, why: problems.join(", "), message };
}

async function main() {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jv-mcp-errors-"));
  const child = spawn(
    process.execPath,
    [path.join(appRoot, "lib", "mcp-stdio.js"), "--no-bridge", "--data-root", dataRoot, "--app-root", appRoot].concat(
      PROFILE ? ["--profile", PROFILE] : [],
    ),
    {
      cwd: appRoot,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: Object.assign({}, process.env, { JEDITOR_DATA_ROOT: dataRoot, CUTLINE_DATA_ROOT: dataRoot }),
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
    if (stderr.length > 20000) stderr = stderr.slice(-8000);
  });
  const client = makeClient(child);

  const init = await client.call("initialize", {
    protocolVersion: "2024-11-05",
    clientInfo: { name: "mcp-error-check", version: "1.0.0" },
    capabilities: {},
  });
  if (!init || !init.result) {
    // No handshake means every later call would sit on its timeout, so stop
    // here and show what the server said on stderr.
    console.log("FAIL init    the stdio server did not answer initialize" + (stderr ? ": " + stderr.slice(-400) : ""));
    client.stop();
    process.exitCode = 1;
    return;
  }
  const listed = await client.call("tools/list", {});
  const tools = (listed.result && listed.result.tools) || [];
  if (!tools.length) {
    console.log("FAIL list    tools/list returned nothing" + (stderr ? ": " + stderr.slice(-400) : ""));
    client.stop();
    process.exitCode = 1;
    return;
  }

  const calls = [];
  for (const spec of tools) {
    calls.push({ tool: spec.name, label: "no arguments", args: {} });
    const args = fakeArgs(spec);
    if (Object.keys(args).length) calls.push({ tool: spec.name, label: "made up id", args });
  }
  // Known bad shapes: an object where a string belongs, a string where an
  // object belongs, and arguments that are a string instead of an object.
  const byName = new Map(tools.map((spec) => [spec.name, spec]));
  const shapes = [
    ["jeditor_get_card", { cardId: 42 }],
    ["jeditor_apply_edit", { patch: "a string" }],
    ["jeditor_get_library_item", { id: "" }],
    // The cards server's own closed value sets.
    ["cards_get", { cardId: 42 }],
    ["cards_set_block_layout", { cardId: "does-not-exist", field: "title" }],
    ["cards_set_style", { cardId: "does-not-exist", durationMs: 50 }],
    ["cards_update", { cardId: "does-not-exist", patch: { colors: { accent: "#ffffff" } } }],
    ["cards_get_skill", { name: "no-such-skill" }],
  ];
  for (const [name, args] of shapes) if (byName.has(name)) calls.push({ tool: name, label: "bad shape", args });
  if (byName.has("jeditor_get_card")) calls.push({ tool: "jeditor_get_card", label: "bad args type", args: "not an object" });

  let failures = 0;
  let successes = 0;
  let refusals = 0;
  for (const entry of calls) {
    const reply = await client.call("tools/call", { name: entry.tool, arguments: entry.args });
    const verdict = inspect(reply);
    if (verdict.ok) {
      if (verdict.why === "success") successes++;
      else refusals++;
    } else failures++;
    const head = (verdict.ok ? "ok   " : "FAIL ") + entry.tool.padEnd(34) + entry.label.padEnd(14) + summarise(entry.args);
    console.log(head);
    if (!verdict.ok) {
      console.log("      " + verdict.why);
      if (verdict.message) console.log("      message: " + verdict.message);
    }
  }

  client.stop();
  console.log(
    (PROFILE ? "profile " + PROFILE + ": " : "") +
      tools.length +
      " tools, " +
      calls.length +
      " calls: " +
      successes +
      " succeeded, " +
      refusals +
      " refused with a sentence, " +
      failures +
      " failed the standard",
  );
  process.exitCode = failures ? 1 : 0;
}

main().catch((error) => {
  console.log("FAIL run     " + (error && error.message ? error.message : error));
  process.exitCode = 1;
});
