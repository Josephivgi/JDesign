# JV UI fix list

Audit of confusing, misplaced, broken or inconsistent icons, buttons and text. Fixed on 2026-11-10 except where an item says otherwise.

How it was checked (2026-11-10):
- Read every renderer file (`renderer/js/**`, `renderer/styles/app.css`) plus the skill front matter that feeds the / menu.
- 27 hidden smoke runs on scratch data with the real imported Cutline library (191 media items, real projects with 14 renders and long agent chats). Each run opened one state: the real project editor, chat history, every menu, the / menu, the media picker, the design dialog, the palette, the shortcuts, the model menu, the skill editor, voice history, storage after measuring, and the Agents marketplace.
- A full pass in dark theme.
- An automated DOM sweep of every page for unlabeled buttons, cut-off text, small click targets, font sizes and primary-button counts.

Priority: **P1** = confusing, wrong, or risky for a normal user. **P2** = misplaced or inconsistent. **P3** = polish.

---

## 1. Risky or wrong behavior

- [x] **P1** **Free up space runs without asking.** It re-encodes your videos and images ("shrinks without visible loss") and deletes duplicates the moment you click. There's no confirm dialog and no list of what it will touch. Every other destructive action asks first. (`settings.js` storage `data-optimize`)
- [x] **P1** **Delete dialogs put focus on the red Delete button.** `confirmDialog` focuses the confirm button even when `danger: true`, so pressing Enter or Space deletes a project, chat, video or library file. Focus Cancel on danger dialogs. (`ui.js:426`)
- [x] **P1** **Old agent replies get the current agent's name.** After a handoff (Cursor to OpenCode), every earlier reply in the chat is labeled "OpenCode", including ones Cursor wrote. `itemHtml` uses `st.harnessId` instead of the row's own `harnessId`. (`chat.js:527`)
- [x] **P1** **Tooltips on disabled buttons never show.** `.btn:disabled` and `.icon-btn:disabled` have `pointer-events: none`, so explanations like Create's "Set up an agent first" and Export's "Nothing to export yet. Ask the agent to make the video first." can never be seen. (`app.css:181`, `app.css:197`)
- [x] **P1** **Export doesn't say which video it saves.** In a project with 14 finished videos, Export silently picks one (the one tied to the selected clip, or the newest). Nothing on screen says which. Name it in the button tooltip, or ask when there's more than one.
- [x] **P1** **Vertical videos are cropped everywhere they show as thumbnails.** Finished-video cards (`.output .tile-thumb` 16:9), library tiles (16:10) and project cards all use `object-fit: cover`, so a 9:16 render shows as a cropped landscape strip. Thumbnail ratios are also different in each place.
- [x] **P2** The media picker's filter says **"Audios"**. It's built with `kind + "s"`; Library says "Audio". (`media.js:259`)
- [x] **P2** Chat list says "just now" for a chat whose last message was Oct 14. Opening a chat seems to bump its time.
- [x] **P2** You can't select error text to copy it. `body { user-select: none }`, and only `.md`, inputs and `.selectable` are excepted, so the raw error under a failed turn (`.err`, `.notice`), agent install commands, and Library preview details can't be copied for troubleshooting. (`app.css:134`)
- [x] **P2** "Show log" (Settings > About) doesn't show a log. It opens an Explorer window at a file. Rename it to "Open log file", or show the log in a dialog.
- [x] **P3** `index.html` starts with `data-theme="dark"`, so light-theme users get a dark flash at launch until prefs load.

## 2. Whole app: navigation, rail, palette, shortcuts

- [x] **P2** The rail logo is a blue "JV" tile while the default accent is violet. It looks off-brand in both themes.
- [x] **P2** Rail "Search" uses the Mac ⌘ icon on Windows and opens a command palette. Use a search icon and show "Ctrl K" in the tooltip.
- [x] **P2** When a project is open, the rail highlights **Home**. Highlight nothing, or show "Projects".
- [x] **P2** Palette wording doesn't match the rail ("Open library", "Manage agents" vs "Library", "Agents").
- [x] **P2** The palette lists every project with the same grey "Project" tag, including duplicate "Untitled project" entries you can't tell apart. Show the date or status instead.
- [x] **P2** Ctrl N says "New project" (shortcuts and palette) but only jumps to Home and focuses the box. Nothing is created.
- [x] **P2** The shortcuts dialog mixes global keys with editor-only ones (Space, F, arrows, Ctrl B/J/L, Esc) and doesn't say which only work in a project.
- [x] **P2** Esc does three jobs: close a menu, close a dialog, and stop the agent mid-turn. One extra Esc after closing a menu can stop a long render.
- [x] **P3** There's no Help or "?" button anywhere. The shortcuts list is only reachable through the palette or `?`.
- [x] **P3** Toasts always show a green check unless they're errors, so neutral notes ("Your next message hands this chat to Claude Code", "An agent updated your instructions") look like successes. Add a neutral info style. (`ui.js:158`)
- [x] **P3** Time formats differ: "5m ago" (most pages), "5 min ago" / "3 h ago" (Agents page `ago()`), "Oct 13" (cards). *Done: Agents uses the shared timeAgo. Cards still show a date for older items on purpose.*
- [x] **P3** Text is very small overall. The sweep found 191 text elements at 11px and 67 at 10.5px on Library alone, and 10.5px meta text in the editor. Compact density changes only a few tokens, because most components use fixed px padding. *Done: no text under 12px on any page (measured). Compact now tightens page, card, tile, menu, chat and settings padding too.*

## 3. Home

- [x] **P1** Projects sit below the 8-tile design gallery, so returning users scroll past "Start from a design" to reach their own work. Put Projects first once any exist, or collapse the gallery.
- [x] **P1** The model picker shows raw ids that change between visits for the same agent: `openai/chatgpt-image-latest` (an image model) on one launch, `opencode-go/Hy4` and `opencode-go/DeepSeek V4.1` on others.
- [x] **P1** The model menu is one flat list of about 150 entries with provider prefixes (`claude-agent/Opus 4.6`, `openai/GPT-4o (2024-08-06)`, `openai/GPT-Audio-1.5`). It isn't grouped by provider, has no "recommended" pick, and doesn't hide audio or image models that can't edit video.
- [x] **P1** Project names come from the first 7 words of the prompt, so they end mid-sentence ("can you go in cutline i", "make a animation explaining how the"). The chat title has the same problem ("can you go in cutline i got a 1.5GB 30 minute..."). Ask the agent for a short title, or name it after the workflow. *Done for new projects and chats. Existing names are left as they are.*
- [x] **P1** Every Blank project is called "Untitled project", and empty projects pile up (two from September in the real data). They look identical, and nothing offers to clean up empty ones.
- [x] **P1** Idea chip icons touch their text. `.chip` has no `display: inline-flex` or `gap`. (`app.css:385`)
- [x] **P2** On the idea chips, film vs sparkles secretly means "needs a video" vs "from scratch".
- [x] **P2** Chip labels don't match the workflow names used elsewhere: "Captions for a video" vs "Add captions", "Vertical short from a video" vs "Make a vertical short", "Explainer video" vs "Make an explainer".
- [x] **P2** "Animated logo intro" inserts the literal text "with my channel name", and "Explainer video" leaves "15 seconds about " hanging with no cursor hint.
- [x] **P2** "Media is optional" sits next to Create, far from the paperclip it describes.
- [x] **P2** The placeholder crams in "Type / for workflows". The wand button means the same thing, and the chat repeats the hint twice.
- [x] **P2** The wand icon is used for Workflows, Settings > Skills, the /improve workflow, and the default for agent workflows. Four meanings for one icon.
- [x] **P2** The project ⋯ button sits on the thumbnail as a grey square, covering part of the picture (on "RobloxCTW" it covers the game's "United Kingdom" label).
- [x] **P2** An empty project's thumbnail is a black box with a dashed frame and a tiny film icon, which reads as a broken image.
- [x] **P2** A project card says "Video ready" twice: the badge and the meta line.
- [x] **P3** The ⋯ tooltip says "Rename or delete", but the menu also has Open.
- [x] **P3** The sort picker shows only "Recent" with no label.
- [x] **P3** "Blank project" sits on the Projects header row, away from Create.

## 4. Design gallery and design dialog

- [x] **P2** "Short line under it **optional**" also has the placeholder "Short line under it (optional)", so the label is said twice.
- [x] **P2** Field rules are only in placeholders ("Headline, 1 to 4 words"), so they vanish as soon as you type.
- [x] **P2** "Leave a field blank to use the sample text" sits under Frame at the very bottom, and the placeholders don't show what the sample text is ("Make it move").
- [x] **P2** Frame is the last field, although it changes the preview most.
- [x] **P2** Music is a native `<select>` that looks different from every other picker in the app.
- [x] **P2** Length choices jump 2.5 s, 3.5 s, 8 s, 15 s with no custom option.
- [x] **P2** "Ask the agent to change it" is a ghost button tucked bottom left, and it closes the dialog and fills the Home box, which isn't obvious.
- [x] **P3** "Make it" is vague. Use "Make video".
- [x] **P3** The Play button sits on top of the preview's lower-left corner, and the left column is mostly empty below the description.
- [x] **P3** Color pickers always start at navy, orange and white, whatever the tile showed. *No change needed: the tiles render with these same three colors (`THUMB_COLORS` in presets-ipc.cjs).*

## 5. Project editor: top bar and tips

- [x] **P1** The tips banner names /improve and /short (greyed out in an empty project) and "Edit design" / "Previous version" (not on screen). It describes buttons you can't see.
- [x] **P1** The ratio picker changes the project frame without re-rendering. In the real 9:16 project, the 16:9 original sits letterboxed in a tall black box, and it isn't clear whether the clip will be cropped or padded.
- [x] **P1** The two panel toggles look almost the same, sit together on the right, and are both highlighted. The media toggle is far from the media panel.
- [x] **P2** Project actions (Render video, Previous version, Edit design, Export) share one row with view toggles and the ratio, with no grouping.
- [x] **P2** "Previous version" / "Newer version" is a clip undo, but it sits beside Export.
- [x] **P2** The project name looks like plain text. The input has a transparent border until hover, so few people will find out they can rename by clicking it.
- [x] **P2** The "Projects /" breadcrumb text isn't clickable. Only the separate chevron goes back.
- [x] **P3** The Edit design text isn't wrapped in a `<span>` like the other buttons. (`editor.js:95`)
- [x] **P3** Disabled Export stays pale violet in light theme, and nearly full color in dark theme.

## 6. Project editor: media panel, stage, player, finished videos

- [x] **P1** An empty project shows four add-media controls at once: the + in the header, "Add media" in the panel, the dashed drop box, and step 1 on the stage. *Done: the drop box only shows while dragging, and the empty panel points at +. Step 1 on the stage stays.*
- [x] **P1** "Finished videos" in the real project shows 14 cards with near-identical names ("Screen take 5 synced...", cut off with no tooltip) and identical thumbnails. The only difference is "Oct 13" vs "Oct 13 · older". Nothing marks the one that is current or final.
- [x] **P1** The stage label badge ("Finished · Screen take 5 synced VO") wraps to two lines over the top of the video and stays there while it plays.
- [x] **P2** Opening a project that has a finished video shows **Original** first, not the finished video.
- [x] **P2** The asset ⋯ and Library tile ⋯ buttons are invisible until hover (`opacity: 0`, no `:focus-within`), so keyboard and touch users never find them. Chat "Copy" / "What was sent" and code-block Copy work the same way.
- [x] **P2** The dashed "Drop files here to add them" box always shows at the bottom of the panel, even when you're not dragging.
- [x] **P2** In the 3-step guide, step 3 "Export" has no button. The "Finished videos" strip shows empty text under the stage before anything exists.
- [x] **P2** At the default 1280px window, the player hides the ±5 s buttons and the volume slider with no hint (container query). The shortcuts list still advertises Left / Right.
- [x] **P2** The scrub knob is hidden until hover, and the track is 4px with no time marks, so the playhead is hard to see when paused.
- [x] **P2** The asset menu says "Mention in chat" while everywhere else says "Attach".
- [x] **P2** The output menu says "Use as source footage" (jargon) and "Open in player" (opens an outside app, no hint).
- [x] **P3** The mute tooltip says "Sound".
- [x] **P3** The chat open/closed state isn't remembered, but the media panel's is.
- [x] **P3** The Original / Finished video tabs only appear after the first render, so the stage jumps.

## 7. Chat panel

- [x] **P1** **The / menu shows agent instructions, not help.** Descriptions come from skill front matter written for agents ("Design edit cards in HTML and CSS with cutline_set_card_html", "Edit a JV video from pinned or tagged library files") and are cut mid-word ("written in HTML, C", "adds a n", "inside the s"). Show the `hint` text in plain words instead.
- [x] **P1** **/review is labeled "Review the design"**, and it's offered as a "Next" chip after a plain video edit. Use "Review this video".
- [x] **P1** Thinking rows dominate the thread. With "Show agent thinking" on by default, the real chat alternates "Thought" rows with every step ("Thought for 2s ... Proceeding to mix with ffmpeg using the workspace library path"). Default it off, or fold the thinking into the steps.
- [x] **P1** Tool step names are machine names: "Tts Tts Tts Tts", "Execute", "Get project", "App preview". `prettyTool` lowercases acronyms and keeps internal names. (`chat.js:1127`)
- [x] **P1** The empty chat stacks two kinds of starters in different styles (workflow chips, then full sentence boxes).
- [x] **P2** When only "/" is typed, the Send button turns active. Enter with the menu closed would send a bare "/".
- [x] **P2** On Home, the / menu repeats "Attach a clip first, or open a project that has one" on 7 of 11 rows. Say it once at the top.
- [x] **P2** The / menu opens over the whole thread (it fills the panel height).
- [x] **P2** Workflow icons clash: /explainer uses the film icon (which elsewhere means "needs a video"), /captions uses the chat bubble (also the Chat settings icon), and /short uses a plain rectangle (the ratio icon). Agent-native commands use the ⌘ icon.
- [x] **P2** "Design a card" (/card) is offered as a starter and in the / menu, but the card studio isn't built.
- [x] **P2** /voiceover and /music aren't greyed out when there's no ElevenLabs key, unlike the clip-only workflows.
- [x] **P2** "Restart agent" appears in the ⋯ menu and as an error button, and the two behave differently (the error one also resends your message).
- [x] **P2** The chat head has three ways to start a new chat: the title dropdown, the + button, and "New chat" inside the dropdown.
- [x] **P2** Click targets are tiny: "Copy" is 27×16px, "What was sent" is 16px tall, and thinking toggles are 17px tall (from the sweep).
- [x] **P2** The model label in the composer changes between visits for the same chat ("opencode-go/DeepSeek V4.1 ..." then "opencode-go/Hy4"), and it's a raw id with no "Model" label. *Done: the provider prefix is gone, and only your own pick is saved to the chat, so the label says Default model until you choose one. Chats that already saved a model keep showing it.*
- [x] **P3** The settled permission row shows the raw tool name.
- [x] **P3** The placeholder and the hint below both say "/ for workflows".

## 8. Library

- [x] **P1** You can't add a library item to a project from Library. The menu has Preview, Rename, Hide from agents and Delete only.
- [x] **P1** Agent scratch files flood the library: in the real data, `synced-vo-temp`, 30+ "VO beat ..." clips, and a file named `1ba28e02-6c82-47be-849a-e05740c6888a`. There's no way to filter by project or by "made by an agent", and duplicate names ("How the British Empire fell" twice, "VO France rewrite" twice) can't be told apart. *Done: "Made by" filter, friendly names for id file names. Duplicates are told apart by size and age on the tile.*
- [x] **P2** Audio tiles are huge lavender blocks with the music icon twice (center and corner badge) for 2-second clips. You can't play audio from the tile, so every listen opens a dialog.
- [x] **P2** Items with no length show the literal word "video" or "audio" as their meta text (`mediaMeta` fallback), in Library and the picker.
- [x] **P2** The sort picker uses a "list" icon (reads as list view).
- [x] **P2** The media picker doesn't show items already in the project at all. They're filtered out without a word, so people think media is missing.
- [x] **P2** Media picker tile names overflow the tile with no ellipsis ("Screen take protocol-check" runs past the edge).
- [x] **P3** "Hide from agents" uses the bot icon.
- [x] **P3** Preview shows "video (video/webm)", a raw MIME type.

## 9. Agents

- [x] **P1** "Your agents" lists Devin and Cursor as "Not installed" with no button there to install or remove them. They also appear in the marketplace below.
- [x] **P1** Claude Code is installed on this PC but isn't in "Your agents". The only sign is a violet "Add" on the "Claude Agent" card, about halfway down a 45-card grid.
- [x] **P2** The marketplace lists 45 general coding agents (including a USDC payment marketplace) with no hint about which ones work well for video editing in JV.
- [x] **P2** Author lines show raw emails and get cut off ("Augment Code <support@augmentcode.com>", "Stakpak Team <contact@stakpak.dev>").
- [x] **P2** "Loading the agent directory..." shows on each visit before the cached list appears.
- [x] **P2** "Check again" is vague. Use "Refresh".
- [x] **P2** Several primary "Add" buttons show at once.
- [x] **P2** "Make default" lives here and in Settings > General. Settings can't go back to "First installed agent".
- [x] **P3** Install hints are developer commands with no copy button.
- [x] **P3** "Installed" is grey, so healthy rows look disabled.

## 10. Settings

- [x] **P1** Every section subtitle touches the card below it. `.settings-pane > p.lead` never matches, because panes render inside `div[data-pane]`. (`app.css:695`)
- [x] **P1** **Skills are written for agents, not people.** Names are folder slugs ("ai-edit", "card-design"). Descriptions say "Call cutline_apply_edit. Do not invent a parallel store." Customize opens raw SKILL.md with front matter and tool names ("Edit the front matter to change the name or description"). "New skill" asks for a "Folder name".
- [x] **P1** In the skill editor, a just-customized built-in skill shows a red **Remove** button. It actually means "reset to the built-in version".
- [x] **P2** The layout shifts about 5px sideways between short and long sections because the scrollbar comes and goes. Use `scrollbar-gutter: stable`.
- [x] **P2** General repeats the rail with an "Agents page / Open Agents" card.
- [x] **P2** Chat > "Agent permissions" is a card with no control, pointing to another section with no link.
- [x] **P2** "Text size" is the only Chat row without a description, and it only affects the chat.
- [x] **P2** Instructions and rules has two Save buttons ("Save", "Save rules"), while every other setting saves instantly. Nothing warns you if you leave with unsaved changes.
- [x] **P2** On Do / Don't rule toggles, the selected side is hard to see.
- [x] **P2** Skills: the user skill has a boxed "Edit" button while built-in skills have a plain "Customize". The "card-design" and "ai-edit" skills are about cards, which aren't in this build.
- [x] **P2** Voice: "Choose voice" shows as if nothing is picked, while Recent agent use shows every voiceover used "Brian - Deep, Resonant and Comforting".
- [x] **P2** Voice > Recent agent use shows raw data: SSML tags (`<break time="10.2s" />`), JSON blobs for "Listed voices" and "Checked setup", lowercase agent ids ("cursor"), and "Voiceover Failed" with no reason.
- [x] **P2** Voice has a "Model" picker (text to speech) while "Model" elsewhere means the agent's AI model.
- [x] **P2** Storage: "Free up space" is both the row title and the button label. The first row says only "Measuring..." with a disabled primary button until the scan ends.
- [x] **P2** Storage leftovers use internal wording ("no library row points at", "the Recorder agent, which is no longer in the app"). "Agent work folders: Some files are already in your library" offers Delete without saying which files.
- [x] **P2** Storage: "Show" is plain text while "Delete" is a bordered red button on the same row.
- [x] **P2** "Bring over Cutline Desktop" stays forever with a disabled Import once JV has data.
- [x] **P2** The data folder shows in Storage and in About.
- [x] **P2** About holds "Agent errors", which belongs on the Agents page.
- [x] **P3** The storage bar and legend use raw hex colors (`#22c55e`, `#3b82f6`...), against the token rule in AGENTS.md. (`settings.js:537`)
- [x] **P3** About's subtitle "runs on ACP agents" is jargon.
- [x] **P3** Accent swatch tooltips show raw ids ("iris").

## 11. Dark theme

- [x] **P2** The empty-stage guide card is almost the same black as the dark background, so its edge disappears.
- [x] **P2** The blue rail logo and the violet accent clash more on dark.
- [x] **P3** Disabled Export looks nearly enabled on dark.

## 12. Leftovers from Cutline

- [x] **P3** `renderer/countdown.html` is still titled "Cutline recorder" with the label "Cutline recorder", for a Record Center that isn't in this build.
- [x] **P3** Agent-facing skill text and tool names still say "Cutline" ("Edit a Cutline card", `cutline_*`), and they surface in Settings and the / menu. *Done for built-in skills (new `title` and `about`). Your own skill "ai-edit-copy" keeps the text you wrote. `cutline_*` tool names stay in skill bodies, which only agents read.*

---

## Not checked

- Narrow windows (under 1100px) weren't captured. The hidden window can't be resized from a page script.
- Light vs dark contrast ratios weren't measured, only judged from screenshots.
- No live agent turn was run after the fixes, so the agent name tags after a handoff, new chat titles, and the permission row wording come from code and existing chat data only.
- The ElevenLabs gate on /voiceover and /music wasn't seen greyed, because the scratch data has a key.
- No click test in a VM. Everything was checked by hidden smoke runs reading the DOM and screenshots, in light and dark.
