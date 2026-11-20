// Home: start a drawing at a size, or open one from the gallery.
(function () {
  const { el, esc, showMenu, openDialog, toast, timeAgo } = UI;

  const SIZES = [
    { t: "Square", d: "1600 x 1600", w: 1600, h: 1600 },
    { t: "Landscape", d: "1920 x 1080", w: 1920, h: 1080 },
    { t: "Portrait", d: "1200 x 1600", w: 1200, h: 1600 },
    { t: "Phone", d: "1080 x 1920", w: 1080, h: 1920 },
    { t: "Sketch page", d: "2480 x 1754", w: 2480, h: 1754 },
  ];

  async function render(root, app) {
    root.innerHTML = "";
    // No top bar here: the Video rail beside this view already has the JD
    // logo and the Video Editor / Drawing switch. The page starts with its
    // title, like Library and Agents, and keeps the theme and settings
    // controls at the right of the title.
    const home = el(`<main class="home"><div class="home-inner">
      <header class="home-head">
        <div class="titles">
          <h1>What are you drawing today?</h1>
          <p class="lede">Sketch it yourself, then ask the assistant to color, shade or finish it with you.</p>
          <p class="ai-line"></p>
        </div>
        <div class="tools">
          <div class="seg" role="group" aria-label="Theme">
            <button type="button" data-mode="light" title="Light" aria-label="Light theme">${icon("sun")}</button>
            <button type="button" data-mode="dark" title="Dark" aria-label="Dark theme">${icon("moon")}</button>
            <button type="button" data-mode="system" title="Match Windows" aria-label="Match the Windows theme">${icon("monitor")}</button>
          </div>
          <button type="button" class="icon-btn settings-btn" title="Draw settings" aria-label="Draw settings">${icon("sliders")}</button>
        </div>
      </header>
      <div class="section-head"><h2>New drawing</h2><span class="hint">Pick a paper size</span></div>
      <div class="sizes"></div>
      <div class="section-head"><h2>Your drawings</h2><span class="count"></span><input class="input search" type="search" placeholder="Search drawings" aria-label="Search drawings"></div>
      <div class="gallery-wrap"></div>
    </div></main>`);
    const mode = document.documentElement.dataset.mode || "system";
    const themeBtns = [...home.querySelectorAll('.seg[aria-label="Theme"] button')];
    themeBtns.forEach((b) => {
      b.classList.toggle("on", b.dataset.mode === mode);
      b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
      b.addEventListener("click", async () => {
        await jdraw.call("prefs:set", "theme", b.dataset.mode);
        await jdraw.call("studio:theme", b.dataset.mode);
        await UI.applyTheme(b.dataset.mode);
        themeBtns.forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-pressed", String(x === b)); });
      });
    });
    home.querySelector(".settings-btn").addEventListener("click", () => openSettings());
    root.appendChild(home);

    const sizes = home.querySelector(".sizes");
    for (const s of SIZES) {
      const ratio = s.w / s.h;
      const bw = ratio >= 1 ? 76 : Math.round(68 * ratio);
      const bh = ratio >= 1 ? Math.round(76 / ratio) : 68;
      const card = el(`<button type="button" class="size-card"><div class="shape-box"><div class="shape" style="width:${bw}px;height:${bh}px"></div></div><div class="cap"><span class="t">${esc(s.t)}</span><span class="d">${esc(s.d)}</span></div></button>`);
      card.addEventListener("click", () => create(app, { width: s.w, height: s.h, name: `${s.t} drawing` }));
      sizes.appendChild(card);
    }
    const custom = el(`<button type="button" class="size-card"><div class="shape-box"><div class="shape custom" style="width:56px;height:56px">${icon("plus")}</div></div><div class="cap"><span class="t">Custom size</span><span class="d">Up to 8192 px</span></div></button>`);
    custom.addEventListener("click", () => customSize(app));
    sizes.appendChild(custom);

    let list = [];
    try { list = await jdraw.call("drawings:list"); } catch (err) { toast(err.message, { problem: true }); }
    const wrap = home.querySelector(".gallery-wrap");
    const count = home.querySelector(".count");
    const search = home.querySelector(".search");
    const draw = () => {
      const q = search.value.trim().toLowerCase();
      const shown = q ? list.filter((d) => d.name.toLowerCase().includes(q)) : list;
      count.textContent = list.length ? String(list.length) : "";
      wrap.innerHTML = "";
      if (!list.length) {
        wrap.appendChild(el(`<div class="empty">${icon("image")}<strong>No drawings yet</strong><span>Pick a paper size above to start your first one.</span></div>`));
        search.style.display = "none";
        return;
      }
      search.style.display = "";
      if (!shown.length) { wrap.appendChild(el(`<div class="empty"><strong>No drawing matches "${esc(q)}"</strong><span>Try a shorter search.</span></div>`)); return; }
      const grid = el('<div class="gallery"></div>');
      for (const d of shown) {
        const card = el(`<div class="art-card" tabindex="0" role="button" aria-label="Open ${esc(d.name)}">
          <div class="thumb">${d.thumb ? `<img alt="" src="${d.thumb}">` : icon("image")}</div>
          <div class="meta"><span class="n">${esc(d.name)}</span><span class="w">${esc(timeAgo(d.updated))}</span></div>
          <button type="button" class="icon-btn more" aria-label="More for ${esc(d.name)}">${icon("more")}</button>
        </div>`);
        card.addEventListener("click", () => app.openDrawing(d.id));
        card.addEventListener("keydown", (e) => {
          if ((e.key === "Enter" || e.key === " ") && e.target === card) {
            e.preventDefault();
            if (!e.repeat) app.openDrawing(d.id);
          }
        });
        const more = card.querySelector(".more");
        more.addEventListener("click", (e) => {
          e.stopPropagation();
          showMenu(more, [
            { label: "Open", icon: "edit", onClick: () => app.openDrawing(d.id) },
            { label: "Rename", icon: "text", onClick: () => rename(d, () => render(root, app)) },
            { label: "Duplicate", icon: "copy", onClick: async () => { await jdraw.call("drawings:duplicate", d.id); render(root, app); } },
            "sep",
            { label: "Delete", icon: "trash", danger: true, onClick: () => remove(d, () => render(root, app)) },
          ], { align: "right" });
        });
        grid.appendChild(card);
      }
      wrap.appendChild(grid);
    };
    search.addEventListener("input", draw);
    draw();

    const line = home.querySelector(".ai-line");
    try {
      const { agents } = await jdraw.call("agents:list");
      const ready = agents.filter((a) => a.installed);
      if (ready.length) line.textContent = `Assistant ready with ${ready.map((a) => a.name).join(", ")}.`;
      else {
        line.classList.add("problem");
        line.innerHTML = `${icon("alert")}<span>No AI agent found on this PC. Install Claude Code for the assistant: npm i -g @agentclientprotocol/claude-agent-acp</span>`;
      }
    } catch {}
  }

  // Settings: read-only list of the skills agents use when they draw.
  async function openSettings() {
    let skills = [];
    let failed = "";
    try { skills = await jdraw.call("skills:list"); } catch (err) { failed = err.message; }
    const body = el('<div class="settings"></div>');
    const sec = el(`<section class="set-sec"><h3>Skills</h3><p class="set-note">Agents read these before they draw. Style skills give a general look. Craft skills cover quality and writing. To use one, type / and its name in the assistant chat. Skills are read-only here.</p></section>`);
    if (failed) sec.appendChild(el(`<p class="set-note problem">${esc(failed)}</p>`));
    const groups = [["Styles", skills.filter((s) => s.kind === "style")], ["Craft", skills.filter((s) => s.kind !== "style")]];
    for (const [name, list] of groups) {
      if (!list.length) continue;
      sec.appendChild(el(`<h4 class="set-group">${esc(name)} <span class="count">${list.length}</span></h4>`));
      const ul = el('<ul class="skill-list"></ul>');
      for (const s of list) {
        ul.appendChild(el(`<li class="skill" data-skill="${esc(s.id)}"><div class="skill-t"><span>${esc(s.title)}</span><span class="skill-cmd">/${esc(s.id)}</span></div><div class="skill-d">${esc(s.description)}</div></li>`));
      }
      sec.appendChild(ul);
    }
    body.appendChild(sec);
    // Nothing to confirm in a read-only list, so Close is a plain button.
    return openDialog({ title: "Draw settings", body, buttons: [{ label: "Close", value: true }], onOpen: (s) => s.querySelector(".dialog").classList.add("wide") });
  }

  async function create(app, opts) {
    try {
      const d = await jdraw.call("drawings:create", opts);
      app.openDrawing(d.id);
    } catch (err) { toast(err.message, { problem: true }); }
  }

  async function customSize(app) {
    const body = el(`<div><div class="grid2"><div><label for="cw">Width</label><input id="cw" class="input" type="number" min="64" max="8192" value="1600" style="width:100%"></div><div><label for="ch">Height</label><input id="ch" class="input" type="number" min="64" max="8192" value="1200" style="width:100%"></div></div><p class="field-help">In pixels, 64 to 8192.</p></div>`);
    const v = await openDialog({
      title: "Custom size",
      body,
      buttons: [
        { label: "Cancel", value: null },
        { label: "Create", primary: true, value: (s) => ({ width: Number(s.querySelector("#cw").value), height: Number(s.querySelector("#ch").value) }) },
      ],
    });
    if (v && v.width >= 64 && v.height >= 64) create(app, { width: Math.min(8192, v.width), height: Math.min(8192, v.height), name: "Untitled drawing" });
  }

  async function rename(d, after) {
    const body = el(`<div><input class="input" style="width:100%" value="${esc(d.name)}" aria-label="Name"></div>`);
    const v = await openDialog({ title: "Rename drawing", body, buttons: [{ label: "Cancel", value: null }, { label: "Rename", primary: true, value: (s) => s.querySelector("input").value }] });
    if (v != null) { await jdraw.call("drawings:rename", d.id, v); after(); }
  }

  async function remove(d, after) {
    const v = await openDialog({ title: "Delete this drawing?", body: `<p>"${esc(d.name)}" and its chat will be removed for good.</p>`, buttons: [{ label: "Cancel", value: null }, { label: "Delete", primary: true, danger: true, value: true }] });
    if (v) { await jdraw.call("drawings:remove", d.id); toast("Drawing deleted"); after(); }
  }

  window.Home = { render, openSettings };
})();
