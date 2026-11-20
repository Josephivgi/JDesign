// Stdio MCP proxy -> the running JDraw HTTP MCP server. Agents that cannot
// take an HTTP MCP entry (Devin reads .devin/mcp_config.local.json, older
// harnesses only know command servers) get the same jdraw tools through this
// bridge. Env from the MCP entry: JDRAW_MCP_URL, JDRAW_MCP_TOKEN, and the
// project/chat binding the session was started with.
const readline = require("readline");

const URL_ = process.env.JDRAW_MCP_URL || "";
const TOKEN = process.env.JDRAW_MCP_TOKEN || "";
const PROJECT = process.env.JDRAW_PROJECT_ID || "";
const CHAT = process.env.JDRAW_CHAT_ID || "";

let sessionId = "";
const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

async function post(payload) {
  const headers = {
    "Content-Type": "application/json",
    Authorization: "Bearer " + TOKEN,
  };
  if (PROJECT) headers["x-jdraw-project"] = PROJECT;
  if (CHAT) headers["x-jdraw-chat-id"] = CHAT;
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const res = await fetch(URL_, { method: "POST", headers, body: JSON.stringify(payload) });
  const sid = res.headers.get("mcp-session-id");
  if (sid) sessionId = sid;
  if (res.status === 202) return null;
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function acceptChunk(chunk) {
  // MCP over stdio may be newline JSON or Content-Length framed; take both.
  const s = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
  return s;
}

const pending = { buf: "" };
async function handleMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  const batch = Array.isArray(msg) ? msg : [msg];
  const replies = [];
  for (const m of batch) {
    if (!m || m.id === undefined) continue; // notifications get no reply
    if (!URL_) {
      replies.push({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: "JDraw is not running." } });
      continue;
    }
    const r = await post(m);
    if (r) replies.push(r);
  }
  for (const r of replies) out(r);
}

// Parse Content-Length framed input (standard) and bare newline JSON.
let raw = "";
process.stdin.on("data", (d) => {
  raw += acceptChunk(d);
  for (;;) {
    const m = raw.match(/^Content-Length:\s*(\d+)\s*\r?\n\r?\n/i);
    if (m) {
      const len = +m[1];
      if (raw.length < m[0].length + len) return;
      const body = raw.slice(m[0].length, m[0].length + len);
      raw = raw.slice(m[0].length + len);
      try { void handleMessage(JSON.parse(body)); } catch {}
      continue;
    }
    const nl = raw.indexOf("\n");
    if (nl < 0) return;
    const line = raw.slice(0, nl).trim();
    raw = raw.slice(nl + 1);
    if (!line) continue;
    try { void handleMessage(JSON.parse(line)); } catch {}
  }
});
process.stdin.resume();
