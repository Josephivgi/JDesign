---
name: oil
title: Oil Painting
group: Painted
description: Thick, visible brush strokes and rich layered color.
---

# Oil Painting

Thick, visible brush strokes and rich layered color. The example image was drawn in JDraw with these steps.

## The look

Oil painting on canvas, thick impasto brush strokes, rich layered color, painterly texture, impressionist light.

Avoid: Flat colors, vector art, smooth digital gradients.

## Palette

`#d8c8a8` canvas, `#4f7fb8` deep sky, `#a9c5df`, `#f2d9a6` warm horizon, `#ffcf5c` sun, `#6e6a9e` far, `#3d5a6c` near, `#7a9a3c` field, `#2f5f2f` leaves, `#4a2e1d` bark

Add the colors you use with set_palette so the person can paint with them too.

## How to draw it in JDraw

- Underpainting layer first: flat polygons or gradient fills blocking in each big area in its middle tone.
- Brush strokes layer on top: thousands of short `marker` strokes (3 points, pressure 0.5, 1, 0.6), length 16 to 26 px, size 10 to 13, opacity 0.85.
- Vary every dab's color slightly (plus or minus 20 in each channel) so the surface shimmers.
- Follow the form with stroke direction: near horizontal in the sky, diagonal on slopes, random in foliage.
- Highlights layer last: lighter, warmer dabs where light hits (sun side of trees, the sun itself), thicker and more opaque.
- Warm canvas tone (#d8c8a8) as background so gaps between strokes read as canvas.
- Light comes from one side: warm, thick dabs there, cooler thin dabs in shadow. Vary dab size, big for the sky and small at the focus.
- Avoid (slop): even smooth shading, same-size dabs in a neat grid, oversaturated color, a centered subject, glossy plastic highlights. Mix colors toward gray.

## Check

Call view_drawing when you are done and compare with the example: does it read as oil painting at a glance? Fix what does not.
