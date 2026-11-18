---
name: player-pov
description: Identify the player from on-screen text before writing narration or voiceover. If the HUD says USSR, the player is the Soviets: do not narrate that side as an outside force.
title: Player side
about: How the agent works out which side the player is on before narrating.
---

# Player point of view

Gameplay scripts are spoken from the side the user is playing. Read the picture before writing a line. The country, faction, or character named in the interface is the player, not the subject of a documentary.

Read this before any voiceover, caption, hook, title card, or `jeditor_tts` script on gameplay. Pair it with `audio-voiceover` for how speech is generated, and with `ai-video-edit` for the edit itself.

## See who is playing

Call `jeditor_preview_frames` and look at the images it returns. Pass `count` (up to 8) or `times` spread from the start, the middle, and the end. `source: true` keeps the raw frame, which is where HUD text is sharpest.

Read every label in the frame:

- Top bar, flag, portrait, faction name, character name, "you"
- Year, turn, or date in the interface
- Map titles and the name of whoever the armies are moving into

If you can see images, quote the text you actually see. If you cannot see images, say so and ask the user what the labels say before you write. A filename, a game title, or real history is not an identity.

Sample more than one moment. If the top bar changes, the player changed. Script each stretch from the label in that stretch.

Write the identity down in one line before any copy: who the player is, the on-screen evidence, and the year if it is visible.

## Voice

Default voice is the player, or a narrator standing with them: "I" and "we". Enemies and places can stay in the third person.

The player's faction is never an outside force in the sentence. Do not describe their own invasion, win, or loss as something happening to a country the viewer is watching.

On-screen text and the spoken line have to name the same side. If a card would say the player's faction did something as if they were someone else, rewrite the card so it is the player's action.

Follow a spectator or documentary voice only when the user asks for that. Even then, do not swap which side is which.

## Game facts stay on screen

Years, borders, and wars come from the footage, including alt-history. Do not correct the clip back to real history.

If the interface says 1957 and the map shows Austria, the script is about that game year. Do not replace it with the real date you remember.

## Worked example

Frames show a strategy game. The top bar reads USSR. The year reads 1957. Armies are moving into Austria.

The player is the Soviet Union.

Wrong: "The Soviet Union smashed into Austria in 1957."

That sentence talks about the player's own country as if the viewer were someone else.

Right: "Austria, 1957. We cross the border and take it."

The enemy is Austria. The year is the year on screen. The speaker is the player.

## Other games

The same lock applies when the identity is a person instead of a country. A nameplate, a portrait, a first-person weapon, or a "you" label means that character is the speaker. "I clear the room." Not "the soldier entered the room," unless the user asked for a spectator recap.

## Then write

Only after the identity line exists:

- Voiceover text goes to `jeditor_tts` (see `audio-voiceover`)
- On-screen lines go through `jeditor_edit_timeline` text ops or a card (`ai-video-edit`)
- Keep each line short and at the true scale of the action (see `game-narration`)

Check the finished frames with `jeditor_preview_frames` again and confirm the words still match the side on screen.
