// Tells whether two issues in the slop gate are the same problem, from one
// review round to the next, and gives each problem one id so the gate's
// counts (tries sent, refunds, "came back the same") follow the problem and
// not the reviewer's wording.
//
// What is trusted, in order:
// 1. the checker's rule id, when both issues carry one;
// 2. where the issue is: boxes that overlap are one object, boxes that sit
//    apart are two, whatever the words say (two lens clouds are two problems);
// 3. the item ids the reviewer named;
// 4. the thing the sentence is about, with plurals and near names folded
//    (sea, ocean, water), when there is no box to go by.
// Two issues on one object are still two problems when they are about
// different kinds of fault (a flat tower, then a floating tower), so a redraw
// that fixed the first is not put back for the second.
//
// Pure functions, no Electron: ctx is { box(issue) -> [x0, y0, x1, y1] or
// null, canvasArea }.

const STOP = new Set(("the a an is are was were be been it its this that these those and or but of in on at to as by for with from into over under behind above below near like " +
  "all both still very too so more most much many some any no not only just also even now again one two three four five six seven eight nine ten every each " +
  "flat big small large tiny huge long short wide thin thick stock plain basic simple generic whole same single main left right top bottom upper lower middle center centre far front back " +
  "dark light bright pale gray grey white black red blue green yellow orange purple brown pink").split(/\s+/));
const GROUPS = [
  ["water", "sea ocean water lake bay river pond wave swell surf waterline"],
  ["rock", "rock rocky cliff crag headland outcrop boulder stone bluff ledge"],
  ["tower", "lighthouse tower beacon"],
  ["tree", "tree pine fir forest wood foliage crown canopy"],
  ["cloud", "cloud cloudbank"],
  ["sky", "sky skie"],
  ["house", "house cottage cabin hut building barn"],
  ["boat", "boat ship sailboat vessel hull"],
  ["hill", "hill mountain ridge peak"],
  ["ground", "ground grass field meadow land shore beach sand"],
  ["picture", "picture drawing scene image composition canvas everything palette color colour layout frame"],
  ["text", "text label caption title word lettering sign"],
];
const FOLD = new Map(GROUPS.flatMap(([to, list]) => list.split(" ").map((w) => [w, to])));
const single = (w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
const wordsOf = (issue) => String((issue && issue.what) || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);

// The thing an issue is about: its first content word, folded.
function subjectOf(issue) {
  for (const w of wordsOf(issue)) {
    if (STOP.has(w) || /^\d/.test(w)) continue;
    const s = single(w);
    if (STOP.has(s)) continue;
    return FOLD.get(s) || s;
  }
  return "";
}

// The kinds of fault an issue names. Empty when the wording gives no clue.
const KINDS = [
  ["attach", /\b(float\w*|hang\w*|hover\w*|not attached|detached|disconnected|unsupported|no (support|contact|footing|base)|gaps?|joints?|almost touch\w*|apart|off the|in the air)\b/],
  ["shape", /\b(basic shapes?|primitives?|triangles?|circles?|ovals?|ellipses?|rectangles?|box(es)?|lollipops?|stacked|geometric|blobs?|silhouettes?|outlines?|polygons?|few points|lens|pill)\b/],
  ["tone", /\b(flat|one tone|single (colou?r|tone|fill)|no (shading|shadow|light|structure)|unlit|planes?|shading|shaded|values?)\b/],
  ["repeat", /\b(identical|cop(y|ies|ied)|copy pasted|repeat\w*|same (shape|size)s?|rows?|lined up|evenly spaced|grid|symmetr\w*|mirror\w*)\b/],
  ["texture", /\b(dash\w*|hatch\w*|loose lines?|random lines?|streaks?|dots?|specks?|scribbl\w*|texture)\b/],
  ["color", /\b(colou?rs?|gr[ae]y|washed|muddy|saturat\w*|oversaturat\w*|palette|garish|dull)\b/],
  ["layout", /\b(centered|centred|composition|horizon|empty|balance\w*|crowded|edge of the (canvas|frame|picture)|cropped|tangent|layout|even(ly)? (detail|busy)|same amount of detail)\b/],
  ["text", /\b(text|labels?|captions?|titles?|words?|lettering|copy)\b/],
  ["paper", /\b(white paper|bare (paper|white)|unfinished|white (band|gap|line))\b/],
  ["stock", /\b(sparkles?|half sun|swoosh\w*|orbit\w*|gradients?|wedges?|beams?|curls?|stock)\b/],
];
function kindsOf(issue) {
  const t = wordsOf(issue).join(" ");
  return KINDS.filter(([, re]) => re.test(t)).map(([k]) => k);
}
const shareKind = (a, b) => { const ka = kindsOf(a), kb = kindsOf(b); return ka.some((k) => kb.includes(k)); };
// Both name a kind of fault and no kind is shared.
const clash = (a, b) => { const ka = kindsOf(a), kb = kindsOf(b); return ka.length > 0 && kb.length > 0 && !ka.some((k) => kb.includes(k)); };

function iou(a, b) {
  if (!a || !b) return 0;
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]), h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter);
}
// Two boxes with clear space between them. A reviewer's box is rough, so
// boxes that only just miss each other do not count as apart.
function apart(a, b) {
  if (!a || !b) return false;
  const gx = Math.max(a[0], b[0]) - Math.min(a[2], b[2]), gy = Math.max(a[1], b[1]) - Math.min(a[3], b[3]);
  const slack = 0.25 * Math.min(Math.max(a[2] - a[0], a[3] - a[1]), Math.max(b[2] - b[0], b[3] - b[1]));
  return gx > slack || gy > slack;
}
const objectBox = (issue, ctx) => { const b = ctx.box(issue); return b && (b[2] - b[0]) * (b[3] - b[1]) < 0.5 * ctx.canvasArea ? b : null; };
const sharedIds = (a, b) => Array.isArray(a.ids) && Array.isArray(b.ids) && a.ids.some((id) => b.ids.includes(id));

// Same problem?
function same(a, b, ctx) {
  const A = objectBox(a, ctx), B = objectBox(b, ctx);
  if (a.rule && b.rule) return a.rule === b.rule && !apart(A, B);
  const differs = clash(a, b);
  if (A && B) {
    if (iou(A, B) >= 0.35) return !differs;
    if (apart(A, B)) return false;
  }
  if (sharedIds(a, b)) return !differs;
  const sa = subjectOf(a);
  if (sa && sa === subjectOf(b)) return !differs;
  return !!(A && B && iou(A, B) >= 0.2 && shareKind(a, b));
}

// The reviewer's "was" number is trusted only when that issue is about the
// same place, the same items or the same thing; reviewers swap the numbers.
function agrees(now, before, ctx) {
  if (now.rule && before.rule) return now.rule === before.rule;
  const A = objectBox(now, ctx), B = objectBox(before, ctx);
  if (A && B && iou(A, B) >= 0.2) return true;
  if (sharedIds(now, before)) return true;
  const s = subjectOf(now);
  return !!s && s === subjectOf(before) && !(A && B && apart(A, B));
}

// Gives every issue a problem id that stays the same across rounds.
function tracker(ctx) {
  const known = []; // { id, rep, seen }
  const ids = new WeakMap();
  let n = 0, tick = 0;
  const take = (issue, k) => { ids.set(issue, k.id); k.rep = issue; k.seen = ++tick; };
  return {
    // issues: this round's list. previous: the list the reviewer was shown
    // (its "was" numbers count from 1 in that list).
    assign(issues, previous) {
      const used = new Set(issues.map((i) => ids.get(i)).filter(Boolean));
      const todo = issues.filter((i) => !ids.has(i));
      for (const i of todo) {
        const p = Array.isArray(previous) ? previous[Number(i.was) - 1] : null;
        const k = p && known.find((e) => e.id === ids.get(p));
        if (k && !used.has(k.id) && agrees(i, p, ctx)) { take(i, k); used.add(k.id); }
      }
      for (const i of todo) {
        if (ids.has(i)) continue;
        const k = known.filter((e) => !used.has(e.id) && same(e.rep, i, ctx)).sort((p, q) => q.seen - p.seen)[0];
        if (k) { take(i, k); used.add(k.id); }
      }
      for (const i of todo) {
        if (ids.has(i)) continue;
        const k = { id: "p" + ++n, rep: i, seen: 0 };
        known.push(k);
        take(i, k);
        used.add(k.id);
      }
      return issues.map((i) => ids.get(i));
    },
    idOf(issue) {
      if (!ids.has(issue)) this.assign([issue]);
      return ids.get(issue);
    },
    // The issue in a new round that is the same problem as `pick`.
    find(issues, pick) {
      const id = this.idOf(pick);
      return issues.find((i) => i !== pick && ids.get(i) === id) || null;
    },
  };
}

// Puts the checker's rule id on the reviewer issues that are about a
// measured problem. A rule the reviewer wrote is kept only when the checker
// reported it this round. Without one, a checker issue in the same place and
// of the same kind lends its rule, when exactly one fits.
function attachRules(issues, checkerIssues, ctx) {
  const rules = new Set((checkerIssues || []).map((c) => c.rule).filter(Boolean));
  for (const i of issues) {
    if (i.rule && !rules.has(i.rule)) delete i.rule;
    if (i.rule) continue;
    const I = ctx.box(i);
    const scene = (b) => !b || (b[2] - b[0]) * (b[3] - b[1]) >= 0.5 * ctx.canvasArea;
    const fits = (checkerIssues || []).filter((c) => {
      if (!c.rule || !shareKind(i, c)) return false;
      const C = ctx.box(c);
      return scene(I) && scene(C) ? subjectOf(i) === subjectOf(c) || !C : !scene(I) && !scene(C) && iou(I, C) >= 0.5;
    });
    if (fits.length === 1) i.rule = fits[0].rule;
  }
  return issues;
}

module.exports = { same, agrees, tracker, attachRules, subjectOf, kindsOf, iou, apart };
