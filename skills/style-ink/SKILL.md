---
name: style-ink
description: Visual style Ink Line Art: Black pen lines with hatching, no color. Read when the user asks for this look on cards, animations or thumbnails.
icon: palette
title: Ink Line Art style
about: How the agent makes cards and animations look ink line art.
group: Styles
---

# Ink Line Art style

Black pen lines with hatching, no color. Use this look for cards (`jeditor_set_card_html`) and code animations (`jeditor_render_animation`) when the user asks for it. `example.png` in this folder shows the look. Read `card-design`, `html-cards` or `code-animation` for the tools; this skill only sets the look. Read `design-slop` first so the style does not turn into the default AI look.

## The look

Black ink line art, fine pen drawing, hatching and cross-hatching for shading, pure black on white, no color, clean confident lines.

Avoid: Color, gray wash, painting, blur.

## Palette

`#ffffff` paper, `#151515` ink

Pass the main colors as `primary`, `secondary` and `text` so the user can still restyle the card. Over footage, keep a plate behind type (see `color-on-video`) unless the style itself makes the type readable.

## How to build it in HTML and CSS

- White or off-white background, black lines only. Inline SVG strokes with round caps.
- Hatching patterns as SVG `<pattern>` fills of thin parallel lines at an angle; cross-hatch with a second pattern.
- Type: a pen-like serif in black. Installed fonts only: `Georgia, "Palatino Linotype", Cambria, serif`, or `"Ink Free", "Segoe Script", cursive` for a hand-inked line.
- Slop check: no gray wash and no glow. Do not scatter hatch lines evenly over everything: hatch only the shadow side of a form.
- Motion: lines draw on with `stroke-dasharray` and `stroke-dashoffset` (600 to 1200 ms), then hatching fades in.

## Check

Render the card or a frame of the animation and compare with `example.png`: does it read as ink line art at a glance, and is the text still easy to read? Fix what does not.
