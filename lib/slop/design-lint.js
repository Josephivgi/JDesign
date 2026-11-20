"use strict";

// Static design-slop lint for the HTML, CSS and script an agent sends as a
// card or a code animation. It reads the source the way a reviewer reads the
// still: what color leads, which fonts will really load, what is centered,
// what glows, what bounces. Pure text in, findings out, no browser.
//
//   const { lintDesign, RULES } = require("./slop/design-lint");
//   lintDesign({ html, css, js, vars, colors, kind, width, height, durationMs },
//              { allow, style, styles, asked, fonts })
//     -> { verdict: "ok" | "tells" | "slop", problems: [{ rule, hard, what, fix, where }], stats }
//
// A hard problem is enough to refuse on its own. Soft tells make "slop" only
// when three or more different ones are present (skills/design-slop: "One tell
// alone is fine. A design with three or four is slop").
//
// The rules follow skills/design-slop/SKILL.md section by section. What a
// style skill or the person's own words unlock is in STYLE_UNLOCKS and ASKED.

// ------------------------------------------------------------------ the rules

const RULES = [
  // color
  { id: "default-gradient", group: "color", hard: true, title: "The #667eea to #764ba2 gradient" },
  { id: "purple-gradient", group: "color", hard: true, title: "Purple to blue or pink to purple gradient" },
  { id: "gradient-text", group: "color", hard: true, title: "Gradient text (background-clip: text)" },
  { id: "purple-main", group: "color", hard: false, title: "Purple, violet or indigo as the main color" },
  { id: "neon-on-dark", group: "color", hard: false, title: "Cyan or neon accent on near-black" },
  { id: "gradient-fill", group: "color", hard: false, title: "Gradient as a fill behind type, a button or the background, or more than one gradient" },
  { id: "glow", group: "color", hard: false, title: "Colored glow shadow" },
  { id: "gray-on-color", group: "color", hard: false, title: "Gray text on a colored plate" },
  { id: "cream-default", group: "color", hard: false, title: "Cream page with a centered serif headline" },
  // type
  { id: "font-missing", group: "type", hard: true, title: "Font that is not on the computer" },
  { id: "font-default", group: "type", hard: false, title: "System font for everything, or one family at one weight" },
  { id: "font-no-fallback", group: "type", hard: false, title: "Office font with no fallback and no generic family" },
  { id: "type-scale", group: "type", hard: false, title: "Sizes with no clear step" },
  { id: "tracking", group: "type", hard: false, title: "Wide tracked caps or crushed display type" },
  { id: "eyebrow", group: "type", hard: false, title: "Eyebrow label over the headline that adds no fact" },
  { id: "italic-serif-hero", group: "type", hard: false, title: "Italic serif hero headline" },
  { id: "icon-tile", group: "type", hard: false, title: "Icon in a rounded tile above a heading" },
  { id: "text-tiny", group: "type", hard: false, title: "Web sized text on a video frame" },
  { id: "weight-soup", group: "type", hard: false, title: "Four or more font weights" },
  // layout
  { id: "centered", group: "layout", hard: false, title: "Everything centered, or a centered paragraph or lower third" },
  { id: "equal-boxes", group: "layout", hard: false, title: "Three or more equal boxes in a row" },
  { id: "stat-row", group: "layout", hard: false, title: "Row of big numbers with small labels" },
  { id: "card-in-card", group: "layout", hard: false, title: "Card inside a card" },
  { id: "pulsing-dot", group: "layout", hard: false, title: "Pulsing dot as decoration" },
  { id: "numbered-markers", group: "layout", hard: false, title: "01, 02, 03 markers" },
  // shape and surface
  { id: "radius", group: "shape", hard: false, title: "Large radius or pill shape on every box, or many different radii" },
  { id: "side-stripe", group: "shape", hard: false, title: "Thick colored bar on one side of a rounded box" },
  { id: "hairline-shadow", group: "shape", hard: false, title: "Hairline border and soft wide shadow on one box" },
  { id: "shadow-everywhere", group: "shape", hard: false, title: "Shadow on every element" },
  { id: "glass", group: "shape", hard: false, title: "Glassmorphism" },
  { id: "texture-overlay", group: "shape", hard: false, title: "Stripes, grid dots or noise laid over a surface" },
  // decoration
  { id: "emoji", group: "decoration", hard: true, title: "Emoji as icons or decoration" },
  { id: "sparkle-char", group: "decoration", hard: false, title: "Sparkle, star or check characters as decoration" },
  { id: "blur-orbs", group: "decoration", hard: false, title: "Blurred orbs or blobs in the background" },
  { id: "particles", group: "decoration", hard: false, title: "Particles, confetti or sparks" },
  { id: "effect-stack", group: "decoration", hard: false, title: "Four or more effects stacked on one design" },
  // motion
  { id: "motion-bounce", group: "motion", hard: false, title: "Bounce, elastic or overshoot easing on type" },
  { id: "motion-layout", group: "motion", hard: false, title: "Animating width, height, margin or position" },
  { id: "motion-triple", group: "motion", hard: false, title: "Fade, slide and scale on one element" },
  { id: "motion-stagger", group: "motion", hard: false, title: "Every line on its own delay in under three seconds" },
  { id: "motion-loop", group: "motion", hard: false, title: "Looping pulse, shimmer or float" },
];

const RULE_BY_ID = new Map(RULES.map((r) => [r.id, r]));

// What each style skill unlocks, read from skills/style-<id>/SKILL.md. A style
// unlocks only what its own text asks for; everything else still applies.
// An entry with a colon is a limited unlock ("gradient-text:once", "motion-bounce:overshoot"),
// handled in the check itself. A style that unlocks glow still gets it on two elements at most.
const STYLE_UNLOCKS = {
  anime: ["gradient-fill", "motion-bounce:overshoot", "texture-overlay", "motion-loop"],
  blueprint: ["texture-overlay"],
  flat: [],
  ink: ["texture-overlay"],
  lowpoly: ["particles"],
  minimalist: [],
  neon: ["glow", "neon-on-dark", "motion-loop", "texture-overlay"],
  oil: ["gradient-fill", "texture-overlay", "particles"],
  papercut: ["shadow-everywhere", "texture-overlay"],
  pencil: ["texture-overlay"],
  pixel: ["texture-overlay"],
  popart: ["motion-bounce:overshoot", "texture-overlay", "shadow-everywhere"],
  stainedglass: ["particles"],
  synthwave: ["purple-main", "purple-gradient", "gradient-fill", "gradient-text:once", "glow", "neon-on-dark", "texture-overlay", "motion-loop"],
  watercolor: ["blur-orbs", "texture-overlay"],
};

// The person's own words. Each entry: the words, then the rules they switch
// off. A match right after "no", "not", "without", "avoid" and the like does
// not count, so "no purple gradients" in standing instructions unlocks nothing.
const ASKED = [
  [/\b(purple|violet|indigo|lavender|lilac|magenta|plum|grape|amethyst|twitch)\b/, ["purple-main"]],
  [/\b(purple|violet|indigo|lavender|lilac|magenta|pink)\b[^.\n]{0,40}\bgradients?\b|\bgradients?\b[^.\n]{0,40}\b(purple|violet|indigo|lavender|lilac|magenta)\b/, ["purple-gradient", "default-gradient", "gradient-fill", "purple-main"]],
  [/\bgradient (text|type|title|headline|lettering|word|fill on the (text|title|headline))\b|\b(text|type|title|headline|letters|word)s? (with|in) an? [a-z ]{0,20}gradient\b/, ["gradient-text"]],
  [/\b(gradients?|ombre|duotone|sunset|sunrise|sky|aurora|iridescent|holographic|rainbow)\b/, ["gradient-fill"]],
  [/\b(glass|glassy|frosted|glassmorphi\w*|translucent|see[- ]through)\b/, ["glass"]],
  [/\b(neon|cyberpunk|synthwave|vaporwave|retrowave|outrun|tron|arcade|hacker|matrix|rave)\b/, ["neon-on-dark", "glow"]],
  [/\b(glow|glows|glowing|glowy|bloom|halo|luminous|backlit)\b/, ["glow"]],
  [/\b(cyan|aqua|turquoise|electric blue|lime green|hot pink|acid green)\b/, ["neon-on-dark"]],
  [/\b(emoji|emojis|emoticons?)\b/, ["emoji", "sparkle-char"]],
  [/\b(sparkles?|stars?|check ?marks?|ticks?|hearts?|arrows?|dingbats?|symbols?)\b/, ["sparkle-char"]],
  [/\b(cent(er|re)(ed|d)?|middle of the (frame|screen|card)|symmetr\w+)\b/, ["centered"]],
  [/\b(bounc\w*|elastic|springy?|spring animation|overshoot|playful|wobbl\w*|jiggl\w*|rubber\w*)\b/, ["motion-bounce"]],
  [/\b(puls\w+|loop(s|ed|ing)?|shimmer\w*|float(s|ing)?|breath\w+|blink\w*|flicker\w*|throb\w*|heartbeat)\b/, ["motion-loop", "pulsing-dot"]],
  [/\b(confetti|celebrat\w+|party|birthday|congrat\w+|fireworks?|particles?|sparks?|snow\w*|rain|stars|starfield|bubbles|bokeh|dust|embers|petals|lens flares?|light leaks?)\b/, ["particles"]],
  [/\b(cream|beige|ivory|off[- ]white|parchment|paper|sand|linen|oat|eggshell)\b/, ["cream-default"]],
  [/\b(pill|pills|pill[- ]shaped|rounded|round corners?|bubbly|soft corners?|big radius)\b/, ["radius"]],
  [/\b(shadows?|drop shadows?|elevat\w+|depth|layered paper|paper ?cut)\b/, ["shadow-everywhere", "hairline-shadow"]],
  [/\b(three|3|four|4|five|5|six|6) (equal )?(boxes|cards|columns|tiles|panels|features|steps|points)\b|\b(grid|row) of (boxes|cards|tiles|features|icons)\b|\bfeature (cards|grid|row)\b|\bbento\b/, ["equal-boxes", "card-in-card"]],
  [/\b(stats?|statistics|numbers|metrics|kpis?|scoreboard|scores?) (row|bar|strip|grid|side by side)\b|\brow of (stats|numbers|metrics)\b/, ["stat-row", "equal-boxes"]],
  [/\b(eyebrow|kicker|overline|badges?|chips?|tags?|labels?|stickers?|ribbons?)\b/, ["eyebrow"]],
  [/\bitalics?\b/, ["italic-serif-hero"]],
  [/\b(wide(ly)? (spaced|tracked)|letter[- ]?spac\w+|tracked[- ]out|spaced[- ]out (caps|letters)|tight tracking|tightly (set|tracked))\b/, ["tracking"]],
  [/\b(stripes?|striped|grid|dots?|dotted|noise|grain\w*|textur\w+|halftone|scanlines?|hatch\w*|checker\w*|plaid|pinstripe)\b/, ["texture-overlay"]],
  [/\b(blur(red|ry)?|orbs?|blobs?|bokeh|mesh gradient|soft shapes?|lava lamp)\b/, ["blur-orbs"]],
  [/\b(system font|system-ui|default font|plain font|one font|single font)\b/, ["font-default"]],
  [/\b(numbered|numbers? (on|for) each|steps?|step by step|ranking|ranked|top (3|5|10|three|five|ten)|countdown|ordered)\b/, ["numbered-markers"]],
  [/\b(left|side|accent|colou?red) (bar|border|stripe|edge)\b/, ["side-stripe"]],
  [/\b(tiny|small|fine) (text|print|type)\b|\bfootnote\b|\bdisclaimer\b|\bwatermark\b/, ["text-tiny"]],
  [/\b(icons?|logo|badge|app icon)\b/, ["icon-tile"]],
  [/\b(card in(side)? a card|nested (cards?|box(es)?|panels?))\b/, ["card-in-card"]],
  [/\b(stagger\w*|one (line|word|letter) at a time|line by line|cascade)\b/, ["motion-stagger"]],
  [/\b(grow|expand|stretch|widen|progress bar|fill(s|ing)? up|typewriter)\b/, ["motion-layout"]],
];

// ---------------------------------------------------------------------- fonts

// Families that ship with Windows 11.
const CORE_FONTS = [
  "arial", "arial black", "bahnschrift", "calibri", "calibri light", "cambria", "cambria math", "candara", "candara light",
  "cascadia code", "cascadia mono", "comic sans ms", "consolas", "constantia", "corbel", "corbel light", "courier new", "ebrima",
  "franklin gothic medium", "gabriola", "gadugi", "georgia", "impact", "ink free", "javanese text", "leelawadee ui",
  "lucida console", "lucida sans unicode", "malgun gothic", "microsoft himalaya", "microsoft jhenghei", "microsoft jhenghei ui",
  "microsoft new tai lue", "microsoft phagspa", "microsoft sans serif", "microsoft tai le", "microsoft yahei", "microsoft yahei ui",
  "microsoft yi baiti", "mingliu-extb", "pmingliu-extb", "mongolian baiti", "ms gothic", "ms ui gothic", "ms pgothic", "mv boli",
  "myanmar text", "nirmala ui", "palatino linotype", "sans serif collection", "segoe print", "segoe script", "segoe ui",
  "segoe ui black", "segoe ui light", "segoe ui semibold", "segoe ui semilight", "segoe ui emoji", "segoe ui historic",
  "segoe ui symbol", "segoe ui variable", "segoe ui variable display", "segoe ui variable text", "segoe ui variable small",
  "simsun", "nsimsun", "sitka", "sitka small", "sitka text", "sitka subheading", "sitka heading", "sitka display", "sitka banner",
  "segoe fluent icons", "segoe mdl2 assets", "marlett", "simsun-extb", "sylfaen", "symbol", "tahoma", "times new roman", "trebuchet ms", "verdana", "webdings", "wingdings", "yu gothic", "yu gothic ui",
  // Names Windows maps onto a core face.
  "helvetica", "times", "courier",
];

// Families that come with Office. On the computer when Office is, so a stack
// that leads with one needs a core face or a generic family behind it.
const OFFICE_FONTS = [
  "agency fb", "algerian", "arial narrow", "arial rounded mt bold", "baskerville old face", "bauhaus 93", "bell mt",
  "berlin sans fb", "berlin sans fb demi", "bernard mt condensed", "blackadder itc", "bodoni mt", "bodoni mt black",
  "bodoni mt condensed", "bodoni mt poster compressed", "book antiqua", "bookman old style", "bradley hand itc", "britannic bold",
  "broadway", "brush script mt", "californian fb", "calisto mt", "castellar", "centaur", "century", "century gothic",
  "century schoolbook", "chiller", "colonna mt", "cooper black", "copperplate gothic bold", "copperplate gothic light", "curlz mt",
  "dubai", "edwardian script itc", "elephant", "engravers mt", "eras bold itc", "eras demi itc", "eras light itc", "eras medium itc",
  "felix titling", "footlight mt light", "forte", "franklin gothic book", "franklin gothic demi", "franklin gothic demi cond",
  "franklin gothic heavy", "franklin gothic medium cond", "freestyle script", "french script mt", "garamond", "gigi", "gill sans mt",
  "gill sans mt condensed", "gill sans mt ext condensed bold", "gill sans ultra bold", "gill sans ultra bold condensed",
  "gloucester mt extra condensed", "goudy old style", "goudy stout", "haettenschweiler", "harlow solid italic", "harrington",
  "high tower text", "imprint mt shadow", "informal roman", "jokerman", "juice itc", "kristen itc", "kunstler script", "leelawadee",
  "lucida bright", "lucida calligraphy", "lucida fax", "lucida handwriting", "lucida sans", "lucida sans typewriter", "magneto",
  "maiandra gd", "matura mt script capitals", "mistral", "modern no. 20", "monotype corsiva", "ms reference sans serif",
  "niagara engraved", "niagara solid", "ocr a extended", "old english text mt", "onyx", "palace script mt", "papyrus", "parchment",
  "perpetua", "perpetua titling mt", "playbill", "poor richard", "pristina", "rage italic", "ravie", "rockwell", "rockwell condensed",
  "rockwell extra bold", "script mt bold", "showcard gothic", "snap itc", "stencil", "tempus sans itc", "tw cen mt",
  "tw cen mt condensed", "tw cen mt condensed extra bold", "viner hand itc", "vivaldi", "vladimir script", "wide latin",
  "wingdings 2", "wingdings 3",
];

const GENERIC_FONTS = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "math", "emoji", "fangsong"]);
// Resolve to the system face on Windows, or are skipped on the way to it.
const SYSTEM_FONTS = new Set(["system-ui", "ui-sans-serif", "ui-serif", "ui-monospace", "ui-rounded", "-apple-system", "blinkmacsystemfont", "sans-serif"]);
const CSS_WIDE = new Set(["inherit", "initial", "unset", "revert", "revert-layer"]);

// Common web and Mac fonts an agent reaches for. None is on the computer. The
// class picks the installed face to suggest instead.
const WEB_FONTS = {
  sans: ["inter", "inter tight", "inter var", "roboto", "open sans", "geist", "geist sans", "plus jakarta sans", "dm sans", "manrope", "lato", "source sans pro", "source sans 3", "noto sans", "work sans", "ibm plex sans", "public sans", "figtree", "onest", "albert sans", "hanken grotesk", "instrument sans", "be vietnam pro", "mulish", "karla", "sf pro", "sf pro display", "sf pro text", "san francisco", "helvetica neue", "avenir", "avenir next", "aptos", "ubuntu", "cantarell", "oxygen", "fira sans", "noto sans display", "satoshi", "general sans", "switzer", "neue montreal", "s\u00F6hne", "sohne", "graphik", "circular", "proxima nova", "gotham", "futura", "gill sans", "lucida grande", "geneva", "optima"],
  geo: ["poppins", "montserrat", "space grotesk", "outfit", "sora", "urbanist", "lexend", "raleway", "josefin sans", "red hat display", "syne", "unbounded", "clash display", "cabinet grotesk", "bricolage grotesque", "archivo", "exo", "exo 2", "orbitron", "rajdhani", "kanit", "jost", "league spartan", "rubik", "epilogue", "familjen grotesk", "dm serif text", "audiowide", "michroma", "chakra petch", "titillium web", "barlow", "saira"],
  serif: ["playfair display", "merriweather", "lora", "cormorant", "cormorant garamond", "eb garamond", "libre baskerville", "dm serif display", "instrument serif", "fraunces", "newsreader", "source serif pro", "source serif 4", "crimson text", "crimson pro", "pt serif", "noto serif", "spectral", "bitter", "ibm plex serif", "libre caslon text", "cinzel", "cinzel decorative", "abril fatface", "bodoni moda", "prata", "marcellus", "tiempos", "canela", "new york", "baskerville", "didot", "hoefler text", "palatino", "charter", "iowan old style", "young serif", "gloock", "roboto serif", "literata", "alegreya", "vollkorn", "zilla slab", "roboto slab", "arvo", "josefin slab"],
  mono: ["jetbrains mono", "fira code", "fira mono", "roboto mono", "ibm plex mono", "space mono", "source code pro", "geist mono", "sf mono", "menlo", "monaco", "ubuntu mono", "dm mono", "inconsolata", "courier prime", "anonymous pro", "hack", "victor mono", "commit mono", "red hat mono", "andale mono", "share tech mono", "major mono display", "overpass mono", "martian mono", "azeret mono"],
  cond: ["bebas neue", "oswald", "anton", "league gothic", "fjalla one", "archivo black", "archivo narrow", "barlow condensed", "roboto condensed", "big shoulders display", "teko", "pathway gothic one", "antonio", "staatliches", "alfa slab one", "black ops one", "russo one", "passion one", "bowlby one", "dela gothic one", "rubik mono one", "paytone one", "squada one", "din", "din condensed", "din alternate"],
  hand: ["caveat", "patrick hand", "pacifico", "dancing script", "permanent marker", "kalam", "indie flower", "shadows into light", "satisfy", "great vibes", "sacramento", "lobster", "amatic sc", "gloria hallelujah", "rock salt", "reenie beanie", "homemade apple", "architects daughter", "handlee", "nanum pen script", "gochi hand", "marker felt", "bradley hand", "chalkboard", "chalkduster", "comic neue", "brush script", "snell roundhand", "noteworthy", "parisienne", "allura", "kaushan script", "yellowtail", "courgette", "cookie"],
  round: ["nunito", "nunito sans", "quicksand", "fredoka", "fredoka one", "comfortaa", "baloo", "baloo 2", "varela round", "m plus rounded 1c", "sniglet", "chewy", "bubblegum sans", "lilita one", "titan one", "luckiest guy", "bangers", "boogaloo", "fredericka the great", "dongle", "sf pro rounded", "arial rounded"],
  pixel: ["press start 2p", "vt323", "silkscreen", "pixelify sans", "dotgothic16", "pixel operator", "minecraft", "04b03", "tiny5", "jersey 10", "handjet"],
  black: ["unifrakturmaguntia", "unifrakturcook", "pirata one", "metal mania", "new rocker", "creepster", "nosifer", "almendra", "uncial antiqua", "medievalsharp", "blackletter"],
};
const WEB_FONT_CLASS = new Map();
for (const cls of Object.keys(WEB_FONTS)) for (const name of WEB_FONTS[cls]) WEB_FONT_CLASS.set(name, cls);

const FONT_FIX = {
  sans: 'Corbel, "Segoe UI", sans-serif for support lines, or "Segoe UI Black", "Arial Black", sans-serif for a headline',
  geo: 'Bahnschrift, "Tw Cen MT", "Segoe UI", sans-serif, or "Segoe UI Black", Impact, sans-serif for a heavy headline',
  serif: 'Georgia, "Palatino Linotype", serif, or Constantia, Cambria, serif',
  mono: 'Consolas, "Cascadia Mono", "Lucida Console", monospace',
  cond: 'Impact, Haettenschweiler, "Arial Narrow", sans-serif',
  hand: '"Ink Free", "Segoe Print", cursive',
  round: '"Arial Rounded MT Bold", "Trebuchet MS", sans-serif',
  pixel: '"OCR A Extended", "Lucida Console", Consolas, monospace',
  black: '"Old English Text MT", "Palatino Linotype", Georgia, serif',
  unknown: 'an installed face such as Georgia, Constantia, Bahnschrift, Impact, "Segoe UI Black", Corbel, Consolas or "Ink Free", then a generic family',
};

const SERIF_FONTS = new Set([
  "serif", "ui-serif", "georgia", "cambria", "constantia", "palatino linotype", "times new roman", "times", "book antiqua", "bodoni mt",
  "bodoni mt black", "garamond", "baskerville old face", "bell mt", "calisto mt", "centaur", "century", "century schoolbook",
  "californian fb", "goudy old style", "high tower text", "perpetua", "sitka", "sitka small", "sitka text", "sitka subheading",
  "sitka heading", "sitka display", "sitka banner", "sylfaen", "bookman old style", "lucida bright", "footlight mt light", "elephant",
  "modern no. 20", "poor richard",
]);

const INSTALLED = new Set([...CORE_FONTS, ...OFFICE_FONTS]);
const OFFICE_SET = new Set(OFFICE_FONTS);
const FACE_SUFFIX = /\s+(thin|hairline|extra ?light|ultra ?light|light|semi ?light|regular|normal|book|medium|semi ?bold|demi ?bold|demi|bold|extra ?bold|ultra ?bold|heavy|black|italic|oblique|condensed|semi ?condensed|narrow|cond)$/;

function fontKey(name) {
  return String(name || "").trim().replace(/^['"]|['"]$/g, "").replace(/\s+/g, " ").toLowerCase();
}

// installed | office | generic | system | web | unknown
function fontKind(key, extra) {
  if (!key) return "unknown";
  if (GENERIC_FONTS.has(key) && key !== "sans-serif") return "generic";
  if (SYSTEM_FONTS.has(key)) return "system";
  if (extra && extra.has(key)) return "installed";
  if (OFFICE_SET.has(key)) return "office";
  if (INSTALLED.has(key)) return "installed";
  if (WEB_FONT_CLASS.has(key)) return "web";
  // "Segoe UI Bold", "Bahnschrift SemiCondensed", "Georgia Italic": a face of an installed family.
  let k = key;
  for (let i = 0; i < 3; i += 1) {
    const cut = k.replace(FACE_SUFFIX, "");
    if (cut === k) break;
    k = cut;
    if (extra && extra.has(k)) return "installed";
    if (OFFICE_SET.has(k)) return "office";
    if (INSTALLED.has(k)) return "installed";
    if (WEB_FONT_CLASS.has(k)) return "web";
  }
  return "unknown";
}

function fontClass(key) {
  let k = key;
  for (let i = 0; i < 4; i += 1) {
    if (WEB_FONT_CLASS.has(k)) return WEB_FONT_CLASS.get(k);
    const cut = k.replace(FACE_SUFFIX, "");
    if (cut === k) break;
    k = cut;
  }
  if (/mono|code|console|terminal/.test(key)) return "mono";
  if (/serif|slab|garamond|caslon|bodoni|didot|roman|antiqua|book/.test(key) && !/sans/.test(key)) return "serif";
  if (/script|hand|brush|marker|pen|chalk|crayon/.test(key)) return "hand";
  if (/pixel|8bit|8-bit|bit ?map|arcade/.test(key)) return "pixel";
  if (/condensed|narrow|compressed|gothic|impact/.test(key)) return "cond";
  if (/round/.test(key)) return "round";
  if (/sans|grotesk|grotesque|display/.test(key)) return "geo";
  return "unknown";
}

function isSerifKey(key) {
  if (SERIF_FONTS.has(key)) return true;
  const cut = key.replace(FACE_SUFFIX, "");
  if (cut !== key && SERIF_FONTS.has(cut)) return true;
  return WEB_FONT_CLASS.get(key) === "serif";
}

// --------------------------------------------------------------- text helpers

// Index of the bracket that closes the one at `open`, strings respected.
function closeOf(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i += 1) {
    const c = s[i];
    if (c === '"' || c === "'") {
      const end = s.indexOf(c, i + 1);
      if (end < 0) return s.length - 1;
      i = end;
    } else if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return s.length - 1;
}

// Split on a separator at bracket depth 0. sep " " splits on any whitespace.
function splitTop(s, sep) {
  const out = [];
  let depth = 0, start = 0;
  const text = String(s == null ? "" : s);
  const space = sep === " ";
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const end = text.indexOf(c, i + 1);
      i = end < 0 ? text.length : end;
    } else if (c === "(" || c === "[") depth += 1;
    else if (c === ")" || c === "]") depth = Math.max(0, depth - 1);
    else if (depth === 0 && (space ? c === " " || c === "\n" || c === "\t" || c === "\r" : c === sep)) {
      const part = text.slice(start, i).trim();
      if (part || !space) out.push(part);
      start = i + 1;
    }
  }
  const last = text.slice(start).trim();
  if (last || (!space && out.length)) out.push(last);
  return out;
}

// Every call of a function whose name matches, with its argument text.
function findCalls(value, nameRe) {
  const out = [];
  const re = new RegExp("(" + nameRe + ")\\(", "gi");
  let m;
  while ((m = re.exec(value))) {
    const open = m.index + m[0].length - 1;
    const before = m.index > 0 ? value[m.index - 1] : "";
    if (/[a-z0-9_-]/i.test(before)) continue;
    const close = closeOf(value, open);
    out.push({ name: m[1].toLowerCase(), args: value.slice(open + 1, close), start: m.index, end: close + 1 });
    re.lastIndex = close + 1;
  }
  return out;
}

function short(text, max) {
  const t = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  const n = max || 60;
  return t.length > n ? t.slice(0, n - 3).trimEnd() + "..." : t;
}

// --------------------------------------------------------------------- colors

const NAMED_COLORS = {
  aliceblue: "f0f8ff", antiquewhite: "faebd7", aqua: "00ffff", aquamarine: "7fffd4", azure: "f0ffff", beige: "f5f5dc", bisque: "ffe4c4",
  black: "000000", blanchedalmond: "ffebcd", blue: "0000ff", blueviolet: "8a2be2", brown: "a52a2a", burlywood: "deb887", cadetblue: "5f9ea0",
  chartreuse: "7fff00", chocolate: "d2691e", coral: "ff7f50", cornflowerblue: "6495ed", cornsilk: "fff8dc", crimson: "dc143c", cyan: "00ffff",
  darkblue: "00008b", darkcyan: "008b8b", darkgoldenrod: "b8860b", darkgray: "a9a9a9", darkgreen: "006400", darkgrey: "a9a9a9",
  darkkhaki: "bdb76b", darkmagenta: "8b008b", darkolivegreen: "556b2f", darkorange: "ff8c00", darkorchid: "9932cc", darkred: "8b0000",
  darksalmon: "e9967a", darkseagreen: "8fbc8f", darkslateblue: "483d8b", darkslategray: "2f4f4f", darkslategrey: "2f4f4f",
  darkturquoise: "00ced1", darkviolet: "9400d3", deeppink: "ff1493", deepskyblue: "00bfff", dimgray: "696969", dimgrey: "696969",
  dodgerblue: "1e90ff", firebrick: "b22222", floralwhite: "fffaf0", forestgreen: "228b22", fuchsia: "ff00ff", gainsboro: "dcdcdc",
  ghostwhite: "f8f8ff", gold: "ffd700", goldenrod: "daa520", gray: "808080", green: "008000", greenyellow: "adff2f", grey: "808080",
  honeydew: "f0fff0", hotpink: "ff69b4", indianred: "cd5c5c", indigo: "4b0082", ivory: "fffff0", khaki: "f0e68c", lavender: "e6e6fa",
  lavenderblush: "fff0f5", lawngreen: "7cfc00", lemonchiffon: "fffacd", lightblue: "add8e6", lightcoral: "f08080", lightcyan: "e0ffff",
  lightgoldenrodyellow: "fafad2", lightgray: "d3d3d3", lightgreen: "90ee90", lightgrey: "d3d3d3", lightpink: "ffb6c1",
  lightsalmon: "ffa07a", lightseagreen: "20b2aa", lightskyblue: "87cefa", lightslategray: "778899", lightslategrey: "778899",
  lightsteelblue: "b0c4de", lightyellow: "ffffe0", lime: "00ff00", limegreen: "32cd32", linen: "faf0e6", magenta: "ff00ff",
  maroon: "800000", mediumaquamarine: "66cdaa", mediumblue: "0000cd", mediumorchid: "ba55d3", mediumpurple: "9370db",
  mediumseagreen: "3cb371", mediumslateblue: "7b68ee", mediumspringgreen: "00fa9a", mediumturquoise: "48d1cc",
  mediumvioletred: "c71585", midnightblue: "191970", mintcream: "f5fffa", mistyrose: "ffe4e1", moccasin: "ffe4b5",
  navajowhite: "ffdead", navy: "000080", oldlace: "fdf5e6", olive: "808000", olivedrab: "6b8e23", orange: "ffa500", orangered: "ff4500",
  orchid: "da70d6", palegoldenrod: "eee8aa", palegreen: "98fb98", paleturquoise: "afeeee", palevioletred: "db7093",
  papayawhip: "ffefd5", peachpuff: "ffdab9", peru: "cd853f", pink: "ffc0cb", plum: "dda0dd", powderblue: "b0e0e6", purple: "800080",
  rebeccapurple: "663399", red: "ff0000", rosybrown: "bc8f8f", royalblue: "4169e1", saddlebrown: "8b4513", salmon: "fa8072",
  sandybrown: "f4a460", seagreen: "2e8b57", seashell: "fff5ee", sienna: "a0522d", silver: "c0c0c0", skyblue: "87ceeb",
  slateblue: "6a5acd", slategray: "708090", slategrey: "708090", snow: "fffafa", springgreen: "00ff7f", steelblue: "4682b4",
  tan: "d2b48c", teal: "008080", thistle: "d8bfd8", tomato: "ff6347", turquoise: "40e0d0", violet: "ee82ee", wheat: "f5deb3",
  white: "ffffff", whitesmoke: "f5f5f5", yellow: "ffff00", yellowgreen: "9acd32",
};

// A value the linter could not know (an unset variable, a number computed in
// script). Color and size parsers give up on it instead of guessing.
const UNKNOWN = "\u0001";

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function linearToSrgb(c) {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return clamp01(v);
}

function linearToOklab(r, g, b) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function oklabToLinear(L, a, b) {
  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
  const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3);
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}

// A parsed color: sRGB 0..1, alpha, and its OKLCH reading (L 0..1, C, h in degrees).
function makeColor(r, g, b, a) {
  const col = { r: clamp01(r), g: clamp01(g), b: clamp01(b), a: a == null ? 1 : clamp01(a) };
  const lab = linearToOklab(srgbToLinear(col.r), srgbToLinear(col.g), srgbToLinear(col.b));
  col.L = lab[0];
  col.C = Math.hypot(lab[1], lab[2]);
  let h = (Math.atan2(lab[2], lab[1]) * 180) / Math.PI;
  if (h < 0) h += 360;
  col.h = h;
  col.la = lab[1];
  col.lb = lab[2];
  return col;
}
function fromLinear(r, g, b, a) {
  return makeColor(linearToSrgb(r), linearToSrgb(g), linearToSrgb(b), a);
}
function fromOklab(L, a, b, alpha) {
  const lin = oklabToLinear(L, a, b);
  return fromLinear(lin[0], lin[1], lin[2], alpha);
}

function hslToRgb(h, s, l) {
  h = (((h % 360) + 360) % 360) / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}

// CIE Lab (D50) to linear sRGB.
function labToLinear(L, a, b) {
  const fy = (L + 16) / 116, fx = a / 500 + fy, fz = fy - b / 200;
  const e = 216 / 24389, k = 24389 / 27;
  const x = (fx * fx * fx > e ? fx * fx * fx : (116 * fx - 16) / k) * 0.96422;
  const y = L > k * e ? Math.pow((L + 16) / 116, 3) : L / k;
  const z = (fz * fz * fz > e ? fz * fz * fz : (116 * fz - 16) / k) * 0.82521;
  return [3.1338561 * x - 1.6168667 * y - 0.4906146 * z, -0.9787684 * x + 1.9161415 * y + 0.033454 * z, 0.0719453 * x - 0.2289914 * y + 1.4052427 * z];
}

function numberOf(tok, percentOf) {
  if (tok == null) return NaN;
  const t = String(tok).trim();
  if (t === "none") return 0;
  if (t.indexOf(UNKNOWN) >= 0) return NaN;
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%?)$/i.exec(t);
  if (!m) {
    const c = /^calc\((.*)\)$/i.exec(t);
    return c ? numberOf(c[1], percentOf) : NaN;
  }
  const n = Number(m[1]);
  return m[2] ? (n / 100) * (percentOf == null ? 1 : percentOf) : n;
}
function angleOf(tok) {
  const t = String(tok == null ? "" : tok).trim();
  if (t === "none") return 0;
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(deg|rad|grad|turn)?$/i.exec(t);
  if (!m) return NaN;
  const n = Number(m[1]);
  const u = (m[2] || "deg").toLowerCase();
  return u === "rad" ? (n * 180) / Math.PI : u === "grad" ? n * 0.9 : u === "turn" ? n * 360 : n;
}
function alphaOf(tok) {
  if (tok == null || tok === "") return 1;
  // A computed alpha still leaves the hue known: judge the color at full strength.
  if (String(tok).indexOf(UNKNOWN) >= 0) return 1;
  const n = numberOf(tok, 1);
  return Number.isFinite(n) ? clamp01(n) : 1;
}

const colorCache = new Map();

function parseColor(input) {
  const key = String(input == null ? "" : input).trim().toLowerCase();
  if (!key) return null;
  const hit = colorCache.get(key);
  if (hit !== undefined) return hit;
  const out = parseColorRaw(key, 0);
  if (colorCache.size > 4000) colorCache.clear();
  colorCache.set(key, out);
  return out;
}

function parseColorRaw(s, depth) {
  if (depth > 6) return null;
  if (s[0] === "#") {
    const hex = s.slice(1);
    if (!/^[0-9a-f]+$/.test(hex)) return null;
    if (hex.length === 3 || hex.length === 4) {
      const v = hex.split("").map((c) => parseInt(c + c, 16) / 255);
      return makeColor(v[0], v[1], v[2], v.length === 4 ? v[3] : 1);
    }
    if (hex.length === 6 || hex.length === 8) {
      const v = [0, 2, 4, 6].slice(0, hex.length / 2).map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
      return makeColor(v[0], v[1], v[2], v.length === 4 ? v[3] : 1);
    }
    return null;
  }
  if (s === "transparent") return makeColor(0, 0, 0, 0);
  if (Object.prototype.hasOwnProperty.call(NAMED_COLORS, s)) return parseColorRaw("#" + NAMED_COLORS[s], depth + 1);
  const m = /^([a-z-]+)\(([\s\S]*)\)$/.exec(s);
  if (!m) return null;
  const fn = m[1];
  let body = m[2].trim();
  if (fn === "color-mix") return mixColors(body, depth);
  if (fn === "light-dark") {
    const parts = splitTop(body, ",");
    return parts.length ? parseColorRaw(parts[0].trim(), depth + 1) : null;
  }
  // Relative syntax, rgb(from <color> r g b / a): judge the origin color.
  if (/^from\s/.test(body)) {
    const toks = splitTop(body.slice(5), " ");
    const origin = toks.length ? parseColorRaw(toks[0], depth + 1) : null;
    if (!origin) return null;
    const slash = splitTop(body, "/");
    return makeColor(origin.r, origin.g, origin.b, slash.length > 1 ? alphaOf(slash[1]) : origin.a);
  }
  let alpha = null;
  const slash = splitTop(body, "/");
  if (slash.length > 1) {
    body = slash[0];
    alpha = slash[1];
  }
  let args = body.indexOf(",") >= 0 ? splitTop(body, ",") : splitTop(body, " ");
  if (alpha == null && args.length === 4 && fn !== "color") alpha = args.pop();
  const a = alphaOf(alpha);
  if (fn === "rgb" || fn === "rgba") {
    if (args.length < 3) return null;
    const v = args.slice(0, 3).map((t) => (/%$/.test(t) ? numberOf(t, 1) : numberOf(t) / 255));
    return v.some((n) => !Number.isFinite(n)) ? null : makeColor(v[0], v[1], v[2], a);
  }
  if (fn === "hsl" || fn === "hsla") {
    if (args.length < 3) return null;
    const h = angleOf(args[0]), sat = numberOf(/%$/.test(args[1]) ? args[1] : args[1] + "%", 1), li = numberOf(/%$/.test(args[2]) ? args[2] : args[2] + "%", 1);
    if (![h, sat, li].every(Number.isFinite)) return null;
    const rgb = hslToRgb(h, clamp01(sat), clamp01(li));
    return makeColor(rgb[0], rgb[1], rgb[2], a);
  }
  if (fn === "hwb") {
    if (args.length < 3) return null;
    const h = angleOf(args[0]);
    let w = numberOf(/%$/.test(args[1]) ? args[1] : args[1] + "%", 1), bl = numberOf(/%$/.test(args[2]) ? args[2] : args[2] + "%", 1);
    if (![h, w, bl].every(Number.isFinite)) return null;
    if (w + bl > 1) {
      const sum = w + bl;
      w /= sum;
      bl /= sum;
    }
    const rgb = hslToRgb(h, 1, 0.5).map((c) => c * (1 - w - bl) + w);
    return makeColor(rgb[0], rgb[1], rgb[2], a);
  }
  if (fn === "oklab" || fn === "oklch") {
    if (args.length < 3) return null;
    const L = numberOf(args[0], 1);
    if (!Number.isFinite(L)) return null;
    if (fn === "oklab") {
      const la = numberOf(args[1], 0.4), lb = numberOf(args[2], 0.4);
      return Number.isFinite(la) && Number.isFinite(lb) ? fromOklab(L, la, lb, a) : null;
    }
    const C = numberOf(args[1], 0.4), h = angleOf(args[2]);
    if (!Number.isFinite(C) || !Number.isFinite(h)) return null;
    return fromOklab(L, C * Math.cos((h * Math.PI) / 180), C * Math.sin((h * Math.PI) / 180), a);
  }
  if (fn === "lab" || fn === "lch") {
    if (args.length < 3) return null;
    const L = numberOf(args[0], 100);
    if (!Number.isFinite(L)) return null;
    let la, lb;
    if (fn === "lab") {
      la = numberOf(args[1], 125);
      lb = numberOf(args[2], 125);
    } else {
      const C = numberOf(args[1], 150), h = angleOf(args[2]);
      la = C * Math.cos((h * Math.PI) / 180);
      lb = C * Math.sin((h * Math.PI) / 180);
    }
    if (!Number.isFinite(la) || !Number.isFinite(lb)) return null;
    const lin = labToLinear(L, la, lb);
    return fromLinear(lin[0], lin[1], lin[2], a);
  }
  if (fn === "color") {
    const space = args[0];
    const v = args.slice(1, 4).map((t) => numberOf(t, 1));
    if (v.length < 3 || v.some((n) => !Number.isFinite(n))) return null;
    if (space === "srgb-linear") return fromLinear(v[0], v[1], v[2], a);
    // display-p3, a98-rgb, rec2020 and the rest: read as sRGB. The hue is
    // close enough to tell purple from tomato.
    return makeColor(v[0], v[1], v[2], a);
  }
  return null;
}

function mixColors(body, depth) {
  const parts = splitTop(body, ",");
  if (parts.length < 3) return null;
  const read = (part) => {
    const toks = splitTop(part, " ");
    let pct = null;
    const rest = [];
    for (const t of toks) {
      if (/^[+-]?(?:\d+\.?\d*|\.\d+)%$/.test(t) && pct == null) pct = Number(t.slice(0, -1)) / 100;
      else rest.push(t);
    }
    return { color: parseColorRaw(rest.join(" "), depth + 1), pct };
  };
  const one = read(parts[1]), two = read(parts[2]);
  if (!one.color || !two.color) return null;
  let p1 = one.pct, p2 = two.pct;
  if (p1 == null && p2 == null) p1 = p2 = 0.5;
  else if (p1 == null) p1 = 1 - p2;
  else if (p2 == null) p2 = 1 - p1;
  const sum = p1 + p2;
  if (!(sum > 0)) return null;
  const scale = sum < 1 ? sum : 1;
  p1 /= sum;
  p2 /= sum;
  const a1 = one.color.a * p1, a2 = two.color.a * p2, alpha = a1 + a2;
  if (alpha <= 0) return makeColor(0, 0, 0, 0);
  const A = linearToOklab(srgbToLinear(one.color.r), srgbToLinear(one.color.g), srgbToLinear(one.color.b));
  const B = linearToOklab(srgbToLinear(two.color.r), srgbToLinear(two.color.g), srgbToLinear(two.color.b));
  const mix = (i) => (A[i] * a1 + B[i] * a2) / alpha;
  return fromOklab(mix(0), mix(1), mix(2), alpha * scale);
}

const COLOR_FN = "rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark";

// Every color written in a value, in source order.
function findColors(value) {
  const out = [];
  const text = String(value == null ? "" : value);
  const re = new RegExp("#[0-9a-f]{3,8}\\b|\\b(" + COLOR_FN + ")\\(|[a-z]+", "gi");
  let m;
  while ((m = re.exec(text))) {
    const tok = m[0];
    if (tok[0] === "#") {
      const c = parseColor(tok);
      if (c) out.push(c);
    } else if (tok[tok.length - 1] === "(") {
      const open = m.index + tok.length - 1;
      const close = closeOf(text, open);
      const c = parseColor(text.slice(m.index, close + 1));
      if (c) out.push(c);
      re.lastIndex = close + 1;
    } else {
      const lower = tok.toLowerCase();
      const before = m.index > 0 ? text[m.index - 1] : "";
      const after = text[m.index + tok.length] || "";
      if (before === "-" || after === "-" || after === "(" || before === "#" || before === "." || /[0-9]/.test(before)) continue;
      if (lower === "transparent" || Object.prototype.hasOwnProperty.call(NAMED_COLORS, lower)) {
        const c = parseColor(lower);
        if (c) out.push(c);
      }
    }
  }
  return out;
}

function hueBetween(h, from, to) {
  return from <= to ? h >= from && h <= to : h >= from || h <= to;
}
function hueGap(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}
function colorGap(a, b) {
  return Math.hypot(a.L - b.L, a.la - b.la, a.lb - b.lb);
}
function hexOf(c) {
  const h = (v) => Math.round(v * 255).toString(16).padStart(2, "0");
  return "#" + h(c.r) + h(c.g) + h(c.b);
}

// Hue families in OKLCH. Indigo starts where blue ends (pure #0000ff sits at
// 264); pink starts past magenta.
// 264); pink starts past magenta. Measured on real palettes: #667eea is 272,
// Tailwind blue-600 is 263, violet-500 is 293, fuchsia-400 is 322.
const isChromatic = (c) => c.a > 0.05 && c.C >= 0.06;
const isPurple = (c) => c.a > 0.05 && c.C >= 0.09 && hueBetween(c.h, 268, 330);
const isBlue = (c) => c.a > 0.05 && c.C >= 0.09 && hueBetween(c.h, 228, 268);
const isPink = (c) => c.a > 0.05 && c.C >= 0.1 && hueBetween(c.h, 330, 20);
const isCyan = (c) => c.a > 0.05 && c.C >= 0.1 && c.L >= 0.7 && hueBetween(c.h, 168, 238);
const isNeon = (c) =>
  c.a > 0.3 &&
  (isCyan(c) ||
    (c.C >= 0.2 && c.L >= 0.8 && hueBetween(c.h, 128, 168)) ||
    (c.C >= 0.23 && c.L >= 0.58 && hueBetween(c.h, 295, 360)) ||
    (c.C >= 0.23 && c.L >= 0.58 && c.h <= 12));
const isNearBlack = (c) => c.a >= 0.6 && c.L <= 0.24 && c.C <= 0.09;
const isGray = (c) => c.a > 0.3 && c.C < 0.04 && c.L > 0.45 && c.L < 0.82;
const isCream = (c) => c.a >= 0.9 && c.L >= 0.9 && c.L <= 0.985 && c.C >= 0.006 && c.C <= 0.07 && hueBetween(c.h, 45, 112);
const DEFAULT_A = parseColor("#667eea");
const DEFAULT_B = parseColor("#764ba2");

// -------------------------------------------------------------------- lengths

const LENGTH = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z%]*)$/i;

// A CSS length in frame pixels, or null when it cannot be known from source.
// frame: { W, H }. em: the font size em and % resolve against (null: unknown).
function lengthPx(tok, frame, em) {
  const t = String(tok == null ? "" : tok).trim().toLowerCase();
  if (!t || t.indexOf(UNKNOWN) >= 0) return null;
  const m = LENGTH.exec(t);
  if (m) {
    const n = Number(m[1]);
    switch (m[2]) {
      case "px": return n;
      case "": return n === 0 ? 0 : null;
      case "vmin": case "svmin": case "dvmin": case "lvmin": case "cqmin": return (n / 100) * Math.min(frame.W, frame.H);
      case "vmax": case "svmax": case "dvmax": case "lvmax": case "cqmax": return (n / 100) * Math.max(frame.W, frame.H);
      case "vw": case "svw": case "dvw": case "lvw": case "cqw": case "cqi": return (n / 100) * frame.W;
      case "vh": case "svh": case "dvh": case "lvh": case "cqh": case "cqb": return (n / 100) * frame.H;
      case "rem": return n * 16;
      case "em": return em == null ? null : n * em;
      case "%": return em == null ? null : (n / 100) * em;
      case "pt": return (n * 4) / 3;
      case "pc": return n * 16;
      case "in": return n * 96;
      case "cm": return (n * 96) / 2.54;
      case "mm": return (n * 96) / 25.4;
      case "ch": case "ex": return em == null ? null : n * em * 0.5;
      default: return null;
    }
  }
  const fn = /^(clamp|min|max|calc)\(([\s\S]*)\)$/.exec(t);
  if (!fn) return null;
  const args = splitTop(fn[2], ",").map((a) => lengthPx(a, frame, em));
  if (fn[1] === "clamp" && args.length === 3) {
    if (args[1] != null) return Math.max(args[0] == null ? -Infinity : args[0], Math.min(args[1], args[2] == null ? Infinity : args[2]));
    return args[2] != null ? args[2] : args[0];
  }
  const known = args.filter((v) => v != null);
  if (!known.length || known.length !== args.length) return null;
  if (fn[1] === "min") return Math.min(...known);
  if (fn[1] === "max") return Math.max(...known);
  return args.length === 1 ? args[0] : null;
}

function timeMs(tok) {
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+))(ms|s)$/i.exec(String(tok == null ? "" : tok).trim());
  if (!m) return null;
  return m[2].toLowerCase() === "s" ? Number(m[1]) * 1000 : Number(m[1]);
}

// ------------------------------------------------------------------------ CSS

function stripCssComments(text) {
  return String(text == null ? "" : text).replace(/\/\*[\s\S]*?\*\//g, " ");
}
function decodeCssEscapes(text) {
  return String(text).replace(/\\([0-9a-f]{1,6})\s?/gi, (m, hex) => {
    const cp = parseInt(hex, 16);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
  });
}

function normProp(raw) {
  const p = String(raw).trim();
  if (p.startsWith("--")) return p;
  return p.toLowerCase().replace(/^-(?:webkit|moz|ms|o|khtml)-/, "");
}
function normValue(raw) {
  return String(raw)
    .replace(/!\s*important\s*$/i, "")
    .replace(/-(?:webkit|moz|ms|o)-((?:repeating-)?(?:linear|radial|conic)-gradient)/gi, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function parseDecls(body) {
  const out = [];
  for (const part of splitTop(body, ";")) {
    if (!part) continue;
    let depth = 0, colon = -1;
    for (let i = 0; i < part.length; i += 1) {
      const c = part[i];
      if (c === "(") depth += 1;
      else if (c === ")") depth -= 1;
      else if (c === ":" && depth === 0) {
        colon = i;
        break;
      }
    }
    if (colon <= 0) continue;
    const prop = normProp(part.slice(0, colon));
    const value = normValue(part.slice(colon + 1));
    if (prop && value && /^(--)?[a-zA-Z_-][\w-]*$/.test(prop)) out.push({ prop, value });
  }
  return out;
}

function closeBrace(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i += 1) {
    const c = s[i];
    if (c === '"' || c === "'") {
      const end = s.indexOf(c, i + 1);
      if (end < 0) return s.length;
      i = end;
    } else if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return s.length;
}

// Walk a block body: plain declarations and the blocks nested in it.
function eachBlock(s, onBlock) {
  let decls = "";
  let i = 0;
  const n = s.length;
  while (i < n) {
    let j = i, depth = 0;
    for (; j < n; j += 1) {
      const c = s[j];
      if (c === '"' || c === "'") {
        const end = s.indexOf(c, j + 1);
        j = end < 0 ? n : end;
      } else if (c === "(") depth += 1;
      else if (c === ")") depth -= 1;
      else if (depth <= 0 && (c === "{" || c === ";" || c === "}")) break;
    }
    if (j >= n) {
      decls += s.slice(i);
      break;
    }
    if (s[j] !== "{") {
      decls += s.slice(i, j) + ";";
      i = j + 1;
      continue;
    }
    const end = closeBrace(s, j);
    onBlock(s.slice(i, j).trim(), s.slice(j + 1, end));
    i = end + 1;
  }
  return decls;
}

// sheet: { rules: [{ sel, decls, media }], keyframes: Map name -> [{ keys, decls }], fontFaces: [decls] }
function parseCss(text, sheet, media, parentSel) {
  eachBlock(stripCssComments(text), (prelude, body) => {
    if (!prelude) return;
    if (prelude[0] === "@") {
      const at = /^@(?:-\w+-)?([\w-]+)\s*([\s\S]*)$/.exec(prelude);
      if (!at) return;
      const name = at[1].toLowerCase();
      if (name === "keyframes") {
        const frames = [];
        eachBlock(body, (keys, inner) => frames.push({ keys: keys.split(",").map((k) => k.trim().toLowerCase()), decls: parseDecls(inner) }));
        const key = at[2].trim().replace(/^['"]|['"]$/g, "");
        if (key) sheet.keyframes.set(key, frames);
      } else if (name === "font-face") sheet.fontFaces.push(parseDecls(body));
      else if (name === "media") parseCss(body, sheet, at[2].trim() || "all", parentSel);
      else if (name === "supports" || name === "layer" || name === "container" || name === "scope" || name === "document" || name === "starting-style") parseCss(body, sheet, media, parentSel);
      return;
    }
    let sel = prelude;
    if (parentSel) sel = splitTop(prelude, ",").map((one) => (one.indexOf("&") >= 0 ? one.replace(/&/g, parentSel) : parentSel + " " + one)).join(", ");
    const nested = [];
    const own = eachBlock(body, (p, b) => nested.push([p, b]));
    const decls = parseDecls(own);
    if (decls.length) sheet.rules.push({ sel, decls, media: media || "" });
    for (const [p, b] of nested) {
      if (p[0] === "@") parseCss(p + "{" + b + "}", sheet, media, sel);
      else parseCss(p + "{" + b + "}", sheet, media, sel.indexOf(",") >= 0 ? ":is(" + sel + ")" : sel);
    }
  });
  return sheet;
}

// ----------------------------------------------------------------------- HTML

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "\u00A9", reg: "\u00AE", trade: "\u2122", hellip: "\u2026", mdash: "\u2014", ndash: "\u2013", rarr: "\u2192", larr: "\u2190", uarr: "\u2191", darr: "\u2193", bull: "\u2022", middot: "\u00B7", times: "\u00D7", check: "\u2713", checkmark: "\u2713", cross: "\u2717", star: "\u2606", starf: "\u2605", bigstar: "\u2605", hearts: "\u2665", spades: "\u2660", clubs: "\u2663", diams: "\u2666", laquo: "\u00AB", raquo: "\u00BB", ldquo: "\u201C", rdquo: "\u201D", lsquo: "\u2018", rsquo: "\u2019", deg: "\u00B0", sect: "\u00A7", para: "\u00B6", phone: "\u260E", female: "\u2640", male: "\u2642", sung: "\u266A", flat: "\u266D", sharp: "\u266F", malt: "\u2720", sext: "\u2736", lozf: "\u29EB", loz: "\u25CA" };

function decodeEntities(text) {
  if (text.indexOf("&") < 0) return text;
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);?/gi, (m, body) => {
    if (body[0] === "#") {
      const cp = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
    }
    const hit = ENTITIES[body] || ENTITIES[body.toLowerCase()];
    return hit == null ? m : hit;
  });
}

const VOID_TAGS = new Set(["br", "img", "hr", "input", "meta", "link", "source", "wbr", "area", "base", "col", "embed", "track", "param"]);
const RAW_TAGS = new Set(["style", "script", "textarea", "title", "noscript"]);
const SELF_NESTING = new Set(["li", "p", "td", "th", "tr", "option", "dt", "dd"]);
const TAG_RE = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[^>]*>|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+[^\s"'<>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>]+))?|\s*\/(?!>))*)\s*(\/?)>/g;
const ATTR_RE = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+)))?/g;

function makeEl(tag, attrs, parent) {
  const el = {
    tag,
    attrs,
    id: attrs.id || "",
    classes: attrs.class ? attrs.class.split(/\s+/).filter(Boolean) : [],
    parent,
    children: [],
    text: "",
    props: Object.create(null),
    pseudo: null,
    hits: [],
    inSvg: tag === "svg" || Boolean(parent && parent.inSvg),
    synthetic: false,
  };
  if (parent) {
    el.index = parent.children.length;
    parent.children.push(el);
  } else el.index = 0;
  return el;
}

// doc: { root (html), body, all: [el], styles: [css], scripts: [js] }
function parseHtml(source) {
  const html = makeEl("html", {}, null);
  const body = makeEl("body", {}, html);
  const doc = { root: html, body, all: [html, body], styles: [], scripts: [] };
  const text = String(source == null ? "" : source);
  if (!text.trim()) return doc;
  let cur = body;
  let last = 0;
  let count = 0;
  TAG_RE.lastIndex = 0;
  const addText = (raw) => {
    if (!raw || !/\S/.test(raw)) return;
    cur.text += (cur.text ? " " : "") + decodeEntities(raw).replace(/\s+/g, " ").trim();
  };
  let m;
  while ((m = TAG_RE.exec(text))) {
    addText(text.slice(last, m.index));
    last = TAG_RE.lastIndex;
    if (m[1]) {
      const name = m[1].toLowerCase();
      let p = cur;
      while (p && p.tag !== name) p = p.parent;
      if (p && p.parent && p !== html && p !== body) cur = p.parent;
      continue;
    }
    if (!m[2]) continue;
    const tag = m[2].toLowerCase();
    const attrs = {};
    if (m[3]) {
      ATTR_RE.lastIndex = 0;
      let a;
      while ((a = ATTR_RE.exec(m[3]))) {
        const value = a[2] != null ? a[2] : a[3] != null ? a[3] : a[4] != null ? a[4] : "";
        attrs[a[1].toLowerCase()] = decodeEntities(value);
      }
    }
    if (RAW_TAGS.has(tag)) {
      const closeRe = new RegExp("</" + tag + "\\s*>", "i");
      const rest = text.slice(last);
      const end = closeRe.exec(rest);
      const inner = end ? rest.slice(0, end.index) : rest;
      if (tag === "style") doc.styles.push(inner);
      else if (tag === "script" && !/^(application\/(json|ld\+json)|text\/template)/i.test(attrs.type || "")) doc.scripts.push(inner);
      last = end ? last + end.index + end[0].length : text.length;
      TAG_RE.lastIndex = last;
      continue;
    }
    if (tag === "html" || tag === "body" || tag === "head") {
      const target = tag === "html" ? html : tag === "body" ? body : null;
      if (target) {
        Object.assign(target.attrs, attrs);
        target.id = target.attrs.id || "";
        target.classes = target.attrs.class ? target.attrs.class.split(/\s+/).filter(Boolean) : [];
        if (tag === "body") cur = body;
      }
      continue;
    }
    if (SELF_NESTING.has(tag) && cur.tag === tag && cur.parent) cur = cur.parent;
    count += 1;
    if (count > 4000) break;
    const el = makeEl(tag, attrs, cur);
    doc.all.push(el);
    if (!(m[4] === "/" || VOID_TAGS.has(tag))) cur = el;
  }
  addText(text.slice(last));
  // data-split text becomes .jv-word and .jv-char spans at load (lib/animation-motion.js).
  for (const el of doc.all.slice()) {
    if (el.attrs["data-split"] == null || !el.text) continue;
    const word = makeEl("span", { class: "jv-word" }, el);
    word.classes = ["jv-word"];
    word.synthetic = true;
    doc.all.push(word);
    let leaf = word;
    if (String(el.attrs["data-split"]).toLowerCase() !== "words") {
      leaf = makeEl("span", { class: "jv-char" }, word);
      leaf.classes = ["jv-char"];
      leaf.synthetic = true;
      doc.all.push(leaf);
    }
    leaf.text = el.text;
    el.splitText = el.text;
    el.text = "";
  }
  return doc;
}

function allText(el) {
  if (el.fullText != null) return el.fullText;
  let out = el.text || "";
  for (const child of el.children) {
    const t = allText(child);
    if (t) out += (out ? " " : "") + t;
  }
  el.fullText = out;
  return out;
}

// ------------------------------------------------------------------ selectors

const STATE_PSEUDO = new Set(["hover", "focus", "focus-visible", "focus-within", "active", "visited", "checked", "disabled", "target", "invalid", "placeholder-shown", "indeterminate"]);
const PSEUDO_ELEMENTS = new Set(["before", "after", "first-letter", "first-line", "selection", "marker", "placeholder", "backdrop", "file-selector-button"]);

function parseNth(expr) {
  const e = String(expr).replace(/\s+/g, "").toLowerCase().replace(/of.*$/, "");
  if (e === "odd") return [2, 1];
  if (e === "even") return [2, 0];
  const m = /^([+-]?\d*)n([+-]\d+)?$/.exec(e);
  if (m) return [m[1] === "" || m[1] === "+" ? 1 : m[1] === "-" ? -1 : Number(m[1]), m[2] ? Number(m[2]) : 0];
  const n = Number(e);
  return Number.isFinite(n) ? [0, n] : null;
}
function nthMatch(ab, pos) {
  if (!ab) return true;
  const a = ab[0], b = ab[1];
  if (a === 0) return pos === b;
  const k = (pos - b) / a;
  return k >= 0 && Number.isInteger(k);
}

function parseCompound(text) {
  const c = { tag: "", id: "", classes: [], attrs: [], pseudos: [], pseudoEl: "", state: false };
  let s = text;
  const tag = /^(\*|[a-zA-Z][\w-]*)/.exec(s);
  if (tag) {
    c.tag = tag[1] === "*" ? "" : tag[1].toLowerCase();
    s = s.slice(tag[0].length);
  }
  while (s) {
    let m;
    if ((m = /^#([\w-]+)/.exec(s))) c.id = m[1];
    else if ((m = /^\.([\w-]+)/.exec(s))) c.classes.push(m[1]);
    else if ((m = /^\[\s*([\w:-]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?[^\]]*\]/.exec(s))) c.attrs.push({ name: m[1].toLowerCase(), op: m[2] || "", value: m[3] != null ? m[3] : m[4] != null ? m[4] : m[5] != null ? m[5] : "" });
    else if ((m = /^::?([\w-]+)/.exec(s))) {
      const name = m[1].toLowerCase().replace(/^-(?:webkit|moz)-/, "");
      let arg = "";
      let len = m[0].length;
      if (s[len] === "(") {
        const close = closeOf(s, len);
        arg = s.slice(len + 1, close);
        len = close + 1;
      }
      if (m[0][1] === ":" || PSEUDO_ELEMENTS.has(name)) c.pseudoEl = name;
      else {
        if (STATE_PSEUDO.has(name)) c.state = true;
        c.pseudos.push({ name, arg });
      }
      s = s.slice(len);
      continue;
    } else break;
    s = s.slice(m[0].length);
  }
  return c;
}

function parseComplex(text) {
  const parts = [];
  let buf = "", comb = "", depth = 0;
  const flush = () => {
    if (!buf) return;
    const c = parseCompound(buf);
    c.comb = parts.length ? comb || " " : "";
    parts.push(c);
    buf = "";
    comb = "";
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") depth -= 1;
    if (depth === 0 && (ch === " " || ch === "\n" || ch === "\t" || ch === ">" || ch === "+" || ch === "~")) {
      flush();
      if (ch !== " " && ch !== "\n" && ch !== "\t") comb = ch;
      else if (!comb) comb = " ";
    } else buf += ch;
  }
  flush();
  if (!parts.length) return null;
  let a = 0, b = 0, c = 0;
  for (const p of parts) {
    if (p.id) a += 1;
    b += p.classes.length + p.attrs.length + p.pseudos.length;
    if (p.tag) c += 1;
    if (p.pseudoEl) c += 1;
  }
  const lastPart = parts[parts.length - 1];
  return { parts, spec: a * 10000 + b * 100 + c, state: parts.some((p) => p.state), pseudoEl: lastPart.pseudoEl };
}

const selectorCache = new Map();
function parseSelectors(sel) {
  const hit = selectorCache.get(sel);
  if (hit) return hit;
  const list = splitTop(sel, ",").map((one) => parseComplex(one.trim())).filter(Boolean);
  if (selectorCache.size > 2000) selectorCache.clear();
  selectorCache.set(sel, list);
  return list;
}

function matchPseudo(el, p) {
  switch (p.name) {
    case "root": return el.tag === "html";
    case "first-child": return el.index === 0;
    case "last-child": return Boolean(el.parent) && el.index === el.parent.children.length - 1;
    case "only-child": return Boolean(el.parent) && el.parent.children.length === 1;
    case "nth-child": return nthMatch(parseNth(p.arg), el.index + 1);
    case "nth-last-child": return Boolean(el.parent) && nthMatch(parseNth(p.arg), el.parent.children.length - el.index);
    case "first-of-type": case "last-of-type": case "nth-of-type": case "nth-last-of-type": case "only-of-type": {
      if (!el.parent) return false;
      const same = el.parent.children.filter((s) => s.tag === el.tag);
      const pos = same.indexOf(el) + 1;
      if (p.name === "first-of-type") return pos === 1;
      if (p.name === "last-of-type") return pos === same.length;
      if (p.name === "only-of-type") return same.length === 1;
      if (p.name === "nth-of-type") return nthMatch(parseNth(p.arg), pos);
      return nthMatch(parseNth(p.arg), same.length - pos + 1);
    }
    case "empty": return !el.children.length && !el.text;
    case "not": return !splitTop(p.arg, ",").some((one) => matchCompound(el, parseCompound(one.trim())));
    case "is": case "where": case "matches": case "any": return splitTop(p.arg, ",").some((one) => {
      const cx = parseComplex(one.trim());
      return cx ? matchComplex(el, cx.parts, cx.parts.length - 1) : false;
    });
    default: return !STATE_PSEUDO.has(p.name);
  }
}

function matchCompound(el, c) {
  if (c.tag && c.tag !== el.tag) return false;
  if (c.id && c.id !== el.id) return false;
  for (const cls of c.classes) if (!el.classes.includes(cls)) return false;
  for (const a of c.attrs) {
    const v = el.attrs[a.name];
    if (v == null) return false;
    if (a.op === "=" && v !== a.value) return false;
    if (a.op === "~=" && !v.split(/\s+/).includes(a.value)) return false;
    if (a.op === "^=" && !v.startsWith(a.value)) return false;
    if (a.op === "$=" && !v.endsWith(a.value)) return false;
    if (a.op === "*=" && v.indexOf(a.value) < 0) return false;
    if (a.op === "|=" && v !== a.value && !v.startsWith(a.value + "-")) return false;
  }
  for (const p of c.pseudos) if (!matchPseudo(el, p)) return false;
  return true;
}

function matchComplex(el, parts, i) {
  if (!matchCompound(el, parts[i])) return false;
  if (i === 0) return true;
  const comb = parts[i].comb;
  if (comb === ">") return Boolean(el.parent) && matchComplex(el.parent, parts, i - 1);
  if (comb === "+") {
    const prev = el.parent && el.index > 0 ? el.parent.children[el.index - 1] : null;
    return Boolean(prev) && matchComplex(prev, parts, i - 1);
  }
  if (comb === "~") {
    if (!el.parent) return false;
    for (let k = el.index - 1; k >= 0; k -= 1) if (matchComplex(el.parent.children[k], parts, i - 1)) return true;
    return false;
  }
  for (let p = el.parent; p; p = p.parent) if (matchComplex(p, parts, i - 1)) return true;
  return false;
}

// ------------------------------------------------------------------ JS source

function decodeJsString(raw) {
  if (raw.indexOf("\\") < 0) return raw;
  return raw.replace(/\\(u\{([0-9a-f]+)\}|u([0-9a-f]{4})|x([0-9a-f]{2})|\r?\n|[\s\S])/gi, (m, all, braced, four, two) => {
    if (braced) {
      const cp = parseInt(braced, 16);
      return cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
    }
    if (four) return String.fromCharCode(parseInt(four, 16));
    if (two) return String.fromCharCode(parseInt(two, 16));
    if (all === "n") return "\n";
    if (all === "t") return "\t";
    if (all === "r") return "\r";
    if (all[0] === "\n" || all[0] === "\r") return "";
    return all;
  });
}

const REGEX_BEFORE = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^", "==", "===", "!=", "!==", "=>", "&&", "||", "+=", "return", "typeof", "case", "in", "of"]);

// Tokens: { t: "s" string, "i" identifier, "n" number, "p" punctuation, v }.
// A template literal is a string whose ${...} parts are in `holes`.
function tokenizeJs(src) {
  const toks = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === " " || c === "\n" || c === "\t" || c === "\r") {
      i += 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      const end = src.indexOf("\n", i);
      i = end < 0 ? n : end;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === "\\") j += 1;
        else if (src[j] === "\n") break;
        j += 1;
      }
      toks.push({ t: "s", v: decodeJsString(src.slice(i + 1, j)) });
      i = j + 1;
      continue;
    }
    if (c === "`") {
      const parts = [];
      let j = i + 1, buf = "";
      while (j < n && src[j] !== "`") {
        if (src[j] === "\\") {
          buf += src.slice(j, j + 2);
          j += 2;
        } else if (src[j] === "$" && src[j + 1] === "{") {
          let depth = 1, k = j + 2;
          while (k < n && depth > 0) {
            if (src[k] === "{") depth += 1;
            else if (src[k] === "}") depth -= 1;
            k += 1;
          }
          parts.push(decodeJsString(buf), { hole: src.slice(j + 2, k - 1).trim() });
          buf = "";
          j = k;
        } else {
          buf += src[j];
          j += 1;
        }
      }
      parts.push(decodeJsString(buf));
      toks.push({ t: "s", v: "", parts });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$]/.test(src[j])) j += 1;
      toks.push({ t: "i", v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] || ""))) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(src[j])) j += 1;
      toks.push({ t: "n", v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (c === "/") {
      const prev = toks[toks.length - 1];
      if (!prev || (prev.t === "p" && REGEX_BEFORE.has(prev.v)) || (prev.t === "i" && REGEX_BEFORE.has(prev.v))) {
        let j = i + 1, inClass = false;
        while (j < n && src[j] !== "\n") {
          if (src[j] === "\\") j += 1;
          else if (src[j] === "[") inClass = true;
          else if (src[j] === "]") inClass = false;
          else if (src[j] === "/" && !inClass) break;
          j += 1;
        }
        j += 1;
        while (j < n && /[a-z]/i.test(src[j])) j += 1;
        toks.push({ t: "r", v: "" });
        i = j;
        continue;
      }
    }
    const three = src.slice(i, i + 3), two = src.slice(i, i + 2);
    if (three === "===" || three === "!==" || three === "...") {
      toks.push({ t: "p", v: three });
      i += 3;
    } else if (two === "==" || two === "!=" || two === "=>" || two === "<=" || two === ">=" || two === "+=" || two === "&&" || two === "||" || two === "++" || two === "--" || two === "-=" || two === "*=" || two === "??" || two === "?.") {
      toks.push({ t: "p", v: two === "?." ? "." : two });
      i += 2;
    } else {
      toks.push({ t: "p", v: c });
      i += 1;
    }
  }
  return toks;
}

const camelToKebab = (name) => String(name).replace(/^(webkit|Webkit|moz|Moz|ms)(?=[A-Z])/, "").replace(/[A-Z]/g, (ch) => "-" + ch.toLowerCase()).replace(/^-/, "");
const JS_STYLE_KEYS = new Set(["background", "background-image", "background-color", "background-clip", "background-size", "color", "font", "font-family", "font-size", "font-weight", "font-style", "box-shadow", "text-shadow", "filter", "backdrop-filter", "border", "border-left", "border-right", "border-top", "border-bottom", "border-radius", "letter-spacing", "text-transform", "text-align", "text-fill-color", "animation", "animation-timing-function", "transition", "transition-timing-function", "fill", "stroke", "stop-color", "opacity", "width", "height"]);
const EASE_BOUNCE = /^(?:ease)?(?:in|out|inout)?(?:bounce|elastic)$|^(?:bounce|elastic)(?:\.(?:in|out|inout))?(?:\(.*\))?$/i;
const EASE_BACK = /^(?:ease)?(?:in|out|inout)back$|^back(?:\.(?:in|out|inout))?(?:\(.*\))?$/i;
const TEXT_PROPS = new Set(["textContent", "innerText", "nodeValue", "title", "alt", "placeholder", "value", "label"]);
const SKIP_PROPS = new Set(["className", "id", "type", "src", "href", "name", "key", "role", "lang", "dir", "dataset", "selector"]);

// What the script styles, draws and writes, as far as source can tell.
function scanJs(source) {
  const out = {
    groups: new Map(), // receiver -> [{ prop, value }]
    declLists: [],
    cssTexts: [],
    htmlTexts: [],
    texts: [],
    looseColors: [],
    eases: [], // { kind: "bounce" | "overshoot", name }
    canvasGrads: new Map(), // receiver -> [color text]
    random: false,
    loopCount: 0,
    draws: false,
    shadowBlur: 0,
    idents: new Set(),
    layoutInDraw: [],
    names: "",
  };
  const src = String(source == null ? "" : source);
  if (!src.trim()) return out;
  const toks = tokenizeJs(src);
  const consts = new Map();
  const group = (key) => {
    let g = out.groups.get(key);
    if (!g) out.groups.set(key, (g = []));
    return g;
  };
  const pathBefore = (j) => {
    // Property path ending at token j, walking left: a.b[0].c -> ["a", "b", "c"].
    const segs = [];
    let k = j;
    while (k >= 0) {
      const tk = toks[k];
      if (tk.t === "i") {
        segs.unshift(tk.v);
        k -= 1;
      } else if (tk.t === "p" && tk.v === "]") {
        let depth = 0, q = k;
        for (; q >= 0; q -= 1) {
          if (toks[q].t === "p" && toks[q].v === "]") depth += 1;
          else if (toks[q].t === "p" && toks[q].v === "[") {
            depth -= 1;
            if (depth === 0) break;
          }
        }
        if (q < 0) break;
        if (q + 2 === k && toks[q + 1].t === "s" && !toks[q + 1].parts) segs.unshift(toks[q + 1].v);
        k = q - 1;
        continue;
      } else if (tk.t === "p" && tk.v === ")") {
        let depth = 0, q = k;
        for (; q >= 0; q -= 1) {
          if (toks[q].t === "p" && toks[q].v === ")") depth += 1;
          else if (toks[q].t === "p" && toks[q].v === "(") {
            depth -= 1;
            if (depth === 0) break;
          }
        }
        if (q < 0) break;
        k = q - 1;
        continue;
      } else break;
      if (k >= 0 && toks[k].t === "p" && toks[k].v === ".") k -= 1;
      else break;
    }
    return segs;
  };
  const strOf = (tk) => {
    if (!tk.parts) return tk.v;
    let s = "";
    for (const part of tk.parts) {
      if (typeof part === "string") s += part;
      else if (consts.has(part.hole)) s += consts.get(part.hole);
      else if (/^[\d.]+$/.test(part.hole)) s += part.hole;
      else s += UNKNOWN;
    }
    return s;
  };
  const constAt = (k) => {
    const tk = toks[k];
    if (!tk || tk.t !== "i") return null;
    const next = toks[k + 1], after = toks[k + 2];
    if (next && next.t === "p" && next.v === "." && after && after.t === "i" && consts.has(tk.v + "." + after.v)) return { value: consts.get(tk.v + "." + after.v), len: 3 };
    if (consts.has(tk.v) && !(next && next.t === "p" && (next.v === "(" || next.v === "." || next.v === "=" || next.v === "["))) return { value: consts.get(tk.v), len: 1 };
    return null;
  };
  const classify = (value) => {
    if (/<[a-z][^<>]*>/i.test(value)) out.htmlTexts.push(value);
    else if (/[^{}]+\{[^{}]*:[^{}]*\}/.test(value)) out.cssTexts.push(value);
    else if (/^\s*[a-z-]+\s*:\s*[^;{}]+;/i.test(value)) out.declLists.push(value);
    else if (/gradient\(/i.test(value)) group("script").push({ prop: "background", value });
    else if (/\b(?:blur|drop-shadow)\(/i.test(value)) group("script").push({ prop: "filter", value });
    else {
      const c = parseColor(value.replace(new RegExp(UNKNOWN, "g"), "1"));
      if (c) out.looseColors.push(c);
    }
  };
  const easeName = (value) => {
    const v = String(value).trim();
    if (!v || v.length > 40) return;
    if (EASE_BOUNCE.test(v)) out.eases.push({ kind: "bounce", name: v });
    else if (EASE_BACK.test(v)) out.eases.push({ kind: "overshoot", name: v });
    else if (/^cubic-bezier\(/i.test(v) || /^linear\(/i.test(v)) out.eases.push({ kind: "css", name: v });
  };

  const consumed = new Set();
  for (let i = 0; i < toks.length; i += 1) {
    const tk = toks[i];
    if (tk.t === "i") {
      const prev = toks[i - 1];
      if (out.idents.size < 3000) out.idents.add(tk.v);
      if (tk.v === "shadowBlur" && toks[i + 1] && toks[i + 1].v === "=" && toks[i + 2] && toks[i + 2].t === "n") out.shadowBlur = Math.max(out.shadowBlur, Number(toks[i + 2].v) || 0);
      if (prev && prev.t === "p" && prev.v === "." && (EASE_BOUNCE.test(tk.v) || EASE_BACK.test(tk.v))) easeName(tk.v);
      if (tk.v === "random" || tk.v === "mulberry") out.random = true;
      if (/^(arc|fillRect|strokeRect|ellipse|lineTo|createElement|createElementNS|appendChild|insertAdjacentHTML|drawImage|bezierCurveTo|quadraticCurveTo)$/.test(tk.v)) out.draws = true;
      // for (...; i < 46; ...), Array(46), { length: 46 }
      if ((tk.v === "length" || tk.v === "Array" || tk.v === "times") && toks[i + 1] && /^[:(]$/.test(toks[i + 1].v) && toks[i + 2] && toks[i + 2].t === "n") out.loopCount = Math.max(out.loopCount, Number(toks[i + 2].v) || 0);
      if (tk.v === "spring" && toks[i + 1] && toks[i + 1].v === "(") {
        let depth = 0, stiffness = 170, damping = 26, mass = 1;
        for (let k = i + 1; k < toks.length && k < i + 60; k += 1) {
          if (toks[k].v === "(") depth += 1;
          else if (toks[k].v === ")") {
            depth -= 1;
            if (depth === 0) break;
          } else if (toks[k].t === "i" && toks[k + 1] && toks[k + 1].v === ":" && toks[k + 2] && toks[k + 2].t === "n") {
            if (toks[k].v === "stiffness") stiffness = Number(toks[k + 2].v);
            else if (toks[k].v === "damping") damping = Number(toks[k + 2].v);
            else if (toks[k].v === "mass") mass = Number(toks[k + 2].v);
          }
        }
        const zeta = damping / (2 * Math.sqrt(Math.max(1e-6, stiffness * mass)));
        if (zeta < 0.45) out.eases.push({ kind: "bounce", name: "JV.spring with damping " + damping });
        else if (zeta < 0.62) out.eases.push({ kind: "overshoot", name: "JV.spring with damping " + damping });
      }
    }
    if (tk.t === "p" && (tk.v === "<" || tk.v === "<=") && toks[i + 1] && toks[i + 1].t === "n") {
      // A loop bound: i < 46
      let k = i - 1, isFor = false;
      for (let back = 0; back < 14 && k >= 0; back += 1, k -= 1) if (toks[k].t === "i" && (toks[k].v === "for" || toks[k].v === "while")) isFor = true;
      if (isFor) out.loopCount = Math.max(out.loopCount, Number(toks[i + 1].v) || 0);
    }
    if (consumed.has(i)) continue;
    let start = null;
    if (tk.t === "s") start = { value: strOf(tk), len: 1 };
    else if (tk.t === "i") {
      const prev = toks[i - 1];
      if (prev && prev.t === "p" && /^(=|\(|,|:|\+|\[|\?|\+=)$/.test(prev.v)) start = constAt(i);
      else if (prev && prev.t === "i" && prev.v === "return") start = constAt(i);
    }
    if (!start) continue;
    // Fold "a" + b + `c` into one string. An operand that is not a known
    // constant becomes UNKNOWN.
    let value = start.value;
    let k = i + start.len;
    while (toks[k] && toks[k].t === "p" && toks[k].v === "+") {
      const nx = toks[k + 1];
      if (!nx) break;
      if (nx.t === "s") {
        value += strOf(nx);
        consumed.add(k + 1);
        k += 2;
        continue;
      }
      const cn = constAt(k + 1);
      if (cn) {
        value += cn.value;
        for (let c = 0; c < cn.len; c += 1) consumed.add(k + 1 + c);
        k += 1 + cn.len;
        continue;
      }
      if (nx.t === "n" && !(toks[k + 2] && toks[k + 2].t === "p" && /^[*/%.-]$/.test(toks[k + 2].v))) {
        value += nx.v;
        k += 2;
        continue;
      }
      // Skip one unknown operand up to the next + at this depth.
      let depth = 0, q = k + 1;
      for (; q < toks.length; q += 1) {
        const t2 = toks[q];
        if (t2.t !== "p") continue;
        if (t2.v === "(" || t2.v === "[" || t2.v === "{") depth += 1;
        else if (t2.v === ")" || t2.v === "]" || t2.v === "}") {
          if (depth === 0) break;
          depth -= 1;
        } else if (depth === 0 && (t2.v === "+" || t2.v === ";" || t2.v === "," || t2.v === ":" || t2.v === "?")) break;
      }
      value += UNKNOWN;
      k = q;
    }
    // Where the expression starts, and what it is handed to.
    let j = i - 1, depth = 0, lead = false;
    for (; j >= 0; j -= 1) {
      const t2 = toks[j];
      if (t2.t === "p") {
        if (t2.v === ")" || t2.v === "]") depth += 1;
        else if (t2.v === "(" || t2.v === "[") {
          if (depth === 0) break;
          depth -= 1;
        } else if (depth === 0 && /^(=|\+=|,|:|;|\{|\}|\?|=>)$/.test(t2.v)) break;
      } else if (depth === 0 && t2.t === "i" && t2.v === "return") break;
      lead = true;
    }
    if (lead) value = UNKNOWN + value;
    out.texts.push(value.replace(new RegExp(UNKNOWN, "g"), " "));
    easeName(value);
    const ctx = j >= 0 ? toks[j] : null;
    if (ctx && ctx.t === "p" && (ctx.v === "=" || ctx.v === "+=")) {
      const path = pathBefore(j - 1);
      const lastSeg = path[path.length - 1] || "";
      const declared = toks[j - 2] && toks[j - 2].t === "i" && /^(var|let|const)$/.test(toks[j - 2].v);
      if (path.length === 1 && (declared || !(toks[j - 2] && toks[j - 2].v === ".")) && ctx.v === "=" && !lead) consts.set(lastSeg, value);
      const styleAt = path.lastIndexOf("style");
      if (styleAt >= 0 && styleAt === path.length - 2) {
        if (lastSeg === "cssText") out.declLists.push(value);
        else group(path.slice(0, styleAt).join(".") || "script").push({ prop: camelToKebab(lastSeg), value });
      } else if (lastSeg === "style" || lastSeg === "cssText") out.declLists.push(value);
      else if (lastSeg === "font" && path.length > 1) group("canvas:" + path.slice(0, -1).join(".")).push({ prop: "font", value });
      else if ((lastSeg === "fillStyle" || lastSeg === "strokeStyle") && path.length > 1) group("canvas:" + path.slice(0, -1).join(".")).push({ prop: "fill", value });
      else if (lastSeg === "shadowColor" && path.length > 1) group("canvas:" + path.slice(0, -1).join(".")).push({ prop: "canvas-shadow-color", value });
      else if (lastSeg === "filter" && path.length > 1) group("canvas:" + path.slice(0, -1).join(".")).push({ prop: "filter", value });
      else if (lastSeg === "innerHTML" || lastSeg === "outerHTML") out.htmlTexts.push(value);
      else if (TEXT_PROPS.has(lastSeg) || SKIP_PROPS.has(lastSeg)) {
        // Words only (the emoji scan has them already), unless it is a stylesheet for a style tag.
        if ((lastSeg === "textContent" || lastSeg === "innerText") && /[^{}]+\{[^{}]*:[^{}]*\}/.test(value)) out.cssTexts.push(value);
      } else classify(value);
    } else if (ctx && ctx.t === "p" && ctx.v === ":" && toks[j - 1] && (toks[j - 1].t === "i" || toks[j - 1].t === "s") && toks[j - 2] && toks[j - 2].t === "p" && /^[{,]$/.test(toks[j - 2].v)) {
      const key = toks[j - 1].parts ? "" : toks[j - 1].v;
      const prop = key.indexOf("-") >= 0 ? key.toLowerCase() : camelToKebab(key);
      // The object this key sits in: find its opening brace, and the name it is bound to.
      let q = j - 2, d2 = 0;
      for (; q >= 0; q -= 1) {
        const t2 = toks[q];
        if (t2.t !== "p") continue;
        if (t2.v === "}" || t2.v === ")" || t2.v === "]") d2 += 1;
        else if (t2.v === "{" || t2.v === "(" || t2.v === "[") {
          if (d2 === 0 && t2.v === "{") break;
          d2 -= 1;
        }
      }
      if (q >= 2 && toks[q - 1].t === "p" && toks[q - 1].v === "=" && toks[q - 2].t === "i" && key && !lead) consts.set(toks[q - 2].v + "." + key, value);
      if (JS_STYLE_KEYS.has(prop)) group("object@" + q).push({ prop, value });
      else if (/^(ease|easing|timingFunction|animationTimingFunction)$/.test(key)) {
        /* easeName above has it */
      } else if (!TEXT_PROPS.has(key) && !SKIP_PROPS.has(key)) classify(value);
    } else if (ctx && ctx.t === "p" && (ctx.v === "(" || ctx.v === ",")) {
      // Which call, which argument.
      let q = i - 1, d2 = 0, argIndex = 0;
      for (; q >= 0; q -= 1) {
        const t2 = toks[q];
        if (t2.t !== "p") continue;
        if (t2.v === ")" || t2.v === "]" || t2.v === "}") d2 += 1;
        else if (t2.v === "(" || t2.v === "[" || t2.v === "{") {
          if (d2 === 0) break;
          d2 -= 1;
        } else if (d2 === 0 && t2.v === ",") argIndex += 1;
      }
      const isCall = q >= 1 && toks[q].v === "(";
      const path = isCall ? pathBefore(q - 1) : [];
      const fn = path[path.length - 1] || "";
      const firstArg = isCall && toks[q + 1] && toks[q + 1].t === "s" && !toks[q + 1].parts ? toks[q + 1].v : "";
      if (fn === "setProperty" && argIndex === 1 && firstArg) {
        const styleAt = path.lastIndexOf("style");
        group(styleAt > 0 ? path.slice(0, styleAt).join(".") : "script").push({ prop: firstArg.startsWith("--") ? firstArg : normProp(firstArg), value });
      } else if (fn === "setProperty" || fn === "getPropertyValue" || fn === "removeProperty") {
        /* the property name */
      } else if (fn === "addColorStop" && argIndex === 1) {
        const key = path.slice(0, -1).join(".") || "gradient";
        if (!out.canvasGrads.has(key)) out.canvasGrads.set(key, []);
        out.canvasGrads.get(key).push(value);
      } else if ((fn === "setAttribute" || fn === "setAttributeNS") && argIndex >= 1 && firstArg) {
        const name = fn === "setAttributeNS" && toks[q + 3] && toks[q + 3].t === "s" ? toks[q + 3].v : firstArg;
        const lower = String(name).toLowerCase();
        if (lower === "style") out.declLists.push(value);
        else if (JS_STYLE_KEYS.has(lower)) group("attr:" + (path.slice(0, -1).join(".") || "el")).push({ prop: lower, value });
      } else if (fn === "setAttribute" || fn === "setAttributeNS" || fn === "getAttribute") {
        /* the attribute name */
      } else if (fn === "insertAdjacentHTML" || fn === "write" || fn === "writeln") out.htmlTexts.push(value);
      else if (/^(querySelector|querySelectorAll|getElementById|getElementsByClassName|getElementsByTagName|createElement|createElementNS|add|remove|toggle|contains|closest|matches|addEventListener|getContext|fillText|strokeText|measureText|log|warn|error|split|join|replace|indexOf|includes|startsWith|endsWith|test|match|padStart|padEnd|toLocaleString|toFixed|require|getPropertyValue|animate)$/.test(fn)) {
        /* names, selectors and words, not styling */
      } else classify(value);
    } else classify(value);
  }
  // Layout properties set from the frame callback.
  const plain = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
  const drawRe = /drawAt\s*(?:=\s*(?:function\b[^(]*)?\(|\()/g;
  let dm;
  while ((dm = drawRe.exec(plain))) {
    const open = plain.indexOf("{", dm.index);
    if (open < 0) break;
    const body = plain.slice(open, closeBrace(plain, open) + 1);
    const lay = /\.style\.(width|height|minWidth|minHeight|maxWidth|maxHeight|margin[A-Z]\w*|margin|padding[A-Z]\w*|padding|top|left|right|bottom)\s*=/g;
    let lm;
    while ((lm = lay.exec(body))) if (!out.layoutInDraw.includes(lm[1])) out.layoutInDraw.push(lm[1]);
  }
  out.names = plain;
  return out;
}

// -------------------------------------------------------------- value parsers

const SIZE_TOKEN = /^[\u0001\d.+-]+(?:px|pt|pc|em|rem|vmin|vmax|vw|vh|%|in|cm|mm|ch|ex|cq\w+|[sdl]v\w+)$|^(?:xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|larger|smaller)$|^(?:calc|clamp|min|max)\(/i;

function parseFontShorthand(value) {
  const v = String(value).trim();
  if (/^(caption|icon|menu|message-box|small-caption|status-bar)$/i.test(v)) return { family: "system-ui" };
  const toks = splitTop(v, " ");
  let at = -1;
  for (let i = 0; i < toks.length; i += 1) {
    if (SIZE_TOKEN.test(toks[i].split("/")[0])) {
      at = i;
      break;
    }
  }
  if (at < 0) return null;
  const out = { style: "normal", weight: "400", size: toks[at].split("/")[0], family: "" };
  for (let i = 0; i < at; i += 1) {
    const t = toks[i].toLowerCase();
    if (t === "italic" || t === "oblique") out.style = "italic";
    else if (t === "bold" || t === "bolder" || t === "lighter" || /^\d{1,4}(\.\d+)?$/.test(t)) out.weight = t;
  }
  let rest = at + 1;
  if (toks[at].indexOf("/") >= 0 && toks[at].endsWith("/")) rest += 1;
  else if (toks[rest] === "/") rest += 2;
  else if (toks[rest] && toks[rest][0] === "/") rest += 1;
  out.family = toks.slice(rest).join(" ");
  return out;
}

function parseFamilies(value) {
  return splitTop(String(value), ",").map(fontKey).filter(Boolean);
}

function weightNumber(value, inherited) {
  const v = String(value == null ? "" : value).trim().toLowerCase();
  if (!v || v === "normal") return 400;
  if (v === "bold") return 700;
  if (v === "bolder") return Math.min(900, (inherited || 400) + 300);
  if (v === "lighter") return Math.max(100, (inherited || 400) - 300);
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : inherited || 400;
}

// box-shadow or text-shadow: [{ inset, x, y, blur, spread, color }]
function parseShadows(value, frame, em) {
  const out = [];
  const v = String(value == null ? "" : value);
  if (!v || /^none$/i.test(v.trim())) return out;
  for (const part of splitTop(v, ",")) {
    const nums = [];
    let inset = false;
    for (const tok of splitTop(part, " ")) {
      if (/^inset$/i.test(tok)) inset = true;
      else if (/^[+-]?[\d.]/.test(tok)) {
        const px = lengthPx(tok, frame, em == null ? 16 : em);
        if (px != null) nums.push(px);
      }
    }
    if (nums.length < 2) continue;
    out.push({ inset, x: nums[0], y: nums[1], blur: nums[2] || 0, spread: nums[3] || 0, color: findColors(part)[0] || null, text: part.trim() });
  }
  return out;
}

function parseFilter(value, frame) {
  const out = { blur: 0, shadows: [] };
  for (const call of findCalls(String(value == null ? "" : value), "blur|drop-shadow")) {
    if (call.name === "blur") out.blur = Math.max(out.blur, lengthPx(call.args, frame, 16) || 0);
    else out.shadows.push(...parseShadows(call.args, frame, 16));
  }
  return out;
}

// { px: largest corner in frame pixels (null: unknown), pct: largest percent, raw }
function parseRadius(value, frame, em) {
  const out = { px: null, pct: 0, raw: String(value || "").trim() };
  for (const tok of splitTop(out.raw.replace(/\//g, " "), " ")) {
    if (/%$/.test(tok)) out.pct = Math.max(out.pct, parseFloat(tok) || 0);
    else if (/infinity/i.test(tok)) out.px = 1e6;
    else {
      const px = lengthPx(tok, frame, em == null ? 16 : em);
      if (px != null) out.px = Math.max(out.px == null ? 0 : out.px, px);
    }
  }
  return out;
}

function parseBorder(value, frame) {
  const v = String(value == null ? "" : value).trim();
  if (!v || /^(none|0|hidden)\b/i.test(v)) return { w: 0, color: null };
  let w = null;
  let none = false;
  for (const tok of splitTop(v, " ")) {
    const t = tok.toLowerCase();
    if (t === "none" || t === "hidden") none = true;
    else if (t === "thin") w = 1;
    else if (t === "medium") w = 3;
    else if (t === "thick") w = 5;
    else if (/^[+-]?[\d.]/.test(t)) {
      const px = lengthPx(t, frame, 16);
      if (px != null) w = px;
    }
  }
  if (none) return { w: 0, color: null };
  return { w: w == null ? 3 : w, color: findColors(v)[0] || null };
}

const TIMING_WORD = /^(ease|ease-in|ease-out|ease-in-out|linear|step-start|step-end)$/i;

// animation shorthand -> [{ name, dur, delay, timing, iter, dir, delayText }]
function parseAnimation(value) {
  const out = [];
  const v = String(value == null ? "" : value).trim();
  if (!v || /^(none|initial|inherit|unset)$/i.test(v)) return out;
  for (const part of splitTop(v, ",")) {
    const a = { name: "", dur: null, delay: null, timing: "", iter: 1, dir: "", delayText: "" };
    for (const tok of splitTop(part, " ")) {
      const t = tok.toLowerCase();
      const ms = timeMs(t);
      if (ms != null) {
        if (a.dur == null) a.dur = ms;
        else if (a.delay == null) {
          a.delay = ms;
          a.delayText = t;
        }
      } else if (/^calc\(/.test(t) && /\d(ms|s)\b/.test(t)) {
        if (a.dur == null) a.dur = 0;
        else {
          a.delay = 0;
          a.delayText = t;
        }
      } else if (TIMING_WORD.test(t) || /^(cubic-bezier|steps|linear)\(/.test(t)) a.timing = t;
      else if (t === "infinite") a.iter = Infinity;
      else if (/^\d+(\.\d+)?$/.test(t)) a.iter = Number(t);
      else if (/^(normal|reverse|alternate|alternate-reverse)$/.test(t)) a.dir = t;
      else if (/^(none|forwards|backwards|both|running|paused)$/.test(t)) {
        /* fill mode and play state */
      } else if (!a.name && /^[\w-]+$/.test(tok)) a.name = tok;
      else if (!a.name) a.name = tok.replace(/^['"]|['"]$/g, "");
    }
    out.push(a);
  }
  return out;
}

// How far a cubic-bezier easing runs past its ends: { over, under } as a share of the move.
function bezierExtremes(text) {
  const m = /cubic-bezier\(([^)]*)\)/i.exec(String(text));
  if (!m) return null;
  const p = m[1].split(",").map((x) => Number(x.trim()));
  if (p.length !== 4 || p.some((x) => !Number.isFinite(x))) return null;
  let max = 1, min = 0;
  for (let i = 1; i < 50; i += 1) {
    const t = i / 50, u = 1 - t;
    const y = 3 * u * u * t * p[1] + 3 * u * t * t * p[3] + t * t * t;
    if (y > max) max = y;
    if (y < min) min = y;
  }
  return { over: max - 1, under: -min };
}

// Every gradient in a value: { type, repeating, stops: [color], hard, unknown, text }
function parseGradients(value) {
  const out = [];
  const v = String(value == null ? "" : value);
  if (v.indexOf("gradient(") < 0) return out;
  for (const call of findCalls(v, "(?:repeating-)?(?:linear|radial|conic)-gradient")) {
    const g = { type: call.name.replace("repeating-", "").replace("-gradient", ""), repeating: call.name.startsWith("repeating-"), stops: [], hard: false, unknown: false, tiny: false, text: call.name + "(" + short(call.args, 70) + ")" };
    let lastPos = null;
    for (const arg of splitTop(call.args, ",")) {
      const colors = findColors(arg);
      if (!colors.length) {
        if (arg.indexOf(UNKNOWN) >= 0) g.unknown = true;
        continue;
      }
      g.stops.push(colors[0]);
      // Stop positions: two stops at one place make a hard edge, which is a
      // drawn shape or a pattern, not a blend.
      const pos = splitTop(arg.replace(new RegExp("#[0-9a-f]{3,8}\\b|\\b(?:" + COLOR_FN + ")\\((?:[^()]|\\([^()]*\\))*\\)", "gi"), " "), " ").filter((t) => /^[+-]?[\d.]+(%|px|deg|turn|vmin|vw|vh|em|rem)?$/.test(t));
      if (pos.length > 1) g.hard = true;
      if (pos.length && lastPos != null) {
        const a = parseFloat(lastPos), b = parseFloat(pos[0]);
        if (lastPos.replace(/[\d.+-]/g, "") === pos[0].replace(/[\d.+-]/g, "") && Math.abs(a - b) <= 1.01) g.hard = true;
      }
      if (pos.length) {
        lastPos = pos[pos.length - 1];
        if (/px$/.test(lastPos) && parseFloat(lastPos) <= 6) g.tiny = true;
      }
    }
    out.push(g);
  }
  return out;
}

function stripCalls(value) {
  let v = String(value == null ? "" : value);
  for (const call of findCalls(v, "(?:repeating-)?(?:linear|radial|conic)-gradient|url|image-set|element|paint").reverse()) v = v.slice(0, call.start) + " " + v.slice(call.end);
  return v;
}

// ------------------------------------------------------------------ the model

const INLINE_TAGS = new Set(["span", "b", "i", "em", "strong", "a", "mark", "small", "sub", "sup", "u", "s", "br", "code", "kbd", "abbr", "cite", "q", "time", "var", "wbr", "label", "tspan", "font", "big", "del", "ins"]);
const BOLD_TAGS = new Set(["b", "strong", "h1", "h2", "h3", "h4", "h5", "h6", "th"]);
const HEADING_EM = { h1: 2, h2: 1.5, h3: 1.17, h4: 1, h5: 0.83, h6: 0.67, small: 0.83, sub: 0.83, sup: 0.83 };
const INHERITED = new Set(["color", "font-family", "font-size", "font-weight", "font-style", "text-align", "letter-spacing", "text-transform", "line-height", "text-shadow", "fill"]);
const SVG_ATTRS = ["fill", "stroke", "stop-color", "font-family", "font-size", "font-weight", "font-style", "letter-spacing", "filter", "text-anchor", "flood-color"];

function resolveVars(value, vars, local) {
  let out = String(value);
  if (out.indexOf("var(") < 0) return out;
  for (let guard = 0; guard < 32; guard += 1) {
    const at = out.lastIndexOf("var(");
    if (at < 0) break;
    const close = closeOf(out, at + 3);
    const inner = out.slice(at + 4, close);
    let comma = -1, depth = 0;
    for (let i = 0; i < inner.length; i += 1) {
      const c = inner[i];
      if (c === "(") depth += 1;
      else if (c === ")") depth -= 1;
      else if (c === "," && depth === 0) {
        comma = i;
        break;
      }
    }
    const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
    const fallback = comma < 0 ? null : inner.slice(comma + 1).trim();
    let rep = local && local.has(name) ? local.get(name) : vars.get(name);
    if (rep == null || rep.indexOf("var(" + name) >= 0) rep = fallback != null && fallback !== "" ? fallback : UNKNOWN;
    out = out.slice(0, at) + rep + out.slice(close + 1);
  }
  return out;
}

function labelOf(el) {
  if (!el) return "";
  if (el.synthetic && el.parent) return labelOf(el.parent.classes.includes("jv-word") ? el.parent.parent : el.parent);
  if (el.id) return "#" + el.id;
  if (el.classes.length) return "." + el.classes[0];
  return el.tag;
}

function buildModel(input, opts) {
  const kind = input.kind === "animation" ? "animation" : "card";
  const W = Number(input.width) > 0 ? Number(input.width) : kind === "animation" ? 1920 : 1080;
  const H = Number(input.height) > 0 ? Number(input.height) : kind === "animation" ? 1080 : 1920;
  const M = {
    kind,
    frame: { W, H },
    durationMs: Number(input.durationMs) > 0 ? Number(input.durationMs) : null,
    units: [],
    vars: new Map(),
    sheet: { rules: [], keyframes: new Map(), fontFaces: [] },
    extraFonts: new Set(),
    raw: "",
  };
  const doc = parseHtml(input.html);
  M.doc = doc;
  const jsSource = [typeof input.js === "string" ? input.js : "", ...doc.scripts].filter((s) => s && s.trim()).join("\n;\n");
  M.js = scanJs(jsSource);
  M.hasJs = Boolean(jsSource.trim());
  // Markup a script writes is part of the page.
  for (const fragment of M.js.htmlTexts.slice(0, 40)) {
    const extra = parseHtml(fragment);
    for (const child of extra.body.children) {
      child.parent = doc.body;
      child.index = doc.body.children.length;
      doc.body.children.push(child);
    }
    for (const el of extra.all) if (el !== extra.root && el !== extra.body) {
      el.fromJs = true;
      doc.all.push(el);
    }
    if (extra.body.text) M.js.texts.push(extra.body.text);
    doc.styles.push(...extra.styles);
  }
  const cssSource = [typeof input.css === "string" ? input.css : "", ...doc.styles, ...M.js.cssTexts].filter(Boolean).join("\n");
  parseCss(cssSource, M.sheet, "", "");
  M.raw = (typeof input.html === "string" ? input.html : "") + "\n" + cssSource + "\n" + jsSource;

  // Variables, as lib/html-card.js cssVarBlock writes them, then the author's own.
  const colors = input.colors && typeof input.colors === "object" ? input.colors : {};
  const setVar = (name, value) => {
    const v = String(value == null ? "" : value).replace(/[;{}<>]/g, "").trim();
    if (name && v) M.vars.set(name, v);
  };
  setVar("--primary", colors.primary || "#1F6F56");
  setVar("--secondary", colors.secondary || "#DFF56A");
  setVar("--text", colors.text || "#FFFFFF");
  M.colorsGiven = { primary: Boolean(colors.primary), secondary: Boolean(colors.secondary), text: Boolean(colors.text) };
  M.primary = parseColor(colors.primary || "");
  const vars = input.vars && typeof input.vars === "object" ? input.vars : {};
  for (const key of Object.keys(vars)) {
    const name = String(key).trim().replace(/^--/, "").replace(/[^A-Za-z0-9_-]/g, "");
    if (name && !["primary", "secondary", "text"].includes(name)) setVar("--" + name, vars[key]);
  }
  for (const rule of M.sheet.rules) for (const d of rule.decls) if (d.prop.startsWith("--") && !(rule.media && MEDIA_OFF.test(rule.media))) M.vars.set(d.prop, d.value);
  for (const el of doc.all) {
    if (!el.attrs.style) continue;
    el.inline = parseDecls(el.attrs.style);
    for (const d of el.inline) if (d.prop.startsWith("--") && !M.vars.has(d.prop)) M.vars.set(d.prop, d.value);
  }
  for (const face of M.sheet.fontFaces) {
    const fam = face.find((d) => d.prop === "font-family");
    const src = face.find((d) => d.prop === "src");
    if (fam && src && /url\(\s*['"]?data:|local\(/i.test(src.value)) M.extraFonts.add(fontKey(fam.value));
  }
  if (Array.isArray(opts.fonts)) for (const f of opts.fonts) M.extraFonts.add(fontKey(f));

  const addUnit = (label, decls, extra) => {
    const u = Object.assign({ label, sel: "", decls, map: new Map(), els: [], src: "css", kf: false, state: false, pseudoEl: "", media: "", anims: [] }, extra || {});
    let local = null;
    for (const d of decls) if (d.prop.startsWith("--")) (local || (local = new Map())).set(d.prop, d.value);
    for (const d of decls) {
      if (d.prop.startsWith("--")) continue;
      let value = resolveVars(d.value, M.vars, local);
      if (d.prop === "content") value = decodeCssEscapes(value);
      if (d.prop === "font") {
        const f = parseFontShorthand(value);
        if (f) {
          if (f.family) u.map.set("font-family", f.family);
          if (f.size) u.map.set("font-size", f.size);
          if (f.weight) u.map.set("font-weight", f.weight);
          if (f.style) u.map.set("font-style", f.style);
        }
      }
      u.map.set(d.prop, value);
    }
    const names = u.map.get("animation-name");
    const anims = parseAnimation(u.map.get("animation"));
    if (names && !anims.length) for (const n of splitTop(names, ",")) if (n && n !== "none") anims.push({ name: n.replace(/^['"]|['"]$/g, ""), dur: null, delay: null, timing: "", iter: 1, dir: "", delayText: "" });
    const pick = (prop, apply) => {
      const v = u.map.get(prop);
      if (!v) return;
      const list = splitTop(v, ",");
      anims.forEach((a, i) => apply(a, list[i % list.length].toLowerCase()));
    };
    pick("animation-duration", (a, v) => (a.dur = timeMs(v)));
    pick("animation-delay", (a, v) => {
      a.delay = timeMs(v) == null ? 0 : timeMs(v);
      a.delayText = v;
    });
    pick("animation-timing-function", (a, v) => (a.timing = v));
    pick("animation-iteration-count", (a, v) => (a.iter = v === "infinite" ? Infinity : Number(v) || 1));
    pick("animation-direction", (a, v) => (a.dir = v));
    u.anims = anims;
    M.units.push(u);
    return u;
  };
  M.addUnit = addUnit;

  for (const rule of M.sheet.rules) {
    const list = parseSelectors(rule.sel);
    const u = addUnit(short(rule.sel, 48), rule.decls, { sel: rule.sel, media: rule.media, selectors: list });
    u.state = list.length > 0 && list.every((s) => s.state);
    u.pseudoEl = list.length && list.every((s) => s.pseudoEl) ? list[0].pseudoEl : "";
  }
  for (const [name, frames] of M.sheet.keyframes) for (const frame of frames) if (frame.decls.length) addUnit("@keyframes " + name, frame.decls, { kf: true, kfName: name, keys: frame.keys });
  for (const el of doc.all) {
    if (el.inline && el.inline.some((d) => !d.prop.startsWith("--"))) {
      const u = addUnit("<" + el.tag + (el.classes.length ? "." + el.classes[0] : "") + " style>", el.inline, { src: "inline", inlineEl: el });
      u.els.push(el);
    }
    if (el.inSvg || el.tag === "svg") {
      const decls = [];
      for (const name of SVG_ATTRS) if (el.attrs[name] != null && el.attrs[name] !== "") decls.push({ prop: name, value: el.attrs[name] });
      if (decls.length) {
        const u = addUnit("<" + el.tag + ">", decls, { src: "svg", svgEl: el });
        u.els.push(el);
      }
    }
  }
  for (const [key, decls] of M.js.groups) addUnit(key.startsWith("canvas:") ? "canvas in script" : "script", decls, { src: "js", canvas: key.startsWith("canvas:") });
  for (const text of M.js.declLists) {
    const decls = parseDecls(text);
    if (decls.length) addUnit("script", decls, { src: "js" });
  }

  // The cascade: which rule styles which element.
  const hits = [];
  const byClass = new Map(), byTag = new Map(), byId = new Map();
  for (const el of doc.all) {
    for (const c of el.classes) (byClass.get(c) || byClass.set(c, []).get(c)).push(el);
    (byTag.get(el.tag) || byTag.set(el.tag, []).get(el.tag)).push(el);
    if (el.id) (byId.get(el.id) || byId.set(el.id, []).get(el.id)).push(el);
  }
  M.units.forEach((u, order) => {
    if (u.src === "inline") {
      hits.push({ el: u.inlineEl, u, spec: 1e9, order, pseudoEl: "" });
      return;
    }
    if (u.src === "svg") {
      hits.push({ el: u.svgEl, u, spec: -1, order, pseudoEl: "" });
      return;
    }
    if (!u.selectors || u.kf || (u.media && MEDIA_OFF.test(u.media))) return;
    const seen = new Set();
    for (const cx of u.selectors) {
      if (cx.state) continue;
      const lastPart = cx.parts[cx.parts.length - 1];
      const pool = lastPart.id ? byId.get(lastPart.id) : lastPart.classes.length ? byClass.get(lastPart.classes[0]) : lastPart.tag ? byTag.get(lastPart.tag) : doc.all;
      if (!pool) continue;
      for (const el of pool) {
        if (seen.has(el) && !cx.pseudoEl) continue;
        if (!matchComplex(el, cx.parts, cx.parts.length - 1)) continue;
        hits.push({ el, u, spec: cx.spec, order, pseudoEl: cx.pseudoEl });
        if (!cx.pseudoEl && !seen.has(el)) {
          seen.add(el);
          u.els.push(el);
        } else if (cx.pseudoEl) (u.pseudoHosts || (u.pseudoHosts = [])).push(el);
      }
    }
  });
  hits.sort((a, b) => a.spec - b.spec || a.order - b.order);
  for (const h of hits) {
    let target = h.el.props;
    if (h.pseudoEl) {
      if (!h.el.pseudo) h.el.pseudo = Object.create(null);
      target = h.el.pseudo[h.pseudoEl] || (h.el.pseudo[h.pseudoEl] = Object.create(null));
    }
    for (const [prop, value] of h.u.map) {
      if (prop === "animation") for (const k of ["animation-name", "animation-delay", "animation-duration", "animation-timing-function", "animation-iteration-count", "animation-direction"]) delete target[k];
      target[prop] = value;
    }
    if (!h.pseudoEl) (h.el.units || (h.el.units = [])).push(h.u);
  }
  M.textEls = doc.all.filter((el) => el.text && /[\p{L}\p{N}]/u.test(el.text) && !RAW_TAGS.has(el.tag));
  return M;
}

// ---------------------------------------------------------- element readings

function inherit(el, prop) {
  for (let p = el; p; p = p.parent) {
    const v = p.props[prop];
    if (v != null && v !== "inherit") return v;
  }
  return undefined;
}

function fontSizePx(el, M) {
  if (el.fs !== undefined) return el.fs;
  el.fs = null;
  const parent = el.parent ? fontSizePx(el.parent, M) : 16;
  let v = el.props["font-size"];
  let out;
  if (v == null || v === "inherit") out = el.parent ? (HEADING_EM[el.tag] && parent != null ? parent * HEADING_EM[el.tag] : parent) : 16;
  else {
    v = String(v).trim().toLowerCase();
    if (v === "larger") out = parent == null ? null : parent * 1.2;
    else if (v === "smaller") out = parent == null ? null : parent / 1.2;
    else if (v === "medium") out = 16;
    else if (v === "small") out = 13;
    else if (v === "large") out = 18;
    else if (v === "x-large") out = 24;
    else if (v === "xx-large") out = 32;
    else out = lengthPx(v, M.frame, parent);
  }
  el.fs = out == null || !(out > 0) ? null : out;
  return el.fs;
}

function fontWeight(el) {
  if (el.fw !== undefined) return el.fw;
  const parent = el.parent ? fontWeight(el.parent) : 400;
  const v = el.props["font-weight"];
  el.fw = v == null || v === "inherit" ? (BOLD_TAGS.has(el.tag) ? 700 : parent) : weightNumber(v, parent);
  return el.fw;
}

function isInline(el) {
  if (el.synthetic) return true;
  if (!INLINE_TAGS.has(el.tag)) return false;
  if (el.parent && /flex|grid/.test(String(el.parent.props.display || ""))) return false;
  if (/^(absolute|fixed)$/.test(String(el.props.position || ""))) return false;
  const d = String(el.props.display || "");
  return !/^(block|flex|grid|list-item|table|flow-root)/.test(d);
}

// The block a piece of text belongs to: its nearest element that is not inline.
function blockOf(el) {
  let p = el;
  while (p.parent && isInline(p)) p = p.parent;
  return p;
}

function isUpper(el) {
  if (/uppercase/i.test(String(inherit(el, "text-transform") || ""))) return true;
  const letters = (el.text || "").replace(/[^\p{L}]/gu, "");
  return letters.length >= 3 && letters === letters.toUpperCase() && letters !== letters.toLowerCase();
}

function backgroundOf(props, M) {
  if (!props) return { solid: null, grads: [], url: false };
  const text = [props.background, props["background-image"], props["background-color"]].filter(Boolean).join(" , ");
  if (!text) return { solid: null, grads: [], url: false, text: "" };
  const solids = findColors(stripCalls(text)).filter((c) => c.a > 0.02);
  return { solid: solids.length ? solids[solids.length - 1] : null, grads: parseGradients(text), url: /url\(/i.test(text), text };
}

function unitBg(u) {
  if (u.bg === undefined) u.bg = backgroundOf(Object.fromEntries(u.map), null);
  return u.bg;
}

const isZero = (v) => v != null && /^0(px|%|vmin|vw|vh|em|rem)?$/.test(String(v).trim());

function isFullBleed(el) {
  const p = el.props;
  const pos = String(p.position || "");
  if (pos === "absolute" || pos === "fixed") {
    if (p.inset != null && splitTop(p.inset, " ").every(isZero)) return true;
    if (isZero(p.top) && isZero(p.left) && ((isZero(p.right) && isZero(p.bottom)) || (/^100(%|vw)$/.test(String(p.width || "")) && /^100(%|vh)$/.test(String(p.height || ""))))) return true;
  }
  return /^100(%|vw)$/.test(String(p.width || "")) && /^100(%|vh|dvh|svh)$/.test(String(p.height || p["min-height"] || ""));
}

// What paints the whole frame: { color, grads, where, known }.
function pageBackground(M) {
  if (M.page !== undefined) return M.page;
  let page = null;
  for (const el of [M.doc.body, M.doc.root]) {
    const bg = backgroundOf(el.props, M);
    if (bg.solid || bg.grads.length) {
      page = { color: bg.solid, grads: bg.grads, where: el.tag, known: true };
      break;
    }
  }
  if (!page) {
    for (const el of M.doc.all) {
      if (el === M.doc.body || el === M.doc.root || el.inSvg) continue;
      let depth = 0;
      for (let p = el.parent; p; p = p.parent) depth += 1;
      if (depth > 4 || !isFullBleed(el)) continue;
      const bg = backgroundOf(el.props, M);
      if (bg.solid && bg.solid.a >= 0.6) {
        page = { color: bg.solid, grads: bg.grads, where: labelOf(el), known: true, el };
        break;
      }
      if (bg.grads.length) {
        page = { color: null, grads: bg.grads, where: labelOf(el), known: true, el };
        break;
      }
    }
  }
  // A page with no background of its own is painted with colors.primary
  // (buildCardDocument in lib/html-card.js, buildAnimationDocument in lib/animation-render.js).
  if (!page) page = { color: M.primary || parseColor("#0E1421"), grads: [], where: "colors.primary", known: true, implicit: true };
  M.page = page;
  return page;
}

// The opaque color behind an element, as far as source can tell.
function backdropOf(el, M) {
  for (let p = el; p; p = p.parent) {
    const bg = backgroundOf(p.props, M);
    if (bg.solid && bg.solid.a >= 0.6) return bg.solid;
    if (bg.grads.length || bg.url) return null;
  }
  const page = pageBackground(M);
  return page && page.color ? page.color : null;
}

function hasText(el) {
  return /[\p{L}\p{N}]/u.test(allText(el));
}

function hasExplicitWidth(el) {
  const p = el.props;
  const w = String(p.width || "").trim();
  if (w && !/^(auto|fit-content|max-content|min-content)$/.test(w)) return true;
  if (/^(absolute|fixed)$/.test(String(p.position || "")) && p.left != null && p.right != null) return true;
  return /^1\b/.test(String(p.flex || "")) || Number(p["flex-grow"]) > 0;
}

function centersChildren(p) {
  const props = p.props;
  const d = String(props.display || "");
  const place = splitTop(String(props["place-items"] || ""), " ");
  if (place.length && /grid|flex/.test(d) && /^center$/.test(place[1] || place[0])) return true;
  if (/grid/.test(d)) {
    if (/^center$/.test(String(props["justify-items"] || ""))) return true;
    const pc = splitTop(String(props["place-content"] || ""), " ");
    if (pc.length && /^center$/.test(pc[1] || pc[0])) return true;
    return /^center$/.test(String(props["justify-content"] || ""));
  }
  if (/flex/.test(d)) {
    const column = /column/.test(String(props["flex-direction"] || props["flex-flow"] || ""));
    if (column) return /^center$/.test(String(props["align-items"] || ""));
    return /^(center|space-around|space-evenly)$/.test(String(props["justify-content"] || ""));
  }
  return false;
}

function isCenteredBlock(el) {
  if (/^center$/i.test(String(inherit(el, "text-align") || "").trim())) return true;
  let cur = el;
  while (cur.parent) {
    const props = cur.props;
    if (/^(absolute|fixed)$/.test(String(props.position || ""))) {
      const tf = String(props.transform || "") + " " + String(props.translate || "");
      if (/^50%$/.test(String(props.left || "").trim()) && /translate(?:x|3d)?\(\s*-50%|^\s*-50%/i.test(tf)) return true;
      return false;
    }
    if (centersChildren(cur.parent)) return !hasExplicitWidth(cur);
    if (hasExplicitWidth(cur)) return false;
    cur = cur.parent;
  }
  return false;
}

function sigOf(el) {
  return el.tag + "." + el.classes.slice().sort().join(".");
}

function unitRadius(u, M) {
  if (u.radius === undefined) {
    const v = u.map.get("border-radius");
    u.radius = v ? parseRadius(v, M.frame, null) : null;
  }
  return u.radius;
}

function elRadius(el, M) {
  if (el.rad === undefined) {
    const v = el.props["border-radius"];
    el.rad = v ? parseRadius(v, M.frame, fontSizePx(el, M)) : null;
  }
  return el.rad;
}
const radiusIsRound = (r) => Boolean(r) && ((r.px != null && r.px > 0.5) || r.pct > 0);

function elBorder(el, M) {
  if (el.border !== undefined) return el.border;
  const p = el.props;
  const all = p.border ? parseBorder(p.border, M.frame) : { w: 0, color: null };
  if (p["border-width"]) {
    const px = lengthPx(splitTop(p["border-width"], " ")[0], M.frame, 16);
    if (px != null) all.w = p["border-style"] || p.border ? px : all.w;
  }
  if (p["border-color"] && all.w) all.color = findColors(p["border-color"])[0] || all.color;
  const sides = {};
  for (const side of ["left", "right", "top", "bottom"]) sides[side] = p["border-" + side] ? parseBorder(p["border-" + side], M.frame) : null;
  el.border = { all, sides };
  return el.border;
}

function isBoxed(el, M) {
  if (el.boxed !== undefined) return el.boxed;
  const bg = backgroundOf(el.props, M);
  const border = elBorder(el, M);
  const visibleBg = (bg.solid && bg.solid.a >= 0.04) || bg.grads.length > 0;
  const visibleBorder = border.all.w > 0 && (!border.all.color || border.all.color.a > 0.04);
  el.boxed = Boolean(visibleBg || visibleBorder);
  return el.boxed;
}

// A card: a filled or outlined box with its own padding and an edge treatment.
function isCard(el, M) {
  if (el.card !== undefined) return el.card;
  el.card = false;
  if (el === M.doc.body || el === M.doc.root || el.inSvg || el.synthetic || !isBoxed(el, M) || isFullBleed(el)) return false;
  const p = el.props;
  // A frame pinned to all four sides is the page border, not a card.
  if (/^(absolute|fixed)$/.test(String(p.position || "")) && (p.inset != null || (p.top != null && p.bottom != null && p.left != null && p.right != null))) return false;
  const padded = p.padding != null ? !splitTop(p.padding, " ").every(isZero) : ["padding-left", "padding-top", "padding-inline", "padding-block"].some((k) => p[k] != null && !isZero(p[k]));
  const edged = radiusIsRound(elRadius(el, M)) || (p["box-shadow"] && p["box-shadow"] !== "none") || elBorder(el, M).all.w > 0;
  el.card = Boolean(padded && edged && hasText(el));
  return el.card;
}

// -------------------------------------------------------------------- unlocks

const NEG_WORDS = /\b(?:no|not|never|without|avoid\w*|don'?t|do not|dont|doesn'?t|isn'?t|aren'?t|won'?t|can'?t|stop|remove|removing|drop|skip|less|fewer|hate|dislike|tired of|sick of|instead of|rather than|anything but|get rid of|ban|banned|forbid\w*|rule out|nothing|too much|too many|replace|swap out|lose|ditch|tone down|reduce|kill)\b/g;
// What turns a sentence back to a request after a "no": "no gradients, just purple", "not centered but neon".
const AFFIRM_WORDS = /\bbut\b|\binstead\b(?! of)|,\s*(?:and\s+)?(?:make it|use|go with|i want|we want|i'd like|i would like|give it|give me|it should|switch to|change (?:it )?to|add|just|only)\b/;

// True when the words at `index` sit under a "no", "without", "avoid" in their own sentence.
function negatedAt(text, index) {
  let start = index;
  while (start > 0 && !/[.!?\n;]/.test(text[start - 1])) start -= 1;
  const clause = text.slice(start, index);
  NEG_WORDS.lastIndex = 0;
  let m, lastEnd = -1;
  while ((m = NEG_WORDS.exec(clause))) lastEnd = m.index + m[0].length;
  if (lastEnd < 0) return false;
  return !AFFIRM_WORDS.test(clause.slice(lastEnd));
}

function readAsked(asked) {
  const text = String(asked == null ? "" : asked).toLowerCase().replace(/[\u2018\u2019]/g, "'");
  const rules = new Set();
  if (text.trim()) {
    for (const [re, ids] of ASKED) {
      const g = new RegExp(re.source, "g");
      let m;
      while ((m = g.exec(text))) {
        if (!negatedAt(text, m.index)) {
          for (const id of ids) rules.add(id);
          break;
        }
        if (g.lastIndex === m.index) g.lastIndex += 1;
      }
    }
  }
  // A thing the person named themselves (a font, an emoji) is theirs to have.
  const names = (word) => {
    const w = String(word || "").toLowerCase();
    if (w.length < 2 || !text) return false;
    let at = text.indexOf(w);
    while (at >= 0) {
      const before = at > 0 ? text[at - 1] : " ";
      const after = text[at + w.length] || " ";
      if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after) && !negatedAt(text, at)) return true;
      at = text.indexOf(w, at + 1);
    }
    return false;
  };
  return { text, rules, names };
}

function makeGate(opts) {
  const allow = new Set((Array.isArray(opts.allow) ? opts.allow : typeof opts.allow === "string" ? [opts.allow] : []).map((s) => String(s).trim().toLowerCase()));
  const styleIds = [];
  for (const s of [opts.style].concat(Array.isArray(opts.styles) ? opts.styles : [])) {
    const id = String(s == null ? "" : s).trim().toLowerCase().replace(/^style-/, "");
    if (id && !styleIds.includes(id)) styleIds.push(id);
  }
  const styleRules = new Set();
  for (const id of styleIds) for (const r of STYLE_UNLOCKS[id] || []) styleRules.add(r);
  const asked = readAsked(opts.asked);
  const open = (id) => allow.has(id) || allow.has(RULE_BY_ID.get(id).group) || asked.rules.has(id);
  return {
    asked,
    styleIds,
    open, // the person or the caller switched it off
    off: (id) => open(id) || styleRules.has(id),
    byStyle: (id) => !open(id) && styleRules.has(id),
    limited: (id, sub) => !open(id) && styleRules.has(id + ":" + sub),
  };
}

// --------------------------------------------------------------------- shared

const MEDIA_OFF = /print|speech|prefers-reduced-motion|prefers-contrast|forced-colors|max-width|max-height|max-aspect-ratio|\bhover\b|prefers-color-scheme\s*:\s*light/i;

const tidy = (s) => String(s).replace(/\u0001/g, "?").replace(/[\u2014\u2013]/g, "-").replace(/\s+/g, " ").trim().replace(/^[a-z]/, (ch) => ch.toUpperCase());

function report(S, rule, what, fix, where) {
  if (S.found.has(rule)) return;
  S.found.set(rule, { rule, hard: RULE_BY_ID.get(rule).hard, what: tidy(what), fix: tidy(fix), where: String(where || "").trim() });
}

function bgOf(el, M) {
  if (el.bg === undefined) el.bg = backgroundOf(el.props, M);
  return el.bg;
}

function firstColor(value) {
  if (!value) return null;
  return findColors(value)[0] || null;
}

function isHidden(el) {
  for (let p = el; p; p = p.parent) if (/^none$/.test(String(p.props.display || "").trim())) return true;
  return false;
}

// The declarations that reach the frame. A :hover rule never does, a rule
// that matches nothing only matters when a script builds the page.
function liveUnits(M) {
  const used = new Set();
  const live = [];
  const maybe = [];
  for (const u of M.units) {
    if (u.state) continue;
    if (u.media && MEDIA_OFF.test(u.media)) continue;
    if (u.kf) {
      maybe.push(u);
      continue;
    }
    if (u.src === "css" && !u.els.length && !(u.pseudoHosts && u.pseudoHosts.length) && !M.hasJs) continue;
    live.push(u);
    for (const a of u.anims) used.add(a.name);
  }
  const jsNames = M.hasJs ? M.js.names : "";
  if (M.doc.all.length <= 2 && !M.hasJs) for (const u of M.units) if (u.src === "css" && !u.kf && !u.state && !(u.media && MEDIA_OFF.test(u.media)) && !live.includes(u)) {
    live.push(u);
    for (const a of u.anims) used.add(a.name);
  }
  for (const u of maybe) if (used.has(u.kfName) || (jsNames && jsNames.indexOf(u.kfName) >= 0)) live.push(u);
  M.usedKf = used;
  return live;
}

function collectTexts(S) {
  const M = S.M, out = [];
  for (const el of M.textEls) {
    if (el.tag === "title" || el.tag === "desc" || el.tag === "option" || el.tag === "template") continue;
    if (isHidden(el)) continue;
    const famText = inherit(el, "font-family");
    const fams = famText && famText.indexOf(UNKNOWN) < 0 ? parseFamilies(famText) : [];
    out.push({ el, block: blockOf(el), size: el.inSvg ? null : fontSizePx(el, M), weight: fontWeight(el), fams, fam: fams[0] || "", famKnown: !famText || famText.indexOf(UNKNOWN) < 0, text: el.text, svg: el.inSvg });
  }
  return out;
}

// Largest text size inside an element.
function treeSize(el, M) {
  if (el.ts !== undefined) return el.ts;
  let best = el.text && /[\p{L}\p{N}]/u.test(el.text) && !el.inSvg ? fontSizePx(el, M) || 0 : 0;
  for (const child of el.children) best = Math.max(best, treeSize(child, M));
  el.ts = best;
  return best;
}

function wordCount(text) {
  const m = String(text || "").match(/[\p{L}\p{N}][\p{L}\p{N}'\u2019.-]*/gu);
  return m ? m.length : 0;
}

const quote = (text, max) => '"' + short(String(text).replace(/"/g, "'"), max || 36) + '"';
const hexName = (c) => hexOf(c).toUpperCase();

// ------------------------------------------------------------------ gradients

function gradRecord(g, extra) {
  const vis = g.stops.filter((c) => c.a >= 0.3);
  let gap = 0, hue = 0;
  for (let i = 0; i < vis.length; i += 1) {
    for (let j = i + 1; j < vis.length; j += 1) {
      gap = Math.max(gap, colorGap(vis[i], vis[j]));
      if (isChromatic(vis[i]) && isChromatic(vis[j])) hue = Math.max(hue, hueGap(vis[i].h, vis[j].h));
    }
  }
  const clear = g.stops.some((c) => c.a < 0.05);
  const sized = Boolean(extra.size) && !/^\s*(cover|contain|auto|100%(\s+100%)?|100%\s+auto|auto\s+100%)\s*$/i.test(extra.size);
  let kind = "blend";
  if (g.repeating || ((g.hard || g.tiny) && sized)) kind = "pattern";
  else if (g.hard) kind = "shape";
  else if (clear || vis.length < 2) kind = "scrim";
  return Object.assign({ g, vis, gap, hue, clear, kind, u: null, where: "", page: false, text: false, els: [] }, extra);
}

function collectGradients(S) {
  const M = S.M, out = [];
  for (const u of S.live) {
    for (const prop of ["background", "background-image", "border-image", "border-image-source"]) {
      const v = u.map.get(prop);
      if (!v || v.indexOf("gradient(") < 0) continue;
      const first = u.els[0];
      const size = u.map.get("background-size") || (first && first.props["background-size"]) || "";
      let page = false, text = false;
      for (const el of u.els) {
        if (el === M.doc.body || el === M.doc.root || isFullBleed(el)) page = true;
        else if (!u.pseudoEl && hasText(el)) text = true;
      }
      if (u.pseudoEl && u.pseudoHosts) for (const el of u.pseudoHosts) if (el === M.doc.body || el === M.doc.root) page = true;
      for (const g of parseGradients(v)) out.push(gradRecord(g, { u, where: u.label, size, page, text, els: u.els, border: prop.startsWith("border") }));
    }
  }
  const svgIds = new Map();
  for (const el of M.doc.all) {
    if (el.tag !== "lineargradient" && el.tag !== "radialgradient") continue;
    const stops = [];
    for (const st of el.children) {
      if (st.tag !== "stop") continue;
      const v = st.props["stop-color"] || st.attrs["stop-color"];
      const c = v ? parseColor(resolveVars(v, M.vars, null)) : null;
      if (!c) continue;
      const op = st.props["stop-opacity"] != null ? Number(st.props["stop-opacity"]) : st.attrs["stop-opacity"] != null ? Number(st.attrs["stop-opacity"]) : 1;
      stops.push(Number.isFinite(op) && op < 1 ? makeColor(c.r, c.g, c.b, c.a * op) : c);
    }
    const rec = gradRecord({ type: el.tag === "lineargradient" ? "linear" : "radial", repeating: false, stops, hard: false, unknown: false, tiny: false, text: "<" + el.tag + ">" }, { where: "the SVG gradient" + (el.id ? " #" + el.id : ""), svg: true, id: el.id });
    if (el.id) svgIds.set(el.id, rec);
    out.push(rec);
  }
  for (const [key, list] of M.js.canvasGrads) {
    const stops = list.map((v) => parseColor(v)).filter(Boolean);
    out.push(gradRecord({ type: "linear", repeating: false, stops, hard: false, unknown: stops.length < list.length, tiny: false, text: "canvas gradient" }, { where: "the canvas gradient " + key, canvas: true, key }));
  }
  S.svgGrads = svgIds;
  return out;
}

function allColorsOf(S) {
  const out = [];
  for (const u of S.live) for (const value of u.map.values()) if (value && value.length < 2000) for (const c of findColors(value)) out.push(c);
  for (const c of S.M.js.looseColors) out.push(c);
  for (const list of S.M.js.canvasGrads.values()) for (const v of list) {
    const c = parseColor(v);
    if (c) out.push(c);
  }
  return out;
}

function checkGradients(S) {
  const M = S.M, gate = S.gate, grads = S.grads;
  const nearA = (c) => colorGap(c, DEFAULT_A) <= 0.05;
  const nearB = (c) => colorGap(c, DEFAULT_B) <= 0.05;
  const flagged = new Set();

  let hit = grads.find((r) => r.g.stops.some(nearA) && r.g.stops.some(nearB));
  if (!hit) {
    const makesGradient = grads.length > 0 || ["createLinearGradient", "createRadialGradient", "createConicGradient"].some((n) => M.js.idents.has(n));
    if (makesGradient) {
      const all = allColorsOf(S);
      if (all.some(nearA) && all.some(nearB)) hit = grads[0] || { where: "the script", g: { stops: [] } };
    }
  }
  if (hit) {
    flagged.add(hit);
    if (!gate.off("default-gradient")) report(S, "default-gradient", "The gradient on " + hit.where + " runs from #667EEA to #764BA2, the stock purple gradient of AI made pages.", "Replace it with one solid color taken from the subject, for example a deep green, a brick red or an ink blue.", hit.where);
  }

  for (const r of grads) {
    if (flagged.has(r)) continue;
    const chrom = r.vis.filter(isChromatic);
    if (chrom.length < 2 || !chrom.some(isPurple)) continue;
    if (!chrom.every((c) => hueBetween(c.h, 190, 20))) continue;
    let pair = null;
    for (const p of chrom) {
      if (!isPurple(p)) continue;
      for (const q of chrom) if (q !== p && colorGap(p, q) >= 0.06 && hueGap(p.h, q.h) >= 12 && (!pair || colorGap(p, q) > colorGap(pair[0], pair[1]))) pair = [p, q];
    }
    if (!pair) continue;
    flagged.add(r);
    if (!gate.off("purple-gradient")) {
      const other = isPurple(pair[1]) ? "purple" : isBlue(pair[1]) || isCyan(pair[1]) ? "blue" : isPink(pair[1]) ? "pink" : "purple";
      report(S, "purple-gradient", "The gradient on " + r.where + " blends purple " + hexName(pair[0]) + " into " + other + " " + hexName(pair[1]) + ", the default AI gradient.", "Use one solid color from the subject there. If the surface needs light, shade one hue from light to dark.", r.where);
    }
    break;
  }
  S.flaggedGrads = flagged;

  // Gradient text
  if (!gate.open("gradient-text")) {
    const hits = [];
    for (const u of S.live) {
      const clip = u.map.get("background-clip") || "";
      const bgText = u.map.get("background") || "";
      if (!/\btext\b/i.test(clip) && !/\btext\b/i.test(stripCalls(bgText))) continue;
      let has = unitBg(u).grads.length > 0;
      let picture = unitBg(u).url && !has;
      for (const el of u.els) {
        const b = bgOf(el, M);
        if (b.grads.length) has = true;
        else if (b.url) picture = true;
      }
      if (!has && !picture && grads.some((r) => !r.svg && !r.canvas)) has = true;
      if (has) hits.push({ where: u.label, n: Math.max(1, u.els.length) });
    }
    for (const el of M.doc.all) {
      if (el.tag !== "text" && el.tag !== "tspan" && el.tag !== "textpath") continue;
      const fill = String(inherit(el, "fill") || "");
      const m = /url\(\s*['"]?#([\w-]+)/.exec(fill);
      if (m && S.svgGrads.has(m[1]) && el.props.fill) hits.push({ where: "the SVG text" + (el.text ? " " + quote(el.text, 24) : ""), n: 1 });
    }
    if (M.js.idents.has("fillText")) {
      for (const key of M.js.canvasGrads.keys()) {
        if (!/^[\w$.]+$/.test(key)) continue;
        const re = new RegExp("fillStyle\\s*=\\s*" + key.replace(/[.$]/g, "\\$&") + "\\b(?:(?!fillStyle\\s*=)[\\s\\S]){0,400}?fillText\\s*\\(");
        if (re.test(M.js.names)) hits.push({ where: "the canvas text", n: 1 });
      }
    }
    const total = hits.reduce((sum, h) => sum + h.n, 0);
    if (hits.length && !(gate.limited("gradient-text", "once") && total <= 1)) {
      report(S, "gradient-text", "The text on " + hits[0].where + " is filled with a gradient (background-clip: text)" + (gate.limited("gradient-text", "once") ? ", and the synthwave style allows that on one word only." : "."), "Give the text one solid color, the accent or near white.", hits[0].where);
    }
  }

  // Gradient as a fill
  if (!gate.off("gradient-fill")) {
    const blends = grads.filter((r) => r.kind === "blend" && !flagged.has(r) && !r.border);
    let found = null, why = "";
    for (const r of blends) {
      if (r.gap < 0.08 || !(r.page || r.text)) continue;
      found = r;
      why = (r.hue >= 35 ? "blends two different hues and " : r.vis.some(isBlue) ? "is a blue gradient and " : "") + (r.page ? "fills the whole background" : "sits behind text as a fill");
      break;
    }
    if (!found) {
      const fills = blends.filter((r) => r.gap >= 0.05);
      const owners = new Set(fills.map((r) => r.u || r.where));
      if (owners.size >= 2) {
        found = fills[0];
        why = "is one of " + owners.size + " gradients on this design";
      } else if (grads.filter((r) => r.kind !== "pattern" && r.kind !== "shape" && !r.border).length >= 4) {
        found = blends[0] || grads[0];
        why = "is one of " + grads.length + " gradients on this design";
      }
    }
    if (found) report(S, "gradient-fill", "The gradient on " + found.where + " " + why + ".", "Use a solid color. Keep at most one gradient, and only to fake light on a real surface such as a sky.", found.where);
  }
}

// ---------------------------------------------------------------------- color

function checkColor(S) {
  const M = S.M, gate = S.gate;
  const page = pageBackground(M);

  if (!gate.off("purple-main")) {
    const pageStops = page && !page.color && page.grads.length ? page.grads[0].stops.filter((c) => c.a >= 0.3 && isChromatic(c)) : [];
    if (pageStops.length && pageStops.every(isPurple)) {
      report(S, "purple-main", "The whole background (" + page.where + ") is purple, " + hexName(pageStops[0]) + " shading into " + hexName(pageStops[pageStops.length - 1]) + ".", "Take the main color from the subject instead, for example tomato red for cooking or pitch green for sport.", page.where);
    } else if (page && page.color && isPurple(page.color)) {
      report(S, "purple-main", "The whole background (" + page.where + ") is purple " + hexName(page.color) + ".", "Take the main color from the subject instead, for example tomato red for cooking or pitch green for sport.", page.where);
    } else {
      let purple = 0, total = 0, sample = null, where = "";
      const add = (c, w, at) => {
        if (!c || c.a < 0.3 || !isChromatic(c)) return;
        total += w;
        if (isPurple(c)) {
          purple += w;
          if (!sample) {
            sample = c;
            where = at;
          }
        }
      };
      for (const el of M.doc.all) {
        if (!el.units) continue;
        const p = el.props, at = labelOf(el);
        const bg = bgOf(el, M);
        if (bg.solid) add(bg.solid, el === M.doc.body || isFullBleed(el) ? 3 : 2, at);
        if (p.color && hasText(el)) add(firstColor(p.color), 2, at);
        const b = elBorder(el, M);
        if (b.all.w > 0) add(b.all.color, 1, at);
        for (const side of ["left", "right", "top", "bottom"]) if (b.sides[side] && b.sides[side].w > 0) add(b.sides[side].color, 1, at);
        if (el.inSvg) {
          add(firstColor(p.fill), 1, at);
          add(firstColor(p.stroke), 1, at);
        }
      }
      for (const r of S.grads) {
        if (r.kind === "pattern") continue;
        const chrom = r.vis.filter(isChromatic);
        for (const c of chrom) add(c, 2 / chrom.length, r.where);
      }
      for (const u of S.live) {
        if (u.src !== "js" && !(u.src === "css" && !u.els.length && !u.kf)) continue;
        for (const prop of ["background", "background-color", "color", "fill"]) {
          const v = u.map.get(prop);
          if (v) add(firstColor(stripCalls(v)), 2, u.label);
        }
      }
      if (purple >= 3 && purple / total >= 0.5) report(S, "purple-main", "Purple " + hexName(sample) + " on " + where + " is the main color of this design.", "Take the main color from the subject instead, for example tomato red for cooking or pitch green for sport.", where);
    }
  }

  if (!gate.off("neon-on-dark")) {
    let hit = null;
    const shadowColors = (p, list) => {
      for (const prop of ["box-shadow", "text-shadow"]) if (p[prop] && p[prop] !== "none") for (const c of findColors(p[prop])) list.push(c);
    };
    for (const el of M.doc.all) {
      if (!el.units || hit) continue;
      const p = el.props, cands = [];
      if (p.color && hasText(el)) cands.push(firstColor(p.color));
      const b = elBorder(el, M);
      if (b.all.w > 0 && b.all.color) cands.push(b.all.color);
      for (const side of ["left", "right", "top", "bottom"]) if (b.sides[side] && b.sides[side].w > 0 && b.sides[side].color) cands.push(b.sides[side].color);
      if (el.inSvg) cands.push(firstColor(p.fill), firstColor(p.stroke));
      shadowColors(p, cands);
      const neon = cands.find((c) => c && isNeon(c));
      if (neon) {
        const back = backdropOf(el, M);
        if (back && isNearBlack(back)) hit = { c: neon, where: labelOf(el), back };
      }
      if (!hit && el.parent && !isFullBleed(el) && el !== M.doc.body) {
        const bg = bgOf(el, M);
        if (bg.solid && isNeon(bg.solid)) {
          const back = backdropOf(el.parent, M);
          if (back && isNearBlack(back)) hit = { c: bg.solid, where: labelOf(el), back };
        }
      }
    }
    if (!hit && page && page.color && isNearBlack(page.color)) {
      for (const u of S.live) {
        if (hit) break;
        if (u.src !== "js" && !(u.src === "css" && !u.els.length && !u.kf)) continue;
        for (const prop of ["color", "background", "background-color", "fill", "stroke", "border", "border-color", "box-shadow", "text-shadow", "canvas-shadow-color"]) {
          const v = u.map.get(prop);
          const neon = v ? findColors(stripCalls(v)).find(isNeon) : null;
          if (neon) {
            hit = { c: neon, where: u.label, back: page.color };
            break;
          }
        }
      }
    }
    if (hit) report(S, "neon-on-dark", "Neon " + hexName(hit.c) + " on " + hit.where + " sits on near black " + hexName(hit.back) + ".", "Pick an accent from the subject at lower brightness, or lift the background off black. Neon on black is for the neon and synthwave styles.", hit.where);
  }

  if (!gate.open("glow")) {
    const hits = S.glow;
    const total = hits.reduce((sum, h) => sum + h.n, 0);
    if (hits.length && !(gate.byStyle("glow") && total <= 2)) {
      report(S, "glow", "A glow shadow is set on " + hits[0].where + " (" + short(hits[0].text, 44) + ")" + (gate.byStyle("glow") ? ", and " + total + " elements glow where the style allows two." : "."), "Remove the glow. For lift use a hard offset shadow with no blur, or a solid plate behind the type.", hits[0].where);
    }
  }

  if (!gate.off("gray-on-color")) {
    for (const t of S.texts) {
      const c = firstColor(inherit(t.el, "color"));
      if (!c || !isGray(c)) continue;
      const back = backdropOf(t.el, M);
      if (back && back.C >= 0.08 && back.L >= 0.25) {
        report(S, "gray-on-color", "The gray text " + quote(t.text, 28) + " (" + hexName(c) + ") sits on a colored plate (" + hexName(back) + ").", "Use a light or dark shade of the plate's own hue, or near white.", labelOf(t.el));
        break;
      }
    }
  }

  if (!gate.off("cream-default") && page && page.color && isCream(page.color) && S.headline) {
    const h = S.headline;
    if (h.fam && isSerifKey(h.fam) && isCenteredBlock(h.block)) report(S, "cream-default", "A cream page (" + hexName(page.color) + ") with a centered serif headline is the second most common AI default after dark mode.", "Take the background from the subject, or keep the cream and set the headline left in a heavy sans such as Bahnschrift or \"Segoe UI Black\".", page.where);
  }
}

// ----------------------------------------------------------------------- type

function checkType(S) {
  const M = S.M, gate = S.gate, texts = S.texts;
  const frameMin = Math.min(M.frame.W, M.frame.H);

  // Fonts that are not on the computer, and Office fonts with nothing behind them.
  for (const u of S.live) {
    const v = u.map.get("font-family");
    if (!v) continue;
    const raw = splitTop(v, ",");
    const fams = raw.map(fontKey).filter(Boolean);
    const first = fams[0];
    if (!first || first.indexOf(UNKNOWN) >= 0 || CSS_WIDE.has(first) || /^var\(/.test(first)) continue;
    const kind = fontKind(first, M.extraFonts);
    const shown = String(raw[0]).trim().replace(/^['"]|['"]$/g, "");
    if (kind === "web" || kind === "unknown") {
      if (gate.off("font-missing") || gate.asked.names(first)) continue;
      const cls = fontClass(first);
      report(S, "font-missing", "The font " + shown + " on " + u.label + " is not on this computer. The page has no network, so the text falls back to a default face.", "Use " + (FONT_FIX[cls] || FONT_FIX.unknown) + ".", u.label);
    } else if (kind === "office" && !gate.off("font-no-fallback")) {
      const rest = fams.slice(1);
      if (!rest.some((k) => GENERIC_FONTS.has(k) || SYSTEM_FONTS.has(k) || fontKind(k, M.extraFonts) === "installed")) {
        report(S, "font-no-fallback", "The font " + shown + " on " + u.label + " comes with Office, and the stack has no Windows font and no generic family after it.", "Add a fallback and a generic family, for example " + shown + ", " + (isSerifKey(first) ? "Georgia, serif" : "\"Segoe UI\", sans-serif") + ".", u.label);
      }
    }
  }

  if (!texts.length) return;
  const sized = texts.filter((t) => t.size != null);
  const headline = S.headline;

  if (!gate.off("font-default")) {
    const kinds = texts.map((t) => (!t.famKnown ? "other" : !t.fam ? "none" : fontKind(t.fam, M.extraFonts)));
    if (kinds.every((k) => k === "none" || k === "system" || k === "generic")) {
      const named = texts.find((t) => t.fam);
      report(S, "font-default", named ? "All the text is set in " + named.fam + ", the default system font." : "No font is set, so all the text uses the default system font.", "Pair a display face for the headline with a plainer text face, for example \"Segoe UI Black\", Impact, sans-serif over Corbel, \"Segoe UI\", sans-serif.", named ? labelOf(named.el) : "body");
    } else {
      const fams = new Set(texts.map((t) => t.fam)), weights = new Set(texts.map((t) => Math.round(t.weight / 100)));
      const sizes = sized.map((t) => t.size);
      const blocks = new Set(texts.map((t) => t.block));
      if (fams.size === 1 && weights.size === 1 && blocks.size >= 2 && sizes.length >= 2 && Math.max(...sizes) / Math.min(...sizes) >= 1.3 && kinds[0] !== "other" && !gate.asked.names(texts[0].fam)) {
        report(S, "font-default", "Every line is " + (texts[0].fam || "one font") + " at weight " + texts[0].weight + ", the headline and the support lines alike.", "Give the headline its own display face or a much heavier weight, and keep a plainer face for the support lines.", labelOf(texts[0].el));
      }
    }
  }

  if (!gate.off("type-scale") && sized.length >= 2) {
    const sizes = [];
    for (const t of sized.slice().sort((a, b) => b.size - a.size)) if (!sizes.length || sizes[sizes.length - 1] / t.size > 1.04) sizes.push(t.size);
    const px = (n) => Math.round(n) + "px";
    let run = 1, runAt = -1;
    for (let i = 1; i < sizes.length; i += 1) {
      if (sizes[i - 1] / sizes[i] < 1.25) {
        run += 1;
        if (run >= 4) runAt = i;
      } else run = 1;
    }
    if (runAt >= 0) report(S, "type-scale", "The text sizes " + sizes.slice(runAt - 3, runAt + 1).map(px).join(", ") + " sit in a row with no clear step.", "Use three sizes at most, with the headline at least twice the support line.", "");
    else if (sizes.length >= 2 && sizes[0] / sizes[sizes.length - 1] < 1.4 && new Set(sized.map((t) => t.block)).size >= 3) report(S, "type-scale", "The largest text is " + px(sizes[0]) + " and the smallest is " + px(sizes[sizes.length - 1]) + ", too close to read as headline and support.", "Make the headline at least twice the size of the support line.", headline ? labelOf(headline.el) : "");
  }

  if (!gate.off("tracking")) {
    for (const t of sized) {
      let owner = t.el;
      while (owner && (owner.props["letter-spacing"] == null || owner.props["letter-spacing"] === "inherit")) owner = owner.parent;
      if (!owner) continue;
      const value = String(owner.props["letter-spacing"]).trim();
      if (/^(normal|0)$/.test(value)) continue;
      const px = lengthPx(value, M.frame, fontSizePx(owner, M));
      if (px == null || !t.size) continue;
      const ratio = px / t.size;
      const where = labelOf(t.el);
      if (ratio >= 0.18 && isUpper(t.el)) {
        report(S, "tracking", "The caps label " + quote(t.text, 28) + " on " + where + " is tracked out to " + ratio.toFixed(2) + "em.", "Set letter-spacing to 0.04em at most on caps.", where);
        break;
      }
      if (ratio < -0.051 && t.size >= 40) {
        report(S, "tracking", "The display text " + quote(t.text, 28) + " on " + where + " is crushed with letter-spacing " + ratio.toFixed(2) + "em.", "Keep negative letter-spacing on display type to -0.03em or less tight.", where);
        break;
      }
    }
  }

  if (!gate.off("eyebrow") && headline) {
    for (const t of sized) {
      const e = t.block;
      if (e === headline.block || !e.parent || t.size > headline.size / 2) continue;
      if (wordCount(allText(e)) > 4 || /\d/.test(allText(e))) continue;
      const spaced = (() => {
        const v = inherit(t.el, "letter-spacing");
        const px = v ? lengthPx(v, M.frame, t.size) : null;
        return px != null && px / t.size >= 0.08;
      })();
      if (!isUpper(t.el) && !spaced) continue;
      // The headline is the next thing after it.
      let next = e.parent.children[e.index + 1];
      if (!next && e.parent.parent && e.parent.children.length === 1) next = e.parent.parent.children[e.parent.index + 1];
      if (!next || !(next === headline.block || treeSize(next, M) >= headline.size * 0.99)) continue;
      if (/^(absolute|fixed)$/.test(String(e.props.position || ""))) {
        // Placed by hand: an eyebrow only when it sits tight on the headline.
        const a = e.props.top != null ? lengthPx(e.props.top, M.frame, t.size) : null;
        const b = next.props.top != null ? lengthPx(next.props.top, M.frame, headline.size) : null;
        if (a == null || b == null || b - a - t.size > headline.size) continue;
      }
      report(S, "eyebrow", "The small label " + quote(allText(e), 28) + " sits above the headline and adds no fact.", "Delete it, or make it carry a fact such as a date or an episode number.", labelOf(e));
      break;
    }
  }

  if (!gate.off("italic-serif-hero") && headline) {
    for (const t of sized) {
      if (t.size < headline.size * 0.9 || !t.fam || !isSerifKey(t.fam)) continue;
      let italic = false;
      for (let p = t.el; p; p = p.parent) {
        const fs = p.props["font-style"];
        if (fs != null && fs !== "inherit") {
          italic = /italic|oblique/.test(fs);
          break;
        }
        if (p.tag === "em" || p.tag === "i" || p.tag === "cite") {
          italic = true;
          break;
        }
      }
      if (!italic) continue;
      report(S, "italic-serif-hero", "The headline " + quote(t.text, 28) + " is set in italic serif (" + t.fam + ").", "Set the headline upright. Bold Georgia or Constantia, or a heavy sans such as Bahnschrift, reads as a choice.", labelOf(t.el));
      break;
    }
  }

  if (!gate.off("icon-tile")) {
    for (const el of M.doc.all) {
      if (!el.units || el.inSvg || !el.parent || el === M.doc.body) continue;
      const p = el.props;
      if (!p.width || !p.height || !isBoxed(el, M) || !radiusIsRound(elRadius(el, M))) continue;
      const w = lengthPx(p.width, M.frame, fontSizePx(el, M)), h = lengthPx(p.height, M.frame, fontSizePx(el, M));
      if (w == null || h == null || w > frameMin * 0.2 || h > frameMin * 0.2 || w < 12 || Math.abs(w - h) > Math.max(w, h) * 0.2) continue;
      const inner = allText(el);
      const holdsIcon = el.children.some((c) => c.tag === "svg" || c.tag === "img" || c.tag === "i") || (inner && [...inner].length <= 2) || (!inner && el.children.length > 0);
      if (!holdsIcon) continue;
      const parentRow = /flex/.test(String(el.parent.props.display || "")) && !/column/.test(String(el.parent.props["flex-direction"] || el.parent.props["flex-flow"] || ""));
      if (parentRow) continue;
      const next = el.parent.children[el.index + 1];
      if (!next || !hasText(next)) continue;
      report(S, "icon-tile", "An icon in a rounded tile (" + labelOf(el) + ") sits above the heading " + quote(allText(next), 24) + ".", "Drop the tile. Lead with the heading, or use one large drawn shape that belongs to the subject.", labelOf(el));
      break;
    }
  }

  if (!gate.off("text-tiny") && frameMin >= 700) {
    const limit = Math.max(16, frameMin * 0.0165);
    // A design whose largest type stays under the video floor is small text
    // through and through: a lone caption at web size, or copy set like a
    // page. The per-element limit under it is for one line of fine print.
    const top = sized.length ? sized.reduce((m, t) => (t.size > m.size ? t : m), sized[0]) : null;
    if (top && top.size < frameMin * 0.025) {
      report(S, "text-tiny", "The largest text on the frame is " + Math.round(top.size) + "px on a " + M.frame.W + " by " + M.frame.H + " frame; every line is a web page size that is too small for video.", "Set the headline at " + Math.round(frameMin * 0.05) + "px or more and support text at " + Math.round(frameMin * 0.03) + "px or more.", labelOf(top.el));
    } else {
      for (const t of sized) {
        if (t.size > limit || [...t.text.replace(/\s/g, "")].length < 3) continue;
        report(S, "text-tiny", "The text " + quote(t.text, 28) + " is " + Math.round(t.size) + "px on a " + M.frame.W + " by " + M.frame.H + " frame, a web page size that is too small for video.", "Set support text at " + Math.round(frameMin * 0.03) + "px or more, or cut the line.", labelOf(t.el));
        break;
      }
    }
  }

  if (!gate.off("weight-soup")) {
    const weights = [...new Set(texts.map((t) => Math.round(t.weight / 100) * 100))].sort((a, b) => a - b);
    if (weights.length >= 4) report(S, "weight-soup", "The text uses " + weights.length + " font weights (" + weights.join(", ") + ").", "Keep two weights: one heavy for the headline and one regular for the rest.", "");
  }
}

// --------------------------------------------------------------------- layout

// How many columns a container lays its children in. 1: stacked.
function rowTracks(p) {
  const props = p.props;
  const d = String(props.display || "");
  if (/flex/.test(d)) return /column/.test(String(props["flex-direction"] || props["flex-flow"] || "")) ? 1 : 99;
  if (/grid/.test(d)) {
    const cols = String(props["grid-template-columns"] || "");
    const rep = /repeat\(\s*(\d+)/.exec(cols);
    if (rep) return Number(rep[1]);
    if (/repeat\(\s*auto-(fit|fill)/.test(cols)) return 99;
    if (cols && cols !== "none") return splitTop(cols, " ").length;
    return /column/.test(String(props["grid-auto-flow"] || "")) ? 99 : 1;
  }
  const first = p.children[0];
  if (first && (/inline-block|inline-flex/.test(String(first.props.display || "")) || /left|right/.test(String(first.props.float || "")))) return 99;
  return 1;
}

const NUMBER_TEXT = /^[~<>+\-$\u20AC\u00A3#]?\d[\d.,:\s]*(?:%|[kmb]|x|\+|ms|s|h|hrs?|min|\u00B0|pts?|px|gb|mb|fps)?\+?$/i;

function animsOf(props) {
  if (!props) return [];
  const anims = parseAnimation(props.animation);
  const names = props["animation-name"];
  if (names && !anims.length) for (const n of splitTop(names, ",")) if (n && n !== "none") anims.push({ name: n.replace(/^['"]|['"]$/g, ""), dur: null, delay: null, timing: "", iter: 1, dir: "", delayText: "" });
  const pick = (prop, apply) => {
    const v = props[prop];
    if (!v) return;
    const list = splitTop(v, ",");
    anims.forEach((a, i) => apply(a, list[i % list.length].toLowerCase()));
  };
  pick("animation-duration", (a, v) => (a.dur = timeMs(v)));
  pick("animation-delay", (a, v) => {
    a.delay = timeMs(v) == null ? 0 : timeMs(v);
    a.delayText = v;
  });
  pick("animation-timing-function", (a, v) => (a.timing = v));
  pick("animation-iteration-count", (a, v) => (a.iter = v === "infinite" ? Infinity : Number(v) || 1));
  pick("animation-direction", (a, v) => (a.dir = v));
  return anims;
}

function elAnims(el) {
  if (el.anims === undefined) el.anims = animsOf(el.props);
  return el.anims;
}

// Marks el.dot on small round filled elements that keep animating.
function findPulsingDots(S) {
  const M = S.M, out = [];
  const limit = Math.max(48, Math.min(M.frame.W, M.frame.H) * 0.04);
  for (const el of M.doc.all) {
    if (!el.units || el.inSvg || el.children.length || hasText(el)) continue;
    const p = el.props;
    if (!p.width || !p.height) continue;
    const w = lengthPx(p.width, M.frame, fontSizePx(el, M)), h = lengthPx(p.height, M.frame, fontSizePx(el, M));
    if (w == null || h == null || w > limit || h > limit || Math.abs(w - h) > 2) continue;
    const r = elRadius(el, M);
    if (!r || !(r.pct >= 50 || (r.px != null && r.px >= Math.min(w, h) / 2 - 0.5))) continue;
    if (!isBoxed(el, M)) continue;
    const anims = elAnims(el).concat(el.pseudo ? animsOf(el.pseudo.before).concat(animsOf(el.pseudo.after)) : []);
    if (!anims.some((a) => a.iter === Infinity || a.iter >= 3)) continue;
    el.dot = true;
    out.push(el);
  }
  return out;
}

function checkLayout(S) {
  const M = S.M, gate = S.gate;

  if (!gate.off("centered")) {
    const blocks = [...new Set(S.texts.filter((t) => !t.svg).map((t) => t.block))];
    const centered = blocks.filter(isCenteredBlock);
    const para = centered.find((b) => wordCount(allText(b)) >= 16);
    let lower = null;
    for (const el of M.doc.all) {
      if (!el.units || el.inSvg || lower) continue;
      const p = el.props;
      if (!/^(absolute|fixed)$/.test(String(p.position || "")) || p.bottom == null || /^auto$/.test(String(p.bottom)) || (p.top != null && !/^auto$/.test(String(p.top))) || isFullBleed(el)) continue;
      const bottom = /%$/.test(String(p.bottom)) ? (parseFloat(p.bottom) / 100) * M.frame.H : lengthPx(p.bottom, M.frame, 16);
      if (bottom == null || bottom > M.frame.H * 0.3 || !hasText(el)) continue;
      const inner = S.texts.find((t) => {
        for (let q = t.el; q; q = q.parent) if (q === el) return true;
        return false;
      });
      if (inner && isCenteredBlock(inner.block)) lower = el;
    }
    const allCentered = blocks.length > 0 && centered.length === blocks.length;
    // A centered title card is allowed for a hook or an end card: a headline and up to two short lines.
    const stat = allCentered && S.headline && NUMBER_TEXT.test(S.headline.text.trim()) && blocks.length >= 2 ? S.headline : null;
    if (blocks.length >= 4 && allCentered) report(S, "centered", "All " + blocks.length + " text blocks are centered.", "Align the headline and the lines under it to one left edge, or keep the headline centered and move the rest to a corner.", labelOf(blocks[0]));
    else if (stat) report(S, "centered", "The stat " + quote(stat.text, 16) + " and its label are centered.", "Set the number on the left edge with its label beside or under it.", labelOf(stat.el));
    else if (para) report(S, "centered", "The paragraph " + quote(allText(para), 32) + " is centered across " + wordCount(allText(para)) + " words.", "Set it left aligned with a fixed width, or cut it to one short line.", labelOf(para));
    else if (lower) report(S, "centered", "The lower third " + labelOf(lower) + " is centered at the bottom of the frame.", "Anchor it to the bottom left with a fixed margin.", labelOf(lower));
  }

  // Rows of equal things.
  const wantBoxes = !gate.off("equal-boxes"), wantStats = !gate.off("stat-row");
  if (wantBoxes || wantStats) {
    for (const parent of M.doc.all) {
      if (parent.children.length < 3 || parent.inSvg) continue;
      if (S.found.has("equal-boxes") && S.found.has("stat-row")) break;
      const groups = new Map();
      for (const child of parent.children) {
        if (child.synthetic || isHidden(child)) continue;
        const sig = child.tag + "." + (child.classes[0] || "");
        (groups.get(sig) || groups.set(sig, []).get(sig)).push(child);
      }
      for (const group of groups.values()) {
        if (group.length < 3 || rowTracks(parent) < 3) continue;
        // A bar chart or a timeline sizes its columns from the markup.
        const varies = group.some((box) => {
          const bar = box.children.some((c) => !c.children.length && !hasText(c));
          return [box].concat(box.children).some((el) => el.inline && el.inline.some((d) => /^(height|width|flex|flex-grow|flex-basis|transform)$/.test(d.prop) || (bar && d.prop.startsWith("--"))));
        });
        if (varies) continue;
        // Stats: a short number over a smaller label, three times or more.
        let stats = 0;
        for (const box of group) {
          const inner = S.texts.filter((t) => {
            for (let q = t.el; q; q = q.parent) if (q === box) return true;
            return false;
          });
          // A year or a clock time is a date on a timeline, not a stat.
          const num = inner.find((t) => NUMBER_TEXT.test(t.text.trim()) && [...t.text.trim()].length <= 9 && !/^(1[5-9]|20)[0-9][0-9]$|[0-9]:[0-9]/.test(t.text.trim()) && t.el.tag !== "time");
          if (num && num.size && inner.some((t) => t !== num && t.size && t.size <= num.size / 1.5 && /\p{L}/u.test(t.text))) stats += 1;
        }
        if (stats >= 3) {
          if (wantStats) report(S, "stat-row", "A row of " + stats + " big numbers with small labels sits in " + labelOf(parent) + ".", "Show the one number that matters at full size and say the rest in a sentence.", labelOf(parent));
          continue;
        }
        if (!wantBoxes) continue;
        const shape = (box) => box.children.filter((c) => !c.synthetic).map((c) => c.tag).join(",");
        const first = shape(group[0]);
        if (group[0].children.length < 2 || !group.every((box) => shape(box) === first && hasText(box) && box.children.filter(hasText).length >= 1)) continue;
        // Boxes, or columns built as icon, heading, line. Plain two line columns (a timeline, a legend) pass.
        const built = (box) => isBoxed(box, M) || box.children.length >= 3 || box.children.some((c) => c.tag === "svg" || c.tag === "img" || (!c.children.length && !hasText(c)));
        if (!group.every(built)) continue;
        report(S, "equal-boxes", group.length + " equal boxes (" + labelOf(group[0]) + ") sit side by side in " + labelOf(parent) + ", each built the same way.", "Make one of them bigger, or set them as a plain list, or show only one.", labelOf(parent));
      }
    }
  }

  if (!gate.off("card-in-card")) {
    for (const el of M.doc.all) {
      if (!isCard(el, M) || el.children.filter(hasText).length < 2) continue;
      let outer = null;
      for (let p = el.parent; p; p = p.parent) if (isCard(p, M)) {
        outer = p;
        break;
      }
      if (!outer) continue;
      report(S, "card-in-card", "The box " + labelOf(el) + " sits inside another box (" + labelOf(outer) + ").", "Keep one box. Split the inside with spacing and a thin rule.", labelOf(el));
      break;
    }
  }

  if (!gate.off("pulsing-dot") && S.dots.length) report(S, "pulsing-dot", "The dot " + labelOf(S.dots[0]) + " pulses on a loop as decoration.", "Delete the dot, or keep it still.", labelOf(S.dots[0]));

  if (!gate.off("numbered-markers")) {
    const marks = new Set();
    let first = null;
    for (const t of S.texts) {
      const m = /^0([1-9])[.):/]?$/.exec(t.text.trim());
      if (!m) continue;
      marks.add(m[1]);
      if (!first) first = t;
    }
    const counter = S.live.find((u) => /decimal-leading-zero/.test(u.map.get("content") || "") || /decimal-leading-zero/.test(u.map.get("list-style-type") || u.map.get("list-style") || ""));
    if (marks.has("1") && marks.has("2")) report(S, "numbered-markers", "The items are marked 01, 02" + (marks.has("3") ? ", 03" : "") + ".", "Drop the numbers unless the order is the point. If it is, use plain 1, 2, 3 in the text face.", labelOf(first.el));
    else if (counter) report(S, "numbered-markers", "The style rule " + counter.label + " numbers the items 01, 02, 03 with a counter.", "Drop the numbers unless the order is the point.", counter.label);
  }
}

// ---------------------------------------------------------- shape and surface

function padTop(el, M) {
  const p = el.props;
  const v = p["padding-top"] || p["padding-block"] || (p.padding ? splitTop(p.padding, " ")[0] : null);
  return v ? lengthPx(v, M.frame, fontSizePx(el, M)) || 0 : 0;
}

function checkShape(S) {
  const M = S.M, gate = S.gate;

  if (!gate.off("radius")) {
    const bigs = [], pills = [], radii = new Set();
    for (const el of M.doc.all) {
      if (!el.units || el.inSvg || el === M.doc.body || el === M.doc.root) continue;
      const r = elRadius(el, M);
      if (!radiusIsRound(r)) continue;
      const p = el.props;
      const picture = el.tag === "img" || el.tag === "video" || el.tag === "canvas";
      if (!isBoxed(el, M) && !picture && !/hidden|clip/.test(String(p.overflow || ""))) continue;
      const fs = fontSizePx(el, M);
      const w = p.width ? lengthPx(p.width, M.frame, fs) : null;
      let h = p.height ? lengthPx(p.height, M.frame, fs) : null;
      const texty = hasText(el);
      if (h == null && texty && fs && wordCount(allText(el)) <= 6 && el.children.every(isInline)) h = fs * 1.3 + 2 * padTop(el, M);
      const half = h != null ? h / 2 : null;
      const circle = (w != null && h != null && p.height && Math.abs(w - h) <= Math.max(w, h) * 0.1 && (r.pct >= 50 || (r.px != null && r.px >= Math.min(w, h) / 2 - 0.5))) || (r.pct >= 50 && !texty);
      if (circle) continue;
      const pill = texty && ((r.px != null && r.px >= 500) || r.pct >= 50 || (half != null && r.px != null && r.px >= half - 0.5));
      if (pill) {
        pills.push(el);
        continue;
      }
      if (!texty && (r.px == null || r.px >= 500 || (half != null && r.px >= half - 0.5))) continue; // a bar with round ends
      if (r.px == null) continue;
      radii.add(Math.round(r.px));
      if (r.px >= 24) bigs.push({ el, px: r.px });
    }
    if (bigs.length >= 2) report(S, "radius", bigs.length + " boxes have a corner radius of 24px or more (" + labelOf(bigs[0].el) + " is " + Math.round(bigs[0].px) + "px).", "Use one small radius, 4 to 12px, for every box. Square corners are fine too.", labelOf(bigs[0].el));
    else if (pills.length >= 2) report(S, "radius", pills.length + " elements are pill shaped (" + labelOf(pills[0]) + ", " + labelOf(pills[1]) + ").", "Keep the full pill for one button or tag and give the rest a 4 to 12px radius.", labelOf(pills[0]));
    else if (radii.size >= 4) report(S, "radius", "The boxes use " + radii.size + " different corner radii (" + [...radii].sort((a, b) => a - b).join(", ") + "px).", "Pick one radius, 4 to 12px, and use it on every box.", "");
  }

  if (!gate.off("side-stripe")) {
    let hit = null;
    for (const el of M.doc.all) {
      if (hit) break;
      if (!el.units || el.inSvg) continue;
      const r = elRadius(el, M);
      const round = radiusIsRound(r) && (r.pct > 0 || r.px >= 3);
      if (!round) continue;
      const b = elBorder(el, M);
      for (const side of ["left", "right", "top", "bottom"]) {
        const s = b.sides[side];
        if (s && s.w >= 3 && s.w > b.all.w + 1.5 && (!s.color || s.color.a > 0.2)) hit = { el, how: "a " + Math.round(s.w) + "px border on the " + side };
      }
      if (hit) break;
      for (const s of parseShadows(el.props["box-shadow"], M.frame, fontSizePx(el, M))) {
        if (s.inset && s.blur === 0 && s.spread === 0 && ((Math.abs(s.x) >= 3 && s.y === 0) || (Math.abs(s.y) >= 3 && s.x === 0)) && s.color && s.color.a > 0.2) hit = { el, how: "an inset bar on one side" };
      }
      if (hit || !isBoxed(el, M)) continue;
      const isBar = (props, fs) => {
        if (!props) return false;
        const bg = backgroundOf(props, M);
        if (!bg.solid && !bg.grads.length) return false;
        const w = props.width ? lengthPx(props.width, M.frame, fs) : props["flex-basis"] ? lengthPx(props["flex-basis"], M.frame, fs) : /^0 0 /.test(String(props.flex || "")) ? lengthPx(String(props.flex).split(/\s+/)[2], M.frame, fs) : null;
        return w != null && w >= 3 && w <= Math.max(16, M.frame.W * 0.012);
      };
      const fs = fontSizePx(el, M);
      if (el.pseudo) for (const name of ["before", "after"]) {
        const pp = el.pseudo[name];
        if (pp && /^(absolute)$/.test(String(pp.position || "")) && isBar(pp, fs) && (isZero(pp.top) || isZero(pp.bottom) || /^100%$/.test(String(pp.height || "")) || (pp.inset != null))) hit = { el, how: "a colored bar drawn with ::" + name };
      }
      if (hit) break;
      const kids = el.children.filter((c) => !c.synthetic);
      for (const kid of [kids[0], kids[kids.length - 1]]) {
        if (kid && kids.length >= 2 && !kid.children.length && !hasText(kid) && isBar(kid.props, fs)) hit = { el, how: "a colored bar (" + labelOf(kid) + ") down one side" };
      }
    }
    if (hit) report(S, "side-stripe", "The rounded box " + labelOf(hit.el) + " has " + hit.how + ".", "Pick one: a square plate with the bar, or rounded corners with no bar.", labelOf(hit.el));
  }

  const shadowed = [];
  let hairline = null;
  for (const el of M.doc.all) {
    if (!el.units || el.inSvg) continue;
    const p = el.props;
    let soft = false, any = false;
    if (p["box-shadow"] && p["box-shadow"] !== "none") {
      for (const s of parseShadows(p["box-shadow"], M.frame, fontSizePx(el, M))) {
        if (s.inset || (s.color && s.color.a < 0.04)) continue;
        if (s.blur > 0 || s.x !== 0 || s.y !== 0 || s.spread > 0) any = true;
        if (s.blur >= 20) soft = true;
      }
    }
    if (p.filter && p.filter.indexOf("drop-shadow") >= 0 && !hasText(el)) any = true;
    if (any) shadowed.push(el);
    if (soft && !hairline) {
      const b = elBorder(el, M).all;
      if (b.w > 0 && b.w <= 1.5 && (!b.color || b.color.a > 0.04)) hairline = el;
    }
  }
  S.softShadows = shadowed.length;
  if (hairline && !gate.off("hairline-shadow")) report(S, "hairline-shadow", "The box " + labelOf(hairline) + " has both a hairline border and a soft wide shadow.", "Pick one: the edge or the shadow.", labelOf(hairline));
  if (shadowed.length >= 3 && !gate.off("shadow-everywhere")) report(S, "shadow-everywhere", shadowed.length + " elements carry a shadow (" + shadowed.slice(0, 3).map(labelOf).join(", ") + ").", "Keep the shadow on the one element that should lift and remove it from the rest.", labelOf(shadowed[0]));

  // Glass
  let glass = null;
  for (const u of S.live) {
    const bf = u.map.get("backdrop-filter");
    if (!bf || bf.indexOf("blur(") < 0) continue;
    S.fx.add("blur");
    let plate = unitBg(u).solid;
    if (!plate && u.els[0]) plate = bgOf(u.els[0], M).solid;
    if (!plate || plate.a < 0.6) glass = glass || { where: u.label, how: "blurs what is behind it under a see-through fill" };
  }
  if (!glass) {
    for (const el of M.doc.all) {
      if (!el.units || el.inSvg) continue;
      const bg = bgOf(el, M);
      if (!bg.solid || bg.solid.L < 0.9 || bg.solid.a < 0.03 || bg.solid.a > 0.35) continue;
      const b = elBorder(el, M).all;
      if (b.w > 0 && b.w <= 2 && b.color && b.color.L >= 0.8 && b.color.a <= 0.5) {
        glass = { where: labelOf(el), how: "is a see-through white fill with a faint white border" };
        break;
      }
    }
  }
  if (glass && !gate.off("glass")) report(S, "glass", "The plate " + glass.where + " " + glass.how + ", the frosted glass look.", "Use a solid dark plate at 80 to 90 percent opacity with no blur and no border.", glass.where);

  // Texture
  const pattern = S.grads.find((r) => r.kind === "pattern");
  const noise = /feturbulence/i.test(M.raw) || S.rawNoise;
  if (pattern || noise) S.fx.add("grain");
  if (!gate.off("texture-overlay")) {
    if (pattern) report(S, "texture-overlay", "A repeating pattern is laid over " + pattern.where + " (" + short(pattern.g.text, 48) + ").", "Remove the pattern and leave the surface flat.", pattern.where);
    else if (noise) report(S, "texture-overlay", "An SVG noise filter (feTurbulence) lays grain over the design.", "Remove the grain and leave the surface flat.", "svg");
  }
}

// ----------------------------------------------------------------- decoration

const EMOJI_RE = /(?:\p{Extended_Pictographic}\uFE0F|\p{Emoji_Presentation}|[\u{1F1E6}-\u{1F1FF}]{2}|[0-9#*]\uFE0F?\u20E3)/gu;
const SPARKLE_RE = /[\u2605\u2606\u2610-\u2612\u2713-\u2718\u2720-\u274B\u274D\u2756\u2763-\u2767\u2B51\u2B52\u269D\u22C6\u2042\u2051\u203B](?!\uFE0F)/gu;
const PARTICLE_NAME = /(?:^|[-_ ])(confetti|particles?|sparkles?|sparks?|fireworks?|bokeh|snowflakes?|starfield|embers?|glitter)(?:[-_ \d]|$)/;
const splitName = (s) => String(s).replace(/([a-z\d])([A-Z])/g, "$1-$2").toLowerCase();

function checkDecoration(S) {
  const M = S.M, gate = S.gate;

  // Every piece of text the frame can show: markup, CSS content, script strings.
  const pieces = [];
  for (const el of M.doc.all) {
    if (RAW_TAGS.has(el.tag)) continue;
    if (el.text) pieces.push({ text: el.text, where: labelOf(el) });
    else if (el.splitText) pieces.push({ text: el.splitText, where: labelOf(el) });
  }
  for (const u of S.live) {
    const c = u.map.get("content");
    if (c && c !== "none" && c !== "normal") pieces.push({ text: c, where: u.label });
  }
  for (const text of M.js.texts) pieces.push({ text, where: "the script" });

  const wantEmoji = !gate.off("emoji"), wantSparkle = !gate.off("sparkle-char");
  if (wantEmoji || wantSparkle) {
    for (const piece of pieces) {
      if (wantEmoji && !S.found.has("emoji")) {
        const found = (piece.text.match(EMOJI_RE) || []).filter((ch) => !gate.asked.text.includes(ch));
        if (found.length) report(S, "emoji", "The emoji " + [...new Set(found)].slice(0, 3).join(" ") + " is used in " + quote(piece.text, 30) + " on " + piece.where + ".", "Remove it. Use a drawn shape, a rule or nothing.", piece.where);
      }
      if (wantSparkle && !S.found.has("sparkle-char")) {
        const found = (piece.text.match(SPARKLE_RE) || []).filter((ch) => !gate.asked.text.includes(ch));
        if (found.length) report(S, "sparkle-char", "The character " + [...new Set(found)].slice(0, 3).join(" ") + " decorates " + quote(piece.text, 30) + " on " + piece.where + ".", "Remove it. Use a drawn shape, a rule or nothing.", piece.where);
      }
    }
  }

  // Blurred orbs
  let orbs = 0, orbWhere = "";
  for (const u of S.live) {
    const f = u.map.get("filter");
    if (!f || f.indexOf("blur(") < 0) continue;
    const blur = parseFilter(f, M.frame).blur;
    if (blur >= 8) S.fx.add("blur");
    if (u.kf || blur < 24) continue;
    const bare = u.els.filter((el) => !hasText(el));
    if (u.els.length && !bare.length) continue;
    orbs += Math.max(1, bare.length);
    orbWhere = orbWhere || u.label;
  }
  const halos = S.grads.filter((r) => r.g.type === "radial" && r.kind === "scrim" && r.g.stops.some((c) => c.a >= 0.15 && isChromatic(c)));
  if (!gate.off("blur-orbs")) {
    if (orbs >= 1) report(S, "blur-orbs", "A blurred blob sits in the background (" + orbWhere + ", filter: blur).", "Delete it. A flat background or one real picture reads better.", orbWhere);
    else if (halos.length >= 2) report(S, "blur-orbs", halos.length + " soft color blobs are drawn with radial gradients (" + halos[0].where + ").", "Delete them. A flat background or one real picture reads better.", halos[0].where);
  }
  if (orbs >= 1 || halos.length >= 2) S.fx.add("orbs");

  // Particles
  let particles = null;
  for (const el of M.doc.all) {
    for (const c of el.classes.concat(el.id ? [el.id] : [])) {
      const m = PARTICLE_NAME.exec(splitName(c));
      if (m && !particles) particles = { where: labelOf(el), how: "The element " + labelOf(el) + " is named " + m[1] + "." };
    }
  }
  if (!particles) for (const u of S.live) {
    const m = u.sel ? PARTICLE_NAME.exec(splitName(u.sel.replace(/[.#>+~:()[\]="']/g, " "))) : null;
    if (m && (u.els.length || M.hasJs)) {
      particles = { where: u.label, how: "The style rule " + u.label + " is named " + m[1] + "." };
      break;
    }
  }
  if (!particles) for (const id of M.js.idents) {
    const m = PARTICLE_NAME.exec(splitName(id));
    if (m) {
      particles = { where: "the script", how: "The script draws " + m[1] + " (" + id + ")." };
      break;
    }
  }
  if (!particles && M.js.random && M.js.loopCount >= 12 && M.js.draws) particles = { where: "the script", how: "The script scatters " + M.js.loopCount + " random shapes." };
  if (!particles) {
    for (const parent of M.doc.all) {
      if (parent.children.length < 12 || parent.inSvg) continue;
      const tiny = parent.children.filter((c) => !c.children.length && !hasText(c) && /^(absolute|fixed)$/.test(String(c.props.position || "")));
      if (tiny.length >= 12) {
        particles = { where: labelOf(parent), how: tiny.length + " loose dots are scattered inside " + labelOf(parent) + "." };
        break;
      }
    }
  }
  if (particles) S.fx.add("particles");
  if (particles && !gate.off("particles")) report(S, "particles", particles.how, "Remove the particles unless the subject is a celebration.", particles.where);
}

// --------------------------------------------------------------------- motion

const LAYOUT_PROP = /^(width|height|min-width|min-height|max-width|max-height|margin(-.+)?|padding(-.+)?|top|left|right|bottom|inset(-.+)?)$/;

function readTransform(get) {
  const out = { translate: 0, scale: 1, rotate: 0, any: false };
  const tf = String(get("transform") || "").toLowerCase();
  if (tf && tf !== "none") {
    out.any = true;
    for (const call of findCalls(tf, "translate3d|translatex|translatey|translatez|translate|scale3d|scalex|scaley|scale|rotate[xyz]?|rotate3d|matrix")) {
      const nums = splitTop(call.args, ",").map((a) => parseFloat(a));
      if (call.name.startsWith("translate")) {
        const far = nums.reduce((m, n) => (Number.isFinite(n) && Math.abs(n) > Math.abs(m) ? n : m), 0);
        if (far) out.translate = far;
      } else if (call.name.startsWith("scale")) {
        const far = nums.reduce((m, n) => (Number.isFinite(n) && Math.abs(n - 1) > Math.abs(m - 1) ? n : m), 1);
        out.scale = far;
      } else if (call.name.startsWith("rotate")) out.rotate = nums[nums.length - 1] || 0;
    }
  } else if (tf === "none") out.any = true;
  const tr = String(get("translate") || "");
  if (tr && tr !== "none") {
    out.any = true;
    const far = splitTop(tr, " ").map((a) => parseFloat(a)).reduce((m, n) => (Number.isFinite(n) && Math.abs(n) > Math.abs(m) ? n : m), 0);
    if (far) out.translate = far;
  }
  const sc = String(get("scale") || "");
  if (sc && sc !== "none") {
    out.any = true;
    const n = parseFloat(sc);
    if (Number.isFinite(n)) out.scale = /%/.test(sc) ? n / 100 : n;
  }
  return out;
}

function keyframeInfo(S, name) {
  if (S.kf.has(name)) return S.kf.get(name);
  const frames = [];
  for (const u of S.M.units) {
    if (!u.kf || u.kfName !== name) continue;
    for (const key of u.keys) {
      const pct = key === "from" ? 0 : key === "to" ? 100 : parseFloat(key);
      if (Number.isFinite(pct)) frames.push({ pct, map: u.map });
    }
  }
  if (!frames.length) {
    S.kf.set(name, null);
    return null;
  }
  frames.sort((a, b) => a.pct - b.pct);
  const info = { name, frames, props: new Set(), layout: [], opacity: false, translate: false, scale: false, rotate: false, transformProp: false, timings: [], scaleSeq: [], moveSeq: [], loopsBack: false };
  const values = new Map(); // prop -> [value per frame or undefined]
  frames.forEach((f, i) => {
    for (const [prop, value] of f.map) {
      if (prop === "animation-timing-function") {
        info.timings.push(value);
        continue;
      }
      info.props.add(prop);
      if (!values.has(prop)) values.set(prop, new Array(frames.length));
      values.get(prop)[i] = value;
    }
    const t = readTransform((p) => f.map.get(p));
    if (t.any) {
      info.transformProp = true;
      info.scaleSeq.push(t.scale);
      info.moveSeq.push(t.translate);
    }
  });
  const changes = (prop) => {
    const list = values.get(prop);
    if (!list) return false;
    const set = new Set(list.map((v) => (v === undefined ? "\u0000" : v)));
    return set.size > 1;
  };
  for (const prop of info.props) if (LAYOUT_PROP.test(prop) && (changes(prop) || frames.length === 1)) info.layout.push(prop);
  info.opacity = changes("opacity");
  info.translate = info.moveSeq.some((v) => v !== 0) && (new Set(info.moveSeq).size > 1 || info.moveSeq.length < frames.length || frames.length === 1);
  info.scale = info.scaleSeq.some((v) => v !== 1) && (new Set(info.scaleSeq).size > 1 || info.scaleSeq.length < frames.length || frames.length === 1);
  if (changes("translate")) info.translate = true;
  if (changes("scale")) info.scale = true;
  // Ends where it started: a pulse, a float, a blink.
  const hasStart = frames[0].pct === 0, hasEnd = frames[frames.length - 1].pct === 100;
  let same = true, moved = false;
  for (const [, list] of values) {
    const a = hasStart ? list[0] : undefined, b = hasEnd ? list[list.length - 1] : undefined;
    if (a !== b) same = false;
    if (new Set(list.map((v) => (v === undefined ? "\u0000" : v))).size > 1) moved = true;
  }
  info.loopsBack = same && moved;
  S.kf.set(name, info);
  return info;
}

// "overshoot", "bounce" or "" for a run of values that ends somewhere new.
function seqKind(seq, unit) {
  if (seq.length < 3) return "";
  const end = seq[seq.length - 1], start = seq[0];
  const span = Math.abs(end - start);
  if (span < unit * 0.05) return "";
  let turns = 0, lastDir = 0, past = 0;
  for (let i = 1; i < seq.length; i += 1) {
    const d = seq[i] - seq[i - 1];
    const dir = d > 0 ? 1 : d < 0 ? -1 : 0;
    if (dir && lastDir && dir !== lastDir) turns += 1;
    if (dir) lastDir = dir;
    const beyond = (seq[i] - end) * Math.sign(end - start);
    if (beyond > past) past = beyond;
  }
  if (turns >= 2 && past / span >= 0.04) return "bounce";
  if (turns >= 1 && past / span >= 0.09) return "overshoot";
  return "";
}

function easingKind(timing) {
  const t = String(timing || "").toLowerCase();
  if (!t) return null;
  if (t.indexOf("cubic-bezier(") >= 0) {
    const x = bezierExtremes(t);
    if (x && Math.max(x.over, x.under) >= 0.09) return { kind: "overshoot", how: t + ", which runs " + Math.round(Math.max(x.over, x.under) * 100) + " percent past its end and springs back" };
  }
  const lin = /linear\(([^)]*)\)/.exec(t);
  if (lin) {
    const nums = lin[1].split(",").map((p) => parseFloat(p)).filter(Number.isFinite);
    const kind = seqKind([0].concat(nums), 1);
    if (kind) return { kind, how: "its linear() easing " + (kind === "bounce" ? "bounces" : "overshoots") };
  }
  return null;
}

function checkMotion(S) {
  const M = S.M, gate = S.gate;
  const uses = [];
  for (const u of S.live) if (!u.kf) for (const a of u.anims) uses.push({ u, a, info: keyframeInfo(S, a.name) });
  const onType = (u) => (u.src === "js" || (!u.els.length && !(u.pseudoHosts && u.pseudoHosts.length)) ? S.texts.length > 0 : u.els.some(hasText));

  if (!gate.open("motion-bounce")) {
    const overshootOk = gate.limited("motion-bounce", "overshoot");
    const hits = [];
    const push = (kind, where, how) => {
      if (kind === "overshoot" && overshootOk) return;
      hits.push({ kind, where, how });
    };
    for (const { u, a, info } of uses) {
      if (!onType(u)) continue;
      const timings = [a.timing].concat(info ? info.timings : []);
      for (const t of timings) {
        const e = easingKind(t);
        if (e) push(e.kind, u.label, "The " + a.name + " animation on " + u.label + " uses " + e.how);
      }
      if (/bounce|elastic|wobble|jello|rubber|tada|jiggle|boing|spring/i.test(a.name)) push("bounce", u.label, "The animation " + a.name + " on " + u.label + " is a bounce");
      if (info) {
        const kind = seqKind(info.scaleSeq, 1) || seqKind(info.moveSeq, Math.max(...info.moveSeq.map(Math.abs), 1));
        if (kind) push(kind, u.label, "The keyframes " + a.name + " on " + u.label + (kind === "bounce" ? " bounce back and forth before they settle" : " run past the end value and settle back"));
      }
    }
    for (const u of S.live) {
      if (u.kf || !onType(u)) continue;
      for (const prop of ["transition", "transition-timing-function"]) {
        const e = easingKind(u.map.get(prop));
        if (e) push(e.kind, u.label, "The transition on " + u.label + " uses " + e.how);
      }
    }
    if (S.texts.length || M.js.idents.has("fillText")) {
      for (const e of M.js.eases) {
        if (e.kind === "css") {
          const k = easingKind(e.name);
          if (k) push(k.kind, "the script", "The script eases with " + k.how);
        } else push(e.kind, "the script", "The script eases with " + e.name + ", which " + (e.kind === "bounce" ? "bounces" : "overshoots and springs back"));
      }
    }
    const hit = hits.find((h) => h.kind === "bounce") || hits[0];
    if (hit) report(S, "motion-bounce", hit.how + ".", "Use an ease-out with no overshoot: cubic-bezier(0.16, 1, 0.3, 1) in CSS, or JV.ease.outCubic or outExpo in script.", hit.where);
  }

  if (!gate.off("motion-layout")) {
    // A bare rule or bar that grows holds nothing to reflow, so it reads the same as a scaleX.
    const bare = (u) => u.els.length > 0 && u.els.every((el) => !el.children.length && !hasText(el));
    const use = uses.find((x) => x.info && x.info.layout.length && !bare(x.u));
    if (use) report(S, "motion-layout", "The keyframes " + use.a.name + " on " + use.u.label + " animate " + use.info.layout.slice(0, 3).join(", ") + ".", "Animate transform (translate, scaleX) and opacity instead, which do not reflow the page.", use.u.label);
    else if (M.js.layoutInDraw.length) report(S, "motion-layout", "The script sets style." + M.js.layoutInDraw.slice(0, 3).join(", style.") + " on every frame.", "Move and size things with transform (translate, scale) and opacity instead.", "the script");
  }

  if (!gate.off("motion-triple")) {
    const byUnit = new Map();
    for (const x of uses) (byUnit.get(x.u) || byUnit.set(x.u, []).get(x.u)).push(x);
    for (const [u, list] of byUnit) {
      let opacity = false, translate = false, scale = false, transformProp = false;
      for (const x of list) {
        if (!x.info) continue;
        opacity = opacity || x.info.opacity || (x.info.props.has("opacity") && x.info.frames.length === 1);
        translate = translate || x.info.translate;
        scale = scale || x.info.scale;
        transformProp = transformProp || x.info.transformProp;
      }
      if (transformProp) {
        const el = u.els[0];
        const base = readTransform((p) => (el ? el.props[p] : u.map.get(p)));
        if (base.translate) translate = true;
        if (base.scale !== 1) scale = true;
      }
      if (opacity && translate && scale) {
        report(S, "motion-triple", "The element " + u.label + " fades, slides and scales at the same time (" + list.map((x) => x.a.name).join(", ") + ").", "Keep one move. A short slide with the fade, or the scale alone.", u.label);
        break;
      }
    }
  }

  if (!gate.off("motion-stagger") && M.durationMs && M.durationMs < 3000) {
    const delays = new Map();
    const blocks = new Set();
    for (const t of S.texts) {
      if (t.svg || blocks.has(t.block)) continue;
      blocks.add(t.block);
      let owner = t.block, anims = elAnims(owner);
      if (!anims.length && owner.parent && owner.parent !== M.doc.body && owner.parent.children.length === 1) {
        owner = owner.parent;
        anims = elAnims(owner);
      }
      if (!anims.length) continue;
      const a = anims[0];
      const key = /calc|\u0001/.test(a.delayText) && owner.attrs.style ? a.delayText + "|" + owner.attrs.style : String(a.delay || 0);
      delays.set(owner, key);
    }
    const distinct = new Set(delays.values());
    if (distinct.size >= 3 && distinct.size >= delays.size * 0.6) report(S, "motion-stagger", distinct.size + " lines each start on their own delay and the whole thing lasts " + (M.durationMs / 1000).toFixed(1) + " seconds.", "Bring the lines in together, or hold the card for three seconds or more.", labelOf([...delays.keys()][0]));
  }

  if (!gate.off("motion-loop")) {
    for (const { u, a, info } of uses) {
      if (!(a.iter === Infinity || a.iter >= 3)) continue;
      if (u.els.length && u.els.every((el) => el.dot)) continue;
      if (u.pseudoHosts && u.pseudoHosts.length && u.pseudoHosts.every((el) => el.dot)) continue;
      const named = /pulse|shimmer|float|glow|breath|blink|bob|wiggle|shine|flicker|throb|heartbeat|ping|wave/i.test(a.name);
      if (!info) {
        if (!named) continue;
      } else {
        const stepped = /^steps\(|^step-/.test(a.timing);
        const lightOnly = [...info.props].every((p) => /^(opacity|visibility|border(-.+)?-color|border-color|background-color|color)$/.test(p));
        if (stepped && lightOnly) continue; // a text caret
        const shimmer = [...info.props].some((p) => p.startsWith("background-position"));
        if (!/alternate/.test(a.dir) && !info.loopsBack && !shimmer) continue; // a spin, a scroll, a ticker
      }
      report(S, "motion-loop", "The " + a.name + " animation on " + u.label + " loops " + (a.iter === Infinity ? "forever" : a.iter + " times") + ".", "Play it once and let it rest, or remove it.", u.label);
      break;
    }
  }
}

// ---------------------------------------------------------------------- lint

function findGlow(S) {
  const M = S.M, hits = [];
  const glows = (s, minBlur) => !s.inset && s.color && s.color.a >= 0.2 && s.blur >= minBlur && s.blur >= 3 * Math.max(Math.abs(s.x), Math.abs(s.y)) && (s.color.C >= 0.08 || (s.color.L >= 0.8 && s.x === 0 && s.y === 0 && s.color.a >= 0.4));
  for (const u of S.live) {
    const bs = u.map.get("box-shadow"), ts = u.map.get("text-shadow"), f = u.map.get("filter");
    if (!bs && !ts && !(f && f.indexOf("drop-shadow") >= 0)) continue;
    const em = u.els[0] ? fontSizePx(u.els[0], M) : 16;
    let found = null;
    if (bs) for (const s of parseShadows(bs, M.frame, em)) if (glows(s, 16)) found = s;
    if (ts) for (const s of parseShadows(ts, M.frame, em)) if (glows(s, 8)) found = s;
    if (f && f.indexOf("drop-shadow") >= 0) for (const s of parseFilter(f, M.frame).shadows) if (glows(s, 10)) found = s;
    if (found) hits.push({ where: u.label, n: u.kf ? 0 : Math.max(1, u.els.length), text: found.text });
  }
  if (M.js.shadowBlur >= 12) {
    for (const [key, decls] of M.js.groups) {
      if (!key.startsWith("canvas:")) continue;
      for (const d of decls) {
        const c = d.prop === "canvas-shadow-color" ? parseColor(d.value) : null;
        if (c && c.a >= 0.2 && (c.C >= 0.08 || c.L >= 0.8)) hits.push({ where: "the canvas", n: 1, text: "shadowBlur " + M.js.shadowBlur });
      }
    }
  }
  return hits;
}

const now = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
const BIG_DATA = /data:[a-z0-9.+\/-]+;base64,[A-Za-z0-9+\/=]{200,}/gi;

function lintDesign(input, opts) {
  const started = now();
  const src = input && typeof input === "object" ? input : {};
  const o = opts && typeof opts === "object" ? opts : {};
  const stats = { kind: src.kind === "animation" ? "animation" : "card", elements: 0, rules: 0, textBlocks: 0, hard: 0, soft: 0, ms: 0 };
  const lean = {};
  let rawNoise = false;
  for (const key of Object.keys(src)) {
    const v = src[key];
    if ((key === "html" || key === "css" || key === "js") && typeof v === "string") {
      if (/feTurbulence/i.test(v)) rawNoise = true;
      if (/%3CfeTurbulence|ZmVUdXJidWxlbmNl/i.test(v)) rawNoise = true;
      lean[key] = v.length > 4000 ? v.replace(BIG_DATA, "data:x;base64,AA") : v;
    } else lean[key] = v;
  }
  let S;
  try {
    const M = buildModel(lean, o);
    S = { M, gate: makeGate(o), found: new Map(), fx: new Set(), kf: new Map(), rawNoise };
    S.live = liveUnits(M);
    S.texts = collectTexts(S);
    S.headline = S.texts.filter((t) => t.size != null).sort((a, b) => b.size - a.size)[0] || null;
    S.grads = collectGradients(S);
    S.glow = findGlow(S);
    S.dots = findPulsingDots(S);
  } catch (err) {
    stats.error = String((err && err.message) || err);
    stats.ms = Math.round((now() - started) * 100) / 100;
    return { verdict: "ok", problems: [], stats };
  }
  for (const check of [checkGradients, checkColor, checkType, checkLayout, checkShape, checkDecoration, checkMotion, checkEffects]) {
    try {
      check(S);
    } catch (err) {
      stats.error = (stats.error ? stats.error + "; " : "") + check.name + ": " + String((err && err.message) || err);
    }
  }
  const problems = [];
  for (const rule of RULES) if (rule.hard && S.found.has(rule.id)) problems.push(S.found.get(rule.id));
  for (const rule of RULES) if (!rule.hard && S.found.has(rule.id)) problems.push(S.found.get(rule.id));
  stats.hard = problems.filter((p) => p.hard).length;
  stats.soft = problems.length - stats.hard;
  stats.elements = S.M.doc.all.length;
  stats.rules = S.M.units.length;
  stats.textBlocks = new Set(S.texts.map((t) => t.block)).size;
  stats.ms = Math.round((now() - started) * 100) / 100;
  const verdict = stats.hard > 0 || stats.soft >= 3 ? "slop" : stats.soft > 0 ? "tells" : "ok";
  return { verdict, problems, stats };
}

// Four or more effects on one design.
function checkEffects(S) {
  const fx = S.fx;
  if (S.glow.length) fx.add("glow");
  if (S.grads.some((r) => (r.kind === "blend" && r.gap >= 0.05) || (S.flaggedGrads && S.flaggedGrads.has(r)))) fx.add("gradient");
  if (S.softShadows > 0) fx.add("shadow");
  for (const info of S.kf.values()) if (info && info.scale && /zoom|ken|push|scale-bg|drift/i.test(info.name)) fx.add("zoom");
  if (S.gate.off("effect-stack")) return;
  const names = { glow: "glow", gradient: "gradient", shadow: "shadow", blur: "blur", grain: "pattern or grain", orbs: "blurred blobs", particles: "particles", zoom: "zoom" };
  // An effect the person asked for, or the style calls for, is not counted.
  const ruleOf = { glow: ["glow"], gradient: ["gradient-fill", "purple-gradient"], shadow: ["shadow-everywhere"], blur: ["glass", "blur-orbs"], grain: ["texture-overlay"], orbs: ["blur-orbs"], particles: ["particles"] };
  const list = [...fx].filter((k) => names[k] && !(ruleOf[k] || []).some((id) => S.gate.off(id))).map((k) => names[k]);
  if (list.length >= 4) report(S, "effect-stack", list.length + " effects are stacked on this design: " + list.join(", ") + ".", "Keep the one effect the viewer would miss and delete the rest.", "");
}

module.exports = { lintDesign, RULES, parseColor, findColors };
