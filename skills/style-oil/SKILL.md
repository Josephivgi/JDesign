---
name: style-oil
description: Visual style Oil Painting: Thick, visible brush strokes and rich layered color. Read when the user asks for this look on cards, animations or thumbnails.
icon: palette
title: Oil Painting style
about: How the agent makes cards and animations look oil painting.
group: Styles
---

# Oil Painting style

Thick, visible brush strokes and rich layered color. Use this look for cards (`jeditor_set_card_html`) and code animations (`jeditor_render_animation`) when the user asks for it. `example.png` in this folder shows the look. Read `card-design`, `html-cards` or `code-animation` for the tools; this skill only sets the look. Read `design-slop` first so the style does not turn into the default AI look.

## The look

Oil painting on canvas, thick impasto brush strokes, rich layered color, painterly texture, impressionist light.

Avoid: Flat colors, vector art, smooth digital gradients.

## Palette

`#d8c8a8` canvas, `#4f7fb8` deep sky, `#a9c5df`, `#f2d9a6` warm horizon, `#ffcf5c` sun, `#6e6a9e` far, `#3d5a6c` near, `#7a9a3c` field, `#2f5f2f` leaves, `#4a2e1d` bark

Pass the main colors as `primary`, `secondary` and `text` so the user can still restyle the card. Over footage, keep a plate behind type (see `color-on-video`) unless the style itself makes the type readable.

## How to build it in HTML and CSS

- Paint the background as a gradient, then overlay many small rotated, rounded rectangles (brush dabs) in close tones, generated in script, for impasto texture.
- A canvas weave texture: two crossing `repeating-linear-gradient` lines at 3 to 5 percent opacity.
- Warm, layered light: a radial glow (`radial-gradient`) from the light source in a pale gold.
- Type: a classic serif in cream or deep umber on a soft painted plate. Installed fonts only: `Georgia, "Palatino Linotype", Constantia, serif`. Gold-leaf accent lines suit titles. No Garamond, it is not on the computer.
- Slop check: no glow, no gradient text. Gold is a flat ochre, not a shiny gradient. Keep the plate small and low, not a centered frame around everything.
- Motion: slow camera-like drift (translate and scale 1 to 1.04 over the whole card), gentle crossfades. Nothing snappy.

## Check

Render the card or a frame of the animation and compare with `example.png`: does it read as oil painting at a glance, and is the text still easy to read? Fix what does not.
