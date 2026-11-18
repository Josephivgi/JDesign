const os = require("os");
const path = require("path");

function isOfficialPiPath(dir) {
  if (!dir) return false;
  const normalized = path.resolve(String(dir)).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return normalized.endsWith("/.pi") || normalized.includes("/.pi/");
}

function defaultEditorpiAgentDir(homeDir) {
  return path.join(homeDir || os.homedir(), ".editorpi", "agent");
}

function resolveHome(options) {
  const opts = options || {};
  const env = opts.env || {};
  const candidates = [opts.homeDir, env.EDITORPI_HOME, os.homedir()];
  for (const home of candidates) {
    if (!home) continue;
    if (isOfficialPiPath(home) || isOfficialPiPath(path.join(home, ".editorpi", "agent"))) continue;
    return home;
  }
  return os.homedir();
}

function resolveEditorpiAgentDir(options) {
  const opts = options || {};
  const env = opts.env || {};
  const home = resolveHome(opts);
  const fallback = defaultEditorpiAgentDir(home);
  const candidates = [opts.agentDir, env.EDITORPI_CODING_AGENT_DIR];
  for (const dir of candidates) {
    if (dir && !isOfficialPiPath(dir)) return String(dir);
  }
  if (opts.authPath) {
    const fromAuth = path.dirname(String(opts.authPath));
    if (!isOfficialPiPath(fromAuth)) return fromAuth;
  }
  if (!isOfficialPiPath(fallback)) return fallback;
  return defaultEditorpiAgentDir(os.homedir());
}

module.exports = { isOfficialPiPath, defaultEditorpiAgentDir, resolveEditorpiAgentDir };
