"use strict";
// Draw-time lint for draw_svg. Agents (Sonnet especially) build objects
// from primitives: ellipse clouds, trapezoid towers, half-ellipse hulls,
// lens-shaped reflections, box bands, ruler-flat edges, dash texture.
// This measures every shape of an SVG before it lands on the canvas and
// refuses the SVG with what to change, so the drawer redraws it right away
// instead of the reviewer finding it five rounds later.

const NUM = /-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi;

function attrs(tag) {
  const out = {};
  const re = /([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(tag))) out[m[1]] = m[3] !== undefined ? m[3] : m[4];
  if (out.style) for (const part of out.style.split(";")) {
    const [k, v] = part.split(":");
    if (k && v && !out[k.trim()]) out[k.trim()] = v.trim();
  }
  return out;
}

// Points of a path, split by subpath, with each segment's kind.
function parsePath(d) {
  const toks = String(d || "").match(/[MmLlHhVvCcSsQqTtAaZz]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) || [];
  const subs = [];
  let cur = null, x = 0, y = 0, sx = 0, sy = 0, cmd = null, i = 0, lastC = null, lastQ = null;
  const num = () => Number(toks[i++]);
  const isNum = () => i < toks.length && !/^[a-z]$/i.test(toks[i]);
  const start = () => { cur = { pts: [[x, y]], ctrl: [], segs: [], closed: false }; subs.push(cur); };
  const to = (nx, ny, kind, ctrl) => {
    if (!cur) start();
    cur.segs.push({ kind, a: [x, y], b: [nx, ny], ctrl: ctrl || [] });
    if (ctrl) cur.ctrl.push(...ctrl);
    x = nx; y = ny; cur.pts.push([x, y]);
  };
  while (i < toks.length) {
    if (/^[a-z]$/i.test(toks[i])) cmd = toks[i++];
    else if (!cmd) { i++; continue; }
    const rel = cmd === cmd.toLowerCase();
    const c = cmd.toUpperCase();
    if (c === "Z") { if (cur) { if (x !== sx || y !== sy) to(sx, sy, "L"); cur.closed = true; } x = sx; y = sy; cur = null; cmd = null; lastC = lastQ = null; continue; }
    if (!isNum()) { cmd = null; continue; }
    const P = (a, b) => [rel ? x + a : a, rel ? y + b : b];
    if (c === "M") {
      const a = num(), b = num();
      x = rel ? x + a : a; y = rel ? y + b : b; sx = x; sy = y;
      start();
      cmd = rel ? "l" : "L";
    } else if (c === "T") {
      const q1 = lastQ ? [2 * x - lastQ[0], 2 * y - lastQ[1]] : [x, y], p = P(num(), num());
      to(p[0], p[1], "C", [q1]); lastQ = q1; lastC = null; continue;
    } else if (c === "L") { const p = P(num(), num()); to(p[0], p[1], "L"); }
    else if (c === "H") { const a = num(); to(rel ? x + a : a, y, "L"); }
    else if (c === "V") { const a = num(); to(x, rel ? y + a : a, "L"); }
    else if (c === "C") { const c1 = P(num(), num()), c2 = P(num(), num()), p = P(num(), num()); to(p[0], p[1], "C", [c1, c2]); lastC = c2; lastQ = null; continue; }
    else if (c === "S") { const r = lastC ? [2 * x - lastC[0], 2 * y - lastC[1]] : [x, y], c2 = P(num(), num()), p = P(num(), num()); to(p[0], p[1], "C", [r, c2]); lastC = c2; lastQ = null; continue; }
    else if (c === "Q") { const c1 = P(num(), num()), p = P(num(), num()); to(p[0], p[1], "C", [c1]); lastQ = c1; lastC = null; continue; }
    else if (c === "A") {
      const rx = Math.abs(num()), ry = Math.abs(num()); num();
      const large = num() ? 1 : 0, sweep = num() ? 1 : 0;
      const p = P(num(), num());
      // The arc's bulge point: off the chord's middle by the arc's height,
      // on the side the sweep and large-arc flags put it.
      const mx = (x + p[0]) / 2, my = (y + p[1]) / 2, dx = p[0] - x, dy = p[1] - y, len = Math.hypot(dx, dy) || 1;
      const R = Math.max(rx, ry, len / 2), half = Math.sqrt(Math.max(0, R * R - (len / 2) * (len / 2)));
      const sag = large ? R + half : R - half;
      const side = sweep ? -1 : 1; // the side depends only on the sweep; large-arc only makes it bulge further
      to(p[0], p[1], "C", [[mx - (dy / len) * sag * side, my + (dx / len) * sag * side]]);
      // Its control point is the bulge itself (on the curve), not a handle.
      cur.segs[cur.segs.length - 1].arc = true;
    } else i++;
    lastC = lastQ = null;
  }
  return subs.filter((s) => s.pts.length > 1);
}

function bboxOf(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// 2D affine matrices [a, b, c, d, e, f], as in SVG.
const ID = [1, 0, 0, 1, 0, 0];
const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
function parseTransform(t) {
  let m = ID;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/gi;
  let r;
  while ((r = re.exec(t || ""))) {
    const v = (r[2].match(NUM) || []).map(Number);
    const k = r[1].toLowerCase();
    let n = ID;
    if (k === "matrix" && v.length >= 6) n = v.slice(0, 6);
    else if (k === "translate") n = [1, 0, 0, 1, v[0] || 0, v[1] || 0];
    else if (k === "scale") n = [v[0] ?? 1, 0, 0, v[1] ?? v[0] ?? 1, 0, 0];
    else if (k === "rotate") {
      const a = ((v[0] || 0) * Math.PI) / 180, cs = Math.cos(a), sn = Math.sin(a);
      n = [cs, sn, -sn, cs, 0, 0];
      if (v.length >= 3) n = mul(mul([1, 0, 0, 1, v[1], v[2]], n), [1, 0, 0, 1, -v[1], -v[2]]);
    } else if (k === "skewx") n = [1, 0, Math.tan(((v[0] || 0) * Math.PI) / 180), 1, 0, 0];
    else if (k === "skewy") n = [1, Math.tan(((v[0] || 0) * Math.PI) / 180), 0, 1, 0, 0];
    m = mul(m, n);
  }
  return m;
}
const apply = (m, pts) => pts.map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);

// Gradients that fade to see-through: a shape filled with one is a glow.
function fadingGradients(svg) {
  const ids = new Map(); // id -> "linear" | "radial"
  const re = /<(linearGradient|radialGradient)\b((?:"[^"]*"|'[^']*'|[^'">])*)>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(svg))) {
    const id = attrs(m[2]).id;
    if (!id) continue;
    const stops = m[3].match(/<stop\b[^>]*>/gi) || [];
    if (stops.some((s) => { const a = attrs(s); return Number(a["stop-opacity"] ?? 1) < 0.3; })) ids.set(id, m[1].toLowerCase() === "lineargradient" ? "linear" : "radial");
  }
  return ids;
}

// Walks the SVG in order, following <g> transforms and inherited fill and
// opacity, and returns every drawn sub-shape with its points.
function shapesOf(svg) {
  const shapes = [];
  const fades = fadingGradients(svg);
  // Fills set by <style> classes or a style attribute, not only fill="".
  const classFill = new Map();
  for (const blk of svg.match(/<style\b[^>]*>[\s\S]*?<\/style>/gi) || []) {
    for (const r of blk.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const f = (r[2].match(/(?:^|;)\s*fill\s*:\s*([^;]+)/i) || [])[1];
      if (f) for (const c of r[1].matchAll(/\.([\w-]+)/g)) classFill.set(c[1], f.trim());
    }
  }
  const fillOf = (a) => {
    if (a.style) { const f = (a.style.match(/(?:^|;)\s*fill\s*:\s*([^;]+)/i) || [])[1]; if (f) return f.trim(); }
    if (a.fill !== undefined) return a.fill;
    for (const c of String(a.class || "").split(/\s+/)) if (classFill.has(c)) return classFill.get(c);
    return undefined;
  };
  const blurOf = new Map();
  for (const f of svg.match(/<filter\b[\s\S]*?<\/filter>/gi) || []) {
    const id = (f.match(/\bid\s*=\s*["']([^"']+)["']/) || [])[1];
    if (!id) continue;
    const sd = [...f.matchAll(/<feGaussianBlur\b[^>]*stdDeviation\s*=\s*["']([^"']+)["']/gi)].flatMap((m) => (m[1].match(NUM) || []).map(Number));
    blurOf.set(id, sd.length ? Math.max(...sd) : 0);
  }
  const blurAmt = (f) => { const id = (String(f || "").match(/url\(\s*#([^)\s]+)\s*\)/) || [])[1]; return id && blurOf.has(id) ? blurOf.get(id) : id ? Infinity : 0; };
  const body =svg.replace(/<defs\b[\s\S]*?<\/defs>/gi, "").replace(/<(clipPath|mask|pattern|symbol|linearGradient|radialGradient|filter|text)\b[\s\S]*?<\/\1>/gi, "");
  const stack = [{ m: ID, fill: undefined, op: 1, fop: 1, filter: false, blur: 0 }];
  const re = /<(\/?)([A-Za-z][\w:-]*)\b((?:"[^"]*"|'[^']*'|[^'">])*?)(\/?)>/g;
  let t;
  while ((t = re.exec(body))) {
    const closing = t[1] === "/", tag = t[2].toLowerCase(), self = t[4] === "/";
    const top = stack[stack.length - 1];
    if (closing) { if ((tag === "g" || tag === "a" || tag === "svg") && stack.length > 1) stack.pop(); continue; }
    const a = attrs(t[3]);
    const ctx = {
      m: a.transform ? mul(top.m, parseTransform(a.transform)) : top.m,
      fill: fillOf(a) !== undefined ? fillOf(a) : top.fill,
      op: top.op * Number(a.opacity ?? 1),
      fop: a["fill-opacity"] !== undefined ? Number(a["fill-opacity"]) : top.fop,
      filter: top.filter || /url\(/.test(a.filter || ""),
      blur: Math.max(top.blur || 0, /url\(/.test(a.filter || "") ? blurAmt(a.filter) : 0),
    };
    if (tag === "g" || tag === "a" || tag === "svg") { if (!self) stack.push(ctx); continue; }
    if (!["rect", "circle", "ellipse", "polygon", "polyline", "path", "line"].includes(tag)) continue;
    const fill = ctx.fill === undefined ? "#000" : ctx.fill;
    const alpha = ctx.op * ctx.fop;
    const filled = fill !== "none" && fill !== "transparent" && alpha > 0.05;
    const grad = (fill.match(/url\(\s*#([^)\s]+)\s*\)/) || [])[1];
    // Glows and haze: a gradient that fades out, a see-through or blurred
    // shape has no hard silhouette, so the shape rules skip it.
    const fade = !!(grad && fades.has(grad));
    const soft = fade || alpha < 0.35 || ctx.filter;
    const base = { tag, raw: t[0], soft, fade, alpha, linearFade: !!(grad && fades.get(grad) === "linear"), blurred: ctx.filter, blurAmt: ctx.filter ? ctx.blur : 0, fill: filled ? fill.toLowerCase() : null, stroke: a.stroke && a.stroke !== "none" ? a.stroke : null };
    let subs = [];
    if (tag === "rect") {
      const x = +a.x || 0, y = +a.y || 0, w = +a.width || 0, h = +a.height || 0;
      const p = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
      subs = [{ pts: p, ctrl: [], closed: true, segs: p.map((q, k) => ({ kind: "L", a: q, b: p[(k + 1) % 4] })) }];
    } else if (tag === "circle" || tag === "ellipse") {
      const cx = +a.cx || 0, cy = +a.cy || 0, rx = +(a.rx ?? a.r) || 0, ry = +(a.ry ?? a.r) || 0;
      const p = Array.from({ length: 8 }, (_, k) => [cx + rx * Math.cos((k * Math.PI) / 4), cy + ry * Math.sin((k * Math.PI) / 4)]);
      subs = [{ pts: p, ctrl: [], closed: true, segs: [], ellipse: true }];
    } else if (tag === "polygon" || tag === "polyline") {
      const n = (a.points || "").match(NUM) || [];
      const pts = [];
      for (let k = 0; k + 1 < n.length; k += 2) pts.push([+n[k], +n[k + 1]]);
      const closed = tag === "polygon";
      const segs = pts.slice(1).map((p, k) => ({ kind: "L", a: pts[k], b: p }));
      if (closed && pts.length > 2) segs.push({ kind: "L", a: pts[pts.length - 1], b: pts[0] });
      subs = pts.length > 1 ? [{ pts, ctrl: [], closed, segs }] : [];
    } else if (tag === "line") {
      const p = [[+a.x1 || 0, +a.y1 || 0], [+a.x2 || 0, +a.y2 || 0]];
      subs = [{ pts: p, ctrl: [], closed: false, segs: [{ kind: "L", a: p[0], b: p[1] }] }];
    } else subs = parsePath(a.d);
    for (const s of subs) {
      const pts = apply(ctx.m, s.pts);
      const ctrl = apply(ctx.m, s.ctrl || []);
      const segs = s.segs.map((g) => { const [p, q] = apply(ctx.m, [g.a, g.b]); return { kind: g.kind, a: p, b: q, ctrl: apply(ctx.m, g.ctrl || []), arc: !!g.arc }; });
      const curves = s.segs.filter((g) => g.kind === "C").length;
      // Detail of an outline: corners count once, curves twice (a curve
      // carries a bend as well as its end point).
      const verts = s.ellipse ? 0 : uniq(pts).length + curves;
      shapes.push(Object.assign({}, base, { pts, segs, closed: s.closed || (!!base.fill && s.pts.length > 2), box: bboxOf(pts.concat(ctrl)), verts, corners: s.ellipse ? 0 : uniq(pts).length, curves }));
    }
  }
  return shapes;
}

function uniq(pts) {
  const seen = new Set();
  return pts.filter(([x, y]) => { const k = `${Math.round(x * 10)},${Math.round(y * 10)}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

// Straight runs: consecutive line segments that stay on one line, at any
// angle, measured end to end.
function straightRuns(s) {
  const runs = [];
  let run = null;
  const off = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / l; };
  for (const g of s.segs) {
    if (g.kind !== "L") { if (run) runs.push(run); run = null; continue; }
    if (run && off(g.b, run.a, run.b) <= 0.012 * Math.hypot(g.b[0] - run.a[0], g.b[1] - run.a[1]) && run.pts.every((p) => off(p, run.a, g.b) <= 0.012 * Math.hypot(g.b[0] - run.a[0], g.b[1] - run.a[1]))) {
      run.pts.push(run.b); run.b = g.b;
    } else { if (run) runs.push(run); run = { a: g.a, b: g.b, pts: [] }; }
  }
  if (run) runs.push(run);
  return runs;
}

// A shape's outline as a polygon, curves sampled (an arc's stored point is
// on the curve; cubic and quadratic handles are not).
function outlineOf(s) {
  if (!s.segs || !s.segs.length) return s.pts;
  const P = [];
  for (const g of s.segs) {
    P.push(g.a);
    const c = g.ctrl || [];
    if (!c.length) continue;
    if (g.arc) { P.push(c[0]); continue; }
    for (const t of [0.25, 0.5, 0.75]) {
      const u = 1 - t;
      if (c.length >= 2) P.push([u * u * u * g.a[0] + 3 * u * u * t * c[0][0] + 3 * u * t * t * c[1][0] + t * t * t * g.b[0], u * u * u * g.a[1] + 3 * u * u * t * c[0][1] + 3 * u * t * t * c[1][1] + t * t * t * g.b[1]]);
      else P.push([u * u * g.a[0] + 2 * u * t * c[0][0] + t * t * g.b[0], u * u * g.a[1] + 2 * u * t * c[0][1] + t * t * g.b[1]]);
    }
  }
  return P;
}
function inPoly(P, x, y) {
  let r = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) if ((P[i][1] > y) !== (P[j][1] > y) && x < ((P[j][0] - P[i][0]) * (y - P[i][1])) / (P[j][1] - P[i][1]) + P[i][0]) r = !r;
  return r;
}
// OKLab of a fill (hex, rgb() or a few names); null for gradients and the rest.
const NAMED = { black: "#000000", white: "#ffffff", gray: "#808080", grey: "#808080", red: "#ff0000", blue: "#0000ff", green: "#008000", navy: "#000080", brown: "#a52a2a" };
function labOf(fill) {
  let f = String(fill || "").trim().toLowerCase();
  if (NAMED[f]) f = NAMED[f];
  let rgb = null;
  const h = f.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (h) { const x = h[1].length === 3 ? h[1].replace(/./g, "$&$&") : h[1]; rgb = [0, 2, 4].map((k) => parseInt(x.slice(k, k + 2), 16) / 255); }
  const m = f.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/);
  if (m) rgb = [+m[1] / 255, +m[2] / 255, +m[3] / 255];
  if (!rgb) return null;
  const [r, g, b] = rgb.map((c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), mm = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b), s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * mm - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * mm + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * mm - 0.808675766 * s];
}

// opts: { vb: {x,y,w,h}, w, h (placed size in canvas px), W, H (canvas) }
// Returns { problems: [{ rule, what, fix }], stats }.
function lintSvg(svg, opts) {
  const { vb, W, H } = opts;
  const kx = opts.w / (vb.w || 1), ky = opts.h / (vb.h || 1);
  const A = W * H;
  // Swells JDraw laid itself are judged only as swells.
  const allShapes = shapesOf(svg);
  const ownSwells = allShapes.filter((s) => /data-jdraw-plane="swell/.test(s.raw || ""));
  const shapes = allShapes.filter((s) => !ownSwells.includes(s));
  const problems = [];
  const where = (b) => `x ${Math.round(opts.x + (b.x - vb.x) * kx)}-${Math.round(opts.x + (b.x - vb.x + b.w) * kx)}, y ${Math.round(opts.y + (b.y - vb.y) * ky)}-${Math.round(opts.y + (b.y - vb.y + b.h) * ky)}`;
  const area = (b) => b.w * kx * b.h * ky;
  // A field spans (nearly) the whole SVG: sky, sea, ground. Those are
  // allowed to be simple; the objects on them are not.
  // A rock or hill that merely fills its own SVG is not a field: unless the
  // object is named as one, a field also spans nearly the whole canvas.
  const fieldName = /\b(sky|sea|water|ocean|lake|bay|ground|grass|field|meadow|sand|beach|land|horizon|backdrop|background)\b/i.test(opts.name || "");
  const field = (b) => b.w >= 0.85 * vb.w && b.w * kx >= (fieldName ? 0.6 : 0.85) * W && (b.h >= 0.25 * vb.h || b.y + b.h >= vb.y + 0.98 * vb.h || b.y <= vb.y + 0.02 * vb.h);
  // The water is judged by what it is, not by the item's name: a sea is often
  // drawn inside one full-canvas item called Sky, and a name test there would
  // skip every water rule and pass a flat sea and a ruled horizon.
  const waterName = /\b(sea|water|ocean|lake|bay|river|pond|waves?|swells?)\b/i.test(opts.name || "");
  const bottomField = (s) => !!(s.fill && s.closed && !s.fade && s.box.w >= 0.88 * vb.w && s.box.y + s.box.h >= vb.y + 0.96 * vb.h && s.box.y >= vb.y + 0.05 * vb.h && s.box.y <= vb.y + 0.92 * vb.h);
  // A field at the bottom of a full-canvas item is water only if it reads
  // cool (blue or teal), so a grass or sand foreground is not painted with
  // swells. Gradients are judged by their middle stop.
  const toneOfFill = (fill) => {
    const own = labOf(fill);
    if (own) return own;
    const id = (String(fill || "").match(/url\(\s*#([^)\s]+)\s*\)/) || [])[1];
    if (!id) return null;
    const g = svg.match(new RegExp("<(linear|radial)Gradient\\b[^>]*id\\s*=\\s*[\"']" + id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[\"'][\\s\\S]*?</\\1Gradient>", "i"));
    if (!g) return null;
    const stops = [...g[0].matchAll(/stop-color\s*[=:]\s*["']?\s*(#[0-9a-f]{3,6}|rgba?\([^)]*\))/gi)].map((m) => labOf(m[1])).filter(Boolean);
    return stops.length ? stops[Math.floor(stops.length / 2)] : null;
  };
  const coolWater = (s) => {
    const L = toneOfFill(s.fill);
    if (!L) return false;
    const h = ((Math.atan2(L[2], L[1]) * 180) / Math.PI + 360) % 360;
    return Math.hypot(L[1], L[2]) >= 0.012 && h >= 190 && h <= 315;
  };
  const hasWater = shapes.some((s) => bottomField(s) && coolWater(s));
  const water = waterName || hasWater;
  // els: the shapes to blame, so a last try can have them stripped.
  const add = (rule, what, fix, els) => { if (!problems.some((p) => p.rule === rule && p.what === what)) problems.push({ rule, what, fix, els: (els || []).map((e) => e.raw).filter(Boolean) }); };

  const filled = shapes.filter((s) => s.fill && (!s.soft || (s.blurred && !s.fade && s.alpha >= 0.6 && s.blurAmt < 0.15 * Math.min(s.box.w, s.box.h))));
  // A closed outline with no fill and a few curves is a drawn circle or ellipse
  // (a compass line around the picture), never a painted form.
  const outlines = shapes.filter((s) => !s.fill && s.stroke && s.closed && s.segs.length <= 8 && !field(s.box) && area(s.box) >= 0.01 * A);
  if (outlines.length) add("outline-ring", `a closed outline with no fill at ${where(outlines[0].box)} (a drawn circle or ellipse floating over the picture)`, "Paint the form it stands for with filled shapes that have uneven edges and tones; a plain outline loop is never a sun, a wheel or a cloud.", outlines);
  for (const s of filled) {
    const a = area(s.box);
    if (field(s.box)) continue;
    const aspect = Math.max(s.box.w * kx, s.box.h * ky) / Math.max(1, Math.min(s.box.w * kx, s.box.h * ky));
    if ((s.tag === "rect" || s.tag === "circle" || s.tag === "ellipse") && a >= 0.004 * A) {
      add("primitive", `a plain <${s.tag}> at ${where(s.box)} is an object made from a basic shape`, `Draw it as a <path> whose outline follows the real thing: uneven, with bumps, notches and a flattened or broken side, at least 12 points.`, [s]);
      continue;
    }
    if ((s.tag === "circle" || s.tag === "ellipse") && aspect >= 2 && a >= 0.0008 * A) {
      add("lens", `a stretched <${s.tag}> at ${where(s.box)} reads as a stock lens or pill (cloud, reflection, foam)`, "Use an irregular path, or leave it out; reflections are broken vertical smears under the object, foam hugs the rock edge.", [s]);
      continue;
    }
    if (s.tag === "path" || s.tag === "polygon") {
      const longSwell = water && s.box.w * kx >= 0.15 * W && aspect >= 4;
      const need = longSwell ? (s.verts >= 6 ? 0 : 6) : a >= 0.02 * A ? 12 : a >= 0.004 * A ? 8 : 0;
      if (need && s.verts < need) {
        add("few-points", `the outline at ${where(s.box)} has only ${s.verts} points for a shape that big (${s.verts <= 4 ? "a box or trapezoid" : "a simple blob"})`, `Give its silhouette at least ${need} points that follow the real form: taper, lean, chips, overhangs; no two sides mirror each other.`, [s]);
        continue;
      }
      // A tall, narrow solid (a tower, a lighthouse, a mast with a body) drawn
      // with a handful of points is a stock tube or cone, however it is tinted.
      const tall = s.closed && s.box.h * ky >= 1.8 * s.box.w * kx && a >= 0.004 * A && a < 0.06 * A;
      if (tall && s.verts < 14) {
        add("tower-simple", `the tall, narrow solid at ${where(s.box)} is a stock tube or cone (${s.verts} points)`, "A tower is built from at least 14 points with a lit side of one width and a shadow side of another, a flared base on the rock, and a gallery and lantern as separate passes. Never one tapered shape with two symmetric sides.", [s]);
        continue;
      }
      // A long swell across the water is not a lens; a short dash still is.
      const swell = water && s.box.w * kx >= 0.15 * W && aspect >= 4;
      if (s.segs.length && s.segs.length <= 5 && aspect >= 2.2 && a >= 0.0008 * A && s.closed && !swell) {
        add("lens", `the shape at ${where(s.box)} is a ${s.segs.length}-curve lens or pill`, "Stock shorthand. Give it an uneven outline with many points, or leave it out.", [s]);
      }
    }
  }

  // The sun: a pale disc with a hard rim and nothing leaving it reads as a
  // pasted-on shape. A painted sun is hot at its middle, loose at its edge,
  // and its light stains the sky and the cloud beside it.
  // A sun is also recognised by what it looks like (a warm, bright, round
  // disc in the upper part of the picture), so an unnamed glow is judged too.
  const warmBright = filled.some((s) => { const c = labOf(s.fill); return !!c && c[0] >= 0.8 && c[2] >= 0.08 && area(s.box) >= 0.0012 * A && area(s.box) < 0.12 * A && s.box.y <= vb.y + 0.6 * vb.h; });
  if (/\b(sun|moon)\b/i.test(opts.name || "") || warmBright) {
    const disc = filled
      .filter((s) => { const L = (labOf(s.fill) || [0])[0]; const w = s.box.w * kx, h = s.box.h * ky; return L >= 0.62 && area(s.box) >= 0.0012 * A && Math.max(w, h) <= 2.4 * Math.min(w, h); })
      .sort((a, b) => area(b.box) - area(a.box))[0];
    if (disc) {
      const d = disc.box;
      const near = (s) => s !== disc && s.box.x < d.x + 2.6 * d.w && s.box.x + s.box.w > d.x - 1.6 * d.w && s.box.y < d.y + 2.6 * d.h && s.box.y + s.box.h > d.y - 1.6 * d.h;
      // A halo: a shape that fades, is see-through or blurred, or a bigger
      // pale shape behind the disc that its light can bleed into.
      const halo = shapes.some((s) => near(s) && (s.fade || s.alpha < 0.85 || s.blurred || /url\(/.test(String(s.fill || s.stroke || "")) || ((labOf(s.fill) || [0])[0] >= 0.6 && area(s.box) >= 1.3 * area(disc.box))));
      // A hot core and a warmer tone toward the rim.
      const inner = filled.filter((s) => near(s) && area(s.box) <= 0.9 * area(disc.box));
      if (!halo) add("sun-glow", `the sun at ${where(d)} is a flat disc with a hard rim and no light leaving it`, "A painted sun is hot in the middle and loose at the edge: a pale hot core, a warmer tone toward the rim, a rim that is uneven and breaks, and a see-through halo that stains the sky and the cloud beside it.", [disc]);
      else if (inner.length < 2) add("sun-core", `the sun at ${where(d)} is one flat tone with no hot core or warmer rim`, "Give the sun two or three tones: a hot pale core, a warmer band toward one side, and a rim that runs a little hotter where the light is strongest.", [disc]);
    }
  }

  if (water) {
    const V = vb, edge = (b) => b.x <= V.x + 0.01 * V.w || b.y <= V.y + 0.01 * V.h || b.x + b.w >= V.x + 0.99 * V.w || b.y + b.h >= V.y + 0.99 * V.h;
    // The water's own top edge: only what sits below it is judged as a mark
    // on the water, so a hull or a rock in the same SVG is not read as a
    // pasted patch on the sea.
    const seaSh = shapes.filter((s) => s.fill && s.closed && field(s.box) && s.box.w >= 0.85 * vb.w && s.box.y + s.box.h >= vb.y + 0.9 * vb.h && s.box.y > vb.y + 0.05 * vb.h).sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h)[0] || null;
    const onSea = (b) => !seaSh || b.y >= seaSh.box.y - 0.02 * vb.h;
    const blots = filled.filter((s) => onSea(s.box) && !field(s.box) && s.closed && s.curves === 0 && s.alpha >= 0.85 && !/url\(/.test(s.fill) && !s.soft && area(s.box) >= 0.002 * A && area(s.box) < 0.08 * A && !edge(s.box));
    // A pale see-through blob on the water: a pasted sun reflection.
    const ghosts = filled.filter((s) => onSea(s.box) && !field(s.box) && s.closed && (s.alpha < 0.9 || (s.curves >= 0.6 * s.segs.length && s.box.w * kx >= 4 * s.box.h * ky && !edge(s.box))) && !(s.box.w * kx >= 0.15 * W && s.box.w * kx >= 6 * s.box.h * ky) && !s.soft && !s.fade && !/url\(/.test(s.fill) && (labOf(s.fill) || [0])[0] > 0.6 && s.box.w * kx >= 0.06 * W && area(s.box) < 0.08 * A);
    if (ghosts.length) {
      // A reflection broken into several glints of different sizes is how it
      // is painted; one pale sheet over the water is not.
      const gs = ghosts.map((s) => s.box.w * kx).sort((a, b) => a - b);
      const broken = gs.length >= 3 && gs[0] <= 0.75 * gs[gs.length - 1];
      if (!broken) add("sea-ghost", `a pale see-through blob floating on the water at ${where(ghosts[0].box)} (a pasted reflection)`, "Leave the light on the water to JDraw: its light pass paints broken glints under the light source. If you draw a reflection, make it many small soft glints that break up toward the front, not one pale shape.", ghosts);
    }
    const pills = shapes.filter((s) => onSea(s.box) && s.fill && s.soft && !s.fade && s.closed && !field(s.box) && s.segs.length <= 8 && s.box.w * kx >= 3 * s.box.h * ky && s.box.w * kx < 0.15 * W && (labOf(s.fill) || [1])[0] < 0.75 && !edge(s.box));
    if (pills.length >= 3) add("sea-soft-blobs", `${pills.length} blurred pills floating on the water, e.g. at ${where(pills[0].box)} (pasted patches, softened)`, "Blur does not turn a pill into a wave. Water reads through long swells that run across the view and overlap, larger and darker toward the front, each with a lit upper edge and an uneven lower one; leave out the floating patches.", pills);
    // A sea that is only a gradient: water reads through swells, at least
    // three, of different lengths and tones.
    {
      const sea = seaSh || shapes.find((s) => s.fill && s.closed && field(s.box));
      // The sea's lightness at a height: its own fill, or its vertical gradient.
      const seaL = (y) => {
        const own = labOf(sea.fill);
        if (own) return own[0];
        const id = (String(sea.fill).match(/url\(\s*#([^)\s]+)\s*\)/) || [])[1];
        const g = id && (svg.match(new RegExp("<linearGradient\\b[^>]*id\\s*=\\s*[\"']" + id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[\"'][\\s\\S]*?</linearGradient>", "i")) || [])[0];
        if (!g) return null;
        const head = g.slice(0, g.indexOf(">"));
        const at = (k, d) => { const m = head.match(new RegExp("\\b" + k + "\\s*=\\s*[\"']?\\s*([-\\d.]+)(%?)")); return m ? +m[1] / (m[2] ? 100 : 1) : d; };
        const user = /gradientUnits\s*=\s*["']userSpaceOnUse/i.test(head);
        const y1 = at("y1", 0), y2 = at("y2", 0);
        const stops = [...g.matchAll(/<stop\b[^>]*>/gi)].map((m) => { const o = (m[0].match(/offset\s*=\s*["']?\s*([\d.]+)(%?)/) || []); const c = (m[0].match(/stop-color\s*[=:]\s*["']?\s*(#[0-9a-f]{3,6}|rgba?\([^)]*\))/i) || [])[1]; const L = labOf(c); return L && { o: o[1] ? +o[1] / (o[2] ? 100 : 1) : 0, L: L[0] }; }).filter(Boolean);
        if (!stops.length) return null;
        if (Math.abs(y2 - y1) < 1e-6) return stops[Math.floor(stops.length / 2)].L;
        const t = user ? (y - y1) / (y2 - y1) : ((y - sea.box.y) / Math.max(1, sea.box.h) - y1) / (y2 - y1);
        if (t <= stops[0].o) return stops[0].L;
        for (let k = 1; k < stops.length; k++) if (t <= stops[k].o) { const a = stops[k - 1], b = stops[k]; return a.L + ((b.L - a.L) * (t - a.o)) / Math.max(1e-6, b.o - a.o); }
        return stops[stops.length - 1].L;
      };
      // A swell the eye cannot pick out of the water does not count.
      const shows = (s) => { if (/data-jdraw-plane="swell/.test(s.raw || "")) return true; const L = labOf(s.fill || s.stroke), w = seaL(s.box.y + s.box.h / 2); return !L || w == null || Math.abs(L[0] - w) * Math.min(1, s.alpha ?? 1) >= 0.06; };
      if (sea) {
        const swells0 = shapes.concat(ownSwells).filter((s) => !(s.soft && !/data-jdraw-plane="swell/.test(s.raw || "")) && s.box.y >= sea.box.y + 0.1 * sea.box.h && !field(s.box) && (s.alpha ?? 1) >= 0.12 && s.box.w * kx >= 0.12 * W && s.box.w * kx >= 4 * Math.max(1, s.box.h * ky) && ((s.fill && s.closed) || (s.stroke && !s.closed)) && shows(s));
        const swells = swells0.filter((s, i) => !swells0.some((o, j) => j < i && Math.abs((o.box.y + o.box.h / 2) - (s.box.y + s.box.h / 2)) <= 1.5 * Math.max(o.box.h, s.box.h) && Math.min(o.box.x + o.box.w, s.box.x + s.box.w) - Math.max(o.box.x, s.box.x) > 0.5 * Math.min(o.box.w, s.box.w)));
        const tones = new Set(swells.map((s) => String(s.fill || s.stroke).toLowerCase()));
        const lens = swells.map((s) => s.box.w * kx);
        const spread = lens.length ? Math.max(...lens) / Math.max(1, Math.min(...lens)) : 1;
        if (ownSwells.length < 3 && (swells.length < 3 || tones.size < 2 || spread < 1.4)) add("water-flat", `the sea is ${swells.length ? `only ${swells.length} swell${swells.length === 1 ? "" : "s"} of ${tones.size === 1 ? "one tone" : "near one length"}` : "a bare gradient with no swells"}`, "Give the water structure: at least three long swells that run across the view at different heights, longer, darker and further apart toward the front, each with a lit upper edge and an uneven, fading lower one.", []);
      }
    }
    // A pill swell: one long smooth strip of few curves laid across the water
    // (a ribbon with a pale rim), not a swell that breaks and fades.
    {
      const seaTop2 = (shapes.filter((s) => s.fill && s.closed && field(s.box) && s.box.w >= 0.85 * vb.w && s.box.y + s.box.h >= vb.y + 0.9 * vb.h && s.box.y > vb.y + 0.05 * vb.h).sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h)[0] || { box: { y: vb.y } }).box.y;
      const onWater = water && !/\b(rocks?|rocky|cliffs?|hills?|shore|headland|land|island)\b/i.test(opts.name || "");
      // A band as thick at its ends as in its middle, the same thickness all
      // along: a ribbon, however many points its edges have.
      const axial = (s) => {
        const P0 = outlineOf(s);
        if (!P0 || P0.length < 4) return null;
        const Q = P0.map((p) => [p[0] * kx, p[1] * ky]);
        const cx = Q.reduce((a, p) => a + p[0], 0) / Q.length, cy = Q.reduce((a, p) => a + p[1], 0) / Q.length;
        let sxx = 0, syy = 0, sxy = 0;
        for (const p of Q) { const dx = p[0] - cx, dy = p[1] - cy; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
        const th = 0.5 * Math.atan2(2 * sxy, sxx - syy), c = Math.cos(-th), si = Math.sin(-th);
        const P = Q.map((p) => [(p[0] - cx) * c - (p[1] - cy) * si, (p[0] - cx) * si + (p[1] - cy) * c]);
        const xs = P.map((p) => p[0]), ys = P.map((p) => p[1]);
        const b = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
        return { P, b };
      };
      const evenBand = (s) => {
        const ax = axial(s);
        if (!ax) return false;
        const { P, b } = ax;
        const span = (x) => { const ys = []; for (let k = 0; k < P.length; k++) { const p = P[k], q = P[(k + 1) % P.length]; if ((p[0] <= x) !== (q[0] <= x)) ys.push(p[1] + ((x - p[0]) * (q[1] - p[1])) / (q[0] - p[0])); } return ys.length >= 2 ? Math.max(...ys) - Math.min(...ys) : 0; };
        const t = []; for (let k = 1; k <= 11; k++) t.push(span(b.x + (k / 12) * b.w));
        const mid = t.slice(3, 8), m = mid.reduce((a, v) => a + v, 0) / mid.length;
        if (!(m > 0)) return false;
        const cv = Math.sqrt(t.reduce((a, v) => a + (v - m) * (v - m), 0) / t.length) / m;
        return cv < 0.3 && Math.min(t[0], t[10]) > 0.55 * m;
      };
      const pillSw = !onWater ? [] : filled.filter((s) => s.closed && !s.fade && !field(s.box) && s.box.y >= seaTop2 && (() => { const ax = axial(s); return ax && ax.b.w >= 0.3 * W && ax.b.w >= 6 * ax.b.h; })() && ((s.segs.length <= 10 && s.curves >= 0.6 * s.segs.length) || evenBand(s)));
      if (pillSw.length) add("pill-swell", `a long even strip across the water at ${where(pillSw[0].box)} (a ribbon swell)`, "A swell is not a ribbon: give it an uneven crest with many small rises and dips, let it thin and break into pieces along its length, and fade it out at both ends.", pillSw);
    }
    if (blots.length >= 2) add("sea-blotches", `${blots.length} flat straight-sided patches floating on the water, e.g. at ${where(blots[0].box)} (pasted blotches)`, "Shapes on water follow the waves: long, thin, curved swells that run across the view, grow larger and darker toward the front, and fade out at their ends (a gradient or see-through edge). A reef or shadow under water is soft-edged, never a hard polygon.", blots);
  }
  // A ribbon cloud: one long smooth strip laid across the sky (a sausage),
  // not a mass of soft lumps with sky between them.
  if (/\b(sky|skies|clouds?)\b/i.test(opts.name || "")) {
    const seaTop = (shapes.filter((s) => s.fill && s.closed && field(s.box) && s.box.w >= 0.85 * vb.w && s.box.y + s.box.h >= vb.y + 0.9 * vb.h && s.box.y > vb.y + 0.05 * vb.h).sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h)[0] || { box: { y: vb.y + 0.7 * vb.h } }).box.y;
    const ribbon = (s) => {
      const P = outlineOf(s);
      if (!P || P.length < 3) return false;
      let ar = 0, per = 0;
      for (let k = 0; k < P.length; k++) { const p = P[k], q = P[(k + 1) % P.length]; ar += p[0] * q[1] - q[0] * p[1]; per += Math.hypot((q[0] - p[0]) * kx, (q[1] - p[1]) * ky); }
      ar = Math.abs(ar / 2) * kx * ky;
      const thick = (2 * ar) / Math.max(1, per), len = per / 2 - thick;
      return thick > 0 && len >= 0.1 * W && len >= 5 * thick;
    };
    const rib = filled.filter((s) => s.closed && !s.fade && (s.alpha ?? 1) >= 0.6 && !field(s.box) && s.box.w < 0.9 * vb.w && s.box.y + s.box.h <= seaTop && s.curves >= 0.6 * s.segs.length && ribbon(s));
    if (rib.length) add("ribbon-cloud", `${rib.length === 1 ? "a long smooth strip" : rib.length + " long smooth strips"} laid across the sky, e.g. at ${where(rib[0].box)} (a sausage cloud)`, "A cloud is not a sausage: build it from several overlapping soft masses of different sizes, a lit top edge and a flatter, darker base, broken into pieces with sky between them.", rib);
  }

  {
    const big = shapes.filter((s) => s.fill && s.closed && !field(s.box) && area(s.box) >= 0.003 * A && labOf(s.fill));
    const pair = [];
    const sameOutline = (p, q) => {
      const P = outlineOf(p), Q = outlineOf(q), dx = q.box.x - p.box.x, dy = q.box.y - p.box.y;
      let both = 0, either = 0;
      for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) {
        const x = p.box.x + ((i + 0.5) / 12) * p.box.w, y = p.box.y + ((j + 0.5) / 12) * p.box.h;
        const a = inPoly(P, x, y), b = inPoly(Q, x + dx, y + dy);
        if (a || b) either++;
        if (a && b) both++;
      }
      return either > 0 && both / either >= 0.85;
    };
    for (let i = 0; i < big.length && !pair.length; i++) for (let j = i + 1; j < big.length; j++) {
      const a = big[i].box, b = big[j].box, m = Math.max(a.w, a.h);
      if (Math.abs(a.x - b.x) < 0.04 * m && Math.abs(a.y - b.y) < 0.04 * m && Math.abs(a.w - b.w) < 0.05 * a.w && Math.abs(a.h - b.h) < 0.06 * a.h && (a.x !== b.x || a.y !== b.y) && !(big[i].soft && big[j].soft) && !(labOf(big[i].fill)[0] < labOf(big[j].fill)[0] ? big[j].soft : big[i].soft) && sameOutline(big[i], big[j]) && Math.abs(labOf(big[i].fill)[0] - labOf(big[j].fill)[0]) > 0.3) { pair.push(labOf(big[i].fill)[0] < labOf(big[j].fill)[0] ? big[i] : big[j]); break; }
    }
    if (pair.length) add("sticker-shadow", `a shape over a dark copy of its own outline, a few pixels off, at ${where(pair[0].box)} (a cut-out sticker)`, "A shadow is not the same shape shifted: shade the side away from the light inside the object with its own planes, and where it meets the ground or water, a contact shadow of a different, broken shape.", pair);
  }

  // A shadow pad: one smooth dark shape, wider than the object, along its
  // bottom (the stock waterline ellipse under a boat).
  {
    // A light blur does not make a shape soft here; only fades are exempt.
    const solids = shapes.filter((s) => s.fill && !s.fade && s.closed && !field(s.box) && area(s.box) >= 0.0005 * A);
    const inside = (b) => b.x > vb.x + 0.01 * vb.w && b.x + b.w < vb.x + 0.99 * vb.w && b.y + b.h < vb.y + 0.99 * vb.h;
    const watery = water;
    const pads = solids.filter((p) => {
      if (!inside(p.box)) return false;
      const lab = labOf(p.fill);
      if (!lab || lab[0] >= 0.5 || p.curves < 0.5 * p.segs.length || p.box.w < 4 * p.box.h) return false;
      // On water only a stock smooth pad (a waterline ellipse) counts, so a
      // sea painted from overlapping swells is not read as a pad. A boat's
      // shadow is refused here whether the item is called Sea or not.
      if (watery && p.tag !== "ellipse" && p.segs.length > 8) return false;
      const over = solids.filter((o) => o !== p && o.box.x < p.box.x + p.box.w && o.box.x + o.box.w > p.box.x && o.box.y < p.box.y + p.box.h);
      if (!over.length) return false;
      const widest = Math.max(...over.map((o) => o.box.w)), bottom = Math.max(...over.map((o) => o.box.y + o.box.h));
      return p.box.w >= 1.1 * widest && p.box.y + p.box.h >= bottom - 0.01 * vb.h && p.box.y >= Math.min(...over.map((o) => o.box.y));
    });
    if (pads.length) add("shadow-pad", `a smooth dark pad wider than the object along its bottom at ${where(pads[0].box)} (a stock waterline or ground shadow)`, "Where an object meets water or ground, break the contact: a few short uneven darker touches hugging its base and, on water, its own reflection broken by the swells; never one smooth dark ellipse wider than the object.", pads);
  }
  // A reflection ladder: three or more small same-color pieces stacked
  // under one another (dashes for a light's reflection).
  {
    const bits = shapes.filter((s) => s.fill && !/url\(/.test(s.fill) && !s.fade && !field(s.box) && area(s.box) < 0.003 * A && s.box.w >= 2 * s.box.h);
    for (const b of bits) {
      const cx = b.box.x + b.box.w / 2;
      const near = (f, g) => { if (f === g) return true; const p = labOf(f), q = labOf(g); return !!(p && q) && Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 0.04; };
      const col = bits.filter((o) => near(o.fill, b.fill) && o.box.x <= cx && o.box.x + o.box.w >= cx);
      const ys = [...new Set(col.map((o) => Math.round(o.box.y / Math.max(1, b.box.h))))];
      const span = Math.max(...col.map((o) => o.box.y + o.box.h)) - Math.min(...col.map((o) => o.box.y));
      // close together, like dashes on water; not window sills a floor apart
      const close = span <= (col.length - 1) * 4 * b.box.h;
      if (col.length >= 3 && ys.length >= 3 && span >= 4 * b.box.h && close) { add("ladder", `${col.length} small dashes stacked under one another at ${where(col[0].box)} (a reflection ladder)`, "Leave reflections of lights to JDraw's light pass, or paint one soft broken vertical smear that wobbles with the swells; never a stack of dashes.", col); break; }
    }
  }

  // Box bands: several 4-corner pieces (striped towers, plank stacks).
  const boxes = filled.filter((s) => !field(s.box) && s.corners > 0 && s.corners <= 4 && s.curves === 0 && area(s.box) >= 0.001 * A);
  if (boxes.length >= 3) add("box-bands", `${boxes.length} four-corner pieces (bands or panels), e.g. at ${where(boxes[0].box)}`, "Bands and panels follow the form: curve each band with the object's roundness, vary its width, and let tones wrap around instead of cutting it into straight strips.");

  const hits = (p, o) => p.box.x < o.box.x + o.box.w && p.box.x + p.box.w > o.box.x && p.box.y < o.box.y + o.box.h && p.box.y + p.box.h > o.box.y;
  // Stacked flat patches: many wide, thin, separate pieces (a ladder of
  // reflection blobs on the sea).
  const wideFlat = filled.filter((s) => { const w = s.box.w * kx, h = s.box.h * ky; return !field(s.box) && w >= 3 * h && w * h < 0.03 * A && w >= 0.04 * W; });
  // Loose: not lying on a bigger piece of the same object (hull stripes, deck boards).
  const flatPatches = wideFlat.filter((p) => !filled.some((o) => o !== p && !field(o.box) && !wideFlat.includes(o) && area(o.box) >= 2 * area(p.box) && hits(p, o)));
  if (flatPatches.length >= 5) add("flat-patches", `${flatPatches.length} wide flat patches stacked as texture (reflection ladder), e.g. at ${where(flatPatches[0].box)}`, "Use a few shapes that follow the form instead: a reflection is one broken vertical smear under the light or object, not a ladder of horizontal blobs.", flatPatches);

  // Sawtooth and stair steps: points added only to pass the point count,
  // so the outline turns sharply one way, then the other, over and over.
  const zig = (s) => {
    const p = uniq(s.pts);
    if (!s.closed || p.length < 10 || s.curves > p.length / 2) return 0;
    let sharp = 0, flips = 0, prev = 0;
    for (let k = 0; k < p.length; k++) {
      const a = p[(k + p.length - 1) % p.length], b = p[k], c = p[(k + 1) % p.length];
      const t = Math.atan2(c[1] - b[1], c[0] - b[0]) - Math.atan2(b[1] - a[1], b[0] - a[0]);
      const turn = Math.atan2(Math.sin(t), Math.cos(t));
      if (Math.abs(turn) > 0.7) { sharp++; if (prev && Math.sign(turn) !== prev) flips++; prev = Math.sign(turn); }
    }
    return flips / p.length;
  };
  // Curves too: a row of same-size bumps (the stock scalloped cloud, a
  // curvy sawtooth) turns one way along each bump and back at each joint.
  // Refused when 12 segments in a row flip like that and are nearly the same size.
  const ang = (p, q) => Math.atan2(q[1] - p[1], q[0] - p[0]);
  const norm = (t) => Math.atan2(Math.sin(t), Math.cos(t));
  // Start and end tangent of a segment. An arc's stored point is its bulge,
  // and its tangents lean twice as far off the chord as that point does.
  const ends = (q) => {
    const c = q.ctrl || [];
    if (!c.length) { const t = ang(q.a, q.b); return [t, t]; }
    if (q.arc) { const ch = ang(q.a, q.b), m = norm(ang(q.a, c[0]) - ch); return [ch + 2 * m, ch - 2 * m]; }
    return [ang(q.a, c[0]), ang(c[c.length - 1], q.b)];
  };
  const regularBumps = (s) => {
    const g = s.segs.filter((q) => Math.hypot(q.b[0] - q.a[0], q.b[1] - q.a[1]) > 1e-6);
    if (!s.closed || g.length < 8 || !g.some((q) => q.kind === "C")) return false;
    const turns = []; // { t, seg }
    for (let k = 0; k < g.length; k++) {
      const q = g[k], c = q.ctrl || [];
      const [t0, t1] = ends(q);
      if (q.kind === "C" && c.length) { const t = norm(t1 - t0); if (Math.abs(t) > 0.7) turns.push({ t, seg: k }); }
      const j = norm(ends(g[(k + 1) % g.length])[0] - t1);
      if (Math.abs(j) > 0.7) turns.push({ t: j, seg: k + 0.5 });
    }
    const len = g.map((q) => Math.hypot(q.b[0] - q.a[0], q.b[1] - q.a[1]));
    // Closed outlines wrap around, so a cloud of 8 to 11 bumps is judged too.
    const n = g.length, win = Math.min(12, n);
    const turns2 = turns.concat(turns.map((x) => ({ t: x.t, seg: x.seg + n })));
    const cvOf = (v) => { const mean = v.reduce((a, b) => a + b, 0) / v.length; return Math.sqrt(v.reduce((a, b) => a + (b - mean) * (b - mean), 0) / v.length) / (mean || 1); };
    for (let k = 0; k < n; k++) {
      const inWin = turns2.filter((x) => x.seg >= k && x.seg < k + win);
      let flips = 0;
      for (let m = 1; m < inWin.length; m++) if (Math.sign(inWin[m].t) !== Math.sign(inWin[m - 1].t)) flips++;
      if (flips < Math.round(win * 1.15)) continue;
      // Same-size bumps: chord lengths and bump heights both barely vary.
      const idx = Array.from({ length: win }, (_, m) => (k + m) % n);
      const height = idx.map((i) => { const q = g[i], c = q.ctrl || []; if (!c.length) return 0; const dx = q.b[0] - q.a[0], dy = q.b[1] - q.a[1], l = Math.hypot(dx, dy) || 1; return Math.max(...c.map((p) => Math.abs((p[0] - q.a[0]) * dy - (p[1] - q.a[1]) * dx) / l)); });
      if (cvOf(idx.map((i) => len[i])) < 0.3 && cvOf(height) < 0.3) return true;
    }
    return false;
  };
  // A stretch of an outline that saws: 10 joints in a row, each turning
  // back the other way (even gently), with teeth of nearly one size. Catches
  // a sawtooth ridge or a stair-step slope on one side of a long outline.
  const sawStretch = (s) => {
    // Straight segments only; a curve breaks the run.
    const g = s.segs.filter((q) => Math.hypot(q.b[0] - q.a[0], q.b[1] - q.a[1]) > 1e-6);
    if (g.length < 12) return false;
    const n = g.length, turn = [], len = [];
    for (let k = 0; k < n; k++) {
      const q = g[k], nx = g[(k + 1) % n];
      // Turn at the joint after segment k; NaN where a curve touches it.
      turn.push(q.kind === "L" && nx.kind === "L" ? norm(ang(nx.a, nx.b) - ang(q.a, q.b)) : NaN);
      len.push(Math.hypot(q.b[0] - q.a[0], q.b[1] - q.a[1]));
    }
    const lim = s.closed ? n : n - 10;
    for (let k = 1; k < lim; k++) {
      let flips = 0;
      for (let m = 1; m < 10; m++) {
        const t0 = turn[(k + m - 1) % n], t1 = turn[(k + m) % n];
        if (Math.abs(t0) > 0.3 && Math.abs(t1) > 0.3 && Math.sign(t0) !== Math.sign(t1)) flips++;
      }
      if (flips < 8) continue;
      const L = Array.from({ length: 10 }, (_, m) => len[(k + m) % n]), mean = L.reduce((a, b) => a + b, 0) / 10;
      if (Math.sqrt(L.reduce((a, b) => a + (b - mean) * (b - mean), 0) / 10) / (mean || 1) < 0.35) return true;
    }
    return false;
  };
  // A short saw: within any 8 straight joints, 5 or more sharp turns that
  // flip back and forth, over a run at least 3% of the canvas wide.
  const rocky = /\b(rocks?|rocky|cliffs?|crags?|stones?|boulders?|bluffs?|headland|outcrop|mountains?|hills?|ridges?)\b/i.test(opts.name || "");
  const sawDense = (s) => {
    const g = s.segs.filter((q) => Math.hypot(q.b[0] - q.a[0], q.b[1] - q.a[1]) > 1e-6);
    if (g.length < 9) return false;
    const n = g.length, turn = [];
    for (let k = 0; k < n; k++) {
      const q = g[k], nx = g[(k + 1) % n];
      turn.push(q.kind === "L" && nx.kind === "L" ? norm(ang(nx.a, nx.b) - ang(q.a, q.b)) : NaN);
    }
    const lim = s.closed ? n : n - 8;
    for (let k = 0; k < lim; k++) {
      let flips = 0;
      for (let m = 1; m < 8; m++) {
        const t0 = turn[(k + m - 1) % n], t1 = turn[(k + m) % n];
        if (Math.abs(t0) > 0.5 && Math.abs(t1) > 0.5 && Math.sign(t0) !== Math.sign(t1)) flips++;
      }
      if (flips < 5) continue;
      if (rocky) {
        const L = Array.from({ length: 8 }, (_, m) => { const q = g[(k + m) % n]; return Math.hypot(q.b[0] - q.a[0], q.b[1] - q.a[1]); }), mean = L.reduce((a, b) => a + b, 0) / 8;
        if (Math.sqrt(L.reduce((a, b) => a + (b - mean) * (b - mean), 0) / 8) / (mean || 1) >= 0.3) continue;
      }
      const pts = Array.from({ length: 9 }, (_, m) => g[(k + m) % n].a);
      const bb = bboxOf(pts);
      if (Math.max(bb.w * kx, bb.h * ky) >= 0.03 * W) return true;
    }
    return false;
  };
  const sawOk = /\b(foam|surf|spray|grass|fur|hair|feathers?|flames?|fire|sparks?|stars?|waves?|swells?|sea|water)\b/i.test(opts.name || "");
  const zigs = filled.filter((s) => !field(s.box) && ((area(s.box) >= 0.004 * A && (zig(s) >= 0.45 || regularBumps(s) || sawStretch(s))) || (!sawOk && Math.max(s.box.w * kx, s.box.h * ky) >= 0.05 * W && sawDense(s))));
  if (zigs.length) add("zigzag", `the outline at ${where(zigs[0].box)} is a sawtooth, stair-step or row of same-size bumps (sharp turns flipping back and forth)`, "Edges wander, they do not zigzag: use fewer, longer runs and gentle curves of different lengths; a cloud edge is soft lumps, a cliff edge breaks at a few ledges.", zigs);

  // Faceted soft things: a cloud, smoke, foam, a bush or a tree crown drawn
  // with straight segments only reads as a low-poly cut-out.
  if (/\b(clouds?|smoke|steam|mist|fog|foam|surf|bush(es)?|shrubs?|trees?|crowns?|canopy|foliage|hedges?)\b/i.test(opts.name || "")) {
    const facet = filled.filter((s) => !field(s.box) && area(s.box) >= 0.002 * A && s.segs.length >= 6 && s.curves < 0.3 * s.segs.length);
    if (facet.length) add("faceted", `${opts.name} is built from straight segments (${facet.length} faceted shape${facet.length === 1 ? "" : "s"}, e.g. at ${where(facet[0].box)})`, "Soft things have soft edges: draw the outline with curves (C or Q) of different sizes, lumps that overlap, and a soft, broken underside, not straight cuts.", facet);
  }

  // Floating ovals: smooth, nearly elliptical blobs lying inside a bigger
  // shape (lens-shaped light patches on a rock, blobs on the sea). Many
  // points do not save an oval; its outline is what matters.
  const polyArea = (p) => { let a = 0; for (let k = 0; k < p.length; k++) { const [x1, y1] = p[k], [x2, y2] = p[(k + 1) % p.length]; a += x1 * y2 - x2 * y1; } return Math.abs(a) / 2; };
  const hull = (p) => {
    const q = uniq(p).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (q.length < 3) return q;
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const v of q) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], v) <= 0) lo.pop(); lo.push(v); }
    for (const v of q.slice().reverse()) { while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], v) <= 0) up.pop(); up.push(v); }
    return lo.slice(0, -1).concat(up.slice(0, -1));
  };
  const ovalish = (s) => {
    if (s.tag === "circle" || s.tag === "ellipse") return true;
    if (!s.closed || s.pts.length < 5) return false;
    const pa = polyArea(s.pts), ha = polyArea(hull(s.pts));
    const pb = bboxOf(s.pts); // on-curve points only, so curve handles do not inflate it
    const fill = pa / Math.max(1e-6, (Math.PI / 4) * pb.w * pb.h);
    return ha > 0 && pa / ha >= 0.93 && fill >= 0.8 && fill <= 1.12;
  };
  const inside = (p, o) => p.box.x >= o.box.x && p.box.y >= o.box.y && p.box.x + p.box.w <= o.box.x + o.box.w && p.box.y + p.box.h <= o.box.y + o.box.h;
  // See-through and blurred blobs count here too (ghost blobs); only fading glows do not.
  const ovals = shapes.filter((s) => s.fill && !s.fade && !field(s.box)).filter((s) => { const a = area(s.box); return a >= 0.003 * A && a < 0.05 * A && ovalish(s) && shapes.some((o) => o !== s && o.fill && o.fill !== s.fill && area(o.box) >= 6 * a && inside(s, o)); });
  // One see-through ghost blob is enough (a pale patch floating on the sea).
  if (ovals.length >= 2 || ovals.some((s) => s.alpha < 0.9)) add("ovals", `${ovals.length} smooth oval patches floating on a bigger shape, e.g. at ${where(ovals[0].box)}`, "Light and shadow follow the form: a lit plane has corners and runs along the top or the side facing the light; foam and reflections hug edges. Do not drop oval patches on a surface.", ovals);

  // Small round stains on a face: two or more little oval blobs set inside
  // one bigger shape (pasted weathering), too small for the oval rule.
  if (!/\b(sea|water|ocean|lake|bay|river|pond|sky|skies|clouds?|stars?|night|foam|spray|surf|lighthouses?|houses?|towers?|cottages?|buildings?|lanterns?|boats?|ships?|windows?)\b/i.test(opts.name || "")) {
    const host = (s) => shapes.find((o) => o !== s && o.fill && o.fill !== s.fill && !field(o.box) && area(o.box) >= 20 * area(s.box) && inside(s, o));
    const small = shapes.filter((s) => { const a = area(s.box), L = (labOf(s.fill) || [0.5])[0]; return s.fill && !s.fade && !field(s.box) && a >= 0.0004 * A && a < 0.003 * A && L >= 0.2 && L <= 0.75 && ovalish(s); });
    const byHost = new Map();
    for (const s of small) { const o = host(s); if (o) byHost.set(o, (byHost.get(o) || []).concat([s])); }
    const stains = [...byHost.values()].find((v) => v.length >= 2);
    if (stains) add("ovals", `${stains.length} small round stains set on one face, e.g. at ${where(stains[0].box)} (pasted weathering)`, "Weathering follows the form and the weather: streaks that run down from ledges and windows, a darker band where spray reaches, worn corners; not round spots dropped on a surface.", stains);
  }
  // A mirror: a big outline whose left and right sides match each other
  // row by row (the stock tower, the stock canoe hull).
  if (!/\b(sea|water|ocean|lake|bay|river|pond|sky|skies|clouds?|sun|moon|glow|light|mist|haze|fog|foam|spray|surf|waves?|swells?|stars?)\b/i.test(opts.name || "")) {
    const mirrored = (s) => {
      const P = outlineOf(s);
      if (P.length < 6) return false;
      const b = s.box, rows = [];
      for (let r = 0; r < 9; r++) {
        const y = b.y + b.h * (0.12 + 0.095 * r);
        const xs = [];
        for (let k = 0; k < P.length; k++) {
          const p = P[k], q = P[(k + 1) % P.length];
          if ((p[1] <= y) !== (q[1] <= y)) xs.push(p[0] + ((y - p[1]) * (q[0] - p[0])) / (q[1] - p[1]));
        }
        if (xs.length >= 2) rows.push((Math.min(...xs) + Math.max(...xs)) / 2);
      }
      if (rows.length < 7) return false;
      const axis = rows.slice().sort((a, c) => a - c)[rows.length >> 1];
      return Math.max(...rows.map((m) => Math.abs(m - axis))) < 0.012 * b.w;
    };
    const mir = filled.filter((s) => s.closed && !field(s.box) && s.tag !== "circle" && s.tag !== "ellipse" && s.tag !== "rect" && s.verts >= 6 && s.box.w * kx >= 0.03 * W && s.box.h * ky >= 0.03 * H && area(s.box) >= 0.004 * A && mirrored(s));
    if (mir.length) add("mirror", `the outline at ${where(mir[0].box)} mirrors itself: its left and right sides match row by row (a stock symbol)`, "Drawn things are not mirror images: give one side a slight lean, a bulge, a chipped or weathered run, or a different taper, so the two sides no longer match.", mir);
  }

  // Drawn cracks: thin dark zigzag slivers laid on a rock or wall (the
  // stock crack), not breaks between planes.
  if (!/\b(sea|water|ocean|lake|bay|river|pond|waves?|swells?)\b/i.test(opts.name || "")) {
    const cracks = filled.filter((s) => {
      const w = s.box.w * kx, h = s.box.h * ky, L = (labOf(s.fill) || [1])[0];
      if (!s.closed || L > 0.3 || s.curves > 1 || s.segs.length < 6) return false;
      if (Math.max(w, h) < 2.5 * Math.min(w, h) || Math.max(w, h) < 0.04 * Math.min(W, H)) return false;
      return filled.some((o) => o !== s && area(o.box) >= 10 * area(s.box) && o.box.x <= s.box.x && o.box.y <= s.box.y && o.box.x + o.box.w >= s.box.x + s.box.w && o.box.y + o.box.h >= s.box.y + s.box.h);
    }).filter((s) => {
      // The sliver's sides turn back and forth: a lightning-bolt edge.
      const p = uniq(s.pts);
      let flips = 0, prev = 0;
      for (let k = 1; k + 1 < p.length; k++) {
        const t = norm(ang(p[k], p[k + 1]) - ang(p[k - 1], p[k]));
        if (Math.abs(t) > 0.35) { if (prev && Math.sign(t) !== prev) flips++; prev = Math.sign(t); }
      }
      return flips >= (Math.max(s.box.w * kx, s.box.h * ky) >= 4 * Math.min(s.box.w * kx, s.box.h * ky) ? 3 : 8);
    });
    if (cracks.length >= 2) add("drawn-cracks", `${cracks.length} thin dark zigzag slivers laid on the surface, e.g. at ${where(cracks[0].box)} (stock lightning-bolt cracks)`, "Cracks are where planes meet: let a darker plane's edge or a shadowed seam between two faces do the work, short and uneven, often branching or fading; do not draw zigzag lines on a flat face.", cracks);
  }
  // A pale shelf: a wide, thin, pale slab that starts at an object's
  // waterline and runs out past both of its sides (the stock shelf a boat
  // floats on). On water it is not a foam line: it is a pasted pad.
  {
    const solids = filled.filter((s) => s.fill && s.closed && !s.fade && !field(s.box) && area(s.box) >= 0.0015 * A);
    const shelves = shapes.filter((s) => {
      const L = (labOf(s.fill) || [0])[0], w = s.box.w * kx, h = s.box.h * ky;
      if (!s.fill || !s.closed || s.fade || L < 0.7 || w < 4 * h || w >= 0.45 * W || field(s.box) || area(s.box) < 0.0004 * A) return false;
      const cx = s.box.x + s.box.w / 2, cy = s.box.y + s.box.h / 2;
      const above = solids.filter((o) => o !== s && o.box.y < cy && o.box.x < s.box.x + s.box.w && o.box.x + o.box.w > s.box.x);
      if (!above.length) return false;
      // The object it runs out from, boxed together: a hull and its mast.
      const u = bboxOf(above.flatMap((o) => [[o.box.x, o.box.y], [o.box.x + o.box.w, o.box.y + o.box.h]]));
      return u.w >= 0.2 * s.box.w && u.w <= 0.95 * s.box.w && u.h >= 0.3 * s.box.w && u.w * kx >= 0.02 * W && Math.abs(u.x + u.w / 2 - cx) < 0.2 * s.box.w;
    });
    if (shelves.length) add("shelf", `a pale slab at ${where(shelves[0].box)} runs along the base of the object and out past both of its sides (a pasted shelf)`, "Where a hull or a rock meets the water there is no pale shelf: break the contact into a few uneven touches of foam, thinner in places and gone in others, with the water and its reflection showing between them.", shelves);
  }
  // A foam slab: one even pale band along the whole base of an object or
  // across the water (the stock surf shelf).
  {
    const big = filled.filter((s) => !field(s.box) && s.closed).sort((a, b) => area(b.box) - area(a.box))[0];
    const foamName = /\b(foam|surf|spray|breakers?)\b/i.test(opts.name || "");
    const slabs = shapes.filter((s) => {
      const L = (labOf(s.fill) || [0])[0], w = s.box.w * kx, h = s.box.h * ky;
      if (!s.fill || !s.closed || s.fade || L < 0.85 || w < 8 * h || w < 0.25 * W) return false;
      // On the water a wide pale band is only a shelf when something floats
      // on it: a sea painted with a pale swell is not a foam shelf.
      if (water && !foamName && !filled.some((o) => o !== s && o.box.h >= 0.02 * H && o.box.w < 0.6 * s.box.w && o.box.y + o.box.h <= s.box.y + 0.6 * s.box.h && o.box.y + o.box.h >= s.box.y - 0.6 * s.box.h)) return false;
      if (big && big !== s && !foamName) return s.box.w >= 0.6 * big.box.w && s.box.y + s.box.h >= big.box.y + 0.85 * big.box.h;
      return foamName;
    });
    if (slabs.length) add("foam-slab", `one even pale band ${Math.round(slabs[0].box.w * kx)}px long along the base at ${where(slabs[0].box)} (a foam shelf)`, "Surf breaks: several torn pieces of different sizes where the water hits the rock, thicker on the side the waves come from, with gaps and spray; never one even pale band.", slabs);
  }
  // A tower painted as a flat column with a band across it and a cut-off
  // foot (the stock lighthouse): no light turning on the form, and nothing
  // spreading where it meets the rock.
  if (/\b(lighthouses?|towers?|chimneys?|minarets?|spires?|turrets?|silos?|beacons?)\b/i.test(opts.name || "") && !/\b(surf|foam|spray|waves?|glow|light|reflection)\b/i.test(opts.name || "")) {
    const solid1 = filled.filter((s) => !field(s.box) && s.closed && !s.soft && (s.alpha ?? 1) >= 0.9 && labOf(s.fill));
    const host = solid1.sort((a, b) => area(b.box) - area(a.box))[0];
    if (host && host.box.h >= 2 * host.box.w) {
      const hb = host.box;
      const inner = solid1.filter((s) => s !== host && s.box.x >= hb.x - 0.05 * hb.w && s.box.x + s.box.w <= hb.x + 1.05 * hb.w);
      const bands = inner.filter((s) => s.box.w >= 0.7 * hb.w && s.box.h <= 0.32 * hb.h);
      const planes = inner.filter((s) => area(s.box) >= 0.05 * area(hb));
      const hostL = (labOf(host.fill) || [0])[0];
      const shade = planes.filter((s) => !bands.includes(s) && (() => { const L = labOf(s.fill); return L && Math.abs(L[0] - hostL) >= 0.08; })());
      if (shade.length === 0 && bands.length <= 2) add("tower-form", `${opts.name} at ${where(hb)} is one flat column${bands.length ? ` with ${bands.length === 1 ? "one flat band" : "two flat bands"} across it` : ""} and no light or shade on its form`, "A round tower turns: a lit side facing the light, a core shadow curving in from the far side with a half-tone before it, and a little reflected light at the far edge. Paint the bands as ellipses that dip at the sides, not strips cut across.", [host]);
      // Nothing spreads at its foot: the plinth or the rock it stands on.
      const foot = inner.filter((s) => s.box.w >= 1.02 * hb.w && s.box.y + s.box.h >= hb.y + 0.8 * hb.h);
      const contact = inner.some((s) => s.box.w >= 0.8 * hb.w && s.box.h <= 0.1 * hb.h && s.box.y + s.box.h >= hb.y + 0.9 * hb.h);
      if (!foot.length && !contact.length) add("tower-foot", `${opts.name} ends on a flat cut at ${where({ x: hb.x, y: hb.y + hb.h - 0.08 * hb.h, w: hb.w, h: 0.08 * hb.h })} with nothing spreading under it (no footing)`, "Give the tower a footing where it meets the rock: a wider plinth that steps out, uneven, with the shadow of the tower falling on it and a few loose stones at its base, so it stands on something.", [host]);
    }
  }
  // A hanging shadow: one dark drop under an object's body, below where it
  // rests (the stock reflection blob under a boat).
  if (!/\b(sea|water|ocean|lake|bay|river|pond|sky|skies|clouds?|waves?|swells?|foam|surf|spray|glow|light|reflections?)\b/i.test(opts.name || "")) {
    // Each big shape is tried as the body: the drop itself may be the biggest shape.
    const bodies = filled.filter((s) => !field(s.box) && s.closed).sort((a, b) => area(b.box) - area(a.box)).slice(0, 4);
    for (const body of bodies) {
      const bb = body.box;
      if (problems.some((p) => p.rule === "hanging-shadow")) break;
      // It hangs below everything else the object draws.
      const lowest = (s) => Math.max(...filled.filter((o) => o !== s && !field(o.box) && o.closed).map((o) => o.box.y + o.box.h));
      const tapers = (s) => { const P = outlineOf(s), b = s.box; const span = (y) => { const xs = []; for (let k = 0; k < P.length; k++) { const p = P[k], q = P[(k + 1) % P.length]; if ((p[1] <= y) !== (q[1] <= y)) xs.push(p[0] + ((y - p[1]) * (q[0] - p[0])) / (q[1] - p[1])); } return xs.length >= 2 ? Math.max(...xs) - Math.min(...xs) : 0; }; const top = span(b.y + 0.2 * b.h), bot = span(b.y + 0.8 * b.h); return b.h >= 0.25 * b.w && top > 0 && bot < 0.6 * top; };
      const drops = shapes.filter((s) => s !== body && s.box.y + s.box.h > lowest(s) + 0.2 * s.box.h && s.fill && s.closed && !s.fade && (s.alpha < 0.9 || s.soft || s.curves >= 0.6 * s.segs.length || tapers(s) || (s.box.w >= 5 * s.box.h && (labOf(s.fill) || [0, 0, 0])[2] < -0.03 && /\b(boats?|ships?|vessels?|dinghy|canoes?|yachts?|trawlers?|skiffs?)\b/i.test(opts.name || ""))) && ((labOf(s.fill) || [1])[0] < 0.36 || (labOf(s.fill) || [0, 0, 0])[2] < -0.06) && s.box.w >= 0.3 * bb.w && s.box.w <= 1.4 * bb.w && s.box.y >= bb.y + 0.5 * bb.h && s.box.y + s.box.h >= bb.y + bb.h + 0.4 * s.box.h && s.box.x >= bb.x - 0.2 * bb.w && s.box.x + s.box.w <= bb.x + 1.2 * bb.w);
      if (drops.length) add("hanging-shadow", `a dark drop hangs under the object at ${where(drops[0].box)} (a stock reflection or shadow blob)`, "Leave the reflection to JDraw's light pass, or draw it as a few broken horizontal strokes that wobble with the water, lighter than the object and cut by the swells; never one dark shape hanging below.", drops);
    }
  }
  // Vertical bands: one object split into three or more tall strips that
  // stand side by side across it (lit, mid and dark as full-height bands).
  if (!/\b(sea|water|ocean|lake|bay|river|pond|sky|skies|clouds?|waves?|swells?|foam|surf|glow|light|mist|haze|fence|railing|columns?|pillars?)\b/i.test(opts.name || "")) {
    const host = filled.filter((s) => !field(s.box) && s.closed).sort((a, b) => area(b.box) - area(a.box))[0];
    if (host && area(host.box) >= 0.01 * A) {
      const hb = host.box, pad = 0.05 * Math.max(hb.w, hb.h);
      const tall = filled.filter((s) => s !== host && s.closed && s.box.h >= 0.6 * hb.h && s.box.w <= 0.5 * hb.w && s.box.w >= 0.08 * hb.w && s.box.x >= hb.x - pad && s.box.y >= hb.y - pad && s.box.x + s.box.w <= hb.x + hb.w + pad && s.box.y + s.box.h <= hb.y + hb.h + pad).sort((a, b) => a.box.x - b.box.x);
      // Side by side: each starts near where the one before it ends.
      let run = tall.slice(0, 1), best = run;
      for (let k = 1; k < tall.length; k++) {
        const p = run[run.length - 1].box, q = tall[k].box;
        if (q.x <= p.x + p.w + 0.1 * hb.w && q.x >= p.x + 0.3 * p.w) run = run.concat([tall[k]]); else run = [tall[k]];
        if (run.length > best.length) best = run;
      }
      const span = best.length ? best[best.length - 1].box.x + best[best.length - 1].box.w - best[0].box.x : 0;
      if (best.length >= 3 && span >= 0.5 * hb.w) add("vertical-bands", `${opts.name || "the object"} is split into ${best.length} tall bands standing side by side at ${where(hb)} (light, mid and dark as full-height strips)`, "Planes are not strips: break the mass into facets of different sizes and shapes that meet at angles, a big lit top plane, a shadowed side that turns under, smaller chips and ledges; no seam runs the full height.", best);
    }
  }
  // Split tone: a tall building cut down its height into flat full-height
  // strips (light, dark) meeting at straight seams, not a turning form.
  if (/\b(lighthouses?|towers?|chimneys?|columns?|pillars?|silos?|minarets?|spires?|turrets?)\b/i.test(opts.name || "")) {
    const solid = filled.filter((s) => !field(s.box) && s.closed && !s.soft && (s.alpha ?? 1) >= 0.9 && labOf(s.fill));
    const tallest = Math.max(0, ...solid.map((s) => s.box.h));
    const tall = solid.filter((s) => s.box.h >= 0.6 * tallest);
    if (tall.length >= 2) {
      const x0 = Math.min(...tall.map((s) => s.box.x)), x1 = Math.max(...tall.map((s) => s.box.x + s.box.w));
      const y0 = Math.min(...tall.map((s) => s.box.y)), y1 = Math.max(...tall.map((s) => s.box.y + s.box.h));
      const hb = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      if (hb.h >= 1.8 * hb.w) {
        const tallP = tall.filter((s) => s.box.w >= 0.15 * hb.w && s.box.w <= 0.7 * hb.w);
        const pair = tallP.find((l) => tallP.some((r) => r !== l && r.box.x > l.box.x && Math.abs(r.box.x - (l.box.x + l.box.w)) <= 0.06 * hb.w && Math.abs(labOf(l.fill)[0] - labOf(r.fill)[0]) >= 0.12));
        if (pair) add("split-tone", `${opts.name || "the object"} is split down its height into flat light and dark strips at ${where(hb)} (hard straight seams)`, "A round form turns from light to shadow: lay a core shadow that curves with the form a little in from the dark side, with a narrow half-tone before it and a little reflected light at the far edge, so there is no single straight seam.", [pair]);
      }
    }
  }
  // See-through shade: a dark flat shape at partial opacity laid over a
  // building or rock to shade it (a plaid veil), not an opaque plane in the
  // object's own hue.
  if (/\b(lighthouses?|towers?|houses?|cottages?|buildings?|churche?s?|barns?|chimneys?|rocks?|rocky|cliffs?|crags?|boulders?|headland|outcrop)\b/i.test(opts.name || "")) {
    const host = filled.filter((s) => !field(s.box) && s.closed).sort((m, n) => area(n.box) - area(m.box))[0];
    if (host) {
      const hb = host.box;
      const veils = shapes.filter((s) => s !== host && s.fill && s.closed && !s.soft && !s.fade && !/url\(/.test(s.fill) && (s.alpha ?? 1) >= 0.2 && (s.alpha ?? 1) <= 0.85 && (labOf(s.fill) || [1])[0] < 0.5 && area(s.box) >= 0.04 * area(hb) && Math.max(0, Math.min(s.box.x + s.box.w, hb.x + hb.w) - Math.max(s.box.x, hb.x)) * Math.max(0, Math.min(s.box.y + s.box.h, hb.y + hb.h) - Math.max(s.box.y, hb.y)) >= 0.8 * area(s.box));
      if (veils.length) add("see-through-shade", `a dark see-through shape laid over ${opts.name || "the object"} to shade it, at ${where(veils[0].box)} (a veil, so the bands and planes show through it)`, "Shade with opaque color: each band or plane gets its own darker, cooler version on the shadow side, painted as part of it, not a dark film laid over everything.", veils);
    }
  }
  // Stamped holes: three or more small pieces of one color set apart on a
  // rock face (pasted crevices or shadow spots), not planes that meet.
  if (/\b(rocks?|rocky|cliffs?|crags?|stones?|boulders?|bluffs?|headland|outcrop|hills?|mountains?|ground|lighthouse|tower|beacon)\b/i.test(opts.name || "")) {
    const host = filled.filter((s) => !field(s.box) && s.closed).sort((a, b) => area(b.box) - area(a.box))[0];
    if (host) {
      const hb = host.box;
      // A headland or rock must stand on something: it reaches the bottom or a
      // side of the picture, or other land sits under its base. A rock that
      // hangs in the middle of the sea with nothing under it is a floating cone.
      const bottomOpen = hb.y + hb.h < vb.y + 0.9 * vb.h;
      const touchesEdge = hb.x <= vb.x + 0.02 * vb.w || hb.x + hb.w >= vb.x + 0.98 * vb.w;
      const under = filled.some((s) => s !== host && !field(s.box) && s.box.y <= hb.y + hb.h + 0.03 * vb.h && s.box.y + s.box.h >= hb.y + hb.h - 0.03 * vb.h && Math.min(s.box.x + s.box.w, hb.x + hb.w) - Math.max(s.box.x, hb.x) > 0.2 * hb.w);
      if (bottomOpen && !touchesEdge && !under && /\b(headland|island|outcrop|rocks?|rocky|cliffs?|crags?|bluffs?)\b/i.test(opts.name || "")) add("floating-rock", `${opts.name} is a rock that hangs above the water at ${where(hb)} with nothing under its base (a floating cone, not a headland)`, "A headland is land: anchor it to the frame's edge or the bottom, with a cliff that runs down into the water and a shelf of rock where it meets the sea. Draw the land in the foreground, not one shape in the middle of the sea.", [host]);
      const bits = filled.filter((s) => s !== host && s.closed && area(s.box) >= 0.0008 * A && area(s.box) <= 0.04 * area(hb) && s.box.x > hb.x && s.box.y > hb.y && s.box.x + s.box.w < hb.x + hb.w && s.box.y + s.box.h < hb.y + hb.h);
      const groups = [];
      for (const s of bits) { const L = labOf(s.fill); const g = L && groups.find((x) => Math.hypot(x.L[0] - L[0], x.L[1] - L[1], x.L[2] - L[2]) < 0.08); if (g) g.list.push(s); else if (L) groups.push({ L, list: [s] }); }
      const gap = 0.01 * Math.max(hb.w, hb.h);
      const apart = (g) => g.every((s, i) => g.every((o, j) => i === j || s.box.x + s.box.w + gap < o.box.x || o.box.x + o.box.w + gap < s.box.x || s.box.y + s.box.h + gap < o.box.y || o.box.y + o.box.h + gap < s.box.y));
      const stamped = groups.map((x) => x.list).find((g) => g.length >= 3 && apart(g));
      // Few big planes: a rock face built from a handful of large flat
      // polygons (low-poly), with no smaller facets, cracks or ledges.
      {
        const inner = filled.filter((s) => s !== host && s.closed && !s.soft && area(s.box) >= 0.003 * area(hb));
        const big = inner.filter((s) => area(s.box) >= 0.06 * area(hb));
        const smallN = inner.length - big.length;
        if (big.length >= 2 && big.length <= 8 && smallN < 4 && area(hb) >= 0.04 * A) add("big-planes", `${opts.name || "the rock"} is ${big.length} big flat planes with almost no smaller facets (${smallN} small ones), at ${where(hb)} (low-poly)`, "Big planes are a start, not a finish: break each into smaller facets of different sizes, add cracks that run along plane edges, ledges with a lit top and a shadow under them, and a few loose stones at the base; let the outline turn at many small corners.", big);
      }
      // A decal: a small straight-sided patch of 3 to 6 corners set well
      // inside the face, touching nothing (a sticker, not a plane).
      const inset = 0.06 * Math.min(hb.w, hb.h);
      const decals = bits.filter((s) => s.curves === 0 && s.segs.length >= 3 && s.segs.length <= 10 && Math.max(s.box.w, s.box.h) <= 3 * Math.min(s.box.w, s.box.h) && area(s.box) <= 0.02 * area(hb) && s.box.x > hb.x + inset && s.box.y > hb.y + inset && s.box.x + s.box.w < hb.x + hb.w - inset && s.box.y + s.box.h < hb.y + hb.h - inset);
      const near = (s, o) => o.box.x < s.box.x + s.box.w + gap && s.box.x < o.box.x + o.box.w + gap && o.box.y < s.box.y + s.box.h + gap && s.box.y < o.box.y + o.box.h + gap;
      const alone = decals.filter((s) => !filled.some((o) => o !== s && o !== host && o.closed && area(o.box) < 4 * area(s.box) && near(s, o)));
      decals.length = 0; decals.push(...alone);
      if (decals.length && !stamped) add("decal", `${decals.length === 1 ? "a small straight-sided patch" : decals.length + " small straight-sided patches"} stuck on the face, e.g. at ${where(decals[0].box)} (a sticker)`, "Marks on a rock belong to its planes: a crack that runs along a plane edge, a shadow under a ledge, a darker face where the rock turns away from the light; not a small flat patch dropped on the surface.", decals);
      if (stamped) add("stamped-holes", `${stamped.length} small pieces of one color set apart on the face, e.g. at ${where(stamped[0].box)} (pasted crevices or spots)`, "Crevices and shadow pockets follow the planes: a dark seam where two faces meet, a shadow tucked under a ledge, each a different size and shape; never the same dark patch stamped across the face.", stamped);
    }
  }
  // Slab strata: four or more wide pieces stacked one above another that
  // together fill much of their area (a cliff as a pile of horizontal
  // slabs, a sky as stripes), whether or not a base shape sits under them.
  const slabs = filled.filter((s) => { const w = s.box.w * kx, h = s.box.h * ky; return !field(s.box) && !/data-jdraw-plane="/.test(s.raw || "") && w >= 2.2 * h && w >= 0.06 * W && w * h < 0.1 * A; });
  for (const s of slabs) {
    const col = slabs.filter((o) => o.box.x < s.box.x + s.box.w && o.box.x + o.box.w > s.box.x);
    const ys = [...new Set(col.map((o) => Math.round((o.box.y + o.box.h / 2) * ky / (0.01 * H))))];
    if (ys.length < 4) continue;
    const u = bboxOf(col.flatMap((o) => [[o.box.x, o.box.y], [o.box.x + o.box.w, o.box.y + o.box.h]]));
    const cover = col.reduce((n, o) => n + area(o.box), 0) / Math.max(1, area(u));
    if (cover >= 0.35) {
      add("slabs", `${col.length} wide pieces stacked in horizontal layers at ${where(u)} (slab strata or stripes)`, "Build the mass from a few big planes that follow its form: a lit top plane, a shadowed face, cracks and ledges that run with the slope at different angles; not a pile of parallel horizontal slabs.");
      break;
    }
  }

  // Ruler edges: long straight runs at any angle (several short segments on
  // one line count as one), not on the SVG's own border, not in a field.
  const onBorder = (p) => Math.abs(p[0] - vb.x) < 0.01 * vb.w || Math.abs(p[0] - vb.x - vb.w) < 0.01 * vb.w || Math.abs(p[1] - vb.y) < 0.01 * vb.h || Math.abs(p[1] - vb.y - vb.h) < 0.01 * vb.h;
  ruler: for (const s of filled) {
    if (field(s.box)) continue;
    for (const r of straightRuns(s)) {
      const dx = (r.b[0] - r.a[0]) * kx, dy = (r.b[1] - r.a[1]) * ky;
      const len = Math.hypot(dx, dy);
      const axis = Math.abs(dy) <= 0.01 * len || Math.abs(dx) <= 0.01 * len;
      if (len < (axis ? 0.12 : 0.16) * W) continue;
      if (onBorder(r.a) && onBorder(r.b)) continue;
      add("ruler-edge", `a ruler-straight edge ${Math.round(len)}px long at ${where(bboxOf([r.a, r.b]))}`, "Nothing hand-drawn is that straight: let the edge lean, sag or bulge a little and break it into uneven runs.", [s]);
      break ruler;
    }
  }

  // Ruler horizon: a field (sea, ground, sky) whose edge runs dead straight
  // across the middle of the canvas, whether or not it sits on the SVG's border.
  // A wiggle of a pixel or two still reads as ruled, so the test is how far
  // a long chain of the outline strays from the line between its ends.
  const flatChains = (s) => {
    const P = s.segs.flatMap((g) => [g.a, ...(g.ctrl || [])]).concat(s.segs.length ? [s.segs[s.segs.length - 1].b] : []).map(([x, y]) => [opts.x + (x - vb.x) * kx, opts.y + (y - vb.y) * ky]);
    const out = [];
    const dev = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / l; };
    let i = 0;
    while (i < P.length - 1) {
      let j = i + 1;
      while (j + 1 < P.length && P.slice(i + 1, j + 1).every((p) => dev(p, P[i], P[j + 1]) <= 6)) j++;
      out.push({ a: P[i], b: P[j] });
      i = j;
    }
    return out;
  };
  // Fields, and any full-width strip (a thin band laid on the horizon to
  // hide a ruled edge is itself a ruled edge). A see-through sea counts too:
  // a gradient does not make a ruled edge hand-drawn.
  const horizonShapes = shapes.filter((s) => s.fill && s.closed && (field(s.box) || s.box.w * kx >= 0.6 * W));
  horizon: for (const s of horizonShapes) {
    for (const r of flatChains(s)) {
      const dx = r.b[0] - r.a[0], dy = r.b[1] - r.a[1], len = Math.hypot(dx, dy);
      const cy = (r.a[1] + r.b[1]) / 2;
      if (len < 0.4 * W || Math.abs(dy) > 0.03 * len || cy < 0.15 * H || cy > 0.88 * H) continue;
      // A chain along the frame counts only when the field lies below it and
      // runs on down (a sea cut off by the top of its own item). A sky whose
      // bottom edge is the frame is covered by the water in front of it.
      const atTop = Math.abs(r.a[1] - opts.y) < 2 && Math.abs(r.b[1] - opts.y) < 2;
      const atBot = Math.abs(r.a[1] - (opts.y + opts.h)) < 2 && Math.abs(r.b[1] - (opts.y + opts.h)) < 2;
      if (atBot) continue;
      if (atTop && s.box.h * ky < 0.1 * H) continue;
      add("ruler-horizon", `a dead-straight horizon or field edge ${Math.round(len)}px long at y ${Math.round(cy)}`, "Break the edge where two fields meet: let it rise and dip a few pixels, overlap the far water with a hazy band or a far headland, and let the sky run on behind the sea instead of ending on a straight line.", [s]);
      break horizon;
    }
  }

  // Confetti: three or more small straight-sided specks (foam as white
  // shards, hexagon dots), in any object whatever its name.
  // Windows, panes and rail posts are boxes, not shards.
  const isRect = (s) => { const p = uniq(s.pts); if (p.length !== 4) return false; const b = bboxOf(p); return polyArea(p) >= 0.9 * b.w * b.h; };
  const shards = filled.filter((s) => { const a = area(s.box); return a >= 0.00003 * A && a < 0.0015 * A && s.segs.length >= 3 && s.segs.length <= 7 && s.curves === 0 && !isRect(s) && !(uniq(s.pts).length === 4 && filled.some((o) => o !== s && o.alpha >= 0.85 && area(o.box) >= 8 * a && o.box.x <= s.box.x && o.box.y <= s.box.y && o.box.x + o.box.w >= s.box.x + s.box.w && o.box.y + o.box.h >= s.box.y + s.box.h)); });
  if (shards.length >= 3) add("shards", `${shards.length} small straight-sided specks (shards, hexagon dots), e.g. at ${where(shards[0].box)}`, "Foam, sparkle and pebbles are not confetti: draw foam as one torn band that wraps the rock at the waterline, or leave the specks out.", shards);

  // Dash texture: many tiny thin marks, or one dashed stroke.
  if (shapes.some((s) => s.stroke && /stroke-dasharray\s*[=:]\s*["']?\s*[\d.]/i.test(s.raw))) add("dashes", "a dashed stroke used as texture or a line", "Drop the dashes. Draw the thing as filled shapes; the finish adds grain.", shapes.filter((s) => /stroke-dasharray/i.test(s.raw)));
  // Rail posts and balusters are boxes, not dashes.
  const dashes = shapes.filter((s) => { const a = area(s.box); const w = s.box.w * kx, h = s.box.h * ky; return a < 0.0004 * A && Math.max(w, h) / Math.max(1, Math.min(w, h)) >= 4 && !(s.tag === "rect" || isRect(s)); });
  if (dashes.length >= 8) add("dashes", `${dashes.length} short thin marks used as texture`, "Drop the dashes. Texture comes from a few larger tone shapes; the finish adds grain.", dashes);

  // Flat object: one big object with a single color.
  const objs = shapes.filter((s) => s.fill && !field(s.box));
  const objArea = objs.filter((s) => !s.soft).reduce((m, s) => Math.max(m, area(s.box)), 0);
  const fills = new Set(objs.map((s) => s.fill));
  const grad = objs.some((s) => /url\(/.test(s.fill));
  const biggest = objs.filter((s) => !s.soft).sort((p, q) => area(q.box) - area(p.box))[0];
  if (objArea >= 0.02 * A && fills.size < 3 && !grad) add("flat", `the object is only ${fills.size} flat color${fills.size === 1 ? "" : "s"}`, "Give it a lit side, a mid tone and a shadow side as separate shapes that follow its form, plus a darker contact shadow where it meets what it stands on.", biggest ? [biggest] : []);

  // Hard-sided light: a see-through linear gradient (a reflection column,
  // a light wedge on the water) fades along one axis only, so its sides
  // stay cut sharp. Radial glows and blurred shapes fade on every side.
  const wedges = shapes.filter((s) => s.fill && s.linearFade && !s.blurred && !field(s.box) && area(s.box) >= 0.006 * A);
  if (wedges.length) add("light-wedge", `a see-through gradient shape with hard sides at ${where(wedges[0].box)} (a light column or wedge)`, "A gradient only fades one way, so the sides stay cut. Leave the light on the water to JDraw's light pass, or draw it as several broken glints of different lengths.", wedges);

  // A row of pills: three or more small, wide, similar blobs of nearly one
  // color strung along a line (surf as beige pills, stamped clouds, stones).
  if (!/\b(sea|water|ocean|lake|bay|waves?|swells?)\b/i.test(opts.name || "")) {
    const pills = filled.filter((s) => !field(s.box) && s.closed && !(s.tag === "rect" || isRect(s)) && area(s.box) < 0.01 * A && area(s.box) >= 0.0004 * A && s.box.w >= 1.8 * s.box.h && labOf(s.fill));
    for (const p of pills) {
      const lp = labOf(p.fill);
      const like = pills.filter((o) => { const lo = labOf(o.fill); return Math.hypot(lo[0] - lp[0], lo[1] - lp[1], lo[2] - lp[2]) < 0.1 && o.box.h <= 1.6 * p.box.h && p.box.h <= 1.6 * o.box.h && Math.abs((o.box.y + o.box.h / 2) - (p.box.y + p.box.h / 2)) * ky < Math.max(0.06 * H, 3 * p.box.h * ky); });
      // Separate pieces, side by side.
      const apart = like.filter((o, k) => !like.some((q, j) => j < k && hits(o, q)));
      if (apart.length >= 3) { add("pill-row", `${apart.length} similar small blobs in a row, e.g. at ${where(apart[0].box)} (surf or stones as pills)`, "Surf, foam and stones are not a string of pills: draw foam as one torn band that wraps the rock at the waterline, broken in places, with different widths; stones as a few clumps of different sizes and shapes.", apart); break; }
    }
  }

  // A floating shadow: a dark see-through wide blob that touches nothing in
  // the object (a shadow ellipse under a boat, hanging in the water).
  {
    const dark = filled.filter((s) => { const lab = labOf(s.fill); return lab && lab[0] < 0.4 && (s.alpha < 0.9 || lab[0] < 0.22) && s.curves >= 0.5 * s.segs.length && s.box.w >= 2.2 * s.box.h && !field(s.box) && area(s.box) >= 0.0008 * A; });
    const ov = (p, o) => Math.max(0, Math.min(p.box.x + p.box.w, o.box.x + o.box.w) - Math.max(p.box.x, o.box.x)) * Math.max(0, Math.min(p.box.y + p.box.h, o.box.y + o.box.h) - Math.max(p.box.y, o.box.y));
    const floating = dark.filter((p) => !filled.some((o) => o !== p && !field(o.box) && !dark.includes(o) && ov(p, o) >= 0.1 * p.box.w * p.box.h));
    if (floating.length) add("floating-shadow", `a dark blob at ${where(floating[0].box)} touches nothing (a shadow floating below the object)`, "A shadow or reflection starts where the object meets the surface: join it to the waterline or base, break it into a few uneven pieces, or leave it out.", floating);
  }

  // Soft rock: a rock or cliff built only from smooth curves, with no hard
  // corners anywhere, reads as a blob with patches, not stone.
  if (/\b(rocks?|rocky|cliffs?|crags?|stones?|boulders?|bluffs?|headland|outcrop)\b/i.test(opts.name || "") && !/\b(surf|foam|spray|waves?|shadows?|moss|glow|light|reflections?|mist)\b/i.test(opts.name || "")) {
    {
      // The body counts too: a rock of three poured planes is still poured.
      const inner = filled.filter((s) => s.closed && !field(s.box)).sort((a, b) => area(b.box) - area(a.box));
      const poured = inner.filter((s) => area(s.box) >= 0.008 * A && s.segs.length <= 12 && s.curves >= 0.6 * s.segs.length);
      if (poured.length >= 3) add("poured-planes", `${poured.length} of the rock's planes are big smooth curves, e.g. at ${where(poured[0].box)} (poured scoops, not broken faces)`, "Rock faces break: build each plane as a facet with six or more hard corners and an uneven, chipped edge, different sizes, meeting at angles; keep curves for weathered tops only.", poured);
    }
    const big = filled.filter((s) => !field(s.box) && s.closed && area(s.box) >= 0.002 * A);
    // Corners on the SVG's own border (where a shape runs off the canvas) do not count.
    const onEdge = (p) => Math.abs(p[0] - vb.x) < 0.01 * vb.w || Math.abs(p[0] - vb.x - vb.w) < 0.01 * vb.w || Math.abs(p[1] - vb.y) < 0.01 * vb.h || Math.abs(p[1] - vb.y - vb.h) < 0.01 * vb.h || p[0] > vb.x + vb.w || p[1] > vb.y + vb.h;
    let corners = 0, soft = 0;
    for (const s of big) {
      const g = s.segs.filter((q) => Math.hypot(q.b[0] - q.a[0], q.b[1] - q.a[1]) > 1e-6);
      let c = 0;
      for (let k = 0; k < g.length; k++) {
        const t1 = ends(g[k])[1], t0 = ends(g[(k + 1) % g.length])[0];
        if (Math.abs(norm(t0 - t1)) > 0.6 && !onEdge(g[k].b)) c++;
      }
      corners += c;
      // A plane with two corners or fewer is a poured sliver or blob.
      if (c <= 2) soft++;
    }
    if (process.env.LINT_DEBUG) console.log("soft-rock", opts.name, corners, soft, big.length);
    if (big.length && (corners < 2.5 * big.length || soft > 0.5 * big.length)) add("soft-rock", `${opts.name} is drawn with soft curves only (${corners} hard corners across ${big.length} shapes): a blob with patches, not stone`, "Stone breaks: give the silhouette and every plane hard corners where faces meet (ledges, chipped edges, cracks), mixed with a few curved runs; planes are cut, not poured.", big.slice().sort((p, q) => area(q.box) - area(p.box)).slice(0, 1));
  }

  // Candy stripes: two or more bands of one color across an object, of
  // the same height, with straight edges across a round form.
  {
    const ob = objs.length ? bboxOf(objs.flatMap((s) => [[s.box.x, s.box.y], [s.box.x + s.box.w, s.box.y + s.box.h]])) : null;
    const byTone = new Map();
    for (const s of filled) {
      if (!ob || field(s.box) || !s.closed) continue;
      const lab = labOf(s.fill);
      if (!lab) continue;
      if (s.box.h > 0.25 * ob.h || s.box.w < 1.2 * s.box.h) continue;
      // Wide for the object at that height: its own width against the widest shape around it.
      const around = filled.filter((o) => o !== s && !field(o.box) && o.box.y <= s.box.y && o.box.y + o.box.h >= s.box.y + s.box.h);
      const across = around.length ? Math.max(...around.map((o) => o.box.w)) : ob.w;
      if (s.box.w < 0.8 * across) continue;
      const key = [...byTone.keys()].find((k) => Math.hypot(k[0] - lab[0], k[1] - lab[1], k[2] - lab[2]) < 0.04) || lab;
      if (!byTone.has(key)) byTone.set(key, []);
      byTone.get(key).push(s);
    }
    // Bands of any color stacked across the object, all one height (red,
    // white, red...): candy stripes too.
    {
      const all = [...byTone.values()].flat().sort((p, q) => p.box.y - q.box.y);
      const rows = all.filter((b, k) => !all.some((o, j) => j < k && Math.abs(o.box.y - b.box.y) < 0.3 * b.box.h));
      if (rows.length >= 3 && byTone.size >= 2) {
        const hs = rows.map((b) => b.box.h), m = hs.reduce((a, b) => a + b, 0) / hs.length;
        const cv = Math.sqrt(hs.reduce((a, b) => a + (b - m) * (b - m), 0) / hs.length) / (m || 1);
        const touching = rows.every((b, k) => k === 0 || b.box.y <= rows[k - 1].box.y + rows[k - 1].box.h * 1.15);
        if (cv < 0.15 && touching) add("even-stripes", `${rows.length} stacked bands in alternating colors, all about ${Math.round(m * ky)}px tall, across the object at ${where(rows[0].box)} (candy stripes)`, "Painted bands are not stencils: give each band a different height, curve its top and bottom edges with the form's roundness (they dip at the sides of a tower), and let weather, shadow and light break them.", rows);
      }
    }
    for (const bands of byTone.values()) {
      const rows = bands.filter((b, k) => !bands.some((o, j) => j < k && Math.abs(o.box.y - b.box.y) < 0.3 * b.box.h));
      if (rows.length < 2) continue;
      const hs = rows.map((b) => b.box.h), m = hs.reduce((a, b) => a + b, 0) / hs.length;
      const cv = Math.sqrt(hs.reduce((a, b) => a + (b - m) * (b - m), 0) / hs.length) / (m || 1);
      if (cv < 0.12) {
        add("even-stripes", `${rows.length} bands of one color, all ${Math.round(m * ky)}px tall, across the object at ${where(rows[0].box)} (candy stripes)`, "Painted bands are not stencils: give each band a different height, curve its top and bottom edges with the form's roundness (they dip at the sides of a tower), and let weather, shadow and light break them.", rows);
        break;
      }
    }
  }

  // Lens clouds: by silhouette, whatever it is made of. All the cloud's
  // shapes are laid on one grid; a wide cloud whose underside is one smooth
  // run (flat or a single arc), or whose top is a row of even scallops, is
  // the stock cloud.
  if (/\b(clouds?|cloudbank)\b/i.test(opts.name || "")) {
    // Each cloud on its own: shapes whose boxes overlap form one cloud.
    // A blur softens the edge but keeps the silhouette, so blurred shapes that
    // are mostly opaque count too (a stock cloud with a blur filter is still stock).
    const cAll = shapes.filter((s) => s.fill && !s.fade && (!s.soft || s.alpha >= 0.6) && !field(s.box) && s.closed && s.pts.length >= 3);
    const groups = [];
    for (const s of cAll) {
      const touching = groups.filter((g) => g.some((o) => hits(s, o)));
      const merged = [s].concat(...touching);
      for (const g of touching) groups.splice(groups.indexOf(g), 1);
      groups.push(merged);
    }
    {
      const boxes = groups.map((g) => Object.assign(bboxOf(g.flatMap((s) => [[s.box.x, s.box.y], [s.box.x + s.box.w, s.box.y + s.box.h]])), { g })).filter((u) => u.w * kx >= 0.04 * W);
      const theirs = (opts.otherClouds || []).map((o) => ({ x: vb.x + (o.x - opts.x) / kx, y: vb.y + (o.y - opts.y) / ky, w: o.w / kx, h: o.h / ky, g: [] })).filter((u) => u.w * kx >= 0.04 * W);
      for (const u of boxes) {
        const row = boxes.concat(theirs).filter((o) => Math.abs((o.y + o.h) - (u.y + u.h)) * ky < 0.04 * H);
        if (row.length >= 3) {
          add("cloud-row", `${row.length} clouds in a level row, their bases lined up at y ${Math.round(opts.y + (u.y + u.h - vb.y) * ky)}`, "Clouds are not set out on a shelf: vary their heights and sizes a lot, overlap some, let one be much bigger and nearer, and let others be thin streaks or broken wisps.", row.flatMap((o) => o.g));
          break;
        }
      }
    }
    for (const cs of groups) {
    if (cs.length) {
      const ub = bboxOf(cs.flatMap((s) => [[s.box.x, s.box.y], [s.box.x + s.box.w, s.box.y + s.box.h]]));
      if (!(ub.w > 0.5 && ub.h > 0.5)) continue;
      const cols = 120, cw = ub.w / cols;
      const topY = new Array(cols).fill(Infinity), botY = new Array(cols).fill(-Infinity);
      const polys = cs.map((s) => outlineOf(s));
      const rows = Math.max(10, Math.round(ub.h / cw));
      const ch = ub.h / rows;
      for (let i = 0; i < cols; i++) {
        const x = ub.x + (i + 0.5) * cw;
        for (let j = 0; j < rows; j++) {
          const y = ub.y + (j + 0.5) * ch;
          if (polys.some((P) => inPoly(P, x, y))) { if (y < topY[i]) topY[i] = y; if (y > botY[i]) botY[i] = y; }
        }
      }
      const idx = [...topY.keys()].filter((i) => Number.isFinite(topY[i]));
      const wPx = ub.w * kx, hPx = ub.h * ky;
      if (idx.length >= 30 && wPx >= 0.04 * W) {
        // Underside: residual of a parabola through the middle 80%.
        const mid = idx.filter((i) => i >= idx[0] + 0.1 * idx.length && i <= idx[idx.length - 1] - 0.1 * idx.length);
        const fit = (xs, ys) => {
          // least squares y = a + b x + c x^2
          const n = xs.length; let s = [0, 0, 0, 0, 0], t = [0, 0, 0];
          for (let k = 0; k < n; k++) { const x = xs[k], y = ys[k]; s[0]++; s[1] += x; s[2] += x * x; s[3] += x * x * x; s[4] += x * x * x * x; t[0] += y; t[1] += x * y; t[2] += x * x * y; }
          const M = [[s[0], s[1], s[2], t[0]], [s[1], s[2], s[3], t[1]], [s[2], s[3], s[4], t[2]]];
          for (let c = 0; c < 3; c++) { let p = c; for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r; [M[c], M[p]] = [M[p], M[c]]; for (let r = 0; r < 3; r++) if (r !== c) { const f = M[r][c] / (M[c][c] || 1e-9); for (let k = c; k < 4; k++) M[r][k] -= f * M[c][k]; } }
          const co = M.map((r, k) => r[3] / (r[k] || 1e-9));
          return Math.sqrt(xs.reduce((a, x, k) => { const e = ys[k] - (co[0] + co[1] * x + co[2] * x * x); return a + e * e; }, 0) / n);
        };
        const xs = mid.map((i) => i / cols), under = fit(xs, mid.map((i) => (botY[i] - ub.y) / ub.w));
        let smoothUnder = wPx >= 3 * hPx && under < 0.008;
        // Top: peaks (local highest points) of a lightly smoothed profile.
        const sm = idx.map((i, k) => { const a = topY[idx[Math.max(0, k - 1)]], b = topY[i], c = topY[idx[Math.min(idx.length - 1, k + 1)]]; return (a + 2 * b + c) / 4; });
        const peaks = [];
        for (let k = 2; k < sm.length - 2; k++) if (sm[k] < sm[k - 1] && sm[k] <= sm[k + 1] && sm[k] < sm[k - 2] && sm[k] <= sm[k + 2]) peaks.push(k);
        const gaps = peaks.slice(1).map((p, k) => p - peaks[k]);
        const cvOf = (v) => { const m = v.reduce((a, b) => a + b, 0) / v.length; return Math.sqrt(v.reduce((a, b) => a + (b - m) * (b - m), 0) / v.length) / (m || 1); };
        const evenTop = peaks.length >= 5 && cvOf(gaps) < 0.3;
        const clipArt = !smoothUnder && peaks.length >= 3 && wPx >= 1.8 * hPx && under < 0.012;
        if (clipArt) smoothUnder = true;
        if (process.env.LINT_DEBUG) console.log("cloud", opts.name, { under: +under.toFixed(4), aspect: +(wPx / hPx).toFixed(1), peaks: peaks.length, gapCv: gaps.length ? +cvOf(gaps).toFixed(2) : null });
        // A cut-out cloud: a few flat opaque pieces with no soft or
        // see-through part, read as a sticker however its edge runs.
        const pieces = cs.filter((s) => area(s.box) >= 0.0005 * A);
        const inCloud = (s) => s.box.x >= ub.x - 0.1 * ub.w && s.box.x + s.box.w <= ub.x + 1.1 * ub.w && s.box.y >= ub.y - 0.2 * ub.h && s.box.y + s.box.h <= ub.y + 1.2 * ub.h;
        const softArea = shapes.filter((s) => s.fill && inCloud(s) && (s.soft || s.alpha < 0.85 || /url\(/.test(s.fill))).reduce((n, s) => n + area(s.box), 0);
        const softPart = softArea >= 0.15 * area(ub);
        if (!smoothUnder && !evenTop && pieces.length <= 4 && !softPart) add("lens-cloud", `the cloud at ${where(ub)} is ${pieces.length} flat opaque cut-out piece${pieces.length === 1 ? "" : "s"} with nothing soft or see-through (a sticker cloud)`, "Paint a cloud as many overlapping pieces: a few see-through veils and soft edges, darker pockets under the heads, a lit rim facing the light, and torn wisps at the ends.", cs);
        if (smoothUnder || evenTop) add("lens-cloud", `the cloud at ${where(ub)} is the stock cloud: ${smoothUnder ? (clipArt ? "a lumpy top over one smooth, flat underside (the clip-art cumulus)" : "a wide shape with one smooth, flat underside") : ""}${smoothUnder && evenTop ? " and " : ""}${evenTop ? `a top of ${peaks.length} evenly spaced scallops` : ""}`, "Real clouds are clumps of different sizes: break the underside into a few uneven lumps and shadowed pockets, give the top big and small heads at uneven spacing, and let parts tear off or overlap.", cs);
      }
    }
    }
  }

  // Flat mass: a big object where one shape is most of what shows (a cliff
  // as one smooth slab with a few planes laid on it). The object is
  // rasterized coarsely, each cell keeping the topmost shape, and the
  // largest single shape's share of the object is measured.
  const solid = filled.filter((s) => !field(s.box) && s.closed && s.pts.length >= 3);
  if (solid.length) {
    const cell = W / 160;
    const toC = (p) => [opts.x + (p[0] - vb.x) * kx, opts.y + (p[1] - vb.y) * ky];
    const top = new Map(); // cell -> shape index
    solid.forEach((s, si) => {
      const P = outlineOf(s).map(toC);
      const b = bboxOf(P);
      for (let cy = Math.max(0, Math.floor(b.y / cell)); cy < Math.min(Math.ceil(H / cell), Math.ceil((b.y + b.h) / cell)); cy++) {
        const y = (cy + 0.5) * cell;
        for (let cx = Math.max(0, Math.floor(b.x / cell)); cx < Math.min(160, Math.ceil((b.x + b.w) / cell)); cx++) {
          if (inPoly(P, (cx + 0.5) * cell, y)) top.set(cy * 1000 + cx, si);
        }
      }
    });
    const total = top.size * cell * cell;
    if (total >= 0.06 * A) {
      // Shapes of nearly the same color are one tone area on screen, however
      // many pieces they are cut into.
      const tones = []; // { lab, n, shapes:Map(si -> n) }
      const toneOfShape = solid.map((s) => {
        const lab = labOf(s.fill);
        let t = lab && tones.find((o) => o.lab && Math.hypot(o.lab[0] - lab[0], o.lab[1] - lab[1], o.lab[2] - lab[2]) < 0.05);
        if (!t) { t = { lab, n: 0, shapes: new Map() }; tones.push(t); }
        return t;
      });
      for (const si of top.values()) { const t = toneOfShape[si]; t.n++; t.shapes.set(si, (t.shapes.get(si) || 0) + 1); }
      const used = tones.filter((t) => t.n);
      const big = used.sort((a, b) => b.n - a.n)[0];
      const share = big.n / top.size;
      const shownT = used.filter((t) => t.n / top.size >= 0.03);
      const shown = shownT.length;
      const Ls = shownT.filter((t) => t.lab).map((t) => t.lab[0]);
      const spread = Ls.length >= 2 ? Math.max(...Ls) - Math.min(...Ls) : 0;
      const bigIdx = [...big.shapes.entries()].sort((a, b) => b[1] - a[1])[0][0];
      if (process.env.LINT_DEBUG) console.log("flat-mass", opts.name, share.toFixed(2), shown, spread.toFixed(3), (total / A).toFixed(3));
      const limit = total >= 0.22 * A ? 0.3 : total >= 0.15 * A ? 0.35 : 0.45; // the bigger the mass, the less of it may be one flat area
      // A mass that covers a fifth of the frame or more carries the picture:
      // it needs many tone areas and a real range of value, not four patches.
      const huge = total >= 0.22 * A;
      if (share > limit || shown < (huge ? 5 : 4) || (Ls.length >= 2 && spread < (huge ? 0.14 : 0.12))) add("flat-mass", `${Math.round(share * 100)}% of the object (${where(solid[bigIdx].box)}) is one flat tone${shown < (huge ? 5 : 4) ? `, with only ${shown} tone areas showing` : ""}${Ls.length >= 2 && spread < (huge ? 0.14 : 0.12) ? `; its lightest and darkest areas are nearly the same value` : ""}`, /\b(sea|water|ocean|lake|bay|river|pond|waves?|surf|foam)\b/i.test(opts.name || "") ? "Water needs structure across all of it: long curved swells of different widths that run across the view, larger and darker toward the front, lighter where they face the sky, broken by light only under the light source; never flat bands or rock planes." : "A big mass needs structure across all of it: split it into several lit, mid and shadow planes of clearly different value (the lit plane much lighter than the shadow side) and different sizes that follow the form (ledges, cracks, a top plane facing the light), so no single tone covers more than a third of it.", [solid[bigIdx]]);
    }
  }

  return { problems, stats: { shapes: shapes.length, filled: filled.length, colors: fills.size } };
}

// Last-try repair for outlines the drawer could not fix: a sawtooth or a
// faceted cloud is rebuilt by JDraw as a smooth curved outline through the
// same shape, with the teeth taken out (Douglas-Peucker) and curves of
// uneven tension so it never becomes a row of equal bumps.
function simplify(pts, tol) {
  if (pts.length < 4) return pts;
  const dev = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy); return l ? Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / l : Math.hypot(p[0] - a[0], p[1] - a[1]); };
  const keep = new Array(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    let best = -1, at = -1;
    for (let k = i + 1; k < j; k++) { const d = dev(pts[k], pts[i], pts[j]); if (d > best) { best = d; at = k; } }
    if (best > tol) { keep[at] = true; stack.push([i, at], [at, j]); }
  }
  return pts.filter((_, k) => keep[k]);
}
function smoothClosed(P, seed) {
  const n = P.length, f = (v) => +v.toFixed(1);
  let d = `M${f(P[0][0])},${f(P[0][1])}`;
  for (let i = 0; i < n; i++) {
    const p0 = P[(i + n - 1) % n], p1 = P[i], p2 = P[(i + 1) % n], p3 = P[(i + 2) % n];
    // Tension from 0.7 to 1.3, different on every segment.
    const t = 0.7 + 0.6 * ((((Math.sin((i + 1) * 12.9898 + seed * 78.233) * 43758.5453) % 1) + 1) % 1);
    const c1 = [p1[0] + ((p2[0] - p0[0]) / 6) * t, p1[1] + ((p2[1] - p0[1]) / 6) * t];
    const c2 = [p2[0] - ((p3[0] - p1[0]) / 6) * t, p2[1] - ((p3[1] - p1[1]) / 6) * t];
    d += ` C${f(c1[0])},${f(c1[1])} ${f(c2[0])},${f(c2[1])} ${f(p2[0])},${f(p2[1])}`;
  }
  return d + " Z";
}
function repairOutlines(svg, els, mode) {
  let out = String(svg), fixed = 0;
  for (const raw of new Set(els || [])) {
    if (!out.includes(raw)) continue;
    const tag = ((raw.match(/^<([a-z]+)/i) || [])[1] || "").toLowerCase();
    const a = attrs(raw);
    let subs;
    if (tag === "path") subs = parsePath(a.d);
    else if (tag === "polygon" && /\/>$/.test(raw)) {
      const n = (a.points || "").match(NUM) || [];
      const pts = [];
      for (let k = 0; k + 1 < n.length; k += 2) pts.push([+n[k], +n[k + 1]]);
      subs = [{ pts, closed: true }];
    } else continue;
    if (!subs.length || !subs.every((sp) => sp.closed)) continue;
    const parts = [];
    if (mode === "ruler") {
      if (!subs.every((sp) => (sp.segs || []).every((q) => q.kind === "L"))) continue;
      const all = subs.flatMap((sp) => sp.pts), bb = bboxOf(all), diag = Math.hypot(bb.w, bb.h) || 1;
      const rnd = rngOf(hashStr(raw));
      for (const sp of subs) {
        const P = [];
        for (const q of sp.segs) {
          P.push(q.a);
          if (Math.hypot(q.b[0] - q.a[0], q.b[1] - q.a[1]) >= 0.08 * diag) P.push(...walkEdge(q.a, q.b, diag, rnd, 0.02));
        }
        if (!sp.closed) P.push(sp.segs[sp.segs.length - 1].b);
        parts.push("M" + P.map((p) => fx(p[0]) + "," + fx(p[1])).join(" L") + (sp.closed ? " Z" : ""));
      }
      const d = parts.join(" ");
      const rest = raw.replace(/^<[a-z]+/i, "").replace(/\s(d|points)\s*=\s*("[^"]*"|'[^']*')/gi, "");
      const next = "<path" + (/\/>$/.test(raw) ? rest.replace(/\s*\/>$/, "") : rest.replace(/\s*>$/, "")) + ` d="${d}"` + (/\/>$/.test(raw) ? "/>" : ">");
      out = out.split(raw).join(next);
      fixed++;
      continue;
    }
    for (const [si, sp] of subs.entries()) {
      const curved = (sp.segs || []).filter((q) => q.kind === "C" && (q.ctrl || []).length).length;
      if (mode === "zigzag" && sp.segs && curved >= sp.segs.length / 2) {
        // A row of same-size bumps keeps its bumps, made uneven: each bump's
        // height scaled differently, and now and then two bumps merged.
        const rnd = (k) => ((Math.sin(k * 91.345) * 43758.5453) % 1 + 1) % 1;
        // Keyed by where a segment is, so layers that share an edge change it the same way.
        const key = (q) => Math.round(q.a[0]) * 0.731 + Math.round(q.a[1]) * 1.917 + Math.round(q.b[0]) * 2.389 + Math.round(q.b[1]) * 0.613;
        const f = (v) => +v.toFixed(1);
        const cub = (q) => { const c = q.ctrl || []; if (q.kind !== "C" || !c.length) return [q.a, q.b]; if (c.length >= 2 && !q.arc) return [c[0], c[1]]; const m = c[0]; const ox = (4 / 3) * (m[0] - (q.a[0] + q.b[0]) / 2), oy = (4 / 3) * (m[1] - (q.a[1] + q.b[1]) / 2); return q.arc ? [[q.a[0] + ox, q.a[1] + oy], [q.b[0] + ox, q.b[1] + oy]] : [[q.a[0] + (2 / 3) * (m[0] - q.a[0]), q.a[1] + (2 / 3) * (m[1] - q.a[1])], [q.b[0] + (2 / 3) * (m[0] - q.b[0]), q.b[1] + (2 / 3) * (m[1] - q.b[1])]]; };
        let d = `M${f(sp.segs[0].a[0])},${f(sp.segs[0].a[1])}`;
        for (let k = 0; k < sp.segs.length; k++) {
          let q = sp.segs[k], [c1, c2] = cub(q), end = q.b;
          if (k + 1 < sp.segs.length && rnd(key(q) * 3) < 0.3) { const q2 = sp.segs[k + 1]; c2 = cub(q2)[1]; end = q2.b; k++; }
          const s = 0.35 + 1.25 * rnd(key(q) * 7 + 1);
          const lerp = (c, base) => [base[0] + (c[0] - base[0]) * s, base[1] + (c[1] - base[1]) * s];
          // Scale the handles' reach off the chord, not along it.
          const a0 = q.a, mid = (t) => [a0[0] + (end[0] - a0[0]) * t, a0[1] + (end[1] - a0[1]) * t];
          const n1 = lerp(c1, mid(1 / 3)), n2 = lerp(c2, mid(2 / 3));
          d += ` C${f(n1[0])},${f(n1[1])} ${f(n2[0])},${f(n2[1])} ${f(end[0])},${f(end[1])}`;
        }
        parts.push(d + " Z");
        continue;
      }
      let pts = uniq(sp.pts);
      const b = bboxOf(pts), diag = Math.hypot(b.w, b.h) || 1;
      // Faceted (a cloud): keep the shape, just round it.
      // Sawtooth (a rock): take the teeth out, then break the long runs at
      // uneven places by uneven amounts, so the edge wanders instead.
      let simple = simplify(pts.concat([pts[0]]), (mode === "zigzag" ? 0.015 : 0.006) * diag).slice(0, -1);
      if (simple.length < 6) simple = simplify(pts.concat([pts[0]]), 0.004 * diag).slice(0, -1);
      if (simple.length < 4) simple = pts;
      if (mode !== "zigzag") { parts.push(smoothClosed(simple, si + raw.length)); continue; }
      const rnd = (k) => ((Math.sin(k * 12.9898 + raw.length * 0.0137) * 43758.5453) % 1 + 1) % 1;
      const P = [];
      for (let k = 0; k < simple.length; k++) {
        const p = simple[k], q = simple[(k + 1) % simple.length];
        P.push(p);
        const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
        // About one break per 5% of the shape's size, at uneven spacing.
        const cuts = Math.min(8, Math.floor(len / (0.05 * diag)));
        let t = 0, side = rnd(k * 11) < 0.5 ? -1 : 1;
        for (let c = 1; c <= cuts; c++) {
          t += (0.3 + 1.4 * rnd(k * 7 + c)) / (cuts + 1);
          if (t >= 0.97) break;
          // The edge drifts to one side and only now and then crosses over.
          if (rnd(k * 5 + c) < 0.3) side = -side;
          const amp = (0.003 + 0.009 * rnd(k * 13 + c * 3)) * diag * side;
          P.push([p[0] + (q[0] - p[0]) * t - ((q[1] - p[1]) / len) * amp, p[1] + (q[1] - p[1]) * t + ((q[0] - p[0]) / len) * amp]);
        }
      }
      const f = (v) => +v.toFixed(1);
      parts.push("M" + P.map((p) => `${f(p[0])},${f(p[1])}`).join(" L") + " Z");
    }
    const d = parts.join(" ");
    const rest = raw.replace(/^<[a-z]+/i, "").replace(/\s(d|points)\s*=\s*("[^"]*"|'[^']*')/gi, "");
    const next = "<path" + (/\/>$/.test(raw) ? rest.replace(/\s*\/>$/, "") : rest.replace(/\s*>$/, "")) + ` d="${d}"` + (/\/>$/.test(raw) ? "/>" : ">");
    out = out.split(raw).join(next);
    fixed++;
  }
  return { svg: out, fixed };
}

// Last try for a mirrored outline: one side of it (and of everything drawn
// inside it) leans and bulges a little, so the two sides stop matching.
function unmirror(svg, els) {
  let out = String(svg), fixed = 0;
  const subsOf = (raw) => {
    const tag = ((raw.match(/^<([a-z]+)/i) || [])[1] || "").toLowerCase();
    const a = attrs(raw);
    if (tag === "path") return parsePath(a.d);
    if (tag === "polygon" || tag === "polyline") {
      const n = (a.points || "").match(NUM) || [], pts = [];
      for (let k = 0; k + 1 < n.length; k += 2) pts.push([+n[k], +n[k + 1]]);
      if (pts.length < 2) return [];
      const segs = pts.slice(1).map((p, k) => ({ kind: "L", a: pts[k], b: p }));
      if (tag === "polygon") segs.push({ kind: "L", a: pts[pts.length - 1], b: pts[0] });
      return [{ pts, segs, closed: tag === "polygon" }];
    }
    if (tag === "rect") {
      const x = +a.x || 0, y = +a.y || 0, w = +a.width || 0, h = +a.height || 0;
      if (!w || !h) return [];
      const pts = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
      return [{ pts, segs: pts.map((p, k) => ({ kind: "L", a: p, b: pts[(k + 1) % 4] })), closed: true }];
    }
    return [];
  };
  const dOf = (subs, wp) => subs.map((sp) => {
    const s0 = wp(sp.pts[0]);
    let d = `M${fx(s0[0])},${fx(s0[1])}`;
    for (const q of sp.segs) {
      const B = wp(q.b), c = q.ctrl || [];
      if (q.kind === "C" && c.length >= 2 && !q.arc) { const c1 = wp(c[0]), c2 = wp(c[1]); d += ` C${fx(c1[0])},${fx(c1[1])} ${fx(c2[0])},${fx(c2[1])} ${fx(B[0])},${fx(B[1])}`; }
      else if (q.kind === "C" && c.length === 1) {
        // An arc stores its bulge (on the curve); a quadratic's handle sits twice as far off.
        const k = q.arc ? [2 * c[0][0] - (q.a[0] + q.b[0]) / 2, 2 * c[0][1] - (q.a[1] + q.b[1]) / 2] : c[0];
        const K = wp(k);
        d += ` Q${fx(K[0])},${fx(K[1])} ${fx(B[0])},${fx(B[1])}`;
      } else d += ` L${fx(B[0])},${fx(B[1])}`;
    }
    return d + (sp.closed ? " Z" : "");
  }).join(" ");
  const rewrite = (raw, wp) => {
    const subs = subsOf(raw);
    if (!subs.length) return null;
    const rest = raw.replace(/^<[a-z]+/i, "").replace(/\s(d|points|x|y|width|height|rx|ry)\s*=\s*("[^"]*"|'[^']*')/gi, "");
    const self = /\/>$/.test(raw);
    return "<path" + (self ? rest.replace(/\s*\/>$/, "") : rest.replace(/\s*>$/, "")) + ` d="${dOf(subs, wp)}"` + (self ? "/>" : ">");
  };
  for (const raw of new Set(els || [])) {
    if (!out.includes(raw) || /\stransform\s*=/i.test(raw)) continue;
    const subs = subsOf(raw);
    if (!subs.length) continue;
    const b = bboxOf(subs.flatMap((sp) => sp.pts));
    if (!b.w || !b.h) continue;
    const rnd = rngOf(hashStr(raw));
    const axis = b.x + b.w / 2, half = b.w / 2, side = rnd() < 0.5 ? -1 : 1;
    const amp = (0.05 + 0.025 * rnd()) * b.w, ph = rnd() * Math.PI * 2, fr = 2 + 1.5 * rnd(), lean = (0.015 + 0.02 * rnd()) * b.w * (rnd() < 0.5 ? -1 : 1);
    const wp = ([x, y]) => {
      const u = ((x - axis) / half) * side;
      if (u <= 0) return [x, y];
      const t = (y - b.y) / b.h;
      return [x + side * Math.min(1.2, u) * (amp * Math.sin(ph + fr * Math.PI * t) * Math.sin(Math.PI * Math.min(1, Math.max(0, t))) + lean * t), y];
    };
    const next = rewrite(raw, wp);
    if (!next) continue;
    // What is drawn inside the outline moves with it: bands, windows, doors.
    const pad = 0.03 * Math.max(b.w, b.h);
    const inner = (out.match(/<(path|polygon|polyline|rect)\b[^>]*>/gi) || []).filter((r) => r !== raw && !/\stransform\s*=/i.test(r)).filter((r) => {
      const ss = subsOf(r);
      if (!ss.length) return false;
      const ib = bboxOf(ss.flatMap((sp) => sp.pts));
      return ib.x >= b.x - pad && ib.y >= b.y - pad && ib.x + ib.w <= b.x + b.w + pad && ib.y + ib.h <= b.y + b.h + pad;
    });
    out = out.split(raw).join(next);
    for (const r of new Set(inner)) { const n2 = rewrite(r, wp); if (n2) out = out.split(r).join(n2); }
    fixed++;
  }
  return { svg: out, fixed };
}

// Last-try structure, so a flat shape cannot land flat. "detail": a plain
// rect/circle/ellipse or a few-point outline is redrawn as an uneven
// outline with many points ("lumps": the same, bigger, for clouds).
// "planes": a flat mass gets a shadow plane, a lit plane and two ledges cut
// from its own outline and aimed at the light. "horizon": a ruled field
// edge rises and dips. light: {x, y} in the SVG's coordinates, or null.
const hashStr = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const rngOf = (seed) => { let v = seed || 1; return () => { v = (Math.imul(v ^ (v >>> 15), 2246822507) + 0x9e3779b9) >>> 0; return v / 4294967296; }; };
const fx = (v) => +v.toFixed(1);
// A line that drifts to one side and only now and then crosses back.
function wander(a, b, size, rnd, ampK) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const n = Math.max(1, Math.min(14, Math.floor(len / (0.05 * size))));
  const out = [];
  let t = 0, side = rnd() < 0.5 ? -1 : 1;
  for (let k = 1; k <= n; k++) {
    t += (0.4 + 1.2 * rnd()) / (n + 1);
    if (t >= 0.96) break;
    if (rnd() < 0.3) side = -side;
    const amp = (0.3 + 0.7 * rnd()) * ampK * size * side;
    out.push([a[0] + (b[0] - a[0]) * t - ((b[1] - a[1]) / len) * amp, a[1] + (b[1] - a[1]) * t + ((b[0] - a[0]) / len) * amp]);
  }
  return out;
}
function rgbOfFill(fill) {
  const nm = NAMED[String(fill || "").trim().toLowerCase()];
  if (nm) fill = nm;
  const m = String(fill || "").trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (m) { const h = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1]; return [0, 2, 4].map((k) => parseInt(h.slice(k, k + 2), 16)); }
  const r = String(fill || "").match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  return r ? [+r[1], +r[2], +r[3]] : null;
}
// A cut edge that bends: a correlated walk, not a zigzag and not a ruler.
function walkEdge(a, b, size, rnd, ampK) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const n = Math.max(1, Math.min(16, Math.floor(len / (0.045 * size))));
  const out = [];
  let t = 0, walk = 0;
  for (let k = 1; k <= n; k++) {
    t += (0.4 + 1.2 * rnd()) / (n + 1);
    if (t >= 0.96) break;
    walk = 0.7 * walk + (rnd() * 2 - 1) * ampK * size * 0.6;
    const amp = walk * Math.sin(Math.PI * t);
    out.push([a[0] + (b[0] - a[0]) * t - ((b[1] - a[1]) / len) * amp, a[1] + (b[1] - a[1]) * t + ((b[0] - a[0]) / len) * amp]);
  }
  return out;
}
// The part of P where dot(p, n) <= c, its cut edges bending.
function bentCut(P, n, c, size, rnd) {
  const sd = (p) => p[0] * n[0] + p[1] * n[1] - c;
  const out = [];
  for (let k = 0; k < P.length; k++) {
    const a = P[k], b = P[(k + 1) % P.length], sa = sd(a), sb = sd(b);
    if (sa <= 0) out.push({ p: a, cut: false });
    if ((sa <= 0) !== (sb <= 0)) { const t = sa / (sa - sb); out.push({ p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], cut: true }); }
  }
  if (out.length < 3) return [];
  const R = [];
  for (let k = 0; k < out.length; k++) { const a = out[k], b = out[(k + 1) % out.length]; R.push(a.p); if (a.cut && b.cut && inPoly(P, (a.p[0] + b.p[0]) / 2, (a.p[1] + b.p[1]) / 2)) R.push(...walkEdge(a.p, b.p, size, rnd, 0.035)); }
  return R;
}
// An outline resampled to n even points, with inward normals.
function resampleOutline(P, n) {
  const L = [0];
  for (let k = 1; k <= P.length; k++) L.push(L[k - 1] + Math.hypot(P[k % P.length][0] - P[k - 1][0], P[k % P.length][1] - P[k - 1][1]));
  const tot = L[L.length - 1], Q = [];
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = (i / n) * tot;
    while (j < P.length - 1 && L[j + 1] < t) j++;
    const a = P[j], b = P[(j + 1) % P.length], u = (t - L[j]) / (L[j + 1] - L[j] || 1);
    Q.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]);
  }
  const N = Q.map((p, k) => { const a = Q[(k + n - 1) % n], b = Q[(k + 1) % n]; const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return [-dy / l, dx / l]; });
  const bb = bboxOf(Q), e = 0.01 * Math.max(bb.w, bb.h);
  let votes = 0;
  for (let k = 0; k < n; k += Math.max(1, Math.floor(n / 12))) votes += inPoly(Q, Q[k][0] + N[k][0] * e, Q[k][1] + N[k][1] * e) ? 1 : -1;
  return { Q, N: votes >= 0 ? N : N.map(([x, y]) => [-x, -y]) };
}
// A band hugging the outline where w(k) > 0; its inner edge is a broken line.
function rimBand(Q, N, w, depth, rnd) {
  const on = Q.map((_, k) => w(k) > 0.05);
  let best = [], cur = [];
  for (let k = 0; k < 2 * Q.length; k++) { const i = k % Q.length; if (on[i]) { cur.push(i); if (cur.length > best.length) best = cur.slice(); if (cur.length >= Q.length) break; } else cur = []; }
  if (best.length < 4) return null;
  const knots = [];
  for (let m = 0; m < best.length; m += 3 + Math.floor(rnd() * 5)) knots.push([m, depth * (0.45 + rnd())]);
  knots.push([best.length - 1, depth * 0.2]);
  knots[0][1] = depth * 0.2;
  const pts = [];
  for (let j = knots.length - 1; j >= 0; j--) {
    const [m, dd0] = knots[j], i = best[m];
    let dd = dd0 * Math.min(1, w(i) * 1.6);
    // never past the far side of a thin part
    while (dd > 1 && !inPoly(Q, Q[i][0] + N[i][0] * dd, Q[i][1] + N[i][1] * dd)) dd *= 0.6;
    pts.push([Q[i][0] + N[i][0] * dd, Q[i][1] + N[i][1] * dd]);
  }
  // Between knots the inner edge bends a little: no ruler runs.
  const inner = [];
  for (let j = 0; j < pts.length; j++) { inner.push(pts[j]); if (j + 1 < pts.length) inner.push(...walkEdge(pts[j], pts[j + 1], depth * 2, rnd, 0.05)); }
  return best.map((i) => Q[i]).concat(inner);
}
// A tapering crack that bends, 4-6 knots, both sides uneven.
function crackFrom(p, dir, len, wdt, rnd) {
  const n = 4 + Math.floor(rnd() * 3), L = [], Rr = [];
  let x = p[0], y = p[1], a = Math.atan2(dir[1], dir[0]);
  for (let k = 0; k <= n; k++) {
    const t = k / n, w = wdt * (1 - t) * (0.6 + 0.8 * rnd());
    const nx = -Math.sin(a), ny = Math.cos(a);
    L.push([x + nx * w, y + ny * w]);
    const w2 = w * (0.4 + 0.6 * rnd());
    Rr.push([x - nx * w2, y - ny * w2]);
    a += (rnd() - 0.5) * 0.9; x += (Math.cos(a) * len) / n; y += (Math.sin(a) * len) / n;
  }
  return L.concat(Rr.reverse().slice(1));
}
function planesFor(P, fill, toLight, seed, fills) {
  const rnd = rngOf(seed);
  const b = bboxOf(P), size = Math.max(b.w, b.h), step = size / 60;
  const S = [];
  for (let y = b.y + step / 2; y < b.y + b.h; y += step) for (let x = b.x + step / 2; x < b.x + b.w; x += step) if (inPoly(P, x, y)) S.push([x, y]);
  if (S.length < 20) return "";
  const q = (v, f) => { const s2 = v.slice().sort((x, y) => x - y); return s2[Math.min(s2.length - 1, Math.floor(f * s2.length))]; };
  const n = toLight;
  const base = rgbOfFill(fill) || [128, 120, 130];
  const hex = (v) => "#" + v.map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0")).join("");
  const mix = (t, to) => hex(base.map((x, k) => x + (to[k] - x) * t));
  // The darkest and lightest colors the object already uses, pushed a little
  // further, so the planes belong to its palette.
  const pal = (fills || []).map(rgbOfFill).filter(Boolean);
  const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const darkest = pal.length ? pal.reduce((a, c) => (lum(c) < lum(a) ? c : a)) : null;
  const lightest = pal.length ? pal.reduce((a, c) => (lum(c) > lum(a) ? c : a)) : null;
  const deep = darkest && lum(darkest) < lum(base) - 30 ? darkest.map((x) => x * 0.85) : base.map((x, k) => x * 0.38 + [6, 8, 14][k]);
  const bright = lightest && lum(lightest) > lum(base) + 30 ? lightest.map((x) => Math.min(255, x * 1.06)) : base.map((x, k) => x + (255 - x) * 0.55 + [10, 4, -8][k]);
  const d = (Q) => "M" + Q.map((p) => `${fx(p[0])},${fx(p[1])}`).join(" L") + " Z";
  const out = [];
  const rot = (v, a2) => [v[0] * Math.cos(a2) - v[1] * Math.sin(a2), v[0] * Math.sin(a2) + v[1] * Math.cos(a2)];
  // Cuts never lie flat: a level cut stacks the rock into strata.
  const tilt = (m) => {
    let a = Math.atan2(m[1], m[0]);
    const off = Math.abs(Math.abs(a) - Math.PI / 2);
    // away from straight up or down, on the side it already leans to
    if (off < 0.6) a += (Math.cos(a) >= 0 ? -1 : 1) * (Math.sign(a) || 1) * (0.6 - off);
    return [Math.cos(a), Math.sin(a)];
  };
  const cut = (m, f) => { m = tilt(m); return bentCut(P, m, q(S.map((p) => p[0] * m[0] + p[1] * m[1]), f), size, rnd); };
  const led = cut(rot(n, (rnd() < 0.5 ? -1 : 1) * (1.35 + 0.25 * rnd())), 0.6 + 0.12 * rnd());
  if (led.length >= 3) out.push(`<path data-jdraw-plane="ledge" fill="${mix(0.22, deep)}" d="${d(led)}"/>`);
  const sh = cut(rot(n, 0.5 + 0.3 * rnd()), 0.4);
  if (sh.length >= 3) out.push(`<path data-jdraw-plane="shade" fill="${mix(0.52, deep)}" d="${d(sh)}"/>`);
  const core = cut(rot(n, (rnd() < 0.5 ? -1 : 1) * (0.8 + 0.3 * rnd())), 0.16);
  if (core.length >= 3) out.push(`<path data-jdraw-plane="core" fill="${mix(0.72, deep)}" d="${d(core)}"/>`);
  const { Q, N } = resampleOutline(P, 90), small = Math.min(b.w, b.h);
  const facing = (k) => -(N[k][0] * n[0] + N[k][1] * n[1]);
  // No band on the base, or on an edge cut straight by the canvas border
  // (its own box side).
  const e = 0.006 * Math.max(b.w, b.h);
  const base0 = (k) => -N[k][1] > 0.75 || Math.abs(Q[k][0] - b.x) < e || Math.abs(Q[k][0] - b.x - b.w) < e || Math.abs(Q[k][1] - b.y - b.h) < e;
  const mid = rimBand(Q, N, (k) => (base0(k) ? 0 : Math.max(0, 0.35 - Math.abs(facing(k)))), 0.22 * small, rnd);
  if (mid) out.push(`<path data-jdraw-plane="mid" fill="${mix(0.25, deep)}" d="${d(mid)}"/>`);
  const lit = rimBand(Q, N, (k) => (base0(k) ? 0 : Math.max(0, facing(k) - 0.25)), 0.2 * small, rnd);
  if (lit) out.push(`<path data-jdraw-plane="lit" fill="${mix(0.45, bright)}" d="${d(lit)}"/>`);
  // No drawn cracks: a crack is where planes meet, and the cut planes already meet.
  return out.join("");
}
// Last try for a flat sea: JDraw lays long swells across the water itself,
// spaced wider, longer and darker toward the front, each a soft dark body
// with a thin lit upper edge, both fading at their ends.
function addSwells(svg, vb) {
  const shapes = shapesOf(svg);
  const sea = shapes.filter((s) => s.fill && s.closed && s.box.w >= 0.85 * vb.w && s.box.y + s.box.h >= vb.y + 0.9 * vb.h && s.box.y > vb.y + 0.05 * vb.h).sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h)[0] || shapes.filter((s) => s.fill && s.closed && s.box.w >= 0.85 * vb.w && s.box.y + s.box.h >= vb.y + 0.9 * vb.h).sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h)[0];
  if (!sea) return { svg, fixed: 0 };
  // The sea's color: its own fill, or the middle stop of its gradient.
  let rgb = rgbOfFill(sea.fill);
  let seaAt = null;
  if (!rgb) {
    const id = (String(sea.fill).match(/url\(\s*#([^)\s]+)\s*\)/) || [])[1];
    const g = id && (svg.match(new RegExp(`<(linear|radial)Gradient\\b[^>]*id\\s*=\\s*["']${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][\\s\\S]*?</\\1Gradient>`, "i")) || [])[0];
    const stops = g ? [...g.matchAll(/stop-color\s*[=:]\s*["']?\s*(#[0-9a-f]{3,6}|rgba?\([^)]*\))/gi)].map((m) => rgbOfFill(m[1])).filter(Boolean) : [];
    rgb = stops.length ? stops[Math.floor(stops.length / 2)] : [40, 70, 110];
    const offs = g ? [...g.matchAll(/<stop\b[^>]*>/gi)].map((m) => { const o = m[0].match(/offset\s*=\s*["']?\s*([\d.]+)(%?)/); const c = m[0].match(/stop-color\s*[=:]\s*["']?\s*(#[0-9a-f]{3,8}|rgba?\([^)]*\)|[a-z]+)/i); const v = c && rgbOfFill(c[1]); return v && { o: o ? +o[1] / (o[2] ? 100 : 1) : 0, v }; }).filter(Boolean) : [];
    const vert = g && !/x2\s*=\s*["']?\s*1/.test(g.slice(0, g.indexOf(">")));
    if (offs.length >= 2 && vert) seaAt = (y) => { const t = (y - sea.box.y) / Math.max(1, sea.box.h); if (t <= offs[0].o) return offs[0].v; for (let k = 1; k < offs.length; k++) if (t <= offs[k].o) { const a = offs[k - 1], c = offs[k], f = (t - a.o) / Math.max(1e-6, c.o - a.o); return a.v.map((x, i) => x + (c.v[i] - x) * f); } return offs[offs.length - 1].v; };
  }
  const hex = (c) => "#" + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
  const dark = hex(rgb.map((v) => v * 0.62)), lit = hex(rgb.map((v) => v + (255 - v) * 0.45));
  const b = sea.box, top = Math.max(b.y + 0.08 * b.h, b.y <= vb.y + 0.05 * vb.h ? vb.y + 0.58 * vb.h : -Infinity), rnd = rngOf(hashStr(svg.slice(0, 2000)) || 7);
  const id = "jdsw" + Math.floor(rnd() * 1e6);
  const out = [`<defs><linearGradient id="${id}" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.25" stop-color="#fff" stop-opacity="1"/><stop offset="0.75" stop-color="#fff" stop-opacity="1"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient><mask id="${id}m" maskContentUnits="objectBoundingBox"><rect width="1" height="1" fill="url(#${id})"/></mask></defs>`];
  const n = 7 + Math.floor(rnd() * 3);
  // Smooth curve through points (Catmull-Rom as cubic Beziers), no M.
  const curveThrough = (P) => {
    let d = "";
    for (let i = 0; i < P.length - 1; i++) {
      const p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(P.length - 1, i + 2)];
      const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6], c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
      d += ` C${fx(c1[0])},${fx(c1[1])} ${fx(c2[0])},${fx(c2[1])} ${fx(p2[0])},${fx(p2[1])}`;
    }
    return d;
  };
  let pieces = 0;
  for (let k = 0; k < n; k++) {
    // Perspective: rows bunch up near the horizon.
    const t = Math.pow((k + 0.6 + 0.3 * rnd()) / n, 1.7);
    const y = top + t * (b.y + b.h - top) * 0.95;
    const len = vb.w * (0.18 + 0.5 * t) * (0.7 + 0.6 * rnd());
    const x0 = b.x + rnd() * Math.max(1, b.w - len);
    const th = vb.h * (0.005 + 0.022 * t) * (0.7 + 0.6 * rnd());
    const tilt = (rnd() * 2 - 1) * 0.012;
    // A swell breaks into two to four pieces of different lengths with gaps.
    const nP = 1 + (rnd() < 0.5 ? 1 : 0), cuts = [0];
    for (let j = 1; j < nP; j++) cuts.push(j / nP + (rnd() - 0.5) * 0.6 / nP);
    cuts.push(1);
    for (let j = 0; j < nP; j++) {
      const ua = cuts[j] + (j ? 0.03 + 0.04 * rnd() : 0), ub = cuts[j + 1] - (j < nP - 1 ? 0.03 + 0.04 * rnd() : 0);
      if (ub - ua < 0.08) continue;
      const pts = 6 + Math.floor(rnd() * 3), upper = [], lower = [], crest = [];
      let walk = 0;
      for (let i = 0; i <= pts; i++) {
        const u = ua + ((ub - ua) * i) / pts, v = i / pts, x = x0 + u * len;
        walk = 0.6 * walk + (rnd() * 2 - 1) * th * 0.15;
        // Each piece swells in its middle and thins to a point at both ends.
        const bow = Math.pow(Math.sin(Math.PI * v), 0.8) * (0.75 + 0.5 * Math.sin(Math.PI * u));
        const yy = y + (u - 0.5) * len * tilt + walk;
        upper.push([x, yy - th * bow * (0.45 + 0.2 * rnd())]);
        lower.push([x, yy + th * 0.3 * bow]);
        crest.push([x, yy - th * bow * 0.3]);
      }
      const body = `M${fx(upper[0][0])},${fx(upper[0][1])}` + curveThrough(upper) + " L" + `${fx(lower[lower.length - 1][0])},${fx(lower[lower.length - 1][1])}` + curveThrough(lower.slice().reverse()) + " Z";
      // The lit crest: a thin sliver along the top that tapers out at both ends.
      const edge = `M${fx(upper[0][0])},${fx(upper[0][1])}` + curveThrough(upper) + curveThrough(crest.slice().reverse()) + " Z";
      const here = seaAt ? seaAt(y) : rgb, dk = hex(here.map((v) => v * 0.68)), lt = hex(here.map((v) => v + (255 - v) * 0.22));
      out.push(`<g mask="url(#${id}m)"><path data-jdraw-plane="swell" fill="${dk}" fill-opacity="${(0.5 + 0.35 * t).toFixed(2)}" d="${body}"/><path data-jdraw-plane="swell-lit" fill="${lt}" fill-opacity="${(0.35 + 0.25 * (1 - t)).toFixed(2)}" d="${edge}"/></g>`);
      pieces++;
    }
  }
  // Right after the sea element, so the swells sit on the water and under the
  // boats, glints and shores drawn on top of it. If the sea tag cannot be
  // found they go before </svg> as before.
  let pos = -1;
  const at = svg.indexOf(sea.raw || "");
  if (at >= 0) {
    pos = at + sea.raw.length;
    if (!/\/>$/.test(sea.raw)) {
      const tag = (sea.raw.match(/^<([a-z]+)/i) || [])[1];
      const close = tag && svg.indexOf("</" + tag + ">", pos);
      if (close >= 0) pos = close + tag.length + 3;
    }
  }
  if (pos < 0) pos = svg.lastIndexOf("</svg>");
  if (pos < 0) return { svg, fixed: 0 };
  return { svg: svg.slice(0, pos) + out.join("") + svg.slice(pos), fixed: pieces };
}

function primitiveOutline(raw) {
  const a = attrs(raw);
  const tag = ((raw.match(/^<([a-z]+)/i) || [])[1] || "").toLowerCase();
  if (tag === "rect") { const x = +a.x || 0, y = +a.y || 0, w = +a.width || 0, h = +a.height || 0; return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]; }
  const cx = +a.cx || 0, cy = +a.cy || 0, rx = +(a.rx ?? a.r) || 0, ry = +(a.ry ?? a.r) || 0;
  const rnd = rngOf(hashStr(raw)), flat = rnd() * Math.PI * 2;
  return Array.from({ length: 18 }, (_, k) => { const t = (k / 18) * Math.PI * 2, r = 0.9 + 0.16 * rnd() - (Math.cos(t - flat) > 0.8 ? 0.08 : 0); return [cx + rx * r * Math.cos(t), cy + ry * r * Math.sin(t)]; });
}
// The element's own attributes, minus its geometry, as written.
function keptAttrs(raw, keepTransform) {
  const head = raw.replace(/^<[a-z]+/i, "").replace(/\/?>$/, "");
  const drop = new Set(["d", "points", "x", "y", "width", "height", "cx", "cy", "r", "rx", "ry"]);
  if (!keepTransform) drop.add("transform");
  return [...head.matchAll(/([\w:-]+)\s*=\s*("[^"]*"|'[^']*')/g)].filter((m) => !drop.has(m[1])).map((m) => ` ${m[1]}=${m[2]}`).join("");
}
function structureRepair(svg, els, mode, light, vb, salt) {
  let out = String(svg), fixed = 0, lumpsU = null;
  const all = shapesOf(out);
  for (const raw of new Set(els || [])) {
    const tag = ((raw.match(/^<([a-z]+)/i) || [])[1] || "").toLowerCase();
    const self = /\/>$/.test(raw);
    const from = self ? raw : raw + `</${tag}>`;
    if (!tag || !out.includes(from)) continue;
    // Its own outline in its parent's coordinates (its own transform applied).
    const own = shapesOf(`<svg>${from}</svg>`).filter((s) => s.pts.length >= 3);
    if (!own.length) continue;
    const fill = (all.find((s) => s.raw === raw) || {}).fill || own[0].fill;
    const prim = tag === "rect" || tag === "circle" || tag === "ellipse";
    const P = prim ? primitiveOutline(raw) : outlineOf(own.sort((p, q2) => q2.box.w * q2.box.h - p.box.w * p.box.h)[0]);
    if (P.length < 3) continue;
    const b = bboxOf(P), size = Math.max(b.w, b.h), rnd = rngOf(hashStr(raw));
    const asPath = (Q) => `<path${keptAttrs(raw, prim)} d="M${Q.map((p) => `${fx(p[0])},${fx(p[1])}`).join(" L")} Z"/>`;
    const ownTf = prim ? attrs(raw).transform : null;
    let next;
    if (mode === "detail") {
      const R = [];
      for (let k = 0; k < P.length; k++) R.push(P[k], ...wander(P[k], P[(k + 1) % P.length], size, rnd, 0.012));
      next = asPath(R);
    } else if (mode === "lumps") {
      // The underside hangs in lumps of uneven width with pockets between
      // them, the same along x for every layer of the cloud; curves through.
      const U = lumpsU || (lumpsU = (() => {
        const ub = bboxOf([...new Set(els)].flatMap((r) => { const t2 = ((r.match(/^<([a-z]+)/i) || [])[1] || ""); return shapesOf("<svg>" + r + (/\/>$/.test(r) ? "" : "</" + t2 + ">") + "</svg>").flatMap((q3) => outlineOf(q3)); }));
        const r2 = rngOf(hashStr(String(svg).length + ":" + ub.w.toFixed(0)));
        const cuts = [0];
        while (cuts[cuts.length - 1] < 1) cuts.push(Math.min(1, cuts[cuts.length - 1] + 0.06 + 0.16 * r2()));
        return { ub, cuts, hs: cuts.map(() => 0.4 + 0.6 * r2()) };
      })());
      const lump = (x) => { const u = (x - U.ub.x) / (U.ub.w || 1); for (let i = 1; i < U.cuts.length; i++) if (u <= U.cuts[i]) { const t = (u - U.cuts[i - 1]) / (U.cuts[i] - U.cuts[i - 1] || 1); return U.hs[i] * Math.pow(Math.sin(Math.PI * t), 0.7); } return 0; };
      const step = Math.max(1, Math.floor(P.length / 60));
      const cy = b.y + 0.55 * b.h, bot = b.y + b.h;
      const R = P.filter((_, k) => k % step === 0).map(([x, y]) => (y > cy ? [x, y - 0.35 * U.ub.h * (1 - lump(x)) * ((y - cy) / (bot - cy || 1))] : [x, y]));
      next = `<path${keptAttrs(raw, prim)} d="${smoothClosed(R, hashStr(raw) % 997)}"/>`;
    } else if (mode === "horizon") {
      // The edge where two fields meet rises and dips with slow waves of
      // uneven size. An edge that runs along the frame is still a horizon in
      // the picture, so it is pushed into the shape rather than left ruled.
      const V = vb || { x: b.x, y: b.y, w: b.w, h: b.h };
      const ph = rnd() * 6.28, ph2 = rnd() * 6.28, ph3 = rnd() * 6.28, amp = 0.022 * V.h;
      const wave = (u) => amp * (1.3 * Math.sin(u * 8.4 + ph) + 0.5 * Math.sin(u * 19 + ph2) + 0.25 * Math.sin(u * 37 + ph3)) / 1.4;
      const R = [];
      for (let k = 0; k < P.length; k++) {
        const a = P[k], c = P[(k + 1) % P.length];
        R.push(a);
        const horiz = Math.abs(a[1] - c[1]) < 0.01 * V.h;
        const vert = Math.abs(a[0] - c[0]) < 0.01 * V.w;
        // A frame side is not a horizon; the bottom frame is covered by the
        // water in front of it.
        if (vert) continue;
        let oneSided = false;
        if (horiz) {
          const onTop = Math.abs(a[1] - V.y) < 0.01 * V.h, onBot = Math.abs(a[1] - V.y - V.h) < 0.01 * V.h;
          if (onBot) continue;
          if (onTop) {
            // A field cut off by the top of its own item: dip into the shape,
            // so the horizon bends instead of running along the frame.
            const mx = (a[0] + c[0]) / 2, my = (a[1] + c[1]) / 2;
            if (!inPoly(P, mx, my + 0.02 * V.h)) continue;
            oneSided = true;
          }
        }
        const len = Math.hypot(c[0] - a[0], c[1] - a[1]), n2 = Math.floor(len / (0.012 * V.w));
        for (let j = 1; j < n2; j++) {
          const t = j / n2, x = a[0] + (c[0] - a[0]) * t, y = a[1] + (c[1] - a[1]) * t, u = (x - V.x) / V.w;
          // The one-sided dip is sized to the edge, so a horizon of any length
          // visibly bends; in the middle of the SVG the edge rises and dips
          // around its line.
          if (oneSided) R.push([x, y + 0.03 * len * (0.42 + 0.58 * (0.5 + 0.5 * Math.sin(t * 8.4 + ph)))]);
          else R.push([x, y + wave(u)]);
        }
      }
      next = asPath(R);
    } else if (mode === "planes") {
      const c = [b.x + b.w / 2, b.y + b.h / 2];
      const dir = light ? [light.x - c[0], light.y - c[1]] : [-0.3, -1];
      const l = Math.hypot(dir[0], dir[1]) || 1;
      let pf = fill;
      if (!rgbOfFill(pf)) {
        // A gradient-filled mass gets planes in its own colors, not a neutral gray.
        const gid = (String(pf).match(/url\(\s*#([^)\s]+)\s*\)/) || [])[1];
        const g = gid && (svg.match(new RegExp(`<(linear|radial)Gradient\\b[^>]*id\\s*=\\s*["']${gid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][\\s\\S]*?</\\1Gradient>`, "i")) || [])[0];
        const stops = g ? [...g.matchAll(/stop-color\s*[=:]\s*["']?\s*(#[0-9a-f]{3,6}|rgba?\([^)]*\))/gi)].map((m) => m[1]).filter((c) => rgbOfFill(c)) : [];
        if (stops.length) pf = stops[Math.floor(stops.length / 2)];
      }
      const planes = planesFor(P, pf, [dir[0] / l, dir[1] / l], (hashStr(raw) + (salt || 0) * 7919) >>> 0, all.map((s) => s.fill));
      if (!planes) continue;
      next = from + (ownTf ? `<g transform="${ownTf}">${planes}</g>` : planes);
    } else continue;
    out = out.split(from).join(next);
    fixed++;
  }
  return { svg: out, fixed };
}

module.exports = { lintSvg, parsePath, shapesOf, parseTransform, repairOutlines, structureRepair, labOf, unmirror, addSwells };

