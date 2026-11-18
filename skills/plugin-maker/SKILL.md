---
name: plugin-maker
description: Make or fix a JV plugin that extends the app window with palette commands, rail pages, project top bar buttons and reactions to app events. Covers the jv API, the approval rule, and how to keep the window fast.
icon: puzzle
command: plugin
label: Make a plugin
hint: What it should add to JV
group: App
title: Plugins
about: How the agent builds plugins that add commands, pages and buttons to JV.
---

# Make a JV plugin

The person wants JV itself to do something new: a button, a page, a
command, a small tool. You build it as a plugin with the
`jeditor_plugin_write` tool. You never edit JV's own source files for this.

## How it works

- A plugin is one ES module, `plugin.js`, saved with `jeditor_plugin_write`
  (`id`, `name`, `description`, `code`). The code is syntax checked; on an
  error nothing is saved and the tool says where the problem is.
- A new plugin is **off**. Only the person can turn it on, in
  Settings > Plugins, after seeing the code. When you change a plugin that
  was on, it turns off until they check it again. Always end by telling
  them where to turn it on, in one plain sentence.
- You cannot turn plugins on, delete them, or run them yourself. Use
  `jeditor_plugin_list` and `jeditor_plugin_read` to see what exists and the
  errors the window recorded, then fix the code and write it again with the
  same `id`.
- No `import` statements and no network libraries. Everything lives in the
  one file. Up to 256 KB.

## The module

```js
export function activate(jv) {
  jv.addCommand({ label: "Count words in project names", icon: "list", run: async () => {
    const projects = await jv.app.projects();
    const words = projects.reduce((n, p) => n + p.name.split(/\s+/).length, 0);
    jv.toast(words + " words across " + projects.length + " project names", "info");
  } });

  // Optional: return a function to undo anything you did outside jv.*.
  return () => {};
}
```

`activate` runs once when the plugin turns on (and at each app start while it
is on). Everything added through `jv` is removed for you when it turns off.

## The jv API

| Call | What it does |
| --- | --- |
| `jv.addCommand({ id, label, icon, run })` | Adds an entry to the command palette (Ctrl K). `run()` may be async. |
| `jv.addPage({ id, label, icon, title, render(el) })` | Adds a button on the left rail that opens a full page. Fill `el` (an empty `div` inside the page scroller). `render` may return a cleanup function, called when the person leaves. Keep `label` to one short word of about 8 letters; longer labels are cut on the narrow rail. |
| `jv.addProjectButton({ id, label, icon, title, onClick(project) })` | Adds a button to the project top bar, left of Render video. `project` is the open project (`id`, `name`, `aspectRatio`, `assets`, `state`). |
| `jv.on(event, fn)` | `"page"` (`{ page }` after every page change), `"project-open"` (the project), `"workspace-changed"` (`{ newRenders, tool }` after an agent or the person changes media). Returns an unsubscribe function. |
| `jv.toast(text, kind, action)` | Short message. `kind`: omit for success, `"info"` for a neutral note, `true` for an error. `action` is optional `{ label, run }` and adds one button to the toast. |
| `jv.ui.openDialog({ title, body, foot, wide })` / `jv.ui.closeDialog()` | Dialog in JV's style. `body` and `foot` are HTML strings. |
| `jv.ui.confirmDialog({ title, body, confirm, danger })` | Resolves `true` or `false`. |
| `jv.ui.promptDialog({ title, label, value, placeholder })` | Resolves the text or `null`. |
| `jv.ui.showMenu(anchorEl, items, { align })` | Menu of `{ label, icon, sub, onSelect, disabled, danger }` and `"sep"`. |
| `jv.ui.icon(name, cls)` | An SVG icon string. Names: home film image music library bot settings plus search play pause stop x check alert info refresh folder file list clock sparkles wand palette mic captions slash puzzle download upload trash pencil copy external eye key book layers user sort help presentation. |
| `jv.ui.esc(text)` | Escape text before putting it in HTML. Always escape names and anything from data. |
| `jv.ui.timeAgo(iso)`, `jv.ui.formatBytes(n)` | Formatting helpers. |
| `jv.app.projects()` | All projects (`id`, `name`, `updatedAt`, `aspectRatio`, `state`). |
| `jv.app.project(id)` | One project, fresh from disk. |
| `jv.app.library()` / `jv.app.finished()` | Library items and finished renders (`id`, `name`, `kind`, `durationMs`, `size`, `createdAt`). |
| `jv.app.route()` | Where the person is: `{ page, projectId }`. |
| `jv.app.navigate(page, params)` / `jv.app.openProject(id)` | Move the window: `"home"`, `"library"`, `"agents"`, `"settings"` (`{ section }`), `"editor"` (`{ projectId }`). |
| `jv.app.theme()` | `"light"` or `"dark"`. |
| `jv.data.get()` / `jv.data.set(obj)` | The plugin's own saved data (JSON, up to 1 MB). |
| `jv.api` | JV's full app bridge, for the rare case the helpers above are not enough. Prefer the helpers. |

## Look like JV

Use JV's classes instead of your own colors, so the plugin follows the theme:
`page-head` (with `h1` and `p`), `card card-pad`, `btn`, `btn btn-primary`
(one per view at most), `btn btn-sm`, `input`, `set-group`, `set-row` with
`.label strong` and `.label small`, `faint`, `empty` (with `h3` and `p`),
`media-grid` and `tile`. Colors only through CSS variables such as
`var(--text)`, `var(--text-2)`, `var(--accent)`, `var(--bg-2)`, `var(--line)`.
No emoji, no colored dots. Short, plain words, no dash punctuation.

## Never freeze the window

A plugin runs inside the JV window. A slow or looping plugin blocks every
project and every agent chat.

- Never write a busy loop or a long synchronous job. Break big work into
  chunks with `await new Promise(r => setTimeout(r, 0))`.
- Event handlers must be cheap. `"workspace-changed"` can fire many times
  while an agent works: compare with what you drew last time and skip the
  redraw when nothing changed. Batch redraws into one `requestAnimationFrame`.
- Do not add MutationObservers on the whole document, and never change JV's
  own elements outside what `jv` gives you.
- Clear every `setInterval` and listener you add yourself in the function
  `activate` returns (or the cleanup that `render` returns).
- An error in your callbacks is caught and recorded. Five errors in a minute
  turn the plugin off. Read them with `jeditor_plugin_read`.

## Steps

1. Ask nothing unless the request has no clear goal. Pick the smallest
   plugin that does what they asked.
2. Check `jeditor_plugin_list` for an existing plugin to update instead of
   adding a near copy.
3. Write it with `jeditor_plugin_write`. Fix any syntax error the tool
   reports and write again.
4. Reply in two or three plain sentences: what it adds, where it shows up,
   and "Turn it on in Settings > Plugins".
5. When the person says it is broken, read it with `jeditor_plugin_read`,
   fix the cause shown in the errors, and write it again.
