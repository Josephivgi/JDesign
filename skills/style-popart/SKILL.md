---
name: style-popart
description: Visual style Comic Pop Art: Bold black outlines, halftone dots and primary colors. Read when the user asks for this look on cards, animations or thumbnails.
icon: palette
title: Comic Pop Art style
about: How the agent makes cards and animations look comic pop art.
group: Styles
---

# Comic Pop Art style

Bold black outlines, halftone dots and primary colors. Use this look for cards (`jeditor_set_card_html`) and code animations (`jeditor_render_animation`) when the user asks for it. `example.png` in this folder shows the look. Read `card-design`, `html-cards` or `code-animation` for the tools; this skill only sets the look. Read `design-slop` first so the style does not turn into the default AI look.

## The look

Comic book pop art, bold thick black outlines, Ben-Day halftone dots, bright primary colors, retro print look, punchy contrast.

Avoid: Soft shading, muted colors, photorealism.

## Palette

`#7fd8ff` sky, `#ff4fa3` halftone pink, `#ffe600` yellow, `#ff7a00` orange, `#e4002b` red, `#2c6bed` blue, `#00b3a4` teal, `#111111` ink, `#ffffff`

Pass the main colors as `primary`, `secondary` and `text` so the user can still restyle the card. Over footage, keep a plate behind type (see `color-on-video`) unless the style itself makes the type readable.

## How to build it in HTML and CSS

- Halftone backgrounds with `radial-gradient(circle, color 30%, transparent 31%)` at a small `background-size`.
- Thick black outlines on every plate and shape (`border: 6px solid #111` or SVG stroke). Hard offset shadow (`box-shadow: 8px 8px 0 #111`).
- Type: heavy condensed comic lettering in caps with a black outline, in a speech bubble or jagged burst. Installed fonts only: `Impact, Haettenschweiler, "Arial Black", sans-serif`. No Bangers, it is not on the computer.
- Slop check: primary colors only (red, yellow, blue, black, white), no purple and no gradients. Halftone dots are the one texture, used on one area. Vary the panel sizes.
- Motion: pops with overshoot (scale 0.6 to 1.1 to 1, 250 ms), slight shake on impact words.

## Check

Render the card or a frame of the animation and compare with `example.png`: does it read as comic pop art at a glance, and is the text still easy to read? Fix what does not.
