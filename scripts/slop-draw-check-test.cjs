#!/usr/bin/env node
"use strict";

// Checks draw/checker/slop_check.py on scenes it can be sure about:
//   node scripts/slop-draw-check-test.cjs
// Each fixture is a small drawing: the SVG items an agent would have placed
// plus a render built with Pillow. The checker has to call a floating object
// that the frame crops on the side (a pier deck over water) and stay quiet
// on cropped objects that keep their own paint below, held objects, and
// busy regions. Prints PASS or FAIL per case and exits 1 on any failure.
// Every child process is hidden and nothing is written to disk.

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SCRIPT = path.join(__dirname, "..", "draw", "checker", "slop_check.py");
const PY = process.env.JDRAW_PYTHON || (process.platform === "win32" ? "python" : "python3");
const W = 1200;
const H = 800;

let failed = 0;
let passed = 0;

function report(ok, name, detail) {
  if (ok) passed += 1;
  else failed += 1;
  console.log((ok ? "PASS " : "FAIL ") + name + (detail ? "  " + detail : ""));
}

const rules = (result) => (result.issues || []).map((i) => i.rule);

// A render of flat color regions: { bg, rects: [[x0, y0, x1, y1, hex], ...] }.
function renderPng(spec) {
  const code = [
    "import sys,json,base64,io",
    "from PIL import Image,ImageDraw",
    "d=json.load(sys.stdin)",
    "im=Image.new('RGB',(d['w'],d['h']),d['bg'])",
    "dr=ImageDraw.Draw(im)",
    "[dr.rectangle([r[0],r[1],r[2],r[3]],fill=r[4]) for r in d['rects']]",
    "b=io.BytesIO();im.save(b,'PNG')",
    "sys.stdout.write(base64.b64encode(b.getvalue()).decode())",
  ].join(";");
  const out = spawnSync(PY, ["-c", code], { input: JSON.stringify(spec), encoding: "utf8", windowsHide: true });
  if (out.status !== 0) throw new Error("Pillow could not render a fixture: " + String(out.stderr || "").trim());
  return out.stdout.trim();
}

function checkDrawing(input) {
  const out = spawnSync(PY, [SCRIPT], { input: JSON.stringify(input), encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (out.status !== 0) throw new Error("slop_check.py failed: " + String(out.stderr || out.error || "").trim());
  try {
    return JSON.parse(out.stdout);
  } catch {
    throw new Error("slop_check.py printed no JSON: " + String(out.stdout || "").slice(0, 200));
  }
}

// One placed item per name, drawn in canvas coordinates (viewBox = canvas).
const item = (name, body) => ({ svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '">' + body + "</svg>", x: 0, y: 0, w: W, h: H, name });
const rect = (x, y, w, h, fill) => '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" fill="' + fill + '"/>';
const SKY = "#b8ccd8";
const SEA = "#3f6d8e";
const PIER = "#8a7a68";

const skyItem = item("sky", rect(0, 0, W, H, SKY));
const skySpec = { w: W, h: H, bg: SKY, rects: [] };

function scene(name, items, rects, ask) {
  const spec = Object.assign({}, skySpec, { rects: skySpec.rects.concat(rects) });
  return {
    name,
    input: { width: W, height: H, png: renderPng(spec), svgs: [skyItem].concat(items), ask: ask || "a harbour with a pier" },
  };
}

const CASES = [
  // A pier deck flush with the left edge, hanging above the water with a
  // clear gap. The render shows sky under the deck, so the cropped edge does
  // not hide the tell.
  scene("pier floats over a sky gap at the left edge", [
    item("sea", rect(0, 560, W, 240, SEA)),
    item("pier", rect(0, 500, 420, 40, PIER)),
  ], [
    [0, 560, W, H, SEA],
    [0, 500, 420, 540, PIER],
  ]),
  // The same deck 10 px over the waterline: the paint under its base is the
  // sea itself.
  scene("pier floats just over the water at the left edge", [
    item("sea", rect(0, 550, W, 250, SEA)),
    item("pier", rect(0, 500, 420, 40, PIER)),
  ], [
    [0, 550, W, H, SEA],
    [0, 500, 420, 540, PIER],
  ]),
  // A house hanging mid canvas touches no edge: the plain floating path.
  scene("house floats mid canvas over the sea", [
    item("sea", rect(0, 580, W, 220, SEA)),
    item("house", rect(500, 400, 200, 140, "#7a5a48")),
  ], [
    [0, 580, W, H, SEA],
    [500, 400, 700, 540, "#7a5a48"],
  ]),
];

const CLEAN = [
  // The pier's base reaches into the sea: it is held, cropped edge or not.
  scene("pier deck reaches into the water at the right edge", [
    item("sea", rect(0, 580, W, 220, SEA)),
    item("pier", rect(780, 500, 420, 120, PIER)),
  ], [
    [0, 580, W, H, SEA],
    [780, 500, W, 620, PIER],
  ]),
  // A rock face cropped at the left edge keeps its own paint right under the
  // drawn item's base: the mass runs on downward, nothing floats.
  scene("rock face keeps its own paint under the drawn base", [
    item("sea", rect(0, 600, W, 200, SEA)),
    item("rock", rect(0, 260, 300, 240, "#8a7a64")),
  ], [
    [0, 260, 300, 600, "#8a7a64"],
    [0, 600, W, H, SEA],
  ]),
  // Under the deck the picture is half water, half a sand spit: no single
  // region to judge, so the cropped edge stays unflagged.
  scene("pier over a split region is not judged", [
    item("sea", rect(0, 580, W, 220, SEA)),
    item("pier", rect(0, 500, 420, 40, PIER)),
  ], [
    [0, 580, W, H, SEA],
    [200, 540, 420, 620, "#c9b98a"],
    [0, 500, 420, 540, PIER],
  ]),
];

(async () => {
  for (const c of CASES) {
    const r = checkDrawing(c.input);
    report(rules(r).includes("floating"), c.name + " is floating", "found: " + (rules(r).join(", ") || "nothing"));
  }
  for (const c of CLEAN) {
    const r = checkDrawing(c.input);
    report(!rules(r).includes("floating"), c.name, "found: " + (rules(r).join(", ") || "nothing"));
  }
  console.log("\n" + passed + " PASS, " + failed + " FAIL");
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.log("HARNESS ERROR", err && err.stack || err);
  process.exit(1);
});
