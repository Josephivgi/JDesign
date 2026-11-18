const fs = require("fs");
const path = require("path");
const { resolveEditorpiAgentDir } = require("./editorpi-paths");

// The agent owns ~/.editorpi/agent/settings.json. JV only adds its own
// keys (contextWindows, showRawErrors) and never rewrites the rest, so a
// provider pin or a key the agent wrote survives a JV save.
function settingsPath(options) {
  return path.join(resolveEditorpiAgentDir(options || {}), "settings.json");
}

// editorpi's kernel and the agent runtime disagree on the missing-key default
// (40k vs 16384). Once JV touches settings.json the key is always written
// so both readers use the same reserve for context-window and compaction math.
const DEFAULT_COMPACTION_RESERVE_TOKENS = 40000;

function readAgentSettings(options) {
  try {
    const raw = fs.readFileSync(settingsPath(options), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    /* missing or unreadable */
  }
  return {};
}

function writeAgentSettings(settings, options) {
  const file = settingsPath(options);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const out = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
  const compaction = out.compaction && typeof out.compaction === "object" ? out.compaction : {};
  if (!(Number(compaction.reserveTokens) > 0)) compaction.reserveTokens = DEFAULT_COMPACTION_RESERVE_TOKENS;
  out.compaction = compaction;
  const body = JSON.stringify(out, null, 2) + "\n";
  const tmp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, body, "utf8");
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.copyFileSync(tmp, file);
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* leave the tmp file */
    }
  }
}

module.exports = { settingsPath, readAgentSettings, writeAgentSettings, DEFAULT_COMPACTION_RESERVE_TOKENS };
