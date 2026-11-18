---
name: video-edit-setup
description: Setup guide for Edit videos chat on the multi-track studio page.
title: Edit setup
about: Setup notes the agent reads before editing.
---

# Video edit setup

What this computer needs for chat on Edit videos.

## 1. Local agent CLI

The command is `editorpi`. It is a fork of Pi from pi.dev. Data is `~/.editorpi/agent`. Do not read or write official Pi's `~/.pi`.

## 2. Setup panel

Open Setup on Edit videos. Connect ChatGPT Plus/Pro, Claude, xAI, Copilot, OpenRouter, or paste an API key. Credentials go to `~/.editorpi/agent/auth.json`.

Ollama is optional. Use it only if you want a local model.

## 3. Pinned files

Uploaded files are pinned for the model. Call jeditor_get_library_item on each pinned id and use that footage.

## 4. Preview and library

When you write a source clip, call `jeditor_add_files` with its absolute path in a `paths` array so it plays in the live monitor and Library Videos. When the clip is complete, call `jeditor_add_finished_video` so it appears on Finished videos. Browse media with `jeditor_list_library` and `jeditor_get_library_item`.

## 5. Tools

Use jeditor_list_library, jeditor_get_library_item, jeditor_list_cards, jeditor_get_card, jeditor_apply_edit, and jeditor_compose_finished. Omit cardId on jeditor_apply_edit to create a new edit card. After a title card, call jeditor_compose_finished so a clip lands on Finished videos. Skills stay on the agent. Do not list them to the user.
