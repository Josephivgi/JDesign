// Hidden smoke run: drives the real UI with pointer events, calls every MCP
// tool, and (when JDRAW_SMOKE_AGENT is set) runs a real agent turn.
(function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(fn, ms, label) {
    const until = Date.now() + (ms || 10000);
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > until) throw new Error("Timed out waiting for " + (label || "condition"));
      await sleep(50);
    }
  }

  function itemCount(doc) {
    return doc.layers.reduce((n, l) => n + l.items.length, 0);
  }

  // Hidden windows get no animation frames, so draw the canvas by hand and
  // turn off CSS transitions before each capture.
  async function capture(app, name) {
    if (app.editor && app.editor.cv) app.editor.cv.draw();
    await sleep(60);
    return jdraw.call("smoke:capture", name).catch(() => null);
  }

  // Pixel box of one item drawn alone, to compare with JGeom.bounds.
  function pixelBox(doc, it) {
    const b = JGeom.bounds(it);
    const pad = 40;
    const c = JRender.makeCanvas(b.w + pad * 2, b.h + pad * 2);
    const ctx = c.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, pad - b.x, pad - b.y);
    const solid = Object.assign({}, it, { opacity: 1 });
    delete solid.shadow;
    JRender.drawItem(ctx, solid, JRender.makeCanvas(c.width, c.height));
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) if (d[(y * c.width + x) * 4 + 3] > 20) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (!Number.isFinite(x0)) return null;
    return { x: x0 - pad + b.x, y: y0 - pad + b.y, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  async function run(app, cfg) {
    const st = document.createElement("style");
    st.textContent = "*, *::before, *::after { transition: none !important; animation: none !important; }";
    document.head.appendChild(st);
    const checks = [];
    const report = { ok: false, checks, startedAt: new Date().toISOString() };
    const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); console.log(`[smoke] ${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + (typeof detail === "string" ? detail : JSON.stringify(detail)) : ""}`); };
    const step = async (name, fn) => {
      try { const d = await fn(); if (d !== false) check(name, true, d); else check(name, false); } catch (err) { check(name, false, err.message); }
    };
    try {
      // Draw-only runs (JDRAW_SMOKE_DRAW_ONLY=1) skip the UI checks and go
      // straight to one agent turn on a blank drawing.
      if (!cfg.drawOnly) {
      await waitFor(() => document.querySelector(".size-card"), 10000, "home");
      check("home shows sizes", document.querySelectorAll(".size-card").length >= 5);
      await capture(app, "01-home");

      await step("settings lists every skill", async () => {
        document.querySelector(".settings-btn").click();
        await waitFor(() => document.querySelector(".skill"), 5000, "skills list");
        const rows = [...document.querySelectorAll(".skill")];
        const ids = rows.map((r) => r.dataset.skill);
        const empty = rows.filter((r) => r.querySelector(".skill-d").textContent.trim().length < 10).length;
        const craft = ["anti-slop", "slop-catalog", "writing-slop", "deslop"].every((id) => ids.includes(id));
        if (rows.length < 19 || empty || !craft) throw new Error(`rows ${rows.length}, empty descriptions ${empty}, craft ${craft}`);
        await capture(app, "01b-settings-skills");
        document.querySelector(".scrim .row .btn").click();
        return `${rows.length} skills`;
      });

      document.querySelector(".size-card").click();
      const ed = await waitFor(() => app.editor && app.editor.doc && app.editor.cv && document.querySelector(".rail .icon-btn") && app.editor, 10000, "editor");
      await sleep(300);
      check("editor opened", !!ed.doc, `${ed.doc.width}x${ed.doc.height}`);
      const cv = ed.cv;
      const canvas = cv.canvas;

      const fire = (type, x, y, extra) => {
        const p = cv.toScreen(x, y);
        const r = canvas.getBoundingClientRect();
        canvas.dispatchEvent(new PointerEvent(type, Object.assign({ bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: r.left + p.x, clientY: r.top + p.y, pressure: 0.5 }, extra || {})));
      };
      const drag = async (pts, holdMs) => {
        const before = itemCount(ed.doc);
        fire("pointerdown", pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) { fire("pointermove", pts[i][0], pts[i][1]); if (i % 4 === 0) await sleep(8); }
        if (holdMs) await sleep(holdMs);
        fire("pointerup", pts[pts.length - 1][0], pts[pts.length - 1][1]);
        await waitFor(() => itemCount(ed.doc) !== before || false, 3000, "doc update").catch(() => {});
        await sleep(30);
      };
      const click = async (x, y) => { fire("pointerdown", x, y); fire("pointerup", x, y); await sleep(120); };
      const circle = (cx, cy, r, n) => Array.from({ length: n + 1 }, (_, i) => [cx + Math.cos((i / n) * Math.PI * 2) * r, cy + Math.sin((i / n) * Math.PI * 2) * r]);
      const W = ed.doc.width, H = ed.doc.height;

      await step("brush draws a face", async () => {
        ed.setTool("brush");
        ed.setBrush({ color: "#1f1f24", size: 10, brush: "pen" });
        await drag(circle(W / 2, H / 2, 380, 80));
        await drag(circle(W / 2 - 140, H / 2 - 100, 40, 30));
        await drag(circle(W / 2 + 140, H / 2 - 100, 40, 30));
        await drag(Array.from({ length: 30 }, (_, i) => [W / 2 - 180 + i * 12, H / 2 + 120 + Math.sin((i / 29) * Math.PI) * 90]));
        const strokes = ed.doc.layers[0].items.filter((i) => i.type === "stroke");
        if (strokes.length !== 4) throw new Error(`expected 4 strokes, got ${strokes.length}`);
        const p = strokes[0].points.map((x) => x[2]);
        return `${strokes.length} strokes, pressure ${Math.min(...p).toFixed(2)}..${Math.max(...p).toFixed(2)}`;
      });

      await step("hold still straightens a wobbly line", async () => {
        const pts = Array.from({ length: 40 }, (_, i) => [200 + i * 20, 200 + Math.sin(i) * 6]);
        await drag(pts, 900);
        const s = ed.doc.layers[0].items[ed.doc.layers[0].items.length - 1];
        const a = s.points[0], b = s.points[s.points.length - 1];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const off = Math.max(...s.points.map((p) => Math.abs((b[0] - a[0]) * (a[1] - p[1]) - (a[0] - p[0]) * (b[1] - a[1])) / len));
        if (off > 0.5) throw new Error("line not straight, off by " + off.toFixed(1));
        return `max distance from a straight line ${off.toFixed(2)} px`;
      });

      await step("filled rectangle shape", async () => {
        ed.setTool("shape");
        cv.shapeKind = "rect";
        cv.shapeFill = true;
        ed.setBrush({ color: "#46a758" });
        await drag([[100, H - 300], [200, H - 250], [300, H - 150]]);
        const r = ed.doc.layers[0].items.find((i) => i.type === "rect");
        if (!r) throw new Error("no rect");
        return `rect ${Math.round(r.w)}x${Math.round(r.h)} fill ${r.fill}`;
      });

      await step("fill bucket fills inside the face", async () => {
        ed.setTool("fill");
        ed.setBrush({ color: "#ffc53d" });
        const before = itemCount(ed.doc);
        await click(W / 2, H / 2 + 20);
        await waitFor(() => itemCount(ed.doc) > before, 8000, "fill item");
        const f = ed.doc.layers[0].items.find((i) => i.type === "image" && i.name === "Fill");
        if (!f) throw new Error("no fill item");
        if (f.w > W * 0.9) throw new Error("fill leaked out of the circle: " + Math.round(f.w));
        return `fill ${Math.round(f.w)}x${Math.round(f.h)} under the lines: ${ed.doc.layers[0].items[0] === f}`;
      });

      await step("eyedropper picks the fill color", async () => {
        ed.setBrush({ color: "#000000" });
        ed.setTool("eyedropper");
        await click(W / 2 + 60, H / 2 + 20);
        await waitFor(() => cv.brush.color === "#ffc53d", 4000, "picked color");
        return cv.brush.color + ", back to " + cv.tool;
      });

      await step("undo and redo", async () => {
        const n = itemCount(ed.doc);
        await ed.undo();
        await waitFor(() => itemCount(ed.doc) === n - 1, 3000, "undo");
        await ed.redo();
        await waitFor(() => itemCount(ed.doc) === n, 3000, "redo");
        return `${n - 1} <-> ${n}`;
      });

      await step("select and drag moves the rectangle", async () => {
        ed.setTool("select");
        const r0 = ed.doc.layers[0].items.find((i) => i.type === "rect");
        const cx = r0.x + r0.w / 2, cy = r0.y + r0.h / 2;
        fire("pointerdown", cx, cy);
        for (let i = 1; i <= 10; i++) fire("pointermove", cx + i * 10, cy - i * 5);
        fire("pointerup", cx + 100, cy - 50);
        await waitFor(() => { const r = ed.doc.layers[0].items.find((i) => i.id === r0.id); return r && Math.abs(r.x - r0.x - 100) < 1; }, 3000, "move");
        return `selected ${ed.selection.length}, moved by 100,-50`;
      });

      await step("text tool adds text", async () => {
        ed.setTool("text");
        await click(120, 140);
        const ta = await waitFor(() => document.querySelector(".text-entry"), 2000, "text box");
        ta.value = "Hello JDraw";
        ta.dispatchEvent(new Event("input"));
        ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        await waitFor(() => ed.doc.layers.some((l) => l.items.some((i) => i.type === "text" && i.text === "Hello JDraw")), 3000, "text item");
        return "ok";
      });

      const card = document.querySelector(".layers-card");
      const rowFor = (id) => card.querySelector(`.lrow[data-id="${id}"]`);
      await step("layers: add, and the new layer is named inline", async () => {
        const n = ed.doc.layers.length;
        card.querySelector(".lc-head .add").click();
        await waitFor(() => ed.doc.layers.length === n + 1, 3000, "layer");
        const inp = await waitFor(() => card.querySelector(".lname input"), 2000, "name box");
        inp.value = "Shading";
        inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        await waitFor(() => ed.activeLayer().name === "Shading", 3000, "renamed");
        return `${n} -> ${n + 1} layers, active "${ed.activeLayer().name}", ${card.querySelectorAll(".lrow").length} rows`;
      });
      await step("layers: double-click renames", async () => {
        const l = ed.doc.layers[0];
        const row = rowFor(l.id);
        row.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientY: 10 }));
        window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
        await sleep(50);
        rowFor(l.id).dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        const inp = await waitFor(() => rowFor(l.id).querySelector("input"), 2000, "rename box");
        inp.value = "Sketch";
        inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        await waitFor(() => ed.doc.layers[0].name === "Sketch", 3000, "renamed");
        return `active is now "${ed.activeLayer().name}"`;
      });
      await step("layers: hide blocks drawing, show again", async () => {
        const l = ed.activeLayer();
        rowFor(l.id).querySelector(".eye").click();
        await waitFor(() => ed.activeLayer().visible === false, 3000, "hidden");
        ed.setTool("brush");
        const n = itemCount(ed.doc);
        await drag([[300, 300], [400, 350], [500, 300]]);
        const blocked = itemCount(ed.doc) === n;
        rowFor(l.id).querySelector(".eye").click();
        await waitFor(() => ed.activeLayer().visible !== false, 3000, "shown");
        if (!blocked) throw new Error("drew on a hidden layer");
        return "drawing on the hidden layer was blocked";
      });
      await step("layers: lock blocks drawing and selecting", async () => {
        card.querySelector(".lock").click();
        await waitFor(() => ed.activeLayer().locked === true, 3000, "locked");
        const n = itemCount(ed.doc);
        await drag([[300, 300], [400, 350], [500, 300]]);
        const blocked = itemCount(ed.doc) === n;
        const hit = ed.cv.hitTest({ x: W / 2 + 380, y: H / 2 });
        card.querySelector(".lock").click();
        await waitFor(() => !ed.activeLayer().locked, 3000, "unlocked");
        if (!blocked) throw new Error("drew on a locked layer");
        if (hit) throw new Error("could select on a locked layer");
        return "ok";
      });
      await step("layers: drag the bottom layer to the top", async () => {
        const bottom = ed.doc.layers[0];
        const rows = [...card.querySelectorAll(".lrow")];
        const row = rowFor(bottom.id);
        const topRect = rows[0].getBoundingClientRect();
        const r = row.getBoundingClientRect();
        row.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientY: r.top + 5 }));
        window.dispatchEvent(new PointerEvent("pointermove", { clientY: r.top - 20 }));
        window.dispatchEvent(new PointerEvent("pointermove", { clientY: topRect.top + 2 }));
        window.dispatchEvent(new PointerEvent("pointerup", { clientY: topRect.top + 2 }));
        await waitFor(() => ed.doc.layers[ed.doc.layers.length - 1].id === bottom.id, 3000, "reorder");
        // And back down so the rest of the test draws on the sketch layer.
        await ed.apply([{ op: "move_layer", layerId: bottom.id, index: 0 }]);
        return `"${bottom.name}" moved to the top`;
      });
      await step("layers: duplicate copies the items", async () => {
        const l = ed.doc.layers[0];
        ed.setActiveLayer(l.id);
        card.querySelector(".dup").click();
        await waitFor(() => ed.doc.layers.length === 3, 3000, "dup");
        const copy = ed.doc.layers[1];
        if (copy.items.length !== l.items.length) throw new Error("items not copied");
        return `"${copy.name}" with ${copy.items.length} items, active "${ed.activeLayer().name}"`;
      });
      await step("layers: merge down with an eraser keeps the eraser on its layer", async () => {
        const copy = ed.doc.layers[1];
        await ed.apply([{ op: "add_items", layerId: copy.id, items: [{ type: "stroke", brush: "eraser", color: "#000", size: 120, points: [[W / 2 - 300, H / 2], [W / 2 + 300, H / 2]] }] }]);
        ed.setActiveLayer(copy.id);
        card.querySelector(".merge").click();
        await waitFor(() => ed.doc.layers.length === 2, 5000, "merged");
        const below = ed.doc.layers[0];
        const merged = below.items.length === 1 && below.items[0].type === "image";
        if (!merged) throw new Error("expected one merged picture, got " + below.items.map((i) => i.type).join(","));
        await ed.undo();
        await waitFor(() => ed.doc.layers.length === 3, 3000, "undo merge");
        await ed.apply([{ op: "delete_layer", layerId: ed.doc.layers[1].id }]);
        return "merged as one picture, undo restored both layers";
      });
      await step("selecting an item makes its layer active", async () => {
        const shading = ed.doc.layers.find((l) => l.name === "Shading");
        ed.setActiveLayer(shading.id);
        ed.setTool("select");
        const rect = ed.doc.layers[0].items.find((i) => i.type === "rect");
        fire("pointerdown", rect.x + rect.w / 2, rect.y + rect.h / 2);
        fire("pointerup", rect.x + rect.w / 2, rect.y + rect.h / 2);
        await sleep(100);
        if (ed.activeLayerId !== ed.doc.layers[0].id) throw new Error("active layer did not follow the selection");
        ed.setTool("brush");
        return `active "${ed.activeLayer().name}"`;
      });

      // MCP tools, called the same way an agent's HTTP call ends up.
      const id = ed.id;
      const mcp = (name, args) => jdraw.call("smoke:mcp", id, name, args || {});
      await step("mcp get_drawing", async () => { const r = await mcp("get_drawing"); return `${r.json.layers.length} layers, ${r.json.layers.reduce((n, l) => n + l.items.length, 0)} items`; });
      await step("mcp set_palette adds colors", async () => {
        const r = await mcp("set_palette", { colors: ["#ff8fab", "#264653"] });
        await sleep(100);
        if (!r.json.palette.includes("#ff8fab")) throw new Error("color missing");
        return `${r.json.palette.length} colors, swatches shown ${document.querySelectorAll(".swatch[data-c]").length}`;
      });
      let drawnIds = [];
      await step("mcp draw on a new layer", async () => {
        const r = await mcp("draw", { newLayer: "Sun", items: [
          { type: "ellipse", x: W - 360, y: 60, w: 260, h: 260, fill: { type: "radial", stops: [[0, "#fff3b0"], [1, "#ffb703"]] }, shadow: { color: "#ffb70399", blur: 40 } },
          { type: "polygon", points: [[100, 900], [150, 820], [210, 790], [260, 720], [300, 700], [360, 740], [420, 790], [470, 830], [500, 880]], smooth: true, fill: "#8ecae6", stroke: "#023047", strokeWidth: 4 },
          { type: "stroke", points: [[600, 300, 0.2], [625, 288, 0.5], [650, 282, 0.7], [700, 280, 0.9], [750, 286, 0.6], [800, 300, 0.3]], color: "#e5484d", size: 14, brush: "marker" },
        ] });
        drawnIds = r.json.ids;
        if (drawnIds.length !== 3) throw new Error("expected 3 ids");
        return r.json;
      });
      await step("mcp draw_svg refuses a primitive object", async () => {
        let msg = "";
        try { await mcp("draw_svg", { svg: '<svg viewBox="0 0 100 100"><ellipse cx="50" cy="50" rx="45" ry="15" fill="#2a9d8f"/></svg>', x: 80, y: 900, w: 400, name: "Lint test" }); } catch (err) { msg = String(err.message || err); }
        if (!/did not place/.test(msg) || !/ellipse/.test(msg)) throw new Error("not refused: " + (msg || "it was placed"));
        return msg.split("\n")[1].slice(0, 90);
      });
      await step("mcp draw_svg", async () => {
        // An uneven bush outline with three tones passes the shape lint.
        const outline = "M8 82 C3 70 7 56 18 50 C14 34 26 22 40 24 C47 8 72 6 78 24 C92 26 97 44 90 56 C99 68 90 84 76 84 C62 90 40 90 30 87 C20 89 11 88 8 82 Z";
        const r = await mcp("draw_svg", { svg: `<svg viewBox="0 0 100 100"><path d="${outline}" fill="#2a7d6f"/><path d="M16 52 C20 41 28 35 36 30 C41 22 50 18 57 22 C52 31 44 37 38 41 C33 47 26 53 20 58 Z" fill="#4fae8f"/><path d="M58 81 C66 76 77 70 85 63 C91 69 88 78 80 82 C73 85 64 84 58 81 Z" fill="#1d5a50"/></svg>`, x: 80, y: 1100, w: 300, newLayer: "Tree", name: "bush" });
        return r.json;
      });
      await step("mcp edit_items, recolor, layers", async () => {
        await mcp("edit_items", { ids: [drawnIds[1]], patch: { fill: "#219ebc" }, dx: 20, scale: 1.1 });
        const rc = await mcp("recolor", { from: "#219ebc", to: "#90be6d", tolerance: 10 });
        const l = await mcp("layers", { action: "hide", layer: "Tree" });
        await mcp("layers", { action: "show", layer: "Tree" });
        return `recolored ${rc.json.changed}, layers ${l.json.layers.map((x) => x.name).join("/")}`;
      });
      await step("mcp set_brush changes the brush", async () => {
        await mcp("set_brush", { color: "#8e4ec6", size: 22, brush: "pencil" });
        await waitFor(() => cv.brush.color === "#8e4ec6" && cv.brush.brush === "pencil", 2000, "brush");
        return `${cv.brush.color} ${cv.brush.size}px ${cv.brush.brush}, tool ${cv.tool}`;
      });
      await step("mcp view_drawing returns a PNG", async () => {
        const r = await mcp("view_drawing", { maxSize: 512 });
        if (!r.image || !r.image.base64 || r.image.base64.length < 1000) throw new Error("no image");
        const crop = await mcp("view_drawing", { x: 0, y: 0, w: 400, h: 400, maxSize: 256 });
        return `${r.image.width}x${r.image.height}, crop ${crop.image.width}x${crop.image.height}`;
      });
      await step("mcp draw paths (curves, arcs, relative commands, text)", async () => {
        // These simple test paths are refused by the shape lint three times,
        // and the fourth try is refused for good (native shapes go through
        // draw_svg). The geometry itself is then checked with the gate off.
        const args = { newLayer: "Paths", items: [
          { type: "path", d: "M 900 1200 C 950 1100 1050 1100 1100 1200 S 1250 1300 1300 1200 Z", fill: "#ffb4a2", stroke: "#6d597a", strokeWidth: 6 },
          { type: "path", d: "m1000 1400 a120 80 0 1 0 240 0 a120 80 0 1 0 -240 0 z", fill: "#b5e48c" },
          { type: "path", d: "M1350 900 h120 v120 h-120 Z", fill: "#48cae4", x: 20, y: 10, scale: 0.8 },
          { type: "path", d: "M 200 1450 Q 300 1350 400 1450 T 600 1450", stroke: "#e63946", strokeWidth: 10 },
          { type: "text", text: "Big title\nsecond line", x: 900, y: 600, size: 72, fill: "#264653" },
          { type: "ellipse", x: 1200, y: 250, w: 90, h: 54, fill: "#ffd166", rotation: 30 },
        ] };
        const msgs = [];
        for (let k = 1; k <= 4; k++) { try { await mcp("draw", args); throw new Error(`try ${k} landed`); } catch (err) { const m = String(err.message || err); if (/landed$/.test(m)) throw err; msgs.push(m); } }
        if (!/did not place/.test(msgs[0]) || !/will not place/.test(msgs[3])) throw new Error("unexpected refusals: " + msgs.map((m) => m.slice(0, 60)).join(" | "));
        await jdraw.call("prefs:set", "slopGate", false);
        let r;
        try { r = await mcp("draw", args); } finally { await jdraw.call("prefs:set", "slopGate", true); }
        return `4th native try refused, then ${r.json.ids.length} items with the gate off`;
      });

      await step("every item's box matches its drawn pixels", async () => {
        const bad = [];
        let n = 0;
        for (const l of ed.doc.layers) for (const it of l.items) {
          if (it.type === "stroke" && it.brush === "eraser") continue;
          const pb = pixelBox(ed.doc, it);
          if (!pb) continue;
          n++;
          const b = JGeom.bounds(it);
          const out = Math.max(b.x - pb.x, b.y - pb.y, pb.x + pb.w - (b.x + b.w), pb.y + pb.h - (b.y + b.h));
          const extra = (b.w * b.h) / Math.max(1, pb.w * pb.h);
          // Pictures (fills, SVG) can have see-through edges, so only check they do not spill out.
          if (out > 3 || extra > 1.9) bad.push(`${it.type}${it.name ? "(" + it.name + ")" : ""} out ${out.toFixed(1)} px, box ${extra.toFixed(2)}x pixels`);
        }
        if (bad.length) throw new Error(bad.join("; "));
        return `${n} items checked`;
      });

      await step("clicks pick what is drawn, not empty space in a box", async () => {
        ed.setTool("select");
        const paths = ed.doc.layers.find((l) => l.name === "Paths");
        const wave = paths.items[3]; // open curve, mostly empty box
        const b = JGeom.bounds(wave);
        // Middle of the box under the curve is empty paper.
        const empty = ed.cv.hitTest({ x: b.x + b.w * 0.25, y: b.y + b.h * 0.95 });
        const onLine = ed.cv.hitTest({ x: 200, y: 1450 });
        const text = paths.items[4];
        const tb = JGeom.bounds(text);
        const onText = ed.cv.hitTest({ x: tb.x + 10, y: text.y - 20 });
        if (empty && empty.item.id === wave.id) throw new Error("empty space selected the curve");
        if (!onLine || onLine.item.id !== wave.id) throw new Error("clicking the curve's line missed it");
        if (!onText || onText.item.id !== text.id) throw new Error("clicking the text missed it");
        // Show the selection box and a hover outline for the screenshot.
        fire("pointerdown", 200, 1450); fire("pointerup", 200, 1450);
        await sleep(50);
        ed.cv.hover = text.id;
        await capture(app, "05-select");
        ed.cv.hover = null;
        return "ok";
      });

      await step("corner handles scale from the opposite corner", async () => {
        const id = [...ed.cv.selection][0];
        const before = JGeom.bounds(JGeom.findItem(ed.doc, id).item);
        ed.cv.draw();
        const h = ed.cv.frameToScreen(ed.cv._handles.find((x) => x.corner === "nw"));
        const r = ed.cv.canvas.getBoundingClientRect();
        const ev = (type, x, y) => ed.cv.canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, pointerType: "mouse", button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: r.left + x, clientY: r.top + y }));
        ev("pointerdown", h.x, h.y);
        ev("pointermove", h.x - 20, h.y - 10);
        ev("pointermove", h.x - 40, h.y - 20);
        ev("pointerup", h.x - 40, h.y - 20);
        await waitFor(() => JGeom.bounds(JGeom.findItem(ed.doc, id).item).w > before.w + 5, 3000, "scaled");
        const after = JGeom.bounds(JGeom.findItem(ed.doc, id).item);
        const keptCorner = Math.abs(after.x + after.w - (before.x + before.w)) < 2 && Math.abs(after.y + after.h - (before.y + before.h)) < 2;
        if (!keptCorner) throw new Error("opposite corner moved");
        await ed.undo();
        ed.setTool("brush");
        return `width ${Math.round(before.w)} -> ${Math.round(after.w)}, bottom right corner stayed`;
      });

      // ---------- drawing tools, round 2
      const gesture = (pts, extra) => {
        fire("pointerdown", pts[0][0], pts[0][1], extra);
        for (let i = 1; i < pts.length; i++) fire("pointermove", pts[i][0], pts[i][1], extra);
        fire("pointerup", pts[pts.length - 1][0], pts[pts.length - 1][1], extra);
      };
      const line = (x0, y0, x1, y1, n) => Array.from({ length: n + 1 }, (_, i) => [x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n]);
      const top = () => { const l = ed.activeLayer(); return l.items[l.items.length - 1]; };
      const [r2] = await ed.apply([{ op: "add_layer", name: "Round 2" }]);
      ed.setActiveLayer(r2.layerId);
      const L2 = () => ed.doc.layers.find((l) => l.id === r2.layerId);

      await step("shapes: arrow, polygon, star, freeform", async () => {
        ed.setTool("shape");
        cv.shapeFill = false;
        cv.lineDash = "solid";
        const out = [];
        cv.shapeKind = "arrow"; await drag(line(W * 0.05, H * 0.05, W * 0.2, H * 0.1, 6));
        if (!(top().type === "line" && top().arrowEnd)) throw new Error("no arrow line");
        out.push("arrow");
        cv.shapeKind = "polygon"; cv.shapeSides = 6; await drag(line(W * 0.22, H * 0.04, W * 0.3, H * 0.14, 6));
        if (!(top().type === "polygon" && top().points.length === 6)) throw new Error("no hexagon: " + JSON.stringify(top()).slice(0, 120));
        out.push("hexagon");
        cv.shapeKind = "star"; cv.starPoints = 5; await drag(line(W * 0.32, H * 0.04, W * 0.4, H * 0.14, 6));
        if (!(top().type === "polygon" && top().points.length === 10)) throw new Error("no star");
        out.push("star");
        cv.shapeKind = "freeform"; await drag(circle(W * 0.46, H * 0.09, 40, 24));
        if (!(top().type === "polygon" && top().closed && top().points.length >= 6)) throw new Error("no freeform shape");
        out.push(`freeform (${top().points.length} points)`);
        return out.join(", ");
      });

      await step("dashed outline and gradient fill", async () => {
        cv.shapeKind = "rect"; cv.shapeFill = false; cv.lineDash = "dashed";
        await drag(line(W * 0.52, H * 0.04, W * 0.6, H * 0.14, 6));
        const dashed = top();
        if (dashed.dash !== "dashed") throw new Error("rect not dashed");
        cv.shapeKind = "ellipse"; cv.shapeFill = true; cv.paintMode = "linear"; cv.color2 = "#0090ff";
        ed.setBrush({ color: "#e5484d" });
        await drag(line(W * 0.62, H * 0.04, W * 0.7, H * 0.14, 6));
        const g = top();
        cv.paintMode = "solid"; cv.lineDash = "solid";
        if (!g.fill || g.fill.type !== "linear" || g.fill.stops.length !== 2) throw new Error("ellipse has no gradient: " + JSON.stringify(g.fill));
        return `dash ${dashed.dash}, gradient ${g.fill.stops.map((s) => s[1]).join(" to ")}`;
      });

      await step("calligraphy and watercolor brushes", async () => {
        ed.setTool("brush");
        ed.setBrush({ brush: "calligraphy", size: 24, color: "#1f1f24" });
        await drag(line(W * 0.05, H * 0.2, W * 0.2, H * 0.28, 20));
        const c = top();
        ed.setBrush({ brush: "watercolor", size: 40, color: "#0090ff" });
        await drag(line(W * 0.05, H * 0.3, W * 0.2, H * 0.3, 20));
        const w = top();
        if (c.brush !== "calligraphy" || w.brush !== "watercolor") throw new Error(`${c.brush} / ${w.brush}`);
        const pc = pixelBox(ed.doc, c), pw = pixelBox(ed.doc, w);
        if (!pc || !pw) throw new Error("a brush drew nothing");
        return `calligraphy ${pc.w}x${pc.h} px, watercolor ${pw.w}x${pw.h} px`;
      });

      await step("mirror drawing adds copies", async () => {
        ed.setBrush({ brush: "pen", size: 8, color: "#8e4ec6" });
        cv.symmetry = "both";
        const before = L2().items.length;
        await drag(line(W * 0.1, H * 0.4, W * 0.2, H * 0.45, 12));
        cv.symmetry = "off";
        const added = L2().items.length - before;
        if (added !== 4) throw new Error(`expected 4 strokes, got ${added}`);
        const s = L2().items.slice(-4);
        const mirrored = Math.abs(s[0].points[0][0] + s[1].points[0][0] - W) < 1;
        if (!mirrored) throw new Error("copy not mirrored across the middle");
        return "4 strokes, mirrored across the middle";
      });

      await step("smudge and blur change the paint under them", async () => {
        ed.setBrush({ brush: "pen", size: 30, color: "#e5484d" });
        await drag(line(W * 0.25, H * 0.22, W * 0.4, H * 0.22, 20));
        const res = [];
        for (const [kind, x] of [["smudge", 0.3], ["blur", 0.36]]) {
          ed.setBrush({ brush: kind, size: 40, opacity: 1 });
          const before = L2().items.length;
          gesture(line(W * x, H * 0.16, W * x + 10, H * 0.3, 20));
          await waitFor(() => L2().items.length === before + 2, 6000, kind);
          const [er, pic] = L2().items.slice(-2);
          if (er.brush !== "eraser" || pic.type !== "image") throw new Error(`${kind}: got ${er.type}/${er.brush} and ${pic.type}`);
          res.push(`${kind} ${Math.round(pic.w)}x${Math.round(pic.h)}`);
        }
        ed.setBrush({ brush: "pen", size: 8 });
        return res.join(", ");
      });

      // A ring with a small break in it, alone on its own layer.
      const [gapL] = await ed.apply([{ op: "add_layer", name: "Gap ring" }]);
      ed.setActiveLayer(gapL.layerId);
      const ringC = { x: W * 0.8, y: H * 0.25 };
      await ed.apply([{ op: "add_items", layerId: gapL.layerId, items: [{ type: "stroke", brush: "pen", size: 6, color: "#1f1f24", points: Array.from({ length: 61 }, (_, i) => { const a = 0.1 + (i / 60) * (Math.PI * 2 - 0.2); return [ringC.x + Math.cos(a) * 80, ringC.y + Math.sin(a) * 80, 1]; }) }] }]);

      await step("fill: close gaps keeps the fill inside a broken ring", async () => {
        ed.setTool("fill");
        cv.fill.sample = "layer"; cv.fill.tolerance = 48;
        const gapLayer = () => ed.doc.layers.find((l) => l.id === gapL.layerId);
        cv.fill.gap = 0;
        let before = gapLayer().items.length;
        await click(ringC.x, ringC.y);
        await waitFor(() => gapLayer().items.length > before, 8000, "leaky fill");
        const leaky = gapLayer().items[0];
        await ed.undo();
        cv.fill.gap = 8;
        before = gapLayer().items.length;
        await click(ringC.x, ringC.y);
        await waitFor(() => gapLayer().items.length > before, 8000, "closed fill");
        const closed = gapLayer().items[0];
        cv.fill.gap = 0; cv.fill.sample = "all";
        if (!(leaky.w > W * 0.8)) throw new Error("expected the fill to leak without gap closing, got " + Math.round(leaky.w));
        if (!(closed.w < 200)) throw new Error("fill leaked with gap closing: " + Math.round(closed.w));
        return `no gap closing ${Math.round(leaky.w)} px wide, with 8 px ${Math.round(closed.w)} px wide`;
      });

      await step("mcp fill_area colors inside the ring", async () => {
        const r = await mcp("fill_area", { x: ringC.x, y: ringC.y, color: "#46a758", color2: "#ffc53d", gradient: "radial", gap: 8, sample: "layer", layer: "Gap ring" });
        if (!(r.json.bounds.w < 200)) throw new Error("agent fill leaked: " + JSON.stringify(r.json));
        return JSON.stringify(r.json.bounds);
      });

      ed.setActiveLayer(r2.layerId);
      await step("select: groups, duplicate, rotate handle, flip, align, space out", async () => {
        ed.setTool("shape"); cv.shapeKind = "rect"; cv.shapeFill = true;
        ed.setBrush({ color: "#0090ff" });
        const ids = [];
        for (let i = 0; i < 3; i++) { await drag(line(W * (0.1 + i * 0.07 + i * i * 0.01), H * 0.6, W * (0.14 + i * 0.07 + i * i * 0.01), H * (0.66 + i * 0.02), 4)); ids.push(top().id); }
        ed.setTool("select");
        ed.selection = ids; cv.setSelection(ids); ed.renderDock();
        ed.groupSelection();
        await waitFor(() => ids.every((id) => JGeom.findItem(ed.doc, id).item.group), 3000, "grouped");
        // A click on one picks the whole group.
        ed.selection = []; cv.setSelection([]);
        const b0 = JGeom.bounds(JGeom.findItem(ed.doc, ids[0]).item);
        await click(b0.x + b0.w / 2, b0.y + b0.h / 2);
        if (cv.selection.size !== 3) throw new Error("click picked " + cv.selection.size + " items, not the group");
        ed.ungroupSelection();
        await waitFor(() => ids.every((id) => !JGeom.findItem(ed.doc, id).item.group), 3000, "ungrouped");
        ed.selection = ids; cv.setSelection(ids);
        await ed.apply([{ op: "distribute_items", ids, dir: "horizontal" }]);
        const bx = ids.map((id) => JGeom.bounds(JGeom.findItem(ed.doc, id).item));
        const gap1 = bx[1].x - (bx[0].x + bx[0].w), gap2 = bx[2].x - (bx[1].x + bx[1].w);
        if (Math.abs(gap1 - gap2) > 0.5) throw new Error(`gaps ${gap1} and ${gap2}`);
        await ed.apply([{ op: "align_items", ids, how: "top" }]);
        if (new Set(ids.map((id) => Math.round(JGeom.bounds(JGeom.findItem(ed.doc, id).item).y))).size !== 1) throw new Error("tops not lined up");
        // Duplicate one with Ctrl+D.
        ed.selection = [ids[0]]; cv.setSelection([ids[0]]);
        const n0 = L2().items.length;
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "d", ctrlKey: true, bubbles: true }));
        await waitFor(() => L2().items.length === n0 + 1, 3000, "duplicate");
        const dup = cv.selection.size === 1 ? JGeom.findItem(ed.doc, [...cv.selection][0]).item : null;
        if (!dup || dup.id === ids[0]) throw new Error("the copy is not selected");
        // Rotate handle: drag a quarter turn with Shift.
        cv.draw();
        const h = cv.frameToScreen(cv._handles.find((x) => x.corner === "rotate"));
        const hd = cv.toDoc(h.x, h.y);
        const bb = JGeom.bounds(dup);
        const c = { x: bb.x + bb.w / 2, y: bb.y + bb.h / 2 };
        const rr = Math.hypot(hd.x - c.x, hd.y - c.y);
        fire("pointerdown", hd.x, hd.y);
        fire("pointermove", c.x + rr * 0.7, c.y - rr * 0.7, { shiftKey: true });
        fire("pointermove", c.x + rr, c.y + 1, { shiftKey: true });
        fire("pointerup", c.x + rr, c.y + 1, { shiftKey: true });
        await waitFor(() => Math.round(JGeom.findItem(ed.doc, dup.id).item.rotation || 0) === 90, 3000, "rotated 90");
        await ed.apply([{ op: "transform_items", ids: [dup.id], flip: "x" }]);
        const flipped = JGeom.findItem(ed.doc, dup.id).item;
        if (flipped.rotation !== -90) throw new Error("flip should turn 90 into -90, got " + flipped.rotation);
        return `3 spaced ${gap1.toFixed(1)} px apart, copy turned 90 then flipped to ${flipped.rotation}`;
      });

      await step("alt+drag drops a copy and lasso selects", async () => {
        const id0 = [...cv.selection][0];
        const it = JGeom.findItem(ed.doc, id0).item;
        const b = JGeom.bounds(it);
        const n0 = L2().items.length;
        gesture(line(b.x + b.w / 2, b.y + b.h / 2, b.x + b.w / 2 + 60, b.y + b.h / 2 + 140, 6), { altKey: true });
        await waitFor(() => L2().items.length === n0 + 1, 3000, "alt copy");
        if (!JGeom.findItem(ed.doc, id0)) throw new Error("the original moved away");
        const copyId = [...cv.selection][0];
        if (copyId === id0) throw new Error("copy not selected");
        const cb = JGeom.bounds(JGeom.findItem(ed.doc, copyId).item);
        cv.selectMode = "lasso";
        ed.selection = []; cv.setSelection([]);
        gesture(circle(cb.x + cb.w / 2, cb.y + cb.h / 2, Math.max(cb.w, cb.h) * 0.75 + 10, 30));
        await sleep(50);
        cv.selectMode = "box";
        if (!cv.selection.has(copyId)) throw new Error("lasso did not pick the copy: " + [...cv.selection].join(","));
        return `copy dropped, lasso picked ${cv.selection.size}`;
      });

      await step("copy and paste", async () => {
        const id0 = [...cv.selection][0];
        ed.selection = [id0]; cv.setSelection([id0]);
        const orig = JGeom.findItem(ed.doc, id0).item;
        const n0 = L2().items.length;
        await ed.copySelection(false);
        await ed.paste();
        await waitFor(() => L2().items.length === n0 + 1, 3000, "paste");
        const p = JGeom.findItem(ed.doc, [...cv.selection][0]).item;
        if (Math.round(p.x - orig.x) !== 20) throw new Error("paste offset " + (p.x - orig.x));
        return "pasted 20 px down and right";
      });

      await step("drop a picture file onto the canvas", async () => {
        const c = JRender.makeCanvas(64, 40);
        const x = c.getContext("2d"); x.fillStyle = "#e5484d"; x.fillRect(0, 0, 64, 40);
        const blob = await new Promise((r) => c.toBlob(r, "image/png"));
        const dt = new DataTransfer();
        dt.items.add(new File([blob], "red box.png", { type: "image/png" }));
        const p = cv.toScreen(W * 0.5, H * 0.5);
        const sr = ed.stage.getBoundingClientRect();
        const n0 = L2().items.length;
        ed.stage.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt, clientX: sr.left + p.x, clientY: sr.top + p.y }));
        await waitFor(() => L2().items.length === n0 + 1, 4000, "dropped picture");
        const img = top();
        if (img.type !== "image" || img.name !== "red box") throw new Error(`got ${img.type} ${img.name}`);
        return `${img.name} ${img.w}x${img.h} at ${Math.round(img.x)},${Math.round(img.y)}`;
      });

      await step("canvas dialog grows the canvas around the middle", async () => {
        const probe = JGeom.findItem(ed.doc, [...cv.selection][0]).item;
        const x0 = probe.x;
        const p = ed.canvasDialog();
        await sleep(120);
        const dlg = document.querySelector(".dialog");
        dlg.querySelector("#cw").value = String(W + 200);
        dlg.querySelector("#ch").value = String(H + 100);
        dlg.querySelector('.anchor button[data-v="center"]').click();
        [...dlg.querySelectorAll(".row button")].find((b) => b.textContent === "Apply").click();
        await p;
        const moved = JGeom.findItem(ed.doc, probe.id).item.x - x0;
        const size = `${ed.doc.width}x${ed.doc.height}`;
        await ed.undo();
        await waitFor(() => ed.doc.width === W, 2000, "undo size");
        if (size !== `${W + 200}x${H + 100}` || Math.round(moved) !== 100) throw new Error(`size ${size}, moved ${moved}`);
        return `${size}, drawing moved 100 px to stay centered (undone)`;
      });

      await step("turned view: strokes land where drawn", async () => {
        cv.rotateView(30);
        ed.setTool("brush");
        ed.setBrush({ brush: "pen", size: 6, color: "#1f1f24", steady: 0 });
        const want = [W * 0.6, H * 0.45];
        await drag(line(want[0], want[1], W * 0.7, H * 0.5, 15));
        const s = top();
        const off = Math.hypot(s.points[0][0] - want[0], s.points[0][1] - want[1]);
        const rt = cv.toDoc(cv.toScreen(123, 456).x, cv.toScreen(123, 456).y);
        const deg = cv.viewDegrees();
        await capture(app, "05-turned");
        cv.rotateView(0, true);
        ed.setBrush({ steady: 0.45 });
        if (off > 2 || Math.abs(rt.x - 123) > 1e-6) throw new Error(`stroke off by ${off}`);
        return `view at ${deg} deg, stroke starts ${off.toFixed(2)} px from the pointer`;
      });

      await step("snap to grid and rulers", async () => {
        ed.toggleView("snap");
        ed.toggleView("rulers");
        ed.setTool("shape"); cv.shapeKind = "rect";
        await drag(line(W * 0.52 + 7, H * 0.82 + 13, W * 0.52 + 140, H * 0.82 + 90, 5));
        const r = top();
        cv.draw();
        await capture(app, "06-grid-rulers");
        ed.toggleView("snap"); ed.toggleView("grid"); ed.toggleView("rulers");
        const g = cv.grid.size;
        if (r.x % g || r.y % g || r.w % g || r.h % g) throw new Error(`not on the grid: ${r.x},${r.y} ${r.w}x${r.h}`);
        return `rect at ${r.x},${r.y} size ${r.w}x${r.h} on a ${g} px grid`;
      });

      await step("SVG export loads as a picture", async () => {
        const svg = JSvg.toSvg(ed.doc);
        const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
        if (parsed.querySelector("parsererror")) throw new Error("bad SVG: " + parsed.querySelector("parsererror").textContent.slice(0, 200));
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error("SVG did not load as an image")); img.src = ed.svgUrl(svg); });
        const file = await ed.exportSvg();
        if (!file) throw new Error("no file");
        ed.selection = [top().id]; cv.setSelection(ed.selection);
        const sel = await ed.exportSelection("png");
        return `${Math.round(svg.length / 1024)} KB, ${img.naturalWidth}x${img.naturalHeight}; selection PNG ${sel ? "saved" : "missing"}`;
      });

      await step("mcp arrange and canvas anchor", async () => {
        const rects = L2().items.filter((i) => i.type === "rect").slice(0, 3).map((i) => i.id);
        const d = await mcp("arrange", { action: "duplicate", ids: [rects[0]], dx: 30, dy: 0 });
        const g = await mcp("arrange", { action: "group", ids: rects.slice(0, 2) });
        await mcp("arrange", { action: "align", ids: rects, how: "left" });
        const rot0 = JGeom.findItem(ed.doc, rects[2]).item.rotation || 0;
        await mcp("arrange", { action: "rotate", ids: [rects[2]], degrees: 45 });
        await mcp("arrange", { action: "flip", ids: [rects[2]], axis: "y" });
        const got = await mcp("get_drawing");
        const r2item = got.json.layers.flatMap((l) => l.items).find((i) => i.id === rects[2]);
        const lefts = rects.map((id) => Math.round(JGeom.bounds(JGeom.findItem(ed.doc, id).item).x));
        const b = await mcp("set_brush", { brush: "calligraphy" });
        await waitFor(() => cv.brush.brush === "calligraphy", 2000, "brush set");
        const c = await mcp("canvas", { width: W + 100, anchor: "center" });
        await ed.undo();
        // Turned by 45 then mirrored top to bottom: the angle flips sign.
        const want = -(((rot0 + 45 + 540) % 360) - 180);
        if (d.json.ids.length !== 1 || !g.json.group || Math.abs((r2item.rotation || 0) - want) > 0.01 || r2item.flipX || r2item.flipY) throw new Error(JSON.stringify({ d: d.json, g: g.json, r2item, want }));
        return `copy ${d.json.ids[0]}, group ${g.json.group}, lefts ${lefts.join("/")}, rotation ${r2item.rotation}, canvas ${c.json.width}`;
      });
      ed.setBrush({ brush: "pen", size: 8 });
      ed.setTool("brush");

      await step("mcp rejects a bad item with a plain message", async () => {
        try { await mcp("draw", { items: [{ type: "blob" }] }); return false; } catch (err) { return err.message; }
      });

      await sleep(400);
      await step("add to the video library", async () => {
        const c = await JRender.renderToCanvas(ed.doc, { scale: 1, transparent: false });
        const r = await jdraw.call("studio:to-video-library", "JDesign smoke drawing " + Date.now(), c.toDataURL("image/png"));
        if (!r.added) throw new Error("not added: " + r.reason);
        return "library item " + r.id;
      });

      await step("export PNG", async () => ed.export({ scale: 1 }).then((f) => { if (!f) throw new Error("no file"); return f; }));
      await capture(app, "02-editor");
      await step("assistant chips shown", async () => {
        const n = document.querySelectorAll(".chips .chip").length;
        return n > 0 ? `${n} chips` : (ed.assistant.agent() ? false : "no agent installed, chips hidden");
      });

      await step("no clipped or overlapping controls", async () => {
        const bad = [];
        const inside = (r, o) => r.left >= o.left - 1 && r.right <= o.right + 1 && r.top >= o.top - 1 && r.bottom <= o.bottom + 1;
        for (const tool of ["brush", "eraser", "shape", "fill", "text", "select"]) {
          ed.setTool(tool); await sleep(30);
          const dock = document.querySelector(".dock");
          if (!dock) continue;
          const db = dock.getBoundingClientRect();
          // Every control sits inside the dock, every slider's parts inside the slider.
          for (const c of dock.querySelectorAll("button, input, .slider, .current-color")) {
            if (c.closest(".palette")) continue; // the palette scrolls on purpose
            const r = c.getBoundingClientRect();
            if (r.width && !inside(r, db)) bad.push(`${tool}: ${c.className || c.tagName} outside the dock`);
          }
          for (const s of dock.querySelectorAll(".slider")) {
            const sb = s.getBoundingClientRect();
            for (const part of s.querySelectorAll(".lab, .lab b, input")) if (!inside(part.getBoundingClientRect(), sb)) bad.push(`${tool}: ${s.textContent.trim()} spills out of its slider`);
          }
        }
        ed.setTool("brush");
        // Text inside the composer pickers is not cut off.
        for (const p of document.querySelectorAll(".composer .selectors .picker span")) if (p.scrollWidth > p.clientWidth + 1) bad.push(`picker "${p.textContent}" is cut off`);
        if (bad.length) throw new Error([...new Set(bad)].slice(0, 6).join("; "));
        return "ok";
      });

      if (cfg.ui) {
        await step("dark theme", async () => { await UI.applyTheme("dark"); await sleep(300); await capture(app, "03-dark"); await UI.applyTheme("light"); return "ok"; });
      }

      }

      if (cfg.agent) {
        await step(`real agent turn (${cfg.agent})`, async () => {
          // Fresh drawing so the agent's work is easy to see.
          await app.goHome();
          const d = await jdraw.call("drawings:create", { width: cfg.width || 1600, height: cfg.height || 1200, name: cfg.name || "Agent smoke" });
          const e2 = await app.openDrawing(d.id);
          await sleep(300);
          // A quick sketch for the agent to work with.
          const c2 = e2.cv;
          const r2 = c2.canvas.getBoundingClientRect();
          const f2 = (type, x, y) => { const p = c2.toScreen(x, y); c2.canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 2, pointerType: "mouse", isPrimary: true, button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: r2.left + p.x, clientY: r2.top + p.y })); };
          const sketch = async (pts) => { const b = itemCount(e2.doc); f2("pointerdown", ...pts[0]); for (const p of pts.slice(1)) f2("pointermove", ...p); f2("pointerup", ...pts[pts.length - 1]); await waitFor(() => itemCount(e2.doc) > b, 3000, "sketch").catch(() => {}); };
          e2.setBrush({ color: "#1f1f24", size: 8, brush: "pen" });
          if (!cfg.drawOnly) await sketch(Array.from({ length: 61 }, (_, i) => [800 + Math.cos((i / 60) * Math.PI * 2) * 260, 640 + Math.sin((i / 60) * Math.PI * 2) * 220]));
          if (!cfg.drawOnly) await sketch([[560, 560], [800, 280], [1040, 560]]);
          const before = itemCount(e2.doc);
          const a = e2.assistant;
          const agent = a.agents.find((x) => x.id === cfg.agent);
          if (!agent || !agent.installed) throw new Error(`${cfg.agent} is not installed`);
          if (a.agentId !== cfg.agent) { a.agentId = cfg.agent; a.models = null; a.renderAll(); a.warm(); }
          // The selectors are on screen and the model list loads by itself.
          const agentBtn = document.querySelector(".composer .agent-pick");
          const modelBtn = document.querySelector(".composer .model-pick");
          const vis = (n) => n && n.offsetWidth > 40 && n.offsetHeight > 20;
          if (!vis(agentBtn) || !vis(modelBtn)) throw new Error("agent or model selector not visible");
          await waitFor(() => a.models && a.models.available.length, 120000, "model list");
          modelBtn.click();
          await sleep(150);
          const items = [...document.querySelectorAll(".menu button")];
          const names = items.map((b) => b.textContent.trim());
          const want = cfg.model ? items.find((b) => b.textContent.toLowerCase().includes(cfg.model.toLowerCase())) : items.find((b) => /haiku|sonnet/i.test(b.textContent)) || items[items.length - 1];
          if (!want) throw new Error("model not in menu: " + names.join(", "));
          want.click();
          await sleep(300);
          await waitFor(() => !a.modelsLoading, 120000, "model switch settles");
          const effortBtn = document.querySelector(".composer .effort-pick");
          if (!vis(effortBtn)) throw new Error("effort selector not visible");
          await waitFor(() => a.effort && a.effort.available.length, 30000, "effort levels");
          effortBtn.click();
          await sleep(150);
          const effItems = [...document.querySelectorAll(".menu button")];
          const effort = cfg.effort || "low";
          const low = effItems.find((b) => new RegExp("^" + effort, "i").test(b.textContent.trim()));
          if (!low) throw new Error("no " + effort + " effort in menu: " + effItems.map((b) => b.textContent.trim()).join(", "));
          low.click();
          await waitFor(() => a.effort && a.effort.current === effort, 60000, "effort applied by the agent");
          report.selectors = { agentLabel: agentBtn.textContent.trim(), modelLabel: modelBtn.textContent.trim(), effortLabel: effortBtn.textContent.trim(), menu: names, effortMenu: effItems.map((b) => b.textContent.trim()), picked: a.modelPrefs[cfg.agent], effortNow: a.effort.current };
          console.log("[smoke] selectors " + JSON.stringify(report.selectors));
          a.input.value = cfg.prompt || "Color in my sketch: it is a house shape, a round body with a pointed roof. Fill the body and roof with nice colors under my lines, and add a simple sky and grass background.";
          a.input.dispatchEvent(new Event("input"));
          a.composer.requestSubmit();
          await waitFor(() => a.busy, 10000, "turn start");
          const t0 = Date.now();
          await waitFor(() => !a.busy, cfg.timeoutMs, "agent turn");
          const msgs = a.chat.messages;
          const last = [...msgs].reverse().find((m) => m.role === "agent");
          await sleep(500);
          report.check = await jdraw.call("slop:result", e2.id);
          report.agentMessages = msgs.filter((m) => m.role === "agent").length;
          report.gateMessages = msgs.filter((m) => m.auto).map((m) => m.text);
          const after = itemCount(e2.doc);
          report.agentExport = await e2.export({ scale: 1 });
          console.log("[smoke] agent export " + report.agentExport);
          await capture(app, "04-agent");
          report.agentChat = {
            steps: [...document.querySelectorAll(".msg.agent .step")].map((s) => s.textContent),
            body: (document.querySelector(".msg.agent:last-child .body") || {}).textContent,
            undoButton: [...document.querySelectorAll(".after-turn button")].map((b) => b.textContent),
            sendButton: a.sendBtn.textContent.trim() + (a.sendBtn.disabled ? " (disabled)" : ""),
            panelWidth: document.querySelector(".panel").offsetWidth,
            dockOverlap: (() => { const labs = [...document.querySelectorAll(".dock .slider")].map((s) => s.getBoundingClientRect()); return labs.some((r, i) => i && r.left < labs[i - 1].right - 1); })(),
          };
          report.agent = { text: last && last.text, tools: last && last.tools, error: last && last.error, seconds: Math.round((Date.now() - t0) / 1000), itemsBefore: before, itemsAfter: after, layers: e2.doc.layers.map((l) => `${l.name}:${l.items.length}`), palette: e2.doc.palette };
          if (last && last.error) throw new Error(last.error);
          if (after <= before) throw new Error("the agent did not add anything to the drawing");
          return `${Math.round((Date.now() - t0) / 1000)} s, items ${before} -> ${after}, tools ${(last.tools || []).length}`;
        });
      }
    } catch (err) {
      check("smoke crashed", false, err.stack || err.message);
    }
    report.ok = checks.every((c) => c.ok);
    report.finishedAt = new Date().toISOString();
    await jdraw.call("smoke:done", report);
  }

  window.Smoke = { run };
})();
