"use strict";

// The launcher every outside agent config points at: <data>/jeditor-mcp.cjs.
//
// A config that named the install folder would break on every update (the
// path carries the app version), and a config that named a checkout would
// break when JV is installed instead. The launcher lives in the data folder,
// finds whichever JV started last through agent-bridge.json, and runs that
// install's MCP server. The app writes it on every start; scripts/mcp-install
// writes the same file so a config works before JV has ever been opened, with
// the app root it found baked in as the fallback.

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const LAUNCHER = "jeditor-mcp.cjs";
// Agent configs written before the rename name the old file, and they are on
// other people's machines, so the old name is written every time as a shim
// onto the new one. Nothing has to migrate.
const LEGACY_LAUNCHER = "cutline-mcp.cjs";

// Reads agent-bridge.json, falls back to the app root this file was written
// with (empty when the app wrote it, because the app is the one starting).
function launcherSource(fallbackAppRoot) {
  const fallback = String(fallbackAppRoot || "").trim();
  const lines = [
    "// Written by JV each time the app starts. Runs the JV MCP stdio server",
    "// from the JV install or checkout that started last, so agent configs that",
    "// point here keep working after app updates.",
    '"use strict";',
    'const fs = require("fs");',
    'const path = require("path");',
    'let appRoot = "";',
    "try {",
    '  appRoot = JSON.parse(fs.readFileSync(path.join(__dirname, "agent-bridge.json"), "utf8")).appRoot || "";',
    "} catch {}",
  ];
  if (fallback) {
    lines.push("// Written by npm run mcp:install before JV had started once.");
    lines.push("if (!appRoot) appRoot = " + JSON.stringify(fallback) + ";");
  }
  lines.push(
    'if (!appRoot || !fs.existsSync(path.join(appRoot, "lib", "mcp-stdio.js"))) {',
    '  process.stderr.write("JV MCP: no JV install at " + (appRoot || "(unknown)") + ". Open JV once, or run: npm run mcp:install\\n");',
    "  process.exit(1);",
    "}",
    'require(path.join(appRoot, "lib", "mcp-stdio.js")).main(["--data-root", __dirname, "--app-root", appRoot].concat(process.argv.slice(2)));',
    "",
  );
  return lines.join("\n");
}

// Two lines so the old path keeps working forever: it only runs the launcher
// under the new name, which is written beside it every time.
function legacyLauncherSource() {
  return [
    "// Written by JV each time the app starts. Agent configs that still point at",
    "// this old file name run the current launcher beside it.",
    '"use strict";',
    'require("./' + LAUNCHER + '");',
    "",
  ].join("\n");
}

function writeIfChanged(file, body) {
  let current = "";
  try {
    current = fs.readFileSync(file, "utf8");
  } catch {
    /* first run */
  }
  if (current === body) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + "." + process.pid + "." + randomUUID() + ".tmp";
  fs.writeFileSync(tmp, body, "utf8");
  fs.renameSync(tmp, file);
  return true;
}

// Writes both launcher names and returns their paths. fallbackAppRoot is only
// baked in when the app has not written a bridge file yet.
function writeLauncher(dataRoot, fallbackAppRoot) {
  const launcher = path.join(dataRoot, LAUNCHER);
  const legacy = path.join(dataRoot, LEGACY_LAUNCHER);
  writeIfChanged(launcher, launcherSource(fallbackAppRoot));
  writeIfChanged(legacy, legacyLauncherSource());
  return { launcher, legacy };
}

module.exports = {
  LAUNCHER,
  LEGACY_LAUNCHER,
  launcherSource,
  legacyLauncherSource,
  writeIfChanged,
  writeLauncher,
};
