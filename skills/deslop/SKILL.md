---
name: deslop
description: Remove AI slop from a video or its cards that already exist. Finds the generic AI tells in the design, the pacing, the narration and the words, fixes them in place, re-renders, and says what changed.
icon: wand
command: deslop
label: Remove AI slop
hint: What looks AI to you
group: Improve
next: review, captions
needs: clip
title: Remove AI slop
about: How the agent finds the generic AI look in a video and takes it out.
---

# Remove AI slop

The user has a video, cards or an animation that looks like every other AI video. Make this one stop looking like that. Keep the content, the facts and the story. Change how it looks, moves, sounds and reads.

The tells live in three skills. Read them first with `jeditor_get_skill`: `design-slop` (cards and HTML), `video-slop` (pacing, motion, narration, music) and `writing-slop` (every word on screen or spoken). This skill is the order of work.

## 1. Find what is there

1. `jeditor_get_project` with the project id. Note the ratio, the clip and `state.renders`.
2. `jeditor_get_timeline` for texts, zooms and sound.
3. `jeditor_list_cards` for the project's cards.
4. If the clip is a code animation, read its source with `jeditor_get_library_item` (`animationSource`: scenes, durations, transitions, colors, audios).
5. A voiceover item's `description` ends with `Script: ...`. Read it with `jeditor_get_library_item`.

If there is nothing to work on, say so in one line and stop.

## 2. Find the slop

Look before you judge:

- `jeditor_preview_frames` at 0.3 s, every text beat, the middle and the last 1.5 s. At least 6 frames.
- `jeditor_render_card` with `asImage: true` for each card.
- `jeditor_animation_frames` with `asImage: true` for an animation.
- `jeditor_probe_audio` with `projectId` for levels and silences.

Then list (for yourself) every tell you can point at, with where it is:

- **Design** (from `design-slop`): purple or purple-blue gradient, Inter or `system-ui` type, glow, glass, gradient text, emoji or sparkles, everything centered, three equal boxes, pill badges that say nothing, a colored bar on one side of a rounded box, an eyebrow on every headline, the same radius and shadow on every element.
- **Video** (from `video-slop`): every scene the same length, the same transition everywhere, the same entrance on every scene, a slam on every beat, the stock preset order (title, stat, end card), floaty camera moves, oversaturated color.
- **Sound**: every narration line the same length and cadence, no pauses, music at one flat level under everything.
- **Words** (from `writing-slop`): ban-list words, "not just X but Y", em dashes, "Ready to...?", "Get Started", lists of three everywhere, Title Case Everywhere, invented numbers.

If you find nothing, say so in one line and change nothing.

## 3. Fix, worst first

Fix what a viewer notices first. Usually that is words, then color and type, then pacing, then sound.

- **Words**: rewrite each slop line with the rewrite table in `writing-slop`. Keep the meaning. A number you cannot source becomes a placeholder and you say so.
- **Cards**: `jeditor_set_card_html` with the fixes from `design-slop`: an installed font that fits the style, one accent, a plate instead of glow or glass, type set off center where the card allows it, decoration removed. Render each card again with `asImage: true` and look.
- **Animation**: send the full `scenes` list again to `jeditor_render_animation` with `projectId` and `replaceClipId` set to the old clip. Make durations differ (longest at least 1.6 times the shortest), hold the key beat, make one transition a `cut` and vary the rest, give neighbouring scenes different entrances, and drop slams that are not on the key line. Check with `jeditor_animation_frames` first.
- **Timeline**: `jeditor_edit_timeline` to shorten copy, remove extra zooms and give every move a reason.
- **Narration**: rewrite only the flat lines (mixed lengths, one very short line, punctuation for breaths) and make only those again with `jeditor_tts` `lines`. If there is no ElevenLabs key, leave the audio and say which lines you would change.
- **Music**: lower the bed under the voice and let it rise in the gaps, as `music-bed` says.

Keep what already works. Do not add new effects to replace the ones you removed.

## 4. Render and check

1. `jeditor_preview_frames` again at the same times.
2. `jeditor_render_project`.
3. Go through the check lists at the end of `design-slop`, `video-slop` and `writing-slop`. Fix every fail and render again.

## 5. Report

Reply in plain words, short:

- The tells you found, each with where it was (a time or a card name).
- What you changed for each.
- Anything you left and why (for example no ElevenLabs key).
- Say that `/review` will score the new version if they want a second read.
