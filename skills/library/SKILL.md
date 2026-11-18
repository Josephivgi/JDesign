---
name: library
description: Bring footage, images, and audio into JV and keep the library usable: import files and links, name and describe items, decide what agents may use, link a clip to its track, and remove what is no longer wanted.
icon: library
command: library
label: Tidy the library
hint: What to bring in or clean up
group: Media
next: source-footage, ai-video-edit
title: Library
about: How the agent imports, labels, and prunes the media in your library.
---

# Library

Every original clip, image, sound, and generated track lives in the library. Projects point at it, and nothing plays in JV that is not there. Importing and naming is real work, not bookkeeping: a library with `clip (2)`, `clip (3)` and no durations is a library an agent cannot plan from.

## Bring a file in

- `jeditor_add_files` with a `paths` array of absolute paths. A video comes back with its probed `durationMs`, so plan cuts from that number, not a guess.
- `jeditor_add_from_url` when the source is a link. It downloads with the app's cookies, which matters for anything behind a sign in.
- `jeditor_add_from_base64` for bytes you made or received inline, such as a generated image. There is no file on disk to point at.
- An item the library already has is skipped, not duplicated: the reply says so in `skipped`. Never rename a file on disk to get around it.

## Read before you plan

- `jeditor_list_library` returns short rows: id, name, kind, size, duration when known, and `aiCanUse`.
- `jeditor_get_library_item` returns one row in full, with its `path` on disk, and probes and saves a missing `durationMs`. A file it cannot read comes back with `probeError` and no duration, not a zero.
- `jeditor_probe_audio` is the sound read: has audio, mean and peak level, clipping, silences. Use it before deciding on sound, and again after a render.

## Label it so the next call is easier

- `jeditor_update_library_item` renames, sets a description, or sets `aiCanUse: false` to keep a clip away from agents.
- Name for the job, not for the file: "interview wide", "gameplay 02, push to B". A description is where a voiceover keeps its script, so leave it alone on a track an agent made.

## Pair and prune

- `jeditor_link_items` pairs a clip with its track so they are found together; `jeditor_unlink_items` by link id.
- `jeditor_delete_library_item` takes the item and its file, and every card and project that pointed at it is cleaned up. It needs `confirm: true`. A render is not a library item: `jeditor_delete_finished` is the one for that.

## Rules

- Never add a file "just in case". Every item is something a person has to scroll past.
- Never change `aiCanUse` to true to unblock yourself. That flag is the user's decision about their own footage.
- Before recommending a delete, say what still points at the item: a project clip, a render, a card background.
- If a person asks what is taking space, `jeditor_list_library` with no filter plus size per row answers it without a second tool.
