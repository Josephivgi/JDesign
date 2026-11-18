---
name: video-improve
description: Make an existing video better. Watch the current cut or finished video, score it against a design checklist, fix the biggest problems, re-render, and compare before and after.
icon: wand
command: improve
label: Improve this video
hint: What to focus on
group: Improve
next: review, short, captions
needs: clip
title: Improving a video
about: How the agent scores a video and fixes the biggest problems.
---

# Improve this video

The user wants the video they already have to be better. Not a new video, not
a plan: a better version of this one, rendered, with a short note on what
changed.

## 1. Find what you are improving

1. `jeditor_get_project` with the project id. Note the ratio, the clip, and
   `state.renders` (finished videos this project made).
2. `jeditor_get_timeline` for the cut: kept ranges, texts, zooms, sound.
3. If there is no clip and no render, there is nothing to improve. Say so in
   one line and offer the matching command instead (`/animate` for a video
   made from scratch, or adding clips first).

The live cut is the "before": it is what the project renders.

## 2. Watch it

`jeditor_preview_frames` with `outputTimes` across the finished timing: the
first second, every text beat, every zoom, the last two seconds. At least 6
frames for a short, 10 for anything over 30 s. One call takes up to 8 times,
so split longer lists into two calls. Then `jeditor_probe_audio` with
`projectId` (it reads the render when there is one) so you know the sound
instead of guessing it.

For a project whose clip is a code animation, also read its source with
`jeditor_get_library_item` and look at `jeditor_animation_frames`: fixing the
animation code and rendering it again is often the better fix. Render the
better version with `jeditor_render_animation`, the `projectId`, and
`replaceClipId` set to the old clip's id, so it takes the old clip's place
(same frame, same length, same edits) instead of becoming a second clip. A
gallery design is the exception: pass its `preset` without html and JV
updates the design in place.

## 3. Score it

Score each line 0 to 2 (read `video-slop` for the AI-generic line) and write one sentence of evidence per line. Do not
skip lines; a 2 needs evidence too.

| Area | 2 means |
| --- | --- |
| Hook | Something moves or reads in the first 1 s. No black, no slow fade from nothing. |
| Pacing | No dead stretch over 2 s without a cut, zoom, or new text. |
| Framing | The subject sits inside the frame on every checked frame (9/16 crops hard). |
| Text legibility | Readable on a phone: large, high contrast, inside safe margins, on screen long enough to read twice. |
| Text amount | One idea per text. No paragraphs on screen. |
| Motion | One lead motion style, used on purpose. Zooms land on the moments that matter. |
| Sound | Audio present, peaks under -1 dBFS, no silent gaps unless chosen; under a voice, music sits low (volume 0.2 to 0.3). |
| Ending | A clear last beat: CTA, title, or a hold. Not a cut mid-motion. |
| AI-generic | Scene lengths vary (longest at least 1.6 times the shortest), one held beat, at least one hard cut, no two neighbours with the same entrance, narration lines of mixed length with pauses, music that changes level. See `video-slop`. |

## 4. Fix the three biggest problems

Pick the three lowest lines (ties: the one a viewer notices first). Fix them
with real edits:

- Hook: cut the slow start (`cut`), add a `hook` text at 0.3 s, punch in on
  the first action.
- Pacing: `cut` dead air, `speed` 1.5x to 2x on travel, add a zoom on a beat.
- Framing: `frame` with `fit: "fill"` and x,y read from the gridded frames.
- Text: shorten copy, use `hook` or `caption` styles, hold each line 1.5 s or more.
- Motion: remove extra moves; keep one style.
- Sound: `duck` on a `sound` op lowers the clip's own audio under the added
  track. A music bed under a voiceover goes on `track: "music"` with `volume`
  0.2 to 0.3. `jeditor_music` makes a bed. Probe again after.
- AI-generic: for a scene animation, send the full `scenes` list again with
  `replaceClipId`: change durations so they differ, hold the key beat, set one
  transition to `cut` and vary the rest, give neighbours different entrances,
  and cut any slam that is not on the key line. For narration, rewrite lines
  to mixed lengths with punctuation for breaths and make only those lines
  again (`jeditor_tts` with `lines`), then render. For music, a bed at one
  flat level gets a lower volume under the voice and a shaped replacement.
- Ending: a `fade` out, or a closing line as a `title` text op over the last
  2 s with a fade. Do not burn an end card with `jeditor_compose_finished`
  on an edited project: it works on the raw clip and drops every cut, text,
  and zoom.

If the user named a focus after the command, that focus comes first and
counts as one of the three.

Change nothing that already scored 2 unless a fix requires it.

## 5. Render and compare

1. `jeditor_preview_frames` again at the same times to check the fixes.
2. `jeditor_render_project`.
3. `jeditor_probe_audio` on the new render.
4. Score the new render with the same table.

## 6. Report

Reply in plain words, short:

- Before and after score for each line that changed (for example "Hook 0 to 2").
- What you changed, with times in seconds so the user can check.
- What you left alone and why, and one idea for a next pass.

Never claim a fix you did not render and check.
