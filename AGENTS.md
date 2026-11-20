# JDesign

JDesign is one Electron app with two AI studios in one window: **Video** (JV, the video editor, `electron/`, `lib/`, `renderer/`) and **Draw** (JDraw, the drawing app, in `draw/`). It was made on 2026-11-17 by copying JEditor and JDraw into this folder; the original folders are untouched and are not read or written by this app.

## How the two studios fit

- `electron/main.cjs` owns the app: name, data folder (`%APPDATA%\JDesign`, video data in `data/`, Draw in `draw/`), single-instance lock, the one `BrowserWindow`. JV's renderer is the window's own page.
- `draw/studio.cjs` (was JDraw's main.cjs) exports `init({ window, dataDir, onSwitch, getThemeMode, setThemeMode, getAccent, addToVideoLibrary })`. It puts JDraw's renderer in a `WebContentsView` that sits beside JV's rail (68px, `RAIL_WIDTH`) while Draw is on show and keeps running when hidden (an agent can keep drawing while you edit video). `draw/preload.cjs` and `draw/renderer/` are JDraw's, with small edits.
- Switching: the rail buttons Video Editor / Drawing (Ctrl D). The rail stays on show in both studios, so Draw has no switch of its own. IPC `studio-switch` (JV) and `studio:switch` (Draw) both end in `switchStudio` in main.cjs.
- One theme: JV's Light / Dark / System choice wins. `set-chrome` forwards the mode and the accent to Draw (`theme:set`); Draw's own toggle sends `studio:theme` back to JV. Draw uses the same neutrals, type and accent tokens as JV and keeps no accent of its own (`prefs:get accent` answers with JV's).
- Draw to Video: Draw export menu, "Add to video library" (`studio:to-video-library` -> `addToVideoLibrary` -> the same library writer as a dropped file).
- Each studio keeps its own agent list, MCP server (`jeditor-app` and `jdraw`) and chats. Not unified yet: one shared agent list, one shared chat, an agent that edits video and draws in the same turn.
- Names left as they were on purpose: `window.cutline`, `window.jdraw`, `jeditor_*` MCP tools, `mcp__jdraw__*` permission gate, env vars `JEDITOR_*` and `JDRAW_*`, MCP server ids. `JDESIGN_USER_DATA` sets the data folder (it also accepts `JEDITOR_USER_DATA`).
- Electron is 45.2.1 (Draw needs `node:sqlite`).

## Verify (hidden only, scratch data folder, never %APPDATA%\JDesign)

- Video studio: `JDESIGN_USER_DATA=<scratch> JEDITOR_SMOKE_SHOTS=<dir> electron . --smoke` (also checks that Draw's view loaded and the switch shows/hides it). Add `JEDITOR_SMOKE_AGENT` for a real turn.
- Draw studio: `JDESIGN_USER_DATA=<scratch> JDRAW_SMOKE_SHOTS=<dir> electron . --draw-smoke` (52 checks; add `JDRAW_SMOKE_AGENT=claude-code` for a real turn, `JDRAW_GATE_ROUNDS=1` keeps it short). The Draw smoke runs the same renderer in its own never-shown window, because a view in a window that is never shown gets no frames.
- Not verified: the Draw view inside a visible window (needs a VM or a person looking); draw's `--drive` and `--mcp-host` modes were dropped in this app.

# JV (the Video studio)

Local Electron AI video editor driven by ACP agents. Successor to Cutline Desktop (`C:\Users\Joe\cutlinedesktop`), with a new window and the same backend. See ARCHITECTURE.md for the map.

Global rules still apply (writing-style, UI layers, no windows on the desktop, real software only).

## UI

- One stylesheet: `renderer/styles/app.css`. Use its tokens (`--bg-0`..`--bg-4`, `--text`, `--text-2`, `--text-3`, `--line`, `--accent`, `--stage`, spacing `--s-*`, radius `--r*`, type `--fs-*`) and components (`.btn`, `.input`, `.switch`, `.seg`, menus via `showMenu`, dialogs via `openDialog`). No raw colors in page CSS.
- Themes: light, dark, system (`data-theme`), accents through `data-accent`, density and chat text size through data attributes on `html`. All set by `applyLook` in `renderer/js/store.js`.
- Icons come from `icon()` in `renderer/js/ui.js`. No emoji, no colored status dots: plain text when healthy, icon plus label for problems.
- The stage stays dark in both themes.
- One primary action per view. UI copy: short, plain, no dash punctuation.
- Preferences go through `setPrefs` (main process `jeditor-prefs.json`), never localStorage as the source of truth.

## Chat and agents

- Agents run over ACP only (`electron/acp-host.cjs`). The `jeditor-app` MCP server is injected into every session; never add a setup step.
- The host owns the transcript and saves it to the chat row. The window draws from `acp-event` deltas (`renderer/js/sessions.js`) and never writes `acpTranscript` itself.
- The Agents page Marketplace lists the public ACP Registry (`lib/acp-registry.js`, cached in `<data>/acp-registry`). Add installs into that folder (npm package, or a binary checked against the registry sha256, or uvx) and saves a `registry` row in `acp-agents.db` with id `registry-<registry id>`. When a registry agent is one of the built-in agents already on the computer, Add uses that copy instead. Smoke: `JEDITOR_SMOKE_MARKET=view` opens it, `JEDITOR_SMOKE_MARKET=<id>,<id>` clicks Add.
- Model pickers (Home and chat) get their list from the agent itself: `acpModels` runs initialize and session/new in a scratch folder with no tools, then caches the list in `editor-chats.db` (`acp_model_cache`). Every live session refreshes that cache. The chosen model is applied with `session/set_config_option` (or `session/set_model`) right before the prompt; model switches get 90 s because Claude Code can take 30 s to finish starting.
- The first launch on a data folder adds every catalog agent installed on this PC (`addInstalledAgents` in `electron/main.cjs`, marker `.agents-detected`). Home disables Create and shows a setup notice when no agent is ready.
- Long tool calls: the HTTP bridge streams a `tools/call` as server-sent events with `notifications/progress` every 15 s when the client sends a progress token, because Claude Code drops a call that is silent for 300 s. Claude Code also gets `MCP_TOOL_TIMEOUT=1800000` (renders take minutes).
- Picker buttons inside a form must be `type="button"`; the Home launcher only submits from Create or Enter.
- A chat binds to the first agent that answers. Picking another agent hands the chat off (`acpHandoff`), which carries the history to the new agent.
- Slash commands: every skill with `command:` in its SKILL.md frontmatter becomes `/name` in the chat and Home boxes (`lib/slash-commands.js`, `renderer/js/slash.js`). Frontmatter also sets `label`, `hint`, `group`, `icon`, `next` (follow-up chips after a turn), and `needs: clip`, which blocks a workflow with a plain reason when the project has no clip (`workflowBlocked`). Agent native commands are listed after JV's.
- A failed turn shows one plain explanation and one button (`explainFailure` in `renderer/js/chat.js`: Continue, Try again, Restart agent, Sign in). A message queued during that turn is held until the person sends it. Restart agent restarts the session and resends the failed message.
- What was actually sent to the agent (context, pinned media, history) stays off the bubble, behind "What was sent".
- Skills are prompts and every task that reads one pays for it, so they are measured: `node scripts/mcp-tools-check.cjs` fails on a skill that names a tool the surface does not have, and a rewrite must cut bytes without dropping a rule (keep every tool name, limit, order and do not).
- ElevenLabs and instruction changes ask through permission cards (`acpPermissionAnswer`). Agents can never apply instruction changes without approval.

- Voice chat: the mic button in the chat and Home boxes records with MediaRecorder (`renderer/js/voice.js`) and `voice-transcribe` turns it into text (`lib/speech-to-text.js`: ElevenLabs Scribe when a key is saved, else the offline Windows recognizer via ffmpeg + System.Speech). Replies are read aloud when `speakReplies` is on (speaker button in the chat header, Settings > Chat): `voice-speak` (`lib/speak-text.js`) returns Windows voice WAV or ElevenLabs MP3 and strips markdown, code and links first. Hidden test: run the smoke with `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream --use-file-for-fake-audio-capture=<wav>` and mute `HTMLMediaElement.play` in the eval.

- ElevenLabs setup lives in Settings > Voice and music: a three step guide when no key is saved, then account, permission and voice rows. `elevenlabs-save` with `verify: true` probes the key first (`checkKeyedProbe`) and refuses a key ElevenLabs turns down on every check, so a typo never replaces a working key. `elevenlabs-try` speaks one short line without saving it to the library.

## Outside agents

- The same MCP serves agents started outside JV, so a terminal agent or a T3 Code agent sets up and edits a project like the in-app chat does. `npm run mcp:install` writes a `jeditor` stdio entry into each agent's own config (Claude Code, Pi, Droid, OpenCode, Cursor, Gemini CLI, Qwen Code, Codex CLI), always `node <data>/jeditor-mcp.cjs` and never the install folder, because that path carries the version. Any change to the launcher arguments or the server name breaks every config already written, so change them only with `--check` passing.
- `npm run mcp:install -- --check` spawns that exact command at the real data folder for the handshake and tool list, then creates, reads, renames, lists and deletes a project in a scratch data folder, so it proves control without touching a library.
- The launcher source lives in `lib/mcp-launcher.js`: `electron/agent-bridge.cjs` writes it on every start, and the installer writes it with the app root baked in as a fallback, so a config works before JV has been opened once.

## Plugins

- Visual style skills: `skills/style-<id>/SKILL.md` + `example.png` (15 looks from Image Studio: watercolor, pixel art, neon and more). Each says how to get that look in card HTML/CSS and code animations; agents read them with `jeditor_get_skill`.
- Agents extend the window with plugins: `<data>/plugins/<id>/plugin.js` (an ES module exporting `activate(jv)`) plus `plugin.json`. Store and rules in `lib/plugins.js`, loader and the `jv` API in `renderer/js/plugins.js`, agent guide in `skills/plugin-maker/SKILL.md` (`/plugin`).
- Agents write with `jeditor_plugin_write` (syntax checked with Electron as Node; nothing saved on an error), and read with `jeditor_plugin_list` / `jeditor_plugin_read` (includes runtime errors). They cannot turn plugins on or delete them.
- Approval: a plugin runs only when the person turned it on in Settings > Plugins (after seeing the code) and its code hash still matches `approvedHash`. Any later write makes it "changed" and it stays off until approved again. The `jvplugin:` protocol serves code through `pluginCodeIfApproved`, and the CSP allows scripts only from `'self'` and `jvplugin:`.
- What a plugin adds (palette commands, rail pages, project top bar buttons, `page` / `project-open` / `workspace-changed` listeners) is tracked per plugin and removed when it turns off, without a restart. Callbacks run through `guard()`: errors are recorded for agents and five in a minute turn the plugin off.

## Rendering

- `jeditor_render_animation` makes footage from HTML/CSS/JS with a deterministic page clock (`SCRIPT_RUNTIME` in `lib/animation-render.js`): `performance.now`, `Date.now`, `requestAnimationFrame`, `setTimeout` and `setInterval` all follow the frame time, and `Math.random` is reseeded per seek so split workers agree. CSS started from script is reported as a `css motion` script error. The motion kit is `window.JV` (`lib/animation-motion.js`).
- Presets live in `lib/animation-presets.js`. Each has `minMs` and gets `ctx.durationMs`, so exits, word pacing and pulses follow the length. `animationSource` raises a too short length with a note and adds a slow push-in on long holds.
- Replacing a clip (`replaceClipId`, or Edit design from the gallery) goes through `swapClip`/`adoptDesign` in `lib/project-design.js`: it keeps the clip's place, carries its edits, and records `state.previousVersion` for the editor's Previous version button. A clip with edits is not registered as the finished video; the editor shows Render video instead (stale check via `editSig`, duplicated in `lib/video-render.js`, `renderer/js/pages/editor.js` and `renderer/js/prompt.js`).
- Multi scene animations: `scenes` on `jeditor_render_animation` and `jeditor_animation_frames` (`scenesSource`, `renderScenes`, `sceneFrames` in `lib/animation-render.js`). Each scene renders as its own frame sequence and ffmpeg `xfade` joins them (falls back to fades if a transition fails). The scene list is saved as the clip's source. Audio entries can carry `startMs`, or `scene: N` to start a voice line with its scene; a scene shorter than its line grows to fit. `jeditor_tts` takes `lines` for a whole script under one approval. The `/explainer` skill drives this end to end.
- Frames render in hidden worker processes (`lib/html-render.js`). Do not move rendering back into the app process: it froze the window for minutes. The worker blocks every request except its own document (`onBeforeRequest` in `lib/html-render-worker.cjs`); images reach a page as data URIs.
- Tool specs can have `validate(input)`; `lib/mcp-server.js` runs it before an approval prompt so a bad call never asks the user. Both kinds carry one: the tool specs in `lib/agent-tools.js` and the base defs in `lib/mcp-server.js`.
- A render belongs to the project that made it (`state.renders[sourceId] = renderId`, items carry `projectIds`). Library and finished files dedupe by content hash, never by name.
- Project state is replaced whole on `aiProjectUpdate`; read the row before writing (`patchState` in the editor).

## Library

- Imports go through `api.addFiles({paths})` with `add-files-progress` events. A skipped duplicate is reported, never silent.
- Video stills come from a canvas grab with `crossOrigin = "anonymous"` (the `cutline://` scheme taints the canvas otherwise), brightest frame of the first second.

## Verify

There is no test suite on purpose. Before shipping, run these in order; each proves something the others cannot:

1. `npm run check:mcp` proves the tool surface: no repeated name, every description and parameter documented, every skill naming a tool that still exists.
2. `npm run check:mcp:errors` calls every tool through the stdio server with no arguments, a made up id and a few bad shapes, and proves each refusal is one sentence an agent can act on.
3. `npm run quality` runs the two above plus a real 2 second render through the MCP, and checks codec, profile, pixel format, audio format and loudness. Use this one when there is only time for one command.
4. The hidden smoke proves the window: `JEDITOR_USER_DATA=<scratch> JEDITOR_SMOKE_SHOTS=<dir> electron . --smoke` visits every page and prints a JSON report.
- A real turn: add `JEDITOR_SMOKE_AGENT` and `JEDITOR_SMOKE_PROMPT`; the report is only `ok` when the turn finished with a reply and no error. `JEDITOR_SMOKE_AGENT2` (for example `claude-code`) and `JEDITOR_SMOKE_PROMPT2` hand the same chat to a second agent through the agent menu, and `JEDITOR_SMOKE_UI=1` clicks through drafts, step details, dialogs and the narrow layout on a data folder from an earlier run.
- Add `JEDITOR_SMOKE_MODEL=<model id>` (for example `haiku` with `claude-code`) to pick the model on Home with the real picker, press Create, and check the live session runs that model.
- Development version: `npm run dev` runs from the repo with `JEDITOR_DEV=1`, data in `%APPDATA%\JV Dev` and window title "JV Dev". Its first launch copies the agent list from `%APPDATA%\JEditor` and adds every catalog agent installed on this PC.
- `JEDITOR_SMOKE_EVAL=<file.js>` runs an async script in the project page and puts its return value in the report; `JEDITOR_SMOKE_EVAL_AFTER` does the same after the agent turn. The report also has `homePickers` (opening Home pickers must not create a project).
- Use a scratch `JEDITOR_USER_DATA`, never the real data folder.
- Env vars read `JEDITOR_*` first and the old `CUTLINE_*` name second, and a child process is given both spellings. Agents start the MCP through `<data>/jeditor-mcp.cjs`; `cutline-mcp.cjs` stays beside it as a two line shim, so configs written before the rename keep working with no migration.
- Visual click testing goes in a VirtualBox guest, never the host desktop.

## Not built yet

Record Center, card studio, the manual timeline editor, and the full cleanup suggestions UI from Cutline. The backend for them is still in `lib/`.
