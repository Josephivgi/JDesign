"use strict";

// Some ACP agents leak an internal transport failure into assistant text
// instead of failing the turn. cursor-agent's stream writes go through an
// internal WritableIterable queue; when it closes mid-turn the agent appends
// "Error: RetriableError: WritableIterable is closed" to the reply and still
// reports stopReason end_turn. The host watches for that signature so the
// turn is retried or failed honestly instead of showing internal noise as the
// answer and never reaching the JV tools again.
const INTERNAL_KIND = /\b(?:RetriableError|NonRetriableError|WriteIterableClosedError|WritableIterable is closed)\b/;

// The leak is always a trailing "Error: ..." line at the end of the message.
// Only the tail is inspected: an agent quoting an error mid-message keeps its
// own words.
const TAIL_ERROR_LINE = /(^|\n)[ \t]*Error:[ \t][^\n]*$/;

// Returns { text, error }: the message with a leaked internal error tail
// removed, and the matched error line when one was found.
function stripInternalErrorTail(text) {
  const body = String(text || "");
  const tail = body.match(TAIL_ERROR_LINE);
  if (!tail || !INTERNAL_KIND.test(tail[0])) return { text: body, error: "" };
  return { text: body.slice(0, body.length - tail[0].length).replace(/\s+$/, ""), error: tail[0].trim() };
}

// True when a thrown error carries the same internal signature, so a rejected
// session/prompt is handled like the leaked-text case.
function isInternalError(error) {
  return INTERNAL_KIND.test(String((error && error.message) || error || ""));
}

// Human-readable detail for system rows: "RetriableError: WritableIterable is
// closed" rather than the doubled "Error: Error: ..." the raw line carries.
function internalErrorDetail(text) {
  return String(text || "").replace(/^\s*Error:\s*/i, "").trim();
}

module.exports = { INTERNAL_KIND, stripInternalErrorTail, isInternalError, internalErrorDetail };
