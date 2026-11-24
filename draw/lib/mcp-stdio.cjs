// Stdio MCP proxy -> the running JDraw HTTP MCP server. Agents that cannot
// take an HTTP MCP entry (Devin reads .devin/mcp_config.local.json, older
// harnesses only know command servers) get the same jdraw tools through this
// bridge. Env from the MCP entry: JDRAW_MCP_URL, JDRAW_MCP_TOKEN, and the
// project/chat binding the session was started with.
//
// Hardened like the video proxy: input is buffered as bytes so a multi-byte
// character split across TCP chunks is decoded whole, every failure answers
// as a JSON-RPC error instead of dying, and the input buffer is capped.

const URL_ = process.env.JDRAW_MCP_URL || "";
const TOKEN = process.env.JDRAW_MCP_TOKEN || "";
const PROJECT = process.env.JDRAW_PROJECT_ID || "";
const CHAT = process.env.JDRAW_CHAT_ID || "";
const MAX_INPUT = 32 * 1024 * 1024;

let sessionId = "";
const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const rpcError = (id, message) => ({ jsonrpc: "2.0", id: id == null ? null : id, error: { code: -32603, message } });

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

async function handleOne(m) {
  if (!m || typeof m !== "object") return null;
  if (!URL_) {
    if (m.id === undefined) return null;
    return rpcError(m.id, "JDraw is not running.");
  }
  try {
    const r = await post(m);
    if (m.id === undefined) return null;
    // A request with no reply (202 or an unparseable body) still needs an
    // answer, or the client waits on it forever.
    return r || rpcError(m.id, "Empty reply from JDraw.");
  } catch {
    // A dead app or a dropped connection answers as an error, not a crash.
    return m.id === undefined ? null : rpcError(m.id, "Could not reach JDraw.");
  }
}

async function handleMessage(msg) {
  const batch = Array.isArray(msg) ? msg : [msg];
  for (const m of batch) {
    const r = await handleOne(m);
    if (r) out(r);
  }
}

// Bytes, not strings: a UTF-8 character can be split across stdin chunks, so
// framing works on the buffer and only complete messages are decoded.
let raw = Buffer.alloc(0);
process.stdin.on("data", (d) => {
  raw = Buffer.concat([raw, Buffer.isBuffer(d) ? d : Buffer.from(d)]);
  if (raw.length > MAX_INPUT) {
    out(rpcError(null, "Input over 32 MB."));
    raw = Buffer.alloc(0);
    return;
  }
  for (;;) {
    // A frame starts with a header line (Content-Length, and some clients
    // send Content-Type first). Parse the whole block, not just line one.
    const firstNl = raw.indexOf(0x0a);
    const firstLine = raw.slice(0, firstNl < 0 ? Math.min(raw.length, 256) : firstNl).toString("latin1").trim();
    if (/^content-(length|type)\s*:/i.test(firstLine)) {
      let head = raw.indexOf("\r\n\r\n");
      let term = 4;
      if (head < 0) { head = raw.indexOf("\n\n"); term = 2; }
      if (head < 0) return;
      const m = raw.slice(0, head).toString("latin1").match(/Content-Length:\s*(\d+)/i);
      if (!m) { raw = raw.slice(head + term); continue; }
      const len = +m[1];
      const start = head + term;
      if (raw.length < start + len) return;
      const body = raw.slice(start, start + len).toString("utf8");
      raw = raw.slice(start + len);
      try { void handleMessage(JSON.parse(body)); } catch {}
      continue;
    }
    if (firstNl < 0) return;
    const line = raw.slice(0, firstNl).toString("utf8").trim();
    raw = raw.slice(firstNl + 1);
    if (!line) continue;
    try { void handleMessage(JSON.parse(line)); } catch {}
  }
});
process.stdin.resume();
// The agent that spawned this proxy is gone when its stdin closes: exit now
// instead of idling as an orphan process.
process.stdin.on("end", () => process.exit(0));
process.stdin.on("error", () => process.exit(0));
process.stdout.on("error", () => process.exit(0));

process.on("uncaughtException", (error) => {
  try { out(rpcError(null, "Draw proxy error: " + (error && error.message ? error.message : String(error)))); } catch {}
});
process.on("unhandledRejection", (error) => {
  try { out(rpcError(null, "Draw proxy error: " + (error && error.message ? error.message : String(error)))); } catch {}
});
