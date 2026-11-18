---
name: style-stainedglass
description: Visual style Stained Glass: Bright glass panes held by thick black lead lines. Read when the user asks for this look on cards, animations or thumbnails.
icon: palette
title: Stained Glass style
about: How the agent makes cards and animations look stained glass.
group: Styles
---

# Stained Glass style

Bright glass panes held by thick black lead lines. Use this look for cards (`jeditor_set_card_html`) and code animations (`jeditor_render_animation`) when the user asks for it. `example.png` in this folder shows the look. Read `card-design`, `html-cards` or `code-animation` for the tools; this skill only sets the look. Read `design-slop` first so the style does not turn into the default AI look.

## The look

Stained glass window, bright translucent colored glass panes, thick black lead lines between panes, light shining through, church window style.

Avoid: Soft gradients, photorealism, thin lines.

## Palette

`#1a1a1a` lead, `#2a6fdb`, `#4fa3f7`, `#ffc93c` gold, `#ffd966`, `#7b2cbf` violet, `#c77dff`, `#1b998b` teal, `#2ec4b6`, `#52b72e` green, `#0f7b3e`, `#8a4b14` amber brown

Pass the main colors as `primary`, `secondary` and `text` so the user can still restyle the card. Over footage, keep a plate behind type (see `color-on-video`) unless the style itself makes the type readable.

## How to build it in HTML and CSS

- Panes as SVG polygons (a Voronoi or jittered grid generated in script), bright jewel colors, thick dark strokes for lead.
- Light shining through: a soft radial highlight with `mix-blend-mode: screen` across the panes.
- Type: a gothic or old-style display face in gold or cream on a pane-shaped plate with a lead border. Installed fonts only: `"Old English Text MT", "Palatino Linotype", Georgia, serif` for gothic or `"Copperplate Gothic Bold", Constantia, serif` for caps. No Cinzel or UnifrakturMaguntia, they are not on the computer.
- Slop check: glass colors are jewel tones with thick lead lines, not a purple-blue gradient. No glow through the glass, no glass blur: this is flat colored panes.
- Motion: panes light up one by one (brightness from dark to full), then a slow sweep of light across the window.

## Check

Render the card or a frame of the animation and compare with `example.png`: does it read as stained glass at a glance, and is the text still easy to read? Fix what does not.
