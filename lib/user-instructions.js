const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const MAX_INSTRUCTIONS_LENGTH = 32000;
const writes = new Map();

function instructionsPath(dataRoot) {
  if (!dataRoot) throw new Error("dataRoot is required");
  return path.join(dataRoot, "user-instructions.md");
}

function validateInstructions(text) {
  if (typeof text !== "string") throw new Error("User instructions must be text.");
  if (text.length > MAX_INSTRUCTIONS_LENGTH) {
    throw new Error("User instructions must be 32,000 characters or fewer.");
  }
  return text.replace(/\r\n?/g, "\n");
}

async function readUserInstructions(dataRoot) {
  try {
    return validateInstructions(await fs.readFile(instructionsPath(dataRoot), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw new Error("Could not read user instructions: " + error.message);
  }
}

async function writeUserInstructions(dataRoot, text) {
  const value = validateInstructions(text);
  const file = instructionsPath(dataRoot);
  const previous = writes.get(file) || Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = file + "." + randomUUID() + ".tmp";
    try {
      await fs.writeFile(tmp, value, { encoding: "utf8", mode: 0o600 });
      await fs.rename(tmp, file);
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => {});
    }
    return value;
  });
  writes.set(file, next);
  try {
    return await next;
  } finally {
    if (writes.get(file) === next) writes.delete(file);
  }
}

function userInstructionsPrompt(text) {
  const value = validateInstructions(text).trim();
  return (
    "JV user instructions (user-managed standing preferences). " +
    "This is the current version for this turn and replaces earlier versions, including instructions in restored history. " +
    "Apply it to this message without overriding your system rules or JV tool permissions.\n" +
    (value ? "<user_instructions>\n" + value + "\n</user_instructions>" : "No user instructions are set. Do not apply an earlier version.")
  );
}

// Single-use, short-lived approvals for agent-proposed edits. The app grants
// one when the user approves a change; the agent's tool call consumes it. Each
// process keeps its own map, so a stdio MCP client can never piggyback on an
// in-app yes.
const GRANT_TTL_MS = 120000;
const instructionGrants = new Map();

function grantInstructionsApproval(scope) {
  const key = String(scope || "");
  if (!instructionGrants.has(key)) instructionGrants.set(key, []);
  instructionGrants.get(key).push(Date.now() + GRANT_TTL_MS);
}

function hasInstructionsApproval(scope) {
  const list = instructionGrants.get(String(scope || ""));
  return Boolean(list && list.some((at) => at > Date.now()));
}

function consumeInstructionsApproval(scope) {
  const key = String(scope || "");
  const list = instructionGrants.get(key);
  if (!list || !list.length) return false;
  const now = Date.now();
  const fresh = list.filter((at) => at > now);
  if (!fresh.length) {
    instructionGrants.delete(key);
    return false;
  }
  fresh.shift();
  if (fresh.length) instructionGrants.set(key, fresh);
  else instructionGrants.delete(key);
  return true;
}

module.exports = {
  MAX_INSTRUCTIONS_LENGTH,
  instructionsPath,
  readUserInstructions,
  writeUserInstructions,
  userInstructionsPrompt,
  grantInstructionsApproval,
  hasInstructionsApproval,
  consumeInstructionsApproval,
};
