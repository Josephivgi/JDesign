---
name: source-footage
description: Find, inspect, pin, and reuse the user's original videos and clips: library reads, frame checks, per-clip timelines, and pulling a range out as its own clip.
title: Your footage
about: How the agent finds and reuses your original videos.
---

# Source footage

The library holds every original clip the user ever added. All of it is reachable, and every pinned clip gets its own timeline, so using old footage or just part of it is normal work, not a special case.

## Find and inspect

- `jeditor_list_library` with `kind: "video"` lists clips with name, duration, size, and `aiCanUse`.
- `jeditor_get_library_item` is the metadata read: it returns the `path` on disk, and for video probes and saves a missing `durationMs` and returns `durationSeconds`. A file ffmpeg cannot read comes back with `probeError` and no duration.
- `jeditor_probe_audio` reads a clip's audio straight from `libraryId`, no pinning needed.

## Seeing the footage

There are no stills of an unpinned clip. Pin it first, it is one non-destructive call:

1. `jeditor_project_add_assets` with the library id, or `assetIds` on `jeditor_create_project`.
2. `jeditor_preview_frames` with `projectId` and `videoId` returns real frames: each moment framed as the render will be, plus the raw source frame with grid lines for reading focus points. `times` are source seconds, up to 8 moments.

`jeditor_get_timeline` on the same clip reports duration, fps, frame count, and whether it carries audio.

## Use part of a clip

Each pinned video keeps its own `videoEdits` and its own render pointer, so a project can hold several sources at once. `videoId` on `jeditor_get_timeline`, `jeditor_edit_timeline`, `jeditor_preview_frames`, `jeditor_auto_scale`, and `jeditor_render_project` overrides the selection, so you never have to switch clips just to edit. Always pass `videoId` when a project pins more than one video; without it the tools target the first pinned one. To move the stage and the user's eyes instead, set `state.selectedAssetId` with `jeditor_update_project`.

- `{ "type": "keep", "start": S, "end": E }` keeps only that range.
- `{ "type": "cut", "start": S, "end": E }` removes that range.
- `{ "type": "reset" }` restores the whole clip.
- `fromFrame` / `toFrame` cut exactly on frames once `jeditor_get_timeline` reports the fps.

## Pull a range out as its own clip

There is no lossless extract; a range becomes a standalone clip through the render:

1. `jeditor_edit_timeline` on the source with `{ "type": "reset" }` then `{ "type": "keep", ... }` (and no look ops; match the project ratio to the source for a clean pull).
2. `jeditor_render_project` for that `videoId`.
3. `jeditor_project_add_render` with the render id copies it into the library, pinned and selected. That copy is now an ordinary clip: pin it into any project with `jeditor_project_add_assets` or `assetIds` at create time.

## Limits to respect

- One render is always one source. There is no splicing two clips into one render; layering is image overlays, audio tracks (`sound` ops or `audioId` on render), and cards via `jeditor_compose_finished`.
- Every timeline edit drops that clip's render pointer, so an extraction always costs a fresh render.
- The render re-encodes at the project ratio (1080 on the short side); it is the right path for editing, not for archiving untouched source segments.
