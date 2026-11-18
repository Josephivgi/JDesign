"use strict";

/**
 * Shared chat-store surface for JV Desktop and editorpi.
 * New durable records live in SQLite (recorder.db under the JV data root).
 * The recorder agent and its tools are gone; this file keeps the pieces the
 * chat store still needs.
 */

const TARGET_TYPES = ["local", "virtualbox", "hyperv", "wsl", "browser"];

function dbPath(dataRoot) {
  return require("path").join(String(dataRoot || ""), "recorder.db");
}

function formatTargetId(type, name) {
  const kind = String(type || "").trim().toLowerCase();
  const id = String(name || "").trim();
  if (!kind) return "";
  if (kind === "local") return "local:this-computer";
  if (!id) return "";
  return kind + ":" + id;
}

function parseTargetId(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (raw === "local" || raw === "local:this-computer") {
    return { type: "local", name: "this-computer", id: "local:this-computer" };
  }
  const slash = raw.indexOf(":");
  if (slash <= 0) return null;
  const type = raw.slice(0, slash).toLowerCase();
  const name = raw.slice(slash + 1).trim();
  if (!TARGET_TYPES.includes(type) || !name) return null;
  return { type, name, id: formatTargetId(type, name) };
}

module.exports = {
  TARGET_TYPES,
  dbPath,
  formatTargetId,
  parseTargetId,
};
