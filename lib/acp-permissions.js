function optionIdOf(option) {
  return String(option && (option.optionId || option.id || option.value) || "").trim();
}

function optionKind(option) {
  return String((option && option.kind) || "").toLowerCase();
}

function optionSignal(option) {
  return (
    optionIdOf(option) +
    " " +
    optionKind(option) +
    " " +
    String((option && (option.name || option.label || option.title)) || "")
  ).toLowerCase();
}

function listPermissionOptions(params) {
  const p = params || {};
  const buckets = [
    p.options,
    p.permissionOptions,
    p.toolCall && p.toolCall.options,
    p.toolCall && p.toolCall.permissionOptions,
    p.tool_call && p.tool_call.options,
  ];
  let raw = [];
  for (const bucket of buckets) {
    if (Array.isArray(bucket) && bucket.length) {
      raw = bucket;
      break;
    }
  }
  const expanded = [];
  for (const option of raw) {
    if (option && Array.isArray(option.options) && option.options.length) {
      expanded.push.apply(expanded, option.options);
    } else {
      expanded.push(option);
    }
  }
  return expanded
    .map((option) => ({
      optionId: optionIdOf(option),
      kind: optionKind(option),
      name: (option && (option.name || option.label || option.title)) || "",
      raw: option,
    }))
    .filter((option) => option.optionId);
}

function isReject(option) {
  return /reject|deny|cancel/.test(optionSignal(option));
}

function isCutlineMcpTool(params) {
  const p = params || {};
  const tool = p.toolCall || p.tool_call || {};
  const blob = [
    tool.name,
    tool.toolName,
    tool.title,
    p.serverName,
    p.mcpServer,
    p.server,
    JSON.stringify(tool),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return blob.includes("cutline") || blob.includes("mcp");
}

function pickAllowOnceId(params) {
  const options = listPermissionOptions(params);
  const once =
    options.find((option) => option.kind === "allow_once") ||
    options.find((option) => /allow_once|allow once/.test(optionSignal(option))) ||
    options.find((option) => !isReject(option));
  return (once && once.optionId) || "allow_once";
}

// ElevenLabs calls spend real characters on the account's plan, so they are
// gated by the user's agent-access mode instead of the blanket auto-allow.
// Speech and music both count; the tool name is matched, not a bare "music",
// so an unrelated sound op carrying a track:'music' argument is not caught.
function isElevenLabsTool(params) {
  const p = params || {};
  const tool = p.toolCall || p.tool_call || {};
  const blob = [tool.name, tool.toolName, tool.title, tool.kind, JSON.stringify(tool.rawInput || {}), p.title]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (/elevenlabs|jeditor_tts|jeditor_music|text.?to.?speech|voiceover|\btts\b/.test(blob)) return true;
  // Replacing a clip's audio from a script makes a voiceover too; with an
  // existing audioId it spends nothing and needs no card.
  const input = tool.rawInput || tool.input || {};
  return /jeditor_replace_audio/.test(blob) && Boolean(String(input.script || "").trim());
}

// Changing the standing instructions rewrites what every future prompt
// carries, so it always asks the user: there is no always or never mode.
// Matched on name fields only; a rule's text mentioning instructions must not
// pull an unrelated tool call into the permission flow.
function isUserInstructionsTool(params) {
  const p = params || {};
  const tool = p.toolCall || p.tool_call || {};
  const blob = [tool.name, tool.toolName, tool.title, p.title]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return /jeditor_update_user_instructions|(?:update|replace|propose|change|edit)[_ -]{0,4}user[_ -]instructions/.test(blob);
}

function pickRejectId(params) {
  const options = listPermissionOptions(params);
  const reject = options.find((option) => isReject(option));
  return reject ? reject.optionId : "";
}

function pickAllowAlwaysId(params) {
  const options = listPermissionOptions(params);
  const always =
    options.find((option) => option.kind === "allow_always") ||
    options.find((option) => /allow_always|always allow|allow always/.test(optionSignal(option)));
  return (always && always.optionId) || "";
}

function deniedPermissionResult(params) {
  const optionId = pickRejectId(params);
  if (optionId) return { outcome: { outcome: "selected", optionId } };
  return { outcome: { outcome: "cancelled" } };
}

function acpPermissionResult(params, method) {
  const name = String(method || "");
  if (name.includes("write_text_file") || name.includes("read_text_file")) {
    return {};
  }
  const optionId = pickAllowOnceId(params);
  return { outcome: { outcome: "selected", optionId } };
}

module.exports = {
  listPermissionOptions,
  pickAllowOnceId,
  pickAllowAlwaysId,
  pickRejectId,
  deniedPermissionResult,
  isCutlineMcpTool,
  isElevenLabsTool,
  isUserInstructionsTool,
  acpPermissionResult,
};
