const fs = require("fs");
const path = require("path");
const { applyCardEdit, applyCardPatch } = require("./card-apply");
const { listLibrary, getLibraryItem } = require("./library-io");
const { copyPathIntoFinished, listFinished, getFinishedItem } = require("./finished-io");
const { composeFinished } = require("./compose-finished");
const { snapshot, loadWorkspace, loadState, defaultCard, saveWorkspace, workspaceDir } = require("./workspace-store");
const { renderCardPng, findFfmpeg, findFont, probeMedia } = require("./card-render");
const { readAnimationSource } = require("./animation-source");
const cardTemplateStore = require("./card-template-store");
const { discoverSkills, findSkill, ensureUserSkillsDir, userSkillsDir } = require("./skills");

const PROTOCOL_VERSION = "2024-11-05";
const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

function negotiateVersion(requested) {
  return SUPPORTED_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSION;
}

function appRootFromHere() {
  return path.join(__dirname, "..");
}

function skillInstructions(dataRoot) {
  const vault = userSkillsDir(dataRoot);
  let rules = "";
  try {
    const { listUserRules, userRulesPrompt } = require("./user-rules");
    rules = userRulesPrompt(listUserRules(dataRoot));
  } catch {
    /* an unreadable or sqlite-less store must not break the handshake */
  }
  return (
    "JV is a desktop video editor driven by an agent. Before editing, call jeditor_list_skills and read the skill that matches the job with jeditor_get_skill: ai-video-edit, code-animation, source-footage, library, export, stage-preview, player-pov, game-narration, html-cards, card-design, type-layout, color-on-video, motion-graphics, audio-voiceover, design-slop, video-slop, writing-slop. For platform or format guidance read content-guidance-research. " +
    "Skills are files. Write <name>/SKILL.md under " +
    vault +
    " and the next list or read sees it. The same name overrides the shipped skill. No app update. " +
    "Quality bar: probe the footage (jeditor_get_library_item, jeditor_preview_frames), design with cards, add motion and text, decide the audio (jeditor_tts or a sound op), render, then inspect frames before done." +
    (rules ? "\n\n" + rules : "")
  );
}

// The definitions never change at runtime. tools/list is called on every agent
// connect, so they are built once and shared.
let baseDefs = null;
function toolDefs() {
  return (baseDefs || (baseDefs = buildToolDefs())).slice();
}

// The card fields jeditor_apply_edit and jeditor_render_card both take. Kept in
// one place so the two specs cannot drift apart again.
function cardPatchSchema() {
  return {
    type: "object",
    description: "Card fields to merge into the card. An omitted field keeps its current value.",
    properties: {
      template: {
        type: "string",
        description: "Template id from jeditor_template_store_list. Its design is merged under the rest of the patch.",
      },
      kind: {
        type: "string",
        enum: ["title_card", "overlay"],
        description: "Card role. An overlay card draws inside a time window over the footage.",
      },
      placement: {
        type: "string",
        enum: ["auto", "intro", "overlay", "end"],
        description: "Where the card plays. auto infers it from kind.",
      },
      durationMs: {
        type: "number",
        minimum: 500,
        maximum: 60000,
        default: 3000,
        description: "How long the card shows, in milliseconds.",
      },
      colors: {
        type: "object",
        description: "Card palette, #RRGGBB hex values. Colors reach HTML cards as var(--primary), var(--secondary), var(--text).",
        properties: {
          primary: { type: "string", description: "Primary color hex, e.g. #1F6F56." },
          secondary: { type: "string", description: "Secondary color hex, e.g. #DFF56A." },
          text: { type: "string", description: "Text color hex." },
        },
      },
      composition: {
        type: "object",
        description: "Copy, layout, surface, and HTML for the card.",
        properties: {
          aspectRatio: {
            type: "string",
            enum: ["vertical", "landscape", "square"],
            description: "Card shape: vertical 9:16, landscape 16:9, square 1:1.",
          },
          surface: {
            type: "string",
            enum: ["solid", "soft", "transparent"],
            description: "Background treatment behind the text.",
          },
          align: { type: "string", enum: ["left", "center", "right"], description: "Default text alignment." },
          headline: { type: "string", description: "Main line, 160 characters max. Empty removes it." },
          body: { type: "string", description: "Body copy, 300 characters max. Empty removes it." },
          eyebrow: { type: "string", description: "Small line above the headline, 80 characters max." },
          cta: { type: "string", description: "Call to action line, 120 characters max." },
          backgroundId: { type: "string", description: "Library image id used as the card background." },
          blockLayout: {
            type: "object",
            description:
              "Per text field position and format: {headline:{x,y,width,fontSize,color,align,bold,highlight}}. x, y, width are 0-1 fractions of the card; fontSize in px; color and highlight are hex.",
          },
          imageLayouts: {
            type: "object",
            description: "Per library image placement, keyed by image id: {x,y,width,height} as 0-1 fractions.",
          },
          html: {
            type: "string",
            description: "Card markup. When set, the card renders from HTML and CSS instead of the text fields.",
          },
          css: { type: "string", description: "CSS for the markup in html. Scripts and external loads are stripped." },
          vars: {
            type: "object",
            description: "CSS variables for the card, e.g. {accent:'#DFF56A'}, read as var(--accent).",
          },
        },
      },
      imageIds: {
        type: "array",
        items: { type: "string" },
        description: "Ordered library image ids placed on the card.",
      },
      drawing: { type: "string", description: "PNG data URL drawn over the card, from the card editor ink layer." },
      motion: {
        type: "object",
        description: "Entry and exit animation for the card's time window.",
        properties: {
          in: {
            type: "string",
            enum: ["none", "fade", "rise", "drop", "slide", "pop"],
            description: "Animation as the card appears. none for no animation.",
          },
          out: {
            type: "string",
            enum: ["none", "fade", "rise", "drop", "slide", "pop"],
            description: "Animation as the card leaves. none for no animation.",
          },
        },
      },
    },
  };
}

function buildToolDefs() {
  return [
    {
      name: "jeditor_list_cards",
      description: "List cards with id, name, kind, placement, and duration. Use before editing if cardId is unknown; jeditor_get_card returns the full card.",
      inputSchema: {
        type: "object",
        properties: {
          workspaceId: { type: "string", description: "Workspace id. Defaults to the active workspace." },
        },
      },
    },
    {
      name: "jeditor_get_card",
      description: "Read one card: copy, colors, composition, motion, and text layout. Use when you need the current fields before editing a card.",
      inputSchema: {
        type: "object",
        required: ["cardId"],
        properties: {
          workspaceId: { type: "string", description: "Workspace id. Defaults to the active workspace." },
          cardId: { type: "string", description: "Card id from jeditor_list_cards." },
        },
      },
    },
    {
      name: "jeditor_apply_edit",
      description:
        "Create or update a card and save it. Omit cardId for a new card, or start from a template with patch.template. Use when the user asks for a title card, overlay, ad, or on-screen copy.",
      inputSchema: {
        type: "object",
        properties: {
          workspaceId: { type: "string", description: "Workspace id. Defaults to the active workspace." },
          cardId: { type: "string", description: "Card to update. Omit to create a new card." },
          name: { type: "string", description: "Card name shown in the editor." },
          description: { type: "string", description: "Card description, notes kept with the card (2000 characters max)." },
          why: {
            type: "string",
            description: "Reason for this change. Stored as the card description when description is not sent.",
          },
          patch: cardPatchSchema(),
        },
      },
    },
    {
      name: "jeditor_list_skills",
      description:
        "List JV skills with name, description, path, and the vault folder where new skills go. Use before editing to find the skill that matches the job.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "jeditor_list_library",
      description:
        "List library media with id, name, kind, size, and duration when known. Use to find the video, image, or audio id before composing; jeditor_get_library_item returns the full row.",
      inputSchema: {
        type: "object",
        properties: {
          workspaceId: { type: "string", description: "Workspace id. Defaults to the active workspace." },
          kind: {
            type: "string",
            enum: ["video", "image", "audio"],
            description: "Only items of this kind. Omit to list all.",
          },
        },
      },
    },
    {
      name: "jeditor_get_library_item",
      description:
        "Read one library item by id with its path on disk, and for video the duration in ms and seconds, probed and saved when missing. Use before planning cuts. Animation clips also return animationSource.",
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: {
          workspaceId: { type: "string", description: "Workspace id. Defaults to the active workspace." },
          id: { type: "string", description: "Library item id from jeditor_list_library." },
        },
      },
    },
    {
      name: "jeditor_list_finished",
      description:
        "List finished renders with id, name, size, and duration. Use to find a render id; jeditor_get_finished returns the full row.",
      inputSchema: {
        type: "object",
        properties: {
          workspaceId: { type: "string", description: "Workspace id. Defaults to the active workspace." },
        },
      },
    },
    {
      name: "jeditor_get_finished",
      description: "Read one finished render by id, including its path on disk. Use when you need to inspect or reuse a render.",
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: {
          workspaceId: { type: "string", description: "Workspace id. Defaults to the active workspace." },
          id: { type: "string", description: "Finished render id from jeditor_list_finished." },
        },
      },
    },
    {
      name: "jeditor_add_finished_video",
      description:
        "Save an existing video file as a finished render. Use for a completed clip, not for source footage, which goes in with jeditor_add_files.",
      inputSchema: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string", description: "Absolute path to a video file on this computer." },
          name: { type: "string", description: "Render name. Defaults to the file name." },
          workspaceId: { type: "string", description: "Workspace id. Defaults to the active workspace." },
          mime: {
            type: "string",
            description: "MIME type, e.g. video/mp4. Inferred from the file path when omitted.",
          },
        },
      },
    },
    {
      name: "jeditor_compose_finished",
      description:
        "Burn cards onto a library clip and save it as a render: intro cards lead, overlays play in their window, the end card closes, and audio mixes over the footage. Use when the user wants a finished ad or clip.",
      inputSchema: {
        type: "object",
        required: ["videoId"],
        properties: {
          videoId: { type: "string", description: "Library video id from jeditor_list_library." },
          cardId: {
            type: "string",
            description: "Burn only this card. Omit to burn every enabled card in the workspace.",
          },
          name: { type: "string", description: "Render name." },
          workspaceId: { type: "string", description: "Workspace id. Defaults to the active workspace." },
          seconds: {
            type: "number",
            minimum: 1,
            maximum: 300,
            description: "Longest footage to use, in seconds. Defaults to the whole clip.",
          },
          placement: {
            type: "string",
            enum: ["intro", "overlay", "end"],
            description: "Force this placement on the one card being composed.",
          },
          cardSeconds: {
            type: "number",
            minimum: 1.5,
            maximum: 10,
            default: 3,
            description: "Seconds the ad-hoc headline card shows, when no cardId is given.",
          },
          headline: { type: "string", description: "Ad-hoc headline, when no cardId supplies one." },
          body: { type: "string", description: "Ad-hoc body text, when no cardId supplies it." },
          cta: { type: "string", description: "Ad-hoc call to action, when no cardId supplies it." },
          audioId: { type: "string", description: "Library audio id mixed over the whole clip (voiceover or music)." },
          audioVolume: {
            type: "number",
            minimum: 0,
            maximum: 4,
            default: 1,
            description: "Gain for the audio overlay.",
          },
          audioLoop: { type: "boolean", description: "Repeat the track to cover the clip (music beds)." },
          duck: {
            type: "number",
            minimum: 0,
            maximum: 1,
            description: "Footage audio gain under the overlay, e.g. 0.3. Omit to leave the footage audio alone.",
          },
          audioIds: {
            type: "array",
            items: { type: "string" },
            description: "Several tracks mixed together with the same gains, e.g. [voiceoverId, musicId]. Use audioId for one.",
          },
          audios: {
            type: "array",
            description: "Tracks with their own gain. Overrides audioIds and audioId.",
            items: {
              type: "object",
              properties: {
                audioId: { type: "string", description: "Library audio id." },
                volume: { type: "number", minimum: 0, maximum: 4, default: 1, description: "Gain for this track." },
                loop: { type: "boolean", description: "Repeat this track to cover the clip." },
                duck: { type: "number", minimum: 0, maximum: 1, description: "Footage audio gain under this track." },
              },
              required: ["audioId"],
            },
          },
        },
      },
    },
    {
      name: "jeditor_render_card",
      description:
        "Render a card to a PNG at full size, the same design the compose step burns. Pass cardId, or template with patch for an unsaved preview. Use to check a design before composing.",
      inputSchema: {
        type: "object",
        properties: {
          workspaceId: { type: "string", description: "Workspace id. Defaults to the active workspace." },
          cardId: { type: "string", description: "Saved card id to render." },
          template: { type: "string", description: "Template id to render instead of a saved card." },
          // The full card field schema is 3.6 KB and jeditor_apply_edit already
          // carries it, so this points at it instead of paying for it twice.
          patch: {
            type: "object",
            description:
              "Card fields for an unsaved preview, the same ones jeditor_apply_edit takes in patch: template, kind, placement, durationMs, colors, composition (copy, blockLayout, html, css), imageIds, drawing, motion.",
          },
          outPath: {
            type: "string",
            description: "Absolute PNG path to write. Defaults into the workspace's renders folder.",
          },
          transparent: { type: "boolean", description: "Keep alpha instead of the card's background." },
          atMs: { type: "number", minimum: 0, description: "Freeze CSS animation at this millisecond for the still." },
          asImage: { type: "boolean", description: "Also return the PNG inline so a vision model can look at it." },
        },
      },
      // Without a card there is no design to render: the handler used to fall
      // back to a default card, so an agent that sent nothing got a picture back
      // and read it as a pass. patch alone is fine when it is a real design.
      validate(input) {
        const src = input && typeof input === "object" ? input : {};
        const cardId = String(src.cardId || "").trim();
        const template = String(src.template || "").trim();
        const patch = src.patch && typeof src.patch === "object" && Object.keys(src.patch).length ? src.patch : null;
        if (!cardId && !template && !patch) {
          throw new Error(
            "This call has nothing to render. Pass cardId from jeditor_list_cards, or template from jeditor_template_store_list, or a patch with the card fields.",
          );
        }
      },
    },
    {
      name: "jeditor_template_store_list",
      description:
        "List card templates: built-in, installed, and saved ones, each with id, category, and source. Use to find the template id for patch.template.",
      inputSchema: {
        type: "object",
        properties: {
          category: {
            type: "string",
            description: "Only templates in this category, e.g. \"Hooks & intros\". See jeditor_template_store_categories.",
          },
        },
      },
    },
    {
      name: "jeditor_template_store_categories",
      description: "List the categories in the card template store. Use to filter jeditor_template_store_list by category.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "jeditor_template_store_install",
      description:
        "Install a built-in template into the user's store so it stays in their collection. Use when the user wants to keep a template that ships with JV.",
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string", description: "Template id from jeditor_template_store_list." },
        },
      },
    },
    {
      name: "jeditor_save_card_as_template",
      description:
        "Save a card's design as a reusable template in the store. Pass cardId for a saved card, or the card object. Use when the user wants to reuse a design later.",
      inputSchema: {
        type: "object",
        properties: {
          workspaceId: { type: "string", description: "Workspace id. Defaults to the active workspace." },
          cardId: { type: "string", description: "Workspace card id to save." },
          card: { type: "object", description: "Card object to save instead of cardId." },
        },
      },
    },
  ];
}

function textResult(payload, isError) {
  // Compact JSON: the indent cost a third more tokens on every call and a model
  // reads neither spacing nor newlines.
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  return { content: [{ type: "text", text }], isError: Boolean(isError) };
}

// One shape for every failure a tool returns: one sentence, no stack, no system
// error text, no temp path, 300 characters or fewer, and a hint that says what
// to do next. The same string is what the app's activity log shows.
const ERROR_LIMIT = 300;
const INTERNAL_ERROR = /(?:ENOENT|EACCES|EPERM|ENOSPC|EBUSY|TypeError|ReferenceError|SyntaxError|RangeError|\bundefined\b|\bNaN\b|\[object Object\]|\bat [\w.$<]+\s*\()/;
const TEMP_PATH = /\b[A-Za-z]:\\[^\s"]*\\Temp\\|\/tmp\/|\/var\/folders\//i;

function errorMessage(error, hint, tail) {
  const raw = String((error && error.message) || error || "")
    .replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, "")
    .replace(/^Error:\s*/, "")
    .split(/\r?\n/)[0]
    .trim();
  const usable = raw && raw.length <= 260 && !INTERNAL_ERROR.test(raw) && !TEMP_PATH.test(raw);
  let text = usable ? raw : hint;
  // A reason from a library names no tool, so the next step is added when the
  // sentence does not already carry one.
  if (tail && !/jeditor_|tools\/list/.test(text)) text = text.replace(/[.\s]+$/, "") + ". " + tail;
  if (text.length > ERROR_LIMIT) text = text.slice(0, ERROR_LIMIT - 1).replace(/[\s,;:.]+$/, "") + ".";
  return /[.?!]$/.test(text) ? text : text + ".";
}

// A value an agent passed, made safe to echo in a sentence. Long or odd ids are
// cut rather than reprinted whole.
function idText(value) {
  const text = String(value == null ? "" : value).trim();
  if (!text) return "the id you passed";
  return JSON.stringify(text.length > 60 ? text.slice(0, 57) + "..." : text);
}

// A video whose upload probe missed carries durationMs 0, and an agent planning
// cuts reads the length first. Probe it here, save it back, and never throw: a
// failed probe returns the row with probeError and no duration fields.
async function withProbedDuration(dataRoot, workspaceId, item) {
  const row = Object.assign({}, item);
  if (row.kind !== "video") return row;
  const known = Math.round(Number(row.durationMs) || 0);
  if (known > 0) {
    row.durationMs = known;
    row.durationSeconds = known / 1000;
    return row;
  }
  try {
    const ffmpeg = findFfmpeg();
    if (!ffmpeg) throw new Error("ffmpeg is not available on this computer, so the duration was not probed");
    const media = await probeMedia(ffmpeg, row.path);
    const probed = Math.round(Number(media && media.durationMs) || 0);
    if (probed <= 0) throw new Error("ffmpeg read no duration for this file, so the duration was not probed");
    row.durationMs = probed;
    row.durationSeconds = probed / 1000;
  } catch (error) {
    delete row.durationMs;
    row.probeError = error && error.message ? error.message : String(error);
    return row;
  }
  try {
    const ws = await loadWorkspace(dataRoot, workspaceId);
    const stored = (ws.library || []).find((entry) => entry && entry.id === row.id);
    if (stored) {
      stored.durationMs = row.durationMs;
      await saveWorkspace(dataRoot, ws);
    }
  } catch {
    /* the probed length still comes back to the caller */
  }
  return row;
}

// The bridge hands the same spec array to every handler (it makes one per
// request that carries no session), so the tool list and name lookups are
// built once per array instead of per handler or per call.
const toolIndexes = new WeakMap();
function toolIndex(extraTools, withBase) {
  let byKind = toolIndexes.get(extraTools);
  if (!byKind) toolIndexes.set(extraTools, (byKind = {}));
  const kind = withBase ? "base" : "bare";
  if (!byKind[kind]) {
    const extra = extraTools.map((spec) => ({ name: spec.name, description: spec.description, inputSchema: spec.inputSchema }));
    const defs = (withBase ? toolDefs() : []).concat(extra);
    const specs = new Map();
    for (const spec of extraTools) if (!specs.has(spec.name)) specs.set(spec.name, spec);
    const schemas = new Map(defs.map((def) => [def.name, (def.inputSchema && def.inputSchema.properties) || {}]));
    // A base tool is a def plus a name branch further down, with no spec object
    // to hold a validate function, so the def carries it instead.
    const validators = new Map();
    for (const def of defs) if (typeof def.validate === "function") validators.set(def.name, def.validate);
    byKind[kind] = { defs, specs, schemas, validators };
  }
  return byKind[kind];
}

function createMcpHandler(options) {
  const dataRoot = options && options.dataRoot;
  const appRoot = (options && options.appRoot) || appRootFromHere();
  if (!dataRoot) throw new Error("MCP dataRoot is required");
  const extraTools = (options && options.extraTools) || [];
  const onToolCall = (options && options.onToolCall) || null;
  const approveTool = (options && options.approveTool) || null;
  let clientName = (options && options.clientName) || "";
  const tools = toolIndex(extraTools, !(options && options.baseTools === false));

  function allToolDefs() {
    return tools.defs.slice();
  }

  function schemaFor(name) {
    return tools.schemas.get(name) || null;
  }

  // The ACP session binds the project/workspace the user has open. When an
  // agent omits them (or forgets after a long turn), fill them in from the
  // session so a JV call can never silently land on the workspace's
  // last-active project instead of the one on screen. An explicit value the
  // agent did send always wins.
  function withSessionDefaults(name, args, meta) {
    const projectId = String((meta && meta.projectId) || "").trim();
    const workspaceId = String((meta && meta.workspaceId) || "").trim();
    if (!projectId && !workspaceId) return args;
    const props = schemaFor(name);
    if (!props) return args;
    const input = args && typeof args === "object" ? Object.assign({}, args) : {};
    let changed = false;
    if (projectId && props.projectId && !input.projectId) {
      input.projectId = projectId;
      changed = true;
    }
    if (workspaceId && props.workspaceId && !input.workspaceId) {
      input.workspaceId = workspaceId;
      changed = true;
    }
    return changed ? input : args;
  }

  async function callTool(name, args, meta) {
    const started = Date.now();
    let result;
    try {
      result = await callToolInner(name, args, meta);
    } catch (error) {
      if (onToolCall) onToolCall({ name, args, ok: false, error, durationMs: Date.now() - started, client: clientName, meta });
      // A failure that got this far still answers as a tool result, never as a
      // protocol error: one sentence with what to do next. The window refreshes
      // because a write may have landed before the throw.
      const failed = textResult({ error: errorMessage(error, name + " could not finish. Check the input, then try again.") }, true);
      failed.saved = true;
      return failed;
    }
    if (onToolCall) {
      onToolCall({ name, args, ok: !result.isError, result, durationMs: Date.now() - started, client: clientName, meta });
    }
    // saved is JV's own refresh flag, not part of an MCP tool result.
    if (result && result.saved !== undefined) {
      const { saved, ...sent } = result;
      return sent;
    }
    return result;
  }

  // A model can garble a workspace id (a real run mixed halves of the project
  // and workspace UUIDs). An unknown id used to create an empty workspace and
  // the edit landed nowhere. Now the project's own workspace wins when the call
  // names a project, and anything else is refused with the right id.
  async function checkWorkspace(input) {
    if (!input || typeof input.workspaceId !== "string" || !input.workspaceId) return { input };
    const state = await loadState(dataRoot);
    if ((state.workspaces || []).some((w) => w && w.id === input.workspaceId)) return { input };
    let owner = "";
    if (input.projectId) {
      try {
        const meta = require("./ai-projects").getProjectMeta(dataRoot, input.projectId);
        owner = (meta && meta.workspaceId) || "";
      } catch {
        owner = "";
      }
    }
    if (owner) return { input: Object.assign({}, input, { workspaceId: owner }) };
    return {
      error:
        "There is no workspace with that id. Pass the open workspace, " + JSON.stringify(state.activeWorkspaceId) +
        ", or read it from jeditor_get_project.",
    };
  }

  async function callToolInner(name, args, meta) {
    // Arguments arrive as an object of named fields. A string or array is a
    // malformed call, and running it would do work the caller never asked for.
    if (args != null && (typeof args !== "object" || Array.isArray(args))) {
      return textResult({ error: "Arguments for " + idText(name) + " must be an object of named fields. Call tools/list for its schema." }, true);
    }
    const checked = await checkWorkspace(args && typeof args === "object" ? args : {});
    if (checked.error) return textResult({ error: checked.error }, true);
    const input = checked.input;
    const spec = tools.specs.get(name);
    if (!spec) {
      // Base tool: fail a bad call before the handler runs or anything is
      // written, with the same plain message shape the specs use.
      const check = tools.validators.get(name);
      if (typeof check === "function") {
        try {
          check(input);
        } catch (error) {
          return textResult({ error: errorMessage(error, "That call does not fit " + name + ". Check its parameters and try again.") }, true);
        }
      }
    }
    if (spec) {
      try {
        // A tool that spends the user's account (voiceovers) asks first. The
        // host decides how: the in-app agent gets an ACP permission prompt, an
        // outside agent connected over the bridge gets one in the app.
        // A call that would be refused anyway fails before anyone is asked.
        // An in-app agent was already asked (ACP permission) before the call
        // got here; a refused call must not leave that yes for a later one.
        if (typeof spec.validate === "function") {
          try {
            spec.validate(input);
          } catch (error) {
            // Only an in-app agent was asked before this point.
            if (typeof spec.onRefused === "function" && meta && meta.harness) {
              try {
                spec.onRefused(meta || {}, input);
              } catch {
                /* the refusal still goes back */
              }
            }
            throw error;
          }
        }
        if (spec.needsApproval && approveTool) await approveTool({ name, args: input, meta: meta || {} });
        const approved = Boolean(spec.needsApproval && approveTool);
        const out = await spec.run({ dataRoot, appRoot, client: clientName, meta: meta || {}, approved }, input);
        if (out && Array.isArray(out.content)) return out;
        return textResult(out == null ? { ok: true } : out);
      } catch (error) {
        const failed = textResult({ error: errorMessage(error, name + " could not finish. Check the input, then try again.") }, true);
        // A tool that writes can fail after saving part of its work, so the
        // window refreshes after any failed write rather than show a stale
        // project (a refresh costs little; a stale view misleads).
        if (spec.mutates || (error && error.saved)) failed.saved = true;
        return failed;
      }
    }
    if (options && options.baseTools === false) {
      return textResult({ error: "There is no tool called " + idText(name) + ". Call tools/list for the names this server has." }, true);
    }
    if (name === "jeditor_list_cards") {
      const snap = await snapshot(dataRoot, input.workspaceId);
      // Rows carry what an agent picks a card by; the detail tool has the rest.
      return textResult({
        workspaceId: snap.workspace.id,
        cards: (snap.workspace.cards || []).map((card) => ({
          id: card.id,
          name: card.name,
          kind: card.kind,
          placement: card.placement || "auto",
          durationMs: card.durationMs,
          createdAt: card.createdAt,
        })),
        note: "Short rows. jeditor_get_card returns the full card.",
      });
    }
    if (name === "jeditor_get_card") {
      if (!input.cardId) return textResult({ error: "Pass cardId: jeditor_list_cards lists the card ids this workspace has." }, true);
      const snap = await snapshot(dataRoot, input.workspaceId);
      const card = (snap.workspace.cards || []).find((item) => item.id === input.cardId);
      if (!card) return textResult({ error: "No card with id " + idText(input.cardId) + " in this workspace. Call jeditor_list_cards for the ids it has." }, true);
      return textResult(card);
    }
    if (name === "jeditor_apply_edit") {
      const patch = Object.assign({}, input.patch || {});
      if (input.name !== undefined) patch.name = input.name;
      if (input.description !== undefined) patch.description = input.description;
      if (input.why !== undefined) patch.why = input.why;
      // A cardId that names no card is a typo, not a request to create one:
      // creating is what omitting cardId is for.
      const cardId = String(input.cardId || patch.id || "");
      if (cardId) {
        const snap = await snapshot(dataRoot, input.workspaceId);
        const known = (snap.workspace.cards || []).some((card) => card && card.id === cardId);
        if (!known) {
          return textResult({ error: "No card with id " + idText(cardId) + " in this workspace. Call jeditor_list_cards for the ids it has, or omit cardId to make a new card." }, true);
        }
      }
      const result = await applyCardEdit({
        dataRoot,
        workspaceId: input.workspaceId,
        cardId,
        patch,
      });
      return textResult({
        card: result.card,
        created: result.created,
        workspaceId: result.snapshot.workspace.id,
      });
    }
    if (name === "jeditor_list_skills") {
      const vault = ensureUserSkillsDir(dataRoot);
      const skills = discoverSkills(appRoot, { dataRoot }).map((skill) => ({
        name: skill.name,
        description: skill.description,
        path: skill.path,
        source: skill.source,
      }));
      return textResult({ vault, skills });
    }
    if (name === "jeditor_list_library") {
      const kind = input.kind == null ? "" : String(input.kind);
      if (kind && !["video", "image", "audio"].includes(kind)) {
        return textResult({ error: "kind must be one of video, image or audio. Omit it to list everything." }, true);
      }
      const snap = await snapshot(dataRoot, input.workspaceId);
      const items = await listLibrary(dataRoot, kind || undefined, snap.workspace.id);
      return textResult({
        workspaceId: snap.workspace.id,
        items: items.map((item) => {
          const row = {
            id: item.id,
            name: item.name,
            kind: item.kind,
            size: item.size,
            createdAt: item.createdAt,
            aiCanUse: item.aiCanUse !== false,
          };
          // An absent durationMs means it was never probed; the detail tool probes it.
          const ms = Number(item.durationMs);
          if (ms > 0) row.durationMs = ms;
          return row;
        }),
        note: "Short rows without paths or hashes. jeditor_get_library_item returns the full item and probes a video's duration.",
      });
    }
    if (name === "jeditor_get_library_item") {
      if (!input.id) return textResult({ error: "Pass an id: jeditor_list_library lists the library ids." }, true);
      const item = await getLibraryItem(dataRoot, input.id, input.workspaceId);
      if (!item) return textResult({ error: "No library item with id " + idText(input.id) + " in this workspace. Call jeditor_list_library for the ids it has." }, true);
      // An animation clip comes back with the code it was rendered from.
      const wsId = input.workspaceId || (await loadState(dataRoot)).activeWorkspaceId;
      const row = await withProbedDuration(dataRoot, wsId, item);
      const animation = readAnimationSource(dataRoot, wsId, item.id);
      if (animation) return textResult(Object.assign({}, row, { animationSource: animation }));
      if (item.source === "animation") {
        return textResult(Object.assign({}, row, { animationSource: null, note: "This clip was rendered from code before JV kept sources, so its code is not saved. Rebuild it from its frames (jeditor_preview_frames)." }));
      }
      return textResult(row);
    }
    if (name === "jeditor_list_finished") {
      const snap = await snapshot(dataRoot, input.workspaceId);
      const items = await listFinished(dataRoot, snap.workspace.id);
      return textResult({
        workspaceId: snap.workspace.id,
        items: items.map((item) => {
          const row = {
            id: item.id,
            name: item.name,
            kind: item.kind,
            size: item.size,
            createdAt: item.createdAt,
          };
          const ms = Number(item.durationMs);
          if (ms > 0) row.durationMs = ms;
          return row;
        }),
        note: "Short rows without paths or hashes. jeditor_get_finished returns the full render.",
      });
    }
    if (name === "jeditor_get_finished") {
      if (!input.id) return textResult({ error: "Pass an id: jeditor_list_finished lists the renders this workspace has." }, true);
      const item = await getFinishedItem(dataRoot, input.id, input.workspaceId);
      if (!item) return textResult({ error: "No finished render with id " + idText(input.id) + " in this workspace. Call jeditor_list_finished for the ids it has." }, true);
      return textResult(item);
    }
    if (name === "jeditor_add_finished_video") {
      if (!input.path) return textResult({ error: "Pass path: the absolute path of a finished video file on this computer." }, true);
      let added;
      try {
        added = await copyPathIntoFinished(dataRoot, input.path, {
          name: input.name,
          mime: input.mime,
          workspaceId: input.workspaceId,
          source: "tui",
        });
      } catch (error) {
        return textResult({ error: errorMessage(error, "That file could not be added as a render.", "Check the path is a video file on this computer, then try again.") }, true);
      }
      // The store hands back the whole workspace with every import; the agent
      // only needs the row it just created. jeditor_get_finished has the rest.
      const item = added.item || {};
      const row = {
        id: item.id,
        name: item.name,
        kind: "video",
        size: Number(item.size) || 0,
        createdAt: item.createdAt,
      };
      const ms = Number(item.durationMs);
      if (ms > 0) row.durationMs = ms;
      return textResult({ item: row, skipped: added.skipped === true });
    }
    if (name === "jeditor_compose_finished") {
      if (!input.videoId) return textResult({ error: "Pass videoId: jeditor_list_library lists the library video ids." }, true);
      // The id is checked here so a wrong one names itself and the tool that
      // lists the right ones, instead of the store's bare "not found".
      const snap = await snapshot(dataRoot, input.workspaceId);
      const known = (snap.workspace.library || []).find((item) => item && item.id === String(input.videoId));
      if (!known) {
        return textResult({ error: "No library item with id " + idText(input.videoId) + " in this workspace. Call jeditor_list_library for the ids it has." }, true);
      }
      if (known.kind !== "video") {
        return textResult({ error: "That library item is " + idText(known.kind) + ", not a video. jeditor_list_library lists the video ids." }, true);
      }
      const composed = await composeFinished({
        dataRoot,
        workspaceId: input.workspaceId,
        videoId: input.videoId,
        cardId: input.cardId,
        name: input.name,
        headline: input.headline,
        body: input.body,
        cta: input.cta,
        seconds: input.seconds,
        placement: input.placement,
        cardSeconds: input.cardSeconds,
        audioId: input.audioId,
        audioVolume: input.audioVolume,
        audioLoop: input.audioLoop,
        duck: input.duck,
        audioIds: input.audioIds,
        audios: input.audios,
        projectId: meta && meta.projectId,
        appRoot,
      });
      return textResult(composed);
    }
    if (name === "jeditor_render_card") {
      const snap = await snapshot(dataRoot, input.workspaceId);
      let card = null;
      if (input.cardId) {
        card = (snap.workspace.cards || []).find((item) => item.id === input.cardId) || null;
        if (!card) return textResult({ error: "No card with id " + idText(input.cardId) + " in this workspace. Call jeditor_list_cards for the ids it has." }, true);
      } else {
        const patch = Object.assign({}, input.patch || {});
        if (input.template) patch.template = input.template;
        card = applyCardPatch(defaultCard(), patch, { expandTemplate: true });
      }
      const outDir = path.join(workspaceDir(dataRoot, snap.workspace.id), "renders");
      await fs.promises.mkdir(outDir, { recursive: true });
      const outPath = input.outPath || path.join(outDir, (card.id || "preview") + ".png");
      const rendered = await renderCardPng({
        dataRoot,
        workspaceId: snap.workspace.id,
        card,
        outPath,
        ffmpeg: findFfmpeg(),
        font: findFont(),
        transparent: input.transparent === true,
        atMs: input.atMs,
        appRoot,
      });
      const info = { path: rendered.path, width: rendered.width, height: rendered.height, card: card.name };
      if (input.asImage === true) {
        return {
          content: [
            { type: "text", text: JSON.stringify(info) },
            { type: "image", data: (await fs.promises.readFile(rendered.path)).toString("base64"), mimeType: "image/png" },
          ],
        };
      }
      return textResult(info);
    }
    if (name === "jeditor_template_store_list") {
      let templates = cardTemplateStore.listStoreTemplates(dataRoot);
      if (input.category) {
        const wanted = String(input.category).toLowerCase();
        templates = templates.filter((item) => String(item.category || "").toLowerCase() === wanted);
      }
      return textResult({ templates });
    }
    if (name === "jeditor_template_store_categories") {
      return textResult({ categories: cardTemplateStore.listStoreCategories(dataRoot) });
    }
    if (name === "jeditor_template_store_install") {
      if (!input.id) return textResult({ error: "Pass id: jeditor_template_store_list lists the template ids, built in and installed." }, true);
      try {
        const template = cardTemplateStore.installTemplate(dataRoot, String(input.id));
        return textResult({ template });
      } catch (error) {
        return textResult({ error: errorMessage(error, "That template could not be installed.", "Call jeditor_template_store_list for the ids it has.") }, true);
      }
    }
    if (name === "jeditor_save_card_as_template") {
      let card = input.card && typeof input.card === "object" ? input.card : null;
      if (!card && input.cardId) {
        const snap = await snapshot(dataRoot, input.workspaceId);
        card = (snap.workspace.cards || []).find((item) => item.id === input.cardId) || null;
        if (!card) return textResult({ error: "No card with id " + idText(input.cardId) + " in this workspace. Call jeditor_list_cards for the ids it has." }, true);
      }
      if (!card) return textResult({ error: "Pass cardId, from jeditor_list_cards, or a card object to save as a template." }, true);
      try {
        const template = cardTemplateStore.saveCardAsTemplate(dataRoot, card);
        return textResult({ template });
      } catch (error) {
        return textResult({ error: errorMessage(error, "That card could not be saved as a template. Give it a name, then try again.") }, true);
      }
    }
    return textResult({ error: "There is no tool called " + idText(name) + ". Call tools/list for the names this server has." }, true);
  }

  async function handle(message, meta) {
    if (!message || typeof message !== "object") {
      return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } };
    }
    if (message.method && String(message.method).startsWith("notifications/")) {
      return null;
    }
    const id = message.id;
    const method = message.method;
    try {
      if (method === "initialize") {
        const params = message.params || {};
        const info = params.clientInfo || {};
        if (info.name) clientName = String(info.name) + (info.version ? " " + info.version : "");
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: negotiateVersion(params.protocolVersion),
            capabilities: {
              tools: { listChanged: false },
              resources: { listChanged: false },
            },
            serverInfo: { name: (options && options.serverName) || "jeditor", version: "1.0.0" },
            instructions:
              options && typeof options.instructions === "function"
                ? options.instructions(dataRoot)
                : options && typeof options.instructions === "string"
                  ? options.instructions
                  : skillInstructions(dataRoot),
          },
        };
      }
      if (method === "ping") {
        return { jsonrpc: "2.0", id, result: {} };
      }
      if (method === "tools/list") {
        return { jsonrpc: "2.0", id, result: { tools: tools.defs } };
      }
      if (method === "tools/call") {
        const name = message.params && message.params.name;
        const rawArgs = (message.params && (message.params.arguments || message.params.args)) || {};
        const args = withSessionDefaults(name, rawArgs, meta);
        const result = await callTool(name, args, meta);
        return { jsonrpc: "2.0", id, result };
      }
      if (method === "resources/list") {
        const skills = discoverSkills(appRoot, { dataRoot });
        return {
          jsonrpc: "2.0",
          id,
          result: {
            resources: skills.map((skill) => ({
              uri: "cutline://skill/" + skill.name,
              name: skill.name,
              mimeType: "text/markdown",
              description: skill.description,
            })),
          },
        };
      }
      if (method === "resources/read") {
        const uri = message.params && message.params.uri;
        const name = String(uri || "").replace(/^cutline:\/\/skill\//, "");
        const skill = findSkill(appRoot, name, { dataRoot });
        if (!skill) {
          return { jsonrpc: "2.0", id, error: { code: -32002, message: "Skill not found" } };
        }
        return {
          jsonrpc: "2.0",
          id,
          result: {
            contents: [{ uri, mimeType: "text/markdown", text: await fs.promises.readFile(skill.path, "utf8") }],
          },
        };
      }
      return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found: " + method } };
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: error && error.message ? error.message : String(error) },
      };
    }
  }

  return {
    handle,
    callTool,
    toolDefs: allToolDefs,
    dataRoot,
    appRoot,
    loadWorkspace,
    clientName: () => clientName,
  };
}

module.exports = {
  PROTOCOL_VERSION,
  SUPPORTED_VERSIONS,
  negotiateVersion,
  createMcpHandler,
  toolDefs,
};
