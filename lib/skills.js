const fs = require("fs");
const path = require("path");
const { isOfficialPiPath } = require("./editorpi-paths");

function parseFrontmatter(text) {
  const match = String(text || "").match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: String(text || "") };
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    meta[key] = value;
  }
  return { meta, body: match[2] };
}

function skillsRoot(appRoot) {
  return path.join(appRoot, "skills");
}

// User-owned vault, next to the rest of the JV data. App updates do not
// touch it. Coding agents write <name>/SKILL.md here; the same name overrides
// the copy shipped inside the app.
function userSkillsDir(dataRoot) {
  if (!dataRoot) throw new Error("dataRoot is required");
  return path.join(dataRoot, "skills");
}

function ensureUserSkillsDir(dataRoot) {
  const dir = userSkillsDir(dataRoot);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* the path is still the vault; a later write can create it */
  }
  return dir;
}

function skillsRoots(appRoot, options) {
  const opts = options || {};
  const roots = [];
  const seen = new Set();
  function add(dir, source) {
    if (!dir) return;
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    if (fs.existsSync(resolved)) roots.push({ dir: resolved, source });
  }
  // Vault first so an edited file wins over the shipped skill of the same name.
  if (opts.dataRoot) add(userSkillsDir(opts.dataRoot), "vault");
  // Renamed variable first, old spelling second, for existing setups.
  const envSkills = process.env.JEDITOR_SKILLS_DIR || process.env.CUTLINE_SKILLS_DIR;
  if (envSkills && !isOfficialPiPath(envSkills)) {
    add(envSkills, "env");
  }
  // Shipped skills before the old editorpi checkout next to the app: that
  // folder is left over from Cutline and only fills in names JV lacks. It used
  // to come first, so its older ai-video-edit replaced the one JV ships.
  add(skillsRoot(appRoot), "app");
  const sibling = path.join(path.dirname(appRoot || ""), "editorpi", "skills");
  add(sibling, "editorpi");
  return roots;
}

function statStamp(file) {
  try {
    const st = fs.statSync(file);
    return st.mtimeMs + ":" + st.size;
  } catch {
    return "";
  }
}

// Every prompt and every jeditor_list_skills call used to walk each root and
// read every SKILL.md. A root's result is reused while every directory it
// walked and every SKILL.md it read still has the same mtime (a stat each,
// no reads). Adding, removing, or renaming anything bumps the parent
// directory; an in-place edit bumps the file. Stamps from the last second
// are not trusted, so a write in the same clock tick as the walk is re-read.
const rootCache = new Map();
const FRESH_MS = 1000;

function rootCacheValid(hit) {
  const cutoff = hit.builtAt - FRESH_MS;
  for (const [file, stamp] of hit.stamps) {
    if (!stamp || statStamp(file) !== stamp || Number(stamp.split(":")[0]) > cutoff) return false;
  }
  return true;
}

function walkRoot(root) {
  const builtAt = Date.now();
  const stamps = new Map();
  const skills = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    stamps.set(dir, statStamp(dir));
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.isFile() && entry.name === "SKILL.md") {
        stamps.set(full, statStamp(full));
        const raw = fs.readFileSync(full, "utf8");
        const { meta, body } = parseFrontmatter(raw);
        skills.push({
          name: meta.name || path.basename(dir),
          description: meta.description || "",
          path: full,
          dir,
          body,
          meta,
        });
      }
    }
  }
  return { builtAt, stamps, skills };
}

function discoverSkillsFromRoot(root, source, found, seen) {
  let hit = rootCache.get(root);
  if (!hit || !rootCacheValid(hit)) {
    hit = walkRoot(root);
    rootCache.set(root, hit);
  }
  for (const skill of hit.skills) {
    if (seen.has(skill.name)) continue;
    seen.add(skill.name);
    found.push(Object.assign({}, skill, { meta: Object.assign({}, skill.meta), source }));
  }
}

function clearSkillsCache() {
  rootCache.clear();
}

function discoverSkills(appRoot, options) {
  const found = [];
  const seen = new Set();
  for (const root of skillsRoots(appRoot, options)) {
    discoverSkillsFromRoot(root.dir, root.source, found, seen);
  }
  found.sort((a, b) => a.name.localeCompare(b.name));
  return found;
}

function discoverBundledSkills(appRoot) {
  const found = [];
  discoverSkillsFromRoot(skillsRoot(appRoot), "app", found, new Set());
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

function findSkill(appRoot, name, options) {
  return discoverSkills(appRoot, options).find((skill) => skill.name === name) || null;
}

module.exports = {
  skillsRoot,
  userSkillsDir,
  ensureUserSkillsDir,
  discoverSkills,
  discoverBundledSkills,
  findSkill,
  parseFrontmatter,
  clearSkillsCache,
};
