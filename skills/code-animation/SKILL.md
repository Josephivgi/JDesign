---
name: code-animation
description: Make a whole video out of code when there is no footage, motion graphics, title sequences, logo stings, kinetic type, and animated explainers written in HTML, CSS, and script, rendered with jeditor_render_animation.
icon: sparkles
command: animate
label: Animate from scratch
hint: What it should show
group: Animation
next: review, voiceover, improve
title: Animation from scratch
about: How the agent makes motion graphics with no footage.
---

# Animations from code

No footage, nothing pinned: `jeditor_render_animation` turns a document you write
into a real video. Use it for an animation, intro, sting, title video, motion
graphics, or loop.

For a card that floats on footage use `card-design` and `html-cards`; that path
burns onto a clip, this one needs none.

## Start from a preset

`jeditor_animation_presets` lists finished designs: `kinetic-title`,
`logo-sting`, `lower-third`, `counter-stat`, `bar-chart`, `word-slam`,
`typewriter-quote`, `end-card`.

- Quick: `jeditor_render_animation` with `preset`, `presetParams` (e.g.
  `{title, subtitle}`), and `colors`.
- Tweak: quick plus `css` or `js`, added on top: your css comes after the preset's
  (so it wins), your js runs after its script in its own scope (query the DOM), and
  your `drawAt(t)` runs after the preset's.
- Custom: `jeditor_animation_presets` with `name` returns the html, css, and js;
  change it and pass all three, html included, so it replaces the preset.

A `design` in the project context (Home gallery) changes the same way: same
`preset`, the `projectId`, only what changes; JV keeps the rest, swaps the old clip
out, and updates the saved design so Edit design matches. That render is the
project's finished video, so skip `jeditor_render_project` unless you edit the
timeline. Long code is left out of the context, so read `state.design` with
`jeditor_get_project` first; css or js you pass replace the saved ones, and audio
replaces as a group (pass the full set, or `audios: []` to remove it).

`scriptErrors` means the clip or stills saved but some motion did not; fix the
named error and render again.

Without `replaceClipId`, `html` or another preset makes a second clip; pass
`asNewClip: true` to keep the first. To change a clip in the project, pass
`replaceClipId` and only the fields that change. A preset is a starting point:
change copy, timing, and colors, and say which one you started from.

## Several scenes: explainers, promos, recaps

One preset is one beat of 3 to 5 s. An explainer, promo, recap, or anything with
"then" in it wants `scenes`; its item schema carries every field.

1. One line per beat: hook, two to four points, close. Pick the preset that fits
   (a number `counter-stat`, a comparison `bar-chart`, a claim `word-slam`, a
   quote `typewriter-quote`) or write html for a beat none covers.
2. Mix lengths: 2 to 2.5 s, 3 to 4 s, one held 4.5 to 6 s, never under the
   preset's `minMs` (a shorter scene is raised, with a note). The longest is at
   least 1.6 times the shortest. A param the preset does not read comes back in the
   note.
3. One palette: `colors` at the top level, not per scene.
4. Transitions per scene: at least one `cut`; `slide`, `wipe`, `zoom`, or `circle`
   once each to mark a section; `fade` only for a soft change. Never the same
   transition twice in a row. Neighbouring scenes get different entrances and
   layouts. Read `video-slop`.
5. Voiceover: one line per scene in one `jeditor_tts` call, `lines: [{text,
   scene}]` (one approval), and its `audios` at the top level, never inside a
   scene: each line starts with its scene and a scene shorter than its line grows.

One scene changes by sending the full `scenes` list with it changed and
`replaceClipId`. A lone `preset` or `html` on a scene clip turns it back into one
beat.

## The loop

1. Write `html`, `css`, and (only if the motion needs math) `js`.
2. `jeditor_animation_frames` with `asImage: true`, at the `timesMs` you name or
   four moments over the duration; for a gallery design pass the same `preset` and
   the `projectId`. Fix clipping, contrast, dead space, text off the safe area, an
   element that never appeared, and a last pose that reads as broken because motion
   was still running when the video ended.
3. `jeditor_render_animation` with the same code. JV keeps the code with the clip:
   `jeditor_get_library_item` returns it as `animationSource` later.
4. It lands in Videos and images, so no `jeditor_add_finished_video`. Render the
   project (`jeditor_render_project`) for Finished videos, or
   `jeditor_compose_finished` to play it with other clips. With `projectId` it also
   becomes that project's clip, so cuts, framing, and zooms apply.

Read `type-layout` and `color-on-video` before the markup, and `motion-graphics`
for the movement: one lead motion, stagger the elements, hold the last pose.

## What renders

A real browser engine, one frame per video frame, at the ratio you ask for
(`aspectRatio`, `durationMs`, `fps`: see the tool schema). Two limits are not
there: one render is capped at 900 frames, so 30 s at 30 fps and 37.5 s at 24, and
`fps` below 30 only makes sense for a deliberate stepped look.

Size in `vmin` (or `vw`/`vh`) as the presets do, so one design reads at every
ratio. Px only for a single-ratio render (1080x1920 wants 60 to 140 px display
type).

## Timing: hook, build, hold

Plan three beats on the real `durationMs`:

1. Hook (first 0.3 s): something moves or reads at once. Never open on an empty
   frame or a slow fade from nothing.
2. Build (to about 60 percent): the rest arrive one beat at a time, 250 to 450 ms
   apart.
3. Hold: the finished pose, readable. Anything that leaves leaves 0.5 to 0.8 s
   before the end, timed from `durationMs`, not a fixed second.

For a longer render spread the build, do not extend the hold: a 10 s animation
whose motion ends at 2 s is 8 s of a still. Presets follow the length you pass.
Before rendering, look at `jeditor_animation_frames` at `durationMs - 100`: it must
be a designed resting pose, not a mid-move one.

## Motion

CSS keyframes are the main tool and they are exact: the renderer pauses every
animation and seeks it, so a frame at 1.5 s shows the animation 1.5 s in. Then
`animation-fill-mode: both` holds the first pose before the start and the last
after the end, every animation stays inside `durationMs` (anything moving at the
end is cut off mid-pose), and `animation-delay` staggers by beat: hook at 0 s,
qualifier at 0.35 s, CTA at 0.7 s. Transforms and opacity land cleanly; avoid
animating layout properties (width, top) when a transform will do. A `transition`
has nothing to trigger it: nothing hovers in a render.

Do not start CSS motion from script (adding a class that animates, or
`element.animate()`): it runs on the wall clock and comes back as a `css motion`
script error. Set the style in `drawAt(t)` with `JV.tween` instead.

## Script

`js` runs before each frame is captured, on a virtual clock, so the render is the
same on any machine:

- `performance.now()`, `Date.now()`, and `requestAnimationFrame` report the frame's
  page-time, not wall time.
- `window.drawAt = function (t) { ... }` is called with the frame time in ms before
  every capture.
- `setTimeout` and `setInterval` run on that clock (1000 ms fires at the 1 s
  frame), but compute every pose from `t` in `drawAt`: only that is exact at every
  frame.
- SVG SMIL (`<animate>`, `<animateTransform>`) does not follow the frame clock.
  Animate SVG attributes from `drawAt(t)` or with CSS keyframes.

Scripts run for animations only. Edit cards strip them, so a card that burns onto
footage stays HTML and CSS.

## The motion kit

Every animation page has `window.JV`:

- **Letters and words, no script**: `data-split="chars"` wraps each letter in
  `.jv-char` with `--i` (`--n` on the parent is the count, for reverse staggers);
  `data-split="words"` wraps `.jv-word`. Stagger with
  `animation-delay: calc(var(--i) * 40ms)`. The split runs before your script, so
  `querySelectorAll(".jv-char")` works. It is plain text: a `<br>` or `<em>` inside
  is dropped, so each styled run gets its own `data-split` element.
- `JV.ease.<name>`: linear, inQuad, outQuad, inOutQuad, inCubic, outCubic,
  inOutCubic, outQuart, inOutQuart, outQuint, inExpo, outExpo, inOutExpo, outCirc,
  inBack, outBack, inOutBack, outElastic, outBounce.
- `JV.progress(t, start, dur, ease)` gives 0 to 1, linear unless you pass an ease
  (pass one: linear motion looks mechanical); `JV.tween(t, start, dur, from, to,
  ease)` gives a value between, `outCubic` by default; `JV.spring(t, start,
  {stiffness, damping, mass})` a springy 0 to 1 that can overshoot, for pops;
  `JV.keyframes(t, [[0, 0], [400, 1.2], [700, 1]])` steps through values;
  `JV.count(t, start, dur, to, {prefix, suffix, decimals})` counts a number with
  thousands separators; `JV.stagger(i, each, from)`, `JV.lerp`, `JV.clamp`,
  `JV.map`; `JV.random(seed)` a repeatable random stream for particles.

`Math.random` is seeded, and a render is split across workers, so pick random
values once at load, not in `drawAt`, or they change every frame.

## Images, colors, and variables

- `{{image:<libraryId>}}` in `html` or `css` expands to a library image, so
  `<img src="{{image:li_9f2}}">` needs no upload step. Get ids with
  `jeditor_list_library` `kind: "image"`.
- `colors: {primary, secondary, text}` reach the page as `var(--primary)`,
  `var(--secondary)`, `var(--text)`; `vars: {accent: "#FFB454"}` adds `var(--accent)`.

No network, no external font: the page cannot load a URL, a Google font, or a
remote image. Use system fonts (`system-ui`, `Segoe UI`, `Georgia`), inline SVG, and
CSS shapes.

## Sound

`jeditor_tts` makes a voiceover and `jeditor_music` a bed; attach either with
`audioId`, or several with `audioIds`/`audios` (a voiceover over a bed). Read
`audio-voiceover` before writing narration, and check with `jeditor_probe_audio`
when the sound matters.
