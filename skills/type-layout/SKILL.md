---
name: type-layout
description: Type scale, margins, and alignment for JV cards. The headline is the only large line. Lower thirds sit low and left. Read when placing text on a card.
title: Text layout
about: How the agent sizes and places text.
---

# Type and layout

Cards render at full frame: vertical 1080×1920, landscape 1920×1080, square 1080×1080. `blockLayout` fontSize is stage pixels on that frame. Sizes below are for that full frame, not the small preview.

Fields are `eyebrow`, `headline`, `body`, and `cta`. Set them with `patch.composition.headline` / `body` / `eyebrow` / `cta` and place them with `patch.composition.blockLayout` on `jeditor_apply_edit`. `x`, `y`, and `width` are fractions from 0 to 1. `0,0` is the top left.

## Scale

Three sizes, and the headline is the only large one.

| Role | Vertical | Landscape overlay |
| --- | --- | --- |
| Eyebrow | 18 to 22 | 18 |
| Headline | 52 to 72, bold | 36 to 44, bold |
| Body or CTA | 22 to 28 | 22 to 24 |

Body is never bold. Eyebrow uses the accent color. Headline uses the text color. If a line does not fit, shorten the words before shrinking the headline under the floor (48 on vertical, 32 on a landscape overlay).

Nothing important goes under 18.

Fonts: pages have no network, so only fonts on the computer work. Do not name Inter, Poppins, Montserrat or Roboto, and do not leave `system-ui` as the only font. `design-slop` has the Windows 11 font list and a display plus text pairing for each mood.

## Margins

Keep every block inside `x` 0.06 to 0.94 and `y` 0.08 to 0.92. `width` must not run past the right margin: left `x` plus `width` stays at or under 0.94.

Title cards (hooks, end cards): headline `y` around 0.34 to 0.42, `width` 0.72 to 0.84, `align: "center"`. Eyebrow sits above it, about 0.08 to 0.1 higher in `y`, not on the same line. Body or CTA sits below, with a similar gap.

Lower thirds and banners: align left. Eyebrow `y` about 0.68 to 0.72, headline just under it, body under that. `x` is 0.06. Headline `width` about 0.5 to 0.62 so it does not cross the frame. Do not center a name plate. Not every title card has to be centered either: a left-set headline with one shape off to the side reads as designed. Do not set three equal boxes in a row, and do not put an eyebrow over every headline (`design-slop`).

A CTA button uses `highlight` for the fill and a dark `color` for the words. Give it its own block. Do not paint the headline with `highlight`.

## Lines

Eyebrow is two or three words. Headline is one line when it can be. Body is one line. If the headline wraps to three lines, cut words.

Leave a gap between roles. Do not set two fields to the same `y`.

## HTML is the layout

Design the card with `jeditor_set_card_html` (`html-cards`). Author at full-frame pixels: a vertical headline is about 64 to 96 px, a landscape lower-third name is about 40 to 64 px, and support type is about 26 to 34 px. Not 16 px. Keep the page background transparent on overlays. Use `var(--primary)`, `var(--secondary)`, and `var(--text)`.

The fraction table above is for a card that is already fields. New designs use CSS `position`, `padding`, and `gap` on the full frame, with the same margins: about 72 px from the sides on a 1080-wide frame, and lower thirds in the bottom quarter.

After the write, `jeditor_render_card` with `asImage: true` and read the still. Clipped words, a headline smaller than the body, or type in the center of an overlay means the layout is not done.
