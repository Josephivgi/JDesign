---
name: motion-graphics
description: Make cuts feel edited, not just trimmed, card motion presets, camera moves, animated text, flashes, fades, and CSS-animated cards. Read before adding animation to any project render or composed clip.
title: Motion and transitions
about: How the agent adds camera moves, animated text and transitions.
---

# Motion and animation

A cut with no movement reads as raw footage. Every render should have at least
one motion idea per beat: a camera move on the picture, a card that enters
with intent, text that lands on the action, or a flash on a transition.

## Do not animate everything the same way

Motion on every beat with the same entrance, the same easing, and the same
speed is the most common sign of a machine made video. Read `video-slop`.
Give each beat its own entrance, let some elements already be on screen when a
beat starts, stagger elements by different amounts instead of an even 0.1 s,
use one hard cut or `flash` where the story turns, and save the biggest move
(a `punch` zoom, a slam) for the line that earns it. Alternate busy and still.
A camera drift is not free: a perfectly linear, floaty push on every shot
reads as a screensaver, so vary its speed and start some beats static.

## Card motion presets

Cards carry `motion: {in, out}` over their own window. Presets: `none`,
`fade`, `rise`, `drop`, `slide`, `pop`. Set them on `jeditor_apply_edit`
(`patch.motion`) or `jeditor_set_card_html` (`motion`).

- `rise` in, `drop` out, lower thirds and name plates entering from below.
- `pop` in, small badges, price tags, "NEW" chips.
- `slide` in, side panels and promos.
- `fade` both ways, title cards, quotes, end cards.

Preset motion composes the whole card as one layer: the PNG or HTML design
slides, scales, or fades together. For anything that is not an animated HTML
card, this is the way to move it.

What the presets actually do, so you can time around them: each move lasts
0.4 s (or 35 percent of a short card's window), eases in and out, and fades
over the 60 percent of the move nearest the hidden side. `rise` and `drop`
travel 12 percent of the frame height, `slide` a full frame width, `pop`
grows from 80 percent on the way in and shrinks to 85 percent on the way
out. Give a card
at least 1.5 s on screen so the entrance, a readable hold, and the exit all
fit, and always set an `out` on overlays: a card that vanishes at the end of
its window reads as a glitch.

Check the motion, not just the design: `jeditor_preview_frames` at the
window start plus 0.2 s (mid entrance), the middle, and the window end minus
0.1 s (mid exit). A still from `jeditor_render_card` cannot show any of
that.

## CSS-animated cards

When a card's `composition.css` contains `@keyframes`, `animation`, or
`transition`, compose renders a frame per video frame (24 fps) and seeks the
page clock to match. Keyframes land exactly on video time. The rules:

- Keep animations inside `durationMs`, content still animating at the end is
  cut off mid-pose.
- Use `animation-fill-mode: both` so edges hold a designed pose instead of
  snapping.
- Animations start when the card appears (intro/end segment start or overlay
  window start), not at video time 0.
- Stagger elements with `animation-delay`, same as on the web.

## Camera moves on footage

Timeline ops from `jeditor_edit_timeline` move the picture itself:

- `zoom` `style: "punch"`, hard cut to 1.2-1.6× on a reaction or beat.
- `zoom` `style: "push"`, slow ease in (1.1-1.3×) for emphasis; put `x`,`y`
  on the subject (0-1 of the source frame).
- `zoom` `style: "pan"`, travels between two focus points for a Ken Burns
  drift; use `fromX`,`fromY`,`fromAmount` to aim it.
- `unzoom` clears moves in a range.

Read `jeditor_preview_frames` first, the raw frame has a focus grid at 0.25 /
0.5 / 0.75 so you can aim `x`,`y` at the actual subject instead of guessing.

## Text that lands

`text` ops burn captions and titles into the picture. `anim: "slide"` enters
from off-frame, `anim: "fade"` dissolves in. Stagger related lines by
0.3-0.6 s, a hook at 0.0 s, the qualifier at 0.4 s, rather than stacking
everything at once. `flash` adds a white beat at a timestamp; use one per hard
transition, not on every cut.

## Whole-clip edges

`fade` ops set `in` / `out` (seconds) on the finished video. Any clip meant
for publishing wants `out` ≈ 0.3-0.5 s; `in` only when the footage itself has
no intro card leading it.

## Recipes

- **Hook:** intro card 2.5 s (`fade` in) → `punch` zoom 1.3× on the first
  reaction frame → `text` hook `anim: "slide"` at outputStart 0.
- **Lower third:** overlay card `motion: {in: "rise", out: "drop"}` at 4-5 s +
  a `text` caption at the same window for what the person is saying.
- **Montage drift:** `pan` at 1.15× across each long section + `flash` on
  music beats.
- **Outro:** `fade` out 0.4 s → end card 4 s with staggered CSS `rise`
  keyframes → `sound` op with a short music bed, `loop: true`, `duck: 0.3`.

## Verify

`jeditor_preview_frames` before render to check framing and text placement,
and `jeditor_render_card` (`asImage: true`) to check card designs before
burning them. After `jeditor_render_project`, pull `jeditor_get_finished` on
the render for its duration, and when something looks off re-preview the
source `times` inside the card windows.
