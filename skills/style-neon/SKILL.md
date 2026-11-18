---
name: style-neon
description: Visual style Neon Glow: Glowing neon tubes on a dark night background. Read when the user asks for this look on cards, animations or thumbnails.
icon: palette
title: Neon Glow style
about: How the agent makes cards and animations look neon glow.
group: Styles
---

# Neon Glow style

Glowing neon tubes on a dark night background. Use this look for cards (`jeditor_set_card_html`) and code animations (`jeditor_render_animation`) when the user asks for it. `example.png` in this folder shows the look. Read `card-design`, `html-cards` or `code-animation` for the tools; this skill only sets the look. Read `design-slop` first so the style does not turn into the default AI look.

## The look

Neon light art, glowing neon tube outlines, bright pink cyan and green glow, dark night background, light bloom, sign style.

Avoid: Daylight, filled shapes, matte colors.

## Palette

`#07071a` night, `#140a2a`, `#ff4fd8` pink, `#ffb3f0` pink core, `#5ce1ff` cyan, `#3d7bff` blue, `#39ff88` green, `#ffb86b` amber

Pass the main colors as `primary`, `secondary` and `text` so the user can still restyle the card. Over footage, keep a plate behind type (see `color-on-video`) unless the style itself makes the type readable.

## How to build it in HTML and CSS

- Dark background, maybe a brick or wall texture at very low contrast.
- Outlines only: SVG strokes or borders, with stacked glows (`filter: drop-shadow` 3 times, or `text-shadow: 0 0 4px, 0 0 12px, 0 0 28px` in the tube color).
- Type: a thin sign-like face with a white-hot core and a colored glow. Installed fonts only: `"Segoe Script", "Ink Free", cursive` for a script sign or `"Segoe UI Light", Bahnschrift, sans-serif` for a thin tube sign.
- Slop check: this style is allowed glow, but only on the sign. The plate, the body line and the background get none. One tube color plus its core, not pink, cyan and violet together. No purple-blue gradient behind it: the wall is near-black with a faint brick texture.
- Motion: the sign flickers on (opacity steps over 300 to 600 ms), then a slow glow pulse. Keep flicker short so it does not distract.

## Check

Render the card or a frame of the animation and compare with `example.png`: does it read as neon glow at a glance, and is the text still easy to read? Fix what does not.
