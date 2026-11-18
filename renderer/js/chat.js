// The project chat. Talks to a real ACP agent through the main process: the
// host spawns the agent, streams its transcript here, and saves it to the
// chat row. This module only draws and sends.

import { api, store, on, emit, defaultHarnessId, harnessById, thumbFor, setPrefs } from "./store.js";
import { getSession, setSession, scopeKey, displayItems, resync } from "./sessions.js";
import { esc, icon, toast, showMenu, confirmDialog, promptDialog, openDialog, autosize, timeAgo, errorText, formatDuration } from "./ui.js";
import { renderMarkdown } from "./markdown.js";
import { buildPrompt } from "./prompt.js";
import { agentAvatar, agentName, openAgentMenu, loadModels, modelPickerButton, openModelMenu } from "./agent-ui.js";
import { mediaChip, pickMedia, wireDrop, importPaths } from "./media.js";
import { attachSlashMenu, fetchSlashCommands, workflowFor, workflowByName, followUps } from "./slash.js";
import { attachMic, speak, stopSpeaking, isSpeaking, onSpeakingChange } from "./voice.js";

const PAGE = "ai";

// Old message rows (user / assistant / system) as transcript rows.
export function legacyRows(messages) {
  return (messages || [])
    .filter((m) => m && typeof m.text === "string" && m.text.trim())
    .map((m) => ({
      role: m.role === "assistant" ? "agent" : m.role === "system" ? "system" : "user",
      text: m.text,
      at: Date.parse(m.createdAt) || 0,
    }));
}
// Unsent text and pinned media for each chat, kept while JV is open so
// switching chats or pages does not lose what the person was typing.
const drafts = new Map();
// What a failed turn means for the person, and the one thing to do next.
// action: "continue" | "retry" | "restart" | "agents".
export function explainFailure(raw) {
  const text = String(raw || "");
  const rules = [
    [/restart the agent/i, "The agent got stuck and needs a fresh start.", "restart"],
    [/stopped during its reply/i, "The agent stopped partway through. Some changes may already be in the project.", "continue"],
    [/stopped while your message was going out/i, "The agent stopped before it could start on your message.", "retry"],
    // Before the sign in rule: an ElevenLabs key problem is not the agent signing out.
    [/elevenlabs/i, "Voiceovers and music need a working ElevenLabs key.", "voice"],
    [/\bsign ?in\b|\blog ?in\b|\bauth(entication|enticate|orization)?\b|unauthori[sz]ed|\b401\b|api key/i, "The agent needs you to sign in again.", "signin"],
    [/\btimed? ?out\b|\btimeout\b/i, "The agent took too long to answer.", "retry"],
    // A tool server that closed leaves the agent running but blind to JV.
    [/\bmcp\b|tool (server|connection)|\bno tools\b|tools? (?:are )?(?:not )?(?:available|closed|disconnected)/i, "The agent lost its connection to JV's tools.", "restart"],
    [/ENOENT|not installed|no such file/i, "That agent is not installed on this computer.", "agents"],
    [/\bexited\b|not running|\bcrash|ECONNRESET|EPIPE|\bspawn\b|could not start/i, "The agent closed unexpectedly.", "restart"],
    [/internal error|stream (closed|ended)|overloaded|rate limit|\b429\b|\b(status|http|error|code)\W{0,3}5\d\d\b/i, "The agent's service had a problem.", "retry"],
  ];
  for (const [re, plain, action] of rules) if (re.test(text)) return { plain, action, raw: text };
  // No rule matched: still say what happened in a sentence, never the raw code.
  return { plain: "The agent stopped before it finished this turn.", action: "retry", raw: text };
}

const ACTION_LABEL = { continue: "Continue", retry: "Try again", restart: "Restart and try again", agents: "Open agents", signin: "Sign in", voice: "Set up ElevenLabs" };

export function draftKey(projectId, chatId) {
  return (projectId || "") + "/" + (chatId || "new");
}
const WINDOW = 160; // display items drawn before "Show earlier"

// Starters that fit what the project has, so nobody is offered "look at my
// footage" in an empty project or "make it shorter" before there is a video.
const SUGGESTIONS = {
  empty: [
    "Make a 10 second animated intro with my channel name",
    "Make a title card that says Coming Soon",
    "Build a 15 second promo video from scratch",
  ],
  clips: [
    "Look at my clips and suggest an edit",
    "Cut this into a 30 second highlight with captions",
    "Add captions and a title at the start",
    "Turn this into a vertical short for TikTok",
  ],
  done: [
    "Make the captions bigger and easier to read",
    "Make a shorter 15 second version",
    "Add background music",
    "Make a vertical 9:16 version",
  ],
};

function stageOf(project) {
  const renders = project && project.state && project.state.renders ? Object.keys(project.state.renders).length : 0;
  if (renders) return "done";
  return project && project.assets && project.assets.length ? "clips" : "empty";
}

function suggestionsFor(project) {
  return SUGGESTIONS[stageOf(project)];
}

// Workflow chips for the empty chat, so the / commands are visible from the
// first message, not only to people who know to type a slash.
const STARTER_FLOWS = {
  empty: ["explainer", "animate", "voiceover"],
  clips: ["edit", "captions", "music"],
  done: ["improve", "review", "short"],
};

export function mountChat(root, ctx) {
  const st = {
    chats: [],
    chat: null,
    harnessId: "",
    modelId: "",
    pins: [],
    sending: false,
    pendingText: "",
    pendingAt: 0,
    connectError: "",
    showAll: false,
    open: new Map(), // per item key: open/closed overrides
    destroyed: false,
    busySince: 0,
    queued: null, // { text, chatId } typed while the agent worked
    mic: "idle", // idle | listening | working
    micMs: 0,
    wasBusy: false,
    saying: -1, // index of the reply being read aloud
  };

  root.innerHTML =
    '<div class="chat-head">' +
    '<button class="chat-title" data-chats title="Chats in this project"><span data-chat-title>Chat</span>' + icon("chevDown", "i-sm chev") + "</button>" +
    '<button class="icon-btn icon-btn-sm" data-new title="New chat" aria-label="New chat">' + icon("plus") + "</button>" +
    '<button class="icon-btn icon-btn-sm" data-speak aria-label="Read replies aloud"></button>' +
    '<button class="icon-btn icon-btn-sm" data-more title="Chat options" aria-label="Chat options">' + icon("more") + "</button>" +
    "</div>" +
    '<div class="thread" data-thread><div class="thread-inner" data-inner></div></div>' +
    '<div class="composer-wrap">' +
    '<div data-notice></div><div data-queued></div>' +
    '<div class="composer" data-composer>' +
    '<div class="composer-pins" data-pins></div>' +
    '<textarea data-input rows="1" placeholder="Ask the agent to edit, cut, caption, or render"></textarea>' +
    '<div class="composer-foot">' +
    '<button class="icon-btn icon-btn-sm" data-attach title="Attach media">' + icon("paperclip") + "</button>" +
    '<button type="button" class="icon-btn icon-btn-sm" data-slash-open title="Workflows (type /)" aria-label="Workflows">' + icon("slash") + "</button>" +
    '<button type="button" class="icon-btn icon-btn-sm mic-btn" data-mic aria-label="Talk instead of typing"></button>' +
    '<span data-agent-slot></span><span data-model-slot></span>' +
    '<span class="grow"></span>' +
    '<span class="agent-status" data-status></span>' +
    '<button class="send-btn" data-send title="Send">' + icon("arrowUp") + "</button>" +
    "</div></div>" +
    '<div class="composer-hint"><span data-hint></span><span data-count></span></div>' +
    "</div>";

  const $ = (sel) => root.querySelector(sel);
  const thread = $("[data-thread]");
  const input = $("[data-input]");
  const draftHere = () => draftKey(ctx.projectId, st.chat ? st.chat.id : "");
  const saveDraft = () => {
    const text = input.value;
    // A message waiting for the turn to end is part of the draft, so leaving
    // the chat or the project while the agent works does not drop it.
    // Only once the chat exists: a message queued during the very first send
    // would otherwise be saved under the "new chat" key and come back later.
    const queued = st.chat && st.queued && (!st.queued.chatId || st.queued.chatId === st.chat.id) ? st.queued : null;
    if (text.trim() || st.pins.length || queued) drafts.set(draftHere(), { text, pins: st.pins.slice(), queued });
    else drafts.delete(draftHere());
  };
  const restoreDraft = () => {
    const d = drafts.get(draftHere());
    input.value = d ? d.text : "";
    st.pins = d ? d.pins.filter((id) => store.mediaById(id)) : [];
    st.queued = d && d.queued ? d.queued : null;
    autosize(input);
  };

  const scope = () => ({
    workspaceId: store.workspaceId,
    projectId: ctx.projectId,
    chatId: st.chat ? st.chat.id : "",
    harnessId: st.harnessId,
  });
  const session = () => (st.chat && st.harnessId ? getSession(scope()) : null);
  const busy = () => Boolean(session() && session().busy);

  // ---------- chats ----------

  const loadChats = async () => {
    try {
      st.chats = (await api.editorChats({ workspaceId: store.workspaceId, page: PAGE, projectId: ctx.projectId })) || [];
      if (!Array.isArray(st.chats)) st.chats = st.chats.chats || [];
    } catch {
      st.chats = [];
    }
  };

  const refreshTitle = async () => {
    if (!st.chat || st.destroyed) return;
    const id = st.chat.id;
    await loadChats();
    const fresh = st.chats.find((c) => c.id === id);
    if (fresh && st.chat && st.chat.id === id && fresh.title !== st.chat.title) {
      st.chat.title = fresh.title;
      $("[data-chat-title]").textContent = fresh.title || "New chat";
    }
  };

  const openChat = async (id) => {
    saveDraft();
    let record = null;
    try {
      record = id ? await api.editorChatGet({ id }) : null;
    } catch {
      record = null;
    }
    st.chat = record && record.chat ? record.chat : null;
    st.wasBusy = false;
    // Chats from Cutline before ACP kept plain message rows instead of an ACP
    // transcript; draw those so an imported conversation is not blank.
    st.legacyRows = record && Array.isArray(record.messages) ? legacyRows(record.messages) : [];
    st.harnessId = (st.chat && st.chat.harnessId && harnessById(st.chat.harnessId) ? st.chat.harnessId : "") || st.harnessId || defaultHarnessId();
    st.modelId = (st.chat && st.chat.model) || "";
    st.showAll = false;
    st.open.clear();
    st.connectError = "";
    st.failure = null;
    st.resendAfterAuth = null;
    restoreDraft();
    if (st.chat) void api.editorChatOpen({ id: st.chat.id }).catch(() => {});
    paintAll(true);
    seedModels();
    // A chat that already talked to an agent reconnects in the background so
    // its model list and session are ready by the time the user types.
    if (st.chat && st.chat.harnessId && store.prefs.autoConnect !== false && harnessById(st.harnessId)?.available) void connect(false);
  };

  const newChat = async (opts = {}) => {
    try {
      const record = await api.editorChatCreate({ workspaceId: store.workspaceId, page: PAGE, projectId: ctx.projectId, model: "" });
      await loadChats();
      if (opts.silent) {
        // A send that created this chat only shows it if the person is
        // still where they pressed Send.
        if (!opts.keep || opts.keep()) st.chat = record.chat;
        return record.chat;
      }
      await openChat(record.chat.id);
      input.focus();
      return st.chat;
    } catch (error) {
      toast(errorText(error), true);
      return null;
    }
  };

  // ---------- agent connection ----------

  const connect = async (surface, fixedScope) => {
    if (!fixedScope && (!st.chat || !st.harnessId)) return null;
    const sc = fixedScope || scope();
    const current = getSession(sc);
    if (current && current.ready) return current;
    const h = harnessById(sc.harnessId);
    if (!h || !h.available) {
      st.connectError = (h ? h.name : "This agent") + " is not installed. " + ((h && h.install) || "Set it up on the Agents page.");
      paintNotice();
      return null;
    }
    setSession(sc, { connecting: true, error: "" });
    try {
      const snap = await api.acpStart(sc);
      return setSession(sc, Object.assign({}, snap, { connecting: false }));
    } catch (error) {
      const msg = errorText(error);
      setSession(sc, { connecting: false, ready: false, error: msg });
      if (surface) st.connectError = msg;
      paintNotice();
      return null;
    }
  };

  const signIn = async (methodId) => {
    try {
      setSession(scope(), { connecting: true });
      const snap = await api.acpAuthenticate(Object.assign({}, scope(), { methodId }));
      setSession(scope(), Object.assign({}, snap, { connecting: false }));
      // Signed in from a failed turn's Sign in button: that message goes out now.
      const pending = st.resendAfterAuth && st.chat && st.resendAfterAuth.chatId === st.chat.id ? st.resendAfterAuth.text : "";
      st.resendAfterAuth = null;
      if (pending && snap && !snap.authRequired) {
        if (input.value.trim() === pending) {
          input.value = "";
          autosize(input);
        }
        void send(pending);
      }
    } catch (error) {
      setSession(scope(), { connecting: false });
      toast(errorText(error), true);
    }
  };

  // ---------- prompt body ----------

  const promptBody = (text, pins, chatId, userEdits) =>
    buildPrompt({
      text,
      projectId: ctx.projectId,
      project: ctx.getProject(),
      workspaceId: store.workspaceId,
      chatId: chatId || "",
      selectedAssetId: ctx.selectedAssetId(),
      pinned: pins.map((id) => store.mediaById(id)),
      mediaById: (id) => store.mediaById(id),
      userEdits,
    });

  // ---------- send / stop ----------

  // Why a workflow cannot run in this project yet, or "".
  const workflowBlocked = (c) => {
    if (!c || !c.needs) return "";
    const needs = String(c.needs).split(/\s*,\s*/);
    if (needs.includes("elevenlabs") && store.elevenlabsReady === false) return "Add your ElevenLabs key in Settings > Voice and music first";
    if (!needs.includes("clip")) return "";
    const p = ctx.getProject ? ctx.getProject() : null;
    const hasClip = Boolean(p && ((p.assets || []).some((a) => a.kind === "video") || (p.state && p.state.renders && Object.keys(p.state.renders).length)));
    return hasClip ? "" : "Add a clip to this project first, or use /animate";
  };

  const starterChips = () => {
    const names = STARTER_FLOWS[stageOf(ctx.getProject && ctx.getProject())] || [];
    return names
      .map((n) => workflowByName(n, st.harnessId))
      .filter((f) => f && !workflowBlocked(f))
      .map((f) => '<button type="button" class="chip" data-suggest="/' + esc(f.name) + ' " title="/' + esc(f.name) + (f.about ? ": " + esc(f.about) : "") + '">' + icon(f.icon || "slash", "i-sm") + '<span class="chip-text">' + esc(f.label) + "</span></button>")
      .join("");
  };

  const send = async (textArg, harnessOverride) => {
    let text = String(textArg != null ? textArg : input.value).trim();
    // A bare slash is the start of a command, not a message.
    if (!text || text === "/") return;
    // A workflow typed in full that cannot run here yet (/improve with no
    // clip) says why instead of starting an agent turn with nothing to do.
    const flow = workflowFor(text, st.harnessId);
    const blocked = flow ? workflowBlocked(flow) : "";
    if (blocked) {
      toast(blocked, true);
      return;
    }
    // Typed while the agent works: hold it and send it the moment the turn
    // ends, instead of refusing it. One message waits; a second replaces it.
    if (busy() || st.sending) {
      // A second message while one waits joins it, so nothing typed is lost.
      const prev = st.queued && (!st.queued.chatId || !st.chat || st.queued.chatId === st.chat.id) ? st.queued.text : "";
      st.queued = { text: prev ? prev + "\n\n" + text : text, chatId: st.chat ? st.chat.id : "" };
      if (textArg == null) {
        input.value = "";
        autosize(input);
      }
      saveDraft();
      paintComposer();
      return;
    }
    if (harnessOverride) st.harnessId = harnessOverride;
    if (!st.harnessId) {
      toast("Choose an agent first.", true);
      return;
    }
    // Typed in the box while a message is held after a failure: the held one
    // goes first, in the order written. A resend from a button leaves it
    // waiting to follow that turn.
    const held = textArg == null && st.queued && (!st.queued.chatId || !st.chat || st.queued.chatId === st.chat.id) ? st.queued : null;
    if (held) {
      if (held.text !== text) text = st.failure && st.failure.text === text ? text + "\n\n" + held.text : held.text + "\n\n" + text;
      st.queued = null;
    }
    st.sending = true;
    st.connectError = "";
    st.failure = null;
    st.pendingText = text;
    st.pendingAt = Date.now();
    drafts.delete(draftHere());
    if (textArg == null) {
      input.value = "";
      autosize(input);
    }
    paintAll();
    let failScope = null;
    const failPins = st.pins.slice();
    // Everything this send needs is fixed the moment Send is pressed.
    // Switching chats while it creates the chat, hands over, or starts the
    // agent must not move the message to the other chat.
    const startChat = st.chat;
    const startChatId = startChat ? startChat.id : "";
    const harnessId = st.harnessId;
    const modelId = st.modelId;
    const pins = st.pins.slice();
    const stillThere = () => (st.chat ? st.chat.id : "") === startChatId;
    try {
      const chat = startChat || (await newChat({ silent: true, keep: stillThere }));
      if (!chat) throw new Error("Could not start a chat.");
      const sc = Object.assign(scope(), { chatId: chat.id, harnessId });
      failScope = sc;
      const here = () => Boolean(st.chat && st.chat.id === sc.chatId && st.harnessId === sc.harnessId);
      // Picking another agent on a chat that already has one hands the
      // conversation over with its context instead of starting blank.
      if (chat.harnessId && chat.harnessId !== harnessId) {
        await api.acpHandoff(Object.assign({}, sc, { fromName: agentName(chat.harnessId), toName: agentName(harnessId) }));
        const record = await api.editorChatGet({ id: chat.id });
        if (record && record.chat && st.chat && st.chat.id === chat.id) st.chat = record.chat;
      }
      if (pins.length) {
        const project = ctx.getProject() || {};
        const have = new Set((project.assets || []).map((a) => a.id));
        const add = pins.filter((id) => !have.has(id) && store.mediaById(id) && store.library.some((i) => i.id === id));
        if (add.length) {
          await api.aiProjectAddAssets({ id: ctx.projectId, assetIds: add }).catch(() => {});
          void ctx.onProjectChanged();
        }
      }
      // Hand edits on the timeline strip go out once, with this message.
      const userEdits = await api.aiProjectTakeUserEdits({ id: ctx.projectId }).catch(() => []);
      const body = promptBody(text, pins, sc.chatId, userEdits);
      let live = await connect(true, sc);
      if (!live) throw new Error((here() && st.connectError) || (getSession(sc) || {}).error || "The agent could not start.");
      if (live.authRequired) throw new Error(agentName(sc.harnessId) + " needs you to sign in first.");
      const at = st.pendingAt;
      const payload = () => Object.assign({}, sc, { text: body, displayText: text, modelId: modelId || undefined, at });
      // Only the attachments that go out with this message leave the
      // composer; ones added while the agent started stay for the next one.
      if (here()) {
        st.pins = st.pins.filter((id) => !pins.includes(id));
        paintPins();
      }
      // The host names the chat from its first message as the prompt goes
      // out; a turn can run for minutes, so pick the name up now.
      if (here() && (!st.chat.title || st.chat.title === "New chat")) setTimeout(() => void refreshTitle(), 1200);
      try {
        await api.acpPrompt(payload());
      } catch (error) {
        // The host session died behind this window: start it again once.
        if (/Start the agent|not running|ready first/i.test(errorText(error))) {
          setSession(sc, { ready: false });
          live = await connect(true, sc);
          if (!live) throw error;
          await api.acpPrompt(payload());
        } else throw error;
      }
      if (here() && (!st.chat.title || st.chat.title === "New chat")) await refreshTitle();
      if (here()) st.chat.harnessId = sc.harnessId;
    } catch (error) {
      const msg = errorText(error);
      // Only the chat the message was typed in gets it back, with its media.
      const same = failScope ? Boolean(st.chat && st.chat.id === failScope.chatId) : stillThere();
      // Typed in a chat the person has since left: it waits as that chat's draft.
      // A pin-only entry there is just the attachments still showing while
      // the send ran; only text the person typed since then wins.
      if (!/cancelled/i.test(msg) && !same && failScope) {
        const k = draftKey(ctx.projectId, failScope.chatId);
        const had = drafts.get(k);
        if (!had || !had.text.trim()) drafts.set(k, { text, pins: Array.from(new Set(failPins.concat(had ? had.pins : []))) });
      }
      if (!/cancelled/i.test(msg) && same) {
        st.connectError = msg;
        st.failure = Object.assign({ at: Date.now(), text }, explainFailure(msg));
        const lastUserRow = [...lastItems].reverse().find((i) => i.type === "user");
        const inThread = Boolean(lastUserRow && String(lastUserRow.text || "").trim() === text);
        if (!inThread && !input.value.trim()) {
          input.value = text;
          autosize(input);
          saveDraft();
        }
        if (failPins.length) {
          st.pins = Array.from(new Set(failPins.concat(st.pins)));
          paintPins();
        }
      }
    } finally {
      st.sending = false;
      st.pendingText = "";
      paintAll();
      void ctx.onProjectChanged();
    }
  };

  // Puts this chat's waiting message back in the box, ahead of anything
  // typed since (the order it was written in).
  const unqueueToInput = () => {
    const q = st.queued;
    if (!q || (q.chatId && st.chat && q.chatId !== st.chat.id)) return false;
    st.queued = null;
    input.value = input.value.trim() ? q.text + "\n\n" + input.value : q.text;
    autosize(input);
    saveDraft();
    paintComposer();
    return true;
  };

  const stop = async () => {
    // Stop means stop: a message waiting for this turn goes back into the box
    // instead of being sent the moment the cancelled turn ends.
    unqueueToInput();
    try {
      await api.acpCancel(scope());
    } catch (error) {
      toast(errorText(error), true);
    }
  };

  // ---------- painting ----------

  let raf = 0;
  const schedule = () => {
    if (raf || st.destroyed) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      paintThread();
      paintComposer();
    });
  };

  const paintAll = (jump) => {
    if (st.destroyed) return;
    $("[data-chat-title]").textContent = (st.chat && st.chat.title) || "New chat";
    paintThread(jump);
    paintComposer();
    paintPins();
  };

  const transcript = () => {
    const live = session();
    if (live && Array.isArray(live.transcript) && live.transcript.length) return live.transcript;
    const saved = st.chat && st.chat.acpTranscript;
    if (Array.isArray(saved) && saved.length) return saved;
    return st.legacyRows || [];
  };

  const isOpen = (key, fallback) => (st.open.has(key) ? st.open.get(key) : fallback);

  const itemHtml = (item, index, items) => {
    if (item.type === "user") {
      return (
        '<div class="msg-user"><div class="bubble">' + esc(item.text) + "</div>" +
        '<div class="meta"><span>' + esc(timeAgo(item.at)) + "</span>" +
        '<button class="link-btn" data-copy-text="' + index + '">Copy</button>' +
        (item.sent ? '<button class="link-btn" data-sent="' + index + '">What was sent</button>' : "") + "</div></div>"
      );
    }
    if (item.type === "agent") {
      // Each reply keeps the name of the agent that wrote it, so a chat handed
      // from one agent to another still shows who said what.
      const who = item.harnessId || (st.chat && st.chat.harnessId) || st.harnessId;
      const prevAgent = items.slice(0, index).reverse().find((x) => x.type === "agent" || x.type === "user");
      const prevWho = prevAgent && prevAgent.type === "agent" ? prevAgent.harnessId || (st.chat && st.chat.harnessId) || st.harnessId : "";
      const showTag = !prevAgent || prevAgent.type === "user" || prevWho !== who;
      return (
        '<div class="msg-agent">' +
        (showTag ? '<div class="agent-tag">' + agentAvatar(who) + esc(agentName(who)) + "</div>" : "") +
        '<div class="md">' + renderMarkdown(item.text) + "</div>" +
        '<div class="meta agent-meta"><button class="link-btn" data-say="' + index + '">' + (st.saying === index && isSpeaking() ? "Stop reading" : "Read aloud") + "</button>" +
        '<button class="link-btn" data-copy-text="' + index + '">Copy</button></div></div>'
      );
    }
    if (item.type === "steps") {
      const running = item.items.filter((s) => s.status === "running");
      const failed = item.items.filter((s) => s.status === "failed").length;
      const live = running.length > 0;
      const open = isOpen(item.key, Boolean(store.prefs.showToolDetails));
      const last = running[running.length - 1] || item.items[item.items.length - 1];
      const label = live
        ? '<span class="shimmer">' + esc(prettyTool(last.title)) + "</span>"
        : esc(item.items.length + (item.items.length === 1 ? " step" : " steps")) + (failed ? ' <span class="problem bad" style="font-size:var(--fs-xs)">' + icon("alertCircle", "i-sm") + failed + " failed</span>" : "");
      return (
        '<div class="steps' + (open ? " is-open" : "") + '" data-steps="' + esc(item.key) + '">' +
        '<button class="steps-head" data-toggle="' + esc(item.key) + '">' +
        (live ? icon("loader", "i-sm spin") : icon("tool", "i-sm")) + "<span>" + label + "</span>" + icon("chevDown", "i-sm chev") + "</button>" +
        '<div class="steps-list">' +
        item.items.map((s, i) => {
          // One row per call: a status word, the plain name, then a fold with
          // what the call took and returned. Nothing long on screen unasked.
          const state = s.status === "running" ? "Running" : s.status === "failed" ? "Failed" : "Done";
          const head =
            '<span class="tool-state is-' + s.status + '">' + state + "</span>" +
            '<span class="name" title="' + esc(s.title) + '">' + esc(prettyTool(s.title)) + "</span>";
          if (!s.input && !s.output) return '<div class="tool-row is-static">' + head + "</div>";
          // What the call took and returned, as the host recorded it (secrets redacted).
          const key = item.key + ":" + i;
          return '<details class="tool-row" data-step="' + esc(key) + '"' + (st.open.get(key) ? " open" : "") + ">" +
            '<summary class="tool-sum">' + head + icon("chevDown", "i-sm chev") + "</summary>" +
            '<div class="step-io">' +
            (s.input ? '<span class="step-io-label">Arguments</span><pre>' + esc(s.input) + "</pre>" : "") +
            (s.output ? '<span class="step-io-label">Result</span><pre>' + esc(s.output) + "</pre>" : "") +
            "</div></details>";
        }).join("") +
        "</div></div>"
      );
    }
    if (item.type === "thinking") {
      // Off unless turned on in Settings > Chat; the live row still shows the agent is busy.
      if (store.prefs.showThinking !== true && !item.live) return "";
      const open = isOpen(item.key, item.live);
      const label = item.live ? '<span class="shimmer">Thinking</span>' : "Thought" + (item.ms > 1500 ? " for " + Math.round(item.ms / 1000) + "s" : "");
      return (
        '<div class="thinking' + (open ? "" : " is-closed") + '"><button class="thinking-head" data-toggle="' + esc(item.key) + '">' +
        icon("brain", "i-sm") + label + icon(open ? "chevUp" : "chevDown", "i-sm") + "</button>" +
        '<div class="thinking-body">' + esc(item.text) + "</div></div>"
      );
    }
    if (item.type === "plan") {
      return (
        '<div class="plan"><div class="plan-title">Plan</div>' +
        item.entries.map((e) => {
          const s = String((e && e.status) || "");
          const cls = s === "completed" ? "done" : s === "in_progress" ? "active" : "";
          return '<div class="plan-item ' + cls + '">' + icon(s === "completed" ? "checkCircle" : s === "in_progress" ? "circleDot" : "circle", "i-sm") + "<span>" + esc((e && e.content) || "") + "</span></div>";
        }).join("") + "</div>"
      );
    }
    if (item.type === "permission") {
      const pending = item.status === "pending" && item.requestId;
      const isInstr = item.kind === "instructions";
      // One card for every approval: the sentence first, then the detail behind
      // a fold, then one primary action and a quiet decline.
      const copy = isInstr
        ? { title: "Change your instructions?", lead: "If you allow, the agent's edit replaces your instructions and rules. You can change them again in Settings." }
        : item.kind === "elevenlabs"
          ? { title: "Use your ElevenLabs credits?", lead: "If you allow, this voiceover or music spends characters from your ElevenLabs plan." }
          : { title: "Let the agent do this?", lead: "If you allow, the agent makes this change to your project. Only allow what you asked for." };
      const detail = (item.tool ? prettyTool(item.tool) : "") + (item.text ? (item.tool ? "\n\n" : "") + item.text : "");
      const detailFold = detail
        ? '<details class="perm-detail"><summary>' + icon("chevDown", "i-sm chev") + "Details</summary><pre>" + esc(detail) + "</pre></details>"
        : "";
      if (!pending) {
        const word = { allowed: "Allowed", always: "Always allowed", denied: "Denied", expired: "Expired", cancelled: "Cancelled" }[item.status] || item.status;
        return '<div class="perm is-settled"><div class="perm-title">' + icon("shield", "i-sm") + esc(item.tool ? prettyTool(item.tool) : copy.title) + '<span class="grow"></span><span class="faint">' + esc(word) + "</span></div></div>";
      }
      return (
        '<div class="perm"><div class="perm-title">' + icon("shield") + esc(copy.title) + "</div>" +
        '<p class="perm-lead">' + esc(copy.lead) + "</p>" +
        detailFold +
        '<div class="perm-actions">' +
        '<button class="btn btn-primary btn-sm" data-perm="' + esc(item.requestId) + '" data-choice="once">Allow</button>' +
        (isInstr ? "" : '<button class="btn btn-sm" data-perm="' + esc(item.requestId) + '" data-choice="always">Always allow</button>') +
        '<button class="btn btn-ghost btn-sm" data-perm="' + esc(item.requestId) + '" data-choice="deny">Deny</button>' +
        "</div></div>"
      );
    }
    if (item.type === "error") {
      const why = explainFailure(item.text);
      // Only the newest failure gets a button; older ones are history.
      const newest = index === items.length - 1 || !items.slice(index + 1).some((x) => x.type === "user" || x.type === "agent");
      return (
        '<div class="err">' + icon("alertCircle") + '<div class="grow">' +
        (why.plain ? "<div>" + esc(why.plain) + '</div><div class="faint err-detail">' + esc(why.raw) + "</div>" : esc(why.raw)) +
        "</div>" +
        (newest && !noticeOwnsFailure() ? '<button type="button" class="btn btn-sm" data-err-action="' + why.action + '">' + ACTION_LABEL[why.action] + "</button>" : "") +
        "</div>"
      );
    }
    if (item.type === "sys") return '<div class="sys">' + esc(item.text) + "</div>";
    return "";
  };

  let lastItems = [];
  const paintThread = (jump) => {
    const inner = $("[data-inner]");
    const live = session();
    const items = displayItems(transcript(), { busy: busy() });
    // The typed message shows at once, before the host echoes it back.
    const echoed = st.pendingText && items.some((i) => i.type === "user" && i.text === st.pendingText && i.at >= st.pendingAt - 2000);
    if (st.pendingText && !echoed) items.push({ type: "user", text: st.pendingText, at: st.pendingAt, key: "pending" });
    lastItems = items;
    const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 120;
    if (!items.length) {
      const h = harnessById(st.harnessId);
      inner.innerHTML =
        '<div class="chat-empty">' + agentAvatar(st.harnessId) +
        "<h3>" + esc(h ? "Edit with " + h.name : "Pick an agent to start") + "</h3>" +
        "<p>Tell it what you want in plain words. It can see this project's clips, cut and caption them, add voiceovers and music, make animations, and render the finished video.</p>" +
        '<div class="suggest">' + starterChips() + suggestionsFor(ctx.getProject && ctx.getProject()).slice(0, 2).map((s) => '<button type="button" class="chip" data-suggest="' + esc(s) + '" title="' + esc(s) + '">' + icon("message", "i-sm") + '<span class="chip-text">' + esc(s) + "</span></button>").join("") + "</div></div>";
      return;
    }
    const start = st.showAll ? 0 : Math.max(0, items.length - WINDOW);
    let html = start > 0 ? '<button class="btn btn-ghost btn-sm" style="align-self:center" data-earlier>Show ' + start + " earlier</button>" : "";
    for (let i = start; i < items.length; i += 1) html += itemHtml(items[i], i, items);
    const working = busy() || st.sending;
    if (working) {
      const lastItem = items[items.length - 1];
      const quiet = !lastItem || lastItem.type === "user" || (lastItem.type === "steps" && !lastItem.items.some((s) => s.status === "running"));
      if (quiet) {
        const label = live && live.connecting ? "Connecting to " + agentName(st.harnessId) : busy() ? "Working" : "Sending";
        html += '<div class="working"><span class="dots"><i></i><i></i><i></i></span><span>' + esc(label) + "</span></div>";
      }
    } else {
      // After a finished turn, offer the next workflow so a person can go
      // from /animate to /review to /improve without knowing the names.
      const lastUser = [...items].reverse().find((i) => i.type === "user");
      const project = ctx.getProject ? ctx.getProject() : null;
      const hasRender = Boolean(project && project.state && project.state.renders && Object.keys(project.state.renders).length);
      // No next steps after a turn that failed: the fix comes first.
      const lastReal = [...items].reverse().find((i) => i.type !== "sys");
      const lastItem = items[items.length - 1];
      const failed = Boolean(st.failure) || Boolean(lastReal && lastReal.type === "error") || Boolean(lastItem && lastItem.type === "sys" && /^x/.test(String(lastItem.key || "")));
      const next = lastUser && !failed ? followUps(lastUser.text, st.harnessId, hasRender, ctx.getProject && ctx.getProject()) : [];
      if (next.length) {
        html +=
          '<div class="followups"><span class="followups-label">Next</span>' +
          next.map((n) => '<button type="button" class="chip" data-suggest="/' + esc(n.name) + ' " title="/' + esc(n.name) + (n.about ? ": " + esc(n.about) : "") + '">' + icon(n.icon || "slash", "i-sm") + '<span class="chip-text">' + esc(n.label) + "</span></button>").join("") +
          "</div>";
      }
    }
    inner.innerHTML = html;
    if (jump || nearBottom) thread.scrollTop = thread.scrollHeight;
  };

  const paintNotice = () => {
    const el = $("[data-notice]");
    const live = session();
    const h = harnessById(st.harnessId);
    let html = "";
    if (live && live.authRequired) {
      const methods = Array.isArray(live.authMethods) ? live.authMethods : [];
      html =
        '<div class="notice warn">' + icon("logIn") + '<span class="grow">' + esc(agentName(st.harnessId)) + " needs you to sign in.</span>" +
        methods.slice(0, 3).map((m) => '<button class="btn btn-sm btn-primary" data-auth="' + esc(m.id) + '">' + esc(m.name || "Sign in") + "</button>").join("") + "</div>";
    } else if (h && !h.available) {
      html = '<div class="notice warn">' + icon("alert") + '<span class="grow">' + esc(h.name) + " is not installed.</span>" + '<button class="btn btn-sm" data-goto-agents>Set up</button></div>';
    } else if (st.connectError && (noticeOwnsFailure() || !lastTurnFailed())) {
      const why = st.failure || explainFailure(st.connectError);
      html =
        '<div class="notice bad">' + icon("alertCircle") + '<span class="grow">' +
        (why.plain ? esc(why.plain) + ' <span class="faint">' + esc(st.connectError) + "</span>" : esc(st.connectError)) + "</span>" +
        (st.failure ? '<button type="button" class="btn btn-sm" data-err-action="' + why.action + '">' + ACTION_LABEL[why.action] + "</button>" : "") +
        '<button class="icon-btn icon-btn-sm" data-dismiss title="Dismiss">' + icon("x", "i-sm") + "</button></div>";
    } else if (!store.harnesses.some((x) => x.available)) {
      html = '<div class="notice warn">' + icon("bot") + '<span class="grow">No agent is installed yet.</span><button class="btn btn-sm btn-primary" data-goto-agents>Add an agent</button></div>';
    }
    el.innerHTML = html;
  };

  const paintStatus = () => {
    const el = $("[data-status]");
    const live = session();
    if (busy()) {
      if (!st.busySince) st.busySince = Date.now();
      el.textContent = formatDuration(Date.now() - st.busySince);
    } else {
      st.busySince = 0;
      el.textContent = live && live.connecting ? "Connecting" : "";
    }
  };

  const paintComposer = () => {
    const h = harnessById(st.harnessId);
    $("[data-agent-slot]").innerHTML =
      '<button class="picker" data-agent title="Agent">' + agentAvatar(st.harnessId) + '<span class="ellipsis">' + esc(h ? h.name : "Choose agent") + "</span>" + icon("chevDown", "i-sm chev") + "</button>";
    $("[data-model-slot]").innerHTML = st.harnessId ? modelPickerButton(st.harnessId, st.modelId, session()) : "";
    const working = busy();
    const btn = $("[data-send]");
    btn.classList.toggle("is-stop", working);
    btn.innerHTML = working ? icon("stop") : st.sending ? icon("loader", "spin") : icon("arrowUp");
    btn.title = working ? "Stop (Esc)" : "Send";
    btn.disabled = !working && (st.sending || !input.value.trim() || input.value.trim() === "/");
    const ctrl = store.prefs.sendKey === "ctrl-enter";
    const flow = workflowFor(input.value, st.harnessId);
    if (st.mic === "listening" || st.mic === "working") {
      $("[data-hint]").innerHTML = st.mic === "working"
        ? "Turning your voice into text"
        : "Listening " + formatDuration(st.micMs || 0) + ". <kbd>Enter</kbd> or the mic to stop, <kbd>Esc</kbd> to throw it away";
    } else $("[data-hint]").innerHTML = working
      ? (input.value.trim() ? (ctrl ? "<kbd>Ctrl</kbd> <kbd>Enter</kbd>" : "<kbd>Enter</kbd>") + " to send it when the agent finishes, <kbd>Esc</kbd> to stop" : "Esc to stop")
      : flow
        ? icon("slash", "i-sm") + " Runs the " + esc(flow.label) + " workflow" + (flow.hint ? ". Optional: type " + esc(flow.hint.charAt(0).toLowerCase() + flow.hint.slice(1)) + " after it" : "")
        : (ctrl ? "<kbd>Ctrl</kbd> <kbd>Enter</kbd> to send" : "<kbd>Enter</kbd> to send, <kbd>/</kbd> for workflows");
    // Both voice states read in words in this line: the mic says it is
    // listening, and the speaker says replies are spoken.
    if (st.mic === "idle" && store.prefs.speakReplies) $("[data-hint]").innerHTML += '<span class="faint"> · Replies are read aloud</span>';
    paintQueued();
    paintNotice();
    paintStatus();
    paintSpeak();
    if (st.wasBusy && !working && !st.sending) onTurnEnd();
    st.wasBusy = working;
    // The turn ended with a message waiting: send it now, in its own chat.
    if (st.queued && !working && !st.sending && !lastTurnFailed() && st.chat && (!st.queued.chatId || st.chat.id === st.queued.chatId)) {
      const next = st.queued;
      setTimeout(() => {
        // The turn may have started in between (the agent reports busy a
        // moment after a send): keep waiting instead of dropping the message.
        if (st.queued !== next || busy() || st.sending || st.destroyed) return;
        st.queued = null;
        void send(next.text);
      }, 0);
    }
  };

  // Read the newest reply aloud when a turn ends, if that is turned on.
  function onTurnEnd() {
    if (!store.prefs.speakReplies || lastTurnFailed()) return;
    const items = lastItems || [];
    const lastUser = items.map((i) => i.type).lastIndexOf("user");
    for (let i = items.length - 1; i > lastUser; i--) {
      if (items[i].type === "agent") return sayItem(i);
    }
  }

  function sayItem(index, opts = {}) {
    const item = lastItems[index];
    if (!item || !item.text) return;
    st.saying = index;
    void speak(item.text, opts).then(() => paintThread());
  }

  function paintSpeak() {
    const btn = $("[data-speak]");
    const on = Boolean(store.prefs.speakReplies);
    btn.classList.toggle("is-on", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.title = on ? "Replies are read aloud. Click to turn off" : "Read replies aloud";
    btn.innerHTML = icon(on ? "volume" : "volumeX");
  }

  // The newest turn ended on an error (the thread's last real row).
  function lastTurnFailed() {
    if (st.failure) return true;
    const lastReal = [...(lastItems || [])].reverse().find((i) => i.type !== "sys");
    return Boolean(lastReal && lastReal.type === "error");
  }

  // The newest send failed in a way the thread does not show (the agent would
  // not start, a sign in was needed, the agent stopped mid-reply): the notice
  // carries it and its button.
  function noticeOwnsFailure() {
    if (!st.failure) return false;
    const lastReal = [...(lastItems || [])].reverse().find((i) => i.type !== "sys");
    if (!lastReal || lastReal.type !== "error") return true;
    const row = String(lastReal.text || "").trim();
    return !(row && (st.failure.raw.includes(row) || row.includes(st.failure.raw)));
  }

  const paintQueued = () => {
    const el = $("[data-queued]");
    const q = st.queued && (!st.chat || !st.queued.chatId || st.chat.id === st.queued.chatId) ? st.queued : null;
    const held = Boolean(q && !busy() && !st.sending && lastTurnFailed());
    el.innerHTML = q
      ? '<div class="queued">' + icon("clock", "i-sm") + '<span class="grow ellipsis">' + (held ? "Held after the error: " : "Sends next: ") + esc(q.text) + "</span>" +
        (held ? '<button type="button" class="link-btn" data-queued-send>Send now</button>' : "") +
        '<button type="button" class="link-btn" data-queued-edit>Edit</button>' +
        '<button type="button" class="icon-btn icon-btn-sm" data-queued-drop title="Don\'t send">' + icon("x", "i-sm") + "</button></div>"
      : "";
  };

  const paintPins = () => {
    st.pins = st.pins.filter((id) => store.mediaById(id));
    $("[data-pins]").innerHTML = st.pins.map((id) => mediaChip(store.mediaById(id))).join("");
    $("[data-pins]").style.display = st.pins.length ? "" : "none";
    saveDraft();
  };

  // ---------- events ----------

  input.addEventListener("input", () => {
    saveDraft();
    autosize(input);
    paintComposer();
  });
  input.addEventListener("keydown", (event) => {
    const ctrl = store.prefs.sendKey === "ctrl-enter";
    if (event.key === "Enter" && !event.isComposing && (ctrl ? event.ctrlKey || event.metaKey : !event.shiftKey && !event.ctrlKey)) {
      event.preventDefault();
      void send();
    }
  });
  $("[data-send]").addEventListener("click", () => (busy() ? stop() : send()));
  const mic = attachMic($("[data-mic]"), input, {
    onState: (state, info) => {
      st.mic = state;
      st.micMs = info.ms || 0;
      paintComposer();
    },
    onText: () => {
      if (store.prefs.micAutoSend && !busy()) void send();
    },
  });
  $("[data-speak]").addEventListener("click", async () => {
    const next = !store.prefs.speakReplies;
    if (!next) stopSpeaking();
    await setPrefs({ speakReplies: next });
    toast(next ? "Replies will be read aloud. Pick the voice in Settings > Chat." : "Replies won't be read aloud");
  });
  const offSpeaking = onSpeakingChange(() => {
    if (!isSpeaking()) st.saying = -1;
    paintThread();
  });
  const slash = attachSlashMenu(input, {
    host: $(".composer-wrap") || root,
    scope: () => scope(),
    agentLabel: () => agentName(st.harnessId),
    disabled: (c) => workflowBlocked(c),
  });
  $("[data-slash-open]").addEventListener("click", () => slash.openFromButton());
  // Warm the list so the hint can name a workflow typed without the menu.
  void fetchSlashCommands(scope()).then(() => {
    if (st.destroyed) return;
    paintComposer();
    paintThread();
  });
  $("[data-attach]").addEventListener("click", async () => {
    const items = await pickMedia({ title: "Attach media", confirm: "Attach", exclude: st.pins, excludeLabel: "Attached" });
    for (const item of items) if (!st.pins.includes(item.id)) st.pins.push(item.id);
    paintPins();
    input.focus();
  });
  $("[data-queued]").addEventListener("click", (event) => {
    if (!st.queued) return;
    if (event.target.closest("[data-queued-send]")) {
      const next = st.queued;
      st.queued = null;
      saveDraft();
      void send(next.text);
    } else if (event.target.closest("[data-queued-edit]")) {
      // Back into the box; it is no longer waiting.
      unqueueToInput();
      input.focus();
    } else if (event.target.closest("[data-queued-drop]")) {
      st.queued = null;
      saveDraft();
      paintComposer();
    }
  });
  $("[data-pins]").addEventListener("click", (event) => {
    const x = event.target.closest("[data-unpin]");
    if (!x) return;
    st.pins = st.pins.filter((id) => id !== x.dataset.unpin);
    paintPins();
  });
  wireDrop($("[data-composer]"), async (paths) => {
    const items = await importPaths(paths);
    for (const item of items) if (!st.pins.includes(item.id)) st.pins.push(item.id);
    paintPins();
  }, "is-over");

  root.addEventListener("toggle", (event) => {
    const d = event.target;
    if (d && d.dataset && d.dataset.step) st.open.set(d.dataset.step, d.open);
  }, true);

  root.addEventListener("click", async (event) => {
    const t = event.target;
    const toggle = t.closest("[data-toggle]");
    if (toggle) {
      const key = toggle.dataset.toggle;
      const el = toggle.parentElement;
      const nowOpen = el.classList.contains("steps") ? !el.classList.contains("is-open") : el.classList.contains("is-closed");
      st.open.set(key, nowOpen);
      paintThread();
      return;
    }
    const perm = t.closest("[data-perm]");
    if (perm) {
      perm.parentElement.querySelectorAll("button").forEach((b) => (b.disabled = true));
      await api.acpPermissionAnswer({ requestId: perm.dataset.perm, choice: perm.dataset.choice }).catch((e) => toast(errorText(e), true));
      return;
    }
    const auth = t.closest("[data-auth]");
    if (auth) return void signIn(auth.dataset.auth);
    if (t.closest("[data-goto-agents]")) return emit("navigate", { page: "agents" });
    const errAction = t.closest("[data-err-action]");
    if (errAction) {
      const action = errAction.dataset.errAction;
      const lastUser = [...lastItems].reverse().find((i) => i.type === "user");
      const lastUserAt = lastItems.lastIndexOf(lastUser);
      const partial = Boolean(lastUser) && lastItems.slice(lastUserAt + 1).some((i) => i.type === "agent" || i.type === "steps");
      const CONTINUE = "Continue where you stopped. Check the project first and do not redo steps that are already done.";
      const original = (st.failure && st.failure.text) || (lastUser && lastUser.text) || "";
      // A failed send whose message never reached the thread starts fresh.
      const inThread = !st.failure || Boolean(lastUser && String(lastUser.text || "").trim() === st.failure.text);
      const again = partial && inThread ? CONTINUE : original;
      // The box got the failed text back: it goes out from there, not twice.
      const fromBox = original && input.value.trim() === original;
      const resend = () => {
        if (!again) return;
        if (fromBox) {
          input.value = "";
          autosize(input);
        }
        void send(again);
      };
      if (action === "agents") return emit("navigate", { page: "agents" });
      if (action === "voice") return emit("navigate", { page: "settings", params: { section: "voice" } });
      if (action === "signin") {
        // A fresh start brings up the agent's own sign in buttons in the
        // notice; with none to offer, the Agents page is the way in.
        errAction.disabled = true;
        const sc = scope();
        const was = session();
        const restart = was && was.ready && !was.authRequired && sc.chatId && sc.harnessId;
        if (restart) setSession(sc, { ready: false });
        void Promise.resolve(restart ? api.acpStop(sc) : null).catch(() => {}).then(() => connect(true)).then((live) => {
          if (live && live.authRequired && (live.authMethods || []).length) {
            st.failure = null;
            st.connectError = "";
            st.resendAfterAuth = { text: again, chatId: sc.chatId };
          } else if (live && live.ready && !live.authRequired) {
            st.failure = null;
            resend();
          } else emit("navigate", { page: "agents" });
          paintAll();
        });
        return;
      }
      if (action === "continue") {
        st.failure = null;
        if (fromBox) {
          input.value = "";
          autosize(input);
          saveDraft();
        }
        return void send(CONTINUE);
      }
      if (action === "restart") {
        errAction.disabled = true;
        errAction.textContent = "Restarting";
        const sc = scope();
        if (sc.chatId && sc.harnessId) setSession(sc, { ready: false });
        void Promise.resolve(sc.chatId && sc.harnessId ? api.acpStop(sc) : null).catch(() => {}).then(() => connect(true)).then((live) => {
          if (live && live.ready) resend();
          else {
            st.failure = Object.assign({ at: Date.now(), text: again }, explainFailure(st.connectError || "The agent could not start."));
            if (!st.connectError) st.connectError = "The agent could not start.";
          }
          paintAll();
        });
        return;
      }
      resend();
      return;
    }
    if (t.closest("[data-dismiss]")) {
      st.failure = null;
      st.resendAfterAuth = null;
      st.connectError = "";
      paintNotice();
      return;
    }
    if (t.closest("[data-earlier]")) {
      st.showAll = true;
      paintThread();
      return;
    }
    const sug = t.closest("[data-suggest]");
    if (sug) {
      // A chip starts the message; whatever was typed stays after it.
      const typed = input.value.trim();
      const cmd = sug.dataset.suggest;
      input.value = !typed || typed.startsWith("/") ? cmd : cmd.startsWith("/") ? cmd + typed : cmd.replace(/\s+$/, "") + " " + typed;
      autosize(input);
      paintComposer();
      input.focus();
      return;
    }
    const say = t.closest("[data-say]");
    if (say) {
      const index = Number(say.dataset.say);
      if (st.saying === index && isSpeaking()) stopSpeaking();
      else sayItem(index);
      return;
    }
    const copy = t.closest("[data-copy-text]");
    if (copy) {
      const item = lastItems[Number(copy.dataset.copyText)];
      if (item) api.copyText(item.text).then(() => toast("Copied"));
      return;
    }
    const sent = t.closest("[data-sent]");
    if (sent) {
      const item = lastItems[Number(sent.dataset.sent)];
      if (item) openDialog({ title: "Sent to the agent", wide: true, body: '<pre class="selectable" style="white-space:pre-wrap;font:12px/1.5 var(--mono);color:var(--text-2);margin:0">' + esc(item.sent) + "</pre>" });
      return;
    }
    if (t.closest("[data-agent]")) {
      openAgentMenu(t.closest("[data-agent]"), st.harnessId, (id) => {
        if (id === st.harnessId) return;
        const prev = st.harnessId;
        st.harnessId = id;
        st.modelId = "";
        st.connectError = "";
        paintAll();
        if (st.chat && st.chat.harnessId && st.chat.harnessId !== id) toast("Your next message hands this chat to " + agentName(id) + " with its history.");
        if (prev !== id) void seedModels();
      }, { above: true });
      return;
    }
    if (t.closest("[data-model]")) {
      openModelMenu(t.closest("[data-model]"), st.harnessId, st.modelId, session(), async (modelId) => {
        st.modelId = modelId;
        paintComposer();
        if (st.chat) await api.editorChatUpdate({ id: st.chat.id, patch: { model: modelId }, light: true }).catch(() => {});
      }, { above: true });
    }
  });

  $("[data-chats]").addEventListener("click", (event) => {
    const items = [{ heading: "Chats in this project" }];
    for (const c of st.chats) {
      items.push({
        label: c.title || "New chat",
        // The last message time, not the last time the chat was opened.
        sub: (c.harnessId ? agentName(c.harnessId) + " · " : "") + timeAgo(c.acpTranscriptTailAt || c.updatedAt),
        icon: "message",
        checked: st.chat && c.id === st.chat.id,
        onSelect: () => openChat(c.id),
      });
    }
    if (!st.chats.length) items.push({ label: "No chats yet. Use + to start one.", disabled: true });
    showMenu(event.currentTarget, items, { width: 300, search: st.chats.length > 8 ? "Search chats" : "" });
  });
  $("[data-new]").addEventListener("click", () => newChat());
  $("[data-more]").addEventListener("click", (event) => {
    const live = session();
    showMenu(event.currentTarget, [
      { label: "Rename chat", icon: "pencil", disabled: !st.chat, onSelect: async () => {
        const name = await promptDialog({ title: "Rename chat", value: st.chat.title });
        if (!name) return;
        await api.editorChatUpdate({ id: st.chat.id, patch: { title: name }, light: true }).catch((e) => toast(errorText(e), true));
        st.chat.title = name;
        await loadChats();
        paintAll();
      } },
      { label: "Copy conversation", icon: "copy", disabled: !lastItems.length, onSelect: () => {
        const text = lastItems.filter((i) => i.type === "user" || i.type === "agent").map((i) => (i.type === "user" ? "You: " : agentName(i.harnessId || (st.chat && st.chat.harnessId) || st.harnessId) + ": ") + i.text).join("\n\n");
        api.copyText(text).then(() => toast("Copied"));
      } },
      { label: live && (live.ready || live.connecting) ? "Restart agent" : "Connect agent", sub: live && (live.ready || live.connecting) ? "Fresh session. Nothing is resent." : "", icon: "refresh", disabled: !st.chat || busy(), onSelect: async () => {
        if (live && (live.ready || live.connecting)) await api.acpStop(scope()).catch(() => {});
        setSession(scope(), { ready: false });
        await connect(true);
      } },
      "sep",
      { label: "Delete chat", icon: "trash", danger: true, disabled: !st.chat, onSelect: async () => {
        const ok = await confirmDialog({ title: "Delete this chat?", body: "The conversation is removed. Edits the agent already made stay in the project.", confirm: "Delete", danger: true });
        if (!ok) return;
        await api.acpStop(scope()).catch(() => {});
        await api.editorChatDelete({ id: st.chat.id }).catch((e) => toast(errorText(e), true));
        st.chat = null;
        await loadChats();
        await openChat(st.chats[0] ? st.chats[0].id : "");
      } },
    ], { align: "end" });
  });

  const onKey = (event) => {
    // Esc stops the agent only from inside the chat, so an extra Esc after
    // closing a menu elsewhere never cancels a long render.
    if (event.key === "Escape" && busy() && !document.querySelector(".scrim, .menu, .slash-menu") && root.contains(document.activeElement)) {
      event.preventDefault();
      void stop();
    }
  };
  document.addEventListener("keydown", onKey);

  // Ask the agent for its models as soon as it is picked, so the choice is
  // there before the first message.
  const seedModels = () => {
    if (!st.harnessId) return;
    void loadModels(st.harnessId);
    paintComposer();
  };

  const offs = [
    on("session", ({ key }) => {
      if (st.chat && key === scopeKey(scope())) schedule();
    }),
    on("harnesses", () => {
      paintAll();
      seedModels();
    }),
    on("models", ({ harnessId }) => {
      if (harnessId === st.harnessId) paintComposer();
    }),
    on("prefs", () => paintAll()),
    on("snapshot", () => paintPins()),
  ];
  const ticker = setInterval(() => {
    if (busy()) paintStatus();
  }, 1000);

  // ---------- start ----------

  (async () => {
    await loadChats();
    const pending = store.pendingLaunch && store.pendingLaunch.projectId === ctx.projectId ? store.pendingLaunch : null;
    store.pendingLaunch = null;
    if (pending) {
      st.harnessId = pending.harnessId || defaultHarnessId();
      st.modelId = pending.modelId || "";
      await newChat({ silent: true });
      if (st.chat && st.modelId) await api.editorChatUpdate({ id: st.chat.id, patch: { model: st.modelId }, light: true }).catch(() => {});
      seedModels();
      paintAll(true);
      void send(pending.text, st.harnessId);
      return;
    }
    let active = null;
    try {
      active = await api.editorChatActive({ workspaceId: store.workspaceId, page: PAGE, projectId: ctx.projectId });
    } catch {
      active = null;
    }
    const id = (active && active.chat && active.chat.id) || (st.chats[0] && st.chats[0].id) || "";
    await openChat(id);
    if (st.chat) {
      const live = getSession(scope());
      if (live) void resync(scope());
    }
    void seedModels();
  })();

  return {
    focus: () => input.focus(),
    // The project gained or lost media or a video: the starters change.
    refresh: () => {
      if (!st.destroyed) paintThread();
    },
    attach: (ids) => {
      for (const id of ids) if (!st.pins.includes(id)) st.pins.push(id);
      paintPins();
      input.focus();
    },
    destroy: () => {
      saveDraft();
      st.destroyed = true;
      cancelAnimationFrame(raf);
      clearInterval(ticker);
      document.removeEventListener("keydown", onKey);
      slash.destroy();
      mic.destroy();
      offSpeaking();
      stopSpeaking();
      offs.forEach((off) => off());
    },
  };
}

// Tool titles arrive as "server: tool_name" or raw ids; say what they do.
const TOOL_NAMES = {
  tts: "Make voiceover", music: "Make music", elevenlabs_voices: "List voices", elevenlabs_setup: "Check voice setup",
  get_project: "Read the project", update_project: "Update the project", apply_edit: "Apply edit", render_project: "Render the video",
  render_animation: "Render animation", animation_frames: "Check animation frames", preview_frames: "Look at frames", app_preview: "Show in preview",
  stage_preview: "Show in preview", get_skill: "Read a skill", list_media: "List media", library: "Read the library", probe: "Inspect a file",
  // JV's own tools, as the thread shows them.
  list_projects: "List projects", create_project: "Create a project", delete_project: "Delete a project", snapshot: "Read the workspace",
  list_workspaces: "List workspaces", create_workspace: "Create a workspace", set_active_workspace: "Switch workspace",
  list_cards: "List cards", get_card: "Read a card", render_card: "Render a card", set_card_html: "Write card HTML", export_card: "Export a card",
  delete_card: "Delete a card", duplicate_card: "Copy a card", list_templates: "List templates", template_store_list: "List templates",
  save_card_as_template: "Save a template", apply_template: "Use a template",
  add_files: "Add files", add_from_url: "Add from a link", list_library: "List the library", get_library_item: "Read a library item",
  list_finished: "List finished videos", get_finished: "Read a finished video", add_finished_video: "Add a finished video",
  compose_finished: "Put cards on the video", get_timeline: "Read the timeline", edit_timeline: "Edit the timeline", auto_scale: "Fit the clip",
  probe_audio: "Check the audio", set_audio: "Set the audio", mute_audio: "Mute the clip", clear_audio: "Clear the audio",
  replace_audio: "Replace the audio", export_project: "Export the project", export_finished: "Export the video",
  list_skills: "List skills", activity: "Read agent activity", read_chat: "Read the chat", record_note: "Write a note",
  plugin_list: "List plugins", plugin_read: "Read a plugin", plugin_write: "Write a plugin",
  execute: "Run a command", bash: "Run a command", shell: "Run a command", read: "Read a file", read_file: "Read a file", write: "Write a file",
  write_file: "Write a file", edit: "Edit a file", glob: "Find files", grep: "Search files", fetch: "Fetch a web page", web_search: "Search the web",
  todowrite: "Update the plan", task: "Run a subtask",
};
function prettyTool(title) {
  let t = String(title || "Tool call");
  t = t.replace(/^(mcp__)?[\w-]+(__|: )/, "");
  t = t.replace(/^(cutline|cards|jeditor)_/, "");
  const key = t.toLowerCase().replace(/[\s-]+/g, "_");
  if (TOOL_NAMES[key]) return TOOL_NAMES[key];
  t = t.replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}
