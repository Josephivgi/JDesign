---
name: style-pencil
description: Visual style Pencil Sketch: Graphite on paper with soft shading and sketchy lines. Read when the user asks for this look on cards, animations or thumbnails.
icon: palette
title: Pencil Sketch style
about: How the agent makes cards and animations look pencil sketch.
group: Styles
---

# Pencil Sketch style

Graphite on paper with soft shading and sketchy lines. Use this look for cards (`jeditor_set_card_html`) and code animations (`jeditor_render_animation`) when the user asks for it. `example.png` in this folder shows the look. Read `card-design`, `html-cards` or `code-animation` for the tools; this skill only sets the look. Read `design-slop` first so the style does not turn into the default AI look.

## The look

Graphite pencil sketch, sketchy construction lines, soft hatched shading, smudged graphite on off-white sketchbook paper, monochrome.

Avoid: Color, ink, digital painting, clean vector.

## Palette

`#f4f1ea` sketchbook paper, `#3a3a3a` graphite, `#6b6b6b` soft graphite

Pass the main colors as `primary`, `secondary` and `text` so the user can still restyle the card. Over footage, keep a plate behind type (see `color-on-video`) unless the style itself makes the type readable.

## How to build it in HTML and CSS

- Paper texture background (off-white with faint noise). Lines in graphite gray, never black.
- Lines drawn as SVG paths with slight jitter, two passes per edge, and an `feTurbulence` displacement for a grainy edge.
- Type: handwriting in graphite gray. Installed fonts only: `"Ink Free", "Segoe Print", "Segoe Script", cursive`. No Caveat or Patrick Hand, they are not on the computer.
- Slop check: no color, no glow. Do not put a clean rounded card behind sketch type: the paper is the plate.
- Motion: sketch lines draw on quickly in a few strokes, shading fades in after. A slight paper wobble is fine.

## Check

Render the card or a frame of the animation and compare with `example.png`: does it read as pencil sketch at a glance, and is the text still easy to read? Fix what does not.
