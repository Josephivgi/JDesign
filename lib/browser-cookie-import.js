"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

// Reads cookies out of the browsers installed on this computer so the agent
// browser can share the user's sign-ins. Nothing leaves the machine: cookies
// move from the local profile into the app's own session partition.
//
// Firefox stores cookies unencrypted in a sqlite db, so a file copy is
// enough. Chromium encrypts them with a key only that browser can unwrap, so
// the browser itself has to hand them over: the profile is copied to a temp
// dir, that copy launches headless with remote debugging, and CDP returns
// the decrypted values. The real profile is never opened or touched.

const CHROMIUM_DEFS = [
  {
    id: "chrome",
    browser: "Chrome",
    exes: [
      ["programFiles", "Google", "Chrome", "Application", "chrome.exe"],
      ["programFilesX86", "Google", "Chrome", "Application", "chrome.exe"],
      ["localAppData", "Google", "Chrome", "Application", "chrome.exe"],
    ],
    userDataDir: ["localAppData", "Google", "Chrome", "User Data"],
  },
  {
    id: "edge",
    browser: "Edge",
    exes: [
      ["programFilesX86", "Microsoft", "Edge", "Application", "msedge.exe"],
      ["programFiles", "Microsoft", "Edge", "Application", "msedge.exe"],
    ],
    userDataDir: ["localAppData", "Microsoft", "Edge", "User Data"],
  },
  {
    id: "brave",
    browser: "Brave",
    exes: [
      ["programFiles", "BraveSoftware", "Brave-Browser", "Application", "brave.exe"],
      ["programFilesX86", "BraveSoftware", "Brave-Browser", "Application", "brave.exe"],
      ["localAppData", "BraveSoftware", "Brave-Browser", "Application", "brave.exe"],
    ],
    userDataDir: ["localAppData", "BraveSoftware", "Brave-Browser", "User Data"],
  },
];

function baseDirs(env) {
  const e = env || process.env;
  const home = os.homedir();
  return {
    appData: e.APPDATA || path.join(home, "AppData", "Roaming"),
    localAppData: e.LOCALAPPDATA || path.join(home, "AppData", "Local"),
    programFiles: e.ProgramFiles || e["PROGRAMFILES"] || "C:\\Program Files",
    programFilesX86: e["ProgramFiles(x86)"] || e["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)",
  };
}

function joinUnder(dirs, parts) {
  const base = dirs[parts[0]];
  return base ? path.join(base, ...parts.slice(1)) : "";
}

function firstExisting(candidates) {
  for (const file of candidates) {
    try {
      if (file && fs.statSync(file).isFile()) return file;
    } catch {
      /* keep looking */
    }
  }
  return "";
}

function chromiumProfiles(userDataDir) {
  let names = [];
  try {
    names = fs
      .readdirSync(userDataDir, { withFileTypes: true })
      .filter((ent) => ent.isDirectory() && (ent.name === "Default" || /^Profile \d+$/.test(ent.name)))
      .map((ent) => ent.name);
  } catch {
    names = [];
  }
  if (!names.includes("Default")) names.unshift("Default");
  return names;
}

function chromiumCookieDb(userDataDir, profile) {
  const dir = path.join(userDataDir, profile);
  const modern = path.join(dir, "Network", "Cookies");
  const legacy = path.join(dir, "Cookies");
  const db = firstExisting([modern, legacy]);
  return db ? { db, dir } : null;
}

function firefoxProfiles(appData) {
  const root = path.join(appData, "Mozilla", "Firefox", "Profiles");
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const db = path.join(root, ent.name, "cookies.sqlite");
    try {
      if (fs.statSync(db).isFile()) out.push({ profile: ent.name, dir: path.join(root, ent.name), db });
    } catch {
      /* no db in this profile */
    }
  }
  return out;
}

// What the setup UI lists and what an import call names: one row per browser
// profile that can hand over cookies.
function browserCookieSources(options) {
  const opts = options || {};
  const dirs = baseDirs(opts.env);
  const out = [];
  for (const prof of firefoxProfiles(dirs.appData)) {
    out.push({
      id: "firefox:" + prof.profile,
      browser: "Firefox",
      kind: "firefox",
      profile: prof.profile,
      profileDir: prof.dir,
      dbFile: prof.db,
    });
  }
  for (const def of CHROMIUM_DEFS) {
    const userDataDir = joinUnder(dirs, def.userDataDir);
    const exe = firstExisting(def.exes.map((parts) => joinUnder(dirs, parts)));
    for (const profile of chromiumProfiles(userDataDir)) {
      const found = chromiumCookieDb(userDataDir, profile);
      if (!found) continue;
      out.push({
        id: def.id + ":" + profile,
        browser: def.browser,
        kind: "chromium",
        profile,
        userDataDir,
        cookieDb: found.db,
        exe,
      });
    }
  }
  return out;
}

function findSource(sources, sourceId) {
  const want = String(sourceId || "").trim();
  if (!want) return null;
  return (Array.isArray(sources) ? sources : []).find((src) => src.id === want) || null;
}

// A cookie belongs when its host is one of the wanted domains or sits under
// it. Leading dots on either side are ignored; an empty list matches all.
function domainMatches(host, domains) {
  if (!domains || !domains.length) return true;
  const h = String(host || "").replace(/^\./, "").toLowerCase();
  return domains.some((d) => {
    const want = String(d || "").replace(/^\./, "").toLowerCase();
    return h === want || h.endsWith("." + want);
  });
}

// Pick one cookie source for a tool call: an exact sourceId, else the browser
// kind plus an optional profile. "Default" wins when no profile is named;
// Firefox's "abcd.default-release" suffix style matches on the tail.
function resolveSource(sources, query) {
  const q = query || {};
  if (q.sourceId) return findSource(sources, q.sourceId);
  const kind = String(q.browser || "").toLowerCase();
  if (!kind) return null;
  const pool = (Array.isArray(sources) ? sources : []).filter((src) => src && String(src.id).startsWith(kind + ":"));
  if (!pool.length) return null;
  const profile = String(q.profile || "").trim();
  if (profile) {
    return pool.find((src) => src.profile === profile || String(src.profile || "").endsWith("." + profile)) || null;
  }
  return pool.find((src) => src.profile === "Default") || pool[0];
}

/* Firefox */

// The main db must copy; a running browser holds it exclusively and the
// honest answer is "close it and retry", not a silently empty import.
function copyWithSidecars(file, destDir, browser) {
  fs.mkdirSync(destDir, { recursive: true });
  const base = path.basename(file);
  const dest = path.join(destDir, base);
  try {
    fs.copyFileSync(file, dest);
  } catch (error) {
    if (error && (error.code === "EBUSY" || error.code === "EPERM")) {
      throw new Error(browser + " is running and holds its cookie file; close " + browser + " and retry");
    }
    throw error;
  }
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try {
      fs.copyFileSync(file + suffix, dest + suffix);
    } catch {
      /* missing sidecar is fine */
    }
  }
  return dest;
}

function readFirefoxCookies(dbFile, options) {
  const opts = options || {};
  const { DatabaseSync } = require("node:sqlite");
  const tmp = fs.mkdtempSync(path.join(opts.tmpDir || os.tmpdir(), "cutline-fxcookies-"));
  try {
    const copy = copyWithSidecars(dbFile, tmp, "Firefox");
    const db = new DatabaseSync(copy, { readOnly: true });
    try {
      return db
        .prepare(
          "SELECT host, name, value, path, expiry, isSecure, isHttpOnly, sameSite FROM moz_cookies",
        )
        .all();
    } finally {
      db.close();
    }
  } finally {
    // A cleanup failure must not mask the rows read or the real error.
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* the startup temp sweep removes leftovers */
    }
  }
}

// moz_cookies.sameSite: 0 unset, 1 lax, 2 strict, 3 none.
function firefoxSameSite(value) {
  if (value === 1) return "lax";
  if (value === 2) return "strict";
  if (value === 3) return "no_restriction";
  return "unspecified";
}

function firefoxRowToCookie(row) {
  if (!row || !row.name) return null;
  const domain = String(row.host || "");
  const bare = domain.replace(/^\./, "");
  if (!bare) return null;
  const cookie = {
    url: (row.isSecure ? "https" : "http") + "://" + bare + String(row.path || "/"),
    name: String(row.name),
    value: String(row.value == null ? "" : row.value),
    domain,
    path: String(row.path || "/"),
    secure: Boolean(row.isSecure),
    httpOnly: Boolean(row.isHttpOnly),
    sameSite: firefoxSameSite(Number(row.sameSite)),
  };
  const expiry = Number(row.expiry);
  if (Number.isFinite(expiry) && expiry > 0) cookie.expirationDate = expiry;
  return cookie;
}

/* Chromium via CDP on a copied profile */

function copyChromiumProfile(source, tmpRoot) {
  const userData = path.join(tmpRoot, "User Data");
  fs.mkdirSync(userData, { recursive: true });
  const localState = path.join(source.userDataDir, "Local State");
  try {
    fs.copyFileSync(localState, path.join(userData, "Local State"));
  } catch {
    /* older installs may lack it */
  }
  const realProfileDir = path.join(source.userDataDir, source.profile);
  const cookieDir = path.dirname(source.cookieDb);
  const rel = path.relative(realProfileDir, cookieDir);
  const destCookieDir = path.join(userData, source.profile, rel);
  fs.mkdirSync(destCookieDir, { recursive: true });
  const base = path.basename(source.cookieDb);
  const dest = path.join(destCookieDir, base);
  try {
    fs.copyFileSync(source.cookieDb, dest);
  } catch (error) {
    if (error && (error.code === "EBUSY" || error.code === "EPERM")) {
      throw new Error(source.browser + " is running and holds its cookie file; close " + source.browser + " and retry");
    }
    throw error;
  }
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try {
      fs.copyFileSync(source.cookieDb + suffix, dest + suffix);
    } catch {
      /* missing sidecar is fine */
    }
  }
  return userData;
}

function cdpSameSite(value) {
  const v = String(value || "").toLowerCase();
  if (v === "strict") return "strict";
  if (v === "lax") return "lax";
  if (v === "none") return "no_restriction";
  return "unspecified";
}

function cdpCookieToElectron(row) {
  if (!row || !row.name) return null;
  const domain = String(row.domain || "");
  const bare = domain.replace(/^\./, "");
  if (!bare) return null;
  const cookie = {
    url: (row.secure ? "https" : "http") + "://" + bare + String(row.path || "/"),
    name: String(row.name),
    value: String(row.value == null ? "" : row.value),
    domain,
    path: String(row.path || "/"),
    secure: Boolean(row.secure),
    httpOnly: Boolean(row.httpOnly),
    sameSite: cdpSameSite(row.sameSite),
  };
  const expires = Number(row.expires);
  if (Number.isFinite(expires) && expires > 0) cookie.expirationDate = expires;
  return cookie;
}

// Windows browser exes are launchers: the spawned process hands off to the
// real browser and exits at once, so the DevTools endpoint is discovered via
// the DevToolsActivePort file the browser writes inside the (copied)
// user-data dir: line 1 = port, line 2 = ws path.
function waitDevToolsPortFile(userDataDir, timeoutMs) {
  const file = path.join(userDataDir, "DevToolsActivePort");
  const deadline = Date.now() + (timeoutMs || 20000);
  return new Promise((resolve, reject) => {
    const poll = () => {
      let txt = "";
      try {
        txt = fs.readFileSync(file, "utf8");
      } catch {
        txt = "";
      }
      const lines = txt.split(/\r?\n/).filter((s) => s.trim().length > 0);
      if (lines.length >= 2 && /^\d+$/.test(lines[0].trim())) {
        resolve("ws://127.0.0.1:" + lines[0].trim() + lines[1].trim());
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("Browser did not expose remote debugging"));
        return;
      }
      setTimeout(poll, 250);
    };
    poll();
  });
}

function cdpRequest(ws, method, params) {
  return new Promise((resolve, reject) => {
    const id = cdpRequest.nextId = (cdpRequest.nextId || 0) + 1;
    const onMessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
      } catch {
        return;
      }
      if (msg && msg.id === id) {
        ws.removeEventListener("message", onMessage);
        if (msg.error) reject(new Error(msg.error.message || "CDP call failed"));
        else resolve(msg.result);
      }
    };
    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}

function wsOpen(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      reject(new Error("Could not reach the browser debug socket"));
    }, timeoutMs || 10000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("Could not reach the browser debug socket"));
    });
  });
}

// Copy the profile, let the browser itself decrypt its cookie store over its
// own debug protocol, then shut it down through CDP and throw the copy away.
async function readChromiumCookies(source, options) {
  const opts = options || {};
  if (!source.exe) throw new Error(source.browser + " is not installed.");
  const spawnImpl = opts.spawnImpl || spawn;
  const tmp = fs.mkdtempSync(path.join(opts.tmpDir || os.tmpdir(), "cutline-cookies-"));
  let cookies = null;
  let failMsg = "";
  try {
    const userData = copyChromiumProfile(source, tmp);
    // The spawned launcher exits at once; the real browser writes
    // DevToolsActivePort into our copied profile dir when debugging is up.
    const proc = spawnImpl(source.exe, [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-sync",
      "--disable-background-networking",
      "--remote-debugging-port=0",
      "--user-data-dir=" + userData,
      "about:blank",
    ], { stdio: ["ignore", "ignore", "ignore"] });
    proc.on("error", () => {});
    try {
      const wsUrl = await waitDevToolsPortFile(userData, opts.timeoutMs || 20000);
      const ws = await wsOpen(wsUrl, opts.timeoutMs || 10000);
      try {
        const result = await cdpRequest(ws, "Storage.getCookies");
        cookies = Array.isArray(result && result.cookies) ? result.cookies : [];
        // Graceful shutdown of the whole browser tree through its own protocol.
        try {
          await cdpRequest(ws, "Browser.close");
        } catch {
          /* shutdown races are fine */
        }
      } finally {
        try {
          ws.close();
        } catch {}
      }
    } catch (error) {
      failMsg = error instanceof Error ? error.message : String(error);
    }
    // If CDP shutdown did not take, find the browser by its unique
    // user-data-dir on the command line and stop it.
    await killByCommandLineMatch(userData);
  } finally {
    // The browser may still hold file locks briefly; retry the cleanup.
    for (let i = 0; i < 20; i += 1) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
        break;
      } catch {
        await sleep(250);
      }
    }
  }
  if (cookies === null) throw new Error(failMsg || "Browser did not return cookies");
  return cookies;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Fallback shutdown: match the temp user-data dir on live command lines.
function killByCommandLineMatch(userDataDir) {
  const token = userDataDir.replace(/\\/g, "\\");
  const ps =
    "Get-CimInstance Win32_Process -Filter \"Name like '%.exe'\" | " +
    "Where-Object { $_.CommandLine -and $_.CommandLine.Contains('" + token.replace(/'/g, "''") + "') } | " +
    "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
  return new Promise((resolve) => {
    const p = spawn("powershell.exe", ["-NoProfile", "-Command", ps], { stdio: "ignore" });
    p.on("exit", () => resolve());
    p.on("error", () => resolve());
    setTimeout(resolve, 8000);
  });
}

// One source -> a list of Electron-shaped cookies ready for ses.cookies.set.
async function readSourceCookies(source, options) {
  if (!source) throw new Error("Unknown cookie source.");
  if (source.kind === "firefox") {
    return readFirefoxCookies(source.dbFile, options).map(firefoxRowToCookie).filter(Boolean);
  }
  if (source.kind === "chromium") {
    return (await readChromiumCookies(source, options)).map(cdpCookieToElectron).filter(Boolean);
  }
  throw new Error("Cannot read cookies from " + (source.browser || source.id) + ".");
}

module.exports = {
  browserCookieSources,
  findSource,
  resolveSource,
  domainMatches,
  readSourceCookies,
  readFirefoxCookies,
  readChromiumCookies,
  firefoxRowToCookie,
  cdpCookieToElectron,
};
