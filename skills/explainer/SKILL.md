---
name: explainer
description: Make a short explainer, promo, or recap video from a one line brief, with no footage. Plans the beats, builds them as animated scenes with transitions, adds a narrated line per scene when asked, checks the stills, and renders one finished video.
icon: presentation
command: explainer
label: Make an explainer
hint: What it is about
group: Animation
next: captions, voiceover, review
title: Explainer videos
about: How the agent plans and animates a short explainer from a one line brief.
---

# Explainer video

The person typed one line ("an explainer about our new pricing", "a promo for
the bake sale", "recap our year"). They want a finished 12 to 30 second video
without answering questions. Make sensible choices and say what you chose.

Only when there is no topic at all (`/explainer` alone, or "an explainer
about" with nothing after it), ask one short question ("What is the video
about?") and stop. Look in the project first: a clip name, a card, or an
earlier message may already say.

Before step 1, load `code-animation` (the "Several scenes" section) and
`video-slop` (the pacing and narration rules) with `jeditor_get_skill`, then
follow these steps.

## 1. Plan the beats

Write the story as 3 to 6 short lines, one per scene:

Do not default to title, stat, end card. Shape the beats from the content: a
puzzle, a reveal, a payoff. Leave out the stat when there is no real number,
and use `html` for a beat no preset fits.

1. Hook: the topic in 1 to 4 words (`kinetic-title`, or `word-slam` for a
   punchy promo), or a question or odd fact drawn as `html`.
2. Two to four points. Pick the preset that fits each line:
   - a number: `counter-stat`
   - a comparison: `bar-chart`
   - a claim or slogan: `word-slam`
   - a quote or testimonial: `typewriter-quote`
   - a person or place: `lower-third` (it sits low, so pair it with a strong
     background color)
3. Close: `end-card` with the call to action and a handle or website.

Use the person's own facts. When a number or name is missing, write a
plain placeholder ("Your stat here") and say so in the reply rather than
inventing a figure.

Default length: about 15 s in all, but never equal scenes. Vary them: a quick
beat of 2 to 2.5 s, a few of 3 to 4 s, and one held beat of 4.5 to 6 s for the
point that matters, with its motion landing early so the pose sits still for
a second or more. The longest scene is at least 1.6 times the shortest, for
example 2.2, 3.6, 2.0, 5.0, 3.2. Respect each preset's `minMs`. A promo can be
faster overall; a calm explainer slower.

## 2. One look

- `colors` once, at the top level: a dark or saturated base (`primary`), one
  accent (`secondary`), and readable `text`. Use the brand colors if the
  project or the request names them.
- `aspectRatio`: the project's frame, or `9/16` when the request mentions
  TikTok, Reels, Shorts, or a phone.
- `transition`: set it per scene, not one for all. Use at least one `cut` (the
  fastest beat, or a change of mood). Use `fade` only where it fits, and one
  `slide`, `wipe`, `zoom`, or `circle` to mark a turn. Do not repeat the same
  one on every scene.

## 3. Look before rendering

Call `jeditor_animation_frames` with the same `scenes` (one still per scene)
and `asImage: true`. Check every still: text inside the frame, nothing
overlapping, the right words. Then check variety: do the stills look like one
template repeated (same layout, same size, same entrance)? If so, change
layout, scale, or light on at least two scenes and look again. Run the check
table in `video-slop`.

## 4. Narration (only when asked)

When the request says narrated, voiceover, voice, or explain out loud:

1. Write one spoken line per scene, plain and conversational, with mixed
   lengths: one very short line (2 to 5 words, for the hook or the reveal),
   some of 8 to 14, and at most one of up to 20 words. Never the same length
   twice in a row. Write for the ear: contractions, a comma where a breath
   goes, a dash or ellipsis where a beat of silence goes, one question
   somewhere. Put the key word of the line near the end of it.
2. One `jeditor_tts` call with `lines: [{text, scene: 1}, {text, scene: 2}, ...]`
   and a `name` ("Pricing explainer"). The person approves the whole script
   on one card, and each line comes back as its own audio item. If the result
   lists `failed` lines, call again with only those (keep each `scene`) and
   merge the two `audios` lists before rendering. Pass `stability` 0.4 to 0.5
   (lower is livelier) and `speed` 0.95 to 1.05; see `audio-voiceover`. If it says `aborted` or the
   call fails, render without narration and tell the person why.
3. Render with `audios: [{audioId, scene: 1}, {audioId, scene: 2}, ...]`. JV
   starts each line with its scene and lengthens any scene that is shorter
   than its line, so you do no timing math. One line per scene reads best;
   two lines on one scene play one after the other.
4. A music bed under the voice: add `{audioId, volume: 0.25, loop: true}` to
   the same list (`jeditor_music`, or a song from the library). Keep it low
   (0.2 to 0.3) and generate it with a prompt that has a shape (see
   `music-bed`).

Without narration, offer it in one sentence at the end instead of making it.

## 5. Render and hand over

`jeditor_render_animation` with `scenes`, `colors`, `transition`, the audio
if any, a clear `name` ("Pricing explainer"), and the `projectId`. Then read
the result before you say it is done:

- `scriptErrors` must be empty; fix the named scene and render again if not.
- `note` says when a scene grew to fit its voice, a transition was shortened,
  or transitions fell back to fades. Mention a change the person would notice.
- `scenes` lists each scene's real start and length, and `durationMs` is the
  final length. With narration it is often longer than planned; say so.
- With narration, `audioTracks` must list one entry per line. A missing line
  means a scene plays silent: fix it before you hand over.

Reply in plain words: what each scene shows (with its length), where the hard
cut and the held beat are, the total length, any
placeholder the person should fill in, and that they can ask for changes
like "make scene 2 slower" or "use our blue".

## Changing it later

Send the full `scenes` list again with the change and `replaceClipId` set to
the clip (`jeditor_get_library_item` on the clip returns the saved scenes and
audios). Keep the audio list unless the person asks to change the voice or
music. To change one spoken line, make only that line again (`jeditor_tts`
with `lines` holding just it and its `scene`), swap its `audioId` in the
saved list, and render; the other lines are reused and cost nothing.
