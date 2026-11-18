// Runs checker/slop_check.py on a drawing: the SVGs agents drew, the native
// items turned into SVG, and a render of the whole canvas. Returns
// { ok, issues: [{ rule, title, detail, where, fix }], stats } or
// { ok: null, error } when Python could not run.
const { spawn } = require("node:child_process");
const path = require("node:path");

const SCRIPT = path.join(__dirname, "..", "checker", "slop_check.py").replace("app.asar", "app.asar.unpacked");

const esc = (v) => String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const paint = (p) => (typeof p === "string" ? p : p && p.stops ? "url(#g)" : "none");

// Native JDraw items as plain SVG elements, so the checker sees one format.
function itemsToSvg(doc, keep) {
  const parts = [];
  for (const layer of doc.layers || []) {
    if (layer.visible === false) continue;
    for (const it of layer.items || []) {
      if (keep && keep.has(it.id)) continue;
      const op = it.opacity != null ? ` opacity="${it.opacity}"` : "";
      const fs = `fill="${esc(paint(it.fill))}" stroke="${esc(paint(it.stroke))}"${it.dash ? ` stroke-dasharray="4 4"` : ""}${op}`;
      if (it.type === "rect") parts.push(`<rect x="${it.x}" y="${it.y}" width="${it.w}" height="${it.h}" ${fs}/>`);
      else if (it.type === "ellipse") parts.push(`<ellipse cx="${it.x + it.w / 2}" cy="${it.y + it.h / 2}" rx="${it.w / 2}" ry="${it.h / 2}" ${fs}/>`);
      else if (it.type === "line") parts.push(`<line x1="${it.x1}" y1="${it.y1}" x2="${it.x2}" y2="${it.y2}" stroke="${esc(paint(it.stroke || it.color || "#000"))}"${it.dash ? ` stroke-dasharray="4 4"` : ""}/>`);
      else if (it.type === "polygon" && Array.isArray(it.points)) {
        const pts = it.points.map((p) => p[0] + "," + p[1]).join(" ");
        parts.push(it.closed === false ? `<polyline points="${pts}" fill="none" stroke="${esc(paint(it.stroke || "#000"))}"/>` : `<polygon points="${pts}" ${fs}/>`);
      } else if (it.type === "path" && it.d) parts.push(`<path d="${esc(it.d)}" transform="translate(${it.x || 0} ${it.y || 0}) scale(${it.scale || 1})" ${fs}/>`);
      else if (it.type === "stroke" && Array.isArray(it.points) && it.brush !== "eraser") {
        parts.push(`<polyline points="${it.points.map((p) => p[0] + "," + p[1]).join(" ")}" fill="none" stroke="${esc(it.color || "#000")}"/>`);
      } else if (it.type === "text") parts.push(`<text x="${it.x}" y="${it.y}" font-size="${it.size || 16}" fill="${esc(paint(it.fill || it.color || "#000"))}">${esc(it.text)}</text>`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${doc.width} ${doc.height}">${parts.join("")}</svg>`;
}

// The SVGs agents placed with draw_svg (image items holding an SVG data URL).
function placedSvgs(doc, keep) {
  const out = [];
  for (const layer of doc.layers || []) {
    if (layer.visible === false) continue;
    for (const it of layer.items || []) {
      if (it.type !== "image" || typeof it.src !== "string" || it.name === "Paper grain" || it.name === "Light pass" || (keep && keep.has(it.id))) continue;
      const m = it.src.match(/^data:image\/svg\+xml(;base64)?,(.*)$/s);
      if (!m) continue;
      const svg = m[1] ? Buffer.from(m[2], "base64").toString("utf8") : decodeURIComponent(m[2]);
      out.push({ svg, x: it.x || 0, y: it.y || 0, w: it.w, h: it.h, name: it.name || layer.name, layer: layer.name });
    }
  }
  return out;
}

function runPython(input, timeoutMs) {
  const py = process.env.JDRAW_PYTHON || (process.platform === "win32" ? "python" : "python3");
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let child;
    try {
      child = spawn(py, [SCRIPT], { windowsHide: true });
    } catch (e) {
      return finish({ ok: null, error: "Python is not available: " + e.message });
    }
    const timer = setTimeout(() => { child.kill(); finish({ ok: null, error: "The checker took too long." }); }, timeoutMs || 60000);
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", (e) => { clearTimeout(timer); finish({ ok: null, error: "Python is not available (" + e.message + "). Install Python 3 with Pillow, or set JDRAW_PYTHON." }); });
    child.on("close", () => {
      clearTimeout(timer);
      try { finish(JSON.parse(out)); } catch { finish({ ok: null, error: "The checker failed: " + (err.trim().split("\n").pop() || "no output") }); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

// render: async () => ({ base64 }) of the whole canvas.
// keep: ids of the person's own items; the checker does not judge them.
async function checkDrawing(doc, render, keep) {
  let png = "";
  try { png = (await render()).base64 || ""; } catch { /* shapes are still checked */ }
  if (!png) return { ok: null, error: "JDraw could not render the drawing for the color and composition checks." };
  const svgs = placedSvgs(doc, keep);
  svgs.push({ svg: itemsToSvg(doc, keep), x: 0, y: 0, w: doc.width, h: doc.height, name: "drawn items" });
  return runPython({ width: doc.width, height: doc.height, png, svgs });
}

// The checker's findings as a message an agent can act on.
function issuesText(issues) {
  return issues.map((i, n) => `${n + 1}. ${i.title}. ${i.detail}${i.where && i.where !== "whole drawing" ? ` Where: ${i.where}.` : ""} Fix: ${i.fix}`).join("\n");
}

module.exports = { checkDrawing, issuesText, itemsToSvg, placedSvgs };
