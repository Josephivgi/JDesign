# Movement preprogramming

Cutline lets vision models program screen movements before recording or while a take rolls. The user sees what will happen next in the chat activity feed before execution finishes.

## Recorder path

1. `recorder_program_movements` runs setup clicks, typing, keys, and scroll on a VirtualBox guest (not on This computer). Steps never return images.
2. The Recorder activity feed shows **Movements next:** with up to eight steps, then `(+N more)` when needed.
3. Nothing screenshots for the agent. A `recorder_computer_use` `screenshot` action is the only frame capture, and a fresh screenshot review is required before `recorder_start` or `recorder_clip`.
4. `recorder_clip` records a programmed clip in one call: it starts the take, runs the steps so the screen moves while it records, then stops and returns the saved video. `durationSeconds` keeps the take rolling after the steps.
5. `recorder_start` is the open ended take. Drive the screen while it records with `recorder_program_movements`, then `recorder_stop`. `recorder_start` may pass `durationSeconds` for planned length. The status bar shows `Recording for Ns / Xs planned`.

Implementation:

| Layer | File |
|-------|------|
| Tool | `lib/recorder-program-movements.js`, `lib/recorder-clip.js`, `vendor/editorpi/src/kernel/recorder-tools.ts` |
| Review gate | `lib/recorder-review-state.js` |
| Recorder UI | `renderer/js/record-agent.js` |
| Shared copy | `renderer/js/recorder-activity.js` |

## Edit videos and AI Video editing

The same activity helpers power Edit videos and AI Video editing chat:

- **Screen movements:** if recorder tools appear in the edit harness session, `recorder_program_movements` lines render as plan messages in the video chat thread.
- **Edit/render plans:** before heavy tools run, the chat shows:
  - `Edit plan:` from `jeditor_apply_edit` (headline, motion, intro, zoom, end card fields)
  - `Render next:` from `jeditor_compose_finished` (video and card ids)

Wiring: `renderer/js/agent-panel.js` listens for `terminal` agent events in video mode. `renderer/js/video-chat.js` renders plan rows with `is-plan` styling.

Chat history persists in SQLite via `lib/editor-chats-store.js`.

## Timing

Programming movements for a 30 second clip may take several minutes. That is expected. The preview list appears when the tool call starts, before steps finish.

## Tests

- `test/recorder-program-movements.test.js`
- `test/recorder-clip.test.js`
- `test/recorder-review-state.test.js`
- `test/record-agent.test.js`
- `test/editor-tool-activity.test.js`
