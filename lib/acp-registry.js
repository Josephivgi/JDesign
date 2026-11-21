"use strict";

// The ACP Registry (agentclientprotocol.com/registry): the public list of
// agents that speak the Agent Client Protocol, with how to install each one.
// JV shows it on the Agents page and installs agents into its own data
// folder, so nothing global changes on the computer:
//   npx    -> npm install into <data>/acp-registry/agents/<id>/<version>
//   binary -> download the archive for this platform, check its sha256, unpack
//   uvx    -> run through uvx (needs uv on PATH)

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const ICON_HOST = "cdn.agentclientprotocol.com";
const CACHE_MS = 6 * 60 * 60 * 1000;
const FETCH_MS = 15000;
const ICON_MAX = 64 * 1024;
const ARCHIVE_MAX = 1024 * 1024 * 1024;
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

// Registry ids that are the same agent as one of JV's built-in entries.
// When that program is already installed, Add uses it instead of downloading.
const BUILTIN_IDS = {
  opencode: "opencode",
  "claude-acp": "claude-code",
  "codex-acp": "codex",
  cursor: "cursor",
  gemini: "gemini",
  "github-copilot-cli": "copilot",
  kimi: "kimi",
  junie: "junie",
  devin: "devin",
};

function registryDir(dataRoot) {
  return path.join(String(dataRoot), "acp-registry");
}

function platformKey(platform = process.platform, arch = process.arch) {
  const os = platform === "win32" ? "windows" : platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : "";
  const cpu = arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : "";
  return os && cpu ? os + "-" + cpu : "";
}

// How this computer would install an agent: the first supported method.
function installMethod(agent, platform) {
  const dist = (agent && agent.distribution) || {};
  const key = platformKey(platform);
  if (dist.binary && key && dist.binary[key] && dist.binary[key].archive && dist.binary[key].cmd) return { kind: "binary", spec: dist.binary[key] };
  if (dist.npx && dist.npx.package) return { kind: "npx", spec: dist.npx };
  if (dist.uvx && dist.uvx.package) return { kind: "uvx", spec: dist.uvx };
  return null;
}

function validAgent(agent) {
  return Boolean(agent && typeof agent === "object" && ID_RE.test(String(agent.id || "")) && agent.name && agent.distribution);
}

async function fetchWithTimeout(url, ms, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await (fetchImpl || fetch)(url, { signal: controller.signal, redirect: "follow" });
  } finally {
    clearTimeout(timer);
  }
}

// The registry, from a fresh download when the cached copy is older than six
// hours (or `refresh` is set), else from the cache. Offline, the cache is used
// however old it is, and `stale` says so.
async function loadRegistry(dataRoot, options = {}) {
  const dir = registryDir(dataRoot);
  const file = path.join(dir, "registry.json");
  let cached = null;
  try {
    cached = JSON.parse(await fsp.readFile(file, "utf8"));
  } catch {
    cached = null;
  }
  const fresh = cached && Date.now() - Number(cached.fetchedAt || 0) < CACHE_MS;
  if (fresh && !options.refresh) return { agents: cached.agents, fetchedAt: cached.fetchedAt, stale: false };
  try {
    const res = await fetchWithTimeout(options.url || REGISTRY_URL, FETCH_MS, options.fetch);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const body = await res.json();
    const agents = (Array.isArray(body && body.agents) ? body.agents : []).filter(validAgent);
    if (!agents.length) throw new Error("the registry came back empty");
    const record = { fetchedAt: Date.now(), agents };
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(file + ".tmp", JSON.stringify(record));
    await fsp.rename(file + ".tmp", file);
    return { agents, fetchedAt: record.fetchedAt, stale: false };
  } catch (error) {
    if (cached && Array.isArray(cached.agents)) return { agents: cached.agents, fetchedAt: cached.fetchedAt, stale: true, error: String(error.message || error) };
    throw new Error("Could not load the ACP Registry: " + String((error && error.message) || error));
  }
}

// Icons are small SVGs on the registry CDN. They are saved once and handed to
// the window as data: URLs (an <img> never runs script inside an SVG).
async function iconData(dataRoot, agent, fetchImpl) {
  const url = String((agent && agent.icon) || "");
  let host = "";
  try {
    host = new URL(url).host;
  } catch {
    return "";
  }
  if (host !== ICON_HOST || !/\.svg$/i.test(url)) return "";
  const dir = path.join(registryDir(dataRoot), "icons");
  const file = path.join(dir, agent.id + "-" + crypto.createHash("sha1").update(url).digest("hex").slice(0, 8) + ".svg");
  let svg = "";
  try {
    svg = await fsp.readFile(file, "utf8");
  } catch {
    try {
      const res = await fetchWithTimeout(url, 8000, fetchImpl);
      if (!res.ok) return "";
      svg = await res.text();
      if (svg.length > ICON_MAX || !/<svg[\s>]/i.test(svg)) return "";
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(file, svg);
    } catch {
      return "";
    }
  }
  return "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function runHidden(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    // A .cmd (npm) runs through cmd.exe. Its path can hold spaces
    // (C:\Program Files\nodejs), so it is quoted and the whole line passed
    // verbatim; the args arrive already quoted.
    const viaCmd = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
    const child = spawn(
      viaCmd ? process.env.ComSpec || "cmd.exe" : command,
      viaCmd ? ["/d", "/s", "/c", '"' + quoteArg(command) + " " + args.join(" ") + '"'] : args,
      {
        cwd: options.cwd,
        env: Object.assign({}, process.env, options.env || {}),
        windowsHide: true,
        windowsVerbatimArguments: viaCmd,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let tail = "";
    const keep = (chunk) => {
      tail = (tail + chunk.toString()).slice(-4000);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = options.timeoutMs ? setTimeout(() => child.kill(), options.timeoutMs) : null;
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve(tail);
      else reject(new Error(tail.trim().split(/\r?\n/).slice(-3).join(" ") || command + " exited with code " + code));
    });
  });
}

function quoteArg(arg) {
  return /[\s"]/.test(arg) ? '"' + String(arg).replace(/"/g, '\\"') + '"' : arg;
}

function packageName(spec) {
  const text = String(spec || "");
  const at = text.lastIndexOf("@");
  return at > 0 ? text.slice(0, at) : text;
}

// npm installs the package into the agent's own folder; the agent then runs
// from the shim npm writes in node_modules/.bin.
async function installNpx(agent, spec, dir, deps) {
  const npm = deps.findProgram(["npm"]);
  if (!npm) throw new Error("npm was not found. Install Node.js, then try again.");
  await fsp.mkdir(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, "package.json"))) await fsp.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "jeditor-agent-" + agent.id, private: true }));
  const args = ["install", "--no-audit", "--no-fund", "--omit=dev", "--loglevel=error", spec.package];
  await runHidden(npm, process.platform === "win32" ? args.map(quoteArg) : args, { cwd: dir, timeoutMs: 10 * 60 * 1000 });
  const name = packageName(spec.package);
  const pkg = JSON.parse(await fsp.readFile(path.join(dir, "node_modules", name, "package.json"), "utf8"));
  const bins = typeof pkg.bin === "string" ? { [name.split("/").pop()]: pkg.bin } : pkg.bin || {};
  const names = Object.keys(bins);
  if (!names.length) throw new Error(name + " has no program to run.");
  const base = name.split("/").pop();
  const bin = names.find((n) => n === base) || names.find((n) => n === agent.id) || names[0];
  const shim = path.join(dir, "node_modules", ".bin", process.platform === "win32" ? bin + ".cmd" : bin);
  if (!fs.existsSync(shim)) throw new Error("npm did not create the " + bin + " command.");
  return { command: shim, args: (spec.args || []).map(String), env: spec.env || {} };
}

// Downloads the archive for this platform, checks its sha256 when the
// registry gives one, and unpacks it with the system tar (Windows 10 and
// later ship bsdtar, which reads zip and tar.gz).
async function installBinary(agent, spec, dir, deps, onProgress) {
  const url = String(spec.archive);
  if (!/^https:\/\//i.test(url) && !deps.allowHttp) throw new Error("The download link is not https.");
  await fsp.mkdir(dir, { recursive: true });
  const name = decodeURIComponent(new URL(url).pathname.split("/").pop() || "agent-archive");
  const archive = path.join(dir, ".download-" + name.replace(/[^\w.-]/g, "_"));
  const res = await fetchWithTimeout(url, 30 * 60 * 1000, deps.fetch);
  if (!res.ok || !res.body) throw new Error("Download failed: HTTP " + res.status);
  const total = Number(res.headers.get("content-length")) || 0;
  const hash = crypto.createHash("sha256");
  const out = fs.createWriteStream(archive);
  let done = 0;
  try {
    for await (const chunk of res.body) {
      done += chunk.length;
      if (done > ARCHIVE_MAX) throw new Error("The download is larger than 1 GB.");
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
      if (onProgress) onProgress({ phase: "download", done, total });
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
  const digest = hash.digest("hex");
  if (spec.sha256 && String(spec.sha256).toLowerCase() !== digest) {
    await fsp.rm(archive, { force: true });
    throw new Error("The download did not match the registry checksum, so it was not installed.");
  }
  if (onProgress) onProgress({ phase: "unpack", done, total });
  const tar = process.platform === "win32" ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
  await runHidden(tar, ["-xf", archive, "-C", dir], { timeoutMs: 10 * 60 * 1000 });
  await fsp.rm(archive, { force: true });
  const command = path.resolve(dir, String(spec.cmd).replace(/\\/g, "/"));
  if (!command.startsWith(path.resolve(dir) + path.sep)) throw new Error("The agent's command points outside its folder.");
  if (!fs.existsSync(command)) throw new Error("The download did not contain " + spec.cmd + ".");
  if (process.platform !== "win32") await fsp.chmod(command, 0o755);
  return { command, args: (spec.args || []).map(String), env: spec.env || {} };
}

async function installUvx(agent, spec, deps) {
  const uvx = deps.findProgram(["uvx"]);
  if (!uvx) throw new Error(agent.name + " runs through uv. Install uv (docs.astral.sh/uv), then try again.");
  return { command: uvx, args: [String(spec.package)].concat((spec.args || []).map(String)), env: spec.env || {} };
}

async function installAgent(dataRoot, agent, deps, onProgress) {
  if (!validAgent(agent)) throw new Error("That agent is not in the registry.");
  const method = installMethod(agent);
  if (!method) throw new Error(agent.name + " has no download for this computer.");
  const version = String(agent.version || "latest").replace(/[^\w.+-]/g, "_");
  const dir = path.join(registryDir(dataRoot), "agents", agent.id, version);
  if (onProgress) onProgress({ phase: method.kind === "npx" ? "npm" : method.kind === "binary" ? "download" : "check", done: 0, total: 0 });
  let spec;
  if (method.kind === "npx") spec = await installNpx(agent, method.spec, dir, deps);
  else if (method.kind === "binary") spec = await installBinary(agent, method.spec, dir, deps, onProgress);
  else spec = await installUvx(agent, method.spec, deps);
  return Object.assign({ kind: method.kind, version: String(agent.version || ""), dir }, spec);
}

// Icons for JV's built-in agents, from the saved registry and icon
// files only (no network): the picker list is drawn often.
function cachedBuiltinIcons(dataRoot) {
  const out = {};
  let agents = [];
  try {
    agents = JSON.parse(fs.readFileSync(path.join(registryDir(dataRoot), "registry.json"), "utf8")).agents || [];
  } catch {
    return out;
  }
  for (const [registryId, builtinId] of Object.entries(BUILTIN_IDS)) {
    const agent = agents.find((a) => a && a.id === registryId);
    const url = String((agent && agent.icon) || "");
    if (!url) continue;
    const file = path.join(registryDir(dataRoot), "icons", registryId + "-" + crypto.createHash("sha1").update(url).digest("hex").slice(0, 8) + ".svg");
    try {
      out[builtinId] = "data:image/svg+xml;base64," + fs.readFileSync(file).toString("base64");
    } catch {
      /* not downloaded yet */
    }
  }
  return out;
}

// Every registry icon already saved on disk, by registry id (no network).
// The model picker draws model makers with them: a Claude model gets the
// claude-acp mark, a Gemini model the gemini mark.
function cachedRegistryIcons(dataRoot) {
  const out = {};
  let agents = [];
  try {
    agents = JSON.parse(fs.readFileSync(path.join(registryDir(dataRoot), "registry.json"), "utf8")).agents || [];
  } catch {
    return out;
  }
  for (const agent of agents) {
    const id = String((agent && agent.id) || "");
    const url = String((agent && agent.icon) || "");
    if (!id || !url) continue;
    const file = path.join(registryDir(dataRoot), "icons", id + "-" + crypto.createHash("sha1").update(url).digest("hex").slice(0, 8) + ".svg");
    try {
      const stat = fs.statSync(file);
      if (stat.size > 0 && stat.size < 64 * 1024) out[id] = "data:image/svg+xml;base64," + fs.readFileSync(file).toString("base64");
    } catch {
      /* not downloaded yet */
    }
  }
  return out;
}

module.exports = {
  cachedRegistryIcons,
  cachedBuiltinIcons,
  REGISTRY_URL,
  BUILTIN_IDS,
  platformKey,
  installMethod,
  loadRegistry,
  iconData,
  installAgent,
  mapLimit,
  packageName,
  runHidden,
  quoteArg,
};
