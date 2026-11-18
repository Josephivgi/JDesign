// The drawing surface: view (pan, zoom, rotate), tools and pointer input.
(function () {
  const G = window.JGeom;
  const { DocRenderer, renderToCanvas } = window.JRender;

  const MIN_ZOOM = 0.05, MAX_ZOOM = 32;
  const RULER = 18; // ruler thickness in screen pixels
  const EFFECT_BRUSHES = ["smudge", "blur"];

  class CanvasView {
    constructor(stage, host) {
      this.stage = stage;
      this.host = host; // { getDoc, activeLayer(), apply(ops), onSelection(ids), onZoom(s), onColorPicked(c), toast, onView() }
      this.canvas = document.createElement("canvas");
      this.canvas.className = "view";
      this.canvas.setAttribute("aria-label", "Drawing canvas");
      stage.prepend(this.canvas);
      this.ctx = this.canvas.getContext("2d");
      this.renderer = new DocRenderer();
      this.view = { x: 0, y: 0, s: 1, r: 0 }; // r: view rotation in radians
      this.renderScale = 1;
      this.tool = "brush";
      this.brush = { color: "#1f1f24", size: 8, opacity: 1, brush: "pen", steady: 0.45, textSize: 48 };
      this.shapeKind = "rect";
      this.shapeFill = false;
      this.shapeSides = 6;
      this.starPoints = 5;
      this.lineDash = "solid"; // solid | dashed | dotted
      this.paintMode = "solid"; // solid | linear | radial
      this.color2 = "#ffffff";
      this.fill = { tolerance: 48, gap: 0, sample: "all" };
      this.symmetry = "off"; // off | v | h | both
      this.selectMode = "box"; // box | lasso
      this.grid = { show: false, snap: false, size: 50 };
      this.rulers = false;
      this.selection = new Set();
      this.live = null; // { layerId, item, more? }
      this.extra = null; // drag preview
      this.pointer = null; // screen position for the brush cursor
      this.spaceDown = false;
      this.gesture = null;
      this._raf = 0;
      this._resize = new ResizeObserver(() => this.resize());
      this._resize.observe(stage);
      JRender.onImageReady = () => { this.renderer.invalidate(); this.requestDraw(); };
      this.bind();
    }

    destroy() {
      this._resize.disconnect();
      cancelAnimationFrame(this._raf);
      clearTimeout(this._scaleTimer);
      window.removeEventListener("keydown", this._onKeyDown, true);
      window.removeEventListener("keyup", this._onKeyUp, true);
      this.canvas.remove();
    }

    get doc() { return this.host.getDoc(); }

    resize() {
      const r = this.stage.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      this.cssW = r.width; this.cssH = r.height;
      this.canvas.width = Math.max(1, Math.round(r.width * dpr));
      this.canvas.height = Math.max(1, Math.round(r.height * dpr));
      // Keep the paper fitted while the layout settles (panels opening,
      // window resizing) until the person zooms or pans themselves.
      if ((!this._fitted || this._autoFit) && r.width > 50) { this._fitted = true; this.fit(); }
      else this.keepPaperInView();
      this.requestDraw();
    }

    fit() {
      const d = this.doc;
      if (!d || !this.cssW) return;
      const padL = 84, padT = 32 + (this.rulers ? RULER : 0), padB = 100;
      const padR = (this.host.rightInset && this.host.rightInset()) || 32;
      const a = Math.abs(Math.cos(this.view.r)), b = Math.abs(Math.sin(this.view.r));
      const availW = this.cssW - padL - padR, availH = this.cssH - padT - padB;
      const s = Math.min(availW / (d.width * a + d.height * b), availH / (d.width * b + d.height * a));
      this.view.s = G.clamp(s, MIN_ZOOM, MAX_ZOOM);
      // Put the paper's center in the middle of the free area.
      const cx = padL + availW / 2, cy = padT + availH / 2;
      const [rx, ry] = this.rot((d.width * this.view.s) / 2, (d.height * this.view.s) / 2);
      this.view.x = cx - rx;
      this.view.y = cy - ry;
      this._autoFit = true;
      this.afterZoom();
    }

    zoomAt(factor, sx, sy) {
      const s0 = this.view.s;
      const s1 = G.clamp(s0 * factor, MIN_ZOOM, MAX_ZOOM);
      if (sx === undefined) { sx = this.cssW / 2; sy = this.cssH / 2; }
      this._autoFit = false;
      this.view.x = sx - (sx - this.view.x) * (s1 / s0);
      this.view.y = sy - (sy - this.view.y) * (s1 / s0);
      this.view.s = s1;
      this.afterZoom();
    }

    setZoom(s) { this.zoomAt(s / this.view.s); }

    // Turns the view around the middle of the screen. deg is added to the
    // current angle unless absolute is set.
    rotateView(deg, absolute) {
      const cx = this.cssW / 2, cy = this.cssH / 2;
      const dp = this.toDoc(cx, cy);
      let r = absolute ? (deg * Math.PI) / 180 : this.view.r + (deg * Math.PI) / 180;
      r = Math.atan2(Math.sin(r), Math.cos(r));
      if (Math.abs(r) < 1e-6) r = 0;
      this.view.r = r;
      const [fx, fy] = this.rot(dp.x * this.view.s, dp.y * this.view.s);
      this.view.x = cx - fx;
      this.view.y = cy - fy;
      this._autoFit = false;
      this.afterZoom();
    }

    viewDegrees() { return Math.round((this.view.r * 180) / Math.PI); }

    // Panning and zooming can never push the paper off screen: at least
    // KEEP px of it (or all of it, when smaller) stays in the free area
    // between the tool rail and the layers card.
    keepPaperInView() {
      const d = this.doc;
      if (!d || !this.cssW) return;
      const KEEP = 160;
      const pts = [[0, 0], [d.width, 0], [0, d.height], [d.width, d.height]].map(([x, y]) => this.toScreen(x, y));
      const minX = Math.min(...pts.map((p) => p.x)), maxX = Math.max(...pts.map((p) => p.x));
      const minY = Math.min(...pts.map((p) => p.y)), maxY = Math.max(...pts.map((p) => p.y));
      const left = 72, top = 8;
      const right = this.cssW - ((this.host.rightInset && this.host.rightInset()) || 32);
      // Stay clear of the floating dock at the bottom.
      const dock = this.stage.querySelector(".dock");
      const stageTop = this.stage.getBoundingClientRect().top;
      const dockTop = dock && dock.offsetHeight ? dock.getBoundingClientRect().top - stageTop : this.cssH;
      const bottom = Math.max(top + 120, Math.min(this.cssH, dockTop) - 8);
      const kx = Math.min(KEEP, maxX - minX, right - left), ky = Math.min(KEEP, maxY - minY, bottom - top);
      let dx = 0, dy = 0;
      if (maxX < left + kx) dx = left + kx - maxX;
      else if (minX > right - kx) dx = right - kx - minX;
      if (maxY < top + ky) dy = top + ky - maxY;
      else if (minY > bottom - ky) dy = bottom - ky - minY;
      this.view.x += dx;
      this.view.y += dy;
    }

    afterZoom() {
      this.keepPaperInView();
      this.host.onZoom && this.host.onZoom(this.view.s);
      this.positionTextEntry();
      clearTimeout(this._scaleTimer);
      this._scaleTimer = setTimeout(() => this.pickRenderScale(), 160);
      this.requestDraw();
    }

    // Render the layers near screen resolution, within memory limits.
    pickRenderScale() {
      const d = this.doc;
      if (!d) return;
      const dpr = window.devicePixelRatio || 1;
      let s = Math.min(2, Math.max(0.25, this.view.s * dpr));
      const maxSide = 8192, maxPx = 40e6;
      s = Math.min(s, maxSide / d.width, maxSide / d.height, Math.sqrt(maxPx / (d.width * d.height)));
      s = Math.round(s * 8) / 8 || 0.125;
      if (s !== this.renderScale) { this.renderScale = s; this.requestDraw(); }
    }

    // ---------- coordinates
    // Screen: CSS pixels in the stage. Frame: screen pixels in the rotated
    // paper frame (doc * zoom), where overlays are drawn. Doc: canvas pixels.
    rot(x, y, inv) {
      const r = inv ? -this.view.r : this.view.r;
      if (!r) return [x, y];
      const c = Math.cos(r), s = Math.sin(r);
      return [x * c - y * s, x * s + y * c];
    }
    toFrame(sx, sy) { const [x, y] = this.rot(sx - this.view.x, sy - this.view.y, true); return { x, y }; }
    toDoc(sx, sy) { const f = this.toFrame(sx, sy); return { x: f.x / this.view.s, y: f.y / this.view.s }; }
    toScreen(x, y) { const [fx, fy] = this.rot(x * this.view.s, y * this.view.s); return { x: fx + this.view.x, y: fy + this.view.y }; }
    frameToScreen(f) { const [x, y] = this.rot(f.x, f.y); return { x: x + this.view.x, y: y + this.view.y }; }

    snap(p) {
      if (!this.grid.snap) return p;
      const g = this.grid.size;
      return { x: Math.round(p.x / g) * g, y: Math.round(p.y / g) * g };
    }

    requestDraw() {
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => { this._raf = 0; this.draw(); });
    }

    docChanged(prev, origin) {
      if (this.livePending && !(this.gesture && this.gesture.kind === "stroke")) { this.live = null; this.livePending = false; }
      if (this.hover && !G.findItem(this.doc, this.hover)) this.hover = null;
      // Drop selected ids that no longer exist.
      const ids = new Set(this.doc.layers.flatMap((l) => l.items.map((i) => i.id)));
      let changed = false;
      for (const id of [...this.selection]) if (!ids.has(id)) { this.selection.delete(id); changed = true; }
      if (changed) this.host.onSelection([...this.selection]);
      if (prev && (prev.width !== this.doc.width || prev.height !== this.doc.height)) this.pickRenderScale();
      this.requestDraw();
    }

    // Puts the context in the rotated paper frame.
    frameTransform(ctx) {
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.translate(this.view.x, this.view.y);
      if (this.view.r) ctx.rotate(this.view.r);
    }

    draw() {
      const d = this.doc;
      if (!d) return;
      const ctx = this.ctx;
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      const s = this.view.s;
      const w = d.width * s, h = d.height * s;
      // Paper with a soft shadow.
      ctx.save();
      this.frameTransform(ctx);
      const dark = document.documentElement.dataset.theme === "dark";
      ctx.shadowColor = dark ? "rgba(0,0,0,0.55)" : "rgba(20,18,30,0.16)";
      ctx.shadowBlur = 28;
      ctx.shadowOffsetY = 8;
      if (G.hexToRgb(d.background || "#ffffff").a < 1) {
        // See-through paper: a checkerboard under it.
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, w, h);
        ctx.shadowColor = "transparent";
        ctx.fillStyle = this.checker(ctx);
        ctx.fillRect(0, 0, w, h);
      }
      ctx.fillStyle = d.background || "#ffffff";
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
      const comp = this.renderer.compose(d, { scale: this.renderScale, live: this.live, extra: this.extra });
      ctx.save();
      this.frameTransform(ctx);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = s * dpr < this.renderScale ? "high" : "medium";
      if (s * dpr > this.renderScale * 1.5 && !this.view.r) ctx.imageSmoothingEnabled = false;
      ctx.drawImage(comp, 0, 0, w, h);
      ctx.restore();
      this.drawOverlays(ctx);
    }

    checker(ctx) {
      if (!this._checker) {
        const c = JRender.makeCanvas(16, 16);
        const x = c.getContext("2d");
        x.fillStyle = "#e6e6ea";
        x.fillRect(0, 0, 8, 8);
        x.fillRect(8, 8, 8, 8);
        this._checker = c;
      }
      return ctx.createPattern(this._checker, "repeat");
    }

    selectionBox(override) {
      let box = null;
      for (const id of this.selection) {
        const f = G.findItem(this.doc, id);
        if (!f) continue;
        const it = override && override.get(id) ? override.get(id) : f.item;
        const b = G.bounds(it);
        box = box ? union(box, b) : b;
      }
      return box;
    }

    drawOverlays(ctx) {
      const cs = getComputedStyle(document.documentElement);
      const accent = cs.getPropertyValue("--accent").trim() || "#6b5cff";
      const s = this.view.s;
      const d = this.doc;
      const px = (v) => (this.view.r ? v : Math.round(v) + 0.5);
      ctx.save();
      this.frameTransform(ctx);

      if (this.grid.show) this.drawGrid(ctx, d, s);

      // Mirror lines while drawing with symmetry.
      if (this.symmetry !== "off" && (this.tool === "brush" || this.tool === "eraser")) {
        ctx.save();
        ctx.strokeStyle = accent;
        ctx.globalAlpha = 0.55;
        ctx.setLineDash([6, 5]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        if (this.symmetry === "v" || this.symmetry === "both") { ctx.moveTo(px((d.width / 2) * s), 0); ctx.lineTo(px((d.width / 2) * s), d.height * s); }
        if (this.symmetry === "h" || this.symmetry === "both") { ctx.moveTo(0, px((d.height / 2) * s)); ctx.lineTo(d.width * s, px((d.height / 2) * s)); }
        ctx.stroke();
        ctx.restore();
      }

      // Hover outline in the select tool, so you see what a click will pick.
      if (this.tool === "select" && this.hover && !this.selection.has(this.hover) && !this.gesture) {
        const f = G.findItem(this.doc, this.hover);
        if (f) {
          const ids = this.groupOf(f.item);
          ctx.save();
          ctx.strokeStyle = accent;
          ctx.globalAlpha = 0.7;
          ctx.lineWidth = 1;
          for (const id of ids) {
            const g = G.findItem(this.doc, id);
            if (!g) continue;
            const b = G.bounds(g.item);
            ctx.strokeRect(px(b.x * s), px(b.y * s), Math.round(b.w * s), Math.round(b.h * s));
          }
          ctx.restore();
        }
      }

      // Selection: a thin box with four corner handles and a rotate handle.
      this._handles = null;
      if (this.selection.size && this.tool === "select") {
        const box = this.selectionBox(this.extra && this.extra.override);
        if (box) {
          const bw = Math.max(1, box.w * s), bh = Math.max(1, box.h * s);
          const x0 = px(box.x * s), y0 = px(box.y * s), x1 = px(box.x * s + bw), y1 = px(box.y * s + bh);
          ctx.save();
          ctx.strokeStyle = accent;
          ctx.lineWidth = 1.5;
          ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
          const mx = (x0 + x1) / 2;
          this._handles = [
            { x: x0, y: y0, corner: "nw" }, { x: x1, y: y0, corner: "ne" },
            { x: x0, y: y1, corner: "sw" }, { x: x1, y: y1, corner: "se" },
            { x: mx, y: y0 - 24, corner: "rotate" },
          ];
          if (!this.gesture || (this.gesture.kind !== "move")) {
            ctx.beginPath();
            ctx.moveTo(mx, y0);
            ctx.lineTo(mx, y0 - 18);
            ctx.stroke();
            ctx.fillStyle = "#ffffff";
            ctx.lineWidth = 1.5;
            for (const h of this._handles) {
              if (h.corner === "rotate") {
                ctx.beginPath();
                ctx.arc(h.x, h.y, 5.5, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
              } else {
                ctx.fillRect(h.x - 4, h.y - 4, 8, 8);
                ctx.strokeRect(h.x - 4, h.y - 4, 8, 8);
              }
            }
          }
          if (this.gesture && this.gesture.kind === "rotate") {
            ctx.fillStyle = accent;
            ctx.font = "600 12px Inter, Segoe UI, sans-serif";
            ctx.textAlign = "center";
            ctx.fillText(`${Math.round(this.gesture.deg || 0)}°`, mx, y0 - 38);
          }
          ctx.restore();
        }
      }

      // Rubber band (frame coordinates).
      if (this.gesture && this.gesture.kind === "band") {
        const g = this.gesture;
        ctx.save();
        ctx.fillStyle = accent + "1f";
        ctx.strokeStyle = accent;
        ctx.lineWidth = 1;
        const x = Math.min(g.sx, g.cx), y = Math.min(g.sy, g.cy);
        ctx.fillRect(x, y, Math.abs(g.cx - g.sx), Math.abs(g.cy - g.sy));
        ctx.strokeRect(x + 0.5, y + 0.5, Math.abs(g.cx - g.sx), Math.abs(g.cy - g.sy));
        ctx.restore();
      }

      // Lasso and freeform outlines (doc coordinates).
      if (this.gesture && (this.gesture.kind === "lasso" || this.gesture.kind === "effect") && this.gesture.pts.length > 1) {
        const g = this.gesture;
        ctx.save();
        ctx.strokeStyle = accent;
        ctx.lineWidth = g.kind === "effect" ? Math.max(1, this.brush.size * s) : 1.5;
        ctx.globalAlpha = g.kind === "effect" ? 0.25 : 1;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        if (g.kind === "lasso") { ctx.setLineDash([5, 4]); ctx.fillStyle = accent + "14"; }
        ctx.beginPath();
        ctx.moveTo(g.pts[0][0] * s, g.pts[0][1] * s);
        for (const p of g.pts) ctx.lineTo(p[0] * s, p[1] * s);
        if (g.kind === "lasso") { ctx.closePath(); ctx.fill(); }
        ctx.stroke();
        ctx.restore();
      }

      if (this.rulers) this.drawRulers(ctx, d, s, cs);
      ctx.restore();

      // Brush cursor (screen coordinates; a circle looks the same turned).
      if (this.pointer && (this.tool === "brush" || this.tool === "eraser") && !this.panMode()) {
        const dpr = window.devicePixelRatio || 1;
        ctx.save();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const r = Math.max(1.5, (this.brush.size / 2) * s);
        ctx.beginPath();
        ctx.arc(this.pointer.x, this.pointer.y, r, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(255,255,255,0.9)";
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.strokeStyle = "rgba(0,0,0,0.7)";
        ctx.lineWidth = 1;
        ctx.stroke();
        if (r < 4) {
          ctx.beginPath();
          ctx.moveTo(this.pointer.x - 8, this.pointer.y); ctx.lineTo(this.pointer.x - 5, this.pointer.y);
          ctx.moveTo(this.pointer.x + 5, this.pointer.y); ctx.lineTo(this.pointer.x + 8, this.pointer.y);
          ctx.moveTo(this.pointer.x, this.pointer.y - 8); ctx.lineTo(this.pointer.x, this.pointer.y - 5);
          ctx.moveTo(this.pointer.x, this.pointer.y + 5); ctx.lineTo(this.pointer.x, this.pointer.y + 8);
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    // Grid lines over the paper. Too-dense lines are skipped.
    drawGrid(ctx, d, s) {
      let step = this.grid.size;
      while (step * s < 8) step *= 2;
      const major = step * 5;
      ctx.save();
      ctx.lineWidth = 1;
      for (const [k, alpha] of [[step, 0.18], [major, 0.38]]) {
        ctx.strokeStyle = `rgba(110,110,135,${alpha})`;
        ctx.beginPath();
        for (let x = k; x < d.width; x += k) { const v = Math.round(x * s) + 0.5; ctx.moveTo(v, 0); ctx.lineTo(v, d.height * s); }
        for (let y = k; y < d.height; y += k) { const v = Math.round(y * s) + 0.5; ctx.moveTo(0, v); ctx.lineTo(d.width * s, v); }
        ctx.stroke();
      }
      ctx.restore();
    }

    // Rulers hug the top and left edges of the paper and stay on screen
    // when the paper scrolls past (unless the view is turned).
    drawRulers(ctx, d, s, cs) {
      const surface = cs.getPropertyValue("--surface").trim() || "#ffffff";
      const line = cs.getPropertyValue("--line").trim() || "#ddd";
      const text = cs.getPropertyValue("--text-3").trim() || "#888";
      const accent = cs.getPropertyValue("--accent").trim() || "#6b5cff";
      const railRight = (() => { const r = this.stage.querySelector(".rail"); if (!r) return 0; const a = r.getBoundingClientRect(), b = this.stage.getBoundingClientRect(); return a.right - b.left + 6; })();
      const topY = this.view.r ? -RULER : Math.min(d.height * s - RULER, Math.max(-RULER, -this.view.y));
      const leftX = this.view.r ? -RULER : Math.min(d.width * s - RULER, Math.max(-RULER, railRight - this.view.x));
      const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
      const step = steps.find((v) => v * s >= 56) || 5000;
      const minor = step / (step % 5 === 0 ? 5 : 2);
      ctx.save();
      ctx.font = "600 9.5px Inter, Segoe UI, sans-serif";
      ctx.textBaseline = "top";
      const band = (horiz) => {
        ctx.fillStyle = surface;
        ctx.globalAlpha = 0.94;
        if (horiz) ctx.fillRect(0, topY, d.width * s, RULER); else ctx.fillRect(leftX, 0, RULER, d.height * s);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = line;
        ctx.lineWidth = 1;
        ctx.beginPath();
        const len = horiz ? d.width : d.height;
        for (let v = 0; v <= len; v += minor) {
          const p = Math.round(v * s) + 0.5;
          const big = Math.abs(v / step - Math.round(v / step)) < 1e-6;
          const t = big ? RULER : RULER * 0.35;
          if (horiz) { ctx.moveTo(p, topY + RULER); ctx.lineTo(p, topY + RULER - t); } else { ctx.moveTo(leftX + RULER, p); ctx.lineTo(leftX + RULER - t, p); }
        }
        ctx.stroke();
        ctx.fillStyle = text;
        for (let v = 0; v <= len; v += step) {
          const p = Math.round(v * s);
          if (horiz) ctx.fillText(String(v), p + 3, topY + 2);
          else { ctx.save(); ctx.translate(leftX + 2, p + 3); ctx.rotate(Math.PI / 2); ctx.textBaseline = "bottom"; ctx.fillText(String(v), 0, 0); ctx.restore(); }
        }
        // Pointer position.
        if (this.pointer) {
          const dp = this.toDoc(this.pointer.x, this.pointer.y);
          ctx.strokeStyle = accent;
          ctx.beginPath();
          if (horiz && dp.x >= 0 && dp.x <= d.width) { ctx.moveTo(dp.x * s, topY); ctx.lineTo(dp.x * s, topY + RULER); }
          if (!horiz && dp.y >= 0 && dp.y <= d.height) { ctx.moveTo(leftX, dp.y * s); ctx.lineTo(leftX + RULER, dp.y * s); }
          ctx.stroke();
        }
      };
      band(true);
      band(false);
      ctx.restore();
    }

    panMode() { return this.tool === "hand" || this.spaceDown; }

    setTool(tool) {
      if (this.textEntry) this.commitText();
      this.tool = tool;
      this.hover = null;
      this.canvas.style.cursor = "";
      for (const c of [...this.stage.classList]) if (c.startsWith("tool-")) this.stage.classList.remove(c);
      this.stage.classList.add("tool-" + tool);
      if (tool !== "select" && this.selection.size) { this.selection.clear(); this.host.onSelection([]); }
      this.requestDraw();
    }

    // ---------- input
    bind() {
      const c = this.canvas;
      c.addEventListener("pointerdown", (e) => this.onDown(e));
      c.addEventListener("pointermove", (e) => this.onMove(e));
      c.addEventListener("pointerup", (e) => this.onUp(e));
      c.addEventListener("pointercancel", (e) => this.onUp(e, true));
      c.addEventListener("pointerleave", () => { this.pointer = null; this.hover = null; this.requestDraw(); });
      c.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
      c.addEventListener("contextmenu", (e) => e.preventDefault());
      c.addEventListener("dblclick", (e) => {
        if (this.tool !== "select") return;
        const pt = this.local(e);
        const hit = this.hitTest(this.toDoc(pt.x, pt.y));
        if (hit && hit.item.type === "text") this.openText(pt, hit.item);
      });
      this._onKeyDown = (e) => {
        if (e.code === "Space" && !isTyping(e)) {
          if (!this.spaceDown) { this.spaceDown = true; this.canvas.style.cursor = ""; this.hover = null; this.stage.classList.add("panning"); this.requestDraw(); }
          e.preventDefault();
        }
      };
      this._onKeyUp = (e) => {
        if (e.code === "Space") { this.spaceDown = false; this.stage.classList.remove("panning", "grabbing"); this.requestDraw(); }
      };
      window.addEventListener("keydown", this._onKeyDown, true);
      window.addEventListener("keyup", this._onKeyUp, true);
    }

    local(e) {
      const r = this.canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    onWheel(e) {
      e.preventDefault();
      const pt = this.local(e);
      if (!e.ctrlKey && (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY))) {
        this.view.x -= e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
        if (!e.shiftKey) this.view.y -= e.deltaY;
        this._autoFit = false;
        this.keepPaperInView();
        this.positionTextEntry();
        this.requestDraw();
        return;
      }
      const amount = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      const factor = Math.exp(-amount * (e.ctrlKey ? 0.01 : 0.0018));
      this.zoomAt(factor, pt.x, pt.y);
    }

    onDown(e) {
      if (this.textEntry) { this.commitText(); return; }
      const pt = this.local(e);
      try { this.canvas.setPointerCapture(e.pointerId); } catch {}
      if (e.button === 1 || e.button === 2 || this.panMode()) {
        this.gesture = { kind: "pan", sx: pt.x, sy: pt.y, vx: this.view.x, vy: this.view.y };
        this.stage.classList.add("panning", "grabbing");
        return;
      }
      if (e.button !== 0) return;
      const dp = this.toDoc(pt.x, pt.y);
      const layer = this.host.activeLayer();
      const needsLayer = ["brush", "eraser", "shape", "fill", "text"].includes(this.tool);
      if (needsLayer && layer && (layer.visible === false || layer.locked)) {
        this.host.toast(layer.locked ? "This layer is locked." : "This layer is hidden. Show it to draw on it.");
        this.gesture = null;
        return;
      }
      switch (this.tool) {
        case "brush":
        case "eraser":
          if (this.tool === "brush" && EFFECT_BRUSHES.includes(this.brush.brush)) this.gesture = { kind: "effect", layerId: layer.id, pts: [[dp.x, dp.y]] };
          else this.startStroke(e, pt, dp, layer);
          break;
        case "shape": {
          const start = this.shapeKind === "freeform" ? dp : this.snap(dp);
          this.gesture = { kind: "shape", start, layerId: layer.id, pts: [[dp.x, dp.y]] };
          break;
        }
        case "select":
          this.startSelect(e, pt, dp);
          break;
        case "fill":
          this.floodFill(dp, layer);
          break;
        case "eyedropper":
          this.pickColor(dp);
          break;
        case "text":
          this.openText(this.toScreenPt(this.snap(dp)));
          break;
      }
    }

    toScreenPt(dp) { return this.toScreen(dp.x, dp.y); }

    onMove(e) {
      const pt = this.local(e);
      this.pointer = pt;
      const g = this.gesture;
      if (!g) {
        if (this.tool === "brush" || this.tool === "eraser" || this.rulers) this.requestDraw();
        if (this.tool === "select" && !this.panMode()) this.updateHover(pt);
        return;
      }
      if (g.kind === "pan") {
        this._autoFit = false;
        this.view.x = g.vx + (pt.x - g.sx);
        this.view.y = g.vy + (pt.y - g.sy);
        this.keepPaperInView();
        this.positionTextEntry();
        this.requestDraw();
        return;
      }
      if (g.kind === "stroke") { this.moveStroke(e, pt); return; }
      if (g.kind === "shape") { this.moveShape(e, this.toDoc(pt.x, pt.y)); return; }
      if (g.kind === "move" || g.kind === "scale" || g.kind === "rotate") { this.moveSelect(e, pt); return; }
      if (g.kind === "band") { const f = this.toFrame(pt.x, pt.y); g.cx = f.x; g.cy = f.y; this.requestDraw(); return; }
      if (g.kind === "lasso" || g.kind === "effect") {
        const dp = this.toDoc(pt.x, pt.y);
        const last = g.pts[g.pts.length - 1];
        if (Math.hypot(dp.x - last[0], dp.y - last[1]) * this.view.s >= 2) g.pts.push([dp.x, dp.y]);
        this.requestDraw();
      }
    }

    onUp(e, cancelled) {
      const g = this.gesture;
      this.gesture = null;
      try { this.canvas.releasePointerCapture(e.pointerId); } catch {}
      if (!g) return;
      if (g.kind === "pan") { this.stage.classList.remove("grabbing"); if (!this.spaceDown && this.tool !== "hand") this.stage.classList.remove("panning"); return; }
      if (cancelled) { this.live = null; this.extra = null; this.requestDraw(); return; }
      if (g.kind === "stroke") this.endStroke(g, this.local(e));
      else if (g.kind === "shape") this.endShape(g);
      else if (g.kind === "move" || g.kind === "scale" || g.kind === "rotate") this.endSelect(g);
      else if (g.kind === "band") this.endBand(g, e.shiftKey);
      else if (g.kind === "lasso") this.endLasso(g, e.shiftKey);
      else if (g.kind === "effect") this.endEffect(g);
    }

    // ---------- strokes
    pressureOf(e, g, pt) {
      if (e.pointerType === "pen") return e.pressure > 0 ? e.pressure : 0.5;
      // Mouse and touch: faster movement draws thinner, like a real pen.
      const now = e.timeStamp || performance.now();
      const dt = Math.max(1, now - (g.lastT || now - 16));
      const dist = Math.hypot(pt.x - (g.lastSx ?? pt.x), pt.y - (g.lastSy ?? pt.y));
      const speed = dist / dt;
      g.lastT = now; g.lastSx = pt.x; g.lastSy = pt.y;
      const target = G.clamp(1.05 - speed * 0.32, 0.38, 1);
      g.p = g.p == null ? 0.7 : g.p * 0.75 + target * 0.25;
      return g.p;
    }

    startStroke(e, pt, dp, layer) {
      this.livePending = false;
      const g = { kind: "stroke", layerId: layer.id, pts: [], sx: dp.x, sy: dp.y, pen: e.pointerType === "pen", lastT: e.timeStamp, lastSx: pt.x, lastSy: pt.y, p: null };
      const p = e.pointerType === "pen" ? (e.pressure || 0.5) : 0.7;
      g.pts.push([dp.x, dp.y, p]);
      g.item = this.strokeItem(g.pts);
      this.gesture = g;
      this.setLive(g);
      this.armHold(g, pt);
      this.requestDraw();
    }

    strokeItem(pts) {
      return {
        id: "live",
        type: "stroke",
        points: pts,
        color: this.brush.color,
        size: this.brush.size,
        brush: this.tool === "eraser" ? "eraser" : this.brush.brush,
        opacity: this.tool === "eraser" ? 1 : this.brush.opacity,
      };
    }

    // Copies of a stroke mirrored across the canvas center lines.
    mirrors(item) {
      if (this.symmetry === "off" || item.type !== "stroke") return [];
      const d = this.doc;
      const ox = d.width / 2, oy = d.height / 2;
      const out = [];
      if (this.symmetry === "v" || this.symmetry === "both") out.push(G.flipItem(item, "x", ox, oy));
      if (this.symmetry === "h" || this.symmetry === "both") out.push(G.flipItem(item, "y", ox, oy));
      if (this.symmetry === "both") out.push(G.flipItem(G.flipItem(item, "x", ox, oy), "y", ox, oy));
      return out;
    }

    setLive(g) {
      this.live = { layerId: g.layerId, item: g.item, more: this.mirrors(g.item) };
    }

    armHold(g, pt) {
      clearTimeout(g.holdTimer);
      g.holdAt = pt;
      g.holdTimer = setTimeout(() => this.snapShape(g), 650);
    }

    moveStroke(e, pt) {
      const g = this.gesture;
      if (g.snapped) {
        if (g.snapped === "line") {
          const dp = this.toDoc(pt.x, pt.y);
          g.pts = linePoints(g.pts[0], [dp.x, dp.y], g.item.size);
          g.item = Object.assign({}, g.item, { points: g.pts });
          this.setLive(g);
          this.requestDraw();
        }
        return;
      }
      const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      const steady = this.brush.steady;
      const follow = 1 - steady * 0.88;
      const minDist = 0.6 / this.view.s;
      for (const ev of events.length ? events : [e]) {
        const lp = this.local(ev);
        const dp = this.toDoc(lp.x, lp.y);
        g.sx += (dp.x - g.sx) * follow;
        g.sy += (dp.y - g.sy) * follow;
        const last = g.pts[g.pts.length - 1];
        if (Math.hypot(g.sx - last[0], g.sy - last[1]) < minDist) continue;
        let p = this.pressureOf(ev, g, lp);
        // Taper the start.
        const n = g.pts.length;
        if (!g.pen && n < 6) p *= 0.45 + n * 0.1;
        g.pts.push([g.sx, g.sy, p]);
      }
      if (Math.hypot(pt.x - g.holdAt.x, pt.y - g.holdAt.y) > 3) this.armHold(g, pt);
      g.item = Object.assign({}, g.item, { points: g.pts });
      this.setLive(g);
      this.requestDraw();
    }

    // Holding still at the end of a stroke turns it into a clean line or
    // ellipse.
    snapShape(g) {
      if (this.gesture !== g || g.snapped || g.pts.length < 6) return;
      const pts = g.pts;
      const a = pts[0], b = pts[pts.length - 1];
      let len = 0;
      for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      if (len * this.view.s < 30) return;
      const chord = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (chord / len > 0.88) {
        g.snapped = "line";
        g.pts = linePoints(a, b, g.item.size);
      } else if (chord < len * 0.22) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of pts) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
        g.snapped = "ellipse";
        g.pts = ellipsePoints((minX + maxX) / 2, (minY + maxY) / 2, (maxX - minX) / 2, (maxY - minY) / 2);
      } else return;
      g.item = Object.assign({}, g.item, { points: g.pts });
      this.setLive(g);
      this.host.toast(g.snapped === "line" ? "Straightened into a line" : "Rounded into an ellipse", { ms: 1400 });
      this.requestDraw();
    }

    endStroke(g, pt) {
      clearTimeout(g.holdTimer);
      this.live = null;
      let pts = g.pts;
      if (!g.snapped) {
        // Catch up with the pointer so the line ends where it was let go.
        const dp = this.toDoc(pt.x, pt.y);
        const last = pts[pts.length - 1];
        const gap = Math.hypot(dp.x - last[0], dp.y - last[1]);
        if (gap > 0.5 && this.brush.steady > 0.05 && pts.length > 1) {
          const steps = Math.min(8, Math.ceil(gap / 3));
          for (let i = 1; i <= steps; i++) pts.push([last[0] + ((dp.x - last[0]) * i) / steps, last[1] + ((dp.y - last[1]) * i) / steps, last[2]]);
        }
        // Taper the end for mouse strokes.
        if (!g.pen && pts.length > 4) {
          const n = Math.min(6, Math.floor(pts.length / 3));
          for (let i = 0; i < n; i++) pts[pts.length - 1 - i][2] *= 0.45 + (i / n) * 0.55;
        }
        pts = simplify(pts, 0.25 / Math.max(0.25, this.view.s));
      }
      const item = this.strokeItem(pts);
      const more = this.mirrors(item);
      // Keep showing the stroke until the saved drawing comes back.
      this.live = { layerId: g.layerId, item: Object.assign({}, item), more };
      this.livePending = true;
      delete item.id;
      const items = [item, ...more.map((m) => { const c = Object.assign({}, m); delete c.id; return c; })];
      this.host.apply([{ op: "add_items", layerId: g.layerId, items }]);
    }

    // ---------- smudge and blur
    // These change paint that is already on the layer, so they work on
    // pixels: the layer is rendered, the area under the stroke is smudged or
    // blurred, then an eraser cuts the old paint there and the result goes
    // on top as a picture. One undo step.
    async endEffect(g) {
      this.requestDraw();
      const d = this.doc;
      const layer = d.layers.find((l) => l.id === g.layerId);
      if (!layer || g.pts.length < 2) return;
      const size = this.brush.size;
      const strength = this.brush.opacity;
      const xs = g.pts.map((p) => p[0]), ys = g.pts.map((p) => p[1]);
      const pad = size;
      const x0 = Math.max(0, Math.floor(Math.min(...xs) - pad)), y0 = Math.max(0, Math.floor(Math.min(...ys) - pad));
      const x1 = Math.min(d.width, Math.ceil(Math.max(...xs) + pad)), y1 = Math.min(d.height, Math.ceil(Math.max(...ys) + pad));
      const w = x1 - x0, h = y1 - y0;
      if (w < 2 || h < 2) return;
      const solo = Object.assign({}, d, { layers: [Object.assign({}, layer, { opacity: 1, blend: undefined, visible: true })] });
      const src = await renderToCanvas(solo, { scale: 1, transparent: true, crop: { x: x0, y: y0, w, h } });
      const out = JRender.makeCanvas(w, h);
      const octx = out.getContext("2d");
      // Even spacing along the stroke.
      const pts = resample(g.pts.map((p) => [p[0] - x0, p[1] - y0]), Math.max(1, size * 0.12));
      if (this.brush.brush === "blur") {
        octx.filter = `blur(${Math.max(1, size * 0.22)}px)`;
        octx.drawImage(src, 0, 0);
        octx.filter = "none";
        if (strength < 1) { octx.globalAlpha = 1 - strength; octx.drawImage(src, 0, 0); octx.globalAlpha = 1; }
      } else {
        octx.drawImage(src, 0, 0);
        const r = Math.max(1, size / 2);
        const dab = JRender.makeCanvas(r * 2, r * 2);
        const dctx = dab.getContext("2d");
        for (let i = 1; i < pts.length; i++) {
          const [px, py] = pts[i - 1], [cx, cy] = pts[i];
          // Pick up paint at the last spot, lay it down here with a soft edge.
          dctx.globalCompositeOperation = "copy";
          dctx.drawImage(out, px - r, py - r, r * 2, r * 2, 0, 0, r * 2, r * 2);
          dctx.globalCompositeOperation = "destination-in";
          const grad = dctx.createRadialGradient(r, r, 0, r, r, r);
          grad.addColorStop(0, "rgba(0,0,0,1)");
          grad.addColorStop(1, "rgba(0,0,0,0)");
          dctx.fillStyle = grad;
          dctx.fillRect(0, 0, r * 2, r * 2);
          octx.globalAlpha = 0.85 * strength;
          octx.drawImage(dab, cx - r, cy - r);
        }
        octx.globalAlpha = 1;
      }
      // Keep only the part under the stroke.
      const maskItem = { type: "stroke", points: g.pts.map((p) => [p[0] - x0, p[1] - y0, 1]), color: "#000000", size, brush: "pen" };
      const mask = JRender.makeCanvas(w, h);
      JRender.drawItem(mask.getContext("2d"), maskItem, JRender.makeCanvas(w, h));
      octx.globalCompositeOperation = "destination-in";
      octx.drawImage(mask, 0, 0);
      const eraser = { type: "stroke", points: g.pts.map((p) => [p[0], p[1], 1]), color: "#000000", size, brush: "eraser" };
      const picture = { type: "image", name: this.brush.brush === "blur" ? "Blur" : "Smudge", x: x0, y: y0, w, h, src: out.toDataURL("image/png") };
      this.host.apply([{ op: "add_items", layerId: g.layerId, items: [eraser, picture] }]);
    }

    // ---------- shapes
    currentPaint(color) {
      if (this.paintMode === "solid") return color;
      return { type: this.paintMode, stops: [[0, color], [1, this.color2]] };
    }

    shapeItem(a, b, shift, pts) {
      let x0 = a.x, y0 = a.y, x1 = b.x, y1 = b.y;
      const color = this.brush.color;
      const dash = this.lineDash !== "solid" ? this.lineDash : undefined;
      if (this.shapeKind === "line" || this.shapeKind === "arrow") {
        if (shift) {
          const ang = Math.round(Math.atan2(y1 - y0, x1 - x0) / (Math.PI / 4)) * (Math.PI / 4);
          const len = Math.hypot(x1 - x0, y1 - y0);
          x1 = x0 + Math.cos(ang) * len; y1 = y0 + Math.sin(ang) * len;
        }
        return { type: "line", x1: x0, y1: y0, x2: x1, y2: y1, stroke: this.currentPaint(color), strokeWidth: this.brush.size, opacity: this.brush.opacity, dash, arrowEnd: this.shapeKind === "arrow" };
      }
      const paintIt = (it) => {
        if (this.shapeFill) it.fill = this.currentPaint(color);
        else { it.fill = null; it.stroke = this.currentPaint(color); it.strokeWidth = this.brush.size; it.dash = dash; }
        return it;
      };
      if (this.shapeKind === "freeform") {
        return paintIt({ type: "polygon", points: simplify(pts.map((p) => [p[0], p[1], 0.5]), 0.6 / this.view.s).map((p) => [p[0], p[1]]), closed: true, opacity: this.brush.opacity });
      }
      if (shift) {
        const s = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
        x1 = x0 + Math.sign(x1 - x0 || 1) * s; y1 = y0 + Math.sign(y1 - y0 || 1) * s;
      }
      const box = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
      if (this.shapeKind === "polygon" || this.shapeKind === "star") {
        const n = this.shapeKind === "star" ? this.starPoints : this.shapeSides;
        return paintIt({ type: "polygon", points: G.shapePoints(this.shapeKind, box.x, box.y, box.w, box.h, n, 0.45), closed: true, opacity: this.brush.opacity });
      }
      const it = paintIt(Object.assign({ type: this.shapeKind, opacity: this.brush.opacity }, box));
      if (this.shapeKind === "rect" && !this.shapeFill) it.radius = 0;
      return it;
    }

    moveShape(e, dp) {
      const g = this.gesture;
      if (this.shapeKind === "freeform") {
        const last = g.pts[g.pts.length - 1];
        if (Math.hypot(dp.x - last[0], dp.y - last[1]) * this.view.s >= 2) g.pts.push([dp.x, dp.y]);
        if (g.pts.length < 3) return;
        g.end = dp;
      } else {
        g.end = this.snap(dp);
      }
      g.shift = e.shiftKey;
      try { g.item = G.normItem(Object.assign({ id: "live" }, this.shapeItem(g.start, g.end, e.shiftKey, g.pts))); } catch { return; }
      this.live = { layerId: g.layerId, item: g.item };
      this.requestDraw();
    }

    endShape(g) {
      if (!g.end || (this.shapeKind !== "freeform" && Math.hypot(g.end.x - g.start.x, g.end.y - g.start.y) * this.view.s < 3) || (this.shapeKind === "freeform" && g.pts.length < 3)) { this.live = null; this.requestDraw(); return; }
      this.livePending = true;
      const item = this.shapeItem(g.start, g.end, g.shift, g.pts);
      this.host.apply([{ op: "add_items", layerId: g.layerId, items: [item] }]);
    }

    // ---------- select
    // Picks the topmost item whose drawn pixels are under the point (within
    // a few screen pixels), so clicks match what you see, not boxes.
    hitTest(dp, opts) {
      const tolPx = 4;
      const tol = tolPx / this.view.s;
      const layers = this.doc.layers;
      for (let li = layers.length - 1; li >= 0; li--) {
        const l = layers[li];
        if (l.visible === false || l.locked) continue;
        if (opts && opts.layerId && l.id !== opts.layerId) continue;
        for (let i = l.items.length - 1; i >= 0; i--) {
          const it = l.items[i];
          if (it.type === "stroke" && it.brush === "eraser") continue;
          const b = G.bounds(it);
          if (dp.x < b.x - tol || dp.y < b.y - tol || dp.x > b.x + b.w + tol || dp.y > b.y + b.h + tol) continue;
          if (this.pixelHit(it, dp, tolPx)) return { item: it, layer: l };
        }
      }
      return null;
    }

    pixelHit(it, dp, r) {
      const size = r * 2 + 1;
      if (!this._hitCanvas) {
        this._hitCanvas = JRender.makeCanvas(size, size);
        this._hitScratch = JRender.makeCanvas(size, size);
      }
      const c = this._hitCanvas;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      ctx.clearRect(0, 0, size, size);
      const s = this.view.s;
      ctx.setTransform(s, 0, 0, s, r - dp.x * s, r - dp.y * s);
      // Faint, blended or glowing items still count where they are drawn.
      const solid = Object.assign({}, it, { opacity: 1 });
      delete solid.shadow;
      delete solid.blend;
      JRender.drawItem(ctx, solid, this._hitScratch);
      const data = ctx.getImageData(0, 0, size, size).data;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 24) return true;
      return false;
    }

    // Every item in the same group as it (or just it).
    groupOf(it) {
      if (!it.group) return [it.id];
      const out = [];
      for (const l of this.doc.layers) for (const x of l.items) if (x.group === it.group) out.push(x.id);
      return out;
    }

    // Hover feedback in the select tool: outline and cursor. Throttled to
    // one hit test per frame.
    updateHover(pt) {
      if (this._hoverPending) { this._hoverPt = pt; return; }
      this._hoverPending = true;
      this._hoverPt = pt;
      requestAnimationFrame(() => {
        this._hoverPending = false;
        const p = this._hoverPt;
        if (this.tool !== "select" || this.gesture) return;
        const handle = this.selection.size ? this.handleAt(p) : null;
        let cursor = "default";
        let hover = null;
        if (handle) cursor = handle.corner === "rotate" ? "grab" : handle.corner === "nw" || handle.corner === "se" ? "nwse-resize" : "nesw-resize";
        else {
          const hit = this.hitTest(this.toDoc(p.x, p.y));
          if (hit) { hover = hit.item.id; cursor = "move"; }
        }
        this.canvas.style.cursor = cursor;
        if (hover !== this.hover) { this.hover = hover; this.requestDraw(); }
      });
    }

    handleAt(pt) {
      if (!this._handles) return null;
      const f = this.toFrame(pt.x, pt.y);
      return this._handles.find((h) => Math.abs(f.x - h.x) <= 7 && Math.abs(f.y - h.y) <= 7) || null;
    }

    startSelect(e, pt, dp) {
      const handle = this.selection.size ? this.handleAt(pt) : null;
      if (handle) {
        const box = this.selectionBox();
        if (handle.corner === "rotate") {
          const ox = box.x + box.w / 2, oy = box.y + box.h / 2;
          this.gesture = { kind: "rotate", origin: { x: ox, y: oy }, a0: Math.atan2(dp.y - oy, dp.x - ox), deg: 0 };
          return;
        }
        // Scale from the opposite corner.
        const ox = handle.corner.includes("w") ? box.x + box.w : box.x;
        const oy = handle.corner.includes("n") ? box.y + box.h : box.y;
        this.gesture = { kind: "scale", sx: pt.x, sy: pt.y, box, corner: handle.corner, origin: { x: ox, y: oy } };
        return;
      }
      const hit = this.hitTest(dp);
      if (hit) {
        // A click picks the whole group; Ctrl+click picks one item inside it.
        const ids = e.ctrlKey || e.metaKey ? [hit.item.id] : this.groupOf(hit.item);
        if (e.shiftKey) {
          const on = this.selection.has(hit.item.id);
          for (const id of ids) on ? this.selection.delete(id) : this.selection.add(id);
        } else if (!this.selection.has(hit.item.id)) {
          this.selection = new Set(ids);
        }
        this.host.onSelection([...this.selection]);
        this.gesture = { kind: "move", sx: pt.x, sy: pt.y, alt: e.altKey, clicked: ids, shift: e.shiftKey, box0: this.selectionBox() };
        this.requestDraw();
        return;
      }
      if (!e.shiftKey && this.selection.size) { this.selection.clear(); this.host.onSelection([]); }
      if (this.selectMode === "lasso") this.gesture = { kind: "lasso", pts: [[dp.x, dp.y]] };
      else { const f = this.toFrame(pt.x, pt.y); this.gesture = { kind: "band", sx: f.x, sy: f.y, cx: f.x, cy: f.y }; }
      this.requestDraw();
    }

    moveSelect(e, pt) {
      const g = this.gesture;
      const override = new Map();
      const layerIds = new Set();
      let key;
      const each = (fn) => {
        for (const id of this.selection) {
          const f = G.findItem(this.doc, id);
          if (!f) continue;
          override.set(id, fn(f.item));
          layerIds.add(f.layer.id);
        }
      };
      if (g.kind === "move") {
        const a = this.toDoc(g.sx, g.sy), b = this.toDoc(pt.x, pt.y);
        let dx = b.x - a.x, dy = b.y - a.y;
        if (e.shiftKey && !g.shift) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
        if (this.grid.snap && g.box0) {
          const t = this.snap({ x: g.box0.x + dx, y: g.box0.y + dy });
          dx = t.x - g.box0.x; dy = t.y - g.box0.y;
        }
        g.dx = dx; g.dy = dy;
        g.moved = g.moved || Math.hypot(pt.x - g.sx, pt.y - g.sy) >= 1;
        each((it) => G.moveItem(it, dx, dy));
        key = `m${dx.toFixed(2)},${dy.toFixed(2)}`;
      } else if (g.kind === "rotate") {
        const dp = this.toDoc(pt.x, pt.y);
        let deg = ((Math.atan2(dp.y - g.origin.y, dp.x - g.origin.x) - g.a0) * 180) / Math.PI;
        deg = ((deg + 540) % 360) - 180;
        if (e.shiftKey) deg = Math.round(deg / 15) * 15;
        g.deg = deg;
        each((it) => G.rotateItem(it, deg, g.origin.x, g.origin.y));
        key = `r${deg.toFixed(2)}`;
      } else {
        const o = g.origin;
        const start = this.toDoc(g.sx, g.sy);
        const now = this.toDoc(pt.x, pt.y);
        const d0 = Math.hypot(start.x - o.x, start.y - o.y) || 1;
        // Project onto the corner's diagonal so sideways wobble does not count.
        const ux = (start.x - o.x) / d0, uy = (start.y - o.y) / d0;
        const d1 = (now.x - o.x) * ux + (now.y - o.y) * uy;
        const s = Math.max(0.02, d1 / d0);
        g.scale = s;
        each((it) => G.scaleItem(it, s, o.x, o.y));
        key = `s${s.toFixed(4)}`;
      }
      this.extra = { layerIds, key, override };
      this.requestDraw();
    }

    endSelect(g) {
      const extra = this.extra;
      this.extra = null;
      const clickOnly = g.kind === "move" && !g.moved;
      if (clickOnly) {
        // A plain click on one item of a bigger selection selects just it.
        const clicked = new Set(g.clicked || []);
        if (!g.shift && g.clicked && this.selection.size > clicked.size) { this.selection = clicked; this.host.onSelection([...clicked]); }
        this.requestDraw();
        return;
      }
      if (!extra || !extra.override.size) { this.requestDraw(); return; }
      if (g.kind === "move" && g.alt) {
        // Alt+drag leaves the originals and drops copies.
        Promise.resolve(this.host.apply([{ op: "duplicate_items", ids: [...this.selection], dx: g.dx, dy: g.dy }])).then((res) => {
          const ids = res && res[0] && res[0].ids;
          if (ids && ids.length) { this.selection = new Set(ids); this.host.onSelection(ids); this.requestDraw(); }
        });
        this.requestDraw();
        return;
      }
      this.host.apply([{ op: "replace_items", items: [...extra.override.values()] }]);
    }

    selectable(it, l) {
      return l.visible !== false && !l.locked && !(it.type === "stroke" && it.brush === "eraser");
    }

    // Picks whole groups when any of their items is picked.
    withGroups(sel) {
      const groups = new Set();
      for (const l of this.doc.layers) for (const it of l.items) if (sel.has(it.id) && it.group) groups.add(it.group);
      if (groups.size) for (const l of this.doc.layers) for (const it of l.items) if (it.group && groups.has(it.group)) sel.add(it.id);
      return sel;
    }

    endBand(g, add) {
      const s = this.view.s;
      const a = { x: Math.min(g.sx, g.cx) / s, y: Math.min(g.sy, g.cy) / s };
      const b = { x: Math.max(g.sx, g.cx) / s, y: Math.max(g.sy, g.cy) / s };
      if ((b.x - a.x) * s < 3 && (b.y - a.y) * s < 3) { this.requestDraw(); return; }
      const sel = add ? new Set(this.selection) : new Set();
      for (const l of this.doc.layers) {
        for (const it of l.items) {
          if (!this.selectable(it, l)) continue;
          const bb = G.bounds(it);
          if (bb.x >= a.x && bb.y >= a.y && bb.x + bb.w <= b.x && bb.y + bb.h <= b.y) sel.add(it.id);
        }
      }
      this.selection = this.withGroups(sel);
      this.host.onSelection([...this.selection]);
      this.requestDraw();
    }

    // Lasso: picks items that sit fully inside the drawn outline.
    endLasso(g, add) {
      const poly = g.pts;
      if (poly.length < 3) { this.requestDraw(); return; }
      const sel = add ? new Set(this.selection) : new Set();
      for (const l of this.doc.layers) {
        for (const it of l.items) {
          if (!this.selectable(it, l)) continue;
          let pts;
          if ((it.type === "stroke" || it.type === "polygon") && !it.rotation) pts = it.points;
          else if (it.type === "line") pts = [[it.x1, it.y1], [it.x2, it.y2]];
          else { const b = G.bounds(it); pts = [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]]; }
          const step = Math.max(1, Math.floor(pts.length / 200));
          let inside = true;
          for (let i = 0; i < pts.length && inside; i += step) inside = pointInPoly(pts[i][0], pts[i][1], poly);
          if (inside) sel.add(it.id);
        }
      }
      this.selection = this.withGroups(sel);
      this.host.onSelection([...this.selection]);
      this.requestDraw();
    }

    selectAll() {
      const layer = this.host.activeLayer();
      this.selection = new Set(layer.items.filter((i) => !(i.type === "stroke" && i.brush === "eraser")).map((i) => i.id));
      this.host.onSelection([...this.selection]);
      this.requestDraw();
    }

    setSelection(ids) {
      this.selection = new Set(ids);
      this.requestDraw();
    }

    nudge(dx, dy) {
      if (!this.selection.size) return;
      this.host.apply([{ op: "move_items", ids: [...this.selection], dx, dy }]);
    }

    // ---------- fill and eyedropper
    async floodFill(dp, layer) {
      const res = await this.computeFill({
        x: dp.x, y: dp.y, color: this.brush.color, color2: this.paintMode === "solid" ? null : this.color2, gradient: this.paintMode,
        tolerance: this.fill.tolerance, gap: this.fill.gap, sample: this.fill.sample, layerId: layer.id, opacity: this.brush.opacity,
      });
      if (!res.item) { if (res.reason) this.host.toast(res.reason); return; }
      this.host.apply([{ op: "add_items", layerId: layer.id, position: "bottom", items: [res.item] }]);
    }

    // Flood fill as a picture item. Used by the Fill tool and the agent's
    // fill_area. o: {x, y, color, color2?, gradient?, tolerance, gap, sample: all|layer, layerId, opacity}
    async computeFill(o) {
      const d = this.doc;
      const x0 = Math.floor(o.x), y0 = Math.floor(o.y);
      if (!(x0 >= 0 && y0 >= 0 && x0 < d.width && y0 < d.height)) return { reason: "That spot is outside the canvas." };
      let src = d;
      if (o.sample === "layer") {
        const layer = d.layers.find((l) => l.id === o.layerId);
        if (layer) src = Object.assign({}, d, { layers: [Object.assign({}, layer, { opacity: 1, blend: undefined, visible: true })] });
      }
      const c = await renderToCanvas(src, { scale: 1, transparent: o.sample === "layer" });
      const W = c.width, H = c.height;
      const data = c.getContext("2d").getImageData(0, 0, W, H).data;
      const i0 = (y0 * W + x0) * 4;
      const tr = data[i0], tg = data[i0 + 1], tb = data[i0 + 2], ta = data[i0 + 3];
      const tol = G.clamp(Number(o.tolerance ?? 48), 0, 255);
      const gap = Math.round(G.clamp(Number(o.gap) || 0, 0, 12));
      const same = new Uint8Array(W * H);
      for (let p = 0, i = 0; p < W * H; p++, i += 4) {
        same[p] = Math.abs(data[i] - tr) <= tol && Math.abs(data[i + 1] - tg) <= tol && Math.abs(data[i + 2] - tb) <= tol && Math.abs(data[i + 3] - ta) <= tol ? 1 : 0;
      }
      // Closing gaps: thicken the outlines before flooding, so the fill
      // cannot squeeze through breaks narrower than the gap.
      let open = same;
      if (gap > 0) {
        const wall = new Uint8Array(W * H);
        for (let p = 0; p < W * H; p++) wall[p] = same[p] ? 0 : 1;
        const thick = dilate(wall, W, H, gap);
        open = new Uint8Array(W * H);
        for (let p = 0; p < W * H; p++) open[p] = thick[p] ? 0 : 1;
        if (!open[y0 * W + x0]) open = same; // clicked right next to a line
      }
      let mask = new Uint8Array(W * H);
      const stack = [y0 * W + x0];
      let count = 0;
      while (stack.length) {
        const p = stack.pop();
        if (mask[p] || !open[p]) continue;
        const x = p % W;
        const y = (p - x) / W;
        let l = x;
        while (l > 0 && !mask[y * W + l - 1] && open[y * W + l - 1]) l--;
        let r = x;
        while (r < W - 1 && !mask[y * W + r + 1] && open[y * W + r + 1]) r++;
        let upRun = false, downRun = false;
        for (let xi = l; xi <= r; xi++) {
          const q = y * W + xi;
          mask[q] = 1; count++;
          if (y > 0) { const ok = !mask[q - W] && open[q - W]; if (ok && !upRun) stack.push(q - W); upRun = ok; }
          if (y < H - 1) { const ok = !mask[q + W] && open[q + W]; if (ok && !downRun) stack.push(q + W); downRun = ok; }
        }
      }
      if (!count) return { reason: "Nothing to fill there." };
      if (gap > 0) {
        // Grow back up to the real outlines (only into same-colored pixels).
        const grown = dilate(mask, W, H, gap + 1);
        for (let p = 0; p < W * H; p++) grown[p] = grown[p] && same[p] ? 1 : 0;
        for (let p = 0; p < W * H; p++) if (mask[p]) grown[p] = 1;
        mask = grown;
      }
      // Grow by 2 px so the fill tucks under anti-aliased line edges.
      mask = dilate(mask, W, H, 2);
      let minX = W, minY = H, maxX = -1, maxY = -1, filled = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (mask[y * W + x]) { filled++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
      const bw = maxX - minX + 1, bh = maxY - minY + 1;
      const out = JRender.makeCanvas(bw, bh);
      const octx = out.getContext("2d");
      const img = octx.createImageData(bw, bh);
      const rgb = G.hexToRgb(o.color);
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          if (!mask[y * W + x]) continue;
          const q = ((y - minY) * bw + (x - minX)) * 4;
          img.data[q] = rgb.r; img.data[q + 1] = rgb.g; img.data[q + 2] = rgb.b; img.data[q + 3] = Math.round(255 * rgb.a);
        }
      }
      octx.putImageData(img, 0, 0);
      if (o.color2 && (o.gradient === "linear" || o.gradient === "radial")) {
        const grad = o.gradient === "radial"
          ? octx.createRadialGradient(bw / 2, bh / 2, 0, bw / 2, bh / 2, Math.max(bw, bh) / 2)
          : octx.createLinearGradient(0, 0, 0, bh);
        grad.addColorStop(0, o.color);
        grad.addColorStop(1, o.color2);
        octx.globalCompositeOperation = "source-in";
        octx.fillStyle = grad;
        octx.fillRect(0, 0, bw, bh);
      }
      const item = { type: "image", name: "Fill", x: minX, y: minY, w: bw, h: bh, src: out.toDataURL("image/png") };
      if (o.opacity !== undefined && o.opacity < 1) item.opacity = o.opacity;
      return { item, filled };
    }

    async pickColor(dp) {
      const d = this.doc;
      const x = Math.floor(dp.x), y = Math.floor(dp.y);
      if (x < 0 || y < 0 || x >= d.width || y >= d.height) return;
      const c = await renderToCanvas(d, { scale: 1 });
      const px = c.getContext("2d").getImageData(x, y, 1, 1).data;
      const hex = "#" + [px[0], px[1], px[2]].map((v) => v.toString(16).padStart(2, "0")).join("");
      this.host.onColorPicked(hex);
    }

    // ---------- text
    openText(pt, existing) {
      const dp = existing ? { x: existing.x, y: existing.y - existing.size * 0.9 } : this.toDoc(pt.x, pt.y);
      const size = existing ? existing.size : this.textSize();
      const color = existing ? (typeof existing.fill === "string" ? existing.fill : this.brush.color) : this.brush.color;
      const ta = document.createElement("textarea");
      ta.className = "text-entry";
      ta.setAttribute("aria-label", "Text");
      ta.style.color = color;
      ta.value = existing ? existing.text : "";
      const grow = () => { ta.style.width = "10px"; ta.style.height = "10px"; ta.style.width = ta.scrollWidth + 8 + "px"; ta.style.height = ta.scrollHeight + "px"; };
      ta.addEventListener("input", grow);
      ta.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Escape") { this.textEntry = null; ta.remove(); }
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this.commitText(); }
      });
      // Using the bottom bar (text size, color) keeps the text open, so its
      // size can change while you type.
      ta.addEventListener("blur", (e) => {
        if (e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest(".dock")) return;
        setTimeout(() => this.textEntry && this.textEntry.ta === ta && document.activeElement !== ta && !(document.activeElement && document.activeElement.closest && document.activeElement.closest(".dock")) && this.commitText(), 0);
      });
      this.stage.appendChild(ta);
      setTimeout(() => ta.focus(), 0);
      this.textEntry = { ta, dp, size, color, existing, grow, layerId: this.host.activeLayer().id };
      this.positionTextEntry();
    }

    textSize() {
      return this.brush.textSize || Math.max(24, Math.round(this.brush.size * 4));
    }

    // Live size and color for the text being typed.
    styleTextEntry(patch) {
      const t = this.textEntry;
      if (!t) return;
      if (patch.size) t.size = patch.size;
      if (patch.color) { t.color = patch.color; t.ta.style.color = patch.color; }
      this.positionTextEntry();
    }

    focusTextEntry() {
      if (this.textEntry) this.textEntry.ta.focus();
    }

    positionTextEntry() {
      const t = this.textEntry;
      if (!t) return;
      const px = t.size * this.view.s;
      const font = `${t.existing ? t.existing.weight : 600} ${px}px ${t.existing ? t.existing.font : "Inter, Segoe UI, sans-serif"}`;
      // The font shorthand resets line-height, and the box puts its baseline
      // somewhere else than the canvas does (0.9 x size below the top). Line
      // both up so the text does not jump when it is placed.
      const m = (this._measure || (this._measure = document.createElement("canvas").getContext("2d")));
      m.font = font;
      const fm = m.measureText("Hg");
      const asc = fm.fontBoundingBoxAscent || px * 0.95, desc = fm.fontBoundingBoxDescent || px * 0.25;
      const boxBaseline = (px * 1.2 - (asc + desc)) / 2 + asc;
      const border = 1.5;
      // Offset from the text's top-left, in the (possibly turned) frame.
      const [ox, oy] = this.rot(-border, px * 0.9 - boxBaseline - border);
      const sp = this.toScreen(t.dp.x, t.dp.y);
      t.ta.style.left = sp.x + ox + "px";
      t.ta.style.top = sp.y + oy + "px";
      t.ta.style.transformOrigin = "0 0";
      t.ta.style.transform = this.view.r ? `rotate(${this.view.r}rad)` : "";
      t.ta.style.font = font;
      t.ta.style.lineHeight = "1.2";
      t.grow();
    }

    commitText() {
      const t = this.textEntry;
      if (!t) return;
      this.textEntry = null;
      const text = t.ta.value.replace(/\s+$/, "");
      t.ta.remove();
      if (t.existing) {
        if (!text) this.host.apply([{ op: "delete_items", ids: [t.existing.id] }]);
        else {
          const patch = {};
          if (text !== t.existing.text) patch.text = text;
          if (t.size !== t.existing.size) patch.size = t.size;
          if (t.color !== (typeof t.existing.fill === "string" ? t.existing.fill : t.color)) patch.fill = t.color;
          if (Object.keys(patch).length) this.host.apply([{ op: "update_items", ids: [t.existing.id], patch }]);
        }
        return;
      }
      if (!text) return;
      this.host.apply([{ op: "add_items", layerId: t.layerId, items: [{ type: "text", text, x: t.dp.x, y: t.dp.y + t.size * 0.9, size: t.size, fill: t.color, opacity: this.brush.opacity }] }]);
    }
  }

  // ---------- geometry helpers
  function union(a, b) {
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
  }

  function segDist(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  function pointInPoly(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  // Square dilation of a 0/1 mask by r pixels (two sliding-window passes).
  function dilate(src, W, H, r) {
    if (r <= 0) return src.slice();
    const tmp = new Uint8Array(W * H), out = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      let n = 0;
      const row = y * W;
      for (let x = 0; x < Math.min(W, r); x++) n += src[row + x];
      for (let x = 0; x < W; x++) {
        if (x + r < W) n += src[row + x + r];
        if (x - r - 1 >= 0) n -= src[row + x - r - 1];
        tmp[row + x] = n > 0 ? 1 : 0;
      }
    }
    for (let x = 0; x < W; x++) {
      let n = 0;
      for (let y = 0; y < Math.min(H, r); y++) n += tmp[y * W + x];
      for (let y = 0; y < H; y++) {
        if (y + r < H) n += tmp[(y + r) * W + x];
        if (y - r - 1 >= 0) n -= tmp[(y - r - 1) * W + x];
        out[y * W + x] = n > 0 ? 1 : 0;
      }
    }
    return out;
  }

  // Points spaced evenly along a polyline.
  function resample(pts, step) {
    const out = [pts[0]];
    let carry = 0;
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
      const len = Math.hypot(bx - ax, by - ay);
      let t = step - carry;
      while (t <= len) { out.push([ax + ((bx - ax) * t) / len, ay + ((by - ay) * t) / len]); t += step; }
      carry = len - (t - step);
    }
    return out;
  }

  function linePoints(a, b, size) {
    const n = Math.max(2, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / Math.max(2, size / 2)));
    const out = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const taper = Math.min(1, Math.min(t, 1 - t) * 8 + 0.35);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, 0.8 * taper]);
    }
    return out;
  }

  function ellipsePoints(cx, cy, rx, ry) {
    const n = Math.max(24, Math.ceil((Math.PI * (rx + ry)) / 4));
    const out = [];
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      out.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry, 0.8]);
    }
    return out;
  }

  // Ramer-Douglas-Peucker on x/y, keeping pressure.
  function simplify(pts, eps) {
    if (pts.length < 4) return pts;
    const keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [s, e] = stack.pop();
      let max = 0, idx = -1;
      for (let i = s + 1; i < e; i++) {
        const d = segDist(pts[i][0], pts[i][1], pts[s][0], pts[s][1], pts[e][0], pts[e][1]) + Math.abs(pts[i][2] - (pts[s][2] + pts[e][2]) / 2) * 0.5;
        if (d > max) { max = d; idx = i; }
      }
      if (max > eps && idx > 0) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
    }
    return pts.filter((_, i) => keep[i]);
  }

  function isTyping(e) {
    const t = e.target;
    return t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
  }

  window.CanvasView = CanvasView;
  window.isTyping = isTyping;
})();
