// Persisted Agent setup progress for the onboarding wizard.
// Lives next to capture-setup.json under the app data root. Reads must never
// throw: a missing or corrupt file returns defaults.

const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { ENGINES, DEFAULT_ENGINE, normalizeEngineId } = require("./browser-engines");

const STEPS = ["engine", "browser", "cookies"];

function setupPath(dataRoot) {
  return path.join(dataRoot, "agents-setup.json");
}

function defaultDataRoot(env) {
  const src = env && typeof env === "object" ? env : process.env;
  const appData =
    src.APPDATA ||
    (process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support")
      : src.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"));
  return path.join(appData, "JEditor", "data");
}

function resolveDataRoot(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  if (typeof o.dataRoot === "string" && o.dataRoot) return o.dataRoot;
  const env = o.env && typeof o.env === "object" ? o.env : process.env;
  // Renamed variable first, old spelling second, so an install that still sets
  // the old name keeps working.
  const fromEnv = env.JEDITOR_DATA_ROOT || env.CUTLINE_DATA_ROOT;
  if (fromEnv) return fromEnv;
  return defaultDataRoot(env);
}

function emptyBrowser() {
  return { engine: DEFAULT_ENGINE };
}

function emptyState() {
  return { completed: false, completedAt: null, steps: {}, browser: emptyBrowser(), answers: {} };
}

function normalizeSteps(raw) {
  const steps = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return steps;
  for (const key of Object.keys(raw)) {
    if (key && raw[key]) steps[String(key)] = true;
  }
  return steps;
}

function normalizeBrowser(raw) {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return { engine: normalizeEngineId(src.engine) };
}

function normalizeAnswers(raw) {
  const answers = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return answers;
  for (const key of Object.keys(raw)) {
    if (key && typeof raw[key] === "boolean") answers[String(key)] = raw[key];
  }
  return answers;
}

function normalizeState(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const completed = Boolean(src.completed);
  return {
    completed,
    completedAt: completed && typeof src.completedAt === "string" && src.completedAt ? src.completedAt : null,
    steps: normalizeSteps(src.steps),
    browser: normalizeBrowser(src.browser),
    answers: normalizeAnswers(src.answers),
  };
}

async function readState(opts) {
  const root = resolveDataRoot(opts);
  try {
    const text = await fs.readFile(setupPath(root), "utf8");
    return normalizeState(JSON.parse(text));
  } catch {
    return emptyState();
  }
}

// Writes serialize through this queue so two concurrent writers cannot read
// the same base state and drop each other's changes.
let writeQueue = Promise.resolve();

function writeState(patch, opts) {
  const run = writeQueue.then(() => writeStateNow(patch, opts));
  writeQueue = run.catch(() => {});
  return run;
}

async function writeStateNow(patch, opts) {
  const root = resolveDataRoot(opts);
  const state = await readState(opts);
  const src = patch && typeof patch === "object" ? patch : {};
  if (typeof src.completed === "boolean") {
    state.completed = src.completed;
    if (src.completed && !state.completedAt) state.completedAt = new Date().toISOString();
    if (!src.completed) state.completedAt = null;
  }
  if (typeof src.completedAt === "string" && src.completedAt) state.completedAt = src.completedAt;
  if (src.steps && typeof src.steps === "object" && !Array.isArray(src.steps)) {
    for (const key of Object.keys(src.steps)) {
      if (!key) continue;
      if (src.steps[key]) state.steps[String(key)] = true;
      else delete state.steps[String(key)];
    }
  }
  if (src.browser && typeof src.browser === "object" && !Array.isArray(src.browser)) {
    state.browser = normalizeBrowser({ engine: src.browser.engine });
  }
  if (src.answers && typeof src.answers === "object" && !Array.isArray(src.answers)) {
    state.answers = normalizeAnswers(src.answers);
  }
  await fs.mkdir(root, { recursive: true });
  const dest = setupPath(root);
  const tmp = dest + "." + process.pid + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(state), "utf8");
  try {
    await fs.rename(tmp, dest);
  } catch {
    await fs.rm(dest, { force: true });
    try {
      await fs.rename(tmp, dest);
    } catch (error) {
      try {
        await fs.unlink(tmp);
      } catch {
        /* tmp already gone */
      }
      throw error;
    }
  }
  return state;
}

async function readBrowser(opts) {
  const state = await readState(opts);
  return state.browser;
}

async function writeBrowser(browser, opts) {
  const src = browser && typeof browser === "object" ? browser : {};
  const engine = typeof src.engine === "string" ? src.engine.trim() : "";
  if (!engine || !ENGINES.some((item) => item.id === engine)) {
    throw new Error("Unknown browser engine: " + (engine || "none"));
  }
  const state = await writeState({ browser: { engine } }, opts);
  return state.browser;
}

module.exports = {
  STEPS,
  setupPath,
  resolveDataRoot,
  emptyState,
  normalizeState,
  readState,
  writeState,
  readBrowser,
  writeBrowser,
};
