const fs = require("fs/promises");
const fssync = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const mediaStore = require("./media-migrate");

const STATE_VERSION = 1;

function statePath(dataRoot) {
  return path.join(dataRoot, "state.json");
}

function workspaceDir(dataRoot, id) {
  return path.join(dataRoot, "workspaces", id);
}

function workspacePath(dataRoot, id) {
  return path.join(workspaceDir(dataRoot, id), "workspace.json");
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

const writeLocks = new Map();

let cachedStateRoot = null;
let cachedState = null;
let cachedStateMtime = null;
const cachedWorkspaces = new Map();

function workspaceCacheKey(dataRoot, id) {
  return dataRoot + "\0" + id;
}

function bustStateCache(dataRoot) {
  if (cachedStateRoot === dataRoot) {
    cachedStateRoot = null;
    cachedState = null;
    cachedStateMtime = null;
  }
}

function bustWorkspaceCache(dataRoot, id) {
  if (id) cachedWorkspaces.delete(workspaceCacheKey(dataRoot, id));
  else {
    for (const key of cachedWorkspaces.keys()) {
      if (key.startsWith(dataRoot + "\0")) cachedWorkspaces.delete(key);
    }
  }
}

function withWriteLock(file, fn) {
  const prev = writeLocks.get(file) || Promise.resolve();
  const run = prev.then(fn, fn);
  writeLocks.set(
    file,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

function firstJsonValueEnd(text) {
  let i = 0;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  if (i >= text.length) return -1;
  const open = text[i];
  if (open !== "{" && open !== "[") return -1;
  const stack = [open];
  let inString = false;
  let escape = false;
  for (let j = i + 1; j < text.length; j += 1) {
    const ch = text[j];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") {
      stack.pop();
      if (!stack.length) return j + 1;
    }
  }
  return -1;
}

function parseJsonDocument(raw) {
  const text = String(raw || "").replace(/^\uFEFF/, "");
  try {
    return { value: JSON.parse(text), repaired: false };
  } catch (error) {
    const end = firstJsonValueEnd(text);
    if (end > 0) {
      return { value: JSON.parse(text.slice(0, end)), repaired: true };
    }
    throw error;
  }
}

// Always temp-then-rename: a size mismatch retries the swap once instead of
// truncating the live file in place.
async function writeJsonFile(file, value) {
  await ensureDir(path.dirname(file));
  const body = JSON.stringify(value, null, 2);
  const want = Buffer.byteLength(body, "utf8");
  return withWriteLock(file, async () => {
    let st = null;
    for (let attempt = 0; attempt < 2 && (!st || st.size !== want); attempt += 1) {
      const tmp = file + "." + process.pid + "." + randomUUID() + ".tmp";
      try {
        await fs.writeFile(tmp, body, "utf8");
        await fs.rename(tmp, file);
      } finally {
        await fs.rm(tmp, { force: true }).catch(() => {});
      }
      st = await fs.stat(file);
    }
    if (st.size !== want) {
      throw new Error("JSON write left leftover bytes in " + file);
    }
    return st;
  });
}

async function writeJsonAtomic(file, value) {
  await writeJsonFile(file, value);
  if (path.basename(file) === "state.json") {
    bustStateCache(path.dirname(file));
  } else if (path.basename(file) === "workspace.json") {
    const id = path.basename(path.dirname(file));
    const dataRoot = path.dirname(path.dirname(path.dirname(file)));
    bustWorkspaceCache(dataRoot, id);
  }
}

async function readJson(file, fallback) {
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = parseJsonDocument(raw);
    if (parsed.repaired) await writeJsonAtomic(file, parsed.value);
    return parsed.value;
  } catch (error) {
    if (error && error.code === "ENOENT") return fallback;
    throw error;
  }
}

function emptyWorkspace(id, name) {
  const now = new Date().toISOString();
  return {
    id,
    name,
    createdAt: now,
    updatedAt: now,
    store: { version: mediaStore.STORE_VERSION },
    library: [],
    finished: [],
    links: [],
    cards: [],
    cardImages: [],
  };
}

function defaultCard() {
  return {
    name: "Untitled card",
    description: "",
    kind: "title_card",
    placement: "auto",
    durationMs: 3000,
    templateId: "",
    endScreen: false,
    endScreenDurationMs: 3000,
    endScreenBackgroundId: "",
    endScreenFit: "cover",
    endScreenTreatment: "none",
    editingBlock: "",
    motion: { in: "none", out: "none" },
    composition: {
      aspectRatio: "vertical",
      headline: "",
      body: "",
      eyebrow: "",
      cta: "",
      align: "left",
      surface: "solid",
      backgroundId: "",
      blockLayout: {},
      imageLayouts: {},
      html: "",
      css: "",
      vars: {},
    },
    colors: {
      primary: "#1F6F56",
      secondary: "#DFF56A",
      text: "#FFFFFF",
    },
    imageIds: [],
    drawing: "",
  };
}

function absorbCardImages(ws) {
  if (!Array.isArray(ws.library)) ws.library = [];
  if (!Array.isArray(ws.cardImages)) {
    ws.cardImages = [];
    return false;
  }
  if (!ws.cardImages.length) return false;
  ws.cardImages.forEach((item) => {
    if (!item || !item.id) return;
    if (ws.library.some((entry) => entry.id === item.id)) return;
    ws.library.unshift({
      id: item.id,
      kind: "image",
      name: item.name || "Image",
      file: item.file,
      mime: item.mime || "image/png",
      size: item.size || 0,
      durationMs: 0,
      description: "",
      aiCanUse: true,
      createdAt: item.createdAt || new Date().toISOString(),
    });
  });
  ws.cardImages = [];
  return true;
}

// Two callers on a fresh data folder (startup work and the first snapshot)
// must share one load, or each makes its own first workspace.
const stateLoads = new Map();
function loadState(dataRoot) {
  const running = stateLoads.get(dataRoot);
  if (running) return running;
  const load = loadStateOnce(dataRoot).finally(() => stateLoads.delete(dataRoot));
  stateLoads.set(dataRoot, load);
  return load;
}

async function loadStateOnce(dataRoot) {
  const stateFile = statePath(dataRoot);
  let stateMtime = null;
  try {
    stateMtime = (await fs.stat(stateFile)).mtimeMs;
  } catch (_) {}
  if (cachedStateRoot === dataRoot && cachedState && cachedStateMtime === stateMtime) {
    return cachedState;
  }
  await ensureDir(dataRoot);
  let state = await readJson(stateFile, null);
  if (!state || state.version !== STATE_VERSION) {
    const id = randomUUID();
    state = {
      version: STATE_VERSION,
      activeWorkspaceId: id,
      workspaces: [{ id, name: "Studio", createdAt: new Date().toISOString() }],
    };
    await writeJsonAtomic(statePath(dataRoot), state);
    const created = emptyWorkspace(id, "Studio");
    await writeJsonAtomic(workspacePath(dataRoot, id), created);
    cachedWorkspaces.set(workspaceCacheKey(dataRoot, id), {
      ws: created,
      mtime: (await fs.stat(workspacePath(dataRoot, id))).mtimeMs,
    });
    cachedStateRoot = dataRoot;
    cachedState = state;
    cachedStateMtime = (await fs.stat(stateFile)).mtimeMs;
    return state;
  }
  if (!state.workspaces.length) {
    const id = randomUUID();
    state.workspaces.push({ id, name: "Studio", createdAt: new Date().toISOString() });
    state.activeWorkspaceId = id;
    await writeJsonAtomic(statePath(dataRoot), state);
    await writeJsonAtomic(workspacePath(dataRoot, id), emptyWorkspace(id, "Studio"));
  }
  if (!state.workspaces.some((item) => item.id === state.activeWorkspaceId)) {
    state.activeWorkspaceId = state.workspaces[0].id;
    await writeJsonAtomic(statePath(dataRoot), state);
  }
  cachedStateRoot = dataRoot;
  cachedState = state;
  try {
    cachedStateMtime = (await fs.stat(stateFile)).mtimeMs;
  } catch (_) {
    cachedStateMtime = null;
  }
  return state;
}

// Saves for one file coalesce: while a write runs, later saves share one
// follow-up write of the newest object. The cache holds that object from the
// moment save is called, so a load during the write never re-reads the file.
const saveQueues = new Map();
const loadsInFlight = new Map();

function saveBusy(file) {
  const q = saveQueues.get(file);
  return Boolean(q && q.busy);
}

function normalizeWorkspace(ws) {
  if (!Array.isArray(ws.cards)) ws.cards = [];
  if (!Array.isArray(ws.library)) ws.library = [];
  if (!Array.isArray(ws.finished)) ws.finished = [];
  if (!Array.isArray(ws.links)) ws.links = [];
  return ws;
}

function loadWorkspaceSync(dataRoot, id) {
  const key = workspaceCacheKey(dataRoot, id);
  const file = workspacePath(dataRoot, id);
  const hit = cachedWorkspaces.get(key);
  if (hit && saveBusy(file)) return hit.ws;
  if (!fssync.existsSync(file)) return null;
  const stat = fssync.statSync(file);
  if (hit && hit.mtime === stat.mtimeMs && hit.size === stat.size) return hit.ws;
  const parsed = parseJsonDocument(fssync.readFileSync(file, "utf8"));
  const ws = parsed.value;
  if (mediaStore.needsCheck(ws)) {
    mediaStore.verifyWorkspaceSync(dataRoot, ws, { workspaceDir: workspaceDir(dataRoot, id) });
  }
  cachedWorkspaces.set(key, { ws, mtime: stat.mtimeMs, size: stat.size });
  return ws;
}

async function loadWorkspace(dataRoot, id) {
  const key = workspaceCacheKey(dataRoot, id);
  const file = workspacePath(dataRoot, id);
  let stat = null;
  try {
    stat = await fs.stat(file);
  } catch (_) {}
  const hit = cachedWorkspaces.get(key);
  if (hit && (saveBusy(file) || (stat && hit.mtime === stat.mtimeMs && hit.size === stat.size))) {
    return normalizeWorkspace(hit.ws);
  }
  // Concurrent misses (a burst of media requests after an outside write)
  // share one read, verify, and repair instead of racing each other.
  if (loadsInFlight.has(key)) return loadsInFlight.get(key);
  const run = readWorkspaceFile(dataRoot, id).finally(() => loadsInFlight.delete(key));
  loadsInFlight.set(key, run);
  return run;
}

async function readWorkspaceFile(dataRoot, id) {
  const key = workspaceCacheKey(dataRoot, id);
  const file = workspacePath(dataRoot, id);
  const ws = await readJson(file, null);
  if (ws) {
    let deferred = 0;
    if (mediaStore.needsCheck(ws)) {
      const check = await mediaStore.verifyWorkspace(dataRoot, ws, {
        workspacePath: file,
        workspaceDir: workspaceDir(dataRoot, id),
      });
      deferred = check.deferred || 0;
      ws.store = Object.assign({}, ws.store, { version: mediaStore.STORE_VERSION });
      if (check.changed) await writeJsonAtomic(file, ws);
    }
    if (absorbCardImages(ws)) await saveWorkspace(dataRoot, ws);
    normalizeWorkspace(ws);
    const live = cachedWorkspaces.get(key);
    if (live && live.ws !== ws && saveBusy(file)) return normalizeWorkspace(live.ws);
    const fresh = await fs.stat(file);
    cachedWorkspaces.set(key, { ws, mtime: fresh.mtimeMs, size: fresh.size });
    if (deferred) fillHashesLater(dataRoot, id);
    return ws;
  }
  const state = await loadState(dataRoot);
  const meta = state.workspaces.find((item) => item.id === id);
  const created = emptyWorkspace(id, meta ? meta.name : "Workspace");
  await writeJsonAtomic(workspacePath(dataRoot, id), created);
  const createdStat = await fs.stat(workspacePath(dataRoot, id));
  cachedWorkspaces.set(key, {
    ws: created,
    mtime: createdStat.mtimeMs,
    size: createdStat.size,
  });
  return created;
}

// Async lookup for the media protocol: null for an unknown id instead of
// creating a workspace, and no sync disk reads on the main thread.
async function loadWorkspaceIfExists(dataRoot, id) {
  if (!id || /[\\/]|\.\./.test(String(id))) return null;
  const file = workspacePath(dataRoot, id);
  const hit = cachedWorkspaces.get(workspaceCacheKey(dataRoot, id));
  if (!(hit && saveBusy(file))) {
    try {
      await fs.stat(file);
    } catch (_) {
      return null;
    }
  }
  return loadWorkspace(dataRoot, id);
}

// Big legacy files skip the content hash during load so the first snapshot
// is not stuck behind a multi-GB read; it is filled in here afterwards.
function fillHashesLater(dataRoot, id) {
  setTimeout(async () => {
    try {
      const ws = await loadWorkspace(dataRoot, id);
      if (await mediaStore.fillMissingHashes(ws, workspaceDir(dataRoot, id))) await saveWorkspace(dataRoot, ws);
    } catch (_) {}
  }, 2000);
}

async function saveWorkspace(dataRoot, ws) {
  ws.updatedAt = new Date().toISOString();
  const file = workspacePath(dataRoot, ws.id);
  const key = workspaceCacheKey(dataRoot, ws.id);
  const hit = cachedWorkspaces.get(key);
  cachedWorkspaces.set(key, { ws, mtime: hit ? hit.mtime : null, size: hit ? hit.size : null });
  let q = saveQueues.get(file);
  if (!q) saveQueues.set(file, (q = { tail: Promise.resolve(), waiting: null, busy: 0 }));
  if (q.waiting) {
    q.waiting.ws = ws;
    await q.waiting.done;
    return ws;
  }
  const job = { ws, done: null };
  q.waiting = job;
  q.busy += 1;
  job.done = q.tail
    .then(async () => {
      if (q.waiting === job) q.waiting = null;
      const stat = await writeJsonFile(file, job.ws);
      const now = cachedWorkspaces.get(key);
      if (!now || now.ws === job.ws) cachedWorkspaces.set(key, { ws: job.ws, mtime: stat.mtimeMs, size: stat.size });
    })
    .finally(() => {
      q.busy -= 1;
    });
  q.tail = job.done.catch(() => {});
  await job.done;
  return ws;
}

function publicWorkspace(ws) {
  return {
    id: ws.id,
    name: ws.name,
    createdAt: ws.createdAt,
    updatedAt: ws.updatedAt,
    library: ws.library,
    finished: ws.finished || [],
    links: ws.links,
    cards: ws.cards,
    cardImages: (ws.cardImages || []).map((item) => ({
      id: item.id,
      name: item.name,
      mime: item.mime,
      size: item.size,
      createdAt: item.createdAt,
    })),
  };
}

async function snapshot(dataRoot, workspaceId) {
  const state = await loadState(dataRoot);
  const id = workspaceId || state.activeWorkspaceId;
  const workspace = await loadWorkspace(dataRoot, id);
  return {
    dataRoot,
    activeWorkspaceId: state.activeWorkspaceId,
    workspaces: state.workspaces,
    workspace: publicWorkspace(workspace),
  };
}

function dataRootExists(dataRoot) {
  return fssync.existsSync(dataRoot);
}

module.exports = {
  STATE_VERSION,
  statePath,
  workspaceDir,
  workspacePath,
  ensureDir,
  writeJsonAtomic,
  readJson,
  parseJsonDocument,
  firstJsonValueEnd,
  emptyWorkspace,
  defaultCard,
  loadState,
  loadWorkspace,
  loadWorkspaceIfExists,
  loadWorkspaceSync,
  saveWorkspace,
  publicWorkspace,
  snapshot,
  dataRootExists,
};
