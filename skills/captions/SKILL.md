---
name: captions
description: Add readable captions to a video. Builds short timed caption lines from the voiceover script or the user's text, styles them for phones, keeps them inside the safe area, and renders.
icon: captions
command: captions
label: Add captions
hint: Style or script
group: Edit
next: review, short
needs: clip
title: Captions
about: How the agent writes and places readable captions.
---

# Captions

Captions are read on a phone, often with the sound off. Short lines, big type,
on screen long enough, never covering the subject.

## 1. Get the words

- If the user gave a script after the command, use it.
- If the project has a voiceover from `jeditor_tts`, its library item's
  `description` ends with `Script: ...`. Those are the exact words. Read it
  with `jeditor_get_library_item`. A narrated scene animation (`/explainer`)
  has one item per line; read each one.
- Otherwise check the audio with `jeditor_probe_audio`. If there is speech but
  no script, say you cannot hear the words and ask for the script, or offer
  captions that describe the action instead. Never invent dialogue.

Check the words against `writing-slop` before you split them.

## 2. Split and time

- 2 to 6 words per line, one idea per line. Break at commas and breaths.
- A narrated scene animation is already timed: its saved source
  (`jeditor_get_library_item` on the clip, `animationSource.audios`) says
  which scene each line is on, and the render result's `audioTracks` gives
  each line's `startMs` and `durationMs` on the clip. If you do not have that
  result, a line starts 250 ms after its scene starts. Spread each line's
  captions over its own window.
- With a voiceover, spread the lines over the voice: the voice starts where
  its `sound` op places it and lasts its item's `durationMs`. Give each line a
  share of that time in proportion to its word count, and use the silences
  `jeditor_probe_audio` reports as sentence breaks.
- Each line holds at least 1.0 s.
- No gap between lines in one sentence; a 0.2 s gap between sentences.
- Use `outputStart`/`outputEnd` (finished-video seconds) after cuts.
- Nothing in the first 0.3 s or the last 0.5 s unless it is the hook or CTA.

Let the line breaks follow how the voice speaks: a short line for a short
phrase, a longer one for a run of words. Do not cut every caption to the same
word count, and do not pop each word with a different color or bounce; one
quiet style with one emphasis word now and then reads as a person, not a
template (see `video-slop`).

## 3. Place and style

1. `jeditor_preview_frames` at a few caption times to see where the subject is.
2. `jeditor_edit_timeline` with `text` ops, `style: "caption"`, `position:
   "bottom"` in 16/9 and 1/1. In 9/16 and 4/5 use `position: "lower"`
   (about two thirds down), which keeps two-line captions out of the bottom
   app buttons. If the subject sits low, use `position: "top"`.
3. The first line can use the `hook` style if the user wants an opener.
4. In 9/16 keep captions above the bottom 15 percent: apps put buttons there.

## 4. Check and render

1. `jeditor_preview_frames` with `outputTimes` on three caption lines. Read
   them as a viewer: can you read each line twice before it leaves?
2. `jeditor_render_project`.
3. Reply with the number of lines, the style, and the time range covered.
