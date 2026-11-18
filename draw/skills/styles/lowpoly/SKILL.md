---
name: lowpoly
title: Low Poly
group: 3D
description: Faceted triangles, like a simple 3D model.
---

# Low Poly

Faceted triangles, like a simple 3D model. The example image was drawn in JDraw with these steps.

## The look

Low poly art, faceted triangular polygons, each facet a flat color, geometric 3D look, clean edges.

Avoid: Smooth surfaces, high detail, photorealism, organic texture.

## Palette

`#9ad0ec` sky, `#e8f6fd`, `#ffd23f` sun, `#ffbe0b`, `#6c5b7b` far, `#8f7aa3` far lit, `#355c7d` near, `#4f7ea8` near lit, `#76b852` grass, `#2e8b57` tree, `#6d4c41` trunk

Add the colors you use with set_palette so the person can paint with them too.

## How to draw it in JDraw

- Cover the canvas with a jittered triangle grid (about 14 by 14 cells, two triangles each). Each triangle is a `polygon` of 3 points.
- Color each triangle by what lies at its center, then shift the color by plus or minus 14 so facets are visible.
- Give each triangle `stroke` equal to its fill, `strokeWidth: 1`, so no gaps show between facets.
- Lit faces lighter, faces turned away darker, as if a single light shines from one side.
- Draw small key objects (sun, tree) on a top layer as their own facet fans so they read clearly.
- Light from one side only: facets turn lighter toward it and darker away from it. Jitter the grid unevenly, with bigger facets in calm areas and smaller ones near the focus.
- Avoid (slop): a regular grid, every facet the same hue, a centered subject, glossy gradients over the facets.

## Check

Call view_drawing when you are done and compare with the example: does it read as low poly at a glance? Fix what does not.
