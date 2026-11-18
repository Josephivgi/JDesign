// Drive mode (`electron . --drive`): the window renders offscreen, so it never
// appears on the desktop, but it paints real frames (animations, transitions).
// A small local HTTP server lets a tester take screenshots and send real mouse
// and keyboard input to the page by pixel position.
//
//   GET  /shot?name=x          -> { path, width, height }  PNG of the latest frame
//   POST /click {x,y,button?,count?}
//   POST /move  {x,y}
//   POST /drag  {from:[x,y], to:[x,y], steps?, button?}
//   POST /wheel {x,y,dy}
//   POST /type  {text}          types text (\n presses Enter)
//   POST /key   {key, mods?}    e.g. {key:"Enter"} {key:"z", mods:["control"]}
//   GET  /info                  window size
// Every request needs header `x-drive-token` (printed in the log line).

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function startDrive({ getWin, dir, port, log }) {
  const token = process.env.JDRAW_DRIVE_TOKEN || crypto.randomBytes(12).toString("hex");
  fs.mkdirSync(dir, { recursive: true });
  let n = 0;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const wc = () => {
    const w = getWin();
    if (!w || w.isDestroyed()) throw new Error("window not ready");
    return w.webContents;
  };
  // The offscreen window never has OS focus, so focus rings and the text caret
  // never painted and screenshots missed what a real window shows. Make the
  // page behave as focused, like the window a person clicks in.
  let focusSet = false;
  const ensureFocus = async () => {
    if (focusSet) return;
    const d = wc().debugger;
    if (!d.isAttached()) d.attach("1.3");
    await d.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
    wc().focus();
    focusSet = true;
  };
  const mouse = (type, x, y, extra = {}) => wc().sendInputEvent({ type, x: Math.round(x), y: Math.round(y), ...extra });

  async function click({ x, y, button = "left", count = 1 }) {
    mouse("mouseMove", x, y);
    await wait(30);
    for (let i = 1; i <= count; i++) {
      mouse("mouseDown", x, y, { button, clickCount: i });
      await wait(40);
      mouse("mouseUp", x, y, { button, clickCount: i });
      await wait(60);
    }
  }
  async function drag({ from, to, steps = 16, button = "left" }) {
    mouse("mouseMove", from[0], from[1]);
    await wait(30);
    mouse("mouseDown", from[0], from[1], { button, clickCount: 1 });
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      mouse("mouseMove", from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, { button });
      await wait(16);
    }
    mouse("mouseUp", to[0], to[1], { button, clickCount: 1 });
  }
  function keyName(k) {
    const map = { enter: "Enter", return: "Enter", esc: "Escape", escape: "Escape", tab: "Tab", backspace: "Backspace", delete: "Delete", space: "Space", up: "Up", down: "Down", left: "Left", right: "Right", home: "Home", end: "End" };
    return map[String(k).toLowerCase()] || k;
  }
  async function key({ key, mods = [] }) {
    const keyCode = keyName(key);
    wc().sendInputEvent({ type: "keyDown", keyCode, modifiers: mods });
    const plain = !mods.some((m) => /control|ctrl|meta|alt/i.test(m));
    // Chromium inserts text (and newlines) from the char event, like a real keyboard.
    if (plain && keyCode.length === 1) wc().sendInputEvent({ type: "char", keyCode, modifiers: mods });
    if (plain && keyCode === "Enter") wc().sendInputEvent({ type: "char", keyCode: "\r", modifiers: mods });
    await wait(20);
    wc().sendInputEvent({ type: "keyUp", keyCode, modifiers: mods });
    await wait(30);
  }
  async function type({ text }) {
    for (const part of String(text).split(/(\n)/)) {
      if (part === "\n") await key({ key: "Enter" });
      else if (part) { await wc().insertText(part); await wait(30); }
    }
  }
  async function shot(name) {
    const w = getWin();
    // Let a frame or two paint after the last input.
    await wait(250);
    const img = await w.webContents.capturePage();
    const file = path.join(dir, `${String(++n).padStart(3, "0")}-${(name || "shot").replace(/[^\w.-]+/g, "_")}.png`);
    fs.writeFileSync(file, img.toPNG());
    const s = img.getSize();
    return { path: file, width: s.width, height: s.height };
  }

  const server = http.createServer(async (req, res) => {
    const reply = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.headers["x-drive-token"] !== token) return reply(401, { error: "bad token" });
    let body = "";
    req.on("data", (c) => (body += c));
    await new Promise((r) => req.on("end", r));
    let args = {};
    try { args = body ? JSON.parse(body) : {}; } catch { return reply(400, { error: "bad json" }); }
    const url = new URL(req.url, "http://x");
    try {
      await ensureFocus();
      switch (url.pathname) {
        case "/shot": return reply(200, await shot(url.searchParams.get("name") || args.name));
        case "/click": await click(args); break;
        case "/move": mouse("mouseMove", args.x, args.y); break;
        case "/drag": await drag(args); break;
        case "/wheel": mouse("mouseWheel", args.x, args.y, { deltaX: 0, deltaY: -(args.dy || 0), canScroll: true }); break;
        case "/type": await type(args); break;
        case "/key": await key(args); break;
        case "/info": { const b = getWin().getContentBounds(); return reply(200, { width: b.width, height: b.height }); }
        default: return reply(404, { error: "unknown path" });
      }
      reply(200, { ok: true });
    } catch (err) {
      reply(500, { error: err.message });
    }
  });
  server.listen(port || 0, "127.0.0.1", () => {
    log(`drive http://127.0.0.1:${server.address().port} token=${token} shots=${dir}`);
  });
  return server;
}

module.exports = { startDrive };
