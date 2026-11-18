---
name: export
description: Hand a finished result to the person: save the render as a file, pack a whole project with its media and edit history, or write a card out as a PNG or a standalone HTML page. Covers where files land and what each export contains.
icon: download
command: export
label: Hand it over
hint: Video, project, or card
group: Delivery
next: video-improve, captions
title: Export and hand off
about: How the agent puts a finished video or a whole project in your hands.
---

# Export

JV keeps everything inside its own data folder. An export is the moment work leaves it, so get the name, the place, and the contents right the first time.

## A finished video

- `jeditor_list_finished` gives the renders with id, name, size, and duration. `jeditor_get_finished` returns one row with its absolute `path`, which is what you need to inspect or copy it.
- `jeditor_export_finished` copies a render to `destPath`. Pass a folder to keep the render's own name, or a full file path to name it yourself.
- Do not re-render to change a file name. Copy it.
- A render that is out of date says so when you read the project: it was made before the latest timeline edits. Re-render with `jeditor_render_project` before exporting, and say which take the person is getting.

## A whole project

`jeditor_export_project` writes a folder with `project.json`, copies of every library file the project uses, its cards, and `agent-activity.json` listing which agent made each edit. Use `finishedId` to include one render in the same folder.

That export is for handing work to someone else or keeping an archive. It is not a backup of the app: preferences, the agents list, and unrelated library items stay behind.

## A card or a still

- `jeditor_export_card` with `format: "png"` writes the exact design the video pipeline burns. With `format: "html"` it writes a self-contained page, images embedded and color variables inlined, that opens in any browser.
- `jeditor_render_card` is the quick look: it renders a PNG you can inspect without exporting anything.

## Rules

- Never write an export over a file that already exists unless the person asked for that. Pick a new name.
- Say where the file went, as a path the person can open. "Saved to your Videos folder" is not a path.
- Name by what it is: `summer-recap-v2.mp4`, not `export-final-final`.
- If the person asked for a share link, a local export is not that. A file on this computer has to be uploaded by them or by a tool that does uploads.
