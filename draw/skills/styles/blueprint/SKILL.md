---
name: blueprint
title: Blueprint
group: Technical
description: White technical lines, dimensions and a grid on blue.
---

# Blueprint

White technical lines, dimensions and a grid on blue. The example image was drawn in JDraw with these steps.

## The look

Technical blueprint drawing, thin white lines on deep blue paper, grid, dimension lines with measurements, title block, engineering schematic style.

Avoid: Color fills, shading, painting, photorealism.

## Palette

`#1f4e8c` blueprint blue, `#eaf4ff` line white, `#ffffff` grid at 13 to 28 percent opacity

Add the colors you use with set_palette so the person can paint with them too.

## How to draw it in JDraw

- Deep blue background (#1f4e8c).
- Grid layer: thin white `line` items every 24 px at opacity 0.13, every 96 px at opacity 0.28.
- Draw everything as unfilled outlines (`fill: null`) in near-white, strokeWidth about 2. No fills or shading.
- Add technical detail: dashed center lines (`dash: "dashed"`), dimension lines with `arrowStart` and `arrowEnd` plus measurement text, dotted extension lines.
- A title block in a corner: a ruled rectangle with a drawing name, scale and sheet number.
- Vary line weights: heavy for outlines, thin for dimensions and grid. Uneven dash lengths and small faded smudge marks keep it from looking machine-perfect.
- Avoid (slop): glow on the lines, a centered mirror-symmetrical object, meaningless extra annotations. Every label and dimension must match something drawn.

## Check

Call view_drawing when you are done and compare with the example: does it read as blueprint at a glance? Fix what does not.
