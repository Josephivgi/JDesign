"use strict";

// Code-made animations. An edit card floats on footage; this is the other job:
// a whole video that is only HTML, CSS, and script, with no source media and
// no timeline. The document renders through the same browser engine as a card
// (lib/html-render.js), one frame per video frame, and ffmpeg encodes the
// sequence.
//
// Motion comes from CSS keyframes, which the renderer pauses and seeks so a
// keyframe lands on the video frame it belongs to, and from script, which the
// runtime below turns into a deterministic clock: performance.now and
// requestAnimationFrame report the render's page-time instead of wall time, so
// the frame captured at 1.5 s is the frame the script draws at 1.5 s on every
// machine. The result lands in Videos and images as ordinary footage, so a
// project can cut, frame, and render it like anything else.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { randomUUID } = require("node:crypto");
const { copyPathIntoLibrary, getLibraryItem, libraryFilePath } = require("./library-io");
const { findFfmpeg, runFfmpeg } = require("./card-render");
const { loadState, loadWorkspace, workspaceDir } = require("./workspace-store");
const { cssVarBlock, sanitizeCss, substituteImages, imageIdsFor, loadImageDataUris } = require("./html-card");
const { renderHtmlSequence, renderHtmlFrames, MAX_SEQUENCE_FRAMES } = require("./html-render");
const { resolveAudioTracks } = require("./compose-finished");
const projects = require("./ai-projects");
const { MOTION_RUNTIME } = require("./animation-motion");

const DEFAULT_FPS = 30;
const MAX_FPS = 30;
const MIN_FPS = 10;
const MIN_DURATION_MS = 200;
const MAX_DURATION_MS = 60000;
const DEFAULT_DURATION_MS = 4000;
const DEFAULT_NAME = "Animation";

// One encode for every animation, preset or hand written. H.264 High at yuv420p
// with faststart is the compatibility floor (browser, QuickTime, JV's stage).
// crf 18 is the quality floor: an animation is type and hard edges, and the
// x264 default this used to inherit (crf 23) smoothed thin strokes at 1080.
// medium is x264's own default preset, so the sharper crf costs bytes, not
// seconds. bitexact is applied by the callers so identical code writes
// identical bytes.
const ENCODE_ARGS = ["-c:v", "libx264", "-profile:v", "high", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p", "-movflags", "+faststart"];
// One audio shape everywhere: 48 kHz stereo AAC, so a voice line and a music
// bed never come out at two sample rates.
const AUDIO_ARGS = ["-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2"];

// The frame the animation renders at. The project ratios are what the editor
// already speaks (16/9, 9/16, 1/1, 4/5); the card names are accepted too.
const SIZES = {
  "16/9": { w: 1920, h: 1080 },
  "9/16": { w: 1080, h: 1920 },
  "1/1": { w: 1080, h: 1080 },
  "4/5": { w: 1080, h: 1350 },
  landscape: { w: 1920, h: 1080 },
  vertical: { w: 1080, h: 1920 },
  square: { w: 1080, h: 1080 },
};

// Injected ahead of the author's script. t is page-time in milliseconds and
// starts at 0, so an animation written against rAF or performance.now plays
// the same in the render as it would in a browser tab.
const SCRIPT_RUNTIME = [
  // Script errors are collected (at most 10, deduped) so a render can tell
  // the agent its js broke instead of quietly leaving that motion out.
  // A drawAt that fails on every frame reports once, with its first time.
  "window.__jvErrors=[];var __jvSeen={};window.__jvError=function(where,e){try{var msg=String(e&&e.message||e),key=where.replace(/ at \\d+ ms$/,'')+'|'+msg;if(__jvSeen[key]||window.__jvErrors.length>=10)return;__jvSeen[key]=1;window.__jvErrors.push(where+': '+msg);}catch(_){}};",
  "window.addEventListener('error',function(ev){window.__jvError('page script',ev.error||ev.message);});",
  "window.addEventListener('unhandledrejection',function(ev){var r=ev.reason;if(r&&r.name==='AbortError')return;if(r!=null&&r!=='')window.__jvError('async script',r);});",
  "(function(){",
  "var t=0,queue=[],next=1;",
  "try{var nativeRaf=window.requestAnimationFrame.bind(window);window.__cutlineRaf=nativeRaf;}catch(e){}",
  "try{performance.now=function(){return t;};}catch(e){}",
  "try{Date.now=function(){return 1700000000000+t;};}catch(e){}",
  "window.requestAnimationFrame=function(cb){var id=next++;queue.push([id,cb]);return id;};",
  "window.cancelAnimationFrame=function(id){queue=queue.filter(function(e){return e[0]!==id;});};",
  // setTimeout and setInterval run on the page clock too: a reveal staggered
  // with timers lands at the same frame in every render. The worker keeps the
  // browser's own setTimeout as __jvNativeTimeout for its paint waits.
  "var timers=[],tnext=1;",
  "try{window.__jvNativeTimeout=window.setTimeout.bind(window);}catch(e){}",
  "window.setTimeout=function(cb,ms){var id=tnext++;if(typeof cb==='function')timers.push({id:id,at:t+Math.max(0,Number(ms)||0),cb:cb,args:[].slice.call(arguments,2)});return id;};",
  "window.setInterval=function(cb,ms){var id=tnext++,every=Math.max(10,Number(ms)||0);if(typeof cb==='function')timers.push({id:id,at:t+every,every:every,cb:cb,args:[].slice.call(arguments,2)});return id;};",
  "window.clearTimeout=window.clearInterval=function(id){timers=timers.filter(function(e){return e.id!==id;});};",
  "function runTimers(){for(var guard=0;guard<20000;guard++){var due=null;for(var i=0;i<timers.length;i++){if(timers[i].at<=t&&(!due||timers[i].at<due.at))due=timers[i];}if(!due)return;" +
    "var fire=due.at;if(due.every){due.at+=due.every;}else{timers=timers.filter(function(e){return e!==due;});}" +
    "var target=t;t=fire;try{due.cb.apply(window,due.args);}catch(e){window.__jvError('timer callback',e);}t=target;}" +
    "window.__jvError('timers','more than 20000 timer callbacks before one frame; some motion was skipped. Compute poses from t in drawAt(t) instead of a fast setInterval');}",
  "window.__cutlineSeek=function(ms){",
  "t=Number(ms)||0;",
  "if(typeof window.__jvReseed==='function')window.__jvReseed(t);",
  "runTimers();",
  "var list=queue;queue=[];",
  "for(var i=0;i<list.length;i++){try{list[i][1](t);}catch(e){window.__jvError('requestAnimationFrame callback',e);}}",
  "if(typeof window.drawAt==='function'){try{window.drawAt(t);}catch(e){window.__jvError('drawAt at '+Math.round(t)+' ms',e);}}",
  "};",
  "})();",
].join("");

// Leads a result note when the page's script threw, so the agent fixes the
// js instead of shipping a video with that motion silently missing.
function errorNote(errors) {
  const list = Array.isArray(errors) ? errors.filter(Boolean) : [];
  if (!list.length) return "";
  return "The page's script threw while rendering, so some motion may be missing: " + list.slice(0, 5).join(" | ") + ". Fix the js and render again. ";
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.round(Math.min(max, Math.max(min, n)));
}

function sizeFor(aspectRatio, opts) {
  const o = opts || {};
  // An explicit pixel size is internal (tests and previews); agents name a
  // ratio and get the full-resolution frame.
  const w = Math.round(Number(o.width) || 0);
  const h = Math.round(Number(o.height) || 0);
  if (w > 1 && h > 1) return { w, h };
  const key = String(aspectRatio || "").trim();
  return SIZES[key] || SIZES["16/9"];
}

function animationAspect(value, fallback) {
  const key = String(value || "").trim();
  if (key === "vertical") return "9/16";
  if (key === "landscape") return "16/9";
  if (key === "square") return "1/1";
  return SIZES[key] ? key : fallback || "16/9";
}

function animationDurationMs(value, fps) {
  // The sequence renderer caps a job at MAX_SEQUENCE_FRAMES, so the longest
  // animation depends on the rate it is captured at.
  const ceiling = Math.min(MAX_DURATION_MS, Math.floor((MAX_SEQUENCE_FRAMES / fps) * 1000));
  const wanted = Number(value);
  if (!Number.isFinite(wanted) || wanted <= 0) return Math.min(DEFAULT_DURATION_MS, ceiling);
  return Math.round(Math.min(ceiling, Math.max(MIN_DURATION_MS, wanted)));
}

// A card the user already designed, rendered as a whole animation instead of
// an overlay: same html, css, colors, and vars, the card's own length.
async function cardSource(dataRoot, workspaceId, cardId) {
  const ws = await loadWorkspace(dataRoot, workspaceId);
  const card = (ws.cards || []).find((item) => item && item.id === String(cardId));
  if (!card) throw new Error("Card not found.");
  const composition = card.composition || {};
  return {
    html: composition.html || "",
    css: composition.css || "",
    vars: composition.vars || {},
    colors: card.colors || {},
    durationMs: card.durationMs,
    aspectRatio: animationAspect(composition.aspectRatio),
  };
}

// What the render draws: a saved card, a preset, or the code the agent
// passed in. A preset fills only what the agent left out, so html from the
// agent with a preset's css still works.
async function animationSource(opts, dataRoot, workspaceId) {
  if (opts.preset && !opts.cardId) {
    const { buildPreset } = require("./animation-presets");
    let timingNote = "";
    {
      const meta = require("./animation-presets").listPresets().find((x) => x.name === String(opts.preset).trim().toLowerCase());
      if (meta && meta.params && opts.presetParams && typeof opts.presetParams === "object") {
        const unknown = Object.keys(opts.presetParams).filter((k) => !(k in meta.params));
        if (unknown.length) timingNote += "presetParams " + unknown.join(", ") + " are not used by " + meta.name + "; it reads " + Object.keys(meta.params).join(", ") + ". ";
      }
      if (meta && opts.durationMs != null && !opts.html && Number(opts.durationMs) < meta.minMs) {
        timingNote += "durationMs was raised to " + meta.minMs + " ms: the " + meta.name + " preset needs that long to finish its motion. For a shorter clip, write your own code. ";
        opts = Object.assign({}, opts, { durationMs: meta.minMs });
      }
    }
    const built = buildPreset(opts.preset, opts.presetParams, { durationMs: opts.durationMs });
    const natural = require("./animation-presets").listPresets().find((x) => x.name === built.preset);
    const total = opts.durationMs == null ? built.durationMs : Number(opts.durationMs) || built.durationMs;
    // A render much longer than the preset's motion would sit still after the
    // entrance; a slow push-in over the hold keeps it alive.
    const naturalMs = natural ? natural.durationMs : built.durationMs;
    // Not for overlays (transparent presets): scaling would push a lower
    // third toward the frame edge.
    const drift = total > naturalMs + 1500 && !opts.html && !built.transparent
      ? "\n(function(){var s=document.querySelector('.stage');if(!s)return;var d=window.drawAt;window.drawAt=function(t){if(typeof d==='function')d(t);" +
        "var p=JV.progress(t," + Math.round(naturalMs * 0.85) + "," + Math.max(600, Math.round(total - naturalMs * 0.85 - 600)) + ",'inOutSine');s.style.transform=p>0?'scale('+(1+0.045*p).toFixed(4)+')':'';};})();"
      : "";
    const has = (v) => !(v == null || v === "");
    // Extra js on the preset's own markup runs after the preset's script
    // (which drives its counters and sparks); js with your own html replaces it.
    // A drawAt in the extra js runs after the preset's own, so a tweak never
    // switches off the preset's counter, bars, or sparks.
    const js = !has(opts.js)
      ? built.js
      : has(opts.html) || !built.js
        ? opts.js
        : // Each script runs in its own function, so the agent's names never
          // collide with the preset's (a const x next to the preset's var x
          // was a SyntaxError that killed both). A drawAt the agent declares
          // or assigns joins the preset's instead of replacing it.
          "try{(function(){\n" + built.js + "\n})();}catch(e){window.__jvError&&window.__jvError('preset script',e);}\nwindow.__jvPresetDraw=window.drawAt;\n" +
          // The agent's code runs in an inner function that hands back its
          // drawAt (a declared one is local). A throw part way still reaches
          // the compose step, so the preset's motion is never lost.
          // new Function also catches a syntax error in the agent's code, so
          // it is reported and the preset keeps moving.
          "(function(){var r=null;try{r=(new Function(" + JSON.stringify(opts.js + "\n;return typeof drawAt==='function'?drawAt:null;").replace(/<\//g, "<\\/") + "))();}catch(e){window.__jvError&&window.__jvError('your js',e);}window.__jvAgentDraw=r||window.drawAt;})();\n" +
          "(function(){var p=window.__jvPresetDraw,m=window.__jvAgentDraw;" +
          "if(typeof p==='function'&&typeof m==='function'&&m!==p){window.drawAt=function(t){p(t);m(t);};}else if(typeof m==='function'){window.drawAt=m;}})();";
    opts = Object.assign({}, opts, {
      html: has(opts.html) ? opts.html : built.html,
      // Extra css on the preset's markup comes after the preset's, so a rule
      // the agent writes wins and everything else keeps the preset's look.
      css: !has(opts.css) ? built.css : has(opts.html) ? opts.css : built.css + "\n/* extra */\n" + opts.css,
      js: drift ? (js || "") + drift : js,
      durationMs: opts.durationMs == null ? built.durationMs : opts.durationMs,
      timingNote,
    });
  }
  if (opts.cardId) {
    const card = await cardSource(dataRoot, workspaceId, opts.cardId);
    return {
      html: opts.html == null ? card.html : opts.html,
      css: opts.css == null ? card.css : opts.css,
      js: opts.js == null ? "" : opts.js,
      vars: Object.assign({}, card.vars, opts.vars || {}),
      colors: Object.assign({}, card.colors, opts.colors || {}),
      durationMs: opts.durationMs == null ? card.durationMs : opts.durationMs,
      aspectRatio: animationAspect(opts.aspectRatio, card.aspectRatio),
    };
  }
  return {
    html: opts.html || "",
    css: opts.css || "",
    js: opts.js || "",
    vars: opts.vars || {},
    colors: opts.colors || {},
    durationMs: opts.durationMs,
    aspectRatio: animationAspect(opts.aspectRatio, "16/9"),
    note: opts.timingNote || "",
  };
}

// Frames come from a document, not a page: it must not reach out to anything.
// A card's sanitizer cannot be reused here because it strips scripts, and the
// script is the animation in this path, so this keeps the markup and the code
// and drops only the parts that would load something: embeds, frames, forms,
// and every absolute URL on an attribute.
const EXTERNAL_HTML_TAG =
  /<(iframe|frame|frameset|object|embed|applet|link|meta|base|form)\b[\s\S]*?(\/>|>([\s\S]*?<\/\1\s*>)?)/gi;
const EXTERNAL_HTML_URL_ATTR =
  /\s+(src|href|poster|data|action|formaction|xlink:href)\s*=\s*(["'])\s*(https?:|\/\/|file:|cutline:)[^"']*\2/gi;

function sanitizeAnimationHtml(html) {
  // Attribute rules must not touch script bodies (`var style = el.style;`).
  return String(html == null ? "" : html)
    .split(/(<script\b[\s\S]*?<\/script\s*>)/i)
    .map((part, i) => {
      if (!(i % 2)) return sanitizeAnimationMarkup(part);
      const open = part.match(/^<script\b[^>]*>/i);
      return open ? sanitizeAnimationMarkup(open[0]) + part.slice(open[0].length) : part;
    })
    .join("")
    .trim();
}

function sanitizeAnimationMarkup(html) {
  return String(html)
    .replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi, (_m, open, body, close) => open + sanitizeCss(body) + close)
    .replace(/\sstyle\s*=\s*(?:(["'])([\s\S]*?)\1|([^\s>"']+))/gi, (_m, q, quoted, bare) => {
      const body = quoted != null ? quoted : bare;
      const safe = body.replace(/url\s*\(([^)]*)\)/gi, (u, inner) => {
        const plain = inner.replace(/&quot;|&#0*34;|&#x0*22;|&#0*39;|&#x0*27;|&apos;/gi, "'").replace(/&#0*58;|&colon;/gi, ":").replace(/&#0*47;|&sol;/gi, "/");
        return /^\s*['"]?\s*(https?:|\/\/|file:)/i.test(plain) ? "url(#)" : u;
      });
      return " style=" + (q || '"') + safe + (q || '"');
    })
    .replace(/\s(image)?srcset\s*=\s*(?:(["'])[\s\S]*?\2|[^\s>]+)/gi, "")
    .replace(EXTERNAL_HTML_TAG, "")
    .replace(EXTERNAL_HTML_URL_ATTR, ' $1=$2#$2')
    .replace(/\s+(src|href|poster|data|action|formaction|xlink:href)\s*=\s*(https?:|\/\/|file:|cutline:)[^\s>]*/gi, ' $1="#"');
}

// A full standalone document. Unlike an edit card this one keeps its script:
// the code is the animation. Nothing off this computer loads, {{image:<id>}}
// still expands to a library image, and the author code cannot end its own
// script block from inside a string.
function buildAnimationDocument(opts) {
  const o = opts || {};
  const colors = o.colors || {};
  const vars = o.vars || {};
  const imageDataUris = o.imageDataUris || {};
  const html = substituteImages(sanitizeAnimationHtml(o.html), imageDataUris);
  const css = substituteImages(sanitizeCss(o.css || ""), imageDataUris);
  // Author code is the point here, so only the closing tag is neutralized:
  // a literal </script> inside a string would otherwise end the block early.
  const js = String(o.js || "").replace(/<\/script/gi, "<\\/script");
  const transparent = o.transparent === true;
  const background = transparent ? "transparent" : String(colors.primary || "#0E1421");
  const base = [
    cssVarBlock({ colors, composition: { vars } }),
    "html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden}",
    "body{background:" + background + ";box-sizing:border-box;font-family:'Segoe UI',system-ui,sans-serif}",
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
    "<script>",
    SCRIPT_RUNTIME,
    MOTION_RUNTIME,
    "</scr" + "ipt>",
    "</head><body>",
    html,
    // Split data-split text right after the markup, before the author's
    // script, so a script that looks up .jv-char at load finds the spans.
    "<script>try{JV.split('[data-split]');}catch(e){}</scr" + "ipt>",
    js.trim() ? "<script>\n" + js + "\n</scr" + "ipt>" : "",
    "</body></html>",
  ].join("\n");
}

async function animationImageDataUris(source) {
  const card = { composition: { html: source.html, css: source.css } };
  if (!imageIdsFor(card).length) return {};
  return loadImageDataUris(card, async (id) => {
    const item = await getLibraryItem(source.dataRoot, id, source.workspaceId);
    if (!item || item.kind !== "image") return "";
    return libraryFilePath(source.dataRoot, source.workspaceId, item);
  });
}

function hasCode(source) {
  return Boolean(String(source.html || "").trim() || String(source.css || "").trim() || String(source.js || "").trim());
}

function buildDocument(source) {
  return buildAnimationDocument({
    html: source.html,
    css: source.css,
    js: source.js,
    colors: source.colors,
    vars: source.vars,
    imageDataUris: source.imageDataUris || {},
    transparent: source.transparent === true,
  });
}

// The audio chain: every track resampled to 48k stereo, its own gain applied,
// all mixed flat (normalize=0 keeps each track at the level it was given),
// then padded and cut to exactly the video's length so a short voiceover does
// not end the picture early and a long bed does not run past it.
function audioFilter(tracks, seconds, firstInput = 1) {
  const parts = [];
  const labels = [];
  tracks.forEach((track, i) => {
    const label = "at" + i;
    const chain =
      "[" +
      (i + firstInput) +
      ":a]aresample=48000,aformat=channel_layouts=stereo" +
      (track.volume !== 1 ? ",volume=" + Number(track.volume).toFixed(3) : "") +
      ",asetpts=PTS-STARTPTS" +
      (track.startMs > 0 ? ",adelay=delays=" + Math.round(track.startMs) + ":all=1" : "") +
      "[" +
      label +
      "]";
    parts.push(chain);
    labels.push("[" + label + "]");
  });
  const mix =
    labels.length === 1
      ? labels[0] + "anull[mixed]"
      : labels.join("") + "amix=inputs=" + labels.length + ":duration=longest:dropout_transition=0:normalize=0[mixed]";
  parts.push(mix);
  parts.push("[mixed]apad,atrim=duration=" + seconds.toFixed(3) + ",asetpts=N/SR/TB[aout]");
  return parts.join(";");
}

// A multi scene animation: each scene is its own preset or code with its own
// length, and neighbours overlap by the transition. Scene i starts on the
// output timeline at starts[i]; the total is the sum minus the overlaps.
const TRANSITIONS = { fade: "fade", dissolve: "dissolve", slide: "slideleft", slideleft: "slideleft", slideup: "slideup", wipe: "wipeleft", wipeleft: "wipeleft", zoom: "zoomin", circle: "circleopen", cut: "cut" };
const MAX_SCENES = 8;

async function scenesSource(opts, dataRoot, workspaceId) {
  const list = Array.isArray(opts.scenes) ? opts.scenes.filter((s) => s && typeof s === "object") : [];
  if (list.length < 2) throw new Error("scenes needs at least 2 scenes. For one beat, pass preset or html without scenes.");
  if (list.length > MAX_SCENES) throw new Error("scenes holds at most " + MAX_SCENES + " scenes. Render longer videos in parts and join them in a project.");
  const aspectRatio = animationAspect(opts.aspectRatio, "16/9");
  const shared = { colors: opts.colors || {}, vars: opts.vars || {}, aspectRatio };
  const scenes = [];
  let note = "";
  for (let i = 0; i < list.length; i += 1) {
    const raw = list[i];
    const sceneOpts = Object.assign({}, shared, raw, {
      colors: Object.assign({}, shared.colors, raw.colors || {}),
      vars: Object.assign({}, shared.vars, raw.vars || {}),
      aspectRatio,
    });
    delete sceneOpts.scenes;
    delete sceneOpts.cardId;
    const ignored = ["audioId", "audioIds", "audios", "audioVolume", "audioLoop", "fps", "aspectRatio", "cardId"].filter((k) => raw[k] != null);
    if (ignored.length) note += "Scene " + (i + 1) + ": " + ignored.join(", ") + " only work at the top level, so they were ignored. ";
    if (!raw.preset && !String(raw.html || "").trim()) throw new Error("Scene " + (i + 1) + " has nothing to animate: give it a preset or html.");
    const source = await animationSource(sceneOpts, dataRoot, workspaceId);
    const durationMs = Math.max(600, Math.min(30000, Math.round(Number(source.durationMs) || 3000)));
    if (source.note) note += "Scene " + (i + 1) + ": " + source.note;
    scenes.push({ source: Object.assign({}, source, { aspectRatio }), durationMs, transition: raw.transition, transitionMs: raw.transitionMs });
  }
  const fallbackName = String(opts.transition || "fade").toLowerCase();
  const fallbackMs = opts.transitionMs == null ? 450 : Number(opts.transitionMs);
  const starts = [0];
  let total = scenes[0].durationMs;
  for (let i = 0; i < scenes.length - 1; i += 1) {
    const name = String(scenes[i].transition || fallbackName).toLowerCase();
    const kind = TRANSITIONS[name] || "fade";
    if (!TRANSITIONS[name]) note += "Scene " + (i + 1) + ": transition " + name + " is not one of " + Object.keys(TRANSITIONS).join(", ") + ", so it fades. ";
    // An overlap longer than half of either scene would eat its hold.
    const limit = Math.floor(Math.min(scenes[i].durationMs, scenes[i + 1].durationMs) / 2);
    const wanted = scenes[i].transitionMs != null && Number.isFinite(Number(scenes[i].transitionMs)) ? Number(scenes[i].transitionMs) : Number.isFinite(fallbackMs) ? fallbackMs : 450;
    const ms = kind === "cut" ? 0 : Math.max(100, Math.min(1200, limit, wanted));
    if (kind !== "cut" && ms < wanted - 1) note += "Scene " + (i + 1) + ": the transition was shortened to " + ms + " ms so it does not eat half of a scene. ";
    scenes[i].out = { kind, ms };
    const start = total - ms;
    starts.push(start);
    total = start + scenes[i + 1].durationMs;
  }
  if (opts.durationMs != null) note += "durationMs at the top level is ignored with scenes: give each scene its own durationMs. ";
  if (total > MAX_DURATION_MS) throw new Error("The scenes add up to " + total + " ms; one animation is at most " + MAX_DURATION_MS + " ms. Shorten the scenes or render two parts.");
  return { scenes, starts, durationMs: total, aspectRatio, note, colors: shared.colors, vars: shared.vars };
}

// One filter graph: each scene's frames at the render rate, then xfade chains
// them. A cut is a concat at the boundary.
function scenesFilter(plan, fps) {
  const parts = [];
  plan.scenes.forEach((scene, i) => parts.push("[" + i + ":v]fps=" + fps + ",format=yuv420p,setpts=PTS-STARTPTS,settb=AVTB[s" + i + "]"));
  let last = "s0";
  let length = plan.scenes[0].durationMs / 1000;
  for (let i = 1; i < plan.scenes.length; i += 1) {
    const out = plan.scenes[i - 1].out;
    const label = "x" + i;
    const d = plan.scenes[i].durationMs / 1000;
    if (out.kind === "cut") {
      parts.push("[" + last + "][s" + i + "]concat=n=2:v=1:a=0[" + label + "]");
      length += d;
    } else {
      const t = out.ms / 1000;
      parts.push("[" + last + "][s" + i + "]xfade=transition=" + out.kind + ":duration=" + t.toFixed(3) + ":offset=" + (length - t).toFixed(3) + "[" + label + "]");
      length = length - t + d;
    }
    last = label;
  }
  return { graph: parts.join(";"), out: "[" + last + "]" };
}

async function renderAnimation(options) {
  const opts = options || {};
  const dataRoot = opts.dataRoot;
  if (!dataRoot) throw new Error("dataRoot is required");
  const state = await loadState(dataRoot);
  const workspaceId = opts.workspaceId || state.activeWorkspaceId;
  if (Array.isArray(opts.scenes) && opts.scenes.length) return renderScenes(opts, dataRoot, workspaceId);
  const source = await animationSource(opts, dataRoot, workspaceId);
  if (!hasCode(source)) {
    throw new Error("Nothing to animate: pass html, css, or js (or a cardId whose card carries them).");
  }
  {
    const fpsWanted = clamp(opts.fps, MIN_FPS, MAX_FPS, DEFAULT_FPS);
    const ceiling = Math.min(MAX_DURATION_MS, Math.floor((MAX_SEQUENCE_FRAMES / fpsWanted) * 1000));
    if (Number(source.durationMs) > ceiling) {
      source.note = (source.note || "") + "durationMs was cut to " + ceiling + " ms: one render holds at most " + MAX_SEQUENCE_FRAMES + " frames at " + fpsWanted + " fps. Render longer videos in parts and join them in a project. ";
    }
  }
  // A wrong project fails before anything is written, not after the clip is
  // already in the library.
  if (opts.projectId && !projects.getProjectMeta(dataRoot, opts.projectId)) throw new Error("Project not found: " + opts.projectId);
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error("ffmpeg is not installed. Rendering needs ffmpeg on this computer.");
  const fps = clamp(opts.fps, MIN_FPS, MAX_FPS, DEFAULT_FPS);
  const durationMs = animationDurationMs(source.durationMs, fps);
  const size = sizeFor(source.aspectRatio, opts);
  const allTracks = await resolveAudioTracks(opts, dataRoot, workspaceId);
  const tracks = allTracks.filter((t) => !t.scene);
  if (tracks.length < allTracks.length) {
    source.note = (source.note || "") + "Audio tied to a scene (scene: N) only plays with scenes, so " + (allTracks.length - tracks.length) + " track(s) were left out. Pass audios again for a single beat. ";
  }
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cutline-animation-"));
  try {
    const seqDir = path.join(tempRoot, "frames");
    fs.mkdirSync(seqDir, { recursive: true });
    const seq = await renderHtmlSequence({
      doc: buildDocument(
        Object.assign({}, source, {
          imageDataUris: await animationImageDataUris(Object.assign({ dataRoot, workspaceId }, source)),
        }),
      ),
      width: size.w,
      height: size.h,
      durationMs,
      fps,
      transparent: false,
      outDir: seqDir,
      appRoot: opts.appRoot,
      tempRoot,
    });
    const seconds = seq.frames / seq.fps;
    const out = path.join(tempRoot, "animation.mp4");
    const args = [
      "-y",
      "-framerate",
      String(seq.fps),
      "-start_number",
      "1",
      "-i",
      path.join(seq.dir, seq.pattern),
    ];
    for (const track of tracks) {
      if (track.loop) args.push("-stream_loop", "-1");
      args.push("-i", track.file);
    }
    if (tracks.length) args.push("-filter_complex", audioFilter(tracks, seconds));
    args.push("-map", "0:v");
    if (tracks.length) {
      args.push("-map", "[aout]");
      args.push(...AUDIO_ARGS);
    } else {
      args.push("-an");
    }
    // bitexact so the same code writes the same bytes twice over: the muxer
    // would otherwise stamp a wall-clock creation_time, and re-rendering an
    // unchanged animation then piles up identical files instead of deduping.
    args.push(...ENCODE_ARGS, "-r", String(seq.fps), "-fflags", "+bitexact", "-flags", "+bitexact", out);
    await runFfmpeg(ffmpeg, args, 300000);
    if (!fs.existsSync(out) || fs.statSync(out).size < 32) throw new Error("ffmpeg did not write a clip.");

    const name = String(opts.name || DEFAULT_NAME).trim() || DEFAULT_NAME;
    const copied = await copyPathIntoLibrary(dataRoot, out, {
      workspaceId,
      name,
      mime: "video/mp4",
      source: "animation",
    });
    const item = copied.item;
    // Keep the code beside the clip, so an agent can read it back and fix or
    // change this animation later instead of rebuilding it from the picture.
    // A preset keeps its recipe (preset, params, extra css/js) so it renders
    // the same way again; a card or raw code keeps the resolved code.
    const saved = opts.preset && !opts.cardId ? opts : Object.assign({}, opts, { html: source.html, css: source.css, js: source.js, vars: source.vars || opts.vars, cardId: undefined });
    require("./animation-source").saveAnimationSource(dataRoot, workspaceId, item.id, saved, {
      durationMs: item.durationMs || Math.round(seconds * 1000),
      fps: seq.fps,
      aspectRatio: source.aspectRatio,
    });
    // The animation is footage, so a project that asked for it gets it as a
    // project asset and as the clip on its timeline: the stage previews it at
    // once and cuts, framing, and renders apply to it like any other source.
    let project = null;
    if (opts.projectId) project = attachToProject(dataRoot, opts.projectId, item, source.aspectRatio);
    return {
      item,
      skipped: copied.skipped === true,
      path: libraryFilePath(dataRoot, workspaceId, item),
      width: size.w,
      height: size.h,
      fps: seq.fps,
      frames: seq.frames,
      durationMs: item.durationMs || Math.round(seconds * 1000),
      aspectRatio: source.aspectRatio,
      audioTracks: tracks.map((track) => ({ audioId: track.audioId, startMs: Math.round(track.startMs || 0), durationMs: Math.round(track.durationMs || 0) || undefined })),
      project,
      scriptErrors: seq.pageErrors || [],
      sourceSaved: true,
      note:
        errorNote(seq.pageErrors) +
        (source.note || "") +
        (copied.skipped === true
          ? "The frames matched a clip already in the library, so that clip was reused; its saved animationSource now holds this code. "
          : "") +
        "The animation is in Videos and images as footage. Render the project with jeditor_render_project (or compose it against other clips) to bake a finished clip into Finished videos.",
    };
  } finally {
    await fs.promises.rm(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {});
  }
}

// A voice line starts this long after its scene does, so the picture leads.
const VOICE_LEAD_MS = 250;
// and the scene holds this long after the line ends, before the next one.
const VOICE_TAIL_MS = 500;
// and two lines on one scene have this much air between them.
const VOICE_GAP_MS = 250;

// Tracks with scene: N belong to that scene. A scene shorter than its line
// (plus the lead, the tail, and the transition out) grows to fit it.
async function fitScenesToVoice(opts, tracks, ffmpeg) {
  const scenes = (opts.scenes || []).map((s) => Object.assign({}, s));
  let voiceNote = "";
  const lineTotal = new Map();
  for (let k = tracks.length - 1; k >= 0; k -= 1) {
    const track = tracks[k];
    if (track.scene > scenes.length) {
      voiceNote += "Audio " + track.audioId + " is for scene " + track.scene + ", but there are " + scenes.length + " scenes, so it did not play (it stays in the saved audios; change its scene or remove it). ";
      tracks.splice(k, 1);
    }
  }
  for (const track of tracks) {
    if (!track.scene) continue;
    let lineMs = track.durationMs;
    if (!lineMs) {
      try {
        const media = await require("./card-render").probeMedia(ffmpeg, track.file);
        lineMs = Number(media && media.durationMs) || 0;
      } catch {
        lineMs = 0;
      }
    }
    if (!lineMs) continue;
    track.lineMs = lineMs;
    const scene = scenes[track.scene - 1];
    // Two lines on one scene play one after the other.
    const before = lineTotal.get(track.scene) || 0;
    lineTotal.set(track.scene, before + lineMs + VOICE_GAP_MS);
    const kind = TRANSITIONS[String(scene.transition || opts.transition || "fade").toLowerCase()] || "fade";
    const own = scene.transitionMs != null ? scene.transitionMs : opts.transitionMs;
    const transition = kind === "cut" ? 0 : own == null ? 450 : Number(own) || 0;
    const offset = Math.max(0, Number(track.startMs) || 0);
    const need = Math.round(VOICE_LEAD_MS + offset + before + lineMs + VOICE_TAIL_MS + (track.scene < scenes.length ? Math.min(1200, transition) : 0));
    if (need > 30000) {
      voiceNote += "Audio " + track.audioId + " is too long for scene " + track.scene + ": one scene holds about " + Math.max(0, 30000 - (need - lineMs)) + " ms of voice, and this line is " + Math.round(lineMs) + " ms" + (track.scene < scenes.length ? ", so it overlaps the next scene's voice. " : ", so it is cut at the end. ") + "Split it into two lines on two scenes. ";
    }
    const fit = Math.min(30000, need);
    if (!(Number(scene.durationMs) >= fit)) {
      if (scene.durationMs != null) voiceNote += "Scene " + track.scene + " grew from " + scene.durationMs + " to " + fit + " ms to fit its voice. ";
      scene.durationMs = fit;
    }
  }
  return { planOpts: Object.assign({}, opts, { scenes }), voiceNote };
}

function placeSceneTracks(plan, tracks) {
  const used = new Map();
  for (const track of tracks) {
    if (!track.scene || plan.starts[track.scene - 1] == null) continue;
    const before = used.get(track.scene) || 0;
    track.offsetMs = track.offsetMs == null ? Math.max(0, Number(track.startMs) || 0) : track.offsetMs;
    track.startMs = plan.starts[track.scene - 1] + VOICE_LEAD_MS + before + track.offsetMs;
    used.set(track.scene, before + (track.lineMs || 0) + VOICE_GAP_MS);
  }
}

async function renderScenes(opts, dataRoot, workspaceId) {
  if (opts.projectId && !projects.getProjectMeta(dataRoot, opts.projectId)) throw new Error("Project not found: " + opts.projectId);
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error("ffmpeg is not installed. Rendering needs ffmpeg on this computer.");
  const tracks = await resolveAudioTracks(opts, dataRoot, workspaceId);
  const { planOpts, voiceNote } = await fitScenesToVoice(opts, tracks, ffmpeg);
  const plan = await scenesSource(planOpts, dataRoot, workspaceId);
  plan.note = (plan.note || "") + voiceNote;
  const fps = clamp(opts.fps, MIN_FPS, MAX_FPS, DEFAULT_FPS);
  const size = sizeFor(plan.aspectRatio, opts);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cutline-animation-"));
  try {
    const seqs = [];
    const pageErrors = [];
    for (let i = 0; i < plan.scenes.length; i += 1) {
      const scene = plan.scenes[i];
      const seqDir = path.join(tempRoot, "scene-" + i);
      fs.mkdirSync(seqDir, { recursive: true });
      const seq = await renderHtmlSequence({
        doc: buildDocument(Object.assign({}, scene.source, {
          imageDataUris: await animationImageDataUris(Object.assign({ dataRoot, workspaceId }, scene.source)),
        })),
        width: size.w,
        height: size.h,
        durationMs: animationDurationMs(scene.durationMs, fps),
        fps,
        transparent: false,
        outDir: seqDir,
        appRoot: opts.appRoot,
        tempRoot,
      });
      // The real length of what was rendered, so the joins land on frames.
      scene.durationMs = Math.round((seq.frames / seq.fps) * 1000);
      for (const e of seq.pageErrors || []) pageErrors.push("scene " + (i + 1) + ": " + e);
      seqs.push(seq);
    }
    for (const scene of plan.scenes) if (scene.out && scene.out.ms) scene.out.ms = Math.max(1000 / fps, Math.round((scene.out.ms * fps) / 1000) * (1000 / fps));
    // Starts from what was really rendered, so a voice line lands on its scene.
    plan.starts = [0];
    for (let i = 1; i < plan.scenes.length; i += 1) plan.starts.push(plan.starts[i - 1] + plan.scenes[i - 1].durationMs - plan.scenes[i - 1].out.ms);
    placeSceneTracks(plan, tracks);
    const filter = scenesFilter(plan, fps);
    let seconds = plan.scenes[0].durationMs / 1000;
    for (let i = 1; i < plan.scenes.length; i += 1) seconds += plan.scenes[i].durationMs / 1000 - plan.scenes[i - 1].out.ms / 1000;
    const out = path.join(tempRoot, "animation.mp4");
    const args = ["-y"];
    for (const seq of seqs) args.push("-framerate", String(seq.fps), "-start_number", "1", "-i", path.join(seq.dir, seq.pattern));
    for (const track of tracks) {
      if (track.loop) args.push("-stream_loop", "-1");
      args.push("-i", track.file);
    }
    const graph = filter.graph + ";" + filter.out + "null[vout]" + (tracks.length ? ";" + audioFilter(tracks, seconds, seqs.length) : "");
    args.push("-filter_complex", graph, "-map", "[vout]");
    if (tracks.length) args.push("-map", "[aout]", ...AUDIO_ARGS);
    else args.push("-an");
    args.push(...ENCODE_ARGS, "-r", String(fps), "-fflags", "+bitexact", "-flags", "+bitexact", out);
    try {
      await runFfmpeg(ffmpeg, args, 600000);
    } catch (error) {
      const fancy = plan.scenes.some((s) => s.out && !["fade", "cut"].includes(s.out.kind));
      if (!fancy || /timed out|no such file|does not exist|could not open|invalid data found|permission denied/i.test(error.message)) throw error;
      for (const s of plan.scenes) if (s.out && s.out.kind !== "cut") s.out.kind = "fade";
      const retry = scenesFilter(plan, fps);
      const at = args.indexOf("-filter_complex");
      args[at + 1] = retry.graph + ";" + retry.out + "null[vout]" + (tracks.length ? ";" + audioFilter(tracks, seconds, seqs.length) : "");
      await runFfmpeg(ffmpeg, args, 600000).catch((again) => {
        throw new Error(again.message + " (first try: " + error.message + ")");
      });
      plan.note = (plan.note || "") + "This ffmpeg could not draw one of the transitions, so every transition fades. ";
    }
    if (!fs.existsSync(out) || fs.statSync(out).size < 32) throw new Error("ffmpeg did not write a clip.");
    const name = String(opts.name || DEFAULT_NAME).trim() || DEFAULT_NAME;
    const copied = await copyPathIntoLibrary(dataRoot, out, { workspaceId, name, mime: "video/mp4", source: "animation" });
    const item = copied.item;
    const durationMs = item.durationMs || Math.round(seconds * 1000);
    // The scene list is the recipe: a fix changes one scene and renders again.
    const saved = Object.assign({}, opts);
    for (const key of ["dataRoot", "appRoot", "html", "css", "js", "preset", "presetParams", "cardId"]) delete saved[key];
    require("./animation-source").saveAnimationSource(dataRoot, workspaceId, item.id, saved, { durationMs, fps, aspectRatio: plan.aspectRatio });
    let project = null;
    if (opts.projectId) project = attachToProject(dataRoot, opts.projectId, item, plan.aspectRatio);
    let at = 0;
    const timeline = plan.scenes.map((scene, i) => {
      const row = { scene: i + 1, preset: scene.source.preset || (opts.scenes[i] && opts.scenes[i].preset) || "custom", startMs: Math.round(at), durationMs: scene.durationMs, transitionOut: scene.out ? scene.out.kind + " " + Math.round(scene.out.ms) + " ms" : "" };
      at += scene.durationMs - (scene.out ? scene.out.ms : 0);
      return row;
    });
    return {
      item,
      skipped: copied.skipped === true,
      path: libraryFilePath(dataRoot, workspaceId, item),
      width: size.w,
      height: size.h,
      fps,
      frames: Math.round(seconds * fps),
      durationMs,
      aspectRatio: plan.aspectRatio,
      audioTracks: tracks.map((track) => ({ audioId: track.audioId, scene: track.scene || undefined, startMs: Math.round(track.startMs || 0), durationMs: Math.round(track.lineMs || track.durationMs || 0) || undefined })),
      scenes: timeline,
      project,
      scriptErrors: pageErrors,
      sourceSaved: true,
      note:
        errorNote(pageErrors) + (plan.note || "") +
        "Scenes start at " + timeline.map((r) => r.startMs + " ms").join(", ") + " on the clip. " +
        (tracks.some((t) => t.scene)
          ? "Voice lines start at " + tracks.filter((t) => t.scene).map((t) => "scene " + t.scene + " " + Math.round(t.startMs) + " ms").join(", ") + ". "
          : "For a voiceover, record one line per scene and pass audios with scene: N; JV places and fits them. ") +
        "The animation is in Videos and images as footage.",
    };
  } finally {
    await fs.promises.rm(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {});
  }
}

// Stills of a scene list: each time on the joined timeline maps to the scene
// that is on screen then (the incoming one during a transition).
async function sceneFrames(opts, dataRoot, workspaceId) {
  const plan = await scenesSource(opts, dataRoot, workspaceId);
  const fps = clamp(opts.fps, MIN_FPS, MAX_FPS, DEFAULT_FPS);
  const size = sizeFor(plan.aspectRatio, opts);
  const asked = Array.isArray(opts.timesMs) && opts.timesMs.length;
  // By default, one still per scene at the end of its build (60 percent in).
  const times = asked
    ? framesAt(opts.timesMs, plan.durationMs, opts.maxFrames)
    : plan.scenes.map((scene, i) => Math.round(plan.starts[i] + scene.durationMs * 0.6)).slice(0, 8);
  const outDir = path.join(workspaceDir(dataRoot, workspaceId), "renders");
  fs.mkdirSync(outDir, { recursive: true });
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cutline-animation-frames-"));
  try {
    const files = new Array(times.length);
    const errors = [];
    for (let i = 0; i < plan.scenes.length; i += 1) {
      const mine = [];
      times.forEach((t, k) => {
        let idx = 0;
        for (let j = 0; j < plan.starts.length; j += 1) if (t >= plan.starts[j]) idx = j;
        if (idx === i) mine.push(k);
      });
      if (!mine.length) continue;
      const scene = plan.scenes[i];
      const rendered = await renderHtmlFrames({
        doc: buildDocument(Object.assign({}, scene.source, { imageDataUris: await animationImageDataUris(Object.assign({ dataRoot, workspaceId }, scene.source)) })),
        width: size.w,
        height: size.h,
        transparent: false,
        outDir,
        pattern: "animation-" + randomUUID() + "-%05d.png",
        timesMs: mine.map((k) => Math.max(0, Math.min(scene.durationMs - 1, times[k] - plan.starts[i]))),
        appRoot: opts.appRoot,
        tempRoot,
      });
      mine.forEach((k, n) => (files[k] = { atMs: times[k], scene: i + 1, path: rendered.files[n] }));
      for (const e of rendered.pageErrors || []) errors.push("scene " + (i + 1) + ": " + e);
    }
    return {
      files: files.filter(Boolean),
      timesMs: times,
      width: size.w,
      height: size.h,
      durationMs: plan.durationMs,
      frames: Math.round((plan.durationMs / 1000) * fps),
      sceneStartsMs: plan.starts,
      scriptErrors: errors,
      note: errorNote(errors) + (plan.note || "") + "Stills of the scenes (one per scene unless you pass timesMs on the joined timeline). Fix a scene, then render with jeditor_render_animation and the same scenes.",
    };
  } finally {
    await fs.promises.rm(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {});
  }
}

function attachToProject(dataRoot, projectId, item, aspectRatio) {
  const meta = projects.getProjectMeta(dataRoot, projectId);
  if (!meta) throw new Error("Project not found.");
  const current = projects.getProject(dataRoot, projectId);
  projects.addAssets(dataRoot, projectId, [{ id: item.id, kind: item.kind }]);
  const state = current && current.state && typeof current.state === "object" ? current.state : {};
  const patch = { state: Object.assign({}, state, { selectedAssetId: item.id }) };
  // The project's frame follows the animation it was built for, so the stage
  // is not letterboxing a vertical animation inside a landscape project.
  if (aspectRatio && aspectRatio !== current.aspectRatio) patch.aspectRatio = aspectRatio;
  return projects.updateProject(dataRoot, projectId, patch);
}

// Stills of the same animation, for looking at the motion before a full render.
async function animationFrames(options) {
  const opts = options || {};
  const dataRoot = opts.dataRoot;
  if (!dataRoot) throw new Error("dataRoot is required");
  const state = await loadState(dataRoot);
  const workspaceId = opts.workspaceId || state.activeWorkspaceId;
  if (Array.isArray(opts.scenes) && opts.scenes.length) return sceneFrames(opts, dataRoot, workspaceId);
  const source = await animationSource(opts, dataRoot, workspaceId);
  if (!hasCode(source)) {
    throw new Error("Nothing to look at: pass html, css, or js (or a cardId whose card carries them).");
  }
  const fps = clamp(opts.fps, MIN_FPS, MAX_FPS, DEFAULT_FPS);
  const durationMs = animationDurationMs(source.durationMs, fps);
  const size = sizeFor(source.aspectRatio, opts);
  // Agents get at most 8 stills a call; the design preview (an internal
  // caller) asks for a whole motion strip in one worker job.
  const times = framesAt(opts.timesMs, durationMs, opts.maxFrames);
  const outDir = path.join(workspaceDir(dataRoot, workspaceId), "renders");
  fs.mkdirSync(outDir, { recursive: true });
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cutline-animation-frames-"));
  try {
    const built = Object.assign({}, source, {
      imageDataUris: await animationImageDataUris(Object.assign({ dataRoot, workspaceId }, source)),
    });
    const rendered = await renderHtmlFrames({
      doc: buildDocument(built),
      width: size.w,
      height: size.h,
      transparent: false,
      outDir,
      pattern: "animation-" + randomUUID() + "-%05d.png",
      timesMs: times,
      appRoot: opts.appRoot,
      tempRoot,
    });
    return {
      files: rendered.files.map((file, i) => ({ atMs: times[i], path: file })),
      timesMs: times,
      width: size.w,
      height: size.h,
      durationMs,
      frames: Math.round((durationMs / 1000) * fps),
      scriptErrors: rendered.pageErrors || [],
      note: errorNote(rendered.pageErrors) + (source.note || "") + "Stills of the animation. Look at them, fix the code, then render with jeditor_render_animation.",
    };
  } finally {
    await fs.promises.rm(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {});
  }
}

// A few moments spread over the animation when the caller names none: the open,
// a beat in, near the end, and the last frame it can show.
function framesAt(value, durationMs, maxFrames) {
  const list = (Array.isArray(value) ? value : []).map((v) => Number(v)).filter((v) => Number.isFinite(v) && v >= 0);
  const cap = Math.max(1, Math.min(120, Math.round(Number(maxFrames) || 8)));
  if (list.length) return list.slice(0, cap);
  const last = Math.max(0, durationMs - 40);
  return Array.from(new Set([0, Math.round(durationMs * 0.25), Math.round(durationMs * 0.6), last]));
}

module.exports = {
  renderAnimation,
  animationFrames,
  buildAnimationDocument,
  animationAspect,
  animationDurationMs,
  framesAt,
  DEFAULT_FPS,
  SCRIPT_RUNTIME,
};
