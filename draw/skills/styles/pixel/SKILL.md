---
name: pixel
title: Pixel Art
group: Retro
description: Chunky pixels and a small retro game palette.
---

# Pixel Art

Chunky pixels and a small retro game palette. The example image was drawn in JDraw with these steps.

## The look

Pixel art, 16-bit retro video game style, chunky square pixels, limited color palette, dithered gradients, crisp edges, no anti-aliasing.

Avoid: Smooth gradients, blur, photorealism, high resolution detail.

## Palette

`#5fcde4` sky, `#7bd8ea`, `#a2e6f2`, `#fbf236` sun, `#5b6ee1` far, `#3f3f74` near, `#6abe30` grass, `#99e550` grass light, `#37946e` tree, `#8f563b` trunk, `#222034` dark

Add the colors you use with set_palette so the person can paint with them too.

## How to draw it in JDraw

- Pick a pixel size (16 px on a 768 canvas) and draw only axis-aligned `rect` items on that grid. Merge runs of the same color in a row into one wide rect.
- A small palette of 10 to 16 colors, 2 or 3 shades per material.
- Gradients become bands of flat color with a checkerboard dither row between them.
- Texture by scattering single lighter pixels in a pattern (grass, leaves).
- No anti-aliasing, no curves, no opacity. Outline dark shapes with the darkest palette color.
- Choose one light direction: highlight pixels on that side and dark pixels on the other. Break up repeats by changing a few pixels in each tree or window.
- Avoid (slop): smooth gradients, glow, mirror-symmetrical sprites that are too perfect, a purple and teal sky by default. Use dither bands and keep the subject off center.

## Check

Call view_drawing when you are done and compare with the example: does it read as pixel art at a glance? Fix what does not.
