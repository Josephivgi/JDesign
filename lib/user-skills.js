const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { userSkillsDir, skillsRoot, discoverBundledSkills, parseFrontmatter, clearSkillsCache } = require("./skills");

const MAX_SKILL_LENGTH = 256000;
const operations = new Map();

async function serial(dataRoot, action) {
  const key = path.resolve(userSkillsDir(dataRoot));
  const previous = operations.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(action);
  operations.set(key, next);
  try { return await next; }
  finally { forgetUserSkills(dataRoot); if (operations.get(key) === next) operations.delete(key); }
}

function validateName(name) {
  if (typeof name !== "string" || name.length > 80 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) ||
      /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(name)) {
    throw new Error("Use a skill name of up to 80 lowercase letters, numbers, and single hyphens.");
  }
  return name;
}

function validateText(text) {
  if (typeof text !== "string" || text.length > MAX_SKILL_LENGTH) {
    throw new Error("Skill instructions must be text, up to 256,000 characters.");
  }
  return text.replace(/\r\n?/g, "\n");
}

async function checkedPath(root, parts) {
  let target = root;
  for (const part of [null, ...parts]) {
    if (part !== null) target = path.join(target, part);
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) throw new Error("Linked skill files and folders cannot be managed here.");
  }
  return target;
}

async function vault(dataRoot, create = false) {
  const root = path.resolve(userSkillsDir(dataRoot));
  if (create) await fs.mkdir(root, { recursive: true });
  await checkedPath(root, []);
  return root;
}

async function skillPath(dataRoot, id) {
  if (typeof id !== "string" || id.includes("\\") || id.includes(":")) throw new Error("Invalid user skill.");
  const parts = id.split("/");
  if (parts.at(-1) !== "SKILL.md" || parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("Invalid user skill.");
  }
  return checkedPath(await vault(dataRoot), parts);
}

async function readText(file) {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > MAX_SKILL_LENGTH * 4) throw new Error("Skill file is too large or is not a file.");
  return validateText(await fs.readFile(file, "utf8"));
}

function entry(root, file, text) {
  const { meta, body } = parseFrontmatter(text);
  return { id: path.relative(root, file).split(path.sep).join("/"), name: meta.name || path.basename(path.dirname(file)),
    description: meta.description || "", body, text, source: "vault" };
}

// The vault listing is reused while every folder walked and every SKILL.md
// read keeps its mtime and size (one lstat each, no reads). Stamps from the
// last second are not trusted, so a same-tick edit is always re-read.
const listCache = new Map();
const FRESH_MS = 1000;

async function stampOf(file) {
  const st = await fs.lstat(file);
  return st.isSymbolicLink() ? "" : st.mtimeMs + ":" + st.size;
}

async function listCacheValid(hit) {
  const cutoff = hit.builtAt - FRESH_MS;
  for (const [file, stamp] of hit.stamps) {
    if (Number(stamp.split(":")[0]) > cutoff) return false;
    if ((await stampOf(file).catch(() => "")) !== stamp) return false;
  }
  return true;
}

function forgetUserSkills(dataRoot) {
  listCache.delete(path.resolve(userSkillsDir(dataRoot)));
  clearSkillsCache();
}

async function listUserSkills(dataRoot) {
  const key = path.resolve(userSkillsDir(dataRoot));
  const hit = listCache.get(key);
  if (hit && await listCacheValid(hit)) return hit.found.map((item) => Object.assign({}, item));
  listCache.delete(key);
  let root;
  try { root = await vault(dataRoot); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const builtAt = Date.now();
  const stamps = new Map();
  const found = [];
  async function visit(dir) {
    stamps.set(dir, await stampOf(dir));
    for (const item of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isSymbolicLink()) continue;
      if (item.isDirectory()) await visit(file);
      else if (item.isFile() && item.name === "SKILL.md") {
        const safe = await checkedPath(root, path.relative(root, file).split(path.sep));
        stamps.set(safe, await stampOf(safe));
        found.push(entry(root, safe, await readText(safe)));
      }
    }
  }
  await visit(root);
  found.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  if (![...stamps.values()].includes("")) listCache.set(key, { builtAt, stamps, found });
  return found.map((item) => Object.assign({}, item));
}

async function saveUserSkill(dataRoot, { id, text, expectedText } = {}) {
  const value = validateText(text);
  return serial(dataRoot, async () => {
    const file = await skillPath(dataRoot, id);
    if (typeof expectedText !== "string" || await readText(file) !== expectedText) {
      throw new Error("This skill changed outside the editor. Reload it before saving; your draft has been kept.");
    }
    const tmp = path.join(path.dirname(file), ".skill-" + randomUUID() + ".tmp");
    try {
      await fs.writeFile(tmp, value, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await skillPath(dataRoot, id);
      await fs.rename(tmp, file);
    } finally { await fs.rm(tmp, { force: true }).catch(() => {}); }
    return entry(await vault(dataRoot), file, value);
  });
}

async function copySkillFiles(source, target) {
  for (const item of await fs.readdir(source, { withFileTypes: true })) {
    if (item.isSymbolicLink()) throw new Error("Cannot clone a skill containing linked files.");
    const from = path.join(source, item.name), to = path.join(target, item.name);
    if (item.isDirectory()) { await fs.mkdir(to); await copySkillFiles(from, to); }
    else if (item.isFile()) await fs.copyFile(from, to);
  }
}

async function createUserSkill(dataRoot, appRoot, { name, bundledName } = {}) {
  validateName(name);
  return serial(dataRoot, async () => {
    const root = await vault(dataRoot, true);
    const target = path.join(root, name);
    // The folder is reserved before copying; existing skills are never replaced.
    try { await fs.mkdir(target); }
    catch (error) { if (error.code === "EEXIST") throw new Error("A user skill with that folder name already exists."); throw error; }
    try {
      let text = "---\nname: " + name + "\ndescription: Describe when the agent should use this skill.\n---\n\n# " + name + "\n\nWrite the instructions for this skill here.\n";
      if (bundledName !== undefined) {
        const bundled = discoverBundledSkills(appRoot).find((skill) => skill.name === bundledName);
        if (!bundled) throw new Error("Bundled skill not found.");
        const source = await checkedPath(path.resolve(skillsRoot(appRoot)), path.relative(skillsRoot(appRoot), bundled.dir).split(path.sep));
        await copySkillFiles(source, target);
        text = await readText(path.join(target, "SKILL.md"));
        const frontmatter = text.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
        if (frontmatter) {
          const end = 4 + frontmatter[1].length;
          const front = text.slice(4, end).replace(/^name:.*$/gm, "name: " + name);
          text = "---\n" + (/^name:/m.test(front) ? front : "name: " + name + "\n" + front) + text.slice(end);
        } else text = "---\nname: " + name + "\n---\n" + text;
      }
      await fs.writeFile(path.join(target, "SKILL.md"), text, { encoding: "utf8", mode: 0o600 });
      return entry(root, path.join(target, "SKILL.md"), text);
    } catch (error) {
      await fs.rm(target, { recursive: true, force: true });
      throw error;
    }
  });
}

// Older builds copied bundled skills into the user vault, where they showed
// up as user skills and shadowed the shipped versions. Drop only the vault
// entries whose SKILL.md is byte-identical to the bundled copy; anything a
// user or agent actually edited stays as a real user skill.
async function pruneBundledDuplicates(dataRoot, appRoot) {
  const bundled = new Map(discoverBundledSkills(appRoot).map((skill) => [skill.name, skill]));
  if (!bundled.size) return 0;
  const root = path.resolve(userSkillsDir(dataRoot));
  let removed = 0;
  for (const skill of await listUserSkills(dataRoot)) {
    const match = bundled.get(skill.name);
    if (!match) continue;
    let shipped;
    try { shipped = await readText(match.path); } catch { continue; }
    if (shipped !== skill.text) continue;
    const file = await skillPath(dataRoot, skill.id);
    await fs.unlink(file);
    const dir = path.dirname(file);
    if (dir !== root) await fs.rmdir(dir).catch(() => {});
    removed += 1;
  }
  if (removed) forgetUserSkills(dataRoot);
  return removed;
}

async function removeUserSkill(dataRoot, { id, expectedText } = {}) {
  return serial(dataRoot, async () => {
    const file = await skillPath(dataRoot, id);
    if (typeof expectedText !== "string" || await readText(file) !== expectedText) {
      throw new Error("This skill changed outside the editor. Reload before removing it.");
    }
    // Keep supporting files and nested skills; only remove this skill's instructions.
    await fs.unlink(file);
    const dir = path.dirname(file);
    if (dir !== path.resolve(userSkillsDir(dataRoot))) {
      await fs.rmdir(dir).catch(() => {});
    }
  });
}

module.exports = { MAX_SKILL_LENGTH, listUserSkills, saveUserSkill, createUserSkill, removeUserSkill, pruneBundledDuplicates };
