"use strict";

// Built-in card designs. A template is just a card patch: applyCardEdit merges
// these defaults before the caller's patch, so a template is a starting point
// a person or an agent can still change freely. Shared by the renderer
// (template gallery) and the MCP tools (patch.templateId).
//
// listCardTemplates(dataRoot) merges this catalog with the user's template
// store (lib/card-template-store.js): templates installed into or saved to
// <dataRoot>/card-template-store.json flow to the same template picker.

function block(x, y, width, fontSize, extra) {
  return Object.assign({ x, y, width, fontSize }, extra || {});
}

const CATEGORY_HOOKS = "Hooks & intros";
const CATEGORY_CTA = "Calls to action";
const CATEGORY_END = "End screens";
const CATEGORY_QUOTES = "Quotes";
const CATEGORY_PROMOS = "Promos";
const CATEGORY_OVERLAYS = "Overlays & lower thirds";

const TEMPLATES = [
  {
    id: "hook",
    name: "Hook headline",
    description: "Big centered hook for the first seconds of a clip.",
    category: CATEGORY_HOOKS,
    placement: "intro",
    durationMs: 2500,
    card: {
      name: "Hook headline",
      kind: "title_card",
      colors: { primary: "#151A24", secondary: "#DFF56A", text: "#FFFFFF" },
      composition: {
        aspectRatio: "vertical",
        surface: "solid",
        align: "center",
        eyebrow: "WATCH THIS",
        headline: "Your hook goes here",
        blockLayout: {
          eyebrow: block(0.15, 0.3, 0.7, 22, { align: "center", color: "#DFF56A" }),
          headline: block(0.1, 0.38, 0.8, 64, { align: "center", bold: true }),
        },
      },
    },
  },
  {
    id: "cold-open",
    name: "Cold open",
    description: "Oversized statement that opens the clip mid-thought.",
    category: CATEGORY_HOOKS,
    placement: "intro",
    durationMs: 2200,
    card: {
      name: "Cold open",
      kind: "title_card",
      colors: { primary: "#0B0F19", secondary: "#8AD4FF", text: "#FFFFFF" },
      composition: {
        aspectRatio: "vertical",
        surface: "solid",
        align: "left",
        headline: "Nobody expected this.",
        body: "Keep watching.",
        blockLayout: {
          headline: block(0.08, 0.34, 0.84, 72, { bold: true }),
          body: block(0.08, 0.56, 0.6, 24, { color: "#8AD4FF" }),
        },
      },
    },
  },
  {
    id: "episode-title",
    name: "Episode title",
    description: "Series-style title card with an episode eyebrow.",
    category: CATEGORY_HOOKS,
    placement: "intro",
    durationMs: 3000,
    card: {
      name: "Episode title",
      kind: "title_card",
      colors: { primary: "#2A1E12", secondary: "#F2B544", text: "#FFF7EA" },
      composition: {
        aspectRatio: "vertical",
        surface: "solid",
        align: "center",
        eyebrow: "EPISODE 01",
        headline: "The big idea",
        body: "A short subtitle line.",
        blockLayout: {
          eyebrow: block(0.25, 0.28, 0.5, 20, { align: "center", color: "#F2B544" }),
          headline: block(0.12, 0.38, 0.76, 58, { align: "center", bold: true }),
          body: block(0.2, 0.54, 0.6, 24, { align: "center", color: "#E8D9C0" }),
        },
      },
    },
  },
  {
    id: "lower-third",
    name: "Lower third",
    description: "Name/title bar over the lower part of the footage.",
    category: CATEGORY_OVERLAYS,
    placement: "overlay",
    durationMs: 4000,
    card: {
      name: "Lower third",
      kind: "overlay",
      colors: { primary: "#0E1421", secondary: "#DFF56A", text: "#FFFFFF" },
      composition: {
        aspectRatio: "landscape",
        surface: "transparent",
        align: "left",
        eyebrow: "SPEAKER",
        headline: "Name goes here",
        body: "Title or role",
        blockLayout: {
          eyebrow: block(0.06, 0.68, 0.4, 18, { color: "#DFF56A" }),
          headline: block(0.06, 0.74, 0.5, 44, { bold: true }),
          body: block(0.06, 0.86, 0.5, 24, { bold: false, color: "#DDE3EA" }),
        },
      },
    },
  },
  {
    id: "overlay-banner",
    name: "Banner strip",
    description: "Compact strip along the bottom for a key point or link.",
    category: CATEGORY_OVERLAYS,
    placement: "overlay",
    durationMs: 3500,
    card: {
      name: "Banner strip",
      kind: "overlay",
      colors: { primary: "#12161F", secondary: "#7CE7C4", text: "#FFFFFF" },
      composition: {
        aspectRatio: "landscape",
        surface: "transparent",
        align: "left",
        headline: "Key point goes here",
        cta: "cutline.app",
        blockLayout: {
          headline: block(0.06, 0.78, 0.62, 30, { bold: true }),
          cta: block(0.7, 0.79, 0.24, 22, {
            align: "center",
            color: "#12161F",
            highlight: "#7CE7C4",
          }),
        },
      },
    },
  },
  {
    id: "cta-end",
    name: "CTA end card",
    description: "Closing card with a call to action.",
    category: CATEGORY_CTA,
    placement: "end",
    durationMs: 3000,
    card: {
      name: "CTA end card",
      kind: "title_card",
      colors: { primary: "#1F6F56", secondary: "#DFF56A", text: "#FFFFFF" },
      composition: {
        aspectRatio: "vertical",
        surface: "solid",
        align: "center",
        headline: "Thanks for watching",
        cta: "Follow for more",
        blockLayout: {
          headline: block(0.12, 0.36, 0.76, 52, { align: "center", bold: true }),
          cta: block(0.24, 0.56, 0.52, 28, {
            align: "center",
            color: "#151A24",
            highlight: "#DFF56A",
          }),
        },
      },
    },
  },
  {
    id: "follow-cta",
    name: "Follow banner",
    description: "Small overlay nudge to follow the channel or handle.",
    category: CATEGORY_CTA,
    placement: "overlay",
    durationMs: 3000,
    card: {
      name: "Follow banner",
      kind: "overlay",
      colors: { primary: "#151A24", secondary: "#FF7A59", text: "#FFFFFF" },
      composition: {
        aspectRatio: "landscape",
        surface: "transparent",
        align: "left",
        eyebrow: "FOLLOW",
        headline: "@yourhandle",
        blockLayout: {
          eyebrow: block(0.06, 0.72, 0.3, 18, { color: "#FF7A59" }),
          headline: block(0.06, 0.78, 0.44, 40, { bold: true }),
        },
      },
    },
  },
  {
    id: "subscribe-cta",
    name: "Subscribe card",
    description: "Mid or late card asking viewers to subscribe.",
    category: CATEGORY_CTA,
    placement: "auto",
    durationMs: 3000,
    card: {
      name: "Subscribe card",
      kind: "title_card",
      colors: { primary: "#3A0CA3", secondary: "#F72585", text: "#FFFFFF" },
      composition: {
        aspectRatio: "vertical",
        surface: "solid",
        align: "center",
        headline: "Want more like this?",
        cta: "Subscribe",
        blockLayout: {
          headline: block(0.14, 0.36, 0.72, 48, { align: "center", bold: true }),
          cta: block(0.3, 0.54, 0.4, 30, {
            align: "center",
            color: "#FFFFFF",
            highlight: "#F72585",
          }),
        },
      },
    },
  },
  {
    id: "watch-next",
    name: "Watch next",
    description: "End screen pointing at the next video.",
    category: CATEGORY_END,
    placement: "end",
    durationMs: 4000,
    card: {
      name: "Watch next",
      kind: "title_card",
      colors: { primary: "#101418", secondary: "#9DB2FF", text: "#FFFFFF" },
      composition: {
        aspectRatio: "vertical",
        surface: "solid",
        align: "center",
        eyebrow: "UP NEXT",
        headline: "Keep watching",
        cta: "Next video",
        blockLayout: {
          eyebrow: block(0.28, 0.3, 0.44, 20, { align: "center", color: "#9DB2FF" }),
          headline: block(0.14, 0.4, 0.72, 50, { align: "center", bold: true }),
          cta: block(0.28, 0.58, 0.44, 26, {
            align: "center",
            color: "#101418",
            highlight: "#9DB2FF",
          }),
        },
      },
    },
  },
  {
    id: "credits",
    name: "Credits card",
    description: "Quiet closing card for credits and thanks.",
    category: CATEGORY_END,
    placement: "end",
    durationMs: 4000,
    card: {
      name: "Credits card",
      kind: "title_card",
      colors: { primary: "#14171C", secondary: "#C9D4E3", text: "#E8EDF2" },
      composition: {
        aspectRatio: "vertical",
        surface: "solid",
        align: "center",
        headline: "Thanks for watching",
        body: "Created by Your Name\nMade with JV",
        blockLayout: {
          headline: block(0.16, 0.34, 0.68, 34, { align: "center", bold: true }),
          body: block(0.18, 0.5, 0.64, 22, { align: "center", color: "#C9D4E3" }),
        },
      },
    },
  },
  {
    id: "quote",
    name: "Quote card",
    description: "Soft background with one large pull quote.",
    category: CATEGORY_QUOTES,
    placement: "intro",
    durationMs: 3000,
    card: {
      name: "Quote card",
      kind: "title_card",
      colors: { primary: "#7C3AED", secondary: "#7C3AED", text: "#202123" },
      composition: {
        aspectRatio: "square",
        surface: "soft",
        align: "left",
        body: "“The best quote wins the pause.”",
        eyebrow: "QUOTE",
        blockLayout: {
          eyebrow: block(0.1, 0.2, 0.6, 20, { color: "#7C3AED" }),
          body: block(0.1, 0.3, 0.8, 40, { bold: true, color: "#202123" }),
        },
      },
    },
  },
  {
    id: "testimonial",
    name: "Testimonial",
    description: "Customer quote with an attribution line.",
    category: CATEGORY_QUOTES,
    placement: "intro",
    durationMs: 3500,
    card: {
      name: "Testimonial",
      kind: "title_card",
      colors: { primary: "#0F3D33", secondary: "#7CE7C4", text: "#FFFFFF" },
      composition: {
        aspectRatio: "square",
        surface: "solid",
        align: "left",
        eyebrow: "TESTIMONIAL",
        body: "“This changed how we ship videos.”",
        headline: "Happy customer",
        blockLayout: {
          eyebrow: block(0.1, 0.16, 0.6, 18, { color: "#7CE7C4" }),
          body: block(0.1, 0.26, 0.8, 36, { bold: true }),
          headline: block(0.1, 0.66, 0.6, 24, { color: "#7CE7C4" }),
        },
      },
    },
  },
  {
    id: "announcement",
    name: "Announcement",
    description: "Square news card for feeds and community posts.",
    category: CATEGORY_PROMOS,
    placement: "intro",
    durationMs: 3000,
    card: {
      name: "Announcement",
      kind: "title_card",
      colors: { primary: "#2563EB", secondary: "#FFFFFF", text: "#FFFFFF" },
      composition: {
        aspectRatio: "square",
        surface: "solid",
        align: "center",
        eyebrow: "ANNOUNCEMENT",
        headline: "Something new",
        body: "Say what changed in one short line.",
        blockLayout: {
          eyebrow: block(0.2, 0.24, 0.6, 20, { align: "center", color: "#DFF56A" }),
          headline: block(0.1, 0.36, 0.8, 56, { align: "center", bold: true }),
          body: block(0.16, 0.56, 0.68, 26, { align: "center", bold: false }),
        },
      },
    },
  },
  {
    id: "product-drop",
    name: "Product drop",
    description: "Launch card for a new product or feature.",
    category: CATEGORY_PROMOS,
    placement: "intro",
    durationMs: 3500,
    card: {
      name: "Product drop",
      kind: "title_card",
      colors: { primary: "#B45309", secondary: "#FDE68A", text: "#FFF9EB" },
      composition: {
        aspectRatio: "vertical",
        surface: "solid",
        align: "center",
        eyebrow: "NEW DROP",
        headline: "Product name",
        cta: "Shop now",
        blockLayout: {
          eyebrow: block(0.28, 0.26, 0.44, 20, { align: "center", color: "#FDE68A" }),
          headline: block(0.12, 0.38, 0.76, 56, { align: "center", bold: true }),
          cta: block(0.3, 0.58, 0.4, 26, {
            align: "center",
            color: "#B45309",
            highlight: "#FDE68A",
          }),
        },
      },
    },
  },
  {
    id: "sponsor",
    name: "Sponsor shoutout",
    description: "Image-forward card for a brand or product.",
    category: CATEGORY_PROMOS,
    placement: "overlay",
    durationMs: 4000,
    card: {
      name: "Sponsor shoutout",
      kind: "overlay",
      colors: { primary: "#151A24", secondary: "#DFF56A", text: "#FFFFFF" },
      composition: {
        aspectRatio: "vertical",
        surface: "solid",
        align: "center",
        eyebrow: "SPONSORED BY",
        headline: "Brand name",
        blockLayout: {
          eyebrow: block(0.2, 0.12, 0.6, 20, { align: "center", color: "#DFF56A" }),
          headline: block(0.12, 0.66, 0.76, 48, { align: "center", bold: true }),
        },
      },
    },
  },
];

function summaryFields(item) {
  return {
    id: item.id,
    name: item.name,
    description: item.description,
    category: item.category || "",
    placement: item.placement,
    durationMs: item.durationMs,
    colors: item.card && item.card.colors ? item.card.colors : undefined,
  };
}

function listTemplates() {
  return TEMPLATES.map((item) => summaryFields(item));
}

function findTemplate(id) {
  return TEMPLATES.find((item) => item.id === id) || null;
}

// All templates the picker should offer: the built-in catalog plus entries in
// the user's template store (installed copies and user-saved designs). The
// store file wins on id collisions so an edited install shadows its builtin.
function mergedTemplates(dataRoot) {
  const byId = new Map();
  for (const item of TEMPLATES) byId.set(item.id, item);
  if (dataRoot) {
    try {
      const { readStoreEntries } = require("./card-template-store");
      for (const entry of readStoreEntries(dataRoot)) {
        if (entry && entry.id && entry.card) byId.set(entry.id, entry);
      }
    } catch {
      /* store file unreadable — catalog still works */
    }
  }
  return Array.from(byId.values());
}

function listCardTemplates(dataRoot) {
  return mergedTemplates(dataRoot).map((item) => summaryFields(item));
}

function findAnyTemplate(id, dataRoot) {
  if (!dataRoot) return findTemplate(id);
  return mergedTemplates(dataRoot).find((item) => item.id === id) || null;
}

// Deep-merge a template into a card patch. Caller's fields win everywhere;
// blockLayout entries merge per text field so a patch can restyle one block.
function templatePatch(id, dataRoot) {
  const found = findAnyTemplate(id, dataRoot);
  if (!found) return null;
  const card = JSON.parse(JSON.stringify(found.card));
  if (found.placement) card.placement = found.placement;
  if (found.durationMs != null) card.durationMs = found.durationMs;
  return card;
}

module.exports = {
  TEMPLATES,
  CATEGORY_HOOKS,
  CATEGORY_CTA,
  CATEGORY_END,
  CATEGORY_QUOTES,
  CATEGORY_PROMOS,
  CATEGORY_OVERLAYS,
  listTemplates,
  listCardTemplates,
  findTemplate,
  findAnyTemplate,
  mergedTemplates,
  templatePatch,
};
