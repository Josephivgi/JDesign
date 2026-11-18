---
name: vertical-short
description: Turn a video into a vertical 9:16 short for TikTok, Reels, or Shorts. Finds the best moment, reframes on the subject, adds a hook and captions, keeps it under the target length, and renders.
icon: phone
command: short
label: Make a vertical short
hint: Length or platform
group: Edit
next: captions, review
needs: clip
title: Vertical shorts
about: How the agent turns a video into a 9:16 short.
---

# Vertical short

A short is not the long video squeezed. It is the best 15 to 45 seconds,
reframed for a phone, with a hook in the first second.

## 1. Target

- Length: what the user said after the command, else 30 s. Never over 60 s.
- Platform words (TikTok, Reels, Shorts) change only the safe area: keep text
  out of the bottom 15 percent and the right 12 percent (captions use
  `position: "lower"`, not `"bottom"`).

## 2. Find the moment

1. `jeditor_get_project` and `jeditor_get_timeline`.
2. `jeditor_preview_frames` with `times` (source seconds) at 10 to 16 moments
   spread over the clip, in calls of up to 8. Look for the strongest action,
   reveal, or line.
3. Pick one continuous stretch, or two or three short ones that tell one
   story. Start on motion, not on setup.

If the project has no clip, say so and offer `/animate` instead.

## 3. Cut and reframe

1. `jeditor_edit_timeline`:
   - `keep` the chosen range (or `cut` around several).
   - `ratio` `9/16`.
   - `frame` `fit: "fill"` with x,y read off the gridded source frames. If the
     subject moves across the frame, use a `zoom` with `style: "pan"` to follow.
2. Check framing with `jeditor_preview_frames` using `outputTimes` every 3 s.
   The subject must be inside the frame on every one.

## 4. Hook, captions, end

- A `hook` text in the first second that says why to keep watching (4 to 7 words).
- Captions for any speech (read `captions`).
- Vary the rhythm: a tight first beat, one slower held moment, and a hard cut
  at least once. Do not zoom or flash on every beat; read `video-slop`.
- One punch-in zoom on the peak moment, and a `flash` if it is a hit.
- A `fade` out over the last 0.5 s, or end on the strongest frame.

## 5. Render

`jeditor_render_project`, then `jeditor_probe_audio`. Reply with the length,
the source range used (in seconds), and the hook text.
