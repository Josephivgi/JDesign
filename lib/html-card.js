"use strict";

// HTML/CSS cards. A card carrying composition.html renders through a real
// browser engine instead of the ffmpeg drawtext path: the agent writes
// structure in html and style in css, and the card's color controls land on
// the page as CSS variables (--primary, --secondary, --text) so the studio
// color pickers keep working on HTML designs. composition.vars adds custom
// variables. The same builder feeds the studio iframe preview, the PNG and
// animated-sequence renderers, and the standalone .html export, so the file
// an agent previews is the file that burns into the video.

const fs = require("fs");
const path = require("path");

const MAX_HTML_CHARS = 64000;
const MAX_CSS_CHARS = 64000;
const MAX_VARS = 24;
const MAX_VAR_NAME = 32;
const MAX_VAR_VALUE = 200;

const IMAGE_TOKEN = /\{\{\s*(?:image|img)\s*:\s*([A-Za-z0-9_-]+)\s*\}\}/g;

function cardIsHtml(card) {
  const html = card && card.composition && card.composition.html;
  return typeof html === "string" && html.trim().length > 0;
}

// The browser has no network and no node integration when these render, but
// the document is still agent text: scripts, frames, and external loads are
// stripped so a pasted design cannot reach out or run code.
function sanitizeHtml(html) {
  let out = String(html == null ? "" : html);
  if (out.length > MAX_HTML_CHARS) out = out.slice(0, MAX_HTML_CHARS);
  out = out.replace(/<script[\s\S]*?(<\/script\s*>|$)/gi, "");
  out = out.replace(/<(iframe|frame|frameset|object|embed|applet|link|meta|base|form)\b[\s\S]*?(\/>|>([\s\S]*?<\/\1\s*>)?)/gi, "");
  out = out.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  out = out.replace(/(href|src|action|formaction|xlink:href)\s*=\s*(["']?)\s*javascript:[^"'>\s]*\2?/gi, "$1=$2#$2");
  out = out.replace(/srcdoc\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  return out.trim();
}

function sanitizeCss(css) {
  let out = String(css == null ? "" : css);
  if (out.length > MAX_CSS_CHARS) out = out.slice(0, MAX_CSS_CHARS);
  out = out.replace(/@import\b[^;}]*/gi, "");
  out = out.replace(/@charset\b[^;}]*/gi, "");
  out = out.replace(/expression\s*\([^)]*\)/gi, "none");
  out = out.replace(/url\s*\(\s*(['"]?)\s*(javascript|vbscript|data:text\/html)[^)]*\)/gi, "url(#)");
  // External loads stay out: http, https, protocol-relative, and file refs.
  // data: images survive (library images are injected as data URIs anyway).
  out = out.replace(/url\s*\(\s*(['"]?)\s*(https?:|\/\/|file:)[^)]*\)/gi, "url(#)");
  out = out.replace(/-moz-binding|behavior\s*:/gi, "");
  return out.trim();
}

function sanitizeVarName(name) {
  return String(name || "")
    .trim()
    .replace(/^--/, "")
    .replace(/[^A-Za-z0-9_-]/g, "")
    .slice(0, MAX_VAR_NAME);
}

// Card colors and composition.vars become :root variables. Agents reference
// var(--primary) etc. so the app's color controls still drive the design.
function cssVarBlock(card) {
  const colors = Object.assign({}, (card && card.colors) || {});
  const vars = Object.assign({}, (card && card.composition && card.composition.vars) || {});
  const lines = [];
  const push = (name, value) => {
    const n = sanitizeVarName(name);
    const v = String(value == null ? "" : value).replace(/[;{}<>]/g, "").slice(0, MAX_VAR_VALUE).trim();
    if (n && v) lines.push("--" + n + ":" + v);
  };
  push("primary", colors.primary || "#1F6F56");
  push("secondary", colors.secondary || "#DFF56A");
  push("text", colors.text || "#FFFFFF");
  let count = 0;
  for (const key of Object.keys(vars)) {
    if (["primary", "secondary", "text"].includes(sanitizeVarName(key))) continue;
    if (count >= MAX_VARS) break;
    push(key, vars[key]);
    count += 1;
  }
  return ":root{" + lines.join(";") + "}";
}

// {{image:<libraryId>}} tokens in html and css point at library images. The
// caller resolves ids to data URIs so the document is fully self-contained:
// it works in a sandboxed iframe preview, a hidden render window, and an
// exported .html file with no file access at all.
function substituteImages(text, imageDataUris) {
  const map = imageDataUris || {};
  return String(text || "").replace(IMAGE_TOKEN, (match, id) => map[id] || "");
}

function imageIdsFor(card) {
  const html = String((card && card.composition && card.composition.html) || "");
  const css = String((card && card.composition && card.composition.css) || "");
  const ids = new Set();
  for (const text of [html, css]) {
    let m;
    IMAGE_TOKEN.lastIndex = 0;
    while ((m = IMAGE_TOKEN.exec(text))) ids.add(m[1]);
  }
  return Array.from(ids);
}

// Full self-contained document. `transparent` keeps the page alpha-clear for
// overlay burning; otherwise the page falls back to the primary color so a
// design with no body background still lands on brand, not black.
function buildCardDocument(card, options) {
  const opts = options || {};
  const imageDataUris = opts.imageDataUris || {};
  const transparent = opts.transparent === true;
  const rawHtml = (card && card.composition && card.composition.html) || "";
  const rawCss = (card && card.composition && card.composition.css) || "";
  const html = substituteImages(sanitizeHtml(rawHtml), imageDataUris);
  const css = substituteImages(sanitizeCss(rawCss), imageDataUris);
  const colors = (card && card.colors) || {};
  const baseBg = transparent ? "transparent" : String(colors.primary || "#0E1421");
  const base = [
    cssVarBlock(card),
    "html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden}",
    "body{background:" + baseBg + ";box-sizing:border-box;font-family:'Segoe UI',system-ui,sans-serif}",
    "*,*::before,*::after{box-sizing:border-box}",
  ].join("\n");
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8">',
    "<style>",
    base,
    "</style>",
    "<style>",
    css,
    "</style>",
    "</head><body>",
    html,
    "</body></html>",
  ].join("\n");
}

// True when the card's own CSS animates, meaning compose should render a
// frame sequence instead of a single still. Only real animations count: a
// transition has no driver on a document with no scripts or pointer, and
// "animation: none" is a reset. Detecting those would burn up to 900 captured
// frames of a still card.
function hasCssAnimation(card) {
  const css = String((card && card.composition && card.composition.css) || "");
  const html = String((card && card.composition && card.composition.html) || "");
  const text = css + "\n" + html;
  if (/@keyframes/.test(text)) return true;
  return (
    /animation\s*:(?!\s*(none|initial|inherit|unset|revert)\b)[^;}]+/.test(text) ||
    /animation-name\s*:(?!\s*none\b)[^;}]+/.test(text)
  );
}

// Reads library image files into data URIs for the ids the document uses.
// `resolveFile` maps an id to an absolute path (library-io does this).
async function loadImageDataUris(card, resolveFile) {
  const out = {};
  for (const id of imageIdsFor(card)) {
    let file = "";
    try {
      file = await resolveFile(id);
    } catch {
      file = "";
    }
    if (!file || !fs.existsSync(file)) continue;
    const ext = path.extname(file).toLowerCase();
    const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : ext === ".gif" ? "image/gif" : "image/jpeg";
    try {
      out[id] = "data:" + mime + ";base64," + fs.readFileSync(file).toString("base64");
    } catch {
      /* unreadable files just leave the token blank */
    }
  }
  return out;
}

const MOTION_PRESETS = ["none", "fade", "rise", "drop", "slide", "pop"];

function normalizeMotion(value) {
  const v = value && typeof value === "object" ? value : {};
  const pick = (x) => (MOTION_PRESETS.includes(x) ? x : "none");
  return { in: pick(v.in), out: pick(v.out) };
}

function cardHasMotion(card) {
  const m = normalizeMotion(card && card.motion);
  return m.in !== "none" || m.out !== "none";
}

module.exports = {
  MAX_HTML_CHARS,
  MAX_CSS_CHARS,
  MOTION_PRESETS,
  cardIsHtml,
  cardHasMotion,
  sanitizeHtml,
  sanitizeCss,
  cssVarBlock,
  substituteImages,
  imageIdsFor,
  buildCardDocument,
  hasCssAnimation,
  loadImageDataUris,
  normalizeMotion,
};
