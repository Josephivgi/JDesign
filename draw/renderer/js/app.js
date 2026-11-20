(function () {
  const EMBEDDED = /[?&]embedded=1/.test(location.search);
  const root = document.getElementById("app");
  const app = {
    editor: null,
    embedded: EMBEDDED,
    idle() {
      // Embedded mode sits inside JV's project editor as a stage area: no
      // Home screen, it waits for JV to send a drawing.
      if (!EMBEDDED) return;
      root.innerHTML = '<div class="embed-idle"></div>';
    },
    async goHome() {
      if (EMBEDDED) return this.idle();
      if (this.editor) { this.editor.unmount(); this.editor = null; }
      await Home.render(root, this);
    },
    async openDrawing(id, chatId) {
      if (this.editor) {
        if (this.editor.id === id) { if (chatId) await jdraw.call("chat:open", id, chatId).catch(() => {}); return this.editor; }
        this.editor.unmount();
        this.editor = null;
      }
      // A chat id comes from a history list: the drawing opens on that chat.
      if (chatId) await jdraw.call("chat:open", id, chatId).catch(() => {});
      const ed = new Editor(root, this, id);
      this.editor = ed;
      try {
        await ed.mount();
      } catch (err) {
        console.error(err);
        UI.toast(err.message, { problem: true });
        this.editor = null;
        await this.goHome();
      }
      return ed;
    },
  };
  window.App = app;
  // JV's Home history can send a chat here: open its drawing on that chat.
  jdraw.on("open:chat", (msg) => {
    if (msg && msg.drawingId) app.ready.then(() => app.openDrawing(msg.drawingId, msg.chatId));
  });
  // JV's project editor places the view on a drawing tab: open that drawing.
  jdraw.on("doc:open", (msg) => {
    if (msg && msg.id) app.ready.then(() => app.openDrawing(msg.id));
  });

  app.ready = (async () => {
    const theme = await jdraw.call("prefs:get", "theme", "system").catch(() => "system");
    UI.applyAccent(await jdraw.call("prefs:get", "accent", "mono").catch(() => "mono"));
    await UI.applyTheme(theme);
    const smoke = await jdraw.call("smoke:config").catch(() => null);
    // Video's Settings > Appearance owns the theme and the accent for both studios.
    jdraw.on("theme:set", ({ mode, accent }) => { if (accent) UI.applyAccent(accent); UI.applyTheme(mode); });
    await app.goHome();
    if (smoke) Smoke.run(app, smoke);
  })();

  window.addEventListener("error", (e) => console.error("[error]", e.message, e.filename + ":" + e.lineno));
  window.addEventListener("unhandledrejection", (e) => console.error("[rejection]", e.reason && (e.reason.stack || e.reason.message || e.reason)));
})();
