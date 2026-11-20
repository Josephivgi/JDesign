#!/usr/bin/env node
"use strict";

// Checks the two static slop linters:
//   node scripts/slop-copy-test.cjs [--corpus <folder>] [--quiet]
// lib/slop/copy-lint.js reads the words (cards, CTAs, scripts, captions,
// names) and lib/slop/pacing-lint.js reads the plan of a video (scene
// lengths, transitions, entrances, narration lines, audio). Each case is one
// piece of copy or one plan written the way an agent writes it, with the
// verdict it must get. The shipped material (card templates, preset defaults,
// the examples in the skills, the rewrite table in writing-slop) is linted
// too: the Plain column and the shipped defaults must pass, the Slop column
// must be caught. --corpus points at a folder of saved agent output: files
// named good-* must pass and files named slop-* must be caught.
// Prints PASS or FAIL per case and exits 1 on any failure. Plain node, no
// window, nothing written to disk.

const fs = require("node:fs");
const path = require("node:path");

const appRoot = path.join(__dirname, "..");
const copy = require(path.join(appRoot, "lib", "slop", "copy-lint"));
const pacing = require(path.join(appRoot, "lib", "slop", "pacing-lint"));
const { visibleText, lintCopy, COPY_RULES } = copy;
const { lintScenes, lintNarration, lintAudioPlan, lintVideoPlan, PACING_RULES } = pacing;

const argv = process.argv.slice(2);
const quiet = argv.includes("--quiet");
const corpusAt = argv.indexOf("--corpus");
// Default: the real agent output saved beside this script.
const corpusDir = corpusAt >= 0 ? argv[corpusAt + 1] : require("node:path").join(__dirname, "slop-corpus");

let passed = 0;
let failed = 0;
const findings = [];

function report(ok, name, detail) {
  if (ok) passed += 1;
  else failed += 1;
  if (!ok || !quiet) console.log((ok ? "PASS " : "FAIL ") + name + (detail ? "  " + detail : ""));
}
function section(title) {
  if (!quiet) console.log("\n" + title);
}
const rulesOf = (result) => result.problems.map((p) => p.rule);
const brief = (result) => result.verdict + " [" + result.problems.map((p) => (p.hard ? "H:" : "s:") + p.rule).join(", ") + "]";

// Every result, from either linter, has to keep the agreed shape.
const RULE_TABLE = new Map(COPY_RULES.concat(PACING_RULES).map((r) => [r.id, r]));
let shapeErrors = 0;
function checkShape(result, label) {
  const bad = [];
  if (!result || !["ok", "tells", "slop"].includes(result.verdict)) bad.push("verdict");
  if (!result || !Array.isArray(result.problems)) bad.push("problems");
  if (!result || !result.stats || typeof result.stats !== "object") bad.push("stats");
  for (const p of (result && result.problems) || []) {
    const meta = RULE_TABLE.get(p.rule);
    if (!meta) bad.push("unknown rule " + p.rule);
    else if (meta.hard !== p.hard) bad.push(p.rule + " hard flag");
    if (typeof p.what !== "string" || p.what.trim().length < 8) bad.push(p.rule + " what");
    if (typeof p.fix !== "string" || p.fix.trim().length < 8) bad.push(p.rule + " fix");
    if (typeof p.where !== "string") bad.push(p.rule + " where");
    if (/[\u2014\u2013]|--/.test(String(p.fix))) bad.push(p.rule + " fix has a dash");
    if (!/[.?"]$/.test(String(p.what).trim())) bad.push(p.rule + " what is not a sentence");
    if (!/[.?")]$/.test(String(p.fix).trim())) bad.push(p.rule + " fix is not a sentence");
  }
  if (result) {
    const hard = result.problems.some((p) => p.hard);
    const soft = new Set(result.problems.filter((p) => !p.hard).map((p) => p.rule)).size;
    const want = hard || soft >= 3 ? "slop" : soft ? "tells" : "ok";
    if (want !== result.verdict) bad.push("verdict " + result.verdict + " does not follow the density rule (" + want + ")");
  }
  if (bad.length) {
    shapeErrors += 1;
    report(false, "shape: " + label, bad.join("; "));
  }
  return result;
}

// want: "ok" | "tells" | "slop", or { verdict, has: [rule ids], not: [rule ids] }
function expect(name, result, want) {
  checkShape(result, name);
  const w = typeof want === "string" ? { verdict: want } : want;
  const got = rulesOf(result);
  const misses = (w.has || []).filter((r) => !got.includes(r));
  const extras = (w.not || []).filter((r) => got.includes(r));
  const ok = result.verdict === w.verdict && !misses.length && !extras.length && (w.verdict !== "ok" || result.problems.length === 0);
  let detail = "";
  if (!ok) {
    detail = "wanted " + w.verdict + (misses.length ? " with " + misses.join(", ") : "") + (extras.length ? " without " + extras.join(", ") : "") + ", got " + brief(result);
    for (const p of result.problems) detail += "\n       " + p.rule + ": " + p.what;
  }
  report(ok, name, detail);
  return result;
}
const copyCase = (name, texts, opts, want) => expect(name, lintCopy(texts, opts), want);

// ------------------------------------------------------------- the surface

section("Surface");
report(typeof visibleText === "function" && typeof lintCopy === "function" && Array.isArray(COPY_RULES), "copy-lint exports visibleText, lintCopy, COPY_RULES");
report([lintScenes, lintNarration, lintAudioPlan, lintVideoPlan].every((f) => typeof f === "function") && Array.isArray(PACING_RULES), "pacing-lint exports lintScenes, lintNarration, lintAudioPlan, lintVideoPlan, PACING_RULES");
{
  const all = COPY_RULES.concat(PACING_RULES);
  const shaped = all.every((r) => /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(r.id) && typeof r.group === "string" && r.group && typeof r.hard === "boolean" && typeof r.title === "string" && r.title);
  report(shaped, "every rule has a kebab-case id, a group, a hard flag and a title");
  report(new Set(all.map((r) => r.id)).size === all.length, "no rule id is used twice across the two linters");
  report(!all.some((r) => /\u2014/.test(r.title)), "no rule title holds an em dash");
}
expect("empty input is ok", lintCopy([], {}), "ok");
expect("a missing plan is ok", lintVideoPlan(null), "ok");
expect("a string is taken as one text", lintCopy("Edit video by typing what you want"), "ok");

// ---------------------------------------- the rewrite table in writing-slop

section("Rewrite table (skills/writing-slop/SKILL.md)");
{
  const skill = fs.readFileSync(path.join(appRoot, "skills", "writing-slop", "SKILL.md"), "utf8");
  const rows = [];
  let inTable = false;
  for (const line of skill.split(/\r?\n/)) {
    if (/^\|\s*Slop\s*\|\s*Plain\s*\|/.test(line)) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    if (!line.startsWith("|")) break;
    if (/^\|\s*-+/.test(line)) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length >= 2) rows.push(cells);
  }
  report(rows.length >= 10, "the table was found", rows.length + " rows");
  for (const [slop, plain] of rows) {
    copyCase("slop column: " + slop, [slop], { kind: "card" }, { verdict: "slop" });
    // The Plain cell may hold notes in brackets and two choices split by a slash.
    const choices = plain.replace(/\([^)]*\)/g, " ").split(" / ").map((c) => c.trim()).filter(Boolean);
    for (const choice of choices) copyCase("plain column: " + choice, [choice], { kind: "card" }, "ok");
  }
}

// -------------------------------------------------------- copy: the real thing

section("Copy an agent writes when it is on autopilot (must be slop)");
const SLOP_COPY = [
  ["launch card", ["Unlock Your Creative Potential", "The all-in-one platform that empowers creators to elevate their content", "Get Started Today"], { kind: "card" }, ["button-copy"]],
  ["question and triple", ["Ready to transform your workflow?", "Seamless. Powerful. Intuitive."], { kind: "card" }, ["question-hook"]],
  ["second brain", ["It's not just a notebook \u2014 it's your second brain."], { kind: "card" }, ["not-just-but", "em-dash"]],
  ["emoji bullets", ["\u2728 Introducing FlowMind \u2728", "\uD83D\uDE80 Launch faster", "\uD83D\uDCA1 Think smarter"], { kind: "card" }, ["emoji"]],
  ["tired of", ["Tired of messy notes?", "Say goodbye to chaos"], { kind: "card" }, ["question-hook", "stock-phrase"]],
  ["fast-paced world", ["In today's fast-paced world, staying organized is crucial."], { kind: "card" }, ["stock-opener"]],
  ["next level", ["Take your productivity to the next level"], { kind: "card" }, ["hollow-closer"]],
  ["journey and learn more", ["Your journey starts here", "Learn More"], { kind: "card" }, ["hollow-closer", "button-copy"]],
  ["join the crowd", ["Join 50,000+ creators who trust Quill"], { kind: "card" }, ["hollow-closer"]],
  ["the future", ["Welcome to the future of note-taking"], { kind: "card" }, ["hollow-closer"]],
  ["threes on every line", ["Fast, simple, and powerful", "Clean, modern, and intuitive", "Secure, reliable, and scalable"], { kind: "card" }, []],
  ["whether you are", ["Whether you're a student or a CEO, Quill has you covered"], { kind: "card" }, ["stock-phrase"]],
  ["the result", ["We rebuilt search from scratch.", "The result? Magic."], { kind: "card" }, ["question-hook"]],
  ["what if", ["What if you could edit a video in seconds?"], { kind: "card" }, ["question-hook"]],
  ["hashtags", ["New video out now #productivity #notes #fyp"], { kind: "card" }, ["hashtag"]],
  ["end card stack", ["Get started today and unlock your potential"], { kind: "cta" }, ["button-copy"]],
  ["stock words stacked", ["A robust, cutting-edge platform for the modern landscape"], { kind: "card" }, ["stock-words-stacked"]],
  ["voiceover opener", ["Hey guys, welcome back! Today we're diving into something truly game-changing.", "Let's dive in."], { kind: "script" }, ["stock-opener"]],
  ["imagine a world", ["Imagine a world where editing takes seconds, not hours."], { kind: "script" }, ["stock-opener"]],
  ["the kicker", ["But here's the kicker: it does all of it for you.", "It isn't just fast. It's effortless."], { kind: "script" }, ["stock-opener"]],
  ["chat reply left in", ["Sure! Here's a voiceover script for your video:", "Bread rises because of yeast."], { kind: "script" }, ["chatbot-reply"]],
  ["script with a dash pivot", ["This isn't editing \u2014 it's magic."], { kind: "script" }, ["em-dash"]],
  ["look no further", ["Looking for a better notebook? Look no further."], { kind: "card" }, ["stock-phrase"]],
  ["level up", ["Level up your content game"], { kind: "cta" }, ["button-copy"]],
  ["more than just", ["More than just a to-do list"], { kind: "card" }, ["not-just-but"]],
  ["not x not y just z", ["Not complicated. Not expensive. Just simple."], { kind: "card" }, ["not-just-but"]],
  ["discover the future", ["Discover a smarter way to work"], { kind: "cta" }, ["button-copy"]],
  ["hype verb at your noun", ["Supercharge your workflow"], { kind: "card" }, ["button-copy"]],
  ["hype verb in title case", ["Elevate Your Brand With Stunning Visuals"], { kind: "card" }, ["button-copy"]],
  ["two actions and a promise", ["Download now and transform your life"], { kind: "cta" }, ["button-copy"]],
  ["the future of", ["Experience the future of productivity"], { kind: "card" }, ["hollow-closer"]],
  ["revolutionize the way", ["Revolutionize the way you take notes"], { kind: "card" }, ["stock-phrase"]],
  ["deserve better", ["Because your ideas deserve better"], { kind: "card" }, ["stock-phrase"]],
  ["stock adjectives as a slam", ["Smart. Fast. Effortless."], { kind: "card" }, ["hollow-triple"]],
  ["a whole weak promo", ["Introducing FlowMind", "Your AI-Powered Productivity Partner", "Smart. Fast. Effortless.", "10x Your Productivity", "Join 50,000+ happy users", "Ready to Transform Your Workflow?", "Get Started Free"], { kind: "card", asked: "make a promo for my app FlowMind" }, ["question-hook", "button-copy", "hollow-closer", "hollow-triple"]],
  ["three soft tells in one piece", ["Work smarter, not harder", "Big news!", "A seamless way to share notes"], { kind: "card" }, ["ad-cliche", "exclamation-mark", "stock-word"]],
  ["chat manners", ["You're absolutely right. Here's the new headline:", "Quill keeps your notes"], { kind: "card" }, ["chatbot-reply"]],
];
for (const [name, texts, opts, has] of SLOP_COPY) copyCase("slop: " + name, texts, opts, { verdict: "slop", has });

section("Copy with one or two tells (must be tells, not refused)");
copyCase("tells: one stock word", ["A seamless way to share notes"], { kind: "card" }, { verdict: "tells", has: ["stock-word"] });
copyCase("tells: studies show", ["Studies show most ideas are lost in a day"], { kind: "card" }, { verdict: "tells", has: ["unsourced-claim"] });
copyCase("tells: a question at the viewer", ["Want more like this?", "Subscribe"], { kind: "card" }, { verdict: "tells", has: ["bait-question"] });
copyCase("tells: announcing", ["Here are three reasons to switch"], { kind: "card" }, { verdict: "tells", has: ["announce-recap"] });
copyCase("tells: exclamation", ["Big news!"], { kind: "card" }, { verdict: "tells", has: ["exclamation-mark"] });
copyCase("tells: two actions on one end card", ["Subscribe and share this video"], { kind: "cta" }, { verdict: "tells", has: ["cta-two-actions"] });
copyCase("tells: a stiff script", ["It is a small tool. You will not need a manual. We are sure you will like it, and it does not cost much."], { kind: "script" }, { verdict: "tells", has: ["no-contractions"] });
copyCase("tells: stage direction", ["[excited] The update is out."], { kind: "script" }, { verdict: "tells", has: ["stage-direction"] });
copyCase("tells: a worn ad line", ["Work smarter, not harder"], { kind: "card" }, { verdict: "tells", has: ["ad-cliche"] });
copyCase("tells: reimagined", ["Notes, reimagined."], { kind: "card" }, { verdict: "tells", has: ["ad-cliche"] });
copyCase("tells: don't just", ["Don't just take notes. Master them."], { kind: "card" }, { verdict: "tells", has: ["contrast-frame"] });
copyCase("tells: a spoken correction is soft, not refused", ["This isn't the final version, it's a draft."], { kind: "script" }, { verdict: "tells", has: ["contrast-frame"], not: ["not-just-but"] });
copyCase("tells: noun upgrade", ["Tailored solutions for small bakeries"], { kind: "card" }, { verdict: "tells", has: ["stock-word"] });
copyCase("tells: every spoken line starts with So", ["So this is the dough.", "So we wait an hour.", "So it rises, and we shape it.", "So now we bake."], { kind: "script" }, { verdict: "tells", has: ["same-opener"] });
copyCase("tells: an invented quotation", ["\"Best notes app I have used.\""], { kind: "card", asked: "a promo for Quill" }, { verdict: "tells", has: ["unsourced-claim"] });
copyCase("tells: the closing line repeats the opening", ["Bread is alive.", "Yeast eats the sugar.", "The gas has nowhere to go.", "Bread is alive."], { kind: "card" }, { verdict: "tells", has: ["announce-recap"] });
copyCase("tells: invented figure", ["87% of notes are never read again"], { kind: "card", asked: "make a title card for my notes app" }, { verdict: "tells", has: ["unsourced-claim"] });

section("Plain copy (must be ok, with no problems at all)");
const CLEAN_COPY = [
  ["title and what it is", ["Quill", "A notebook app"], { kind: "card" }],
  ["an instruction", ["Open it and start typing."], { kind: "card" }],
  ["two short sentences", ["Search one word. Find the note."], { kind: "card" }],
  ["bake sale", ["Bake sale", "Saturday 10 to 2", "Lincoln School gym"], { kind: "card" }],
  ["a list of days", ["Everything in one notebook, sorted by day.", "Mon Call the dentist back", "Tue Buy coffee filters", "Wed Garden plan for spring, with the sketch"], { kind: "card" }],
  ["a real question about the topic", ["Why does bread rise?"], { kind: "card" }],
  ["facts", ["Yeast eats sugar", "The gas has nowhere to go"], { kind: "card" }],
  ["a plain CTA", ["Download Quill"], { kind: "cta" }],
  ["CTA examples from the skill", ["Watch part 2"], { kind: "cta" }],
  ["a link placeholder", ["Visit example.com"], { kind: "cta" }],
  ["end card", ["Thanks for watching", "Subscribe"], { kind: "card" }],
  ["a range with a hyphen", ["Mon - Fri", "9 am - 5 pm"], { kind: "card" }],
  ["a label with a hyphen", ["Daft Punk - Around the World"], { kind: "card" }],
  ["an episode", ["Episode 4", "The one with the bridge"], { kind: "card" }],
  ["numbers that are not claims", ["3 clips. 1 story."], { kind: "card" }],
  ["placeholders", ["00%", "Your stat here", "Your link here"], { kind: "card", asked: "an explainer about FlowMind" }],
  ["a year and a size", ["Recorded in 2024, in 4K"], { kind: "card", asked: "title card for my trip" }],
  ["game line", ["We invaded Italy."], { kind: "script" }],
  ["game line with a year", ["Italy, 1957. We take the peninsula."], { kind: "script" }],
  ["a spoken explanation", ["So here's how it works.", "You type what you want, and the editor makes the cut.", "That's it."], { kind: "script" }],
  ["a pause dash in a script", ["Then the oven sets every bubble in place - and that's your crumb."], { kind: "script" }],
  ["an ellipsis pause", ["It rises... and then it stops."], { kind: "script" }],
  ["the action caption from the skill", ["Cutting the first clip"], { kind: "card" }],
  ["a quote card", ["\u201CGood design is as little design as possible.\u201D", "Dieter Rams"], { kind: "card" }],
  ["a brand name", ["Made with JV"], { kind: "card" }],
  ["a file name", ["Pricing explainer"], { kind: "name" }],
];
for (const [name, texts, opts] of CLEAN_COPY) copyCase("clean: " + name, texts, opts, "ok");

section("Ordinary speech is not slop");
copyCase("discover inside a sentence", ["We discover the cave at minute three."], { kind: "script" }, "ok");
copyCase("discovered, past tense", ["Fleming discovered penicillin in 1928."], { kind: "card" }, "ok");
copyCase("journey on a travel video the person asked for", ["Our journey across Iceland", "Ten days on the ring road"], { kind: "card", asked: "make a title card for our journey across Iceland" }, "ok");
copyCase("a train journey", ["The train journey takes six hours."], { kind: "script" }, "ok");
copyCase("a real landscape", ["The landscape here is mostly lava and moss."], { kind: "script" }, "ok");
copyCase("a door that unlocks", ["Unlock the door with the blue key"], { kind: "card" }, "ok");
copyCase("an achievement", ["Level 12 unlocked"], { kind: "card" }, "ok");
copyCase("a literal transform", ["Transform your photos into paintings"], { kind: "card" }, "ok");
copyCase("a journey with a route", ["The journey from Lisbon to Porto takes about three hours by train."], { kind: "script" }, "ok");
copyCase("levelling up in a game", ["We leveled up twice before the boss."], { kind: "script" }, "ok");
copyCase("joining a few clips", ["Join 2 clips into one"], { kind: "card" }, "ok");
copyCase("a placeholder figure", ["00%", "Your stat here"], { kind: "card", asked: "an explainer about FlowMind" }, "ok");
copyCase("a reef", ["A coral reef is a whole ecosystem."], { kind: "script" }, "ok");
copyCase("a number the person gave", ["1.2M views", "Thank you"], { kind: "card", asked: "we hit 1.2 million views this year, make a thank you card" }, "ok");
copyCase("a price the person gave", ["New pricing", "Starter is now $8 a month"], { kind: "card", asked: "an explainer about our new pricing: starter is now $8 a month" }, "ok");
copyCase("a crowd the person gave", ["Join 10,000 creators"], { kind: "card", asked: "we have 10,000 creators, make an end card" }, "ok");
copyCase("join with a place and a time", ["Join us Saturday at 10"], { kind: "card" }, "ok");
copyCase("an instruction that reads like the frame", ["If it's not in Downloads, it's in Documents."], { kind: "script" }, "ok");
copyCase("a content question in a script", ["Why does bread rise?", "Yeast."], { kind: "script" }, "ok");
copyCase("one list of three is a style", ["Flour, water and salt."], { kind: "card" }, "ok");
copyCase("get started inside a sentence, spoken", ["Once the dough is warm, we can get started on the shaping."], { kind: "script" }, { verdict: "tells", not: ["button-copy"] });

section("What the person typed is theirs");
copyCase("a word they asked for", ["Seamless sync"], { kind: "card", asked: "use the word seamless in the headline" }, "ok");
copyCase("a ban is not permission", ["Unlock your potential"], { kind: "card", asked: "never say unlock, it sounds like an ad" }, { verdict: "slop", has: ["stock-phrase"] });
{
  const standing = "DON'T: Write AI-sounding copy or scripts: em dashes, \"not just X but Y\", unlock, elevate, seamless, game-changer, \"Ready to...?\", \"Get Started\", lists of three in every line.";
  copyCase("a DON'T rule that lists the words is not permission", ["Get Started"], { kind: "cta", asked: "make a promo for my notes app\n" + standing }, { verdict: "slop", has: ["button-copy"] });
  copyCase("a DON'T rule does not hide stacked stock words", ["A seamless experience that empowers every creator"], { kind: "card", asked: standing }, { verdict: "slop", has: ["stock-words-stacked"] });
  copyCase("a list of words to avoid is not permission", ["Seamless sync"], { kind: "card", asked: "Words I never want to see:\n- seamless\n- unlock\n\nMake a title card for Quill." }, { verdict: "tells", has: ["stock-word"] });
  copyCase("an avoid label rules the whole line out", ["Unlock your potential"], { kind: "card", asked: "Avoid: unlock your potential, level up, journey" }, { verdict: "slop" });
}
copyCase("their own line, word for word", ["Ready to roll?"], { kind: "card", asked: "put \"Ready to roll?\" on the first card" }, "ok");
copyCase("their line, in other case", ["READY TO ROLL?"], { kind: "card", asked: "put \"Ready to roll?\" on the first card" }, "ok");
copyCase("allow list: a phrase", ["Get Started"], { kind: "cta", allow: ["Get Started"] }, "ok");
copyCase("allow list: a rule id", ["\uD83C\uDF82 Bake sale"], { kind: "card", allow: ["emoji"] }, "ok");
copyCase("emoji they asked for", ["\uD83C\uDF82 Bake sale"], { kind: "card", asked: "add a cake emoji before the title" }, "ok");
copyCase("emoji they ruled out", ["\uD83C\uDF82 Bake sale"], { kind: "card", asked: "no emoji please" }, { verdict: "slop", has: ["emoji"] });
copyCase("a hashtag they asked for", ["Bake sale #bakesale"], { kind: "card", asked: "end with the hashtag #bakesale" }, "ok");
copyCase("their brand uses an exclamation mark", ["Yahoo!"], { kind: "card", asked: "title card for Yahoo! news" }, "ok");

section("Kinds");
copyCase("caption: the speaker's own words pass", ["it's not just a game, it's my whole life honestly", "we basically unlocked the next level"], { kind: "caption" }, "ok");
copyCase("caption: emoji the agent added", ["we take the city \uD83D\uDD25"], { kind: "caption" }, { verdict: "slop", has: ["emoji"] });
copyCase("caption: hashtags the agent added", ["we take the city #gaming"], { kind: "caption" }, { verdict: "slop", has: ["hashtag"] });
copyCase("name: title case is fine", ["Quill Title Card"], { kind: "name" }, "ok");
copyCase("name: the ban list still counts", ["Unlock Your Potential promo"], { kind: "name" }, { verdict: "slop" });
copyCase("script: a question hook is still caught", ["Ready to change how you edit?"], { kind: "script" }, { verdict: "slop", has: ["question-hook"] });
copyCase("card: title case on every line", ["The Fastest Way To Take Notes", "Built For People Who Write"], { kind: "card" }, { verdict: "tells", has: ["title-case"] });

// ----------------------------------------------------------------- dodges

section("Cheap dodges (must still be slop)");
const DODGES = [
  ["curly apostrophes", ["It\u2019s not just an app, it\u2019s a revolution"]],
  ["upper case", ["UNLOCK YOUR POTENTIAL"]],
  ["mixed case", ["uNlOcK yOuR pOtEnTiAl"]],
  ["extra spaces", ["Get    Started"]],
  ["spaced letters", ["U N L O C K your potential"]],
  ["a hyphen inside the word", ["Un-lock your potential"]],
  ["a zero width space", ["Un\u200Block your potential"]],
  ["a soft hyphen", ["Un\u00ADlock your potential"]],
  ["Cyrillic lookalikes", ["Unl\u043E\u0441k your potential"]],
  ["full width letters", ["\uFF35\uFF4E\uFF4C\uFF4F\uFF43\uFF4B your potential"]],
  ["markdown emphasis", ["**Unlock** your potential"]],
  ["a non breaking space", ["Get\u00A0Started"]],
  ["en dash for the em dash", ["Quill \u2013 your second brain"]],
  ["spaced hyphen for the em dash", ["Quill - your second brain."]],
  ["two hyphens for the em dash", ["Quill -- your second brain"]],
  ["horizontal bar", ["Quill \u2015 your second brain"]],
  ["trailing punctuation", ["Get started..."]],
  ["quotes around it", ["\u201CGet Started\u201D"]],
];
for (const [name, texts] of DODGES) copyCase("dodge: " + name, texts, { kind: "card" }, { verdict: "slop" });
const HTML_DODGES = [
  ["an entity inside the word", "<h1>A seam&shy;less experience that empowers every creator</h1>"],
  ["a tag inside the word", "<h1><b>Un</b>lock your potential</h1>"],
  ["two spans for one word", "<h1><span>un</span><span>lock</span> your potential</h1>"],
  ["one span per letter", "<h1>" + "Unlock".split("").map((c) => "<span>" + c + "</span>").join("") + " your potential</h1>"],
  ["one span per word", "<a><span>Get</span> <span>Started</span></a>"],
  ["numeric entities", "<h1>Get&#32;Started</h1>"],
  ["an emoji as an entity", "<h1>&#128640; Launch day</h1>"],
  ["a wbr", "<h1>Un<wbr>lock your potential</h1>"],
  ["a comment inside the word", "<h1>Un<!-- x -->lock your potential</h1>"],
  ["text set from script", "<h1 id=\"t\"></h1><script>document.getElementById(\"t\").textContent = \"Unlock your potential\";</script>"],
  ["words in a script array", "<div id=\"w\"></div><script>const words = [\"Unleash\", \"Your\", \"Potential\"]; let i = 0; window.drawAt = (t) => { w.textContent = words[Math.floor(t / 600) % 3]; };</script>"],
  ["css content", "<h1 class=\"h\"></h1><style>.h::after { content: \"Get Started\"; }</style>"],
];
for (const [name, html] of HTML_DODGES) {
  const texts = visibleText(html);
  expect("dodge in markup: " + name, lintCopy(texts, { kind: "card" }), { verdict: "slop" });
}

// ------------------------------------------------------------- visibleText

section("visibleText");
{
  const same = (name, got, want) => report(JSON.stringify(got) === JSON.stringify(want), "visibleText: " + name, JSON.stringify(got) === JSON.stringify(want) ? "" : "got " + JSON.stringify(got) + ", wanted " + JSON.stringify(want));
  same("blocks become separate runs", visibleText("<div><h1>Quill</h1><p>A notebook app</p></div>"), ["Quill", "A notebook app"]);
  same("style, script and comments are dropped", visibleText("<style>.a{color:red}</style><!-- note --><p>Hello there</p><script>var x = 1;</script>"), ["Hello there"]);
  same("entities are decoded", visibleText("<p>Tom &amp; Jerry &lt;3 &quot;cheese&quot; &#8212; caf&eacute;</p>"), ["Tom & Jerry <3 \"cheese\" \u2014 caf\u00E9"]);
  same("inline tags keep the sentence whole", visibleText("<p>Search <em>one</em> word. <strong>Find</strong> the note.</p>"), ["Search one word. Find the note."]);
  same("a line break is a space", visibleText("<h1>Open it<br>and start typing.</h1>"), ["Open it and start typing."]);
  same("split words come back whole", visibleText("<h1 data-split=\"chars\">Quill</h1><p data-split=\"words\">A notebook app</p>"), ["Quill", "A notebook app"]);
  same("empty input", visibleText(""), []);
  same("no input", visibleText(null), []);
  const fromScript = visibleText("<div id=\"a\"></div><script>a.textContent = \"Start with one note.\"; a.style.color = \"#ff0000\"; a.className = \"big title\";</script>");
  report(fromScript.includes("Start with one note.") && !fromScript.some((t) => /ff0000|big title/.test(t)), "visibleText: text set from script is read, styles and class names are not", JSON.stringify(fromScript));
  const typed = visibleText("<p id=\"q\"></p><script>const lines = [\"Buy coffee filters\", \"Call the dentist back\"]; window.drawAt = function (t) { q.textContent = lines[t > 900 ? 1 : 0]; };</script>");
  report(typed.includes("Buy coffee filters") && typed.includes("Call the dentist back"), "visibleText: a list of lines in script is read", JSON.stringify(typed));
  const counted = visibleText("<b id=\"n\">0</b><script>window.drawAt = function (t) { JV.count(t, 300, 1500, 1200, { suffix: \"%\" }); };</script>");
  report(counted.some((t) => /1,?200\s?%/.test(t)), "visibleText: the end value of a counter is read", JSON.stringify(counted));
}

// ------------------------------------------------------------------ plans

const html = (text, anim) => ({ html: "<div class=\"s\"><h1 class=\"t\">" + text + "</h1></div>", css: anim || "" });
const FADE_UP = ".t{animation:up 600ms ease-out both}@keyframes up{from{opacity:0;transform:translateY(4vmin)}to{opacity:1;transform:none}}";
const WIPE_ON = ".t{animation:wipe 700ms cubic-bezier(.2,.8,.2,1) 100ms both}@keyframes wipe{from{clip-path:inset(0 100% 0 0)}to{clip-path:inset(0 0 0 0)}}";
const SCALE_IN = ".t{animation:pop 500ms ease-out both}@keyframes pop{from{transform:scale(.6);opacity:0}to{transform:scale(1);opacity:1}}";
const planCase = (name, input, opts, want) => expect(name, lintVideoPlan(input, opts), want);

section("Plans an agent makes on autopilot (must be slop)");
planCase("slop plan: four presets, 3 s each, default fades", { scenes: ["kinetic-title", "counter-stat", "word-slam", "end-card"].map((preset) => ({ preset, durationMs: 3000 })) }, {}, { verdict: "slop", has: ["equal-scene-lengths", "fade-every-scene"] });
planCase("slop plan: five html scenes, same length, same fade up", { transition: "fade", scenes: ["Meet Quill", "Write", "Search", "Sort", "Download"].map((t) => Object.assign({ durationMs: 3000 }, html(t, FADE_UP))) }, {}, { verdict: "slop", has: ["equal-scene-lengths", "fade-every-scene", "same-entrance-every-scene"] });
planCase("slop plan: title, stat, end card at preset defaults", { scenes: [{ preset: "kinetic-title" }, { preset: "counter-stat" }, { preset: "end-card" }] }, {}, { verdict: "slop", has: ["equal-scene-lengths", "stock-preset-order"] });
planCase("slop plan: a slide between every scene", { transition: "slide", scenes: [2200, 3600, 2000, 5000, 3200].map((durationMs, i) => Object.assign({ durationMs }, html("Beat " + (i + 1), [FADE_UP, WIPE_ON, SCALE_IN, "", WIPE_ON][i]))) }, {}, { verdict: "slop", has: ["one-transition-everywhere"] });
planCase("slop plan: a word slam on every scene", { scenes: [{ preset: "word-slam", durationMs: 2200, transition: "cut" }, { preset: "word-slam", durationMs: 3600, transition: "fade" }, { preset: "word-slam", durationMs: 2000, transition: "wipe" }, { preset: "word-slam", durationMs: 5000 }] }, {}, { verdict: "slop", has: ["same-entrance-every-scene"] });
planCase("slop plan: six scenes near 3 s, fades and dissolves", { scenes: [3000, 3200, 3000, 3100, 3000, 3300].map((durationMs, i) => Object.assign({ durationMs, transition: i % 2 ? "dissolve" : "fade" }, html("Point " + (i + 1), i % 2 ? WIPE_ON : FADE_UP))) }, {}, { verdict: "slop", has: ["equal-scene-lengths", "fade-every-scene"] });
planCase("slop plan: durations left out, so every html scene is 3 s", { scenes: ["One", "Two", "Three", "Four"].map((t) => html(t, FADE_UP)) }, {}, { verdict: "slop", has: ["equal-scene-lengths"] });
planCase("slop plan: a short preset scene is raised to the same length", { scenes: [{ preset: "counter-stat", durationMs: 1500 }, { preset: "counter-stat", durationMs: 2000 }, { preset: "counter-stat", durationMs: 2500 }] }, {}, { verdict: "slop", has: ["equal-scene-lengths", "same-entrance-every-scene"] });
planCase("slop plan: three soft misses add up", { scenes: [{ preset: "kinetic-title", durationMs: 2600, transition: "slide" }, { preset: "bar-chart", durationMs: 3600, transition: "fade" }, { preset: "bar-chart", durationMs: 3000, transition: "slide" }, { preset: "end-card", durationMs: 3400 }] }, {}, { verdict: "slop", has: ["flat-scene-lengths", "no-hard-cut", "same-entrance-neighbours"] });
planCase("slop plan: narration at one length", { scenes: [{ preset: "kinetic-title", durationMs: 2200, transition: "cut" }, { preset: "bar-chart", durationMs: 4800, transition: "wipe" }, { preset: "typewriter-quote", durationMs: 3400, transition: "cut" }, { preset: "end-card", durationMs: 2600 }], lines: ["Bread rises because yeast eats the sugar inside.", "The gas it makes gets trapped in the dough.", "Heat then sets the bubbles into a soft crumb.", "That is why fresh bread feels so light today."] }, {}, { verdict: "slop", has: ["every-line-same-length"] });
planCase("slop plan: the bed as loud as the voice", { scenes: [{ preset: "kinetic-title", transition: "cut" }, { preset: "bar-chart", transition: "wipe" }, { preset: "end-card" }], audios: [{ audioId: "v1", scene: 1 }, { audioId: "v2", scene: 2 }, { audioId: "v3", scene: 3 }, { audioId: "bed", loop: true, duck: 0.3 }] }, {}, { verdict: "slop", has: ["music-over-voice"] });

section("Plans with one or two misses (must be tells, not refused)");
planCase("tells plan: no hard cut in four scenes", { scenes: [{ preset: "kinetic-title", durationMs: 2200, transition: "wipe" }, { preset: "bar-chart", durationMs: 4800, transition: "fade" }, { preset: "typewriter-quote", durationMs: 3400, transition: "slide" }, { preset: "end-card", durationMs: 2600 }] }, {}, { verdict: "tells", has: ["no-hard-cut"] });
planCase("tells plan: the same preset twice in a row", { scenes: [{ preset: "kinetic-title", durationMs: 2200, transition: "cut" }, { preset: "counter-stat", durationMs: 4800, transition: "fade" }, { preset: "counter-stat", durationMs: 3400, transition: "wipe" }, { preset: "end-card", durationMs: 2600 }] }, { asked: "show both numbers: 40 and 12" }, { verdict: "tells", has: ["same-entrance-neighbours"] });
planCase("tells plan: lengths too close", { scenes: [{ preset: "kinetic-title", durationMs: 2600, transition: "cut" }, { preset: "bar-chart", durationMs: 3600, transition: "fade" }, { preset: "end-card", durationMs: 3000 }] }, {}, { verdict: "tells", has: ["flat-scene-lengths"] });
planCase("tells plan: the wipe used twice", { scenes: [{ preset: "kinetic-title", durationMs: 2200, transition: "wipe" }, { preset: "bar-chart", durationMs: 4800, transition: "cut" }, { preset: "typewriter-quote", durationMs: 3400, transition: "wipeleft" }, { preset: "end-card", durationMs: 2600 }] }, {}, { verdict: "tells", has: ["showy-transition-repeated"] });
planCase("tells plan: nothing holds still", { scenes: [Object.assign({ durationMs: 2000, transition: "cut" }, html("One", ".t{animation:up 1500ms ease-out 300ms both}@keyframes up{from{opacity:0;transform:translateY(4vmin)}to{opacity:1;transform:none}}")), Object.assign({ durationMs: 3400, transition: "fade" }, html("Two", ".t{animation:wipe 2400ms linear 600ms both}@keyframes wipe{from{clip-path:inset(0 100% 0 0)}to{clip-path:inset(0 0 0 0)}}")), Object.assign({ durationMs: 2400 }, html("Three", ".t{animation:pop 1800ms ease-out 200ms both}@keyframes pop{from{transform:scale(.6)}to{transform:scale(1)}}"))] }, {}, { verdict: "tells", has: ["no-held-beat"] });
planCase("tells plan: two tracks at one level", { audioIds: ["a1", "a2"], scenes: [{ preset: "kinetic-title" }, { preset: "end-card" }] }, {}, { verdict: "tells", has: ["tracks-at-one-level"] });

section("Plans made on purpose (must be ok)");
planCase("good plan: the example in the explainer skill", { scenes: [{ preset: "kinetic-title", durationMs: 2200, transition: "cut" }, { preset: "counter-stat", durationMs: 3600, transition: "fade" }, { preset: "word-slam", durationMs: 2000, transition: "wipe" }, { preset: "typewriter-quote", durationMs: 5000, transition: "cut" }, { preset: "end-card", durationMs: 3200 }] }, { asked: "an explainer about our launch: 1200 signups in week one" }, "ok");
planCase("good plan: html scenes with their own entrances", { scenes: [Object.assign({ durationMs: 2200, transition: "cut" }, html("Quill", SCALE_IN)), Object.assign({ durationMs: 2000, transition: "wipeleft", transitionMs: 400 }, html("Open it and start typing.", FADE_UP)), Object.assign({ durationMs: 2800, transition: "fade" }, html("Search one word.", WIPE_ON)), Object.assign({ durationMs: 3600, transition: "slideup" }, html("Sorted by day.", "")), Object.assign({ durationMs: 2800 }, html("Download Quill", FADE_UP))] }, {}, "ok");
planCase("good plan: one beat, no scenes", { preset: "kinetic-title", presetParams: { title: "Bake sale" }, durationMs: 3500 }, {}, "ok");
planCase("good plan: one html beat", { html: "<h1>Quill</h1>", css: FADE_UP, durationMs: 3000 }, {}, "ok");
planCase("good plan: two scenes are not nagged about variety", { scenes: [{ preset: "kinetic-title", durationMs: 3000 }, { preset: "end-card", durationMs: 3000 }] }, {}, "ok");
planCase("good plan: two scenes of the same preset", { scenes: [{ preset: "counter-stat", durationMs: 3500 }, { preset: "counter-stat", durationMs: 3500 }] }, {}, "ok");
planCase("good plan: three scenes, a cut and a fade", { scenes: [{ preset: "kinetic-title", durationMs: 2200, transition: "cut" }, { preset: "bar-chart", durationMs: 4800, transition: "fade" }, { preset: "end-card", durationMs: 3000 }] }, {}, "ok");
planCase("good plan: six scenes with two cuts", { scenes: [{ preset: "kinetic-title", durationMs: 2200, transition: "cut" }, Object.assign({ durationMs: 3200, transition: "fade" }, html("The puzzle", WIPE_ON)), { preset: "bar-chart", durationMs: 4200, transition: "slide" }, Object.assign({ durationMs: 2000, transition: "cut" }, html("The reveal", SCALE_IN)), { preset: "typewriter-quote", durationMs: 5600, transition: "zoom" }, { preset: "end-card", durationMs: 3000 }] }, {}, "ok");
planCase("good plan: narrated, lengths left to the voice, bed kept low", { scenes: [{ preset: "kinetic-title", transition: "cut" }, { preset: "bar-chart", transition: "wipe" }, Object.assign({ transition: "cut" }, html("So the dough swells.", SCALE_IN)), { preset: "end-card" }], audios: [{ audioId: "v1", scene: 1 }, { audioId: "v2", scene: 2 }, { audioId: "v3", scene: 3 }, { audioId: "v4", scene: 4 }, { audioId: "bed", volume: 0.25, loop: true }], lines: [{ text: "Why does bread rise?", scene: 1 }, { text: "Yeast eats the sugar in the dough, and the gas it gives off has nowhere to go.", scene: 2 }, { text: "So the dough swells.", scene: 3 }, { text: "Then the oven sets every bubble in place... and that's your crumb.", scene: 4 }] }, {}, "ok");
planCase("good plan: the person asked for even scenes and fades", { transition: "fade", scenes: [Object.assign({ durationMs: 3000 }, html("One", FADE_UP)), Object.assign({ durationMs: 3000 }, html("Two", WIPE_ON)), Object.assign({ durationMs: 3000 }, html("Three", SCALE_IN)), Object.assign({ durationMs: 3000 }, html("Four", ""))] }, { asked: "four scenes, 3 seconds each, with a fade between every scene" }, "ok");
planCase("good plan: the person asked for a slide between scenes", { transition: "slide", scenes: [2200, 3600, 2000, 5000].map((durationMs, i) => Object.assign({ durationMs }, html("Beat " + (i + 1), [FADE_UP, WIPE_ON, SCALE_IN, ""][i]))) }, { asked: "use a slide transition between all the scenes, no hard cuts" }, "ok");
planCase("slop plan: fading one element in is not asking for fades everywhere", { scenes: ["kinetic-title", "counter-stat", "word-slam", "end-card"].map((preset) => ({ preset, durationMs: 3000 })) }, { asked: "make the logo fade in at the start, and show our 1200 signups" }, { verdict: "slop", has: ["fade-every-scene", "equal-scene-lengths"] });
planCase("slop plan: a rule against fades is not a request for them", { scenes: ["kinetic-title", "counter-stat", "word-slam", "end-card"].map((preset) => ({ preset, durationMs: 3000 })) }, { asked: "DON'T: use a fade between every scene or the same length for every scene" }, { verdict: "slop", has: ["fade-every-scene", "equal-scene-lengths"] });
planCase("good plan: music only, at full level", { audioId: "song", audioVolume: 1, audioLoop: true, scenes: [{ preset: "kinetic-title", durationMs: 2200, transition: "cut" }, { preset: "bar-chart", durationMs: 4800, transition: "fade" }, { preset: "end-card", durationMs: 3000 }] }, {}, "ok");
planCase("good plan: rules switched off by id", { scenes: ["kinetic-title", "counter-stat", "word-slam", "end-card"].map((preset) => ({ preset, durationMs: 3000 })) }, { allow: ["equal-scene-lengths", "fade-every-scene"] }, "ok");
{
  // One stylesheet sent with every scene: each scene only uses its own class.
  const shared = FADE_UP.replace(".t{", ".rise{") + WIPE_ON.replace(".t{", ".wipe{") + SCALE_IN.replace(".t{", ".pop{");
  const scene = (cls, text, durationMs, transition) => ({ html: "<h1 class=\"" + cls + "\">" + text + "</h1>", css: shared, durationMs, transition });
  planCase("good plan: one stylesheet shared by every scene, a different class on each", { scenes: [scene("pop", "Quill", 2200, "cut"), scene("rise", "Open it", 2000, "wipe"), scene("wipe", "Search", 4800, "fade"), scene("", "Sorted", 3000, "cut"), scene("rise", "Download", 2800)] }, {}, "ok");
  planCase("slop plan: one stylesheet shared by every scene, the same class on each", { scenes: [scene("rise", "Quill", 2200, "cut"), scene("rise", "Open it", 2000, "wipe"), scene("rise", "Search", 4800, "fade"), scene("rise", "Sorted", 3000)] }, {}, { verdict: "slop", has: ["same-entrance-every-scene"] });
}
planCase("good plan: a fast piece cut hard all the way", { transition: "cut", scenes: [{ preset: "kinetic-title", durationMs: 2200 }, Object.assign({ durationMs: 2000 }, html("The puzzle", WIPE_ON)), { preset: "bar-chart", durationMs: 4600 }, Object.assign({ durationMs: 2400 }, html("The reveal", SCALE_IN)), { preset: "end-card", durationMs: 3000 }] }, {}, "ok");

section("Narration");
expect("narration: every line the same length", lintNarration(["Bread rises because yeast eats the sugar inside.", "The gas it makes gets trapped in the dough.", "Heat then sets the bubbles into a soft crumb.", "That is why fresh bread feels so light today."]), { verdict: "slop", has: ["every-line-same-length"] });
expect("narration: every line between 6 and 14 words", lintNarration(["Bread rises because yeast eats sugar.", "The gas that comes off it gets trapped inside the stretchy dough.", "Heat sets those bubbles into a crumb.", "And that is why a fresh loaf feels so light in your hand.", "Now you know what the yeast is doing."]), { verdict: "slop", has: ["every-line-medium"] });
expect("narration: no long line", lintNarration(["Why does bread rise?", "Yeast eats the sugar in the dough.", "The gas has nowhere to go, so it pushes out.", "So the dough swells."]), { verdict: "tells", has: ["line-length-mix"] });
expect("narration: no short line", lintNarration(["Bread rises because yeast eats the sugar inside it.", "The gas it gives off has nowhere to go, so it pushes the dough out from the inside.", "Heat then sets all of those bubbles.", "And that is why a fresh loaf feels light."]), { verdict: "tells", has: ["line-length-mix"] });
expect("narration: a long line with no breath", lintNarration(["Yeast eats the sugar in the dough and the gas it gives off has nowhere to go so the dough swells up."]), { verdict: "tells", has: ["no-breath"] });
expect("narration: a short and a long line, with breaths", lintNarration(["Why does bread rise?", "Yeast eats the sugar in the dough, and the gas it gives off has nowhere to go.", "So the dough swells.", "Then the oven sets every bubble in place... and that's your crumb."]), "ok");
expect("narration: lines as objects", lintNarration([{ text: "Italy, 1957.", scene: 1 }, { text: "We cross the border at dawn, and by noon the whole northern front has folded in on itself.", scene: 2 }, { text: "We take the peninsula.", scene: 3 }, { text: "Rome is next, if the supply line holds.", scene: 4 }]), "ok");
expect("narration: one line is not nagged", lintNarration(["We invaded Italy."]), "ok");
expect("narration: two lines of one length are not nagged", lintNarration(["We roll north and take the city.", "Then we turn east toward the river."]), "ok");
expect("narration: three lines of mixed length", lintNarration(["Italy, 1957.", "We roll north and take the city.", "Nobody stops us."]), "ok");
expect("narration: a dash counts as a breath", lintNarration(["We cross the border at dawn with everything we have - and by noon the whole northern front has folded in on itself."]), "ok");

section("Audio plan");
expect("audio: bed at default level under voice lines", lintAudioPlan([{ audioId: "v1", scene: 1 }, { audioId: "v2", scene: 2 }, { audioId: "m", loop: true }]), { verdict: "slop", has: ["music-over-voice"] });
expect("audio: duck does not lower a bed in an animation", lintAudioPlan([{ audioId: "v1", scene: 1 }, { audioId: "m", loop: true, volume: 1, duck: 0.2 }]), { verdict: "slop", has: ["music-over-voice"] });
expect("audio: bed at 0.6 under voice", lintAudioPlan([{ audioId: "v1", scene: 1 }, { audioId: "m", loop: true, volume: 0.6 }]), { verdict: "tells", has: ["bed-loud-under-voice"] });
expect("audio: bed at 0.25 under voice", lintAudioPlan([{ audioId: "v1", scene: 1 }, { audioId: "v2", scene: 2 }, { audioId: "m", loop: true, volume: 0.25 }]), "ok");
expect("audio: voice lines only", lintAudioPlan([{ audioId: "v1", scene: 1 }, { audioId: "v2", scene: 2 }]), "ok");
expect("audio: one song alone", lintAudioPlan([{ audioId: "m", loop: true }]), "ok");
expect("audio: a voice line set to loop", lintAudioPlan([{ audioId: "v1", scene: 1, loop: true }]), { verdict: "tells", has: ["voice-looped"] });
expect("audio: audioIds with a known voice and bed", lintAudioPlan([], { audioIds: ["v", "m"], tracks: { v: "voice", m: "music" } }), { verdict: "slop", has: ["music-over-voice"] });
expect("audio: the person asked for loud music", lintAudioPlan([{ audioId: "v1", scene: 1 }, { audioId: "m", loop: true }], { asked: "keep the music at full volume, I like it loud" }), "ok");
expect("audio: no tracks", lintAudioPlan([]), "ok");

// ------------------------------------------------- bad input and long input

section("Bad input and long input");
{
  const tries = [
    ["lintCopy(null)", () => lintCopy(null)],
    ["lintCopy of mixed junk", () => lintCopy([null, 5, {}, undefined, ["x"], { text: "Quill", where: "scene 2" }], { kind: "nonsense", asked: 7, allow: "emoji" })],
    ["visibleText(123)", () => visibleText(123)],
    ["visibleText of broken markup", () => visibleText("<div><h1>Quill<p>A notebook <b>app</div><script>var s = 'unterminated")],
    ["lintScenes of junk", () => lintScenes([null, 1, "a", {}, { html: 5, css: {}, js: [], durationMs: "abc", transition: 9 }])],
    ["lintScenes(not a list)", () => lintScenes("scenes")],
    ["lintNarration of junk", () => lintNarration([null, 4, {}, { text: null }, ""])],
    ["lintNarration(not a list)", () => lintNarration("We invaded Italy.")],
    ["lintAudioPlan of junk", () => lintAudioPlan([null, "x", {}, { audioId: 5, volume: "loud", scene: "two" }], { audioIds: "x", tracks: 4 })],
    ["lintVideoPlan of junk", () => lintVideoPlan({ scenes: [null, { preset: "no-such-preset" }, { preset: 7 }], audios: "x", audioIds: [null], lines: [null, {}], transition: {} }, { asked: {}, allow: 3 })],
    ["lintVideoPlan(a string)", () => lintVideoPlan("plan")],
  ];
  for (const [name, fn] of tries) {
    let error = "";
    let result;
    try {
      result = fn();
    } catch (e) {
      error = String((e && e.stack) || e).split(/\r?\n/).slice(0, 2).join(" ");
    }
    const shaped = !error && (Array.isArray(result) || (result && typeof result.verdict === "string" && Array.isArray(result.problems)));
    report(shaped, "does not throw: " + name, error);
  }
  const long = [];
  for (let i = 0; i < 12; i += 1) long.push(("The dough rests for an hour, and while it rests the yeast keeps working, so the bubbles grow and the gluten relaxes and nothing else needs to happen " + "and then ".repeat(40)).slice(0, 600));
  const bigHtml = "<div>" + "<p class=\"row\"><span>Mon</span> Call the dentist back &amp; buy coffee filters</p>".repeat(1500) + "</div><style>" + ".row{animation:up 600ms ease both}".repeat(800) + "</style><script>" + "var a = \"x\"; a.b = [1, 2, 3];".repeat(1500) + "</script>";
  const started = Date.now();
  lintCopy(long, { kind: "script", asked: long.join(" ") });
  lintNarration(long);
  const texts = visibleText(bigHtml);
  lintCopy(texts, { kind: "card", asked: "" });
  lintVideoPlan({ scenes: Array.from({ length: 8 }, () => ({ html: bigHtml.slice(0, 20000), css: ".row{animation:up 600ms ease both}@keyframes up{from{opacity:0}to{opacity:1}}".repeat(200), durationMs: 3000 })) });
  const took = Date.now() - started;
  report(took < 4000, "long input stays fast", took + " ms for 12 lines of 600 characters, a 100 KB page and 8 heavy scenes");
}

// ------------------------------------------------------- shipped material

section("Shipped material (templates, presets, skill examples)");
// Findings already known in shipped files. They are reported, not hidden: a
// soft tell here is real, and the file is not this test's to change.
const KNOWN_SHIPPED = new Set(["card template subscribe-cta: bait-question"]);
function shipped(label, result) {
  checkShape(result, label);
  const mine = [...new Set(result.problems.map((p) => label + ": " + p.rule))];
  const fresh = mine.filter((f) => !KNOWN_SHIPPED.has(f));
  for (const p of result.problems) findings.push(label + ": " + (p.hard ? "hard " : "soft ") + p.rule + ". " + p.what);
  report(!fresh.length && result.verdict !== "slop", "shipped: " + label, fresh.length ? "flagged " + brief(result) + result.problems.map((p) => "\n       " + p.rule + ": " + p.what).join("") : mine.length ? "known finding: " + rulesOf(result).join(", ") : "");
}
{
  const templates = require(path.join(appRoot, "lib", "card-templates")).TEMPLATES;
  report(templates.length >= 10, "card templates were found", templates.length + " templates");
  for (const t of templates) {
    const c = (t.card && t.card.composition) || {};
    const texts = Object.keys(c).filter((k) => typeof c[k] === "string" && !["aspectRatio", "surface", "align"].includes(k)).map((k) => c[k]).filter((v) => v.trim());
    shipped("card template " + t.id, lintCopy(texts, { kind: "card", asked: "" }));
    shipped("card template name " + t.id, lintCopy([t.name, t.card.name].filter(Boolean), { kind: "name" }));
  }
  const presets = require(path.join(appRoot, "lib", "animation-presets"));
  for (const name of presets.PRESET_NAMES) {
    const built = presets.buildPreset(name, {}, {});
    const texts = visibleText((built.html || "") + "\n<style>" + (built.css || "") + "</style>\n<script>" + (built.js || "") + "</script>");
    report(texts.length > 0, "preset " + name + " has readable text", JSON.stringify(texts));
    shipped("preset default " + name, lintCopy(texts, { kind: "card", asked: "" }));
    shipped("preset alone " + name, lintVideoPlan({ preset: name }, {}));
  }
  // skills/explainer: the example lengths and the audio it tells the agent to pass.
  shipped("explainer example lengths 2.2, 3.6, 2.0, 5.0, 3.2", lintScenes([2200, 3600, 2000, 5000, 3200].map((durationMs, i) => Object.assign({ durationMs, transition: ["cut", "fade", "wipe", "cut", "fade"][i] }, html("Beat", [SCALE_IN, FADE_UP, WIPE_ON, "", FADE_UP][i])))));
  shipped("explainer narrated audio example", lintAudioPlan([{ audioId: "a", scene: 1 }, { audioId: "b", scene: 2 }, { audioId: "bed", volume: 0.25, loop: true }]));
  shipped("explainer placeholder", lintCopy(["Your stat here"], { kind: "card", asked: "an explainer about our pricing" }));
  shipped("explainer clip name", lintCopy(["Pricing explainer"], { kind: "name" }));
  // skills/game-narration: the Right column and the line it recommends.
  for (const line of ["We invaded Italy.", "We push the front into Italy.", "Italy, 1957. We take the peninsula.", "We roll north and take the city.", "We take the city"]) shipped("game-narration line \"" + line + "\"", lintCopy([line], { kind: "script" }));
  // skills/writing-slop: the CTA and caption examples.
  for (const line of ["Download JV", "Watch part 2", "Subscribe", "Visit example.com"]) shipped("writing-slop CTA \"" + line + "\"", lintCopy([line], { kind: "cta" }));
  shipped("writing-slop caption \"Cutting the first clip\"", lintCopy(["Cutting the first clip"], { kind: "card" }));
  // And the lines those skills name as wrong.
  copyCase("writing-slop bad caption", ["Watch the magic unfold"], { kind: "card" }, { verdict: "slop" });
  copyCase("writing-slop bad CTA", ["Get started today and unlock..."], { kind: "cta" }, { verdict: "slop" });
  planCase("video-slop bad lengths 3, 3, 3, 3", { scenes: [3000, 3000, 3000, 3000].map((durationMs, i) => Object.assign({ durationMs, transition: ["cut", "wipe", "fade", "fade"][i] }, html("Beat", [SCALE_IN, FADE_UP, WIPE_ON, ""][i]))) }, {}, { verdict: "slop", has: ["equal-scene-lengths"] });
}

// -------------------------------------------------- how the gate calls us

section("Stable output for the gate");
{
  const a = lintCopy(["Quill", "Unlock your potential"], { kind: "card" });
  const b = lintCopy(["Unlock your potential"], { kind: "card" });
  const key = (r) => r.problems.map((p) => p.rule + "\n" + p.what).sort().join("\n\n");
  report(key(a) === key(b), "a problem's rule and what do not change with the line's place in the list", key(a) === key(b) ? "" : key(a) + " vs " + key(b));
  const once = lintCopy(["It's not just an app, it's a revolution"], { kind: "card" });
  report(once.problems.filter((p) => p.rule === "not-just-but").length === 1, "one frame on one line is one problem", brief(once));
  const crowd = lintCopy(["Join thousands of happy creators"], { kind: "card" });
  report(crowd.problems.length === 1, "one tell is not reported under two rule ids", brief(crowd));
  const plan = { scenes: ["kinetic-title", "counter-stat", "word-slam", "end-card"].map((preset) => ({ preset, durationMs: 3000 })) };
  report(JSON.stringify(lintVideoPlan(plan)) === JSON.stringify(lintVideoPlan(plan)), "the same plan gives the same result twice");
  const fix = lintVideoPlan(plan).problems.map((p) => p.fix).join(" ");
  report(/scene \d/.test(fix) && /\d s\b/.test(fix), "a pacing fix names scene numbers and seconds", fix);
}

// ------------------------------------------------------------------ corpus

function sceneTexts(scene) {
  let h = String(scene.html || "");
  let c = String(scene.css || "");
  let j = String(scene.js || "");
  if (!h.trim() && scene.preset) {
    try {
      const built = require(path.join(appRoot, "lib", "animation-presets")).buildPreset(scene.preset, scene.presetParams || {}, { durationMs: scene.durationMs });
      h = built.html || "";
      c = built.css || "";
      j = built.js || "";
    } catch {
      /* an unknown preset has no text */
    }
  }
  return visibleText(h + "\n<style>" + c + "</style>\n<script>" + j + "</script>");
}

if (corpusDir) {
  section("Corpus (" + corpusDir + ")");
  const files = fs.existsSync(corpusDir) ? fs.readdirSync(corpusDir).filter((f) => f.endsWith(".json")).sort() : [];
  report(files.length > 0, "the corpus folder has files", files.length + " files");
  for (const file of files) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(corpusDir, file), "utf8"));
    } catch (error) {
      report(false, "corpus: " + file, "not JSON: " + error.message);
      continue;
    }
    const scenes = Array.isArray(data.scenes) && data.scenes.length ? data.scenes : [data];
    const results = [];
    const plan = checkShape(lintVideoPlan(data, { asked: "" }), file + " plan");
    results.push(["plan", plan]);
    const all = [];
    scenes.forEach((scene, i) => {
      const texts = sceneTexts(scene);
      all.push(...texts);
      results.push(["scene " + (i + 1) + " copy", checkShape(lintCopy(texts, { kind: "card", asked: "" }), file + " scene " + (i + 1))]);
    });
    results.push(["all copy", checkShape(lintCopy(all, { kind: "card", asked: "" }), file + " all copy")]);
    if (Array.isArray(data.lines) && data.lines.length) results.push(["script", checkShape(lintCopy(data.lines.map((l) => (typeof l === "string" ? l : l.text)), { kind: "script", asked: "" }), file + " script")]);
    const problems = [];
    for (const [part, r] of results) for (const p of r.problems) if (!problems.some((x) => x.rule === p.rule && x.what === p.what)) problems.push(Object.assign({ part }, p));
    const hard = problems.filter((p) => p.hard);
    const soft = [...new Set(problems.filter((p) => !p.hard).map((p) => p.rule))];
    const blocked = hard.length > 0 || soft.length >= 3;
    const list = problems.map((p) => "\n       " + (p.hard ? "hard " : "soft ") + p.rule + " (" + p.part + "): " + p.what).join("");
    if (/^good-/i.test(file)) report(problems.length === 0, "corpus good: " + file, problems.length ? "flagged" + list : "");
    else if (/^slop-/i.test(file)) report(blocked, "corpus slop: " + file, blocked ? hard.length + " hard, " + soft.length + " soft rules" + (quiet ? "" : list) : "not caught" + list);
    else if (!quiet) console.log("INFO " + file + ": " + (blocked ? "slop" : problems.length ? "tells" : "ok") + list);
  }
}

// ----------------------------------------------------------------- summary

if (findings.length) {
  console.log("\nFindings in shipped material:");
  for (const f of [...new Set(findings)]) console.log("  " + f);
}
console.log("\n" + passed + " passed, " + failed + " failed" + (shapeErrors ? " (" + shapeErrors + " shape errors)" : ""));
process.exit(failed ? 1 : 0);
