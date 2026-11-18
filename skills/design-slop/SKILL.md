---
name: design-slop
description: Visual AI slop to avoid on cards, animations and thumbnails. Default purple gradients, Inter and system-ui type, glow, glass, emoji, centered everything, equal boxes. Read first, before card-design or any HTML design.
icon: eye
title: Design slop
about: The look that marks a design as made by AI, and what to do instead.
---

# Design slop

Slop is the default look a model falls into when nobody decided anything. Read this before `card-design`, `html-cards`, `type-layout`, `color-on-video`, a `style-*` skill or a code animation. It covers how a design looks; wording is covered elsewhere.

One tell alone is fine. A design with three or four is slop.

## Decide first

Before any markup, make five choices.

1. Subject: what is this card about (a cooking channel, a speedrun, a bank)? The look comes from the subject, not from "modern and clean".
2. Palette: one dark, one light, one accent.
3. Fonts: one display face and one text face from the list below. Not the same face for both.
4. Layout: where the headline sits and why. Left, bottom, off-center, or full-bleed. Say which.
5. One thing the viewer should remember. Everything else supports it or goes.

If you cannot answer one, pick the least generic option. The first idea that comes to mind is the slop.

## Color

- No purple, violet or indigo as the main color, and no purple-to-blue or pink-to-purple gradient. The common default is `#667eea` into `#764ba2`.
- No cyan or neon accents on near-black unless the style is neon or synthwave.
- Gradients: none by default. Allowed once per card, only to fake light on a real surface (a sky, a sunset), never as a fill behind a headline, a button or the whole background.
- No gradient text (`background-clip: text`). Use a solid color. Only `style-synthwave` may break this, and only on one word.
- No colored glow shadow (`box-shadow: 0 0 40px accent`) on dark cards.
- Gray body text on a colored plate looks dead. Use a shade of the plate hue or near-white.
- Do not default to cream or beige backgrounds either, the second most common choice after dark mode.
- Pick colors from the subject: a cooking channel is tomato, flour, cast iron and herb green, not violet.

## Type

- Pages have no network. Only fonts on the computer work. Never write Inter, Poppins, Montserrat, Roboto, Open Sans, Geist, Space Grotesk, Plus Jakarta Sans or any Google font: they fall back to the default sans and the card looks generic.
- Never leave `system-ui` as the only font, and never set one family at one weight for everything. Pair a display face for the headline with a plainer text face for support lines.
- Pick from the list below, and always end the stack with a generic family (`serif`, `sans-serif`, `monospace`).
- Use few sizes with a clear step. Headline at least 2x the support line. Not 44, 40, 36, 32 in a row.
- Tracking: caps need `letter-spacing` of 0.04em at most. Wide 0.2em to 0.3em caps on every small label is a tell. Do not crush display type with negative spacing either.
- No eyebrow label above every headline. Use one only when it adds a fact (a date, an episode number).
- No italic serif hero headline as a default style.
- No icon in a rounded tile above a heading.
- Keep lines short enough to read in the time the card is up.

### Fonts that ship with Windows 11

All of these are on the machine. Rockwell, Bodoni MT, Cooper Black, Copperplate Gothic Bold, Haettenschweiler, Showcard Gothic, Old English Text MT, Bauhaus 93, Berlin Sans FB and Tw Cen MT come with Office, so list them first and fall back.

| Voice | Display | Text |
| --- | --- | --- |
| Editorial, warm | Georgia bold, Cambria bold, Palatino Linotype | Corbel, Segoe UI |
| Loud and heavy | Impact, Segoe UI Black, Arial Black, Haettenschweiler | Bahnschrift, Arial Narrow |
| Technical | Bahnschrift (condensed or heavy through `font-stretch` and `font-variation-settings`), Consolas | Segoe UI, Consolas |
| Friendly | Candara bold, Trebuchet MS bold, Sitka Banner | Corbel, Trebuchet MS |
| Handmade | Ink Free, Segoe Print, Gabriola | Georgia, Corbel |
| Retro slab | Rockwell Extra Bold, Cooper Black, Franklin Gothic Heavy | Rockwell, Georgia |
| Classic | Constantia bold, Bodoni MT, Palatino Linotype | Georgia, Cambria |
| Mono | Consolas, Cascadia Mono, Lucida Console | Consolas |

Example stack: `font-family: "Segoe UI Black", Impact, "Arial Black", sans-serif;`

## Layout

- Not everything centered. A centered title card is allowed for a hook or an end card. A centered lower third, a centered stat or a centered paragraph is not.
- Not three equal boxes with an icon, a heading and a line each. If you have three things, make one bigger, or set them as a list, or show only one.
- No big number, small label, row of stats, gradient accent hero.
- No card inside a card. Use spacing and a rule.
- No pill badge or "LIVE" or "NEW" chip unless the thing is live or new. No pulsing dot as decoration.
- No numbered markers (01, 02, 03) unless the order matters.
- Use real hierarchy: one large thing, one medium, the rest small. Space related items tight and separate groups wide.
- Align to one edge. A left edge shared by the headline and the body is stronger than three centered lines.

## Shape and surface

- One border radius for a family of shapes, and a small one (4 to 12 px). Not 24 px or more on every box, and not pill-shaped everything. A full pill is for one button or tag.
- No thick colored border on one side of a rounded box (the left bar plus rounded corners). Pick the bar or the rounding. A plain rule on a square plate is fine.
- No hairline border and soft wide shadow on the same box. Pick an edge or an elevation.
- Not the same shadow on every element. Most elements get none.
- No glassmorphism (blur plus translucent white plate with a faint border). A plate behind type over busy footage is fine, but make it a dark solid at 80 to 90 percent opacity, not frosted glass.
- No repeating-gradient stripes, grid dots or noise laid over a surface to look designed.
- No hand-drawn SVG mascot, face or scene that looks sketchy. Use a simple geometric shape or nothing.

## Decoration

- No emoji or sparkle characters as icons or decoration. No sparkle stars, checkmarks or rockets. Use a drawn shape, a rule, or nothing.
- No floating blurred orbs or blobs in the background.
- No lens flares, light leaks, particles or confetti unless the subject is a celebration.
- Before keeping an effect, ask what the viewer would lose if it were gone. If nothing, delete it, and never stack effects (glow, blur, gradient, shadow, grain and a zoom) on one card.

## Motion

- No bounce or elastic easing on type. Use ease-out (`cubic-bezier(0.16, 1, 0.3, 1)`).
- Animate `transform` and `opacity`. Not width, height or margin.
- Do not fade, slide and scale the same element together. One move.
- Do not animate every line on its own delay when the card is under three seconds.
- Do not loop a shimmer, pulse or float on a card the viewer reads once.

## Check before you call it done

Render the still with `jeditor_render_card` (`asImage: true`) or a frame of the animation, look at the PNG, and walk the rules above against it. Fix and render again for each miss. Two or more misses: redo the card from "Decide first", do not patch it. The one question that catches most of it: could this card be for any topic? If you can swap the subject and nothing changes, it is slop.
