---
name: audio-voiceover
description: Add real audio to edits, ElevenLabs text-to-speech voiceovers, music beds, ducking, and mixing into project renders and composed clips. Read before any edit that should have narration or sound.
icon: mic
command: voiceover
label: Add a voiceover
hint: The script or tone
group: Sound
next: captions, review
title: Voiceover and sound
about: How the agent adds narration, music and mixes the sound.
needs: elevenlabs
---

# Audio and voiceover

Read `writing-slop` before you write a script: it lists the lines that sound like every AI voiceover.

Every render answers one question: does this have a voiceover, a music bed, the source audio, or a mix? Silence is a decision, not a default.

For a scene animation, write the script in one `jeditor_tts` call with `lines: [{text, scene}]` (up to 12 lines, 600 characters each): one approval, one audio item per line. Pass the returned `audios` to `jeditor_render_animation` with the same `scenes`. If lines come back in `failed`, do not render: call again with only those and merge the two `audios` lists. If it says `aborted`, the account was refused: tell the person and stop.

## ElevenLabs setup

A key is needed once per machine: `jeditor_elevenlabs_setup` `{apiKey}` saves it, `probe: true` verifies it, and `ELEVENLABS_API_KEY` in the environment works when no key is saved.

Never invent a key, and never paste one into a card, note, or project text. With no key, say so once and keep going: write the edit without speech, or add an audio file the person already has (`jeditor_add_files` takes mp3, wav, m4a, ogg).

## Voices

Pass `voiceId` or `voiceName` from `jeditor_elevenlabs_voices`, choosing by the topic (energetic for promos, warm for explainers) and keeping one voice for the whole video. Pacing follows the voice's own samples, so try another voice if one rushes.

## The script

Flat narration is the biggest tell of a machine made video. The script matters more than the settings.

- Mixed line lengths: one very short (2 to 5 words), several medium (8 to 14), at most one long (up to 20). Never the same length line after line.
- Contractions, plain words, a question somewhere. Put the key word near the end of its line.
- Punctuation is the pause control: a comma is a small breath (about every 8 to 12 words), a period a full stop, a dash or `...` a longer beat. Capital letters on one word add emphasis; use it rarely. SSML `<break>` works only on older models, not Eleven v3 or v4, and many breaks in one line make a voice speed up or add noise, so use punctuation first.
- Read it aloud in your head. If you run out of air, add a comma or split it.

Settings are starting points. `stability` 0.4 to 0.55 (0.8 and up sounds polished but flat, keep near 0.45 for an explainer), `style` 0.1 to 0.4 (high sounds theatrical or unstable), `speed` 0.95 to 1.05 (the range is 0.7 to 1.2, and extremes cost quality). Settings apply to every line in one `lines` call: variety comes from the script, not from the settings.

Speech runs about 150 words per minute: write narration shorter than the video or the card window it sits under, then check `item.durationMs` against the words. A 3-word line lasting 2 s is a beat, a 14-word line lasting 2.5 s is rushed. Re-make only the line that is off.

`jeditor_tts` writes the MP3 into the library. Give it `text` (up to 5000 characters), the voice, the settings, a `name` and `videoId` to link the voiceover to the clip it narrates so it shows in the clip's Linked panel.

## Background music

`jeditor_music` composes a bed and saves it as a library audio item. Name the mood, genre, tempo and instruments in `prompt` (up to 2000 characters), set `instrumental: true` so no vocals appear, and give `lengthMs` (3000 to 600000). A bed spends the account, goes through the same agent access mode, and needs the `music_generation` permission on the key.

A bed belongs on the `music` track: set it with `jeditor_set_audio` or the `sound` op `{type:'sound', audioId, track:'music', volume, loop, duck}`, then render. Leave `voice` alone so narration plays over it.

## Mixing it in

Three attach points:

1. **One call:** `jeditor_replace_audio` `{projectId, script}` generates the voiceover, removes the clip's own audio, attaches the track and renders. Pass `audioId` instead of `script` to reuse a track, and `muteSource: false` with `duck` to keep the original sound underneath.
2. **Composed clips:** `jeditor_compose_finished` `{audioId, audioVolume, audioLoop, duck}` lays the track over the whole finished clip.
3. **Project renders:** `jeditor_edit_timeline` `{type: "sound", audioId, volume, loop, duck, track}` saves the track on the timeline so every `jeditor_render_project` after carries it, or pass `audioId` etc. straight to `jeditor_render_project` for a one-off.

Layers, not one slot: `track` is `voice` (default) or `music`. Both can play at once, so narration over a bed is one edit, not a choice, and a second track never replaces the first. Clear one with `{type:'sound', audioId:'', track:'music'}`, both with `{type:'sound', audioId:''}` or `jeditor_clear_audio`. For several tracks in one render pass `audioIds: [voiceId, musicId]` or `audios: [{audioId, volume, loop, duck}]`.

- `audioVolume` / `volume`: gain, 1 is as generated. Voiceovers usually stay at 1.
- `audioLoop` / `loop`: repeat a short bed. Voiceovers almost never loop.
- `duck`: how much the source audio ducks under the overlay, 0-1. `0.3` keeps ambience audible under narration, `0` mutes the source, omit it to leave the source at full volume. The deepest duck wins.
- The clip's own audio: `jeditor_mute_audio` for the whole clip or a range, or the `{type:'audio', muted:true}` op, which also takes `fromFrame`/`toFrame`.

Nothing is attenuated: each track mixes at the level you asked for.

## Recipes

- **Promo with music under the narration:** `jeditor_music` the bed → `jeditor_tts` the narration → `sound` op `{audioId: voiceId, track:'voice'}` plus `{audioId: bedId, track:'music', volume: 0.5, loop: true, duck: 0.25}` → render.

## Verify

- **Listen to the result.** `jeditor_probe_audio` reports whether the file has an audio stream at all, its duration, channels, mean and peak dBFS, clipping and silent stretches. On a project it reads the latest render. A silent track looks fine in a still, so check after every render that mattered.
- Probe the audio item (`libraryId`) and the render to confirm the mix kept its level, `jeditor_get_library_item` to confirm the item persisted with its duration, and `jeditor_get_timeline` to see whether the bed landed on `music` or replaced the voiceover. `jeditor_get_finished` and `composed.audioId` confirm which track a composed clip mixed.
