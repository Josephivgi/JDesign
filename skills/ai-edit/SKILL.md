---
name: ai-edit
description: Edit a JV card in the local workspace. Use for copy, colors, layout, images, templates, placement, duration, name, and why/description. Call jeditor_apply_edit. Do not invent a parallel store.
title: Card edits
about: How the agent changes text, colors and layout on a card.
---

# AI Edit

Change a persisted JV card through the JV MCP tools. The desktop editor and this skill share one apply path.

## When to use

The user asks to change a card's message, colors, layout, images, name, or why/description.

## Tools

- `jeditor_list_cards` to see cards in the active workspace
- `jeditor_get_card` to read one card
- `jeditor_apply_edit` to write a patch, or omit cardId to create a new edit card
- `jeditor_render_card` to rasterize the card to a PNG (proves the design)
- `jeditor_apply_edit` with `patch.composition` (copy, blockLayout, surface, aspect ratio), `patch.colors`, `patch.placement`, `patch.durationMs`, `patch.kind`, and `patch.imageIds` to set copy, layout, colors, surface, ratio, placement, duration, kind, and images
- `jeditor_template_store_list` / `jeditor_template_store_categories` to browse the template store (builtins, installed, and user-saved) with an optional `category` filter
- `jeditor_template_store_install` to install a builtin template id into the user's store
- `jeditor_save_card_as_template` to keep the current card's design as a reusable user template
- `jeditor_set_card_html` to write a card's HTML/CSS design (see the `html-cards` skill for examples)
- `jeditor_export_card` to write the card to a PNG or a standalone .html file on disk

## Patch shape

`jeditor_apply_edit` arguments:

- `cardId` (optional if creating)
- `patch.name`
- `patch.description` or `patch.why`
- `patch.composition.headline`
- `patch.composition.body`
- `patch.composition.eyebrow`
- `patch.composition.cta`
- `patch.composition.align`
- `patch.composition.aspectRatio`
- `patch.composition.backgroundId`
- `patch.composition.blockLayout` - `{ "headline": { "x": 0.1, "y": 0.2, "width": 0.8, "fontSize": 32, "color": "#FFFFFF", "align": "center", "bold": true, "highlight": "#000000" } }` (x/y/width are 0-1 stage fractions, fontSize is stage px)
- `patch.colors.primary` / `secondary` / `text`
- `patch.imageIds`
- `patch.template` - template id from `jeditor_template_store_list`; expands the design under the patch
- `patch.placement` - `auto` | `intro` | `overlay` | `end`
- `patch.durationMs` - 500-60000 on-screen time
- `patch.kind` - `title_card` or `overlay`
- `patch.motion` - `{ "in": "rise", "out": "drop" }` from `none`, `fade`, `rise`, `drop`, `slide`, `pop`; animates the whole card through its window
- `patch.composition.html` / `patch.composition.css` - markup and stylesheet for a code card (scripts and external loads are stripped); prefer `jeditor_set_card_html`
- `patch.composition.vars` - custom CSS variables, `{ "accent": "#DFF56A" }` becomes `var(--accent)`; `colors` map to `var(--primary)`, `var(--secondary)`, `var(--text)`

Send only fields that should change. Nested maps merge. For a template-first design, pass `template` plus only the fields you want to override.

## Verify

Call `jeditor_render_card` after designing - it writes a real PNG from the same renderer the video pipeline uses. Check `path` in the result and open it if you can see images.

## Rules

- Do not claim a change until `jeditor_apply_edit` returns the updated card.
- Keep existing fields the user did not mention.
- Do not generate video. Do not scan the library unless asked.
- Cards render at the card's `aspectRatio`: vertical 1080×1920, landscape 1920×1080, square 1080×1080. Keep fontSize ≥ 18 stage px for legibility.
