---
name: papercut
title: Paper Cutout
group: Graphic
description: Stacked paper layers with soft drop shadows.
---

# Paper Cutout

Stacked paper layers with soft drop shadows. The example image was drawn in JDraw with these steps.

## The look

Layered paper cut art, stacked paper layers with soft drop shadows between them, smooth curved edges, pastel colors, depth like a shadow box.

Avoid: Line art, photorealism, flat with no depth.

## Palette

`#fff4e6` background, `#ffe1e8` sky, `#ff9f6e` sun, `#ffd3a1` halo, `#c9b6e4` back layer, `#9fb7e8`, `#a8d5a2`, `#86c17f`, `#6aab68` front layer, `#4f9a5a` tree, `#a9785a` trunk

Add the colors you use with set_palette so the person can paint with them too.

## How to draw it in JDraw

- Build the scene as stacked bands, back to front, each a `polygon` with `smooth: true` that runs the full width and down to the bottom edge.
- Every layer gets a soft drop shadow: `shadow: {color: "#00000055", blur: 12 to 18, x: 0, y: 4 to 6}`. This is what makes it read as paper.
- Pastel fills, each band a step darker or more saturated toward the front.
- Smooth curved edges (gentle sine wobble on the band tops). No lines, no texture.
- Clouds and small objects are single `path` shapes with the same shadow.
- All drop shadows fall the same way (one light direction). Add a faint paper grain (tiny specks at opacity 0.05) on a top layer. Vary the wobble of each band.
- Avoid (slop): identical band curves, neon colors, glow, a centered symmetrical scene. Keep the pastels muted.

## Check

Call view_drawing when you are done and compare with the example: does it read as paper cutout at a glance? Fix what does not.
