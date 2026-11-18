---
name: popart
title: Comic Pop Art
group: Illustrated
description: Bold black outlines, halftone dots and primary colors.
---

# Comic Pop Art

Bold black outlines, halftone dots and primary colors. The example image was drawn in JDraw with these steps.

## The look

Comic book pop art, bold thick black outlines, Ben-Day halftone dots, bright primary colors, retro print look, punchy contrast.

Avoid: Soft shading, muted colors, photorealism.

## Palette

`#7fd8ff` sky, `#ff4fa3` halftone pink, `#ffe600` yellow, `#ff7a00` orange, `#e4002b` red, `#2c6bed` blue, `#00b3a4` teal, `#111111` ink, `#ffffff`

Add the colors you use with set_palette so the person can paint with them too.

## How to draw it in JDraw

- Every shape gets a thick black outline: `stroke: "#111111", strokeWidth: 6 to 8`.
- Bright flat primary fills: red, yellow, blue, plus pink and teal.
- Halftone dots: a grid of small ellipses (offset every other row) in the background, growing in size toward the bottom or one side.
- Burst rays behind the subject: thin yellow triangles fanning out from a point.
- A comic burst `path` (jagged star) with a sound-effect word ("POW!") in a heavy font like Impact.
- Offset the colors slightly from the black outlines (misregistration of 3 to 5 px) and vary the halftone dot size. Use one light direction if you shade.
- Avoid (slop): glossy gradients, a pile of sparkles, every color at the same strength, a centered symmetrical face. Keep the palette to a few bold colors.

## Check

Call view_drawing when you are done and compare with the example: does it read as comic pop art at a glance? Fix what does not.
