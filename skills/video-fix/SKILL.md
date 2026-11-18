---
name: video-fix
description: Find and fix what is broken in this project's video, such as an animation whose script fails, text cut off at the edge, a black or frozen stretch, missing sound, or a design that does not match the request. Check first, fix only what is wrong, render, and check again.
icon: tool
command: fix
label: Fix what looks wrong
hint: What looks wrong
group: Improve
next: review, improve
needs: clip
title: Fixing problems
about: How the agent finds and fixes what looks broken.
---

# Fix what looks wrong

The user thinks something in the video is broken. This is a repair, not a
redesign: find the faults, fix those, and leave everything that works alone.
If the user described the problem after the command, start with that.

## 1. Read the project

1. `jeditor_get_project` with the project id. Note the ratio, the clip, any
   `design` in the context (a gallery design), and `state.renders`.
2. If the clip is a code animation (the context marks it `madeFromCode`, or
   has a `design`), read its code before anything else: `state.design` in the
   `jeditor_get_project` result has the full saved css and js (the chat
   context leaves long code out). For any other animation clip,
   `jeditor_get_library_item` returns `animationSource`, what it was rendered
   from. A code render has html, css, and js. A preset render has `preset`,
   `presetParams`, `colors`, and any extra css or js instead: render it again
   from that preset. When it is null the code was not kept; rebuild it from
   the clip's frames.

## 2. Check, with evidence

Look before you change anything. Every fault you report needs evidence.
Rendered frames alone can look fine while the script failed, so a code
animation always gets the code check below, even when the frames look right.

- Animation code: `jeditor_animation_frames` at 4 to 8 moments: the first
  0.3 s, each entrance, the finished pose, the last frame. For a gallery
  design pass the same `preset` and the `projectId`: JV fills in the saved
  params, colors, css, and js, so the stills match the project. For other
  animations, pass the `animationSource` fields as they are. If the call
  comes back as an error with `scriptErrors`, that is fault number one.
- The rendered video: `jeditor_preview_frames` across the cut (first second,
  middle, last two seconds; up to 8 times a call).
- Sound: `jeditor_probe_audio` with `projectId`.

Check each frame for:

| Fault | What it looks like |
| --- | --- |
| Script error | `scriptErrors` in the result, or motion that never starts. |
| Cut off | Text or a logo past the frame edge or inside the outer 5 percent. |
| Overlap | Two texts on top of each other, or text over the subject's face. |
| Unreadable | Low contrast text, or text too small to read on a phone. |
| Dead frame | Black, blank, or frozen for more than 1 s where motion was meant. |
| Wrong content | A typo, the wrong words, or colors that do not match what was asked. |
| Sound | Silence where audio was meant, clipping above -1 dBFS, music louder than a voice. |

## 3. Fix only the faults

- Script error: fix the named error in the js. For a gallery design, render
  with the same `preset` and `projectId` and pass only the corrected `js`
  (JV keeps the rest and swaps the clip). Never paper over an error with an
  empty try/catch.
- Cut off or overlap: in an animation, move or shrink with css (for a design,
  extra `css` with the saved rules carried over). For burned-in timeline text,
  `jeditor_edit_timeline` `text` ops with `x`, `y`, or `position` move it; a
  `frame` op only crops the picture.
- Unreadable: raise contrast (a backdrop or a darker background color) and
  size.
- Dead frame: remove it with a `cut`, or give the animation an entrance
  that starts by 0.3 s.
- Wrong content: correct the param, text, or color.
- Sound: music under a voice at volume 0.2 to 0.3; for the full rules read
  `jeditor_get_skill {name: "audio-voiceover"}`.

## 4. Render and check again

Render the way the clip was made. For the gallery design's own clip, pass
its `preset` without html and JV updates the design. For any other code
animation (a second clip of the preset included), call
`jeditor_render_animation` with the `projectId`, `replaceClipId` set to the
broken clip's id, and only the fields you fixed (for example just `js`):
JV fills the rest from the clip's saved source and keeps its frame, length,
edits, and captions. If the note says its timeline edits moved, run
`jeditor_render_project` after. A fix that only changes timeline edits
needs just `jeditor_render_project`. Then repeat the checks from
step 2 at the same moments. A fix counts only when the new frames show it
and no `scriptErrors` come back.

## 5. Report

Plain words, short:

- Each fault you found, with the time in seconds, and what you changed.
- What you checked and found fine.
- Anything you could not fix and what the user can decide.

If you found nothing wrong, say what you checked and show it was fine. Do not
invent faults.
