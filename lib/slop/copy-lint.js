"use strict";

// Static lint for the words an agent writes for a video: card and animation
// copy, end card actions, voiceover scripts, caption text, file and item
// names. It is the mechanical form of skills/writing-slop/SKILL.md and of the
// wording rules in lib/user-rules.js. Pure: no file access, no app state.
//
//   visibleText(html) -> string[]   the text runs a viewer would read
//   lintCopy(texts, opts) -> { verdict, problems, stats }
//
// Verdict and density
//   A hard problem alone makes the verdict "slop": the phrase forms the skill
//   bans outright ("not just X but Y", em dashes, emoji, hashtags, hype
//   openers, hollow closers, button copy, stock question hooks).
//   A soft problem is a tell. One tell is a choice, so the verdict is "tells".
//   The piece is "slop" when three or more different soft rules fire on it,
//   the same limit lib/slop/gate.js uses across design, copy and pacing.
//   Repeats inside one rule are judged by how dense they are for the kind:
//     card, cta   two stock words in one sentence, or three in the piece, are
//                 hard ("stock-words-stacked"). Two lists of three is a tell,
//                 three (or two on most lines) is hard.
//     script      two stock words in one sentence are hard; three across the
//                 script are hard only at one per 40 words or denser, since a
//                 script is long. Missing contractions need two stiff forms
//                 and no contraction at all.
//     caption     the speaker's own words: only emoji and hashtags.
//     name        file and item names: the ban list only.
//
// What the person typed is never flagged: a word, phrase, figure, link or
// whole line present in opts.asked (or opts.allow) passes, unless they typed
// it to rule it out ("no emoji", "never say unlock"). opts.allow may also
// hold rule ids to switch off.

// ------------------------------------------------------------ text plumbing

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00A0", shy: "\u00AD",
  mdash: "\u2014", ndash: "\u2013", horbar: "\u2015", hellip: "\u2026",
  lsquo: "\u2018", rsquo: "\u2019", sbquo: "\u201A", ldquo: "\u201C", rdquo: "\u201D", bdquo: "\u201E",
  laquo: "\u00AB", raquo: "\u00BB", copy: "\u00A9", reg: "\u00AE", trade: "\u2122",
  bull: "\u2022", middot: "\u00B7", rarr: "\u2192", larr: "\u2190", uarr: "\u2191", darr: "\u2193",
  harr: "\u2194", rArr: "\u21D2", times: "\u00D7", divide: "\u00F7", minus: "\u2212",
  hyphen: "\u2010", dash: "\u2010", zwj: "\u200D", zwnj: "\u200C", ZeroWidthSpace: "\u200B",
  NoBreak: "\u2060", lrm: "\u200E", rlm: "\u200F", ensp: "\u2002", emsp: "\u2003", thinsp: "\u2009",
  hairsp: "\u200A", numsp: "\u2007", puncsp: "\u2008", deg: "\u00B0", percnt: "%", num: "#",
  excl: "!", quest: "?", colon: ":", semi: ";", comma: ",", period: ".", sol: "/", lpar: "(",
  rpar: ")", commat: "@", dollar: "$", check: "\u2713", starf: "\u2605", star: "\u2606",
  hearts: "\u2665", euro: "\u20AC", pound: "\u00A3", cent: "\u00A2", yen: "\u00A5", plusmn: "\u00B1",
  frac12: "\u00BD", lowbar: "_", ast: "*", plus: "+", equals: "=", Tab: "\t", NewLine: "\n",
};
// Accented letters: &eacute; &uuml; &ntilde; and the rest of that family.
{
  const marks = { acute: 0x301, grave: 0x300, circ: 0x302, uml: 0x308, tilde: 0x303, cedil: 0x327, ring: 0x30a, caron: 0x30c };
  for (const letter of "AEIOUYNCSZaeiouyncsz") {
    for (const name of Object.keys(marks)) {
      const ch = (letter + String.fromCharCode(marks[name])).normalize("NFC");
      if (ch.length === 1) NAMED_ENTITIES[letter + name] = ch;
    }
  }
  Object.assign(NAMED_ENTITIES, { szlig: "\u00DF", aelig: "\u00E6", AElig: "\u00C6", oslash: "\u00F8", Oslash: "\u00D8", iexcl: "\u00A1", iquest: "\u00BF", sect: "\u00A7", para: "\u00B6", micro: "\u00B5", infin: "\u221E", ne: "\u2260", le: "\u2264", ge: "\u2265", prime: "\u2032", Prime: "\u2033" });
}
// Names a browser decodes even without the closing semicolon.
const LEGACY_ENTITIES = new Set(["amp", "lt", "gt", "quot", "nbsp", "shy", "copy", "reg"]);

// Characters that take no space on screen. A ban word split by one of these
// still reads as the word, so they are dropped before anything is matched.
const INVISIBLE_RE = /[\u00AD\u034F\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

function decodeEntities(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*)(;?)/gi, (all, body, semi) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return all;
      try {
        return String.fromCodePoint(code);
      } catch {
        return all;
      }
    }
    const hit = Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body) ? body : Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body.toLowerCase()) ? body.toLowerCase() : "";
    if (!hit) return all;
    if (!semi && !LEGACY_ENTITIES.has(hit)) return all;
    return NAMED_ENTITIES[hit];
  });
}

const INLINE_TAGS = new Set([
  "a", "abbr", "b", "bdi", "bdo", "big", "cite", "code", "data", "del", "dfn", "em", "font", "i", "ins", "kbd",
  "mark", "nobr", "q", "s", "samp", "small", "span", "strike", "strong", "sub", "sup", "time", "tt", "u", "var",
  "tspan", "textpath", "label",
]);
const SEAM_CLOSE = "\u0001";
const SEAM_OPEN = "\u0002";

const isUpper = (ch) => ch !== ch.toLowerCase();
const isLower = (ch) => ch !== ch.toUpperCase();

// Where an inline tag sat between two characters with no space: join them
// when the tag was inside a word (<b>un</b>lock, one span per letter), put a
// space when two elements only touch in the source (one span per word).
function resolveSeams(raw) {
  if (raw.indexOf(SEAM_CLOSE) < 0 && raw.indexOf(SEAM_OPEN) < 0) return raw;
  const parts = raw.split(/([\u0001\u0002]+)/);
  let out = parts[0];
  let pieceStart = 0;
  for (let i = 1; i < parts.length; i += 2) {
    const seam = parts[i];
    const next = parts[i + 1] || "";
    const left = out.slice(-1);
    const right = next.charAt(0);
    if (!left || !right || /\s/.test(left) || /\s/.test(right)) {
      pieceStart = out.length;
      out += next;
      continue;
    }
    const sibling = /\u0001[\u0001\u0002]*\u0002/.test(seam);
    let join;
    if (sibling) {
      const lastSpace = Math.max(out.lastIndexOf(" "), out.lastIndexOf("\n"), out.lastIndexOf("\t"));
      const leftLen = out.length - Math.max(pieceStart, lastSpace + 1);
      const rightLen = (next.match(/^\S+/) || [""])[0].length;
      join = leftLen === 1 && rightLen === 1;
    } else {
      join = !(isUpper(right) && (isLower(left) || /[.,!?;:]/.test(left)));
    }
    pieceStart = out.length + (join ? 0 : 1);
    out += (join ? "" : " ") + next;
  }
  return out;
}

function tidyRun(raw) {
  return resolveSeams(raw).replace(/[\s\u00A0]+/g, " ").trim();
}

// The text runs in markup only (no script or style mining).
function htmlRuns(html) {
  let s = String(html == null ? "" : html);
  s = s.replace(/<!--[\s\S]*?(?:-->|$)/g, " ");
  s = s.replace(/<(script|style|title|desc|metadata|noscript|template|head)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, " ");
  // A counter that starts at 0 and counts to a data attribute shows that
  // number, so the number is the text.
  s = s.replace(
    /<([a-z][\w-]*)\b([^>]*\bdata-(?:v|val|value|count|to|target|num|number|end|stat)\s*=\s*["']?(-?[\d.,]+)["']?[^>]*)>([^<]*)<\//gi,
    (all, tag, attrs, value, inner) => (/^[\s\d.,%$+\-]*$/.test(inner) ? "<" + tag + attrs + ">" + value + "</" : all),
  );
  const runs = [];
  const extra = [];
  let run = "";
  const flush = () => {
    const text = tidyRun(run);
    run = "";
    if (text) runs.push(text);
  };
  const text = (chunk) => {
    run += decodeEntities(chunk).replace(INVISIBLE_RE, "");
  };
  const tagRe = /<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
  let last = 0;
  let m;
  while ((m = tagRe.exec(s))) {
    text(s.slice(last, m.index));
    last = tagRe.lastIndex;
    const name = m[2].toLowerCase();
    if (name === "br") run += " ";
    else if (name === "wbr") continue;
    else if (name === "img") run += " ";
    else if (name === "input" || name === "textarea") {
      const attrs = m[3] || "";
      const pick = (attr) => {
        const hit = attrs.match(new RegExp("\\b" + attr + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s\"'>]+))", "i"));
        return hit ? decodeEntities(hit[1] != null ? hit[1] : hit[2] != null ? hit[2] : hit[3] || "") : "";
      };
      const type = pick("type").toLowerCase();
      if (pick("placeholder")) extra.push(pick("placeholder"));
      if ((type === "button" || type === "submit") && pick("value")) extra.push(pick("value"));
      flush();
    } else if (INLINE_TAGS.has(name)) run += m[1] ? SEAM_CLOSE : SEAM_OPEN;
    else flush();
  }
  text(s.slice(last));
  flush();
  for (const item of extra) {
    const t = tidyRun(item.replace(INVISIBLE_RE, ""));
    if (t) runs.push(t);
  }
  return runs;
}

// ---- words a script writes into the page

function readEscape(src, at) {
  // src[at] is the backslash. Returns [text, next index].
  const c = src[at + 1];
  if (c == null) return ["", at + 1];
  const simple = { n: "\n", t: "\t", r: "\r", b: "", f: "", v: "", 0: "" };
  if (Object.prototype.hasOwnProperty.call(simple, c)) return [simple[c], at + 2];
  if (c === "\n") return ["", at + 2];
  if (c === "\r") return ["", src[at + 2] === "\n" ? at + 3 : at + 2];
  if (c === "x" && /^[0-9a-f]{2}$/i.test(src.substr(at + 2, 2))) return [String.fromCharCode(parseInt(src.substr(at + 2, 2), 16)), at + 4];
  if (c === "u") {
    const brace = src.slice(at + 2).match(/^\{([0-9a-f]{1,6})\}/i);
    if (brace) {
      try {
        return [String.fromCodePoint(parseInt(brace[1], 16)), at + 2 + brace[0].length];
      } catch {
        return ["", at + 2 + brace[0].length];
      }
    }
    if (/^[0-9a-f]{4}$/i.test(src.substr(at + 2, 4))) return [String.fromCharCode(parseInt(src.substr(at + 2, 4), 16)), at + 6];
  }
  return [c, at + 2];
}

// Every string literal in a script, with where it sits. Comments and regex
// literals are skipped so a quote inside one does not start a string.
function jsLiterals(src) {
  const out = [];
  const n = src.length;
  let i = 0;
  let lastSig = "";
  while (i < n) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      const e = src.indexOf("\n", i);
      i = e < 0 ? n : e;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const e = src.indexOf("*/", i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (c === "/" && (lastSig === "" || "(,=:[!&|?{};+-*%<>~^".includes(lastSig) || /\b(?:return|typeof|case|do|else)$/.test(src.slice(Math.max(0, i - 8), i).trimEnd()))) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n && src[j] !== "\n") {
        const d = src[j];
        if (d === "\\") {
          j += 2;
          continue;
        }
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) {
          closed = true;
          break;
        }
        j += 1;
      }
      if (closed) {
        i = j + 1;
        lastSig = "/";
        continue;
      }
    }
    if (c === '"' || c === "'" || c === "`") {
      const start = i;
      let j = i + 1;
      let value = "";
      while (j < n) {
        const d = src[j];
        if (d === "\\") {
          const [textPart, next] = readEscape(src, j);
          value += textPart;
          j = next;
          continue;
        }
        if (d === c) break;
        if (c !== "`" && d === "\n") break;
        if (c === "`" && d === "$" && src[j + 1] === "{") {
          let depth = 1;
          j += 2;
          while (j < n && depth > 0) {
            if (src[j] === "{") depth += 1;
            else if (src[j] === "}") depth -= 1;
            j += 1;
          }
          value += " ";
          continue;
        }
        value += d;
        j += 1;
      }
      out.push({ value, start, end: Math.min(j, n - 1) });
      i = j + 1;
      lastSig = c;
      continue;
    }
    if (!/\s/.test(c)) lastSig = c;
    i += 1;
  }
  return out;
}

const FONT_NAMES = /\b(?:sans-serif|serif|monospace|system-ui|ui-sans-serif|Segoe UI|Georgia|Arial|Helvetica|Times New Roman|Courier|Consolas|Impact|Verdana|Tahoma|Trebuchet|Palatino|Constantia|Corbel|Calibri|Cambria|Garamond|Futura|Roboto|Menlo|Monaco|Bahnschrift|Candara|Rockwell)\b/i;
const CODE_TOKENS = /^(?:ease|linear|ease-in|ease-out|ease-in-out|both|forwards|backwards|infinite|none|block|inline|inline-block|flex|grid|absolute|relative|fixed|hidden|visible|center|left|right|top|bottom|middle|baseline|alphabetic|round|butt|square|miter|bevel|source-over|lighter|screen|multiply|overlay|transparent|currentcolor|inherit|auto|uppercase|lowercase|capitalize|nowrap|pointer|2d|webgl|div|span|canvas|svg|path|rect|circle|line|text|g|p|h1|h2|h3|ul|li|img|click|load|resize|domcontentloaded|function|string|number|object|undefined|boolean|chars|words|use strict)$/i;

// True for a literal that is code, a selector, a css value or a file name
// rather than words for the screen.
function codeish(value) {
  const t = String(value).trim();
  if (!t) return true;
  if (!/\p{L}/u.test(t)) return true;
  if (CODE_TOKENS.test(t)) return true;
  if (/[{}<>\\]|;\s*\S|=>|==|\|\||&&|\(\)|\$\(|\+\s*$/.test(t)) return true;
  if (/^[.#@\[*:>~+]/.test(t)) return true;
  if (/(?:^|[\s,(:-])\d*\.?\d+(?:px|r?em|vmin|vmax|vw|vh|ms|deg|fr|pt)\b/i.test(t)) return true;
  if (/\b(?:rgba?|hsla?|var|calc|translate(?:[xyz]|3d)?|scale[xyz]?|rotate[xyz]?|skew[xy]?|cubic-bezier|steps|url|linear-gradient|radial-gradient|conic-gradient|blur|inset|matrix|perspective|color-mix)\(/i.test(t)) return true;
  if (/^(?:https?:|data:|blob:|file:|\.{0,2}\/)|\.(?:png|jpe?g|gif|svg|webp|mp[34]|wav|ogg|json|js|css|html?|woff2?|ttf)$/i.test(t)) return true;
  if (/^[a-z]+(?:[A-Z][a-z0-9]*)+$/.test(t) || /^[a-z0-9]+(?:[-_][a-z0-9]+)+$/.test(t) || /^[A-Z0-9]+(?:_[A-Z0-9]+)+$/.test(t)) return true;
  if (FONT_NAMES.test(t) && (t.includes(",") || t.split(/\s+/).length <= 3)) return true;
  return false;
}

const CTX_SKIP_CALL = /(?:\b(?:console\.\w+|querySelector(?:All)?|getElementById|getElementsBy\w+|addEventListener|removeEventListener|getAttribute|setAttribute|removeAttribute|hasAttribute|setProperty|getPropertyValue|removeProperty|createElement(?:NS)?|getContext|matches|closest|require|animate|indexOf|includes|startsWith|endsWith|split|join|padStart|padEnd|getItem|setItem|dispatchEvent|postMessage|__jvError)|\.(?:add|remove|toggle|contains|replace|replaceAll|item)|\bnew\s+\w*Error|\bnew\s+(?:Event|CustomEvent|RegExp|URL)|\bimport)\s*\(\s*(?:[^()'"`]*,\s*)?$/;
const CTX_SKIP_PROP = /\.(?:style(?:\.[\w$]+)?|className|id|font|fillStyle|strokeStyle|textAlign|textBaseline|cssText|src|href|type|lineCap|lineJoin|globalCompositeOperation|shadowColor|filter|direction|dataset\.[\w$]+|name|rel|target|method|crossOrigin)\s*\+?=\s*$/;
const CTX_TEXT = /(?:\.(?:textContent|innerText|innerHTML|outerHTML|nodeValue|placeholder)\s*\+?=|\b(?:fillText|strokeText|createTextNode)\s*\(|\binsertAdjacent(?:HTML|Text)\s*\(|\bdocument\.write(?:ln)?\s*\()/;
const NAME_HINT = /(?:^|[^A-Za-z0-9_$])[A-Za-z_$]*?(?:text|txt|title|headline|heading|label|caption|quote|lines?|words?|cta|tagline|msg|message|copy|button|btn|author|role|eyebrow|kicker|desc|description|handle|phrase|sentence|slogan|hook|punchline|script|narration|subtitle|items?|steps?|bullets?|points?)[A-Za-z0-9_$]*\s*[:=]\s*(?:\[\s*)?$/i;

function proseLike(value) {
  const words = String(value).match(/[\p{L}][\p{L}'\u2019-]*/gu) || [];
  if (words.length >= 3) return true;
  return words.length === 2 && /^\s*["'(]?\p{Lu}/u.test(value);
}

// Text literals a script puts on screen: textContent, innerHTML and canvas
// text, arrays of words for a typewriter or a slam, named text fields, any
// sentence, and the number a JV.count counter ends on.
function scriptTexts(js, depth) {
  const src = String(js == null ? "" : js);
  const level = depth || 0;
  if (!src.trim()) return [];
  const literals = jsLiterals(src);
  const out = [];
  const push = (value) => {
    const v = String(value).replace(INVISIBLE_RE, "");
    if (/<[a-zA-Z!\/][^>]*>/.test(v)) {
      for (const run of htmlRuns(v)) out.push(run);
      return;
    }
    const t = decodeEntitiesLoose(v).replace(/[\s\u00A0]+/g, " ").trim();
    if (t) out.push(t);
  };
  // Arrays made only of string literals.
  const inArray = new Map();
  {
    let skeleton = "";
    let at = 0;
    literals.forEach((lit, index) => {
      skeleton += src.slice(at, lit.start) + "\u0000" + index + "\u0000";
      at = lit.end + 1;
    });
    skeleton += src.slice(at);
    const arrayRe = /\[\s*(?:\u0000\d+\u0000\s*,\s*)+\u0000\d+\u0000\s*,?\s*\]/g;
    let m;
    while ((m = arrayRe.exec(skeleton))) {
      const ids = (m[0].match(/\u0000(\d+)\u0000/g) || []).map((x) => Number(x.replace(/\u0000/g, "")));
      const before = skeleton.slice(Math.max(0, m.index - 60), m.index).replace(/\u0000\d+\u0000/g, '""');
      if (/[\w$)\]]\s*$/.test(before)) continue; // obj["a", "b"] is not an array of words
      const values = ids.map((id) => literals[id].value);
      const plain = values.filter((v) => !codeish(v));
      if (plain.length < Math.ceil(values.length / 2)) continue;
      const named = NAME_HINT.test(before + "[");
      const spaced = plain.some((v) => /\p{L}\s+\p{L}/u.test(v));
      const capped = plain.every((v) => /^\s*["'(]?[\p{Lu}\d]/u.test(v));
      if (!named && !spaced && !capped) continue;
      // One word per entry (a typewriter, a slam): the viewer reads them as one line.
      const single = plain.length >= 2 && plain.length <= 12 && plain.length === values.length && plain.every((v) => !/\s/.test(v.trim()));
      ids.forEach((id, k) => inArray.set(id, single ? (k === 0 ? { joined: plain.map((v) => v.trim()).join(" ") } : { skip: true }) : true));
    }
  }
  literals.forEach((lit, index) => {
    const value = lit.value;
    if (!value.trim()) return;
    const before = src.slice(Math.max(0, lit.start - 90), lit.start);
    const after = src.slice(lit.end + 1, lit.end + 14);
    // Code inside a string (new Function("..."), a wrapped script): look inside.
    if (value.length > 40 && /\b(?:function|var|const|let|return)\b|=>/.test(value) && /[;(){}]/.test(value)) {
      if (level < 2) for (const t of scriptTexts(value, level + 1)) out.push(t);
      return;
    }
    if (inArray.has(index)) {
      const tag = inArray.get(index);
      if (tag && tag.skip) return;
      if (tag && tag.joined) {
        push(tag.joined);
        return;
      }
      if (!codeish(value) || /<[a-zA-Z][^>]*>/.test(value)) push(value);
      return;
    }
    if (/[!=]==?\s*$/.test(before) || /^\s*[!=]==?/.test(after) || /\bcase\s*$/.test(before)) return;
    if (/^\s*:/.test(after) && /[{,]\s*$/.test(before)) return; // an object key
    if (/[\w$)\]]\s*\[\s*$/.test(before) && /^\s*\]/.test(after)) return; // obj["key"]
    if (CTX_SKIP_CALL.test(before) || CTX_SKIP_PROP.test(before)) return;
    const stmtStart = Math.max(before.lastIndexOf(";"), before.lastIndexOf("{"), before.lastIndexOf("}"), before.lastIndexOf("\n")) + 1;
    const stmt = before.slice(stmtStart);
    if (CTX_TEXT.test(stmt)) {
      if (/<[a-zA-Z][^>]*>/.test(value) || !/^[\s.#\[]?[\w-]*$/.test(value) || /\p{L}/u.test(value)) push(value);
      return;
    }
    if (/<[a-zA-Z][^>]*>[^<]*\p{L}/u.test(value)) {
      push(value);
      return;
    }
    if (codeish(value)) return;
    if (NAME_HINT.test(before) || proseLike(value)) push(value);
  });
  // JV.count(t, start, dur, to, {prefix, suffix, decimals}): the end value.
  const countRe = /JV\.count\(\s*[^,()]+,\s*[^,()]+,\s*[^,()]+,\s*([A-Za-z_$][\w$]*|-?[\d.]+(?:e\d+)?)\s*(?:,\s*\{([^}]*)\})?/g;
  const numberOf = (token) => {
    if (/^-?[\d.]/.test(token)) return Number(token);
    const hit = src.match(new RegExp("(?:^|[^\\w$.])" + token.replace(/\$/g, "\\$") + "\\s*=\\s*(-?[\\d.]+(?:e\\d+)?)"));
    return hit ? Number(hit[1]) : NaN;
  };
  const stringOf = (token) => {
    const t = String(token || "").trim();
    const quoted = t.match(/^(["'])(.*)\1$/);
    if (quoted) return quoted[2];
    if (!/^[A-Za-z_$][\w$]*$/.test(t)) return "";
    const hit = src.match(new RegExp("(?:^|[^\\w$.])" + t.replace(/\$/g, "\\$") + "\\s*=\\s*([\"'])((?:\\\\.|(?!\\1).)*)\\1"));
    return hit ? hit[2] : "";
  };
  let cm;
  while ((cm = countRe.exec(src))) {
    const to = numberOf(cm[1]);
    if (!Number.isFinite(to)) continue;
    const optsText = cm[2] || "";
    const opt = (key) => {
      const hit = optsText.match(new RegExp("\\b" + key + "\\s*:\\s*(\"[^\"]*\"|'[^']*'|[A-Za-z_$][\\w$]*|-?[\\d.]+)"));
      return hit ? hit[1] : "";
    };
    const decToken = opt("decimals");
    const dec = decToken ? numberOf(decToken) : 0;
    const digits = Number.isFinite(dec) ? Math.max(0, Math.min(4, dec)) : 0;
    const parts = Number(to).toFixed(digits).split(".");
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    const shown = stringOf(opt("prefix")) + parts.join(".") + stringOf(opt("suffix"));
    if (shown.trim()) out.push(shown.trim());
  }
  return out;
}

function decodeEntitiesLoose(text) {
  return /&[#a-zA-Z]/.test(text) ? decodeEntities(text) : text;
}

// content: "..." in a stylesheet is text on screen too.
function cssTexts(css) {
  const out = [];
  const re = /\bcontent\s*:\s*(["'])((?:\\[\s\S]|(?!\1)[^\\])*)\1/g;
  let m;
  while ((m = re.exec(String(css == null ? "" : css)))) {
    const value = m[2]
      .replace(/\\([0-9a-f]{1,6})\s?/gi, (all, hex) => {
        try {
          return String.fromCodePoint(parseInt(hex, 16));
        } catch {
          return "";
        }
      })
      .replace(/\\([\s\S])/g, "$1")
      .replace(INVISIBLE_RE, "")
      .replace(/[\s\u00A0]+/g, " ")
      .trim();
    if (value) out.push(value);
  }
  return out;
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

// The text a viewer would read from a card or animation document: markup
// text with tags, comments, style and script removed and entities decoded,
// one entry per block level run, then the words its script and css add.
function visibleText(html) {
  const source = String(html == null ? "" : html);
  const scripts = [];
  const styles = [];
  source.replace(/<script\b[^>]*>([\s\S]*?)(?:<\/script\s*>|$)/gi, (all, body) => {
    scripts.push(body);
    return "";
  });
  source.replace(/<style\b[^>]*>([\s\S]*?)(?:<\/style\s*>|$)/gi, (all, body) => {
    styles.push(body);
    return "";
  });
  const runs = htmlRuns(source);
  for (const css of styles) for (const t of cssTexts(css)) runs.push(t);
  for (const js of scripts) for (const t of scriptTexts(js)) runs.push(t);
  return dedupe(runs);
}

// ------------------------------------------------------------- normalising

const HOMOGLYPHS = {
  "\u0430": "a", "\u0435": "e", "\u043E": "o", "\u0440": "p", "\u0441": "c", "\u0445": "x", "\u0443": "y",
  "\u0456": "i", "\u0455": "s", "\u0458": "j", "\u0501": "d", "\u0410": "A", "\u0415": "E", "\u041E": "O",
  "\u0420": "P", "\u0421": "C", "\u0425": "X", "\u0406": "I", "\u039F": "O", "\u03BF": "o", "\u0391": "A",
  "\u0395": "E", "\u0399": "I", "\u03B9": "i",
};
const HOMOGLYPH_RE = new RegExp("[" + Object.keys(HOMOGLYPHS).join("") + "]", "g");

// Single ban words in the forms someone might split with a space, a hyphen
// or a tag. Two neighbours that join into one of these are read as the word.
const JOINABLE = new Set([
  "delve", "delves", "delving", "tapestry", "landscape", "realm", "seamless", "seamlessly", "elevate", "elevates",
  "elevated", "elevating", "unlock", "unlocks", "unlocked", "unlocking", "unleash", "unleashed", "empower",
  "empowers", "empowered", "empowering", "leverage", "leveraging", "robust", "streamline", "streamlined",
  "harness", "testament", "pivotal", "vibrant", "crucial", "gamechanger", "gamechanging", "revolutionary",
  "revolutionize", "revolutionise", "journey", "journeys", "ecosystem", "synergy", "paradigm", "effortless",
  "effortlessly", "discover",
]);

// One line of copy with its tricks removed, in its own case, for quoting and
// for the rule patterns (all case insensitive).
function clean(input) {
  let s = String(input == null ? "" : input);
  s = s.replace(INVISIBLE_RE, "").replace(/[\uFE0E\uFE0F]/g, "");
  let folded = s;
  try {
    folded = s.normalize("NFKC");
  } catch {
    folded = s;
  }
  s = folded
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u02BC\u00B4]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2212\uFE63\uFF0D]/g, "-")
    .replace(HOMOGLYPH_RE, (ch) => HOMOGLYPHS[ch])
    .replace(/(\*\*|~~|`)/g, "")
    .replace(/(^|[\s"'(])\*(?=\S)/g, "$1")
    .replace(/(\S)\*(?=[\s"'.,!?)]|$)/g, "$1")
    .replace(/[\s\u00A0]+/g, " ")
    .trim();
  // L E T T E R S spaced out, or dotted, read as the word.
  s = s.replace(/(?<![\p{L}\p{N}])(?:\p{L}[ ._\u00B7-]){3,}\p{L}(?![\p{L}\p{N}])/gu, (hit) => hit.replace(/[ ._\u00B7-]/g, ""));
  // A ban word broken in two or three ("seam less", "un-lock").
  s = s.replace(/(?<![\p{L}\p{N}])(\p{L}{1,10})[ -](\p{L}{1,10})(?:[ -](\p{L}{1,6}))?(?![\p{L}\p{N}])/gu, (hit, a, b, c) => {
    if (c && JOINABLE.has((a + b + c).toLowerCase())) return a + b + c;
    if (JOINABLE.has((a + b).toLowerCase())) return a + b + (c ? hit.slice(a.length + 1 + b.length) : "");
    return hit;
  });
  return s;
}

const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'-]*/gu;
const wordsOf = (text) => String(text).match(WORD_RE) || [];

function sentencesOf(text) {
  return String(text)
    .split(/(?<=[.!?\u2026])["')\]]?\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function shorten(text, max) {
  const t = String(text).replace(/\s+/g, " ").trim();
  const limit = max || 80;
  return t.length <= limit ? t : t.slice(0, limit - 3).replace(/\s+\S*$/, "") + "...";
}
const q = (text, max) => '"' + shorten(text, max).replace(/"/g, "'") + '"';
const esc = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ------------------------------------------------------- what the person typed

const NEGATION_CUE = /\b(?:no|not|never|don't|dont|do not|doesn't|avoid|without|ban|banned|stop|remove|delete|cut|drop|lose|kill|skip|hate|dislike|instead of|rather than|get rid of|less|fewer|isn't|aren't|won't|shouldn't|mustn't|can't|nothing like|anything like|too many|too much)\b/i;
const REPLACE_CUE = /\b(?:replace|change|swap|rename|rewrite|fix)\b([\s\S]*)$/i;

function makeAsked(asked, allow, ruleIds) {
  const parts = [];
  if (typeof asked === "string") parts.push(asked);
  else if (Array.isArray(asked)) for (const a of asked) parts.push(String(a == null ? "" : a));
  const allowList = (Array.isArray(allow) ? allow : typeof allow === "string" ? [allow] : []).map((a) => String(a == null ? "" : a).trim()).filter(Boolean);
  const off = new Set(allowList.filter((a) => ruleIds.has(a)));
  const allowed = allowList.filter((a) => !ruleIds.has(a));
  const known = parts.some((p) => p.trim()) || allowed.length > 0;
  // One entry per clause the person typed: a ban cue only reaches to the end
  // of its own clause.
  const clauses = [];
  // "DON'T: ...", "Avoid: ...", "Never use: ..." rule the whole line out, and a
  // line that ends in a colon with a ban cue rules out the list under it.
  const BAN_LABEL = /^\s*(?:[-*\u2022]\s*)?(?:don'?t|do not|never|avoid|no|not allowed|forbidden|banned?|ban list|stop|skip)\b[^:.!?]{0,40}:/i;
  const BULLET = /^\s*(?:[-*\u2022]|\d+[.)])\s+/;
  for (const part of parts) {
    let listBanned = false;
    for (const rawLine of part.split(/\r?\n/)) {
      const line = rawLine.replace(/[\u2018\u2019]/g, "'");
      if (!line.trim()) {
        listBanned = false;
        continue;
      }
      const isBullet = BULLET.test(line);
      if (!isBullet) listBanned = false;
      const banned = BAN_LABEL.test(line) || (listBanned && isBullet);
      if (!isBullet && /:\s*$/.test(line) && NEGATION_CUE.test(line)) listBanned = true;
      // Split into clauses at sentence ends and at "but", never inside quotes.
      const cuts = [0];
      const splitter = /(?<=[.!?;])\s+|\s+(?:but|instead|however)\s+/gi;
      let hit;
      while ((hit = splitter.exec(line))) {
        const quotes = (line.slice(0, hit.index).match(/["\u201C\u201D]/g) || []).length;
        if (quotes % 2 === 0) cuts.push(hit.index, hit.index + hit[0].length);
        if (hit[0] === "") splitter.lastIndex += 1;
      }
      cuts.push(line.length);
      for (let k = 0; k + 1 < cuts.length; k += 2) {
        const c = clean(line.slice(cuts[k], cuts[k + 1]));
        if (c) clauses.push({ text: c, lower: c.toLowerCase(), free: false, banned });
      }
    }
  }
  for (const a of allowed) {
    const c = clean(a);
    if (c) clauses.push({ text: c, lower: c.toLowerCase(), free: true });
  }
  const ruledOut = (clause, index) => {
    if (clause.free) return false;
    if (clause.banned) return true;
    const before = clause.text.slice(0, index);
    if (NEGATION_CUE.test(before)) return true;
    const swap = before.match(REPLACE_CUE);
    return Boolean(swap && !/\b(?:with|to|into|by|for)\b/i.test(swap[1]));
  };
  // True when the person typed something that matches, and not to rule it out.
  const typed = (pattern) => {
    for (const clause of clauses) {
      const re = pattern instanceof RegExp ? new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g") : new RegExp(esc(String(pattern)), "gi");
      let m;
      while ((m = re.exec(clause.text))) {
        if (!ruledOut(clause, m.index)) return true;
        if (m[0] === "") re.lastIndex += 1;
      }
    }
    return false;
  };
  const phrase = (text) => {
    const t = clean(text);
    if (!t) return false;
    const head = /^[\p{L}\p{N}]/u.test(t) ? "(?<![\\p{L}\\p{N}])" : "";
    const tail = /[\p{L}\p{N}]$/u.test(t) ? "(?![\\p{L}\\p{N}])" : "";
    return typed(new RegExp(head + esc(t).replace(/\s+/g, "\\s+") + tail, "giu"));
  };
  const numbers = new Set();
  const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000, million: 1000000, billion: 1000000000, half: 50, double: 2, twice: 2 };
  for (const clause of clauses) {
    if (clause.banned) continue;
    for (const value of figureValues(clause.text)) numbers.add(value);
    for (const w of clause.lower.match(/[a-z]+/g) || []) if (Object.prototype.hasOwnProperty.call(NUMBER_WORDS, w)) numbers.add(NUMBER_WORDS[w]);
  }
  return { known, typed, phrase, off, numbers, text: clauses.map((c) => c.lower).join("\n"), raw: parts.join("\n") };
}

// The numeric values in a text: "1,200", "1.2k", "2 million", "50%".
function figureValues(text) {
  const out = [];
  const re = /(\d[\d,]*(?:\.\d+)?)\s?(k|m|bn|b|million|billion|thousand|hundred)?\b/gi;
  let m;
  while ((m = re.exec(String(text)))) {
    let value = Number(m[1].replace(/,/g, ""));
    if (!Number.isFinite(value)) continue;
    const unit = (m[2] || "").toLowerCase();
    if (unit === "k" || unit === "thousand") value *= 1000;
    else if (unit === "m" || unit === "million") value *= 1000000;
    else if (unit === "b" || unit === "bn" || unit === "billion") value *= 1000000000;
    else if (unit === "hundred") value *= 100;
    out.push(value);
    if (unit) out.push(Number(m[1].replace(/,/g, "")));
  }
  return out;
}

// --------------------------------------------------------------- the rules

const COPY_RULES = [
  { id: "not-just-but", group: "frame", hard: true, title: "\"Not just X, but Y\", \"it's not X, it's Y\", \"more than just\", \"Not X. Not Y. Just Z.\"" },
  { id: "contrast-frame", group: "frame", hard: false, title: "A softer contrast frame: \"It's not X. It's Y.\", \"No X. No Y. Just Z.\", \"not just another X\"" },
  { id: "em-dash", group: "punctuation", hard: true, title: "An em dash, or --, a spaced en dash or a spaced hyphen standing in for one" },
  { id: "emoji", group: "punctuation", hard: true, title: "Emoji in copy" },
  { id: "hashtag", group: "punctuation", hard: true, title: "Hashtags nobody asked for" },
  { id: "unicode-ornament", group: "punctuation", hard: false, title: "Unicode arrows, check marks, stars and box characters as decoration" },
  { id: "exclamation-mark", group: "punctuation", hard: false, title: "An exclamation mark on a card" },
  { id: "colon-pivot", group: "punctuation", hard: false, title: "A colon pivot in a headline (\"The result: magic\")" },
  { id: "stock-opener", group: "phrase", hard: true, title: "Hype opener: \"In today's fast-paced world\", \"Imagine a world\", \"Let's dive in\", \"Here's the kicker\"" },
  { id: "question-hook", group: "phrase", hard: true, title: "Stock question hook: \"Ready to...?\", \"Tired of...?\", \"What if you could\", \"The result? Magic.\"" },
  { id: "bait-question", group: "phrase", hard: false, title: "A question aimed at the viewer as a headline (\"Want more like this?\")" },
  { id: "hollow-closer", group: "phrase", hard: true, title: "Hollow closer: \"Your journey starts here\", \"Take it to the next level\", \"The future is here\", \"Join us\"" },
  { id: "button-copy", group: "phrase", hard: true, title: "Stock button copy: \"Get Started\", \"Learn More\", \"Discover more\", \"Level up your\"" },
  { id: "stock-phrase", group: "phrase", hard: true, title: "Stock phrase: \"look no further\", \"say goodbye to\", \"whether you're X or Y\", \"unlock your potential\"" },
  { id: "ad-cliche", group: "phrase", hard: false, title: "A worn ad line: \"work smarter, not harder\", \"for creators, by creators\", \"Notes, reimagined\", \"all-in-one\"" },
  { id: "chatbot-reply", group: "phrase", hard: true, title: "A chat reply left in the copy (\"Great question\", \"Here's your script\", \"I hope this helps\")" },
  { id: "stock-word", group: "word", hard: false, title: "One stock word or soft stock phrase from the ban list (seamless, elevate, unlock, journey, \"transform your\")" },
  { id: "stock-words-stacked", group: "word", hard: true, title: "Stock words stacked: two in one sentence, or three in the piece" },
  { id: "hollow-triple", group: "structure", hard: true, title: "A list of three stock adjectives (\"Fast, simple, powerful\")" },
  { id: "rule-of-three-everywhere", group: "structure", hard: true, title: "Lists of three on most lines, or three of them in the piece" },
  { id: "rule-of-three", group: "structure", hard: false, title: "A second list of three (one per video is the limit)" },
  { id: "title-case", group: "structure", hard: false, title: "Title Case On The Lines" },
  { id: "one-rhythm", group: "structure", hard: false, title: "Every line the same length" },
  { id: "announce-recap", group: "structure", hard: false, title: "Announcing or recapping: \"Here are three reasons\", \"In summary\", a closing line that repeats the opening" },
  { id: "copula-dodge", group: "word", hard: false, title: "\"serves as\", \"stands as\", \"boasts\", \"features\" where \"is\" or \"has\" works" },
  { id: "trailing-ing", group: "word", hard: false, title: "A trailing -ing clause that claims significance (\", redefining how we create\")" },
  { id: "filler-adverb", group: "word", hard: false, title: "Magic adverbs and filler transitions: quietly, deeply, fundamentally, remarkably, \"It's worth noting\"" },
  { id: "shout-hook", group: "phrase", hard: false, title: "A hook that shouts (\"Stop scrolling\", \"You won't believe\")" },
  { id: "unsourced-claim", group: "fact", hard: false, title: "A figure, price, quote, link or \"studies show\" claim the person did not give" },
  { id: "no-contractions", group: "spoken", hard: false, title: "A script with no contractions" },
  { id: "stage-direction", group: "spoken", hard: false, title: "Stage directions in a script (\"[excited]\")" },
  { id: "semicolon-line", group: "spoken", hard: false, title: "A spoken line that needs a semicolon" },
  { id: "same-opener", group: "spoken", hard: false, title: "Most spoken lines start with the same filler word (\"So\", \"Okay\", \"Now\")" },
  { id: "not-for-the-ear", group: "spoken", hard: false, title: "Symbols and links a voice cannot say (\"&\", \"e.g.\", \"https://\")" },
  { id: "cta-two-actions", group: "cta", hard: false, title: "Two actions in one call to action" },
];
const RULE_BY_ID = new Map(COPY_RULES.map((r) => [r.id, r]));
const RULE_IDS = new Set(COPY_RULES.map((r) => r.id));
const SOFT_LIMIT = 3;

// Which rules run for which kind of text.
const SPOKEN_ONLY = new Set(["no-contractions", "stage-direction", "semicolon-line", "not-for-the-ear", "same-opener"]);
const ON_SCREEN_ONLY = new Set(["title-case", "one-rhythm", "exclamation-mark", "colon-pivot", "bait-question"]);
const NAME_RULES = new Set(["not-just-but", "em-dash", "emoji", "stock-opener", "question-hook", "hollow-closer", "button-copy", "stock-phrase", "chatbot-reply", "stock-word", "stock-words-stacked"]);
const CAPTION_RULES = new Set(["emoji", "hashtag"]);

function ruleRuns(id, kind) {
  if (kind === "caption") return CAPTION_RULES.has(id);
  if (kind === "name") return NAME_RULES.has(id);
  if (id === "cta-two-actions") return kind === "cta";
  if (kind === "script") return !ON_SCREEN_ONLY.has(id);
  return !SPOKEN_ONLY.has(id);
}

// Stock words. skip(text, index, match) returns true for an ordinary sense.
// "Level 12 unlocked", "Achievement unlocked": the game's own words.
const UNLOCKED_THING = /\b(?:doors?|levels?|skins?|achievements?|characters?|weapons?|maps?|modes?|gates?|chests?|areas?|zones?|stages?|worlds?|tiers?|badges?|items?|rewards?|abilit(?:y|ies)|skills?|cars?|perks?|upgrades?|tracks?|outfits?|emotes?|troph(?:y|ies)|endings?|planets?|islands?|dungeons?|hero(?:es)?|class(?:es)?|cards?|boss(?:es)?|missions?|quests?|chapters?|ranks?)(?:\s+[#\d]+)?\s+$/i;
const STOCK_WORDS = [
  { key: "delve", re: /\bdelv(?:e|es|ed|ing)\b/gi, fix: "Say \"look at\" or \"go through\"." },
  { key: "tapestry", re: /\btapestr(?:y|ies)\b/gi, fix: "Name the real things it is made of." },
  {
    key: "landscape",
    re: /\b(?:(?:digital|media|business|competitive|tech|technology|market|marketing|content|creative|creator|modern|evolving|changing|ever-changing|ever-evolving|shifting|current|today's|ai|industry|global|social|political|financial|economic|threat|security|software|retail|gaming|educational|regulatory|cultural|startup|crowded|complex) landscapes?|landscapes? of (?:innovation|technology|possibilit(?:y|ies)|opportunit(?:y|ies)|content|media|ideas|work|business|ai|design|creativity|marketing|change))\b/gi,
    fix: "Name the field itself, like \"video editing\" or \"the market\".",
  },
  { key: "realm", re: /\brealms?\b/gi, fix: "Say \"area\", or name the place.", skip: (t, i) => /(?:^|[^\p{L}])\p{Lu}[\p{L}']+ $/u.test(t.slice(0, i)) && /^R/.test(t.slice(i)) && /[a-z]/.test(t.replace(/\b\p{Lu}[\p{L}']*/gu, "")) },
  { key: "seamless", re: /\bseamless(?:ly|ness)?\b/gi, fix: "Say what joins up, or cut the word: \"One tool for cutting, captions and voice\"." },
  { key: "elevate", re: /\belevat(?:e|es|ed|ing)\b/gi, fix: "Say \"improve\", or say how it gets better." },
  {
    key: "unlock",
    re: /\bunlock(?:s|ed|ing)?\b/gi,
    fix: "Say \"get\", \"open\" or \"use\", and name the thing.",
    skip: (t, i, m) => (/^unlocked$/i.test(m) && UNLOCKED_THING.test(t.slice(0, i))) || /^(?:\s+[\p{L}\d'-]+){0,3}?\s+(?:doors?|phones?|screens?|levels?|skins?|achievements?|characters?|weapons?|maps?|modes?|gates?|chests?|areas?|zones?|stages?|worlds?|tiers?|badges?|items?|rewards?|abilit(?:y|ies)|skills?|cars?|bikes?|accounts?|devices?|files?|pdfs?|bosses|boss|perks?|upgrades?|tracks?|outfits?|emotes?|trophies|trophy|cheats?|endings?|planets?|islands?|dungeons?|heroes|hero|classes|class|cards?|locks?|safe|vault|padlock)\b/iu.test(t.slice(i + m.length)),
  },
  { key: "unleash", re: /\bunleash(?:es|ed|ing)?\b/gi, fix: "Say \"use\", and name what it does." },
  { key: "empower", re: /\bempower(?:s|ed|ing|ment)?\b/gi, fix: "Say \"lets you\" or \"helps you\", then the task." },
  {
    key: "leverage",
    re: /\bleverag(?:e|es|ed|ing)\b/gi,
    fix: "Say \"use\".",
    skip: (t, i, m) => {
      if (/^leverag(?:es|ing)$/i.test(m)) return false;
      const before = t.slice(0, i);
      if (/\b(?:the|a|more|some|any|no|of|have|has|had|gain|gains|with|financial|your|our|their|much|extra|real|that|this|its|his|her|my|enough|less|high|low)\s+$/i.test(before)) return true;
      return !/^\s+\p{L}/u.test(t.slice(i + m.length));
    },
  },
  { key: "robust", re: /\brobust(?:ly|ness)?\b/gi, fix: "Say \"solid\", or say what it holds up against." },
  { key: "streamline", re: /\bstreamlin(?:e|es|ed|ing)\b/gi, fix: "Say \"shorten\" or \"cut steps from\", with the steps." },
  {
    key: "harness",
    re: /\bharness(?:es|ed|ing)?\b/gi,
    fix: "Say \"use\".",
    skip: (t, i, m) => !/^harness(?:es|ed|ing)?\s+(?:the|your|our|its|their|this|that|these|those|ai|data|power|energy|technology|creativity|\p{L}+ing)\b/iu.test(t.slice(i)) || /\b(?:a|the|safety|climbing|dog|horse|wiring|seat|test)\s+$/i.test(t.slice(0, i)),
  },
  { key: "testament", re: /\btestaments?\b/gi, fix: "Say \"shows\" or \"proves\".", skip: (t, i) => /\b(?:old|new|last|final)\s+$/i.test(t.slice(0, i)) },
  { key: "pivotal", re: /\bpivotal\b/gi, fix: "Say \"important\", or say why it matters." },
  { key: "vibrant", re: /\bvibran(?:t|tly|cy)\b/gi, fix: "Name the colours, or say what is lively about it." },
  { key: "crucial", re: /\bcrucial(?:ly)?\b/gi, fix: "Say \"important\", or say what breaks without it." },
  { key: "game-changer", re: /\bgame[\s-]?chang(?:er|ers|ing)\b/gi, fix: "Say what changed, with the before and after." },
  { key: "cutting-edge", re: /\bcutting[\s-]edge\b/gi, fix: "Say \"new\", and what it does that the old one could not." },
  { key: "next-level", re: /\bnext[\s-]level\b/gi, fix: "Say what is better, in plain words." },
  { key: "revolutionary", re: /\brevolution(?:ary|i[sz]e[sd]?|i[sz]ing)\b/gi, fix: "Say what is different about it.", skip: (t, i, m) => /^\s+(?:war|guard|army|france|era|period|calendar)\b/i.test(t.slice(i + m.length)) },
  {
    key: "journey",
    re: /\bjourneys?\b/gi,
    fix: "Say \"path\" or \"process\", or name the steps.",
    skip: (t, i) => /\b(?:train|bus|boat|car|road|rail|ferry|flight|sea|river|bike|cycle|coach|return|outward|overnight|\d+[\s-]?(?:hour|day|mile|km|minute|week)s?|(?:two|three|four|five|six|seven|eight|nine|ten)[\s-](?:hour|day|mile|week)s?)\s+$/i.test(t.slice(0, i)) || /\b(?:train|bus|boat|ferry|flights?|drive|drove|road|trip|miles?|km|kilomet\w+|hours?|by (?:car|rail|sea|air|bike|foot)|across|sailed|hiked|trek\w*|voyage|expedition|route|pilgrim\w*)\b|\bfrom \p{Lu}[\p{L}' -]{1,30} to \p{Lu}/u.test(t),
  },
  { key: "ecosystem", re: /\becosystems?\b/gi, fix: "Say \"set of tools\", or name them.", skip: (t, i) => /\b(?:reef|forest|marine|ocean|river|lake|wetland|desert|coral|soil|pond|natural|fragile|arctic|rainforest|local|island|coastal)\s+$/i.test(t.slice(0, i)) || /\b(?:reefs?|forests?|oceans?|rivers?|lakes?|wetlands?|corals?|rainforests?|species|habitats?|wildlife|predators?|prey|biolog\w+|ecolog\w+|plants?|animals?|insects?|fish|birds?|tundra|savanna)\b/i.test(t) },
  { key: "synergy", re: /\bsynerg(?:y|ies|istic)\b/gi, fix: "Say what works together, and how." },
  { key: "paradigm", re: /\bparadigms?\b/gi, fix: "Say \"way of working\", or name it." },
  { key: "effortless", re: /\beffortless(?:ly)?\b/gi, fix: "Say what takes less work, with the real saving if you have it." },
  { key: "worry-free", re: /\bworry[\s-]free\b/gi, fix: "Say what is covered." },
  { key: "transform your", skip: (t, i, m) => /^(?:\s+[\p{L}\d'-]+){1,5}?\s+into\b/iu.test(t.slice(i + m.length)), re: /\btransform(?:s|ed|ing)? (?:your|the way you)\b/gi, fix: "Say what changes, with the before and after: \"Cut an hour of editing down to ten minutes\" only if that is true." },
  { key: "utilize", re: /\butili[sz](?:e|es|ed|ing|ation)\b/gi, fix: "Say \"use\"." },
  { key: "nestled", re: /\bnestled\b/gi, fix: "Say \"in\" or \"sits in\"." },
  { key: "meticulous", re: /\bmeticulous(?:ly)?\b/gi, fix: "Say \"careful\", or show the care with one detail." },
  { key: "intricate", re: /\bintricate(?:ly)?\b/gi, fix: "Say \"detailed\", or name the detail." },
  { key: "underscores", re: /\bunderscor(?:es|ing|ed)\b/gi, fix: "Say \"shows\"." },
  { key: "dive in", re: /\b(?:div(?:e|es|ing)|dove|deep[\s-]dive) (?:right |straight |deep(?:er)? )?in(?:to)?\b/gi, fix: "Cut it and start with the first fact.", skip: (t, i, m) => /^\s+(?:the\s+)?(?:pool|water|sea|ocean|lake|river|waves|deep end|surf)\b/i.test(t.slice(i + m.length)) },
  { key: "in today's", re: /\bin today's\b(?! (?:video|episode|lesson|class|match|game|show|stream|tutorial|session|update|post|issue|recipe|workout|news|weather|meeting|paper|puzzle|vlog|race|round))/gi, fix: "Cut the opener and start with the first fact." },
  { key: "level up", skip: (t, i, m) => /^level(?:s|ed|ing|led|ling) up$/i.test(m) || /\b(?:boss|xp|quests?|rank|skill tree|character|hp|dungeons?|loot|grind|level \d+|raid|stats?)\b/i.test(t), re: /\blevel(?:s|ed|ing|led|ling)? up\b/gi, fix: "Say the real gain: \"Cut an hour of editing down to ten minutes\" only if that is true." },
  { key: "what are you waiting for", re: /\bwhat are you waiting for\b/gi, fix: "Say the next action: \"Download JV\", \"Watch part 2\"." },
  { key: "the possibilities are endless", re: /\b(?:the )?possibilities are (?:endless|limitless|infinite)\b|\b(?:endless|limitless|infinite|unlimited) possibilities\b/gi, fix: "Name one real thing it can do." },
  { key: "solutions", re: /\b(?:tailored|custom|innovative|smart|digital|software|business|enterprise|creative|complete|total|integrated|end-to-end|turnkey|bespoke|powerful|modern|scalable|ai|ai-powered|intelligent) solutions?\b/gi, fix: "Name the thing: an app, a service, a tool." },
  { key: "experiences", re: /\b(?:immersive|unforgettable|curated|elevated|premium|digital|bespoke|tailored|unparalleled|unmatched) experiences?\b/gi, fix: "Say what the person does or sees." },
  { key: "the sky's the limit", re: /\b(?:the )?sky(?:'s| is) the limit\b/gi, fix: "Name one real thing it can do." },
];

const GENERIC_ADJECTIVES = new Set([
  "fast", "faster", "simple", "simpler", "easy", "easier", "powerful", "smart", "smarter", "beautiful", "secure",
  "reliable", "scalable", "modern", "clean", "intuitive", "flexible", "affordable", "elegant", "bold", "seamless",
  "efficient", "effortless", "smooth", "quick", "quicker", "sleek", "intelligent", "innovative", "creative",
  "strong", "stronger", "better", "brighter", "bigger", "cheaper", "lighter", "safer", "stunning", "robust",
  "limitless", "endless", "effective", "professional", "polished", "dynamic", "versatile", "responsive",
  "accessible", "sustainable", "authentic", "unique", "fresh", "friendly", "stylish", "premium", "vibrant",
]);

const CTA_VERBS = "get|start|unlock|subscribe|follow|like|share|download|visit|join|sign|try|watch|learn|discover|buy|shop|book|call|click|tap|hit|comment|save|read|open|install|grab|claim|order|register|donate|vote|send|check|explore|upgrade|create";

function sentenceCase(text, keep) {
  let first = true;
  return String(text).replace(/[\p{L}][\p{L}'-]*/gu, (word) => {
    if (first) {
      first = false;
      return word;
    }
    if (/^\p{Lu}{2,}$/u.test(word) || word === "I" || keep(word)) return word;
    return word.toLowerCase();
  });
}

// Lists of three in one line of copy.
function triplesIn(line) {
  const out = [];
  const sents = sentencesOf(line);
  const bare = (s) => s.replace(/^[\s"'(]+|[\s"'.,!?)]+$/g, "");
  // "Fast. Simple. Yours." : a streak of exactly three one or two word sentences.
  let streak = [];
  const closeStreak = () => {
    if (streak.length === 3) out.push({ items: streak.map(bare), text: streak.join(" ") });
    streak = [];
  };
  for (const s of sents) {
    if (wordsOf(s).length >= 1 && wordsOf(s).length <= 2 && !/\?$/.test(s)) streak.push(s);
    else closeStreak();
  }
  closeStreak();
  const CLAUSE_START = /^(?:we|you|i|they|it|he|she|there|this|that|then|so|but|which|who|when|while|if|because|with|and|or|to|as|not|just|for|from|in|on|at|by)\b/i;
  for (const s of sents) {
    if (wordsOf(s).length <= 2) continue;
    const parts = s.split(/\s*,\s*/);
    let items = null;
    if (parts.length === 3 && /^(?:and|&|or)\s+/i.test(parts[2])) items = [parts[0], parts[1], parts[2].replace(/^(?:and|&|or)\s+/i, "")];
    else if (parts.length === 2) {
      const m = parts[1].match(/^(.+?)\s+(?:and|&|or)\s+(.+)$/i);
      if (m) items = [parts[0], m[1], m[2]];
    } else if (parts.length === 3 && sents.length === 1 && parts.every((p) => wordsOf(p).length >= 1 && wordsOf(p).length <= 2)) items = parts.slice();
    if (!items) continue;
    const [a, b, c] = items.map(bare);
    if (!a || !b || !c) continue;
    if (wordsOf(b).length > 3 || wordsOf(c).length > 5) continue;
    if (CLAUSE_START.test(b) || CLAUSE_START.test(c)) continue;
    out.push({ items: [a, b, c], text: s });
  }
  return out;
}

function isHollowTriple(triple) {
  const [a, b, c] = triple.items;
  const lastOf = (s) => (wordsOf(s).pop() || "").toLowerCase();
  const firstOf = (s) => (wordsOf(s)[0] || "").toLowerCase();
  return wordsOf(b).length === 1 && GENERIC_ADJECTIVES.has(lastOf(a)) && GENERIC_ADJECTIVES.has(b.toLowerCase()) && GENERIC_ADJECTIVES.has(firstOf(c));
}

function isTitleCaseSentence(sentence, keep) {
  const words = String(sentence).match(/[\p{L}][\p{L}'-]*/gu) || [];
  if (words.length < 4) return false;
  if (!/\p{Ll}/u.test(sentence)) return false;
  const SMALL = new Set(["a", "an", "the", "and", "or", "but", "nor", "for", "of", "to", "in", "on", "at", "by", "with", "from", "as", "vs", "via", "per", "is", "it"]);
  let caps = 0;
  let lows = 0;
  for (const w of words.slice(1)) {
    if (/^\p{Lu}{2,}$/u.test(w) || w === "I" || keep(w)) continue;
    if (/^\p{Lu}/u.test(w)) caps += 1;
    else if (!SMALL.has(w.toLowerCase())) lows += 1;
  }
  return caps >= 3 && lows === 0;
}

const EMOJI_RE = /(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F|[\u{1F1E6}-\u{1F1FF}]|[0-9#*]\uFE0F?\u20E3)(?:\u200D(?:\p{Emoji_Presentation}|\p{Extended_Pictographic})\uFE0F?|[\u{1F3FB}-\u{1F3FF}]|\uFE0F)*/gu;
const ORNAMENT_RE = /[\u2190-\u21FF\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2600-\u26FF\u2700-\u27BF\u2B00-\u2BFF]/gu;

const LINK_RE = /\b(?:https?:\/\/|www\.)[^\s"'<>]+|\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|app|co|dev|ai|tv|gg|me|shop|store|xyz|uk|de|fr|ca|us|studio|video|site|online)\b(?:\/[^\s"'<>]*)?/gi;
const HANDLE_RE = /(?:^|[\s(])@[a-z0-9_.]{2,}/gi;
const PLACEHOLDER_LINK = /example\.(?:com|org|net)|your|handle|username|channel|website|domain|brand|company|site\.com|name/i;

function toLines(texts, kind) {
  const list = Array.isArray(texts) ? texts : texts == null ? [] : [texts];
  const lines = [];
  const label = kind === "script" ? "line " : kind === "name" ? "name " : "text ";
  list.forEach((entry, i) => {
    const raw = entry && typeof entry === "object" ? String(entry.text == null ? "" : entry.text) : String(entry == null ? "" : entry);
    const where = entry && typeof entry === "object" && entry.where ? String(entry.where) : label + (i + 1);
    let pieces;
    if (/<[a-zA-Z!\/][^>]*>/.test(raw)) pieces = visibleText(raw);
    else pieces = decodeEntitiesLoose(raw).split(/\r?\n/);
    for (const piece of pieces) {
      let source = piece;
      if (kind === "name") source = source.replace(/\.[a-z0-9]{2,5}$/i, "").replace(/(?<=[\p{L}\p{N}])[_.]+(?=[\p{L}\p{N}])/gu, " ").replace(/(?<=\p{L})-(?=\p{L})/gu, " ");
      const text = clean(source);
      if (!text) continue;
      lines.push({ raw: String(piece), text, where, index: lines.length, sentences: sentencesOf(text), words: wordsOf(text).length });
    }
  });
  return lines;
}

function lintCopy(texts, opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const kind = ["card", "cta", "script", "caption", "name"].includes(o.kind) ? o.kind : "card";
  const lines = toLines(texts, kind);
  const asked = makeAsked(o.asked, o.allow, RULE_IDS);
  const problems = [];
  const runs = (id) => ruleRuns(id, kind) && !asked.off.has(id);
  const add = (rule, line, what, fix, extra) => {
    if (!runs(rule)) return;
    if (problems.some((p) => p.rule === rule && p.what === what)) return;
    const meta = RULE_BY_ID.get(rule);
    problems.push(Object.assign({ rule, hard: Boolean(meta && meta.hard), what, fix, where: line ? line.where : "", text: line ? line.text : "" }, extra || {}));
  };
  // A line the person typed word for word is theirs.
  for (const line of lines) line.theirs = line.words >= 3 && asked.phrase(line.text);
  const mine = lines.filter((line) => !line.theirs);
  const onScreen = kind === "card" || kind === "cta";
  const spoken = kind === "script";
  const keepCase = (word) => asked.typed(new RegExp("(?<![\\p{L}\\p{N}])" + esc(word) + "(?![\\p{L}\\p{N}])", "u"));

  // Phrase rules. Each entry: rule, pattern, what (from the match), fix,
  // optional test(line, match) to accept. A match the person typed passes.
  const hardSpans = new Map(); // line index -> [[start, end]]
  const phraseSeen = new Set(); // one problem per rule per line
  const phrase = (rule, re, describe, fix, accept) => {
    if (!runs(rule)) return;
    for (const line of mine) {
      const pattern = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
      let m;
      while ((m = pattern.exec(line.text))) {
        if (m[0] === "") {
          pattern.lastIndex += 1;
          continue;
        }
        if (accept && !accept(line, m)) continue;
        if (asked.typed(new RegExp(re.source, re.flags.replace("g", "")))) continue;
        const seenKey = rule + "\n" + line.index;
        if (!phraseSeen.has(seenKey)) {
          phraseSeen.add(seenKey);
          add(rule, line, describe(line, m), typeof fix === "function" ? fix(line, m) : fix);
        }
        if (RULE_BY_ID.get(rule).hard) {
          if (!hardSpans.has(line.index)) hardSpans.set(line.index, []);
          hardSpans.get(line.index).push([m.index, m.index + m[0].length]);
        }
      }
    }
  };
  const inHardSpan = (line, start, end) => (hardSpans.get(line.index) || []).some(([a, b]) => start >= a && end <= b);
  const found = (m) => q(m[0].replace(/^[\s.!?]+/, ""), 60);

  // ---- emoji, hashtags, ornaments (read from the raw text)
  for (const line of mine) {
    const raw = line.raw;
    const emoji = raw.match(EMOJI_RE) || [];
    const kept = dedupe(emoji).filter((e) => !asked.typed(new RegExp(esc(e), "u")));
    if (kept.length && !asked.typed(/\bemojis?\b/i)) {
      add(
        "emoji",
        line,
        "Emoji in the copy: " + kept.slice(0, 4).join(" ") + " in " + q(line.text, 50) + ".",
        kind === "caption" ? "Captions are the spoken words. Take the emoji out." : "Take the emoji out and let the words carry it. If it marked a list, use a plain line or a number.",
      );
    }
    if (runs("hashtag")) {
      const tags = [];
      const tagRe = /(?:^|[^\p{L}\p{N}&#])(#[\p{L}_][\p{L}\p{N}_]*)/gu;
      let m;
      while ((m = tagRe.exec(line.text))) {
        const tag = m[1];
        if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(tag)) continue;
        if (asked.typed(new RegExp(esc(tag) + "(?![\\p{L}\\p{N}_])", "iu"))) continue;
        tags.push(tag);
      }
      if (tags.length && !asked.typed(/\bhashtags?\b/i)) {
        add("hashtag", line, "Hashtags nobody asked for: " + dedupe(tags).slice(0, 4).join(" ") + ".", kind === "caption" ? "Captions are the spoken words. Take the hashtags out." : "Take the hashtags out. Hashtags go in the post, not in the video, and only when the person asks.");
      }
    }
    if (runs("unicode-ornament")) {
      const rest = raw.replace(EMOJI_RE, "");
      const marks = dedupe(rest.match(ORNAMENT_RE) || []).filter((ch) => !asked.typed(new RegExp(esc(ch), "u")));
      if (marks.length) add("unicode-ornament", line, "Symbol characters used as decoration: " + marks.slice(0, 4).join(" ") + " in " + q(line.text, 50) + ".", "Write the word (\"next\", \"done\") or draw the shape in the design instead of typing a symbol.");
    }
  }

  if (kind !== "caption") {
    // ---- dashes
    if (runs("em-dash")) {
      for (const line of mine) {
        const t = line.text;
        const dashFix = "Use a period or a comma: two short sentences read better than one with a dash.";
        if (/[\u2014\u2015]/.test(t)) {
          add("em-dash", line, "Em dash in " + q(t, 70) + ".", dashFix);
          continue;
        }
        if (kind === "name") continue;
        let hit = false;
        const dd = /--+/g;
        let m;
        while ((m = dd.exec(t))) {
          const L = t[m.index - 1] || "";
          const R = t[m.index + m[0].length] || "";
          if (R === ">" || L === "<" || L === "!") continue;
          if ((L === "" || /\s/.test(L)) && /[\p{L}\p{N}]/u.test(R)) continue; // a command line flag
          if (!(R === "" || /[\s\p{L}"'(]/u.test(R))) continue;
          hit = true;
        }
        if (hit) {
          add("em-dash", line, "\"--\" stands in for an em dash in " + q(t, 70) + ".", dashFix);
          continue;
        }
        if (spoken) continue; // in a script a spaced hyphen is the pause mark audio-voiceover asks for
        // A spaced en dash or hyphen between words is the same pivot. A range
        // ("Mon - Fri", "3 - 1") and a short label ("Artist - Song") are not.
        const pivot = /(\S+) [\u2013-] (\S+)/g;
        while ((m = pivot.exec(t))) {
          const left = m[1];
          const right = m[2];
          if (/\d/.test(left) || /\d/.test(right)) continue;
          const DAY = /^(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|monday|tuesday|wednesday|thursday|friday|saturday|sunday|am|pm|noon|midnight|today|tomorrow|now|open|close|start|end)\.?$/i;
          if (DAY.test(left) && DAY.test(right)) continue;
          const before = wordsOf(t.slice(0, m.index + left.length)).length;
          const after = wordsOf(t.slice(m.index + left.length + 3)).length;
          const label = before <= 3 && after <= 3 && /^["'(]?[\p{Lu}\d]/u.test(right) && !/[.!?]$/.test(t);
          if (label) continue;
          add("em-dash", line, "A spaced " + (t[m.index + left.length + 1] === "-" ? "hyphen" : "en dash") + " stands in for an em dash in " + q(t, 70) + ".", dashFix);
          break;
        }
        if (/\p{Ll}{3,}\u2013\p{Ll}{3,}/u.test(t)) add("em-dash", line, "An en dash stands in for an em dash in " + q(t, 70) + ".", dashFix);
      }
    }

    // ---- "not just X, but Y" family
    const frameFix = "Say the one claim plainly and name what it does, like \"An editor that cuts for you\".";
    phrase("not-just-but", /\b(?:not|n't|no longer|never) (?:just|only|merely|simply)\b[^.!?]{0,90}?(?:\bbut\b|(?:[,;:]|\s[\u2014\u2013-]{1,2})\s*(?:it|this|that|they|these|those|we|you|he|she)(?:'s|'re| is| are| was| were)\b)/i, (l) => q(l.text, 80) + " uses the \"not just X, but Y\" frame.", frameFix);
    phrase("not-just-but", /\b(?:not|n't|no longer|never) (?:just|only|merely|simply)\b[^.!?]{1,60}[.!?]\s+(?:it|this|that|they|these|those|we|you|he|she)(?:'s|'re| is| are| was| were)\b/i, (l) => q(l.text, 80) + " uses the \"not just X. It's Y\" frame.", frameFix);
    phrase("not-just-but", /\bmore than just\b/i, (l) => q(l.text, 80) + " uses \"more than just\".", frameFix);
    phrase(
      spoken ? "contrast-frame" : "not-just-but",
      /(?:\b(?:it|this|that|they|these|those|we|you|he|she)(?:'s|'re| is| are| was| were) not|\b(?:is|are|was|were)n't|\b(?:is|are|was|were) not)\b[^.!?;]{1,70}?(?:[,;:]|\s[\u2014\u2013-]{1,2})\s*(?:it|this|that|they|these|those|we|you|he|she)(?:'s|'re| is| are| was| were)\b/i,
      (l) => q(l.text, 80) + " uses the \"it's not X, it's Y\" frame.",
      frameFix,
      (line, m) => {
        // "If it's not in Downloads, it's in Documents" is an instruction, not the frame.
        const start = Math.max(line.text.lastIndexOf(".", m.index), line.text.lastIndexOf("!", m.index), line.text.lastIndexOf("?", m.index)) + 1;
        return !/\b(?:if|when|unless|while|since|because|once|whenever|in case)\b/i.test(line.text.slice(start, m.index + 12));
      },
    );
    phrase("not-just-but", /\bnot\b[^.!?,]{1,40}[.!?,]\s*not\b[^.!?,]{1,40}[.!?,]\s*(?:just|only)\b/i, (l) => q(l.text, 80) + " uses the \"Not X. Not Y. Just Z.\" frame.", frameFix);
    phrase(
      "contrast-frame",
      /(?:\b(?:it|this|that|they|these|those|we|you|he|she)(?:'s|'re| is| are| was| were) not|\b(?:is|are|was|were)n't)\b((?: [\p{L}\p{N}'-]+){1,6})[.!]\s+(?:it|this|that|they|these|those|we|you|he|she)(?:'s|'re| is| are| was| were)\b/iu,
      (l) => q(l.text, 80) + " sets up \"not X\" only to say \"it's Y\".",
      "Skip the setup and say the second half on its own.",
      (line, m) => !inHardSpan(line, m.index, m.index + m[0].length),
    );
    phrase("contrast-frame", /\bno\b[^.!?,]{1,40}[.!?,]\s*no\b[^.!?,]{1,40}[.!?,]\s*(?:just|only)\b/i, (l) => q(l.text, 80) + " uses the \"No X. No Y. Just Z.\" frame.", "Say what it does in one plain sentence.");
    phrase("contrast-frame", /\bnot (?:just|only|merely) (?:another|an?|the|about)\b/i, (l) => q(l.text, 80) + " defines the thing by what it is not.", "Say what it is.", (line, m) => !inHardSpan(line, m.index, m.index + m[0].length));

    phrase("contrast-frame", /\b(?:don't|do not) just [^.!?,;]{1,40}[.!?,;]\s*\S/i, (l) => q(l.text, 80) + " uses the \"Don't just X. Y.\" frame.", "Say the second half on its own.", (line, m) => !inHardSpan(line, m.index, m.index + m[0].length));

    // ---- openers, hooks, closers, buttons, stock phrases
    const openerFix = "Delete the opener and start with the first fact or the first action.";
    phrase("stock-opener", /\bin today's (?:[\p{L}-]+ ){0,2}(?:world|age|era|landscape|society|economy|market(?:place)?|environment|climate|times)\b/iu, (l, m) => found(m) + " is a stock opener.", openerFix);
    phrase("stock-opener", /\bin (?:a|an|the|this|our) (?:fast-paced|fast-moving|ever-changing|ever-evolving|digital|modern|busy|noisy|crowded) (?:world|age|era)\b/i, (l, m) => found(m) + " is a stock opener.", openerFix);
    phrase("stock-opener", /\bin a world (?:where|of|full)\b|\bimagine a world\b/i, (l, m) => found(m) + " is a stock opener.", openerFix);
    phrase("stock-opener", /\blet's (?:dive|jump right|dig right)\b[^.!?]{0,12}|\bdive right in\b|(?:^|[.!?]\s+)dive in(?:to)?\b/i, (l, m) => found(m) + " is a stock opener.", openerFix, (line, m) => !/^[^.!?]*\b(?:pool|water|sea|ocean|lake|river|waves)\b/i.test(line.text.slice(m.index + m[0].length)));
    phrase("stock-opener", /\bhere's the kicker\b|\bbuckle up\b|\bwithout further ado\b/i, (l, m) => found(m) + " is a stock opener.", openerFix);

    const hookFix = "Cut the question and state the one thing the viewer gets, like \"Make your next video here\".";
    phrase("question-hook", /(?:^|[.!?]\s+)["']?(?:so,? )?(?:are you |you |get )?ready to\b[^.!?]*\?/i, (l, m) => found(m) + " is a \"Ready to...?\" hook.", hookFix);
    phrase("question-hook", /(?:^|[.!?]\s+)["']?(?:so,? )?(?:are you )?ready to [\p{L}'-]+ your\b/iu, (l, m) => found(m) + " is a \"Ready to...\" hook.", hookFix, (line, m) => !inHardSpan(line, m.index, m.index + m[0].length));
    phrase("question-hook", /(?:^|[.!?]\s+)["']?(?:are you )?(?:tired|sick|bored|fed up) (?:of|with)\b[^.!?]*\?/i, (l, m) => found(m) + " is a \"Tired of...?\" hook.", hookFix);
    phrase("question-hook", /\bwhat if you could\b/i, (l, m) => q(l.text, 70) + " opens on \"What if you could\".", hookFix);
    phrase(
      "question-hook",
      /(?:^|[.!?]\s+)["']?(?:and |but |so )?(?:the|our|your|my) (?:results?|best part|catch|secret|answer|outcome|difference|kicker|twist|solution|reason|payoff|bottom line|verdict|upside|good news|bad news|trick|key)\?\s+\S[^.!?]*/i,
      (l, m) => found(m) + " asks a question only to answer it.",
      "Say it as one statement: put the answer first and drop the question.",
    );
    if (onScreen) {
      phrase(
        "bait-question",
        /(?:^|[.!?]\s+)["']?(?:want|need|looking|struggling|wish|ever|have you ever|did you know|do you|are you|can you|could you|would you|is your|are your|what if|why not|who doesn't|isn't it time|wondering|guess what|sound familiar|know what)\b[^.!?]*\?/i,
        (l, m) => found(m) + " is a question aimed at the viewer.",
        "State what the viewer gets instead: a noun and a verb, 3 to 7 words.",
        (line, m) => !inHardSpan(line, m.index, m.index + m[0].length),
      );
    }

    const closerFix = "End on the next real action with a real name or link, like \"Start with one clip\" or \"Download JV\".";
    phrase("hollow-closer", /\b(?:start|begin|continue|embark on) your (?:[\p{L}-]+ )?journey\b|\byour (?:[\p{L}-]+ )?journey (?:starts|begins|awaits|continues)\b/iu, (l, m) => found(m) + " is a hollow closer.", closerFix);
    phrase("hollow-closer", /\b(?:take|bring|taking|takes) (?:it|this|things|them|your [\p{L} -]{1,30}?) to the next level\b|\bto the next level\b/iu, (l, m) => found(m) + " is a hollow closer.", closerFix);
    phrase("hollow-closer", /\bthe future (?:of [^.!?]{1,40} )?is (?:here|now|yours)\b|\bwelcome to the future\b|\bthe future (?:starts|begins) (?:here|now|today)\b/i, (l, m) => found(m) + " is a hollow closer.", closerFix);
    phrase("hollow-closer", /^["']?join us(?: today| now)?[.!]?["']?$/i, (l) => q(l.text, 40) + " is a hollow closer.", "Say where and when, or the real next action: \"Join us Saturday at 10\", \"Subscribe\".");
    phrase("hollow-closer", /\bjoin (?:the |over |more than )?(?:thousands|millions|hundreds|\d{1,3}(?:,\d{3})+\+?|\d{3,}\+?|\d[\d.]*\s?(?:k|m|million|thousand)\b\+?|\d+\+) ?(?:of )?[^.!?,]{0,40}/i, (l) => q(l.text, 70) + " invites the viewer to join a crowd.", "Drop the crowd unless the person gave the number. Say who made it or what it does: \"Made by one person, used by you\".", (line, m) => !figureValues(m[0]).some((v) => asked.numbers.has(v)));
    phrase("hollow-closer", /\bjoin the (?:movement|revolution)\b/i, (l, m) => found(m) + " is a hollow closer.", closerFix);
    phrase("hollow-closer", /\b(?:experience|meet|discover|step into|embrace|enter|explore|glimpse|shape|build) the future of\b/i, (l, m) => q(l.text, 70) + " promises \"the future of\" something.", "Say what it does today: \"Tell your story with less work\".", (line, m) => !inHardSpan(line, m.index, m.index + m[0].length));

    if (onScreen || kind === "name") {
      phrase("button-copy", /\bget started\b/i, (l) => "\"Get Started\" is stock button copy" + (l.words > 2 ? ", in " + q(l.text, 60) : "") + ".", "Name the action: \"Open the editor\", or \"Try it free\" only if it is free.");
      phrase("button-copy", /\blearn more\b/i, (l) => "\"Learn More\" is stock button copy" + (l.words > 2 ? ", in " + q(l.text, 60) : "") + ".", "Say where it leads: \"See how it works\" or \"Read the guide\".");
      phrase("button-copy", /\b(?:discover|explore) more\b|(?:^|[.!?:]\s+)["']?discover\b(?! (?:card|channel|page|tab|feed|weekly)\b)/i, (l) => q(l.text, 60) + " uses \"Discover\" as a command.", "Say what the viewer does or gets: \"Tell your story with less work\".", (line, m) => !inHardSpan(line, m.index + m[0].length - 8, m.index + m[0].length));
    }
    phrase("button-copy", /\blevel(?:ing)? up your\b/i, (l) => q(l.text, 60) + " uses \"Level up your\".", "Say the real gain: \"Cut an hour of editing down to ten minutes\" only if that is true, else drop the number.");

    phrase("stock-phrase", /\blook no further\b/i, (l, m) => found(m) + " is a stock phrase.", "Cut it and say what the thing does.");
    phrase("stock-phrase", /\b(?:watch|see|feel|experience) the magic\b|\bthe magic (?:unfold|happen)s?\b|\bwhere the magic happens\b/i, (l, m) => found(m) + " is a stock phrase.", "Say what happens on screen: \"Cutting the first clip\".");
    phrase("stock-phrase", /\bsay goodbye to\b/i, (l) => q(l.text, 70) + " uses \"say goodbye to\".", "Say the good result instead of the problem: \"Videos people watch to the end\".");
    phrase("stock-phrase", /\bwhether you're\b[^.!?]{1,70}\bor\b/i, (l) => q(l.text, 70) + " uses \"whether you're X or Y\".", "Pick the one viewer this is for and talk to them.");
    phrase("stock-phrase", /\b(?:unlock|unleash|harness|maximi[sz]e|tap into)(?:es|s|ing)? (?:your|the|its|their|our) (?:full |true |creative |hidden |inner )?(?:potential|power|possibilities|creativity|magic|secrets?|future)\b/i, (l) => q(l.text, 70) + " uses the \"unlock the power\" phrase.", "Name what the product actually does: \"Edit video by typing what you want\".");

    phrase("stock-phrase", /\brevolutioni[sz]e(?:s|d)? (?:the way|how) (?:you|we|people|teams|creators)\b/i, (l, m) => found(m) + " is a stock phrase.", "Say the one thing that changes: \"Edit video by typing what you want\".");
    phrase("stock-phrase", /(?:^|[.!?]\s+)["']?(?:experience|discover|feel) the (?:difference|power|freedom|thrill)\b/i, (l, m) => found(m) + " is a stock phrase.", "Say what the viewer will see or get, in plain words.", (line, m) => !inHardSpan(line, m.index, m.index + m[0].length));
    phrase("stock-phrase", /\b(?:you|your [\p{L} -]{1,24}?) deserves? (?:better|more|the best)\b/iu, (l, m) => found(m) + " is a stock phrase.", "Say what is better about it: \"Search finds a note in one word\".");
    // A hype verb aimed at "your" plus an abstract noun is the same button line.
    phrase(
      "button-copy",
      /\b(?:elevate|supercharge|turbocharge|transform|revolutioni[sz]e|streamline|unleash|unlock|empower|skyrocket|reimagine|redefine|10x)s? your (?:[\p{L}-]+ )?(?:workflow|productivity|content|brand|business|life|day|game|creativity|potential|experience|skills|career|team|ideas|vision|future|journey|results|growth|success|strategy|performance|marketing|sales|audience|reach|presence|output|process|routine|mindset)\b/iu,
      (l, m) => found(m) + " is stock button copy.",
      "Say the real gain in plain words: \"Cut an hour of editing down to ten minutes\" only if that is true, else say what it does.",
      (line, m) => !inHardSpan(line, m.index, m.index + m[0].length),
    );

    const clicheFix = "Say what it does in plain words, or cut the line.";
    const cliche = (re) => phrase("ad-cliche", re, (l, m) => found(m) + " is a worn ad line.", clicheFix, (line, m) => !inHardSpan(line, m.index, m.index + m[0].length));
    cliche(/\bwork smarter,? not harder\b/i);
    cliche(/\bfor (\p{L}+),? by \1\b/iu);
    cliche(/(?:^|[.!?]\s+)["']?[\p{L}' -]{2,30}[,.] (?:reimagined|redefined|reinvented|perfected|simplified|made easy|made simple|done right)[.!]?(?=\s|["']?$)/iu);
    cliche(/^["']?where [\p{L}' -]{2,30} (?:comes? to life|meets? [\p{L}' -]{2,30}|takes? flight|comes? true)[.!]?["']?$/iu);
    cliche(/\bsay hello to\b/i);
    cliche(/\ball-in-one\b/i);
    cliche(/\blike never before\b/i);
    cliche(/\bhas never been (?:easier|simpler|faster|this easy|so easy)\b/i);
    cliche(/\bat your fingertips\b/i);
    cliche(/\bthe ultimate (?:[\p{L}-]+ )?(?:solution|tool|platform|experience|companion|app|toolkit)\b/iu);

    phrase("chatbot-reply", /^["']?(?:sure|certainly|absolutely|of course)[!,]\s+(?:here|i|let)|\bgreat question\b|\byou(?:'re| are) absolutely right\b|\bi hope this helps\b|\blet me know if you (?:need|want|have|would)\b|\bhere(?:'s| is) (?:your|the|a) (?:[\p{L}-]+ )?(?:script|voiceover|narration|caption|captions|headline|draft|copy|version)\b|\bas an ai\b/iu, (l, m) => found(m) + " is a chat reply, not copy.", "Remove it. Only the words for the screen or the voice belong here.");

    // ---- stock words
    if (runs("stock-word") || runs("stock-words-stacked")) {
      const hits = []; // { key, word, line, sentence, fix }
      for (const line of mine) {
        for (const entry of STOCK_WORDS) {
          const re = new RegExp(entry.re.source, entry.re.flags);
          let m;
          while ((m = re.exec(line.text))) {
            if (entry.skip && entry.skip(line.text, m.index, m[0])) continue;
            if (inHardSpan(line, m.index, m.index + m[0].length)) continue;
            if (asked.typed(new RegExp(entry.re.source, "i"))) continue;
            let pos = 0;
            let sentence = 0;
            for (let s = 0; s < line.sentences.length; s += 1) {
              const at = line.text.indexOf(line.sentences[s], pos);
              if (at >= 0 && m.index >= at) sentence = s;
              pos = at >= 0 ? at + line.sentences[s].length : pos;
            }
            hits.push({ key: entry.key, word: m[0], line, sentence, fix: entry.fix });
          }
        }
      }
      // Script only: button copy and a bare "Discover" are soft when spoken.
      if (spoken) {
        for (const line of mine) {
          for (const [key, re, fix] of [
            ["get started", /\bget started\b/gi, "Say the first real step instead."],
            ["learn more", /\blearn more\b/gi, "Say where it leads: \"see how it works\", \"read the guide\"."],
            ["discover", /(?:^|[.!?:]\s+)discover\b/gi, "Say what the viewer does or gets."],
          ]) {
            let m;
            while ((m = re.exec(line.text))) {
              if (asked.typed(new RegExp(re.source, "i"))) continue;
              hits.push({ key, word: m[0].replace(/^[\s.!?:]+/, ""), line, sentence: 0, fix, phraseOnly: true });
            }
          }
        }
      }
      const words = hits.filter((h) => !h.phraseOnly);
      const distinct = dedupe(words.map((h) => h.key));
      const bySentence = new Map();
      for (const h of words) {
        const key = h.line.index + ":" + h.sentence;
        if (!bySentence.has(key)) bySentence.set(key, new Set());
        bySentence.get(key).add(h.key);
      }
      const stackedKeys = new Set();
      for (const set of bySentence.values()) if (set.size >= 2) for (const k of set) stackedKeys.add(k);
      const totalWords = mine.reduce((sum, l) => sum + l.words, 0);
      const pieceStack = distinct.length >= 3 && (!spoken || distinct.length >= totalWords / 40);
      if (stackedKeys.size || pieceStack) {
        const keys = stackedKeys.size ? [...stackedKeys] : distinct;
        const line = words.find((h) => keys.includes(h.key)).line;
        add(
          "stock-words-stacked",
          line,
          "Stock words pile up: " + keys.slice(0, 5).map((k) => '"' + k + '"').join(", ") + (stackedKeys.size ? " in " + q(line.text, 70) : " across the piece") + ".",
          "Rewrite the line around what the thing does: \"One tool for cutting, captions and voice\". Keep none of those words.",
        );
      }
      const reported = new Set();
      for (const h of hits) {
        if (stackedKeys.has(h.key) || (pieceStack && !h.phraseOnly)) continue;
        if (reported.has(h.key) || reported.size >= 3) continue;
        reported.add(h.key);
        add("stock-word", h.line, '"' + h.word + '" is a stock word, in ' + q(h.line.text, 60) + ".", h.fix);
      }
    }

    // ---- lists of three
    if (runs("hollow-triple") || runs("rule-of-three") || runs("rule-of-three-everywhere")) {
      const triples = [];
      for (const line of mine) for (const t of triplesIn(line.text)) triples.push(Object.assign({ line }, t));
      const plain = [];
      for (const t of triples) {
        if (isHollowTriple(t)) add("hollow-triple", t.line, q(t.text, 60) + " is a list of three stock adjectives.", "Pick the one that is true and say it plainly, like \"Fast.\" Then show what makes it so.");
        else plain.push(t);
      }
      const all = triples.length;
      const longLines = mine.filter((l) => l.words >= 3).length || 1;
      if (all >= 3 || (all >= 2 && all * 2 >= longLines && plain.length >= 1)) {
        if (plain.length) add("rule-of-three-everywhere", plain[0].line, all + " lists of three in " + mine.length + (mine.length === 1 ? " line" : " lines") + ", like " + q(plain[0].text, 50) + ".", "Keep one list of three at most. Turn the others into one item, or two.");
      } else if (plain.length >= 2) {
        add("rule-of-three", plain[1].line, "A second list of three: " + q(plain[1].text, 60) + ".", "Keep one list of three in the whole video. Make this one a single item, or two.");
      }
    }

    // ---- copula dodge, trailing -ing, filler, announcing
    const copulaFix = "Say \"is\" or \"has\": \"The editor has a timeline\".";
    phrase("copula-dodge", /\b(?:serves?|served|serving) as (?:a|an|the|your|our)\b/i, (l, m) => found(m) + " stands in for \"is\", in " + q(l.text, 60) + ".", copulaFix);
    phrase("copula-dodge", /\b(?:stands?|standing) as (?:a|an|the)\b/i, (l, m) => found(m) + " stands in for \"is\", in " + q(l.text, 60) + ".", copulaFix);
    phrase("copula-dodge", /\bboast(?:s|ing)?\b/i, (l, m) => found(m) + " stands in for \"has\", in " + q(l.text, 60) + ".", copulaFix);
    phrase(
      "copula-dodge",
      /\b[\p{L}'-]+ features (?:a|an|the|over|more than|\d|built-in)\b/iu,
      (l) => "\"features\" stands in for \"has\", in " + q(l.text, 60) + ".",
      copulaFix,
      (line, m) => !/^(?:new|key|main|top|best|these|those|its|the|our|your|all|other|more|many|some|few|pro|premium|core|same|of|and|with|what|which)\b/i.test(m[0]),
    );
    phrase(
      "trailing-ing",
      /,\s+(?:highlighting|underscoring|showcasing|redefining|reflecting|emphasi[sz]ing|demonstrating|ensuring|cementing|solidifying|transforming|revolutioni[sz]ing|reshaping|empowering|enabling|elevating|unlocking|fostering|signaling|symboli[sz]ing|reimagining|bridging|paving the way|setting the stage|making it (?:a|an|the|easier|simple|perfect|ideal|possible)|marking a|proving that)\b[^.!?]*[.!?]?\s*$/i,
      (l, m) => q(l.text, 80) + " ends on a trailing \"-ing\" clause that only claims importance.",
      "End the sentence before the comma. If the second half is a fact, give it its own short sentence.",
    );
    phrase(
      "filler-adverb",
      /\b(?:quietly|deeply|fundamentally|remarkably) (?!(?:into|in|through|and|or|for|to|as|while|until|before|after|from|with|on|at|enough|then|so)\b)[\p{L}]+/iu,
      (l, m) => '"' + m[0].split(" ")[0].toLowerCase() + '" is a filler adverb, in ' + q(l.text, 60) + ".",
      "Cut the adverb. If the sentence needs it, say what actually happens.",
    );
    phrase("filler-adverb", /\bit(?:'s| is) (?:worth noting|important to (?:note|remember|understand))\b|\bworth noting that\b|(?:^|[.!?]\s+)importantly,|\bneedless to say\b|\bat the end of the day\b/i, (l, m) => found(m) + " is filler.", "Cut it and say the point.");
    phrase(
      "announce-recap",
      /\bhere (?:are|is|'s) (?:[\p{L}]+ )?(?:\d+|two|three|four|five|six|seven|ten|some|a few|several) (?:[\p{L}]+ )?(?:reasons|ways|tips|things|steps|facts|secrets|lessons|ideas|tricks|mistakes|signs|benefits)\b/iu,
      (l, m) => found(m) + " announces a list instead of starting it.",
      "Delete the announcement and start with the first item.",
    );
    phrase(
      "announce-recap",
      /\b(?:in summary|in conclusion|to sum up|to summari[sz]e|to recap|let's recap|all in all|the bottom line(?: is)?|as we've seen|to wrap (?:it |things )?up|in a nutshell|key takeaways?)\b|(?:^|[.!?]\s+)in short,|\bin this video,? (?:we|i|you)(?:'ll| will| are going to|'re going to)\b/i,
      (l, m) => found(m) + " announces or recaps instead of saying something new.",
      "Delete it. End on the last new fact or the next action.",
    );
    if (runs("announce-recap") && mine.length >= 3) {
      const first = mine[0];
      const lastLine = mine[mine.length - 1];
      const a = new Set(wordsOf(first.text.toLowerCase()));
      const b = new Set(wordsOf(lastLine.text.toLowerCase()));
      const shared = [...a].filter((w) => b.has(w)).length;
      const union = new Set([...a, ...b]).size || 1;
      if (first.words >= 3 && lastLine.words >= 3 && shared / union >= 0.8) add("announce-recap", lastLine, "The closing line repeats the opening: " + q(lastLine.text, 60) + ".", "End on the next action or the last new fact instead of saying the opening again.");
    }

    // ---- shouting hook (first line only)
    if (mine.length && mine[0].index === 0) {
      phrase(
        "shout-hook",
        /^["']?(?:stop scrolling|stop what you're doing|listen up|attention[,!: ]|hey you\b|you won't believe|this (?:will )?changes? everything|big news|huge news|don't scroll|wait[!,.]|breaking[:!])/i,
        (l, m) => q(l.text, 60) + " opens with a hook that shouts.",
        "Start with the first fact or the first action.",
        (line) => line.index === 0,
      );
    }

    // ---- on screen only: Title Case, one rhythm, exclamation, colon pivot
    if (runs("title-case")) {
      const eligible = mine.filter((l) => l.words >= 4 && /\p{Ll}/u.test(l.text) && !/\S [\u2013-] \S/.test(l.text));
      const titled = eligible.filter((l) => l.sentences.some((s) => isTitleCaseSentence(s, keepCase)));
      if (titled.length && titled.length * 2 >= eligible.length) {
        const line = titled[0];
        add("title-case", line, (titled.length > 1 ? titled.length + " lines are in Title Case, like " + q(line.text, 60) : q(line.text, 60) + " is in Title Case") + ".", "Use sentence case: " + q(sentenceCase(line.text, keepCase), 60) + ".");
      }
    }
    if (runs("one-rhythm")) {
      const long = mine.filter((l) => l.words >= 5);
      if (long.length >= 4) {
        const counts = long.map((l) => l.words);
        const lo = Math.min(...counts);
        const hi = Math.max(...counts);
        if (hi - lo <= 1) add("one-rhythm", long[0], "All " + long.length + " lines run " + (lo === hi ? lo : lo + " to " + hi) + " words, so they read at one beat.", "Change two of them: cut one to 3 words and let another run to " + (hi + 5) + ".");
      }
    }
    if (runs("exclamation-mark")) {
      // "Yahoo!" stays when the person wrote it with the mark.
      const brandBang = (l) => {
        const words = [...l.text.matchAll(/([\p{L}\p{N}][\p{L}\p{N}'-]*)\s?!/gu)].map((m) => m[1]);
        return words.length > 0 && words.length === (l.text.match(/!+/g) || []).length && words.every((w) => new RegExp("(?<![\\p{L}\\p{N}])" + esc(w) + "\\s?!", "iu").test(asked.raw));
      };
      const bang = mine.filter((l) => /!/.test(l.text) && !brandBang(l));
      if (bang.length) add("exclamation-mark", bang[0], q(bang[0].text, 60) + " has an exclamation mark" + (bang.length > 1 ? " (" + bang.length + " lines do)" : "") + ".", "End it with a period, or with nothing on a headline. Keep the mark only if the person's brand uses one.");
    }
    if (runs("colon-pivot")) {
      for (const line of mine) {
        const m = line.text.match(/^["']?((?:the|our|your|my|one|this|that|its|their|his|her) [^:\d]{2,40}):\s+(\S.*)$/i);
        if (!m) continue;
        if (wordsOf(m[1]).length > 5 || wordsOf(m[2]).length > 8) continue;
        add("colon-pivot", line, q(line.text, 60) + " pivots on a colon.", "Say it as one statement with a noun and a verb, 3 to 7 words, no colon.");
      }
    }

    // ---- facts the person did not give
    if (runs("unsourced-claim")) {
      for (const line of mine) {
        const t = line.text;
        const claims = [];
        const CLAIM_PATTERNS = [
          /\b(?:studies|research|surveys?|experts?|scientists|doctors|researchers) (?:show|shows|say|says|agree|agrees|prove|proves|suggest|suggests|confirm|confirms|found|reveal|reveals|recommend|recommends)\b/gi,
          /\baccording to (?:a |the |recent |new )?(?:stud(?:y|ies)|research|experts|scientists|surveys?|reports?)\b/gi,
          /\b(?:thousands|millions|hundreds|billions|tens of thousands|countless|dozens) of (?:[\p{L}]+ )?(?:people|users|creators|customers|teams|fans|viewers|businesses|companies|developers|players|families|students|editors|brands)\b/giu,
          /\b(?:thousands|millions|hundreds|everyone|everybody) (?:love|loves|trust|trusts|use|uses|agree|agrees)\b/gi,
          /\b(?:trusted|loved|used|chosen|preferred) by (?:thousands|millions|hundreds|teams|creators|experts|professionals|the best|leading|top|over|more than|\d)[^.!?,]{0,30}/gi,
          /\b(?:award-winning|world-class|industry-leading|best-in-class|world's (?:first|best|fastest|leading|most [\p{L}]+)|#1\b|no\. ?1\b|number one|top-rated|five-star|5-star|best-selling)/giu,
        ];
        for (const re of CLAIM_PATTERNS) {
          let m;
          while ((m = re.exec(t))) {
            if (inHardSpan(line, m.index, m.index + m[0].length)) continue;
            if (asked.phrase(m[0])) continue;
            claims.push(m[0].trim());
          }
        }
        if (asked.known) {
          // Stat-like figures only: percentages, multipliers, money, big
          // counts, ratings. Dates, times, steps and small counts pass.
          const FIGURES = [
            /[$\u20AC\u00A3]\s?\d[\d,]*(?:\.\d+)?\s?(?:k|m|bn|b|million|billion|thousand)?\b/gi,
            /\b\d[\d,]*(?:\.\d+)?\s?(?:%|percent\b)/gi,
            /\b\d+(?:\.\d+)?x\b/gi,
            /\b\d+(?:\.\d+)? times (?:faster|more|better|cheaper|smaller|bigger|higher|lower|as)\b/gi,
            /\b\d[\d,]*(?:\.\d+)?\s?(?:k|m|bn|million|billion|thousand)\b\+?/gi,
            /\b\d{1,3}(?:,\d{3})+\b\+?|\b\d{4,}\b\+?/g,
            /\b\d+\+(?=[\s.,!?]|$)/g,
            /\b\d(?:\.\d)?\s?\/\s?(?:5|10)\b|\b\d(?:\.\d)?\s?(?:stars?\b|out of (?:5|10)\b)/gi,
            /\b\d+ (?:out of|in) \d+\b/gi,
          ];
          const spans = [];
          for (const re of FIGURES) {
            let m;
            while ((m = re.exec(t))) {
              const start = m.index;
              const end = m.index + m[0].length;
              if (spans.some(([a, b]) => start < b && end > a)) continue;
              if (inHardSpan(line, start, end)) continue;
              const text = m[0].trim();
              if (!/[1-9]/.test(text)) continue; // "00%": a placeholder
              if (/^(?:19|20)\d\d$/.test(text)) continue; // a year
              if (/^[248]k$/i.test(text)) continue; // a resolution
              if (/^\d{4,}$/.test(text) && /^\s*(?:x|p\b|ms\b|px\b|hz\b|fps\b)/i.test(t.slice(end))) continue;
              const values = figureValues(text);
              if (values.length && values.some((v) => asked.numbers.has(v))) continue;
              if (asked.phrase(text)) continue;
              spans.push([start, end]);
              claims.push(text);
            }
          }
          // A quotation the person did not give.
          const quoted = line.raw.replace(INVISIBLE_RE, "").trim().match(/^["\u201C\u00AB](.{8,})["\u201D\u00BB][.!?]?$/);
          if (quoted && wordsOf(quoted[1]).length >= 3 && !asked.phrase(clean(quoted[1]))) {
            add("unsourced-claim", line, "The quotation " + q(clean(quoted[1]), 60) + " is not something the person gave.", "Use a real quote the person gave, with the name of who said it, or put a plain placeholder and say so in the reply.");
          }
          // A link or handle the person did not give.
          const links = (t.match(LINK_RE) || []).concat((t.match(HANDLE_RE) || []).map((h) => h.trim().replace(/^\(/, "")));
          for (const link of links) {
            if (PLACEHOLDER_LINK.test(link)) continue;
            if (/@/.test(link) && !/^@/.test(link)) continue;
            if (asked.typed(new RegExp(esc(link.replace(/^https?:\/\/(?:www\.)?|^www\./i, "").replace(/\/$/, "")), "i"))) continue;
            claims.push(link);
          }
        }
        if (!claims.length) continue;
        const list = dedupe(claims);
        add(
          "unsourced-claim",
          line,
          (list.length === 1 ? q(list[0], 40) + " is" : list.slice(0, 4).map((c) => q(c, 30)).join(", ") + " are") + " not something the person gave, in " + q(t, 60) + ".",
          "Use the person's real figure, name or link, or put a plain placeholder such as \"Your stat here\" and say so in the reply. Keep it if it came from their footage or files.",
        );
      }
    }

    // ---- spoken lines
    if (spoken) {
      const whole = mine.map((l) => l.text).join(" ");
      if (runs("no-contractions")) {
        const stiff = whole.match(/\b(?:it is|that is|there is|here is|what is|who is|he is|she is|you are|we are|they are|i am|do not|does not|did not|is not|are not|was not|were not|will not|would not|should not|could not|can not|cannot|have not|has not|had not|you will|we will|i will|they will|it will|you have|we have|i have|they have|let us)\b/gi) || [];
        const loose = /\b(?:it|that|there|here|what|who|he|she|let)'s\b|'(?:re|ll|ve|d|m)\b|n't\b/i.test(whole);
        if (stiff.length >= 2 && !loose && wordsOf(whole).length >= 12) {
          const shown = dedupe(stiff.map((s) => s.toLowerCase())).slice(0, 3);
          const CONTRACT = { "it is": "it's", "that is": "that's", "there is": "there's", "here is": "here's", "what is": "what's", "who is": "who's", "he is": "he's", "she is": "she's", "you are": "you're", "we are": "we're", "they are": "they're", "i am": "I'm", "do not": "don't", "does not": "doesn't", "did not": "didn't", "is not": "isn't", "are not": "aren't", "was not": "wasn't", "were not": "weren't", "will not": "won't", "would not": "wouldn't", "should not": "shouldn't", "could not": "couldn't", "can not": "can't", cannot: "can't", "have not": "haven't", "has not": "hasn't", "had not": "hadn't", "you will": "you'll", "we will": "we'll", "i will": "I'll", "they will": "they'll", "it will": "it'll", "you have": "you've", "we have": "we've", "i have": "I've", "they have": "they've", "let us": "let's" };
          add("no-contractions", mine[0], "The script never uses a contraction: " + shown.map((s) => '"' + s + '"').join(", ") + ".", "Write them the way people say them: " + shown.map((s) => '"' + CONTRACT[s] + '"').join(", ") + ".");
        }
      }
      if (runs("same-opener") && mine.length >= 3) {
        // "So", "Okay", "Look" are fine once. Not on every line.
        const starts = {};
        for (const line of mine) {
          const first = (line.text.match(/^["']?(so|okay|ok|now|well|look|and|but|alright|right|basically|honestly|here's the thing)\b/i) || [])[1];
          if (first) (starts[first.toLowerCase()] = starts[first.toLowerCase()] || []).push(line);
        }
        for (const word of Object.keys(starts)) {
          const group = starts[word];
          if (group.length >= 3 && group.length * 2 > mine.length) {
            add("same-opener", group[1], group.length + " of the " + mine.length + " lines start with \"" + group[0].text.slice(0, word.length) + "\", like " + q(group[1].text, 50) + ".", "Keep it on one line and start the others with the fact or the action.");
            break;
          }
        }
      }
      for (const line of mine) {
        const t = line.text;
        if (runs("stage-direction")) {
          const m = t.match(/\[[^\]\n]{1,30}\]|\((?:pause|beat|laughs?|laughing|sighs?|excited|whispers?|whispering|music|sfx|dramatic|smiling|softly|loudly|cheerful|serious)[^)]{0,20}\)|(?:^|\s)\*[\p{L} ]{2,24}\*(?=\s|$)/iu) || line.raw.match(/(?:^|\s)\*[\p{L} ]{2,24}\*(?=\s|$)/u);
          if (m && !asked.typed(new RegExp(esc(m[0].trim()), "i")) && !asked.typed(/\b(?:audio tags?|stage directions?|emotion tags?)\b/i)) add("stage-direction", line, "Stage direction " + q(m[0].trim(), 30) + " is in the script, and the voice will read it or guess at it.", "Take it out and let punctuation set the delivery: a comma for a breath, \"...\" for a beat.");
        }
        if (runs("semicolon-line") && /;/.test(t)) add("semicolon-line", line, "A spoken line holds two ideas joined by a semicolon: " + q(t, 70) + ".", "Split it into two lines at the semicolon.");
        if (runs("not-for-the-ear")) {
          const m = t.match(/https?:\/\/\S+|\bwww\.\S+|\s&\s|\bw\/|\be\.g\.|\bi\.e\.|\betc\./i);
          if (m) add("not-for-the-ear", line, q(m[0].trim(), 30) + " is written for the eye, in " + q(t, 60) + ".", "Write what the voice should say: \"and\", \"for example\", the site name as words.");
        }
      }
    }

    // ---- call to action: one action
    if (runs("cta-two-actions")) {
      for (const line of mine) {
        const m = line.text.match(new RegExp("^\\W*(?:" + CTA_VERBS + ")\\b[^.!?]*?(?:\\band\\b|&|\\bthen\\b|\\+|,)\\s*(?:" + CTA_VERBS + ")\\b", "i"));
        if (m) add("cta-two-actions", line, q(line.text, 60) + " asks for two actions.", "One action per end card: keep the one that matters, like \"Subscribe\" or \"Watch part 2\".");
      }
    }
  }

  problems.sort((a, b) => Number(b.hard) - Number(a.hard));
  const hard = problems.filter((p) => p.hard).length;
  const softRules = dedupe(problems.filter((p) => !p.hard).map((p) => p.rule));
  const words = lines.reduce((sum, l) => sum + l.words, 0);
  const verdict = hard ? "slop" : softRules.length >= SOFT_LIMIT ? "slop" : softRules.length ? "tells" : "ok";
  return {
    verdict,
    problems,
    stats: {
      kind,
      lines: lines.length,
      words,
      hard,
      soft: problems.length - hard,
      softRules,
      softLimit: SOFT_LIMIT,
      theirs: lines.filter((l) => l.theirs).length,
      askedKnown: asked.known,
    },
  };
}

// One sentence for a refusal or a note: the first problem and its fix.
function summary(result) {
  const r = result || {};
  const list = Array.isArray(r.problems) ? r.problems : [];
  if (!list.length) return "";
  const p = list[0];
  const more = list.length > 1 ? " (" + (list.length - 1) + " more)" : "";
  return String(p.what).trim() + " " + String(p.fix).trim() + more;
}

module.exports = { visibleText, lintCopy, COPY_RULES, scriptTexts, cssTexts, summary };
