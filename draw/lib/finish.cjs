// The artist finish: code that runs on a finished drawing and takes off the
// marks of a model drawing by coordinates. Three passes, all deterministic:
//
// 1. Color grade (OKLCH). Stretches a squashed value range to real darks and
//    clean lights, gives gray and muddy colors a hue (cool in shadow, warm in
//    light), turns down textbook full-strength colors, and nudges every hue
//    toward one light story. This is what the user keeps calling "colors feel
//    off".
// 2. Painted edges. Each SVG an agent placed gets a filter: a low-frequency
//    displacement so edges waver like a brush or cut paper instead of a
//    plotter line, and a soft mottle inside the fills like gouache. Text is
//    left sharp.
// 3. Paper. One grain layer over the whole canvas (soft-light, faint).
//
// It returns store ops; the caller applies them as one undo step. Items it
// already finished are remembered in doc.finished (id -> color signature) so
// running it again only touches new or changed items.
const G = require("../renderer/js/geom.js");

// ---------- color

const toLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function rgbToOklch({ r, g, b }) {
  const R = toLin(r / 255), Gg = toLin(g / 255), B = toLin(b / 255);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * Gg + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * Gg + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * Gg + 0.6299787005 * B);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L, C: Math.hypot(a, bb), h: ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360 };
}

function oklchToRgb({ L, C, h }) {
  const a = C * Math.cos((h * Math.PI) / 180), b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map(toSrgb);
}

const inGamut = (rgb) => rgb.every((v) => v >= -0.001 && v <= 1.001);
const smooth = (e0, e1, x) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const hueToward = (h, target, amt, maxDeg = 180) => { const d = ((target - h + 540) % 360) - 180; const step = Math.max(-maxDeg, Math.min(maxDeg, d * amt)); return (h + step + 360) % 360; };
const hex2 = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");

const SHADOW_HUE = 255; // cool blue
const LIGHT_HUE = 75; // warm amber

// ctx: { Lmin, Lmax } of the colors in the drawing.
function gradeColor(hex, ctx) {
  const n = G.normColor(hex);
  if (!n) return hex;
  const rgb = G.hexToRgb(n);
  const alpha = n.length === 9 ? n.slice(7) : "";
  let { L, C, h } = rgbToOklch(rgb);

  // 1. Value range: only ever widened, never squashed.
  if (ctx && ctx.Lmax - ctx.Lmin > 0.05 && ctx.Lmax - ctx.Lmin < 0.8) {
    const lo = Math.min(ctx.Lmin, 0.18), hi = Math.max(ctx.Lmax, 0.92);
    const t = (L - ctx.Lmin) / (ctx.Lmax - ctx.Lmin);
    L = L + (lo + t * (hi - lo) - L) * 0.6;
  }

  const shadow = smooth(0.6, 0.18, L); // 1 in deep shadow
  const light = smooth(0.62, 0.92, L) * (1 - smooth(0.965, 0.995, L)); // 1 in warm lights, 0 at paper white
  const target = shadow >= light ? SHADOW_HUE : LIGHT_HUE;
  const pull = Math.max(shadow, light);

  if (C < 0.035) {
    // 2. Gray. True neutrals (foam, white paint, stone, text) stay neutral;
    // only dull mid grays get a faint tint from the light story, and a gray
    // that already leans keeps its own hue.
    // Mid grays (rock, stone, hulls) get a visible lean: cool in shade,
    // warm in light. Near white and near black stay neutral.
    const mid = L > 0.28 && L < 0.72;
    // A gray keeps its own hue (at most 8 degrees of lean) and only a
    // little more chroma, so stone does not turn lilac.
    if (C >= 0.012) {
      h = hueToward(h, mid ? (L < 0.5 ? SHADOW_HUE : LIGHT_HUE) : target, mid ? 1 : pull, 8);
      if (mid) C = Math.min(C * 1.15, 0.03);
    } else if (mid) {
      h = L < 0.5 ? SHADOW_HUE : LIGHT_HUE;
      C = 0.018;
    }
  } else {
    // 3. Muddy midtones get their hue back; textbook colors come down. The
    // hue moves at most 8 degrees, so the drawing keeps its own colors.
    if (L > 0.3 && L < 0.72 && C < 0.08) C *= 1.3;
    C = Math.min(C, 0.2 - 0.05 * light);
    h = hueToward(h, target, 0.12 * pull, 8);
  }

  // Gamut map by lowering chroma.
  let out = oklchToRgb({ L, C, h });
  for (let i = 0; i < 24 && !inGamut(out); i++) { C *= 0.92; out = oklchToRgb({ L, C, h }); }
  return "#" + out.map(hex2).join("") + alpha;
}

// ---------- reading colors out of items and SVG

const COLOR_PROPS = "fill|stroke|stop-color|flood-color|lighting-color|color";
const ATTR_RE = new RegExp(`(\\s(?:${COLOR_PROPS})\\s*=\\s*)(["'])([^"']*)\\2`, "gi");
const STYLE_RE = new RegExp(`((?:^|[;{\\s"'])(?:${COLOR_PROPS})\\s*:\\s*)([^;"'}]+)`, "gi");

function isColorValue(v) {
  const s = String(v).trim().toLowerCase();
  if (!s || s === "none" || s === "transparent" || s === "currentcolor" || s.startsWith("url(") || s === "inherit") return false;
  return !!G.normColor(s);
}

function svgColors(svg) {
  const out = [];
  svg.replace(ATTR_RE, (m, a, q, v) => { if (isColorValue(v)) out.push(G.normColor(v)); return m; });
  svg.replace(STYLE_RE, (m, a, v) => { if (isColorValue(v)) out.push(G.normColor(v)); return m; });
  return out;
}

function gradeSvg(svg, ctx) {
  return svg
    .replace(ATTR_RE, (m, a, q, v) => (isColorValue(v) ? `${a}${q}${gradeColor(v, ctx)}${q}` : m))
    .replace(STYLE_RE, (m, a, v) => (isColorValue(v) ? `${a}${gradeColor(v.trim(), ctx)}` : m));
}

function paintColors(p) {
  if (!p) return [];
  if (typeof p === "string") return [p];
  return (p.stops || []).map((s) => s[1]);
}

function gradePaint(p, ctx) {
  if (!p) return p;
  if (typeof p === "string") return gradeColor(p, ctx);
  return Object.assign({}, p, { stops: p.stops.map((s) => [s[0], gradeColor(s[1], ctx)]) });
}

// ---------- SVG items

function decodeSvg(src) {
  const m = typeof src === "string" && src.match(/^data:image\/svg\+xml(;base64)?,(.*)$/s);
  if (!m) return null;
  return m[1] ? Buffer.from(m[2], "base64").toString("utf8") : decodeURIComponent(m[2]);
}

const encodeSvg = (svg) => "data:image/svg+xml;base64," + Buffer.from(svg, "utf8").toString("base64");

// Splits the inside of the root <svg> into top-level nodes: [{ text, tag }].
function topLevel(inner) {
  const nodes = [];
  let i = 0, depth = 0, start = 0, curTag = null;
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\/?([A-Za-z][\w:.-]*)(?:"[^"]*"|'[^']*'|[^'">])*?(\/?)>/g;
  let m;
  while ((m = re.exec(inner))) {
    if (depth === 0 && m.index > i) nodes.push({ text: inner.slice(i, m.index), tag: null });
    const tok = m[0];
    if (tok.startsWith("<!--") || tok.startsWith("<![")) {
      if (depth === 0) { nodes.push({ text: tok, tag: null }); i = re.lastIndex; }
      continue;
    }
    const closing = tok.startsWith("</");
    const self = m[2] === "/";
    if (closing) {
      depth--;
      if (depth === 0) { nodes.push({ text: inner.slice(start, re.lastIndex), tag: curTag }); i = re.lastIndex; }
    } else if (self) {
      if (depth === 0) { nodes.push({ text: tok, tag: m[1] }); i = re.lastIndex; }
    } else {
      if (depth === 0) { start = m.index; curTag = m[1]; }
      depth++;
    }
  }
  if (i < inner.length) nodes.push({ text: inner.slice(i), tag: null });
  return nodes;
}

function hashSeed(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 997 + 1;
}

// Bumped when the filter changes, so finished items get the new one.
const FINISH_VERSION = 19;

// What an SVG actually draws, in canvas px: agents often place each object
// on a full-canvas SVG, so the item box says nothing about the object.
const SOFT_NAME = /\b(clouds?|mist|fog|haze|smoke|steam|distant|far|mountains?|hills?|glow|sky|reflections?)\b/i;
function contentOf(svg, it, vb, W, H) {
  let shapes = [];
  try { shapes = require("./svg-lint.cjs").shapesOf(svg); } catch {}
  const kx = it.w / (vb.w || 1), ky = it.h / (vb.h || 1);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of shapes) {
    if (!s.fill || s.soft) continue;
    const b = s.box;
    if (b.w >= 0.85 * vb.w && b.h >= 0.85 * vb.h) continue; // a background rect
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
  }
  const fieldNamed = /\b(sea|water|ocean|lake|bay|sky|skies)\b/i.test(it.name || "") && !/\b(rocks?|rocky|cliffs?|stones?)\b/i.test(it.name || "");
  const tall = (hh) => hh >= 0.4 * H || (fieldNamed && hh >= 0.18 * H);
  if (!(x1 > x0)) return { area: (it.w * it.h) / (W * H), x: it.x, y: it.y, w: it.w, h: it.h, field: it.w >= 0.9 * W && tall(it.h) };
  const w = (x1 - x0) * kx, h = (y1 - y0) * ky;
  // A field (sky, sea) spans the canvas; big objects (a cliff) are not one.
  return { area: Math.min(1, (w * h) / (W * H)), x: it.x + (x0 - vb.x) * kx, y: it.y + (y0 - vb.y) * ky, w, h, field: w >= 0.9 * W && tall(h) };
}
const KEEP_SHARP = new Set(["defs", "style", "title", "desc", "metadata", "text", "linearGradient", "radialGradient", "filter", "clipPath", "mask", "pattern", "symbol"]);

// Wraps the drawn parts of one SVG in a painted-edge filter. k = canvas
// pixels per SVG unit, so the wobble is the same size at any scale.
// area: share of the canvas the item covers; big fills (sky, sea) get far
// less mottle so it never reads as a filter laid over the picture.
function paintEdges(svg, k, seed, strength, vb, area = 0.1, light = 225, obj = {}) {
  const open = svg.match(/<svg\b(?:"[^"]*"|'[^']*'|[^'">])*>/i);
  const close = svg.lastIndexOf("</svg>");
  if (!open || close < 0) return svg;
  const head = svg.slice(0, open.index + open[0].length);
  const inner = svg.slice(open.index + open[0].length, close);
  const fid = `jdraw-hand-${seed}`;
  const unit = (px) => +(px / k).toFixed(3);
  const freq = (perPx) => +(perPx * k).toFixed(5);
  const s = Math.max(0, Math.min(1.5, strength));
  const mottle = s * 0.3 * (1 - 0.5 * Math.min(1, area / 0.4));
  // Objects get form: a light from one side rounds every shape (lit edge
  // toward the light, shade on the far side). Big fills stay flat.
  const field = obj.field !== undefined ? !!obj.field : area > 0.25;
  // Soft things (clouds, haze) get only a little form, so no bright bevel rim.
  const form = field ? 0 : s * (obj.soft ? 0.25 : 0.6);
  // Shading reaches into the shape in proportion to its size.
  const objMin = Math.max(20, Math.min(obj.w || 200, obj.h || 200));
  const formBlur = Math.max(4, Math.min(16, 0.08 * objMin));
  // Clouds, haze, far hills: soft edges, no pooled rim, less wobble.
  const soft = !!obj.soft;
  // A big mass carries the picture: a slow wash across it (wider than it is
  // tall, like a brush loaded unevenly) keeps it from reading as one flat
  // fill, without laying an even grain over the whole thing.
  const wash = field || soft ? 0 : s * (area >= 0.05 ? 0.15 : 0.1);
  // The wobble is sized to the object, so a small lighthouse keeps its
  // rails and windows; a field barely moves, so its edge never thins into a
  // drawn line where the field behind shows through.
  // The subject (a small solid object: the lighthouse, the boat) stays in
  // focus: half the wobble, sharp outline all round, less seam blur.
  const focus = !!obj.focus && !field && !soft;
  const wobPx = (field ? 3 : Math.min(8, Math.max(2, 0.03 * objMin)) * (soft ? 0.6 : 1)) * (focus ? 0.5 : 1);
  // Brush strokes: visible, only on objects, a little longer along the object
  // (axis-aligned streaks read as scan lines on skies and a plaid on rock).
  const tall = (obj.h || 0) > 1.6 * (obj.w || 1);
  const sf = tall ? `${freq(1 / 12)} ${freq(1 / 30)}` : `${freq(1 / 30)} ${freq(1 / 12)}`;
  const stroke = field || soft ? 0 : s * 0.2;
  // Seams between tones inside a shape melt like wet paint while its
  // outline stays sharp: the blur only lands inside a shrunk copy of the shape.
  const coreR = field ? 4 : Math.max(3, Math.min(10, 0.05 * objMin));
  const seamBlur = (field ? 7 : soft ? 8 : Math.max(3, Math.min(9, 0.04 * objMin))) * (focus ? 0.6 : 1);
  // Light from where the scene's light is (azimuth/elevation per object).
  const lAz = Number.isFinite(Number(obj.az)) ? Number(obj.az) : light;
  const lEl = Number.isFinite(Number(obj.el)) ? Number(obj.el) : 30; // kept at 30 so flat fills stay neutral
  const filter =
    // Region in user units: the whole viewBox plus room for the displacement,
    // so thin parts (masts, rails) are never clipped to straight edges.
    `<defs><filter id="${fid}" filterUnits="userSpaceOnUse" x="${vb.x - unit(16)}" y="${vb.y - unit(16)}" width="${vb.w + unit(32)}" height="${vb.h + unit(32)}" color-interpolation-filters="sRGB">` +
    `<feTurbulence type="fractalNoise" baseFrequency="${freq(1 / 40)}" numOctaves="2" seed="${seed}" result="w"/>` +
    `<feDisplacementMap in="SourceGraphic" in2="w" scale="${unit(wobPx * s)}" xChannelSelector="R" yChannelSelector="G" result="d0"/>` +
    // A second, medium wobble so edges are uneven without the fine jagged
    // tear that made every outline look like cut paper.
    `<feTurbulence type="fractalNoise" baseFrequency="${freq(1 / 14)}" numOctaves="1" seed="${seed + 5}" result="f"/>` +
    `<feDisplacementMap in="d0" in2="f" scale="${unit((field ? 1 : 2) * s * (soft ? 0.6 : 1) * (focus ? 0.5 : 1))}" xChannelSelector="G" yChannelSelector="R" result="d"/>` +
    // Tone seams blend like wet paint: a well blurred copy, kept to the
    // inside of the shape (a shrunk, softened copy of its alpha), mixed
    // mostly blur over the sharp one. The outline itself is untouched.
    `<feMorphology in="d" operator="erode" radius="${unit(coreR)}" result="core0"/>` +
    `<feGaussianBlur in="core0" stdDeviation="${unit(coreR / 2)}" result="core"/>` +
    `<feGaussianBlur in="d" stdDeviation="${unit(seamBlur)}" result="db"/>` +
    `<feComposite in="db" in2="core" operator="in" result="dbi"/>` +
    `<feComposite in="d" in2="dbi" operator="arithmetic" k1="0" k2="0.6" k3="0.4" k4="0" result="dm0"/>` +
    // Over the sharp copy, so the edge stays fully opaque (no see-through band).
    `<feComposite in="dm0" in2="d" operator="over" result="dm"/>` +
    // An opaque copy to blend into, so see-through pixels keep their color
    // instead of being pulled toward the gray of the noise.
    `<feColorMatrix in="dm" type="matrix" values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 0 1" result="dop"/>` +
    `<feTurbulence type="fractalNoise" baseFrequency="${freq(area > 0.25 ? 1 / 140 : 1 / 60)}" numOctaves="2" seed="${seed + 11}" result="n"/>` +
    `<feColorMatrix in="n" type="saturate" values="0" result="ng"/>` +
    `<feComponentTransfer in="ng" result="nm"><feFuncR type="linear" slope="${mottle.toFixed(2)}" intercept="${(0.5 - mottle / 2).toFixed(2)}"/><feFuncG type="linear" slope="${mottle.toFixed(2)}" intercept="${(0.5 - mottle / 2).toFixed(2)}"/><feFuncB type="linear" slope="${mottle.toFixed(2)}" intercept="${(0.5 - mottle / 2).toFixed(2)}"/><feFuncA type="linear" slope="0" intercept="1"/></feComponentTransfer>` +
    `<feBlend in="nm" in2="dop" mode="soft-light" result="b"/>` +
    // A wash over big shapes: slow, uneven ridges of tone, the way a loaded
    // brush leaves more paint in some places than others.
    `<feTurbulence type="fractalNoise" baseFrequency="${freq(1 / 420)} ${freq(1 / 150)}" numOctaves="3" seed="${seed + 31}" result="w2"/>` +
    `<feColorMatrix in="w2" type="saturate" values="0" result="w2g"/>` +
    `<feComponentTransfer in="w2g" result="w2m"><feFuncR type="linear" slope="${wash.toFixed(2)}" intercept="${(0.5 - wash / 2).toFixed(2)}"/><feFuncG type="linear" slope="${wash.toFixed(2)}" intercept="${(0.5 - wash / 2).toFixed(2)}"/><feFuncB type="linear" slope="${wash.toFixed(2)}" intercept="${(0.5 - wash / 2).toFixed(2)}"/><feFuncA type="linear" slope="0" intercept="1"/></feComponentTransfer>` +
    `<feBlend in="w2m" in2="b" mode="soft-light" result="b2"/>` +
    `<feComposite in="b2" in2="d" operator="in" result="mottled"/>` +
    // Form shading from the shape's own blurred outline.
    `<feGaussianBlur in="d" stdDeviation="${unit(formBlur)}" result="ab"/>` +
    `<feDiffuseLighting in="ab" surfaceScale="${+(formBlur * 1.3).toFixed(1)}" diffuseConstant="1" lighting-color="#fff" result="lit0"><feDistantLight azimuth="${+lAz.toFixed(1)}" elevation="${+lEl.toFixed(1)}"/></feDiffuseLighting>` +
    // The lighting works from an 8-bit blurred alpha, so its slopes come out
    // in steps (stripes across big soft shapes); a blur smooths them away.
    `<feGaussianBlur in="lit0" stdDeviation="${unit(Math.max(2, formBlur / 4))}" result="lit"/>` +
    // Warm on the side that faces the light, cool on the far side.
    `<feColorMatrix in="lit" type="matrix" values="0.4 0.4 0.4 0 -0.1  0.333 0.333 0.334 0 0  0.267 0.267 0.266 0 0.1  0 0 0 1 0" result="litg"/>` +
    `<feComponentTransfer in="litg" result="litm"><feFuncR type="linear" slope="${form.toFixed(2)}" intercept="${(0.5 - form / 2).toFixed(2)}"/><feFuncG type="linear" slope="${form.toFixed(2)}" intercept="${(0.5 - form / 2).toFixed(2)}"/><feFuncB type="linear" slope="${form.toFixed(2)}" intercept="${(0.5 - form / 2).toFixed(2)}"/><feFuncA type="linear" slope="0" intercept="1"/></feComponentTransfer>` +
    `<feBlend in="litm" in2="mottled" mode="soft-light" result="sh0"/>` +
    // Brush strokes, mostly along one direction.
    `<feTurbulence type="fractalNoise" baseFrequency="${sf}" numOctaves="1" seed="${seed + 17}" result="st"/>` +
    `<feColorMatrix in="st" type="saturate" values="0" result="stg"/>` +
    `<feComponentTransfer in="stg" result="stm"><feFuncR type="linear" slope="${stroke.toFixed(2)}" intercept="${(0.5 - stroke / 2).toFixed(2)}"/><feFuncG type="linear" slope="${stroke.toFixed(2)}" intercept="${(0.5 - stroke / 2).toFixed(2)}"/><feFuncB type="linear" slope="${stroke.toFixed(2)}" intercept="${(0.5 - stroke / 2).toFixed(2)}"/><feFuncA type="linear" slope="0" intercept="1"/></feComponentTransfer>` +
    `<feBlend in="stm" in2="sh0" mode="soft-light" result="sh1"/>` +
    `<feComposite in="sh1" in2="d" operator="in" result="shaded"/>` +
    // Pigment pooling: paint gathers at the edge of each wash, so a soft
    // darker rim sits just inside every shape.
    `<feMorphology in="d" operator="erode" radius="${unit(2.5)}" result="er"/>` +
    `<feComposite in="d" in2="er" operator="out" result="ring"/>` +
    `<feGaussianBlur in="ring" stdDeviation="${unit(1.6)}" result="ringb"/>` +
    `<feColorMatrix in="ringb" type="matrix" values="0 0 0 0 0.08 0 0 0 0 0.06 0 0 0 0 0.1 0 0 0 ${(soft || field ? 0 : 0.2 * s).toFixed(2)} 0" result="rim"/>` +
    `<feComposite in="rim" in2="shaded" operator="atop" result="painted"/>` +
    // Bleed: at the SVG's own border the wobble would pull in empty pixels
    // (white specks along the canvas edge). Fill that thin band from a
    // grown copy of the drawing.
    (obj.canvasEdge === false
      ? `<feOffset in="painted" dx="0" dy="0" result="out"/>`
      : `<feMorphology in="SourceGraphic" operator="dilate" radius="${unit(6)}" result="grown"/>` + `<feFlood flood-color="#000" flood-opacity="1" x="${vb.x + unit(6)}" y="${vb.y + unit(6)}" width="${Math.max(0, vb.w - unit(12))}" height="${Math.max(0, vb.h - unit(12))}" result="inner"/>` + `<feComposite in="grown" in2="inner" operator="out" result="band"/>` + `<feComposite in="painted" in2="band" operator="over" result="out"/>`) +
    // Lost and found edges: a slow noise picks stretches of the outline that
    // melt into a blurred copy; the rest stay crisp. Clouds and haze melt all round.
    `<feGaussianBlur in="out" stdDeviation="${unit(soft ? 3.5 : 1.5)}" result="ob"/>` +
    `<feTurbulence type="fractalNoise" baseFrequency="${freq(1 / 160)}" numOctaves="1" seed="${seed + 23}" result="en"/>` +
    `<feColorMatrix in="en" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 ${soft ? "0 0 0 0 1" : field || focus ? "0 0 0 0 0" : "4 0 0 0 -2.3"}" result="emask"/>` +
    // Only the outline melts: the sharp picture fades out at its edge (alpha
    // from the blurred copy) and a soft halo of the blur sits just outside.
    `<feComposite in="out" in2="ob" operator="in" result="inner"/>` +
    `<feComposite in="ob" in2="out" operator="out" result="halo"/>` +
    `<feComposite in="inner" in2="halo" operator="over" result="melt"/>` +
    `<feComposite in="melt" in2="emask" operator="in" result="lost"/>` +
    `<feComposite in="out" in2="emask" operator="out" result="found"/>` +
    `<feComposite in="lost" in2="found" operator="arithmetic" k1="0" k2="1" k3="1" k4="0"/>` +
    `</filter></defs>`;
  const parts = [];
  let run = [];
  const flush = () => { if (run.length) { parts.push(`<g filter="url(#${fid})">${run.join("")}</g>`); run = []; } };
  for (const n of topLevel(inner)) {
    if (!n.tag) { (run.length ? run : parts).push(n.text); continue; }
    if (KEEP_SHARP.has(n.tag)) { flush(); parts.push(n.text); } else run.push(n.text);
  }
  flush();
  const markedHead = head.replace(/<svg\b/i, `<svg data-jdraw-finish="${+s.toFixed(2)}" data-jdraw-fv="${FINISH_VERSION}"`);
  return markedHead + filter + parts.join("") + svg.slice(close);
}

// Takes a painted-edge finish back off an SVG.
function unpaintEdges(svg) {
  const fid = (svg.match(/jdraw-hand-(\d+)/) || [])[1];
  const marks = (t) => t.replace(/\sdata-jdraw-finish="[^"]*"/, "").replace(/\sdata-jdraw-fv="[^"]*"/, "").replace(/\sdata-jdraw-lit="[^"]*"/, "");
  if (!fid) return marks(svg);
  const out = svg.replace(new RegExp(`<defs><filter id="jdraw-hand-${fid}"[\\s\\S]*?</filter></defs>`), "");
  const open = out.match(/<svg\b(?:"[^"]*"|'[^']*'|[^'">])*>/i);
  const close = out.lastIndexOf("</svg>");
  if (!open || close < 0) return out;
  const start = open.index + open[0].length;
  const wrap = `<g filter="url(#jdraw-hand-${fid})">`;
  const inner = topLevel(out.slice(start, close)).map((n) => (n.tag === "g" && n.text.startsWith(wrap) ? n.text.slice(wrap.length, -"</g>".length) : n.text)).join("");
  return marks(out.slice(0, start)) + inner + out.slice(close);
}

function paintedStrength(svg) {
  const m = svg.match(/data-jdraw-finish="([\d.]+)"/);
  return m ? Number(m[1]) : null;
}

function viewBoxOf(svg, item) {
  const vb = svg.match(/viewBox\s*=\s*["']\s*([-\d.]+)[\s,]+([-\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  if (vb) return { x: +vb[1], y: +vb[2], w: +vb[3], h: +vb[4] };
  const w = Number((svg.match(/\swidth\s*=\s*["']?([\d.]+)/i) || [])[1]) || item.w || 100;
  const h = Number((svg.match(/\sheight\s*=\s*["']?([\d.]+)/i) || [])[1]) || item.h || 100;
  return { x: 0, y: 0, w, h };
}

// ---------- paper

function paperSvg(W, H, seed) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" data-jdraw-paper="1">` +
    `<filter id="p" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">` +
    `<feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="${seed}" stitchTiles="stitch" result="fine"/>` +
    `<feTurbulence type="fractalNoise" baseFrequency="0.006 0.009" numOctaves="3" seed="${seed + 3}" result="tooth"/>` +
    `<feBlend in="fine" in2="tooth" mode="overlay" result="mix"/>` +
    `<feColorMatrix in="mix" type="saturate" values="0"/>` +
    `<feComponentTransfer><feFuncA type="linear" slope="0" intercept="1"/></feComponentTransfer>` +
    `</filter><rect width="${W}" height="${H}" filter="url(#p)"/></svg>`
  );
}

const PAPER_NAME = "Paper grain";
const PAPER_LAYER = "JDraw paper";
// Soft-light has to be on the layer: an item blended onto its own empty
// layer canvas comes out as a flat gray veil.
const PAPER_LAYER_STYLE = { blend: "soft-light", opacity: 0.25, paper: true };
const isPaper = (it) => it.type === "image" && (it.name === PAPER_NAME || it.name === LIGHT_NAME || /data-jdraw-paper/.test(decodeSvg(it.src) || ""));
const LIGHT_NAME = "Light pass";
const LIGHT_LAYER = "JDraw light";
const LIGHT_LAYER_STYLE = { blend: "screen", opacity: 0.55, paper: true };
// Bumped when the light pass changes, so an existing light layer is redrawn.
const LIGHT_VERSION = 2;
const isLight = (it) => it.type === "image" && (it.name === LIGHT_NAME || /data-jdraw-paper="light"/.test(decodeSvg(it.src) || ""));

// The light pass SVG: a warm glow at the light with a torn halo that bleeds
// into the sky and cloud around it, and below it on the sea a broken path of
// soft glints (no column with straight sides, no ladder of even rungs), each
// one bowing and breaking, fading toward the viewer.
function lightRng(seed) {
  let v = (seed | 0) || 1;
  return () => {
    v = (Math.imul(v ^ (v >>> 15), 2246822507) + 0x9e3779b9) >>> 0;
    return v / 4294967296;
  };
}
function lightSvg(W, H, lp, seaTop, seed, mask) {
  const r = 0.13 * W;
  const onLine = seaTop !== null && Math.abs(lp.y - seaTop) < 0.04 * H;
  const gy = onLine ? seaTop - 0.08 * H : lp.y;
  // A small hot core, and a wide halo whose edge is torn by noise: the light
  // spreads into the cloud and sky around it instead of stopping at a disc.
  const glow =
    `<radialGradient id="lg" cx="${lp.x}" cy="${gy}" r="${r}" gradientUnits="userSpaceOnUse"${onLine ? ` gradientTransform="translate(${lp.x} ${gy}) scale(1.6 0.5) translate(${-lp.x} ${-gy})"` : ""}><stop offset="0" stop-color="#ffefcf" stop-opacity="0.85"/><stop offset="0.4" stop-color="#ffcf9a" stop-opacity="0.32"/><stop offset="1" stop-color="#ff9a6a" stop-opacity="0"/></radialGradient>` +
    `<radialGradient id="lgh" cx="${lp.x}" cy="${gy}" r="${(0.5 * W).toFixed(1)}" gradientUnits="userSpaceOnUse"${onLine ? ` gradientTransform="translate(${lp.x} ${gy}) scale(1.3 0.42) translate(${-lp.x} ${-gy})"` : ""}><stop offset="0" stop-color="#ffdca6" stop-opacity="0.4"/><stop offset="0.28" stop-color="#ffc38a" stop-opacity="0.19"/><stop offset="0.62" stop-color="#ffab74" stop-opacity="0.07"/><stop offset="1" stop-color="#ff9a6a" stop-opacity="0"/></radialGradient>` +
    `<filter id="lghf" filterUnits="userSpaceOnUse" x="${-W}" y="${-H}" width="${3 * W}" height="${3 * H}" color-interpolation-filters="sRGB">` +
    `<feTurbulence type="fractalNoise" baseFrequency="${(1.4 / W).toFixed(6)}" numOctaves="2" seed="${seed % 991}" result="hn"/>` +
    `<feDisplacementMap in="SourceGraphic" in2="hn" scale="${(0.12 * W).toFixed(1)}" xChannelSelector="R" yChannelSelector="G"/>` +
    `<feGaussianBlur stdDeviation="${(0.035 * W).toFixed(1)}"/></filter>`;
  // The light on the water stops well short of the bottom edge and fades.
  const yEnd = seaTop !== null ? seaTop + 0.62 * (H - seaTop) : H;
  let path = "", glints = "";
  if (seaTop !== null && lp.y < seaTop + 0.02 * H && seaTop < 0.92 * H && lp.x > -0.05 * W && lp.x < 1.05 * W) {
    const top = seaTop + 2;
    path =
      `<linearGradient id="lpg" x1="0" y1="${top}" x2="0" y2="${yEnd}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#ffe2b4" stop-opacity="0.8"/><stop offset="0.4" stop-color="#ffbb84" stop-opacity="0.5"/><stop offset="1" stop-color="#ff9a6a" stop-opacity="0.08"/></linearGradient>` +
      // Soft edges on every glint, so none of them is a rung with cut ends.
      `<filter id="lpf" filterUnits="userSpaceOnUse" x="${-W}" y="${-H}" width="${3 * W}" height="${3 * H}" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="${(0.007 * W).toFixed(1)} ${Math.max(2, 0.0024 * H).toFixed(1)}"/></filter>`;
    const rnd = lightRng(seed * 7 + 13);
    const n = 15 + Math.floor(rnd() * 7);
    const span = yEnd - top;
    let lastX = lp.x;
    for (let k = 0; k < n; k++) {
      // Perspective: the glints gather near the horizon and spread out, widen
      // and thicken toward the viewer; some rows are missing altogether.
      const u = (k + 0.35 + 0.5 * rnd()) / n;
      const t = Math.pow(u, 1.5);
      const y = top + 0.06 * span + t * 0.92 * span;
      if (rnd() < 0.1) continue;
      const spread = (0.03 + 0.1 * t) * W;
      const drift = (rnd() * 2 - 1) * spread * 0.7;
      const cx = Math.max(0.03 * W, Math.min(0.97 * W, lp.x + drift + (lastX - lp.x) * 0.2));
      lastX = cx;
      const half = spread * (0.28 + 0.42 * rnd());
      const th = (0.004 + 0.012 * t) * H * (0.55 + 0.8 * rnd());
      // Two bows, different on each side: the crest rises more at one end.
      const l = cx - half, rr = cx + half * (0.5 + 0.7 * rnd());
      const upA = y - th * (0.7 + 0.6 * rnd()), upB = y - th * (0.25 + 0.5 * rnd());
      const dnA = y + th * (0.35 + 0.3 * rnd()), dnB = y + th * (0.6 + 0.5 * rnd());
      glints += `<path d="M${l.toFixed(1)},${y.toFixed(1)} C${(l + (rr - l) * 0.25).toFixed(1)},${upA.toFixed(1)} ${(l + (rr - l) * 0.72).toFixed(1)},${upB.toFixed(1)} ${rr.toFixed(1)},${y.toFixed(1)} C${(l + (rr - l) * 0.68).toFixed(1)},${dnB.toFixed(1)} ${(l + (rr - l) * 0.22).toFixed(1)},${dnA.toFixed(1)} ${l.toFixed(1)},${y.toFixed(1)} Z"/>`;
      // A thin bright crest on some of them, and a small dash beside others.
      if (rnd() < 0.5) {
        const c2 = cx + (rnd() * 2 - 1) * half * 0.8, w2 = half * (0.25 + 0.4 * rnd());
        glints += `<path d="M${(c2 - w2).toFixed(1)},${(y - th * 0.55).toFixed(1)} C${(c2 - w2 * 0.3).toFixed(1)},${(y - th * 1.15).toFixed(1)} ${(c2 + w2 * 0.4).toFixed(1)},${(y - th * 1.0).toFixed(1)} ${(c2 + w2).toFixed(1)},${(y - th * 0.5).toFixed(1)} C${(c2 + w2 * 0.3).toFixed(1)},${(y - th * 0.75).toFixed(1)} ${(c2 - w2 * 0.2).toFixed(1)},${(y - th * 0.8).toFixed(1)} ${(c2 - w2).toFixed(1)},${(y - th * 0.55).toFixed(1)} Z"/>`;
      }
    }
    // A broad, soft wash under the glints: overlapping blobs of uneven width,
    // never one wedge with straight sides.
    let wash = "";
    for (let k = 0; k < 7; k++) {
      const u = (k + 0.6) / 7, t = Math.pow(u, 1.4);
      const y = top + t * 0.95 * span;
      const rx = (0.012 + 0.05 * t) * W * (0.7 + 0.6 * rnd()), ry = Math.max(6, (0.012 + 0.02 * t) * H);
      wash += `<ellipse cx="${(lp.x + (rnd() * 2 - 1) * 0.03 * W).toFixed(1)}" cy="${y.toFixed(1)}" rx="${rx.toFixed(1)}" ry="${ry.toFixed(1)}"/>`;
    }
    glints = `<g fill="url(#lpg)" filter="url(#lpf)"><g opacity="0.5">${wash}</g>${glints}</g>`;
  }
  // The glints stay on the water: masked to the sea items, minus every
  // object drawn over the sea (the rock, the boat).
  const img = (m, f) => `<image href="${encodeSvg(m.svg)}" x="${m.x}" y="${m.y}" width="${m.w}" height="${m.h}" preserveAspectRatio="none" filter="url(#${f})"/>`;
  const maskDef = path && mask && mask.sea.length
    ? `<filter id="lmw"><feFlood flood-color="#fff"/><feComposite in2="SourceAlpha" operator="in"/></filter><filter id="lmb"><feFlood flood-color="#000"/><feComposite in2="SourceAlpha" operator="in"/></filter><mask id="lpm" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}">${mask.sea.map((m) => img(m, "lmw")).join("")}${mask.over.map((m) => img(m, "lmb")).join("")}</mask>`
    : "";
  const body = maskDef ? `<g mask="url(#lpm)">${glints}</g>` : glints;
  const haloW = 1.05 * W, haloH = 0.62 * W;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" data-jdraw-paper="light"><defs>${glow}${path}${maskDef}</defs><rect x="${(lp.x - haloW / 2).toFixed(1)}" y="${(gy - haloH / 2).toFixed(1)}" width="${haloW.toFixed(1)}" height="${haloH.toFixed(1)}" fill="url(#lgh)" filter="url(#lghf)"/><rect x="${lp.x - 1.7 * r}" y="${gy - r}" width="${3.4 * r}" height="${2 * r}" fill="url(#lg)"/>${body}</svg>`;
}

// ---------- the pass

function itemColors(it) {
  if (it.type === "image") { const svg = decodeSvg(it.src); return svg ? svgColors(svg) : []; }
  const out = [...paintColors(it.fill), ...paintColors(it.stroke)];
  if (it.color) out.push(it.color);
  return out.filter(Boolean);
}

// Lightness range of every opaque color in the drawing.
function colorRange(doc, keep) {
  const Ls = [];
  const add = (c) => { const n = G.normColor(c); if (n && (n.length < 9 || parseInt(n.slice(7), 16) > 160)) Ls.push(rgbToOklch(G.hexToRgb(n)).L); };
  if (doc.background) add(doc.background);
  for (const l of doc.layers || []) for (const it of l.items || []) if (!isPaper(it) && !(keep && keep.has(it.id))) itemColors(it).forEach(add);
  if (!Ls.length) return null;
  Ls.sort((a, b) => a - b);
  // Ignore the odd outlier so one black outline does not hide a gray picture.
  const q = (p) => Ls[Math.min(Ls.length - 1, Math.max(0, Math.round(p * (Ls.length - 1))))];
  return { Lmin: Ls.length > 8 ? q(0.03) : Ls[0], Lmax: Ls.length > 8 ? q(0.97) : Ls[Ls.length - 1] };
}

// An item's colors and shapes (without the painted-edge filter), hashed.
const crypto = require("node:crypto");
function signature(it) {
  const src = it.type === "image" ? unpaintEdges(decodeSvg(it.src) || it.src || "") : null;
  return crypto.createHash("sha1").update(JSON.stringify([it.fill, it.stroke, it.color, src])).digest("hex").slice(0, 16);
}

// opts: { grade, edges, grain } (booleans, all on by default), strength 0.3..1.5
// keep: ids of items to leave alone (the person's own work).
// Returns { ops, stats } where ops is [] when there is nothing to do.
function finishOps(doc, opts = {}, keep = null) {
  const grade = opts.grade !== false, edges = opts.edges !== false, grain = opts.grain !== false;
  const strength = Number.isFinite(Number(opts.strength)) ? Math.max(0.3, Math.min(1.5, Number(opts.strength))) : 1;
  const done = Object.assign({}, doc.finished || {});
  // The range of the first pass is kept, so items redrawn later are graded
  // the same way instead of against colors that were already stretched.
  const ctx = grade ? (done.__range ? { Lmin: done.__range[0], Lmax: done.__range[1] } : colorRange(doc, keep)) : null;
  const ops = [];
  const stats = { graded: 0, painted: 0, unpainted: 0, paper: false, range: ctx && { from: [+ctx.Lmin.toFixed(2), +ctx.Lmax.toFixed(2)] } };
  const ids = new Set();
  const nextDone = {};
  // Where the scene's light is (canvas px), measured once from the first
  // render and kept, so redrawn objects get the same light.
  const lp = opts.lightAt && Number.isFinite(opts.lightAt.x) ? opts.lightAt : Array.isArray(done.__light) ? { x: done.__light[0], y: done.__light[1] } : null;
  const litMark = lp ? `data-jdraw-lit="${Math.round(lp.x)},${Math.round(lp.y)}"` : null;
  const azFor = (c) => (lp ? ((Math.atan2(lp.y - (c.y + c.h / 2), lp.x - (c.x + c.w / 2)) * 180) / Math.PI + 360) % 360 : Number.isFinite(Number(opts.light)) ? Number(opts.light) : 225);

  for (const layer of doc.layers || []) {
    for (let it of layer.items || []) {
      ids.add(it.id);
      if (isPaper(it) || (keep && keep.has(it.id))) continue;
      // Hidden layers keep what they had; they are finished when shown.
      if (layer.visible === false) { if (done[it.id]) nextDone[it.id] = done[it.id]; continue; }
      const sig = signature(it);
      const needGrade = grade && done[it.id] !== sig;
      const patch = {};
      if (it.type === "image") {
        const orig = decodeSvg(it.src);
        if (!orig) continue;
        let svg = orig;
        const was = paintedStrength(svg);
        const old = was !== null && (!svg.includes(`data-jdraw-fv="${FINISH_VERSION}"`) || (litMark && !svg.includes(litMark)));
        if (was !== null && (!edges || old || Math.abs(was - strength) > 0.01 || needGrade)) { svg = unpaintEdges(svg); if (!edges) stats.unpainted++; }
        if (needGrade) svg = gradeSvg(svg, ctx);
        if (edges && paintedStrength(svg) === null) {
          let vb = viewBoxOf(svg, it);
          // Room to paint: an SVG cut tight around its object would clip the
          // wobble and the soft edges to straight lines at its border. Sides
          // not on the canvas edge grow by a margin, once.
          const W = doc.width, H = doc.height;
          const atL = it.x <= 1, atT = it.y <= 1, atR = it.x + it.w >= W - 1, atB = it.y + it.h >= H - 1;
          // Only when the viewBox has the item's shape: padding sets
          // preserveAspectRatio none, which would stretch a letterboxed SVG.
          const sameShape = vb.w > 0 && vb.h > 0 && it.h > 0 && Math.abs(vb.w / vb.h - it.w / it.h) < 0.01 * (it.w / it.h);
          if (!/data-jdraw-pad=/.test(svg) && sameShape && !(atL && atT && atR && atB) && it.w > 0 && it.h > 0) {
            const m = 24, kx = it.w / (vb.w || 1), ky = it.h / (vb.h || 1);
            // Never past the canvas edge.
            const pl = atL ? 0 : Math.min(m, it.x), pt = atT ? 0 : Math.min(m, it.y), pr = atR ? 0 : Math.min(m, W - it.x - it.w), pb = atB ? 0 : Math.min(m, H - it.y - it.h);
            const nvb = { x: vb.x - pl / kx, y: vb.y - pt / ky, w: vb.w + (pl + pr) / kx, h: vb.h + (pt + pb) / ky };
            const head = svg.match(/<svg\b(?:"[^"]*"|'[^']*'|[^'">])*>/i);
            if (head) {
              let h2 = head[0].replace(/\s(width|height|viewBox|preserveAspectRatio)\s*=\s*("[^"]*"|'[^']*')/gi, "");
              h2 = h2.replace(/<svg\b/i, `<svg viewBox="${+nvb.x.toFixed(2)} ${+nvb.y.toFixed(2)} ${+nvb.w.toFixed(2)} ${+nvb.h.toFixed(2)}" preserveAspectRatio="none" data-jdraw-pad="${m}"`);
              svg = svg.slice(0, head.index) + h2 + svg.slice(head.index + head[0].length);
              Object.assign(patch, { x: it.x - pl, y: it.y - pt, w: it.w + pl + pr, h: it.h + pt + pb });
              it = Object.assign({}, it, patch);
              vb = nvb;
            }
          }
          const canvasEdge = it.x <= 1 || it.y <= 1 || it.x + it.w >= W - 1 || it.y + it.h >= H - 1;
          const c = contentOf(svg, it, vb, doc.width, doc.height);
          svg = paintEdges(svg, it.w / (vb.w || 1), hashSeed(it.id), strength, vb, c.area, azFor(c), { w: c.w, h: c.h, field: c.field, soft: SOFT_NAME.test(it.name || ""), canvasEdge, focus: !c.field && (c.w * c.h < 0.12 * W * H || (/\b(rocks?|rocky|cliffs?|crags?|stones?|boulders?|bluffs?|headland|outcrop)\b/i.test(it.name || "") && !/\b(surf|foam|spray|waves?|shadows?|moss|mist)\b/i.test(it.name || ""))) });
          if (lp) svg = svg.replace(/<svg\b/i,`<svg data-jdraw-lit="${Math.round(lp.x)},${Math.round(lp.y)}"`);
          if (was === null || old || Math.abs(was - strength) > 0.01) stats.painted++;
        }
        if (svg !== orig) patch.src = encodeSvg(svg);
      } else if (needGrade) {
        if (it.fill) patch.fill = gradePaint(it.fill, ctx);
        if (it.stroke) patch.stroke = gradePaint(it.stroke, ctx);
        if (it.color) patch.color = gradeColor(it.color, ctx);
      }
      if (needGrade) stats.graded++;
      if (Object.keys(patch).length) ops.push({ op: "update_items", ids: [it.id], patch });
      const mark = grade ? signature(Object.assign({}, it, patch)) : done[it.id];
      if (mark) nextDone[it.id] = mark;
    }
  }

  // The background is graded once per color, and only when the drawing has
  // none of the person's own work on it.
  let bg;
  if (grade && doc.background && !(keep && keep.size) && done.__bg !== doc.background) {
    bg = gradeColor(doc.background, ctx);
    nextDone.__bg = bg;
  } else if (done.__bg) nextDone.__bg = done.__bg;
  if (lp) nextDone.__light = [Math.round(lp.x), Math.round(lp.y)];
  if (opts.lightAt && typeof opts.lightAt.sky === "string") nextDone.__lightSky = opts.lightAt.sky;
  else if (done.__lightSky !== undefined) nextDone.__lightSky = done.__lightSky;
  if (done.__range) nextDone.__range = done.__range;
  else if (ctx && Object.keys(nextDone).some((k) => !k.startsWith("__"))) nextDone.__range = [+ctx.Lmin.toFixed(3), +ctx.Lmax.toFixed(3)];

  // The light pass: the scene's light given a job in code, on its own layer
  // under the paper. A soft glow at the source, and when the source sits
  // above the sea, a broken warm path on the water below it.
  const lightLayer = (doc.layers || []).find((l) => (l.items || []).some(isLight));
  let seaTop = null;
  const mask = { sea: [], over: [] };
  let maskSig = "";
  for (const layer of doc.layers || []) {
    if (layer.visible === false) continue;
    for (const it of layer.items || []) {
      if (it.type !== "image" || isPaper(it)) continue;
      const isSea = /\b(sea|water|ocean|lake|bay|river|pond|waves?|swells?)\b/i.test(it.name || "");
      // Anything drawn after a sea item covers the water there.
      if (!isSea) {
        if (mask.sea.length && !/\b(sky|glow|light|halo|haze|mist|reflections?|glints?|sparkles?)\b/i.test(it.name || "")) {
          const svg = unpaintEdges(decodeSvg(it.src) || "");
          if (svg) { mask.over.push({ svg, x: it.x, y: it.y, w: it.w, h: it.h }); maskSig += it.id + signature(it) + [it.x, it.y, it.w, it.h].map(Math.round).join(","); }
        }
        continue;
      }
      const svg = unpaintEdges(decodeSvg(it.src) || ""); // shapes inside the paint filter read as soft
      if (!svg) continue;
      const vbS = viewBoxOf(svg, it);
      const c = contentOf(svg, it, vbS, doc.width, doc.height);
      // The waterline is the top of the water shape itself (the largest
      // full-width shape reaching the bottom), not of a sky drawn in the same item.
      let cy = c.y;
      try {
        const water = require("./svg-lint.cjs").shapesOf(svg).filter((sh) => sh.fill && sh.closed && sh.box.w >= 0.85 * vbS.w && sh.box.y + sh.box.h >= vbS.y + 0.9 * vbS.h && sh.box.y > vbS.y + 0.05 * vbS.h).sort((m, n) => n.box.w * n.box.h - m.box.w * m.box.h)[0];
        if (water) cy = Math.max(cy, it.y + ((water.box.y - vbS.y) * it.h) / (vbS.h || 1));
      } catch {}
      if (c.w >= 0.6 * doc.width && (seaTop === null || cy < seaTop)) seaTop = cy;
      mask.sea.push({ svg, x: it.x, y: it.y, w: it.w, h: it.h });
      maskSig += it.id + signature(it) + [it.x, it.y, it.w, it.h].map(Math.round).join(",");
    }
  }
  const passSig = lp && edges ? `v${LIGHT_VERSION},${Math.round(lp.x)},${Math.round(lp.y)},${seaTop === null ? "-" : Math.round(seaTop)},${hashSeed(maskSig)}` : null;
  if (passSig) nextDone.__lightpass = passSig;
  if (passSig && passSig !== done.__lightpass) {
    const src = encodeSvg(lightSvg(doc.width, doc.height, lp, seaTop, hashSeed(doc.id || "jdraw"), mask));
    const old = lightLayer && lightLayer.items.find(isLight);
    if (old) ops.push({ op: "update_items", ids: [old.id], patch: { src } });
    else {
      ops.push({ op: "add_items", newLayer: LIGHT_LAYER, items: [{ type: "image", name: LIGHT_NAME, src, x: 0, y: 0, w: doc.width, h: doc.height }] });
      ops.push(Object.assign({ op: "update_layer", layerId: LIGHT_LAYER }, LIGHT_LAYER_STYLE));
    }
    stats.lightPass = passSig;
  } else if (!passSig && lightLayer) {
    ops.push({ op: "delete_items", ids: lightLayer.items.filter(isLight).map((i) => i.id) });
  }

  const paperLayer = (doc.layers || []).find((l) => (l.items || []).some((it) => isPaper(it) && !isLight(it)));
  if (paperLayer && !grain) {
    // Only the grain goes; anything the person drew on that layer stays.
    ops.push({ op: "delete_items", ids: paperLayer.items.filter(isPaper).map((i) => i.id) });
  } else if (paperLayer) {
    // A light layer added in this pass lands on top, so the paper moves over it.
    const addedLight = ops.some((o) => o.op === "add_items" && o.newLayer === LIGHT_LAYER);
    const top = doc.layers[doc.layers.length - 1] === paperLayer && !addedLight;
    if (!top) ops.push({ op: "move_layer", layerId: paperLayer.id, index: doc.layers.length - (addedLight ? 0 : 1) });
    // Older drawings had the blend on the item.
    const item = paperLayer.items.find(isPaper);
    if ((item.blend && item.blend !== "source-over") || paperLayer.blend !== PAPER_LAYER_STYLE.blend || paperLayer.opacity !== PAPER_LAYER_STYLE.opacity || !paperLayer.paper) {
      ops.push({ op: "update_items", ids: [item.id], patch: { blend: "source-over", opacity: 1 } });
      ops.push(Object.assign({ op: "update_layer", layerId: paperLayer.id }, PAPER_LAYER_STYLE));
    }
  } else if (grain && (ops.length || Object.keys(nextDone).some((k) => !k.startsWith("__")))) {
    ops.push({ op: "add_items", newLayer: PAPER_LAYER, items: [{ type: "image", name: PAPER_NAME, src: encodeSvg(paperSvg(doc.width, doc.height, hashSeed(doc.id || "jdraw"))), x: 0, y: 0, w: doc.width, h: doc.height }] });
    ops.push(Object.assign({ op: "update_layer", layerId: PAPER_LAYER }, PAPER_LAYER_STYLE));
    stats.paper = true;
  }

  const before = JSON.stringify(Object.fromEntries(Object.entries(done).filter(([k]) => k.startsWith("__") || ids.has(k))));
  if (ops.length || bg || JSON.stringify(nextDone) !== before) {
    const docOp = { op: "set_doc", finished: nextDone };
    if (bg) docOp.background = bg;
    ops.push(docOp);
  }
  return { ops, stats };
}

module.exports = { isLight, LIGHT_NAME, finishOps, gradeColor, gradeSvg, paintEdges, unpaintEdges, rgbToOklch, isPaper, decodeSvg, topLevel, PAPER_NAME, contentOf, SOFT_NAME };
