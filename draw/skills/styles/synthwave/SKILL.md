---
name: synthwave
title: Synthwave
group: Retro
description: 80s neon sunset, striped sun and a glowing grid.
---

# Synthwave

80s neon sunset, striped sun and a glowing grid. The example image was drawn in JDraw with these steps.

## The look

Synthwave retro 1980s aesthetic, neon pink and cyan, striped gradient sunset sun, glowing perspective grid floor, dark purple sky with stars, outrun style.

Avoid: Daylight, muted colors, realism.

## Palette

`#0d0221` night, `#3a0f5c` purple, `#ff2a6d` hot pink, `#ff71ce` pink, `#fff35c` sun top, `#ff9e3d` sun middle, `#05d9e8` cyan grid, `#b967ff` violet, `#1a0b3d` mountains

Add the colors you use with set_palette so the person can paint with them too.

## How to draw it in JDraw

- Sky: a rect with a vertical gradient from near black purple to hot pink at the horizon. Sprinkle tiny white ellipses for stars.
- Sun: a big circle with a yellow to orange to pink vertical gradient and a pink glow (`shadow` blur 40). Cut horizontal stripes across its lower half with sky-colored rects that get thicker toward the bottom.
- Mountains: dark polygons with a pink `stroke` (width 3) and pink glow.
- Grid floor: cyan `line` items with a cyan `shadow` blur 10. Lines fan out from a vanishing point at the horizon; horizontal lines get closer together near the horizon.
- A bright pink horizon line with a strong glow.
- Use this look only when the person asks for synthwave. Keep it from being generic: one sun off center, vary the mountain heights, keep the glow only on the sun, the horizon and the grid.
- Avoid (slop): glow and sparkles on everything, a perfectly centered sun and mirror-symmetrical mountains, the same purple and teal gradient every time. Add a little film grain on top.

## Check

Call view_drawing when you are done and compare with the example: does it read as synthwave at a glance? Fix what does not.
