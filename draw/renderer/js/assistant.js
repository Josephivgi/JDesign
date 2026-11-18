// The assistant panel: pick an agent and model, chat, quick actions, and
// undo what the assistant did.
(function () {
  const { el, esc, showMenu, toast } = UI;

  const TOOL_LABELS = {
    view_drawing: ["Looked at the drawing", "eye"],
    get_drawing: ["Read the layers", "layers"],
    draw: ["Drew", "brush"],
    draw_svg: ["Painted", "palette"],
    edit_items: ["Adjusted", "edit"],
    delete_items: ["Removed items", "trash"],
    recolor: ["Recolored", "fill"],
    set_palette: ["Added colors", "palette"],
    set_brush: ["Set your brush", "brush"],
    canvas: ["Changed the canvas", "square"],
    layers: ["Changed layers", "layers"],
  };

  function toolLabel(title) {
    const t = String(title || "");
    const m = t.match(/(?:mcp__jdraw__|jdraw[_:.]+)?([a-z_]+)/i);
    const key = m && TOOL_LABELS[m[1]] ? m[1] : Object.keys(TOOL_LABELS).find((k) => t.includes(k));
    if (key) return TOOL_LABELS[key];
    if (/^Blocked/.test(t)) return ["Blocked a tool outside JDraw", "alert"];
    // The agent's own housekeeping (tool search, todo lists) is not shown.
    return null;
  }

  // Small safe formatter for agent replies: paragraphs, lists, bold, code.
  function richText(text) {
    if (!text) return "";
    const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>").replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
    const out = [];
    for (const block of text.split(/\n{2,}/)) {
      const lines = block.split("\n");
      if (lines.every((l) => /^\s*([-*]|\d+\.)\s+/.test(l))) {
        const ordered = /^\s*\d+\./.test(lines[0]);
        out.push(`<${ordered ? "ol" : "ul"}>${lines.map((l) => `<li>${inline(l.replace(/^\s*([-*]|\d+\.)\s+/, ""))}</li>`).join("")}</${ordered ? "ol" : "ul"}>`);
      } else if (/^#{1,4}\s/.test(lines[0])) {
        out.push(`<p><strong>${inline(lines[0].replace(/^#{1,4}\s/, ""))}</strong>${lines.length > 1 ? "<br>" + lines.slice(1).map(inline).join("<br>") : ""}</p>`);
      } else out.push(`<p>${lines.map(inline).join("<br>")}</p>`);
    }
    return out.join("");
  }

  const ACTIONS = {
    empty: [
      { label: "Draw something for me", icon: "sparkles", fill: "Draw " },
      { label: "Coloring page", icon: "pencil", prompt: "Make a simple coloring page for me: clean black outlines of a friendly scene with big shapes I can fill, no colors." },
      { label: "Suggest a palette", icon: "palette", prompt: "Suggest a palette of 8 colors that work well together for a cheerful illustration and add them to my palette. Do not draw anything." },
    ],
    drawing: [
      { label: "Color it in", icon: "fill", prompt: "Color my drawing. Keep my lines on top and fill each shape with fitting, harmonious colors on a layer underneath." },
      { label: "Add shading", icon: "shade", prompt: "Add soft shading and highlights so my drawing looks more three dimensional. Keep my lines visible and pick a light direction from the top left." },
      { label: "Clean up lines", icon: "clean", prompt: "Trace my sketch with clean, smooth line art on a new layer called Clean lines, then hide my original sketch layer." },
      { label: "Add a background", icon: "mountain", prompt: "Add a background that fits my drawing, on a new layer under everything else." },
      { label: "Finish it", icon: "wand", prompt: "Finish this drawing: add the details it is missing while keeping my style and colors." },
      { label: "Suggest a palette", icon: "palette", prompt: "Look at my drawing and add 6 to 8 colors that fit it to my palette. Do not draw anything." },
    ],
    selection: [
      { label: "Recolor selection", icon: "fill", prompt: "Recolor the items I selected with a nicer color scheme that fits the rest of the drawing." },
      { label: "Add detail here", icon: "wand", prompt: "Add detail and texture to the part I selected, keeping its shape." },
      { label: "Shade selection", icon: "shade", prompt: "Shade the part I selected with soft shadows and a highlight." },
    ],
  };

  const EFFORT_NAMES = { xhigh: "Extra high", max: "Max", low: "Low", medium: "Medium", high: "High", default: "Default" };
  function effortName(o) { return EFFORT_NAMES[o.id] || (/^xhigh$/i.test(o.name) ? "Extra high" : o.name); }

  class Assistant {
    constructor(root, editor) {
      this.root = root;
      this.editor = editor;
      this.agents = [];
      this.agentId = null;
      this.models = null;
      this.modelPrefs = {};
      this.status = { state: "idle" };
      this.chat = { messages: [] };
      this.busy = false;
      this.canUndoTurn = false;
      this.skills = [];
      this.commandCache = {};
      this.slash = null;
      this.build();
      jdraw.call("skills:list").then((list) => { this.skills = list || []; if (this.slash) this.updateSlash(); }).catch(() => {});
    }

    build() {
      this.root.innerHTML = "";
      this.list = el('<div class="messages" aria-live="polite"></div>');
      this.root.appendChild(this.list);
      this.stateEl = el('<div class="agent-state"></div>');
      this.root.appendChild(this.stateEl);
      this.chipsEl = el('<div class="chips"></div>');
      this.root.appendChild(this.chipsEl);
      // The wheel scrolls the chip row sideways; fades show there is more.
      this.chipsEl.addEventListener("wheel", (e) => {
        if (this.chipsEl.scrollWidth <= this.chipsEl.clientWidth) return;
        e.preventDefault();
        this.chipsEl.scrollLeft += e.deltaY || e.deltaX;
      }, { passive: false });
      this.chipsEl.addEventListener("scroll", () => this.chipFades());
      this.queuedEl = el('<div class="queued" hidden></div>');
      this.root.appendChild(this.queuedEl);
      this.composer = el(`<form class="composer">
        <div class="selectors">
          <div class="sel"><span class="sel-label">Agent</span><button type="button" class="picker agent-pick" aria-label="Agent">${icon("sparkles")}<span>Agent</span>${icon("chevron")}</button></div>
          <div class="sel"><span class="sel-label">Model</span><button type="button" class="picker model-pick" aria-label="Model"><span>Model</span>${icon("chevron")}</button></div>
          <div class="sel"><span class="sel-label">Effort</span><button type="button" class="picker effort-pick" aria-label="Effort"><span>Effort</span>${icon("chevron")}</button></div>
        </div>
        <textarea rows="2" placeholder="Ask for help with your drawing" aria-label="Message"></textarea>
        <div class="row"><button type="button" class="btn ghost sm clear-chat" title="Start a new chat" aria-label="New chat">${icon("plus")}New chat</button><span class="ctx"></span><button type="submit" class="btn primary sm send">${icon("send")}Send</button></div>
      </form>`);
      this.root.appendChild(this.composer);
      this.input = this.composer.querySelector("textarea");
      // The / menu: JDraw skills and the agent's own commands.
      this.slashEl = el('<div class="menu slash" role="listbox" aria-label="Commands" hidden></div>');
      this.composer.appendChild(this.slashEl);
      this.slashEl.addEventListener("pointerdown", (e) => e.preventDefault());
      this.sendBtn = this.composer.querySelector(".send");
      this.ctxEl = this.composer.querySelector(".ctx");
      this.input.addEventListener("input", () => { this.autosize(); this.renderBar(); this.updateContext(); this.updateSlash(); });
      this.input.addEventListener("focus", () => this.updateContext());
      this.input.addEventListener("blur", () => { this.updateContext(); this.closeSlash(); });
      this.input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (this.slash && this.slashKey(e)) return;
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          // Enter never stops a running turn; it queues the message instead.
          if (this.busy) this.queue();
          else this.send();
        }
        if (e.key === "Escape" && this.busy) { e.preventDefault(); this.cancel(); }
      });
      this.composer.addEventListener("submit", (e) => {
        e.preventDefault();
        if (this.busy) { if (this.input.value.trim()) this.queue(); else this.cancel(); }
        else this.send();
      });
      this.root.querySelector(".agent-pick").addEventListener("click", (e) => this.pickAgent(e.currentTarget));
      this.root.querySelector(".model-pick").addEventListener("click", (e) => this.pickModel(e.currentTarget));
      this.root.querySelector(".effort-pick").addEventListener("click", (e) => this.pickEffort(e.currentTarget));
      this.root.querySelector(".clear-chat").addEventListener("click", () => this.clear());
      this.autosize();
    }

    // Grows with the text from two lines up to about seven, then scrolls.
    autosize() {
      this.input.style.height = "auto";
      this.input.style.height = Math.min(168, Math.max(56, this.input.scrollHeight)) + "px";
    }

    async load(chat, busy, canUndoTurn) {
      this.chat = chat || { messages: [] };
      this.busy = !!busy;
      this.canUndoTurn = !!canUndoTurn;
      try {
        const res = await jdraw.call("agents:list");
        this.agents = res.agents;
        this.modelPrefs = res.models || {};
        this.modelCache = res.modelCache || {};
        this.effortPrefs = res.efforts || {};
        this.effortCache = res.effortCache || {};
        const installed = this.agents.filter((a) => a.installed);
        const want = this.chat.agent || res.preferred;
        this.agentId = (installed.find((a) => a.id === want) || installed[0] || {}).id || null;
        this.models = (this.agentId && this.modelCache[this.agentId]) || null;
        this.effort = (this.agentId && this.effortCache[this.agentId]) || null;
      } catch (err) { this.agents = []; }
      this.renderAll();
      this.warm();
    }

    // Start the agent in the background so the model list is real and the
    // first message does not wait for start-up.
    async warm() {
      const agentId = this.agentId;
      if (!agentId || this.busy) return;
      this.modelsLoading = true;
      this.renderBar();
      try {
        const r = await jdraw.call("agent:start", this.editor.id, agentId);
        if (this.agentId !== agentId) return;
        if (r.models) { this.models = r.models; this.modelCache[agentId] = r.models; }
        this.effort = r.effort || null;
        this.effortCache[agentId] = this.effort;
        if (r.commands && r.commands.length) this.commandCache[agentId] = r.commands;
      } catch (err) {
        if (this.agentId === agentId) { this.status = { state: "failed", message: err.message }; this.renderState(); }
      } finally {
        if (this.agentId === agentId) { this.modelsLoading = false; this.renderBar(); }
      }
    }

    agent() { return this.agents.find((a) => a.id === this.agentId); }

    renderAll() {
      this.renderBar();
      this.renderMessages();
      this.renderChips();
      this.renderState();
      this.updateContext();
    }

    renderBar() {
      const a = this.agent();
      const ap = this.root.querySelector(".agent-pick span");
      ap.textContent = a ? a.name : "No agent";
      const mp = this.root.querySelector(".model-pick");
      const pref = this.agentId && this.modelPrefs[this.agentId];
      const cur = this.models && this.models.available.find((m) => m.id === (pref || this.models.current));
      mp.querySelector("span").textContent = cur ? cur.name : this.modelsLoading ? "Loading..." : pref || "Default";
      mp.disabled = !a;
      mp.title = cur ? `${cur.name}${cur.description ? ": " + cur.description : ""}` : "Pick a model";
      const ep = this.root.querySelector(".effort-pick");
      const effPref = this.agentId && this.effortPrefs[this.agentId];
      const effCur = this.effort && this.effort.available.find((o) => o.id === (effPref || this.effort.current));
      ep.querySelector("span").textContent = effCur ? effortName(effCur) : this.modelsLoading && !this.effort ? "Loading..." : this.effort ? "Default" : "Not offered";
      mp.classList.toggle("loading", !cur && !!this.modelsLoading);
      ep.classList.toggle("loading", !effCur && !!this.modelsLoading && !this.effort);
      ep.disabled = !a || (!this.effort && !this.modelsLoading);
      ep.title = this.effort ? "How hard the model thinks before it draws. Higher is slower and more careful." : `${a ? a.name : "This agent"} does not offer an effort setting for this model.`;
      // While a turn runs: Stop, or Queue once something is typed (Esc still stops).
      const typed = !!this.input.value.trim();
      const queueMode = this.busy && typed;
      this.sendBtn.innerHTML = queueMode ? `${icon("clock")}Queue` : this.busy ? `${icon("stop")}Stop` : `${icon("send")}Send`;
      this.sendBtn.classList.toggle("primary", !this.busy || queueMode);
      this.sendBtn.classList.toggle("stop", this.busy && !queueMode);
      this.sendBtn.disabled = !this.busy && (!a || !typed);
      this.sendBtn.title = queueMode ? "Send this when the assistant is done (Enter). Esc stops the assistant." : this.busy ? "Stop the assistant (Esc)" : "Send (Enter)";
      this.input.placeholder = this.busy ? `${a ? a.name : "The assistant"} is working. You can write your next message.` : "Ask for help with your drawing";
      this.composer.classList.toggle("busy", this.busy);
      this.syncTimer();
    }

    // "Working 12 s" in the composer while a turn runs.
    syncTimer() {
      if (this.busy && !this._timer) {
        this._since = this._since || Date.now();
        this._timer = setInterval(() => this.updateContext(), 1000);
      } else if (!this.busy && this._timer) {
        clearInterval(this._timer);
        this._timer = null;
        this._since = 0;
      }
    }

    renderState() {
      const s = this.status;
      this.stateEl.className = "agent-state";
      this.stateEl.innerHTML = "";
      if (!this.agents.some((x) => x.installed)) {
        this.stateEl.classList.add("problem");
        this.stateEl.innerHTML = `${icon("alert")}<span>No AI agent is installed. For Claude Code run: npm i -g @agentclientprotocol/claude-agent-acp, then sign in to Claude Code once.</span>`;
        return;
      }
      // "Starting..." is shown inside the composer (updateContext) so nothing jumps.
      this.updateContext();
      if (s.state === "failed" || (s.state === "stopped" && s.message && this.busy)) {
        this.stateEl.classList.add("problem");
        this.stateEl.innerHTML = `${icon("alert")}<span>${esc(s.message || "The agent stopped.")}</span>`;
      }
    }

    renderChips() {
      this.chipsEl.innerHTML = "";
      // One row that scrolls sideways, so its height never changes.
      this.chipsEl.classList.toggle("off", this.busy || !this.agent());
      if (this.busy || !this.agent()) return;
      const doc = this.editor.doc;
      const empty = !doc || doc.layers.every((l) => !l.items.length);
      const sel = this.editor.selection.length;
      const set = sel ? ACTIONS.selection : empty ? ACTIONS.empty : ACTIONS.drawing;
      for (const a of set) {
        const chip = el(`<button type="button" class="chip" title="Put this in the message box">${icon(a.icon)}${esc(a.label)}</button>`);
        // Chips write the request into the box so it can be read and changed
        // before sending.
        chip.addEventListener("click", () => {
          const text = a.fill || a.prompt;
          this.input.value = text;
          this.autosize();
          this.input.focus();
          this.input.setSelectionRange(text.length, text.length);
          this.input.scrollTop = this.input.scrollHeight;
          this.renderBar();
          this.updateContext();
        });
        this.chipsEl.appendChild(chip);
      }
      this.chipsEl.scrollLeft = 0;
      requestAnimationFrame(() => this.chipFades());
      setTimeout(() => this.chipFades(), 50);
    }

    chipFades() {
      const c = this.chipsEl;
      c.classList.toggle("more-right", c.scrollLeft + c.clientWidth < c.scrollWidth - 2);
      c.classList.toggle("more-left", c.scrollLeft > 2);
    }

    renderQueued() {
      const q = this.queued;
      this.queuedEl.hidden = !q;
      this.queuedEl.innerHTML = "";
      if (!q) return;
      const row = el(`<div class="q-inner">${icon("clock")}<span class="q-label">Sends next</span><span class="q-text"></span><button type="button" class="icon-btn q-edit" title="Edit it" aria-label="Edit queued message">${icon("edit")}</button><button type="button" class="icon-btn q-x" title="Don't send it" aria-label="Cancel queued message">${icon("x")}</button></div>`);
      row.querySelector(".q-text").textContent = q;
      row.querySelector(".q-x").addEventListener("click", () => { this.queued = null; this.renderQueued(); this.updateContext(); });
      row.querySelector(".q-edit").addEventListener("click", () => {
        this.input.value = q; this.queued = null; this.autosize(); this.renderQueued(); this.renderBar(); this.input.focus();
      });
      this.queuedEl.appendChild(row);
    }

    updateContext() {
      const sel = this.editor.selection.length;
      const name = this.agent() ? this.agent().name : "the agent";
      let text = "";
      if (this.busy) text = `Working ${Math.max(0, Math.round((Date.now() - (this._since || Date.now())) / 1000))} s`;
      else if (this.status && this.status.state === "starting") text = `Starting ${name}...`;
      else if (sel) text = `${sel} selected item${sel === 1 ? "" : "s"} included`;
      else if (document.activeElement === this.input) text = "Enter sends, Shift+Enter adds a line";
      this.ctxEl.textContent = text;
      this.ctxEl.classList.toggle("sel", !this.busy && !!sel);
    }

    renderMessages() {
      const atBottom = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 40;
      this.list.innerHTML = "";
      const msgs = this.chat.messages || [];
      if (!msgs.length) {
        this.list.appendChild(el(`<div class="assistant-empty"><div class="big">${icon("sparkles")}</div><strong>Draw together</strong><span>Sketch something, then ask me to color it, shade it, clean up the lines or add a background. I can also draw from scratch.</span></div>`));
        return;
      }
      msgs.forEach((m, i) => {
        if (m.role === "user") { this.list.appendChild(el(`<div class="msg user">${esc(m.text)}</div>`)); return; }
        const took = !m.open && m.seconds ? `<span class="took">${m.seconds < 60 ? m.seconds + " s" : Math.floor(m.seconds / 60) + " min " + (m.seconds % 60) + " s"}</span>` : "";
        const node = el(`<div class="msg agent"><div class="who">${icon("sparkles")}${esc(m.agent || "Assistant")}${took}</div><div class="steps"></div><div class="body"></div></div>`);
        const steps = node.querySelector(".steps");
        const seen = new Map();
        const tools = (m.tools || []).map((t) => ({ t, lab: toolLabel(t.title) })).filter((x) => x.lab);
        // A failed step the agent then did again successfully is not shown.
        const okLabels = new Set(tools.filter((x) => x.t.status !== "failed").map((x) => x.lab[0]));
        for (const { t, lab } of tools) {
          const [label, ic] = lab;
          const failed = t.status === "failed";
          if (failed && okLabels.has(label)) continue;
          const running = t.status === "pending" || t.status === "in_progress";
          const text = failed ? `${label}: did not work` : label;
          const k = text;
          if (seen.has(k) && !running) { const s = seen.get(k); s.n++; s.el.querySelector("b").textContent = s.n > 1 ? ` x${s.n}` : ""; continue; }
          const chip = el(`<span class="step ${failed ? "failed" : running ? "running" : ""}">${icon(failed ? "alert" : ic)}${esc(text)}<b></b></span>`);
          seen.set(k, { n: 1, el: chip });
          steps.appendChild(chip);
        }
        if (!steps.children.length) steps.remove();
        node.querySelector(".body").innerHTML = richText((m.text || "").trim());
        if (m.open && !(m.text || "").trim()) node.appendChild(el('<span class="typing" aria-label="Working"><i></i><i></i><i></i></span>'));
        if (m.error) node.appendChild(el(`<div class="error">${icon("alert")}<span>${esc(m.error)}</span></div>`));
        if (m.undone) node.appendChild(el(`<div class="undone">${icon("undo")}<span>Changes undone. Ctrl+Z puts them back.</span></div>`));
        if (!m.open && m.stopReason === "cancelled") node.appendChild(el(`<div class="agent-state" style="padding:0">Stopped.</div>`));
        const isLast = i === msgs.length - 1;
        if ((isLast || m.changed) && !m.open) {
          const row = el('<div class="after-turn"></div>');
          if (this.canUndoTurn && m.changed) {
            const undo = el(`<button type="button" class="btn sm">${icon("undo")}Undo these changes</button>`);
            undo.addEventListener("click", async () => {
              try { await jdraw.call("agent:undoTurn", this.editor.id); this.canUndoTurn = false; for (const x of msgs) delete x.changed; m.undone = true; this.renderMessages(); } catch (err) { toast(err.message, { problem: true }); }
            });
            row.appendChild(undo);
          }
          if (m.error && isLast) {
            const retry = el(`<button type="button" class="btn sm">${icon("refresh")}Try again</button>`);
            retry.addEventListener("click", async () => {
              const lastUser = [...msgs].reverse().find((x) => x.role === "user");
              await jdraw.call("agent:stop", this.editor.id);
              if (lastUser) this.send(lastUser.text);
            });
            row.appendChild(retry);
          }
          if (row.children.length) node.appendChild(row);
        }
        this.list.appendChild(node);
      });
      if (atBottom || this.busy) this.list.scrollTop = this.list.scrollHeight;
    }

    pickAgent(anchor) {
      const items = [{ heading: true, label: "Agent" }];
      for (const a of this.agents) {
        items.push({
          label: a.name,
          desc: a.installed ? "Ready" : "Not installed on this computer",
          check: a.id === this.agentId,
          onClick: () => {
            if (!a.installed) { toast(`Install ${a.name} first: ${a.install}`, { problem: true, ms: 5000 }); return; }
            if (a.id === this.agentId) return;
            this.agentId = a.id;
            this.models = this.modelCache[a.id] || null;
            this.effort = this.effortCache[a.id] || null;
            this.status = { state: "idle" };
            jdraw.call("prefs:set", "agent", a.id);
            this.renderAll();
            this.warm();
          },
        });
      }
      items.push("sep", { label: "Look again for agents", icon: "refresh", onClick: async () => { const r = await jdraw.call("agents:list", true); this.agents = r.agents; if (!this.agent()) this.agentId = (this.agents.find((x) => x.installed) || {}).id || null; this.renderAll(); } });
      showMenu(anchor, items, { above: true, width: 260 });
    }

    async pickModel(anchor) {
      if (!this.agentId) return;
      if (!this.models) {
        if (this.modelsLoading) {
          showMenu(anchor, [{ heading: true, label: `Getting the model list from ${this.agent().name}. This takes a few seconds the first time.` }], { above: true });
          return;
        }
        await this.warm();
        if (!this.models || !this.models.available.length) { toast("This agent does not offer a model choice."); return; }
      }
      const pref = this.modelPrefs[this.agentId] || this.models.current;
      // Newest model of each family first; older versions in their own group.
      const ver = (m) => { const v = String(m.name).match(/(\d+(?:\.\d+)?)/); return v ? parseFloat(v[1]) : 0; };
      const fam = (m) => String(m.name).replace(/[\d.]+/g, "").replace(/\(.*\)/, "").trim().toLowerCase();
      const newest = new Map();
      for (const m of this.models.available) { const f = fam(m); if (!/default/i.test(m.name) && (!newest.has(f) || ver(m) > ver(newest.get(f)))) newest.set(f, m); }
      const isMain = (m) => /default/i.test(m.name) || m.id === pref || [...newest.values()].includes(m);
      const row = (m) => ({
        label: m.name,
        desc: m.description ? m.description.slice(0, 60) : undefined,
        check: m.id === pref,
        onClick: async () => {
          this.modelPrefs[this.agentId] = m.id;
          this.renderBar();
          try { await jdraw.call("agent:setModel", this.editor.id, this.agentId, m.id); } catch (err) { toast(err.message, { problem: true }); }
        },
      });
      const main = this.models.available.filter(isMain), older = this.models.available.filter((m) => !isMain(m));
      const items = [{ heading: true, label: `${this.agent().name} model` }, ...main.map(row)];
      if (older.length) items.push("sep", { heading: true, label: "Older models" }, ...older.map((m) => ({ ...row(m), desc: undefined })));
      showMenu(anchor, items, { above: true, width: 260 });
    }

    pickEffort(anchor) {
      if (!this.effort) {
        if (this.modelsLoading) showMenu(anchor, [{ heading: true, label: "Getting the effort levels from the agent..." }], { above: true });
        return;
      }
      const pref = this.effortPrefs[this.agentId] || this.effort.current;
      const help = { low: "Fastest, least careful", medium: "Balanced", high: "More careful drawing", xhigh: "Very careful, slower", max: "Most careful, slowest", default: "The model's own default" };
      showMenu(anchor, [{ heading: true, label: "Effort" }, ...this.effort.available.map((o) => ({
        label: effortName(o),
        desc: o.description || help[o.id],
        check: o.id === pref,
        onClick: async () => {
          this.effortPrefs[this.agentId] = o.id;
          this.renderBar();
          try { await jdraw.call("agent:setEffort", this.editor.id, this.agentId, o.id); } catch (err) { toast(err.message, { problem: true }); }
        },
      }))], { above: true, width: 260 });
    }

    // ---------- / commands
    // JDraw skills first (styles and craft), then the agent's own commands.
    slashItems() {
      const items = this.skills.map((sk) => ({ name: sk.id, title: sk.title, desc: sk.description, group: sk.kind === "style" ? "JDraw styles" : "JDraw skills", skill: sk }));
      const a = this.agent();
      for (const c of this.commandCache[this.agentId] || []) {
        if (items.some((i) => i.name === c.name)) continue;
        items.push({ name: c.name, title: "/" + c.name, desc: c.description, hint: c.hint, group: `${a ? a.name : "Agent"} commands`, command: c });
      }
      return items;
    }

    parseSlash(text) {
      const m = /^\/(\S+)\s*([\s\S]*)$/.exec(text);
      if (!m) return null;
      const name = m[1].toLowerCase();
      const item = this.slashItems().find((i) => i.name.toLowerCase() === name);
      return item ? Object.assign({ rest: m[2].trim() }, item) : null;
    }

    skillPrompt(sk, rest) {
      const ask = rest || (sk.kind === "style" ? "Apply this style to my drawing." : "Do this on my drawing.");
      const how = sk.kind === "style"
        ? `Use the ${sk.title} style. Call get_style with id ${sk.id} and follow its palette and steps.`
        : `Use the JDraw skill "${sk.title}". Call get_style with id ${sk.id} and follow it.`;
      return `${how}\n\n${ask}`;
    }

    updateSlash() {
      const m = /^\/(\S*)$/.exec(this.input.value);
      if (!m) { this.closeSlash(); return; }
      const q = m[1].toLowerCase();
      const list = this.slashItems().filter((i) => i.name.toLowerCase().includes(q) || i.title.toLowerCase().includes(q));
      if (q) list.sort((a, b) => (b.name.toLowerCase().startsWith(q) ? 1 : 0) - (a.name.toLowerCase().startsWith(q) ? 1 : 0));
      const prev = this.slash && this.slash.list[this.slash.index];
      this.slash = { list, index: Math.max(0, list.indexOf(prev)) };
      this.renderSlash();
    }

    renderSlash() {
      const { list, index } = this.slash;
      const box = this.slashEl;
      box.innerHTML = "";
      if (!list.length) box.appendChild(el(`<div class="label">${this.skills.length ? "No command matches." : "Loading skills..."}</div>`));
      let group = null;
      list.forEach((it, i) => {
        if (it.group !== group) { group = it.group; box.appendChild(el(`<div class="label">${esc(group)}</div>`)); }
        const b = el(`<button type="button" role="option" class="${i === index ? "active" : ""}"><span class="txt"><span class="cmd">/${esc(it.name)}</span>${it.skill ? `<span class="ttl">${esc(it.title)}</span>` : ""}${it.desc ? `<span class="desc">${esc(it.desc)}</span>` : ""}</span></button>`);
        b.addEventListener("click", () => this.pickSlash(i));
        box.appendChild(b);
      });
      box.hidden = false;
      const act = box.querySelector("button.active");
      if (act) act.scrollIntoView({ block: "nearest" });
    }

    slashKey(e) {
      const s = this.slash;
      if (e.key === "Escape") { e.preventDefault(); this.closeSlash(); return true; }
      if (!s.list.length) return false;
      if (e.key === "ArrowDown") { e.preventDefault(); s.index = (s.index + 1) % s.list.length; this.renderSlash(); return true; }
      if (e.key === "ArrowUp") { e.preventDefault(); s.index = (s.index - 1 + s.list.length) % s.list.length; this.renderSlash(); return true; }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) { e.preventDefault(); this.pickSlash(s.index); return true; }
      return false;
    }

    pickSlash(i) {
      const it = this.slash && this.slash.list[i];
      if (!it) return;
      this.input.value = "/" + it.name + " ";
      this.closeSlash();
      this.autosize();
      this.renderBar();
      this.input.focus();
      this.input.setSelectionRange(this.input.value.length, this.input.value.length);
    }

    closeSlash() {
      this.slash = null;
      if (this.slashEl) { this.slashEl.hidden = true; this.slashEl.innerHTML = ""; }
    }

    async send(text, display) {
      let t = (text ?? this.input.value).trim();
      if (!t || this.busy) return;
      if (!this.agentId) { toast("Install an agent first.", { problem: true }); return; }
      if (text === undefined) { this.input.value = ""; this.autosize(); this.closeSlash(); }
      let agentCommand = false;
      const cmd = this.parseSlash(t);
      if (cmd && cmd.skill) { display = display || t; t = this.skillPrompt(cmd.skill, cmd.rest); }
      else if (cmd && cmd.command) agentCommand = true;
      this.busy = true;
      this.renderBar();
      this.renderChips();
      try {
        await jdraw.call("agent:prompt", this.editor.id, {
          agentId: this.agentId,
          model: this.modelPrefs[this.agentId] || null,
          effort: (this.effort && this.effortPrefs[this.agentId]) || null,
          text: t,
          agentCommand,
          display: display ? `${display}` : undefined,
          context: this.editor.contextString(),
        });
      } catch (err) {
        this.busy = false;
        this.renderBar();
        this.renderChips();
        toast(err.message, { problem: true, ms: 6000 });
      }
    }

    // Holds the typed message until the running turn ends, then sends it.
    queue() {
      const t = this.input.value.trim();
      if (!t) return;
      this.queued = this.queued ? this.queued + "\n" + t : t;
      this.input.value = "";
      this.autosize();
      this.renderBar();
      this.renderQueued();
      this.updateContext();
    }

    async cancel() {
      try { await jdraw.call("agent:cancel", this.editor.id); } catch {}
    }

    async clear() {
      if ((this.chat.messages || []).length) {
        const ok = await UI.openDialog({
          title: "Start a new chat?",
          body: "The conversation is cleared. Your drawing stays as it is.",
          buttons: [{ label: "Cancel", value: false }, { label: "New chat", value: true, primary: true }],
        });
        if (!ok) return;
      }
      if (this.busy) await this.cancel();
      this.queued = null;
      this.renderQueued();
      await jdraw.call("chat:clear", this.editor.id);
      this.chat = { agent: this.agentId, messages: [] };
      this.busy = false;
      this.canUndoTurn = false;
      this.models = this.modelCache[this.agentId] || null;
      this.effort = this.effortCache[this.agentId] || null;
      this.status = { state: "idle" };
      this.renderAll();
      this.warm();
    }

    // Events from the main process for this drawing.
    onEvent(ev) {
      const msgs = this.chat.messages || (this.chat.messages = []);
      const last = msgs[msgs.length - 1];
      const open = last && last.role === "agent" && last.open ? last : null;
      switch (ev.type) {
        case "chat":
          this.chat = ev.chat;
          this.busy = true;
          this.canUndoTurn = true;
          this.renderAll();
          this.editor.setBusy(true, this.agent() ? this.agent().name : "Assistant");
          return;
        case "text":
          if (open) {
            if (open.gap && open.text.trim()) open.text = open.text.trimEnd() + "\n\n";
            open.gap = false;
            open.text += ev.text;
          }
          break;
        case "tool":
          if (open) {
            open.gap = true;
            const t = open.tools.find((x) => x.id === ev.id);
            if (t) { if (ev.title) t.title = ev.title; if (ev.status) t.status = ev.status; }
            else open.tools.push({ id: ev.id, title: ev.title || "Tool", status: ev.status || "pending" });
          }
          break;
        case "commands":
          if (this.agentId) this.commandCache[this.agentId] = ev.commands || [];
          if (this.slash) this.updateSlash();
          return;
        case "status":
          if (ev.commands && ev.commands.length && this.agentId) this.commandCache[this.agentId] = ev.commands;
          this.status = ev;
          if (ev.models) this.models = ev.models;
          if (ev.state === "ready" && ev.models) { this.effort = ev.effort || null; this.effortCache[this.agentId] = this.effort; }
          this.renderBar();
          this.renderState();
          return;
        case "gate":
          // JDraw's slop check and reviewer run between agent turns.
          this.busy = true;
          this.editor.setBusy(true, ev.label || "The slop check");
          return;
        case "done":
        case "error":
          if (open) { open.open = false; open.stopReason = ev.stopReason; if (ev.type === "error") open.error = ev.message; }
          if (ev.gating && ev.type === "done") {
            // The check runs next; the turn ends with turn-end.
            this.editor.setBusy(true, "The slop check");
            this.renderAll();
            return;
          }
          this.busy = false;
          this.editor.setBusy(false);
          this.renderAll();
          // Show the end of the reply and its Undo button.
          this.list.scrollTop = this.list.scrollHeight;
          this.editor.afterAgentTurn(ev);
          if (this.queued) {
            const q = this.queued;
            this.queued = null;
            this.renderQueued();
            if (ev.type === "done" && ev.stopReason !== "cancelled") setTimeout(() => this.send(q), 300);
            else { this.input.value = q; this.autosize(); this.renderBar(); }
          }
          return;
        case "turn-end": {
          const lastAgent = [...msgs].reverse().find((m) => m.role === "agent");
          if (lastAgent) { lastAgent.seconds = ev.seconds; if (ev.changed) { for (const m of msgs) delete m.changed; lastAgent.changed = true; } }
          this.canUndoTurn = !!ev.canUndoTurn;
          if (ev.check) this.chat.check = ev.check;
          if (this.busy) {
            // A gated turn: finish it here instead of at "done".
            this.onEvent({ type: "done", stopReason: "end_turn" });
            return;
          }
          this.renderMessages();
          this.list.scrollTop = this.list.scrollHeight;
          return;
        }
        default:
          return;
      }
      clearTimeout(this._t);
      this._t = setTimeout(() => this.renderMessages(), 40);
    }
  }

  window.Assistant = Assistant;
})();
