---
name: style-pixel
description: Visual style Pixel Art: Chunky pixels and a small retro game palette. Read when the user asks for this look on cards, animations or thumbnails.
icon: palette
title: Pixel Art style
about: How the agent makes cards and animations look pixel art.
group: Styles
---

# Pixel Art style

Chunky pixels and a small retro game palette. Use this look for cards (`jeditor_set_card_html`) and code animations (`jeditor_render_animation`) when the user asks for it. `example.png` in this folder shows the look. Read `card-design`, `html-cards` or `code-animation` for the tools; this skill only sets the look. Read `design-slop` first so the style does not turn into the default AI look.

## The look

Pixel art, 16-bit retro video game style, chunky square pixels, limited color palette, dithered gradients, crisp edges, no anti-aliasing.

Avoid: Smooth gradients, blur, photorealism, high resolution detail.

## Palette

`#5fcde4` sky, `#7bd8ea`, `#a2e6f2`, `#fbf236` sun, `#5b6ee1` far, `#3f3f74` near, `#6abe30` grass, `#99e550` grass light, `#37946e` tree, `#8f563b` trunk, `#222034` dark

Pass the main colors as `primary`, `secondary` and `text` so the user can still restyle the card. Over footage, keep a plate behind type (see `color-on-video`) unless the style itself makes the type readable.

## How to build it in HTML and CSS

- Draw at a low resolution (a 160 by 90 or 320 by 180 grid of divs, a `<canvas>`, or box-shadow pixel art) and scale up with `image-rendering: pixelated`.
- A fixed 16-color palette. Gradients are dithered bands.
- Type: a blocky face at whole multiples of its pixel size, with `image-rendering: pixelated` and no smoothing. Installed fonts only: `"OCR A Extended", "Lucida Console", Consolas, monospace` in caps, or draw bitmap letters from a grid of squares in script. No Press Start 2P or VT323, they are not on the computer.
- Slop check: no gradients or glow, the palette is 8 to 16 flat colors. Emoji are not pixel art: draw sprites from squares.
- Motion: step animation only (`steps()` timing), moves in whole pixels, a few frames per second for sprites. Blink cursors and score counters fit.

## Check

Render the card or a frame of the animation and compare with `example.png`: does it read as pixel art at a glance, and is the text still easy to read? Fix what does not.
