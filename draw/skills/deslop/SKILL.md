---
name: deslop
title: Remove AI slop
group: Craft
description: Take a drawing that looks like generic AI output and fix it in place. Find the tells, fix the worst ones first, check again.
---

# Remove AI slop

Use this when the person asks to deslop a drawing, remove the AI look, or make it look less generic. The job is to fix what is there, not to start over. `anti-slop` lists the tells; `writing-slop` covers the words. This skill is the order of work.

## 1. Look

1. `view_drawing` to see it. `get_drawing` for item ids, layers and colors.
2. Go through the tells in `anti-slop` and write down (for yourself, not in the reply) which ones the drawing has. Note the item ids for each.
3. Read every text item against `writing-slop`.

If the drawing has no tells, say so in one line and change nothing.

## 2. Fix, worst first

Fix in this order. Stop when the drawing reads as made by a person.

1. **Color.** Oversaturated or default purple and teal: `recolor` toward calm colors with real hue and one or two accents. Gray and washed out: push darks darker and lights lighter and give the main colors back their hue. Put the new colors in with `set_palette`.
2. **Light.** No light direction: pick one. Add a shadow layer (multiply, opacity 0.2 to 0.4) on the side away from the light, contact shadows under anything on the ground, and a few warm highlights on the lit side.
3. **Glow and decoration.** Delete glow, sparkles, lens flares, stars and swirls that are not a real light source or part of the subject (`delete_items`, or `edit_items` to remove a shadow blur).
4. **Composition.** Subject dead center: move it to a third with `edit_items` or `arrange`. Break mirror symmetry in the scene around it.
5. **Repeats.** Copy-pasted trees, windows or clouds: change each one's size, lean, shade and spacing with `edit_items`. Delete one if the count is even and tidy.
6. **Shapes.** Perfect ellipses for trees, clouds or rocks: redraw them as uneven polygons or paths, then delete the ellipses.
7. **Texture.** Delete loose short lines, dashes, hatch marks and scattered dots; they read as AI. Smooth fills only: break big areas with a few larger patches of slightly different color and soft value changes, or a very faint fine grain.
8. **Overlap.** Things in the wrong order or floating: fix the layer order with `arrange` or `layers`, and add contact shadows.
9. **Text.** Rewrite slop text on the canvas with `edit_items` using the rules in `writing-slop`.
10. **Finish.** Call `check_drawing` and fix what it lists, then `finish_drawing`. It grades the colors and paints the edges of SVG items by code, so do not draw grain or wobble by hand. On a person's own pencil or ink drawing, call it with `edges: false` so their lines stay as they drew them.

## Rules

- The person's own strokes are theirs. Recolor, move or texture them only as far as the fix needs. Do not delete their line art. Put new work on named layers (Shadows, Texture, Light).
- Keep the subject and the idea. Deslop changes how it is drawn, not what it shows.
- If the person chose a style that uses glow or neon (they asked for neon, synthwave or a sign), keep the glow and fix the rest.

## Check

`view_drawing` again and answer the check list at the end of `anti-slop`. Fix every "no". Then reply in one to three sentences with what you changed, in plain words.
