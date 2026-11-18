---
name: ai-video-edit
description: Edit a JV video from pinned or tagged library files. Use for cuts, captions, intros, animations, text, zoom, end cards, audio, voiceover, and applying cards onto footage.
icon: film
command: edit
label: Edit my clips
hint: What to change
group: Edit
next: review, improve, captions
needs: clip
title: Video edits
about: How the agent cuts, captions and adds effects to your clips.
---

# AI Video Edit

Edit a JV video from pinned or tagged library files. A video made of type and shape with no footage is its own path: `code-animation`.

Read the skill that matches the job: `player-pov` and `game-narration` before gameplay narration, `card-design` and `html-cards` before an edit card, `type-layout` and `color-on-video` for type and colour, `motion-graphics` for animation, `audio-voiceover` for speech, `captions` for subtitles, `video-improve` for craft, `source-footage` for original clips and renders, `stage-preview` for Source against a render.

## When to use

The user pins or uploads files, tags `@video:id` or `@image:id`, or asks to cut footage, add captions, build an intro, animate text, zoom, write an end card, add a voiceover or music, or apply cards onto a clip.

## Pinned files

The user message lists pinned files that must be used; they are already uploaded. Call `jeditor_get_library_item` for each id for its `path` and, for video, the exact `durationMs` and `durationSeconds`. Do not ask for a reattach and do not invent ids. If you cannot see images, plan from name, duration and the request, and never cut past the probed duration.

## Look at the footage

`jeditor_preview_frames` returns real frames: read the shots, where the subject sits, any text in frame, the pacing, and where a hook or CTA fits. With `times` it frames each moment as the render will, plus the raw source with grid lines at 0.25, 0.5 and 0.75, so x,y (0 to 1, 0,0 top left) come off the picture instead of a guess.

## Edit craft

A finished cut is not a still title card:

1. Intro: name sting, cold open or fade in (about 0.8s to 2s).
2. Motion: one lead motion, card `motion: {in, out}`, animated text `anim: "slide"`/`"fade"`, or CSS keyframes on HTML cards.
3. Text: headline, body, captions, staggered as they appear.
4. Zoom: punch or push on the key moments, not the whole clip.
5. Sound: a voiceover, a music bed, or a deliberate call to keep source audio, attached with the timeline `sound` op or `audioId`/`audioIds` on the render, then confirmed with `jeditor_probe_audio`.
6. End card: CTA, handle or hold, in the last 2s.

When the user asks for quality, plan the beats: hook text in the first second, a punch or push on each key moment, a flash on the biggest hit, fades at the ends, and an audio choice.

## Timeline edits (real cuts, not text)

1. `jeditor_get_timeline` with the open `projectId`: duration, frame rate and frame count, whether it carries audio, the kept segments in milliseconds and frames, and the existing cuts. Prefer frames when the rate is known: 0.301s is frame 9.03 at 30 fps, and a whole frame is what a render can land on.
2. `jeditor_edit_timeline` with `ops`, applied in order, all or nothing. Every time takes seconds or a frame:
   - `{ "type": "cut", "start": 5, "end": 8 }` removes 5-8s; `{ "type": "cut", "fromFrame": 150, "toFrame": 240 }` is the same cut in frames.
   - `{ "type": "keep", "start": 2, "end": 30 }` keeps only that range and drops the rest.
   - `{ "type": "split", "at": 12 }` marks a boundary so a later range op can aim at that part.
   - `{ "type": "speed", "start": 10, "end": 20, "rate": 2 }` plays 2x; `rate` runs 0.25 to 8.
   - `{ "type": "audio", "muted": true }` silences the clip; add `start`/`end` for one range, or `"volume": 0.3` (0 to 2) to duck it.
   - `{ "type": "reset" }` restores the whole clip, then apply fresh ops after it.
   Times are seconds by default; `startMs`/`endMs`/`atMs` work too.
3. `jeditor_render_project` bakes the timeline into a real video that plays in the project preview right away, so send the user there, not to Finished videos (a copy lands there on its own). A later timeline edit puts the preview back on the live cut until you render again.

Cut the boring or laggy parts, speed the slow ones, drop bad audio, then render. Say what changed in seconds so the cut points can be checked.

## Frame, zoom, and effects (real look, burned into the render)

The render comes out at the project ratio (9/16 is 1080x1920). The same `jeditor_edit_timeline` call takes look ops, and the preview and the render draw them the same way.

- `{ "type": "ratio", "aspectRatio": "9/16" }` changes the output frame (9/16, 16/9, 1/1, 4/5).
- `{ "type": "frame", "fit": "fit" }` shows the whole picture on a blurred fill, nothing cropped; this is the default. `{ "type": "frame", "fit": "fill", "x": 0.72, "y": 0.5 }` covers the frame and crops around x,y. Wide footage in a tall frame keeps about a third of the width, so x must sit on the action.
- `{ "type": "zoom", "start": 12, "end": 14.5, "amount": 1.8, "x": 0.7, "y": 0.4 }` punches in. `"style": "push"` eases in from the base frame; `"style": "pan"` with `fromX`/`fromY` travels. Use 1.3 to 2 for most punches (clamped 1 to 4). `{ "type": "unzoom", "start": 12, "end": 15 }` clears moves.
- `{ "type": "text", "text": "The army crosses the Balkans", "style": "hook", "start": 0.5, "end": 3.5, "position": "top" }`. Styles `hook`, `caption`, `bubbly`, `title`; text is held inside the safe margins and sized to the frame. `outputStart`/`outputEnd` for finished-video seconds; `{ "type": "remove_text", "id": "..." }` removes one.
- `{ "type": "flash", "at": 12 }` is a white hit frame on a beat; `{ "type": "fade", "in": 0.4, "out": 0.8 }` fades the finished video in and out.
- `{ "type": "sound", "audioId": "li_abc", "duck": 0.3, "track": "voice" }` lays a library track over the whole cut; `volume` sets its gain, `loop` repeats a short bed, `duck` lowers the source audio under it. `track` is `voice` (default) or `music`, and both play together. An empty `audioId` clears every track, or only the named one.

Then `jeditor_preview_frames` again (`outputTimes` for finished timing), fix what is off, `jeditor_render_project`, and `jeditor_probe_audio` the render: frames show the cut, only the probe shows the sound is there, at the right level, and not silent.

## Tools

Read first: `jeditor_get_library_item`, `jeditor_list_library`, `jeditor_get_timeline`, `jeditor_preview_frames`.

Edit and sound: `jeditor_edit_timeline`, `jeditor_render_project`, `jeditor_replace_audio` (new script over a clip's own audio in one call), `jeditor_set_audio`, `jeditor_clear_audio`, `jeditor_mute_audio`, `jeditor_probe_audio`.

Library and finished: `jeditor_add_files`, `jeditor_add_finished_video`, `jeditor_compose_finished`.

Animation: `jeditor_render_animation`, `jeditor_animation_frames` (see `code-animation`).

Voice: `jeditor_tts`, `jeditor_elevenlabs_setup`, `jeditor_elevenlabs_voices`.

Cards: `jeditor_list_cards`, `jeditor_get_card`, `jeditor_apply_edit`, `jeditor_set_card_html`, `jeditor_render_card`, `jeditor_template_store_list`, `jeditor_template_store_categories`, `jeditor_template_store_install`, `jeditor_save_card_as_template`.

## Tags

User messages may tag `@video:id`, `@image:id` and `@card:id`. Tagged cards arrive with name, kind, why and their headline, body and cta; use those ids, and call `jeditor_get_card` for colours, layout or images.

## Project state

A `Project` section in the user message is the live editor state and ground truth: name, ratio, clip, trims, splits, kept ranges with speed and audio, intro, texts, overlays, end card, audio placements. Build on it, change only what was asked, and never reset or re-describe it.

## Rules

- Do not invent files or library paths. Do not generate stock footage.
- Use the pinned files, then tagged media, then `jeditor_list_library`.
- Nothing pinned and nothing in the library is not a dead end: a video of type and shape (intro, sting, title sequence, motion graphics, loop) is made with `jeditor_render_animation` after reading `code-animation`. Never ask for footage for it.
- `jeditor_add_files` with absolute `paths` puts a clip in the library; `jeditor_add_finished_video` puts a finished clip on Finished videos.
- Write on-screen designs as HTML cards with `jeditor_set_card_html` (`html-cards`, `card-design`), verify the design with `jeditor_render_card`, then compose.
- To advertise or put copy on a raw clip: `jeditor_apply_edit` without cardId (headline, body, cta), then `jeditor_compose_finished` with the library video id and the card id. On a project that already has cuts, texts or zooms, add `text` ops with `jeditor_edit_timeline` instead, since compose works on the raw clip and would drop that edit. Do not only reply in chat.
- Retry your own tool calls if a compose or apply fails before you answer.
