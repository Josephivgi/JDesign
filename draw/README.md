# JDraw

A drawing app for Windows with an AI assistant that draws with you. Sketch something, then ask the assistant to color it, shade it, clean up the lines, add a background or finish it. It can also draw from scratch and add colors to your palette.

The assistant is a real coding agent running on your PC over the Agent Client Protocol (ACP): Claude Code (through the Claude Agent SDK adapter), OpenCode, Gemini CLI or Codex. JDraw gives it an MCP server with drawing tools, so it sees the canvas and edits it the same way you do, with undo.

## Drawing

- Brushes: ink pen (pressure and speed taper), pencil, marker, airbrush, eraser.
- Steady slider smooths shaky lines. Hold still at the end of a stroke to turn it into a straight line or a clean ellipse.
- Shapes (rectangle, ellipse, line, outline or filled), fill bucket, color picker, text.
- Select, move, scale (corner handle), delete, arrange.
- Layers with visibility, opacity, blend modes, merge down.
- Pan with Space or the middle button, zoom with the wheel.
- Export PNG (1x, 2x, transparent) or JPG.

Shortcuts: B brush, E eraser, V select, U shapes, G fill, I color picker, T text, H hand, [ and ] brush size, Ctrl+Z / Ctrl+Y, Ctrl+0 fit, Ctrl+E export.

## Assistant

Pick an agent and a model at the top of the Assistant panel. Quick actions change with what is on the canvas (empty, a drawing, or a selection). The assistant puts its work on new named layers, and **Undo AI changes** puts the drawing back the way it was before its last turn. It can only use JDraw's tools: requests for files, commands or other tools are refused.

Install an agent if you do not have one:

```
npm i -g @agentclientprotocol/claude-agent-acp   # Claude Code (sign in to Claude Code once)
npm i -g opencode-ai                             # OpenCode
```

## MCP tools

`view_drawing` (PNG of the canvas), `get_drawing` (layers, items, selection), `draw` (strokes, shapes, polygons, SVG paths, text, gradients, shadows, blend modes), `draw_svg`, `edit_items`, `delete_items`, `recolor`, `set_palette`, `set_brush`, `canvas`, `layers`.

## Data

Drawings and chats are stored in SQLite at `%APPDATA%\JDraw\jdraw.db`. Nothing leaves your PC except what the agent you pick sends to its own service.

## Develop

```
npm install
npm start
```

Hidden smoke test (no window on screen):

```
set JDRAW_USER_DATA=<scratch folder>
set JDRAW_SMOKE_SHOTS=<folder for report.json and images>
set JDRAW_SMOKE_AGENT=claude-code        (optional: a real agent turn)
electron . --smoke
```
