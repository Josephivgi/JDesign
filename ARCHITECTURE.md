# JV architecture

Electron app. The main process owns all data and the agents; the window only draws.

## Main process (`electron/`)

- `main.cjs`: window, `cutline://` media protocol, workspace IPC. Its first lines route `--html-render-worker` launches to the frame renderer instead of the app.
- `acp-host.cjs`: runs ACP agents, one session per workspace/project/chat/agent. It keeps the transcript, streams `acp-event` deltas to the window, and saves the transcript to the chat row itself (`schedulePersist`), so a chat survives a closed window. Session open retries while an agent is still warming up (`whileWarmingUp`; OpenCode answers ServiceUnavailableError while its plugins load).
- `agent-bridge.cjs`: the `jeditor-app` MCP server on 127.0.0.1 (port 47831 or a free one). It is injected into every ACP session; no setup step.
- `jeditor-ipc.cjs`: preferences (`jeditor-prefs.json`), about, data folder, and the Cutline import.
- `smoke.cjs`: hidden end to end run (`--smoke`).

## Shared libraries (`lib/`)

CommonJS, used by the main process and the MCP server. Tool names carry the `jeditor_` prefix (they were `cutline_` before the JEditor rename, and the `cutline://` scheme keeps the old name). Environment variables are read as `JEDITOR_*` with the old `CUTLINE_*` name behind them, and the MCP launcher is `jeditor-mcp.cjs` with `cutline-mcp.cjs` kept beside it as a shim for agent configs written earlier. Stores are SQLite (`node:sqlite`): editor-chats, ai-video-projects, user-rules, acp-agents, agent-activity.

Frames for animations and HTML cards render in hidden worker processes (`lib/html-render.js`), never in the app's own process: rendering in-process blocked the window for most of a second per frame.

## MCP surface and output

Four servers, all built from the same spec objects: 15 base and 54 agent tools in the file-backed `jeditor-mcp.cjs`, 28 `cards_*` tools for the card studio (`--profile cards`), 3 `content_*` research tools, and 30 live app tools on the bridge. Agents read the 44 skills in `skills/` through `jeditor_get_skill`.

Agents outside JV get the same servers. `scripts/mcp-install.cjs` writes a `jeditor` stdio entry into the installed agent configs, all pointing at `<data>/jeditor-mcp.cjs`; the launcher source is `lib/mcp-launcher.js`, written by the app on every start and by the installer before the app has run. With JV closed those agents get the file-backed tools; with it open the bridge adds the window, browser, download and recorder tools, and `runCheck` in that script proves both halves.

Everything delivered is H.264 High profile, yuv420p, faststart, AAC 48 kHz stereo, and plays on the stage and in a browser. The project render (`lib/video-look-graph.js`) encodes crf 18 at veryfast, declares High 4.1, mixes at 192k and runs `loudnorm` at -14 LUFS (TP -1.5, LRA 11) when tracks are mixed. A composed clip (`lib/compose-finished.js`) encodes crf 20 at medium with 160k audio; an animation (`lib/animation-render.js`) crf 18 at medium with 160k audio. `npm run quality` proves the surface, the failure messages and a real 2 second render in one command.

## Window (`renderer/`)

Plain ES modules, no framework or build step.

- `js/store.js`: app state, event bus, preferences, theme.
- `js/sessions.js`: live ACP sessions and `displayItems`, which turns transcript rows into chat items (grouped tool steps, thinking, plans, permission cards).
- `js/chat.js`: the chat panel. `js/pages/*`: home, library, agents, settings, editor.
- `styles/app.css`: one stylesheet built on tokens (theme, accent, density, chat text size).

`window.cutline` is the preload API name, kept from Cutline.
