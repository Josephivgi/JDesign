---
name: stage-preview
description: Control what the open AI Video project plays on its stage: Source (the live cut) or an Output render.
title: Preview control
about: How the agent switches what the preview shows.
---

# Stage preview

In the window these are labeled **Original** (Source) and **Finished video** (Output), and the Outputs list is titled **Finished videos**. Use those names when you talk to the user.

The AI Video editor's preview has two sides. Source is the selected clip with the live cut and look applied, before any render. Output is a rendered video from the project's Outputs list.

A fresh `jeditor_render_project` lands on the stage on its own, and an edit that invalidates the render puts the stage back on Source by itself. Use this skill's tool only when you want to change what the user is watching without touching the edit.

## Tool

`jeditor_app_preview` exists only while the app runs, and it acts on the project open on screen. Open one first with `jeditor_app_open_project` when needed, and check `jeditor_app_state` when you are not sure a project is open.

- `{ "mode": "source" }` plays the live cut again, the same as the user clicking Source.
- `{ "mode": "output" }` plays the project's current render.
- `{ "renderId": "..." }` puts that render on the stage, the same as the Outputs row's Show button. It changes what the stage plays now; nothing is saved.

The call returns the mode now on stage plus the selected clip and output ids.

## When to use it

- After reviewing a render for the user, flip back to `source` so the next edit previews live.
- When the user asks to see an earlier render, pass its id from the Outputs list instead of rendering again.
- Do not call it to make a render appear: `jeditor_render_project` already puts its result on stage.

## Move a render back into editing

Watching is not editing. To cut or re-frame a render, or to keep working on a past version, pull it into the project as a source clip with `jeditor_project_add_render`.

1. Find the render id in `jeditor_get_project`'s `outputs` list. It covers the clip each source points at plus every past render the project still owns, so earlier versions are reachable too.
2. `jeditor_project_add_render` with the `finishedId` copies it into Videos and images, pins it on the project, and selects it as the timeline clip. Pass `projectId` to add it to the open project; omit it to make a new project on the render.
3. Edit it like any source: `jeditor_get_timeline`, `jeditor_edit_timeline`, `jeditor_preview_frames`, `jeditor_render_project`.

The render is never destroyed: the copy in the library becomes the source, and the original stays in Outputs. Original library clips are already editable; pin them with `jeditor_project_add_assets` and select them with `jeditor_update_project` `state.selectedAssetId` when the timeline should follow them.
