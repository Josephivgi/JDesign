(function () {
  const root = document.getElementById("app");
  const app = {
    editor: null,
    async goHome() {
      if (this.editor) { this.editor.unmount(); this.editor = null; }
      await Home.render(root, this);
    },
    async openDrawing(id) {
      if (this.editor) { this.editor.unmount(); this.editor = null; }
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

  app.ready = (async () => {
    const theme = await jdraw.call("prefs:get", "theme", "system").catch(() => "system");
    await UI.applyTheme(theme);
    const smoke = await jdraw.call("smoke:config").catch(() => null);
    jdraw.on("theme:set", ({ mode }) => UI.applyTheme(mode));
    await app.goHome();
    if (smoke) Smoke.run(app, smoke);
  })();

  window.addEventListener("error", (e) => console.error("[error]", e.message, e.filename + ":" + e.lineno));
  window.addEventListener("unhandledrejection", (e) => console.error("[rejection]", e.reason && (e.reason.stack || e.reason.message || e.reason)));
})();
