---
name: music-bed
description: Add background music under this project's video. Pick a mood that fits the content, generate a bed the length of the video, mix it low under any voice, render, and check the levels.
icon: music
command: music
label: Add background music
hint: A mood such as calm piano
group: Sound
next: review, captions
needs: clip, elevenlabs
title: Background music
about: How the agent picks and mixes background music.
---

# Add background music

The user wants music under the video. The music supports the video; it never
competes with a voice or the clip's own important sound.

## 1. Read the project and the sound

1. `jeditor_get_project` and `jeditor_get_timeline`: the clip, its length
   after cuts, and any `sound` ops already on the timeline (a voiceover, an
   earlier bed).
2. `jeditor_probe_audio` with `projectId`: is there speech or other sound
   already, and how loud.
3. If a music bed is already attached, you are replacing it. Say so in the
   report.

## 2. Pick the mood

If the user named a mood after the command, use it. Otherwise choose from
the content and say why in one line:

| Content | Bed |
| --- | --- |
| Product, launch, sale | Upbeat electronic or pop, 110 to 125 BPM |
| Tutorial, explainer, talking head | Calm lo-fi or soft piano, 70 to 90 BPM |
| Gaming, sport, action | Driving electronic or rock, 125 to 150 BPM |
| Story, travel, emotional | Warm acoustic or cinematic strings |
| Logo sting, short title | A short rise and hit, matched to the motion |

Always instrumental under a voice.

Give the bed a shape. A bed at one level from the first second to the last
reads as filler. In the prompt, ask for a quiet intro that builds, and a clean
ending. Then in the mix: start the bed low, keep it at the low end under the
key line, and let it come up in the final scene or end with a stop, not a
fade that never finishes. Do not use the same genre for every video; pick
from the table by content (see `video-slop`).

## 3. Make the bed

`jeditor_music` with a prompt that names the genre, mood, tempo, and two or
three instruments, plus "instrumental", `instrumental: true`, and `videoId`
set to the project's clip. Set `lengthMs` to the video length plus about 1 s,
kept between 3000 and 600000; a bed shorter than the video needs `loop`.

JV shows the user a card to approve the music call. It needs an ElevenLabs
key: if the call says the key is missing, stop and tell the user to paste
their ElevenLabs key in JV under Settings, Voice and music. Never fake music with silence or
a placeholder.

## 4. Mix it

Attach the bed with the id `jeditor_music` returned:

`jeditor_set_audio` with `{projectId, audioId: <bed id>, track: "music", volume, loop}`

- Under a voiceover or speech in the footage: `volume` 0.2 to 0.3.
- With no voice: `volume` 0.5 to 0.7.
- `duck` (0 to 1) lowers the footage's own audio under the added tracks. Leave
  it out when the footage has speech you want heard. Use `duck` 0.2 to 0.4
  only to push down footage noise or room sound under a voiceover.
- `loop` only when the bed is shorter than the video.

For a gallery design (the context has a `design`), put the bed in the design
instead, or the next design edit drops it: `jeditor_render_animation` with the
same `preset` and `projectId`, and `audios` set to every saved track plus
the bed. Turn the saved audio into `audios` entries first: keep
`extras.audios` entries as they are, each `extras.audioIds` id as
`{audioId}`, and a saved `extras.audioId` as
`{audioId, volume: audioVolume, loop: audioLoop}` (skip it when
`extras.audioIds` already lists it, or it plays twice). Then add
`{audioId: <bed id>, volume, loop: true}` with the volume from the list
above (0.2 to 0.3 under a voice, 0.5 to 0.7 without). Audio settings replace as a
group, so always pass the full set you want.

## 5. Render and check

1. `jeditor_render_project`. For a design, skip it unless the render's note
   says to run it: the animation render above already made the finished
   video, so probe that.
2. `jeditor_probe_audio` on the result. Peaks must stay under -1 dBFS, and the
   level should not be flat for the whole video. A voice
   must stay clearly above the bed; lower the bed if not and render again.

For voice levels and timing, read the full rules with
`jeditor_get_skill {name: "audio-voiceover"}`.

## 6. Report

Plain words: the mood you picked and why, the volume, where it starts and
ends, and the probe result. Offer one alternative mood if the user wants a
different feel.
