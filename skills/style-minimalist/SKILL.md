---
name: style-minimalist
description: Visual style Minimalist: Few shapes, lots of empty space, muted colors. Read when the user asks for this look on cards, animations or thumbnails.
icon: palette
title: Minimalist style
about: How the agent makes cards and animations look minimalist.
group: Styles
---

# Minimalist style

Few shapes, lots of empty space, muted colors. Use this look for cards (`jeditor_set_card_html`) and code animations (`jeditor_render_animation`) when the user asks for it. `example.png` in this folder shows the look. Read `card-design`, `html-cards` or `code-animation` for the tools; this skill only sets the look. Read `design-slop` first so the style does not turn into the default AI look.

## The look

Minimalist art, very few simple shapes, large areas of negative space, muted earthy palette, calm balanced composition.

Avoid: Clutter, detail, busy textures, many objects.

## Palette

`#f2ebe0` background, `#e9e2d6` ground, `#d9663f` accent, `#2f3e46` dark, `#52796f` muted green

Pass the main colors as `primary`, `secondary` and `text` so the user can still restyle the card. Over footage, keep a plate behind type (see `color-on-video`) unless the style itself makes the type readable.

## How to build it in HTML and CSS

- One headline, lots of space. Type takes less than a third of the frame.
- Background: a single muted color. One accent shape (a circle, a rule) in the accent color.
- Type: a light or regular weight sans or a refined serif, small labels at 0.04em tracking at most. Installed fonts only: `Corbel, "Segoe UI", sans-serif` or `Constantia, Georgia, serif`.
- Slop check: minimalist is not the stock beige page with a centered serif headline and a pill badge. Put the one element off-center on purpose, use one muted accent, and leave the space empty instead of filling it with a hairline box.
- No plates, shadows, glows or textures.
- Motion: slow fades and a small rise (8 to 16 px, 600 ms). One element at a time.

## Check

Render the card or a frame of the animation and compare with `example.png`: does it read as minimalist at a glance, and is the text still easy to read? Fix what does not.
