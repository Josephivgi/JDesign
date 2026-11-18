const fs = require("fs");
const path = require("path");
const { resolveDataRoot } = require("./agents-setup-state");
const { readAgentSettings, writeAgentSettings } = require("./agent-settings");

// Provider and agent failures are appended to a JSONL file the user can read
// and open from the app. Nothing here may throw: a logging bug must never take
// a chat turn down. The file is capped and rotated once so it cannot grow
// without bound on a long-lived install.
const MAX_BYTES = 512 * 1024;
const MAX_DETAIL = 4000;
const DEFAULT_LIMIT = 50;

function errorsPath(options) {
  return path.join(resolveDataRoot(options || {}), "logs", "errors.jsonl");
}

function clip(value, max) {
  const text = String(value == null ? "" : value).replace(/\s+$/g, "");
  return text.length > max ? text.slice(0, max) + " …" : text;
}

// "401: {...}" and "HTTP 401 Unauthorized" both carry the status the user
// needs, so pull it out once instead of re-parsing in each surface.
function errorCode(message) {
  const text = String(message == null ? "" : message);
  const http = text.match(/\bHTTP\s+(\d{3})\b/i) || text.match(/(?:^|\s)(\d{3})(?=\s*:)/) || text.match(/\bstatus(?:\s*code)?\s*[:=]?\s*(\d{3})\b/i);
  if (http) return http[1];
  if (/\bENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up\b/i.test(text)) return "network";
  return "";
}

function rotateIfNeeded(file) {
  try {
    if (!fs.existsSync(file)) return;
    if (fs.statSync(file).size <= MAX_BYTES) return;
    const previous = file + ".1";
    try {
      fs.unlinkSync(previous);
    } catch {
      /* nothing to replace */
    }
    fs.renameSync(file, previous);
  } catch {
    /* rotation is best effort */
  }
}

function recordError(input) {
  const entry = input && typeof input === "object" ? input : { message: String(input || "") };
  const at = new Date().toISOString();
  const message = clip(entry.message, 1000);
  const row = {
    at,
    source: String(entry.source || "agent"),
    harness: String(entry.harness || ""),
    model: String(entry.model || ""),
    code: String(entry.code || errorCode(message)),
    message,
  };
  const detail = clip(entry.detail, MAX_DETAIL);
  if (detail && detail !== message) row.detail = detail;
  const file = errorsPath(entry);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    rotateIfNeeded(file);
    fs.appendFileSync(file, JSON.stringify(row) + "\n", "utf8");
  } catch {
    /* logging must never take the app down */
  }
  return Object.assign({}, row, { path: file });
}

function readErrors(options) {
  const opts = options && typeof options === "object" ? options : {};
  const limit = Number.isFinite(Number(opts.limit)) && Number(opts.limit) > 0 ? Math.floor(Number(opts.limit)) : DEFAULT_LIMIT;
  const file = errorsPath(opts);
  const out = [];
  for (const name of [file + ".1", file]) {
    let text = "";
    try {
      text = fs.readFileSync(name, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const value = line.trim();
      if (!value) continue;
      try {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === "object" && parsed.message) out.push(parsed);
      } catch {
        /* skip a torn line */
      }
    }
  }
  return out.slice(-limit).reverse();
}

function clearErrors(options) {
  const file = errorsPath(options);
  let removed = 0;
  for (const name of [file, file + ".1"]) {
    try {
      fs.unlinkSync(name);
      removed += 1;
    } catch {
      /* already gone */
    }
  }
  return { ok: true, removed };
}

// Compact by default. The switch is stored with the agent settings so it
// survives a restart without a second preferences file.
function readErrorDisplay(options) {
  const settings = readAgentSettings(options);
  return { advanced: settings.showRawErrors === true };
}

function setErrorDisplay(input, options) {
  const body = input && typeof input === "object" ? input : {};
  const settings = readAgentSettings(options);
  if ("advanced" in body) {
    if (body.advanced) settings.showRawErrors = true;
    else delete settings.showRawErrors;
  }
  writeAgentSettings(settings, options);
  return { advanced: settings.showRawErrors === true };
}

module.exports = {
  errorsPath,
  errorCode,
  recordError,
  readErrors,
  clearErrors,
  readErrorDisplay,
  setErrorDisplay,
};
