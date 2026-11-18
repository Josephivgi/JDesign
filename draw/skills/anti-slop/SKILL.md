---
name: anti-slop
title: Avoid AI slop
group: Craft
description: What makes a drawing look like generic AI output, and how to avoid it.
---

# Avoid AI slop

Generic AI art shows the same tells: basic shapes, parts that float, flat even color, everything too clean and centered. Real structure fixes most of them.

After this, read get_style slop-catalog for the tells in your subject.

## What JDraw refuses while you draw

draw_svg checks each object and refuses it, with what to change, when it:

- is a plain rectangle, circle or ellipse (over about 90 px), or a stretched ellipse (lens cloud, pill)
- has an outline with fewer than 12 points (8 for small parts)
- is a closed shape of five or fewer curves that is long and thin
- zigzags, steps like a staircase, or is a row of same-size bumps
- is built from three or more four-corner bands or panels (striped towers)
- has an edge running ruler-straight across the object
- uses eight or more short thin marks, or dashes, as texture
- is a sky, sea or ground edge ruled straight across the middle
- has fewer than three colors
- has three or more small straight-sided specks (foam shards, hexagon dots)
- is a full-width thin strip along the horizon
- is a big object (over 6% of the canvas) that is mostly one flat tone, or has fewer than four tone areas
- is a see-through gradient wedge with hard sides
- is the stock cloud: wide with one smooth flat underside, or evenly spaced scallops
- has two or more bands of one color at equal height (candy stripes)
- has three or more similar blobs in a row (surf or stones as pills)
- is a dark smooth blob under an object that touches nothing (floating shadow)
- is a clip-art cumulus, or three or more clouds with bases in one level row
- is a flat straight-sided patch on water (water shapes are long curved swells that fade at their ends)
- is a pale see-through blob on water (a pasted sun reflection)
- is a dark copy of its own outline a few pixels off (a cut-out sticker)
- is one smooth dark pad wider than an object along its base (stock waterline shadow)
- is three or more small dashes stacked one under another (reflection ladder)
- is a rock whose inner planes are big smooth curves, or a rock drawn with soft curves only

Three refusals for one object, then a fourth try. On that try JDraw strips the decoration tells, smooths sawtooth edges, breaks ruled horizons and adds its own planes. A stock lens cloud is left out. Your own planes are better than JDraw's, so plan for them from the start.

## Rules for every drawing

1. No object is one primitive or a stack of them. One silhouette path per object, with real parts.
2. Every part is attached. Work out joints from the parent's coordinates and overlap joined parts.
3. No loose short lines, dashes, hatching or dots as texture. Show surface with shapes and color.
4. No copy-pasted shapes. Repeats differ in size, shape, lean and shade.
5. No rows. Repeats sit at different depths in uneven, overlapping groups.
6. Real color: real hue, true darks, clean lights, warm light against cool shadow. Never gray or muddy, never mostly purple.
7. No see-through light wedges, no half sun on the horizon, no lens clouds, no sparkles.
8. The subject sits off center, the horizon sits off the middle, and there is one clear focus.
9. One light direction. Shadows start at the base of each object and fall away from the light.
10. Text in one color only, and only the words the person gave.

## The tells the user rejects most

- Basic shapes stacked like blocks: a box with a triangle roof, a circle on a dome, trees as triangles, bushes as half circles.
- Parts that do not connect: a platform wider than its rock, a chimney floating over the roof, ears off the head, a shadow that does not start at the base.
- Textbook colors: pure red, orange, yellow or green, one flat fill per object.
- Random lines: dashes, scattered strokes, cracks on bricks, lines on rocks, bark and fur.
- Gray, washed-out color, or muddy midtones with no light idea.
- Wood grain, scratches and fold lines drawn across surfaces.
- Symbol clichés: code brackets, gears, lightbulbs, brains, sparkles.
- Multicolor text.
- Rain as even straight streaks.
- Things standing in a row on one baseline.
- Mirror-symmetric subjects, and an object whose two sides match row by row.
- Perfect circles and ellipses for trees, clouds, rocks and bodies.
- Oversaturated color, glossy plastic surfaces, glow on things that do not need it, and detail spread evenly with no focus.

## What to do instead

- Outline each object as one path with many points that follow its real silhouette: a lean, a bulge, a chip, a taper, and no two sides matching.
- Add the parts that make it read as built or alive: eaves, a railing, a stone base, window frames, a foundation, branches under foliage.
- Vary every edge. A cliff breaks at a few ledges, and a cloud edge is soft lumps.
- Give each object three tones (lit, mid, shadow) as separate shapes, and shift the shadow's hue, not only its darkness.
- Break big masses into several planes of different sizes and clearly different value, so no single tone covers more than a third.
- Draw each child after its parent and crop-check every joint.
- Decide the light first: where the warm light is, where the cool shadow is, and put the strongest contrast at the focus.

## Two pictures the reviewers called generated

- A lighthouse that is one tapered shape or a symmetric cone. Give it a lit side and a narrower shadow side of unequal width, a flared stone base on the rock, a gallery and a lantern.
- A sea that is one smooth gradient. Give it passes of different length, swells that are wider and darker near the front, and a broken path of pale pieces under the sun.
- Skies, water and clouds that are flat. Washes must overlap and show deeper where they cross, and every cloud mixes passes of unequal length.

## Stock shorthand that marks a drawing as generated

Lens or three-circle clouds; a half-circle sun on the horizon with dashed reflections; water as rows of short lines; grass as scattered dashes; triangle mountains with a zigzag snow cap; three-triangle pines; lollipop trees; half-dome bushes; a flat see-through light wedge; every object side-on or facing right; a sun in every outdoor scene; a logo built from a circle, orbit rings or a sparkle.
