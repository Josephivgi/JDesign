---
name: style-anime
description: Visual style Anime: Clean cel shading, bright skies and big fluffy clouds. Read when the user asks for this look on cards, animations or thumbnails.
icon: palette
title: Anime style
about: How the agent makes cards and animations look anime.
group: Styles
---

# Anime style

Clean cel shading, bright skies and big fluffy clouds. Use this look for cards (`jeditor_set_card_html`) and code animations (`jeditor_render_animation`) when the user asks for it. `example.png` in this folder shows the look. Read `card-design`, `html-cards` or `code-animation` for the tools; this skill only sets the look. Read `design-slop` first so the style does not turn into the default AI look.

## The look

Anime background art, cel shading with hard shadow edges, vibrant saturated colors, dramatic cumulus clouds, clean crisp shapes, Japanese animation style.

Avoid: Photorealism, muddy colors, sketchy lines.

## Palette

`#1c64d8` sky top, `#5aa8f0` sky, `#bfe3ff` horizon, `#ffffff` clouds, `#c7dcf5` cloud shade, `#8fa6d6` far mountains, `#4f7cad` near, `#5cc24a` grass, `#46a63a` grass shade, `#2f8f44` tree, `#48b25a` tree light

Pass the main colors as `primary`, `secondary` and `text` so the user can still restyle the card. Over footage, keep a plate behind type (see `color-on-video`) unless the style itself makes the type readable.

## How to build it in HTML and CSS

- Background: a tall blue sky gradient with big white clouds built from overlapping circles, a pale blue copy offset down-right for the shadow edge.
- Two-tone cel shading on every shape: a flat base plus a hard-edged darker shape (`clip-path` or a second element), no blur.
- Type: bold rounded sans in white with a thick dark outline (`-webkit-text-stroke` or stacked `text-shadow`). Installed fonts only: `"Arial Rounded MT Bold", "Trebuchet MS", "Segoe UI Black", sans-serif`. No Nunito or Poppins, they are not on the computer.
- Slop check: draw sparkle stars as CSS shapes, never emoji. One sky gradient is the style, so do not add a second gradient on the type. Keep the plate shapes cel-flat, not glass or glowing.
- Accent shapes: speed lines (`repeating-conic-gradient`) or sparkle stars behind a hook.
- Motion: quick snappy entrances (pop or slide 200 to 300 ms with a small overshoot), clouds drifting slowly behind.

## Check

Render the card or a frame of the animation and compare with `example.png`: does it read as anime at a glance, and is the text still easy to read? Fix what does not.
