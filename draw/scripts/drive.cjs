#!/usr/bin/env node
// Command line for drive mode (see lib/drive.cjs).
//   node scripts/drive.cjs shot <name>
//   node scripts/drive.cjs click <x> <y> [right] [2]
//   node scripts/drive.cjs move <x> <y>
//   node scripts/drive.cjs drag <x1> <y1> <x2> <y2> [right]
//   node scripts/drive.cjs wheel <x> <y> <dy>
//   node scripts/drive.cjs type "<text>"        (\n presses Enter)
//   node scripts/drive.cjs key <Key> [control|shift|alt ...]
// Each action except shot also takes a screenshot afterwards and prints its path.
// Needs JDRAW_DRIVE_URL (http://127.0.0.1:port) and JDRAW_DRIVE_TOKEN.

const url = process.env.JDRAW_DRIVE_URL;
const token = process.env.JDRAW_DRIVE_TOKEN;
if (!url || !token) { console.error("Set JDRAW_DRIVE_URL and JDRAW_DRIVE_TOKEN"); process.exit(2); }

async function call(p, body) {
  const res = await fetch(url + p, { method: body ? "POST" : "GET", headers: { "x-drive-token": token, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const out = await res.json();
  if (!res.ok) throw new Error(out.error || res.status);
  return out;
}

(async () => {
  const [cmd, ...a] = process.argv.slice(2);
  const num = (i) => Number(a[i]);
  switch (cmd) {
    case "shot": break;
    case "click": await call("/click", { x: num(0), y: num(1), button: a.includes("right") ? "right" : "left", count: a.includes("2") && a.indexOf("2") > 1 ? 2 : 1 }); break;
    case "move": await call("/move", { x: num(0), y: num(1) }); break;
    case "drag": await call("/drag", { from: [num(0), num(1)], to: [num(2), num(3)], button: a.includes("right") ? "right" : "left" }); break;
    case "wheel": await call("/wheel", { x: num(0), y: num(1), dy: num(2) }); break;
    case "type": await call("/type", { text: (a[0] || "").replace(/\\n/g, "\n") }); break;
    case "key": await call("/key", { key: a[0], mods: a.slice(1) }); break;
    case "info": console.log(JSON.stringify(await call("/info"))); return;
    default: console.error("unknown command " + cmd); process.exit(2);
  }
  const name = cmd === "shot" ? (a[0] || "shot") : `${cmd}-${a.join("_")}`.slice(0, 40);
  const s = await call("/shot?name=" + encodeURIComponent(name));
  console.log(s.path);
})().catch((e) => { console.error(e.message); process.exit(1); });
