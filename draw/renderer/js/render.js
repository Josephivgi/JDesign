// Draws a JDraw document with Canvas 2D. Each layer renders into its own
// canvas so erasers only cut through their layer and layer opacity and blend
// modes apply to the whole layer.
(function () {
  const G = window.JGeom;
  const images = new Map(); // src -> { img, ready, waiters }

  // Real text widths for bounds and selection boxes.
  const measureCtx = document.createElement("canvas").getContext("2d");
  const widthCache = new Map();
  G.setTextMeasurer((text, font) => {
    const k = font + "|" + text;
    let w = widthCache.get(k);
    if (w === undefined) {
      measureCtx.font = font;
      w = measureCtx.measureText(text).width;
      if (widthCache.size > 4000) widthCache.clear();
      widthCache.set(k, w);
    }
    return w;
  });
  let onImageReady = null;

  function imageFor(src) {
    let rec = images.get(src);
    if (!rec) {
      const img = new Image();
      rec = { img, ready: false, failed: false, promise: null };
      rec.promise = new Promise((resolve) => {
        img.onload = () => { rec.ready = true; rec.box = contentBox(img); resolve(); onImageReady && onImageReady(); };
        img.onerror = () => { rec.failed = true; resolve(); };
      });
      img.src = src;
      images.set(src, rec);
    }
    return rec;
  }

  // Visible part of a picture as fractions of its size, so selection boxes
  // hug the art instead of see-through margins.
  function contentBox(img) {
    try {
      const W = img.naturalWidth || img.width || 256, H = img.naturalHeight || img.height || 256;
      const s = Math.min(1, 192 / Math.max(W, H));
      const w = Math.max(1, Math.round(W * s)), h = Math.max(1, Math.round(H * s));
      const c = makeCanvas(w, h);
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, w, h);
      const d = ctx.getImageData(0, 0, w, h).data;
      let x0 = w, y0 = h, x1 = -1, y1 = -1;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      if (x1 < 0) return null;
      // One sample of slack on each side.
      return { x: Math.max(0, (x0 - 1) / w), y: Math.max(0, (y0 - 1) / h), w: Math.min(1, (x1 - x0 + 3) / w), h: Math.min(1, (y1 - y0 + 3) / h) };
    } catch { return null; }
  }
  G.setImageBoxer((src) => { const rec = images.get(src); return rec && rec.ready ? rec.box : null; });

  function preloadImages(doc) {
    const waits = [];
    for (const l of doc.layers) for (const it of l.items) if (it.type === "image") waits.push(imageFor(it.src).promise);
    return Promise.all(waits);
  }

  function makeCanvas(w, h) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.ceil(w));
    c.height = Math.max(1, Math.ceil(h));
    return c;
  }

  function toPaint(ctx, p, it) {
    if (!p) return null;
    if (typeof p === "string") return p;
    const b = G.bounds(it);
    let g;
    if (p.type === "radial") {
      const cx = p.cx ?? b.x + b.w / 2, cy = p.cy ?? b.y + b.h / 2, r = p.r ?? Math.max(b.w, b.h) / 2;
      g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(0.1, r));
    } else {
      g = ctx.createLinearGradient(p.x1 ?? b.x, p.y1 ?? b.y, p.x2 ?? b.x, p.y2 ?? b.y + b.h);
    }
    for (const [o, c] of p.stops) { try { g.addColorStop(o, c); } catch {} }
    return g;
  }

  // Pressure to radius for each brush.
  function radiusAt(it, p) {
    const r = it.size / 2;
    if (it.brush === "marker" || it.brush === "airbrush" || it.brush === "watercolor") return r;
    if (it.brush === "pencil") return r * (0.75 + 0.25 * p);
    return r * (0.25 + 0.75 * p);
  }

  // The smooth centerline a stroke follows (each piece bends through its
  // point, midpoint to midpoint), sampled finely so the stroke can be painted
  // as one filled outline instead of many overlapping pieces, which left a
  // joint bump at every point. Each sample carries the index and param of the
  // piece it came from, so widths interpolate the way the old widths did.
  function strokeSpine(pts) {
    const seg = [{ x: pts[0][0], y: pts[0][1], dx: 0, dy: 0, i: 0, f: 0 }];
    let px = pts[0][0], py = pts[0][1];
    for (let i = 1; i < pts.length; i++) {
      const cx = pts[i][0], cy = pts[i][1];
      const nx = pts[i + 1];
      const mx = nx ? (cx + nx[0]) / 2 : cx, my = nx ? (cy + nx[1]) / 2 : cy;
      if (i === 1) { seg[0].dx = 2 * (cx - px); seg[0].dy = 2 * (cy - py); }
      // Sample each piece in proportion to its length: a few hundred px of
      // curve needs more than five chords or the edge reads faceted.
      const pieceLen = Math.hypot(mx - px, my - py) || Math.hypot(cx - px, cy - py);
      const K = Math.max(3, Math.min(16, Math.ceil(pieceLen / 6)));
      for (let k = 1; k <= K; k++) {
        const t = k / K, mt = 1 - t;
        seg.push({
          x: mt * mt * px + 2 * mt * t * cx + t * t * mx,
          y: mt * mt * py + 2 * mt * t * cy + t * t * my,
          dx: 2 * mt * (cx - px) + 2 * t * (mx - cx),
          dy: 2 * mt * (cy - py) + 2 * t * (my - cy),
          i, f: t,
        });
      }
      px = mx; py = my;
    }
    // A doubled point leaves a dead derivative: reuse the last real direction.
    for (let k = 1; k < seg.length; k++) if (!seg[k].dx && !seg[k].dy) { seg[k].dx = seg[k - 1].dx; seg[k].dy = seg[k - 1].dy; }
    return seg;
  }

  // Paints a variable-width stroke as one outline: down the left edge, around
  // a round cap at the end, back up the right edge, around the start. There
  // are no segment joints, so the silhouette stays one clean curve.
  function ribbon(ctx, spine, halfAt, opts) {
    const o = opts || {};
    const n = spine.length;
    if (!n) return;
    const dirAt = o.dirAt || ((s) => { const d = Math.hypot(s.dx, s.dy) || 1; return { x: -s.dy / d, y: s.dx / d }; });
    const L = new Array(n), R = new Array(n), W = new Array(n);
    for (let k = 0; k < n; k++) W[k] = Math.max(0.3, halfAt(spine[k]));
    // Where the spine bends tighter than the half-width, the inner edge would
    // cross the outer and leave an unfilled wedge or a knife point. Shrink the
    // width to just under the local turn radius so the edges can never cross.
    for (let k = 1; k < n - 1; k++) {
      const a = spine[k - 1], b = spine[k], c = spine[k + 1];
      const ang = Math.abs(Math.atan2(a.dx * c.dy - a.dy * c.dx, a.dx * c.dx + a.dy * c.dy));
      const ds = (Math.hypot(b.x - a.x, b.y - a.y) + Math.hypot(c.x - b.x, c.y - b.y)) / 2;
      if (ang > 1e-4 && ds > 0) { const r = ds / ang; if (r < W[k]) W[k] = Math.max(0.3, r * 0.95); }
    }
    for (let k = 0; k < n; k++) {
      const s = spine[k];
      const dir = dirAt(s), w = W[k];
      L[k] = [s.x - dir.x * w, s.y - dir.y * w];
      R[k] = [s.x + dir.x * w, s.y + dir.y * w];
    }
    // Direction the left edge leaves a spine point: the left normal's angle.
    const aL = (s) => { const d = Math.hypot(s.dx, s.dy); return d ? Math.atan2(s.dx / d, -s.dy / d) : 0; };
    ctx.beginPath();
    ctx.moveTo(L[0][0], L[0][1]);
    for (let k = 1; k < n; k++) ctx.lineTo(L[k][0], L[k][1]);
    if (!o.flatCaps) {
      const s = spine[n - 1], w = W[n - 1], a0 = aL(s);
      for (let k = 1; k <= 6; k++) { const a = a0 - (Math.PI * k) / 6; ctx.lineTo(s.x + w * Math.cos(a), s.y + w * Math.sin(a)); }
    } else ctx.lineTo(R[n - 1][0], R[n - 1][1]);
    for (let k = n - 1; k >= 0; k--) ctx.lineTo(R[k][0], R[k][1]);
    if (!o.flatCaps) {
      const s = spine[0], w = W[0], a0 = aL(s);
      for (let k = 1; k <= 6; k++) { const a = a0 + Math.PI - (Math.PI * k) / 6; ctx.lineTo(s.x + w * Math.cos(a), s.y + w * Math.sin(a)); }
    }
    ctx.closePath();
    ctx.fill();
  }

  // Strokes draw at full strength into a scratch canvas, then the result is
  // laid down once with the stroke's opacity, so overlapping segments do not
  // build up darker spots.
  function strokePath(ctx, it) {
    // Near-duplicate points collapse: a doubled point left a dead derivative
    // (a wedge start cap) or a real corner kink through the repeat.
    const pts = [it.points[0]];
    for (let k = 1; k < it.points.length; k++) {
      const p = it.points[k], q = pts[pts.length - 1];
      if (Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.01) pts.push(p);
      else pts[pts.length - 1] = p; // keep the last pressure of the run
    }
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (pts.length === 1) {
      const r = radiusAt(it, pts[0][2]);
      ctx.beginPath();
      ctx.arc(pts[0][0], pts[0][1], Math.max(0.3, r), 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    // Pressure at a spine sample: piece i is centered on point i, so its ends
    // carry the midpoint pressures of the points either side, not the points
    // themselves (which landed the peak half a segment late).
    const pressAt = (k) => pts[k][2] ?? 0.5;
    const midPress = (k) => (k === 0 ? pressAt(0) : k === pts.length - 1 ? pressAt(k) : (pressAt(k) + pressAt(k + 1)) / 2);
    const press = (s) => {
      const l = s.i <= 0 ? pressAt(0) : midPress(s.i - 1), r = midPress(s.i);
      return l + (r - l) * s.f;
    };
    if (it.brush === "calligraphy") {
      // A flat nib held at 45 degrees: the nib direction is constant, so the
      // stroke is one ribbon whose two edges sit nib-width apart along that
      // direction, with flat caps where the nib lifts. One polygon, so a bend
      // can never open a slit.
      ribbon(ctx, strokeSpine(pts), (s) => (it.size / 2) * (0.35 + 0.65 * press(s)), { dirAt: () => ({ x: Math.SQRT1_2, y: -Math.SQRT1_2 }), flatCaps: true });
      return;
    }
    if (it.brush === "marker" || it.brush === "airbrush" || it.brush === "watercolor") {
      // Washes keep their width along the body but each one ends differently:
      // the start and the end have their own taper length and tip width, and
      // the body swells a little, all fixed by the stroke's own points so a
      // redraw is identical. No two washes end in the same sausage shape.
      const full = it.brush === "airbrush" ? it.size * 0.6 : it.size;
      const along = [0];
      for (let i = 1; i < pts.length; i++) along.push(along[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      const total = along[along.length - 1] || 1;
      const last = pts[pts.length - 1];
      const rnd = (k) => { const v = Math.sin((pts[0][0] * 12.9898 + pts[0][1] * 78.233 + last[0] * 3.1 + last[1] * 7.7 + k * 37.719)) * 43758.5453; return v - Math.floor(v); };
      const headF = 0.06 + 0.16 * rnd(1), tailF = 0.16 + 0.3 * rnd(2);
      const headW = 0.4 + 0.4 * rnd(3), tailW = 0.1 + 0.25 * rnd(4);
      const swellN = 1.2 + 1.8 * rnd(5), swellP = rnd(6) * 6.283;
      const ease = (x) => x * x * (3 - 2 * x);
      const widthAt = (i) => {
        const f = along[i] / total;
        let w = 1;
        if (f < headF) w = headW + (1 - headW) * ease(f / headF);
        if (1 - f < tailF) w = Math.min(w, tailW + (1 - tailW) * ease((1 - f) / tailF));
        w *= 1 + 0.1 * Math.sin(f * Math.PI * swellN + swellP);
        // The last 2% runs to a point, so a tapered tail ends in a dry tip
        // instead of a little round bulb the cap would otherwise leave.
        if (1 - f < 0.02) w *= Math.max(0, (1 - f) / 0.02);
        return Math.max(0.08, full * w);
      };
      if (total < 1) { ctx.lineWidth = full; ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]); ctx.stroke(); return; }
      // Piece i is centered on point i, so its ends carry the midpoint widths
      // (same half-segment fix as the pen pressure below).
      const midWidth = (k) => (k === 0 ? widthAt(0) : k === pts.length - 1 ? widthAt(k) : (widthAt(k) + widthAt(k + 1)) / 2);
      ribbon(ctx, strokeSpine(pts), (s) => ((s.i <= 0 ? widthAt(0) : midWidth(s.i - 1)) * (1 - s.f) + midWidth(s.i) * s.f) / 2);
      if (it.brush !== "airbrush" && total > full * 3) {
        // Dry-brush tail: the last part of a long wash breaks into bristle
        // streaks, so the stroke ends in broken paint, not a clean point.
        const prev = ctx.globalCompositeOperation;
        ctx.globalCompositeOperation = "destination-out";
        ctx.lineCap = "butt";
        const nStreak = 3 + Math.floor(rnd(7) * 3);
        for (let k = 0; k < nStreak; k++) {
          const off = ((k + 0.5) / nStreak - 0.5 + (rnd(8 + k) - 0.5) * 0.12) * full * 0.8;
          const from = 0.68 + rnd(20 + k) * 0.14;
          ctx.lineWidth = Math.max(0.6, full * (0.04 + 0.05 * rnd(30 + k)));
          ctx.beginPath();
          let started = false;
          for (let i = 1; i < pts.length; i++) {
            if (along[i] / total < from) continue;
            // The streak must stay inside the local taper: scale its offset
            // by the width ratio here and stop once the stroke is narrower
            // than the bristle line, or it gashes through the edge.
            const w = widthAt(i);
            if (started && w < ctx.lineWidth * 1.6) break;
            const o = off * (w / full);
            const dx = pts[i][0] - pts[i - 1][0], dy = pts[i][1] - pts[i - 1][1], d = Math.hypot(dx, dy) || 1;
            const x = pts[i][0] - dy / d * o, y = pts[i][1] + dx / d * o;
            if (started) ctx.lineTo(x, y); else { ctx.moveTo(x, y); started = true; }
          }
          if (started) ctx.stroke();
        }
        ctx.globalCompositeOperation = prev;
        ctx.lineCap = "round";
      }
      return;
    }
    // Variable width: pressure interpolates along the stroke, one clean ribbon.
    ribbon(ctx, strokeSpine(pts), (s) => Math.max(0.25, radiusAt(it, press(s))));
  }

  function smoothPolygon(ctx, pts, closed) {
    const n = pts.length;
    const get = (i) => (closed ? pts[(i + n) % n] : pts[Math.max(0, Math.min(n - 1, i))]);
    ctx.moveTo(pts[0][0], pts[0][1]);
    const segs = closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
      const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
      const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
      ctx.bezierCurveTo(c1x, c1y, c2x, c2y, p2[0], p2[1]);
    }
    if (closed) ctx.closePath();
  }

  function dashFor(it) {
    const w = Math.max(1, it.strokeWidth || 1);
    // Round caps add half a width to each end, so the gaps are drawn wider.
    if (it.dash === "dashed") return [w * 2, w * 3];
    if (it.dash === "dotted") return [0.001, w * 2];
    return [];
  }

  function fillAndStroke(ctx, it, path) {
    const fill = toPaint(ctx, it.fill, it);
    const stroke = toPaint(ctx, it.stroke, it);
    if (fill) { ctx.fillStyle = fill; path ? ctx.fill(path) : ctx.fill(); }
    if (stroke && it.strokeWidth > 0) {
      // The shadow is cast once, by the fill.
      if (fill) ctx.shadowColor = "transparent";
      ctx.strokeStyle = stroke;
      ctx.lineWidth = it.strokeWidth;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.setLineDash(dashFor(it));
      path ? ctx.stroke(path) : ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // Filled arrowhead with its tip at (x, y), pointing along (dx, dy).
  function arrowHead(ctx, it, x, y, dx, dy) {
    const len = Math.hypot(dx, dy);
    if (!len) return;
    const ux = dx / len, uy = dy / len;
    const L = G.arrowSize(it), W = L * 0.55;
    ctx.save();
    ctx.setLineDash([]);
    ctx.fillStyle = toPaint(ctx, it.stroke, it) || "#000000";
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - ux * L - uy * W, y - uy * L + ux * W);
    ctx.lineTo(x - ux * L * 0.78, y - uy * L * 0.78);
    ctx.lineTo(x - ux * L + uy * W, y - uy * L - ux * W);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // Ends of an open line, with the direction it leaves each end.
  function lineEnds(it) {
    if (it.type === "line") return { a: [it.x1, it.y1], ad: [it.x1 - it.x2, it.y1 - it.y2], b: [it.x2, it.y2], bd: [it.x2 - it.x1, it.y2 - it.y1] };
    const p = it.points, n = p.length;
    return { a: p[0], ad: [p[0][0] - p[1][0], p[0][1] - p[1][1]], b: p[n - 1], bd: [p[n - 1][0] - p[n - 2][0], p[n - 1][1] - p[n - 2][1]] };
  }

  const pathCache = new Map();
  function path2d(d) {
    let p = pathCache.get(d);
    if (!p) {
      try { p = new Path2D(d); } catch { p = new Path2D(); }
      if (pathCache.size > 2000) pathCache.clear();
      pathCache.set(d, p);
    }
    return p;
  }

  // Rotation and mirroring around the item's center.
  function itemTransform(ctx, it) {
    if (!it.rotation && !it.flipX && !it.flipY) return;
    const b = G.bounds(it);
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    ctx.translate(cx, cy);
    if (it.rotation) ctx.rotate((it.rotation * Math.PI) / 180);
    if (it.flipX || it.flipY) ctx.scale(it.flipX ? -1 : 1, it.flipY ? -1 : 1);
    ctx.translate(-cx, -cy);
  }

  function applyItemState(ctx, it) {
    itemTransform(ctx, it);
    if (it.shadow) {
      ctx.shadowColor = it.shadow.color;
      ctx.shadowBlur = it.shadow.blur * (ctx.getTransform().a || 1);
      ctx.shadowOffsetX = it.shadow.x * (ctx.getTransform().a || 1);
      ctx.shadowOffsetY = it.shadow.y * (ctx.getTransform().a || 1);
    }
  }

  function drawArrows(ctx, it) {
    if (!it.arrowStart && !it.arrowEnd) return;
    ctx.shadowColor = "transparent";
    const e = lineEnds(it);
    if (it.arrowEnd) arrowHead(ctx, it, e.b[0], e.b[1], e.bd[0], e.bd[1]);
    if (it.arrowStart) arrowHead(ctx, it, e.a[0], e.a[1], e.ad[0], e.ad[1]);
  }

  // scratch: a canvas the same size as ctx's canvas, used by strokes.
  function drawItem(ctx, it, scratch) {
    ctx.save();
    const alpha = it.opacity ?? 1;
    if (it.type === "stroke") {
      drawStrokeItem(ctx, it, scratch, alpha);
      ctx.restore();
      return;
    }
    ctx.globalAlpha = alpha;
    if (it.blend) ctx.globalCompositeOperation = it.blend;
    applyItemState(ctx, it);
    switch (it.type) {
      case "rect":
        ctx.beginPath();
        if (it.radius) ctx.roundRect(it.x, it.y, it.w, it.h, Math.min(it.radius, it.w / 2, it.h / 2));
        else ctx.rect(it.x, it.y, it.w, it.h);
        fillAndStroke(ctx, it);
        break;
      case "ellipse":
        ctx.beginPath();
        ctx.ellipse(it.x + it.w / 2, it.y + it.h / 2, Math.max(0.1, it.w / 2), Math.max(0.1, it.h / 2), 0, 0, Math.PI * 2);
        fillAndStroke(ctx, it);
        break;
      case "line": {
        // Stop the line short of an arrowhead so its round cap stays hidden.
        let { x1, y1, x2, y2 } = it;
        const len = Math.hypot(x2 - x1, y2 - y1) || 1;
        const cut = Math.min(len / 3, G.arrowSize(it) * 0.7);
        if (it.arrowEnd) { x2 -= ((x2 - x1) / len) * cut; y2 -= ((y2 - y1) / len) * cut; }
        if (it.arrowStart) { x1 += ((it.x2 - x1) / len) * cut; y1 += ((it.y2 - y1) / len) * cut; }
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        fillAndStroke(ctx, Object.assign({}, it, { fill: null }));
        drawArrows(ctx, it);
        break;
      }
      case "polygon":
        ctx.beginPath();
        if (it.smooth && it.points.length > 2) smoothPolygon(ctx, it.points, it.closed);
        else {
          ctx.moveTo(it.points[0][0], it.points[0][1]);
          for (let i = 1; i < it.points.length; i++) ctx.lineTo(it.points[i][0], it.points[i][1]);
          if (it.closed) ctx.closePath();
        }
        fillAndStroke(ctx, it);
        if (!it.closed) drawArrows(ctx, it);
        break;
      case "path": {
        ctx.translate(it.x || 0, it.y || 0);
        if (it.scale) ctx.scale(it.scale, it.scale);
        const local = Object.assign({}, it);
        if (it.scale) local.strokeWidth = it.strokeWidth / it.scale;
        fillAndStroke(ctx, local, path2d(it.d));
        break;
      }
      case "text": {
        ctx.font = `${it.weight || 600} ${it.size}px ${it.font}`;
        ctx.textAlign = it.align || "left";
        ctx.textBaseline = "alphabetic";
        const lines = it.text.split("\n");
        lines.forEach((line, i) => {
          const y = it.y + i * it.size * 1.2;
          if (it.fill) { ctx.fillStyle = toPaint(ctx, it.fill, it); ctx.fillText(line, it.x, y); }
          if (it.stroke && it.strokeWidth) { ctx.shadowColor = "transparent"; ctx.strokeStyle = toPaint(ctx, it.stroke, it); ctx.lineWidth = it.strokeWidth; ctx.lineJoin = "round"; ctx.strokeText(line, it.x, y); }
        });
        break;
      }
      case "image": {
        const rec = imageFor(it.src);
        if (rec.ready) ctx.drawImage(rec.img, it.x, it.y, it.w, it.h);
        break;
      }
    }
    ctx.restore();
  }

  function rgbOf(c) {
    if (typeof c !== "string") return null;
    let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim());
    if (m) { let h = m[1]; if (h.length === 3) h = h.replace(/./g, (ch) => ch + ch); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); }
    m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(c);
    return m ? [+m[1], +m[2], +m[3]] : null;
  }
  function lum(c) { const v = rgbOf(c); return v ? (0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]) / 255 : 0.5; }
  function shade(c, k) { const v = rgbOf(c); return v ? "rgb(" + v.map((x) => Math.round(x * k)).join(",") + ")" : null; }

  function drawStrokeItem(ctx, it, scratch, alpha) {
    const t = ctx.getTransform();
    const b = G.bounds(it);
    // Device-space box of the stroke, clipped to the canvas.
    // The cleared region must cover what the blur filter samples, not just
    // the drawn box: an airbrush blur reads ~3x its radius plus its shadow
    // outside the box, and old pixels there leak back in as a fringe.
    const reach = it.brush === "airbrush" ? Math.ceil(it.size * t.a * 1.4) : it.brush === "watercolor" ? Math.ceil(it.size * t.a * 0.3) : 0;
    const pad = 4 + reach + (it.shadow ? it.shadow.blur * 2 : 0);
    const x0 = Math.max(0, Math.floor(b.x * t.a + t.e - pad));
    const y0 = Math.max(0, Math.floor(b.y * t.d + t.f - pad));
    const x1 = Math.min(ctx.canvas.width, Math.ceil((b.x + b.w) * t.a + t.e + pad));
    const y1 = Math.min(ctx.canvas.height, Math.ceil((b.y + b.h) * t.d + t.f + pad));
    if (x1 <= x0 || y1 <= y0) return;
    const sc = scratch.getContext("2d");
    sc.setTransform(1, 0, 0, 1, 0, 0);
    sc.clearRect(x0, y0, x1 - x0, y1 - y0);
    sc.save();
    sc.setTransform(t);
    itemTransform(sc, it);
    sc.fillStyle = it.color;
    sc.strokeStyle = it.color;
    if (it.brush === "airbrush") {
      sc.shadowColor = it.color;
      sc.shadowBlur = it.size * 0.8 * t.a;
      sc.filter = `blur(${Math.max(0.5, it.size * 0.18 * t.a)}px)`;
    }
    if (it.brush === "watercolor") sc.filter = `blur(${Math.max(0.6, it.size * 0.07 * t.a)}px)`;
    if (it.brush === "watercolor") {
      // Pigment pools at the edge of a wet wash: a darker full-width pass
      // under a lighter, narrower one leaves a deeper rim.
      const rim = shade(it.color, 0.82);
      if (rim) {
        sc.strokeStyle = rim; sc.fillStyle = rim;
        strokePath(sc, it);
        sc.strokeStyle = it.color; sc.fillStyle = it.color;
        strokePath(sc, { ...it, size: it.size * 0.7 });
      } else strokePath(sc, it);
    } else strokePath(sc, it);
    sc.restore();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    let a = alpha;
    if (it.brush === "marker") a *= 0.6;
    if (it.brush === "pencil") a *= 0.88;
    if (it.brush === "airbrush") a *= 0.55;
    if (it.brush === "watercolor") a *= 0.5;
    // Washes multiply so passes darken where they overlap and build up. A
    // light wash (cloud, glint) stays source-over so it can still lighten.
    const wash = it.brush === "marker" || it.brush === "watercolor" || it.brush === "airbrush";
    const lightWash = wash && lum(it.color) > 0.72;
    if (it.brush === "airbrush" && !lightWash) a = Math.min(1, a * 1.25);
    ctx.globalAlpha = a;
    ctx.globalCompositeOperation = it.brush === "eraser" ? "destination-out" : it.blend || (wash && !lightWash ? "multiply" : "source-over");
    ctx.drawImage(scratch, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
  }

  function renderLayer(target, layer, scale, scratch, extra) {
    const ctx = target.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, target.width, target.height);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    const hidden = extra && extra.hiddenIds;
    const override = extra && extra.override;
    for (const raw of layer.items) {
      if (hidden && hidden.has(raw.id)) continue;
      const it = override && override.has(raw.id) ? override.get(raw.id) : raw;
      drawItem(ctx, it, scratch);
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
    }
  }

  // A renderer keeps one canvas per layer and only redraws layers that
  // changed since the last frame.
  class DocRenderer {
    constructor() {
      this.layerCanvases = new Map(); // layerId -> { canvas, key }
      this.scale = 1;
      this.scratch = null;
      this.composite = null;
      this.tmp = null;
    }

    ensureSize(doc, scale) {
      const w = Math.ceil(doc.width * scale), h = Math.ceil(doc.height * scale);
      if (!this.composite || this.composite.width !== w || this.composite.height !== h || this.scale !== scale) {
        this.scale = scale;
        this.composite = makeCanvas(w, h);
        this.scratch = makeCanvas(w, h);
        this.tmp = makeCanvas(w, h);
        this.layerCanvases.clear();
      }
    }

    layerCanvas(layer, extra) {
      if (!this.keys) this.keys = new WeakMap();
      let base = this.keys.get(layer.items);
      if (base === undefined) {
        base = JSON.stringify(layer.items);
        this.keys.set(layer.items, base);
      }
      const useExtra = extra && extra.layerIds && extra.layerIds.has(layer.id);
      const key = base + (useExtra ? "|" + extra.key : "");
      let rec = this.layerCanvases.get(layer.id);
      if (!rec) {
        rec = { canvas: makeCanvas(this.composite.width, this.composite.height), key: null };
        this.layerCanvases.set(layer.id, rec);
      }
      if (rec.key !== key) {
        renderLayer(rec.canvas, layer, this.scale, this.scratch, useExtra ? extra : null);
        rec.key = key;
      }
      return rec.canvas;
    }

    invalidate() {
      for (const rec of this.layerCanvases.values()) rec.key = null;
    }

    // live: { layerId, item } a stroke still being drawn.
    // extra: { layerId, key, hiddenIds, override } for drag previews.
    compose(doc, opts) {
      const o = opts || {};
      this.ensureSize(doc, o.scale || 1);
      const ctx = this.composite.getContext("2d");
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      ctx.clearRect(0, 0, this.composite.width, this.composite.height);
      if (!o.transparent) {
        ctx.fillStyle = doc.background || "#ffffff";
        ctx.fillRect(0, 0, this.composite.width, this.composite.height);
      }
      for (const layer of doc.layers) {
        if (layer.visible === false || (o.onlyLayer && layer.id !== o.onlyLayer)) continue;
        let src = this.layerCanvas(layer, o.extra);
        if (o.live && o.live.layerId === layer.id) {
          const t = this.tmp.getContext("2d");
          t.setTransform(1, 0, 0, 1, 0, 0);
          t.globalAlpha = 1;
          t.globalCompositeOperation = "copy";
          t.drawImage(src, 0, 0);
          t.globalCompositeOperation = "source-over";
          for (const it of [o.live.item, ...(o.live.more || [])]) {
            t.setTransform(this.scale, 0, 0, this.scale, 0, 0);
            drawItem(t, it, this.scratch);
          }
          src = this.tmp;
        }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = layer.opacity ?? 1;
        ctx.globalCompositeOperation = layer.blend || "source-over";
        ctx.drawImage(src, 0, 0);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      return this.composite;
    }
  }

  // One-off render to a new canvas, waiting for images. Used for exports,
  // thumbnails and for showing the agent the drawing.
  // ids: only draw these items. crop: {x, y, w, h} in canvas pixels.
  async function renderToCanvas(doc, opts) {
    const o = opts || {};
    if (o.ids) {
      const ids = o.ids instanceof Set ? o.ids : new Set(o.ids);
      doc = Object.assign({}, doc, { layers: doc.layers.map((l) => Object.assign({}, l, { items: l.items.filter((it) => ids.has(it.id)) })) });
    }
    await preloadImages(doc);
    const scale = o.scale || 1;
    const r = new DocRenderer();
    const c = r.compose(doc, { scale, transparent: o.transparent, onlyLayer: o.onlyLayer });
    if (!o.crop) return c;
    const out = makeCanvas(o.crop.w * scale, o.crop.h * scale);
    out.getContext("2d").drawImage(c, -o.crop.x * scale, -o.crop.y * scale);
    return out;
  }

  window.JRender = {
    DocRenderer,
    drawItem,
    renderToCanvas,
    preloadImages,
    makeCanvas,
    dashFor,
    set onImageReady(fn) { onImageReady = fn; },
  };
})();
