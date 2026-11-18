---
name: color-on-video
description: Color for cards on footage. One accent, a plate behind type, and colors the user can still edit. Read before picking card colors.
title: Color on video
about: How the agent picks text and card colors over footage.
---

# Color on video

A card has three colors: `primary`, `secondary`, and `text`. Pass them on `jeditor_set_card_html`. In the CSS they are `var(--primary)`, `var(--secondary)`, and `var(--text)`. Use those variables for the plate, the accent, and the type. A hardcoded hex the user cannot restyle is a last resort for a one-off photo treatment.

## Roles

- `primary`: the plate. Dark for light type, or light for dark type.
- `secondary`: the accent. One use. The eyebrow, a left rule, or the CTA fill. Not the headline and the body and the border.
- `text`: the headline. Light on a dark plate, dark on a light plate.

`highlight` on a block is the CTA fill. Pair it with the accent, and set the CTA `color` to the dark plate so the words stay readable.

## Contrast

Look at `jeditor_preview_frames` before choosing colors.

- White or yellow type on a bright sky, snow, or UI needs a plate. Transparent overlay with bare text fails.
- The plate can be a bar or a chip. An overlay does not dim the whole frame unless it is an intro or an end card.
- Intro and end cards use `surface: "solid"` so the plate is the background.
- Overlays use `surface: "transparent"` and paint their own bar in HTML, or rely on `highlight` for a pill. Field-only overlays still need the text to sit on a quiet, dark part of the picture. If that part is bright, switch to an HTML bar (`html-cards`).

Dark footage (a strategy map, a night scene) wants a small light or acid accent, not a second full-screen black card on top of the action.

## Pick from the picture

Take a dark and a light from the frames. Keep the accent close to one color already in the shot, or use a single high-contrast accent if the shot is muddy. Do not invent a new hue for every element.

Built-in templates are safe starts: near-black plate `#151A24`, acid accent `#DFF56A`, white text. They are a default, and a default is what slop looks like when every card uses it. Change them when the footage or the subject asks (see `design-slop`), not on every card in the same video. Cards in one project share one plate and one accent.

## Fails

- Accent on more than one role
- Light text with no plate on light footage
- Four unrelated hues
- A saturated plate that fights the footage for a two-word name
- Gray body text that disappears on the plate (`text` mixed toward the plate until it is faint)
- Purple, violet or indigo as the main color, or any purple-to-blue gradient (`design-slop`)
- A gradient behind the headline, gradient text, or a colored glow shadow
- Cyan or neon on near-black when the subject is not neon

Render with `jeditor_render_card` `asImage: true`. If you cannot read the headline at a glance, darken the plate or lighten the type and render again.
