---
name: card-design
description: Design edit cards in HTML and CSS with jeditor_set_card_html. One idea, type off faces and HUD, then render and fix. Read before designing any card.
icon: layers
title: Card design
about: How the agent designs title and info cards.
---

# Card design

A good card has one job, a clear headline, and type that survives the footage. The tools are in `ai-edit` and `html-cards`. This skill is the quality bar. Read `type-layout` for sizes and `color-on-video` for palettes. Read `motion-graphics` for the entrance. Read `player-pov` before gameplay copy. Read `design-slop` before any markup: it lists the default AI looks to avoid. Read `writing-slop` before you write the copy.

## Design the card in HTML and CSS

Edit cards are HTML. Call `jeditor_set_card_html` with `html`, `css`, `colors`, `placement`, `durationMs`, and `motion`. Read `html-cards` for the tool, the CSS variables, and working examples. `jeditor_apply_edit` field text is only for a card that is already a plain headline and body.

The page is the full frame (vertical 1080×1920, landscape 1920×1080, square 1080×1080). Overlay cards keep the page background transparent so the footage shows through. Intro and end cards paint their own background.

Shape it like this:

- Hook or cold open: intro, 2 to 2.5 seconds, type centered
- Lower third or banner: overlay, 3.5 to 5 seconds, a bar or plate in the bottom band
- End card: end, 3 to 5 seconds, one ask

A name and a title are still a lower third. HTML is how you draw the plate, the rule, and the type, not a reason to fill the frame.

## One idea

Each card does one of these: hook, name, fact, quote, or ask. Do not put a hook, a paragraph, and a subscribe line on the same card.

Copy is short. Headline is one line, two if the words need it. Body is one short line or absent. Eyebrow is two or three words. CTA is a few words.

On gameplay, the words follow `player-pov`. The player's country or character is not a logo treated as someone else.

## Where it sits

Look at `jeditor_preview_frames` before placing an overlay. Put type in a quiet area.

- Do not cover a face, a weapon, or the center of a map.
- Do not cover the top bar. That is often the player's name (USSR, a character plate).
- Lower thirds and banners sit in the bottom band. Hooks and end cards are full-frame title cards between shots, not floating on the action.
- Match the project frame: `vertical`, `landscape`, or `square`.

Overlay cards use `surface: "transparent"` and `kind: "overlay"`. Intro and end cards use `surface: "solid"` and `kind: "title_card"`.

## Motion, once

One entrance from `motion-graphics`. `rise` for a lower third, `fade` for a title, `pop` for a single chip. Do not also keyframe every line, flash the cut, and punch-zoom the same moment. Give every overlay an exit too (`drop` after `rise`, `fade` after `fade`), and at least 1.5 s on screen.

## Check, then fix

1. `jeditor_render_card` with `asImage: true`. Look at the PNG.
2. Fix the markup or CSS with `jeditor_set_card_html`. Change colors, placement, duration, or motion in the same call.
3. Render again.
4. Run the check list at the end of `design-slop` on the PNG.
5. Once it is on the video, check the motion with `jeditor_preview_frames`
   at the card's start plus 0.2 s and its end minus 0.1 s: the entrance and
   exit must look intended, not cut off.

Reject the card if any of these are true:

- Headline and body are the same size
- The accent color is on the headline, the body, and the border
- Light text sits on bright footage with no plate behind it
- Type covers a face or the HUD
- The body is a paragraph
- The lower third is centered in the middle of the frame
- Text is cut off at the edge
- It trips the `design-slop` check: purple or purple-blue gradient, Inter or `system-ui` type, glow, glass, gradient text, emoji, three equal boxes, everything centered
- Every box has the same large radius and shadow, or a thick one-sided border sits on a rounded box
- The card would look the same for any topic
- An effect is there only to look designed

Then burn it with `jeditor_compose_finished` or the project render. Do not tell the user the design is done until the render has been looked at.
