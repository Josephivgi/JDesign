const fs = require("fs");
const os = require("os");
const path = require("path");
const { AcpClient } = require("../lib/acp-client");

const appRoot = path.join(__dirname, "..");
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cutline-live-acp-"));
const harnessId = process.argv[2] || "grok";

async function main() {
  const client = new AcpClient({ harnessId, dataRoot, appRoot });
  const stderr = [];
  try {
    client.start();
    if (client.child && client.child.stderr) {
      client.child.stderr.on("data", (chunk) => stderr.push(chunk.toString("utf8")));
    }
    const init = await client.initialize();
    const session = await client.newSession();
    const mcp = (session && session.mcpServers) || client.sessionNewParams().mcpServers;
    let prompt = null;
    try {
      prompt = await client.prompt("Reply with the single word pong.", session.sessionId || client.sessionId);
    } catch (error) {
      prompt = { error: error.message };
    }
    process.stdout.write(
      JSON.stringify(
        {
          ok: Boolean(session && (session.sessionId || client.sessionId) && mcp && mcp.length),
          harnessId,
          initialize: init && Object.keys(init),
          sessionId: session && (session.sessionId || session.session_id),
          mcpServers: mcp,
          prompt,
        },
        null,
        2,
      ) + "\n",
    );
  } catch (error) {
    process.stdout.write(
      JSON.stringify({ ok: false, harnessId, error: error.message, stderr: stderr.join("").slice(0, 2000) }, null, 2) + "\n",
    );
    process.exitCode = 1;
  } finally {
    client.stop();
  }
}

main();
