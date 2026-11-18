---
name: style-synthwave
description: Visual style Synthwave: 80s neon sunset, striped sun and a glowing grid. Read when the user asks for this look on cards, animations or thumbnails.
icon: palette
title: Synthwave style
about: How the agent makes cards and animations look synthwave.
group: Styles
---

# Synthwave style

80s neon sunset, striped sun and a glowing grid. Use this look for cards (`jeditor_set_card_html`) and code animations (`jeditor_render_animation`) when the user asks for it. `example.png` in this folder shows the look. Read `card-design`, `html-cards` or `code-animation` for the tools; this skill only sets the look. Read `design-slop` first so the style does not turn into the default AI look.

## The look

Synthwave retro 1980s aesthetic, neon pink and cyan, striped gradient sunset sun, glowing perspective grid floor, dark purple sky with stars, outrun style.

Avoid: Daylight, muted colors, realism.

## Palette

`#0d0221` night, `#3a0f5c` purple, `#ff2a6d` hot pink, `#ff71ce` pink, `#fff35c` sun top, `#ff9e3d` sun middle, `#05d9e8` cyan grid, `#b967ff` violet, `#1a0b3d` mountains

Pass the main colors as `primary`, `secondary` and `text` so the user can still restyle the card. Over footage, keep a plate behind type (see `color-on-video`) unless the style itself makes the type readable.

## How to build it in HTML and CSS

- Background: a dark purple to hot pink gradient sky, a striped gradient sun (`linear-gradient` plus a `repeating-linear-gradient` mask), and a perspective grid (`transform: perspective(...) rotateX(...)` on a grid of lines).
- Glow everything: `box-shadow` and `text-shadow` in pink and cyan.
- Type: heavy italic retro lettering. Installed fonts only: `"Segoe UI Black", Impact, "Arial Black", sans-serif` set italic with `transform: skewX(-10deg)`. A cyan-to-pink fill on one word is allowed (`background-clip: text`); the rest of the type is solid.
- Slop check: this style is the one place purple, pink and cyan belong, but do not stack glow on the sun, the grid, the type and the plate all at once. Pick one glowing element. The sun is striped and flat, the grid fades with distance, and the text sits on a dark plate.
- Motion: grid scrolls toward the viewer in a loop, sun rises slowly, titles slide in with a scanline flicker.

## Check

Render the card or a frame of the animation and compare with `example.png`: does it read as synthwave at a glance, and is the text still easy to read? Fix what does not.
