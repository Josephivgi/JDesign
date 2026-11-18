---
name: ink
title: Ink Line Art
group: Drawn
description: Black pen lines with hatching, no color.
---

# Ink Line Art

Black pen lines with hatching, no color. The example image was drawn in JDraw with these steps.

## The look

Black ink line art, fine pen drawing, hatching and cross-hatching for shading, pure black on white, no color, clean confident lines.

Avoid: Color, gray wash, painting, blur.

## Palette

`#ffffff` paper, `#151515` ink

Add the colors you use with set_palette so the person can paint with them too.

## How to draw it in JDraw

- White background, black only. No color, no gray fills.
- Confident outlines with `pen` strokes, size 2.8 to 3.2, pressure about 0.9.
- Shade by hatching: parallel `pen` strokes, size 1.2 to 1.6, 6 to 9 px apart, clipped to the area being shaded. Cross-hatch the darkest areas with a second set at another angle.
- Keep lit areas empty. Darkness comes only from line density.
- Densify stroke points (every 5 px) so long straight hatch lines stay crisp.
- Vary line weight: thicker on the shadow side and where forms overlap, thin on the lit side. Let hatch lines vary in length and spacing a little.
- Avoid (slop): one even line width everywhere, ruler-straight hatching, outlines with no overlaps, decoration that fills empty space for no reason. Leave white paper.

## Check

Call view_drawing when you are done and compare with the example: does it read as ink line art at a glance? Fix what does not.
