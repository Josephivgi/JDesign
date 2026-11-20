// Live ACP sessions as the main process reports them. One entry per
// workspace/project/chat/agent, keyed the same way the host keys them. The
// host owns the transcript and saves it to the chat row; this window keeps a
// copy for drawing and folds the streamed deltas onto it.

import { api, emit } from "./store.js";

const sessions = new Map();
const resyncing = new Set();

export function scopeKey(scope) {
  const s = scope || {};
  return JSON.stringify([String(s.workspaceId || ""), String(s.projectId || ""), String(s.chatId || ""), String(s.harnessId || "")]);
}

export function getSession(scope) {
  return sessions.get(scopeKey(scope)) || null;
}

function mergeDelta(base, delta) {
  const all = Array.isArray(base) ? base : [];
  const from = delta && Number.isFinite(delta.from) ? delta.from : NaN;
  const rows = delta && Array.isArray(delta.rows) ? delta.rows : null;
  const length = delta && Number.isFinite(delta.length) ? delta.length : NaN;
  if (!rows || !Number.isFinite(from) || from < 0 || !Number.isFinite(length)) return null;
  const shift = from > 0 && Number.isFinite(delta.shift) && delta.shift > 0 ? delta.shift : 0;
  if (shift + from > all.length) return null;
  const merged = all.slice(shift, shift + from).concat(rows);
  return merged.length === length ? merged : null;
}

export function setSession(scope, patch) {
  const key = scopeKey(scope);
  const prev = sessions.get(key) || { transcript: null };
  // Older than what is already here: a snapshot that raced a newer event.
  if (patch && Number.isFinite(patch.seq) && Number.isFinite(prev.seq) && patch.seq < prev.seq) return prev;
  const next = Object.assign({}, prev);
  for (const [k, v] of Object.entries(patch || {})) {
    if (k === "transcript" || k === "transcriptDelta") continue;
    next[k] = v;
  }
  if (Array.isArray(patch && patch.transcript)) {
    // An empty list after a stop keeps what is already drawn; the chat row
    // still holds the rows and the next start reseeds from it.
    if (patch.transcript.length || !prev.transcript) next.transcript = patch.transcript;
  }
  if (patch && patch.transcriptDelta) {
    const merged = mergeDelta(prev.transcript, patch.transcriptDelta);
    if (merged) next.transcript = merged;
    else void resync(scope);
  }
  sessions.set(key, next);
  if (next.models && Array.isArray(next.models.availableModels) && next.models.availableModels.length && api && api.acpModelsCacheSet) {
    void api.acpModelsCacheSet({ harnessId: scope.harnessId, models: next.models }).catch(() => {});
  }
  emit("session", { key, scope, session: next });
  return next;
}

export async function resync(scope) {
  const key = scopeKey(scope);
  if (resyncing.has(key) || !api) return;
  resyncing.add(key);
  try {
    // A snapshot that lost the race to a newer event is dropped; ask again
    // so a transcript that needed repair still gets it.
    for (let tries = 0; tries < 3; tries++) {
      const snap = await api.acpSession(scope);
      if (!snap || typeof snap !== "object") break;
      const cur = sessions.get(key);
      if (cur && Number.isFinite(snap.seq) && Number.isFinite(cur.seq) && snap.seq < cur.seq) continue;
      setSession(scope, snap);
      break;
    }
  } catch {
    /* the next event resyncs */
  } finally {
    resyncing.delete(key);
  }
}

let wired = false;
export function wireSessions() {
  if (wired || !api || !api.onAcpEvent) return;
  wired = true;
  api.onAcpEvent((message) => {
    if (!message || !message.payload) return;
    const scope = {
      workspaceId: message.workspaceId,
      projectId: message.projectId,
      chatId: message.chatId,
      harnessId: message.harnessId,
    };
    setSession(scope, message.payload);
  });
}

// The model catalog each agent reported last time, so pickers can show
// choices before a slow agent finishes connecting.
let modelCache = null;
export async function modelCacheFor(harnessId) {
  if (!modelCache && api && api.acpModelsCache) {
    try {
      modelCache = (await api.acpModelsCache()) || {};
    } catch {
      modelCache = {};
    }
  }
  return (modelCache && modelCache[harnessId]) || null;
}

// ---------- transcript to display items ----------

const INTERNAL_TAIL = /(^|\n)[ \t]*Error:[ \t][^\n]*(RetriableError|NonRetriableError|WriteIterableClosedError|WritableIterable is closed)[^\n]*$/;

function cleanAgentText(text) {
  return String(text || "").replace(INTERNAL_TAIL, "").replace(/\s+$/, "");
}

// The host already redacted and shortened these; cap what the thread draws.
const DETAIL_MAX = 4000;
function detailText(value) {
  if (value == null || value === "") return "";
  let data = value;
  if (typeof data === "string" && /^s*[{[]/.test(data)) {
    try {
      data = JSON.parse(data);
    } catch {
      /* not JSON: show as written */
    }
  }
  // A call that only ran code reads better as the code itself.
  if (data && typeof data === "object" && !Array.isArray(data) && Object.keys(data).length === 1 && typeof data.code === "string") data = data.code;
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return text.length > DETAIL_MAX ? text.slice(0, DETAIL_MAX) + "\n..." : text;
}

function toolStatus(status) {
  const s = String(status || "");
  if (s === "completed") return "done";
  if (s === "failed" || s === "cancelled") return "failed";
  return "running";
}

// Folds transcript rows into what the thread draws: user turns, agent text,
// thinking, permission cards, plans, and tool calls grouped into one "steps"
// block per run of consecutive calls.
export function displayItems(rows, opts = {}) {
  const list = Array.isArray(rows) ? rows.slice() : [];
  const sorted = list.every((row, i) => i === 0 || !Number.isFinite(row && row.at) || !Number.isFinite(list[i - 1] && list[i - 1].at) || row.at >= list[i - 1].at);
  if (!sorted) list.sort((a, b) => (Number(a && a.at) || 0) - (Number(b && b.at) || 0));
  const busy = Boolean(opts.busy);
  const out = [];
  let steps = null;
  const flush = () => {
    if (steps) out.push(steps);
    steps = null;
  };
  list.forEach((row, index) => {
    if (!row || typeof row !== "object") return;
    const at = Number.isFinite(row.at) ? row.at : 0;
    if (row.role === "tool") {
      if (!steps) steps = { type: "steps", items: [], at, key: "s" + index };
      let status = toolStatus(row.status);
      if (status === "running" && !busy) status = "failed";
      steps.items.push({ title: String(row.title || "Tool call"), status, at, kind: row.kind || "", input: detailText(row.input), output: detailText(row.output) });
      return;
    }
    if (row.role === "thought") {
      const text = cleanAgentText(row.text);
      if (!text) return;
      flush();
      const next = list[index + 1];
      const live = busy && !next;
      out.push({ type: "thinking", text, live, ms: next && Number.isFinite(next.at) && at ? Math.max(0, next.at - at) : 0, key: "t" + index });
      return;
    }
    if (row.role === "plan") {
      flush();
      out.push({ type: "plan", entries: Array.isArray(row.entries) ? row.entries : [], key: "p" + index });
      return;
    }
    flush();
    // A drawing the agent made or changed shows as a card that opens its tab.
    if (row.role === "artifact") {
      out.push({ type: "artifact", drawingId: String(row.drawingId || ""), drawingName: String(row.drawingName || "Drawing"), projectId: String(row.projectId || ""), at, key: "r" + index });
      return;
    }
    if (row.role === "user") out.push({ type: "user", text: String(row.text || ""), sent: row.sent ? String(row.sent) : "", at, key: "u" + index });
    else if (row.role === "agent") {
      const text = cleanAgentText(row.text);
      if (!text) return;
      const prev = out[out.length - 1];
      // Agents stream one reply as several rows around tool calls; adjacent
      // text rows read as one message.
      // Rows keep the agent that wrote them, so a handed-off chat stays labeled.
      const harnessId = row.harnessId ? String(row.harnessId) : "";
      if (prev && prev.type === "agent" && (!harnessId || !prev.harnessId || prev.harnessId === harnessId)) prev.text += "\n\n" + text;
      else out.push({ type: "agent", text, at, key: "a" + index, harnessId });
    } else if (row.role === "permission") {
      out.push({
        type: "permission",
        requestId: String(row.requestId || ""),
        tool: String(row.tool || ""),
        text: String(row.text || ""),
        status: row.status || "pending",
        kind: row.kind || "elevenlabs",
        key: "perm" + index,
      });
    } else if (row.role === "system") {
      const text = String(row.text || "");
      if (row.kind === "handoff") out.push({ type: "sys", text: text || "Chat handed to another agent", key: "h" + index });
      // The after-turn check stopped the turn: a status row, not a divider.
      // row.sent is the fix prompt it gave the agent, kept behind a link.
      else if (row.kind === "slop-gate") out.push({ type: "sys", gate: true, text: text.replace(/^Turn stopped: /, ""), sent: row.sent ? String(row.sent) : "", key: "x" + index });
      else if (/^Turn failed: /.test(text)) out.push({ type: "error", text: text.replace(/^Turn failed: /, ""), key: "e" + index });
      else if (/^Turn stopped\.$/.test(text)) out.push({ type: "sys", text: "Stopped", key: "x" + index });
      else if (/^Turn stopped: /.test(text)) out.push({ type: "sys", text: text.replace(/^Turn stopped: /, ""), key: "x" + index });
      else if (/needs sign in|^Signed in to |stopped mid-turn|internal error|fresh .* session|still starting up/i.test(text)) out.push({ type: "sys", text, key: "n" + index });
      // "session ready" and "Turn finished." are bookkeeping, not conversation.
    }
  });
  flush();
  return out;
}
