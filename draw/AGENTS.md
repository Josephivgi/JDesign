# JDraw

Electron drawing app with ACP agents. Global rules apply (writing style, no windows on the desktop, real software only).

## Map

- `main.cjs`: window, IPC, agent sessions, chat transcripts (main owns them), smoke hooks.
- `lib/store.cjs`: SQLite (`node:sqlite`, no native modules). The main process owns every open drawing; all edits go through `apply(id, ops)` as one undo step and come back to the window as `doc:changed`.
- `lib/mcp-server.cjs`: the `jdraw` MCP server (Streamable HTTP, JSON replies, bearer token, drawing id in the `x-jdraw-drawing` header). Injected into every ACP `session/new`.
- Settings (gear icon on Home) lists all 18 skills read-only via `skills:list` (`listSkills` in `lib/styles.cjs`). `npm run pack` (electron-builder --dir) packs `skills/**` into app.asar.
- `skills/styles/<id>/SKILL.md` + `example.png`: style skills (15 looks from Image Studio, examples drawn in JDraw). `lib/styles.cjs` reads them from disk; agents get them through the `list_styles` and `get_style` MCP tools (the guide plus the example image).
- Chat `/` menu (`renderer/js/assistant.js`): JDraw skills from `skills:list` (sent as a prompt that tells the agent to call `get_style`) and the agent's own commands from ACP `available_commands_update` (sent alone as one prompt block, which is what makes Claude Code run them as commands).
- Slop gate (`main.cjs` runGate): after an agent turn that changed the drawing, `checker/slop_check.py` (via `lib/slop-check.cjs`, needs Python 3 + Pillow) measures it, then `lib/finish.cjs` (artist finish: OKLCH color grade, painted-edge SVG filter, paper grain; skips the person's own items) runs, then a read-only reviewer agent (`REVIEW_BRIEF` in `lib/acp.cjs`, max 6 issues). Issues go back to the drawer, up to `JDRAW_GATE_ROUNDS` (default 4). Prefs `slopGate` and `artistFinish` (default on). Agents get `check_drawing` and `finish_drawing` MCP tools.
- `lib/acp.cjs`: ACP client and agent catalog. Permission requests are allowed only for `mcp__jdraw__*` tools; everything else is rejected.
- `renderer/js/geom.js`: item model shared by the window and main (normItem, bounds, move, scale).
- `renderer/js/render.js`: Canvas 2D renderer, one canvas per layer. `canvas.js`: input and tools. `editor.js`, `assistant.js`, `home.js`: screens. `layers.js`: floating layers card (rows are kept between renders so rename and drag work).
- Agent choices come from the agent: Claude Code reports `model` and `effort` (category `thought_level`) as ACP config options; they are cached per agent in prefs and applied before each turn.
- Merge down of a layer with erasers or a blend mode renders the pair into one image (`flatten_into`); otherwise items move as they are.

## UI

- One stylesheet, `renderer/styles/app.css`. Tokens on `:root`, dark theme under `[data-theme="dark"]`. No raw colors in rules.
- Icons from `icon()` in `renderer/js/icons.js`. No emoji, no colored status dots.
- Prefs go through `prefs:get`/`prefs:set` (SQLite), not localStorage.

## Verify

- Hidden smoke only: `JDRAW_USER_DATA=<scratch> JDRAW_SMOKE_SHOTS=<dir> electron . --smoke`. Add `JDRAW_SMOKE_AGENT=claude-code` for a real agent turn (report.json has the reply, tool calls and the chat as drawn). `JDRAW_SMOKE_UI=1` adds a dark theme capture.
- Hidden window captures can be stale (no animation frames while hidden). Trust exported PNGs and DOM checks.
- Use a scratch data folder, never `%APPDATA%\JDraw`.
