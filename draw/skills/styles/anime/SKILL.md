---
name: anime
title: Anime
group: Illustrated
description: Clean cel shading, bright skies and big fluffy clouds.
---

# Anime

Clean cel shading, bright skies and big fluffy clouds. The example image was drawn in JDraw with these steps.

## The look

Anime background art, cel shading with hard shadow edges, vibrant saturated colors, dramatic cumulus clouds, clean crisp shapes, Japanese animation style.

Avoid: Photorealism, muddy colors, sketchy lines.

## Palette

`#1c64d8` sky top, `#5aa8f0` sky, `#bfe3ff` horizon, `#ffffff` clouds, `#c7dcf5` cloud shade, `#8fa6d6` far mountains, `#4f7cad` near, `#5cc24a` grass, `#46a63a` grass shade, `#2f8f44` tree, `#48b25a` tree light

Add the colors you use with set_palette so the person can paint with them too.

## How to draw it in JDraw

- Sky: a rect with a vertical linear gradient, deep blue at the top to pale blue at the horizon.
- Big cumulus clouds: a cluster of 6 to 8 overlapping ellipses in a pale blue shade, then the same cluster in white shifted up and left by 4 to 6 px so the shade shows as a hard-edged rim.
- Cel shading: every form is one flat fill plus one darker flat shape for the shadow side. Hard edges, no soft gradients on objects.
- Add one lighter flat shape on the lit side of round forms (tree crowns, hills).
- Small detail strokes (grass blades: `pen`, size 3, two points, pressure 0.3 to 0.9) give life to big flat areas.
- Glow on light sources: an ellipse with a soft `shadow` blur of 30 to 40 in a warm white.

- Pick one light direction (say, sun from the upper left) and put every cel shadow on the opposite side.
- Vary the clouds in size and shape. Put the subject off center.
- Avoid (slop): the same cloud copied three times, a perfectly round sun with sparkles, oversaturated candy sky, glossy airbrush gradients on objects.

## Check

Call view_drawing when you are done and compare with the example: does it read as anime at a glance? Fix what does not.
