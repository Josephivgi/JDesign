---
name: video-slop
description: What makes a video look like AI slop (same pacing every scene, same entrance, flat even narration, music at one level, stock preset order) and the rules that avoid it. Read before planning, animating, narrating, reviewing, or improving any video.
icon: eye
title: Avoiding AI slop
about: How the agent keeps a video from looking made by AI: varied pacing, motion and sound.
---

# Avoiding AI slop

Slop is not bad quality. It is sameness. Every scene gets the same length, the
same entrance, the same level of energy, and the viewer feels nobody decided
anything. A video made on purpose has rhythm: some beats are short, one is
held, one is a hard cut, and the voice breathes.

This skill covers video, motion, pacing and sound. For the words on screen and
in the script, read `writing-slop` too.

## The tells

Pacing and editing

- Every scene is the same length (3 s, 3 s, 3 s, 3 s). No rhythm, no held
  beat, no quick one.
- Constant tempo from start to finish. Better work slows down for the point
  that matters and moves fast through the supporting beats.
- Fade between every scene. Transitions that only fill the gap between two
  scenes.
- Every scene starts with the same entrance (all fade up, all slide in).
- A kinetic text slam on every beat, so none of them lands.
- A fixed preset order: title, stat, end card. Every video built from the same
  three presets looks like the same video.
- A templated shape: hook, three points, call to action, with nothing that
  surprises.
- Runtime stretched to hit a number. Cut what you can lose.
- Visuals that do not match the line being said. Pause on any frame and ask if
  the picture belongs to the words.

Motion and look

- Camera and shape moves that are perfectly smooth and floaty, always the same
  easing, always the same speed.
- Flat lighting: every scene the same even brightness, no depth, no shadow.
- Oversaturated color, or the same gradient on every scene.
- Everything centered, everything the same size.

Narration

- The "TTS plateau": every line the same length, the same pitch, the same
  cadence. No emphasis, no pauses, no speeding up.
- No breaths or pauses between clauses. Real speech pauses about every 8 to 12
  words.
- The default voice at default settings, with nothing chosen for the topic.

Music

- A bed wall to wall at one level, starting at second 0 and never changing.
- Music that never reacts: no dip under a key line, no lift at the ending, no
  silence for a beat.

## Rules

Pacing

1. Vary scene length. In a set of scenes, the longest is at least 1.6 times
   the shortest. Example for 16 s: 2.2, 3.6, 2.0, 5.0, 3.2.
2. One scene gets a held beat: the key point sits still for a second after
   its motion lands. This is the beat to hold, not the title.
3. At least one hard cut (`transition: "cut"`). Put it on the fastest beat or
   on a change of mood. Use `fade` rarely; use `slide`, `wipe`, `zoom`, or
   `circle` once each at most, and only where the story turns.
4. Not every beat needs motion energy. Alternate loud and quiet: a busy scene,
   then a still one.
5. Plan the shape from the content. A bread explainer has a puzzle, a reveal,
   and a payoff. Do not default to title, stat, end card. Skip the stat when
   there is no real number.

Motion

6. No two neighbouring scenes use the same entrance. Give each scene its own
   verb (build up, wipe on, scale in, type out) or let some things already be
   there when the scene starts.
7. One kinetic slam per video, on the line that earns it.
8. Mix easing and speed. A push-in that starts fast and settles reads as a
   person; a linear drift reads as a screensaver. Add a small offset or
   overlap between elements instead of moving them all in lockstep.
9. Add depth: a second layer behind the text (a shape, a line, a soft shadow)
   and some change in light between scenes (a darker scene, then a brighter
   one).
10. Keep color to one base and one accent, desaturated a notch from pure.

Sound and voice

11. Mixed line lengths: one short line (2 to 5 words), some medium (8 to 14),
    one longer (up to 20). Never 6 to 14 words for every line.
12. Write for the ear: contractions, a comma where a breath goes, a dash or
    ellipsis where a beat of silence goes, one question. Read each line aloud
    in your head.
13. The music has a shape: start low, dip under the key line, lift in the last
    scene, and let it end on a clean tail or a stop.

## Check before you hand over

Write this table in your head, or in the reply when asked:

| Check | Pass |
| --- | --- |
| Scene lengths | Longest at least 1.6 times the shortest |
| Held beat | One scene holds its key point 1 s or more |
| Hard cut | At least one `cut` |
| Entrances | No two neighbours alike |
| Narration lengths | One line 5 words or fewer, one 14 or more |
| Pauses | Punctuation marks the breaths |
| Music | Not one flat level for the whole video |
| Match | Any frame you stop on fits the line spoken there |

If three or more fail, fix the plan and look at the frames again before you
render. `design-review` scores this as the "AI-generic" area, and
`video-improve` acts on it.

## Sources

- opus.pro, "The AI Slop Aesthetic: 12 Tells":
  https://www.opus.pro/blog/ai-slop-aesthetic-12-tells (flat lighting,
  oversaturated color, too-smooth motion, missing breath patterns, "TTS
  plateau" cadence)
- easyviral.ai, "How to make AI videos that don't feel like slop":
  https://easyviral.ai/blog/how-to-make-ai-videos-that-dont-feel-like-slop-2026
  (constant tempo, no cut rhythm, transitions as filler, default voice,
  templated hook structure, padding)
- ElevenLabs prompting guide:
  https://elevenlabs.io/docs/best-practices/prompting (punctuation sets
  rhythm, ellipses add pauses, speed 0.7 to 1.2, break tags only on older
  models)
