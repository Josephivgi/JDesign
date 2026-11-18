---
name: flat
title: Flat Vector
group: Graphic
description: Clean geometric shapes, flat fills and simple shadows.
---

# Flat Vector

Clean geometric shapes, flat fills and simple shadows. The example image was drawn in JDraw with these steps.

## The look

Flat vector illustration, clean geometric shapes, solid flat fills, minimal simple shadow shapes, limited harmonious palette, modern graphic design.

Avoid: Texture, gradients heavy, photorealism, outlines.

## Palette

`#ffe9cf` background, `#ffd6a5`, `#ff8c42` sun, `#ffc078` halo, `#7b6d8d` far, `#625573` far shadow, `#4a6c6f` near, `#3b5759` near shadow, `#84b082` field, `#6f9a6d` field shade, `#2e7d4f` tree, `#5c4033` trunk

Add the colors you use with set_palette so the person can paint with them too.

## How to draw it in JDraw

- Only clean shapes: `polygon`, `rect` (with radius), `ellipse` and `path`. No freehand strokes.
- Solid fills, no outlines. Shadows are one flat darker shape on one side of each form (a polygon over half a mountain).
- A limited palette of 6 to 10 harmonious colors. Add them with set_palette.
- At most one soft gradient, for the sky; everything else flat.
- A halo is a larger ellipse behind the main one at opacity 0.5.
- Few items (10 to 30). Simplify shapes to their silhouette.
- Use one light direction: every shadow shape falls to the same side. Add a faint grain overlay (tiny dots at opacity 0.05 to 0.1) so fills are not dead smooth.
- Avoid (slop): glossy gradients, glow, a centered symmetrical subject, a purple and teal sky by default, identical repeated trees. Vary size and shade of repeats.

## Check

Call view_drawing when you are done and compare with the example: does it read as flat vector at a glance? Fix what does not.
