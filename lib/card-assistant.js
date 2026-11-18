"use strict";

// The card studio assistant is an ACP chat with its own session scope and its
// own MCP server (jeditor-cards). The chat id is a fixed marker, not a stored
// chat row, so it never mixes with the Edit videos or AI Video chats.

const CARD_ASSISTANT_CHAT_ID = "card-assistant";
const CARD_MCP_NAME = "jeditor-cards";
const CARD_MCP_PATH = "/mcp/cards";
const { CONTENT_RESEARCH_MCP_NAME, CONTENT_RESEARCH_MCP_PATH } = require("./content-research-tools");

function isCardAssistantScope(ids) {
  return Boolean(ids) && String(ids.chatId || "") === CARD_ASSISTANT_CHAT_ID;
}

// The bridge serves the base MCP, card editor MCP, and content research MCP.
function bridgeUrlForProfile(url, profile) {
  const profilePath = profile === "cards"
    ? CARD_MCP_PATH
    : profile === "content-research"
      ? CONTENT_RESEARCH_MCP_PATH
      : "";
  if (!profilePath) return url;
  const parsed = new URL(url);
  parsed.pathname = profilePath;
  return parsed.toString();
}

const CARD_ASSISTANT_PREAMBLE =
  "You are the JV card assistant, working inside the user's card studio. Use only the jeditor-cards MCP tools (cards_*) to read and change cards: they act on the user's real workspace, and the studio redraws when you change a card. " +
  "Do not use shell, file, or web tools for card work, and do not edit files in your working folder. The message carries the card the user has open; read it with cards_get before changing it, make focused changes, then check the result with cards_render. " +
  "Deleting a card asks the user to confirm in the app; only delete what they asked you to delete. Say briefly what you changed.";

// Sent with every AI Video and Edit videos turn: those agents carry the same
// card editor next to the app tools.
const CARD_TOOLS_HINT =
  "Edit cards: your session also has the jeditor-cards MCP server (cards_* tools), the same full card editor the card studio assistant uses. Use it for any card work: create, read, text, style, block layout, HTML and CSS code, images, end screens, templates, duplicate, rename, reorder, delete, restore, undo, redo, and cards_render to check the result. Prefer cards_* over the older jeditor_* card tools. " +
  "Deleting a card asks the user to confirm in the app; only delete what they asked you to delete. cards_open switches the app to the card studio, so call it only when the user asks to see a card there.";

module.exports = {
  CARD_ASSISTANT_CHAT_ID,
  CARD_MCP_NAME,
  CARD_MCP_PATH,
  CONTENT_RESEARCH_MCP_NAME,
  CONTENT_RESEARCH_MCP_PATH,
  CARD_ASSISTANT_PREAMBLE,
  CARD_TOOLS_HINT,
  isCardAssistantScope,
  bridgeUrlForProfile,
};
