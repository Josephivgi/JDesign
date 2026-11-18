---
name: writing-slop
description: Keep AI slop out of every word you write for a video. Card headlines, captions, end-card CTAs and voiceover scripts. Ban list, plain rewrites, spoken-line rules, and a final check. Read before writing any on-screen or spoken copy.
icon: type
title: Writing without slop
about: How the agent writes copy that sounds like a person, not a chatbot.
---

# Writing without slop

Slop is copy that sounds like every other AI text. Viewers spot it in one line and stop trusting the video. This skill covers the words only. `card-design` and `type-layout` cover how they look. `audio-voiceover` covers the voice.

Slop is a density problem more than a word problem. One "seamless" is fine. A headline with "seamless", a rule of three and a question is slop. Check the whole piece, not single words.

## What gives it away

These are the patterns people and detectors flag most often (Wikipedia "Signs of AI writing", Pangram "9 Signs of AI Writing", tropes.fyi).

1. **"Not just X, but Y"** and **"It's not X, it's Y."** The most common tell. Also "Not X. Not Y. Just Z."
2. **Em dashes** used as a drama pivot. Use a period or a comma.
3. **Stock words**: delve, tapestry, landscape, realm, seamless, elevate, unlock, empower, leverage, robust, streamline, harness, testament, pivotal, vibrant, crucial, game-changer, cutting-edge, next-level, revolutionize, journey, ecosystem.
4. **Rule of three everywhere.** "Fast, simple and powerful." Once is a style. Every line is a tic.
5. **Question hooks.** "Ready to...?" "Tired of...?" "What if you could...?" "The result? Magic."
6. **Hype openers.** "In today's fast-paced world", "Imagine a world where", "Let's dive in", "Here's the kicker".
7. **Hollow closers.** "Start your journey today", "Take it to the next level", "The future is here", "Join us".
8. **Button copy.** "Get Started", "Learn More", "Level up your...", "Unlock your potential", "Discover more".
9. **Fake specificity.** Invented numbers, "studies show", "experts say", "thousands love it". Never invent a figure, a quote, a review or a source. If a number matters and you do not have it, put a plain placeholder ("Your stat here") and say so in the reply, same as `explainer`.
10. **Copula dodge.** "serves as", "stands as", "boasts", "features" where "is" or "has" works.
11. **Trailing -ing significance.** "..., highlighting its importance", "..., redefining how we create".
12. **Emoji as bullets or decoration**, Unicode arrows, curly quotes, box characters.
13. **Title Case On Every Line.** Use sentence case.
14. **One rhythm.** Every line the same length, same shape, same cadence.
15. **Magic adverbs and filler transitions.** quietly, deeply, fundamentally, remarkably, "It's worth noting", "Importantly".
16. **Announcing and recapping.** "Here are three reasons", "In summary", a closing line that repeats the opening.

## Ban list

Do not write these in any card, caption, CTA or script, unless the user typed the word themselves:

delve, tapestry, landscape, realm, seamless, seamlessly, elevate, unlock, unleash, empower, leverage (verb), robust, streamline, harness, testament, pivotal, vibrant, crucial, game-changer, game-changing, cutting-edge, next-level, revolutionary, revolutionize, transform your, journey, ecosystem, synergy, paradigm, "in today's", "dive in", "Let's dive", "take it to the next level", "Level up", "Ready to", "Get Started", "Learn More", "Discover", "Imagine a world", "not just ... but", "it's not ... it's", "more than just", "whether you're ... or ...", "look no further", "say goodbye to", "worry-free", "effortless".

Also no em dashes, no `--` standing in for one, no emoji, no hashtags unless asked.

## Rewrite table

Say the plain thing. Name what the product or video actually does.

| Slop | Plain |
|---|---|
| Unlock the power of seamless editing | Edit video by typing what you want |
| It's not just an app, it's a revolution | An editor that cuts for you |
| Ready to elevate your content? | Make your next video here |
| Get Started | Try it free (only if it is free) / Open the editor |
| Learn More | See how it works / Read the guide |
| Level up your workflow | Cut an hour of editing down to ten minutes (only if true; else drop the number) |
| Discover the future of storytelling | Tell your story with less work |
| Join thousands of happy creators | Made by one person, used by you (or say nothing) |
| Fast, simple, powerful | Fast. (Pick one real thing.) |
| Your journey starts here | Start with one clip |
| Let's dive in! | (Delete it. Start with the first fact.) |
| Say goodbye to boring videos | Videos people watch to the end |
| A seamless experience that empowers every creator | One tool for cutting, captions and voice |
| In today's fast-paced world, attention is everything | Most people decide in two seconds. (Only with a real source; else cut.) |

Headline rules:
- State the one thing the viewer gets. A noun and a verb, 3 to 7 words.
- No question, no colon pivot, no exclamation mark unless the user's brand uses one.
- Sentence case.

CTA rules:
- The button or end card says the next action in plain words: "Download JV", "Watch part 2", "Subscribe", "Visit example.com". Use the user's real link or name. If there is none, ask or leave a placeholder.
- One action per end card. No "Get started today and unlock...".

Caption rules:
- Captions are the spoken words, not a rewrite. Do not "improve" the speaker. Fix typos only.
- If you write caption lines that describe the action instead of speech, make them plain statements: "Cutting the first clip", not "Watch the magic unfold".

## Spoken lines (voiceover, narration)

Write for the ear, then read it out loud in your head.

- Mix short and long. A 3-word line, then a 15-word line. Never five lines the same length.
- Use contractions: it's, you'll, don't, I'm. "It is" and "do not" sound stiff unless you mean it.
- Start sentences the way people do: "So", "Okay", "Look", "Here's the thing" are fine once. Not every line.
- Say numbers and names the way you would say them to a friend. Spell out what the voice should read.
- One idea per line. If a line needs a semicolon, make two lines.
- No stage direction in the script ("[excited]") unless the voice tool supports it and the user asked.
- No hooks that shout. Start with the first fact or the first action.
- Plain verbs: "make", "cut", "add", "show", "use". Not "leverage", "utilize", "harness".
- It is fine to be a bit rough. A contraction, a fragment, a small aside sounds human. A perfectly balanced sentence does not.
- Game and gameplay lines also follow `game-narration` and `player-pov`.

## Final check

Run this on every piece of copy before you render or send it to `jeditor_tts`.

1. Search the text for every word in the ban list. Any hit gets rewritten.
2. Look for "not X, but Y" and "it's not X, it's Y" in any form. Rewrite as one plain claim.
3. Count dashes. Zero em dashes.
4. Count threes. At most one list of three in the whole video.
5. Is there a question hook or a "Ready to"? Cut it.
6. Is any number, quote, review or source not given by the user or read from their footage? Remove it or use a placeholder, and say so.
7. Is the CTA a real next step with a real name or link?
8. Read the lines in a row. If they all have the same length and shape, change two of them.
9. Would a friend say this out loud? If not, say it the way they would.
10. Could this line sit in any other video unchanged? If yes, make it about this one.

Fix, then render. In your reply, show the final text, not a description of it.
