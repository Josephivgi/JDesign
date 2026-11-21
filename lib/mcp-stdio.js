#!/usr/bin/env node
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createMcpHandler } = require("./mcp-server");
const { cardEditorSpecs, cardEditorInstructions, SERVER_NAME } = require("./card-editor-tools");
const { bridgeUrlForProfile } = require("./card-assistant");
const {
  CONTENT_RESEARCH_MCP_NAME,
  CONTENT_RESEARCH_INSTRUCTIONS,
  contentResearchToolSpecs,
  unavailableContentResearchBrowser,
} = require("./content-research-tools");

function argValue(argv, name) {
  const index = argv.indexOf(name);
  if (index >= 0 && argv[index + 1]) return argv[index + 1];
  const prefix = name + "=";
  const hit = argv.find((item) => item.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : "";
}

function defaultDataRoot() {
  const base = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  // JDesign is this app; the older JEditor folders stay as fallbacks for
  // configs written before the rename.
  for (const name of ["JDesign", "JDesign Dev", "JEditor", "JV Dev"]) {
    const dir = path.join(base, name, "data");
    if (fs.existsSync(dir)) return dir;
  }
  return path.join(base, "JDesign", "data");
}

// The renamed spelling is read first, the old one second, so agent configs and
// scripts written before the rename keep working.
function env(name) {
  return process.env["JEDITOR_" + name] || process.env["CUTLINE_" + name] || "";
}

function parseDataRoot(argv) {
  return (
    argValue(argv, "--data-root") ||
    env("DATA_ROOT")
  );
}

// Every proxied message looks the bridge up. The file only changes when the
// app starts or stops, so a stat decides whether to read and parse it again.
const bridgeCache = new Map();

function readBridge(dataRoot) {
  const file = path.join(dataRoot, "agent-bridge.json");
  try {
    const stat = fs.statSync(file);
    const hit = bridgeCache.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.info;
    let info = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!info || !info.pid || !info.url || !info.token) info = null;
    bridgeCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, info });
    return info;
  } catch {
    bridgeCache.delete(file);
    return null;
  }
}

// A bridge that times out is skipped for 30 s so a hung app does not add the
// timeout wait to every message.
let bridgeDownUntil = 0;

// Reads one SSE frame stream (the bridge answers a tools/call that carries a
// progressToken this way). Progress notifications go to onProgress as they
// arrive so the client keeps seeing signs of life; the JSON-RPC message whose
// id matches the request is the reply. Any other id-bearing message (a
// server-initiated request) is forwarded to the client, not swallowed.
async function readSseReply(res, onProgress, requestId) {
  const reader = res.body && res.body.getReader ? res.body.getReader() : null;
  if (!reader) return undefined;
  const decoder = new TextDecoder();
  let buf = "";
  let reply;
  const take = (msg) => {
    if (msg && typeof msg === "object" && msg.id === requestId) {
      reply = msg;
    } else if (msg && typeof msg === "object" && typeof onProgress === "function") {
      try {
        onProgress(msg);
      } catch {
        /* a client that cannot hear progress still gets the reply */
      }
    }
  };
  const frames = (text) => {
    buf += text;
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        try {
          take(JSON.parse(line.slice(5).trim()));
        } catch {
          /* a frame that is not JSON is skipped, not fatal */
        }
      }
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      frames(decoder.decode(value, { stream: true }));
    }
    frames(decoder.decode());
  } catch (error) {
    // A reply that already arrived survives a torn stream.
    if (reply) return reply;
    // A stream that dies mid-call may have run the tool; never rerun locally.
    // Keep the request id so the client's pending call can resolve.
    return {
      jsonrpc: "2.0",
      id: requestId === undefined ? null : requestId,
      error: { code: -32603, message: "JV app error: the stream closed before the reply. The tool may have run; check before retrying." },
    };
  }
  return reply;
}

// Sends one JSON-RPC message to the running app. Returns undefined when the
// caller should fall back to the file-backed tools.
async function postToBridge(info, message, headers, session, onProgress) {
  const isCall = message && message.method === "tools/call";
  // Tool calls can run long and must not run twice, so they get no timeout
  // and no fallback once the app has answered. Every other message fails over
  // fast so a hung app cannot stall the handshake.
  const timeoutMs = isCall ? 0 : Number(env("BRIDGE_TIMEOUT_MS")) || 5000;
  let timedOut = false;
  let timer;
  let res;
  try {
    const controller = timeoutMs ? new AbortController() : null;
    if (controller) {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
    }
    try {
      res = await fetch(info.url, {
        method: "POST",
        headers: Object.assign(
          {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            Authorization: "Bearer " + info.token,
          },
          headers || {},
          session && session.id ? { "Mcp-Session-Id": session.id } : {},
        ),
        body: JSON.stringify(message),
        signal: controller ? controller.signal : undefined,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    if (timedOut) bridgeDownUntil = Date.now() + 30000;
    if (isCall && !(error && error.cause && error.cause.code === "ECONNREFUSED")) {
      // ECONNREFUSED means the app is not listening, so the request never ran
      // and a local fallback is safe. Anything else (reset, hangup) may have
      // reached the app, and a silent local rerun could run the tool twice.
      return {
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32603,
          message: "JV app error: the connection closed before the reply. The tool may have run; check before retrying.",
        },
      };
    }
    return undefined;
  }
  // The bridge opens a session on initialize. Sending it back reuses that
  // handler instead of building a new one for every later message.
  const sid = res.headers && res.headers.get && res.headers.get("mcp-session-id");
  if (sid && session) session.id = sid;
  if (res.status === 202) return null;
  if (res.status === 401 || res.status === 404) return undefined;
  let body;
  if (/text\/event-stream/i.test(String(res.headers.get("content-type") || ""))) {
    body = await readSseReply(res, onProgress, message && message.id);
  } else {
    const text = await res.text();
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = undefined;
    }
  }
  if (body !== undefined && body !== null && typeof body !== "object") body = undefined;
  const hasId = message && message.id !== undefined && message.id !== null;
  if (body === undefined || (body === null && hasId) || !res.ok) {
    // The app answered but not with a usable reply. A tool call gets a
    // JSON-RPC error (never a local rerun); anything else falls back.
    if (isCall) {
      const detail =
        (body && (typeof body.error === "string" ? body.error : (body.error && body.error.message))) || "HTTP " + res.status;
      return { jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "JV app error: " + detail } };
    }
    return undefined;
  }
  return body;
}

function createProxyHandler(options) {
  const { dataRoot, appRoot } = options;
  const { agentToolSpecs } = require("./agent-tools");
  const { recordAction, callProjectId } = require("./agent-activity");
  const harness = env("HARNESS");
  const harnessKey = env("HARNESS_KEY");
  const cards = options.profile === "cards";
  const contentResearch = options.profile === "content-research";
  let client = "";
  const local = createMcpHandler({
    dataRoot,
    appRoot,
    extraTools: cards
      ? cardEditorSpecs()
      : contentResearch
        ? contentResearchToolSpecs({ getBrowser: unavailableContentResearchBrowser })
        : agentToolSpecs(),
    baseTools: !cards && !contentResearch,
    serverName: cards ? SERVER_NAME : contentResearch ? CONTENT_RESEARCH_MCP_NAME : undefined,
    instructions: cards ? cardEditorInstructions : contentResearch ? CONTENT_RESEARCH_INSTRUCTIONS : undefined,
    onToolCall(call) {
      // The note tool already wrote its own "note" row.
      if (call.ok && call.name === "jeditor_record_note") return;
      try {
        const args = call.args || {};
        const text = call.result && call.result.content && call.result.content[0] && call.result.content[0].text;
        recordAction(dataRoot, {
          tool: call.name,
          client: call.client || client,
          harness,
          projectId: callProjectId(call),
          workspaceId: args.workspaceId || "",
          args,
          ok: call.ok,
          summary: String(text || (call.error && call.error.message) || "").slice(0, 240),
          durationMs: call.durationMs,
        });
      } catch {
        /* logging never blocks the tool */
      }
    },
  });
  const bridgeLookup = options.readBridge || readBridge;
  // The ACP session sets these when it spawns this stdio server; they bind
  // the agent to the project the user has open.
  const sessionProjectId = String(env("PROJECT_ID")).trim();
  const sessionWorkspaceId = String(env("WORKSPACE_ID")).trim();
  const sessionChatId = String(env("CHAT_ID")).trim();
  let session = { owner: "", id: "" };
  // The last tool list the app sent. The file-backed fallback has fewer
  // tools (no live app tools), so answering a list with it while the app is
  // only slow made tools vanish from the agent and come back 30 s later.
  let lastBridgeList = null;
  let localNames = null;
  async function isLiveOnlyTool(name) {
    if (!name || !lastBridgeList.tools.some((t) => t && t.name === name)) return false;
    if (!localNames) {
      const listed = await local.handle({ jsonrpc: "2.0", id: "local-names", method: "tools/list" }, {
        projectId: sessionProjectId,
        workspaceId: sessionWorkspaceId,
        chatId: sessionChatId,
      });
      localNames = new Set(((listed && listed.result && listed.result.tools) || []).map((t) => t.name));
    }
    return !localNames.has(name);
  }

  async function handle(message, emit) {
    if (message && message.method === "initialize") {
      const info = (message.params && message.params.clientInfo) || {};
      if (info.name) client = String(info.name) + (info.version ? " " + info.version : "");
    }
    // After a timeout the app is skipped for 30 s, but a call to a tool only
    // the live app has must still reach it: the local fallback would just
    // answer "unknown tool".
    const liveOnly = Boolean(
      message && message.method === "tools/call" && lastBridgeList &&
        (await isLiveOnlyTool(message.params && message.params.name)),
    );
    const bridge = Date.now() < bridgeDownUntil && !liveOnly ? null : bridgeLookup(dataRoot);
    if (bridge) {
      // A restarted app has a new token and forgets old sessions.
      const owner = bridge.url + " " + bridge.token + " " + bridge.pid + " " + (bridge.startedAt || "");
      if (session.owner !== owner) session = { owner, id: "" };
      const reply = await postToBridge(options.profile ? Object.assign({}, bridge, { url: bridgeUrlForProfile(bridge.url, options.profile) }) : bridge, message, {
        "x-cutline-client": client,
        "x-cutline-harness": harness,
        "x-cutline-harness-key": harnessKey,
        "x-cutline-project-id": sessionProjectId,
        "x-cutline-workspace-id": sessionWorkspaceId,
        "x-cutline-chat-id": sessionChatId,
      }, session, emit);
      if (reply !== undefined) {
        if (message && message.method === "tools/list" && reply && reply.result && Array.isArray(reply.result.tools)) lastBridgeList = reply.result;
        return reply;
      }
    }
    if (message && message.method === "tools/list" && lastBridgeList && bridgeLookup(dataRoot)) {
      return { jsonrpc: "2.0", id: message.id, result: lastBridgeList };
    }
    return local.handle(message, { projectId: sessionProjectId, workspaceId: sessionWorkspaceId, chatId: sessionChatId });
  }

  return { handle, local };
}

function createFramedIo(handler, stdin, stdout) {
  let buffer = Buffer.alloc(0);
  let framing = "header";
  stdin.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    try {
      processBuffer();
    } catch (error) {
      // A malformed frame must not take the server down: drop the pending
      // bytes and keep serving. Agents see a dead MCP pipe as a closed
      // writable stream and block every tool call after it.
      buffer = Buffer.alloc(0);
      process.stderr.write("jeditor-mcp: dropped an unreadable frame: " + (error && error.message ? error.message : error) + "\n");
    }
  });
  // The agent closed our input or died; a stdio server with no client is an
  // orphan, so exit rather than linger holding the data root.
  stdin.on("end", () => process.exit(0));
  stdin.on("error", () => process.exit(0));
  stdout.on("error", () => process.exit(0));

  function processBuffer() {
    while (buffer.length) {
      const nl = indexOfNewline(buffer);
      const firstLine = buffer.slice(0, nl === -1 ? undefined : nl).toString("utf8");
      if (/^\s*content-length\s*:/i.test(firstLine.trim())) {
        // Only a leading Content-Length line starts a framed message. Searching
        // for "\r\n\r\n" first would swallow newline-framed messages buffered
        // ahead of a framed one, which arrive in the same chunk.
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;
        const header = buffer.slice(0, headerEnd).toString("utf8");
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          buffer = buffer.slice(headerEnd + 4);
          continue;
        }
        const length = Number(match[1]);
        const start = headerEnd + 4;
        if (buffer.length < start + length) return;
        const body = buffer.slice(start, start + length).toString("utf8");
        buffer = buffer.slice(start + length);
        framing = "header";
        dispatch(body);
        continue;
      }
      if (nl === -1) return;
      const line = firstLine.trim();
      buffer = buffer.slice(nl + 1);
      if (line) {
        framing = "ndjson";
        dispatch(line);
      }
    }
  }

  function indexOfNewline(buf) {
    const n = buf.indexOf(10);
    return n;
  }

  function dispatch(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    Promise.resolve(handler.handle(message, write))
      .then((reply) => {
        if (!reply) return;
        write(reply);
      })
      .catch((error) => {
        write({
          jsonrpc: "2.0",
          id: message && message.id,
          error: { code: -32000, message: error.message || String(error) },
        });
      });
  }

  // The MCP stdio spec is newline-delimited JSON; older JV clients send
  // Content-Length frames. Reply in whatever framing the client used.
  function write(obj) {
    const json = JSON.stringify(obj);
    try {
      if (framing === "ndjson") {
        stdout.write(json + "\n");
        return;
      }
      const payload = Buffer.from(json, "utf8");
      stdout.write("Content-Length: " + payload.length + "\r\n\r\n");
      stdout.write(payload);
    } catch {
      // The pipe is already gone; the stdout "error" handler above exits.
    }
  }

  return { write, dispatch };
}

function main(argv) {
  // One bad call or a dropped pipe must not kill the server silently: an agent
  // whose MCP process exits sees every later tool call as a closed stream.
  process.on("uncaughtException", (error) => {
    try {
      process.stderr.write("jeditor-mcp: " + ((error && error.stack) || error) + "\n");
    } catch {
      /* stderr is gone too */
    }
  });
  process.on("unhandledRejection", (error) => {
    try {
      process.stderr.write("jeditor-mcp: unhandled rejection: " + ((error && error.message) || error) + "\n");
    } catch {
      /* stderr is gone too */
    }
  });
  const dataRoot = parseDataRoot(argv) || defaultDataRoot();
  const appRoot = argValue(argv, "--app-root") || path.join(__dirname, "..");
  const profile = argValue(argv, "--profile");
  const handler = argv.includes("--no-bridge")
    ? createProxyHandler({ dataRoot, appRoot, profile, readBridge: () => null })
    : createProxyHandler({ dataRoot, appRoot, profile });
  createFramedIo(handler, process.stdin, process.stdout);
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = { parseDataRoot, defaultDataRoot, readBridge, createProxyHandler, createFramedIo, main };
