---
name: style-papercut
description: Visual style Paper Cutout: Stacked paper layers with soft drop shadows. Read when the user asks for this look on cards, animations or thumbnails.
icon: palette
title: Paper Cutout style
about: How the agent makes cards and animations look paper cutout.
group: Styles
---

# Paper Cutout style

Stacked paper layers with soft drop shadows. Use this look for cards (`jeditor_set_card_html`) and code animations (`jeditor_render_animation`) when the user asks for it. `example.png` in this folder shows the look. Read `card-design`, `html-cards` or `code-animation` for the tools; this skill only sets the look. Read `design-slop` first so the style does not turn into the default AI look.

## The look

Layered paper cut art, stacked paper layers with soft drop shadows between them, smooth curved edges, pastel colors, depth like a shadow box.

Avoid: Line art, photorealism, flat with no depth.

## Palette

`#fff4e6` background, `#ffe1e8` sky, `#ff9f6e` sun, `#ffd3a1` halo, `#c9b6e4` back layer, `#9fb7e8`, `#a8d5a2`, `#86c17f`, `#6aab68` front layer, `#4f9a5a` tree, `#a9785a` trunk

Pass the main colors as `primary`, `secondary` and `text` so the user can still restyle the card. Over footage, keep a plate behind type (see `color-on-video`) unless the style itself makes the type readable.

## How to build it in HTML and CSS

- Stack 4 to 6 full-width shapes (SVG paths or `clip-path` waves), each with `filter: drop-shadow(0 4px 10px rgba(0,0,0,.3))`.
- Pastel colors, each layer slightly darker toward the front. A faint paper grain helps.
- Type: a friendly sans on a paper tag that casts a drop shadow. Installed fonts only: `Candara, "Trebuchet MS", Corbel, sans-serif` bold, or `"Cooper Black", Georgia, serif` for a chunky tag.
- Slop check: the shadow is the style, but use one shadow direction and a tight blur, not a big soft shadow on every layer. Layers differ in size and shape, not copies of one rounded rectangle.
- Motion: layers slide up one after another with parallax (back layers move less), 400 to 600 ms, slight stagger. Feels like a shadow box opening.

## Check

Render the card or a frame of the animation and compare with `example.png`: does it read as paper cutout at a glance, and is the text still easy to read? Fix what does not.
