---
name: stainedglass
title: Stained Glass
group: Decorative
description: Bright glass panes held by thick black lead lines.
---

# Stained Glass

Bright glass panes held by thick black lead lines. The example image was drawn in JDraw with these steps.

## The look

Stained glass window, bright translucent colored glass panes, thick black lead lines between panes, light shining through, church window style.

Avoid: Soft gradients, photorealism, thin lines.

## Palette

`#1a1a1a` lead, `#2a6fdb`, `#4fa3f7`, `#ffc93c` gold, `#ffd966`, `#7b2cbf` violet, `#c77dff`, `#1b998b` teal, `#2ec4b6`, `#52b72e` green, `#0f7b3e`, `#8a4b14` amber brown

Add the colors you use with set_palette so the person can paint with them too.

## How to draw it in JDraw

- Black background (#1a1a1a) shows through as lead.
- Split the canvas into a jittered grid of four-sided panes (about 9 by 9). Color each pane by what lies mostly inside it, picking at random from 2 to 4 shades of that color.
- Every pane has thick black lead: `stroke: "#1a1a1a", strokeWidth: 7`.
- Feature shapes (sun, tree crowns) go on a top layer as larger panes with the same lead, a sun split into wedges by black lines.
- A thick black frame around the whole window (strokeWidth 14).
- Light comes through from one side: panes near the light are brighter and more yellow. Vary pane size and shade, and let a few panes be nearly clear.
- Avoid (slop): a perfect even grid, every pane glowing, a centered symmetrical design with nothing to look at, rainbow palettes. Pick a limited set of glass colors.

## Check

Call view_drawing when you are done and compare with the example: does it read as stained glass at a glance? Fix what does not.
