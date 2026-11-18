# JDesign

> **Beta. For beta versions only.** JDesign is an early beta. It is not a stable release, features are unfinished, and things can break or change between builds. Back up anything you care about, and use it only if you are happy testing beta software.

JDesign puts two AI studios in one Windows app: **Video** (the JV editor) and **Draw** (an AI drawing studio). Switch between them from the left rail or with Ctrl+D. Each studio is driven by the coding agents you already have, through ACP.

- **Video**: describe the video and an agent cuts, captions, voices and animates it. Details below.
- **Draw**: agents draw on a canvas through their own tools. Exports can be added to the Video library.
- One theme (Light, Dark or System) across both studios. Data lives in `%APPDATA%\JDesign` (set `JDESIGN_USER_DATA` to use another folder).

Requires Node.js and Electron 45 (installed by `npm install`). Agents need their own CLI installed and signed in.

Known beta gaps: no installer yet; the two studios keep separate agent lists and chats; the "Drive JV from your own agent" section below is inherited from JV and its install script still targets JV paths, not JDesign.

---

An AI video editor for Windows that runs on the coding agents you already have. You describe the video, an ACP agent (OpenCode, Claude Code, Codex, Cursor, Gemini CLI and others) does the cutting, captions, voiceovers, and animations through JV's own tools, and you watch the result land on the stage.

Everything stays on this computer: media, projects, chats, and renders.

## Run

```
npm install
npm start
```

Data lives in `%APPDATA%\JEditor\data`. Set `JEDITOR_USER_DATA` to use another folder (handy for testing).

## First steps

1. **Agents** (Ctrl+3): add an agent from the catalog, or a custom ACP command. The agent's own CLI must be installed and signed in.
2. **Home** (Ctrl+1): type what you want to make, attach footage if you have any, pick the frame ratio and agent, and press Create. Footage is optional: agents can build a video from code.
3. **Editor**: media on the left, the stage and your renders in the middle, the chat on the right. Ctrl+B toggles media, Ctrl+J toggles the chat, Ctrl+L focuses it.

Ctrl+K opens the command palette and `?` lists every shortcut.

## Drive JV from your own agent

JV's tools are an MCP server, so the agent you already run in a terminal, an IDE, or T3 Code can set up and edit JV projects without JV's chat. Point it at JV once:

```
npm run mcp:install                     # every agent found on this computer
npm run mcp:install -- --client claude,pi
npm run mcp:install -- --json          # snippet for any other MCP client
npm run mcp:install -- --check         # spawn the server and make a project
```

The entry is a stdio server named `jeditor`: `node %APPDATA%\JEditor\data\jeditor-mcp.cjs`. It points at the data folder, never the install folder, whose path carries the version, so an update or a switch between the installed app and a checkout does not break a config. Configs are written for Claude Code, Pi, Droid, OpenCode, Cursor, Gemini CLI, Qwen Code and Codex CLI; `--dry-run` shows what would change.

With JV closed, that agent can still list workspaces, create and update projects, import media, cut the timeline, render, and write skills. Open JV and the same server adds the window: navigate pages, screenshots, the built-in browser with your cookies, downloads into the library, and the recorder. Voiceovers and instruction changes still ask in the JV window.

An outside agent is not told which project you have open. It finds one with `jeditor_list_projects`, or makes one with `jeditor_create_project`, and passes `projectId` on every call after that.

## Settings

Ctrl+, opens Settings:

- **General**: default agent, auto connect.
- **Appearance**: light, dark, or system theme, accent color, density.
- **Chat**: text size, send key, tool details, thinking.
- **Instructions**: standing instructions and Do / Don't rules sent with every prompt.
- **Skills**: the skills agents read, plus your own.
- **Voice**: ElevenLabs key, voice, model, and whether agents must ask first.
- **Storage**: space used, free up space, leftover files, and a one-time import from Cutline Desktop.
- **About**: versions and the data folder.

## Coming from Cutline Desktop

Settings > Storage > Import from Cutline copies your Cutline library, projects, chats, rules, and agents into JV. It only runs while JV is still empty, and it never changes the Cutline folder.

## Not in this build yet

Record Center, the card studio, and the manual timeline editor from Cutline Desktop are not part of JV yet. Agents can still make cards and edits through the tools.

## Tests

There is no test suite. Four commands cover what a change can break, in this order:

```
npm run check:mcp          # the tool surface and the skills
npm run check:mcp:errors   # every bad tool call gets one sentence back
npm run quality            # both of the above plus a real 2 second render
npm run mcp:install -- --check   # an outside agent can make and edit a project
npm start -- --smoke       # the window, every page, and a real agent turn
```

`npm run quality` prints codec, profile, pixel format, audio format and loudness for a render it makes through the MCP, and exits 1 if anything is off. `npm start -- --smoke` boots the real window hidden, visits every page, and prints a JSON report. With `JEDITOR_SMOKE_AGENT` and `JEDITOR_SMOKE_PROMPT` set, it also sends that prompt to the real agent through the chat and waits for the turn.
