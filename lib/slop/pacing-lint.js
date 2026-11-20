"use strict";

// Static lint for the plan of a video: scene lengths, transitions, entrances,
// preset order, narration line lengths and the audio plan. It is the
// mechanical form of skills/video-slop/SKILL.md (rules 1 to 13 and the
// hand-over table). Pure: it reads the tool arguments and nothing else.
//
//   lintScenes(scenes, opts)      the scenes list of jeditor_render_animation
//   lintNarration(lines, opts)    the lines of jeditor_tts (strings or {text})
//   lintAudioPlan(audios, opts)   the audios list (opts.audioIds for the short form)
//   lintVideoPlan(input, opts)    the raw tool arguments; runs the three above
//   -> { verdict: "ok" | "tells" | "slop", problems: [{ rule, hard, what, fix, where }], stats }
//
// Verdict and density
//   A hard problem alone makes the verdict "slop": the plan is the default
//   one (every scene the same length, a fade between every scene, the same
//   entrance on every scene, every narration line the same length, a bed at
//   full level over the voice).
//   A soft problem is one failed row of the skill's hand-over table. The
//   skill's own limit decides: "If three or more fail, fix the plan", so
//   three or more different soft rules make the verdict "slop", one or two
//   make it "tells". lib/slop/gate.js adds soft rules across design, copy and
//   pacing with the same limit.
//   Variety needs room: a plan of one or two scenes is never checked for
//   variety, and narration of one or two lines is only checked for breath.
//
// A plan the person asked for in their own words passes: "fade between every
// scene" or "3 seconds each" in opts.asked switches that rule off, and
// opts.allow may hold rule ids to switch off.

const PACING_RULES = [
  { id: "equal-scene-lengths", group: "pacing", hard: true, title: "Every scene the same length" },
  { id: "flat-scene-lengths", group: "pacing", hard: false, title: "Longest scene under 1.6 times the shortest" },
  { id: "no-held-beat", group: "pacing", hard: false, title: "No scene holds its key point for a second after its motion lands" },
  { id: "fade-every-scene", group: "transition", hard: true, title: "A fade between every scene (4 or more scenes)" },
  { id: "one-transition-everywhere", group: "transition", hard: true, title: "The same slide, wipe, zoom or circle between every scene" },
  { id: "showy-transition-repeated", group: "transition", hard: false, title: "A slide, wipe, zoom or circle used more than once" },
  { id: "fades-back-to-back", group: "transition", hard: false, title: "Two fades in a row" },
  { id: "no-hard-cut", group: "transition", hard: false, title: "No hard cut in 4 or more scenes" },
  { id: "same-entrance-every-scene", group: "motion", hard: true, title: "Every scene uses the same preset or the same entrance" },
  { id: "same-entrance-neighbours", group: "motion", hard: false, title: "Two neighbouring scenes use the same preset or entrance" },
  { id: "slam-repeated", group: "motion", hard: false, title: "More than one kinetic word slam" },
  { id: "every-beat-loud", group: "motion", hard: false, title: "Every scene is a loud preset, with no quiet beat" },
  { id: "stock-preset-order", group: "pacing", hard: false, title: "The default order: title, stat, end card" },
  { id: "every-line-same-length", group: "narration", hard: true, title: "Every narration line the same length" },
  { id: "every-line-medium", group: "narration", hard: true, title: "Every narration line between 6 and 14 words" },
  { id: "line-length-mix", group: "narration", hard: false, title: "No short line, no long line, or a run of lines the same length" },
  { id: "no-breath", group: "narration", hard: false, title: "A long line with no punctuation to breathe on" },
  { id: "music-over-voice", group: "audio", hard: true, title: "A music bed at full level under the voice" },
  { id: "bed-loud-under-voice", group: "audio", hard: false, title: "A music bed above half level under the voice" },
  { id: "tracks-at-one-level", group: "audio", hard: false, title: "Several tracks mixed at one level from the first second" },
  { id: "voice-looped", group: "audio", hard: false, title: "A voice line set to loop" },
];
const RULE_BY_ID = new Map(PACING_RULES.map((r) => [r.id, r]));
const SOFT_LIMIT = 3;

// The transition names the renderer knows, as families.
const TRANSITION_FAMILY = { fade: "fade", dissolve: "fade", slide: "slide", slideleft: "slide", slideup: "slide", wipe: "wipe", wipeleft: "wipe", zoom: "zoom", circle: "circle", cut: "cut" };
const SHOWY = new Set(["slide", "wipe", "zoom", "circle"]);
const LOUD_PRESETS = new Set(["word-slam", "kinetic-title", "logo-sting"]);

// Preset lengths: [default ms, shortest ms]. Read from the presets module
// when it loads; this copy keeps the lint working on its own.
const PRESET_FALLBACK = {
  "kinetic-title": [3500, 2200],
  "logo-sting": [3000, 2000],
  "lower-third": [4500, 2400],
  "counter-stat": [3500, 2500],
  "bar-chart": [4500, 2400],
  "word-slam": [3600, 2000],
  "typewriter-quote": [5000, 3200],
  "end-card": [4000, 2200],
};
let presetCache = null;
function presetTable() {
  if (presetCache) return presetCache;
  const table = Object.assign({}, PRESET_FALLBACK);
  try {
    for (const p of require("../animation-presets").listPresets()) table[p.name] = [Number(p.durationMs) || 3000, Number(p.minMs) || 1000];
  } catch {
    /* the fallback table stands */
  }
  presetCache = table;
  return table;
}

// ------------------------------------------------------------------ helpers

const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'\u2019-]*/gu;
const wordsOf = (text) => String(text == null ? "" : text).match(WORD_RE) || [];
const secs = (ms) => {
  const s = Math.round(ms / 100) / 10;
  return (Number.isInteger(s) ? String(s) : s.toFixed(1)) + " s";
};
function listOf(items) {
  const a = items.map(String);
  if (a.length <= 1) return a.join("");
  return a.slice(0, -1).join(", ") + " and " + a[a.length - 1];
}
function shorten(text, max) {
  const t = String(text).replace(/\s+/g, " ").trim();
  const limit = max || 70;
  return t.length <= limit ? t : t.slice(0, limit - 3).replace(/\s+\S*$/, "") + "...";
}

const NEGATION_CUE = /\b(?:no|not|never|don't|dont|do not|avoid|without|stop|remove|drop|fewer|less|instead of|rather than|too many|too much)\b/i;
// True when the person typed something matching, and not to rule it out.
function askedFor(asked, re) {
  const text = Array.isArray(asked) ? asked.join("\n") : typeof asked === "string" ? asked : "";
  if (!text.trim()) return false;
  for (const clause of text.split(/[.!?;\n]+|\s+(?:but|instead|however)\s+/i)) {
    const m = clause.match(re);
    if (m && !NEGATION_CUE.test(clause.slice(0, m.index))) return true;
  }
  return false;
}

// True when the person asked for this transition between scenes. "Fade the
// logo in" is about one element and does not count.
const TRANSITION_WORDS = { fade: "cross ?fades?|fades?|fading|dissolves?", slide: "slides?|sliding", wipe: "wipes?|wiping", zoom: "zooms?|zooming", circle: "circles?|iris" };
function transitionAsked(asked, family) {
  const names = TRANSITION_WORDS[family];
  if (!names) return false;
  const n = "(?:" + names + ")";
  const source =
    "\\b" + n + " (?:between|transitions?|every|each|everywhere|throughout|from (?:scene|one)|into (?:each|the next)|for (?:all|every|each))\\b" +
    "|\\b(?:all|only|just) " + n + "\\b" +
    "|\\btransitions?\\b[^.!?\\n]{0,24}\\b" + n + "\\b" +
    "|\\b" + n + "\\b[^.!?\\n]{0,24}\\b(?:transitions?|between (?:the )?(?:scenes|every|each|all))\\b" +
    (family === "fade" ? "|\\bcross ?fades?\\b" : "");
  return askedFor(asked, new RegExp(source, "i"));
}

function collector(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const off = new Set((Array.isArray(o.allow) ? o.allow : []).map((a) => String(a)));
  const problems = [];
  const add = (rule, where, what, fix) => {
    if (off.has(rule)) return;
    if (problems.some((p) => p.rule === rule && p.what === what)) return;
    problems.push({ rule, hard: Boolean(RULE_BY_ID.get(rule) && RULE_BY_ID.get(rule).hard), what, fix, where });
  };
  return { problems, add, asked: o.asked };
}

function finish(problems, stats) {
  problems.sort((a, b) => Number(b.hard) - Number(a.hard));
  const hard = problems.filter((p) => p.hard).length;
  const softRules = [...new Set(problems.filter((p) => !p.hard).map((p) => p.rule))];
  const verdict = hard ? "slop" : softRules.length >= SOFT_LIMIT ? "slop" : softRules.length ? "tells" : "ok";
  return { verdict, problems, stats: Object.assign({ hard, soft: problems.length - hard, softRules, softLimit: SOFT_LIMIT }, stats || {}) };
}

// ------------------------------------------------------ reading a scene's css

function splitTop(text, sep) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of String(text)) {
    if (ch === "(") depth += 1;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function declarations(body) {
  const map = {};
  for (const part of splitTop(body, ";")) {
    const at = part.indexOf(":");
    if (at < 0) continue;
    const prop = part.slice(0, at).trim().toLowerCase();
    if (prop) map[prop] = part.slice(at + 1).trim();
  }
  return map;
}

// { rules: [{ selector, decl }], keyframes: Map(name -> [{ step, decl }]) }
function parseCss(css) {
  const src = String(css == null ? "" : css).replace(/\/\*[\s\S]*?\*\//g, " ");
  const rules = [];
  const keyframes = new Map();
  const walk = (text) => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf("{", i);
      if (open < 0) break;
      const prelude = text.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === "{") depth += 1;
        else if (text[j] === "}") depth -= 1;
        j += 1;
      }
      const body = text.slice(open + 1, depth === 0 ? j - 1 : j);
      const kf = prelude.match(/^@(?:-webkit-)?keyframes\s+([\w-]+)/i);
      if (kf) {
        const frames = [];
        const frameRe = /([^{}]+)\{([^{}]*)\}/g;
        let m;
        while ((m = frameRe.exec(body))) for (const step of m[1].split(",")) frames.push({ step: step.trim().toLowerCase(), decl: declarations(m[2]) });
        keyframes.set(kf[1], frames);
      } else if (/^@(?:media|supports|layer|container)\b/i.test(prelude)) walk(body);
      else if (!prelude.startsWith("@")) rules.push({ selector: prelude.replace(/\s+/g, " "), decl: declarations(body) });
      i = j;
    }
  };
  walk(src);
  return { rules, keyframes };
}

const TIMING_WORDS = new Set(["ease", "linear", "ease-in", "ease-out", "ease-in-out", "step-start", "step-end", "both", "forwards", "backwards", "none", "normal", "reverse", "alternate", "alternate-reverse", "running", "paused", "infinite"]);

function timeMs(token) {
  const m = String(token).trim().match(/^(-?\d*\.?\d+)(ms|s)$/i);
  if (!m) return NaN;
  return Number(m[1]) * (m[2].toLowerCase() === "s" ? 1000 : 1);
}

// How many letters or words the motion kit's split gives the widest element.
function splitCount(html, mode, scope) {
  const re = /<([a-zA-Z][\w-]*)\b([^>]*\bdata-split\s*=\s*["']?(chars|words)["']?[^>]*)>([\s\S]*?)<\/\1\s*>/gi;
  let best = 0;
  let scoped = 0;
  let m;
  while ((m = re.exec(String(html || "")))) {
    if (m[3].toLowerCase() !== mode) continue;
    const text = m[4].replace(/<[^>]*>/g, "").replace(/&[#\w]+;/g, "x");
    const n = mode === "words" ? (text.trim().split(/\s+/).filter(Boolean).length || 0) : text.replace(/\s+/g, "").length;
    best = Math.max(best, n);
    if (scope) {
      const tag = m[1].toLowerCase();
      const cls = (m[2].match(/\bclass\s*=\s*["']([^"']*)["']/i) || ["", ""])[1].split(/\s+/);
      const id = (m[2].match(/\bid\s*=\s*["']([^"']*)["']/i) || ["", ""])[1];
      if (scope === tag || scope === "#" + id || (scope[0] === "." && cls.includes(scope.slice(1)))) scoped = Math.max(scoped, n);
    }
  }
  return scoped || best;
}

// A delay value in ms, or NaN when it cannot be read. Handles a plain time
// and the stagger forms calc(var(--i) * 45ms) and calc(200ms + var(--i) * 45ms).
function delayMs(value, rule, html) {
  const v = String(value == null ? "" : value).trim();
  if (!v) return 0;
  const plain = timeMs(v);
  if (Number.isFinite(plain)) return plain;
  const stagger = v.match(/var\(\s*--([\w-]+)\s*\)\s*\*\s*(-?\d*\.?\d+(?:ms|s))|(-?\d*\.?\d+(?:ms|s))\s*\*\s*var\(\s*--([\w-]+)\s*\)/i);
  if (!/^calc\(/i.test(v) || !stagger) return NaN;
  const step = timeMs(stagger[2] || stagger[3]);
  const rest = v.replace(stagger[0], " ");
  if (/var\(/i.test(rest)) return NaN;
  const baseHit = rest.match(/(-?\d*\.?\d+)(ms|s)\b/i);
  const base = baseHit ? timeMs(baseHit[0]) : 0;
  let count = 0;
  const sel = rule.selector;
  if (/\.jv-char\b/.test(sel) || /\.jv-word\b/.test(sel)) {
    const mode = /\.jv-char\b/.test(sel) ? "chars" : "words";
    const scope = (sel.match(/([.#]?[\w-]+)\s+\.jv-(?:char|word)\b/) || ["", ""])[1].toLowerCase();
    count = splitCount(html, mode, scope);
  } else {
    const name = stagger[1] || stagger[4];
    const re = new RegExp("--" + name + "\\s*:\\s*(\\d+)", "g");
    let m;
    let max = -1;
    while ((m = re.exec(String(html || "")))) max = Math.max(max, Number(m[1]));
    count = max + 1;
  }
  if (!count || !Number.isFinite(step)) return NaN;
  return base + (count - 1) * step;
}

// The animations a rule starts: [{ name, durationMs, delayMs, loops, steps }].
function animationsOf(rule, html) {
  const d = rule.decl;
  const out = [];
  if (d.animation) {
    const longDelay = d["animation-delay"];
    for (const seg of splitTop(d.animation, ",")) {
      const steps = /\bsteps\(/i.test(seg);
      const flat = seg.replace(/[\w-]+\([^()]*(?:\([^()]*\)[^()]*)*\)/g, " ");
      const tokens = flat.trim().split(/\s+/).filter(Boolean);
      const times = tokens.filter((t) => Number.isFinite(timeMs(t))).map(timeMs);
      const infinite = tokens.includes("infinite");
      const count = tokens.find((t) => /^\d*\.?\d+$/.test(t));
      const name = tokens.find((t) => !Number.isFinite(timeMs(t)) && !TIMING_WORDS.has(t.toLowerCase()) && !/^\d*\.?\d+$/.test(t) && /^[a-zA-Z_-]/.test(t));
      if (!name) continue;
      let delay = times.length > 1 ? times[1] : 0;
      if (longDelay != null && times.length < 2) delay = delayMs(longDelay, rule, html);
      out.push({ name, durationMs: times.length ? times[0] : 0, delayMs: delay, loops: infinite ? Infinity : count ? Number(count) : 1, steps });
    }
  } else if (d["animation-name"]) {
    const names = d["animation-name"].split(",").map((s) => s.trim());
    const dur = timeMs((d["animation-duration"] || "0s").split(",")[0]);
    const loops = /infinite/i.test(d["animation-iteration-count"] || "") ? Infinity : Number(d["animation-iteration-count"]) || 1;
    for (const name of names) if (name && name !== "none") out.push({ name, durationMs: Number.isFinite(dur) ? dur : 0, delayMs: delayMs(d["animation-delay"], rule, html), loops, steps: /steps\(/i.test(d["animation-timing-function"] || "") });
  }
  return out;
}

const VERB_WORDS = { fade: "fade", y: "move up or down", x: "move sideways", move: "move", scale: "scale", rotate: "rotate", clip: "wipe", blur: "blur", track: "letter spacing", draw: "line draw", size: "grow", steps: "typed on", other: "change" };

// What kind of entrance one animation is: the properties it changes.
function verbOf(anim, frames, rule) {
  const classes = new Set();
  const texts = frames.map((f) => f.decl);
  const transformValues = texts.map((dcl) => dcl.transform).filter(Boolean);
  if (rule.decl.transform) transformValues.push(rule.decl.transform);
  const allProps = new Set();
  for (const dcl of texts) for (const key of Object.keys(dcl)) allProps.add(key);
  if (allProps.has("opacity")) classes.add("fade");
  if (allProps.has("transform") || allProps.has("translate") || allProps.has("scale") || allProps.has("rotate")) {
    const joined = transformValues.join(" ").toLowerCase();
    if (/translatey\(|translate\(\s*0(?:px|%|vmin|vw|vh)?\s*,/.test(joined)) classes.add("y");
    else if (/translatex\(/.test(joined)) classes.add("x");
    else if (/translate(?:3d)?\(/.test(joined) || allProps.has("translate")) classes.add("move");
    if (/scale[xy]?\(/.test(joined) || allProps.has("scale")) classes.add("scale");
    if (/rotate[xyz]?\(/.test(joined) || allProps.has("rotate")) classes.add("rotate");
  }
  if (allProps.has("clip-path")) classes.add("clip");
  if (allProps.has("filter") || allProps.has("backdrop-filter")) classes.add("blur");
  if (allProps.has("letter-spacing")) classes.add("track");
  if (allProps.has("stroke-dashoffset")) classes.add("draw");
  if (allProps.has("width") || allProps.has("height") || allProps.has("max-width") || allProps.has("max-height")) classes.add("size");
  if (anim.steps) classes.add("steps");
  if (!classes.size) classes.add("other");
  return [...classes].sort().join("+");
}

// For a scene written as html: its entrance signature and when its motion
// lands. signature is "" when there is no css entrance; endMs is null when
// the motion cannot be read (script motion, an unreadable delay).
function readMotion(scene) {
  const html = String(scene.html || "");
  const js = String(scene.js || "");
  const { rules, keyframes } = parseCss(scene.css);
  const verbs = new Set();
  let end = 0;
  let readable = true;
  // A stylesheet shared by every scene must not make every scene look alike:
  // only the rules that reach something in this scene's markup count.
  const classes = new Set();
  const ids = new Set();
  const tags = new Set(["html", "body"]);
  html.replace(/\bclass\s*=\s*["']([^"']*)["']/gi, (all, list) => list.split(/\s+/).forEach((c) => c && classes.add(c)));
  html.replace(/\bid\s*=\s*["']([^"']*)["']/gi, (all, id) => ids.add(id.trim()));
  html.replace(/<([a-zA-Z][\w-]*)/g, (all, tag) => tags.add(tag.toLowerCase()));
  if (/data-split\s*=\s*["']?chars/i.test(html)) classes.add("jv-char");
  if (/data-split\s*=\s*["']?words/i.test(html)) classes.add("jv-word");
  const reaches = (selector) => {
    if (!html.trim()) return true; // the script builds the page
    return selector.split(",").some((one) => {
      const last = one.trim().split(/\s*[>+~]\s*|\s+/).pop() || "";
      const core = last.replace(/::?[\w-]+(?:\([^)]*\))?/g, "").replace(/\[[^\]]*\]/g, "");
      const cls = core.match(/\.[\w-]+/g) || [];
      const idList = core.match(/#[\w-]+/g) || [];
      const tag = (core.match(/^[a-zA-Z][\w-]*/) || [""])[0].toLowerCase();
      if (!cls.length && !idList.length && !tag) return true;
      return cls.every((c) => classes.has(c.slice(1)) || js.includes(c.slice(1))) && idList.every((i) => ids.has(i.slice(1)) || js.includes(i.slice(1))) && (!tag || tags.has(tag));
    });
  };
  for (const rule of rules) {
    if (!reaches(rule.selector)) continue;
    for (const anim of animationsOf(rule, html)) {
      const frames = keyframes.get(anim.name);
      if (!frames) continue;
      if (anim.loops !== 1) continue; // a loop or a pulse is not an entrance
      const last = frames.filter((f) => f.step === "to" || f.step === "100%").pop();
      if (last && /^0(?:\.0+)?$/.test(String(last.decl.opacity || "").trim())) continue; // an exit
      verbs.add(verbOf(anim, frames, rule));
      if (!Number.isFinite(anim.delayMs) || !Number.isFinite(anim.durationMs)) readable = false;
      else end = Math.max(end, anim.delayMs + anim.durationMs);
    }
  }
  const scripted = /\bdrawAt\b|\bJV\.|requestAnimationFrame|setTimeout|setInterval/.test(js);
  return { signature: [...verbs].sort().join("|"), endMs: scripted || !readable ? null : end, scripted };
}

function wordList(value) {
  let raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[|,\n]/) : [];
  raw = raw.map((x) => (typeof x === "string" ? x.trim() : x)).filter((x) => x !== "" && x != null);
  if (!raw.length) return 3;
  if (raw.length === 1 && typeof raw[0] === "string" && /\s/.test(raw[0])) raw = raw[0].split(/\s+/);
  return Math.min(5, raw.length);
}

// When a preset's entrance lands, from the timings in lib/animation-presets.js.
function presetMotionEnd(name, params, d) {
  const p = params && typeof params === "object" ? params : {};
  const str = (v, fb) => String(v == null ? "" : v).trim() || fb;
  switch (name) {
    case "kinetic-title": {
      const len = str(p.title, "Make it move").slice(0, 60).length;
      const step = Math.max(12, Math.min(45, Math.floor((d - 1200) / Math.max(1, len))));
      const riseEnd = 200 + Math.max(0, len - 1) * step + 700;
      const bar = Math.max(900, riseEnd - 500) + 600;
      const sub = str(p.subtitle, "") ? Math.max(1250, riseEnd - 350) + 600 : 0;
      return Math.max(riseEnd, bar, sub);
    }
    case "logo-sting":
      return 1650;
    case "lower-third":
      return 1250 + 700; // it leaves 0.7 s before the end
    case "counter-stat":
      return 2200;
    case "bar-chart": {
      const k = Array.isArray(p.items) && p.items.length ? Math.min(6, p.items.length) : 5;
      return 500 + (k - 1) * 140 + 900;
    }
    case "word-slam": {
      const k = wordList(p.words);
      const per = Math.min(1600, Math.floor(Math.max(1200, d - 600) / k));
      return 150 + (k - 1) * per + 380;
    }
    case "typewriter-quote": {
      const len = str(p.quote, "Good design is as little design as possible.").slice(0, 160).length;
      const per = Math.min(55, Math.max(1200, d - 1700) / Math.max(1, len));
      return 500 + len * per + (str(p.author, "") ? 800 : 0);
    }
    case "end-card":
      return 1800;
    default:
      return null;
  }
}

// One scene as the renderer will play it.
function readScene(raw, index) {
  const table = presetTable();
  const preset = raw.preset ? String(raw.preset).trim().toLowerCase() : "";
  const ownHtml = String(raw.html || "").trim() !== "";
  const meta = preset && table[preset] ? table[preset] : null;
  let duration = Number(raw.durationMs);
  let raised = false;
  if (!Number.isFinite(duration) || duration <= 0) duration = meta ? meta[0] : 3000;
  if (meta && !ownHtml && duration < meta[1]) {
    duration = meta[1];
    raised = true;
  }
  duration = Math.max(600, Math.min(30000, Math.round(duration)));
  const floorMs = meta && !ownHtml ? meta[1] : 600;
  let signature = "";
  let label = "";
  let endMs = null;
  if (preset && !ownHtml) {
    signature = "preset:" + preset;
    label = "the " + preset + " preset";
    endMs = presetMotionEnd(preset, raw.presetParams, duration);
    if (String(raw.js || "").trim()) endMs = null;
  } else {
    const motion = readMotion(raw);
    endMs = motion.endMs;
    if (motion.signature && !motion.scripted) {
      signature = "css:" + motion.signature;
      label = listOf(motion.signature.split("|").map((v) => v.split("+").map((c) => VERB_WORDS[c] || c).join(" with ")));
    }
  }
  return { n: index + 1, preset: ownHtml ? "" : preset, ownHtml, duration, raised, floorMs, signature, label, endMs, holdMs: endMs == null ? null : duration - endMs };
}

// --------------------------------------------------------------- lintScenes

function lintScenes(scenes, opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const { problems, add, asked } = collector(o);
  const list = (Array.isArray(scenes) ? scenes : []).filter((s) => s && typeof s === "object");
  const n = list.length;
  const read = list.map(readScene);
  const fallback = String(o.transition || "fade").toLowerCase();
  const transitions = [];
  for (let i = 0; i < n - 1; i += 1) {
    const name = String(list[i].transition || fallback).toLowerCase();
    transitions.push(TRANSITION_FAMILY[name] || "fade");
  }
  const voiced = new Set((Array.isArray(o.voicedScenes) ? o.voicedScenes : []).map(Number).filter((v) => v >= 1 && v <= n));
  const durations = read.map((s) => s.duration);
  const stats = {
    scenes: n,
    durationsMs: durations,
    ratio: n ? Math.round((Math.max(...durations) / Math.min(...durations)) * 100) / 100 : 0,
    transitions,
    entrances: read.map((s) => s.signature),
    holdsMs: read.map((s) => s.holdMs),
    voicedScenes: [...voiced],
  };
  // One or two scenes have no room for variety.
  if (n < 3) return finish(problems, stats);

  // ---- scene lengths (rules 1 and 2)
  const lengthsKnown = voiced.size * 2 < n; // a voiced scene grows to fit its line
  stats.lengthsChecked = lengthsKnown;
  const wantsEven = askedFor(asked, /\b(?:same|equal|even|identical) (?:length|lengths|duration|durations|time|pace|pacing)\b|\b\d+(?:\.\d+)?\s?(?:s|sec|secs|seconds?)\s+(?:each|per scene|a scene|every scene)\b|\beach (?:scene|one|beat)\b[^.]{0,20}\b\d+(?:\.\d+)?\s?(?:s|sec|seconds?)\b/i);
  let lengthFired = false;
  if (lengthsKnown && !wantsEven) {
    const max = Math.max(...durations);
    const min = Math.min(...durations);
    const ratio = max / min;
    if (ratio < 1.6) {
      // Suggest one held scene and one quick one, by number.
      const longTies = read.filter((s) => s.duration === max);
      const target = Math.round(0.6 * (n - 1));
      const held = longTies.slice().sort((a, b) => Math.abs(a.n - 1 - target) - Math.abs(b.n - 1 - target) || (a.n === 1 || a.n === n ? 1 : 0) - (b.n === 1 || b.n === n ? 1 : 0))[0];
      const shortTies = read.filter((s) => s.duration === min && s.n !== held.n);
      const quick = (shortTies.find((s) => s.n === 2) || shortTies[0] || read.find((s) => s.n !== held.n));
      const quickTo = Math.max(quick.floorMs, Math.min(quick.duration, 2200));
      const heldTo = Math.max(held.duration, 4500, Math.ceil((quickTo * 1.7) / 500) * 500);
      const steps = [];
      if (heldTo > held.duration + 100) steps.push("scene " + held.n + " about " + secs(heldTo));
      if (quickTo < quick.duration - 100) steps.push("scene " + quick.n + " about " + secs(quickTo));
      const fix = "Make " + (steps.length ? steps.join(" and ") : "one scene about " + secs(heldTo)) + ", so the longest is at least 1.6 times the shortest and the main point has room to hold.";
      const raisedNote = read.some((s) => s.raised) ? " (a scene shorter than its preset allows is raised to the preset's shortest length)" : "";
      if (ratio < 1.15) {
        add("equal-scene-lengths", "scenes 1 to " + n, (max === min ? "All " + n + " scenes run " + secs(max) : "All " + n + " scenes run about the same length (" + listOf(durations.map(secs)) + ")") + raisedNote + ".", fix);
      } else {
        add("flat-scene-lengths", "scenes 1 to " + n, "Scene lengths are " + listOf(durations.map(secs)) + ": the longest is only " + ratio.toFixed(1) + " times the shortest" + raisedNote + ".", fix);
      }
      lengthFired = true;
    }
  }
  if (lengthsKnown && !lengthFired && !voiced.size && read.every((s) => s.holdMs != null)) {
    const best = read.slice().sort((a, b) => b.holdMs - a.holdMs)[0];
    if (best.holdMs < 1000) {
      const need = Math.ceil((best.duration + (1200 - Math.max(0, best.holdMs))) / 100) * 100;
      add("no-held-beat", "scene " + best.n, "No scene holds still: the longest hold is " + secs(Math.max(0, best.holdMs)) + ", on scene " + best.n + ", after its motion lands.", "Make the scene with the main point about " + secs(need) + ", or land its motion earlier, so it sits still for a second or more.");
    }
  }

  // ---- transitions (rule 3)
  const count = (family) => transitions.filter((t) => t === family).length;
  const fades = count("fade");
  const cuts = count("cut");
  const quickest = read.slice(0, n - 1).slice().sort((a, b) => a.duration - b.duration)[0];
  const turn = Math.min(n - 1, Math.max(1, Math.round(n / 2)));
  const turnScene = turn === quickest.n ? (turn < n - 1 ? turn + 1 : Math.max(1, turn - 1)) : turn;
  let transitionHard = false;
  if (transitions.length >= 2 && fades === transitions.length) {
    if (!transitionAsked(asked, "fade")) {
      if (n >= 4) {
        add("fade-every-scene", "scenes 1 to " + (n - 1), "Every one of the " + transitions.length + " hand-overs is a fade.", "Set scene " + quickest.n + "'s transition to \"cut\" (the fastest beat), keep one fade, and use \"slide\" or \"wipe\" once, after scene " + turnScene + ", where the story turns.");
        transitionHard = true;
      } else {
        add("fades-back-to-back", "scenes 1 and 2", "Both hand-overs are fades.", "Set scene " + quickest.n + "'s transition to \"cut\" and keep the other fade.");
      }
    } else transitionHard = true;
  } else {
    const showyAll = transitions.length >= 2 && SHOWY.has(transitions[0]) && transitions.every((t) => t === transitions[0]);
    if (showyAll && transitions.length >= 3 && !transitionAsked(asked, transitions[0])) {
      add("one-transition-everywhere", "scenes 1 to " + (n - 1), "Every hand-over is a " + transitions[0] + " (" + transitions.length + " in a row).", "Keep one " + transitions[0] + " where the story turns, set scene " + quickest.n + "'s transition to \"cut\", and use a fade or another cut for the rest.");
      transitionHard = true;
    } else {
      for (const family of SHOWY) {
        const at = transitions.map((t, i) => (t === family ? i + 1 : 0)).filter(Boolean);
        if (at.length > 1 && !transitionAsked(asked, family)) {
          add("showy-transition-repeated", "scenes " + listOf(at), "The " + family + " transition is used " + at.length + " times (after scenes " + listOf(at) + ").", "Keep it once, where the story turns, and set scene " + at[at.length - 1] + "'s transition to \"cut\" or \"fade\".");
        }
      }
      for (let i = 0; i < transitions.length - 1; i += 1) {
        if (transitions[i] === "fade" && transitions[i + 1] === "fade" && !transitionAsked(asked, "fade")) {
          add("fades-back-to-back", "scenes " + (i + 1) + " and " + (i + 2), "Scenes " + (i + 1) + " and " + (i + 2) + " both hand over with a fade.", "Set scene " + (read[i].duration <= read[i + 1].duration ? i + 1 : i + 2) + "'s transition to \"cut\".");
          break;
        }
      }
    }
  }
  if (!transitionHard && n >= 4 && cuts === 0 && !askedFor(asked, /\bsmooth (?:transitions?|cuts?|hand-?overs?)\b|\bno (?:hard |jump )?cuts?\b|\bwithout (?:hard |jump )?cuts?\b/i)) {
    add("no-hard-cut", "scenes 1 to " + (n - 1), "None of the " + transitions.length + " hand-overs is a hard cut.", "Set scene " + quickest.n + "'s transition to \"cut\": it is the fastest beat (" + secs(quickest.duration) + ").");
  }

  // ---- entrances and presets (rules 5, 6, 7 and 4)
  const signed = read.filter((s) => s.signature);
  const allSame = signed.length === n && read.every((s) => s.signature === read[0].signature);
  if (allSame) {
    const viaPreset = read[0].signature.startsWith("preset:");
    add(
      "same-entrance-every-scene",
      "scenes 1 to " + n,
      viaPreset ? "All " + n + " scenes use " + read[0].label + ", so every scene enters the same way." : "All " + n + " scenes start with the same entrance (" + read[0].label + ").",
      viaPreset
        ? "Keep it on one scene. Give scene 2 another preset and write scene " + Math.min(n, 3) + " as html with its own entrance (wipe on, scale in, type out)."
        : "Keep it on one scene. Give scene 2 a different verb (wipe on, scale in, type out) and let scene " + Math.min(n, 3) + " start with its text already there.",
    );
  } else {
    const pairs = [];
    for (let i = 0; i < n - 1; i += 1) if (read[i].signature && read[i].signature === read[i + 1].signature) pairs.push(i);
    if (pairs.length) {
      const i = pairs[0];
      const viaPreset = read[i].signature.startsWith("preset:");
      const who = pairs.map((p) => p + 1 + " and " + (p + 2));
      add(
        "same-entrance-neighbours",
        "scenes " + (i + 1) + " and " + (i + 2),
        "Scenes " + listOf(who) + (viaPreset ? " use the same preset (" + read[i].preset + ")" : " start with the same entrance (" + read[i].label + ")") + ".",
        viaPreset ? "Give scene " + (i + 2) + " another preset, or write it as html with its own entrance." : "Give scene " + (i + 2) + " its own verb (wipe on, scale in, type out), or let its text already be there when the scene starts.",
      );
    }
    const slams = read.filter((s) => s.preset === "word-slam");
    const apart = slams.length > 1 && !slams.some((s, k) => k > 0 && s.n === slams[k - 1].n + 1);
    if (apart) add("slam-repeated", "scenes " + listOf(slams.map((s) => s.n)), "The word slam is used on scenes " + listOf(slams.map((s) => s.n)) + ".", "Keep one slam, on the line that earns it, and make scene " + slams[slams.length - 1].n + " a quiet beat.");
    if (read.every((s) => LOUD_PRESETS.has(s.preset))) add("every-beat-loud", "scenes 1 to " + n, "Every scene is a loud preset (" + listOf(read.map((s) => s.preset)) + "), so none of them lands.", "Follow a loud scene with a still one: make scene " + Math.min(n, 2) + " a quote, a stat, or plain html that is already there.");
  }
  const order = read.map((s) => s.preset || "html");
  const stockOrder = order[0] === "kinetic-title" && order[n - 1] === "end-card" && order.slice(1, -1).every((p) => p === "counter-stat");
  if (stockOrder && !askedFor(asked, /\d{2,}|\d\s?%|\bstat(?:s|istic|istics)?\b|\bnumbers?\b|\bcounter\b/i)) {
    add("stock-preset-order", "scenes 1 to " + n, "The plan is the default order: title, stat, end card.", "Shape the beats from the content (a puzzle, a reveal, a payoff). Drop the stat unless the person gave a number, and write scene 2 as html for the one thing this video shows.");
  }

  return finish(problems, stats);
}

// ------------------------------------------------------------ lintNarration

const PAUSE_SPLIT = /[,.;:!?\u2026\u2014\u2013()]+|\s-{1,2}\s/;
const JOINERS = new Set(["and", "but", "so", "because", "then", "when", "which", "while", "or", "before", "after", "if", "where", "that"]);

function lintNarration(lines, opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const { problems, add } = collector(o);
  const texts = (Array.isArray(lines) ? lines : lines == null ? [] : [lines])
    .map((l) => String(typeof l === "string" ? l : (l && l.text) || "").trim())
    .filter(Boolean);
  const counts = texts.map((t) => wordsOf(t).length);
  const n = texts.length;
  const stats = { lines: n, wordCounts: counts };

  // ---- breath: a long stretch with no pause mark (any number of lines)
  texts.forEach((text, i) => {
    let worst = "";
    let worstCount = 0;
    for (const seg of text.split(PAUSE_SPLIT)) {
      const c = wordsOf(seg).length;
      if (c > worstCount) {
        worstCount = c;
        worst = seg;
      }
    }
    if (worstCount <= 14) return;
    const words = wordsOf(worst);
    const mid = Math.round(words.length / 2);
    let at = -1;
    for (let k = 5; k < words.length - 3; k += 1) {
      if (JOINERS.has(words[k].toLowerCase()) && (at < 0 || Math.abs(k - mid) < Math.abs(at - mid))) at = k;
    }
    const fix = at >= 0
      ? "Put a comma before \"" + words[at] + "\" (after word " + at + "), or end the sentence there."
      : "Put a comma or a period after \"" + words[mid - 1] + "\" (about word " + mid + "), or split it into two lines.";
    add("no-breath", "line " + (i + 1), "Line " + (i + 1) + " runs " + worstCount + " words with no comma or stop: \"" + shorten(text, 60) + "\".", fix);
  });

  // One or two lines have no room for a mix.
  if (n < 3) return finish(problems, stats);

  const min = Math.min(...counts);
  const max = Math.max(...counts);
  const shortest = counts.indexOf(min) + 1;
  const longest = counts.indexOf(max) + 1;
  const other = (avoid) => {
    for (let i = 0; i < n; i += 1) if (i + 1 !== avoid) return i + 1;
    return 1;
  };
  if (n >= 4 && max - min <= 2) {
    const cut = shortest;
    const grow = longest !== cut ? longest : other(cut);
    add("every-line-same-length", "lines 1 to " + n, "All " + n + " lines run " + (min === max ? min : min + " to " + max) + " words, so the voice never changes pace.", "Cut line " + cut + " to 5 words or fewer and let line " + grow + " run to 14 or more, with a comma where the breath goes.");
  } else if (n >= 4 && min >= 6 && max <= 14) {
    const cut = shortest;
    const grow = longest !== cut ? longest : other(cut);
    add("every-line-medium", "lines 1 to " + n, "Every line is between 6 and 14 words (" + listOf(counts) + ").", "Cut line " + cut + " to 5 words or fewer and let line " + grow + " run to 14 or more, with a comma where the breath goes.");
  } else if (n >= 4) {
    if (min > 5) add("line-length-mix", "lines 1 to " + n, "No line has 5 words or fewer (the lines run " + listOf(counts) + " words).", "Cut line " + shortest + " to 2 to 5 words: the hook or the reveal reads best short.");
    else if (max < 14) add("line-length-mix", "lines 1 to " + n, "No line has 14 words or more (the lines run " + listOf(counts) + " words).", "Let line " + longest + " run to 14 to 20 words, with a comma where the breath goes.");
    // Three neighbours within a word of each other.
    for (let i = 0; i + 2 < n; i += 1) {
      const trio = counts.slice(i, i + 3);
      if (Math.min(...trio) >= 4 && Math.max(...trio) - Math.min(...trio) <= 1) {
        add("line-length-mix", "lines " + (i + 1) + " to " + (i + 3), "Lines " + (i + 1) + ", " + (i + 2) + " and " + (i + 3) + " run " + listOf(trio) + " words, one after the other.", "Change line " + (i + 2) + ": cut it to under 5 words or let it run past 14.");
        break;
      }
    }
  } else if (min >= 4 && max - min <= 1) {
    add("line-length-mix", "lines 1 to 3", "All 3 lines run " + (min === max ? min : min + " to " + max) + " words.", "Cut line " + shortest + " to 5 words or fewer, or let line " + (longest !== shortest ? longest : other(shortest)) + " run past 14.");
  }
  return finish(problems, stats);
}

// ------------------------------------------------------------ lintAudioPlan

function lintAudioPlan(audios, opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const { problems, add, asked } = collector(o);
  const known = o.tracks && typeof o.tracks === "object" ? o.tracks : {};
  const kindFor = (id) => {
    const t = known[id];
    const k = typeof t === "string" ? t : t && t.kind;
    return k === "voice" || k === "music" ? k : "";
  };
  const list = (Array.isArray(audios) ? audios : []).filter((a) => a && typeof a === "object" && a.audioId);
  const tracks = list.map((a, i) => {
    const scene = Number(a.scene) || 0;
    const loop = a.loop === true;
    return {
      n: i + 1,
      id: String(a.audioId),
      volume: a.volume == null || !Number.isFinite(Number(a.volume)) ? 1 : Number(a.volume),
      loop,
      scene,
      startMs: Number(a.startMs) || 0,
      duck: a.duck,
      kind: kindFor(String(a.audioId)) || (scene > 0 ? "voice" : loop ? "music" : ""),
      sure: Boolean(kindFor(String(a.audioId))) || scene > 0 || loop,
    };
  });
  const ids = (Array.isArray(o.audioIds) ? o.audioIds : []).map((x) => String(x || "")).filter(Boolean);
  const stats = { tracks: tracks.length || ids.length, voices: tracks.filter((t) => t.kind === "voice").length, beds: tracks.filter((t) => t.kind === "music").length };
  if (askedFor(asked, /\bloud(?:er)? music\b|\bmusic (?:loud|louder|up)\b|\bfull volume\b|\bturn (?:the )?music up\b/i)) return finish(problems, stats);

  const voices = tracks.filter((t) => t.kind === "voice");
  const beds = tracks.filter((t) => t.kind === "music");
  const unknown = tracks.filter((t) => !t.kind);
  const duckNote = (bed) => (bed.duck != null ? " Its duck value does not lower it: duck only lowers a clip's own sound, and an animation has none." : "");
  if (beds.length && voices.length) {
    for (const bed of beds) {
      const under = voices.length + (voices.length === 1 ? " voice line" : " voice lines");
      if (bed.volume >= 0.8) add("music-over-voice", "audios " + bed.n, "The music bed (audios entry " + bed.n + ") plays at volume " + bed.volume + " under " + under + ", as loud as the voice." + duckNote(bed), "Set that entry's volume to 0.2 to 0.3 so the voice sits on top.");
      else if (bed.volume > 0.5) add("bed-loud-under-voice", "audios " + bed.n, "The music bed (audios entry " + bed.n + ") plays at volume " + bed.volume + " under " + under + "." + duckNote(bed), "Bring it down to 0.2 to 0.3. A bed above half level competes with the voice.");
    }
  } else if (beds.length && unknown.length) {
    for (const bed of beds) {
      if (bed.volume >= 0.8) add("bed-loud-under-voice", "audios " + bed.n, "The looping track (audios entry " + bed.n + ") plays at volume " + bed.volume + " together with " + unknown.length + " other " + (unknown.length === 1 ? "track" : "tracks") + "." + duckNote(bed), "If the other track is a voice, set the bed's volume to 0.2 to 0.3.");
    }
  } else if (!beds.length && !voices.length && unknown.length >= 2) {
    const level = unknown[0].volume;
    if (unknown.every((t) => t.volume === level && t.startMs === unknown[0].startMs)) add("tracks-at-one-level", "audios 1 to " + unknown.length, unknown.length + " tracks start together at volume " + level + ".", "If one is music under a voice, set its volume to 0.2 to 0.3 and add loop: true so it reads as the bed.");
  }
  if (!tracks.length && ids.length >= 2) {
    const kinds = ids.map(kindFor);
    if (kinds.includes("voice") && kinds.includes("music")) add("music-over-voice", "audioIds", "audioIds mixes the voice and the music at the same level.", "Pass audios instead: the voice at volume 1 and the bed as {audioId, volume: 0.25, loop: true}.");
    else add("tracks-at-one-level", "audioIds", "audioIds mixes " + ids.length + " tracks at one level from the first second.", "If one is music under a voice, pass audios instead, with the bed as {audioId, volume: 0.25, loop: true}.");
  }
  for (const v of voices) if (v.loop && v.scene > 0) add("voice-looped", "audios " + v.n, "The voice line for scene " + v.scene + " (audios entry " + v.n + ") is set to loop.", "Take loop off that entry. Only a music bed loops.");
  return finish(problems, stats);
}

// ------------------------------------------------------------ lintVideoPlan

// input: the raw jeditor_render_animation or jeditor_animation_frames
// arguments. A single beat (no scenes) has nothing to vary, so only its
// audio plan is read. lines (jeditor_tts) are checked when present.
function lintVideoPlan(input, opts) {
  const args = input && typeof input === "object" ? input : {};
  const o = opts && typeof opts === "object" ? opts : {};
  const problems = [];
  const stats = {};
  const merge = (result, key) => {
    for (const p of result.problems) if (!problems.some((x) => x.rule === p.rule && x.what === p.what)) problems.push(p);
    stats[key] = result.stats;
  };
  const audios = Array.isArray(args.audios) ? args.audios.filter((a) => a && typeof a === "object") : [];
  if (Array.isArray(args.scenes) && args.scenes.length) {
    const voicedScenes = audios.map((a) => Number(a.scene) || 0).filter(Boolean);
    merge(lintScenes(args.scenes, Object.assign({}, o, { transition: args.transition, transitionMs: args.transitionMs, voicedScenes })), "scenes");
  }
  if (audios.length || (Array.isArray(args.audioIds) && args.audioIds.length)) {
    merge(lintAudioPlan(audios, Object.assign({}, o, { audioIds: audios.length ? [] : args.audioIds })), "audio");
  }
  const lines = Array.isArray(args.lines) ? args.lines : Array.isArray(o.lines) ? o.lines : null;
  if (lines && lines.length >= 2) merge(lintNarration(lines, o), "narration");
  return finish(problems, stats);
}

// One sentence for a refusal or a note: the first problem and its fix.
function summary(result) {
  const r = result || {};
  const list = Array.isArray(r.problems) ? r.problems : [];
  if (!list.length) return "";
  const p = list[0];
  return String(p.what).trim() + " " + String(p.fix).trim() + (list.length > 1 ? " (" + (list.length - 1) + " more)" : "");
}

module.exports = { lintScenes, lintNarration, lintAudioPlan, lintVideoPlan, PACING_RULES, summary };
