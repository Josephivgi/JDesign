---
name: game-narration
description: Narration for video-game footage (strategy games and shooters). Keep lines simple and at the true scale of what happened, with the player as the subject.
title: Game narration
about: How the agent writes narration for game footage.
---

# Game narration

Footage from a game needs a different script than footage from real life. The clip is one player's session, not a history lesson. Write short lines that name the biggest true thing that happened, from the player's side.

## Is it a game?

Detect game footage before writing a word:

- A HUD: health, ammo, score, resources, a turn or year counter
- A faction, country, or leader label, usually in a top bar or corner
- A minimap, unit icons, or a "you" marker on the map
- On-screen prompts, tooltips, or a dialogue box

Read frames first with `jeditor_preview_frames` and look for these. If you cannot see images, say so and ask the user what the on-screen labels say instead of guessing.

When it is a game, the player is the subject. See `player-pov` for who the player is: the faction or character named on screen is the side the viewer is playing, so the script speaks as that side.

## Say less

One action per line. The clip shows a moment; say that moment.

- No stat recaps, no unit counts, no turn-by-turn detail unless the user asks.
- A 10-second clip gets one idea, not three.
- Cut adjectives and filler. "We take the city" beats "our forces successfully advance and capture the key city".
- Let the picture carry the detail. You do not need to name every unit on screen.

## Match the scale

Name the biggest true thing that happened, not a smaller one.

- If the player took a country, say "We invaded Italy", not "We hit a region" or "a border clash".
- Use the noun the game itself uses: nation, empire, front, city, sector. Use the year on screen.
- Do not shrink an invasion into a skirmish. Do not inflate a skirmish into an invasion.
- The scale comes from the footage, not from how dramatic a line sounds.

## Worked examples

| Wrong | Right |
| --- | --- |
| We hit a region near the border. | We invaded Italy. |
| A border clash breaks out. | We push the front into Italy. |
| The USSR invaded Italy in 1957. | Italy, 1957. We take the peninsula. |
| Enemy forces engaged our units in the north. | We roll north and take the city. |

The third row is the player-identity case: when the top bar reads USSR, the USSR is the player, so the player's own country is never the outside force in the sentence.

## Then write

- Identity first: `player-pov` for who the player is.
- Speech: `audio-voiceover` for `jeditor_tts` and mixing.
- The edit: `ai-video-edit` for cuts, text, and the render.
- Check the finished frames with `jeditor_preview_frames` again and confirm the words match the side and the scale on screen.
