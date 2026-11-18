"use strict";

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { BrowserWindow, session } = require("electron");
const { BROWSER_TARGET_ID, isBrowserTarget } = require("./news-contract");
const { readState } = require("./agents-setup-state");
const { resolveEngine, searchUrlFor } = require("./browser-engines");

// Electron's default user agent gets refused by search sites. Match the
// Chromium version this Electron build actually embeds (Chromium 138).
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";
const LOAD_TIMEOUT_MS = 30000;

const SEARCH_TIMEOUT_MS = 30000;

let server = null;
let serverPort = 0;
let newsSession = null;
const windows = new Map();
let nextWindowId = 1;

function getSession() {
  if (!newsSession) newsSession = session.fromPartition("persist:cutline-news");
  return newsSession;
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res, status, obj) {
  // A route that already hit its queue timeout has a closed socket; a late
  // finish must not throw into an unhandled rejection.
  if (res.writableEnded || res.destroyed) return;
  setCors(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function withTimeout(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Page load timed out")), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function ensureWindow(windowId, show) {
  if (windowId && windows.has(windowId)) {
    return { win: windows.get(windowId), id: windowId };
  }
  if (!windowId) {
    for (const [id, win] of windows) {
      if (win && !win.isDestroyed()) return { win, id };
    }
  }
  const id = "win_" + nextWindowId++;
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    // Agent-driven calls pass show:false so pages load offscreen. The app
    // surfaces the window through the mini preview instead of popping it up.
    show: show === true,
    title: "JV browser",
    autoHideMenuBar: true,
    webPreferences: {
      session: getSession(),
      contextIsolation: true,
      nodeIntegration: false,
      enableRemoteModule: false,
      // Hidden windows do not rasterize otherwise, which would blank the
      // mini preview's capturePage snapshot.
      paintWhenInitiallyHidden: true,
      backgroundThrottling: false,
    },
  });
  if (win.webContents && win.webContents.setUserAgent) {
    win.webContents.setUserAgent(USER_AGENT);
  }
  win.on("page-title-updated", (event) => event.preventDefault());
  windows.set(id, win);
  win.on("closed", () => windows.delete(id));
  return { win, id };
}

async function loadUrl(win, url, timeoutMs) {
  if (!url) return;
  if (win.isDestroyed() || win.webContents.isDestroyed?.()) throw new Error("Browser window closed");
  const note = (phase) => {
    if (globalThis.cutlineNoteActivity) globalThis.cutlineNoteActivity("browser navigation " + phase);
  };
  note("start");
  try {
    await withTimeout(win.loadURL(url), timeoutMs || LOAD_TIMEOUT_MS);
    if (win.isDestroyed() || win.webContents.isDestroyed?.()) throw new Error("Browser window closed");
    note("complete");
  } catch (error) {
    note("failed " + (error.code || "navigation error"));
    throw error;
  }
}

async function closeWindow(windowId) {
  const win = windows.get(windowId);
  if (!win) throw new Error("Window not found: " + windowId);
  win.close();
  windows.delete(windowId);
  return { closed: true };
}

function pageText(win) {
  return win.webContents.executeJavaScript("(function() { return document.body ? document.body.innerText : ''; })()");
}

function pageTitle(win) {
  return win.webContents.executeJavaScript("(function() { return document.title || ''; })()");
}

// Resolve the persisted engine preference lazily on every call so a changed
// choice takes effect without restarting the server. Falls back to the default
// engine if the state file is missing, corrupt, or unreadable.
async function currentEngine() {
  try {
    const { app } = require("electron");
    const opts = app && typeof app.getPath === "function" ? { dataRoot: path.join(app.getPath("userData"), "data") } : {};
    const state = await readState(opts);
    return resolveEngine(state && state.browser && state.browser.engine);
  } catch {
    return resolveEngine(null);
  }
}

async function searchGeneric(win, query, site, engine) {
  const url = searchUrlFor(engine.id, query, site);
  if (!url) throw new Error("No search URL for engine: " + engine.id);
  await loadUrl(win, url, SEARCH_TIMEOUT_MS);
  const results = await win.webContents.executeJavaScript(
    `(function() {
      const here = location.origin;
      const seen = new Set();
      const out = [];
      const anchors = Array.from(document.querySelectorAll('a[href]'));
      for (const a of anchors) {
        const href = a.href || '';
        if (!/^https?:/i.test(href)) continue;
        try { if (new URL(href).origin === here) continue; } catch (e) { continue; }
        const title = (a.innerText || a.textContent || '').trim();
        if (title.length <= 3) continue;
        if (seen.has(href)) continue;
        seen.add(href);
        out.push({ title: title, link: href, url: href, snippet: '' });
        if (out.length >= 10) break;
      }
      return out;
    })()`
  );
  const full = site ? query + " site:" + site : query;
  return {
    query: full,
    results: Array.isArray(results) ? results : [],
    title: await pageTitle(win),
    url: win.webContents.getURL(),
  };
}

async function searchEngine(win, query, site, engineId) {
  return searchGeneric(win, query, site, resolveEngine(engineId));
}

async function clickSelector(win, selector) {
  await win.webContents.executeJavaScript(
    `(function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('Element not found: ' + ${JSON.stringify(selector)});
      el.click();
      return true;
    })()`
  );
  return { clicked: true };
}

async function typeInto(win, selector, text) {
  await win.webContents.executeJavaScript(
    `(function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('Element not found: ' + ${JSON.stringify(selector)});
      el.focus();
      el.value = ${JSON.stringify(text)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`
  );
  return { typed: true };
}

function sameSiteElectron(value) {
  const v = String(value || "").toLowerCase();
  if (v === "lax" || v === "strict" || v === "no_restriction") return v;
  if (v === "unspecified" || v === "none") return "no_restriction";
  return "no_restriction";
}

function cookieUrl(cookie) {
  if (cookie.url) return cookie.url;
  const domain = String(cookie.domain || "").replace(/^\./, "");
  const path = String(cookie.path || "/");
  const scheme = cookie.secure ? "https" : "http";
  return scheme + "://" + domain + path;
}

// Capture a static preview of the chosen start page from a dedicated hidden
// window. It shares the persistent session but never reuses (or gets reused
// by) a visible browser window, so a preview cannot navigate a window the
// user or an agent is looking at.
let previewWin = null;
let previewIdleTimer = null;
const PREVIEW_IDLE_MS = 60 * 1000;

// The hidden window must not hold the process open (window-all-closed)
// or live forever; retire it after a minute without a preview request.
function armPreviewIdle() {
  clearTimeout(previewIdleTimer);
  const win = previewWin;
  previewIdleTimer = setTimeout(() => {
    if (win && !win.isDestroyed()) win.destroy();
  }, PREVIEW_IDLE_MS);
  if (previewIdleTimer.unref) previewIdleTimer.unref();
}

function previewWindow() {
  if (previewWin && !previewWin.isDestroyed()) {
    armPreviewIdle();
    return previewWin;
  }
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    title: "JV browser",
    autoHideMenuBar: true,
    webPreferences: {
      session: getSession(),
      contextIsolation: true,
      nodeIntegration: false,
      enableRemoteModule: false,
      paintWhenInitiallyHidden: true,
      backgroundThrottling: false,
    },
  });
  if (win.webContents && win.webContents.setUserAgent) {
    win.webContents.setUserAgent(USER_AGENT);
  }
  win.on("page-title-updated", (event) => event.preventDefault());
  previewWin = win;
  win.on("closed", () => {
    if (previewWin === win) previewWin = null;
  });
  armPreviewIdle();
  return win;
}

async function previewBrowser() {
  const engine = await currentEngine();
  const win = previewWindow();
  if (engine.homeUrl && engine.homeUrl !== "about:blank") {
    await loadUrl(win, engine.homeUrl, LOAD_TIMEOUT_MS);
  }
  const image = await win.webContents.capturePage();
  return { png: image.toDataURL(), url: win.webContents.getURL(), windowId: "preview" };
}

// One setter for every import path (JSON exports, installed browsers). A
// cookie that fails validation is skipped, not fatal to the batch.
async function importCookieList(list) {
  const sess = getSession();
  let imported = 0;
  for (const cookie of Array.isArray(list) ? list : []) {
    if (!cookie || typeof cookie !== "object") continue;
    if (!cookie.name) continue;
    try {
      const details = {
        url: cookieUrl(cookie),
        name: cookie.name,
        value: cookie.value || "",
        domain: cookie.domain,
        path: cookie.path || "/",
        secure: Boolean(cookie.secure),
        httpOnly: Boolean(cookie.httpOnly),
        sameSite: sameSiteElectron(cookie.sameSite),
      };
      // Both expiry spellings land here: Electron's expirationDate and the
      // cookie-editor "expires". An expiry already in the past is a dead
      // cookie: skip it instead of resurrecting it as a session cookie.
      const expires = Number(cookie.expirationDate ?? cookie.expires);
      const now = Date.now() / 1000;
      if (Number.isFinite(expires) && expires > 0 && expires <= now) continue;
      if (Number.isFinite(expires) && expires > now) details.expirationDate = expires;
      await sess.cookies.set(details);
      imported += 1;
    } catch {
      /* skip malformed cookies */
    }
  }
  return { imported };
}

async function importCookies(path) {
  const raw = fs.readFileSync(path, "utf8");
  const parsed = JSON.parse(raw);
  const list = Array.isArray(parsed) ? parsed : parsed.cookies || [];
  return importCookieList(list);
}

// Pull cookies out of an installed browser profile into this session. The
// import itself lives in lib/browser-cookie-import.js; it never touches the
// live profile (a copied profile answers through the browser's own CDP).
async function importBrowserCookies(sourceId, options) {
  const { browserCookieSources, findSource, readSourceCookies, domainMatches } = require("./browser-cookie-import");
  const sources = browserCookieSources();
  const source = findSource(sources, sourceId);
  if (!source) throw new Error("Unknown cookie source: " + sourceId);
  // A bare string domain must narrow to that one site, never widen to all.
  const raw = options && options.domains;
  const domains = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  const list = (await readSourceCookies(source)).filter((cookie) => domainMatches(cookie && cookie.domain, domains));
  const result = await importCookieList(list);
  return { imported: result.imported, found: list.length, browser: source.browser, profile: source.profile, source: source.id };
}

function browserSources() {
  const { browserCookieSources } = require("./browser-cookie-import");
  return browserCookieSources().map((src) => ({
    id: src.id,
    browser: src.browser,
    profile: src.profile,
    kind: src.kind,
  }));
}

/* Screenshots land next to the rest of the app's durable data so the chat
   can link or render them after the run ends. */
function shotsDir() {
  const { app } = require("electron");
  const dir = path.join(app.getPath("userData"), "data", "browser-shots");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Shared capture for the HTTP screenshot route and the MCP image tool: find
// the element rect (scrolling it on screen first) and grab the pixels.
async function captureWindow(windowId, selector) {
  const { win, id } = await ensureWindow(windowId || null, false);
  let rect;
  const want = String(selector || "").trim();
  if (want) {
    // Scroll the element into view first: capturePage rects are relative to
    // the visible frame, so an off-screen element needs a scroll before the
    // bounding box lines up with the pixels.
    rect = await win.webContents.executeJavaScript(
      `(function() {
        const el = document.querySelector(${JSON.stringify(want)});
        if (!el) throw new Error('Element not found: ' + ${JSON.stringify(want)});
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        return { x: Math.max(0, Math.floor(r.x)), y: Math.max(0, Math.floor(r.y)), width: Math.ceil(r.width), height: Math.ceil(r.height) };
      })()`,
    );
    if (!rect || rect.width < 2 || rect.height < 2) throw new Error("Element has no visible area: " + want);
  }
  const image = await win.webContents.capturePage(rect || undefined);
  return { win, id, image };
}

async function screenshotPage(windowId, selector) {
  const { win, id, image } = await captureWindow(windowId, selector);
  const file = path.join(shotsDir(), "shot-" + Date.now() + ".png");
  fs.writeFileSync(file, image.toPNG());
  return { windowId: id, path: file, url: win.webContents.getURL(), title: win.webContents.getTitle() };
}

async function scrollPage(windowId, amount, selector) {
  const { win, id } = await ensureWindow(windowId || null, false);
  const want = String(selector || "").trim();
  const n = Number(amount);
  // Negative amounts scroll back up; a missing or zero amount is one page.
  const px = Number.isFinite(n) && n !== 0 ? Math.sign(n) * Math.min(5000, Math.max(100, Math.abs(n))) : 800;
  const metrics = await win.webContents.executeJavaScript(
    `(function() {
      const el = ${JSON.stringify(want)} ? document.querySelector(${JSON.stringify(want)}) : null;
      if (el) el.scrollIntoView({ block: "center" });
      else window.scrollBy(0, ${px});
      return { found: Boolean(el), scrollY: Math.round(window.scrollY), scrollHeight: document.documentElement ? document.documentElement.scrollHeight : 0 };
    })()`,
  );
  const out = { windowId: id, scrolled: true, scrollY: metrics && metrics.scrollY, scrollHeight: metrics && metrics.scrollHeight };
  if (want) out.found = Boolean(metrics && metrics.found);
  return out;
}

async function evaluatePage(windowId, expression) {
  const { win, id } = await ensureWindow(windowId, false);
  const value = await win.webContents.executeJavaScript(String(expression || ""), true);
  // Page objects are not always JSON-shaped; round-trip so the caller never
  // gets a value it cannot serialize.
  let out = value;
  try {
    out = JSON.parse(JSON.stringify(value === undefined ? null : value));
  } catch {
    out = String(value);
  }
  return { windowId: id, url: win.webContents.getURL(), title: win.webContents.getTitle(), value: out };
}

/* Ask-for-help: the agent posts a question, the app flashes its window and
   drops a card in the chat, and the route stays open until the user answers
   or the wait times out. */

const pendingAsks = new Map();
let nextAskId = 1;
const ASK_TIMEOUT_MS = 10 * 60 * 1000;

// App windows = every BrowserWindow except the agent's own browser windows.
function appWindows() {
  const news = new Set(windows.values());
  return BrowserWindow.getAllWindows().filter((win) => win && !win.isDestroyed() && !news.has(win));
}

function broadcastAsk(ask) {
  for (const win of appWindows()) {
    try {
      win.webContents.send("agent-event", { event: "ask-user", payload: ask });
      win.flashFrame(true);
    } catch {
      /* window may be mid-teardown */
    }
  }
}

function askUser(question, timeoutMs) {
  const askId = "ask_" + nextAskId++;
  const wait = Number.isFinite(Number(timeoutMs)) ? Math.max(5000, Math.min(30 * 60 * 1000, Number(timeoutMs))) : ASK_TIMEOUT_MS;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingAsks.delete(askId);
      resolve({ askId, answer: "", timedOut: true });
    }, wait);
    pendingAsks.set(askId, {
      resolve: (result) => {
        clearTimeout(timer);
        resolve(result);
      },
    });
    const ask = { askId, question: String(question || ""), at: new Date().toISOString() };
    try {
      broadcastAsk(ask);
    } catch {
      /* still resolve on timeout or an explicit answer */
    }
  });
}

// The renderer's answer resolves the waiting tool call. Unknown ids (expired
// or already answered) are ignored so a stale card cannot crash anything.
function answerAsk(askId, result) {
  const entry = pendingAsks.get(String(askId || ""));
  if (!entry) return { answered: false };
  pendingAsks.delete(String(askId));
  const out = { askId: String(askId), answer: String((result && result.answer) || "") };
  if (result && result.skipped) out.skipped = true;
  entry.resolve(out);
  return { answered: true };
}

function settlePendingAsks(reason) {
  for (const [askId, entry] of pendingAsks) {
    pendingAsks.delete(askId);
    try {
      entry.resolve({ askId, answer: "", timedOut: true, reason });
    } catch {
      /* gone already */
    }
  }
}

// Scan common export locations for JSON cookie exports, newest first.
async function listCookieExports() {
  const { app } = require("electron");
  if (!app || typeof app.getPath !== "function") return [];
  const dirs = [];
  for (const key of ["downloads", "documents", "desktop"]) {
    try {
      dirs.push({ dir: app.getPath(key), label: key[0].toUpperCase() + key.slice(1) });
    } catch {}
  }
  const matches = [];
  for (const { dir, label } of dirs) {
    const files = await fs.promises.readdir(dir).catch(() => []);
    for (const name of files) {
      const lower = name.toLowerCase();
      if (!lower.endsWith(".json") || !lower.includes("cookie")) continue;
      const file = path.join(dir, name);
      const stat = await fs.promises.stat(file).catch(() => null);
      if (stat && stat.isFile()) {
        matches.push({ path: file, name, dir: label, mtime: stat.mtime.toISOString(), size: stat.size });
      }
    }
  }
  matches.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
  return matches;
}

// Import the newest detected cookie export.
async function autoFindCookies() {
  const matches = await listCookieExports();
  const first = matches[0];
  if (!first) return { imported: 0, path: "" };
  const outcome = await importCookies(first.path);
  return { imported: outcome.imported, path: first.path };
}

async function handle(req, res) {
  if (req.method === "OPTIONS") {
    setCors(res);
    res.writeHead(204);
    res.end();
    return;
  }
  const parts = req.url.split("?");
  const route = parts[0];
  try {
    if (req.method === "GET" && route === "/health") {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "Method not allowed" });
      return;
    }
    const body = await readBody(req);
    if (route === "/open") {
      const { win, id } = await ensureWindow(null, body.show === true);
      if (body.url) await loadUrl(win, body.url);
      sendJson(res, 200, { windowId: id, url: win.webContents.getURL(), title: win.webContents.getTitle() });
      return;
    }
    if (route === "/navigate") {
      const { win, id } = await ensureWindow(body.windowId, false);
      if (body.url) await loadUrl(win, body.url);
      sendJson(res, 200, { windowId: id, url: win.webContents.getURL(), title: win.webContents.getTitle() });
      return;
    }
    if (route === "/search") {
      const { win, id } = await ensureWindow(body.windowId, body.show === true);
      const engine = await currentEngine();
      const result = await searchEngine(win, String(body.query || ""), body.site, engine.id);
      result.windowId = id;
      sendJson(res, 200, result);
      return;
    }
    if (route === "/click") {
      const { win, id } = await ensureWindow(body.windowId, false);
      await clickSelector(win, String(body.selector || ""));
      sendJson(res, 200, { windowId: id, clicked: true });
      return;
    }
    if (route === "/type") {
      const { win, id } = await ensureWindow(body.windowId, false);
      await typeInto(win, String(body.selector || ""), String(body.text || ""));
      sendJson(res, 200, { windowId: id, typed: true });
      return;
    }
    if (route === "/read") {
      const { win, id } = await ensureWindow(body.windowId, false);
      const text = await pageText(win);
      sendJson(res, 200, { windowId: id, url: win.webContents.getURL(), title: win.webContents.getTitle(), text });
      return;
    }
    if (route === "/screenshot") {
      const result = await screenshotPage(body.windowId, body.selector);
      sendJson(res, 200, result);
      return;
    }
    if (route === "/scroll") {
      const result = await scrollPage(body.windowId, body.amount);
      sendJson(res, 200, result);
      return;
    }
    if (route === "/evaluate") {
      const result = await evaluatePage(body.windowId, body.expression);
      sendJson(res, 200, result);
      return;
    }
    if (route === "/browser-sources") {
      sendJson(res, 200, { sources: browserSources() });
      return;
    }
    if (route === "/browser-import") {
      const result = await importBrowserCookies(String(body.sourceId || body.browser || ""));
      sendJson(res, 200, result);
      return;
    }
    if (route === "/ask") {
      const result = await askUser(String(body.question || ""), body.timeoutMs);
      sendJson(res, 200, result);
      return;
    }
    if (route === "/cookies") {
      const result = await importCookies(String(body.path || ""));
      sendJson(res, 200, result);
      return;
    }
    if (route === "/close") {
      await closeWindow(String(body.windowId || ""));
      sendJson(res, 200, { closed: true });
      return;
    }
    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
}

// A wedged renderer (crashed tab, stalled GPU) can leave executeJavaScript or
// capturePage pending forever; without a cap, that one call would freeze the
// serialized queue for every later route. /ask gets its own long window and
// the browser import needs room for a cold headless launch.
const ROUTE_TIMEOUT_MS = 45000;
const ROUTE_TIMEOUTS = { "/ask": 31 * 60 * 1000, "/browser-import": 120000 };

// The MCP bridge calls the browser in-process, outside the HTTP queue (an
// /ask wait there can run 30 minutes). Bridge calls get their own serialized
// queue with the same cap, so a wedged renderer fails one tool call instead
// of hanging the outside agent.
let agentCalls = Promise.resolve();
function agentCall(fn, capMs) {
  const run = agentCalls.then(() => {
    let timer;
    return Promise.race([
      Promise.resolve().then(fn),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Browser call timed out")), capMs || ROUTE_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
  });
  agentCalls = run.catch(() => {});
  return run;
}

async function ensureNewsBrowserServer() {
  if (server) return serverPort;
  let requests = Promise.resolve();
  server = http.createServer((req, res) => {
    const route = (req.url || "").split("?")[0];
    const cap = ROUTE_TIMEOUTS[route] || ROUTE_TIMEOUT_MS;
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Browser route timed out")), cap),
    );
    const request = requests.then(() =>
      Promise.race([handle(req, res), timeout]).catch((error) => {
        try {
          sendJson(res, error && error.message === "Browser route timed out" ? 504 : 500, {
            error: error instanceof Error ? error.message : String(error),
          });
        } catch {
          /* response already closed */
        }
      }),
    );
    requests = request.catch(() => {});
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  serverPort = address && typeof address === "object" ? address.port : 0;
  return serverPort;
}

function getNewsBrowserPort() {
  return serverPort;
}

function stopNewsBrowserServer() {
  settlePendingAsks("server-stopped");
  for (const win of windows.values()) {
    try {
      if (!win.isDestroyed()) win.close();
    } catch {}
  }
  windows.clear();
  if (server) {
    try {
      server.close();
    } catch {}
    server = null;
    serverPort = 0;
  }
}

const { app } = require("electron");
if (app && typeof app.on === "function") {
  app.on("before-quit", stopNewsBrowserServer);
}

async function openBrowserWindow(url) {
  const existing = Array.from(windows.entries()).find(([, win]) => win && !win.isDestroyed());
  const { win, id } = existing ? { win: existing[1], id: existing[0] } : await ensureWindow(null, true);
  const blank = !win.webContents.getURL() || win.webContents.getURL() === "about:blank";
  if (url || blank) {
    let start = url;
    if (!start) {
      try {
        start = (await currentEngine()).homeUrl;
      } catch {
        /* fall back to the constant start page */
      }
    }
    await loadUrl(win, start);
  }
  win.show();
  win.focus();
  return { windowId: id, url: win.webContents.getURL(), title: win.webContents.getTitle() };
}

// What the app's mini preview needs: which agent windows exist, where they
// are, and whether the user already expanded one into a real window.
function browserState() {
  const out = [];
  for (const [id, win] of windows) {
    if (!win || win.isDestroyed()) continue;
    out.push({
      windowId: id,
      url: win.webContents.getURL(),
      title: win.webContents.getTitle(),
      visible: win.isVisible(),
    });
  }
  return out;
}

// Thumbnail for the in-app preview. Sized down so the renderer can repaint
// often without shuffling full frames over IPC.
async function browserSnapshot(windowId) {
  const win = windows.get(windowId);
  if (!win || win.isDestroyed()) throw new Error("Window not found: " + windowId);
  // Software-rendered capturePage has faulted the host under memory pressure;
  // refuse the thumbnail while the machine is nearly out of RAM.
  if (os.freemem() < 200 * 1024 * 1024) throw new Error("low memory");
  if (globalThis.cutlineNoteActivity) globalThis.cutlineNoteActivity("capturePage snapshot " + windowId);
  const image = await win.webContents.capturePage();
  const small = image && typeof image.resize === "function" ? image.resize({ width: 480 }) : image;
  return {
    windowId,
    url: win.webContents.getURL(),
    title: win.webContents.getTitle(),
    visible: win.isVisible(),
    png: small ? small.toDataURL() : "",
  };
}

// Reveal and hide are app-side only: they are not exposed on the agent HTTP
// server, so a tool call can never pop a window over the user's screen.
function revealBrowserWindow(windowId) {
  const win = windows.get(windowId);
  if (!win || win.isDestroyed()) throw new Error("Window not found: " + windowId);
  win.show();
  win.focus();
  return { windowId, visible: true };
}

function hideBrowserWindow(windowId) {
  const win = windows.get(windowId);
  if (!win || win.isDestroyed()) throw new Error("Window not found: " + windowId);
  win.hide();
  return { windowId, visible: false };
}

async function cookieStats() {
  const cookies = await getSession().cookies.get({});
  return { count: cookies.length };
}

async function clearCookies() {
  const ses = getSession();
  const cookies = await ses.cookies.get({});
  await ses.clearStorageData({ storages: ["cookies"] });
  return { cleared: cookies.length };
}

async function cookieDetails() {
  const cookies = await getSession().cookies.get({});
  const domains = new Set();
  for (const cookie of cookies) {
    if (!cookie || !cookie.domain) continue;
    domains.add(cookie.domain.replace(/^\./, ""));
  }
  return { count: cookies.length, domains: Array.from(domains).sort() };
}

// Agent-side browser actions. Values of cookies never leave the session here;
// only names and domains are listed. The MCP bridge calls the exported
// wrappers below; each one serializes through agentCall so a wedged renderer
// fails one tool call instead of hanging the outside agent.

// capturePage has faulted under memory pressure; refuse while low on RAM.
async function screenshotWindowCore(windowId, width, selector) {
  if (os.freemem() < 200 * 1024 * 1024) throw new Error("low memory");
  const { win, id, image } = await captureWindow(windowId, selector);
  const w = Math.max(320, Math.min(1920, Number(width) || 1280));
  const sized = image.getSize().width > w ? image.resize({ width: w }) : image;
  return { windowId: id, url: win.webContents.getURL(), title: win.webContents.getTitle(), png: sized.toPNG().toString("base64") };
}

async function pressKeyCore(windowId, key) {
  const { win, id } = await ensureWindow(windowId || null, false);
  const keyCode = String(key || "Enter");
  win.webContents.sendInputEvent({ type: "keyDown", keyCode });
  if (keyCode.length === 1) win.webContents.sendInputEvent({ type: "char", keyCode });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode });
  return { windowId: id, pressed: keyCode };
}

function waitSelectorMs(timeoutMs) {
  return Math.min(60000, Math.max(250, Number(timeoutMs) || 10000));
}

async function waitForSelectorCore(windowId, selector, waitMs) {
  const { win, id } = await ensureWindow(windowId || null, false);
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const found = await win.webContents.executeJavaScript(
      "Boolean(document.querySelector(" + JSON.stringify(String(selector || "")) + "))",
    );
    if (found) return { windowId: id, found: true };
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { windowId: id, found: false };
}

async function listCookieNames(domain) {
  const filter = domain ? { domain: String(domain) } : {};
  const cookies = await getSession().cookies.get(filter);
  return {
    count: cookies.length,
    cookies: cookies.slice(0, 500).map((c) => ({ name: c.name, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly })),
  };
}

async function agentOpenCore(url, windowId) {
  const { win, id } = await ensureWindow(windowId || null, false);
  if (url) await loadUrl(win, url);
  return { windowId: id, url: win.webContents.getURL(), title: win.webContents.getTitle() };
}

async function agentSearchCore(query, site, windowId) {
  const { win, id } = await ensureWindow(windowId || null, false);
  const engine = await currentEngine();
  const result = await searchEngine(win, String(query || ""), site, engine.id);
  result.windowId = id;
  return result;
}

async function agentClickCore(windowId, selector) {
  const { win, id } = await ensureWindow(windowId || null, false);
  await clickSelector(win, String(selector || ""));
  return { windowId: id, clicked: true };
}

async function agentTypeCore(windowId, selector, text) {
  const { win, id } = await ensureWindow(windowId || null, false);
  await typeInto(win, String(selector || ""), String(text || ""));
  return { windowId: id, typed: true };
}

async function agentReadCore(windowId) {
  const { win, id } = await ensureWindow(windowId || null, false);
  const text = await pageText(win);
  return { windowId: id, url: win.webContents.getURL(), title: win.webContents.getTitle(), text: String(text || "").slice(0, 200000) };
}

// The names and argument order electron/agent-bridge.cjs calls, each a thin
// agentCall wrapper around a core. closeWindow and listCookieNames are not
// queued: an agent must still be able to close or inspect a wedged window.
function agentOpen(url, windowId) {
  return agentCall(() => agentOpenCore(url, windowId));
}

function agentSearch(query, site, windowId) {
  return agentCall(() => agentSearchCore(query, site, windowId));
}

function agentClick(windowId, selector) {
  return agentCall(() => agentClickCore(windowId, selector));
}

function agentType(windowId, selector, text) {
  return agentCall(() => agentTypeCore(windowId, selector, text));
}

function agentRead(windowId) {
  return agentCall(() => agentReadCore(windowId));
}

function pressKey(windowId, key) {
  return agentCall(() => pressKeyCore(windowId, key));
}

function scrollWindow(windowId, dy, selector) {
  return agentCall(() => scrollPage(windowId, dy === undefined ? 600 : dy, selector));
}

function evalInWindow(windowId, script) {
  return agentCall(() => evaluatePage(windowId, script));
}

function screenshotWindow(windowId, width, selector) {
  return agentCall(() => screenshotWindowCore(windowId, width, selector));
}

function waitForSelector(windowId, selector, timeoutMs) {
  const wait = waitSelectorMs(timeoutMs);
  return agentCall(() => waitForSelectorCore(windowId, selector, wait), wait + 5000);
}

module.exports = {
  agentCall,
  closeWindow,
  evalInWindow,
  screenshotWindow,
  pressKey,
  scrollWindow,
  waitForSelector,
  listCookieNames,
  agentOpen,
  agentSearch,
  agentClick,
  agentType,
  agentRead,
  BROWSER_TARGET_ID,
  isBrowserTarget,
  importCookies,
  importCookieList,
  importBrowserCookies,
  browserSources,
  answerAsk,
  screenshotPage,
  scrollPage,
  evaluatePage,
  autoFindCookies,
  listCookieExports,
  previewBrowser,
  openBrowserWindow,
  browserState,
  browserSnapshot,
  revealBrowserWindow,
  hideBrowserWindow,
  cookieStats,
  cookieDetails,
  clearCookies,
  ensureNewsBrowserServer,
  getNewsBrowserPort,
  stopNewsBrowserServer,
};
