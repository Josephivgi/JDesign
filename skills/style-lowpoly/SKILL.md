---
name: style-lowpoly
description: Visual style Low Poly: Faceted triangles, like a simple 3D model. Read when the user asks for this look on cards, animations or thumbnails.
icon: palette
title: Low Poly style
about: How the agent makes cards and animations look low poly.
group: Styles
---

# Low Poly style

Faceted triangles, like a simple 3D model. Use this look for cards (`jeditor_set_card_html`) and code animations (`jeditor_render_animation`) when the user asks for it. `example.png` in this folder shows the look. Read `card-design`, `html-cards` or `code-animation` for the tools; this skill only sets the look. Read `design-slop` first so the style does not turn into the default AI look.

## The look

Low poly art, faceted triangular polygons, each facet a flat color, geometric 3D look, clean edges.

Avoid: Smooth surfaces, high detail, photorealism, organic texture.

## Palette

`#9ad0ec` sky, `#e8f6fd`, `#ffd23f` sun, `#ffbe0b`, `#6c5b7b` far, `#8f7aa3` far lit, `#355c7d` near, `#4f7ea8` near lit, `#76b852` grass, `#2e8b57` tree, `#6d4c41` trunk

Pass the main colors as `primary`, `secondary` and `text` so the user can still restyle the card. Over footage, keep a plate behind type (see `color-on-video`) unless the style itself makes the type readable.

## How to build it in HTML and CSS

- Generate the background in script: a jittered grid of SVG triangles, each colored from a gradient with small random shifts.
- Shapes on top are faceted: polygons split into 3 to 6 triangles with light and dark faces.
- Type: bold geometric sans, possibly on a faceted plate (a polygon `clip-path`). Installed fonts only: `"Segoe UI Black", "Arial Black", Bahnschrift, sans-serif`.
- Slop check: facets get flat fills from one palette, not a rainbow or a purple-blue gradient across the faces. No glow along the edges. Use unequal polygons, not a regular grid of triangles.
- Motion: facets flip or fade in with a stagger from one corner, or slowly shift color. Rotations around Y suit logos.

## Check

Render the card or a frame of the animation and compare with `example.png`: does it read as low poly at a glance, and is the text still easy to read? Fix what does not.
