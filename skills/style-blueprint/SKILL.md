---
name: style-blueprint
description: Visual style Blueprint: White technical lines, dimensions and a grid on blue. Read when the user asks for this look on cards, animations or thumbnails.
icon: palette
title: Blueprint style
about: How the agent makes cards and animations look blueprint.
group: Styles
---

# Blueprint style

White technical lines, dimensions and a grid on blue. Use this look for cards (`jeditor_set_card_html`) and code animations (`jeditor_render_animation`) when the user asks for it. `example.png` in this folder shows the look. Read `card-design`, `html-cards` or `code-animation` for the tools; this skill only sets the look. Read `design-slop` first so the style does not turn into the default AI look.

## The look

Technical blueprint drawing, thin white lines on deep blue paper, grid, dimension lines with measurements, title block, engineering schematic style.

Avoid: Color fills, shading, painting, photorealism.

## Palette

`#1f4e8c` blueprint blue, `#eaf4ff` line white, `#ffffff` grid at 13 to 28 percent opacity

Pass the main colors as `primary`, `secondary` and `text` so the user can still restyle the card. Over footage, keep a plate behind type (see `color-on-video`) unless the style itself makes the type readable.

## How to build it in HTML and CSS

- Blue background with a two-level grid (`linear-gradient` lines, fine and major).
- All shapes as thin white outlines. Callouts with arrowheads and measurements.
- Type: uppercase technical labels and a title block in a corner. Installed fonts only: `Consolas, "Cascadia Mono", "Lucida Console", monospace` for labels and `Bahnschrift, "Segoe UI", sans-serif` for the title. No Roboto Mono or IBM Plex Mono.
- Slop check: no glow on the lines, no cyan-on-black. This is white line on blue paper, flat. Do not center the title: it lives in the title block.
- Motion: lines draw on with `stroke-dashoffset`, dimension labels type in. Precise, linear easing.

## Check

Render the card or a frame of the animation and compare with `example.png`: does it read as blueprint at a glance, and is the text still easy to read? Fix what does not.
