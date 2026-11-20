// Regression test for the stdio proxy SSE fix: a tools/call carrying a
// progressToken gets an SSE reply from the bridge; the proxy must forward
// each progress notification as it arrives and return the final reply.
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const TOKEN = "test-token-1234567890abcdef";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "jv-sse-"));
fs.mkdirSync(path.join(root, "data"), { recursive: true });

const server = http.createServer((req, res) => {
  if (req.headers.authorization !== "Bearer " + TOKEN) { res.writeHead(401).end(); return; }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const msg = Array.isArray(body) ? body[0] : body;
    const headers = { "Content-Type": "application/json" };
    const sid = req.headers["mcp-session-id"] || "sess-1";
    headers["Mcp-Session-Id"] = sid;
    if (msg.method === "tools/call" && msg.params && msg.params._meta && msg.params._meta.progressToken) {
      headers["Content-Type"] = "text/event-stream";
      res.writeHead(200, headers);
      res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: msg.params._meta.progressToken, progress: 1, total: 2 } })}\n\n`);
      setTimeout(() => {
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: '{"ok":true}' }] } })}\n\n`);
        res.end();
      }, 120);
      return;
    }
    res.writeHead(200, headers);
    res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: msg.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake", version: "0" } } : { content: [] } }));
  });
});

server.listen(0, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${server.address().port}/`;
  fs.writeFileSync(path.join(root, "data", "agent-bridge.json"), JSON.stringify({ url, token: TOKEN, appRoot: process.cwd(), pid: 1, startedAt: "x" }));
  const child = spawn(process.execPath, [path.join(process.cwd(), "lib", "mcp-stdio.js"), "--data-root", path.join(root, "data")], { env: { ...process.env, JEDITOR_DATA_ROOT: path.join(root, "data") } });
  const got = [];
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) got.push(JSON.parse(l)); }
  });
  child.stderr.on("data", (d) => process.stderr.write(d));
  const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
  setTimeout(() => send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "test" } } }), 200);
  setTimeout(() => send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "jeditor_long_tool", arguments: {}, _meta: { progressToken: "pt-1" } } }), 500);
  setTimeout(() => {
    child.kill();
    server.close();
    const progress = got.filter((m) => m.method === "notifications/progress");
    const reply = got.find((m) => m.id === 2);
    const ok = progress.length >= 1 && reply && reply.result && reply.result.content;
    console.log("progress notifications:", progress.length, "| reply:", JSON.stringify(reply && reply.result ? reply.result.content : reply));
    console.log(ok ? "PASS" : "FAIL");
    process.exit(ok ? 0 : 1);
  }, 2500);
});
