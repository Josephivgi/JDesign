// Shared drawing model helpers. Loaded by the window (as window.JGeom) and by
// the main process (require) so the agent tools and the canvas agree on
// bounds, colors and item shapes.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.JGeom = api;
})(typeof self !== "undefined" ? self : this, function () {
  const ITEM_TYPES = ["stroke", "rect", "ellipse", "line", "polygon", "path", "text", "image"];
  const BRUSHES = ["pen", "pencil", "marker", "airbrush", "calligraphy", "watercolor", "eraser"];
  const DASHES = ["dashed", "dotted"];

  let counter = 0;
  function uid(prefix) {
    counter = (counter + 1) % 1679616;
    return (prefix || "i") + Date.now().toString(36).slice(-5) + counter.toString(36) + Math.random().toString(36).slice(2, 5);
  }

  const NAMED = {
    black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000", blue: "#0000ff", yellow: "#ffff00",
    orange: "#ffa500", purple: "#800080", pink: "#ffc0cb", brown: "#a52a2a", gray: "#808080", grey: "#808080",
    transparent: "#00000000", none: "#00000000",
  };

  // Accepts #rgb, #rgba, #rrggbb, #rrggbbaa and a few names. Returns
  // lowercase #rrggbb or #rrggbbaa, or null.
  function normColor(value) {
    if (typeof value !== "string") return null;
    let v = value.trim().toLowerCase();
    if (NAMED[v]) return NAMED[v];
    const rgb = v.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/);
    if (rgb) {
      const to = (n) => Math.max(0, Math.min(255, Math.round(Number(n)))).toString(16).padStart(2, "0");
      let hex = "#" + to(rgb[1]) + to(rgb[2]) + to(rgb[3]);
      if (rgb[4] !== undefined) {
        let a = rgb[4].endsWith("%") ? parseFloat(rgb[4]) / 100 : Number(rgb[4]);
        if (a < 1) hex += to(a * 255);
      }
      return hex;
    }
    if (!v.startsWith("#")) v = "#" + v;
    if (/^#[0-9a-f]{3,4}$/.test(v)) v = "#" + v.slice(1).split("").map((c) => c + c).join("");
    if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/.test(v)) return v.endsWith("ff") && v.length === 9 ? v.slice(0, 7) : v;
    return null;
  }

  function hexToRgb(hex) {
    const h = normColor(hex) || "#000000";
    return { r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16), a: h.length === 9 ? parseInt(h.slice(7, 9), 16) / 255 : 1 };
  }

  function colorDistance(a, b) {
    const x = hexToRgb(a), y = hexToRgb(b);
    return Math.sqrt((x.r - y.r) ** 2 + (x.g - y.g) ** 2 + (x.b - y.b) ** 2);
  }

  // A paint is a color string or a gradient object.
  function normPaint(value) {
    if (value == null || value === "" || value === "none") return null;
    if (typeof value === "string") return normColor(value);
    if (typeof value === "object" && (value.type === "linear" || value.type === "radial") && Array.isArray(value.stops)) {
      const stops = value.stops
        .map((s) => (Array.isArray(s) ? { offset: Number(s[0]), color: normColor(s[1]) } : { offset: Number(s.offset), color: normColor(s.color) }))
        .filter((s) => s.color && Number.isFinite(s.offset))
        .map((s) => [Math.max(0, Math.min(1, s.offset)), s.color]);
      if (stops.length < 2) return stops.length ? stops[0][1] : null;
      const out = { type: value.type, stops };
      for (const k of ["x1", "y1", "x2", "y2", "cx", "cy", "r"]) if (Number.isFinite(Number(value[k]))) out[k] = Number(value[k]);
      return out;
    }
    return null;
  }

  function paintColors(p) {
    if (!p) return [];
    if (typeof p === "string") return [p];
    return p.stops.map((s) => s[1]);
  }

  function num(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  // Cleans an item from the window or an agent. Throws with a plain message
  // when the item cannot be drawn.
  function normItem(raw) {
    if (!raw || typeof raw !== "object") throw new Error("Each item must be an object.");
    const type = String(raw.type || "").toLowerCase();
    if (!ITEM_TYPES.includes(type)) throw new Error(`Unknown item type "${raw.type}". Use one of: ${ITEM_TYPES.join(", ")}.`);
    const it = { id: typeof raw.id === "string" && raw.id ? raw.id : uid(type[0]), type };
    if (raw.opacity !== undefined) it.opacity = clamp(num(raw.opacity, 1), 0, 1);
    if (raw.rotation) it.rotation = num(raw.rotation, 0);
    if (raw.name) it.name = String(raw.name).slice(0, 80);
    if (raw.blend && typeof raw.blend === "string") it.blend = raw.blend;
    if (raw.flipX) it.flipX = true;
    if (raw.flipY) it.flipY = true;
    if (raw.group && typeof raw.group === "string") it.group = raw.group.slice(0, 40);
    if (raw.shadow && typeof raw.shadow === "object") {
      const c = normColor(raw.shadow.color || "#00000080");
      if (c) it.shadow = { color: c, blur: clamp(num(raw.shadow.blur, 8), 0, 200), x: num(raw.shadow.x, 0), y: num(raw.shadow.y, 0) };
    }
    const fill = normPaint(raw.fill);
    const stroke = normPaint(raw.stroke);
    const sw = clamp(num(raw.strokeWidth, 2), 0, 500);
    const lineStyle = () => {
      if (DASHES.includes(raw.dash)) it.dash = raw.dash;
      if (type === "line" || (type === "polygon" && raw.closed === false)) {
        if (raw.arrowStart) it.arrowStart = true;
        if (raw.arrowEnd) it.arrowEnd = true;
      }
    };
    switch (type) {
      case "stroke": {
        const pts = Array.isArray(raw.points) ? raw.points : [];
        it.points = pts
          .map((p) => (Array.isArray(p) ? [num(p[0], NaN), num(p[1], NaN), clamp(num(p[2], 0.5), 0, 1)] : [num(p.x, NaN), num(p.y, NaN), clamp(num(p.pressure ?? p.p, 0.5), 0, 1)]))
          .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))
          .map((p) => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10, Math.round(p[2] * 100) / 100]);
        if (!it.points.length) throw new Error("A stroke needs at least one point.");
        it.color = normColor(raw.color || raw.stroke || "#000000") || "#000000";
        it.size = clamp(num(raw.size ?? raw.strokeWidth, 6), 0.5, 400);
        it.brush = BRUSHES.includes(raw.brush) ? raw.brush : "pen";
        break;
      }
      case "rect":
      case "ellipse":
      case "image": {
        it.x = num(raw.x, 0);
        it.y = num(raw.y, 0);
        it.w = num(raw.w ?? raw.width, 100);
        it.h = num(raw.h ?? raw.height, 100);
        if (it.w < 0) { it.x += it.w; it.w = -it.w; }
        if (it.h < 0) { it.y += it.h; it.h = -it.h; }
        if (type === "image") {
          if (typeof raw.src !== "string" || !/^data:image\//.test(raw.src)) throw new Error("An image needs a data:image/ src.");
          it.src = raw.src;
        } else {
          it.fill = fill;
          it.stroke = stroke;
          it.strokeWidth = sw;
          if (type === "rect" && raw.radius) it.radius = clamp(num(raw.radius, 0), 0, 10000);
          if (!it.fill && !it.stroke) it.fill = "#000000";
          lineStyle();
        }
        break;
      }
      case "line": {
        it.x1 = num(raw.x1, 0); it.y1 = num(raw.y1, 0); it.x2 = num(raw.x2, 100); it.y2 = num(raw.y2, 100);
        it.stroke = stroke || normColor(raw.color) || "#000000";
        it.strokeWidth = sw;
        lineStyle();
        break;
      }
      case "polygon": {
        const pts = (Array.isArray(raw.points) ? raw.points : [])
          .map((p) => (Array.isArray(p) ? [num(p[0], NaN), num(p[1], NaN)] : [num(p.x, NaN), num(p.y, NaN)]))
          .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
        if (pts.length < 2) throw new Error("A polygon needs at least two points.");
        it.points = pts;
        it.closed = raw.closed !== false;
        it.smooth = !!raw.smooth;
        it.fill = it.closed ? fill : null;
        it.stroke = stroke;
        it.strokeWidth = sw;
        if (!it.fill && !it.stroke) it.stroke = "#000000";
        lineStyle();
        break;
      }
      case "path": {
        if (typeof raw.d !== "string" || !raw.d.trim()) throw new Error("A path needs an SVG d string.");
        it.d = raw.d.slice(0, 200000);
        it.fill = fill;
        it.stroke = stroke;
        it.strokeWidth = sw;
        if (!it.fill && !it.stroke) it.fill = "#000000";
        if (raw.x || raw.y) { it.x = num(raw.x, 0); it.y = num(raw.y, 0); }
        if (raw.scale) it.scale = clamp(num(raw.scale, 1), 0.001, 1000);
        lineStyle();
        break;
      }
      case "text": {
        it.text = String(raw.text ?? "").slice(0, 2000);
        if (!it.text) throw new Error("A text item needs text.");
        it.x = num(raw.x, 0);
        it.y = num(raw.y, 0);
        it.size = clamp(num(raw.size ?? raw.fontSize, 32), 4, 2000);
        it.font = typeof raw.font === "string" && raw.font ? raw.font.slice(0, 80) : "Inter, Segoe UI, sans-serif";
        it.weight = String(raw.weight || "600");
        it.align = ["left", "center", "right"].includes(raw.align) ? raw.align : "left";
        it.fill = fill || normColor(raw.color) || "#000000";
        if (stroke) { it.stroke = stroke; it.strokeWidth = sw; }
        break;
      }
    }
    return it;
  }

  function strokePad(it) {
    if (it.type === "stroke") return it.size / 2 + (it.brush === "airbrush" ? it.size : it.brush === "watercolor" ? it.size * 0.25 : 0);
    if (it.stroke && (it.arrowStart || it.arrowEnd)) return Math.max((it.strokeWidth || 0) / 2, arrowSize(it) * 0.6);
    if (it.stroke) return (it.strokeWidth || 0) / 2;
    return 0;
  }

  // Arrowhead length for a line of this width.
  function arrowSize(it) {
    return Math.max(10, (it.strokeWidth || 2) * 3.2);
  }

  // Exact extremes of Bezier curves and SVG arcs.
  function cubicExtent(x0, y0, x1, y1, x2, y2, x3, y3, add) {
    add(x0, y0); add(x3, y3);
    const at = (t, a, b, c, d) => { const u = 1 - t; return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d; };
    for (const [a, b, c, d] of [[x0, x1, x2, x3], [y0, y1, y2, y3]]) {
      // Roots of the derivative: A t^2 + B t + C = 0
      const A = -a + 3 * b - 3 * c + d, B = 2 * (a - 2 * b + c), C = b - a;
      const ts = [];
      if (Math.abs(A) < 1e-9) { if (Math.abs(B) > 1e-9) ts.push(-C / B); }
      else { const disc = B * B - 4 * A * C; if (disc >= 0) { const s = Math.sqrt(disc); ts.push((-B + s) / (2 * A), (-B - s) / (2 * A)); } }
      for (const t of ts) if (t > 0 && t < 1) add(at(t, x0, x1, x2, x3), at(t, y0, y1, y2, y3));
    }
  }
  function quadExtent(x0, y0, x1, y1, x2, y2, add) {
    add(x0, y0); add(x2, y2);
    for (const [a, b, c] of [[x0, x1, x2], [y0, y1, y2]]) {
      const den = a - 2 * b + c;
      if (Math.abs(den) < 1e-9) continue;
      const t = (a - b) / den;
      if (t > 0 && t < 1) { const u = 1 - t; add(u * u * x0 + 2 * u * t * x1 + t * t * x2, u * u * y0 + 2 * u * t * y1 + t * t * y2); }
    }
  }
  function arcExtent(x1, y1, rx, ry, rotDeg, large, sweep, x2, y2, add) {
    add(x1, y1); add(x2, y2);
    rx = Math.abs(rx); ry = Math.abs(ry);
    if (!rx || !ry || (x1 === x2 && y1 === y2)) return;
    // SVG spec F.6.5: endpoint to center parameterization.
    const phi = (rotDeg * Math.PI) / 180, cos = Math.cos(phi), sin = Math.sin(phi);
    const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
    const x1p = cos * dx + sin * dy, y1p = -sin * dx + cos * dy;
    const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s; }
    const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
    const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
    let co = den ? Math.sqrt(Math.max(0, num / den)) : 0;
    if (!!large === !!sweep) co = -co;
    const cxp = (co * rx * y1p) / ry, cyp = (-co * ry * x1p) / rx;
    const cx = cos * cxp - sin * cyp + (x1 + x2) / 2, cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
    const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
    let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
    if (!sweep && dt > 0) dt -= 2 * Math.PI;
    if (sweep && dt < 0) dt += 2 * Math.PI;
    const steps = Math.max(8, Math.ceil(Math.abs(dt) / (Math.PI / 32)));
    for (let k = 1; k < steps; k++) {
      const t = t1 + (dt * k) / steps;
      const ex = rx * Math.cos(t), ey = ry * Math.sin(t);
      add(cos * ex - sin * ey + cx, sin * ex + cos * ey + cy);
    }
  }

  // Bounds of SVG path data. Walks every command (absolute and relative)
  // with exact curve and arc extents.
  const pathBoundsCache = new Map();
  function pathBounds(d) {
    const key = String(d);
    const hit = pathBoundsCache.get(key);
    if (hit) return hit;
    const tokens = key.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) || [];
    let i = 0, cmd = "", x = 0, y = 0, sx = 0, sy = 0;
    let lastC = null, lastQ = null; // last cubic / quadratic control point, for S and T
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const add = (px, py) => { if (px < minX) minX = px; if (px > maxX) maxX = px; if (py < minY) minY = py; if (py > maxY) maxY = py; };
    const isNum = (t) => t !== undefined && !/^[a-zA-Z]$/.test(t);
    const n = () => Number(tokens[i++]);
    let guard = 0;
    while (i < tokens.length && guard++ < 200000) {
      if (/^[a-zA-Z]$/.test(tokens[i])) cmd = tokens[i++];
      else if (!cmd) { i++; continue; }
      const rel = cmd === cmd.toLowerCase();
      const C = cmd.toUpperCase();
      const ox = rel ? x : 0, oy = rel ? y : 0;
      if (C === "Z") { x = sx; y = sy; add(x, y); if (!isNum(tokens[i])) continue; else { cmd = rel ? "l" : "L"; continue; } }
      if (!isNum(tokens[i])) { if (i < tokens.length && !/^[a-zA-Z]$/.test(tokens[i])) i++; continue; }
      const prevC = lastC, prevQ = lastQ;
      lastC = null; lastQ = null;
      switch (C) {
        case "M": x = ox + n(); y = oy + n(); sx = x; sy = y; add(x, y); cmd = rel ? "l" : "L"; break;
        case "L": x = ox + n(); y = oy + n(); add(x, y); break;
        case "H": x = ox + n(); add(x, y); break;
        case "V": y = (rel ? y : 0) + n(); add(x, y); break;
        case "C": {
          const c1x = ox + n(), c1y = oy + n(), c2x = ox + n(), c2y = oy + n();
          const ex = ox + n(), ey = oy + n();
          cubicExtent(x, y, c1x, c1y, c2x, c2y, ex, ey, add);
          x = ex; y = ey; lastC = [c2x, c2y];
          break;
        }
        case "S": {
          // First control point mirrors the previous curve's second one.
          const c1x = prevC ? 2 * x - prevC[0] : x, c1y = prevC ? 2 * y - prevC[1] : y;
          const c2x = ox + n(), c2y = oy + n();
          const ex = ox + n(), ey = oy + n();
          cubicExtent(x, y, c1x, c1y, c2x, c2y, ex, ey, add);
          x = ex; y = ey; lastC = [c2x, c2y];
          break;
        }
        case "Q": {
          const cx = ox + n(), cy = oy + n(), ex = ox + n(), ey = oy + n();
          quadExtent(x, y, cx, cy, ex, ey, add);
          x = ex; y = ey; lastQ = [cx, cy];
          break;
        }
        case "T": {
          const c = prevQ ? [2 * x - prevQ[0], 2 * y - prevQ[1]] : [x, y];
          const ex = ox + n(), ey = oy + n();
          quadExtent(x, y, c[0], c[1], ex, ey, add);
          x = ex; y = ey; lastQ = c;
          break;
        }
        case "A": {
          const rx = n(), ry = n(), rot = n(), large = n(), sweep = n();
          const ex = ox + n(), ey = oy + n();
          arcExtent(x, y, rx, ry, rot, large, sweep, ex, ey, add);
          x = ex; y = ey;
          break;
        }
        default: i++;
      }
    }
    const out = Number.isFinite(minX) ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY } : { x: 0, y: 0, w: 0, h: 0 };
    if (pathBoundsCache.size > 3000) pathBoundsCache.clear();
    pathBoundsCache.set(key, out);
    return out;
  }

  // Bezier control points of a smooth polygon, the same ones the renderer
  // uses (Catmull-Rom to Bezier), so bounds cover the curve.
  function smoothControls(pts, closed) {
    const n = pts.length;
    const get = (i) => (closed ? pts[(i + n) % n] : pts[Math.max(0, Math.min(n - 1, i))]);
    const out = [];
    const segs = closed ? n : n - 1;
    const add = (x, y) => out.push([x, y]);
    for (let i = 0; i < segs; i++) {
      const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
      const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
      const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
      cubicExtent(p1[0], p1[1], c1[0], c1[1], c2[0], c2[1], p2[0], p2[1], add);
    }
    return out;
  }

  // The window sets a real text measurer; the main process uses an estimate.
  let measureText = null;
  function setTextMeasurer(fn) { measureText = fn; }
  let imageBoxer = null;
  function setImageBoxer(fn) { imageBoxer = fn; }

  function bounds(it) {
    let b;
    switch (it.type) {
      case "stroke":
      case "polygon": {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        let pts = it.points;
        if (it.type === "polygon" && it.smooth && pts.length > 2) pts = pts.concat(smoothControls(pts, it.closed));
        for (const p of pts) {
          if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
          if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
        }
        b = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
        break;
      }
      case "line":
        b = { x: Math.min(it.x1, it.x2), y: Math.min(it.y1, it.y2), w: Math.abs(it.x2 - it.x1), h: Math.abs(it.y2 - it.y1) };
        break;
      case "path": {
        const pb = pathBounds(it.d);
        const s = it.scale || 1;
        b = { x: pb.x * s + (it.x || 0), y: pb.y * s + (it.y || 0), w: pb.w * s, h: pb.h * s };
        break;
      }
      case "text": {
        const lines = it.text.split("\n");
        const font = `${it.weight || 600} ${it.size}px ${it.font}`;
        const w = Math.max(...lines.map((l) => (measureText ? measureText(l, font) : l.length * it.size * 0.55)));
        const h = (lines.length - 1) * it.size * 1.2 + it.size * 1.15;
        const x = it.align === "center" ? it.x - w / 2 : it.align === "right" ? it.x - w : it.x;
        b = { x, y: it.y - it.size * 0.9, w, h };
        break;
      }
      case "image": {
        const f = imageBoxer && imageBoxer(it.src);
        b = f ? { x: it.x + f.x * it.w, y: it.y + f.y * it.h, w: Math.min(it.w, f.w * it.w), h: Math.min(it.h, f.h * it.h) } : { x: it.x, y: it.y, w: it.w, h: it.h };
        break;
      }
      default:
        b = { x: it.x, y: it.y, w: it.w, h: it.h };
    }
    const pad = strokePad(it);
    b = { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
    if (it.rotation) {
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      const a = (it.rotation * Math.PI) / 180, c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
      const w2 = b.w * c + b.h * s, h2 = b.w * s + b.h * c;
      b = { x: cx - w2 / 2, y: cy - h2 / 2, w: w2, h: h2 };
    }
    return b;
  }

  function moveItem(it, dx, dy) {
    const out = JSON.parse(JSON.stringify(it));
    switch (out.type) {
      case "stroke": out.points = out.points.map((p) => [p[0] + dx, p[1] + dy, p[2]]); break;
      case "polygon": out.points = out.points.map((p) => [p[0] + dx, p[1] + dy]); break;
      case "line": out.x1 += dx; out.x2 += dx; out.y1 += dy; out.y2 += dy; break;
      case "path": out.x = (out.x || 0) + dx; out.y = (out.y || 0) + dy; break;
      default: out.x += dx; out.y += dy;
    }
    return out;
  }

  // Scales an item around (ox, oy).
  function scaleItem(it, s, ox, oy) {
    const out = JSON.parse(JSON.stringify(it));
    const sx = (x) => ox + (x - ox) * s;
    const sy = (y) => oy + (y - oy) * s;
    switch (out.type) {
      case "stroke": out.points = out.points.map((p) => [sx(p[0]), sy(p[1]), p[2]]); out.size *= s; break;
      case "polygon": out.points = out.points.map((p) => [sx(p[0]), sy(p[1])]); break;
      case "line": out.x1 = sx(out.x1); out.x2 = sx(out.x2); out.y1 = sy(out.y1); out.y2 = sy(out.y2); break;
      case "path": out.x = sx(out.x || 0); out.y = sy(out.y || 0); out.scale = (out.scale || 1) * s; break;
      case "text": out.x = sx(out.x); out.y = sy(out.y); out.size *= s; break;
      default: out.x = sx(out.x); out.y = sy(out.y); out.w *= s; out.h *= s;
    }
    if (out.strokeWidth && out.type !== "stroke") out.strokeWidth *= s;
    return out;
  }

  // Center of an item, the point it rotates and flips around.
  function center(it) {
    const b = bounds(it);
    return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  }

  function rotPt(x, y, ox, oy, rad) {
    const c = Math.cos(rad), s = Math.sin(rad);
    return [ox + (x - ox) * c - (y - oy) * s, oy + (x - ox) * s + (y - oy) * c];
  }

  // Rotates an item by deg around (ox, oy), or its own center. Lines,
  // polygons and strokes get new points so their boxes stay tight; other
  // items keep a rotation angle.
  function rotateItem(it, deg, ox, oy) {
    let out = JSON.parse(JSON.stringify(it));
    if (!deg) return out;
    const c0 = center(it);
    if (ox === undefined) { ox = c0.x; oy = c0.y; }
    const rad = (deg * Math.PI) / 180;
    switch (out.type) {
      case "stroke": out.points = out.points.map((p) => [...rotPt(p[0], p[1], ox, oy, rad), p[2]]); return out;
      case "polygon": out.points = out.points.map((p) => rotPt(p[0], p[1], ox, oy, rad)); return out;
      case "line": {
        const a = rotPt(out.x1, out.y1, ox, oy, rad), b = rotPt(out.x2, out.y2, ox, oy, rad);
        out.x1 = a[0]; out.y1 = a[1]; out.x2 = b[0]; out.y2 = b[1];
        return out;
      }
    }
    const nc = rotPt(c0.x, c0.y, ox, oy, rad);
    out = moveItem(out, nc[0] - c0.x, nc[1] - c0.y);
    let r = ((out.rotation || 0) + deg) % 360;
    if (r > 180) r -= 360;
    if (r <= -180) r += 360;
    if (Math.abs(r) < 1e-6) delete out.rotation; else out.rotation = Math.round(r * 1000) / 1000;
    return out;
  }

  // Mirrors an item across a vertical (axis "x") or horizontal ("y") line
  // through (ox, oy), or its own center.
  function flipItem(it, axis, ox, oy) {
    const c0 = center(it);
    if (ox === undefined) { ox = c0.x; oy = c0.y; }
    const fx = (x) => (axis === "x" ? 2 * ox - x : x);
    const fy = (y) => (axis === "y" ? 2 * oy - y : y);
    let out = JSON.parse(JSON.stringify(it));
    switch (out.type) {
      case "stroke": out.points = out.points.map((p) => [fx(p[0]), fy(p[1]), p[2]]); return out;
      case "polygon": out.points = out.points.map((p) => [fx(p[0]), fy(p[1])]); return out;
      case "line": out.x1 = fx(out.x1); out.x2 = fx(out.x2); out.y1 = fy(out.y1); out.y2 = fy(out.y2); return out;
    }
    out = moveItem(out, fx(c0.x) - c0.x, fy(c0.y) - c0.y);
    if (out.rotation) out.rotation = -out.rotation;
    // Plain rectangles and ellipses look the same mirrored, unless a
    // gradient runs across them.
    const gradient = (p) => !!p && typeof p === "object";
    if ((out.type === "rect" || out.type === "ellipse") && !gradient(out.fill) && !gradient(out.stroke)) return out;
    const k = axis === "x" ? "flipX" : "flipY";
    if (out[k]) delete out[k]; else out[k] = true;
    return out;
  }

  // Points of a regular polygon (n sides) or star (n points) inside a box.
  function shapePoints(kind, x, y, w, h, n, inner) {
    const cx = x + w / 2, cy = y + h / 2, rx = w / 2, ry = h / 2;
    const count = kind === "star" ? n * 2 : n;
    const pts = [];
    for (let i = 0; i < count; i++) {
      const a = -Math.PI / 2 + (i * Math.PI * 2) / count;
      const k = kind === "star" && i % 2 ? inner : 1;
      pts.push([Math.round((cx + Math.cos(a) * rx * k) * 10) / 10, Math.round((cy + Math.sin(a) * ry * k) * 10) / 10]);
    }
    return pts;
  }

  function unionBox(boxes) {
    const x0 = Math.min(...boxes.map((b) => b.x)), y0 = Math.min(...boxes.map((b) => b.y));
    return { x: x0, y: y0, w: Math.max(...boxes.map((b) => b.x + b.w)) - x0, h: Math.max(...boxes.map((b) => b.y + b.h)) - y0 };
  }

  // Lines items up. how: left|center|right|top|middle|bottom. Against the
  // box around all of them, or against ref (the canvas) when given.
  function alignItems(items, how, ref) {
    const boxes = items.map(bounds);
    const r = ref || unionBox(boxes);
    return items.map((it, i) => {
      const b = boxes[i];
      let dx = 0, dy = 0;
      if (how === "left") dx = r.x - b.x;
      else if (how === "center") dx = r.x + r.w / 2 - (b.x + b.w / 2);
      else if (how === "right") dx = r.x + r.w - (b.x + b.w);
      else if (how === "top") dy = r.y - b.y;
      else if (how === "middle") dy = r.y + r.h / 2 - (b.y + b.h / 2);
      else if (how === "bottom") dy = r.y + r.h - (b.y + b.h);
      return dx || dy ? moveItem(it, dx, dy) : it;
    });
  }

  // Even gaps between items, side to side ("horizontal") or top to bottom.
  function distributeItems(items, dir) {
    if (items.length < 3) return items;
    const horiz = dir !== "vertical";
    const rows = items.map((it, i) => ({ it, i, b: bounds(it) }));
    rows.sort((a, b) => (horiz ? a.b.x - b.b.x : a.b.y - b.b.y));
    const first = rows[0].b, last = rows[rows.length - 1].b;
    const span = horiz ? last.x + last.w - first.x : last.y + last.h - first.y;
    const used = rows.reduce((n, r) => n + (horiz ? r.b.w : r.b.h), 0);
    const gap = (span - used) / (rows.length - 1);
    let at = horiz ? first.x : first.y;
    const out = items.slice();
    for (const r of rows) {
      const d = at - (horiz ? r.b.x : r.b.y);
      out[r.i] = Math.abs(d) > 1e-6 ? moveItem(r.it, horiz ? d : 0, horiz ? 0 : d) : r.it;
      at += (horiz ? r.b.w : r.b.h) + gap;
    }
    return out;
  }

  function newDoc(opts) {
    const o = opts || {};
    const layerId = uid("L");
    return {
      version: 1,
      width: clamp(Math.round(num(o.width, 1600)), 64, 8192),
      height: clamp(Math.round(num(o.height, 1200)), 64, 8192),
      background: normColor(o.background || "#ffffff") || "#ffffff",
      palette: (o.palette || ["#1f1f24", "#ffffff", "#e5484d", "#f76b15", "#ffc53d", "#46a758", "#0090ff", "#8e4ec6"]).map(normColor).filter(Boolean),
      layers: [{ id: layerId, name: "Layer 1", visible: true, opacity: 1, items: [] }],
    };
  }

  function findItem(doc, id) {
    for (const layer of doc.layers) {
      const i = layer.items.findIndex((it) => it.id === id);
      if (i >= 0) return { layer, index: i, item: layer.items[i] };
    }
    return null;
  }

  function itemColors(it) {
    if (it.type === "stroke") return [it.color];
    if (it.type === "image") return [];
    return [...paintColors(it.fill), ...paintColors(it.stroke)];
  }

  return { rotateItem, flipItem, shapePoints, alignItems, distributeItems, unionBox, center, arrowSize, DASHES, setTextMeasurer, setImageBoxer, pathBounds, ITEM_TYPES, BRUSHES, uid, normColor, normPaint, hexToRgb, colorDistance, normItem, bounds, moveItem, scaleItem, newDoc, findItem, itemColors, clamp, paintColors };
});
