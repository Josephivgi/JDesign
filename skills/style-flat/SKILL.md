---
name: style-flat
description: Visual style Flat Vector: Clean geometric shapes, flat fills and simple shadows. Read when the user asks for this look on cards, animations or thumbnails.
icon: palette
title: Flat Vector style
about: How the agent makes cards and animations look flat vector.
group: Styles
---

# Flat Vector style

Clean geometric shapes, flat fills and simple shadows. Use this look for cards (`jeditor_set_card_html`) and code animations (`jeditor_render_animation`) when the user asks for it. `example.png` in this folder shows the look. Read `card-design`, `html-cards` or `code-animation` for the tools; this skill only sets the look. Read `design-slop` first so the style does not turn into the default AI look.

## The look

Flat vector illustration, clean geometric shapes, solid flat fills, minimal simple shadow shapes, limited harmonious palette, modern graphic design.

Avoid: Texture, gradients heavy, photorealism, outlines.

## Palette

`#ffe9cf` background, `#ffd6a5`, `#ff8c42` sun, `#ffc078` halo, `#7b6d8d` far, `#625573` far shadow, `#4a6c6f` near, `#3b5759` near shadow, `#84b082` field, `#6f9a6d` field shade, `#2e7d4f` tree, `#5c4033` trunk

Pass the main colors as `primary`, `secondary` and `text` so the user can still restyle the card. Over footage, keep a plate behind type (see `color-on-video`) unless the style itself makes the type readable.

## How to build it in HTML and CSS

- Pure CSS shapes or inline SVG with solid fills. No textures, no outlines, no blur.
- One flat shadow shape per form, offset to one side, about 15 percent darker.
- Palette of 4 to 6 colors passed as `primary`, `secondary`, `text` plus custom vars.
- Type: a heavy geometric display face for the headline and a plain face for support. Installed fonts only: `"Segoe UI Black", "Arial Black", Impact, sans-serif` for headlines and `Corbel, "Segoe UI", sans-serif` for text. No Poppins, Montserrat or Inter: they are the generic AI default and are not on the computer. Plates are flat rectangles with one small radius (4 to 10 px), not pills.
- Slop check: flat does not mean three equal rounded cards with an icon each, and it does not mean a purple-blue gradient. Pick a palette from the subject, vary the size of the shapes, and keep one radius.
- Motion: clean slides and scale-ins (250 to 400 ms, ease-out cubic). Shapes can stagger in one after another.

## Check

Render the card or a frame of the animation and compare with `example.png`: does it read as flat vector at a glance, and is the text still easy to read? Fix what does not.
