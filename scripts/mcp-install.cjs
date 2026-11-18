#!/usr/bin/env node
"use strict";

// Wires JV's MCP server into the coding agents a person already runs outside
// JV: a terminal, an IDE, T3 Code, or anything else that reads an MCP config.
//
// Outside agents get the same server JV's own chat gets, so they set projects
// up, edit them, render, and drive the open window exactly like an in-app
// agent. The entry always points at <data>/jeditor-mcp.cjs, never at an
// install folder: that path carries the app version and changes on update.
//
//   npm run mcp:install                       every client found here
//   npm run mcp:install -- --client claude,pi one or more clients
//   npm run mcp:install -- --all              every known client, even missing ones
//   npm run mcp:install -- --dry-run          show the plan, write nothing
//   npm run mcp:install -- --remove           take the entry back out
//   npm run mcp:install -- --json             print a snippet for any other client
//   npm run mcp:install -- --check            spawn the server and prove it works
//
// Adding an entry by hand is the same thing: a stdio server named `jeditor`
// running `node <data>/jeditor-mcp.cjs`.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { writeLauncher, LAUNCHER } = require("../lib/mcp-launcher");

const SERVER_NAME = "jeditor";
const HOME = os.homedir();
const APPDATA = process.env.APPDATA || path.join(HOME, "AppData", "Roaming");
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local");
const REPO_ROOT = path.join(__dirname, "..");

// The same stdio entry in the shape each client writes. Durations render in
// minutes, so the clients that take a tool timeout get thirty of them.
function stdioEntry(server, style) {
  const base = { command: server.command, args: server.args };
  if (style === "opencode") {
    return {
      type: "local",
      command: [server.command].concat(server.args),
      environment: {},
      enabled: true,
      timeout: 1800000,
    };
  }
  if (style === "claude") return { type: "stdio", command: server.command, args: server.args, env: {} };
  if (style === "droid") return { type: "stdio", command: server.command, args: server.args, env: {}, disabled: false };
  if (style === "timeout") return { command: server.command, args: server.args, env: {}, timeout: 1800000 };
  return Object.assign(base, { env: {} });
}

const CLIENTS = [
  {
    id: "claude",
    label: "Claude Code",
    bin: "claude",
    file: () => path.join(HOME, ".claude.json"),
    style: "claude",
    section: "mcpServers",
  },
  {
    id: "pi",
    label: "Pi",
    bin: "pi",
    file: () => path.join(HOME, ".pi", "agent", "mcp.json"),
    style: "plain",
    section: "mcpServers",
  },
  {
    id: "droid",
    label: "Droid",
    bin: "droid",
    file: () => path.join(HOME, ".factory", "mcp.json"),
    style: "droid",
    section: "mcpServers",
  },
  {
    id: "opencode",
    label: "OpenCode",
    bin: "opencode",
    file: () => path.join(HOME, ".config", "opencode", "opencode.json"),
    style: "opencode",
    section: "mcp",
  },
  {
    id: "cursor",
    label: "Cursor",
    bin: "cursor-agent",
    file: () => path.join(HOME, ".cursor", "mcp.json"),
    style: "plain",
    section: "mcpServers",
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    bin: "gemini",
    file: () => path.join(HOME, ".gemini", "settings.json"),
    style: "timeout",
    section: "mcpServers",
  },
  {
    id: "qwen",
    label: "Qwen Code",
    bin: "qwen",
    file: () => path.join(HOME, ".qwen", "settings.json"),
    style: "timeout",
    section: "mcpServers",
  },
  {
    id: "codex",
    label: "Codex CLI",
    bin: "codex",
    file: () => path.join(HOME, ".codex", "config.toml"),
    style: "toml",
  },
];

function usage() {
  return [
    "Usage: npm run mcp:install -- [options]",
    "",
    "  --client <ids>   comma separated: " + CLIENTS.map((c) => c.id).join(", "),
    "  --all            every known client, even ones not found here",
    "  --dry-run        print the plan, change nothing",
    "  --remove         delete the jeditor entry instead of adding it",
    "  --json           print the stdio snippet for any other MCP client",
    "  --check          spawn the server and prove a project can be made",
    "  --data-root <d>  JV data folder (default: the newest one this PC has)",
    "  --app-root <d>   JV install or checkout (default: from agent-bridge.json)",
  ].join("\n");
}

function parseArgs(argv) {
  const flags = { clients: [], all: false, dryRun: false, remove: false, json: false, check: false, dataRoot: "", appRoot: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const inline = String(arg).split("=").slice(1).join("=");
      if (inline) return inline;
      i += 1;
      return argv[i] || "";
    };
    if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg.startsWith("--client")) flags.clients.push(...String(value()).split(",").map((s) => s.trim()).filter(Boolean));
    else if (arg === "--all") flags.all = true;
    else if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--remove") flags.remove = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--check") flags.check = true;
    else if (arg.startsWith("--data-root")) flags.dataRoot = value();
    else if (arg.startsWith("--app-root")) flags.appRoot = value();
    else throw new Error("Unknown option " + arg + ". Run with --help to see the ones that exist.");
  }
  return flags;
}

function onPath(bin) {
  const exts = process.platform === "win32" ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").concat([""]) : [""];
  for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const file = path.join(dir, bin + ext);
      try {
        if (fs.statSync(file).isFile()) return file;
      } catch {
        /* not in this folder */
      }
    }
  }
  return "";
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function fileTime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

// The data folder is the one whose bridge file is newest: that is the JV the
// person actually uses, whether it is the installed app or the dev build.
function resolveDataRoot(flags) {
  if (flags.dataRoot) return path.resolve(flags.dataRoot);
  const fromEnv = process.env.JEDITOR_DATA_ROOT || process.env.CUTLINE_DATA_ROOT;
  if (fromEnv) return path.resolve(fromEnv);
  const candidates = ["JEditor", "JV Dev"]
    .map((name) => path.join(APPDATA, name, "data"))
    .filter((dir) => fs.existsSync(dir));
  if (!candidates.length) {
    throw new Error("No JV data folder found. Open JV once, or pass --data-root <folder>.");
  }
  candidates.sort((a, b) => fileTime(path.join(b, "agent-bridge.json")) - fileTime(path.join(a, "agent-bridge.json")));
  return candidates[0];
}

function hasServer(file) {
  return fs.existsSync(path.join(file, "lib", "mcp-stdio.js"));
}

function resolveAppRoot(flags, dataRoot) {
  if (flags.appRoot) {
    const root = path.resolve(flags.appRoot);
    if (!hasServer(root)) throw new Error(root + " is not a JV install or checkout (no lib/mcp-stdio.js).");
    return root;
  }
  const bridge = readJson(path.join(dataRoot, "agent-bridge.json"));
  const fromBridge = bridge && typeof bridge.appRoot === "string" ? bridge.appRoot : "";
  if (fromBridge && hasServer(fromBridge)) return fromBridge;
  const installed = path.join(LOCALAPPDATA, "Programs", "JEditor", "resources", "app");
  if (hasServer(installed)) return installed;
  if (hasServer(REPO_ROOT)) return REPO_ROOT;
  throw new Error("Could not find a JV install. Open JV once, or pass --app-root <folder>.");
}

function serverFor(dataRoot, appRoot) {
  return {
    command: process.execPath,
    args: [path.join(dataRoot, LAUNCHER)],
    appRoot,
    dataRoot,
  };
}

function writeJsonFile(file, config) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.copyFileSync(file, file + ".bak");
  } catch {
    /* first write, nothing to back up */
  }
  const tmp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

function installJson(client, server, dryRun) {
  const file = client.file();
  const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  let config = {};
  if (before.trim()) {
    config = readJson(file);
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new Error(file + " is not a JSON object, so it was left alone.");
    }
  }
  if (!config[client.section] || typeof config[client.section] !== "object" || Array.isArray(config[client.section])) {
    config[client.section] = {};
  }
  config[client.section][SERVER_NAME] = stdioEntry(server, client.style);
  const after = JSON.stringify(config, null, 2) + "\n";
  if (after === before && fs.existsSync(file)) return "already";
  if (!dryRun) writeJsonFile(file, config);
  return "added";
}

function removeJson(client, dryRun) {
  const file = client.file();
  if (!fs.existsSync(file)) return "missing";
  const config = readJson(file);
  if (!config || typeof config !== "object") return "unreadable";
  const section = config[client.section];
  if (!section || !Object.prototype.hasOwnProperty.call(section, SERVER_NAME)) return "absent";
  delete section[SERVER_NAME];
  if (!dryRun) writeJsonFile(file, config);
  return "removed";
}

// Codex is the one client with a TOML config, so its entry is written as a
// section. Replacing the whole `[mcp_servers.jeditor]` block keeps it idempotent.
function codexBlock(server) {
  return [
    "[mcp_servers." + SERVER_NAME + "]",
    "command = " + JSON.stringify(server.command),
    "args = [" + server.args.map((a) => JSON.stringify(a)).join(", ") + "]",
  ].join("\n");
}

function installToml(client, server, dryRun) {
  const file = client.file();
  const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const pattern = /^\[mcp_servers\.jeditor\][^\n]*\n(?:[^\[][^\n]*\n?)*/m;
  const block = codexBlock(server) + "\n";
  let after;
  if (pattern.test(before)) {
    after = before.replace(pattern, block);
  } else {
    after = before.replace(/\s*$/, "");
    after = (after ? after + "\n\n" : "") + block;
  }
  if (after === before && fs.existsSync(file)) return "already";
  if (!dryRun) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      fs.copyFileSync(file, file + ".bak");
    } catch {
      /* first write */
    }
    fs.writeFileSync(file, after, "utf8");
  }
  return "added";
}

function removeToml(client, dryRun) {
  const file = client.file();
  if (!fs.existsSync(file)) return "missing";
  const before = fs.readFileSync(file, "utf8");
  const pattern = /^\[mcp_servers\.jeditor\][^\n]*\n(?:[^\[][^\n]*\n?)*/m;
  if (!pattern.test(before)) return "absent";
  const after = before.replace(pattern, "").replace(/\n{3,}/g, "\n\n").replace(/\s*$/, "\n");
  if (!dryRun) fs.writeFileSync(file, after, "utf8");
  return "removed";
}

function clientState(client) {
  const file = client.file();
  if (!fs.existsSync(file)) return { file, present: false, installed: false };
  let installed = false;
  if (client.style === "toml") {
    installed = /^\[mcp_servers\.jeditor\]/m.test(fs.readFileSync(file, "utf8"));
  } else {
    const config = readJson(file);
    const section = config && config[client.section];
    installed = Boolean(section && section[SERVER_NAME]);
  }
  return { file, present: true, installed };
}

function detect(client) {
  const state = clientState(client);
  return state.present || Boolean(onPath(client.bin));
}

function apply(client, server, flags) {
  if (client.style === "toml") {
    return flags.remove ? removeToml(client, flags.dryRun) : installToml(client, server, flags.dryRun);
  }
  return flags.remove ? removeJson(client, flags.dryRun) : installJson(client, server, flags.dryRun);
}

function printSnippet(server) {
  const entry = stdioEntry(server, "claude");
  const snippet = { mcpServers: { [SERVER_NAME]: entry } };
  process.stdout.write(JSON.stringify(snippet, null, 2) + "\n");
}

// --- check -----------------------------------------------------------------

// A small MCP client over stdio. Newline framed, which the server answers in
// kind, and every request has a timeout so a hung server cannot hang the check.
function connect(command, args, env) {
  const child = spawn(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: Object.assign({}, process.env, env || {}),
    windowsHide: true,
  });
  let buffer = "";
  let nextId = 1;
  const pending = new Map();
  const stderr = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
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
      if (message.id != null && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr.push(chunk);
    if (stderr.length > 40) stderr.shift();
  });
  child.on("exit", (code) => {
    for (const [, settle] of pending) settle({ error: { message: "the server exited (" + code + "): " + stderr.join("").trim() } });
    pending.clear();
  });

  function request(method, params, timeoutMs) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(method + " got no reply in " + Math.round(timeoutMs / 1000) + " s"));
      }, timeoutMs || 30000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.error) reject(new Error(method + ": " + (message.error.message || JSON.stringify(message.error))));
        else resolve(message.result);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  // Closing waits for the process to exit: on Windows an open SQLite file
  // inside the scratch folder makes the folder impossible to remove.
  function close() {
    return new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode) return resolve();
      child.once("exit", () => resolve());
      try {
        child.stdin.end();
      } catch {
        /* already gone */
      }
      child.kill();
      setTimeout(resolve, 2000);
    });
  }

  return { child, request, close };
}

async function callTool(client, name, args) {
  const result = await client.request("tools/call", { name, arguments: args || {} }, 60000);
  const first = result && Array.isArray(result.content) ? result.content[0] : null;
  const text = first && first.text ? first.text : "";
  if (result && result.isError) throw new Error(name + ": " + text);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function runCheck(server) {
  const report = { server: "", handshake: null, tools: 0, live: false, project: {}, ok: false };

  // 1. The exact command an agent config holds, at the real data folder.
  //    tools/list only, so nothing in a real library can change.
  const configured = connect(server.command, server.args);
  try {
    const init = await configured.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "jv-mcp-install", version: "1.0.0" },
    });
    report.handshake = { server: init.serverInfo, protocol: init.protocolVersion };
    const list = await configured.request("tools/list", {});
    report.tools = Array.isArray(list.tools) ? list.tools.length : 0;
    // A bridge file can outlive the app, so a window tool in the list is what
    // proves JV is actually reachable, not the file.
    report.live = Array.isArray(list.tools) && list.tools.some((tool) => tool && tool.name === "jeditor_app_state");
    if (report.tools < 30) throw new Error("only " + report.tools + " tools were listed; the server looks half wired");
  } finally {
    await configured.close();
  }

  // 2. A whole project on a scratch data folder, so the check proves control
  //    without touching a real library.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "jv-mcp-check-"));
  const projectServer = connect(process.execPath, [
    path.join(server.appRoot, "lib", "mcp-stdio.js"),
    "--data-root",
    scratch,
    "--no-bridge",
  ]);
  try {
    await projectServer.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "jv-mcp-install", version: "1.0.0" },
    });
    const created = await callTool(projectServer, "jeditor_create_project", { name: "External MCP check" });
    const projectId = created && created.id ? created.id : created && created.project && created.project.id;
    if (!projectId) throw new Error("jeditor_create_project returned no id: " + JSON.stringify(created).slice(0, 300));
    const read = await callTool(projectServer, "jeditor_get_project", { projectId });
    if (!read || !read.id) throw new Error("jeditor_get_project did not return the new project");
    await callTool(projectServer, "jeditor_update_project", { projectId, name: "External MCP check, renamed" });
    const listed = await callTool(projectServer, "jeditor_list_projects", {});
    const rows = Array.isArray(listed) ? listed : (listed && listed.projects) || [];
    if (!rows.some((row) => row.id === projectId)) throw new Error("the new project was not in jeditor_list_projects");
    await callTool(projectServer, "jeditor_delete_project", { projectId, confirm: true });
    report.project = { created: true, read: true, updated: true, listed: true, deleted: true };
  } finally {
    await projectServer.close();
    try {
      fs.rmSync(scratch, { recursive: true, force: true });
    } catch {
      /* a leftover temp folder is not a failed check */
    }
  }

  report.server = [server.command].concat(server.args).join(" ");
  report.ok = true;
  return report;
}

// --- main ------------------------------------------------------------------

async function main(argv) {
  const flags = parseArgs(argv);
  if (flags.help) {
    process.stdout.write(usage() + "\n");
    return 0;
  }
  const dataRoot = resolveDataRoot(flags);
  const appRoot = resolveAppRoot(flags, dataRoot);
  const server = serverFor(dataRoot, appRoot);

  if (flags.json) {
    printSnippet(server);
    return 0;
  }

  // Write the launcher first. It is what the configs point at, and it works
  // before JV has ever started because the app root is baked in as a fallback.
  const launcher = flags.dryRun ? { launcher: path.join(dataRoot, LAUNCHER) } : writeLauncher(dataRoot, appRoot);
  if (flags.check) {
    const report = await runCheck(server);
    process.stdout.write(
      [
        "JV MCP check",
        "  server    " + report.server,
        "  handshake " + (report.handshake ? report.handshake.server.name + " " + report.handshake.server.version + ", protocol " + report.handshake.protocol : "none"),
        "  tools     " + report.tools + (report.live ? " (JV is running: window, browser and recording tools are live)" : " (JV is closed: project, library and render tools work, window tools wait)"),
        "  project   created, read, updated, listed, deleted in a scratch data folder",
        "  ok",
      ].join("\n") + "\n",
    );
    return 0;
  }

  const wanted = flags.all
    ? CLIENTS
    : flags.clients.length
      ? CLIENTS.filter((client) => flags.clients.includes(client.id))
      : CLIENTS.filter((client) => detect(client));
  if (flags.clients.length) {
    const unknown = flags.clients.filter((id) => !CLIENTS.some((client) => client.id === id));
    if (unknown.length) throw new Error("Unknown client " + unknown.join(", ") + ". Known: " + CLIENTS.map((c) => c.id).join(", ") + ".");
  }

  process.stdout.write(
    [
      "JV MCP",
      "  node      " + server.command,
      "  server    " + launcher.launcher,
      "  install   " + appRoot,
      "  data      " + dataRoot,
      "",
    ].join("\n"),
  );

  const lines = [];
  for (const client of wanted) {
    const state = clientState(client);
    let result = "skipped";
    let detail = "";
    try {
      result = apply(client, server, flags);
      detail = state.file.replace(HOME, "~");
    } catch (error) {
      result = "failed";
      detail = (error && error.message) || String(error);
    }
    lines.push("  " + (client.id + "        ").slice(0, 10) + " " + result.padEnd(9) + " " + detail);
  }
  const skipped = CLIENTS.filter((client) => !wanted.includes(client));
  process.stdout.write(lines.join("\n") + "\n");
  if (skipped.length) {
    process.stdout.write("\n  not here: " + skipped.map((client) => client.id).join(", ") + " (add one with --client <id>, or --all to create its config)\n");
  }
  if (flags.dryRun) process.stdout.write("\n  dry run: nothing was written\n");
  else process.stdout.write("\n  Agents see every tool once JV has been opened; the ones that drive the window work while it runs.\n");
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code || 0),
    (error) => {
      process.stderr.write("jv mcp:install: " + ((error && error.message) || error) + "\n");
      process.exit(1);
    },
  );
}

module.exports = { CLIENTS, parseArgs, resolveDataRoot, resolveAppRoot, stdioEntry, installJson, removeJson, installToml, removeToml, runCheck };
