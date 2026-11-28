"use strict";

// Hidden end-to-end boot of the real JV window (--smoke). The window is
// never shown. It walks every page, records console errors, and saves a PNG
// of each page to JEDITOR_SMOKE_SHOTS when set. With JEDITOR_SMOKE_PROMPT it
// also creates a project and sends that prompt through the real chat UI to
// the agent named by JEDITOR_SMOKE_AGENT, waiting for the turn to finish.

const fs = require("node:fs");
const path = require("node:path");

let started = false;

async function runJeditorSmoke(win, opts) {
  // did-finish-load fires again after the theme reload below; run once.
  if (started) return;
  started = true;
  const { app, checkLibraryProtocol } = opts;
  const shots = process.env.JEDITOR_SMOKE_SHOTS || "";
  const errors = [];
  win.webContents.on("console-message", (...args) => {
    const event = args[0];
    const level = event && typeof event === "object" && "level" in event ? event.level : args[1];
    const message = event && typeof event === "object" && "message" in event ? event.message : args[2];
    // A ResizeObserver loop notice is a Chromium warning, not a real error:
    // the observer only re-reads the rect on the next frame.
    if (level === "error" || level === 3) {
      const text = String(message || "");
      if (!text.includes("ResizeObserver loop")) errors.push(text.slice(0, 400));
    }
  });
  win.webContents.on("render-process-gone", (_e, details) => errors.push("renderer gone: " + JSON.stringify(details)));
  const js = (code) => win.webContents.executeJavaScript(code);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const shot = async (name) => {
    if (!shots) return "";
    fs.mkdirSync(shots, { recursive: true });
    // A hidden window may hold an old frame; ask for a fresh paint first.
    win.webContents.invalidate();
    await sleep(350);
    win.webContents.invalidate();
    await sleep(250);
    const image = await win.webContents.capturePage();
    const file = path.join(shots, name + ".png");
    fs.writeFileSync(file, image.toPNG());
    return file;
  };
  const waitFor = async (selector, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await js("Boolean(document.querySelector(" + JSON.stringify(selector) + "))")) return true;
      await sleep(150);
    }
    return false;
  };
  const report = { pages: {}, shots: [] };
  try {
    const theme = process.env.JEDITOR_SMOKE_THEME;
    report.booted = await waitFor(".rail [data-nav]", 20000);
    if (theme) {
      await js("window.cutline.setPrefs({ theme: " + JSON.stringify(theme) + " }).then(() => location.reload())");
      await sleep(600);
      report.booted = await waitFor(".rail [data-nav]", 20000);
    }
    report.title = await js("document.title");
    // The Draw studio lives in a view inside this window: it must load, the
    // switch must show and hide it, and the rail must offer it.
    report.draw = opts.drawProbe ? await opts.drawProbe().catch((e) => ({ ok: false, error: String((e && e.message) || e) })) : { ok: false, error: "no probe" };
    // One rail tile now: Projects. The studio switch buttons are gone.
    report.railSwitch = await js("!!document.querySelector('.rail [data-nav=home]') && !document.querySelector('.rail [data-studio]')");
    report.snapshotError = await js("window.cutline.snapshot().then(() => '').catch((e) => String(e && e.message || e))");
    report.counts = await js("Promise.all([window.cutline.snapshot(), window.cutline.aiProjects()]).then(([s, p]) => ({ library: ((s && s.workspace && s.workspace.library) || []).length, projects: (Array.isArray(p) ? p : (p && p.projects) || []).length }))").catch((e) => ({ error: String(e.message || e) }));
    try {
      report.projectDelete = await require("./smoke-project-delete.cjs").verifyProjectDelete({ dataRoot: opts.dataRoot(), js });
    } catch (error) {
      report.projectDelete = { ok: false, error: String((error && error.message) || error) };
    }
    if (process.env.JEDITOR_SMOKE_IMPORT) {
      // Copies the real Cutline Desktop library into this (scratch) data root.
      const t0 = Date.now();
      report.importStatus = await js("window.cutline.cutlineImportStatus()");
      report.importResult = await js("window.cutline.cutlineImport().then((r) => r || 'ok').catch((e) => 'error: ' + (e && e.message || e))");
      report.importSeconds = Math.round((Date.now() - t0) / 1000);
      process.stdout.write(JSON.stringify(report) + "\n");
      app.exit(typeof report.importResult === "string" && report.importResult.startsWith("error") ? 2 : 0);
      return;
    }
    report.harnesses = await js("window.cutline.acpHarnesses().then((l) => l.map((h) => h.id + (h.available ? '' : '(missing)')))");

    const visit = async (page, ready, extra) => {
      // Home has no rail button: the Video Editor studio tile opens it.
      await js(page === "home" ? "window.__jeditor.navigate('home')" : "document.querySelector('[data-nav=\"" + page + "\"]').click()");
      const ok = await waitFor(ready);
      await sleep(500);
      report.pages[page + (extra || "")] = ok;
      report.shots.push(await shot(page + (extra || "")));
    };
    await visit("home", "[data-launch]");
    // Opening a picker on Home must never submit the launcher and start a
    // project (the agent button used to default to type=submit).
    report.homePickers = await js(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const count = async () => { const p = await window.cutline.aiProjects(); return (Array.isArray(p) ? p : (p && p.projects) || []).length; };
      const before = await count();
      const clicked = [];
      for (const sel of ['[data-launch] [data-agent]', '[data-launch] [data-model]', '[data-launch] [data-ratio]']) {
        const b = document.querySelector(sel);
        if (!b || b.disabled) continue;
        b.click();
        clicked.push(sel);
        await wait(300);
        const item = document.querySelector('.menu .menu-item:not([disabled])');
        if (item && sel !== '[data-launch] [data-agent]') item.click();
        else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await wait(400);
      }
      const after = await count();
      return { ok: before === after && Boolean(document.querySelector('[data-launch]')), clicked, before, after };
    })()`);
    await visit("library", "[data-lib]");
    await visit("agents", ".agent-row");
    await visit("settings", "[data-snav]");
    for (const section of ["appearance", "chat", "instructions", "skills", "voice", "storage", "about"]) {
      await js("document.querySelector('[data-sec=\"" + section + "\"]').click()");
      await sleep(900);
      report.pages["settings-" + section] = await js("Boolean(document.querySelector(" + JSON.stringify('[data-pane="' + section + '"] h2') + "))");
      report.shots.push(await shot("settings-" + section));
    }

    // JEDITOR_SMOKE_MARKET=id,id: install agents from the ACP Registry by
    // clicking Add in the Agents page marketplace, as a person would.
    const marketIds = String(process.env.JEDITOR_SMOKE_MARKET || "").split(",").map((x) => x.trim()).filter(Boolean);
    // "view" only opens the marketplace; real ids are installed.
    const marketView = marketIds.includes("view");
    if (marketView) marketIds.splice(marketIds.indexOf("view"), 1);
    if (marketIds.length || marketView) {
      report.market = { installs: {} };
      await js("window.__jeditor.navigate('agents')");
      report.market.loaded = await waitFor("[data-market]", 60000);
      report.market.count = await js("document.querySelectorAll('[data-market]').length");
      report.market.withIcons = await js("document.querySelectorAll('[data-market] .reg-icon').length");
      report.shots.push(await shot("market"));
      for (const id of marketIds) {
        const started = Date.now();
        const clicked = await js(`(async () => {
          const q = document.querySelector('[data-market-q]');
          q.value = ${JSON.stringify(id)};
          q.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 300));
          const card = document.querySelector('[data-market="' + ${JSON.stringify(id)} + '"]');
          if (!card) return 'no card';
          const b = card.querySelector('[data-install]');
          if (!b) return 'no add button: ' + card.querySelector('.market-foot').textContent;
          b.click();
          return 'clicked';
        })()`);
        let state = "";
        let sawProgress = "";
        const end = Date.now() + 15 * 60 * 1000;
        while (Date.now() < end) {
          await sleep(1500);
          state = await js("(() => { const c = document.querySelector('[data-market=\"" + id + "\"]'); return c ? c.querySelector('.market-foot').textContent : 'gone'; })()");
          if (/Downloading|Installing|Unpacking/.test(state)) sawProgress = state;
          if (!/Downloading|Installing|Unpacking/.test(state) && Date.now() - started > 3000) break;
        }
        const toastText = await js("Array.from(document.querySelectorAll('.toast')).map((t) => t.textContent).join(' | ')");
        report.market.installs[id] = { clicked, state, sawProgress, toast: toastText, seconds: Math.round((Date.now() - started) / 1000), added: /Added/.test(state) };
        report.shots.push(await shot("market-" + id));
      }
      report.market.state = await js("window.cutline.acpRegistry({}).then((r) => r.agents.filter((a) => a.harnessId || a.installedVersion).map((a) => ({ id: a.id, harnessId: a.harnessId, added: a.added, installedVersion: a.installedVersion, update: a.update })))");
      report.market.harnesses = await js("window.cutline.acpHarnesses().then((l) => l.map((h) => h.id + (h.available ? '' : '(missing)')))");
      report.market.ok = report.market.loaded && report.market.count > 0 && Object.values(report.market.installs).every((x) => x.added);
    }

    // A project, the editor, and the chat.
    await js("window.__jeditor.navigate('home')");
    await waitFor("[data-launch]");
    const prompt = process.env.JEDITOR_SMOKE_PROMPT || "";
    const agent = process.env.JEDITOR_SMOKE_AGENT || "";
    if (agent) {
      // Add the agent through the same call the Agents page uses.
      report.agentAdd = await js(
        "window.cutline.acpHarnesses().then(async (l) => { const h = l.find((x) => x.id === " + JSON.stringify(agent) + "); if (h && h.available) return 'already'; const r = await window.cutline.acpAgentAdd({ catalogId: " + JSON.stringify(agent) + " }); await window.__jeditor.refreshHarnesses(); return r; }).catch((e) => 'error: ' + (e && e.message || e))",
      );
      report.harnessesAfterAdd = await js("window.cutline.acpHarnesses().then((l) => l.map((h) => h.id + (h.available ? '' : '(missing)')))");
    }
    if (agent) await js("window.cutline.setPrefs({ defaultAgent: " + JSON.stringify(agent) + " }).then((p) => { window.__jeditor.store.prefs = p; })");
    // JEDITOR_SMOKE_MODEL=<model id>: pick the model on Home with the real
    // picker (the list comes from the agent itself), then press Create.
    const wantModel = process.env.JEDITOR_SMOKE_MODEL || "";
    let projectId = "";
    if (wantModel && agent && prompt) {
      await js("window.__jeditor.navigate('home')");
      await waitFor("[data-launch]");
      const t0 = Date.now();
      report.homeModel = { pickerReady: await waitFor("[data-home-model] [data-model]:not([disabled])", 150000), seconds: 0 };
      report.homeModel.seconds = Math.round((Date.now() - t0) / 1000);
      report.homeModel.labelBefore = await js("(document.querySelector('[data-home-model]') || {}).textContent || ''");
      report.shots.push(await shot("home-model-picker"));
      report.homeModel.pick = await js(`(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const list = await window.cutline.acpModels({ harnessId: ${JSON.stringify(agent)} });
        const m = (list.availableModels || []).find((x) => x.modelId === ${JSON.stringify(wantModel)});
        if (!m) return { ok: false, why: 'agent did not offer it', offered: (list.availableModels || []).map((x) => x.modelId) };
        document.querySelector('[data-home-model] [data-model]').click();
        await wait(400);
        const items = Array.from(document.querySelectorAll('.menu .menu-item'));
        const item = items.find((el) => (el.textContent || '').startsWith(m.name));
        if (!item) return { ok: false, why: 'not in menu', menu: items.map((el) => el.textContent).slice(0, 20) };
        item.click();
        await wait(300);
        const label = document.querySelector('[data-home-model]').textContent;
        const box = document.querySelector('[data-launch-input]');
        box.value = ${JSON.stringify(prompt)};
        box.dispatchEvent(new Event('input', { bubbles: true }));
        return { ok: label.includes(m.name), name: m.name, label, menuCount: items.length };
      })()`);
      report.shots.push(await shot("home-model-picked"));
      await js("document.querySelector('[data-create]').click()");
      await waitFor("[data-stage]", 20000);
      projectId = await js("window.cutline.aiProjects().then((p) => { const list = Array.isArray(p) ? p : (p && p.projects) || []; list.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))); return list[0] ? list[0].id : ''; })");
    } else {
      projectId = await js(
        "window.cutline.aiProjectCreate({ name: 'Smoke project', aspectRatio: '16/9', assetIds: [] }).then((p) => p.id)",
      );
    }
    if (prompt && !wantModel) {
      await js("window.__jeditor.store.pendingLaunch = { projectId: " + JSON.stringify(projectId) + ", text: " + JSON.stringify(prompt) + ", harnessId: " + JSON.stringify(agent) + " }");
    }
    if (!wantModel) await js("window.__jeditor.navigate('editor', { projectId: " + JSON.stringify(projectId) + " })");
    report.pages.editor = await waitFor("[data-stage]");
    report.pages.chat = await waitFor("[data-input]");
    await sleep(1200);
    report.shots.push(await shot("editor"));
    // JEDITOR_SMOKE_EVAL=<file.js>: run an async expression from a file in
    // the project page and put what it returns in the report (for checks
    // and UI exploration that the fixed steps do not cover).
    if (process.env.JEDITOR_SMOKE_EVAL) {
      await sleep(2500);
      const code = fs.readFileSync(process.env.JEDITOR_SMOKE_EVAL, "utf8");
      report.eval = await js("(async () => { " + code + " })()").catch((e) => "error: " + (e && e.message || e));
      report.shots.push(await shot("eval"));
    }

    if (prompt) {
      const limit = Number(process.env.JEDITOR_SMOKE_TURN_MS) || 8 * 60 * 1000;
      const end = Date.now() + limit;
      let sawBusy = false;
      let lastShot = 0;
      let finished = false;
      while (Date.now() < end) {
        await sleep(1500);
        const state = await js("(() => { const b = document.querySelector('[data-send]'); return { busy: Boolean(b && b.classList.contains('is-stop')), sending: Boolean(b && b.querySelector('.spin')), replies: document.querySelectorAll('[data-inner] .msg-agent').length }; })()");
        if (state.busy || state.sending) sawBusy = true;
        if (Date.now() - lastShot > 20000) {
          lastShot = Date.now();
          report.shots.push(await shot("chat-progress-" + Math.round((limit - (end - Date.now())) / 1000) + "s"));
        }
        // A quick turn can end before this loop starts (for example while
        // JEDITOR_SMOKE_EVAL runs): a reply with the agent idle is finished too.
        if ((sawBusy || state.replies > 0) && !state.busy && !state.sending) {
          finished = true;
          break;
        }
      }
      await sleep(2500);
      report.turn = await js(
        "(() => { const t = document.querySelector('[data-inner]'); return { users: t.querySelectorAll('.msg-user').length, agentReplies: t.querySelectorAll('.msg-agent').length, steps: t.querySelectorAll('.tool-row').length, errors: Array.from(t.querySelectorAll('.err')).map((e) => e.textContent.slice(0, 300)), notice: (document.querySelector('[data-notice]').textContent || '').slice(0, 300), lastReply: (Array.from(t.querySelectorAll('.msg-agent .md')).pop() || {}).textContent || '' }; })()",
      );
      report.turn.finished = finished;
      report.turn.seconds = Math.round((Date.now() - (end - limit)) / 1000);
      report.turn.lastReply = String(report.turn.lastReply || "").slice(0, 600);
      report.project = await js("window.cutline.aiProjectGet({ id: " + JSON.stringify(projectId) + " }).then((p) => ({ assets: p.assets.length, renders: Object.keys((p.state && p.state.renders) || {}).length, state: Object.keys(p.state || {}) }))");
      report.chatRows = await js(
        "window.cutline.editorChats({ workspaceId: window.__jeditor.store.workspaceId, page: 'ai', projectId: " + JSON.stringify(projectId) + " }).then(async (list) => { const c = list[0]; if (!c) return null; const r = await window.cutline.editorChatGet({ id: c.id }); return { title: r.chat.title, harnessId: r.chat.harnessId, savedRows: (r.chat.acpTranscript || []).length }; })",
      );
      // Which way the agent reached JV's tools (http or stdio).
      report.mcp = await js(
        "window.cutline.editorChats({ workspaceId: window.__jeditor.store.workspaceId, page: 'ai', projectId: " + JSON.stringify(projectId) + " }).then(async (list) => { const c = list[0]; if (!c) return null; const s = await window.cutline.acpSession({ workspaceId: window.__jeditor.store.workspaceId, projectId: " + JSON.stringify(projectId) + ", chatId: c.id, harnessId: " + JSON.stringify(agent) + " }); return s && s.mcp ? { transport: s.mcp.transport, status: s.mcp.status, configured: s.mcp.configured } : null; }).catch((e) => 'error: ' + (e && e.message || e))",
      );
      if (wantModel) {
        // What the agent session is really running, and what the chat shows.
        report.modelCheck = await js(
          "window.cutline.editorChats({ workspaceId: window.__jeditor.store.workspaceId, page: 'ai', projectId: " + JSON.stringify(projectId) + " }).then(async (list) => { const c = list[0]; if (!c) return null; const r = await window.cutline.editorChatGet({ id: c.id }); const s = await window.cutline.acpSession({ workspaceId: window.__jeditor.store.workspaceId, projectId: " + JSON.stringify(projectId) + ", chatId: c.id, harnessId: " + JSON.stringify(agent) + " }); return { want: " + JSON.stringify(wantModel) + ", chatModel: r.chat.model, sessionModel: s && s.models && s.models.currentModelId, sessionModelCount: s && s.models && s.models.availableModels.length, composerLabel: (document.querySelector('[data-model-slot]') || {}).textContent || '' }; }).catch((e) => 'error: ' + (e && e.message || e))",
        );
        if (report.modelCheck && typeof report.modelCheck === "object") report.modelCheck.ok = report.modelCheck.sessionModel === wantModel && report.modelCheck.chatModel === wantModel;
      }
      // JEDITOR_SMOKE_EVAL_AFTER=<file.js>: same as JEDITOR_SMOKE_EVAL, run
      // once the agent turn has finished.
      if (process.env.JEDITOR_SMOKE_EVAL_AFTER) {
        const code = fs.readFileSync(process.env.JEDITOR_SMOKE_EVAL_AFTER, "utf8");
        report.evalAfter = await js("(async () => { " + code + " })()").catch((e) => "error: " + (e && e.message || e));
      }
      report.shots.push(await shot("chat-final"));

      // JEDITOR_SMOKE_AGENT2: hand the same chat to a second real agent
      // through the agent menu and send JEDITOR_SMOKE_PROMPT2 with Send.
      const agent2 = process.env.JEDITOR_SMOKE_AGENT2 || "";
      const prompt2 = process.env.JEDITOR_SMOKE_PROMPT2 || "";
      if (agent2 && prompt2) {
        report.agent2Add = await js(
          "window.cutline.acpHarnesses().then(async (l) => { const h = l.find((x) => x.id === " + JSON.stringify(agent2) + "); if (h && h.available) return 'already'; const r = await window.cutline.acpAgentAdd({ catalogId: " + JSON.stringify(agent2) + " }); await window.__jeditor.refreshHarnesses(); return r; }).catch((e) => 'error: ' + (e && e.message || e))",
        );
        report.handoffPick = await js(`(async () => {
          const wait = (ms) => new Promise((r) => setTimeout(r, ms));
          const h = (window.__jeditor.store.harnesses || []).find((x) => x.id === ${JSON.stringify(agent2)});
          if (!h || !h.available) return { ok: false, why: 'agent not available' };
          document.querySelector('[data-agent]').click();
          await wait(400);
          const item = Array.from(document.querySelectorAll('.menu .menu-item')).find((m) => m.textContent.includes(h.name));
          if (!item) return { ok: false, why: 'not in menu' };
          item.click();
          await wait(600);
          const label = document.querySelector('[data-agent]').textContent;
          const input = document.querySelector('[data-input]');
          input.value = ${JSON.stringify(prompt2)};
          input.dispatchEvent(new Event('input', { bubbles: true }));
          await wait(200);
          document.querySelector('[data-send]').click();
          return { ok: label.includes(h.name), label };
        })()`);
        const limit2 = Number(process.env.JEDITOR_SMOKE_TURN_MS) || 8 * 60 * 1000;
        // Nothing was sent when the pick failed: no turn to wait for.
        const end2 = Date.now() + (report.handoffPick && report.handoffPick.ok ? limit2 : 0);
        let sawBusy2 = false;
        let finished2 = false;
        let lastShot2 = 0;
        while (Date.now() < end2) {
          await sleep(1500);
          const st2 = await js("(() => { const b = document.querySelector('[data-send]'); return { busy: Boolean(b && b.classList.contains('is-stop')), sending: Boolean(b && b.querySelector('.spin')) }; })()");
          if (st2.busy || st2.sending) sawBusy2 = true;
          if (Date.now() - lastShot2 > 20000) {
            lastShot2 = Date.now();
            report.shots.push(await shot("handoff-progress-" + Math.round((limit2 - (end2 - Date.now())) / 1000) + "s"));
          }
          if (sawBusy2 && !st2.busy && !st2.sending) {
            finished2 = true;
            break;
          }
        }
        await sleep(2500);
        report.turn2 = await js(
          "(() => { const t = document.querySelector('[data-inner]'); return { users: t.querySelectorAll('.msg-user').length, agentReplies: t.querySelectorAll('.msg-agent').length, errors: Array.from(t.querySelectorAll('.err')).map((e) => e.textContent.slice(0, 300)), notice: (document.querySelector('[data-notice]').textContent || '').slice(0, 300), lastReply: ((Array.from(t.querySelectorAll('.msg-agent .md')).pop() || {}).textContent || '').slice(0, 600) }; })()",
        );
        // The Stop button must stay off once the turn ended: sample the
        // button and the host's own busy flag for 12 s.
        report.settle2 = [];
        for (let i = 0; i < 24; i++) {
          report.settle2.push(await js("(async () => { const b = document.querySelector('[data-send]'); const list = await window.cutline.editorChats({ workspaceId: window.__jeditor.store.workspaceId, page: 'ai', projectId: " + JSON.stringify(projectId) + " }); const s = await window.cutline.acpSession({ workspaceId: window.__jeditor.store.workspaceId, projectId: " + JSON.stringify(projectId) + ", chatId: list[0].id, harnessId: " + JSON.stringify(agent2) + " }); return (b.classList.contains('is-stop') ? 'S' : '-') + (s && s.busy ? 'B' : '-') + (s ? s.seq : ''); })()"));
          await sleep(500);
        }
        report.turn2.stuckStop = report.settle2.slice(-4).some((x) => x[0] === "S");
        report.turn2.finished = finished2;
        report.turn2.seconds = Math.round((Date.now() - (end2 - limit2)) / 1000);
        report.chatRows2 = await js(
          "window.cutline.editorChats({ workspaceId: window.__jeditor.store.workspaceId, page: 'ai', projectId: " + JSON.stringify(projectId) + " }).then(async (list) => { const r = await window.cutline.editorChatGet({ id: list[0].id }); const rows = r.chat.acpTranscript || []; return { chats: list.length, harnessId: r.chat.harnessId, savedRows: rows.length, harnesses: Array.from(new Set(rows.map((x) => x.harnessId).filter(Boolean))) }; })",
        );
        report.shots.push(await shot("handoff-final"));
      }
    }

    if (process.env.JEDITOR_SMOKE_UI) report.ui = await uiChecks({ js, sleep, shot, waitFor, win, report });

    try {
      report.libraryProtocol = await checkLibraryProtocol();
    } catch (error) {
      report.libraryProtocol = { ok: false, error: error.message || String(error) };
    }
    report.consoleErrors = errors;
    const pagesOk = Object.values(report.pages).every(Boolean);
    const pickersOk = !report.homePickers || report.homePickers.ok;
    // A prompt run only passes when the agent really answered.
    const turnOk = !prompt || Boolean(report.turn && report.turn.finished && report.turn.agentReplies > 0 && !report.turn.errors.length && !report.turn.notice);
    const t2 = report.turn2;
    const turn2Ok = !report.handoffPick || Boolean(report.handoffPick.ok && t2 && t2.finished && !t2.stuckStop && t2.users >= 2 && !t2.errors.length && !t2.notice);
    const modelOk = !process.env.JEDITOR_SMOKE_MODEL || Boolean(report.homeModel && report.homeModel.pick && report.homeModel.pick.ok && report.modelCheck && report.modelCheck.ok);
    report.ok = Boolean(report.booted && pagesOk && pickersOk && turnOk && turn2Ok && modelOk && (!report.market || report.market.ok) && report.libraryProtocol && report.libraryProtocol.ok && report.draw && report.draw.ok && report.railSwitch && report.projectDelete && report.projectDelete.ok && !report.snapshotError && !errors.length && report.title === "JDesign");
    process.stdout.write(JSON.stringify(report) + "\n");
    app.exit(report.ok ? 0 : 2);
  } catch (error) {
    report.error = (error && error.stack) || String(error);
    report.consoleErrors = errors;
    process.stdout.write(JSON.stringify(report) + "\n");
    app.exit(1);
  }
}

// JEDITOR_SMOKE_UI: click through the chat and dialogs of the newest project
// that already has a conversation with tool calls (use a data folder from an
// earlier agent run). Every check is a real DOM interaction.
async function uiChecks({ js, sleep, shot, waitFor, win, report }) {
  const ui = {};
  const projectId = await js(
    "window.cutline.aiProjects().then(async (list) => { const all = Array.isArray(list) ? list : (list && list.projects) || []; for (const p of all) { const chats = await window.cutline.editorChats({ workspaceId: window.__jeditor.store.workspaceId, page: 'ai', projectId: p.id }); for (const c of chats || []) { const r = await window.cutline.editorChatGet({ id: c.id }); if ((r.chat.acpTranscript || []).some((x) => x.role === 'tool' && x.input)) return p.id; } } return ''; })",
  );
  ui.projectWithTools = Boolean(projectId);
  if (!projectId) return ui;
  await js("window.__jeditor.navigate('editor', { projectId: " + JSON.stringify(projectId) + " })");
  await waitFor(".steps");
  await sleep(1200);

  // Tool step details: open a steps block, then one step's input and result.
  ui.stepDetail = await js(`(async () => {
    const steps = Array.from(document.querySelectorAll('.steps')).find((s) => s.querySelector('details.tool-row[data-step]'));
    if (!steps) return { ok: false, why: 'no step with details' };
    if (!steps.classList.contains('is-open')) steps.querySelector('[data-toggle]').click();
    await new Promise((r) => setTimeout(r, 300));
    const again = document.querySelector('[data-steps="' + steps.dataset.steps + '"]');
    const d = again.querySelector('details.tool-row[data-step]');
    d.querySelector('summary').click();
    await new Promise((r) => setTimeout(r, 300));
    const pre = d.querySelectorAll('pre');
    d.scrollIntoView({ block: 'center' });
    return { ok: d.open && pre.length > 0, blocks: pre.length, first: (pre[0] && pre[0].textContent || '').slice(0, 120) };
  })()`);
  await sleep(1500);
  ui.stepScroll = await js("(() => { const d = document.querySelector('.step-detail[open]'); const t = document.querySelector('[data-thread]'); const before = t.scrollTop; if (d) d.scrollIntoView({ block: 'center' }); return { threads: document.querySelectorAll('[data-thread]').length, editors: document.querySelectorAll('[data-stage]').length, found: Boolean(d), anyDetail: document.querySelectorAll('.step-detail').length, openSteps: document.querySelectorAll('.steps.is-open').length, before, after: t.scrollTop, max: t.scrollHeight - t.clientHeight }; })()");
  await sleep(150);
  ui.shots = [await shot("ui-step-detail")];

  // Drafts: type, switch to a new chat, come back.
  ui.draft = await js(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const input = document.querySelector('[data-input]');
    input.value = 'draft that should survive';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const firstTitle = document.querySelector('[data-chat-title]').textContent;
    document.querySelector('[data-new]').click();
    await wait(1200);
    const emptyInNew = document.querySelector('[data-input]').value === '';
    document.querySelector('[data-chats]').click();
    await wait(400);
    const item = Array.from(document.querySelectorAll('.menu .menu-item')).find((m) => m.textContent.includes(firstTitle.slice(0, 20)));
    if (!item) return { ok: false, why: 'chat not in menu', firstTitle };
    item.click();
    await wait(1500);
    const back = document.querySelector('[data-input]').value;
    return { ok: emptyInNew && back === 'draft that should survive', emptyInNew, back };
  })()`);

  // Dialog: focus moves in, the app is inert, Tab stays inside, Escape restores focus.
  ui.dialog = await js(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const more = document.querySelector('[data-more]');
    more.focus();
    more.click();
    await wait(300);
    const del = Array.from(document.querySelectorAll('.menu .menu-item')).find((m) => /Delete chat/.test(m.textContent));
    if (!del) return { ok: false, why: 'no delete item' };
    del.click();
    await wait(300);
    const dlg = document.querySelector('.scrim .dialog');
    const labelled = dlg && dlg.getAttribute('aria-labelledby');
    const labelText = labelled ? (document.getElementById(labelled) || {}).textContent : '';
    const focusInside = dlg && dlg.contains(document.activeElement);
    const appInert = document.getElementById('app').inert === true;
    const last = Array.from(dlg.querySelectorAll('button')).pop();
    last.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    const wrapped = dlg.contains(document.activeElement) && document.activeElement !== last;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await wait(200);
    const closed = !document.querySelector('.scrim .dialog');
    const appBack = document.getElementById('app').inert === false;
    const restored = document.activeElement === more;
    return { ok: Boolean(labelText) && focusInside && appInert && wrapped && closed && appBack && restored, labelText, focusInside, appInert, wrapped, closed, appBack, restored };
  })()`);

  // A modal closes any open menu, and page shortcuts stay off behind it.
  ui.modalGuards = await js(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    document.activeElement && document.activeElement.blur();
    document.querySelector('[data-more]').click();
    await wait(300);
    const menuBefore = Boolean(document.querySelector('.menu'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true }));
    await wait(300);
    const dialog = Boolean(document.querySelector('.scrim .dialog'));
    const menuAfter = Boolean(document.querySelector('.menu'));
    const page = location.hash + '|' + Boolean(document.querySelector('[data-stage]'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '1', ctrlKey: true, bubbles: true, cancelable: true }));
    await wait(400);
    const stayed = Boolean(document.querySelector('[data-stage]'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await wait(200);
    return { ok: menuBefore && dialog && !menuAfter && stayed, menuBefore, dialog, menuAfter, stayed, page };
  })()`);

  // Narrow window: the chat column gives way instead of crushing the stage.
  const before = win.getSize();
  win.setSize(960, 700);
  await sleep(900);
  ui.narrow = await js(`(() => {
    const chat = document.querySelector('[data-chat]').getBoundingClientRect().width;
    const col = document.querySelector('.stage-col').getBoundingClientRect();
    const video = document.querySelector('[data-stage]').getBoundingClientRect();
    const fits = video.left >= col.left - 1 && video.right <= col.right + 1;
    return { ok: chat <= window.innerWidth * 0.47 && col.width >= 300 && fits, chat: Math.round(chat), stage: Math.round(col.width), videoFits: fits, width: window.innerWidth, wrapW: document.querySelector('[data-stage-wrap]').clientWidth, stageW: document.querySelector('[data-stage]').style.width, hidden: document.visibilityState };
  })()`);
  ui.shots.push(await shot("ui-narrow"));
  win.setSize(before[0], before[1]);
  await sleep(500);

  // Home follows the default agent from Settings until one is picked there.
  ui.homeAgent = await js(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const s = window.__jeditor.store;
    const ids = (s.harnesses || []).filter((h) => h.available).map((h) => h.id);
    const other = ids.find((id) => id !== s.prefs.defaultAgent) || '';
    const original = s.prefs.defaultAgent || '';
    const label = () => (document.querySelector('[data-agent]') || {}).textContent || '';
    window.__jeditor.navigate('home');
    await wait(600);
    const first = label();
    if (!other || ids.length < 2) return { ok: true, note: 'only one agent installed; default shown: ' + first.trim() };
    s.prefs = await window.cutline.setPrefs({ defaultAgent: other });
    window.__jeditor.navigate('library');
    await wait(400);
    window.__jeditor.navigate('home');
    await wait(600);
    const second = label();
    s.prefs = await window.cutline.setPrefs({ defaultAgent: original });
    return { ok: first !== second, first: first.trim(), second: second.trim() };
  })()`);
  ui.ok = Boolean(ui.modalGuards && ui.modalGuards.ok && ui.stepDetail && ui.stepDetail.ok && ui.draft && ui.draft.ok && ui.dialog && ui.dialog.ok && ui.narrow && ui.narrow.ok && ui.homeAgent && ui.homeAgent.ok);
  if (!ui.ok) report.pages.ui = false;
  return ui;
}

module.exports = { runJeditorSmoke };
