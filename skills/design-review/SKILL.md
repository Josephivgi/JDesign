---
name: design-review
description: Review a video or animation like a design lead, without changing it. Looks at real frames and audio, scores hook, pacing, framing, type, color, motion, sound, and ending, and gives a short ranked fix list.
icon: eye
command: review
label: Review this video
hint: What to look at
group: Improve
next: improve
needs: clip
title: Video review
about: How the agent reviews a video and lists what to fix, without changing it.
---

# Design review

The user wants an honest read of what they have, not edits. Change nothing.
Do not render, do not edit the timeline, do not touch cards.

## Look

1. `jeditor_get_project`, then `jeditor_get_timeline` if there is a clip.
2. Look at the live cut: it is what the next render will be. For an
   animation, also use `jeditor_animation_frames` with `asImage: true` on its
   source.
3. Frames: `jeditor_preview_frames` with `outputTimes` at 0.3 s, every text
   beat, the middle, and the last 1.5 s. Six frames minimum, up to 8 per call.
4. `jeditor_probe_audio` with `projectId` (it reads the render when there is one).

If there is nothing to look at yet, say so in one line and stop.

## Judge

Read `type-layout`, `color-on-video`, `motion-graphics`, and `video-slop` for the
standard.
Score each area 1 to 5 with one line of evidence that points at a time:

- **Hook**: does the first second earn the second second?
- **Pacing**: the longest stretch with nothing new on screen, in seconds.
- **Framing**: subject inside the frame, safe margins respected.
- **Type**: size on a phone, weight, line length, how long each line holds.
- **Color**: contrast of text on footage (aim for 4.5:1 or a backing plate),
  a palette of two or three colors, not five.
- **Motion**: one lead motion, eased, staggered, last pose held.
- **Sound**: levels, voice clarity, music ducked, silent gaps.
- **Ending**: a clear last beat.
- **AI-generic**: does it look machine made? 5 means it has rhythm and
  decisions behind it; 1 means it is a template repeated. Measure, do not
  guess. Write down: each scene's length (is the longest at least 1.6 times
  the shortest?), the transition after each scene (any hard `cut`? the same
  one every time?), each scene's entrance (neighbours alike?), whether any
  beat is held, the word count of each narration line (all alike?), pauses
  in the voice (`jeditor_probe_audio` silences), music level over time, and
  whether the preset order is title, stat, end card. Give the score and name
  the two worst tells with times.

## Report

1. One sentence: the overall impression a viewer would have.
2. The scores, one line each.
3. **Fix first**: the three changes that would help most (an AI-generic score
   of 3 or lower puts its worst tell on this list), each with the time
   it applies to and the exact edit (for example "0.0 to 1.4 s: cut the fade
   from black, start on the first swing").
4. Say that `/improve` will apply those fixes if they want.

Be specific and kind. Never pad a score; a 3 with a reason helps more than a
polite 5.
