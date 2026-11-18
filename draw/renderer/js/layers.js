// Floating layers card on the canvas. Rows are kept between renders so
// double-click rename and drag to reorder work; only what changed is
// updated.
(function () {
  const { el, esc, showMenu, toast, openDialog } = UI;

  const BLENDS = [
    ["source-over", "Normal"], ["multiply", "Multiply"], ["screen", "Screen"], ["overlay", "Overlay"],
    ["soft-light", "Soft light"], ["darken", "Darken"], ["lighten", "Lighten"], ["color", "Color"],
  ];

  class LayersPanel {
    constructor(stage, editor) {
      this.editor = editor;
      this.collapsed = false;
      this.thumbs = {};
      this.fresh = new Set();
      this.rows = new Map(); // layerId -> row element
      this.node = el(`<section class="layers-card" aria-label="Layers">
        <header class="lc-head">
          <button type="button" class="lc-title" aria-expanded="true">${icon("layers")}<span>Layers</span><b class="lc-count"></b>${icon("chevron", "lc-chev")}</button>
          <span style="flex:1"></span>
          <button type="button" class="icon-btn add" title="New layer" aria-label="New layer">${icon("plus")}</button>
        </header>
        <div class="lc-body">
          <div class="lc-list" role="listbox" aria-label="Layers"></div>
          <div class="lc-props">
            <div class="lc-line"><span>Opacity</span><input type="range" min="0" max="100" class="op" aria-label="Layer opacity"><b class="opv"></b></div>
            <div class="lc-line"><span>Blend</span><button type="button" class="picker blend"><span></span>${icon("chevron")}</button></div>
            <div class="lc-actions">
              <button type="button" class="icon-btn dup" title="Duplicate layer" aria-label="Duplicate layer">${icon("copy")}</button>
              <button type="button" class="icon-btn merge" title="Merge down" aria-label="Merge down">${icon("merge")}</button>
              <button type="button" class="icon-btn lock" title="Lock layer" aria-label="Lock layer">${icon("lock")}</button>
              <span style="flex:1"></span>
              <button type="button" class="icon-btn del" title="Delete layer" aria-label="Delete layer">${icon("trash")}</button>
            </div>
            <div class="lc-line paper"><span>Paper</span><label class="bg-swatch" title="Paper color"><input type="color" aria-label="Paper color"></label><em class="dims"></em></div>
          </div>
        </div>
      </section>`);
      stage.appendChild(this.node);
      this.list = this.node.querySelector(".lc-list");
      this.bind();
    }

    get doc() { return this.editor.doc; }

    bind() {
      const n = this.node;
      n.querySelector(".lc-title").addEventListener("click", () => this.setCollapsed(!this.collapsed));
      n.querySelector(".add").addEventListener("click", () => this.addLayer());
      n.querySelector(".dup").addEventListener("click", () => this.duplicate(this.editor.activeLayer()));
      n.querySelector(".merge").addEventListener("click", () => this.mergeDown(this.editor.activeLayer()));
      n.querySelector(".lock").addEventListener("click", () => { const l = this.editor.activeLayer(); this.editor.apply([{ op: "update_layer", layerId: l.id, locked: !l.locked }]); });
      n.querySelector(".del").addEventListener("click", () => this.remove(this.editor.activeLayer()));
      const op = n.querySelector(".op");
      op.addEventListener("input", () => {
        const l = this.editor.activeLayer();
        n.querySelector(".opv").textContent = op.value + "%";
        l.opacity = op.value / 100; // preview; saved on change
        this.editor.cv.requestDraw();
      });
      op.addEventListener("change", () => this.editor.apply([{ op: "update_layer", layerId: this.editor.activeLayer().id, opacity: op.value / 100 }]));
      op.addEventListener("keydown", (e) => e.stopPropagation());
      n.querySelector(".blend").addEventListener("click", (e) => {
        const l = this.editor.activeLayer();
        showMenu(e.currentTarget, BLENDS.map(([v, label]) => ({ label, check: (l.blend || "source-over") === v, onClick: () => this.editor.apply([{ op: "update_layer", layerId: l.id, blend: v }]) })));
      });
      const bg = n.querySelector(".paper input");
      bg.addEventListener("input", () => { n.querySelector(".bg-swatch").style.background = bg.value; });
      bg.addEventListener("change", () => this.editor.apply([{ op: "set_doc", background: bg.value }]));
    }

    setCollapsed(c) {
      this.collapsed = c;
      this.node.classList.toggle("collapsed", c);
      this.node.querySelector(".lc-title").setAttribute("aria-expanded", String(!c));
      jdraw.call("prefs:set", "layersCollapsed", c).catch(() => {});
      if (!c) this.scheduleThumbs();
    }

    setVisible(v) {
      this.node.style.display = v ? "" : "none";
    }

    // Called after any doc change or active layer change.
    update(changedByAgent, prevLayerIds) {
      const doc = this.doc;
      if (changedByAgent && prevLayerIds) for (const l of doc.layers) if (!prevLayerIds.has(l.id)) this.fresh.add(l.id);
      const ordered = [...doc.layers].reverse();
      const seen = new Set();
      ordered.forEach((l, i) => {
        seen.add(l.id);
        let row = this.rows.get(l.id);
        if (!row) { row = this.makeRow(l.id); this.rows.set(l.id, row); }
        this.fillRow(row, l);
        if (this.list.children[i] !== row) this.list.insertBefore(row, this.list.children[i] || null);
      });
      for (const [id, row] of this.rows) if (!seen.has(id)) { row.remove(); this.rows.delete(id); }
      this.node.querySelector(".lc-count").textContent = String(doc.layers.length);
      const l = this.editor.activeLayer();
      const idx = doc.layers.indexOf(l);
      const n = this.node;
      const op = n.querySelector(".op");
      if (document.activeElement !== op) op.value = Math.round((l.opacity ?? 1) * 100);
      n.querySelector(".opv").textContent = Math.round((l.opacity ?? 1) * 100) + "%";
      n.querySelector(".blend span").textContent = (BLENDS.find((b) => b[0] === (l.blend || "source-over")) || BLENDS[0])[1];
      n.querySelector(".merge").disabled = idx <= 0;
      const lock = n.querySelector(".lock");
      lock.classList.toggle("on", !!l.locked);
      lock.title = l.locked ? "Unlock layer" : "Lock layer";
      lock.innerHTML = icon(l.locked ? "lock" : "unlock");
      n.querySelector(".paper input").value = doc.background.slice(0, 7);
      n.querySelector(".bg-swatch").style.background = doc.background;
      n.querySelector(".dims").textContent = `${doc.width} x ${doc.height}`;
      this.scheduleThumbs();
    }

    makeRow(id) {
      const row = el(`<div class="lrow" role="option" tabindex="-1" data-id="${esc(id)}">
        <span class="grip" aria-hidden="true">${icon("grip")}</span>
        <button type="button" class="icon-btn eye"></button>
        <div class="lthumb"></div>
        <div class="lname"><span class="ltext"></span><small class="lmeta"></small></div>
        <span class="lflags"></span>
      </div>`);
      row.addEventListener("pointerdown", (e) => this.onRowDown(e, row));
      row.addEventListener("dblclick", (e) => { if (!e.target.closest(".eye")) this.rename(row.dataset.id); });
      row.addEventListener("contextmenu", (e) => { e.preventDefault(); this.rowMenu(row, e); });
      row.querySelector(".eye").addEventListener("click", (e) => {
        e.stopPropagation();
        const l = this.doc.layers.find((x) => x.id === row.dataset.id);
        if (l) this.editor.apply([{ op: "update_layer", layerId: l.id, visible: l.visible === false }]);
      });
      return row;
    }

    fillRow(row, l) {
      const active = l.id === this.editor.activeLayerId;
      row.classList.toggle("on", active);
      row.setAttribute("aria-selected", String(active));
      row.classList.toggle("hidden-layer", l.visible === false);
      row.classList.toggle("fresh", this.fresh.has(l.id));
      const eye = row.querySelector(".eye");
      const hidden = l.visible === false;
      const want = hidden ? "eyeOff" : "eye";
      if (eye.dataset.icon !== want) { eye.innerHTML = icon(want); eye.dataset.icon = want; }
      eye.title = hidden ? "Show layer" : "Hide layer";
      eye.setAttribute("aria-label", `${hidden ? "Show" : "Hide"} ${l.name}`);
      if (!row.querySelector(".lname input")) row.querySelector(".ltext").textContent = l.name;
      const bits = [`${l.items.length} item${l.items.length === 1 ? "" : "s"}`];
      if ((l.opacity ?? 1) < 1) bits.push(Math.round(l.opacity * 100) + "%");
      if (l.blend && l.blend !== "source-over") bits.push((BLENDS.find((b) => b[0] === l.blend) || [0, l.blend])[1]);
      row.querySelector(".lmeta").textContent = bits.join(" · ");
      row.querySelector(".lflags").innerHTML = l.locked ? icon("lock") : "";
      const t = this.thumbs[l.id];
      const box = row.querySelector(".lthumb");
      if (t && box.dataset.src !== t) { box.innerHTML = `<img alt="" src="${t}">`; box.dataset.src = t; }
    }

    // Click selects; dragging the row reorders.
    onRowDown(e, row) {
      if (e.button !== 0 || e.target.closest(".eye") || e.target.closest("input")) return;
      const id = row.dataset.id;
      if (this.editor.activeLayerId !== id) this.editor.setActiveLayer(id);
      this.fresh.delete(id);
      const startY = e.clientY;
      let dragging = false;
      let ghostIndex = -1;
      const rows = () => [...this.list.querySelectorAll(".lrow")];
      const move = (ev) => {
        if (!dragging && Math.abs(ev.clientY - startY) > 5) { dragging = true; row.classList.add("dragging"); this.list.classList.add("sorting"); }
        if (!dragging) return;
        const list = rows().filter((r) => r !== row);
        ghostIndex = list.length;
        for (let i = 0; i < list.length; i++) {
          const r = list[i].getBoundingClientRect();
          if (ev.clientY < r.top + r.height / 2) { ghostIndex = i; break; }
        }
        list.forEach((r, i) => r.classList.toggle("drop-before", i === ghostIndex));
        this.list.classList.toggle("drop-end", ghostIndex === list.length);
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        row.classList.remove("dragging");
        this.list.classList.remove("sorting", "drop-end");
        rows().forEach((r) => r.classList.remove("drop-before"));
        if (!dragging || ghostIndex < 0) return;
        // ghostIndex counts top to bottom among the other rows.
        const n = this.doc.layers.length;
        const index = n - 1 - ghostIndex;
        const from = this.doc.layers.findIndex((l) => l.id === id);
        if (index !== from) this.editor.apply([{ op: "move_layer", layerId: id, index: Math.max(0, Math.min(n - 1, index)) }]);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    }

    rowMenu(row, e) {
      const l = this.doc.layers.find((x) => x.id === row.dataset.id);
      if (!l) return;
      this.editor.setActiveLayer(l.id);
      const idx = this.doc.layers.indexOf(l);
      showMenu(row, [
        { label: "Rename", icon: "text", hint: "Double-click", onClick: () => this.rename(l.id) },
        { label: "Duplicate", icon: "copy", onClick: () => this.duplicate(l) },
        ...(idx > 0 ? [{ label: "Merge down", icon: "merge", onClick: () => this.mergeDown(l) }] : []),
        { label: l.locked ? "Unlock" : "Lock", icon: l.locked ? "unlock" : "lock", onClick: () => this.editor.apply([{ op: "update_layer", layerId: l.id, locked: !l.locked }]) },
        { label: l.visible === false ? "Show" : "Hide", icon: l.visible === false ? "eye" : "eyeOff", onClick: () => this.editor.apply([{ op: "update_layer", layerId: l.id, visible: l.visible === false }]) },
        { label: "Select everything on it", icon: "select", onClick: () => { this.editor.setTool("select"); this.editor.cv.selectAll(); this.editor.renderDock(); } },
        "sep",
        { label: "Delete layer", icon: "trash", danger: true, onClick: () => this.remove(l) },
      ]);
    }

    rename(id) {
      const row = this.rows.get(id);
      const l = this.doc.layers.find((x) => x.id === id);
      if (!row || !l || row.querySelector(".lname input")) return;
      const box = row.querySelector(".lname");
      const text = box.querySelector(".ltext");
      text.style.display = "none";
      const inp = el(`<input class="input" value="${esc(l.name)}" aria-label="Layer name">`);
      box.prepend(inp);
      inp.focus();
      inp.select();
      let done = false;
      const finish = (save) => {
        if (done) return;
        done = true;
        const v = inp.value.trim();
        inp.remove();
        text.style.display = "";
        if (save && v && v !== l.name) this.editor.apply([{ op: "update_layer", layerId: id, name: v }]);
      };
      inp.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); });
      inp.addEventListener("pointerdown", (e) => e.stopPropagation());
      inp.addEventListener("blur", () => finish(true));
    }

    async addLayer() {
      this.setCollapsed(false);
      const idx = this.doc.layers.indexOf(this.editor.activeLayer());
      const [res] = await this.editor.apply([{ op: "add_layer", name: `Layer ${this.doc.layers.length + 1}`, index: idx + 1 }]);
      if (res) { this.editor.setActiveLayer(res.layerId); this.rename(res.layerId); }
    }

    async duplicate(l) {
      const [res] = await this.editor.apply([{ op: "duplicate_layer", layerId: l.id }]);
      if (res) this.editor.setActiveLayer(res.layerId);
    }

    async mergeDown(l) {
      const idx = this.doc.layers.indexOf(l);
      if (idx <= 0) return;
      const below = this.doc.layers[idx - 1];
      // Erasers and blend modes only make sense on their own layer, so such a
      // layer is merged as a picture of the two layers.
      const needsFlatten = l.items.some((i) => i.type === "stroke" && i.brush === "eraser") || (l.blend && l.blend !== "source-over") || below.items.some((i) => i.type === "stroke" && i.brush === "eraser");
      if (needsFlatten) {
        const pair = Object.assign({}, this.doc, { layers: [Object.assign({}, below, { opacity: 1, blend: "source-over", visible: true }), Object.assign({}, l, { visible: true })] });
        const c = await JRender.renderToCanvas(pair, { scale: 1, transparent: true });
        await this.editor.apply([{ op: "flatten_into", layerId: l.id, image: { x: 0, y: 0, w: this.doc.width, h: this.doc.height, src: c.toDataURL("image/png") } }]);
        toast(`Merged into "${below.name}" as one picture`);
      } else {
        await this.editor.apply([{ op: "merge_down", layerId: l.id }]);
        toast(`Merged into "${below.name}"`);
      }
      this.editor.setActiveLayer(below.id);
    }

    async remove(l) {
      if (this.doc.layers.length === 1 && !l.items.length) { toast("A drawing needs at least one layer."); return; }
      if (l.items.length) {
        const ok = await openDialog({ title: `Delete "${l.name}"?`, body: `<p>It has ${l.items.length} item${l.items.length === 1 ? "" : "s"}. You can undo this.</p>`, buttons: [{ label: "Cancel", value: null }, { label: "Delete", primary: true, danger: true, value: true }] });
        if (!ok) return;
      }
      await this.editor.apply([{ op: "delete_layer", layerId: l.id }]);
    }

    // A pen line on a big page is under a pixel wide at thumbnail size and
    // vanished. Render larger, shrink in steps, then thicken and strengthen
    // faint pixels so the art on the layer can be seen.
    async thumbFor(doc, l, scale) {
      const one = Object.assign({}, doc, { layers: [Object.assign({}, l, { visible: true, opacity: 1, blend: "source-over" })] });
      const big = await JRender.renderToCanvas(one, { scale: Math.min(1, scale * 4), transparent: true });
      const w = Math.max(1, Math.round(doc.width * scale)), h = Math.max(1, Math.round(doc.height * scale));
      let src = big;
      while (src.width / 2 > w) {
        const half = JRender.makeCanvas(Math.ceil(src.width / 2), Math.ceil(src.height / 2));
        const hc = half.getContext("2d");
        hc.imageSmoothingQuality = "high";
        hc.drawImage(src, 0, 0, half.width, half.height);
        src = half;
      }
      const out = JRender.makeCanvas(w, h);
      const ctx = out.getContext("2d");
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(src, 0, 0, w, h);
      for (const [dx, dy] of [[0.5, 0], [0, 0.5]]) ctx.drawImage(out, dx, dy);
      const img = ctx.getImageData(0, 0, w, h);
      const d = img.data;
      for (let i = 3; i < d.length; i += 4) if (d[i]) d[i] = Math.min(255, d[i] * 3);
      ctx.putImageData(img, 0, 0);
      return out.toDataURL("image/png");
    }

    scheduleThumbs() {
      clearTimeout(this._t);
      if (this.collapsed) return;
      this._t = setTimeout(async () => {
        const doc = this.doc;
        const scale = 96 / Math.max(doc.width, doc.height);
        if (!this._keys) this._keys = new Map();
        for (const l of doc.layers) {
          // Short fingerprint of the layer's items, so edits that keep the same
          // length still refresh without holding a copy of big image data.
          const s = JSON.stringify(l.items);
          let h = 2166136261;
          for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
          const key = `${doc.width}:${doc.height}:${s.length}:${h >>> 0}`;
          if (this._keys.get(l.id) === key && this.thumbs[l.id]) continue;
          this.thumbs[l.id] = await this.thumbFor(doc, l, scale);
          this._keys.set(l.id, key);
        }
        for (const l of this.doc.layers) { const row = this.rows.get(l.id); if (row) this.fillRow(row, l); }
      }, 300);
    }
  }

  window.LayersPanel = LayersPanel;
})();
