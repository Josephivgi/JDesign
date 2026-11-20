"use strict";

// jeditor_check_slop: the tool an agent calls to run every slop check on what
// it made. The same check the ACP host runs after a turn (electron/
// acp-host.cjs), so an agent that calls it before replying sees what the host
// would send back. Spec shape and wording follow lib/agent-tools.js.

function obj(properties, required) {
  const schema = { type: "object", properties: properties || {} };
  if (required && required.length) schema.required = required;
  return schema;
}

const text = (value) => (value == null ? "" : String(value).trim());

// What the person typed in this chat, when the call-time gate has it.
function askedFor(meta, dataRoot) {
  const parts = [];
  try {
    const gate = require("./gate");
    if (typeof gate.getAsked === "function") parts.push(gate.getAsked(meta || {}));
  } catch {
    /* the gate module is optional here */
  }
  try {
    parts.push(require("node:fs").readFileSync(require("node:path").join(dataRoot, "user-instructions.md"), "utf8").slice(0, 8000));
  } catch {
    /* no standing instructions saved */
  }
  return parts.filter(Boolean).join("\n");
}

function slopToolSpecs() {
  return [
    {
      name: "jeditor_check_slop",
      description:
        "Run every slop check on a project, a card, or a clip: the saved design and words, the scene plan, and the rendered picture and sound, measured frame by frame. Use it after a render and before you call the work done; each issue says where it is and how to fix it.",
      inputSchema: obj(
        {
          projectId: { type: "string", description: "Project to check: its clips, their saved source, and its finished video. From jeditor_list_projects." },
          cardId: { type: "string", description: "Card to check, from jeditor_list_cards. Render it with jeditor_render_card first so its picture is measured too." },
          libraryId: { type: "string", description: "One clip or finished video to check, from jeditor_snapshot." },
          frames: { type: "boolean", description: "false skips measuring the rendered file and checks only the saved source. Default true.", default: true },
          workspaceId: { type: "string", description: "Workspace id. Defaults to the active workspace." },
        },
        [],
      ),
      validate(input) {
        const src = input && typeof input === "object" ? input : {};
        for (const key of ["projectId", "cardId", "libraryId"]) {
          if (src[key] != null && typeof src[key] !== "string") throw new Error("Pass " + key + " as a string id, not a " + (Array.isArray(src[key]) ? "list" : typeof src[key]) + ".");
        }
        if (!text(src.projectId) && !text(src.cardId) && !text(src.libraryId)) {
          throw new Error("Pass projectId, cardId or libraryId: jeditor_list_projects, jeditor_list_cards and jeditor_snapshot list the ids.");
        }
      },
      async run(ctx, input) {
        const { checkSlop } = require("./check");
        const meta = (ctx && ctx.meta) || {};
        // A style skill read in this chat unlocks what that skill allows, the
        // same as at the tool call.
        let styles = [];
        try {
          styles = require("./gate").stylesFor(meta);
        } catch {
          styles = [];
        }
        const result = await checkSlop(
          { dataRoot: ctx.dataRoot, appRoot: ctx.appRoot, asked: askedFor(meta, ctx.dataRoot), style: styles[styles.length - 1] || "", styles, frames: input.frames !== false },
          { projectId: text(input.projectId), cardId: text(input.cardId), libraryId: text(input.libraryId), workspaceId: text(input.workspaceId) },
        );
        const out = { ok: result.ok, verdict: result.verdict, issues: result.issues, checked: result.checked };
        if (result.skipped.length) out.skipped = result.skipped;
        out.note = result.issues.length
          ? result.verdict === "slop"
            ? "Fix each issue, render again, then call jeditor_check_slop again. If the person asked for one of these in their own words, keep it and say so."
            : "One or two tells are fine when they are a choice. Fix them if they were not."
          : result.checked.length
            ? "Nothing found by the checks that ran."
            : "Nothing could be checked yet: see skipped.";
        return out;
      },
    },
  ];
}

module.exports = { slopToolSpecs };
