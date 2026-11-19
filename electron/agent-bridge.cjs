"use strict";

// Experimental agent bridge. Serves the JV MCP over Streamable HTTP on
// 127.0.0.1 so outside coding agents (Cursor, Devin, editorpi, anything that
// speaks MCP) can drive the running app: edit cards, upload media, record,
// use the built-in browser with imported cookies, and export projects. The
// stdio MCP (lib/mcp-stdio.js) finds this server through agent-bridge.json and
// proxies to it, so both transports reach the same live app.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID, randomBytes, timingSafeEqual } = require("node:crypto");
const { createMcpHandler, toolDefs } = require("../lib/mcp-server");
const { agentToolSpecs } = require("../lib/agent-tools");
const { recordAction, callProjectId } = require("../lib/agent-activity");
const { cardEditorSpecs, cardEditorInstructions, SERVER_NAME: CARD_SERVER_NAME } = require("../lib/card-editor-tools");
const {
  CONTENT_RESEARCH_MCP_NAME,
  CONTENT_RESEARCH_MCP_PATH,
  CONTENT_RESEARCH_INSTRUCTIONS,
  contentResearchToolSpecs,
} = require("../lib/content-research-tools");

const PREFERRED_PORT = 47831;
const MAX_BODY = 64 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 20000;
// How often a streamed tool call reports that it is still running.
const PROGRESS_MS = 15000;
const MAX_SESSIONS = 128;

const MUTATING_BASE = new Set([
  "jeditor_apply_edit",
  "jeditor_add_finished_video",
  "jeditor_compose_finished",
  "jeditor_edit_timeline",
  "jeditor_render_project",
]);

// Must match the pages the renderer answers (renderer/js/bridge-commands.js).
// The agent, agent-setup, provider, MCP setup, and Finished videos pages are
// gone; Cleanup replaced the last one.
const PAGES = ["acpMarketplace", "edit", "record", "ai", "cards", "cleanup", "clips"];

function obj(properties, required) {
  const schema = { type: "object", properties: properties || {} };
  if (required && required.length) schema.required = required;
  return schema;
}

const WIN = { type: "string", description: "Browser window id from jeditor_browser_open. Omit for the last window." };
const SELECTOR = { type: "string", description: "CSS selector for the element, e.g. \"article a[href]\"." };

function imageResult(meta, pngBase64) {
  return {
    content: [
      { type: "text", text: JSON.stringify(meta) },
      { type: "image", data: pngBase64, mimeType: "image/png" },
    ],
    isError: false,
  };
}

function bridgeFile(dataRoot) {
  return path.join(dataRoot, "agent-bridge.json");
}

function writeFileAtomic(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + "." + process.pid + "." + randomUUID() + ".tmp";
  fs.writeFileSync(tmp, body, "utf8");
  fs.renameSync(tmp, file);
}

// Agent configs point at the launcher in the data folder instead of the
// install folder, whose path carries the app version and changes on every
// update. The source lives in lib/mcp-launcher so scripts/mcp-install writes
// the same file.
const { LAUNCHER, writeLauncher: writeLauncherFiles } = require("../lib/mcp-launcher");

function writeLauncher(dataRoot) {
  return writeLauncherFiles(dataRoot).launcher;
}

function readBridgeFile(dataRoot) {
  try {
    return JSON.parse(fs.readFileSync(bridgeFile(dataRoot), "utf8"));
  } catch {
    return null;
  }
}

function sameToken(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

// Whether an outside agent may spend the user's ElevenLabs characters.
//
// An in-app ACP session is not handled here: it carries a harness id, and its
// agent asks through session/request_permission, which acp-host turns into a
// grant after the user answers. An outside agent (Cursor, Devin, anything
// started from its own config) has no harness and no permission channel of its
// own, so without this it could never generate a voiceover in the default ask
// mode, and the error it got pointed at a prompt it could not raise. This is
// that prompt.
const APPROVAL_TIMEOUT_MS = 120000;

function approvalScopeFor(call) {
  const meta = (call && call.meta) || {};
  const args = (call && call.args) || {};
  return String(meta.projectId || args.projectId || meta.workspaceId || args.workspaceId || meta.sessionId || "");
}

function approvalCommand(host, command, args, timeoutMs) {
  if (typeof host.askApproval === "function") return host.askApproval(command, args, timeoutMs);
  return host.rendererCommand(command, args, timeoutMs);
}

function createElevenLabsApprover(host) {
  return async function approveElevenLabs(call) {
    const meta = (call && call.meta) || {};
    if (meta.harness) return true;
    const { readConfig, grantTtsApproval } = require("../lib/elevenlabs");
    const cfg = await readConfig(host.dataRoot);
    if (cfg.agentAccess === "never") {
      throw new Error(
        "ElevenLabs voiceovers are turned off (agent access: Never). Ask the user to allow them on JV's ElevenLabs page.",
      );
    }
    if (cfg.agentAccess === "always") {
      grantTtsApproval(approvalScopeFor(call));
      return true;
    }
    const win = host.mainWindow();
    if (!win || win.isDestroyed()) {
      throw new Error(
        "This voiceover needs the user's approval, and the JV window is not open. Ask the user to open JV and approve it, or to set ElevenLabs agent access to Always.",
      );
    }
    const args = (call && call.args) || {};
    const lineList = Array.isArray(args.lines) ? args.lines.map((l, i) => (i + 1) + ". " + String(typeof l === "string" ? l : (l && l.text) || "")) : [];
    const wording = lineList.length
      ? lineList.length + " lines\n" + lineList.join("\n")
      : String(args.script != null ? args.script : args.text == null ? "" : args.text);
    let answer = null;
    try {
      answer = await approvalCommand(
        host,
        "approve-elevenlabs",
        {
          tool: call.name,
          client: meta.client || "",
          text: wording.length > 1500 ? wording.slice(0, 1500) + "\n... (" + wording.length + " characters in all)" : wording,
          // Characters of speech, not of the numbered preview.
          chars: lineList.length
            ? args.lines.reduce((n, l) => n + String(typeof l === "string" ? l : (l && l.text) || "").length, 0)
            : wording.length,
        },
        APPROVAL_TIMEOUT_MS,
      );
    } catch (error) {
      throw new Error(
        "Nobody answered the voiceover request in JV (" +
          ((error && error.message) || error) +
          "). Set ElevenLabs agent access to Always to let outside agents generate voiceovers without asking.",
      );
    }
    if (!answer || answer.approved !== true) throw new Error("The user declined this voiceover.");
    grantTtsApproval(approvalScopeFor(call));
    return true;
  };
}

// Instruction edits rewrite what every future prompt carries, so they always
// ask the user. An in-app ACP session answers through its chat permission
// card, which drops a grant this check can see; an outside agent has no
// permission channel of its own, so the app asks on its behalf. There is no
// always mode: every proposal asks.
function createInstructionsApprover(host) {
  return async function approveInstructions(call) {
    const { hasInstructionsApproval, grantInstructionsApproval } = require("../lib/user-instructions");
    const meta = (call && call.meta) || {};
    const scope = approvalScopeFor(call);
    if (hasInstructionsApproval(scope)) return true;
    const win = host.mainWindow();
    if (!win || win.isDestroyed()) {
      throw new Error(
        "Changing the user instructions needs the user's approval, and the JV window is not open. Ask the user to open JV so the approval prompt can show.",
      );
    }
    const args = (call && call.args) || {};
    const proposed = String(args.text == null ? "" : args.text);
    let answer = null;
    try {
      answer = await approvalCommand(
        host,
        "approve-instructions",
        {
          tool: call.name,
          client: String(meta.client || ""),
          text: proposed.slice(0, 800),
          chars: proposed.length,
        },
        APPROVAL_TIMEOUT_MS,
      );
    } catch (error) {
      throw new Error("Nobody answered the instructions change in JV (" + ((error && error.message) || error) + ").");
    }
    if (!answer || answer.approved !== true) throw new Error("The user declined the instructions change.");
    grantInstructionsApproval(scope);
    return true;
  };
}

function createAgentBridge(host) {
  const dataRoot = host.dataRoot;
  const appRoot = host.appRoot;
  const browser = () => require("../lib/news-browser-server");
  const pendingCommands = new Map();
  const sessions = new Map();
  let server = null;
  let port = 0;
  let token = "";
  let startedAt = "";
  function broadcast(event, payload) {
    for (const win of host.windows()) {
      if (!win.isDestroyed()) win.webContents.send("agent-event", { event, payload });
    }
  }

  // Runs a command inside the renderer (navigate, record, open card) so the
  // agent drives the same code paths a click would.
  function rendererCommand(command, args, timeoutMs) {
    const win = host.mainWindow();
    if (!win || win.isDestroyed()) return Promise.reject(new Error("The JV window is not open."));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingCommands.delete(id);
        reject(new Error("The JV window did not answer " + command + "."));
      }, timeoutMs || COMMAND_TIMEOUT_MS);
      pendingCommands.set(id, { resolve, reject, timer });
      win.webContents.send("bridge-command", { id, command, args: args || {} });
    });
  }

  // The user has to be able to see a prompt for it to be a prompt: a minimized
  // or hidden window would silently time out instead.
  function bringForward() {
    const win = host.mainWindow();
    if (!win || win.isDestroyed()) return;
    try {
      if (!win.isVisible()) win.show();
      if (win.isMinimized()) win.restore();
      win.focus();
    } catch {
      /* showing the window is best effort */
    }
  }

  function askApproval(command, args, timeoutMs) {
    const restore = typeof host.approvalVisibility === "function" ? host.approvalVisibility() : null;
    const done = () => {
      if (restore) {
        try { restore(); } catch {}
      }
    };
    try {
      bringForward();
      return rendererCommand(command, args, timeoutMs).finally(done);
    } catch (error) {
      done();
      throw error;
    }
  }

  function commandReply(payload) {
    const body = payload || {};
    const rec = pendingCommands.get(body.id);
    if (!rec) return;
    pendingCommands.delete(body.id);
    clearTimeout(rec.timer);
    if (body.ok) rec.resolve(body.result == null ? { ok: true } : body.result);
    else rec.reject(new Error(body.error || "Command failed."));
  }

  function electronToolSpecs() {
    return [
      {
        name: "jeditor_app_state",
        description: "Read what the JV window shows now: page, open project or card, and recording state.",
        inputSchema: obj({}),
        run: () => rendererCommand("state"),
      },
      {
        name: "jeditor_app_navigate",
        description: "Switch the JV window to a page: " + PAGES.join(", ") + ".",
        inputSchema: obj({ page: { type: "string", enum: PAGES, description: "Page to open in the JV window." } }, ["page"]),
        run: (_ctx, input) => rendererCommand("navigate", { page: input.page }),
      },
      {
        name: "jeditor_app_open_card",
        description: "Open an edit card in the card studio so the user sees the edit.",
        inputSchema: obj({ cardId: { type: "string", description: "Edit card id, from jeditor_list_cards." } }, ["cardId"]),
        run: (_ctx, input) => rendererCommand("open-card", { cardId: input.cardId }),
      },
      {
        name: "jeditor_app_open_project",
        description: "Open an AI Video editing project in the editor.",
        inputSchema: obj({ projectId: { type: "string", description: "Project id, from jeditor_list_projects." } }, ["projectId"]),
        run: (_ctx, input) => rendererCommand("open-project", { projectId: input.projectId }),
      },
      {
        name: "jeditor_app_preview",
        description:
          "Switch the open AI Video project's preview between Source (the clip with the live cut) and Output (a render). mode source or output; pass renderId to put that render on the stage like clicking it under Finished videos.",
        inputSchema: obj({
          mode: { type: "string", enum: ["source", "output"], description: "source shows the clip with its live cuts, output shows a render." },
          renderId: { type: "string", description: "Show this render on the stage; overrides mode." },
        }),
        run: (_ctx, input) => rendererCommand("stage-preview", { mode: input.mode, renderId: input.renderId }),
      },
      {
        name: "jeditor_app_screenshot",
        description: "Screenshot the JV window as a PNG so you can check your edit.",
        inputSchema: obj({ width: { type: "number", description: "Window width to scale the PNG to, 320 to 1920. Default 1280.", minimum: 320, maximum: 1920 } }),
        async run(_ctx, input) {
          const win = host.mainWindow();
          if (!win || win.isDestroyed()) throw new Error("The JV window is not open.");
          const image = await win.webContents.capturePage();
          const w = Math.max(320, Math.min(1920, Number(input.width) || 1280));
          const sized = image.getSize().width > w ? image.resize({ width: w }) : image;
          return imageResult({ size: sized.getSize() }, sized.toPNG().toString("base64"));
        },
      },
      {
        name: "jeditor_record_start",
        description:
          "Start a Record Center screen recording with the current capture settings. The take lands in Videos and images when stopped.",
        inputSchema: obj({}),
        run: () => rendererCommand("record-start"),
      },
      {
        name: "jeditor_record_stop",
        description: "Stop the Record Center recording and save the take.",
        inputSchema: obj({}),
        run: () => rendererCommand("record-stop"),
      },
      {
        name: "jeditor_record_status",
        description: "Read the Record Center phase (idle, ready, countdown, recording, review) and the last saved take.",
        inputSchema: obj({}),
        run: () => rendererCommand("record-status"),
      },
      {
        name: "jeditor_browser_open",
        description: "Open a page in JV's built-in Chromium browser. It shares cookies imported with the cookie tools.",
        inputSchema: obj({ url: { type: "string", description: "Absolute http(s) URL to load in the window." }, windowId: WIN }),
        async run(_ctx, input) {
          await browser().ensureNewsBrowserServer();
          return browser().agentOpen(input.url, input.windowId);
        },
      },
      {
        name: "jeditor_browser_search",
        description: "Search the web in the built-in browser with the engine chosen in Setup. Optional site filter.",
        inputSchema: obj(
          {
            query: { type: "string", description: "Search terms, plain words rather than operators." },
            site: { type: "string", description: "Only results from this site, e.g. x.com." },
            windowId: WIN,
          },
          ["query"],
        ),
        run: (_ctx, input) => browser().agentSearch(input.query, input.site, input.windowId),
      },
      {
        name: "jeditor_browser_read",
        description: "Read the visible text of the current page.",
        inputSchema: obj({ windowId: WIN }),
        run: (_ctx, input) => browser().agentRead(input.windowId),
      },
      {
        name: "jeditor_browser_click",
        description: "Click the first element matching a CSS selector.",
        inputSchema: obj({ selector: SELECTOR, windowId: WIN }, ["selector"]),
        run: (_ctx, input) => browser().agentClick(input.windowId, input.selector),
      },
      {
        name: "jeditor_browser_type",
        description: "Type text into the input matching a CSS selector.",
        inputSchema: obj(
          {
            selector: SELECTOR,
            text: { type: "string", description: "Text to type into the field." },
            windowId: WIN,
          },
          ["selector", "text"],
        ),
        run: (_ctx, input) => browser().agentType(input.windowId, input.selector, input.text),
      },
      {
        name: "jeditor_browser_press",
        description: "Press a key in the page, for example Enter, Tab, Escape, or a single character.",
        inputSchema: obj(
          { key: { type: "string", description: "Key name: Enter, Tab, Escape, ArrowDown, or one character." }, windowId: WIN },
          ["key"],
        ),
        run: (_ctx, input) => browser().pressKey(input.windowId, input.key),
      },
      {
        name: "jeditor_browser_scroll",
        description: "Scroll the page by dy pixels, or scroll an element into view.",
        inputSchema: obj({
          dy: { type: "number", description: "Pixels to scroll down. Negative scrolls up. Omit with selector." },
          selector: { type: "string", description: "Scroll this element into view instead of by a distance." },
          windowId: WIN,
        }),
        run: (_ctx, input) => browser().scrollWindow(input.windowId, input.dy, input.selector),
      },
      {
        name: "jeditor_browser_wait",
        description: "Wait until a CSS selector exists on the page.",
        inputSchema: obj(
          {
            selector: SELECTOR,
            timeoutMs: { type: "number", description: "How long to wait before giving up. Default 5000.", minimum: 100 },
            windowId: WIN,
          },
          ["selector"],
        ),
        run: (_ctx, input) => browser().waitForSelector(input.windowId, input.selector, input.timeoutMs),
      },
      {
        name: "jeditor_browser_eval",
        description: "Run JavaScript in the page and return a JSON-safe result.",
        inputSchema: obj(
          { script: { type: "string", description: "JavaScript to run in the page. The last expression is returned." }, windowId: WIN },
          ["script"],
        ),
        run: (_ctx, input) => browser().evalInWindow(input.windowId, input.script),
      },
      {
        name: "jeditor_browser_screenshot",
        description:
          "PNG screenshot of JV's browser, returned as an image. Pass selector to capture one element, e.g. a single post. width scales it down (default 1280).",
        inputSchema: obj({
          width: { type: "number", description: "PNG width to scale down to. Default 1280.", minimum: 320, maximum: 1920 },
          selector: { type: "string", description: "CSS selector to capture only that element, e.g. one post." },
          windowId: WIN,
        }),
        async run(_ctx, input) {
          const shot = await browser().screenshotWindow(input.windowId, input.width, input.selector);
          return imageResult({ windowId: shot.windowId, url: shot.url, title: shot.title }, shot.png);
        },
      },
      {
        name: "jeditor_browser_windows",
        description: "List open browser windows.",
        inputSchema: obj({}),
        run: () => ({ windows: browser().browserState() }),
      },
      {
        name: "jeditor_browser_show",
        description: "Show or hide a browser window on the user's screen.",
        inputSchema: obj(
          {
            windowId: { type: "string", description: "Window to show or hide, from jeditor_browser_windows." },
            visible: { type: "boolean", description: "true puts the window on the user's screen, false hides it." },
          },
          ["windowId", "visible"],
        ),
        run: (_ctx, input) =>
          input.visible ? browser().revealBrowserWindow(input.windowId) : browser().hideBrowserWindow(input.windowId),
      },
      {
        name: "jeditor_browser_close",
        description: "Close a browser window.",
        inputSchema: obj(
          { windowId: { type: "string", description: "Window to close, from jeditor_browser_windows." } },
          ["windowId"],
        ),
        run: (_ctx, input) => browser().closeWindow(input.windowId),
      },
      {
        name: "jeditor_download_to_library",
        description: "Download a URL using the browser's cookies (logged-in downloads) and add it to the library.",
        inputSchema: obj(
          {
            url: { type: "string", description: "Absolute http(s) URL of the file to download." },
            name: { type: "string", description: "Name for the library item. Defaults to the file name in the URL." },
          },
          ["url"],
        ),
        async run(_ctx, input) {
          const { session } = require("electron");
          const os = require("node:os");
          const { copyPathIntoLibrary } = require("../lib/library-io");
          const res = await session.fromPartition("persist:cutline-news").fetch(String(input.url));
          if (!res.ok) throw new Error("Download failed: HTTP " + res.status);
          const mime = String(res.headers.get("content-type") || "").split(";")[0].trim();
          const name = String(input.name || path.basename(new URL(input.url).pathname) || "download");
          const tmp = path.join(os.tmpdir(), "cutline-agent-" + randomUUID() + "-" + name.replace(/[<>:"/\\|?*]/g, "_"));
          await fs.promises.writeFile(tmp, Buffer.from(await res.arrayBuffer()));
          try {
            return await copyPathIntoLibrary(dataRoot, tmp, { name, mime, source: "agent" });
          } finally {
            fs.promises.unlink(tmp).catch(() => {});
          }
        },
        mutates: true,
      },
      {
        name: "jeditor_cookies_import_file",
        description: "Import a JSON cookie export (from a cookie editor extension) into the built-in browser.",
        inputSchema: obj(
          { path: { type: "string", description: "Absolute path to the cookie JSON export on this computer." } },
          ["path"],
        ),
        run: (_ctx, input) => browser().importCookies(String(input.path)),
      },
      {
        name: "jeditor_cookies_import_json",
        description: "Import cookies passed inline as an array of {name, value, domain, path, secure, httpOnly, sameSite, expirationDate}.",
        inputSchema: obj(
          { cookies: { type: "array", items: { type: "object" }, description: "Cookie rows as an export gives them." } },
          ["cookies"],
        ),
        run: (_ctx, input) => browser().importCookieList(Array.isArray(input.cookies) ? input.cookies : []),
      },
      {
        name: "jeditor_cookies_auto_find",
        description: "Import the newest cookie JSON export found in Downloads, Documents, or Desktop.",
        inputSchema: obj({}),
        run: () => browser().autoFindCookies(),
      },
      {
        name: "jeditor_cookies_browsers",
        description:
          "List installed browser profiles (Firefox, Chrome, Edge, Brave) that cookies can be imported from. Each row has the sourceId that jeditor_cookies_import_browser takes.",
        inputSchema: obj({}),
        run: () => ({ sources: browser().browserSources() }),
      },
      {
        name: "jeditor_cookies_import_browser",
        description:
          "Copy cookies from an installed browser profile into JV's browser so its sign-ins carry over. Pass sourceId from jeditor_cookies_browsers, or browser and an optional profile. Limit with domains. Close that browser first: a running browser locks its cookie file. Chrome, Edge, and Brave hand over their cookies through a headless copy of the profile, which takes a few seconds.",
        inputSchema: obj({
          sourceId: { type: "string", description: "Source id from jeditor_cookies_browsers, e.g. chrome:Default." },
          browser: { type: "string", enum: ["firefox", "chrome", "edge", "brave"], description: "Browser to copy from, when no sourceId is passed." },
          profile: { type: "string", description: "Profile folder name, e.g. Default or Profile 1. Defaults to Default." },
          domains: { type: "array", items: { type: "string" }, description: "Only these sites and their subdomains, e.g. x.com." },
        }),
        async run(_ctx, input) {
          if (!input.sourceId && !input.browser) {
            throw new Error("Pass sourceId from jeditor_cookies_browsers, or browser.");
          }
          const { browserCookieSources, resolveSource } = require("../lib/browser-cookie-import");
          const source = resolveSource(browserCookieSources(), input);
          if (!source) throw new Error("No " + (input.browser || input.sourceId) + " profile with cookies was found.");
          return browser().importBrowserCookies(source.id, { domains: input.domains });
        },
      },
      {
        name: "jeditor_cookies_list",
        description: "List cookie names and domains in the built-in browser. Values are never returned.",
        inputSchema: obj({ domain: { type: "string", description: "Only cookies for this domain and its subdomains, e.g. x.com." } }),
        run: (_ctx, input) => browser().listCookieNames(input.domain),
      },
      {
        name: "jeditor_cookies_clear",
        description: "Clear every cookie in the built-in browser.",
        inputSchema: obj({ confirm: { type: "boolean", description: "Must be true. Clearing cookies signs the user out everywhere." } }, ["confirm"]),
        run(_ctx, input) {
          if (input.confirm !== true) throw new Error("Pass confirm: true to clear all browser cookies.");
          return browser().clearCookies();
        },
      },
    ];
  }

  const fileSpecs = agentToolSpecs();
  const liveSpecs = electronToolSpecs();
  const allSpecs = fileSpecs.concat(liveSpecs);
  const mutating = new Set(MUTATING_BASE);
  for (const spec of allSpecs) if (spec.mutates) mutating.add(spec.name);
  const cardSpecs = cardEditorSpecs({
    appState: () => rendererCommand("state"),
    openCard: (cardId) => rendererCommand("open-card", { cardId }),
  });
  const contentResearchSpecs = contentResearchToolSpecs();
  const cardMutating = new Set(cardSpecs.filter((spec) => spec.mutates).map((spec) => spec.name));
  let allToolNames = null;

  function noteRow(result) {
    const text = result && Array.isArray(result.content) ? result.content.find((item) => item.type === "text") : null;
    return text ? JSON.parse(text.text) : null;
  }

  function onToolCall(call) {
    const args = call.args || {};
    let summary = "";
    if (call.result && Array.isArray(call.result.content)) {
      const text = call.result.content.find((item) => item.type === "text");
      summary = text ? String(text.text).slice(0, 240) : "";
    } else if (call.error) {
      summary = call.error.message || String(call.error);
    }
    const meta = call.meta || {};
    let row = null;
    try {
      // The note tool writes its own "note" row, which is the one to show.
      row = call.ok && call.name === "jeditor_record_note" ? noteRow(call.result) : recordAction(dataRoot, {
        tool: call.name,
        client: meta.client || call.client || "",
        harness: meta.harness || "",
        sessionId: meta.sessionId || "",
        projectId: callProjectId(call),
        workspaceId: args.workspaceId || "",
        args,
        ok: call.ok,
        summary,
        durationMs: call.durationMs,
      });
    } catch {
      /* the tool result stays authoritative even if the log write fails */
    }
    if (row) broadcast("bridge-activity", row);
    if (cardMutating.has(call.name)) {
      if (call.ok) broadcast("cards-changed", { tool: call.name, cardId: String(args.cardId || ""), cardIds: Array.isArray(args.cardIds) ? args.cardIds.map(String) : [] });
    } else if ((call.ok || (call.result && call.result.saved)) && mutating.has(call.name)) {
      // A tool can finish with an error result after it saved something (a
      // render whose script threw still saves and swaps the clip); it marks
      // that with saved, so the window refreshes. Plain failures do not.
      broadcast("workspace-changed", { tool: call.name });
    }
    if (call.ok && call.name === "jeditor_plugin_write") {
      let r = {};
      try {
        r = noteRow(call.result) || {};
      } catch {
        r = {};
      }
      broadcast("plugins-changed", { tool: call.name, id: String(args.id || ""), name: String(r.name || args.name || ""), status: String(r.status || ""), created: Boolean(r.created) });
    }
    if (call.ok && call.name === "jeditor_update_user_instructions") {
      broadcast("instructions-changed", { tool: call.name });
    }
  }

  // Stdio proxies and ACP sessions rarely send DELETE, so the session map is
  // capped and kept in recent-use order. An evicted session only costs a fresh
  // handler on its next request.
  function handlerFor(sessionId) {
    if (!sessionId || !sessions.has(sessionId)) return null;
    const handler = sessions.get(sessionId);
    sessions.delete(sessionId);
    sessions.set(sessionId, handler);
    return handler;
  }

  function keepSession(id, handler) {
    sessions.set(id, handler);
    while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
  }

  // Whether an outside agent may spend the user's ElevenLabs characters.
  const approveElevenLabs = createElevenLabsApprover({
    dataRoot,
    mainWindow: () => host.mainWindow(),
    rendererCommand,
    askApproval,
  });
  const approveInstructions = createInstructionsApprover({
    mainWindow: () => host.mainWindow(),
    rendererCommand,
    askApproval,
  });
  // Deleting cards always asks in the app, whichever agent called, and the
  // dialog names the cards so the user sees what is about to go.
  async function approveCardDelete(call) {
    const win = host.mainWindow();
    if (!win || win.isDestroyed()) throw new Error("Deleting cards needs the user's approval, and the JV window is not open.");
    const args = call.args || {};
    const ids = Array.isArray(args.cardIds) ? args.cardIds.map(String) : [];
    let names = [];
    try {
      const { loadWorkspace, loadState } = require("../lib/workspace-store");
      const wsId = args.workspaceId || (await loadState(dataRoot)).activeWorkspaceId;
      const ws = await loadWorkspace(dataRoot, wsId);
      names = ids.map((id) => ((ws.cards || []).find((card) => card.id === id) || {}).name || id);
    } catch {
      names = ids;
    }
    let answer = null;
    try {
      answer = await askApproval("approve-card-delete", { client: String((call.meta || {}).client || ""), names }, APPROVAL_TIMEOUT_MS);
    } catch (error) {
      throw new Error("Nobody answered the delete request in JV (" + ((error && error.message) || error) + ").");
    }
    if (!answer || answer.approved !== true) throw new Error("The user declined deleting the card.");
    return true;
  }
  const approveTool = (call) =>
    call.name === "cards_delete"
      ? approveCardDelete(call)
      : call.name === "jeditor_update_user_instructions"
        ? approveInstructions(call)
        : approveElevenLabs(call);

  function newHandler(clientHint, profile) {
    const cards = profile === "cards";
    const contentResearch = profile === "content-research";
    const handler = createMcpHandler({
      dataRoot,
      appRoot,
      extraTools: cards ? cardSpecs : contentResearch ? contentResearchSpecs : allSpecs,
      baseTools: !cards && !contentResearch,
      serverName: cards ? CARD_SERVER_NAME : contentResearch ? CONTENT_RESEARCH_MCP_NAME : undefined,
      instructions: cards ? cardEditorInstructions : contentResearch ? CONTENT_RESEARCH_INSTRUCTIONS : undefined,
      onToolCall,
      approveTool,
      clientName: clientHint || "",
    });
    handler.profile = cards ? "cards" : contentResearch ? "content-research" : "";
    return handler;
  }

  function send(res, status, body, headers) {
    res.writeHead(status, Object.assign({ "Content-Type": "application/json" }, headers || {}));
    res.end(body == null ? "" : JSON.stringify(body));
  }

  function authorized(req, url) {
    const header = String(req.headers.authorization || "");
    const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    const given = bearer || String(req.headers["x-cutline-token"] || "") || url.searchParams.get("token") || "";
    return sameToken(given, token);
  }

  function originAllowed(req) {
    const origin = req.headers.origin;
    if (!origin || origin === "null") return true;
    try {
      const host = new URL(origin).hostname;
      return host === "127.0.0.1" || host === "localhost";
    } catch {
      return false;
    }
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          reject(new Error("Request too large"));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }

  async function onRequest(req, res) {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/health") return send(res, 200, { ok: true, name: "jeditor", startedAt });
    if (url.pathname !== "/mcp" && url.pathname !== "/mcp/cards" && url.pathname !== CONTENT_RESEARCH_MCP_PATH) return send(res, 404, { error: "Not found" });
    const profile = url.pathname === "/mcp/cards" ? "cards" : url.pathname === CONTENT_RESEARCH_MCP_PATH ? "content-research" : "";
    if (!originAllowed(req)) return send(res, 403, { error: "Origin not allowed" });
    if (!authorized(req, url)) return send(res, 401, { error: "Missing or wrong JV bridge token" });
    const sessionHeader = String(req.headers["mcp-session-id"] || "");
    if (req.method === "DELETE") {
      sessions.delete(sessionHeader);
      return send(res, 204, null);
    }
    if (req.method === "GET") return send(res, 405, { error: "This server does not open an SSE stream." }, { Allow: "POST, DELETE" });
    if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" });
    let parsed;
    try {
      parsed = JSON.parse(await readBody(req));
    } catch {
      return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
    const meta = {
      client: String(req.headers["x-cutline-client"] || ""),
      harness: String(req.headers["x-cutline-harness"] || ""),
      sessionId: sessionHeader,
      // The ACP session's bound project/workspace. The MCP handler fills
      // them into calls the agent left blank so edits land on the open
      // project instead of the workspace's last-active one.
      projectId: String(req.headers["x-cutline-project-id"] || ""),
      workspaceId: String(req.headers["x-cutline-workspace-id"] || ""),
      // The chat the ACP session belongs to, so jeditor_read_chat defaults
      // to it.
      chatId: String(req.headers["x-cutline-chat-id"] || ""),
    };
    const batch = Array.isArray(parsed) ? parsed : [parsed];
    let handler = handlerFor(sessionHeader);
    if (handler && handler.profile !== profile) handler = null;
    const headers = {};
    if (!handler) {
      handler = newHandler(meta.client, profile);
      if (batch.some((msg) => msg && msg.method === "initialize")) {
        const id = randomUUID();
        keepSession(id, handler);
        headers["Mcp-Session-Id"] = id;
        meta.sessionId = id;
      }
    }
    // A long tool call (a render can take minutes) streams its answer as
    // server-sent events with a progress note every few seconds. Claude Code
    // aborts a call that sends "no response or progress" for 300 s, and
    // without this a slow render was dropped while it was still working.
    const single = !Array.isArray(parsed) && parsed && parsed.method === "tools/call" ? parsed : null;
    const progressToken = single && single.params && single.params._meta ? single.params._meta.progressToken : undefined;
    const acceptsStream = /text\/event-stream/i.test(String(req.headers.accept || ""));
    if (single && acceptsStream && (typeof progressToken === "string" || typeof progressToken === "number")) {
      res.writeHead(200, Object.assign({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" }, headers));
      const event = (msg) => {
        if (!res.writableEnded) res.write("event: message\ndata: " + JSON.stringify(msg) + "\n\n");
      };
      const started = Date.now();
      let beat = 0;
      const timer = setInterval(() => {
        beat += 1;
        event({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken, progress: beat, message: "Still working (" + Math.round((Date.now() - started) / 1000) + " s)" } });
      }, PROGRESS_MS);
      try {
        const reply = await handler.handle(single, meta);
        if (reply) event(reply);
      } finally {
        clearInterval(timer);
        res.end();
      }
      return;
    }
    const replies = [];
    for (const message of batch) {
      const reply = await handler.handle(message, meta);
      if (reply) replies.push(reply);
    }
    if (!replies.length) return send(res, 202, null, headers);
    return send(res, 200, Array.isArray(parsed) ? replies : replies[0], headers);
  }

  function listen(p) {
    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        onRequest(req, res).catch((error) => {
          if (!res.headersSent) send(res, 500, { error: error.message || String(error) });
        });
      });
      srv.once("error", reject);
      srv.listen(p, "127.0.0.1", () => {
        srv.removeListener("error", reject);
        resolve(srv);
      });
    });
  }

  async function start() {
    if (server) return info();
    const previous = readBridgeFile(dataRoot);
    token = previous && typeof previous.token === "string" && previous.token.length >= 32 ? previous.token : randomBytes(24).toString("hex");
    try {
      server = await listen(PREFERRED_PORT);
    } catch {
      server = await listen(0);
    }
    port = server.address().port;
    startedAt = new Date().toISOString();
    writeFileAtomic(
      bridgeFile(dataRoot),
      JSON.stringify({ url: "http://127.0.0.1:" + port + "/mcp", port, token, pid: process.pid, startedAt, appRoot }, null, 2),
    );
    try {
      writeLauncher(dataRoot);
    } catch {
      /* agents can still use lib/mcp-stdio.js directly */
    }
    return info();
  }

  function stop() {
    for (const rec of pendingCommands.values()) {
      clearTimeout(rec.timer);
      rec.reject(new Error("JV is closing."));
    }
    pendingCommands.clear();
    sessions.clear();
    if (server) {
      try {
        server.close();
      } catch {
        /* already closed */
      }
      server = null;
    }
    const current = readBridgeFile(dataRoot);
    if (current && current.pid === process.pid) {
      writeFileAtomic(bridgeFile(dataRoot), JSON.stringify(Object.assign({}, current, { pid: 0, stoppedAt: new Date().toISOString() }), null, 2));
    }
  }

  function info() {
    const url = port ? "http://127.0.0.1:" + port + "/mcp" : "";
    const launcher = path.join(dataRoot, LAUNCHER);
    const stdioArgs = [launcher];
    const toolNames = (allToolNames || (allToolNames = toolDefs().map((def) => def.name).concat(allSpecs.map((spec) => spec.name)))).slice();
    return {
      running: Boolean(server),
      url,
      port,
      token,
      startedAt,
      dataRoot,
      launcher,
      tools: toolNames.length,
      toolNames,
      liveTools: liveSpecs.map((spec) => spec.name),
      stdio: { command: "node", args: stdioArgs },
      configs: {
        cursor: {
          mcpServers: { jeditor: { url, headers: { Authorization: "Bearer " + token } } },
        },
        cursorStdio: { mcpServers: { jeditor: { command: "node", args: stdioArgs } } },
        devin: { mcpServers: { jeditor: { command: "node", args: stdioArgs } } },
      },
    };
  }

  return { start, stop, info, commandReply, rendererCommand, toolNames: () => allSpecs.map((s) => s.name) };
}

module.exports = { createAgentBridge, createElevenLabsApprover, createInstructionsApprover, bridgeFile, readBridgeFile, PREFERRED_PORT };
