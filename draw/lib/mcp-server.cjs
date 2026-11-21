// JDraw's MCP server (Streamable HTTP, JSON replies). Every ACP session gets
// it injected with a bearer token and the drawing id, so an agent can only
// touch the drawing its chat belongs to.
const http = require("node:http");
const crypto = require("node:crypto");
const G = require("../renderer/js/geom.js");
const Styles = require("./styles.cjs");
const Lint = require("./svg-lint.cjs");
const Finish = require("./finish.cjs");
const lintTries = new Map(); // docId -> draw_svg refusals in a row
// Brushes that paint washes (constant width, see-through): a ring of one of these is a blob, not a form.
const WASH_BRUSHES = new Set(["watercolor", "airbrush", "marker"]);
// True when every point of a stroke sits the same distance from one centre
// (a compass curve): the centre is the circumcircle of its first, middle and last points.
function isCircleArc(points) {
  const P = points.map((p) => (Array.isArray(p) ? [p[0], p[1]] : [p.x, p.y]));
  // A compass curve bows hard (a rainbow, a construction arc); a shallow bend
  // is just a pass following the form and always fits some big circle.
  const sh = strokeShape(P);
  if (sh.maxDev < 0.12 * sh.len) return false;
  const [a, b, c] = [P[0], P[Math.floor(P.length / 2)], P[P.length - 1]];
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (!Number.isFinite(d) || Math.abs(d) < 1e-6) return false;
  const ux = ((a[0] ** 2 + a[1] ** 2) * (b[1] - c[1]) + (b[0] ** 2 + b[1] ** 2) * (c[1] - a[1]) + (c[0] ** 2 + c[1] ** 2) * (a[1] - b[1])) / d;
  const uy = ((a[0] ** 2 + a[1] ** 2) * (c[0] - b[0]) + (b[0] ** 2 + b[1] ** 2) * (a[0] - c[0]) + (c[0] ** 2 + c[1] ** 2) * (b[0] - a[0])) / d;
  const rs = P.map((p) => Math.hypot(p[0] - ux, p[1] - uy));
  const r = rs.reduce((s, v) => s + v, 0) / rs.length;
  if (!(r > 0) || r > 3000) return false;
  return rs.every((v) => Math.abs(v - r) <= 0.04 * r);
}

// Length of a stroke, its start-to-end distance, and how far its middle strays from the straight line between its ends.
// Last-try repair for a native stroke: a ruler-straight stroke bows out by 5% of its length (a sag that peaks mid-stroke); a ring is dropped; an even-pressure stroke gets a hand-drawn profile (light, press, lift).
function repairStroke(raw, kind) {
  if (!raw || raw.type !== "stroke" || !Array.isArray(raw.points) || raw.points.length < 4) return raw;
  const pts = raw.points.map((p) => (Array.isArray(p) ? p.slice() : [p.x, p.y, p.pressure ?? p.p ?? 0.5]));
  if (kind === "press") {
    // A line that never changes pressure reads as a vector. The repair lifts
    // both ends and presses unevenly through the middle, seeded by the
    // stroke's own start so the same stroke repairs the same way.
    const n = pts.length;
    const seed = Math.abs(Math.sin(pts[0][0] * 0.371 + pts[0][1] * 0.113) * 100) % 1;
    const out = pts.map((p, i) => {
      const f = i / Math.max(1, n - 1);
      const body = 0.55 + 0.28 * Math.sin(f * Math.PI * (1.5 + seed) + seed * 6.28);
      const tip = Math.min(1, f / 0.15, (1 - f) / 0.15);
      const v = Math.max(0.1, Math.min(1, body * (0.35 + 0.65 * tip)));
      return [p[0], p[1], +v.toFixed(3)];
    });
    return { ...raw, points: out };
  }
// A ring is never kept: an open arc of it still reads as the same circle.
  if (kind === "ring") return null;
  const s = strokeShape(pts);
  const [ax, ay] = pts[0], [bx, by] = pts[pts.length - 1];
  const L = Math.hypot(bx - ax, by - ay) || 1;
  const nx = -(by - ay) / L, ny = (bx - ax) / L;
  const amp = Math.min(0.05 * s.len, 25);
  let acc = 0;
  const out = pts.map((p, i) => {
    if (i > 0) acc += Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]);
    const off = amp * Math.sin(Math.PI * (acc / (s.len || 1)));
    return [p[0] + nx * off, p[1] + ny * off, p[2] ?? 0.5];
  });
  return { ...raw, points: out };
}
function strokeShape(points) {
  let len = 0;
  for (let i = 1; i < points.length; i++) len += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  const [ax, ay] = points[0];
  const [bx, by] = points[points.length - 1];
  const chord = Math.hypot(bx - ax, by - ay);
  const cl = chord || 1;
  let maxDev = 0;
  for (const [px, py] of points) maxDev = Math.max(maxDev, Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / cl);
  return { len, chord, maxDev };
}
const finalRefused = new Set(); // objects already given their one last-try refusal (slabs, ribbon swells)

// Words on the canvas are the strongest tell: a generated slogan or an em
// dash lands unchecked unless the string is tested. Returns what gave it
// away, or null. Runs in every lint mode, icons and logos included.
function slopText(t) {
  const hit = t.match(/\b(delve|tapestry|realm|seamless|elevate|unlock|unleash|empower|leverage|robust|streamline|harness|testament|pivotal|vibrant|crucial|game[-\s]?changer|cutting[-\s]?edge|next[-\s]?level|revolutionary|journey|ecosystem|stunning|breathtaking|masterpiece)\b/i)
    || t.match(/(dive in|ready to|get started|learn more|level up|imagine a world|not just\b.{0,40}\bbut\b|it's not\b.{0,40}\bit's\b|more than just)/i)
    || t.match(/—|--|[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u);
  const ws = t.trim().split(/\s+/);
  const titled = ws.length >= 4 && ws.every((w) => /^["'(\[]*[A-Z]/.test(w)) && ws.some((w) => /[a-z]/.test(w));
  return hit ? `"${hit[0]}"` : titled ? "Title Case on every word" : null;
}
const TEXT_FIX = "write the shortest plain version in sentence case, only the words the person gave or real labels";
// Which rule set a drawing gets this turn. The host says: "full" (scenery
// and everything else), "mark" (an icon or a logo was asked for), "clean"
// (another clean look: a diagram, pixel art, flat vector) or "off".
const lintModeOf = (host, docId) => (host.lintMode ? host.lintMode(docId) : !host.lintOn || host.lintOn(docId) ? "full" : "off");
const askOf = (host, docId) => (host.turnPrompt ? String(host.turnPrompt(docId) || "") : "");

const SERVER_NAME = "jdraw";
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

let drawVersionCache = "";
function drawVersion() {
  if (!drawVersionCache) {
    try {
      drawVersionCache = JSON.parse(require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "package.json"), "utf8")).version || "0.1.0";
    } catch {
      drawVersionCache = "0.1.0";
    }
  }
  return drawVersionCache;
}

const paint = {
  description: 'A color ("#e5484d", "#00000080" with alpha, "red") or a gradient {"type":"linear","x1":0,"y1":0,"x2":0,"y2":400,"stops":[[0,"#ffd166"],[1,"#ef476f"]]} / {"type":"radial","cx":200,"cy":200,"r":150,"stops":[...]}. Gradient coordinates are canvas pixels.',
  anyOf: [{ type: "string" }, { type: "object" }, { type: "null" }],
};

const itemSchema = {
  type: "object",
  description:
    "One drawing item. type is one of: " +
    "stroke {points:[[x,y,pressure0to1],...], color, size, brush: pen|pencil|marker|airbrush|calligraphy|watercolor|eraser} (freehand line, pressure tapers width; calligraphy is a flat 45 degree nib; watercolor is soft, see-through and darkens where it overlaps; eraser removes paint on its layer); " +
    "rect {x,y,w,h, radius?}; ellipse {x,y,w,h} (bounding box); line {x1,y1,x2,y2, arrowStart?, arrowEnd?}; " +
    "polygon {points:[[x,y],...], closed?: true, smooth?: false} (smooth=true draws a curve through the points; open polygons take arrowStart/arrowEnd too); " +
    "path {d: SVG path data, x?, y?, scale?}; text {x, y (baseline), text, size, font?, weight?, align?: left|center|right}; " +
    "image {x,y,w,h, src: data:image/... (PNG or SVG data URL)}. " +
    "Shapes take fill, stroke (paint), strokeWidth, dash: dashed|dotted. Any item takes opacity 0..1, rotation (degrees), flipX/flipY (mirror), group (items with the same group string select and move together), shadow {color, blur, x, y} (use for glow and soft shading), blend (a canvas composite mode such as multiply, screen, overlay, soft-light), name.",
  properties: {
    type: { type: "string", enum: G.ITEM_TYPES },
    fill: paint,
    stroke: paint,
  },
  required: ["type"],
  additionalProperties: true,
};

function tools() {
  return [
    {
      name: "get_drawing",
      description:
        "Read the drawing: canvas size, background, palette, the person's current brush, layers (bottom to top) and every item with its id, type, bounds and colors. Also returns what the person has selected. Call this before editing so you know the ids.",
      inputSchema: { type: "object", properties: { includePoints: { type: "boolean", description: "Include full stroke points and path data (large)." } } },
    },
    {
      name: "view_drawing",
      description:
        "Look at the drawing as a PNG image, exactly as the person sees it. Call it before you start and after you draw to check your work. Optionally crop to a region (canvas pixels).",
      inputSchema: {
        type: "object",
        properties: {
          x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" },
          maxSize: { type: "number", description: "Longest side of the returned image in pixels, 256 to 1568. Default 1024." },
          layer: { type: "string", description: "Show only this layer (id or name)." },
        },
      },
    },
    {
      name: "draw",
      mutates: true,
      description:
        "Add items to the drawing in one undo step. Put new work on its own named layer (newLayer) so the person can hide or remove it. Coordinates are canvas pixels with 0,0 at the top left. Returns the new ids.",
      inputSchema: {
        type: "object",
        properties: {
          items: { type: "array", items: itemSchema, minItems: 1 },
          layer: { type: "string", description: "Existing layer id or name to draw on (created if the name is new). Default: the top layer." },
          newLayer: { type: "string", description: "Create a new layer with this name for the items." },
          layerIndex: { type: "integer", description: "Where to put the new layer, 0 = bottom. Use 0 for backgrounds and color fills under the person's line art." },
          position: { type: "string", enum: ["top", "bottom"], description: "Add above or below the layer's existing items." },
        },
        required: ["items"],
      },
    },
    {
      name: "draw_svg",
      mutates: true,
      description:
        "Paint an SVG onto the drawing as one item. Best for detailed illustration: write full SVG markup with a viewBox, and it is placed at x,y with size w,h. For a painted look, use draw with stroke items instead (get_style stroke-paint). Use draw instead when the person may want to edit the shapes one by one.",
      inputSchema: {
        type: "object",
        properties: {
          svg: { type: "string", description: "Complete <svg ...>...</svg> markup with a viewBox. No external links or scripts." },
          x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" },
          layer: { type: "string" }, newLayer: { type: "string" }, layerIndex: { type: "integer" },
          opacity: { type: "number" }, blend: { type: "string" }, name: { type: "string" },
        },
        required: ["svg"],
      },
    },
    {
      name: "edit_items",
      mutates: true,
      description:
        "Change items by id: colors (fill, stroke, color), size, strokeWidth, opacity, shadow (null removes it), blend, position fields, text, brush. Also move them (dx, dy), scale them around their center, rotate (degrees), restack them (order: front|back|forward|backward), or move them to another layer.",
      inputSchema: {
        type: "object",
        properties: {
          ids: { type: "array", items: { type: "string" }, minItems: 1 },
          patch: { type: "object", additionalProperties: true },
          dx: { type: "number" }, dy: { type: "number" }, scale: { type: "number" }, rotate: { type: "number" },
          order: { type: "string", enum: ["front", "back", "forward", "backward"] },
          toLayer: { type: "string" },
        },
        required: ["ids"],
      },
    },
    {
      name: "arrange",
      mutates: true,
      description:
        "Arrange items by id, one undo step. action: duplicate (copies above the originals, offset by dx/dy, returns the new ids), group / ungroup (grouped items select and move together for the person), " +
        "align (how: left|center|right|top|middle|bottom; to: canvas lines them up with the canvas, otherwise with each other), distribute (dir: horizontal|vertical, even gaps, 3+ items), " +
        "rotate (degrees) or flip (x mirrors left-right, y top-bottom) around the center of all the items together.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["duplicate", "group", "ungroup", "align", "distribute", "rotate", "flip"] },
          ids: { type: "array", items: { type: "string" }, minItems: 1 },
          dx: { type: "number" }, dy: { type: "number" },
          how: { type: "string", enum: ["left", "center", "right", "top", "middle", "bottom"] },
          to: { type: "string", enum: ["items", "canvas"] },
          dir: { type: "string", enum: ["horizontal", "vertical"] },
          degrees: { type: "number" },
          axis: { type: "string", enum: ["x", "y"] },
        },
        required: ["action", "ids"],
      },
    },
    {
      name: "fill_area",
      mutates: true,
      description:
        "Paint-bucket fill: floods the enclosed area under x,y (canvas pixels) with a color or gradient, the way the person's Fill tool does. Use it to color in the person's line art. " +
        "The fill goes under the existing items of the layer so outlines stay on top. tolerance 0..255 (default 48) is how different a color may be and still fill; gap 0..12 (default 0) closes small breaks in outlines so the fill does not leak; " +
        "sample: all (what you see, default) or layer (only the target layer's lines count).",
      inputSchema: {
        type: "object",
        properties: {
          x: { type: "number" }, y: { type: "number" },
          color: { type: "string" },
          color2: { type: "string", description: "Second color for a gradient fill." },
          gradient: { type: "string", enum: ["linear", "radial"] },
          tolerance: { type: "number" }, gap: { type: "number" },
          sample: { type: "string", enum: ["all", "layer"] },
          layer: { type: "string", description: "Layer to put the fill on (id or name). Default: the person's active layer." },
          opacity: { type: "number" },
        },
        required: ["x", "y", "color"],
      },
    },
    {
      name: "delete_items",
      mutates: true,
      description: "Remove items by id.",
      inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "string" }, minItems: 1 } }, required: ["ids"] },
    },
    {
      name: "recolor",
      mutates: true,
      description: "Swap one color for another across the drawing or one layer, for every item close to that color (tolerance 0 to 442, default 24). Also changes the background if it matches.",
      inputSchema: {
        type: "object",
        properties: { from: { type: "string" }, to: { type: "string" }, tolerance: { type: "number" }, layer: { type: "string" } },
        required: ["from", "to"],
      },
    },
    {
      name: "set_palette",
      mutates: true,
      description:
        "Change the color palette shown under the canvas, where the person picks colors. mode add (default) appends colors, replace swaps the whole palette. Give a short name for each color when it helps.",
      inputSchema: {
        type: "object",
        properties: {
          colors: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 48 },
          names: { type: "array", items: { type: "string" } },
          mode: { type: "string", enum: ["add", "replace"] },
        },
        required: ["colors"],
      },
    },
    {
      name: "set_brush",
      description: "Set the person's current brush so their next strokes use it: color, size (px), brush, opacity. smudge drags paint along the stroke and blur softens what is under it; both only work for the person's own strokes.",
      inputSchema: {
        type: "object",
        properties: { color: { type: "string" }, size: { type: "number" }, brush: { type: "string", enum: [...G.BRUSHES, "smudge", "blur"] }, opacity: { type: "number" } },
      },
    },
    {
      name: "canvas",
      mutates: true,
      description: 'Change the background color ("transparent" for no paper) or the canvas size. anchor center keeps the drawing in the middle when the size changes; the default keeps it at the top left.',
      inputSchema: { type: "object", properties: { background: { type: "string" }, width: { type: "integer" }, height: { type: "integer" }, anchor: { type: "string", enum: ["top-left", "center"] } } },
    },
    {
      name: "layers",
      mutates: (a) => layerAction(a) !== "list",
      description: "Manage layers: list, add, rename, show or hide, lock or unlock, duplicate, set opacity or blend mode, move (index 0 = bottom), merge_down or delete.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "add", "rename", "show", "hide", "lock", "unlock", "duplicate", "opacity", "blend", "move", "merge_down", "delete"] },
          layer: { type: "string", description: "Layer id or name (not needed for add)." },
          name: { type: "string" }, opacity: { type: "number" }, blend: { type: "string" }, index: { type: "integer" },
        },
        required: ["action"],
      },
    },
    {
      name: "list_styles",
      description:
        "List the style skills: guides for drawing in a general look (watercolor, oil, anime, flat vector, pixel art, neon, ink, pencil, blueprint and more). Call it when the person names a look or style, or asks for something new without one and a style would help.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_style",
      description:
        "Read one style skill: the look, a palette, the JDraw steps that get it (brushes, opacity, glow, hatching, layers) and an example image drawn in JDraw. Follow it when you draw in that style; adapt it to the person's subject instead of copying the example scene.",
      inputSchema: { type: "object", properties: { id: { type: "string", description: "Style id or name from list_styles, for example watercolor or Pixel Art." } }, required: ["id"] },
    },
    {
      name: "check_drawing",
      description:
        "Run JDraw's AI slop checker on the drawing: loose lines and dashes, scattered dots, copy-pasted shapes, triangle trees, primitive-only objects, things in a row, light wedges, gray, muddy or low-contrast color, multicolor text. Returns each problem with where it is and how to fix it. Call it after you draw and fix everything it finds; JDraw runs it again when you finish and sends you back to fix what is left.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "finish_drawing",
      mutates: true,
      description:
        "The artist finish, run by code: grades every color (real darks and clean lights, gray and muddy colors get a hue, cool shadows and warm lights, textbook full-strength colors toned down), gives every SVG you placed painted edges and a soft gouache mottle inside the fills (text stays sharp), and lays a faint paper grain over the canvas. JDraw runs it on its own when you finish, before the reviewer looks. Call it yourself only to change it, and only when the person asked for that look: edges false when they asked for pixel art, low poly, blueprint or a flat vector look (never because your own drawing came out flat); grain false for clean graphic work; strength 0.5 for a lighter touch, 1.4 for a looser hand. Your choice is kept for this drawing. Do not draw your own grain, wobble or noise on top of it.",
      inputSchema: {
        type: "object",
        properties: {
          edges: { type: "boolean", description: "Painted edges and fill mottle on SVGs (default true)." },
          grain: { type: "boolean", description: "Paper grain layer (default true)." },
          grade: { type: "boolean", description: "Color grade (default true)." },
          strength: { type: "number", description: "0.3 to 1.5, default 1." },
        },
      },
    },
  ];
}

function round(n) {
  return Math.round(n * 10) / 10;
}

function summarize(doc, ctx, includePoints) {
  return {
    width: doc.width,
    height: doc.height,
    background: doc.background,
    palette: doc.palette,
    brush: ctx.brush || null,
    selection: ctx.selection || [],
    layers: doc.layers.map((l, index) => ({
      id: l.id,
      name: l.name,
      index,
      visible: l.visible !== false,
      opacity: l.opacity ?? 1,
      ...(l.blend ? { blend: l.blend } : {}),
      items: l.items.map((it) => {
        const b = G.bounds(it);
        const out = { id: it.id, type: it.type, bounds: { x: round(b.x), y: round(b.y), w: round(b.w), h: round(b.h) } };
        const colors = [...new Set(G.itemColors(it))];
        if (colors.length) out.colors = colors;
        if (it.name) out.name = it.name;
        if (it.type === "stroke") { out.brush = it.brush; out.size = it.size; out.pointCount = it.points.length; }
        if (it.type === "text") out.text = it.text;
        if (it.opacity !== undefined && it.opacity !== 1) out.opacity = it.opacity;
        if (it.group) out.group = it.group;
        if (it.rotation) out.rotation = it.rotation;
        if (it.flipX) out.flipX = true;
        if (it.flipY) out.flipY = true;
        if (includePoints) {
          if (it.points) out.points = it.points;
          if (it.d) out.d = it.d;
          if (it.fill && typeof it.fill === "object") out.fill = it.fill;
        }
        return out;
      }),
    })),
  };
}

function svgToDataUrl(svg) {
  let s = String(svg || "").trim();
  if (!/^<svg[\s>]/i.test(s.replace(/^<\?xml[^>]*>\s*/i, ""))) throw new Error("svg must be <svg ...> markup.");
  {
    // An event handler is an attribute of its own (after a space), not the
    // tail of a name like maskContentUnits, which JDraw's own swells use.
    const bad = s.match(/<script|[\s"'/]on[a-z]+\s*=|href\s*=\s*["']?(?!#)(?:https?:|\/\/|file:)/i);
    if (bad) throw new Error("The SVG cannot have scripts, event handlers or links to outside files (found " + JSON.stringify(bad[0].trim()) + ").");
  }
  if (!/xmlns=/.test(s)) s = s.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  return "data:image/svg+xml;base64," + Buffer.from(s, "utf8").toString("base64");
}

function svgSize(svg) {
  const vb = String(svg).match(/viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  if (vb) return { w: Number(vb[1]), h: Number(vb[2]) };
  const w = String(svg).match(/\swidth\s*=\s*["']?([\d.]+)/i);
  const h = String(svg).match(/\sheight\s*=\s*["']?([\d.]+)/i);
  return { w: w ? Number(w[1]) : 512, h: h ? Number(h[1]) : 512 };
}

// host: { store, viewDrawing(docId, opts) -> {png base64}, setBrush(docId, brush), context(docId) -> {brush, selection},
//   listDrawings(projectId), projectOf(docId), newDrawing(opts), openDrawing(docId),
//   beforeTool(ctx, docId, name, args), onTool(docId, name, args, err, ctx) }
function createMcpServer(host) {
  const token = crypto.randomBytes(24).toString("hex");
  const sessions = new Set();
  // MCP session id (or a header fallback) -> { docId }: which drawing a
  // project-bound session last picked with new_drawing/open_drawing.
  const sessionDocs = new Map();
  const PICK_TOOLS = new Set(["list_drawings", "new_drawing", "open_drawing"]);
  // mutates on a tool def is the one source of truth: it drives the
  // checkpoint before the call, the changed mark for the turn gate and the
  // artifact card. A stale hardcoded list here is how deletes slipped past
  // all three.
  const allDefs = allToolDefs();

  // The drawings a session may see. A project-bound session only ever lists,
  // opens or edits drawings inside its own project.
  function drawingList(projectId) {
    if (projectId && typeof host.listDrawings === "function") return host.listDrawings(projectId) || [];
    return host.store.list();
  }

  function inScope(ctx, docId) {
    return !ctx.projectId || typeof host.projectOf !== "function" || host.projectOf(docId) === ctx.projectId;
  }

  function ctxDoc(ctx) {
    const id = String(ctx.sess.docId || "");
    if (id && !inScope(ctx, id)) {
      ctx.scopeErr = "That drawing is not in this project.";
      return "";
    }
    return id;
  }

  async function pickTool(ctx, name, args) {
    const a = args || {};
    const rows = () => drawingList(ctx.projectId);
    if (name === "list_drawings") {
      const ds = rows().map((d) => ({ id: d.id, name: d.name, updated: d.updated }));
      return { json: { drawings: ds, open: ctx.sess.docId || "", next: ds.length ? "open_drawing with an id picks one; new_drawing makes a blank one." : "No drawings yet. new_drawing makes one." } };
    }
    if (name === "new_drawing") {
      if (typeof host.newDrawing !== "function") throw new Error("new_drawing is not available here.");
      const opts = { name: a.name, projectId: ctx.projectId || undefined };
      const size = String(a.size || "").match(/(\d+)\s*[x×]\s*(\d+)/i);
      const ratio = String(a.ratio || "").match(/(\d+(?:\.\d+)?)\s*[/:]\s*(\d+(?:\.\d+)?)/);
      if (size) { opts.width = +size[1]; opts.height = +size[2]; }
      else if (ratio) { opts.width = 1600; opts.height = Math.round((1600 * +ratio[2]) / +ratio[1]); }
      const d = host.newDrawing(opts);
      ctx.sess.docId = d.id;
      if (typeof host.openDrawing === "function") try { host.openDrawing(d.id); } catch {}
      return { json: { id: d.id, name: d.name, next: "Draw on it with draw_svg or draw." } };
    }
    if (name === "open_drawing") {
      const want = String(a.id || a.name || "").trim();
      if (!want) throw new Error("Pass id or name.");
      const hit = rows().find((d) => d.id === want) || rows().find((d) => String(d.name).toLowerCase() === want.toLowerCase());
      if (!hit) throw new Error(ctx.projectId ? "No drawing in this project with that id or name. Call list_drawings." : "No drawing with that id or name. Call list_drawings.");
      ctx.sess.docId = hit.id;
      if (typeof host.openDrawing === "function") try { host.openDrawing(hit.id); } catch {}
      return { json: { id: hit.id, name: hit.name, next: "Draw on it with draw_svg or draw." } };
    }
    throw new Error("Unknown tool: " + name);
  }

  async function callTool(docId, name, args) {
    const store = host.store;
    const a = args || {};
    const layerRef = (ref) => {
      if (!ref) return undefined;
      const doc = store.getDoc(docId);
      const l = doc.layers.find((x) => x.id === ref || x.name.toLowerCase() === String(ref).toLowerCase());
      return l ? l.id : ref;
    };
    switch (name) {
      case "list_styles":
        return { json: { styles: Styles.listStyles(), next: "Read the one that fits with get_style. Also read get_style anti-slop and get_style slop-catalog (the parts for your subject) before you draw, and get_style writing-slop before you add any text." } };
      case "get_style": {
        const s = Styles.getStyle(a.id);
        if (!s) throw new Error(`No style "${a.id}". Call list_styles for the ids.`);
        const text = s.body + (s.example ? "\n\n(The image above is the example drawn in JDraw in this style.)" : "");
        return s.example ? { image: { base64: s.example.toString("base64") }, text } : { json: { id: s.id, name: s.name, guide: s.body } };
      }
      case "check_drawing": {
        if (!host.checkDrawing) throw new Error("The checker is not available here.");
        const r = await host.checkDrawing(docId);
        if (r.ok === null) return { json: { ok: null, error: r.error, next: "The checker could not run. Check the drawing yourself with view_drawing." } };
        return { json: { ok: r.ok, issues: r.issues, next: r.ok ? "Clean. A reviewer will still look at it when you finish." : "Fix every issue (redraw the object, do not hide it), then call check_drawing again." } };
      }
      case "finish_drawing": {
        if (!host.finishDrawing) throw new Error("The finish is not available here.");
        const opts = {};
        for (const k of ["edges", "grain", "grade"]) if (typeof a[k] === "boolean") opts[k] = a[k];
        if (Number.isFinite(Number(a.strength)) && a.strength !== undefined) opts.strength = Math.max(0.3, Math.min(1.5, Number(a.strength)));
        return { json: host.finishDrawing(docId, opts) };
      }
      case "get_drawing":
        return { json: summarize(store.getDoc(docId), host.context(docId), !!a.includePoints) };
      case "view_drawing": {
        const png = await host.viewDrawing(docId, a);
        {
          const d = store.getDoc(docId);
          const k = (a.w || d.width) / png.width;
          return { image: png, text: `Canvas ${d.width}x${d.height}. Image ${png.width}x${png.height}${a.w ? `, cropped to x ${a.x || 0} y ${a.y || 0} w ${a.w} h ${a.h}` : ""}. Canvas position = ${a.w ? `(${a.x || 0}, ${a.y || 0}) + ` : ""}image position x ${+k.toFixed(3)}.` };
        }
      }
      case "draw": {
        // Native shapes get the same primitive checks as draw_svg, so the
        // lint cannot be sidestepped by switching tools.
        let items = a.items;
        const drawMode = lintModeOf(host, docId);
        let drawNote = null;
        if (drawMode === "mark" || drawMode === "clean") {
          // Icon, logo and diagram asks: plain shapes and even lines are the
          // point, so only generated copy and the stock app icon are refused.
          const doc = store.getDoc(docId);
          const said = askOf(host, docId);
          const textBad = [], bad = [];
          const read = [];
          for (const raw of a.items || []) { try { const it = G.normItem(raw); read.push({ it, b: G.bounds(it) }); } catch (err) { textBad.push(`an item could not be read (${err.message}); fix its fields and call draw again`); } }
          for (const { it, b } of read) {
            if (it.type !== "text" || !b || typeof it.text !== "string" || !it.text.trim()) continue;
            const why = slopText(it.text);
            if (why) textBad.push(`the text at x ${Math.round(b.x)}, y ${Math.round(b.y)} reads as generated copy (${why}): ${TEXT_FIX}`);
          }
          if (drawMode === "mark" && !/\b(letters?|monograms?|initials?|word\s?marks?|letter\s?marks?|text (icon|logo|mark)|typographic|lettering)\b/i.test(said)) {
            const old = doc.layers.flatMap((l) => l.items || []).map((it) => { try { return { it, b: G.bounds(it) }; } catch { return null; } }).filter((e) => e && e.b);
            const all = old.concat(read.filter((e) => e.b));
            const texts = all.filter((e) => e.it.type === "text" && typeof e.it.text === "string" && e.it.text.trim());
            const glyph = texts.length === 1 && /^[A-Za-z0-9]{1,2}$/.test(texts[0].it.text.trim()) ? texts[0] : null;
            const esc = glyph ? glyph.it.text.trim() : "";
            const named = glyph && (new RegExp(`["'“‘]${esc}["'”’]`).test(said) || (esc.length === 2 && new RegExp(`\\b${esc}\\b`).test(said)));
            // Only when this call adds the letter or a tile for it.
            if (glyph && !named && (read.includes(glyph) || read.some((e) => e.it.type === "rect" || e.it.type === "ellipse"))) {
              const shapes = all.filter((e) => e !== glyph && e.it.type !== "text" && e.b.w * e.b.h > 0);
              const tile = shapes.filter((e) => (e.it.type === "rect" || e.it.type === "ellipse") && e.b.w <= 1.25 * e.b.h && e.b.h <= 1.25 * e.b.w && glyph.b.x >= e.b.x && glyph.b.x + glyph.b.w <= e.b.x + e.b.w && glyph.b.y >= e.b.y - 0.1 * e.b.h && glyph.b.y + glyph.b.h <= e.b.y + 1.1 * e.b.h).sort((p, q) => q.b.w * q.b.h - p.b.w * p.b.h)[0];
              const rest = tile ? shapes.filter((e) => e !== tile && e.b.w * e.b.h < 0.5 * tile.b.w * tile.b.h && e.b.w * e.b.h >= 0.004 * tile.b.w * tile.b.h) : [];
              if (tile && rest.length <= 2) bad.push(`the mark is the letter${esc.length > 1 ? "s" : ""} "${esc}" in a tile at x ${Math.round(tile.b.x)}-${Math.round(tile.b.x + tile.b.w)}, y ${Math.round(tile.b.y)}-${Math.round(tile.b.y + tile.b.h)}: the default app icon. Draw a mark that shows what the thing is or does, and keep a letter only when the ask says to use one`);
            }
          }
          const key = docId + "\n#draw";
          const tries = lintTries.get(key) || 0;
          // Generated copy never lands. The stock icon lands on the fourth try, listed.
          if (textBad.length || (bad.length && tries < 3)) {
            if (tries < 3) lintTries.set(key, tries + 1);
            throw new Error(`JDraw did not place these shapes (try ${Math.min(tries + 1, 4)} of 4). Fix these and call draw again:\n` + textBad.concat(bad).slice(0, 8).map((p, n) => `${n + 1}. ${p}.`).join("\n"));
          }
          lintTries.delete(key);
          if (bad.length) drawNote = bad;
        }
        if (drawMode === "full") {
          const doc = store.getDoc(docId);
          const A = doc.width * doc.height;
          const bad = [];
          const strokeBad = [];
          const fixes = new Map(); // raw item -> repair kind (ruler, ring or press)
          const newStrokes = [];
          for (const raw of a.items || []) {
            let it, b;
            try { it = G.normItem(raw); b = G.bounds(it); } catch (err) { bad.push(`an item could not be read (${err.message}); fix its fields and call draw again`); continue; }
            if (it.type === "stroke" && Array.isArray(it.points) && it.points.length >= 2 && b) {
              const at = `x ${Math.round(b.x)}-${Math.round(b.x + b.w)}, y ${Math.round(b.y)}-${Math.round(b.y + b.h)}`;
              newStrokes.push({ it, where: `x ${Math.round(b.x)}, y ${Math.round(b.y)}` });
              // Stroke checks run before the area test below, so a thin
              // stroke (a mast, a horizon, a crack) is still measured.
              if (it.points.length < 4) bad.push(`a stroke at ${at} has only ${it.points.length} points, so it reads as a ruler line: paint it with 6 to 20 points that bend with the form`);
              else {
                const s = strokeShape(it.points);
                if (s.len >= (it.size < 10 ? 60 : 120) && s.maxDev < 0.025 * s.len && fixes.set(raw, "ruler")) strokeBad.push(`a stroke at ${at} runs ruler-straight (it bends less than 2.5% along its length): bend it with the form, or split it into shorter passes that follow the shape`);
                else if (s.len >= 240 && s.chord < 0.08 * s.len && it.points.length >= 6 && fixes.set(raw, "ring")) strokeBad.push(`a ${it.brush || "pen"} stroke at ${at} closes on itself into a ring, which reads as a stock circle, a sausage cloud or a blob: open the stroke and build the form with overlapping passes of different lengths`);
                else if (s.len >= 240 && it.points.length >= 8 && isCircleArc(it.points) && fixes.set(raw, "ring")) strokeBad.push(`a ${it.brush || "pen"} stroke at ${at} is a perfect circle arc (every point the same distance from one centre), which reads as a stock rainbow or a construction arc: draw the form with uneven passes that follow it, not a compass curve`);
                // A pen, pencil or calligraphy stroke that never changes
                // pressure paints one dead-even width along its whole length:
                // the tell of a generated line, not a hand line.
                if (["pen", "pencil", "calligraphy"].includes(it.brush) && s.len >= 60 && it.points.length >= 6) {
                  const ps = it.points.map((p) => p[2]).filter((v) => typeof v === "number");
                  if (ps.length >= 6 && Math.max(...ps) - Math.min(...ps) < 0.08 && (fixes.has(raw) || fixes.set(raw, "press"))) strokeBad.push(`a ${it.brush} stroke at ${at} keeps one even pressure end to end, so it paints one dead-even width: give the points pressure that starts light, presses through the middle and lifts at the end`);
                }
                // A stroke that turns back on itself again and again is
                // scribble, not a pass following a form. The signed turn
                // total catches the other filler mark, a spiral: it never
                // reverses and never closes, so it escapes both checks above.
                let reversals = 0, turn = 0;
                for (let i = 1; i + 1 < it.points.length; i++) {
                  const ax = it.points[i][0] - it.points[i - 1][0], ay = it.points[i][1] - it.points[i - 1][1];
                  const bx = it.points[i + 1][0] - it.points[i][0], by = it.points[i + 1][1] - it.points[i][1];
                  const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
                  if (la && lb) {
                    if ((ax * bx + ay * by) / (la * lb) < -0.5) reversals++;
                    turn += Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
                  }
                }
                if (reversals >= 5) strokeBad.push(`a ${it.brush || "pen"} stroke at ${at} doubles back on itself ${reversals} times, which reads as scribble or a sawtooth, not a pass: redraw it as one pass that follows the form, or split it into separate strokes`);
                else if (Math.abs(turn) >= 3.5 * Math.PI) strokeBad.push(`a ${it.brush || "pen"} stroke at ${at} curls around on itself ${Math.abs(turn / (2 * Math.PI)).toFixed(1)} turns, which reads as a stock swirl, not a form: draw the thing it stands for or leave it out`);
              }
            }
            if (it.type === "text" && b && typeof it.text === "string" && it.text.trim()) {
              const why = slopText(it.text);
              if (why) bad.push(`the text at x ${Math.round(b.x)}, y ${Math.round(b.y)} reads as generated copy (${why}): ${TEXT_FIX}`);
            }
            if (!b || b.w * b.h < 0.004 * A || (b.w >= 0.9 * doc.width && b.h >= 0.25 * doc.height)) continue;
            const glow = (it.fill && typeof it.fill === "object" && it.shadow && it.shadow.blur) || Number(it.opacity ?? 1) < 0.35;
            if (glow) continue;
            const where = `x ${Math.round(b.x)}-${Math.round(b.x + b.w)}, y ${Math.round(b.y)}-${Math.round(b.y + b.h)}`;
            if (it.type === "rect" || it.type === "ellipse") bad.push(`a plain ${it.type} at ${where} is an object made from a basic shape; draw it as a path with an uneven outline of at least 12 points`);
            else if ((it.type === "polygon" || it.type === "path") && Array.isArray(it.points) && it.points.length < 8) bad.push(`the ${it.type} at ${where} has only ${it.points.length} points for a shape that big; give its silhouette at least 8 to 12 points that follow the real form`);
            else if (it.type === "path" && typeof it.d === "string") {
              // Native paths carry d, not points: count corners and curves the same way draw_svg does.
              const n = Lint.parsePath(it.d).reduce((sum, sp) => sum + sp.segs.length, 0);
              if (n < 8) bad.push(`the path at ${where} has only ${n} segments for a shape that big; give its silhouette at least 8 to 12 points that follow the real form`);
            }
          }
          // A row of repeated strokes (same length, size and angle) is the
          // stock reflection ladder or dash row. Count the strokes already on
          // the canvas plus the earlier ones in this call.
          const sigOf = (it) => {
            const s = strokeShape(it.points);
            const p0 = it.points[0], p1 = it.points[it.points.length - 1];
            return { len: s.len, size: it.size, ang: Math.atan2(p1[1] - p0[1], p1[0] - p0[0]) };
          };
          const alike = (p, q) => {
            let d = Math.abs(p.ang - q.ang) % Math.PI;
            d = Math.min(d, Math.PI - d);
            return Math.abs(p.len - q.len) <= 0.2 * Math.max(p.len, q.len) && Math.abs(p.size - q.size) <= 0.25 * Math.max(p.size, q.size) && d <= 10 * Math.PI / 180;
          };
          const onCanvas = doc.layers.flatMap((l) => l.items).filter((i) => i.type === "stroke" && Array.isArray(i.points) && i.points.length >= 2).map(sigOf);
          const seen = onCanvas.slice();
          for (const ns of newStrokes) {
            const sg = sigOf(ns.it);
            const same = seen.filter((o) => alike(o, sg)).length;
            if (same >= 5) { bad.push(`a stroke at ${ns.where} repeats ${same} strokes of the same length, size and angle: this reads as a row of identical marks, so vary each pass's length, size and angle`); break; }
            seen.push(sg);
          }
          // Stacked capsules: wash passes that share most of their width and sit one above another
          // read as a cloud made of slabs. Four already on the canvas refuse a fifth.
          const washBox = (i) => { try { return G.bounds(i); } catch { return null; } };
          const washes = doc.layers.flatMap((l) => l.items).filter((i) => i.type === "stroke" && WASH_BRUSHES.has(i.brush)).map(washBox).filter(Boolean);
          const stacks = (nb, list) => list.filter((o) => {
            const ox = Math.min(o.x + o.w, nb.x + nb.w) - Math.max(o.x, nb.x);
            if (ox < 0.6 * Math.min(o.w, nb.w)) return false;
            const h = Math.min(o.h, nb.h) || 1;
            return Math.abs((o.y + o.h / 2) - (nb.y + nb.h / 2)) <= 1.5 * h;
          }).length;
          for (const ns of newStrokes) {
            if (!WASH_BRUSHES.has(ns.it.brush)) continue;
            const nb = washBox(ns.it);
            if (!nb) continue;
            const n = stacks(nb, washes);
            if (n >= 4) { bad.push(`a ${ns.it.brush} stroke at ${ns.where} is the fifth pass stacked on the same band: this reads as a cloud made of slabs. Put it at a different height, a different length, or a different tilt`); break; }
            washes.push(nb);
          }
          const key = docId + "\n#draw";
          const tries = lintTries.get(key) || 0;
          if (!bad.length && strokeBad.length && tries >= 3) {
            // Last try, strokes only: JDraw bows a ruler-straight stroke and opens a ring, the way draw_svg repairs its last try.
            items = (a.items || []).map((raw) => (fixes.has(raw) ? repairStroke(raw, fixes.get(raw)) : raw)).filter(Boolean);
            lintTries.delete(key);
          } else bad.push(...strokeBad);
          if (bad.length && tries >= 3) throw new Error("JDraw will not place these native shapes: they still read as AI-made. Draw this object with draw_svg instead (one SVG with the whole object), and JDraw will repair what is left on its last try:\n" + bad.slice(0, 8).map((p, n) => `${n + 1}. ${p}.`).join("\n"));
          if (bad.length && tries < 3) {
            lintTries.set(key, tries + 1);
            throw new Error(`JDraw did not place these shapes (try ${tries + 1} of 4): they read as AI-made. Fix these and call draw again, or use draw_svg:\n` + bad.slice(0, 8).map((p, n) => `${n + 1}. ${p}.`).join("\n"));
          }
          lintTries.delete(key);
        }
        const [res] = store.apply(docId, [{ op: "add_items", items, layerId: layerRef(a.layer), newLayer: a.newLayer, layerIndex: a.layerIndex, position: a.position }], "agent");
        return { json: Object.assign({ added: res.ids.length, ids: res.ids, layerId: res.layerId }, drawNote ? { placedWithProblems: drawNote } : {}) };
      }
      case "draw_svg": {
        const src = svgToDataUrl(a.svg);
        const size = svgSize(a.svg);
        const doc = store.getDoc(docId);
        let w = Number(a.w), h = Number(a.h);
        if (!w && !h) { const s = Math.min(doc.width / size.w, doc.height / size.h); w = size.w * s; h = size.h * s; }
        else if (!w) w = (h * size.w) / size.h;
        else if (!h) h = (w * size.h) / size.w;
        const item = { type: "image", src, x: Number(a.x) || 0, y: Number(a.y) || 0, w, h, opacity: a.opacity, blend: a.blend, name: a.name || "SVG" };
        // Shapes are measured before they land: primitives, few-point
        // outlines, lenses, box bands, ruler edges, dash texture and flat
        // single-color objects are refused with what to change. After three
        // refusals for one object name the fourth try lands, with the
        // problems listed.
        let lintNote = null;
        let nameTip = null;
        const svgMode = lintModeOf(host, docId);
        const ask = askOf(host, docId);
        if (svgMode === "mark" || svgMode === "clean") {
          // Icon, logo and diagram asks get their own short rule set: the
          // stock marks and generated copy. No scenery rule runs here.
          const vbm = String(a.svg).match(/viewBox\s*=\s*["']\s*([-\d.]+)[\s,]+([-\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
          const vb = vbm ? { x: +vbm[1], y: +vbm[2], w: +vbm[3], h: +vbm[4] } : { x: 0, y: 0, w: size.w, h: size.h };
          const { problems } = Lint.lintClean(String(a.svg), { vb, x: item.x, y: item.y, w, h, W: doc.width, H: doc.height, name: a.name, ask, kind: svgMode });
          const copy = Lint.textsOf(String(a.svg)).map((t) => [t, slopText(t)]).filter((e) => e[1]).map(([t, why]) => ({ rule: "text", what: `the text "${t.slice(0, 40)}" reads as generated copy (${why})`, fix: TEXT_FIX[0].toUpperCase() + TEXT_FIX.slice(1) + "." }));
          const key = docId + "\n" + (a.name ? String(a.name).toLowerCase() : `@${Math.round(item.x / 100)},${Math.round(item.y / 100)},${Math.round(w / 100)}`);
          const tries = lintTries.get(key) || 0;
          const what = svgMode === "mark" ? "it uses a stock icon or logo shape" : "it carries a stock mark";
          // Generated copy never lands; a stock mark lands on the fourth try.
          if (copy.length || (problems.length && tries < 3)) {
            if (tries < 3) lintTries.set(key, tries + 1);
            throw new Error(`JDraw did not place this SVG (${a.name || "unnamed"}, try ${Math.min(tries + 1, 4)} of 4): ${copy.length && !problems.length ? "its text reads as generated copy" : what}. Fix these and call draw_svg again with the whole object, same name:\n` + copy.concat(problems).map((p, n) => `${n + 1}. ${p.what}. ${p.fix}`).join("\n"));
          }
          lintTries.delete(key);
          if (problems.length) {
            // Last try: a sparkle, a swoosh or an orbit ring is decoration on
            // top of the mark, so JDraw takes it out. The rest lands, listed.
            let svg = String(a.svg), stripped = 0;
            for (const el of new Set(problems.filter((p) => ["sparkle", "logo-swoosh", "logo-orbit"].includes(p.rule)).flatMap((p) => p.els || []))) {
              const tag = (el.match(/^<([a-z]+)/i) || [])[1];
              const selfClosed = /\/>$/.test(el);
              if (!selfClosed && !tag) continue;
              const lit = el.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
              const re = new RegExp(selfClosed ? lit : lit + "[\\s\\S]*?</" + tag + ">", "g");
              const n = (svg.match(re) || []).length;
              if (n && Lint.shapesOf(svg.replace(re, "")).length) { svg = svg.replace(re, ""); stripped += n; }
            }
            if (stripped) item.src = svgToDataUrl(svg);
            lintNote = Lint.lintClean(svg, { vb, x: item.x, y: item.y, w, h, W: doc.width, H: doc.height, name: a.name, ask, kind: svgMode }).problems.map((p) => p.what);
            if (stripped) lintNote.unshift(`JDraw removed ${stripped} stock shape${stripped === 1 ? "" : "s"} (sparkle, swoosh or orbit ring)`);
          }
        }
        if (svgMode === "full") {
          if (Lint.genericName(a.name)) nameTip = "Name each object for what it is (name: \"cloud\", \"rock\", \"lighthouse\"), so it is checked as that thing.";
          const vbm = String(a.svg).match(/viewBox\s*=\s*["']\s*([-\d.]+)[\s,]+([-\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
          const vb = vbm ? { x: +vbm[1], y: +vbm[2], w: +vbm[3], h: +vbm[4] } : { x: 0, y: 0, w: size.w, h: size.h };
          // Other cloud items already on the canvas, by what they draw.
          const otherClouds = /\bclouds?\b/i.test(a.name || "") ? (doc.layers || []).flatMap((l) => l.items || []).filter((it) => it.type === "image" && /\bclouds?\b/i.test(it.name || "")).map((it) => {
            try {
              const s0 = Finish.unpaintEdges(Finish.decodeSvg(it.src) || "");
              const m = s0.match(/viewBox\s*=\s*["']\s*([-\d.]+)[\s,]+([-\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
              const v = m ? { x: +m[1], y: +m[2], w: +m[3], h: +m[4] } : { x: 0, y: 0, w: it.w, h: it.h };
              const c = Finish.contentOf(s0, it, v, doc.width, doc.height);
              if (!c.field) return { x: c.x, y: c.y, w: c.w, h: c.h };
              // Blurred clouds are skipped by the content measure: box what they draw.
              const ss = Lint.shapesOf(s0).filter((s) => s.fill && s.closed && (s.alpha ?? 1) >= 0.3 && s.box.w < 0.85 * v.w);
              if (!ss.length) return null;
              const x0 = Math.min(...ss.map((s) => s.box.x)), y0 = Math.min(...ss.map((s) => s.box.y)), x1 = Math.max(...ss.map((s) => s.box.x + s.box.w)), y1 = Math.max(...ss.map((s) => s.box.y + s.box.h));
              return { x: it.x + ((x0 - v.x) * it.w) / v.w, y: it.y + ((y0 - v.y) * it.h) / v.h, w: ((x1 - x0) * it.w) / v.w, h: ((y1 - y0) * it.h) / v.h };
            } catch { return null; }
          }).filter(Boolean) : [];
          const { problems } = Lint.lintSvg(String(a.svg), { vb, x: item.x, y: item.y, w, h, W: doc.width, H: doc.height, name: a.name, ask, otherClouds });
          // Unnamed SVGs are told apart by where they go, so they do not share one budget.
          const key = docId + "\n" + (a.name ? String(a.name).toLowerCase() : `@${Math.round(item.x / 100)},${Math.round(item.y / 100)},${Math.round(w / 100)}`);
          const tries = lintTries.get(key) || 0;
          if (problems.length && tries < 3) {
            lintTries.set(key, tries + 1);
            const shown = problems.slice(0, 8);
            throw new Error(`JDraw did not place this SVG (${a.name || "unnamed"}, try ${tries + 1} of 4): it reads as AI-made. Fix these and call draw_svg again with the whole object, same name:\n` + shown.map((p, n) => `${n + 1}. ${p.what}. ${p.fix}`).join("\n") + (problems.length > shown.length ? `\n(${problems.length - shown.length} more of the same kinds)` : ""));
          }
          lintTries.delete(key);
          if (problems.length) {
            // Last try: shapes that are pure decoration tells (oval blobs,
            // reflection ladders, dashes, lenses) are taken out by JDraw
            // instead of landing; structural problems land and are listed.
            let svg = String(a.svg);
            // Shards go only when they are light specks (foam, sparkle); dark
            // ones may be windows or stones that belong to the object.
            const light = (el) => { const m = el.match(/fill\s*=\s*["']#([0-9a-f]{3}|[0-9a-f]{6})["']/i); if (!m) return false; const h = m[1].length === 3 ? m[1].replace(/./g, "$&$&") : m[1]; const v = [0, 2, 4].map((k) => parseInt(h.slice(k, k + 2), 16) / 255); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2] > 0.72; };
            const strip = new Set(problems.filter((p) => ["ovals", "flat-patches", "dashes", "lens", "shards", "light-wedge", "pill-row", "floating-shadow", "sea-blotches", "sea-ghost", "ladder", "sea-soft-blobs", "sticker-shadow", "drawn-cracks", "foam-slab", "hanging-shadow", "stamped-holes", "pill-swell", "ribbon-cloud", "decal", "sparkle"].includes(p.rule)).flatMap((p) => (p.rule === "shards" ? (p.els || []).filter(light) : p.els || [])));
            let stripped = 0;
            for (const el of strip) {
              // Self-closing tags, or an open tag with its own closing tag; every copy goes.
              const tag = (el.match(/^<([a-z]+)/i) || [])[1];
              const selfClosed = /\/>$/.test(el);
              if (!selfClosed && !tag) continue;
              const lit = el.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
              const re = new RegExp(selfClosed ? lit : lit + "[\\s\\S]*?</" + tag + ">", "g");
              const n = (svg.match(re) || []).length;
              if (n) { svg = svg.replace(re, ""); stripped += n; }
            }
            // Never strip an object down to nothing: then it lands as drawn.
            if (stripped && !Lint.shapesOf(svg).length) {
              const rib = problems.find((p) => p.rule === "pill-swell");
              if (rib && !finalRefused.has(key)) { finalRefused.add(key); lintTries.set(key, 3); throw new Error(`JDraw did not place this SVG (${a.name || "unnamed"}, last try): ${rib.what}. ${rib.fix} Draw the swells as part of the sea, each one breaking and fading.`); }
              svg = String(a.svg); stripped = 0;
            }
            // Sawtooth and faceted outlines are rebuilt by JDraw as smooth
            // curved outlines through the same shape, so they cannot land as drawn.
            let repaired = 0;
            for (const rule of ["faceted", "zigzag", "ruler-edge"]) {
              const els = problems.filter((p) => p.rule === rule).flatMap((p) => p.els || []);
              if (!els.length) continue;
              const r = Lint.repairOutlines(svg, els, rule === "ruler-edge" ? "ruler" : rule);
              svg = r.svg; repaired += r.fixed;
            }
            // A mirrored outline leans and bulges on one side.
            {
              const els = problems.filter((p) => p.rule === "mirror").flatMap((p) => p.els || []);
              if (els.length) { const r = Lint.unmirror(svg, els); svg = r.svg; repaired += r.fixed; }
            }
            // Flat structure cannot land either: JDraw gives a primitive or a
            // few-point outline an uneven outline, a lens cloud lumps, a ruled
            // horizon a rise and dip, and then cuts lit, shadow and ledge
            // planes into whatever is still one flat mass, aimed at the light.
            const lintOpts = { vb, x: item.x, y: item.y, w, h, W: doc.width, H: doc.height, name: a.name, ask, otherClouds };
            const elsOf = (list, rules) => list.filter((p) => rules.includes(p.rule)).flatMap((p) => p.els || []);
            let built = 0;
            const lintNow = () => Lint.lintSvg(svg, lintOpts).problems;
            let now = stripped || repaired ? lintNow() : problems;
            for (const [mode, rules] of [["detail", ["primitive", "few-points"]], ["horizon", ["ruler-horizon"]]]) {
              const els = elsOf(now, rules);
              if (!els.length) continue;
              const r = Lint.structureRepair(svg, els, mode, null, vb);
              svg = r.svg; built += r.fixed;
            }
            if (built) now = lintNow();
            // Twice at most: a mass already split into pieces may need a second cut.
            for (let pass = 0; pass < 2; pass++) {
              if (/\b(sea|water|ocean|lake|bay|river|pond|waves?|surf|foam|spray|sky|skies|clouds?|mist|haze|glow|light)\b/i.test(a.name || "")) break;
              const flatEls = elsOf(now, ["flat-mass", "flat", "soft-rock"]);
              if (!flatEls.length) break;
              // The scene's light in this SVG's coordinates, else from above.
              const lights = (doc.layers || []).flatMap((l) => l.items || []).filter((it) => /\b(sun|moon|glow|lamp|lantern|light)\b/i.test(it.name || "") && !/pass/i.test(it.name || ""));
              let sun = null;
              for (const it of lights.sort((a, b) => (/\b(sun|moon)\b/i.test(b.name) ? 1 : 0) - (/\b(sun|moon)\b/i.test(a.name) ? 1 : 0))) {
                let c = { x: it.x, y: it.y, w: it.w, h: it.h, field: false };
                try {
                  const s0 = it.type === "image" ? Finish.unpaintEdges(Finish.decodeSvg(it.src) || "") : "";
                  const m = s0 && s0.match(/viewBox\s*=\s*["']\s*([-\d.]+)[\s,]+([-\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
                  if (s0) c = Finish.contentOf(s0, it, m ? { x: +m[1], y: +m[2], w: +m[3], h: +m[4] } : { x: 0, y: 0, w: it.w, h: it.h }, doc.width, doc.height);
                } catch {}
                if ((c.field || c.w >= 0.8 * doc.width) && /\b(sun|moon)\b/i.test(it.name || "")) {
                  try {
                    const s0 = Finish.unpaintEdges(Finish.decodeSvg(it.src) || "");
                    const m = s0.match(/viewBox\s*=\s*["']\s*([-\d.]+)[\s,]+([-\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
                    const v = m ? { x: +m[1], y: +m[2], w: +m[3], h: +m[4] } : { x: 0, y: 0, w: it.w, h: it.h };
                    const small = Lint.shapesOf(s0).filter((s) => s.fill && s.box.w * s.box.h < 0.25 * v.w * v.h).sort((a, b) => ((Lint.labOf(b.fill) || [0])[0] - (Lint.labOf(a.fill) || [0])[0]) || (b.box.w * b.box.h - a.box.w * a.box.h))[0];
                    if (small) c = { x: it.x + ((small.box.x - v.x) * it.w) / v.w, y: it.y + ((small.box.y - v.y) * it.h) / v.h, w: (small.box.w * it.w) / v.w, h: (small.box.h * it.h) / v.h, field: false };
                  } catch {}
                }
                if (c.field || c.w >= 0.8 * doc.width) continue;
                sun = c; break;
              }
              const L0 = doc.finished && Array.isArray(doc.finished.__light) ? doc.finished.__light : sun ? [sun.x + sun.w / 2, sun.y + sun.h / 2] : [doc.width * 0.35, 0];
              const light = { x: vb.x + ((L0[0] - item.x) * vb.w) / (w || 1), y: vb.y + ((L0[1] - item.y) * vb.h) / (h || 1) };
              const r = Lint.structureRepair(svg, flatEls, "planes", light, vb, pass);
              svg = r.svg; built += r.fixed;
              if (!r.fixed) break;
              now = lintNow();
            }
            // A bare sea gets its swells from JDraw.
            if (now.some((p) => p.rule === "water-flat")) { const r = Lint.addSwells(svg, vb); if (r.fixed) { svg = r.svg; built += r.fixed; now = lintNow(); } }
            // A lens cloud gets lumps first: its underside hangs in uneven lumps with
            // pockets between. Only a cloud that is still a lens after that is left out.
            if (now.some((p) => p.rule === "lens-cloud" || p.rule === "cloud-row")) {
              const lensEls = elsOf(now, ["lens-cloud", "cloud-row"]);
              if (lensEls.length) {
                const r = Lint.structureRepair(svg, lensEls, "lumps", null, vb);
                if (r.fixed) { svg = r.svg; built += r.fixed; now = lintNow(); }
              }
            }
            if (stripped || repaired || built) { item.src = svgToDataUrl(svg); a.svg = svg; }
            // A lens cloud lands with JDraw's lumps repair instead of being
            // left out: refusing it teaches the agent to leave clouds out
            // and the sky ends up empty. What is still stock is listed, so
            // the agent can draw it better next time.
            const lens = now.find((p) => p.rule === "lens-cloud" || p.rule === "cloud-row");
            const lensNote = lens ? `JDraw gave the cloud an uneven underside with lumps and shadowed pockets; it still reads as stock: ${lens.what}. ${lens.fix}` : null;
            // A flat mass or primitive outline still has no real structure
            // after repair, so it does not land silently: one more last-try
            // refusal says what to redraw, then it lands with the problems listed.
            const STRUCTURAL = new Set(["primitive", "few-points", "flat-mass", "flat", "soft-rock", "faceted", "zigzag", "mirror", "ruler-edge", "ruler-horizon", "split-tone", "even-stripes", "vertical-bands", "big-planes"]);
            const struct = now.filter((p) => STRUCTURAL.has(p.rule));
            if (struct.length && !finalRefused.has(key)) {
              finalRefused.add(key);
              lintTries.set(key, 3);
              throw new Error(`JDraw did not place this SVG (${a.name || "unnamed"}, last try): ${struct[0].what}. ${struct[0].fix} Draw the whole object again that way, with the same name.`);
            }
            // Slab strata cannot be repaired without breaking the mass, so they
            // never land: the next try is again a last try.
            const slab = now.find((p) => p.rule === "slabs") && !/\b(sea|water|ocean|lake|bay|river|pond|sky|skies|clouds?|waves?|swells?)\b/i.test(a.name || "") ? now.find((p) => p.rule === "slabs") : null;
            if (slab && !finalRefused.has(key)) {
              finalRefused.add(key);
              lintTries.set(key, 3);
              throw new Error(`JDraw did not place this SVG (${a.name || "unnamed"}, last try): ${slab.what}. ${slab.fix} Draw the whole object again without the stacked layers.`);
            }
            const left = now;
            lintNote = left.map((p) => p.what);
            if (lensNote) lintNote.unshift(lensNote);
            if (built) lintNote.unshift(`JDraw rebuilt ${built} flat shape${built === 1 ? "" : "s"} (uneven outlines, lit and shadow planes, a broken horizon)`);
            if (stripped) lintNote.unshift(`JDraw removed ${stripped} shape${stripped === 1 ? "" : "s"} that read as stock decoration`);
            if (repaired) lintNote.unshift(`JDraw redrew ${repaired} sawtooth, faceted or mirrored outline${repaired === 1 ? "" : "s"}`);
          }
        }
        const [res] = store.apply(docId, [{ op: "add_items", items: [item], layerId: layerRef(a.layer), newLayer: a.newLayer, layerIndex: a.layerIndex }], "agent");
        return { json: Object.assign({ id: res.ids[0], layerId: res.layerId, x: item.x, y: item.y, w: round(w), h: round(h) }, lintNote && lintNote.length ? { placedWithProblems: lintNote } : {}, nameTip ? { tip: nameTip } : {}) };
      }
      case "edit_items": {
        const ops = [];
        if (a.patch && Object.keys(a.patch).length) ops.push({ op: "update_items", ids: a.ids, patch: a.patch });
        if (a.dx || a.dy || (a.scale && a.scale !== 1) || a.rotate) ops.push({ op: "move_items", ids: a.ids, dx: a.dx, dy: a.dy, scale: a.scale, rotate: a.rotate });
        if (a.order) ops.push({ op: "order_items", ids: a.ids, to: a.order });
        if (a.toLayer) ops.push({ op: "move_to_layer", ids: a.ids, layerId: layerRef(a.toLayer) });
        if (!ops.length) throw new Error("Nothing to change. Give a patch, dx/dy, scale, rotate, order or toLayer.");
        store.apply(docId, ops, "agent");
        return { json: { changed: a.ids.length } };
      }
      case "arrange": {
        const ids = a.ids || [];
        const ops = {
          duplicate: { op: "duplicate_items", ids, dx: a.dx ?? 20, dy: a.dy ?? 20 },
          group: { op: "group_items", ids },
          ungroup: { op: "ungroup_items", ids },
          align: { op: "align_items", ids, how: a.how || "left", to: a.to },
          distribute: { op: "distribute_items", ids, dir: a.dir || "horizontal" },
          rotate: { op: "transform_items", ids, rotate: Number(a.degrees) || 0 },
          flip: { op: "transform_items", ids, flip: a.axis === "y" ? "y" : "x" },
        };
        if (!ops[a.action]) throw new Error(`Unknown action "${a.action}". Use one of: ${Object.keys(ops).join(", ")}.`);
        if (a.action === "align" && !["left", "center", "right", "top", "middle", "bottom"].includes(ops.align.how)) throw new Error("how must be left, center, right, top, middle or bottom.");
        const [res] = store.apply(docId, [ops[a.action]], "agent");
        return { json: res };
      }
      case "fill_area": {
        const color = G.normColor(a.color);
        if (!color) throw new Error("Not a color: " + a.color);
        const color2 = a.color2 ? G.normColor(a.color2) : null;
        if (a.color2 && !color2) throw new Error("Not a color: " + a.color2);
        const doc = store.getDoc(docId);
        const ctx = host.context(docId);
        const layerId = layerRef(a.layer) || ctx.activeLayer || doc.layers[doc.layers.length - 1].id;
        if (!doc.layers.some((l) => l.id === layerId)) throw new Error(`No layer named "${a.layer}".`);
        const res = await host.fillArea(docId, {
          x: Number(a.x), y: Number(a.y), color, color2, gradient: a.gradient,
          tolerance: a.tolerance, gap: a.gap, sample: a.sample === "layer" ? "layer" : "all", layerId,
          opacity: a.opacity,
        });
        if (!res || !res.item) throw new Error((res && res.reason) || "Nothing to fill there.");
        const [added] = store.apply(docId, [{ op: "add_items", layerId, position: "bottom", items: [res.item] }], "agent");
        return { json: { id: added.ids[0], layerId, filled: res.filled, bounds: { x: res.item.x, y: res.item.y, w: res.item.w, h: res.item.h } } };
      }
      case "delete_items": {
        const [res] = store.apply(docId, [{ op: "delete_items", ids: a.ids }], "agent");
        return { json: res };
      }
      case "recolor": {
        const [res] = store.apply(docId, [{ op: "recolor", from: a.from, to: a.to, tolerance: a.tolerance, layerId: layerRef(a.layer) }], "agent");
        return { json: res };
      }
      case "set_palette": {
        const colors = (a.colors || []).map(G.normColor).filter(Boolean);
        if (!colors.length) throw new Error("No valid colors given.");
        const op = a.mode === "replace" ? { op: "set_doc", palette: colors } : { op: "set_doc", addColors: colors };
        store.apply(docId, [op], "agent");
        return { json: { palette: store.getDoc(docId).palette } };
      }
      case "set_brush": {
        const brush = {};
        if (a.color) { brush.color = G.normColor(a.color); if (!brush.color) throw new Error("Not a color: " + a.color); }
        if (a.size) brush.size = G.clamp(Number(a.size), 0.5, 400);
        if (a.brush) brush.brush = [...G.BRUSHES, "smudge", "blur"].includes(a.brush) ? a.brush : "pen";
        if (a.opacity !== undefined) brush.opacity = G.clamp(Number(a.opacity), 0.05, 1);
        host.setBrush(docId, brush);
        return { json: { brush } };
      }
      case "canvas": {
        store.apply(docId, [{ op: "set_doc", background: a.background, width: a.width, height: a.height, anchor: a.anchor }], "agent");
        const d = store.getDoc(docId);
        return { json: { width: d.width, height: d.height, background: d.background } };
      }
      case "layers": {
        const listLayers = () => store.getDoc(docId).layers.map((l, i) => ({ id: l.id, name: l.name, index: i, visible: l.visible !== false, locked: !!l.locked, items: l.items.length }));
        a.action = layerAction(a);
        if (a.action === "list") return { json: { layers: listLayers() } };
        const L = a.layer !== undefined ? layerRef(a.layer) : undefined;
        const map = {
          lock: { op: "update_layer", layerId: L, locked: true },
          unlock: { op: "update_layer", layerId: L, locked: false },
          duplicate: { op: "duplicate_layer", layerId: L },
          add: { op: "add_layer", name: a.name, index: a.index },
          rename: { op: "update_layer", layerId: L, name: a.name },
          show: { op: "update_layer", layerId: L, visible: true },
          hide: { op: "update_layer", layerId: L, visible: false },
          opacity: { op: "update_layer", layerId: L, opacity: a.opacity },
          blend: { op: "update_layer", layerId: L, blend: a.blend },
          move: { op: "move_layer", layerId: L, index: a.index },
          merge_down: { op: "merge_down", layerId: L },
          delete: { op: "delete_layer", layerId: L },
        };
        if (!map[a.action]) throw new Error(`Unknown layer action "${a.action}". Use one of: list, ${Object.keys(map).join(", ")}.`);
        if (a.action !== "add" && L === undefined) throw new Error(`"${a.action}" needs "layer" (a layer id or name).`);
        const [res] = store.apply(docId, [map[a.action]], "agent");
        return { json: { ...res, layers: listLayers() } };
      }
      default:
        throw new Error("Unknown tool " + name);
    }
  }

  function toolResult(out) {
    const content = [];
    if (out.image) {
      content.push({ type: "image", data: out.image.base64, mimeType: "image/png" });
      if (out.text) content.push({ type: "text", text: out.text });
    } else content.push({ type: "text", text: JSON.stringify(out.json, null, 0) });
    return { content };
  }

  async function handleRpc(msg, ctx) {
    const { id, method, params } = msg;
    const reply = (result) => ({ jsonrpc: "2.0", id, result });
    const fail = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
    if (method === "initialize") {
      const asked = params && params.protocolVersion;
      return reply({
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[1],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, title: "JDraw", version: drawVersion() },
        instructions: "Tools for the drawing open in JDraw. view_drawing shows it, get_drawing lists items, draw and draw_svg add art, fill_area colors in enclosed areas, edit_items and arrange change it, set_palette adds colors for the person. list_styles and get_style give guides for drawing in a style (watercolor, pixel art, neon and more).",
      });
    }
    if (method === "ping") return reply({});
    if (method === "tools/list") return reply({ tools: allDefs.map(({ mutates, ...t }) => t) });
    if (method === "tools/call") {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      try {
        if (PICK_TOOLS.has(name)) {
          const out = await pickTool(ctx, name, args);
          // Only mutating picks earn the artifact card and turn tracking:
          // new_drawing creates a doc; list/open are reads and fire nothing.
          if (toolMutates(name, args)) try { host.onTool && host.onTool(ctx.sess.docId, name, args, null, ctx); } catch {}
          return reply(toolResult(out));
        }
        const docId = ctxDoc(ctx);
        if (!docId) return reply({ isError: true, content: [{ type: "text", text: ctx.scopeErr || "No drawing is attached to this session. Call list_drawings then open_drawing, or new_drawing." }] });
        if (toolMutates(name, args)) try { host.beforeTool && host.beforeTool(ctx, docId, name, args); } catch {}
        const out = await callTool(docId, name, args);
        try { host.onTool && host.onTool(docId, name, args, null, ctx); } catch {}
        return reply(toolResult(out));
      } catch (err) {
        try { host.onTool && host.onTool(ctx.sess && ctx.sess.docId, name, args, err, ctx); } catch {}
        return reply({ isError: true, content: [{ type: "text", text: err && err.message ? err.message : String(err) }] });
      }
    }
    if (method === "resources/list") return reply({ resources: [] });
    if (method === "prompts/list") return reply({ prompts: [] });
    if (id === undefined) return null;
    return fail(-32601, "Method not found: " + method);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname !== "/mcp") { res.writeHead(404).end(); return; }
      if (req.headers.authorization !== "Bearer " + token) { res.writeHead(401, { "Content-Type": "application/json" }).end('{"error":"unauthorized"}'); return; }
      if (req.method === "DELETE") { const sid = req.headers["mcp-session-id"]; sessions.delete(sid); sessionDocs.delete(String(sid || "")); res.writeHead(200).end(); return; }
      if (req.method !== "POST") { res.writeHead(405, { Allow: "POST, DELETE" }).end(); return; }
      const sessKey = String(req.headers["mcp-session-id"] || "") || "hdr:" + String(req.headers["x-jdraw-drawing"] || "") + ":" + String(req.headers["x-jdraw-project"] || "");
      const sess = sessionDocs.get(sessKey) || { docId: String(req.headers["x-jdraw-drawing"] || url.searchParams.get("drawing") || "") };
      // Re-insert on every request so the cap evicts the least recently used
      // binding, not a live session.
      sessionDocs.delete(sessKey);
      if (sessionDocs.size >= 256) sessionDocs.delete(sessionDocs.keys().next().value);
      sessionDocs.set(sessKey, sess);
      const ctx = {
        sess,
        projectId: String(req.headers["x-jdraw-project"] || url.searchParams.get("project") || ""),
        chatId: String(req.headers["x-jdraw-chat-id"] || ""),
      };
      const chunks = [];
      let size = 0;
      for await (const c of req) { size += c.length; if (size > 20 * 1024 * 1024) { res.writeHead(413, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Body over 20 MB. Split the artwork into smaller draw calls or place smaller images." } })); return; } chunks.push(c); }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })); return; }
      const batch = Array.isArray(body) ? body : [body];
      const headers = { "Content-Type": "application/json" };
      if (batch.some((m) => m && m.method === "initialize")) {
        const sid = crypto.randomUUID();
        sessions.add(sid);
        headers["Mcp-Session-Id"] = sid;
      }
      // Sequential: pick and use tools in one batch must run in order
      // (new_drawing then draw), and parallel calls would race on the doc.
      const replies = [];
      for (const m of batch) {
        const r = await handleRpc(m || {}, ctx);
        if (r) replies.push(r);
      }
      if (!replies.length) { res.writeHead(202, headers).end(); return; }
      res.writeHead(200, headers).end(JSON.stringify(Array.isArray(body) ? replies : replies[0]));
    } catch (err) {
      console.error("[mcp]", err);
      if (!res.headersSent) res.writeHead(500).end();
    }
  });

  return {
    token,
    url: null,
    tools,
    callTool,
    // The tool names that change a drawing, from the mutates flags. The
    // studio derives checkpoint and artifact behavior from this same set.
    mutatingToolNames,
    // Each person turn starts with a fresh refusal budget per object.
    resetLint(docId) { for (const k of [...lintTries.keys()]) if (k.startsWith(docId + "\n")) lintTries.delete(k); for (const k of [...finalRefused]) if (k.startsWith(docId + "\n")) finalRefused.delete(k); },
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          this.url = `http://127.0.0.1:${server.address().port}/mcp`;
          resolve(this.url);
        });
      });
    },
    close() { server.close(); },
    // MCP server entry for ACP session/new.
    acpEntry(docId) {
      return {
        type: "http",
        name: SERVER_NAME,
        url: this.url,
        headers: [
          { name: "Authorization", value: "Bearer " + token },
          { name: "x-jdraw-drawing", value: docId },
        ],
      };
    },
    // A JV project chat gets the drawing tools bound to its project: the
    // session can only list, open and edit drawings that belong to it.
    acpEntryFor(ids) {
      const o = ids || {};
      return {
        type: "http",
        name: SERVER_NAME,
        url: this.url,
        headers: [
          { name: "Authorization", value: "Bearer " + token },
          { name: "x-jdraw-project", value: String(o.projectId || "") },
          { name: "x-jdraw-chat-id", value: String(o.chatId || "") },
        ],
      };
    },
  };
}

module.exports = { createMcpServer, summarize, svgToDataUrl, mutatingToolNames, toolMutates };

function pickToolDefs() {
  return [
    { name: "list_drawings", description: "List the drawings in this project (id, name, when updated).", inputSchema: { type: "object", properties: {} } },
    { name: "new_drawing", mutates: true, description: "Create a blank drawing in this project and start drawing on it. size: like 1280x720; ratio: like 16/9, 1/1, 9/16.", inputSchema: { type: "object", properties: { name: { type: "string" }, size: { type: "string" }, ratio: { type: "string" } } } },
    { name: "open_drawing", description: "Open one of this project's drawings by id or name and bring it up on stage. Pass id or name.", inputSchema: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } } },
  ];
}

// Layers has one def for many actions and the callers write aliases
// (get/list, create/add, copy/duplicate...). Normalize before anything
// decides whether a call changes the drawing.
const LAYER_ALIAS = { list: "list", get: "list", create: "add", new: "add", remove: "delete", reorder: "move", visible: "show", merge: "merge_down", copy: "duplicate" };
function layerAction(a) {
  if (!a || !a.action) return "";
  if (a.action === "visibility") return a.visible === false ? "hide" : "show";
  return LAYER_ALIAS[a.action] || a.action;
}

let defCache = null;
function allToolDefs() {
  if (!defCache) defCache = tools().concat(pickToolDefs());
  return defCache;
}

// Args-aware mutation check: a read-only layers list is not a mutation even
// though the tool itself can mutate.
function toolMutates(name, args) {
  const def = allToolDefs().find((t) => t.name === name);
  return Boolean(def && (typeof def.mutates === "function" ? def.mutates(args) : def.mutates));
}

// Same set the server instance reports, for code that needs it before a
// server exists. Built from the shared defs so it cannot drift from them.
function mutatingToolNames() {
  return new Set(allToolDefs().filter((t) => t.mutates).map((t) => t.name));
}
