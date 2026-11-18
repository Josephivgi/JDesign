---
name: neon
title: Neon Glow
group: Retro
description: Glowing neon tubes on a dark night background.
---

# Neon Glow

Glowing neon tubes on a dark night background. The example image was drawn in JDraw with these steps.

## The look

Neon light art, glowing neon tube outlines, bright pink cyan and green glow, dark night background, light bloom, sign style.

Avoid: Daylight, filled shapes, matte colors.

## Palette

`#07071a` night, `#140a2a`, `#ff4fd8` pink, `#ffb3f0` pink core, `#5ce1ff` cyan, `#3d7bff` blue, `#39ff88` green, `#ffb86b` amber

Add the colors you use with set_palette so the person can paint with them too.

## How to draw it in JDraw

- Dark night background (#07071a) with a subtle gradient and a few dim stars.
- Draw only outlines, as glowing tubes: `pen` strokes, size 4 to 6, with `shadow: {color: same as stroke, blur: 18, x: 0, y: 0}`.
- Double tubes for the main shape: a thick colored outline plus a thin pale core inside it.
- No filled shapes. Bright pink, cyan, green and amber against the dark.
- Neon text: text items with a matching color glow (blur 24), like a shop sign.
- Vary tube brightness and add a faint reflection on the ground under the signs. Let one tube flicker dim or have a small gap.
- Avoid (slop): use this glow-heavy look only when the person asks for neon. Do not put glow and sparkles on everything, and keep the subject off center.

## Check

Call view_drawing when you are done and compare with the example: does it read as neon glow at a glance? Fix what does not.
