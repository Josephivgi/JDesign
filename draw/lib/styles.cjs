// Style skills: skills/styles/<id>/SKILL.md plus example.png. Each one tells an
// agent how to get a general look (watercolor, pixel art, ...) with JDraw's
// own tools. They came from Image Studio's styles; the examples were drawn in
// JDraw. Read from disk on every call so an edited file is picked up at once.
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "skills", "styles");
// Not a style, so list_styles skips it; get_style anti-slop reads it.
const CRAFT = path.join(__dirname, "..", "skills", "anti-slop");
// Also not a style: rules for text on the canvas and chat replies.
const WRITING = path.join(__dirname, "..", "skills", "writing-slop");
// Also not a style: how to remove the AI look from a finished drawing.
const DESLOP = path.join(__dirname, "..", "skills", "deslop");
// Also not a style: the long list of tells, sorted by subject.
const CATALOG = path.join(__dirname, "..", "skills", "slop-catalog");

function parse(text) {
  const m = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: String(text) };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: m[2].trim() };
}

function listStyles() {
  let dirs = [];
  try { dirs = fs.readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; }
  const out = [];
  for (const id of dirs.sort()) {
    try {
      const { meta } = parse(fs.readFileSync(path.join(ROOT, id, "SKILL.md"), "utf8"));
      out.push({ id: meta.name || id, name: meta.title || id, group: meta.group || "", description: meta.description || "" });
    } catch {}
  }
  return out;
}

// Every skill for the Settings list: the styles first, then the craft skills
// (not styles). Read-only; { id, title, group, kind, description }.
function listSkills() {
  const out = listStyles().map((s) => ({ id: s.id, title: s.name, group: s.group, kind: "style", description: s.description }));
  for (const dir of [CRAFT, CATALOG, WRITING, DESLOP]) {
    try {
      const { meta } = parse(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8"));
      const id = meta.name || path.basename(dir);
      out.push({ id, title: meta.title || id, group: meta.group || "Craft", kind: "craft", description: meta.description || "" });
    } catch {}
  }
  return out;
}

function findDir(ref) {
  const want = String(ref || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!want) return null;
  if (want === "antislop") return CRAFT;
  if (want === "writingslop") return WRITING;
  if (want === "deslop") return DESLOP;
  if (want === "slopcatalog") return CATALOG;
  for (const s of listStyles()) {
    if (s.id.toLowerCase() === want || s.name.toLowerCase().replace(/[^a-z0-9]/g, "") === want) return path.join(ROOT, s.id);
  }
  return null;
}

// { id, name, body, example (Buffer or null) } or null.
function getStyle(ref) {
  const dir = findDir(ref);
  if (!dir) return null;
  const { meta, body } = parse(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8"));
  let example = null;
  try { example = fs.readFileSync(path.join(dir, "example.png")); } catch {}
  return { id: meta.name || path.basename(dir), name: meta.title || path.basename(dir), body, example };
}

module.exports = { listStyles, listSkills, getStyle, STYLES_DIR: ROOT };
