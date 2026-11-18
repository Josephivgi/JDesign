---
name: html-cards
description: Design edit cards in HTML and CSS, then burn them into video. This is how cards are designed. Read with card-design before writing markup.
title: Card layout
about: How the agent builds cards and puts them on video.
---

# HTML/CSS cards

This is the design path for edit cards. Read `card-design`, `type-layout`, and
`color-on-video` and `design-slop`, then write the card here. A hook, a lower third, and an end
card are HTML documents, not a stack of text fields.

A card with `composition.html` renders through a browser engine instead of the
text-box layout, and the same document the studio previews is the one burned
into the video. Write markup in `html`, style it in `css`, and keep scripts
out (they are stripped, along with iframes and external loads).

## Write one

`jeditor_set_card_html` creates or updates a card:

```json
{
  "html": "<div class=\"tag\">EP 12</div>",
  "css": ".tag { position: absolute; top: 48px; left: 72px; padding: 8px 22px 10px; background: var(--secondary); color: var(--primary); font: 400 44px Impact, \"Arial Black\", sans-serif; letter-spacing: 0.02em; }",
  "kind": "overlay",
  "placement": "overlay",
  "durationMs": 4000,
  "colors": {
    "primary": "#14201C",
    "secondary": "#E8553D",
    "text": "#F6EFE3"
  }
}
```

Fonts: the page has no network, so name fonts that ship with Windows, with a generic last (`design-slop` has the list). Do not use `system-ui`, Inter or Poppins. The examples below show the shape of the markup; change the fonts, colors and layout to fit the subject so every card does not look the same.

Then check it with `jeditor_render_card` (`asImage: true` to see it), and burn
it with `jeditor_compose_finished`. Render and look before shipping, that is
how you catch clipped text and dead space.

## Color controls still work

The card's `colors` reach the page as CSS variables: `var(--primary)`,
`var(--secondary)`, `var(--text)`. Use them for every brand color so the user
can restyle the card in the studio or with `jeditor_apply_edit`
(`patch.colors`) without touching the markup. `vars` adds your own:

```json
{ "vars": { "accent": "#FFB454", "radius": "22px" } }
```

becomes `var(--accent)` and `var(--radius)` on `:root`.

## Library images

`{{image:<libraryId>}}` inside `html` or `css` expands to the image file (as an
embedded data URI), so `<img src="{{image:li_9f2}}">` and
`background-image: url({{image:li_9f2}})` both work. Get ids from
`jeditor_list_library` `kind: "image"`.

## Sizing

The design renders at the card's aspect ratio (vertical 1080×1920, landscape
1920×1080, square 1080×1080) at full resolution. The preview stage is a
scaled-down view of the same box, so author sizes for the full render:
vertical overlays usually want 40-80 px fonts, not 20 px. Overlay cards render
on a transparent background; keep the page background transparent and style
your own backdrop elements so footage shows around the design. Intro and end
cards get the `--primary` background unless your CSS paints one.

## Animation

Two ways to move a card:

- `motion` presets (`{in, out}` from `none`, `fade`, `rise`, `drop`, `slide`,
  `pop`) animate the whole card through its window. Good defaults: `rise` for
  lower thirds, `pop` for emphasis chips, `fade` for end cards.
- Keyframed CSS (`@keyframes` + `animation`) animates inside the card. When
  the css animates, compose rasterizes a frame per video frame at 24 fps and
  plays the page clock exactly, so a `2s ease` lands as 48 frames of a 4 s
  card. Keep animations under the card's `durationMs` and prefer
  `animation-fill-mode: both` so the card holds its first or last pose at the
  edges.

Do not rely on transitions triggered by hover or timers, nothing hovers in a
render, and time only moves when the video does. SMIL `<animate>` and
`<video>` inside the card do not animate; use CSS keyframes and images.

## Examples

### Lower-third name plate (overlay, rises in)

A square plate with one rule under it. No rounded corners, no gradient, no left bar on a rounded box.

```json
{
  "html": "<div class=\"lower\"><div class=\"who\">MAYA CHEN</div><div class=\"what\">Pastry chef, Northlight</div></div>",
  "css": ".lower { position: absolute; left: 72px; bottom: 120px; padding: 20px 40px 24px; background: color-mix(in srgb, var(--primary) 92%, transparent); border-bottom: 6px solid var(--secondary); } .who { color: var(--text); font: 700 58px Georgia, \"Palatino Linotype\", serif; line-height: 1.05; } .what { color: var(--text); font: 400 28px Corbel, \"Segoe UI\", sans-serif; margin-top: 8px; }",
  "kind": "overlay",
  "placement": "overlay",
  "durationMs": 5000,
  "motion": {
    "in": "rise",
    "out": "drop"
  }
}
```

### End card with one ask (end, css animated)

Left-set, one color block cut off by the edge, one ask in plain type. Not a centered stack with a pill button.

```json
{
  "html": "<div class=\"end\"><h1>New episode every Friday</h1><div class=\"ask\">Subscribe so you do not miss it</div><div class=\"slab\"></div></div>",
  "css": "@keyframes rise { from { opacity: 0; transform: translateY(40px); } to { opacity: 1; transform: none; } } .end { height: 100%; display: flex; flex-direction: column; justify-content: flex-end; align-items: flex-start; gap: 28px; padding: 140px 96px; box-sizing: border-box; } h1 { max-width: 62%; margin: 0; color: var(--text); font: 700 104px Georgia, \"Palatino Linotype\", serif; line-height: 1.02; animation: rise 0.6s cubic-bezier(0.16, 1, 0.3, 1) both; } .ask { color: var(--secondary); font: 700 38px Bahnschrift, \"Segoe UI\", sans-serif; animation: rise 0.6s 0.15s cubic-bezier(0.16, 1, 0.3, 1) both; } .slab { position: absolute; top: 0; right: 0; bottom: 0; width: 22%; background: var(--secondary); }",
  "kind": "title_card",
  "placement": "end",
  "durationMs": 5000,
  "colors": {
    "primary": "#1B1613",
    "secondary": "#E8553D",
    "text": "#F6EFE3"
  }
}
```

### Image promo strip (overlay with library photo)

```json
{
  "html": "<div class=\"promo\"><img src=\"{{image:li_abc}}\" alt=\"\"><div class=\"tag\">NEW</div></div>",
  "css": ".promo { position: absolute; right: 48px; top: 48px; width: 420px; border-radius: 6px; overflow: hidden; } .promo img { display: block; width: 100%; height: 280px; object-fit: cover; } .tag { position: absolute; top: 0; left: 0; background: var(--secondary); color: var(--primary); font: 400 30px Impact, \"Arial Black\", sans-serif; padding: 6px 18px 8px; }",
  "kind": "overlay",
  "placement": "overlay",
  "durationMs": 3500
}
```


## Workflow

1. `jeditor_list_library` for image ids if the design needs photos.
2. `jeditor_set_card_html` with the markup, css, colors, placement, duration.
3. `jeditor_render_card` with `asImage: true`; fix spacing, contrast, clipping.
4. `jeditor_compose_finished` with the video id (and `audioId` if the clip has
   a voiceover or music bed).
5. `jeditor_get_card` to confirm what persisted if anything looks wrong.
