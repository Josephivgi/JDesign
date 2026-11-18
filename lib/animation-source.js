"use strict";

// The code an animation clip was rendered from, kept beside the workspace
// (<workspace>/animation-src/<libraryId>.json) rather than in the library row,
// so the snapshot the window loads stays small. Agents read it back through
// jeditor_get_library_item to fix or change an animation without rebuilding it.

const fs = require("fs");
const path = require("path");
const { workspaceDir } = require("./workspace-store");

const FIELDS = ["html", "css", "js", "preset", "presetParams", "scenes", "transition", "transitionMs", "colors", "vars", "aspectRatio", "durationMs", "fps", "audioId", "audioIds", "audios", "audioVolume", "audioLoop"];

function sourcePath(dataRoot, workspaceId, libraryId) {
  const safe = String(libraryId || "").replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safe) return "";
  if (!/^[a-zA-Z0-9_-]+$/.test(String(workspaceId || ""))) return "";
  return path.join(workspaceDir(dataRoot, workspaceId), "animation-src", safe + ".json");
}

// input: what the render was called with (agent fields only).
function saveAnimationSource(dataRoot, workspaceId, libraryId, input, rendered) {
  const file = sourcePath(dataRoot, workspaceId, libraryId);
  if (!file) return;
  const out = { savedAt: new Date().toISOString() };
  for (const key of FIELDS) if (input && input[key] != null && input[key] !== "") out[key] = input[key];
  if (rendered) {
    if (rendered.durationMs) out.durationMs = rendered.durationMs;
    if (rendered.fps) out.fps = rendered.fps;
    if (rendered.aspectRatio) out.aspectRatio = rendered.aspectRatio;
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(out), "utf8");
  } catch {
    /* the clip stays usable without its source */
  }
}

// The saved source, or null when there is none with code in it.
function readAnimationSource(dataRoot, workspaceId, libraryId) {
  const file = sourcePath(dataRoot, workspaceId, libraryId);
  if (!file) return null;
  try {
    const src = JSON.parse(fs.readFileSync(file, "utf8"));
    return src && (src.html || src.css || src.js || src.preset || (Array.isArray(src.scenes) && src.scenes.length)) ? src : null;
  } catch {
    return null;
  }
}

function deleteAnimationSource(dataRoot, workspaceId, libraryId) {
  const file = sourcePath(dataRoot, workspaceId, libraryId);
  if (file) fs.rm(file, { force: true }, () => {});
}

module.exports = { saveAnimationSource, readAnimationSource, deleteAnimationSource };
