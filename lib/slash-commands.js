"use strict";

// Slash commands. Typing /improve in a chat runs a JV workflow: a skill whose
// frontmatter names a `command`. The agent gets a short instruction to read
// that skill and follow it, plus whatever the user typed after the command.
// The chat shows what the user typed, not the wrapper.
//
// Agents advertise their own commands over ACP (available_commands_update).
// Those are not JV workflows; a line that starts with one is sent to the
// agent unchanged so the agent runs it itself.

const { discoverSkills } = require("./skills");

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

function commandName(value) {
  const name = String(value || "").trim().replace(/^\//, "").toLowerCase();
  return NAME_RE.test(name) ? name : "";
}

// Every skill with `command:` in its frontmatter. The first skill to claim a
// name wins, and discoverSkills already lists the vault before the app, so a
// skill the user saved can take over a shipped command.
function listCommands(appRoot, options) {
  const out = [];
  const seen = new Set();
  let skills = [];
  try {
    skills = discoverSkills(appRoot, options);
  } catch {
    return out;
  }
  for (const skill of skills) {
    const meta = skill.meta || {};
    const name = commandName(meta.command);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      skill: skill.name,
      label: String(meta.label || "").trim().slice(0, 60) || name,
      description: String(meta["command-description"] || skill.description || "").replace(/\s+/g, " ").trim().slice(0, 160),
      hint: String(meta.hint || "").trim().slice(0, 80),
      // One plain sentence for people (the description is written for agents).
      about: String(meta.about || "").trim().slice(0, 140),
      group: String(meta.group || "").trim().slice(0, 30) || "Workflows",
      // An icon name from renderer/js/ui.js; the menu falls back to a wand.
      icon: /^[a-zA-Z-]{2,20}$/.test(String(meta.icon || "").trim()) ? String(meta.icon).trim() : "",
      // "clip": only useful once the project has footage or a render.
      // "clip", "elevenlabs", or both separated by a comma.
      needs: String(meta.needs || "").trim().toLowerCase().slice(0, 40),
      // Commands that usually come after this one, offered when it finishes.
      next: String(meta.next || "").split(",").map(commandName).filter(Boolean).slice(0, 3),
      source: skill.source || "app",
    });
  }
  // Groups in the order a person usually works; unknown groups go last.
  const rank = (g) => {
    const i = GROUP_ORDER.indexOf(g);
    return i < 0 ? GROUP_ORDER.length : i;
  };
  out.sort((a, b) => rank(a.group) - rank(b.group) || a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
  return out;
}

const GROUP_ORDER = ["Create", "Animation", "Edit", "Improve", "Design", "Sound"];

// A short, readable name for a chat or project started with a command:
// what the user typed after it, or the command's label.
function titleFor(text, commands) {
  const parsed = parseSlash(text);
  if (!parsed) return "";
  const command = (commands || []).find((c) => c.name === parsed.name);
  if (!command) return "";
  return (parsed.args ? command.label + ": " + parsed.args : command.label).replace(/\s+/g, " ").trim().slice(0, 60);
}

// "/improve make it punchier" -> { name: "improve", args: "make it punchier" }.
// Only the first line can hold the command, and it has to be at the start.
function parseSlash(text) {
  const match = String(text || "").match(/^\/([A-Za-z0-9][A-Za-z0-9-]{0,39})(?:[ \t]+([\s\S]*))?$/);
  if (!match) {
    const multi = String(text || "").match(/^\/([A-Za-z0-9][A-Za-z0-9-]{0,39})\s*\n([\s\S]*)$/);
    if (!multi) return null;
    return { name: multi[1].toLowerCase(), args: multi[2].trim() };
  }
  return { name: match[1].toLowerCase(), args: String(match[2] || "").trim() };
}

function workflowPrompt(command, args) {
  return (
    "The user ran the JV command /" + command.name + " (" + command.label + "). " +
    "First read the JV skill `" + command.skill + "` with jeditor_get_skill and follow its workflow step by step, in order. " +
    "Do the work with the JV tools; do not stop at a plan unless the skill says to ask first. " +
    "When you finish, reply in plain words: what you changed, what you checked, and anything left for the user to decide.\n\n" +
    (args ? "What the user asked for with it: " + args : "The user added nothing after the command, so use the skill's defaults for this project.")
  );
}

// Returns { text, command } where text is what the agent should receive.
// agentCommands are names the agent advertised; those pass through untouched.
function expandSlash(text, commands, agentCommands) {
  const parsed = parseSlash(text);
  if (!parsed) return { text: String(text || ""), command: null };
  const agentNames = new Set((agentCommands || []).map((c) => commandName(c && (c.name || c))));
  const command = (commands || []).find((c) => c.name === parsed.name);
  // A JV workflow wins over an agent command of the same name: the user saw
  // it under JV workflows in the menu.
  if (command) return { text: workflowPrompt(command, parsed.args), command };
  if (agentNames.has(parsed.name)) return { text: String(text || ""), command: null, agentCommand: parsed.name };
  return { text: String(text || ""), command: null };
}

// ACP available_commands_update -> a small list the renderer can show.
function normalizeAgentCommands(list) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const name = commandName(item && item.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const input = item.input && typeof item.input === "object" ? item.input : null;
    out.push({
      name,
      description: String((item && item.description) || "").replace(/\s+/g, " ").trim().slice(0, 160),
      hint: input && typeof input.hint === "string" ? input.hint.trim().slice(0, 80) : "",
    });
    if (out.length >= 80) break;
  }
  return out;
}

module.exports = { listCommands, parseSlash, expandSlash, workflowPrompt, normalizeAgentCommands, commandName, titleFor };
