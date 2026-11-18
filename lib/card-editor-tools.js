"use strict";

// The Edit cards MCP server. Every tool works on the same workspace cards the
// card studio edits, through the same stores, so an agent can do anything the
// user can do there: write copy, position text, write HTML and CSS, manage
// images, apply templates, render, undo, and delete. Deleting asks the user in
// the app first (needsApproval); everything else is undoable with cards_undo.

const fs = require("node:fs");
const path = require("node:path");
const { loadState, loadWorkspace, saveWorkspace, snapshot, defaultCard, workspaceDir } = require("./workspace-store");
const { applyCardEdit, applyCardPatch } = require("./card-apply");
const { copyPathIntoLibrary } = require("./library-io");
const cardTemplateStore = require("./card-template-store");

const SERVER_NAME = "jeditor-cards";
const TEXT_FIELDS = ["headline", "body", "eyebrow", "cta"];
const LIMITS = { headline: 160, body: 300, eyebrow: 80, cta: 120 };
const MAX_CODE = 200000;
const MAX_HISTORY = 40;
const LAYOUT_KEYS = ["x", "y", "width", "fontSize", "color", "align", "bold", "highlight"];

function obj(properties, required) {
  const schema = { type: "object", properties: properties || {} };
  if (required && required.length) schema.required = required;
  return schema;
}

const WS = { type: "string", description: "Workspace id. Defaults to the open workspace." };
const CARD = { type: "string", description: "Card id from cards_list." };
const HEX = { type: "string", description: "Hex color, #RRGGBB." };
const ALIGN = { type: "string", enum: ["left", "center", "right"], description: "Text alignment." };
const PLACEMENT = { type: "string", enum: ["auto", "intro", "overlay", "end"], description: "When the card plays in the video." };
const MOTION = { type: "string", enum: ["none", "fade", "rise", "drop", "slide", "pop"], description: "Motion preset." };
const DURATION_MS = { type: "number", minimum: 500, maximum: 60000, description: "On-screen time in ms, 500 to 60000." };

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function plain(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clamp(value, min, max) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
}

const history = new Map();
const trash = new Map();

function historyFor(workspaceId, cardId) {
  const key = workspaceId + ":" + cardId;
  if (!history.has(key)) history.set(key, { past: [], future: [] });
  return history.get(key);
}

function remember(workspaceId, card) {
  const h = historyFor(workspaceId, card.id);
  h.past.push(JSON.stringify(card));
  if (h.past.length > MAX_HISTORY) h.past.shift();
  h.future = [];
}

function view(card, full) {
  const c = card.composition || {};
  const out = {
    id: card.id,
    name: card.name,
    description: card.description || "",
    kind: card.kind,
    placement: card.placement || "auto",
    durationMs: card.durationMs,
    templateId: card.templateId || "",
    aspectRatio: c.aspectRatio || "vertical",
    colors: card.colors,
    text: { headline: c.headline || "", body: c.body || "", eyebrow: c.eyebrow || "", cta: c.cta || "" },
    align: c.align || "left",
    surface: c.surface || "solid",
    backgroundId: c.backgroundId || "",
    imageIds: card.imageIds || [],
    motion: card.motion,
    isHtmlCard: Boolean(c.html && c.html.trim()),
    htmlLength: (c.html || "").length,
    cssLength: (c.css || "").length,
    hasDrawing: Boolean(card.drawing),
    endScreen: Boolean(card.endScreen),
  };
  if (full) {
    out.blockLayout = c.blockLayout || {};
    out.imageLayouts = c.imageLayouts || {};
    out.html = c.html || "";
    out.css = c.css || "";
    out.vars = c.vars || {};
    out.endScreenDurationMs = card.endScreenDurationMs;
    out.endScreenBackgroundId = card.endScreenBackgroundId || "";
    out.endScreenFit = card.endScreenFit;
    out.endScreenTreatment = card.endScreenTreatment;
  }
  return out;
}

async function openWorkspace(ctx, input) {
  const id = (input && input.workspaceId) || (ctx.meta && ctx.meta.workspaceId) || (await loadState(ctx.dataRoot)).activeWorkspaceId;
  const ws = await loadWorkspace(ctx.dataRoot, id);
  if (!Array.isArray(ws.cards)) ws.cards = [];
  return ws;
}

// An id an agent passed, safe and short enough to put inside a sentence.
function idText(value) {
  const text = String(value == null ? "" : value).trim();
  if (!text) return "the id you passed";
  return JSON.stringify(text.length > 60 ? text.slice(0, 57) + "..." : text);
}

// A template id that names nothing would leave the card unchanged in silence,
// so it fails here and names the tool that lists the real ids.
function knownTemplate(ctx, templateId) {
  const { findAnyTemplate } = require("./card-templates");
  const found = findAnyTemplate(String(templateId || ""), ctx.dataRoot);
  if (!found) {
    throw new Error("No template with id " + idText(templateId) + ". Call cards_list_templates for the ids it has.");
  }
  return found;
}

// The patch fields with a closed set of values, checked before anything is
// written so a typo is a sentence and not a silent no-op.
function checkPatch(patch) {
  if (!plain(patch)) return;
  if (patch.durationMs !== undefined) checkDuration(patch.durationMs);
  if (plain(patch.colors)) {
    const known = ["primary", "secondary", "text"];
    const unknown = Object.keys(patch.colors).filter((key) => !known.includes(key));
    if (unknown.length) {
      throw new Error("patch.colors takes primary, secondary and text, not " + unknown.map(idText).join(", ") + ".");
    }
  }
}

function checkDuration(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 500 || ms > 60000) {
    throw new Error("durationMs must be between 500 and 60000 milliseconds. Pass the length in ms, for example 3000.");
  }
}

function findIndex(ws, cardId) {
  const index = ws.cards.findIndex((card) => card.id === cardId);
  if (index === -1) throw new Error("No card with id " + idText(cardId) + " in this workspace. Call cards_list for the ids it has.");
  return index;
}

// Loads the card, lets fn change a copy, normalizes it like a studio save, and
// writes it. The previous version goes on the undo stack first.
async function mutate(ctx, input, fn) {
  if (!input || !input.cardId) throw new Error("Pass cardId: cards_list lists the card ids this workspace has.");
  const ws = await openWorkspace(ctx, input);
  const index = findIndex(ws, input.cardId);
  const current = ws.cards[index];
  const draft = clone(current);
  const note = (await fn(draft, ws)) || {};
  const next = applyCardPatch(draft, {});
  next.id = current.id;
  next.createdAt = current.createdAt;
  next.updatedAt = new Date().toISOString();
  remember(ws.id, current);
  ws.cards[index] = next;
  await saveWorkspace(ctx.dataRoot, ws);
  return Object.assign({ workspaceId: ws.id, card: view(next) }, note);
}

function libraryImage(ws, id) {
  const item = (ws.library || []).find((entry) => entry.id === id);
  if (!item || item.kind !== "image") throw new Error("No library image with id " + idText(id) + ". Call cards_list_images for the ids it has.");
  return item;
}

function cleanLayout(value) {
  const out = {};
  if (!plain(value)) return out;
  for (const key of LAYOUT_KEYS) if (value[key] !== undefined && value[key] !== null) out[key] = value[key];
  if (out.x !== undefined) out.x = clamp(out.x, 0, 1);
  if (out.y !== undefined) out.y = clamp(out.y, 0, 0.95);
  if (out.width !== undefined) out.width = clamp(out.width, 0.1, 1);
  if (out.fontSize !== undefined) out.fontSize = clamp(out.fontSize, 8, 160);
  return out;
}

function codeTarget(card, target) {
  if (target !== "html" && target !== "css") throw new Error("target must be html or css. Pass html to write markup, or css to write styles.");
  return target;
}

function guardCode(text, label) {
  if (typeof text !== "string") throw new Error(label + " must be a string of code. Pass the code itself as text.");
  if (text.length > MAX_CODE) throw new Error(label + " is over the " + MAX_CODE + " character limit. Cut it down, then try again.");
  return text;
}

function cardEditorInstructions(dataRoot) {
  let rules = "";
  try {
    const { listUserRules, userRulesPrompt } = require("./user-rules");
    rules = userRulesPrompt(listUserRules(dataRoot));
  } catch {
    /* an unreadable rules store must not break the handshake */
  }
  return (
    "You are editing JV edit cards. Everything the card studio offers is a tool here: cards_list and cards_get to read, cards_set_text, cards_set_style, cards_set_block_layout, cards_set_code and cards_edit_code (HTML and CSS), cards_images, cards_set_end_screen, cards_apply_template, cards_duplicate, cards_move, cards_undo, cards_render to look at the result, and cards_delete (the user is asked to confirm, and cards_restore_deleted brings a card back). " +
    "Read the card first, make the change, then call cards_render with asImage and look at it before saying it is done. Text positions are 0-1 fractions of the card (x, y, width), fontSize is in px on a 390 px wide stage. Copy limits: headline 160, body 300, eyebrow 80, cta 120 characters. HTML cards use var(--primary), var(--secondary), var(--text), custom vars, and {{image:<libraryId>}}; scripts and external loads are stripped. " +
    "Read the matching skill with cards_get_skill before designing (design-slop, writing-slop for the words, card-design, type-layout, color-on-video, html-cards, motion-graphics). Never delete a card unless the user asked for that card to go." +
    (rules ? "\n\n" + rules : "")
  );
}

function cardEditorSpecs(hooks) {
  const live = hooks || {};
  const specs = [
    {
      name: "cards_list",
      description: "List every edit card in the workspace with its name, placement, duration, shape, and headline. Start here when you do not have a card id.",
      inputSchema: obj({ workspaceId: WS }),
      async run(ctx, input) {
        const ws = await openWorkspace(ctx, input);
        return { workspaceId: ws.id, count: ws.cards.length, cards: ws.cards.map((card) => view(card)) };
      },
    },
    {
      name: "cards_get",
      description: "Read one card in full: text, colors, text layout, image layout, html, css, vars, motion, end screen. The drawing layer is reported as hasDrawing only.",
      inputSchema: obj({ cardId: CARD, workspaceId: WS }, ["cardId"]),
      async run(ctx, input) {
        const ws = await openWorkspace(ctx, input);
        return { workspaceId: ws.id, card: view(ws.cards[findIndex(ws, input.cardId)], true) };
      },
    },
    {
      name: "cards_app_state",
      description: "Read what the user sees in the JV window: the page, the card open in the studio, and which card tab is active.",
      inputSchema: obj({}),
      async run() {
        if (!live.appState) throw new Error("The JV window is not connected. Open JV, then call cards_app_state again.");
        return live.appState();
      },
    },
    {
      name: "cards_open",
      description: "Open a card in the card studio so the user sees it. Use when pointing the user at a card you changed.",
      inputSchema: obj({ cardId: CARD }, ["cardId"]),
      async run(_ctx, input) {
        if (!live.openCard) throw new Error("The JV window is not connected. Open JV, then call cards_open again.");
        return live.openCard(input.cardId);
      },
    },
    {
      name: "cards_create",
      description:
        "Make a new card. template is an id from cards_list_templates (omit for a blank card). patch can carry any card fields (see cards_update). New cards go to the front of the list. Use when the design does not exist yet.",
      inputSchema: obj({
        name: { type: "string", description: "Card name, up to 100 characters." },
        template: { type: "string", description: "Template id from cards_list_templates. Omit for a blank card." },
        patch: { type: "object", description: "Card fields merged over the template or blank card." },
        workspaceId: WS,
      }),
      async run(ctx, input) {
        const patch = Object.assign({}, plain(input.patch) ? input.patch : {});
        if (input.template) {
          knownTemplate(ctx, input.template);
          patch.template = String(input.template);
        }
        checkPatch(patch);
        if (input.name) patch.name = String(input.name).slice(0, 100);
        const result = await applyCardEdit({ dataRoot: ctx.dataRoot, workspaceId: input.workspaceId || (ctx.meta && ctx.meta.workspaceId) || undefined, patch });
        return { workspaceId: result.snapshot.workspace.id, card: view(result.card, true) };
      },
    },
    {
      name: "cards_update",
      description: "Merge any card fields at once, the same patch shape the studio saves. Use when no focused tool fits the change.",
      inputSchema: obj(
        {
          cardId: CARD,
          patch: {
            type: "object",
            description:
              "Card fields: name, description, kind, placement, durationMs (500-60000), motion {in,out}, endScreen, endScreenDurationMs, endScreenBackgroundId, endScreenFit, endScreenTreatment, drawing, imageIds; colors {primary,secondary,text}; composition {aspectRatio, headline, body, eyebrow, cta, align, surface, backgroundId, blockLayout, imageLayouts, html, css, vars}.",
          },
          workspaceId: WS,
        },
        ["cardId", "patch"],
      ),
      async run(ctx, input) {
        if (!plain(input.patch)) throw new Error("patch must be an object of card fields, for example { \"durationMs\": 3000 }.");
        checkPatch(input.patch);
        const ws = await openWorkspace(ctx, input);
        const current = ws.cards[findIndex(ws, input.cardId)];
        const patch = Object.assign({}, input.patch);
        delete patch.id;
        const result = await applyCardEdit({ dataRoot: ctx.dataRoot, workspaceId: ws.id, cardId: input.cardId, patch });
        remember(ws.id, current);
        return { workspaceId: ws.id, card: view(result.card) };
      },
    },
    {
      name: "cards_set_text",
      description:
        "Set the card copy. Pass only the fields to change; an empty string removes that text box. headline max 160, body 300, eyebrow 80, cta 120 characters. align sets the default text alignment.",
      inputSchema: obj(
        {
          cardId: CARD,
          headline: { type: "string", description: "Headline text, up to 160 characters. Empty removes it." },
          body: { type: "string", description: "Body text, up to 300 characters. Empty removes it." },
          eyebrow: { type: "string", description: "Small label above the headline, up to 80 characters. Empty removes it." },
          cta: { type: "string", description: "Call to action line, up to 120 characters. Empty removes it." },
          align: ALIGN,
          workspaceId: WS,
        },
        ["cardId"],
      ),
      async run(ctx, input) {
        const changed = TEXT_FIELDS.filter((field) => input[field] !== undefined).concat(input.align !== undefined ? ["align"] : []);
        if (!changed.length) throw new Error("Nothing to change. Pass headline, body, eyebrow, cta, or align.");
        return mutate(ctx, input, (card) => {
          for (const field of TEXT_FIELDS) {
            if (input[field] === undefined) continue;
            const text = String(input[field] == null ? "" : input[field]).slice(0, LIMITS[field]);
            card.composition[field] = text;
            if (!text) delete card.composition.blockLayout[field];
          }
          if (input.align !== undefined) card.composition.align = input.align;
          return { changed };
        });
      },
    },
    {
      name: "cards_set_style",
      description: "Restyle a card: name, description, colors, surface, aspect ratio, placement, duration, kind, motion. Use when the change is visual rather than copy.",
      inputSchema: obj(
        {
          cardId: CARD,
          name: { type: "string", description: "Card name, up to 100 characters." },
          description: { type: "string", description: "Why this card exists, up to 2000 characters." },
          primary: HEX,
          secondary: HEX,
          text: HEX,
          surface: { type: "string", enum: ["solid", "soft", "transparent"], description: "Card background treatment." },
          aspectRatio: { type: "string", enum: ["vertical", "landscape", "square"], description: "Card shape: 9:16, 16:9, or 1:1." },
          placement: PLACEMENT,
          durationMs: DURATION_MS,
          kind: { type: "string", enum: ["title_card", "overlay"], description: "Title card, or overlay on the footage." },
          motion: { type: "object", description: "Entrance and exit presets, {in, out}.", properties: { in: MOTION, out: MOTION } },
          workspaceId: WS,
        },
        ["cardId"],
      ),
      async run(ctx, input) {
        const keys = ["name", "description", "primary", "secondary", "text", "surface", "aspectRatio", "placement", "durationMs", "kind", "motion"];
        const changed = keys.filter((key) => input[key] !== undefined);
        if (!changed.length) {
          throw new Error("Nothing to change. Pass at least one of name, description, colors, surface, aspectRatio, placement, durationMs, kind or motion.");
        }
        const hex = /^#[0-9a-f]{6}$/i;
        for (const key of ["primary", "secondary", "text"]) {
          if (input[key] !== undefined && !hex.test(String(input[key]))) {
            throw new Error(key + " must be a #RRGGBB color, for example #1F6F56.");
          }
        }
        if (input.durationMs !== undefined) checkDuration(input.durationMs);
        return mutate(ctx, input, (card) => {
          if (input.name !== undefined) card.name = String(input.name).trim().slice(0, 100) || card.name;
          if (input.description !== undefined) card.description = String(input.description).slice(0, 2000);
          for (const key of ["primary", "secondary", "text"]) if (input[key] !== undefined) card.colors[key] = String(input[key]).toUpperCase();
          if (input.surface !== undefined) card.composition.surface = input.surface;
          if (input.aspectRatio !== undefined) card.composition.aspectRatio = input.aspectRatio;
          if (input.placement !== undefined) card.placement = input.placement;
          if (input.durationMs !== undefined) card.durationMs = input.durationMs;
          if (input.kind !== undefined) card.kind = input.kind;
          if (plain(input.motion)) card.motion = Object.assign({}, card.motion, input.motion);
          return { changed };
        });
      },
    },
    {
      name: "cards_set_block_layout",
      description:
        "Position and format one text box. field is headline|body|eyebrow|cta. x, y, width are 0-1 fractions of the card; fontSize in px; color hex; align left|center|right; bold; highlight. reset true drops the custom layout so the field returns to its default spot.",
      inputSchema: obj(
        {
          cardId: CARD,
          field: { type: "string", enum: TEXT_FIELDS, description: "Text box to change." },
          x: { type: "number", minimum: 0, maximum: 1, description: "Left edge, 0-1 of the card width." },
          y: { type: "number", minimum: 0, maximum: 0.95, description: "Top edge, 0-1 of the card height." },
          width: { type: "number", minimum: 0.1, maximum: 1, description: "Box width, 0.1-1 of the card width." },
          fontSize: { type: "number", minimum: 8, maximum: 160, description: "Font size in stage px." },
          color: { type: "string", description: "Text color, #RRGGBB." },
          align: ALIGN,
          bold: { type: "boolean", description: "Bold text." },
          highlight: { type: "string", description: "Highlight color, #RRGGBB, or empty for none." },
          reset: { type: "boolean", description: "Drop the custom layout and return the field to its default spot." },
          workspaceId: WS,
        },
        ["cardId", "field"],
      ),
      async run(ctx, input) {
        if (!TEXT_FIELDS.includes(input.field)) {
          throw new Error("field must be one of " + TEXT_FIELDS.join(", ") + ". These are the card's text boxes; call cards_get to see their copy.");
        }
        const layoutKeys = LAYOUT_KEYS.filter((key) => input[key] !== undefined);
        if (input.reset !== true && !layoutKeys.length) {
          throw new Error("Pass at least one of x, y, width, fontSize, color, align, bold or highlight, or reset: true to drop the custom layout.");
        }
        return mutate(ctx, input, (card) => {
          const layouts = card.composition.blockLayout;
          if (input.reset === true) delete layouts[input.field];
          else layouts[input.field] = Object.assign({}, layouts[input.field], cleanLayout(input));
          return { field: input.field, layout: layouts[input.field] || null };
        });
      },
    },
    {
      name: "cards_set_code",
      description: "Write the card's HTML and CSS. Pass only the parts to change; an empty html turns the card back into a text card. Use for designed cards after cards_get.",
      inputSchema: obj(
        {
          cardId: CARD,
          html: {
            type: "string",
            description:
              "Card markup, up to 200000 characters. Colors reach the page as var(--primary), var(--secondary), var(--text); {{image:<libraryId>}} embeds a library image; scripts, iframes and external loads are stripped.",
          },
          css: { type: "string", description: "Stylesheet, up to 200000 characters. @keyframes animate the card inside videos." },
          vars: { type: "object", description: "Custom variables, e.g. {accent:'#DFF56A'}, available as var(--accent)." },
          workspaceId: WS,
        },
        ["cardId"],
      ),
      async run(ctx, input) {
        if (input.html === undefined && input.css === undefined && input.vars === undefined) throw new Error("Pass html, css, or vars.");
        return mutate(ctx, input, (card) => {
          if (input.html !== undefined) card.composition.html = guardCode(input.html, "html");
          if (input.css !== undefined) card.composition.css = guardCode(input.css, "css");
          if (input.vars !== undefined) {
            if (!plain(input.vars)) throw new Error("vars must be an object of CSS variables, for example { \"accent\": \"#DFF56A\" }.");
            const vars = {};
            for (const key of Object.keys(input.vars)) {
              if (/^[a-z][a-z0-9-]{0,40}$/i.test(key)) vars[key] = String(input.vars[key]).slice(0, 200);
            }
            card.composition.vars = vars;
          }
          return { htmlLength: card.composition.html.length, cssLength: card.composition.css.length };
        });
      },
    },
    {
      name: "cards_edit_code",
      description:
        "Change the card's code without resending all of it. target is html or css. Use find with replace for an exact text swap (all occurrences when replaceAll is true; the call fails if find is not in the code), or append / prepend to add code at the end or start.",
      inputSchema: obj(
        {
          cardId: CARD,
          target: { type: "string", enum: ["html", "css"], description: "Code to change." },
          find: { type: "string", description: "Exact text to find in the target code." },
          replace: { type: "string", description: "Replacement for find. Empty deletes the found text." },
          replaceAll: { type: "boolean", description: "Replace every occurrence, not just the first." },
          append: { type: "string", description: "Code added after the current code." },
          prepend: { type: "string", description: "Code added before the current code." },
          workspaceId: WS,
        },
        ["cardId", "target"],
      ),
      async run(ctx, input) {
        return mutate(ctx, input, (card) => {
          const target = codeTarget(card, input.target);
          let code = card.composition[target] || "";
          if (input.find !== undefined) {
            const find = String(input.find);
            if (!find) throw new Error("find cannot be empty. Pass the exact text to replace.");
            if (!code.includes(find)) throw new Error("That find text is not in the " + target + ". Copy it exactly from the code, then try again.");
            const replacement = String(input.replace == null ? "" : input.replace);
            code = input.replaceAll === true ? code.split(find).join(replacement) : code.replace(find, () => replacement);
          } else if (input.append === undefined && input.prepend === undefined) {
            throw new Error("Pass find with replace, or append or prepend, to change the " + target + ".");
          }
          if (input.prepend !== undefined) code = String(input.prepend) + code;
          if (input.append !== undefined) code = code + String(input.append);
          card.composition[target] = guardCode(code, target);
          return { target, length: code.length };
        });
      },
    },
    {
      name: "cards_list_images",
      description: "List the images in the library that a card can use, with ids and names. Use before cards_images, which takes these ids.",
      inputSchema: obj({ workspaceId: WS }),
      async run(ctx, input) {
        const ws = await openWorkspace(ctx, input);
        const images = (ws.library || []).filter((item) => item.kind === "image").map((item) => ({ id: item.id, name: item.name, width: item.width, height: item.height }));
        return { workspaceId: ws.id, images };
      },
    },
    {
      name: "cards_images",
      description: "Manage the images on a card: add, remove, reorder, set the background, place them, or import a file. Use when a card needs pictures.",
      inputSchema: obj(
        {
          cardId: CARD,
          add: { type: "array", items: { type: "string" }, description: "Library image ids to put on the card." },
          remove: { type: "array", items: { type: "string" }, description: "Library image ids to take off the card." },
          order: { type: "array", items: { type: "string" }, description: "Full stacking order, back to front, by library image id." },
          backgroundId: { type: "string", description: "Library image id to use as the card background." },
          clearBackground: { type: "boolean", description: "Remove the background image." },
          layouts: { type: "object", description: "Placement per image id: {imageId: {x, y, width, height}} as 0-1 fractions." },
          importPath: { type: "string", description: "Absolute path to a PNG, JPG, or WEBP file." },
          workspaceId: WS,
        },
        ["cardId"],
      ),
      async run(ctx, input) {
        let imported = "";
        if (input.importPath) {
          const ws = await openWorkspace(ctx, input);
          const added = await copyPathIntoLibrary(ctx.dataRoot, String(input.importPath), { workspaceId: ws.id, source: "agent" });
          if (!added.item || added.item.kind !== "image") throw new Error("That file is not an image. Pass a PNG, JPEG, WebP or GIF.");
          imported = added.item.id;
        }
        return mutate(ctx, input, (card, ws) => {
          let ids = Array.isArray(card.imageIds) ? card.imageIds.slice() : [];
          for (const id of (input.add || []).concat(imported ? [imported] : [])) {
            libraryImage(ws, id);
            if (!ids.includes(id)) ids.push(id);
          }
          if (Array.isArray(input.remove)) {
            ids = ids.filter((id) => !input.remove.includes(id));
            for (const id of input.remove) delete card.composition.imageLayouts[id];
            if (input.remove.includes(card.composition.backgroundId)) card.composition.backgroundId = "";
          }
          if (Array.isArray(input.order)) {
            const unknown = input.order.filter((id) => !ids.includes(id));
            if (unknown.length) throw new Error("order names images that are not on this card: " + unknown.map(idText).join(", ") + ". Call cards_get to see the card's image ids.");
            ids = input.order.concat(ids.filter((id) => !input.order.includes(id)));
          }
          card.imageIds = ids;
          if (input.backgroundId) {
            libraryImage(ws, input.backgroundId);
            card.composition.backgroundId = String(input.backgroundId);
          }
          if (input.clearBackground === true) card.composition.backgroundId = "";
          if (plain(input.layouts)) {
            for (const id of Object.keys(input.layouts)) {
              if (!ids.includes(id)) throw new Error("layouts names an image that is not on this card: " + idText(id) + ". Add it with cards_images first.");
              const l = input.layouts[id] || {};
              const next = Object.assign({}, card.composition.imageLayouts[id]);
              for (const key of ["x", "y", "width", "height"]) if (l[key] !== undefined) next[key] = clamp(l[key], 0, 1);
              card.composition.imageLayouts[id] = next;
            }
          }
          return { imageIds: card.imageIds, backgroundId: card.composition.backgroundId || "", imported: imported || undefined };
        });
      },
    },
    {
      name: "cards_set_end_screen",
      description: "Control the end screen shown after the card: on or off, its length, background image, fit and treatment. Use when the card should end on a full screen.",
      inputSchema: obj(
        {
          cardId: CARD,
          enabled: { type: "boolean", description: "Turn the end screen on or off." },
          durationMs: { type: "number", minimum: 500, maximum: 60000, description: "How long the end screen shows, 500 to 60000 ms." },
          backgroundId: { type: "string", description: "Library image id for the end screen background. Empty removes it." },
          fit: { type: "string", enum: ["cover", "contain"], description: "How the image fills the frame." },
          treatment: { type: "string", enum: ["none", "dim", "blur"], description: "Treatment over the image." },
          workspaceId: WS,
        },
        ["cardId"],
      ),
      async run(ctx, input) {
        return mutate(ctx, input, (card, ws) => {
          if (input.enabled !== undefined) card.endScreen = input.enabled === true;
          if (input.durationMs !== undefined) card.endScreenDurationMs = clamp(input.durationMs, 500, 60000);
          if (input.backgroundId !== undefined) {
            if (input.backgroundId) libraryImage(ws, input.backgroundId);
            card.endScreenBackgroundId = String(input.backgroundId || "");
          }
          if (input.fit !== undefined) card.endScreenFit = String(input.fit);
          if (input.treatment !== undefined) card.endScreenTreatment = String(input.treatment);
        });
      },
    },
    {
      name: "cards_clear_drawing",
      description: "Erase the freehand drawing layer on a card. Text, images, and code stay.",
      inputSchema: obj({ cardId: CARD, workspaceId: WS }, ["cardId"]),
      async run(ctx, input) {
        return mutate(ctx, input, (card) => {
          card.drawing = "";
        });
      },
    },
    {
      name: "cards_list_templates",
      description: "List card templates: built-ins plus the user's installed and saved ones. Use an id with cards_create or cards_apply_template.",
      inputSchema: obj({ category: { type: "string", description: "Only templates in this category." } }),
      async run(ctx, input) {
        let templates = cardTemplateStore.listStoreTemplates(ctx.dataRoot);
        if (input.category) templates = templates.filter((item) => String(item.category || "").toLowerCase() === String(input.category).toLowerCase());
        return { templates: templates.map((item) => ({ id: item.id, name: item.name, category: item.category, description: item.description, source: item.source })) };
      },
    },
    {
      name: "cards_apply_template",
      description: "Restyle an existing card with a template. The template's design replaces the card's current look. cards_undo brings the old look back.",
      inputSchema: obj({ cardId: CARD, templateId: { type: "string", description: "Template id from cards_list_templates." }, workspaceId: WS }, ["cardId", "templateId"]),
      async run(ctx, input) {
        const ws = await openWorkspace(ctx, input);
        const current = ws.cards[findIndex(ws, input.cardId)];
        knownTemplate(ctx, input.templateId);
        const result = await applyCardEdit({ dataRoot: ctx.dataRoot, workspaceId: ws.id, cardId: input.cardId, patch: { template: String(input.templateId) } });
        remember(ws.id, current);
        return { workspaceId: ws.id, card: view(result.card) };
      },
    },
    {
      name: "cards_save_as_template",
      description: "Save a card's design as a reusable template in the user's template collection. Use when a finished design should be available to other cards.",
      inputSchema: obj({ cardId: CARD, workspaceId: WS }, ["cardId"]),
      async run(ctx, input) {
        const ws = await openWorkspace(ctx, input);
        const template = cardTemplateStore.saveCardAsTemplate(ctx.dataRoot, ws.cards[findIndex(ws, input.cardId)]);
        return { template };
      },
    },
    {
      name: "cards_duplicate",
      description: "Copy a card into a new card. The copy goes to the front of the list.",
      inputSchema: obj({ cardId: CARD, name: { type: "string", description: "Name for the copy. Defaults to the original name plus copy." }, workspaceId: WS }, ["cardId"]),
      async run(ctx, input) {
        const ws = await openWorkspace(ctx, input);
        const card = ws.cards[findIndex(ws, input.cardId)];
        const copy = clone(card);
        delete copy.id;
        copy.name = String(input.name || card.name + " copy").slice(0, 100);
        const result = await applyCardEdit({ dataRoot: ctx.dataRoot, workspaceId: ws.id, patch: copy });
        return { workspaceId: ws.id, card: view(result.card) };
      },
    },
    {
      name: "cards_rename",
      description: "Rename a card. Use when the name no longer matches what the card says.",
      inputSchema: obj({ cardId: CARD, name: { type: "string", description: "New name, up to 100 characters." }, workspaceId: WS }, ["cardId", "name"]),
      async run(ctx, input) {
        const name = String(input.name || "").trim().slice(0, 100);
        if (!name) throw new Error("name cannot be empty. Give the card a name of a few words.");
        return mutate(ctx, input, (card) => {
          card.name = name;
        });
      },
    },
    {
      name: "cards_move",
      description: "Change a card's place in the list. position 0 is the front.",
      inputSchema: obj({ cardId: CARD, position: { type: "number", minimum: 0, description: "New place in the list, 0 is the front." }, workspaceId: WS }, ["cardId", "position"]),
      async run(ctx, input) {
        const ws = await openWorkspace(ctx, input);
        const index = findIndex(ws, input.cardId);
        const [card] = ws.cards.splice(index, 1);
        const to = Math.round(clamp(input.position, 0, ws.cards.length));
        ws.cards.splice(to, 0, card);
        await saveWorkspace(ctx.dataRoot, ws);
        return { workspaceId: ws.id, order: ws.cards.map((item) => ({ id: item.id, name: item.name })) };
      },
    },
    {
      name: "cards_delete",
      description:
        "Delete one or more cards. The user is asked to confirm in the app before anything is removed, and the call fails if they decline. Pass confirm true. Media files stay in the library. cards_restore_deleted brings a deleted card back until JV closes.",
      inputSchema: obj(
        {
          cardIds: { type: "array", items: { type: "string" }, description: "Ids of the cards to delete." },
          confirm: { type: "boolean", description: "Must be true." },
          workspaceId: WS,
        },
        ["cardIds", "confirm"],
      ),
      needsApproval: true,
      async run(ctx, input) {
        if (input.confirm !== true) throw new Error("Pass confirm: true to delete cards.");
        if (!ctx.approved) throw new Error("Deleting cards needs the JV app open so the user can confirm. Open JV and try again.");
        const ids = Array.from(new Set((input.cardIds || []).map(String)));
        if (!ids.length) throw new Error("cardIds is empty. Pass the ids of the cards to delete, from cards_list.");
        const ws = await openWorkspace(ctx, input);
        for (const id of ids) findIndex(ws, id);
        for (const card of ws.cards) if (ids.includes(card.id)) trash.set(ws.id + ":" + card.id, { card: clone(card), at: Date.now() });
        ws.cards = ws.cards.filter((card) => !ids.includes(card.id));
        await saveWorkspace(ctx.dataRoot, ws);
        return { workspaceId: ws.id, deleted: ids, remaining: ws.cards.length };
      },
    },
    {
      name: "cards_restore_deleted",
      description: "Bring back a card deleted earlier in this JV session. Omit cardId to restore the most recent one.",
      inputSchema: obj({ cardId: CARD, workspaceId: WS }),
      async run(ctx, input) {
        const ws = await openWorkspace(ctx, input);
        const entries = Array.from(trash.entries()).filter(([key]) => key.startsWith(ws.id + ":"));
        const pick = input.cardId ? entries.find(([key]) => key === ws.id + ":" + input.cardId) : entries.sort((a, b) => b[1].at - a[1].at)[0];
        if (!pick) throw new Error("There is nothing to restore: no card was deleted in this JV session.");
        if (ws.cards.some((card) => card.id === pick[1].card.id)) throw new Error("A card with that id already exists. Call cards_list for the ids this workspace has.");
        ws.cards.unshift(pick[1].card);
        trash.delete(pick[0]);
        await saveWorkspace(ctx.dataRoot, ws);
        return { workspaceId: ws.id, card: view(pick[1].card) };
      },
    },
    {
      name: "cards_undo",
      description: "Undo the last agent change to a card (up to 40 steps). Changes the user made by hand in the studio are not in this stack.",
      inputSchema: obj({ cardId: CARD, workspaceId: WS }, ["cardId"]),
      async run(ctx, input) {
        return step(ctx, input, "past", "future");
      },
    },
    {
      name: "cards_redo",
      description: "Redo a change that cards_undo reverted.",
      inputSchema: obj({ cardId: CARD, workspaceId: WS }, ["cardId"]),
      async run(ctx, input) {
        return step(ctx, input, "future", "past");
      },
    },
    {
      name: "cards_render",
      description:
        "Rasterize a card to a PNG exactly as the video pipeline burns it. asImage (default true) returns the picture so you can check the design. atMs freezes CSS animation at that millisecond. Always render after a visual change.",
      inputSchema: obj(
        {
          cardId: CARD,
          asImage: { type: "boolean", default: true, description: "Return the PNG so you can look at it. Default true." },
          atMs: { type: "number", minimum: 0, description: "Freeze CSS animation at this millisecond." },
          transparent: { type: "boolean", description: "PNG with a transparent background." },
          workspaceId: WS,
        },
        ["cardId"],
      ),
      async run(ctx, input) {
        const { renderCardPng, findFfmpeg, findFont } = require("./card-render");
        const ws = await openWorkspace(ctx, input);
        const card = ws.cards[findIndex(ws, input.cardId)];
        const outDir = path.join(workspaceDir(ctx.dataRoot, ws.id), "renders");
        await fs.promises.mkdir(outDir, { recursive: true });
        const rendered = await renderCardPng({
          dataRoot: ctx.dataRoot,
          workspaceId: ws.id,
          card,
          outPath: path.join(outDir, card.id + ".png"),
          ffmpeg: findFfmpeg(),
          font: findFont(),
          transparent: input.transparent === true,
          atMs: input.atMs,
          appRoot: ctx.appRoot,
        });
        const info = { path: rendered.path, width: rendered.width, height: rendered.height, card: card.name };
        if (input.asImage === false) return info;
        return {
          content: [
            { type: "text", text: JSON.stringify(info) },
            { type: "image", data: (await fs.promises.readFile(rendered.path)).toString("base64"), mimeType: "image/png" },
          ],
        };
      },
    },
    {
      name: "cards_list_skills",
      description: "List the JV design skills (design-slop, card-design, type-layout, color-on-video, html-cards, motion-graphics, and others). Read one with cards_get_skill.",
      inputSchema: obj({}),
      async run(ctx) {
        const { discoverSkills } = require("./skills");
        return { skills: discoverSkills(ctx.appRoot, { dataRoot: ctx.dataRoot }).map((skill) => ({ name: skill.name, description: skill.description })) };
      },
    },
    {
      name: "cards_get_skill",
      description: "Read one design skill by name before designing a card.",
      inputSchema: obj({ name: { type: "string", description: "Skill name from cards_list_skills." } }, ["name"]),
      async run(ctx, input) {
        const { findSkill } = require("./skills");
        const skill = findSkill(ctx.appRoot, String(input.name || ""), { dataRoot: ctx.dataRoot });
        if (!skill) throw new Error("No skill named " + idText(input.name) + ". Call cards_list_skills for the names this server has.");
        return { name: skill.name, text: await fs.promises.readFile(skill.path, "utf8") };
      },
    },
  ];

  async function step(ctx, input, from, to) {
    const ws = await openWorkspace(ctx, input);
    const index = findIndex(ws, input.cardId);
    const h = historyFor(ws.id, input.cardId);
    if (!h[from].length) {
      throw new Error(
        from === "past"
          ? "Nothing to undo for this card. Change it with cards_set_text or cards_update first."
          : "Nothing to redo for this card. Call cards_undo first so there is a change to redo.",
      );
    }
    h[to].push(JSON.stringify(ws.cards[index]));
    const restored = JSON.parse(h[from].pop());
    restored.updatedAt = new Date().toISOString();
    ws.cards[index] = restored;
    await saveWorkspace(ctx.dataRoot, ws);
    return { workspaceId: ws.id, card: view(restored), undoLeft: h.past.length, redoLeft: h.future.length };
  }

  for (const spec of specs) spec.mutates = !/^cards_(list|get|app_state|render|open|list_skills|get_skill|list_images|list_templates|save_as_template)/.test(spec.name);
  return specs;
}

module.exports = { SERVER_NAME, cardEditorSpecs, cardEditorInstructions, defaultCard, snapshot };
