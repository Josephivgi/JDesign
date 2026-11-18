// Turns a JDraw document (or some of its items) into SVG markup that looks
// like the canvas: gradients, shadows, blend modes, rotation, mirroring and
// erasers (as masks over what was drawn before them on the layer).
(function () {
  const G = window.JGeom;
  const n = (v) => String(Math.round(v * 100) / 100);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  function color(c) {
    const h = G.normColor(c) || "#000000";
    if (h.length === 9) {
      const { r, g, b, a } = G.hexToRgb(h);
      return `rgba(${r},${g},${b},${n(a)})`;
    }
    return h;
  }

  function toSvg(doc, opts) {
    const o = opts || {};
    const ids = o.ids ? new Set(o.ids) : null;
    const box = o.crop || { x: 0, y: 0, w: doc.width, h: doc.height };
    const defs = [];
    let seq = 0;
    const id = (p) => `${p}${++seq}`;

    function paint(p, it) {
      if (!p) return "none";
      if (typeof p === "string") return color(p);
      const b = G.bounds(it);
      const gid = id("g");
      const stops = p.stops.map(([off, c]) => `<stop offset="${n(off)}" stop-color="${color(c)}"/>`).join("");
      if (p.type === "radial") {
        const cx = p.cx ?? b.x + b.w / 2, cy = p.cy ?? b.y + b.h / 2, r = p.r ?? Math.max(b.w, b.h) / 2;
        defs.push(`<radialGradient id="${gid}" gradientUnits="userSpaceOnUse" cx="${n(cx)}" cy="${n(cy)}" r="${n(Math.max(0.1, r))}">${stops}</radialGradient>`);
      } else {
        defs.push(`<linearGradient id="${gid}" gradientUnits="userSpaceOnUse" x1="${n(p.x1 ?? b.x)}" y1="${n(p.y1 ?? b.y)}" x2="${n(p.x2 ?? b.x)}" y2="${n(p.y2 ?? b.y + b.h)}">${stops}</linearGradient>`);
      }
      return `url(#${gid})`;
    }

    function common(it, extraAlpha) {
      const a = [];
      const alpha = (it.opacity ?? 1) * (extraAlpha ?? 1);
      if (alpha < 1) a.push(`opacity="${n(alpha)}"`);
      const style = [];
      if (it.blend && it.blend !== "source-over") style.push(`mix-blend-mode:${it.blend}`);
      if (style.length) a.push(`style="${style.join(";")}"`);
      if (it.shadow) {
        const fid = id("f");
        defs.push(`<filter id="${fid}" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="${n(it.shadow.x)}" dy="${n(it.shadow.y)}" stdDeviation="${n(it.shadow.blur / 2)}" flood-color="${color(it.shadow.color)}"/></filter>`);
        a.push(`filter="url(#${fid})"`);
      }
      if (it.rotation || it.flipX || it.flipY) {
        const c = G.center(it);
        a.push(`transform="translate(${n(c.x)} ${n(c.y)})${it.rotation ? ` rotate(${n(it.rotation)})` : ""}${it.flipX || it.flipY ? ` scale(${it.flipX ? -1 : 1} ${it.flipY ? -1 : 1})` : ""} translate(${n(-c.x)} ${n(-c.y)})"`);
      }
      return a.join(" ");
    }

    function fillStroke(it) {
      const a = [`fill="${paint(it.fill, it)}"`];
      if (it.stroke && it.strokeWidth > 0) {
        a.push(`stroke="${paint(it.stroke, it)}" stroke-width="${n(it.strokeWidth)}" stroke-linecap="round" stroke-linejoin="round"`);
        const dash = JRender.dashFor(it);
        if (dash.length) a.push(`stroke-dasharray="${dash.map(n).join(" ")}"`);
      }
      return a.join(" ");
    }

    function arrows(it) {
      if (!it.arrowStart && !it.arrowEnd) return "";
      const L = G.arrowSize(it), W = L * 0.55;
      const head = (x, y, dx, dy) => {
        const len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
        const p = [[x, y], [x - ux * L - uy * W, y - uy * L + ux * W], [x - ux * L * 0.78, y - uy * L * 0.78], [x - ux * L + uy * W, y - uy * L - ux * W]];
        return `<path d="M${p.map((q) => n(q[0]) + " " + n(q[1])).join("L")}Z" fill="${paint(it.stroke, it)}"/>`;
      };
      let ends;
      if (it.type === "line") ends = { a: [it.x1, it.y1], ad: [it.x1 - it.x2, it.y1 - it.y2], b: [it.x2, it.y2], bd: [it.x2 - it.x1, it.y2 - it.y1] };
      else { const p = it.points, k = p.length; ends = { a: p[0], ad: [p[0][0] - p[1][0], p[0][1] - p[1][1]], b: p[k - 1], bd: [p[k - 1][0] - p[k - 2][0], p[k - 1][1] - p[k - 2][1]] }; }
      return (it.arrowEnd ? head(ends.b[0], ends.b[1], ends.bd[0], ends.bd[1]) : "") + (it.arrowStart ? head(ends.a[0], ends.a[1], ends.ad[0], ends.ad[1]) : "");
    }

    function smoothD(pts, closed) {
      const k = pts.length;
      const get = (i) => (closed ? pts[(i + k) % k] : pts[Math.max(0, Math.min(k - 1, i))]);
      let d = `M${n(pts[0][0])} ${n(pts[0][1])}`;
      for (let i = 0; i < (closed ? k : k - 1); i++) {
        const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
        d += `C${n(p1[0] + (p2[0] - p0[0]) / 6)} ${n(p1[1] + (p2[1] - p0[1]) / 6)} ${n(p2[0] - (p3[0] - p1[0]) / 6)} ${n(p2[1] - (p3[1] - p1[1]) / 6)} ${n(p2[0])} ${n(p2[1])}`;
      }
      return d + (closed ? "Z" : "");
    }

    function radiusAt(it, p) {
      const r = it.size / 2;
      if (it.brush === "marker" || it.brush === "airbrush" || it.brush === "watercolor") return r;
      if (it.brush === "pencil") return r * (0.75 + 0.25 * p);
      return r * (0.25 + 0.75 * p);
    }

    // Freehand stroke body, painted in col (black inside eraser masks).
    function strokeBody(it, col) {
      const pts = it.points;
      if (pts.length === 1) return `<circle cx="${n(pts[0][0])}" cy="${n(pts[0][1])}" r="${n(Math.max(0.3, radiusAt(it, pts[0][2])))}" fill="${col}"/>`;
      if (it.brush === "calligraphy") {
        const k = Math.SQRT1_2;
        let s = "";
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i - 1], b = pts[i];
          const ra = it.size / 2 * (0.35 + 0.65 * a[2]), rb = it.size / 2 * (0.35 + 0.65 * b[2]);
          s += `M${n(a[0] - k * ra)} ${n(a[1] + k * ra)}L${n(a[0] + k * ra)} ${n(a[1] - k * ra)}L${n(b[0] + k * rb)} ${n(b[1] - k * rb)}L${n(b[0] - k * rb)} ${n(b[1] + k * rb)}Z`;
        }
        return `<path d="${s}" fill="${col}" stroke="${col}" stroke-width="${n(Math.max(0.6, it.size * 0.06))}" stroke-linejoin="round"/>`;
      }
      if (it.brush === "marker" || it.brush === "airbrush" || it.brush === "watercolor") {
        let d = `M${n(pts[0][0])} ${n(pts[0][1])}`;
        for (let i = 1; i < pts.length - 1; i++) d += `Q${n(pts[i][0])} ${n(pts[i][1])} ${n((pts[i][0] + pts[i + 1][0]) / 2)} ${n((pts[i][1] + pts[i + 1][1]) / 2)}`;
        const last = pts[pts.length - 1];
        d += `L${n(last[0])} ${n(last[1])}`;
        return `<path d="${d}" fill="none" stroke="${col}" stroke-width="${n(it.brush === "airbrush" ? it.size * 0.6 : it.size)}" stroke-linecap="round" stroke-linejoin="round"/>`;
      }
      // Variable width: one short curve per point, like the canvas.
      let s = "";
      let px = pts[0][0], py = pts[0][1];
      for (let i = 1; i < pts.length; i++) {
        const cur = pts[i], next = pts[i + 1];
        const mx = next ? (cur[0] + next[0]) / 2 : cur[0], my = next ? (cur[1] + next[1]) / 2 : cur[1];
        s += `<path d="M${n(px)} ${n(py)}Q${n(cur[0])} ${n(cur[1])} ${n(mx)} ${n(my)}" stroke-width="${n(Math.max(0.5, radiusAt(it, cur[2]) * 2))}"/>`;
        px = mx; py = my;
      }
      return `<g fill="none" stroke="${col}" stroke-linecap="round">${s}</g>`;
    }

    function strokeSvg(it) {
      let extra = 1, style = "";
      if (it.brush === "marker") { extra = 0.6; style = "multiply"; }
      if (it.brush === "pencil") extra = 0.88;
      if (it.brush === "airbrush") extra = 0.55;
      if (it.brush === "watercolor") { extra = 0.5; style = "multiply"; }
      const view = Object.assign({}, it, style && !it.blend ? { blend: style } : {});
      let filter = "";
      if (it.brush === "airbrush" || it.brush === "watercolor") {
        const fid = id("b");
        defs.push(`<filter id="${fid}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${n(Math.max(0.5, it.size * (it.brush === "airbrush" ? 0.3 : 0.07)))}"/></filter>`);
        filter = ` filter="url(#${fid})"`;
      }
      return `<g ${common(view, extra)}${filter}>${strokeBody(it, color(it.color))}</g>`;
    }

    function itemSvg(it) {
      const c = common(it);
      switch (it.type) {
        case "stroke": return strokeSvg(it);
        case "rect": return `<rect x="${n(it.x)}" y="${n(it.y)}" width="${n(it.w)}" height="${n(it.h)}"${it.radius ? ` rx="${n(Math.min(it.radius, it.w / 2, it.h / 2))}"` : ""} ${fillStroke(it)} ${c}/>`;
        case "ellipse": return `<ellipse cx="${n(it.x + it.w / 2)}" cy="${n(it.y + it.h / 2)}" rx="${n(Math.max(0.1, it.w / 2))}" ry="${n(Math.max(0.1, it.h / 2))}" ${fillStroke(it)} ${c}/>`;
        case "line": {
          let { x1, y1, x2, y2 } = it;
          const len = Math.hypot(x2 - x1, y2 - y1) || 1, cut = Math.min(len / 3, G.arrowSize(it) * 0.7);
          if (it.arrowEnd) { x2 -= ((it.x2 - it.x1) / len) * cut; y2 -= ((it.y2 - it.y1) / len) * cut; }
          if (it.arrowStart) { x1 += ((it.x2 - it.x1) / len) * cut; y1 += ((it.y2 - it.y1) / len) * cut; }
          return `<g ${c}><line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" ${fillStroke(Object.assign({}, it, { fill: null }))}/>${arrows(it)}</g>`;
        }
        case "polygon": {
          const d = it.smooth && it.points.length > 2 ? smoothD(it.points, it.closed) : `M${it.points.map((p) => n(p[0]) + " " + n(p[1])).join("L")}${it.closed ? "Z" : ""}`;
          return `<g ${c}><path d="${d}" ${fillStroke(it)}/>${it.closed ? "" : arrows(it)}</g>`;
        }
        case "path": {
          const s = it.scale || 1;
          const local = Object.assign({}, it, { strokeWidth: (it.strokeWidth || 0) / s });
          return `<g ${c}><path d="${esc(it.d)}" transform="translate(${n(it.x || 0)} ${n(it.y || 0)}) scale(${n(s)})" ${fillStroke(local)}/></g>`;
        }
        case "text": {
          const anchor = it.align === "center" ? "middle" : it.align === "right" ? "end" : "start";
          const lines = it.text.split("\n").map((l, i) => `<tspan x="${n(it.x)}" y="${n(it.y + i * it.size * 1.2)}">${esc(l)}</tspan>`).join("");
          const st = it.stroke && it.strokeWidth ? ` stroke="${paint(it.stroke, it)}" stroke-width="${n(it.strokeWidth)}" stroke-linejoin="round" paint-order="stroke"` : "";
          return `<text font-family="${esc(it.font)}" font-size="${n(it.size)}" font-weight="${esc(it.weight || 600)}" text-anchor="${anchor}" fill="${paint(it.fill, it)}"${st} xml:space="preserve" ${c}>${lines}</text>`;
        }
        case "image": return `<image href="${it.src}" x="${n(it.x)}" y="${n(it.y)}" width="${n(it.w)}" height="${n(it.h)}" preserveAspectRatio="none" ${c}/>`;
      }
      return "";
    }

    const layersOut = [];
    for (const layer of doc.layers) {
      if (layer.visible === false) continue;
      let parts = [];
      for (const it of layer.items) {
        if (ids && !ids.has(it.id)) continue;
        if (it.type === "stroke" && it.brush === "eraser") {
          if (!parts.length) continue;
          const mid = id("m");
          const er = Object.assign({}, it, { brush: "pen" });
          defs.push(`<mask id="${mid}" maskUnits="userSpaceOnUse" x="${-doc.width}" y="${-doc.height}" width="${doc.width * 3}" height="${doc.height * 3}"><rect x="${-doc.width}" y="${-doc.height}" width="${doc.width * 3}" height="${doc.height * 3}" fill="#fff"/><g ${common(Object.assign({}, it, { opacity: 1, blend: null, shadow: null }))}>${strokeBody(er, "#000")}</g></mask>`);
          parts = [`<g mask="url(#${mid})">${parts.join("")}</g>`];
          continue;
        }
        parts.push(itemSvg(it));
      }
      if (!parts.length) continue;
      const la = [];
      if ((layer.opacity ?? 1) < 1) la.push(`opacity="${n(layer.opacity)}"`);
      if (layer.blend && layer.blend !== "source-over") la.push(`style="mix-blend-mode:${layer.blend}"`);
      layersOut.push(`<g data-layer="${esc(layer.name)}" ${la.join(" ")}>${parts.join("")}</g>`);
    }
    const bg = !o.transparent && doc.background && G.hexToRgb(doc.background).a > 0
      ? `<rect x="${n(box.x)}" y="${n(box.y)}" width="${n(box.w)}" height="${n(box.h)}" fill="${color(doc.background)}"/>`
      : "";
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${n(box.w)}" height="${n(box.h)}" viewBox="${n(box.x)} ${n(box.y)} ${n(box.w)} ${n(box.h)}">` +
      (defs.length ? `<defs>${defs.join("")}</defs>` : "") +
      `${bg}<g style="isolation:isolate">${layersOut.join("")}</g></svg>`;
  }

  window.JSvg = { toSvg };
})();
