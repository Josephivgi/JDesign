// The editor: top bar, tool rail, paint dock, side panel (assistant and
// layers). The main process owns the drawing; every edit goes through
// doc:apply and comes back as doc:changed.
(function () {
  const G = window.JGeom;
  const { el, esc, showMenu, toast, openDialog } = UI;

  const TOOLS = [
    { id: "select", icon: "select", label: "Select and move", key: "V" },
    { id: "brush", icon: "brush", label: "Brush", key: "B" },
    { id: "eraser", icon: "eraser", label: "Eraser", key: "E" },
    { id: "shape", icon: "shapes", label: "Shapes", key: "U" },
    { id: "fill", icon: "fill", label: "Fill", key: "G" },
    { id: "eyedropper", icon: "eyedropper", label: "Pick a color", key: "I" },
    { id: "text", icon: "text", label: "Text", key: "T" },
    "sep",
    { id: "hand", icon: "hand", label: "Move the view", key: "H" },
  ];
  const BRUSHES = [
    { id: "pen", icon: "brush", label: "Ink pen" },
    { id: "pencil", icon: "pencil", label: "Pencil" },
    { id: "marker", icon: "marker", label: "Marker" },
    { id: "airbrush", icon: "airbrush", label: "Airbrush" },
    { id: "calligraphy", icon: "calligraphy", label: "Calligraphy pen" },
    { id: "watercolor", icon: "watercolor", label: "Watercolor" },
    { id: "smudge", icon: "smudge", label: "Smudge: drag paint around" },
    { id: "blur", icon: "blur", label: "Blur: soften what is under it" },
  ];
  const SHAPES = [
    { id: "rect", icon: "square", label: "Rectangle" },
    { id: "ellipse", icon: "circle", label: "Ellipse" },
    { id: "line", icon: "line", label: "Line" },
    { id: "arrow", icon: "arrow", label: "Arrow" },
    { id: "polygon", icon: "polygon", label: "Polygon" },
    { id: "star", icon: "star", label: "Star" },
    { id: "freeform", icon: "freeform", label: "Freeform shape: draw its outline" },
  ];
  const TOOL_PREF_KEYS = ["shapeKind", "shapeFill", "shapeSides", "starPoints", "lineDash", "paintMode", "color2", "symmetry", "selectMode"];
  const BLENDS = [
    ["source-over", "Normal"], ["multiply", "Multiply"], ["screen", "Screen"], ["overlay", "Overlay"],
    ["soft-light", "Soft light"], ["darken", "Darken"], ["lighten", "Lighten"], ["color", "Color"],
  ];

  class Editor {
    constructor(root, app, id) {
      this.root = root;
      this.app = app;
      this.id = id;
      this.doc = null;
      this.meta = null;
      this.selection = [];
      this.activeLayerId = null;
      this.canUndo = false;
      this.canRedo = false;
      this.panelTab = "assistant";
      this.offs = [];
    }

    async mount() {
      const data = await jdraw.call("drawings:open", this.id);
      this.doc = data.doc;
      this.meta = data.meta;
      this.canUndo = data.canUndo;
      this.canRedo = data.canRedo;
      this.activeLayerId = this.doc.layers[this.doc.layers.length - 1].id;
      this.build();
      const pref = (k, d) => jdraw.call("prefs:get", k, d).catch(() => d);
      const savedBrush = await pref("brush", null);
      if (savedBrush) Object.assign(this.cv.brush, savedBrush);
      const tools = await pref("toolOptions", null);
      if (tools) {
        for (const k of TOOL_PREF_KEYS) if (tools[k] !== undefined) this.cv[k] = tools[k];
        if (tools.fill) Object.assign(this.cv.fill, tools.fill);
      }
      const view = await pref("view", null);
      if (view) { Object.assign(this.cv.grid, view.grid || {}); this.cv.rulers = !!view.rulers; }
      if (!this.embedded) {
        this.setPanelWidth(await pref("panelWidth", 440));
        this.setPanel(await pref("panelOpen", true));
      }
      this.setLayersOpen(await pref("layersOpen", true));
      this.layers.setCollapsed(await pref("layersCollapsed", false));
      this.cv.fit();
      this.cv.setTool("brush");
      this.renderRail();
      this.renderDock();
      this.layers.update();
      this.renderTop();
      if (this.assistant.load) await this.assistant.load(data.chat, data.busy, data.canUndoTurn, data.chats);
      if (data.busy) this.setBusy(true, "Assistant");
      this.pushContext();
      this.subscribe();
      this.bindKeys();
      this.bindDrop();
    }

    unmount() {
      for (const off of this.offs) off();
      this.offs = [];
      window.removeEventListener("keydown", this._keys);
      if (this.cv) { this.cv.commitText(); this.cv.destroy(); }
      clearTimeout(this._thumbT);
      this.saveThumb();
      jdraw.call("drawings:close", this.id).catch(() => {});
    }

    activeLayer() {
      return this.doc.layers.find((l) => l.id === this.activeLayerId) || this.doc.layers[this.doc.layers.length - 1];
    }

    // ---------- layout
    build() {
      this.embedded = !!(this.app && this.app.embedded);
      this.root.innerHTML = "";
      const top = el(`<header class="topbar drag">
        ${this.embedded ? "" : `<button type="button" class="icon-btn back" title="All drawings" aria-label="All drawings">${icon("back")}</button>`}
        <input class="name-input" aria-label="Drawing name" spellcheck="false">
        <span class="divider"></span>
        <button type="button" class="icon-btn undo" title="Undo (Ctrl+Z)" aria-label="Undo">${icon("undo")}</button>
        <button type="button" class="icon-btn redo" title="Redo (Ctrl+Y)" aria-label="Redo">${icon("redo")}</button>
        <span class="spacer"></span>
        <div class="zoom no-drag">
          <button type="button" class="icon-btn zout" title="Zoom out" aria-label="Zoom out">${icon("minus")}</button>
          <button type="button" class="pct" title="View: zoom, turn, grid, rulers">100%</button>
          <button type="button" class="icon-btn zin" title="Zoom in" aria-label="Zoom in">${icon("plus")}</button>
        </div>
        <span class="divider"></span>
        <button type="button" class="icon-btn canvas-btn" title="Canvas size and paper" aria-label="Canvas size and paper">${icon("canvas")}</button>
        <button type="button" class="btn export">${icon("download")}Export</button>
        <button type="button" class="icon-btn layers-toggle" title="Layers" aria-label="Show layers">${icon("layers")}</button>
        ${this.embedded ? "" : `<button type="button" class="icon-btn panel-toggle" title="Assistant" aria-label="Show assistant">${icon("sparkles")}</button>`}
      </header>`);
      this.root.appendChild(top);
      const editor = el(`<div class="editor">
        <section class="stage" aria-label="Canvas">
          <nav class="rail" aria-label="Tools"></nav>
          <div class="dock" aria-label="Paint"></div>
        </section>
        ${this.embedded ? "" : `<aside class="panel" aria-label="Assistant">
          <div class="panel-resize" title="Drag to resize" aria-hidden="true"></div>
          <div class="panel-head">${icon("sparkles")}<span>Assistant</span><span style="flex:1"></span><button type="button" class="icon-btn close-panel" title="Hide assistant" aria-label="Hide assistant">${icon("x")}</button></div>
          <div class="panel-body assistant-body"></div>
        </aside>`}
      </div>`);
      this.root.appendChild(editor);
      this.stage = editor.querySelector(".stage");
      this.panel = editor.querySelector(".panel");
      this.rail = editor.querySelector(".rail");
      this.dock = editor.querySelector(".dock");

      this.cv = new CanvasView(this.stage, {
        getDoc: () => this.doc,
        activeLayer: () => this.activeLayer(),
        apply: (ops) => this.apply(ops),
        onSelection: (ids) => {
          this.selection = ids;
          // Selecting something makes its layer the active one.
          const f = ids.length ? G.findItem(this.doc, ids[ids.length - 1]) : null;
          if (f && f.layer.id !== this.activeLayerId) { this.activeLayerId = f.layer.id; this.layers.update(); }
          this.pushContext();
          this.assistant.renderChips();
          this.assistant.updateContext();
          if (this.cv.tool === "select") this.renderDock();
        },
        onZoom: (s) => { const p = this.root.querySelector(".pct"); if (p) p.textContent = Math.round(s * 100) + "%"; },
        onColorPicked: (hex) => { this.setBrush({ color: hex }); toast(`Picked ${hex}`, { ms: 1200 }); if (this._prevTool) this.setTool(this._prevTool); },
        toast: (t, o) => toast(t, o),
        rightInset: () => (this.layersOpen && this.layers && !this.layers.collapsed ? 300 : 32),
      });
      // Embedded mode has no assistant panel (the project chat lives in JV):
      // a stub keeps the shared canvas/layers code paths safe.
      this.assistant = this.embedded
        ? { load: null, renderChips() {}, updateContext() {}, onEvent() {}, cancel() {} }
        : new Assistant(editor.querySelector(".assistant-body"), this);
      this.layers = new LayersPanel(this.stage, this);
      const closePanel = editor.querySelector(".close-panel");
      if (closePanel) closePanel.addEventListener("click", () => this.setPanel(false));
      const resizeHandle = editor.querySelector(".panel-resize");
      if (resizeHandle) this.bindResize(resizeHandle);

      const backBtn = top.querySelector(".back");
      if (backBtn) backBtn.addEventListener("click", () => this.app.goHome());
      const name = top.querySelector(".name-input");
      name.value = this.meta.name;
      name.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter" || e.key === "Escape") { if (e.key === "Escape") name.value = this.meta.name; name.blur(); } });
      name.addEventListener("blur", async () => {
        if (name.value.trim() === this.meta.name) return;
        this.meta.name = await jdraw.call("drawings:rename", this.id, name.value);
        name.value = this.meta.name;
      });
      top.querySelector(".undo").addEventListener("click", () => this.undo());
      top.querySelector(".redo").addEventListener("click", () => this.redo());
      top.querySelector(".zin").addEventListener("click", () => this.cv.zoomAt(1.25));
      top.querySelector(".zout").addEventListener("click", () => this.cv.zoomAt(0.8));
      top.querySelector(".pct").addEventListener("click", (e) => this.viewMenu(e.currentTarget));
      top.querySelector(".canvas-btn").addEventListener("click", () => this.canvasDialog());
      top.querySelector(".export").addEventListener("click", (e) => this.exportMenu(e.currentTarget));
      const panelToggle = top.querySelector(".panel-toggle");
      if (panelToggle) panelToggle.addEventListener("click", () => this.setPanel(!this.panelOpen));
      top.querySelector(".layers-toggle").addEventListener("click", () => this.setLayersOpen(!this.layersOpen));
    }

    setPanel(open) {
      if (!this.panel) return;
      this.panelOpen = open;
      this.panel.classList.toggle("hidden", !open);
      this.root.querySelector(".panel-toggle").classList.toggle("on", open);
      jdraw.call("prefs:set", "panelOpen", open).catch(() => {});
    }

    setLayersOpen(open) {
      this.layersOpen = open;
      this.layers.setVisible(open);
      this.root.querySelector(".layers-toggle").classList.toggle("on", open);
      jdraw.call("prefs:set", "layersOpen", open).catch(() => {});
    }

    setPanelWidth(w) {
      const max = Math.max(360, Math.min(760, window.innerWidth - 520));
      this.panelWidth = Math.round(Math.max(340, Math.min(max, Number(w) || 440)));
      this.panel.style.width = this.panelWidth + "px";
    }

    bindResize(handle) {
      handle.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        try { handle.setPointerCapture(e.pointerId); } catch {}
        const startX = e.clientX, startW = this.panelWidth;
        document.body.classList.add("resizing");
        // Listen on the window so the drag keeps going wherever the pointer goes.
        const move = (ev) => this.setPanelWidth(startW + (startX - ev.clientX));
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          document.body.classList.remove("resizing");
          jdraw.call("prefs:set", "panelWidth", this.panelWidth).catch(() => {});
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      });
      handle.addEventListener("dblclick", () => { this.setPanelWidth(440); jdraw.call("prefs:set", "panelWidth", 440).catch(() => {}); });
    }

    setActiveLayer(id) {
      if (!this.doc.layers.some((l) => l.id === id)) return;
      this.activeLayerId = id;
      this.layers.update();
      this.pushContext();
    }

    renderTop() {
      this.root.querySelector(".undo").disabled = !this.canUndo;
      this.root.querySelector(".redo").disabled = !this.canRedo;
    }

    renderRail() {
      this.rail.innerHTML = "";
      for (const t of TOOLS) {
        if (t === "sep") { this.rail.appendChild(el('<div class="sep"></div>')); continue; }
        const b = el(`<button type="button" class="icon-btn ${this.cv.tool === t.id ? "on" : ""}" aria-label="${esc(t.label)}" aria-pressed="${this.cv.tool === t.id}">${icon(t.icon)}<span class="tip">${esc(t.label)}<span class="kbd">${t.key}</span></span></button>`);
        b.addEventListener("click", () => this.setTool(t.id));
        this.rail.appendChild(b);
      }
    }

    setTool(id) {
      if (id === "eyedropper" && this.cv.tool !== "eyedropper") this._prevTool = this.cv.tool;
      this.cv.setTool(id);
      if (id !== "select" && this.selection.length) { this.selection = []; this.pushContext(); }
      this.renderRail();
      this.renderDock();
    }

    renderDock() {
      const b = this.cv.brush;
      const tool = this.cv.tool;
      const cv = this.cv;
      this.dock.innerHTML = "";
      const sep = () => this.dock.appendChild(el('<span class="vsep"></span>'));
      const pick = (label, list, current, onPick) => {
        const g = el(`<div class="brush-pick" role="group" aria-label="${esc(label)}"></div>`);
        for (const it of list) {
          const btn = el(`<button type="button" class="icon-btn ${current === it.id ? "on" : ""}" title="${esc(it.label)}" aria-label="${esc(it.label)}" aria-pressed="${current === it.id}">${icon(it.icon)}</button>`);
          btn.addEventListener("click", () => onPick(it.id));
          g.appendChild(btn);
        }
        this.dock.appendChild(g);
      };
      const seg = (label, options, current, onPick) => {
        const s = el(`<div class="seg" role="group" aria-label="${esc(label)}"></div>`);
        for (const [v, text] of options) {
          const x = el(`<button type="button" class="${current === v ? "on" : ""}" aria-pressed="${current === v}">${esc(text)}</button>`);
          x.addEventListener("click", () => onPick(v));
          s.appendChild(x);
        }
        this.dock.appendChild(s);
        return s;
      };
      const iconBtn = (name, title, onClick, on) => {
        const x = el(`<button type="button" class="icon-btn ${on ? "on" : ""}" title="${esc(title)}" aria-label="${esc(title)}">${icon(name)}</button>`);
        x.addEventListener("click", (e) => onClick(e.currentTarget));
        this.dock.appendChild(x);
        return x;
      };
      const symmetryBtn = () => {
        const labels = { off: "Mirror: off", v: "Mirror left and right", h: "Mirror top and bottom", both: "Mirror four ways" };
        iconBtn("symmetry", labels[cv.symmetry], (anchor) => showMenu(anchor, [
          { heading: true, label: "Mirror drawing" },
          ...Object.entries(labels).map(([k, v]) => ({ label: k === "off" ? "Off" : v, check: cv.symmetry === k, onClick: () => { cv.symmetry = k; this.saveToolPrefs(); this.renderDock(); cv.requestDraw(); } })),
        ], { above: true }), cv.symmetry !== "off");
      };

      if (tool === "brush") {
        pick("Brush", BRUSHES, b.brush, (id) => this.setBrush({ brush: id }));
        if (!["smudge", "blur"].includes(b.brush)) symmetryBtn();
        sep();
      } else if (tool === "eraser") {
        symmetryBtn();
        sep();
      } else if (tool === "shape") {
        pick("Shape", SHAPES, cv.shapeKind, (id) => { cv.shapeKind = id; this.saveToolPrefs(); this.renderDock(); });
        const lineLike = cv.shapeKind === "line" || cv.shapeKind === "arrow";
        if (!lineLike) seg("Shape style", [[false, "Outline"], [true, "Filled"]], cv.shapeFill, (v) => { cv.shapeFill = v; this.saveToolPrefs(); this.renderDock(); });
        if (cv.shapeKind === "polygon") this.dock.appendChild(this.slider("Sides", cv.shapeSides, 3, 12, (v) => String(v), (v) => { cv.shapeSides = v; this.saveToolPrefs(); }));
        if (cv.shapeKind === "star") this.dock.appendChild(this.slider("Points", cv.starPoints, 3, 12, (v) => String(v), (v) => { cv.starPoints = v; this.saveToolPrefs(); }));
        if (lineLike || !cv.shapeFill) seg("Line style", [["solid", "Solid"], ["dashed", "Dashed"], ["dotted", "Dotted"]], cv.lineDash, (v) => { cv.lineDash = v; this.saveToolPrefs(); this.renderDock(); });
        sep();
      } else if (tool === "fill") {
        this.dock.appendChild(this.slider("Tolerance", cv.fill.tolerance, 0, 160, (v) => String(v), (v) => { cv.fill.tolerance = v; this.saveToolPrefs(); }));
        this.dock.appendChild(this.slider("Close gaps", cv.fill.gap, 0, 12, (v) => (v ? v + " px" : "Off"), (v) => { cv.fill.gap = v; this.saveToolPrefs(); }));
        seg("Fill looks at", [["all", "All layers"], ["layer", "This layer"]], cv.fill.sample, (v) => { cv.fill.sample = v; this.saveToolPrefs(); this.renderDock(); });
        sep();
      }

      if (tool === "select") {
        this.renderSelectDock(seg, iconBtn, sep);
        this.groupDock();
        return;
      }

      if (tool !== "eraser" && tool !== "hand" && !(tool === "brush" && ["smudge", "blur"].includes(b.brush))) {
        this.colorControls(tool);
      }

      if (tool !== "hand" && tool !== "eyedropper") {
        if (tool !== "fill" && tool !== "text") this.dock.appendChild(this.slider("Size", b.size, 1, 200, (v) => v + " px", (v) => this.setBrush({ size: v }, true), true));
        if (tool === "text") {
          const cur = cv.textEntry ? cv.textEntry.size : cv.textSize();
          this.dock.appendChild(this.slider("Text size", cur, 8, 400, (v) => v + " px", (v) => { this.setBrush({ textSize: v }, true); cv.styleTextEntry({ size: v }); }, true, () => cv.focusTextEntry()));
        }
        const strengthLabel = tool === "brush" && ["smudge", "blur"].includes(b.brush) ? "Strength" : "Opacity";
        if (tool !== "eraser") this.dock.appendChild(this.slider(strengthLabel, Math.round(b.opacity * 100), 5, 100, (v) => v + "%", (v) => this.setBrush({ opacity: v / 100 }, true)));
        if ((tool === "brush" && !["smudge", "blur"].includes(b.brush)) || tool === "eraser") this.dock.appendChild(this.slider("Steady", Math.round(b.steady * 100), 0, 100, (v) => v + "%", (v) => this.setBrush({ steady: v / 100 }, true)));
      }
      if (tool === "hand") this.dock.appendChild(el(`<span class="dock-note">Drag to move around. Scroll to zoom.</span>`));
      if (tool === "eyedropper") this.dock.appendChild(el(`<span class="dock-note">Click the drawing to pick a color</span>`));
      this.groupDock();
    }

    // The dock is built as one flat run with separators. Each run between two
    // separators becomes a group, so a narrow dock wraps whole groups (tool
    // options, color, sliders) and never leaves one slider alone on a row.
    groupDock() {
      let group = null;
      for (const node of [...this.dock.children]) {
        if (node.classList.contains("vsep")) { group = null; node.remove(); continue; }
        if (!group) { group = el('<div class="group"></div>'); this.dock.insertBefore(group, node); }
        group.appendChild(node);
      }
    }

    // Current color, gradient choice and palette.
    colorControls(tool) {
      const b = this.cv.brush;
      const cv = this.cv;
      const cur = el(`<label class="current-color" title="Color ${esc(b.color)}" style="background:${esc(b.color)}"><input type="color" aria-label="Color" value="${esc(b.color.slice(0, 7))}"></label>`);
      const inp = cur.querySelector("input");
      inp.addEventListener("input", () => { cur.style.background = inp.value; this.cv.brush.color = inp.value; this.markSwatch(); });
      inp.addEventListener("change", () => this.setBrush({ color: inp.value }));
      this.dock.appendChild(cur);
      if (tool === "shape" || tool === "fill") {
        const s = el(`<div class="seg" role="group" aria-label="Paint"></div>`);
        for (const [v, text] of [["solid", "Plain"], ["linear", "Gradient"], ["radial", "Radial"]]) {
          const x = el(`<button type="button" class="${cv.paintMode === v ? "on" : ""}" aria-pressed="${cv.paintMode === v}">${text}</button>`);
          x.addEventListener("click", () => { cv.paintMode = v; this.saveToolPrefs(); this.renderDock(); });
          s.appendChild(x);
        }
        this.dock.appendChild(s);
        if (cv.paintMode !== "solid") {
          const c2 = el(`<label class="current-color second" title="Second color ${esc(cv.color2)}" style="background:${esc(cv.color2)}"><input type="color" aria-label="Second gradient color" value="${esc(cv.color2.slice(0, 7))}"></label>`);
          const i2 = c2.querySelector("input");
          i2.addEventListener("input", () => { c2.style.background = i2.value; cv.color2 = i2.value; });
          i2.addEventListener("change", () => { cv.color2 = i2.value; this.saveToolPrefs(); });
          this.dock.appendChild(c2);
        }
      }
      const pal = el('<div class="palette" role="group" aria-label="Palette"></div>');
      const fresh = this._freshColors || new Set();
      for (const c of this.doc.palette) {
        const sw = el(`<button type="button" class="swatch ${fresh.has(c) ? "fresh" : ""}" title="${esc(c)}" aria-label="Color ${esc(c)}" style="background:${esc(c)}"></button>`);
        sw.dataset.c = c;
        sw.addEventListener("click", () => {
          this.setBrush({ color: c });
          if (this.cv.tool === "select" && this.selection.length) this.colorSelection(c);
        });
        sw.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          showMenu(sw, [{ label: "Remove from palette", icon: "trash", onClick: () => this.apply([{ op: "set_doc", palette: this.doc.palette.filter((x) => x !== c) }]) }], { above: true });
        });
        pal.appendChild(sw);
      }
      this._freshColors = null;
      const add = el(`<button type="button" class="swatch add" title="Add the current color to the palette" aria-label="Add color to palette">${icon("plus")}</button>`);
      add.addEventListener("click", () => this.apply([{ op: "set_doc", addColors: [this.cv.brush.color] }]));
      pal.appendChild(add);
      this.dock.appendChild(pal);
      this.markSwatch();
      this.dock.appendChild(el('<span class="vsep"></span>'));
    }

    selectedItems() {
      return this.selection.map((id) => G.findItem(this.doc, id)).filter(Boolean).map((f) => f.item);
    }

    renderSelectDock(seg, iconBtn, sep) {
      const cv = this.cv;
      const n = this.selection.length;
      seg("Select with", [["box", "Box"], ["lasso", "Lasso"]], cv.selectMode, (v) => { cv.selectMode = v; this.saveToolPrefs(); this.renderDock(); });
      if (!n) {
        this.dock.appendChild(el(`<span class="dock-note">Click or drag to select. Alt+drag copies.</span>`));
        return;
      }
      sep();
      this.dock.appendChild(el(`<span class="dock-note">${n} selected</span>`));
      const items = this.selectedItems();
      const first = items[0];
      // Color of what is selected.
      const colorOf = (it) => (it.type === "stroke" ? it.color : typeof it.fill === "string" ? it.fill : typeof it.stroke === "string" ? it.stroke : null);
      const c0 = items.map(colorOf).find(Boolean);
      if (c0) {
        const cur = el(`<label class="current-color" title="Color of the selection" style="background:${esc(c0)}"><input type="color" aria-label="Color of the selection" value="${esc(c0.slice(0, 7))}"></label>`);
        const inp = cur.querySelector("input");
        inp.addEventListener("input", () => { cur.style.background = inp.value; });
        inp.addEventListener("change", () => this.colorSelection(inp.value));
        this.dock.appendChild(cur);
      }
      if (first) {
        this.dock.appendChild(this.slider("Opacity", Math.round((first.opacity ?? 1) * 100), 5, 100, (v) => v + "%", () => {}, false,
          (v) => this.apply([{ op: "update_items", ids: this.selection, patch: { opacity: v / 100 } }])));
      }
      const lined = items.filter((it) => it.type === "stroke" || (it.stroke && it.type !== "text"));
      if (lined.length) {
        const w0 = lined[0].type === "stroke" ? lined[0].size : lined[0].strokeWidth;
        this.dock.appendChild(this.slider("Line width", Math.round(w0), 1, 200, (v) => v + " px", () => {}, true,
          (v) => this.apply(lined.map((it) => ({ op: "update_items", ids: [it.id], patch: it.type === "stroke" ? { size: v } : { strokeWidth: v } })))));
      }
      const texts = items.filter((it) => it.type === "text");
      if (texts.length) {
        // Preview on the canvas while dragging, save once on release.
        this.dock.appendChild(this.slider("Text size", texts[0].size, 8, 400, (v) => v + " px", (v) => { texts.forEach((it) => (it.size = v)); cv.styleTextEntry({ size: v }); cv.requestDraw(); }, true,
          (v) => { this.apply([{ op: "update_items", ids: texts.map((it) => it.id), patch: { size: v } }]); cv.focusTextEntry(); }));
      }
      const lines = items.filter((it) => it.type === "line" || (it.type === "polygon" && !it.closed));
      if (lines.length) {
        const both = lines.every((it) => it.arrowEnd);
        iconBtn("arrow", both ? "Remove arrowheads" : "Add arrowheads", () => this.apply([{ op: "update_items", ids: lines.map((it) => it.id), patch: { arrowEnd: !both } }]), both);
      }
      sep();
      iconBtn("copy", "Duplicate (Ctrl+D)", () => this.duplicateSelection());
      iconBtn("rotate", "Rotate 90 degrees", () => this.apply([{ op: "transform_items", ids: this.selection, rotate: 90 }]));
      iconBtn("flipH", "Flip left to right (Shift+H)", () => this.apply([{ op: "transform_items", ids: this.selection, flip: "x" }]));
      iconBtn("flipV", "Flip top to bottom (Shift+V)", () => this.apply([{ op: "transform_items", ids: this.selection, flip: "y" }]));
      iconBtn("arrange", "Arrange", (anchor) => showMenu(anchor, [
        { heading: true, label: "Arrange" },
        { label: "Bring to front", hint: "Ctrl+Shift+]", onClick: () => this.order("front") },
        { label: "Bring forward", hint: "Ctrl+]", onClick: () => this.order("forward") },
        { label: "Send backward", hint: "Ctrl+[", onClick: () => this.order("backward") },
        { label: "Send to back", hint: "Ctrl+Shift+[", onClick: () => this.order("back") },
      ], { above: true }));
      iconBtn("alignL", n === 1 ? "Align to the canvas" : "Align", (anchor) => {
        const a = (how) => this.apply([{ op: "align_items", ids: this.selection, how }]);
        const rows = [
          { heading: true, label: n === 1 ? "Align to the canvas" : "Align" },
          { label: "Left", icon: "alignL", onClick: () => a("left") },
          { label: "Center", icon: "alignC", onClick: () => a("center") },
          { label: "Right", icon: "alignR", onClick: () => a("right") },
          { label: "Top", icon: "alignT", onClick: () => a("top") },
          { label: "Middle", icon: "alignM", onClick: () => a("middle") },
          { label: "Bottom", icon: "alignB", onClick: () => a("bottom") },
        ];
        if (n > 1) rows.push("sep", { label: "Center on the canvas", icon: "fit", onClick: () => this.apply([{ op: "align_items", ids: this.selection, how: "center", to: "canvas" }, { op: "align_items", ids: this.selection, how: "middle", to: "canvas" }]) });
        if (n >= 3) rows.push("sep", { label: "Space out side to side", icon: "distH", onClick: () => this.apply([{ op: "distribute_items", ids: this.selection, dir: "horizontal" }]) },
          { label: "Space out top to bottom", icon: "distV", onClick: () => this.apply([{ op: "distribute_items", ids: this.selection, dir: "vertical" }]) });
        showMenu(anchor, rows, { above: true });
      });
      const grouped = items.some((it) => it.group);
      const oneGroup = grouped && new Set(items.map((it) => it.group)).size === 1 && items.every((it) => it.group);
      if (n > 1 && !oneGroup) iconBtn("group", "Group (Ctrl+G)", () => this.groupSelection());
      if (grouped) iconBtn("ungroup", "Ungroup (Ctrl+Shift+G)", () => this.ungroupSelection());
      const toLayer = iconBtn("layers", "Move to layer", () => showMenu(toLayer, [
        { heading: true, label: "Move to layer" },
        ...[...this.doc.layers].reverse().map((l) => ({ label: l.name, check: l.id === this.activeLayerId, onClick: async () => { await this.apply([{ op: "move_to_layer", ids: this.selection, layerId: l.id }]); this.setActiveLayer(l.id); } })),
        "sep",
        { label: "New layer", icon: "plus", onClick: async () => { const name = `Layer ${this.doc.layers.length + 1}`; const [r] = await this.apply([{ op: "move_to_layer", ids: this.selection, layerId: name }]); if (r && r.layerId) this.setActiveLayer(r.layerId); } },
      ], { above: true }));
      iconBtn("more", "More", (anchor) => showMenu(anchor, [
        { label: "Copy", icon: "copy", hint: "Ctrl+C", onClick: () => this.copySelection(false) },
        { label: "Cut", icon: "cut", hint: "Ctrl+X", onClick: () => this.copySelection(true) },
        { label: "Paste", icon: "paste", hint: "Ctrl+V", onClick: () => this.paste() },
        "sep",
        { label: "Export selection as PNG", icon: "image", onClick: () => this.exportSelection("png") },
        { label: "Export selection as SVG", icon: "image", onClick: () => this.exportSelection("svg") },
      ], { above: true }));
      iconBtn("trash", "Delete (Del)", () => this.deleteSelection());
    }

    // Size uses a curved scale so small sizes are easy to hit.
    slider(label, value, min, max, fmt, onChange, curved, onCommit) {
      const toPos = (v) => (curved ? Math.round(Math.sqrt((v - min) / (max - min)) * 1000) : v);
      const fromPos = (p) => (curved ? Math.max(min, Math.round(min + (p / 1000) ** 2 * (max - min))) : Number(p));
      const node = el(`<label class="slider"><span class="lab">${esc(label)}<b>${esc(fmt(value))}</b></span><input type="range" min="${curved ? 0 : min}" max="${curved ? 1000 : max}" value="${toPos(value)}" aria-label="${esc(label)}"></label>`);
      const input = node.querySelector("input");
      const out = node.querySelector("b");
      input.addEventListener("input", () => { const v = fromPos(input.value); out.textContent = fmt(v); onChange(v); });
      if (onCommit) input.addEventListener("change", () => onCommit(fromPos(input.value)));
      input.addEventListener("keydown", (e) => e.stopPropagation());
      node.dataset.label = label;
      return node;
    }

    saveToolPrefs() {
      const o = { fill: this.cv.fill };
      for (const k of TOOL_PREF_KEYS) o[k] = this.cv[k];
      clearTimeout(this._toolSave);
      this._toolSave = setTimeout(() => jdraw.call("prefs:set", "toolOptions", o).catch(() => {}), 300);
    }

    saveViewPrefs() {
      jdraw.call("prefs:set", "view", { grid: this.cv.grid, rulers: this.cv.rulers }).catch(() => {});
    }

    // ---------- selection actions
    colorSelection(c) {
      const ops = [];
      for (const it of this.selectedItems()) {
        if (it.type === "image") continue;
        let patch;
        if (it.type === "stroke") patch = { color: c };
        else if (it.type === "line") patch = { stroke: c };
        else if (it.type === "text" || it.fill) patch = { fill: c };
        else patch = { stroke: c };
        ops.push({ op: "update_items", ids: [it.id], patch });
      }
      if (ops.length) this.apply(ops);
    }

    order(to) {
      if (this.selection.length) this.apply([{ op: "order_items", ids: this.selection, to }]);
    }

    async selectNew(promise) {
      const res = await promise;
      const ids = res && res[0] && res[0].ids;
      if (!ids || !ids.length) return;
      if (this.cv.tool !== "select") this.setTool("select");
      this.selection = ids;
      this.cv.setSelection(ids);
      this.pushContext();
      this.renderDock();
    }

    duplicateSelection() {
      if (this.selection.length) this.selectNew(this.apply([{ op: "duplicate_items", ids: this.selection, dx: 20, dy: 20 }]));
    }

    groupSelection() {
      if (this.selection.length > 1) this.apply([{ op: "group_items", ids: this.selection }]).then(() => this.renderDock());
    }

    ungroupSelection() {
      if (this.selection.length) this.apply([{ op: "ungroup_items", ids: this.selection }]).then(() => this.renderDock());
    }

    // Selected items in stacking order (bottom layer first).
    orderedSelection() {
      const ids = new Set(this.selection);
      const out = [];
      for (const l of this.doc.layers) for (const it of l.items) if (ids.has(it.id)) out.push(it);
      return out;
    }

    async copySelection(cut) {
      const items = this.orderedSelection();
      if (!items.length) return;
      const box = G.unionBox(items.map(G.bounds));
      let png = null;
      try {
        const c = await JRender.renderToCanvas(this.doc, { ids: this.selection, transparent: true, crop: { x: Math.floor(box.x), y: Math.floor(box.y), w: Math.ceil(box.w) + 1, h: Math.ceil(box.h) + 1 } });
        png = c.toDataURL("image/png");
      } catch {}
      const text = "jdraw-items:" + JSON.stringify({ from: this.id, items });
      this._pasteN = 0;
      await jdraw.call("clipboard:write", { text, png });
      if (cut) this.deleteSelection();
      else toast(items.length === 1 ? "Copied" : `Copied ${items.length} items`, { ms: 1200 });
    }

    viewCenter() {
      const r = this.stage.getBoundingClientRect();
      const p = this.cv.toDoc(r.width / 2, r.height / 2);
      return { x: G.clamp(p.x, 0, this.doc.width), y: G.clamp(p.y, 0, this.doc.height) };
    }

    targetLayer() {
      const layer = this.activeLayer();
      if (layer.locked || layer.visible === false) { toast(layer.locked ? "This layer is locked." : "This layer is hidden. Show it to add to it."); return null; }
      return layer;
    }

    async paste() {
      let clip;
      try { clip = await jdraw.call("clipboard:read"); } catch (err) { toast(err.message, { problem: true }); return; }
      const layer = this.targetLayer();
      if (!layer) return;
      if (clip.items) {
        let data;
        try { data = JSON.parse(clip.items); } catch { return; }
        const items = (data.items || []).map((it) => JSON.parse(JSON.stringify(it)));
        if (!items.length) return;
        // Paste in place in another drawing; offset when the originals are here.
        const here = items.some((it) => G.findItem(this.doc, it.id));
        this._pasteN = here ? (this._pasteN || 0) + 1 : 0;
        const off = 20 * this._pasteN;
        const groups = new Map();
        const ready = items.map((it) => {
          const m = off ? G.moveItem(it, off, off) : it;
          delete m.id;
          if (m.group) { if (!groups.has(m.group)) groups.set(m.group, G.uid("g")); m.group = groups.get(m.group); }
          return m;
        });
        this.selectNew(this.apply([{ op: "add_items", layerId: layer.id, items: ready }]));
        return;
      }
      if (clip.image) { this.importImage(clip.image, this.viewCenter(), "Pasted picture"); return; }
      const text = (clip.text || "").trim();
      if (!text) { toast("The clipboard is empty."); return; }
      if (/^(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(text)) {
        if (/<script|on\w+\s*=/i.test(text)) { toast("That SVG has scripts in it, so it was not pasted.", { problem: true }); return; }
        const svg = /xmlns=/.test(text) ? text : text.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
        this.importImage("data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svg))), this.viewCenter(), "Pasted SVG");
        return;
      }
      const c = this.viewCenter();
      const size = this.cv.textSize();
      this.selectNew(this.apply([{ op: "add_items", layerId: layer.id, items: [{ type: "text", text: text.slice(0, 2000), x: c.x, y: c.y, size, fill: this.cv.brush.color, align: "center" }] }]));
    }

    // Adds a picture centered at pt, scaled to fit the canvas. Big pictures
    // are shrunk so the drawing stays quick to save.
    async importImage(src, pt, name) {
      const layer = this.targetLayer();
      if (!layer) return;
      const img = new Image();
      try { await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error("That picture could not be read.")); img.src = src; }); }
      catch (err) { toast(err.message, { problem: true }); return; }
      let w = img.naturalWidth || 512, h = img.naturalHeight || 512;
      const isSvg = src.startsWith("data:image/svg");
      const MAX = 2048;
      if (!isSvg && Math.max(w, h) > MAX) {
        const k = MAX / Math.max(w, h);
        const c = JRender.makeCanvas(w * k, h * k);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        src = /^data:image\/jpe?g/.test(src) ? c.toDataURL("image/jpeg", 0.9) : c.toDataURL("image/png");
        w = c.width; h = c.height;
      }
      const fit = Math.min(1, (this.doc.width * 0.8) / w, (this.doc.height * 0.8) / h);
      w *= fit; h *= fit;
      const x = G.clamp(pt.x - w / 2, 0, Math.max(0, this.doc.width - w)), y = G.clamp(pt.y - h / 2, 0, Math.max(0, this.doc.height - h));
      this.selectNew(this.apply([{ op: "add_items", layerId: layer.id, items: [{ type: "image", name: name || "Picture", src, x, y, w, h }] }]));
    }

    bindDrop() {
      const over = (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes("Files")) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; this.stage.classList.add("dropping"); } };
      this.stage.addEventListener("dragenter", over);
      this.stage.addEventListener("dragover", over);
      this.stage.addEventListener("dragleave", (e) => { if (e.target === this.stage || !this.stage.contains(e.relatedTarget)) this.stage.classList.remove("dropping"); });
      this.stage.addEventListener("drop", async (e) => {
        this.stage.classList.remove("dropping");
        const files = [...(e.dataTransfer ? e.dataTransfer.files : [])].filter((f) => /^image\//.test(f.type));
        if (!files.length) return;
        e.preventDefault();
        const r = this.stage.getBoundingClientRect();
        const pt = this.cv.toDoc(e.clientX - r.left, e.clientY - r.top);
        let i = 0;
        for (const f of files.slice(0, 12)) {
          const url = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => res(null); fr.readAsDataURL(f); });
          if (url) await this.importImage(url, { x: pt.x + i * 24, y: pt.y + i * 24 }, f.name.replace(/\.[^.]+$/, "").slice(0, 60));
          i++;
        }
      });
    }

    // ---------- canvas size and background
    async canvasDialog() {
      const d = this.doc;
      const bg = d.background || "#ffffff";
      const clear = G.hexToRgb(bg).a === 0;
      const body = el(`<div class="canvas-form">
        <div class="grid2">
          <div><label for="cw">Width</label><input id="cw" class="input" type="number" min="64" max="8192" value="${d.width}"></div>
          <div><label for="ch">Height</label><input id="ch" class="input" type="number" min="64" max="8192" value="${d.height}"></div>
        </div>
        <div class="field"><span class="flabel">When the size changes, keep the drawing</span>
          <div class="seg anchor" role="group" aria-label="Keep the drawing"><button type="button" data-v="top-left" class="on">At the top left</button><button type="button" data-v="center">In the middle</button></div></div>
        <div class="field"><span class="flabel">Paper</span>
          <div class="paper-row"><label class="current-color" style="background:${esc(clear ? "#ffffff" : bg.slice(0, 7))}"><input type="color" aria-label="Paper color" value="${esc(clear ? "#ffffff" : bg.slice(0, 7))}"></label>
          <label class="check"><input type="checkbox" class="clear" ${clear ? "checked" : ""}> See-through (no paper)</label></div></div>
      </div>`);
      let anchor = "top-left";
      body.querySelectorAll(".anchor button").forEach((b) => b.addEventListener("click", () => {
        anchor = b.dataset.v;
        body.querySelectorAll(".anchor button").forEach((x) => x.classList.toggle("on", x === b));
      }));
      const col = body.querySelector('input[type="color"]');
      col.addEventListener("input", () => { col.parentElement.style.background = col.value; body.querySelector(".clear").checked = false; });
      const res = await openDialog({
        title: "Canvas",
        body,
        buttons: [
          { label: "Cancel", value: null },
          { label: "Crop to drawing", value: "trim" },
          { label: "Apply", primary: true, value: (s) => ({ w: Number(s.querySelector("#cw").value), h: Number(s.querySelector("#ch").value), bg: s.querySelector(".clear").checked ? "#00000000" : s.querySelector('input[type="color"]').value }) },
        ],
      });
      if (!res) return;
      if (res === "trim") { this.cropToDrawing(); return; }
      if (!(res.w >= 64 && res.h >= 64)) { toast("Width and height must be at least 64.", { problem: true }); return; }
      await this.apply([{ op: "set_doc", width: Math.min(8192, res.w), height: Math.min(8192, res.h), anchor, background: res.bg }]);
      this.cv.fit();
    }

    async cropToDrawing() {
      const items = [];
      for (const l of this.doc.layers) if (l.visible !== false) for (const it of l.items) if (!(it.type === "stroke" && it.brush === "eraser")) items.push(it);
      if (!items.length) { toast("There is nothing drawn yet."); return; }
      const b = G.unionBox(items.map(G.bounds));
      const x = Math.floor(b.x), y = Math.floor(b.y);
      const w = Math.max(64, Math.ceil(b.x + b.w) - x), h = Math.max(64, Math.ceil(b.y + b.h) - y);
      const all = this.doc.layers.flatMap((l) => l.items.map((it) => it.id));
      await this.apply([{ op: "move_items", ids: all, dx: -x, dy: -y }, { op: "set_doc", width: Math.min(8192, w), height: Math.min(8192, h) }]);
      this.cv.fit();
      toast(`Canvas is now ${Math.min(8192, w)} x ${Math.min(8192, h)}`, { ms: 1800 });
    }

    // ---------- view options
    viewMenu(anchor) {
      const cv = this.cv;
      const deg = cv.viewDegrees();
      showMenu(anchor, [
        { heading: true, label: "Zoom" },
        { label: "Fit to window", hint: "Ctrl+0", onClick: () => cv.fit() },
        { label: "Actual size", hint: "Ctrl+1", onClick: () => cv.setZoom(1) },
        { label: "200%", onClick: () => cv.setZoom(2) },
        { label: "50%", onClick: () => cv.setZoom(0.5) },
        "sep",
        { heading: true, label: deg ? `Turned ${deg}°` : "Turn the view" },
        { label: "Turn left 15°", icon: "rotateL", hint: "Shift+[", onClick: () => cv.rotateView(-15) },
        { label: "Turn right 15°", icon: "rotate", hint: "Shift+]", onClick: () => cv.rotateView(15) },
        ...(deg ? [{ label: "Straighten", hint: "Shift+\\", onClick: () => cv.rotateView(0, true) }] : []),
        "sep",
        { label: "Show grid", icon: "grid", check: cv.grid.show, hint: "Ctrl+'", onClick: () => this.toggleView("grid") },
        { label: "Snap to grid", icon: "magnet", check: cv.grid.snap, hint: "Ctrl+Shift+'", onClick: () => this.toggleView("snap") },
        { label: `Grid size: ${cv.grid.size} px`, onClick: () => this.gridSizeMenu(anchor) },
        { label: "Show rulers", icon: "ruler", check: cv.rulers, hint: "Ctrl+R", onClick: () => this.toggleView("rulers") },
      ]);
    }

    gridSizeMenu(anchor) {
      showMenu(anchor, [
        { heading: true, label: "Grid size" },
        ...[10, 20, 25, 50, 100, 200].map((v) => ({ label: `${v} px`, check: this.cv.grid.size === v, onClick: () => { this.cv.grid.size = v; this.saveViewPrefs(); this.cv.requestDraw(); } })),
      ]);
    }

    toggleView(what) {
      const cv = this.cv;
      if (what === "grid") cv.grid.show = !cv.grid.show;
      if (what === "snap") { cv.grid.snap = !cv.grid.snap; if (cv.grid.snap) cv.grid.show = true; }
      if (what === "rulers") cv.rulers = !cv.rulers;
      const on = what === "grid" ? cv.grid.show : what === "snap" ? cv.grid.snap : cv.rulers;
      toast(`${what === "grid" ? "Grid" : what === "snap" ? "Snap to grid" : "Rulers"} ${on ? "on" : "off"}`, { ms: 1000 });
      this.saveViewPrefs();
      cv.requestDraw();
    }

    markSwatch() {
      const c = (this.cv.brush.color || "").toLowerCase();
      this.dock.querySelectorAll(".swatch[data-c]").forEach((s) => s.classList.toggle("on", s.dataset.c === c));
    }

    setBrush(patch, quiet) {
      if (patch.color) patch.color = G.normColor(patch.color) || this.cv.brush.color;
      Object.assign(this.cv.brush, patch);
      if (patch.color && this.cv.textEntry) { this.cv.styleTextEntry({ color: patch.color }); setTimeout(() => this.cv.focusTextEntry(), 0); }
      clearTimeout(this._brushSave);
      this._brushSave = setTimeout(() => jdraw.call("prefs:set", "brush", this.cv.brush).catch(() => {}), 400);
      this.pushContext();
      if (!quiet) this.renderDock();
      this.cv.requestDraw();
    }

    // ---------- doc changes
    async apply(ops) {
      try {
        return await jdraw.call("doc:apply", this.id, ops);
      } catch (err) {
        this.cv.live = null;
        this.cv.requestDraw();
        toast(err.message, { problem: true });
        return [];
      }
    }

    async undo() { await jdraw.call("doc:undo", this.id); }
    async redo() { await jdraw.call("doc:redo", this.id); }

    deleteSelection() {
      if (!this.selection.length) return;
      const ids = this.selection;
      this.selection = [];
      this.cv.setSelection([]);
      this.apply([{ op: "delete_items", ids }]);
    }

    subscribe() {
      this.offs.push(jdraw.on("doc:changed", (m) => {
        if (m.id !== this.id) return;
        const prev = this.doc;
        const prevPalette = new Set(prev.palette);
        const prevLayers = new Set(prev.layers.map((l) => l.id));
        this.doc = m.doc;
        this.canUndo = m.canUndo;
        this.canRedo = m.canRedo;
        if (!this.doc.layers.some((l) => l.id === this.activeLayerId)) this.activeLayerId = this.doc.layers[this.doc.layers.length - 1].id;
        if (m.origin === "agent") this._freshColors = new Set(this.doc.palette.filter((c) => !prevPalette.has(c)));
        this.cv.docChanged(prev, m.origin);
        this.renderTop();
        this.layers.update(m.origin === "agent", prevLayers);
        if (this.doc.palette.join() !== prev.palette.join() || this.cv.tool === "select") this.renderDock();
        this.assistant.renderChips();
        this.scheduleThumb();
      }));
      this.offs.push(jdraw.on("agent:event", (ev) => { if (ev.docId === this.id) this.assistant.onEvent(ev); }));
      this.offs.push(jdraw.on("brush:set", (m) => {
        if (m.docId !== this.id) return;
        this.setBrush(m.brush);
        if (m.brush.brush) this.setTool(m.brush.brush === "eraser" ? "eraser" : "brush");
      }));
      this.offs.push(jdraw.on("render:request", (m) => { if (m.docId === this.id) this.renderForAgent(m); }));
    }

    async renderForAgent({ reqId, opts }) {
      try {
        const d = this.doc;
        const o = opts || {};
        if (o.kind === "fill") {
          const res = await this.cv.computeFill(o.fill || {});
          jdraw.renderReply({ reqId, item: res.item || null, filled: res.filled || 0, reason: res.reason || null });
          return;
        }
        const maxSize = G.clamp(Number(o.maxSize) || 1024, 256, 1568);
        let layerId = null;
        if (o.layer) {
          const l = d.layers.find((x) => x.id === o.layer || x.name.toLowerCase() === String(o.layer).toLowerCase());
          if (!l) throw new Error(`No layer named "${o.layer}".`);
          layerId = l.id;
        }
        const crop = o.w && o.h ? { x: G.clamp(Number(o.x) || 0, 0, d.width), y: G.clamp(Number(o.y) || 0, 0, d.height), w: Number(o.w), h: Number(o.h) } : { x: 0, y: 0, w: d.width, h: d.height };
        crop.w = Math.max(1, Math.min(crop.w, d.width - crop.x));
        crop.h = Math.max(1, Math.min(crop.h, d.height - crop.y));
        const scale = Math.min(2, maxSize / Math.max(crop.w, crop.h));
        const full = await JRender.renderToCanvas(d, { scale, onlyLayer: layerId });
        const out = JRender.makeCanvas(crop.w * scale, crop.h * scale);
        out.getContext("2d").drawImage(full, crop.x * scale, crop.y * scale, crop.w * scale, crop.h * scale, 0, 0, out.width, out.height);
        const url = out.toDataURL("image/png");
        jdraw.renderReply({ reqId, base64: url.split(",")[1], width: out.width, height: out.height });
      } catch (err) {
        jdraw.renderReply({ reqId, error: err.message || String(err) });
      }
    }

    scheduleThumb() {
      clearTimeout(this._thumbT);
      this._thumbT = setTimeout(() => this.saveThumb(), 1200);
    }

    async saveThumb() {
      if (!this.doc) return;
      try {
        const scale = Math.min(1, 480 / Math.max(this.doc.width, this.doc.height));
        const c = await JRender.renderToCanvas(this.doc, { scale });
        await jdraw.call("drawings:thumb", this.id, c.toDataURL("image/jpeg", 0.85));
      } catch {}
    }

    pushContext() {
      jdraw.call("ctx:update", this.id, { brush: { color: this.cv.brush.color, size: this.cv.brush.size, brush: this.cv.brush.brush, opacity: this.cv.brush.opacity }, selection: this.selection, activeLayer: this.activeLayerId }).catch(() => {});
    }

    contextString() {
      const l = this.activeLayer();
      const parts = [`canvas ${this.doc.width}x${this.doc.height}`, `active layer "${l.name}" (${l.id})`, `brush ${this.cv.brush.color} ${this.cv.brush.size}px ${this.cv.brush.brush}`];
      if (this.selection.length) {
        const boxes = this.selection.slice(0, 40).map((id) => { const f = G.findItem(this.doc, id); if (!f) return id; const b = G.bounds(f.item); return `${id} (${f.item.type} at ${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.w)}x${Math.round(b.h)})`; });
        parts.push(`the person selected: ${boxes.join(", ")}`);
      } else parts.push("nothing selected");
      return parts.join("; ");
    }

    setBusy(on, name) {
      const old = this.stage.querySelector(".busy-pill");
      if (old) old.remove();
      if (!on) return;
      const pill = el(`<div class="busy-pill" role="status">${icon("sparkles", "spark")}<span>${esc(name || "Assistant")} is working on your drawing</span><button type="button" class="btn sm">${icon("stop")}Stop</button></div>`);
      pill.querySelector("button").addEventListener("click", () => this.assistant.cancel());
      this.stage.appendChild(pill);
    }

    afterAgentTurn(ev) {
      if (ev.type === "error") toast("The assistant ran into a problem. See the chat.", { problem: true });
    }

    // ---------- export
    exportMenu(anchor) {
      showMenu(anchor, [
        { heading: true, label: "Export" },
        { label: "PNG", desc: `${this.doc.width} x ${this.doc.height}`, icon: "image", onClick: () => this.export({ scale: 1 }) },
        { label: "PNG at 2x", desc: `${this.doc.width * 2} x ${this.doc.height * 2}`, icon: "image", onClick: () => this.export({ scale: 2 }) },
        { label: "PNG, no paper", desc: "Transparent background", icon: "image", onClick: () => this.export({ scale: 1, transparent: true }) },
        { label: "JPG", desc: "Smaller file", icon: "image", onClick: () => this.export({ scale: 1, jpg: true }) },
        { label: "SVG", desc: "Vector file for other apps", icon: "image", onClick: () => this.exportSvg() },
        "sep",
        { label: "Add to video library", desc: "Use this drawing in a video", icon: "film", onClick: () => this.addToVideo() },
        ...(this.selection.length ? ["sep", { heading: true, label: `Selection (${this.selection.length})` },
          { label: "Selection as PNG", desc: "Just what is selected, see-through", icon: "image", onClick: () => this.exportSelection("png") },
          { label: "Selection as SVG", icon: "image", onClick: () => this.exportSelection("svg") }] : []),
      ], { align: "right" });
    }

    async saveFile(name, url, ext) {
      const file = await jdraw.call("export:save", name, url, ext);
      if (file) toast("Exported", { action: { label: "Show in folder", onClick: () => jdraw.call("export:reveal", file) } });
      return file;
    }

    svgUrl(svg) {
      return "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svg)));
    }

    async exportSvg() {
      try { return await this.saveFile(this.meta.name, this.svgUrl(JSvg.toSvg(this.doc)), "svg"); }
      catch (err) { toast(err.message, { problem: true }); return null; }
    }

    async exportSelection(kind) {
      const items = this.orderedSelection();
      if (!items.length) return null;
      const b = G.unionBox(items.map(G.bounds));
      const crop = { x: Math.floor(b.x), y: Math.floor(b.y), w: Math.ceil(b.w) + 1, h: Math.ceil(b.h) + 1 };
      try {
        if (kind === "svg") return await this.saveFile(this.meta.name + " selection", this.svgUrl(JSvg.toSvg(this.doc, { ids: this.selection, crop, transparent: true })), "svg");
        const scale = Math.min(2, 16384 / Math.max(crop.w, crop.h));
        const c = await JRender.renderToCanvas(this.doc, { ids: this.selection, transparent: true, crop, scale });
        return await this.saveFile(this.meta.name + " selection", c.toDataURL("image/png"), "png");
      } catch (err) { toast(err.message, { problem: true }); return null; }
    }

    async addToVideo() {
      try {
        const c = await JRender.renderToCanvas(this.doc, { scale: 1, transparent: false });
        const r = await jdraw.call("studio:to-video-library", this.meta.name, c.toDataURL("image/png"));
        if (r.added) toast("Added to the video library", { action: { label: "Open Video", onClick: () => jdraw.call("studio:switch", "video") } });
        else toast("Not added: " + r.reason, { problem: true });
      } catch (err) { toast(err.message, { problem: true }); }
    }

    async export(o) {
      try {
        const scale = Math.min(o.scale, 16384 / Math.max(this.doc.width, this.doc.height));
        const c = await JRender.renderToCanvas(this.doc, { scale, transparent: o.transparent });
        const url = o.jpg ? c.toDataURL("image/jpeg", 0.92) : c.toDataURL("image/png");
        const file = await jdraw.call("export:save", this.meta.name, url, o.jpg ? "jpg" : "png");
        if (file) toast("Exported", { action: { label: "Show in folder", onClick: () => jdraw.call("export:reveal", file) } });
        return file;
      } catch (err) { toast(err.message, { problem: true }); return null; }
    }

    // ---------- keys
    bindKeys() {
      this._keys = (e) => {
        if (isTyping(e) || document.querySelector(".scrim")) return;
        const k = e.key.toLowerCase();
        const mod = e.ctrlKey || e.metaKey;
        if (mod && k === "z" && !e.shiftKey) { e.preventDefault(); this.undo(); return; }
        if ((mod && k === "y") || (mod && k === "z" && e.shiftKey)) { e.preventDefault(); this.redo(); return; }
        if (mod && k === "0") { e.preventDefault(); this.cv.fit(); return; }
        if (mod && k === "1") { e.preventDefault(); this.cv.setZoom(1); return; }
        if (mod && (k === "=" || k === "+")) { e.preventDefault(); this.cv.zoomAt(1.25); return; }
        if (mod && k === "-") { e.preventDefault(); this.cv.zoomAt(0.8); return; }
        if (mod && k === "a") { e.preventDefault(); this.setTool("select"); this.cv.selectAll(); this.renderDock(); return; }
        if (mod && k === "e") { e.preventDefault(); this.export({ scale: 1 }); return; }
        if (mod && k === "c" && this.selection.length) { e.preventDefault(); this.copySelection(false); return; }
        if (mod && k === "x" && this.selection.length) { e.preventDefault(); this.copySelection(true); return; }
        if (mod && k === "v") { e.preventDefault(); this.paste(); return; }
        if (mod && k === "d") { e.preventDefault(); this.duplicateSelection(); return; }
        if (mod && k === "g") { e.preventDefault(); if (e.shiftKey) this.ungroupSelection(); else this.groupSelection(); return; }
        if (mod && k === "r") { e.preventDefault(); this.toggleView("rulers"); return; }
        if (mod && e.code === "Quote") { e.preventDefault(); this.toggleView(e.shiftKey ? "snap" : "grid"); return; }
        if (mod && (e.code === "BracketRight" || e.code === "BracketLeft") && this.selection.length) {
          e.preventDefault();
          const up = e.code === "BracketRight";
          this.order(e.shiftKey ? (up ? "front" : "back") : up ? "forward" : "backward");
          return;
        }
        if (mod) return;
        // Shift+[ and Shift+] turn the view; Shift+\ straightens it.
        if (e.shiftKey && (e.code === "BracketLeft" || e.code === "BracketRight")) { e.preventDefault(); this.cv.rotateView(e.code === "BracketLeft" ? -15 : 15); return; }
        if (e.shiftKey && e.code === "Backslash") { e.preventDefault(); this.cv.rotateView(0, true); return; }
        if (e.shiftKey && (k === "h" || k === "v") && this.selection.length) { e.preventDefault(); this.apply([{ op: "transform_items", ids: this.selection, flip: k === "h" ? "x" : "y" }]); return; }
        if ((k === "delete" || k === "backspace") && this.selection.length) { e.preventDefault(); this.deleteSelection(); return; }
        if (k === "escape") { if (this.selection.length) { this.selection = []; this.cv.setSelection([]); this.pushContext(); this.renderDock(); } return; }
        if (k.startsWith("arrow") && this.selection.length) {
          e.preventDefault();
          const step = e.shiftKey ? 10 : 1;
          this.cv.nudge(k === "arrowleft" ? -step : k === "arrowright" ? step : 0, k === "arrowup" ? -step : k === "arrowdown" ? step : 0);
          return;
        }
        if (k === "[" || k === "]") {
          const s = this.cv.brush.size;
          const next = k === "]" ? Math.min(200, Math.round(s * 1.2 + 1)) : Math.max(1, Math.round(s / 1.2 - 0.5));
          this.setBrush({ size: next }, true);
          const sl = this.dock.querySelector('[data-label="Size"]');
          if (sl) { sl.querySelector("b").textContent = next + " px"; sl.querySelector("input").value = Math.round(Math.sqrt((next - 1) / 199) * 1000); }
          return;
        }
        const tool = TOOLS.find((t) => t !== "sep" && t.key.toLowerCase() === k);
        if (tool) { e.preventDefault(); this.setTool(tool.id); }
      };
      window.addEventListener("keydown", this._keys);
    }
  }

  window.Editor = Editor;
})();
