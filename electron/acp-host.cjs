"use strict";

// Runs outside coding agents (Cursor, Devin, editorpi) as ACP children of the
// app. One live session per agent. Updates stream to the Coding agents page;
// the agents reach JV itself through the MCP server passed in session/new.

const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { AcpClient } = require("../lib/acp-client");
const { listAcpHarnesses, acpSpawnSpec, cutlineMcpServersForAcp, writeCwdMcpConfig, preflightCutlineMcp, acpHarness } = require("../lib/acp-harnesses");
const { getChat, updateChat, switchChatHarness, getAcpModelCache, setAcpModelCache } = require("../lib/editor-chats");
const { chatTitleFromText } = require("../lib/editor-chats-store");
const { handoffPrompt, toolDetail } = require("../lib/acp-handoff");
const { isCardAssistantScope, CARD_ASSISTANT_PREAMBLE, CARD_TOOLS_HINT } = require("../lib/card-assistant");
const { stripInternalErrorTail, isInternalError, internalErrorDetail } = require("../lib/acp-errors");
const { isElevenLabsTool, isUserInstructionsTool, listPermissionOptions, pickAllowOnceId, pickAllowAlwaysId, deniedPermissionResult } = require("../lib/acp-permissions");
const { readConfig: readElevenLabsConfig, savePrefs: saveElevenLabsPrefs, grantTtsApproval } = require("../lib/elevenlabs");
const { recordAction } = require("../lib/agent-activity");
const { discoverSkills, ensureUserSkillsDir } = require("../lib/skills");
const { listCommands, expandSlash, normalizeAgentCommands, titleFor } = require("../lib/slash-commands");
const { readUserInstructions, userInstructionsPrompt, grantInstructionsApproval } = require("../lib/user-instructions");
const { listUserRules, userRulesPrompt } = require("../lib/user-rules");

const TRANSCRIPT_MAX = 4000;
// The start of a leaked internal error line (lib/acp-errors.js TAIL_ERROR_LINE).
const LINE_ERROR = /^[ \t]*Error:/;

// The rows a chat saves: saved rows older than anything this session holds
// (seed), rows trimmed off the capped live copy this session (evicted), then
// the live copy. A long chat never loses its head on save.
// Chats from Cutline before ACP kept plain user/assistant messages. They
// seed the transcript like saved ACP rows, so connecting an agent keeps them
// on screen and the agent gets them as context.
function legacyMessageRows(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((m) => m && typeof m.text === "string" && m.text.trim())
    .map((m) => ({
      role: m.role === "assistant" ? "agent" : m.role === "system" ? "system" : "user",
      text: m.text,
      at: Date.parse(m.createdAt) || 0,
    }));
}

function mergePersistRows(seedRows, evictedRows, liveRows) {
  const evicted = Array.isArray(evictedRows) ? evictedRows : [];
  const liveOnly = Array.isArray(liveRows) ? liveRows : [];
  const live = evicted.length ? evicted.concat(liveOnly) : liveOnly;
  const seed = Array.isArray(seedRows) ? seedRows : [];
  const first = live.find((row) => row && Number.isFinite(row.at));
  const firstAt = first ? first.at : Infinity;
  const head = seed.filter((row) => row && Number.isFinite(row.at) && row.at < firstAt);
  return head.concat(live);
}

function createAcpHost(host, dependencies) {
  const sessions = new Map();
  // An agent process that has sat idle this long is stopped to free its RAM.
  // The chat keeps its transcript and saved session id, and the renderer's
  // connect() restarts and resumes it on the next message. 0 turns it off.
  const IDLE_REAP_MS = (() => {
    const raw = process.env.JDESIGN_AGENT_IDLE_MS;
    const n = raw === undefined || raw === "" ? 10 * 60_000 : Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 10 * 60_000;
  })();
  let reapTimer = null;
  // Saved model lists older than this are read again from the agent in the
  // background, so models an agent adds later (Devin's SWE-2.1) show up
  // without a restart. JDESIGN_MODEL_REFRESH_MS overrides it; 0 turns it off.
  const MODEL_REFRESH_MS = (() => {
    const raw = process.env.JDESIGN_MODEL_REFRESH_MS;
    const n = raw === undefined || raw === "" ? 30 * 60_000 : Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 30 * 60_000;
  })();
  let modelRefreshTimer = null;
  let modelRefreshFirst = null;
  // Commands each agent advertised in its last session, so the / menu can
  // list them before a new session is up.
  const agentCommandCache = new Map();
  const Client = (dependencies && dependencies.AcpClient) || AcpClient;
  const spawnSpec = (dependencies && dependencies.acpSpawnSpec) || acpSpawnSpec;

  function scope(payload) {
    const body = typeof payload === "string" ? { harnessId: payload } : payload || {};
    return { harnessId: String(body.harnessId || ""), projectId: String(body.projectId || ""), workspaceId: String(body.workspaceId || ""), chatId: String(body.chatId || "") };
  }

  // One live session per workspace/project/chat/harness: two chats inside the
  // same project are separate conversations and resume independently.
  function key(payload) {
    const ids = scope(payload);
    return JSON.stringify([ids.workspaceId, ids.projectId, ids.chatId, ids.harnessId]);
  }

  function current(session) {
    return sessions.get(key(session)) === session && !session.stopped;
  }

  function clean(session, text) {
    let value = String(text || "");
    for (const token of session.tokens) if (token) value = value.split(token).join("[redacted]");
    return value;
  }

  // Appending a streamed chunk used to re-clean the whole accumulated reply,
  // which is quadratic on long replies. The head is already clean, so only a
  // token that straddles the seam can be new: re-clean the last (longest
  // token - 1) chars of the head together with the chunk. A short copy of
  // the row's tail rides on session._seam so neither this nor the leaked
  // error check reads (and flattens) the whole reply on every chunk.
  function appendChunk(session, row, text) {
    let max = 0;
    for (const token of session.tokens) if (token && token.length > max) max = token.length;
    const keep = Math.max(64, max);
    let seam = session._seam;
    if (!seam || seam.row !== row || seam.length !== row.text.length) {
      const body = String(row.text || "");
      seam = { row, tail: body.slice(-keep), lineErr: LINE_ERROR.test(body.slice(body.lastIndexOf("\n") + 1)) };
    }
    const prefix = max > 1 ? Math.min(seam.tail.length, max - 1) : 0;
    const window = seam.tail.slice(seam.tail.length - prefix) + text;
    const cleaned = max ? clean(session, window) : window;
    if (cleaned === window) row.text += text;
    else row.text = row.text.slice(0, row.text.length - prefix) + cleaned;
    const start = seam.tail.length - prefix;
    const joined = seam.tail.slice(0, start) + cleaned;
    // lineErr: the last line opens with "Error:", the only shape the leak
    // takes, so scrubInternalTail has to look. When the line began before
    // the kept tail, it keeps what was decided when that start was visible.
    const nl = joined.lastIndexOf("\n");
    const lineAt = nl >= 0 ? nl + 1 : row.text.length === joined.length ? 0 : -1;
    if (lineAt >= 0) seam.lineErr = LINE_ERROR.test(joined.slice(lineAt));
    seam.tail = joined.slice(-keep);
    seam.length = row.text.length;
    session._seam = seam;
  }

  // Every event and snapshot carries a rising number. A snapshot the window
  // asked for can come back after newer events (a turn finishing while the
  // request was in flight); the window drops anything older than what it has.
  let eventSeq = 0;
  function emit(ids, kind, payload) {
    const scoped = scope(ids);
    const seq = ++eventSeq;
    for (const win of host.windows()) {
      if (!win.isDestroyed()) win.webContents.send("acp-event", Object.assign({}, scoped, { kind, payload: Object.assign({}, payload, scoped, { seq }) }));
    }
    if (ids && ids.transcript && ids.chatId && sessions.get(key(ids)) === ids) schedulePersist(ids);
  }

  // JV persists the chat from the host, not the window: the transcript
  // the agent streams is the one that lands on the chat row, whether or not a
  // window is open on that chat. Writes coalesce to one every PERSIST_MS.
  const PERSIST_MS = 700;

  function persistRows(session) {
    return mergePersistRows(session.seedRows, session.evicted, session.transcript);
  }

  function persistNow(session) {
    if (session._persistTimer) clearTimeout(session._persistTimer);
    session._persistTimer = 0;
    if (!session.chatId || session.chatId === "card-assistant") return;
    try {
      const patch = { acpTranscript: persistRows(session), forHarness: session.harnessId };
      if (session.sessionId) patch.acpSessionId = session.sessionId;
      // chat.model is the person's pick only (the window saves it). Writing
      // the agent's current model here made the composer label change between
      // visits when no model was picked.
      updateChat(host.dataRoot, session.chatId, patch, { light: true });
    } catch {
      /* a deleted chat has nowhere to save; the session stops with it */
    }
  }

  function schedulePersist(session) {
    if (session._persistTimer) return;
    session._persistTimer = setTimeout(() => persistNow(session), PERSIST_MS);
  }

  // The first prompt that reaches an agent binds the chat to it and names the
  // chat after what the user typed.
  function bindChat(session, displayText) {
    if (!session.chatId || session.chatId === "card-assistant") return;
    try {
      const record = getChat(host.dataRoot, session.chatId, { transcript: "tail" });
      const chat = record && record.chat;
      if (!chat) return;
      const patch = {};
      if (!chat.harnessId) patch.harnessId = session.harnessId;
      if (!chat.title || chat.title === "New chat") patch.title = chatTitleFromText(displayText);
      if (Object.keys(patch).length) updateChat(host.dataRoot, session.chatId, patch, { light: true });
    } catch {
      /* the lock is a convenience; the turn still runs */
    }
  }

  // A streamed turn pushes one transcript update per agent chunk. Sending and
  // rebuilding the whole thread for every chunk is what made typing lag for
  // seconds on long chats, so the first chunk goes out at once and the rest
  // coalesce to about twelve a second. The trailing send always fires, so the
  // last chunk of a turn still lands.
  const STREAM_EMIT_MS = 80;

  // Each emit used to carry the entire transcript, which meant cloning
  // hundreds of KB across IPC twelve times a second on long chats. Track the
  // earliest index touched since the last send and ship only that tail; the
  // renderer keeps its own copy and applies the delta onto it.
  function markDirty(session, index) {
    const at = Number.isFinite(index) && index >= 0 ? index : 0;
    const prev = session._emitFrom;
    session._emitFrom = Number.isFinite(prev) && prev < at ? prev : at;
  }

  // `shift` counts rows the TRANSCRIPT_MAX cap dropped off the front since
  // the last send. The renderer drops as many before applying `from`, so a
  // capped chat ships its new tail instead of all 4000 rows on every push.
  function transcriptPayload(session) {
    const len = session.transcript.length;
    const from = Number.isFinite(session._emitFrom) ? Math.max(0, Math.min(session._emitFrom, len)) : len;
    const rows = from < len ? session.transcript.slice(from) : [];
    const shift = from > 0 ? session._emitShift || 0 : 0;
    session._emitFrom = len;
    session._emitShift = 0;
    return { transcriptDelta: shift ? { from, rows, length: len, shift } : { from, rows, length: len } };
  }

  // Tool rows by toolCallId, open tool rows, and row positions, so a
  // tool_call_update and the end-of-turn settle stop scanning thousands of
  // rows. Positions are absolute (rows ever pushed); `shift` is how many the
  // cap dropped off the front. Rebuilt whenever the transcript is replaced.
  function isOpenTool(row) {
    return Boolean(row && row.role === "tool" && (row.status === "pending" || row.status === "in_progress" || !row.status));
  }

  function indexTools(session) {
    const index = { byId: new Map(), open: new Set(), pos: new WeakMap(), shift: 0 };
    session._tools = index;
    session.transcript.forEach((row, at) => trackRow(session, row, at));
    return index;
  }

  function tools(session) {
    return session._tools || indexTools(session);
  }

  function trackRow(session, row, at) {
    if (!row || typeof row !== "object") return;
    const index = tools(session);
    index.pos.set(row, at + index.shift);
    if (row.role !== "tool") return;
    // First row wins, the same row the old linear find returned.
    if (!index.byId.has(row.toolCallId)) index.byId.set(row.toolCallId, row);
    if (isOpenTool(row)) index.open.add(row);
  }

  function rowIndex(session, row) {
    const index = tools(session);
    const abs = index.pos.get(row);
    if (abs !== undefined && session.transcript[abs - index.shift] === row) return abs - index.shift;
    const at = session.transcript.indexOf(row);
    if (at >= 0) index.pos.set(row, at + index.shift);
    return at;
  }

  // Cap the transcript at TRANSCRIPT_MAX by dropping its oldest rows.
  function trimFront(session) {
    const over = session.transcript.length - TRANSCRIPT_MAX;
    if (over <= 0) return;
    const index = tools(session);
    const dropped = session.transcript.splice(0, over);
    // Rows leave the live copy, never the saved chat: persistRows writes them.
    if (!Array.isArray(session.evicted)) session.evicted = [];
    for (const row of dropped) if (row) session.evicted.push(row);
    for (const row of dropped) {
      if (!row || row.role !== "tool") continue;
      if (index.byId.get(row.toolCallId) === row) index.byId.delete(row.toolCallId);
      index.open.delete(row);
    }
    index.shift += over;
    session._emitShift = (session._emitShift || 0) + over;
    if (Number.isFinite(session._emitFrom)) session._emitFrom = Math.max(0, session._emitFrom - over);
  }

  function emitTranscript(session) {
    const state = session._streamEmit || (session._streamEmit = { last: 0, timer: 0 });
    const now = Date.now();
    const since = state.last ? now - state.last : Infinity;
    if (since >= STREAM_EMIT_MS) {
      state.last = now;
      emit(session, "update", transcriptPayload(session));
      return;
    }
    if (state.timer) return;
    state.timer = setTimeout(() => {
      state.timer = 0;
      state.last = Date.now();
      if (current(session)) emit(session, "update", transcriptPayload(session));
    }, STREAM_EMIT_MS - since);
  }

  function workFolder(body, ids) {
    const root = path.resolve(host.dataRoot, "agent-workspaces");
    const isolated = path.join(root, createHash("sha256").update(key(ids)).digest("hex"));
    const dir = body.cwd && String(body.cwd).trim() ? path.resolve(String(body.cwd)) : isolated;
    if (ids.harnessId === "devin" && dir !== isolated) throw new Error("Devin sessions use JV's isolated agent workspace. Omit cwd when starting Devin.");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  // Rows are not strictly chronological: replayed history lands at the tail
  // after newer rows. "Newest" means the greatest `at`, not the last index.
  function lastRowAt(rows) {
    let at = 0;
    for (const row of rows || []) if (row && Number.isFinite(row.at) && row.at > at) at = row.at;
    return at;
  }

  function push(session, entry) {
    const row = Object.assign({ at: Date.now() }, entry);
    // Agent replies remember who wrote them, so a chat handed to another
    // agent keeps the right name on its older replies.
    if (row.role === "agent" && !row.harnessId && session.harnessId) row.harnessId = session.harnessId;
    if (row.text) row.text = clean(session, row.text);
    if (row.sent) row.sent = clean(session, row.sent);
    markDirty(session, session.transcript.length);
    trackRow(session, row, session.transcript.length);
    session.transcript.push(row);
    // The front splice shifts every index; trimFront carries that in the
    // delta's shift instead of restarting it at 0.
    trimFront(session);
  }

  // session/load replays the agent's stored history as fresh session/update
  // notifications. They fold into session.replayRows beside the seeded
  // transcript and merge once the load finishes, so rows the agent replayed
  // dedupe and anything the seed missed still lands. The transcript stays a
  // union that only grows, so persisting it can never erase stored history.
  const REPLAY_LOOKAHEAD = 8;

  function replayRowMatches(incoming, seeded) {
    if (!incoming || !seeded || incoming.role !== seeded.role) return false;
    if (incoming.role === "tool") {
      // Replays re-issue the same call under fresh replay-* ids, so ids that
      // differ must not force a duplicate: the title is the only stable name.
      if (incoming.toolCallId && seeded.toolCallId && incoming.toolCallId === seeded.toolCallId) return true;
      return String(incoming.title || "") === String(seeded.title || "");
    }
    if (incoming.role === "plan") {
      const a = (incoming.entries || []).map((entry) => String((entry && entry.content) || "")).join("");
      const b = (seeded.entries || []).map((entry) => String((entry && entry.content) || "")).join("");
      return a === b;
    }
    return String(incoming.text || "") === String(seeded.text || "");
  }

  // The saved transcript can be a moment behind or ahead of the agent's
  // replay: a chat persisted mid-stream holds a partial reply the agent
  // replays in full, and a re-serialized replay can be shorter or carry
  // different trailing whitespace than the row that was saved. Treating
  // either side being a prefix of the other as the same message keeps a
  // resume from printing a copy of the reply or a stray fragment of it.
  function replayTextOverlap(incoming, seeded) {
    const a = String(incoming == null ? "" : incoming).replace(/\s+$/, "");
    const b = String(seeded == null ? "" : seeded).replace(/\s+$/, "");
    if (!a || !b) return "";
    if (a === b) return "same";
    if (a.startsWith(b)) return "extends";
    if (b.startsWith(a)) return "covered";
    return "";
  }

  // Fold one replayed update the same way the live path folds into
  // session.transcript, but into a side list instead.
  function replayPush(session, row) {
    const list = session.replayRows || (session.replayRows = []);
    list.push(Object.assign({ at: Date.now() }, row));
  }

  function replayKey(row) {
    if (!row) return "";
    if (row.role === "tool") return "tool:" + String(row.title || "");
    if (row.role === "plan") return "plan:" + (row.entries || []).map((entry) => String((entry && entry.content) || "")).join("");
    return row.role + ":" + String(row.text || "").replace(/\s+$/, "");
  }

  function foldReplay(session) {
    const replayed = session.replayRows || [];
    session.replayRows = null;
    if (!replayed.length) return;
    // The transcript at this point is only the seeded rows; align the replay
    // against them with a short lookahead for rows the agent skipped.
    const seedLen = session.transcript.length;
    // The seeded window is the saved transcript's last TRANSCRIPT_MAX rows,
    // but the agent replays its whole session. A replayed row that misses the
    // aligned match is still skipped while the full saved copy holds it more
    // times than the replay has used, so a resume converges instead of
    // re-adding whatever the cap left out of the window.
    const saved = new Map();
    for (const row of session.seedRows && session.seedRows.length ? session.seedRows : session.transcript) {
      const k = replayKey(row);
      saved.set(k, (saved.get(k) || 0) + 1);
    }
    const used = new Map();
    let cursor = 0;
    for (const row of replayed) {
      const k = replayKey(row);
      const seen = used.get(k) || 0;
      used.set(k, seen + 1);
      let hit = -1;
      for (let i = cursor; i < Math.min(seedLen, cursor + REPLAY_LOOKAHEAD); i += 1) {
        const seeded = session.transcript[i];
        if (replayRowMatches(row, seeded)) {
          hit = i;
          break;
        }
        // Chunk folding glues consecutive same-role replayed messages into
        // one row; when the seed covers the head, the tail rejoins on its own.
        // A shorter replay of a reply the saved copy already holds is the same
        // message, not a second one.
        if (row.role === seeded.role && typeof row.text === "string" && typeof seeded.text === "string") {
          const overlap = replayTextOverlap(row.text, seeded.text);
          if (overlap === "extends") {
            session.transcript.push(Object.assign({}, row, { text: row.text.slice(seeded.text.length) }));
            hit = i;
            break;
          }
          if (overlap === "covered" || overlap === "same") {
            hit = i;
            break;
          }
        }
      }
      if (hit >= 0) cursor = hit + 1;
      else if (seen >= (saved.get(k) || 0)) session.transcript.push(row);
    }
    // Rows merged in at or after the seeded block; the next delta covers them.
    markDirty(session, seedLen);
    // Folded rows bypass push(), so the cap has to run here too or every
    // session/load keeps growing the stored transcript past TRANSCRIPT_MAX.
    // trimFront also moves the dirty mark down with the dropped rows.
    trimFront(session);
    indexTools(session);
  }

  // Folds ACP session/update notifications into a compact transcript: text
  // chunks join the last agent message, tool calls update in place.
  function onUpdate(session, params) {
    if (!current(session) || (params && params.sessionId && session.sessionId && params.sessionId !== session.sessionId)) return;
    const update = (params && params.update) || {};
    const kind = update.sessionUpdate;
    if (kind === "config_option_update" || kind === "current_model_update") {
      emitState(session);
      return;
    }
    if (kind === "available_commands_update") {
      session.agentCommands = normalizeAgentCommands(update.availableCommands || update.available_commands);
      if (session.harnessId) agentCommandCache.set(session.harnessId, session.agentCommands);
      emitState(session);
      return;
    }
    if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
      const text = update.content && update.content.type === "text" ? clean(session, update.content.text || "") : "";
      if (!text) return;
      const role = kind === "agent_message_chunk" ? "agent" : "thought";
      if (session.replaying) {
        const list = session.replayRows || (session.replayRows = []);
        const last = list[list.length - 1];
        if (last && last.role === role) {
          last.text += text;
          // A replayed turn can carry the same leaked tail; strip it for
          // display without flagging the live turn that did not produce it.
          const tail = stripInternalErrorTail(last.text);
          if (tail.error) {
            last.text = tail.text;
            // Nothing but the leaked tail: there is no reply to draw.
            if (!last.text.trim()) list.pop();
          }
        } else {
          // The chunk opens a new row (the row before it was a tool call, or a
          // different role), so the strip has to run here too: otherwise the
          // leaked internal error is kept as the replayed reply and the saved
          // answer reads as "Error: RetriableError: ...".
          const row = { role, at: Date.now(), text };
          const tail = stripInternalErrorTail(row.text);
          if (tail.error) row.text = tail.text;
          // Nothing but the leaked tail: there is no reply to draw.
          if (row.text.trim()) list.push(row);
        }
        return;
      }
      const last = session.transcript[session.transcript.length - 1];
      if (last && last.role === role) {
        appendChunk(session, last, text);
        markDirty(session, session.transcript.length - 1);
      } else push(session, { role, text });
      scrubInternalTail(session);
    } else if (kind === "tool_call") {
      // The approval card reads the script from here when the permission
      // request itself does not carry the tool's input.
      if (update.toolCallId && (update.rawInput || update.input)) rememberToolInput(session, update.toolCallId, update.rawInput || update.input);
      const row = {
        role: "tool",
        toolCallId: update.toolCallId,
        title: clean(session, update.title || "Tool call"),
        status: update.status || "pending",
      };
      applyToolDetail(session, row, update);
      if (row.status === "completed") session.turnHadCompletedTool = true;
      if (session.replaying) {
        replayPush(session, row);
        return;
      }
      push(session, row);
    } else if (kind === "tool_call_update") {
      if (update.toolCallId && (update.rawInput || update.input)) rememberToolInput(session, update.toolCallId, update.rawInput || update.input);
      const index = tools(session);
      const live = index.byId.get(update.toolCallId);
      const row = live || (session.replayRows || []).find((item) => item.role === "tool" && item.toolCallId === update.toolCallId);
      if (row) {
        if (update.status) row.status = update.status;
        if (update.status === "completed") session.turnHadCompletedTool = true;
        if (update.title) row.title = clean(session, update.title);
        applyToolDetail(session, row, update);
        if (live) {
          if (isOpenTool(row)) index.open.add(row);
          else index.open.delete(row);
          const at = rowIndex(session, row);
          if (at >= 0) markDirty(session, at);
        }
      }
    } else if (kind === "plan" && Array.isArray(update.entries)) {
      const row = { role: "plan", entries: update.entries.map((e) => ({ content: clean(session, e.content), status: e.status })) };
      if (session.replaying) {
        replayPush(session, row);
        return;
      }
      push(session, row);
    } else {
      return;
    }
    emitTranscript(session);
  }

  // Tool rows keep a short, redacted copy of what the call took and returned,
  // so a context handoff can show the next agent the tool trail, not just
  // titles.
  function applyToolDetail(session, row, update) {
    const detail = toolDetail(update);
    if (detail.kind) row.kind = detail.kind;
    if (detail.input) row.input = clean(session, detail.input);
    if (detail.output) row.output = clean(session, detail.output);
  }

  // A leaked internal error lands as the last line of the newest text row.
  // Strip it and remember where it was: a turn that still ends on this
  // signature died inside the agent process instead of answering.
  function scrubInternalTail(session) {
    const index = session.transcript.length - 1;
    const row = session.transcript[index];
    if (!row || (row.role !== "agent" && row.role !== "thought")) return;
    // Runs on every chunk: the leak only ever sits on the last line, so skip
    // the full-text regex unless that line could hold it. A streamed row
    // already knows from its seam without reading the whole reply.
    const seam = session._seam;
    if (seam && seam.row === row && seam.length === String(row.text || "").length) {
      if (!seam.lineErr) return;
    } else {
      const body = String(row.text || "");
      if (body.indexOf("Error:", body.lastIndexOf("\n") + 1) < 0) return;
    }
    const { text, error } = stripInternalErrorTail(row.text);
    if (!error) return;
    session.internalError = error;
    if (text) {
      row.text = text;
      session.internalErrorAt = index;
      session.internalErrorLen = text.length;
      markDirty(session, index);
    } else {
      session.transcript.pop();
      session.internalErrorAt = index;
      session.internalErrorLen = 0;
      markDirty(session, index);
    }
  }

  // The agent can hit the stream error mid-turn and recover: more thinking or
  // reply text arrives after the flagged tail. Only a turn that still ends on
  // the error counts as failed by it.
  function recoveredFromInternalError(session) {
    const at = session.internalErrorAt;
    if (!Number.isFinite(at) || at < 0) return false;
    const row = session.transcript[at];
    if (row && (row.role === "agent" || row.role === "thought") && row.text && row.text.length > (session.internalErrorLen || 0)) return true;
    for (let i = at + 1; i < session.transcript.length; i += 1) {
      const next = session.transcript[i];
      if ((next.role === "agent" || next.role === "thought") && next.text && next.text.trim()) return true;
    }
    return false;
  }

  // A settled turn leaves no tool call legitimately running: rows the agent
  // never finished (blocked, dropped, or killed with the turn) flip to
  // cancelled so they stop reading as "running" forever in the chat.
  function settleOrphanTools(session) {
    const index = tools(session);
    let first = -1;
    for (const row of index.open) {
      if (!isOpenTool(row)) continue;
      const at = rowIndex(session, row);
      if (at < 0) continue;
      row.status = "cancelled";
      if (first < 0 || at < first) first = at;
    }
    index.open.clear();
    if (first >= 0) markDirty(session, first);
  }

  // The saved agent session is poisoned when it dies on an internal error
  // twice: resuming it replays the same failure, so the chat forgets it and
  // the next start opens fresh.
  function forgetStoredSessionId(session, nextSessionId) {
    if (!session.chatId) return;
    try {
      updateChat(host.dataRoot, session.chatId, { acpSessionId: String(nextSessionId || "") });
    } catch {
      /* the renderer's transcript persist catches up */
    }
  }

  // A session that died on the internal stream error is poisoned: resuming it
  // replays the failure, so every later send dies the same way. Open a new one
  // on the same agent process and point the chat at it. Returns the new session
  // id, or "" when the agent could not open one.
  async function replaceSession(session) {
    const created = await whileWarmingUp(session, () => session.client.newSession({ cwd: session.cwd, mcpServers: session.pendingMcps || [] }));
    const nextId = created && (created.sessionId || created.session_id);
    if (typeof nextId !== "string" || !nextId.trim()) return "";
    session.sessionId = nextId;
    // The fresh session carries none of the earlier context, so the next send
    // must carry the chat history again.
    session.resumed = false;
    forgetStoredSessionId(session, nextId);
    return nextId;
  }

  // `lean` leaves the transcript out: emitState sends the rows through the
  // delta path instead of cloning the whole transcript on every state change.
  function snapshot(payload, lean) {
    const ids = scope(payload);
    const session = sessions.get(key(ids));
    if (!session) return Object.assign({}, ids, { seq: eventSeq, running: false, starting: false, ready: false, processRunning: false, busy: false, state: "stopped", transcript: [], models: { availableModels: [], currentModelId: "" }, effort: null, mcp: { status: "unchecked", configured: false, agentAcknowledged: null } });
    const processRunning = Boolean(session.client && session.client.started);
    const ready = session.ready && processRunning && !session.stopped;
    const out = Object.assign({}, ids, {
      seq: eventSeq,
      running: ready,
      starting: session.starting,
      ready,
      processRunning,
      state: session.starting ? "starting" : ready ? "ready" : session.error ? "error" : "stopped",
      busy: session.busy,
      sessionId: session.sessionId,
      cwd: session.cwd,
      agentName: session.agentName,
      error: session.error,
      models: session.client ? session.client.models : { availableModels: [], currentModelId: "" },
      effort: session.client ? session.client.effort || null : null,
      commands: Array.isArray(session.agentCommands) ? session.agentCommands.slice() : [],
      mcp: Object.assign({}, session.mcp),
      authRequired: Boolean(session.authRequired),
      authMethods: Array.isArray(session.authMethods) ? session.authMethods : [],
    });
    if (lean !== true) out.transcript = session.transcript.map((entry) => Object.assign({}, entry));
    return out;
  }

  // State changes (model and config updates, readiness, busy, MCP checks)
  // carry the transcript as the same delta "update" uses: the renderer folds
  // it with mergeAcpTranscriptDelta, so an unchanged transcript costs nothing.
  function emitState(session) {
    emit(session, "state", Object.assign(snapshot(session, true), transcriptPayload(session)));
  }

  function authFailure(error) {
    return /auth|credential|sign ?in|log ?in/i.test(String((error && error.message) || ""));
  }

  // Every live session and every background check refreshes the saved model
  // list, so the pickers on Home and in a fresh chat show what the agent
  // really offers. Models that were not in the saved list are reported to the
  // windows (acp-models-changed) so they can repaint and say what is new.
  function rememberModels(harnessId, models, effort) {
    if (!models || !Array.isArray(models.availableModels) || !models.availableModels.length) return [];
    let prev = null;
    try {
      prev = getAcpModelCache(host.dataRoot)[harnessId] || null;
    } catch {
      prev = null;
    }
    const entry = { availableModels: models.availableModels, currentModelId: models.currentModelId || "", effort: effort || null, updatedAt: Date.now() };
    try {
      setAcpModelCache(host.dataRoot, harnessId, entry);
    } catch {
      /* store busy; the next session retries */
    }
    const before = prev && Array.isArray(prev.availableModels) ? new Set(prev.availableModels.map((m) => m && m.modelId)) : null;
    const added = before && before.size ? entry.availableModels.filter((m) => !before.has(m.modelId)) : [];
    const removed = before && before.size ? before.size + added.length - entry.availableModels.length : 0;
    if (!before || added.length || removed) {
      for (const win of host.windows()) {
        if (!win.isDestroyed()) win.webContents.send("acp-models-changed", { harnessId, models: entry, added });
      }
    }
    return added;
  }

  function finishReady(session, mcp) {
    if (session.client) rememberModels(session.harnessId, session.client.models, session.client.effort);
    session.authRequired = false;
    session.authMethods = [];
    session.pendingNew = null;
    session.mcp.configured = true;
    session.mcp.transport = (mcp && mcp.type) || "stdio";
    session.ready = true;
    session.starting = false;
    session.lastActiveAt = Date.now();
    push(session, { role: "system", text: session.agentName + " session ready. JV MCP preflight passed; MCP configuration supplied. Agent tool connection is not reported by ACP." });
    emitState(session);
    return snapshot(session);
  }

  // After the user's row is in the transcript: a dead agent here says so in
  // words the window does not auto-retry on (a retry would add the message
  // twice).
  function assertActiveSent(session) {
    try {
      assertActive(session);
    } catch (error) {
      if (error.cancelled) throw error;
      throw new Error("The agent stopped while your message was going out. Send it again.");
    }
  }

  // After the agent answered (or died answering): it may already have changed
  // the project, so a blind resend could repeat its edits.
  function assertActiveReplied(session) {
    try {
      assertActive(session);
    } catch (error) {
      if (error.cancelled) throw error;
      throw new Error("The agent stopped during its reply. Check the project before you send again.");
    }
  }

  function assertActive(session) {
    if (!current(session)) {
      const error = new Error("ACP startup or turn cancelled.");
      error.cancelled = true;
      throw error;
    }
    if (session.client && !session.client.started) throw new Error("ACP child is not running.");
  }

  // ElevenLabs voiceovers spend real account characters, so they bypass the
  // blanket auto-allow. In "ask" mode the request becomes an approval card in
  // the chat; an unanswered card expires after five minutes and denies.
  const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;

  function permissionToolTitle(params) {
    const tool = (params && (params.toolCall || params.tool_call)) || {};
    return String(tool.title || tool.name || tool.toolName || "ElevenLabs voiceover");
  }

  function recordPermission(session, tool, status, detail, label) {
    try {
      recordAction(host.dataRoot, {
        tool: "permission:" + String(tool || "elevenlabs").slice(0, 80),
        client: "acp",
        harness: session.harnessId,
        sessionId: session.sessionId || "",
        projectId: session.projectId || "",
        workspaceId: session.workspaceId || "",
        ok: status === "allowed" || status === "always",
        summary: (label || "ElevenLabs voiceover") + " " + status + (detail ? " (" + detail + ")" : ""),
      });
    } catch {
      /* logging must never break the permission path */
    }
  }

  function grantScope(session) {
    return session.projectId || session.workspaceId || session.sessionId || "";
  }

  function rememberToolInput(session, id, input) {
    if (!session.toolInputs) session.toolInputs = new Map();
    session.toolInputs.set(String(id), input);
    if (session.toolInputs.size > 50) session.toolInputs.delete(session.toolInputs.keys().next().value);
  }

  // What the person is approving: every line of a script up to a size the
  // card can show, then how much more there is.
  function permissionPreview(input) {
    if (Array.isArray(input.lines) && input.lines.length) {
      const lines = input.lines.map((l, i) => (i + 1) + ". " + String(typeof l === "string" ? l : (l && l.text) || "").trim());
      const chars = lines.reduce((n, l) => n + l.length, 0);
      const shown = [];
      let used = 0;
      for (const line of lines) {
        if (used + line.length > 1400 && shown.length) break;
        shown.push(line.length > 400 ? line.slice(0, 400) + "..." : line);
        used += line.length;
      }
      const more = lines.length - shown.length;
      return lines.length + " lines, " + chars + " characters\n" + shown.join("\n") + (more ? "\nand " + more + " more line" + (more === 1 ? "" : "s") : "");
    }
    const text = String(input.text || input.script || input.prompt || "");
    if (!text) return "";
    return text.length > 400 ? text.slice(0, 400) + "... (" + text.length + " characters)" : text;
  }

  function askPermission(session, params, title, kind) {
    const requestId = "perm-" + randomUUID();
    const tool = (params && (params.toolCall || params.tool_call)) || {};
    const cached = tool.toolCallId && session.toolInputs ? session.toolInputs.get(String(tool.toolCallId)) : null;
    const has = (v) => v && typeof v === "object" && (Array.isArray(v.lines) || typeof v.text === "string");
    const input = [tool.rawInput, tool.input, cached].find(has) || tool.rawInput || tool.input || cached || {};
    const shown = permissionPreview(input);
    const preview = clean(session, shown || (kind === "instructions" ? "" : "This agent did not share the script with JV."));
    const row = { role: "permission", requestId, tool: title, text: preview, status: "pending", kind: kind || "elevenlabs" };
    push(session, row);
    // push copies the entry into the transcript row; settlePermission must
    // mutate that stored row or the card never repaints out of pending.
    const storedRow = session.transcript[session.transcript.length - 1];
    emitTranscript(session);
    return new Promise((resolve) => {
      const pending = {
        resolve,
        row: storedRow,
        params,
        timer: setTimeout(() => void settlePermission(session, requestId, "expired"), PERMISSION_TIMEOUT_MS),
      };
      session.permissions.set(requestId, pending);
    });
  }

  async function settlePermission(session, requestId, decision) {
    const pending = session.permissions.get(requestId);
    if (!pending) return false;
    session.permissions.delete(requestId);
    clearTimeout(pending.timer);
    const params = pending.params;
    const isInstructions = pending.row.kind === "instructions";
    const label = isInstructions ? "User instructions" : "ElevenLabs voiceover";
    let result;
    if (decision === "once" || decision === "always") {
      // The grant is consumed by the agent's actual tool call moments later;
      // without it the ask-mode gate in the tool would still refuse.
      (isInstructions ? grantInstructionsApproval : grantTtsApproval)(grantScope(session));
      if (isInstructions) {
        // Instruction edits have no always mode: every proposal asks.
        pending.row.status = "allowed";
        result = { outcome: { outcome: "selected", optionId: pickAllowOnceId(params) } };
      } else if (decision === "always") {
        pending.row.status = "always";
        try {
          await saveElevenLabsPrefs(host.dataRoot, { agentAccess: "always" });
        } catch {
          /* the allow still applies to this call */
        }
        result = { outcome: { outcome: "selected", optionId: pickAllowAlwaysId(params) || pickAllowOnceId(params) } };
      } else {
        pending.row.status = "allowed";
        result = { outcome: { outcome: "selected", optionId: pickAllowOnceId(params) } };
      }
    } else {
      pending.row.status = decision === "expired" ? "expired" : "denied";
      result = deniedPermissionResult(params);
    }
    recordPermission(session, pending.row.tool, pending.row.status, "", label);
    pending.resolve(result);
    markDirty(session, rowIndex(session, pending.row));
    if (current(session)) emitTranscript(session);
    return true;
  }

  // Returns a result to intercept the request, or undefined to keep the
  // default auto-answer for everything that is not ElevenLabs.
  async function onAgentRequest(session, message) {
    if (!current(session)) return undefined;
    const method = String((message && message.method) || "");
    if (!/request_permission/i.test(method)) return undefined;
    const params = (message && message.params) || {};
    // Instruction edits always ask: there is no access mode that skips the
    // card, so the agent can never change the standing text by itself.
    if (isUserInstructionsTool(params)) {
      const title = clean(session, permissionToolTitle(params));
      return askPermission(session, params, title, "instructions");
    }
    if (!isElevenLabsTool(params)) return undefined;
    const cfg = await readElevenLabsConfig(host.dataRoot);
    const mode = cfg.agentAccess || "ask";
    const title = clean(session, permissionToolTitle(params));
    if (mode === "always") return undefined;
    if (mode === "never") {
      push(session, { role: "permission", requestId: "", tool: title, text: "", status: "denied" });
      recordPermission(session, title, "denied", "access mode: never");
      emitTranscript(session);
      return deniedPermissionResult(params);
    }
    return askPermission(session, params, title);
  }

  // The chat's approval card answers through IPC. Any session can hold the
  // request, so the pending map is searched rather than trusting the scope.
  function answerPermission(payload) {
    const body = payload || {};
    const requestId = String(body.requestId || "");
    const choice = String(body.choice || "");
    if (!requestId || !["once", "always", "deny"].includes(choice)) return { ok: false };
    for (const session of sessions.values()) {
      if (session.permissions && session.permissions.has(requestId)) {
        void settlePermission(session, requestId, choice);
        return { ok: true };
      }
    }
    return { ok: false };
  }

  // Some agents (OpenCode with plugins) answer session/new and session/load
  // with ServiceUnavailableError for the first seconds while their plugins
  // load. That is a warm-up, not a failure: retry it.
  function isWarmingUp(error) {
    const text = String((error && error.message) || error || "") + " " + JSON.stringify((error && error.data) || "");
    return /ServiceUnavailable|did not finish activating|Internal service failure/i.test(text);
  }

  async function whileWarmingUp(session, call) {
    // Plugin loading has taken over 30 s on a busy machine, so wait up to 90 s
    // and tell the user why the agent is not answering yet.
    const end = Date.now() + 90000;
    let told = false;
    for (let delay = 1000; ; delay = Math.min(delay * 1.5, 4000)) {
      try {
        return await call();
      } catch (error) {
        if (!isWarmingUp(error) || Date.now() + delay > end) {
          if (isWarmingUp(error)) throw new Error(session.agentName + " did not finish starting after 90 seconds. Its plugins or MCP servers may be stuck; try again, or check the agent on its own.");
          throw error;
        }
        if (!told && current(session)) {
          told = true;
          push(session, { role: "system", text: session.agentName + " is still starting up. Waiting for it..." });
          emitState(session);
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
        assertActive(session);
      }
    }
  }

  // Opens the chat's session: session/load when the agent supports it and the
  // chat persisted a session id, else a fresh session/new. A rejected load
  // falls back to a clean session rather than failing the start.
  async function openSession(session) {
    const client = session.client;
    if (session.wantSessionId && session.canLoad) {
      // Replay updates collect beside the seeded transcript while this flag
      // is up; a rejected load still folds in whatever it managed to replay.
      session.replaying = true;
      try {
        const created = await whileWarmingUp(session, () =>
          client.loadSession(session.wantSessionId, Object.assign({}, session.pendingNew, { sessionId: session.wantSessionId })),
        );
        session.resumed = true;
        return created;
      } catch {
        /* the saved session expired server-side; start clean */
      } finally {
        session.replaying = false;
        foldReplay(session);
      }
    }
    return whileWarmingUp(session, () => client.newSession(session.pendingNew));
  }

  // A fresh session could not replay the chat's earlier context, so the next
  // prompt carries it once. A resumed session already has that context. A
  // chat just handed to this agent gets the fuller handoff block instead.
  function applyHistoryPrefix(session) {
    if (session.resumed) return;
    session.historyPrefix = handoffPrompt(session.seedRows, { harnessId: session.harnessId, chatId: session.chatId }) || historyPrefixFor(session.seedRows);
  }

  const HISTORY_PREFIX_MAX = 8000;
  function historyPrefixFor(rows) {
    const lines = [];
    for (const row of (Array.isArray(rows) ? rows : []).slice(-60)) {
      const text = String(stripInternalErrorTail((row && row.text) || "").text).replace(/\s+/g, " ").trim().slice(0, 800);
      if (row.role === "user" && text) lines.push("User: " + text);
      else if (row.role === "agent" && text) lines.push("Agent: " + text);
      else if (row.role === "tool" && (row.title || text)) lines.push("Tool: " + (String(row.title || "").trim() || text));
    }
    if (!lines.length) return "";
    let body = lines.join("\n");
    if (body.length > HISTORY_PREFIX_MAX) body = body.slice(-HISTORY_PREFIX_MAX);
    return "This chat is a restored session whose earlier agent context could not be loaded; use the prior conversation below as context and continue from it.\n" + body;
  }

  async function checkMcp(session, signal) {
    session.mcp.status = "checking";
    session.mcp.error = "";
    emitState(session);
    const bridge = host.bridgeInfo();
    if (bridge && bridge.token) session.tokens.add(bridge.token);
    try {
      // A chat outside the card studio also carries the card editor server,
      // so both are checked before the agent is told it has them.
      const profiles = profileFor(session) === "cards" ? ["cards"] : ["", "cards"];
      const results = await Promise.all(profiles.map((profile) => preflightCutlineMcp({ bridge, harnessId: session.harnessId, signal, profile })));
      assertActive(session);
      Object.assign(session.mcp, results[0], { toolCount: results.reduce((sum, item) => sum + (item.toolCount || 0), 0) });
      return bridge;
    } catch (error) {
      if (current(session)) Object.assign(session.mcp, signal && signal.aborted ? { status: "unchecked", error: "" } : { status: "error", error: clean(session, error.message) });
      throw error;
    }
  }

  function start(payload) {
    const body = payload || {};
    const ids = scope(body);
    const harness = acpHarness(ids.harnessId, { dataRoot: host.dataRoot });
    if (!harness) return Promise.reject(new Error("Unknown agent: " + ids.harnessId));
    const existing = sessions.get(key(ids));
    if (existing && existing.starting && !existing.stopped) return existing.startPromise;
    if (existing && existing.ready && existing.client && existing.client.started && !existing.stopped) return Promise.resolve(snapshot(ids));
    if (existing && existing.authRequired && existing.client && existing.client.started && !existing.stopped) return Promise.resolve(snapshot(ids));
    // A restart after a dead session keeps whatever its transcript had past
    // the last persist; the chat row only catches up on the debounced write.
    const displacedRows = existing && Array.isArray(existing.transcript) ? existing.transcript.slice() : [];
    if (existing) dispose(existing);
    const session = Object.assign({}, ids, {
      cwd: "", busy: false, starting: true, ready: false, stopped: false, transcript: [], sessionId: "", agentName: "", error: "", client: null, permissions: new Map(),
      authRequired: false, authMethods: [], pendingNew: null,
      canLoad: false, wantSessionId: "", resumed: false, seedRows: [], historyPrefix: "",
      internalError: "", internalErrorAt: -1, internalErrorLen: 0, turnHadCompletedTool: false,
      mcp: { status: "unchecked", configured: false, agentAcknowledged: null, transport: "", checkedAt: null, toolCount: 0, error: "" },
      tokens: new Set(), controller: new AbortController(), turnController: null, cancelVersion: 0,
    });
    sessions.set(key(ids), session);
    session.startPromise = Promise.resolve().then(async () => {
      let stderr = "";
      try {
        assertActive(session);
        // The persisted chat row carries the ACP session id and the saved
        // transcript, so reopening a chat can resume the same agent session.
        // The saved rows seed the live transcript before the session opens:
        // replayed rows dedupe against it and fresh rows append after it, so
        // the persisted stream can only ever grow, never shrink.
        if (session.chatId) {
          try {
            const record = getChat(host.dataRoot, session.chatId);
            if (record && record.chat) {
              session.wantSessionId = String(record.chat.acpSessionId || "");
              session.seedRows = Array.isArray(record.chat.acpTranscript) ? record.chat.acpTranscript : [];
              if (!session.seedRows.length) session.seedRows = legacyMessageRows(record.messages);
              if (session.seedRows.length) {
                session.transcript = session.seedRows.slice(-TRANSCRIPT_MAX).map((row) => Object.assign({}, row));
                // A permission row persisted while pending is dead: its
                // promise belonged to a session that is gone, so show it as
                // expired instead of buttons that can never answer. A tool row
                // left pending died with its turn the same way. A reply that
                // ends on a leaked internal error drops the noise tail.
                for (const row of session.transcript) {
                  if (!row) continue;
                  if (row.role === "permission" && row.status === "pending") row.status = "expired";
                  if (row.role === "tool" && (row.status === "pending" || row.status === "in_progress" || !row.status)) row.status = "cancelled";
                  if ((row.role === "agent" || row.role === "thought") && row.text) row.text = stripInternalErrorTail(row.text).text;
                }
                session.transcript = session.transcript.filter((row) => row && (row.role !== "agent" && row.role !== "thought" || row.text));
              }
            }
          } catch {
            /* store unreadable; start clean */
          }
        }
        // The live transcript is the fresher copy: the persisted seed can be
        // a debounced write behind it, and once the stored transcript exceeds
        // TRANSCRIPT_MAX the capped live copy is the only one holding the
        // newest rows. Prefer whichever ends later; break ties toward the
        // longer one.
        const seedTail = lastRowAt(session.transcript);
        const dispTail = lastRowAt(displacedRows);
        if (dispTail > seedTail || (dispTail === seedTail && displacedRows.length >= session.transcript.length)) {
          session.transcript = displacedRows.slice(-TRANSCRIPT_MAX).map((row) => Object.assign({}, row));
        }
        if (dispTail > lastRowAt(session.seedRows) || displacedRows.length > session.seedRows.length) session.seedRows = displacedRows;
        // The transcript was rebuilt wholesale; whatever an earlier emit sent
        // no longer lines up, so the next delta restarts from the top.
        session._emitFrom = 0;
        session._emitShift = 0;
        indexTools(session);
        // Emit the starting state only after the saved transcript is seeded,
        // so the first snapshot the renderer sees never clobbers seeded rows
        // with an empty transcript.
        emitState(session);
        const bridge = await checkMcp(session, session.controller.signal);
        const spec = spawnSpec(ids.harnessId, { appRoot: host.appRoot, dataRoot: host.dataRoot });
        session.cwd = workFolder(body, ids);
        const options = Object.assign({}, ids, { dataRoot: host.dataRoot, appRoot: host.appRoot, profile: profileFor(ids), drawMcp: typeof host.drawMcp === "function" ? host.drawMcp(ids) : null, bridge });
        for (const entry of cutlineMcpServersForAcp(options)) writeCwdMcpConfig(ids.harnessId, session.cwd, entry);
        const client = new Client(Object.assign({}, options, { cwd: session.cwd, onUpdate: (params) => onUpdate(session, params), onRequest: (message) => onAgentRequest(session, message) }));
        session.client = client;
        // The agent is not an Orca pane: inherited ORCA_* credentials would
        // make its global hook shims (for example ~/.cursor/hooks.json) post to
        // a pane server and read hook stdin, which can stall tool calls. Strip
        // them so those hooks take their no-op path.
        // Both spellings of every variable: the app reads the renamed one first,
        // and the old one keeps a script or config written before the rename
        // working against this same session.
        const childEnv = Object.assign({
          JEDITOR_DATA_ROOT: host.dataRoot, CUTLINE_DATA_ROOT: host.dataRoot,
          JEDITOR_APP_ROOT: host.appRoot, CUTLINE_APP_ROOT: host.appRoot,
          JEDITOR_HARNESS: ids.harnessId, CUTLINE_HARNESS: ids.harnessId,
          JEDITOR_HARNESS_KEY: (host.bridgeInfo() || {}).harnessKey || "", CUTLINE_HARNESS_KEY: (host.bridgeInfo() || {}).harnessKey || "",
          JEDITOR_PROJECT_ID: ids.projectId, CUTLINE_PROJECT_ID: ids.projectId,
          JEDITOR_WORKSPACE_ID: ids.workspaceId, CUTLINE_WORKSPACE_ID: ids.workspaceId,
        }, spec.env);
        for (const name of Object.keys(childEnv)) if (/^ORCA_/i.test(name)) delete childEnv[name];
        client.start({
          command: spec.command, args: spec.args, cwd: session.cwd,
          env: childEnv,
        });
        if (client.child && client.child.stderr) {
          client.child.stderr.on("data", (chunk) => {
            stderr = (stderr + chunk.toString("utf8")).slice(-2000);
          });
        }
        if (client.child) {
          // An agent that shuts itself down between turns (exit code 0 with
          // nothing in flight) is a stopped session, not an error to shout
          // about: report it as stopped so the chat's reconnect path brings it
          // back. A process that dies mid-turn or dies dirty keeps its error.
          const exited = (detail, graceful) => {
            if (!current(session)) return;
            const midTurn = Boolean(session.busy || session.turnController);
            client.started = false;
            session.ready = false;
            session.busy = false;
            // Approval cards the dead agent was waiting on can never be
            // used; settle them so no Approve button grants anything later.
            for (const pending of (session.permissions || new Map()).values()) {
              clearTimeout(pending.timer);
              if (pending.row) {
                pending.row.status = "cancelled";
                markDirty(session, rowIndex(session, pending.row));
              }
              try {
                pending.resolve({ outcome: { outcome: "cancelled" } });
              } catch {
                /* already settled */
              }
            }
            if (session.permissions) session.permissions.clear();
            if (graceful && !midTurn) {
              session.error = "";
              session.stopped = true;
            } else {
              session.error = clean(session, detail + (stderr ? ": " + stderr.trim().split("\n").pop() : ""));
            }
            emitState(session);
          };
          client.child.on("exit", (code, signal) => exited("Agent exited" + (signal ? ": " + signal : " with code " + code), !signal && code === 0));
          client.child.on("error", (error) => exited(error.message || "Agent failed to start.", false));
        }
        const init = await client.initialize();
        assertActive(session);
        session.agentName = (init && init.agentInfo && (init.agentInfo.title || init.agentInfo.name)) || harness.name;
        session.canLoad = Boolean(init && init.agentCapabilities && init.agentCapabilities.loadSession);
        const mcps = cutlineMcpServersForAcp(Object.assign({}, options, { bridge, agentCapabilities: init && init.agentCapabilities }));
        const mcp = mcps[0];
        session.pendingNew = { cwd: session.cwd, mcpServers: mcps };
        session.pendingMcps = mcps;
        session.pendingMcp = mcp;
        session.authMethods = (init && init.authMethods) || [];
        let created;
        try {
          created = await openSession(session);
        } catch (error) {
          if (authFailure(error) && session.authMethods.length && client.started) {
            session.starting = false;
            session.authRequired = true;
            session.error = clean(session, error.message);
            push(session, { role: "system", text: session.agentName + " needs sign in before it can open a session." });
            emitState(session);
            return snapshot(session);
          }
          throw error;
        }
        assertActive(session);
        const sessionId = (session.resumed && session.wantSessionId) || (created && (created.sessionId || created.session_id));
        if (typeof sessionId !== "string" || !sessionId.trim()) throw new Error("Invalid ACP session/new response: missing sessionId.");
        session.sessionId = sessionId;
        applyHistoryPrefix(session);
        return finishReady(session, mcp);
      } catch (error) {
        const message = clean(session, (error.message || String(error)) + (stderr ? " " + stderr.trim().split("\n").pop() : ""));
        if (current(session)) {
          session.error = message;
          session.starting = false;
          session.ready = false;
          session.busy = false;
          session.stopped = true;
          session.controller.abort();
          if (session.client) session.client.stop();
          emitState(session);
        }
        throw new Error(message);
      }
    });
    return session.startPromise;
  }

  async function authenticate(payload) {
    const ids = scope(payload || {});
    const session = sessions.get(key(ids));
    if (!session || !session.authRequired || !session.client || !session.client.started || session.stopped || !session.pendingNew) {
      throw new Error("This agent is not waiting for sign in. Start it first.");
    }
    if (session.authenticating) throw new Error("Sign in is already in progress.");
    const methods = session.authMethods || [];
    const pick = payload && payload.methodId
      ? payload.methodId
      : methods.find((m) => /browser/i.test(String((m && (m.id || m.name)) || m))) || methods[0];
    const methodId = typeof pick === "object" && pick ? String(pick.id || "") : String(pick || "");
    if (!methodId) throw new Error((session.agentName || "This agent") + " does not advertise a sign-in method.");
    session.authenticating = true;
    session.starting = true;
    session.error = "";
    emitState(session);
    try {
      await session.client.request("authenticate", { methodId }, 600000);
      assertActive(session);
      const created = await openSession(session);
      assertActive(session);
      const sessionId = (session.resumed && session.wantSessionId) || (created && (created.sessionId || created.session_id));
      if (typeof sessionId !== "string" || !sessionId.trim()) throw new Error("Invalid ACP session/new response: missing sessionId.");
      session.sessionId = sessionId;
      applyHistoryPrefix(session);
      push(session, { role: "system", text: "Signed in to " + session.agentName + "." });
      return finishReady(session, session.pendingMcp);
    } catch (error) {
      session.starting = false;
      session.error = clean(session, error.message);
      if (!session.client.started) {
        session.stopped = true;
        session.authRequired = false;
      }
      emitState(session);
      throw new Error(session.error);
    } finally {
      session.authenticating = false;
    }
  }

  // Built on every send from the files on disk, so a skill saved a moment ago
  // is named in this turn. Bodies stay behind jeditor_get_skill.
  function skillsPrompt() {
    try {
      const vault = ensureUserSkillsDir(host.dataRoot);
      const skills = discoverSkills(host.appRoot, { dataRoot: host.dataRoot });
      const lines = skills
        .map((skill) => {
          const desc = String(skill.description || "").replace(/\s+/g, " ").trim().slice(0, 180);
          return "- " + skill.name + (desc ? ": " + desc : "");
        })
        .join("\n");
      return (
        "JV skills (live). Read the one that matches this job with jeditor_get_skill. " +
        "Save a skill as a folder under " +
        vault +
        " containing SKILL.md. The same folder name overrides the shipped skill, and the next message includes it.\n" +
        lines
      );
    } catch {
      return "";
    }
  }

  // Slash commands for the composer menu: JV workflows (skills that name a
  // command) and whatever the agent advertised, live or from its last session.
  function slashCommands(payload) {
    const ids = scope(payload || {});
    const session = sessions.get(key(ids));
    const harnessId = String((payload && payload.harnessId) || (session && session.harnessId) || "");
    const live = session && Array.isArray(session.agentCommands) ? session.agentCommands : null;
    return {
      workflows: listCommands(host.appRoot, { dataRoot: host.dataRoot }),
      agent: (live && live.length ? live : agentCommandCache.get(harnessId) || []).slice(),
    };
  }

  // Turns "/improve ..." into the workflow instruction. text is the full
  // dispatch, which starts with the typed line; agent commands go out bare
  // so the agent sees its own command at the start of the prompt.
  function applySlash(session, text, displayText) {
    let workflows = [];
    try {
      workflows = listCommands(host.appRoot, { dataRoot: host.dataRoot });
    } catch {
      workflows = [];
    }
    const agentList = (session.agentCommands && session.agentCommands.length ? session.agentCommands : agentCommandCache.get(session.harnessId)) || [];
    const exp = expandSlash(displayText, workflows, agentList);
    if (exp.command) {
      const rest = text.startsWith(displayText) ? text.slice(displayText.length) : "\n\n" + text;
      return { text: exp.text + rest, raw: false, command: exp.command.name, title: titleFor(displayText, workflows) };
    }
    if (exp.agentCommand) return { text: displayText, raw: true, command: exp.agentCommand };
    return { text, raw: false, command: "" };
  }

  function profileFor(ids) {
    return isCardAssistantScope(ids) ? "cards" : "";
  }

  async function contextText(session, text) {
    const instructions = userInstructionsPrompt(await readUserInstructions(host.dataRoot));
    let rules = "";
    try {
      rules = userRulesPrompt(listUserRules(host.dataRoot));
    } catch {
      /* an unreadable rules store must not block a prompt */
    }
    if (isCardAssistantScope(session)) {
      return instructions + "\n\n" + (rules ? rules + "\n\n" : "") + CARD_ASSISTANT_PREAMBLE + "\nWorkspace id: " + session.workspaceId + "\n\n" + text;
    }
    const hint = skillsPrompt();
    let body = text;
    if (session.projectId || session.workspaceId) {
      body =
        "JV active project context: " +
        JSON.stringify({ projectId: session.projectId, workspaceId: session.workspaceId }) +
        ". Use the JV MCP for this editing task. Include these exact IDs in project/workspace tool arguments where supported. Read this project's current state before editing; do not use a different or last-open project. The cwd is an isolated agent workspace, not the editing project.\n\n" +
        text;
    }
    return instructions + "\n\n" + (rules ? rules + "\n\n" : "") + CARD_TOOLS_HINT + "\n\n" + (hint ? hint + "\n\n" + body : body);
  }

  // The after-turn slop gate (lib/slop/after-turn.js): checks what the agent
  // designed or rendered in the turn that just ended and, when it reads as
  // slop, sends the findings back to the same session as a fix turn. The chat
  // gets one plain system line per round and the agent's fix reply, never a
  // made-up message from the person. Nothing in here may fail their turn.
  async function slopGateAfterTurn(session, turn) {
    const stopped = () => turn.cancelVersion !== session.cancelVersion || !current(session);
    const log = (message) => {
      try {
        require("../lib/slop/after-turn").logLine(host.dataRoot, { error: String(message) });
      } catch {
        console.error(message);
      }
    };
    try {
      const rows = session.transcript.slice(Math.max(0, turn.userRowIndex));
      const report = await require("../lib/slop/after-turn").runAfterTurn({
        dataRoot: host.dataRoot,
        appRoot: host.appRoot,
        since: turn.since,
        harnessId: session.harnessId,
        projectId: session.projectId || "",
        workspaceId: session.workspaceId || "",
        toolTitles: rows.filter((row) => row && row.role === "tool").map((row) => row.title),
        asked: session.transcript.filter((row) => row && row.role === "user").map((row) => row.text).join("\n"),
        signal: session.turnController ? session.turnController.signal : undefined,
        stopped,
        log,
        say(text, extra) {
          push(session, Object.assign({ role: "system", text }, extra || {}));
          emitTranscript(session);
        },
        async send(text) {
          session.internalError = "";
          session.internalErrorAt = -1;
          session.internalErrorLen = 0;
          let result = null;
          try {
            const options = { signal: session.turnController ? session.turnController.signal : undefined };
            result =
              typeof session.client.promptWithRecovery === "function"
                ? await session.client.promptWithRecovery(text, session.sessionId, options)
                : await session.client.prompt(text, session.sessionId);
          } catch (error) {
            if (stopped()) return { stopped: true };
            settleOrphanTools(session);
            return { failed: true, why: clean(session, (error && error.message) || String(error)) };
          }
          if (stopped() || (result && result.stopReason === "cancelled")) return { stopped: true };
          settleOrphanTools(session);
          if (session.internalError && !recoveredFromInternalError(session)) return { failed: true, why: "internal error" };
          if (result && result.idleStopped) return { failed: true, why: "the agent went quiet" };
          return { ok: true };
        },
      });
      if (report.failed && report.sent && current(session)) {
        push(session, { role: "system", text: (session.agentName || "The agent") + " stopped mid-turn while fixing what the check found. Send a message to continue." });
      }
      session.slopGate = report;
      return report;
    } catch (error) {
      log("slop gate: " + String((error && error.stack) || error));
      return { ran: false, failed: true };
    }
  }

  // The same gate Draw runs after its own turns, for drawings a project chat
  // turn touched: artist finish, the pixel checker, then the read-only
  // reviewer. Its issues go back into this same session until clean or the
  // rounds run out. Same slopGate pref and JEDITOR_GATE_ROUNDS as the video
  // gate (JDRAW_GATE_ROUNDS overrides for the drawing gate).
  async function drawGateAfterTurn(session, turn) {
    if (typeof host.drawTurnChanged !== "function" || typeof host.drawCheckDrawing !== "function") return null;
    const projectId = session.projectId || "";
    if (!projectId) return null;
    const stopped = () => turn.cancelVersion !== session.cancelVersion || !current(session);
    const log = (message) => {
      try {
        require("../lib/slop/after-turn").logLine(host.dataRoot, { error: "draw gate: " + String(message) });
      } catch {
        console.error(message);
      }
    };
    const say = (text, extra) => {
      push(session, Object.assign({ role: "system", text }, extra || {}));
      emitTranscript(session);
    };
    const send = async (text) => {
      session.internalError = "";
      session.internalErrorAt = -1;
      session.internalErrorLen = 0;
      let result = null;
      try {
        const options = { signal: session.turnController ? session.turnController.signal : undefined };
        result =
          typeof session.client.promptWithRecovery === "function"
            ? await session.client.promptWithRecovery(text, session.sessionId, options)
            : await session.client.prompt(text, session.sessionId);
      } catch (error) {
        if (stopped()) return { stopped: true };
        settleOrphanTools(session);
        return { failed: true, why: clean(session, (error && error.message) || String(error)) };
      }
      if (stopped() || (result && result.stopReason === "cancelled")) return { stopped: true };
      settleOrphanTools(session);
      if (session.internalError && !recoveredFromInternalError(session)) return { failed: true, why: "internal error" };
      if (result && result.idleStopped) return { failed: true, why: "the agent went quiet" };
      return { ok: true };
    };
    try {
      let on = true;
      try {
        on = JSON.parse(require("fs").readFileSync(require("path").join(host.dataRoot, "jeditor-prefs.json"), "utf8")).slopGate !== false;
      } catch {}
      if (!on || process.env.JEDITOR_SLOP_GATE === "0") return null;
      const rounds = Number(process.env.JDRAW_GATE_ROUNDS || process.env.JEDITOR_GATE_ROUNDS || 2) || 0;
      if (!rounds) return null;
      const changed = await host.drawTurnChanged(projectId);
      const docIds = Array.isArray(changed) ? changed.slice(0, 3) : [];
      if (!docIds.length) return null;
      const promptText = session.transcript.filter((row) => row && row.role === "user").map((row) => row.text).slice(-3).join("\n");
      const previous = new Map();
      let round = 0;
      for (;;) {
        if (stopped()) return { stopped: true };
        const issues = [];
        for (const docId of docIds) {
          const check = await host.drawCheckDrawing(docId, { prompt: promptText, harnessId: session.harnessId, previous: previous.get(docId) || null });
          if (!check || check.ok === null) { if (check && check.error) log(docId + " check: " + check.error); continue; }
          if (Array.isArray(check.issues)) previous.set(docId, check.issues);
          for (const i of check.issues || []) issues.push({ docId, name: check.name || "Drawing", what: i.what, where: i.where, fix: i.fix });
        }
        if (!issues.length) {
          if (round > 0) say("Drawing check: clean.");
          return { ok: true, rounds: round };
        }
        if (round >= rounds) {
          say("Drawing check still flags " + issues.length + " problem" + (issues.length === 1 ? "" : "s") + ": " + issues.slice(0, 3).map((i) => i.what).join("; "), { kind: "slop-gate" });
          return { ok: false, rounds: round };
        }
        say("Drawing check found " + issues.length + " problem" + (issues.length === 1 ? "" : "s") + ", asking the agent to fix.", { kind: "slop-gate" });
        const ask = "The drawing check flagged this project drawing. Fix each problem with the jdraw tools (redraw the item, do not hide or delete it), on the drawing id given:\n" + issues.map((i, n) => `${n + 1}. ${i.what}${i.where ? ` (${i.where})` : ""}${i.fix ? ` Fix: ${i.fix}` : ""} [drawing ${i.docId} "${i.name}"]`).join("\n");
        const reply = await send(ask);
        round++;
        if (reply.stopped) return { stopped: true };
        if (reply.failed) {
          say((session.agentName || "The agent") + " stopped while fixing what the drawing check found. Send a message to continue.", { kind: "slop-gate" });
          return { ok: false, failed: true, rounds: round };
        }
      }
    } catch (error) {
      log("draw gate: " + String((error && error.stack) || error));
      return { ran: false, failed: true };
    }
  }

  async function prompt(payload) {
    const body = payload || {};
    const session = sessions.get(key(body));
    if (!session || !session.ready || !session.client || !session.client.started || session.stopped) throw new Error("Start the agent and wait for its session to be ready first.");
    if (session.busy) throw new Error("The agent is still working.");
    const text = String(body.text || "").trim();
    if (!text) throw new Error("Type a message first.");
    // displayText is what the user typed; text may carry a context prefix the
    // agent needs. The transcript records the typed line so titles and
    // history read like the chat, not the wrapper.
    const displayText = String(body.displayText || "").trim() || text;
    session.busy = true;
    session.lastActiveAt = Date.now();
    session.error = "";
    const cancelVersion = session.cancelVersion;
    session.turnController = new AbortController();
    const turnStartedAt = new Date().toISOString();
    // A restored chat whose agent could not reload its session gets the
    // earlier conversation prepended once so the reply sees real history.
    // The prefix is only consumed once the prompt actually dispatches: a
    // failed preflight or a cancelled send restores it so the next turn
    // still carries the history.
    const slash = applySlash(session, text, displayText);
    const prefix = slash.raw ? "" : session.historyPrefix;
    const promptText = prefix ? prefix + "\n\n" + slash.text : slash.text;
    let holdingAwake = false;
    try {
      // An agent command goes out exactly as typed: any wrapper in front of
      // it would stop the agent from reading it as a command.
      const promptArgs = slash.raw ? slash.text : await contextText(session, promptText);
      assertActive(session);
      if (cancelVersion !== session.cancelVersion) throw new Error("ACP turn cancelled.");
      // The user row lands before any dispatch wait: a slow MCP preflight or a
      // failed send still leaves the typed message in the transcript instead
      // of letting it vanish from the thread and the persisted chat.
      // `sent` is the full dispatch (app context, pinned media, history). The
      // bubble keeps displayText only; the payload sits behind the message's
      // Advanced disclosure so the thread stays readable.
      push(session, Object.assign({ role: "user", text: displayText, sent: promptArgs }, Number.isFinite(body.at) ? { at: body.at } : {}));
      const userRowIndex = session.transcript.length - 1;
      // The slop gate never turns down a look the person asked for, in this
      // message or an earlier one, so it gets every line they typed here.
      try {
        require("../lib/slop/gate").setAsked(session, session.transcript.filter((row) => row && row.role === "user").map((row) => row.text));
      } catch {
        /* the gate then runs without knowing what was asked */
      }
      bindChat(session, slash.title || displayText);
      emitState(session);
      // A turn can run for minutes with the user away. Hold off system
      // suspension for its duration so the machine sleeping cannot cut the
      // agent's connection; the host releases it when the turn settles.
      if (typeof host.powerHold === "function") {
        host.powerHold();
        holdingAwake = true;
      }
      await checkMcp(session, session.turnController.signal);
      assertActiveSent(session);
      if (body.modelId !== undefined && body.modelId !== null && String(body.modelId)) await session.client.setModel(String(body.modelId), session.sessionId);
      if (body.effort !== undefined && body.effort !== null && String(body.effort) && typeof session.client.setEffort === "function" && session.client.effort) {
        // Effort is best effort: an agent without the option, or one that
        // turns the value down, must not stop the send.
        await session.client.setEffort(String(body.effort), session.sessionId).catch(() => {});
      }
      assertActiveSent(session);
      if (cancelVersion !== session.cancelVersion) throw new Error("ACP turn cancelled.");
      // A stream can die inside the agent while the turn still reports
      // end_turn; the reply then ends on a leaked internal error instead of a
      // real answer. Resend in place first, then once on a fresh session: a
      // saved session poisoned this way replays the same failure on every
      // prompt, so the chat forgets it and the transcript seeds a new one.
      let turnArgs = promptArgs;
      let internalAttempts = 0;
      let sessionReset = false;
      for (;;) {
        session.internalError = "";
        session.internalErrorAt = -1;
        session.internalErrorLen = 0;
        session.turnHadCompletedTool = false;
        // promptWithRecovery keeps a slow turn alive past the first timeout:
        // the agent may answer late, and a hard reject here would leave it
        // working while the chat looks idle and a retry would stack a second
        // prompt into the live turn.
        let result = null;
        let thrown = null;
        try {
          result =
            typeof session.client.promptWithRecovery === "function"
              ? await session.client.promptWithRecovery(turnArgs, session.sessionId, { signal: session.turnController.signal })
              : await session.client.prompt(turnArgs, session.sessionId);
        } catch (error) {
          if (!isInternalError(error)) throw error;
          thrown = error;
        }
        assertActiveReplied(session);
        const leaked = session.internalError && !recoveredFromInternalError(session);
        const internalText = (thrown && String(thrown.message || "")) || (leaked ? session.internalError : "");
        // A cancelled stopReason is only the user's stop when they actually
        // asked for it: a dead agent stream reports "cancelled" after leaking
        // its internal error, and treating that as a clean stop would skip the
        // retry and drop the failure row.
        const userStopped = cancelVersion !== session.cancelVersion;
        if (userStopped || !internalText) {
          if (!internalText && !slash.raw) session.historyPrefix = "";
          settleOrphanTools(session);
          const idleMin = result && result.idleStopped ? Math.max(1, Math.round((result.idleMs || 0) / 60000)) : 0;
          // A turn that ended by itself gets the slop check before it counts as
          // finished. The gate never throws; the person's Stop ends it too.
          const gated = !userStopped && !internalText && !idleMin && !slash.raw && !(result && result.stopReason === "cancelled");
          const gate = gated ? await slopGateAfterTurn(session, { since: turnStartedAt, cancelVersion, userRowIndex }) : null;
          if (gated && !(gate && gate.stopped)) await drawGateAfterTurn(session, { since: turnStartedAt, cancelVersion });
          const gateStopped = Boolean(gate && gate.stopped);
          const ended = idleMin
            ? "Turn stopped: " + (session.agentName || "the agent") + " sent nothing for " + idleMin + " min. Send a message to continue."
            : gateStopped || (result && result.stopReason === "cancelled")
              ? "Turn stopped."
              : "Turn finished.";
          push(session, { role: "system", text: ended });
          return Object.assign({}, scope(session), { stopReason: gateStopped ? "cancelled" : result && result.stopReason });
        }
        // The turn ended on an internal agent error, not a real answer.
        settleOrphanTools(session);
        const detail = internalErrorDetail(internalText) || "stream closed";
        if (session.turnHadCompletedTool) {
          // Tool calls already landed; replaying the message could run them
          // twice, so the turn fails openly instead of resending blind. The
          // session it died on is poisoned, though: leaving the chat pointed at
          // it made every manual retry resume it and die the same way, which is
          // how one bad turn turned into a thread full of the same failure.
          // Replace it here so the retry the message asks for actually works.
          let replaced = false;
          try {
            // Abort the prompt the dead stream belonged to before opening the
            // replacement. An agent whose old request is still live cancels it
            // when the next session opens, and that cancel is what poisons the
            // fresh session in turn - the same WritableIterable failure the
            // leak below is recovering from.
            try {
              session.client.cancel(session.sessionId);
            } catch {
              /* the stream is already gone */
            }
            const nextId = await replaceSession(session);
            if (nextId) {
              // The fresh session has none of the earlier context, so the next
              // send carries the chat history again (this send's own ask
              // excluded, so the retry does not read as a second one).
              session.historyPrefix = historyPrefixFor(session.transcript.slice(0, userRowIndex));
              replaced = true;
            }
          } catch {
            /* the fresh session never opened; the failure below still stands */
          }
          // A replaced session heals the chat by itself: the retry the user
          // would be asked for is already safe, and the tool calls that ran are
          // on screen. So this is not something to act on, and raising an error
          // card here only painted a red "RetriableError: WritableIterable is
          // closed" wall with a Retry that re-ran the same tool calls. Settle
          // the turn with a plain row and let the next message continue.
          if (replaced) {
            push(session, {
              role: "system",
              text: session.agentName + " stopped mid-turn after running tools. A fresh session is ready; send a message to continue.",
            });
            settleOrphanTools(session);
            return Object.assign({}, scope(session), { stopReason: "end_turn" });
          }
          throw new Error(
            session.agentName +
              " ended the turn on an internal error (" + detail + ") after tool calls had already run. " +
              "Check the result before sending the message again.",
          );
        }
        if (internalAttempts < 2) {
          internalAttempts += 1;
          push(session, { role: "system", text: session.agentName + " ended the turn on an internal error (" + detail + ") without answering; retrying." });
          emitTranscript(session);
          continue;
        }
        if (!sessionReset) {
          sessionReset = true;
          try {
            const nextId = await replaceSession(session);
            if (nextId) {
              internalAttempts = 0;
              // The fresh session has none of the earlier context; the resent
              // message carries the chat history again, minus this send's row.
              const history = historyPrefixFor(session.transcript.slice(0, userRowIndex));
              // The expanded workflow (slash.text), not the typed "/improve",
              // so the retry still carries the skill's instructions.
              turnArgs = slash.raw ? slash.text : await contextText(session, (history ? history + "\n\n" : "") + slash.text);
              push(session, { role: "system", text: "Started a fresh " + session.agentName + " session after repeated internal errors; retrying." });
              emitTranscript(session);
              continue;
            }
          } catch {
            /* the fresh session never opened; fail the turn below */
          }
        }
        const message = session.agentName + " keeps ending turns on an internal error (" + detail + "). Restart the agent and send the message again.";
        // dispose() clears current(), so the catch below would not record the
        // failure; push the row and the error state first.
        push(session, { role: "system", text: "Turn failed: " + message });
        session.error = clean(session, message);
        emitState(session);
        dispose(session);
        throw new Error(message);
      }
    } catch (error) {
      const message = clean(session, error.message || String(error));
      // The one-shot history prefix never reached the agent; put it back so
      // the next send still carries the restored context.
      if (prefix) session.historyPrefix = prefix + (session.historyPrefix ? "\n\n" + session.historyPrefix : "");
      if (current(session) && cancelVersion !== session.cancelVersion) {
        push(session, { role: "system", text: "Turn stopped." });
        // A turn that ignored the user's stop request still has a live
        // prompt the host cannot see; tear it down so the next send starts
        // fresh instead of hitting a wedged agent.
        if (/did not stop when asked/.test(message)) dispose(session);
        return Object.assign({}, scope(session), { stopReason: "cancelled" });
      }
      if (current(session)) {
        session.error = message;
        // The failure belongs in the chat history: the user row persisted
        // before dispatch, so the transcript should also say why no reply
        // followed it.
        push(session, { role: "system", text: "Turn failed: " + message });
        // A turn that ignored both the grace wait and the stop request has a
        // live session/prompt the host can no longer see. Tear the client
        // down; the next send starts fresh and resumes the saved session.
        if (/did not stop when asked/.test(message)) dispose(session);
      }
      throw new Error(message);
    } finally {
      if (holdingAwake && typeof host.powerRelease === "function") host.powerRelease();
      session.busy = false;
      session.lastActiveAt = Date.now();
      session.turnController = null;
      settleOrphanTools(session);
      // Report the settled turn even when it tore the session down. Skipping
      // that emit left the renderer believing a killed session was still
      // ready, so every later message was refused and the agent looked broken
      // until the app was restarted. A replaced or removed session is still
      // skipped: its own stop already reported it.
      if (sessions.get(key(session)) === session) emitState(session);
    }
  }

  function dispose(session) {
    if (session._persistTimer && session.transcript && session.transcript.length) persistNow(session);
    session.stopped = true;
    session.starting = false;
    session.ready = false;
    session.busy = false;
    if (session.mcp.status === "checking") session.mcp.status = "unchecked";
    // Pending approval cards can never be answered once the session is gone;
    // resolve them cancelled so the agent's request does not hang forever.
    for (const pending of (session.permissions || new Map()).values()) {
      clearTimeout(pending.timer);
      if (pending.row) {
        pending.row.status = "cancelled";
        markDirty(session, rowIndex(session, pending.row));
      }
      try {
        pending.resolve({ outcome: { outcome: "cancelled" } });
      } catch {
        /* already settled */
      }
    }
    if (session.permissions) session.permissions.clear();
    if (Array.isArray(session.transcript)) settleOrphanTools(session);
    session.controller.abort();
    if (session.turnController) session.turnController.abort();
    if (session.client) session.client.stop(session.sessionId);
  }

  function cancel(payload) {
    const session = sessions.get(key(payload));
    if (session) {
      session.cancelVersion++;
      if (session.starting) {
        dispose(session);
        session.error = "";
        emitState(session);
      } else if (session.ready && session.client) {
        if (session.turnController) session.turnController.abort();
        session.client.cancel(session.sessionId);
      }
    }
    return Object.assign({}, scope(payload), { ok: true });
  }

  function stop(payload) {
    const ids = scope(payload);
    const session = sessions.get(key(ids));
    // dropTranscript means the caller just cleared the chat: echoing the
    // old rows back would repopulate and re-persist the wiped thread.
    const drop = Boolean(payload && typeof payload === "object" && payload.dropTranscript);
    // Copy after dispose: pending permission rows flip to cancelled in there,
    // and an earlier copy would echo them still pending.
    if (session && drop && session._persistTimer) {
      clearTimeout(session._persistTimer);
      session._persistTimer = 0;
    }
    if (session) dispose(session);
    const rows = !drop && session && Array.isArray(session.transcript) ? session.transcript.map((row) => Object.assign({}, row)) : [];
    sessions.delete(key(ids));
    // The empty snapshot would otherwise blank the visible thread; the chat
    // keeps its transcript and the next start reseeds from it.
    emit(ids, "state", Object.assign(snapshot(ids), { transcript: rows }));
    return snapshot(ids);
  }

  // Removing a marketplace agent must not leave its sessions running: the
  // agent disappears from the picker and there is no UI left to stop it.
  function stopHarness(payload) {
    const id = String((payload && payload.harnessId) || "");
    if (!id) return;
    for (const session of Array.from(sessions.values())) {
      if (session.harnessId !== id) continue;
      dispose(session);
      const rows = Array.isArray(session.transcript) ? session.transcript.map((row) => Object.assign({}, row)) : [];
      sessions.delete(key(session));
      emit(session, "state", Object.assign(snapshot(session), { transcript: rows }));
    }
  }

  // Hands a chat from its current agent to another (context handoff). Every
  // live session on the chat stops: the outgoing agent's so it cannot keep
  // writing, and any older session of the incoming agent because it never saw
  // the turns since. The chat row is rebound with a handoff row, and the
  // incoming agent's next start opens fresh and carries the prior chat in its
  // first prompt (applyHistoryPrefix).
  function handoff(payload) {
    const body = payload || {};
    const ids = scope(body);
    if (!ids.chatId) throw new Error("Open a chat before switching agents.");
    if (!acpHarness(ids.harnessId, { dataRoot: host.dataRoot })) throw new Error("Unknown agent: " + ids.harnessId);
    const record = getChat(host.dataRoot, ids.chatId, { transcript: "tail" });
    if (!record || !record.chat) throw new Error("Chat not found.");
    const from = String(record.chat.harnessId || "");
    const onChat = Array.from(sessions.values()).filter((session) =>
      session.chatId === ids.chatId && session.workspaceId === ids.workspaceId && session.projectId === ids.projectId);
    if (onChat.some((session) => session.busy)) throw new Error("Wait for the current turn to finish before switching agents.");
    const outgoing = onChat.find((session) => session.harnessId === from);
    const liveTranscript = outgoing && Array.isArray(outgoing.transcript) ? outgoing.transcript.map((row) => Object.assign({}, row)) : null;
    for (const session of onChat) {
      dispose(session);
      sessions.delete(key(session));
      // An empty transcript is a deliberate clear in the renderer, so the
      // stopped session cannot persist its rows back over the handed-off chat.
      emit(session, "state", Object.assign(snapshot(session), { transcript: [] }));
    }
    return switchChatHarness(host.dataRoot, ids.chatId, {
      harnessId: ids.harnessId,
      fromName: String(body.fromName || ""),
      toName: String(body.toName || ""),
      liveTranscript,
    });
  }

  // Stops ready sessions that nobody has used for IDLE_REAP_MS. Never touches
  // a busy, starting or approval-waiting session. The session entry stays (as
  // stopped) so its transcript survives and the next start() resumes it.
  function reapIdle(now, limitMs) {
    const limit = limitMs === undefined ? IDLE_REAP_MS : limitMs;
    if (!limit) return 0;
    const at = Number.isFinite(now) ? now : Date.now();
    let reaped = 0;
    for (const session of Array.from(sessions.values())) {
      if (!session.ready || session.busy || session.starting || session.stopped || !session.client) continue;
      if (session.permissions && session.permissions.size) continue;
      if (at - (session.lastActiveAt || 0) < limit) continue;
      try {
        dispose(session);
        emitState(session);
        reaped++;
      } catch {
        /* already gone */
      }
    }
    return reaped;
  }

  if (IDLE_REAP_MS) {
    reapTimer = setInterval(() => reapIdle(), Math.max(1000, Math.min(60_000, Math.floor(IDLE_REAP_MS / 2))));
    if (reapTimer.unref) reapTimer.unref();
  }

  function stopAll() {
    if (reapTimer) {
      clearInterval(reapTimer);
      reapTimer = null;
    }
    if (modelRefreshTimer) {
      clearInterval(modelRefreshTimer);
      modelRefreshTimer = null;
    }
    if (modelRefreshFirst) {
      clearTimeout(modelRefreshFirst);
      modelRefreshFirst = null;
    }
    for (const session of sessions.values()) {
      try {
        dispose(session);
      } catch {
        /* gone */
      }
    }
    sessions.clear();
  }

  // The models an agent offers, read from the agent itself: a short-lived
  // child runs initialize and session/new in a scratch folder (no JV
  // tools attached), reports the list, and exits. Pickers call this before
  // any chat has connected, so choosing a model never needs a first message.
  const probes = new Map();
  function models(payload) {
    const body = typeof payload === "string" ? { harnessId: payload } : payload || {};
    const harnessId = String(body.harnessId || "");
    if (!acpHarness(harnessId, { dataRoot: host.dataRoot })) return Promise.reject(new Error("Unknown agent: " + harnessId));
    if (!body.refresh) {
      let cached = null;
      try {
        cached = getAcpModelCache(host.dataRoot)[harnessId] || null;
      } catch {
        cached = null;
      }
      if (cached && Array.isArray(cached.availableModels) && cached.availableModels.length) {
        return Promise.resolve(Object.assign({ source: "cache", stale: modelsStale(cached) }, cached));
      }
    }
    if (probes.has(harnessId)) return probes.get(harnessId);
    const run = (async () => {
      const spec = spawnSpec(harnessId, { appRoot: host.appRoot, dataRoot: host.dataRoot });
      const cwd = path.join(host.dataRoot, "acp-probe", harnessId.replace(/[^a-z0-9._-]+/gi, "_"));
      fs.mkdirSync(cwd, { recursive: true });
      const env = Object.assign({ JEDITOR_DATA_ROOT: host.dataRoot, CUTLINE_DATA_ROOT: host.dataRoot, JEDITOR_APP_ROOT: host.appRoot, CUTLINE_APP_ROOT: host.appRoot, JEDITOR_HARNESS: harnessId, CUTLINE_HARNESS: harnessId, JEDITOR_HARNESS_KEY: (host.bridgeInfo() || {}).harnessKey || "", CUTLINE_HARNESS_KEY: (host.bridgeInfo() || {}).harnessKey || "" }, spec.env);
      for (const name of Object.keys(env)) if (/^ORCA_/i.test(name)) delete env[name];
      const client = new Client({ harnessId, dataRoot: host.dataRoot, appRoot: host.appRoot, cwd });
      let stderr = "";
      try {
        client.start({ command: spec.command, args: spec.args, cwd, env });
        if (client.child && client.child.stderr) client.child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-2000); });
        const init = await client.initialize();
        // Same warm-up allowance as a real start: OpenCode's plugins can
        // answer ServiceUnavailable for 30 s or more.
        const end = Date.now() + 90000;
        for (let delay = 1000; ; delay = Math.min(delay * 1.5, 4000)) {
          try {
            await client.newSession({ cwd, mcpServers: [] });
            break;
          } catch (error) {
            if (!isWarmingUp(error) || Date.now() + delay > end) throw error;
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }
        const caps = init && init.agentCapabilities && init.agentCapabilities.sessionCapabilities;
        if (caps && caps.close && client.sessionId) await client.request("session/close", { sessionId: client.sessionId }, 5000).catch(() => {});
        const result = { availableModels: client.models.availableModels, currentModelId: client.models.currentModelId || "", effort: client.effort || null };
        rememberModels(harnessId, result, client.effort);
        return Object.assign({ source: "agent" }, result);
      } catch (error) {
        const tail = stderr.trim().split(/\r?\n/).pop();
        throw new Error((error && error.message ? error.message : String(error)) + (tail ? " " + tail : ""));
      } finally {
        client.stop();
        probes.delete(harnessId);
      }
    })();
    probes.set(harnessId, run);
    return run;
  }

  function modelsStale(cached) {
    const at = Number(cached && cached.updatedAt) || 0;
    return !at || Date.now() - at >= (MODEL_REFRESH_MS || Infinity);
  }

  // Background check: every agent that is installed and has a saved list
  // older than MODEL_REFRESH_MS is read again, one at a time. New models go
  // out through rememberModels. Agents never used have no saved list and are
  // left alone, so this never starts an agent the user has not picked.
  let refreshingModels = false;
  async function refreshStaleModels() {
    if (refreshingModels) return [];
    refreshingModels = true;
    const checked = [];
    try {
      let cache = {};
      try {
        cache = getAcpModelCache(host.dataRoot) || {};
      } catch {
        return checked;
      }
      const installed = new Set(listAcpHarnesses({ appRoot: host.appRoot, dataRoot: host.dataRoot }).filter((h) => h.available).map((h) => h.id));
      for (const harnessId of Object.keys(cache)) {
        if (!installed.has(harnessId) || !modelsStale(cache[harnessId])) continue;
        try {
          const result = await models({ harnessId, refresh: true });
          checked.push({ harnessId, count: result.availableModels.length });
        } catch (error) {
          checked.push({ harnessId, error: String((error && error.message) || error) });
        }
      }
    } finally {
      refreshingModels = false;
    }
    return checked;
  }

  if (MODEL_REFRESH_MS) {
    // First pass a minute after launch, then on a timer. Each pass only reads
    // the lists that went stale, so a short timer costs nothing extra.
    modelRefreshFirst = setTimeout(() => {
      modelRefreshFirst = null;
      void refreshStaleModels();
    }, Math.min(60_000, MODEL_REFRESH_MS));
    if (modelRefreshFirst.unref) modelRefreshFirst.unref();
    modelRefreshTimer = setInterval(() => void refreshStaleModels(), Math.max(10_000, Math.min(MODEL_REFRESH_MS, 10 * 60_000)));
    if (modelRefreshTimer.unref) modelRefreshTimer.unref();
  }

  function list(payload) {
    const ids = scope(payload);
    return listAcpHarnesses({ appRoot: host.appRoot, dataRoot: host.dataRoot }).map((item) => Object.assign(item, { session: snapshot(Object.assign({}, ids, { harnessId: item.id })) }));
  }

  // Draw reports a drawing the agent made or changed mid-turn: it lands in
  // the chat transcript as an artifact card (renderer/js/chat.js).
  function recordDrawArtifact(info) {
    const o = info || {};
    for (const session of sessions.values()) {
      if (session.stopped) continue;
      if (o.chatId && session.chatId !== o.chatId) continue;
      if (!o.chatId && o.projectId && session.projectId !== o.projectId) continue;
      // One card per drawing per turn, no matter how many tools touched it.
      const lastUser = session.transcript.reduce((acc, row, i) => (row && row.role === "user" ? i : acc), -1);
      if (session.transcript.slice(Math.max(0, lastUser)).some((row) => row && row.role === "artifact" && row.drawingId === String(o.drawingId || ""))) continue;
      push(session, { role: "artifact", drawingId: String(o.drawingId || ""), drawingName: String(o.drawingName || "Drawing"), projectId: String(o.projectId || session.projectId || "") });
      emitTranscript(session);
    }
  }

  return { list, models, refreshStaleModels, slashCommands, start, authenticate, prompt, cancel, stop, stopHarness, handoff, stopAll, reapIdle, snapshot, answerPermission, recordDrawArtifact };
}

module.exports = { createAcpHost, mergePersistRows, legacyMessageRows };
