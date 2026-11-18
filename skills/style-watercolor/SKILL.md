---
name: style-watercolor
description: Visual style Watercolor: Soft washes that bleed into each other on textured paper. Read when the user asks for this look on cards, animations or thumbnails.
icon: palette
title: Watercolor style
about: How the agent makes cards and animations look watercolor.
group: Styles
---

# Watercolor style

Soft washes that bleed into each other on textured paper. Use this look for cards (`jeditor_set_card_html`) and code animations (`jeditor_render_animation`) when the user asks for it. `example.png` in this folder shows the look. Read `card-design`, `html-cards` or `code-animation` for the tools; this skill only sets the look. Read `design-slop` first so the style does not turn into the default AI look.

## The look

Watercolor painting, soft wet-on-wet washes, pigment blooms and bleeding edges, visible cold-press paper texture, loose brushwork, light airy palette.

Avoid: Hard outlines, photorealism, 3D render.

## Palette

`#fbf8f1` paper, `#5aa7e0` sky, `#f39a1e` sun, `#f9c74f`, `#5b6db8` far hills, `#2f6f86` near hills, `#5f9e3a` grass, `#2d7a3a` leaves, `#5a3a24` bark

Pass the main colors as `primary`, `secondary` and `text` so the user can still restyle the card. Over footage, keep a plate behind type (see `color-on-video`) unless the style itself makes the type readable.

## How to build it in HTML and CSS

- Background is warm paper (#fbf8f1) with a faint grain: a `feTurbulence` noise layer at 4 to 8 percent opacity.
- Washes are soft blobs: `border-radius` shapes or SVG paths with `filter: blur(6px)` plus an SVG `feTurbulence` + `feDisplacementMap` filter so edges bleed and wobble.
- Stack 2 or 3 translucent washes of the same hue (opacity 0.4 to 0.7, `mix-blend-mode: multiply`) so overlaps darken.
- Type: a soft serif or hand lettering in a dark wash tone (`#2f3e5a`), never pure black. Installed fonts only: `Georgia, Constantia, serif` or `"Ink Free", cursive`. No hard plates; put type on a pale wash.
- Slop check: washes bleed and overlap unevenly, they are not a smooth blurred gradient blob. No glow and no glass. Do not center everything on the paper: let the wash run off one edge.
- Motion: washes fade and grow in slowly (scale 0.96 to 1, 600 to 900 ms, ease-out), like paint spreading. No snap or bounce.

## Check

Render the card or a frame of the animation and compare with `example.png`: does it read as watercolor at a glance, and is the text still easy to read? Fix what does not.
