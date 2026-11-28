"use strict";

// File-backed agent tools. They run in the stdio MCP process when JV is
// closed and inside the Electron main process when the app is open, so every
// write goes through the same stores the app uses.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const {
  loadState,
  loadWorkspace,
  saveWorkspace,
  snapshot,
  workspaceDir,
  workspacePath,
  statePath,
  writeJsonAtomic,
  emptyWorkspace,
} = require("./workspace-store");
const { applyCardEdit } = require("./card-apply");
const {
  copyPathIntoLibrary,
  getLibraryItem,
  deleteLibraryItem,
  libraryFilePath,
} = require("./library-io");
const { getFinishedItem, finishedFilePath, updateFinishedItem, deleteFinishedItem } = require("./finished-io");
const projects = require("./ai-projects");
const { deleteProjectCascade } = require("./project-delete");

// A render whose page script threw comes back as a failed call (the clip or
// stills are still saved and listed), because agents act on a failed call
// and skim past a note. The failure is one sentence an agent can act on; the
// saved paths ride along for the next call.
function scriptErrorResult(result) {
  const errors = (result && Array.isArray(result.scriptErrors) ? result.scriptErrors : []).map(String).filter(Boolean);
  const first = errors[0] || "the page's script threw";
  const more = errors.length > 1 ? " (" + (errors.length - 1) + " more in scriptErrors)" : "";
  const error = ("The page's script threw: " + first + more + ". Fix that line in js, then render again.").slice(0, 300);
  // saved: the call still wrote files, so the window refreshes for it.
  return { content: [{ type: "text", text: JSON.stringify(Object.assign({ error }, result, { scriptErrors: errors.slice(0, 3) })) }], isError: true, saved: true };
}

// A failed render reaches an agent as one line it can act on: the first useful
// stderr line, no temp path, no exit code, then what to do next. A message the
// renderer already wrote for an agent is passed through untouched, and a few
// bare "not found" strings from the render layer get the sentence they need.
function renderFailure(error, action) {
  const raw = String((error && error.message) || error || "").trim();
  const known = {
    "Project not found.": "That project id is not in this workspace. Call jeditor_list_projects for the ids.",
    "The project has no video on its timeline.": "This project has no clip on its timeline yet. Add one with jeditor_project_add_assets, then try again.",
    "The source clip file is missing.": "The clip's file is gone from the library. Re-import it with jeditor_add_files, then try again.",
    "ffmpeg is not installed.": "ffmpeg is not installed on this computer, so nothing can render. Install ffmpeg, or ask the person to.",
    "ffmpeg did not write a clip.": "ffmpeg wrote no video, so nothing was saved. Check the code renders stills with jeditor_animation_frames, then try again.",
  };
  if (known[raw]) return new Error(known[raw]);
  const first = raw.split(/\r?\n/).map((part) => part.trim()).filter(Boolean)[0] || "";
  const looksRaw =
    /\(\s*(?:code|exit)?\s*-?\d+\s*\)\s*$/i.test(first) ||
    /ffmpeg|conversion failed|invalid data|no such file|error opening|could not open|moov atom/i.test(first) ||
    /[\\/](?:Temp|tmp)[\\/]/i.test(first);
  if (!looksRaw && /[.!?]$/.test(first)) return error;
  const line = first
    .replace(/(?:[A-Za-z]:)?[\\/][^\s"']*(?:[\\/](?:Temp|tmp)[\\/])[^\s"']*/gi, "the temporary file")
    .replace(/\s*\((?:code|exit)?\s*-?\d+\)\s*$/i, "")
    .trim();
  const sentence = line ? line.charAt(0).toUpperCase() + line.slice(1) + (/[.!?]$/.test(line) ? "" : ".") : "The render failed.";
  const text = (sentence + " " + (action || "Check the source file plays in a player, then try again.")).replace(/\s+/g, " ").trim();
  return new Error(text.length > 300 ? text.slice(0, 296).trimEnd() + "..." : text);
}

// Names an agent probably meant, so a typo costs one call instead of a guess.
function closestNames(wanted, names, limit) {
  const target = String(wanted || "").toLowerCase();
  const score = (name) => {
    const lower = name.toLowerCase();
    if (lower === target) return 0;
    if (lower.startsWith(target) || target.startsWith(lower)) return 1;
    if (lower.includes(target) || target.includes(lower)) return 2;
    let same = 0;
    for (const ch of new Set(target)) if (lower.includes(ch)) same += 1;
    return 10 - same;
  };
  return names
    .slice()
    .sort((a, b) => score(a) - score(b))
    .filter((name) => score(name) < 10)
    .slice(0, limit || 4);
}

// Every tool that needs an id says which one is missing and where the ids come
// from, so a first call without it costs one reply, not a guess.
function requireField(key, message) {
  return (input) => {
    const value = input && input[key];
    if (value != null && String(value).trim()) return;
    throw new Error(message);
  };
}

// A per-file import failure inside a list result: the OS reason in plain words.
function fileFailure(error) {
  const raw = String((error && error.message) || error || "");
  if (/ENOENT|no such file|not exist/i.test(raw)) return "No file at that path. Pass an absolute path to a file that exists.";
  if (/EACCES|EPERM|permission|being used/i.test(raw)) return "That file cannot be read, probably because another app has it open. Close it, then try again.";
  if (/EISDIR|ENOTDIR/i.test(raw)) return "That path is a folder, not a file. Pass the file's full path.";
  if (/ENOSPC|no space/i.test(raw)) return "There is no room on this disk for that file. Free some space, then try again.";
  const first = raw.split(/\r?\n/).map((part) => part.trim()).filter(Boolean)[0] || "The import failed.";
  const sentence = first.slice(0, 180) + (/[.!?]$/.test(first) ? "" : ".");
  return sentence + " Check the file, then try again.";
}

function errorNoteFor(errors) {
  const list = Array.isArray(errors) ? errors.filter(Boolean) : [];
  return list.length ? "The page's script threw while rendering, so some motion may be missing: " + list.slice(0, 5).join(" | ") + ". Fix the js and render again. " : "";
}
const { listActions, recordAction } = require("./agent-activity");

const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;

function obj(properties, required) {
  const schema = { type: "object", properties: properties || {} };
  if (required && required.length) schema.required = required;
  return schema;
}

const WS = { type: "string", description: "Workspace id. Defaults to the active workspace." };
const CONFIRM = { type: "boolean", description: "Must be true. Deletes are permanent." };

// A first look at a log stays small: both log tools used to return 40 to 100
// rows by default and filled a context window before the agent read anything.
const ACTIVITY_DEFAULT_LIMIT = 20;
const CHAT_DEFAULT_LIMIT = 20;

// The audio fields repeat across the render, animation, and audio tools, so
// one definition keeps the wording, type, and limits the same everywhere.
const AUDIO_ID = { type: "string", description: "Library audio item id (jeditor_tts, jeditor_music, or an import)." };
const AUDIO_VOLUME = { type: "number", description: "Gain for the track, 0 to 4. Default 1.", minimum: 0, maximum: 4, default: 1 };
const AUDIO_LOOP = { type: "boolean", description: "Repeat the track to cover the whole clip, for a bed shorter than the video." };
const AUDIO_DUCK = {
  type: "number",
  description: "How far the clip's own audio drops under the track, 0 to 1. 0 mutes the source. The deepest duck wins.",
  minimum: 0,
  maximum: 1,
};
const AUDIO_IDS = {
  type: "array",
  items: { type: "string" },
  description: "Several library audio ids mixed at the same gain. Use audios to give each track its own gain.",
};

// One concept, one name and one wording: a card, a project, a clip, a library
// item, a render. An agent that learned projectId on one tool reads it the same
// way on the next.
const CARD_ID = { type: "string", description: "Edit card id." };
const PROJECT_ID = { type: "string", description: "Project id, from jeditor_list_projects." };
const FINISHED_ID = { type: "string", description: "Finished video id, from jeditor_snapshot." };
const VIDEO_ID = { type: "string", description: "Clip to work on. Defaults to the clip on the timeline." };
const ASPECT_RATIO = {
  type: "string",
  enum: ["16/9", "9/16", "1/1", "4/5"],
  description: "Output frame: 16/9, 9/16, 1/1, or 4/5. Default 16/9.",
};

// Shared with the native editorpi surface (vendor/editorpi/src/kernel/cutline-tools.ts keeps a copy).
const EDIT_TIMELINE_DOC =
  "Edit a project's clip: real cuts plus the look the render burns in. Use it for trims, speed, reframing, zooms, burned-in text, flashes and fades. Check with jeditor_preview_frames, then render with jeditor_render_project.";

// The op list is read while an agent fills ops, so it lives on the property
// instead of in the tool description.
const EDIT_TIMELINE_OPS_DOC =
  "Ops apply in order, all or nothing. Times are source seconds (startMs/endMs too). " +
  "CUTS: {type:'cut',start,end} drops a range (lag, dead pause, bad take); {type:'keep',start,end} keeps only it; {type:'split',at}; {type:'speed',start,end,rate} (2 is 2x); {type:'audio',start,end,muted,volume} (no start/end means the whole clip); {type:'reset'}. " +
  "Every op takes frames instead: fromFrame/toFrame or startFrame/endFrame on a range, frame or atFrame on a point, inFrame/outFrame on a fade. Frames are exact and snap to the grid unless you pass frame:{snap:false}. " +
  "LOOK: {type:'ratio',aspectRatio:'9/16'|'16/9'|'1/1'|'4/5'} sets the output frame and fills the source; {type:'frame',fit:'fit'|'fill',x,y,background:'blur'|'black'} shows the whole picture or crops around focus x,y (0..1, 0,0 top left), so put x,y on the subject. " +
  "{type:'zoom',start,end,amount,x,y,style}: punch (default) cuts to amount (1.1 to 4) at x,y, push eases in, pan travels from fromX,fromY; {type:'unzoom',start,end} clears moves; " +
  "{type:'text',text,start,end,style:'hook'|'caption'|'bubbly'|'title',x,y,position:'top'|'upper'|'center'|'lower'|'bottom',anim:'slide'|'fade'|'none',id} writes burned-in text in the safe area (outputStart/outputEnd for finished seconds); {type:'remove_text',id|all:true|start,end}; " +
  "{type:'flash',at}; {type:'fade',in,out} (seconds). " +
  "SOUND: {type:'sound',audioId,volume,loop,duck,track} lays a library track over the cut; track is 'voice' (default) or 'music', so both can play. audioId:'' clears every track, track:'music' with audioId:'' clears only the bed. volume defaults 1, duck 0-1 lowers the source under it (deepest wins, 0 mutes). " +
  "Check with jeditor_preview_frames, then render with jeditor_render_project.";

const PREVIEW_FRAMES_DOC =
  "See a project before rendering: up to 8 stills framed exactly as the render will be, plus the raw source frame with grid lines for reading focus points. Use it to check framing, zoom and text placement before a render, and again after a framing change.";

// A whole video made of code. Edit cards float on footage; this needs none, so
// a project with nothing pinned can still be given a real clip.
const ANIMATION_DOC =
  "Make a video out of code, with no footage and nothing pinned: titles, stats, explainers, end cards. Read design-slop, motion-graphics, card-design, type-layout, or color-on-video for the look, and jeditor_animation_frames to see the motion. Pass projectId to make it the project's clip.";

// The code fields both animation tools take: the same document either gets
// rendered to a video or rasterized to stills. The html/css/js contract lives
// here because an agent reads it while filling the call, not before it, and it
// is paid for twice in the tool list, so it stays tight.
function animationCodeProps() {
  const presetNames = require("./animation-presets").PRESET_NAMES;
  const transitions = ["fade", "dissolve", "slide", "slideleft", "slideup", "wipe", "wipeleft", "zoom", "circle", "cut"];
  return {
    html: {
      type: "string",
      description: "Body markup. data-split='chars'|'words' staggers letters with --i; {{image:<libraryId>}} embeds a library image. Replaces a preset's markup.",
    },
    css: {
      type: "string",
      description: "Styling and the @keyframes that animate, seeked frame by frame. Animate in css, not from js. With a preset, these rules come after its css.",
    },
    js: {
      type: "string",
      description:
        "Optional script on a virtual clock: performance.now, Date.now, rAF, setTimeout, setInterval follow frame time and Math.random is seeded, so draws repeat. drawAt(t) gets the frame time in ms. window.JV has tween, spring, ease, count, keyframes, random. With a preset it runs in its own scope after the preset's, so query the DOM instead of reading its variables.",
    },
    cardId: { type: "string", description: "Use this saved card's html, css, colors, vars, and length instead of inline code." },
    preset: {
      type: "string",
      enum: presetNames,
      description: "Start from a ready-made design (jeditor_animation_presets). Your css and js add on top; html replaces its markup.",
    },
    presetParams: { type: "object", description: "The preset's text and numbers, e.g. {title, subtitle} or {items: [{label, value}]}." },
    colors: { type: "object", description: "{primary, secondary, text} become --primary, --secondary, --text on the page." },
    vars: { type: "object", description: "Extra CSS variables: {accent: '#FFB454'} becomes var(--accent)." },
    aspectRatio: {
      type: "string",
      enum: ["16/9", "9/16", "1/1", "4/5", "landscape", "vertical", "square"],
      description: "Output frame. landscape, vertical, square are the words for 16/9, 9/16, 1/1. Default 16/9.",
    },
    durationMs: {
      type: "number",
      description: "Length in ms. A render holds at most 900 frames (30 s at 30 fps). With scenes, each scene has its own.",
      minimum: 200,
      maximum: 60000,
      default: 4000,
    },
    fps: { type: "number", description: "Frames per second. Higher is smoother and slower.", minimum: 10, maximum: 30, default: 30 },
    scenes: {
      type: "array",
      description:
        "Several beats instead of one: 2 to 8 scenes, each with a preset or html, its own durationMs and an optional transition. Top level colors, vars, aspectRatio and fps apply to all. Scenes overlap by their transition, 60 s total at most. The result lists each scene's start time, for timing a voiceover.",
      items: {
        type: "object",
        properties: {
          preset: { type: "string", enum: presetNames, description: "Preset for this scene." },
          presetParams: { type: "object", description: "The preset's text and numbers for this scene." },
          html: { type: "string", description: "Your own markup for a beat no preset covers, with css and js." },
          css: { type: "string", description: "This scene's styling and keyframes, on top of the preset's." },
          js: { type: "string", description: "This scene's script." },
          durationMs: { type: "number", description: "This scene's length, at least the preset's minMs. Usually 3000 to 5000.", minimum: 600, maximum: 30000 },
          transition: { type: "string", enum: transitions, description: "How this scene hands over to the next." },
          transitionMs: { type: "number", description: "That transition's length in ms.", minimum: 100, maximum: 1200 },
          colors: { type: "object", description: "Change the palette for this one scene." },
        },
      },
    },
    transition: {
      type: "string",
      enum: transitions,
      description: "With scenes: the hand-over between scenes unless one names its own. Default fade.",
    },
    transitionMs: { type: "number", description: "With scenes: transition length. Default 450.", minimum: 100, maximum: 1200, default: 450 },
    workspaceId: WS,
  };
}

function needConfirm(input, what) {
  if (input && input.confirm === true) return;
  throw new Error("Pass confirm: true to delete " + what + ". This cannot be undone.");
}

function plainMap(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

// Project state merge, RFC 7386 style: map keys merge recursively, anything
// else replaces, and null deletes a key. A videoEdits or renders patch that
// names one clip then keeps every other clip's entries instead of wiping
// them; clearing a clip's edits is videoEdits: { clipId: null }.
function mergeStatePatch(base, patch) {
  if (!plainMap(patch)) return patch;
  const out = plainMap(base) ? Object.assign({}, base) : {};
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    if (value === null) {
      delete out[key];
    } else {
      out[key] = mergeStatePatch(out[key], value);
    }
  }
  return out;
}

async function activeId(dataRoot, workspaceId) {
  if (workspaceId) return workspaceId;
  return (await loadState(dataRoot)).activeWorkspaceId;
}

function safeName(value, fallback) {
  const cleaned = String(value || "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}

async function deleteLibraryItemFromDisk(dataRoot, id, workspaceId) {
  const wsId = await activeId(dataRoot, workspaceId);
  return deleteLibraryItem(dataRoot, id, wsId);
}

async function downloadToTemp(url, name) {
  const parsed = new URL(String(url || ""));
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("That link is not http or https, so nothing was downloaded. Pass a plain web link to jeditor_add_from_url.");
  }
  const res = await fetch(parsed, { redirect: "follow" });
  if (!res.ok) {
    throw new Error("The download returned HTTP " + res.status + ", so nothing was imported. Check the link opens in a browser, then try again.");
  }
  const length = Number(res.headers.get("content-length") || 0);
  const tooBig = "That file is larger than the 2 GB import limit. Download it yourself and import a shorter clip, or use a smaller file.";
  if (length > MAX_DOWNLOAD_BYTES) throw new Error(tooBig);
  const mime = String(res.headers.get("content-type") || "").split(";")[0].trim();
  const base = safeName(name || path.basename(parsed.pathname) || "download", "download");
  const tmp = path.join(os.tmpdir(), "cutline-agent-" + randomUUID() + "-" + base);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_DOWNLOAD_BYTES) throw new Error(tooBig);
  await fsp.writeFile(tmp, bytes);
  return { tmp, mime, name: base };
}

async function exportProjectBundle(dataRoot, input) {
  const project = projects.getProject(dataRoot, input.projectId);
  if (!project) throw new Error("That project id is not in this workspace. Call jeditor_list_projects for the ids.");
  const ws = await loadWorkspace(dataRoot, project.workspaceId);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const root = input.destDir
    ? path.resolve(String(input.destDir))
    : path.join(dataRoot, "exports", safeName(project.name, "project") + "-" + stamp);
  const assetDir = path.join(root, "assets");
  await fsp.mkdir(assetDir, { recursive: true });
  const assets = [];
  for (const ref of project.assets || []) {
    const item = (ws.library || []).find((entry) => entry.id === ref.id);
    if (!item) {
      assets.push({ id: ref.id, kind: ref.kind, missing: true });
      continue;
    }
    const src = libraryFilePath(dataRoot, ws.id, item);
    const dest = path.join(assetDir, item.id + path.extname(item.file || ""));
    let copied = false;
    try {
      await fsp.copyFile(src, dest);
      copied = true;
    } catch {
      copied = false;
    }
    assets.push({
      id: item.id,
      kind: item.kind,
      name: item.name,
      mime: item.mime,
      durationMs: item.durationMs,
      file: copied ? path.relative(root, dest) : "",
      missing: !copied,
    });
  }
  // Card and asset edits carry no projectId, so rows that name the project,
  // one of its assets, or a card that ships in this bundle count as well.
  const ids = [project.id, ...(project.assets || []).map((ref) => ref.id), ...(ws.cards || []).map((card) => card.id)].filter(Boolean);
  const activity = listActions(dataRoot, { limit: 500 }).filter((row) => {
    if (row.projectId === project.id) return true;
    const args = JSON.stringify(row.args || {});
    return ids.some((id) => args.includes(id));
  });
  const manifest = {
    format: "cutline-project-export",
    version: 1,
    exportedAt: new Date().toISOString(),
    project,
    assets,
    cards: ws.cards || [],
    agents: Array.from(new Set(activity.map((row) => row.client || row.harness).filter(Boolean))),
  };
  const writeTmp = async (file, value) => {
    const tmp = file + "." + randomUUID() + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
    await fsp.rename(tmp, file);
  };
  await writeTmp(path.join(root, "project.json"), manifest);
  await writeTmp(path.join(root, "agent-activity.json"), activity);
  let finished = null;
  if (input.finishedId) {
    const item = await getFinishedItem(dataRoot, input.finishedId, ws.id);
    if (!item) throw new Error("That finished video id does not exist in this workspace. jeditor_snapshot lists the finished ids.");
    const dest = path.join(root, safeName(item.name, "finished") + (path.extname(item.file || "") || ".mp4"));
    await fsp.copyFile(finishedFilePath(dataRoot, ws.id, item), dest);
    finished = dest;
  }
  return { path: root, manifest: path.join(root, "project.json"), assets: assets.length, actions: activity.length, finished };
}

// What a list row keeps: the fields an agent picks and filters by, plus the ids
// it hands to the detail tool. Storage details (file paths, content hashes,
// posters, editor state) stay in the row the detail tool returns.
function libraryRow(item) {
  const row = { id: item.id, name: item.name, kind: item.kind, size: Number(item.size) || 0 };
  if (Number(item.durationMs)) row.durationMs = Number(item.durationMs);
  row.aiCanUse = item.aiCanUse !== false;
  if (item.createdAt) row.createdAt = item.createdAt;
  return row;
}

function finishedRow(item) {
  const row = { id: item.id, name: item.name, kind: "video", size: Number(item.size) || 0 };
  if (Number(item.durationMs)) row.durationMs = Number(item.durationMs);
  if (item.createdAt) row.createdAt = item.createdAt;
  return row;
}

function cardRow(card) {
  const row = { id: card.id, name: card.name, kind: card.kind, placement: card.placement };
  if (Number(card.durationMs)) row.durationMs = Number(card.durationMs);
  return row;
}

// A project list row: no editor state, but the counts an agent needs to choose
// between projects.
function projectRow(project) {
  const renders = (project.state && project.state.renders) || {};
  return {
    id: project.id,
    name: project.name,
    aspectRatio: project.aspectRatio,
    pinned: Boolean(project.pinned),
    assets: (project.assets || []).length,
    renders: Object.keys(renders).length,
    updatedAt: project.updatedAt,
  };
}

function baseAgentToolSpecs(options) {
  return [
    {
      name: "jeditor_list_workspaces",
      description: "List the workspaces with their ids, names, and which one is active. Use it to find a workspaceId for another call.",
      inputSchema: obj({}),
      async run({ dataRoot }) {
        const state = await loadState(dataRoot);
        return { activeWorkspaceId: state.activeWorkspaceId, workspaces: state.workspaces };
      },
    },
    {
      name: "jeditor_create_workspace",
      description: "Create a new empty workspace. Use it when the person wants a clean space; activate switches the app to it now.",
      inputSchema: obj(
        {
          name: { type: "string", description: "Workspace name, up to 80 characters." },
          activate: { type: "boolean", description: "Make it the active workspace. Default false." },
        },
        ["name"],
      ),
      mutates: true,
      async run({ dataRoot }, input) {
        const state = await loadState(dataRoot);
        const id = randomUUID();
        const name = String(input.name || "Workspace").trim().slice(0, 80) || "Workspace";
        await writeJsonAtomic(workspacePath(dataRoot, id), emptyWorkspace(id, name));
        const next = Object.assign({}, state, {
          workspaces: state.workspaces.concat([{ id, name, createdAt: new Date().toISOString() }]),
          activeWorkspaceId: input.activate ? id : state.activeWorkspaceId,
        });
        await writeJsonAtomic(statePath(dataRoot), next);
        return { id, name, active: next.activeWorkspaceId === id };
      },
    },
    {
      name: "jeditor_set_active_workspace",
      description: "Switch the active workspace, so later calls that omit workspaceId use it. Use it when the person moves to another workspace.",
      inputSchema: obj({ workspaceId: { type: "string", description: "Workspace id to switch to." } }, ["workspaceId"]),
      mutates: true,
      async run({ dataRoot }, input) {
        const state = await loadState(dataRoot);
        if (!state.workspaces.some((item) => item.id === input.workspaceId)) throw new Error("That workspace id does not exist. jeditor_list_workspaces lists the workspace ids.");
        await writeJsonAtomic(statePath(dataRoot), Object.assign({}, state, { activeWorkspaceId: input.workspaceId }));
        return { activeWorkspaceId: input.workspaceId };
      },
    },
    {
      name: "jeditor_snapshot",
      description: "Read the whole workspace in short rows: counts, then id, name, kind, size, and duration for every library item, finished video, card, and link. Use it to find ids. jeditor_list_projects has project editor state.",
      inputSchema: obj({ workspaceId: WS }),
      async run({ dataRoot }, input) {
        const full = await snapshot(dataRoot, input.workspaceId);
        const ws = full.workspace || {};
        const library = ws.library || [];
        const finished = ws.finished || [];
        const cards = ws.cards || [];
        const links = ws.links || [];
        const kindCount = (kind) => library.filter((item) => item && item.kind === kind).length;
        const result = {
          activeWorkspaceId: full.activeWorkspaceId,
          workspaces: (full.workspaces || []).map((item) => ({ id: item.id, name: item.name, createdAt: item.createdAt })),
          workspace: {
            id: ws.id,
            name: ws.name,
            createdAt: ws.createdAt,
            updatedAt: ws.updatedAt,
            counts: {
              library: library.length,
              videos: kindCount("video"),
              images: kindCount("image"),
              audio: kindCount("audio"),
              finished: finished.length,
              cards: cards.length,
              links: links.length,
            },
            library: library.map(libraryRow),
            finished: finished.map(finishedRow),
            cards: cards.map(cardRow),
            links: links.map((link) => ({ id: link.id, refs: link.refs })),
          },
        };
        // Nothing was trimmed in an empty workspace, so it needs no pointer.
        if (library.length || finished.length || cards.length) {
          result.note =
            "Short rows, no paths or stored fields. jeditor_list_projects returns projects with their editor state. jeditor_get_library_item, jeditor_get_card, and jeditor_get_finished return one row in full.";
        }
        return result;
      },
    },
    {
      name: "jeditor_delete_card",
      description: "Delete an edit card. Use it when a card is no longer wanted; a render it was burned into is untouched. confirm:true is required.",
      inputSchema: obj({ cardId: CARD_ID, workspaceId: WS, confirm: CONFIRM }, ["cardId", "confirm"]),
      mutates: true,
      async run({ dataRoot }, input) {
        needConfirm(input, "this card");
        const ws = await loadWorkspace(dataRoot, await activeId(dataRoot, input.workspaceId));
        const before = ws.cards.length;
        ws.cards = ws.cards.filter((card) => card.id !== input.cardId);
        if (ws.cards.length === before) throw new Error("That card id does not exist. jeditor_list_cards lists the card ids.");
        await saveWorkspace(dataRoot, ws);
        return { deleted: input.cardId };
      },
    },
    {
      name: "jeditor_duplicate_card",
      description: "Copy an edit card into a new card, with an optional name for the copy. Use it to keep the original while trying another design.",
      inputSchema: obj(
        { cardId: CARD_ID, name: { type: "string", description: "Name for the copy. Defaults to the original name plus ' copy'." }, workspaceId: WS },
        ["cardId"],
      ),
      mutates: true,
      async run({ dataRoot }, input) {
        const ws = await loadWorkspace(dataRoot, await activeId(dataRoot, input.workspaceId));
        const card = ws.cards.find((item) => item.id === input.cardId);
        if (!card) throw new Error("That card id does not exist. jeditor_list_cards lists the card ids.");
        const copy = JSON.parse(JSON.stringify(card));
        delete copy.id;
        copy.name = input.name || card.name + " copy";
        const result = await applyCardEdit({ dataRoot, workspaceId: ws.id, patch: copy });
        return { card: result.card };
      },
    },
    {
      name: "jeditor_attach_card_image",
      description: "Attach an image to a card: a file at path, imported into the library, or an image already there. Use asBackground to make it the card's background.",
      inputSchema: obj(
        {
          cardId: CARD_ID,
          path: { type: "string", description: "Absolute path to a PNG, JPG, or WEBP file. Omit when you pass libraryId." },
          libraryId: { type: "string", description: "Use an image already in the library instead of path." },
          asBackground: { type: "boolean", description: "Make this image the card's background. Default false." },
          workspaceId: WS,
        },
        ["cardId"],
      ),
      mutates: true,
      async run({ dataRoot }, input) {
        const wsId = await activeId(dataRoot, input.workspaceId);
        let imageId = input.libraryId;
        if (!imageId) {
          if (!input.path) throw new Error("Pass path to an image file, or libraryId for an image already in the library.");
          const added = await copyPathIntoLibrary(dataRoot, input.path, { workspaceId: wsId, source: "agent" });
          if (added.item.kind !== "image") throw new Error("That file is not an image, so nothing was attached. Pass a PNG, JPG or WEBP path, or a library image id.");
          imageId = added.item.id;
        }
        const ws = await loadWorkspace(dataRoot, wsId);
        const card = ws.cards.find((item) => item.id === input.cardId);
        if (!card) throw new Error("That card id does not exist. jeditor_list_cards lists the card ids.");
        if (!ws.library.some((item) => item.id === imageId && item.kind === "image")) throw new Error("That image id is not in the library. jeditor_list_library with kind image lists them.");
        card.imageIds = Array.from(new Set((card.imageIds || []).concat([imageId])));
        if (input.asBackground) {
          card.composition = card.composition || {};
          card.composition.backgroundId = imageId;
        }
        card.updatedAt = new Date().toISOString();
        await saveWorkspace(dataRoot, ws);
        return { card, imageId };
      },
    },
    {
      name: "jeditor_add_files",
      description: "Import local video, image, or audio files into the library in one call, returning each item id, kind, and a video's length. Use it before any edit that needs a clip.",
      inputSchema: obj(
        {
          paths: { type: "array", items: { type: "string" }, description: "Absolute paths on this computer. A duplicate is reported in skipped, not imported twice." },
          workspaceId: WS,
        },
        ["paths"],
      ),
      mutates: true,
      async run({ dataRoot }, input) {
        const wsId = await activeId(dataRoot, input.workspaceId);
        const added = [];
        const skipped = [];
        const failed = [];
        for (const file of input.paths || []) {
          try {
            const result = await copyPathIntoLibrary(dataRoot, file, { workspaceId: wsId, source: "agent" });
            const item = result.item;
            (result.skipped ? skipped : added).push({
              path: file,
              id: item.id,
              kind: item.kind,
              name: item.name,
              // Agents plan cuts in seconds; the length has to come back with
              // the upload, not from a separate probe the agent cannot run.
              durationMs: item.kind === "video" ? Number(item.durationMs) || 0 : undefined,
            });
          } catch (error) {
            failed.push({ path: file, error: fileFailure(error) });
          }
        }
        return { workspaceId: wsId, added, skipped, failed };
      },
    },
    {
      name: "jeditor_add_from_url",
      description: "Download a video, image, or audio file from an http(s) URL into the library. Use it when the source is a link rather than a file on this computer.",
      inputSchema: obj(
        {
          url: { type: "string", description: "http or https URL. Other schemes and files over 2 GB are refused." },
          name: { type: "string", description: "Name for the library item. Defaults to the file name in the URL." },
          workspaceId: WS,
        },
        ["url"],
      ),
      mutates: true,
      async run({ dataRoot }, input) {
        const got = await downloadToTemp(input.url, input.name);
        try {
          // The store hands back the whole workspace with every import; the
          // agent only needs the new row.
          const copied = await copyPathIntoLibrary(dataRoot, got.tmp, {
            workspaceId: input.workspaceId,
            name: got.name,
            mime: got.mime,
            source: "agent",
          });
          return { item: libraryRow(copied.item), skipped: copied.skipped === true };
        } finally {
          fsp.unlink(got.tmp).catch(() => {});
        }
      },
    },
    {
      name: "jeditor_add_from_base64",
      description: "Write base64 bytes into the library as a new item. Use it for images you generated or received inline, which have no file on disk.",
      inputSchema: obj(
        {
          data: { type: "string", description: "Base64 bytes, with or without a data: prefix." },
          name: { type: "string", description: "Name for the new library item, including its extension." },
          mime: { type: "string", description: "File type, e.g. image/png or audio/mpeg. Decides the item's kind." },
          workspaceId: WS,
        },
        ["data", "name", "mime"],
      ),
      mutates: true,
      async run({ dataRoot }, input) {
        const tmp = path.join(os.tmpdir(), "cutline-agent-" + randomUUID() + "-" + safeName(input.name, "file"));
        await fsp.writeFile(tmp, Buffer.from(String(input.data).replace(/^data:[^,]+,/, ""), "base64"));
        try {
          const copied = await copyPathIntoLibrary(dataRoot, tmp, {
            workspaceId: input.workspaceId,
            name: input.name,
            mime: input.mime,
            source: "agent",
          });
          return { item: libraryRow(copied.item), skipped: copied.skipped === true };
        } finally {
          fsp.unlink(tmp).catch(() => {});
        }
      },
    },
    {
      name: "jeditor_update_library_item",
      description: "Rename a library item, change its description, or set whether the AI may use it. Use it for clearer labels, or to keep a clip away from agents.",
      inputSchema: obj(
        {
          id: { type: "string", description: "Library item id, from jeditor_snapshot." },
          name: { type: "string", description: "New name." },
          description: { type: "string", description: "New description, up to 2000 characters. A voiceover's script is kept here." },
          aiCanUse: { type: "boolean", description: "Whether the AI may use this item." },
          workspaceId: WS,
        },
        ["id"],
      ),
      mutates: true,
      async run({ dataRoot }, input) {
        const ws = await loadWorkspace(dataRoot, await activeId(dataRoot, input.workspaceId));
        const item = ws.library.find((entry) => entry.id === input.id);
        if (!item) throw new Error("That library item id is not in this workspace. jeditor_snapshot lists the library ids.");
        if (typeof input.name === "string") item.name = input.name.trim() || item.name;
        if (typeof input.description === "string") item.description = input.description.slice(0, 2000);
        if (typeof input.aiCanUse === "boolean") item.aiCanUse = input.aiCanUse;
        await saveWorkspace(dataRoot, ws);
        return { item };
      },
    },
    {
      name: "jeditor_delete_library_item",
      description: "Delete a library item and its file, and drop it from the cards and projects that used it. Use only on the person's say so. confirm:true is required.",
      inputSchema: obj({ id: { type: "string", description: "Library item id, from jeditor_snapshot." }, workspaceId: WS, confirm: CONFIRM }, ["id", "confirm"]),
      mutates: true,
      async run({ dataRoot }, input) {
        needConfirm(input, "this library item");
        const wsId = await activeId(dataRoot, input.workspaceId);
        const item = await getLibraryItem(dataRoot, input.id, wsId);
        if (!item) throw new Error("That library item id is not in this workspace. jeditor_snapshot lists the library ids.");
        return deleteLibraryItemFromDisk(dataRoot, input.id, input.workspaceId);
      },
    },
    {
      name: "jeditor_link_items",
      description: "Link two library items, for example a clip and its voiceover. Use it so the pair is found together later; linking the same pair twice returns the existing link.",
      inputSchema: obj(
        {
          a: { type: "string", description: "Library item id of the first item." },
          b: { type: "string", description: "Library item id of the second item. Must differ from a." },
          workspaceId: WS,
        },
        ["a", "b"],
      ),
      mutates: true,
      async run({ dataRoot }, input) {
        if (input.a === input.b) throw new Error("Pass two different library ids: a and b are the same item, so there is nothing to link.");
        const ws = await loadWorkspace(dataRoot, await activeId(dataRoot, input.workspaceId));
        if (![input.a, input.b].every((id) => ws.library.some((item) => item.id === id))) {
          throw new Error("One of those ids is not in this workspace's library. jeditor_snapshot lists the library ids.");
        }
        const existing = ws.links.find((link) => link.refs.includes(input.a) && link.refs.includes(input.b));
        if (existing) return { link: existing, created: false };
        const link = { id: randomUUID(), refs: [input.a, input.b], createdAt: new Date().toISOString() };
        ws.links.push(link);
        await saveWorkspace(dataRoot, ws);
        return { link, created: true };
      },
    },
    {
      name: "jeditor_unlink_items",
      description: "Remove a link between library items by link id. Use it when a clip and a track should no longer be paired; the items themselves stay.",
      inputSchema: obj({ linkId: { type: "string", description: "Link id, from jeditor_snapshot." }, workspaceId: WS }, ["linkId"]),
      mutates: true,
      async run({ dataRoot }, input) {
        const ws = await loadWorkspace(dataRoot, await activeId(dataRoot, input.workspaceId));
        ws.links = ws.links.filter((link) => link.id !== input.linkId);
        await saveWorkspace(dataRoot, ws);
        return { removed: input.linkId };
      },
    },
    {
      name: "jeditor_update_finished",
      description: "Rename a finished video or change its description. Use it when a render needs a clearer label. Library items and cards are not touched.",
      inputSchema: obj(
        {
          id: FINISHED_ID,
          name: { type: "string", description: "New name." },
          description: { type: "string", description: "New description." },
          workspaceId: WS,
        },
        ["id"],
      ),
      mutates: true,
      async run({ dataRoot }, input) {
        const patch = {};
        if (typeof input.name === "string") patch.name = input.name;
        if (typeof input.description === "string") patch.description = input.description;
        const snap = await updateFinishedItem(dataRoot, input.id, patch, input.workspaceId);
        return { item: (snap.workspace.finished || []).find((item) => item.id === input.id) || null };
      },
    },
    {
      name: "jeditor_delete_finished",
      description: "Delete a finished video and its file, and drop it from the projects that pointed at it. Use only on the person's say so. confirm:true is required.",
      inputSchema: obj({ id: FINISHED_ID, workspaceId: WS, confirm: CONFIRM }, ["id", "confirm"]),
      mutates: true,
      async run({ dataRoot }, input) {
        needConfirm(input, "this render");
        await deleteFinishedItem(dataRoot, input.id, input.workspaceId);
        try {
          const wsId = await activeId(dataRoot, input.workspaceId);
          projects.dropRender(dataRoot, wsId, input.id);
        } catch {
          /* the render removal stays authoritative */
        }
        return { deleted: input.id };
      },
    },
    {
      name: "jeditor_export_finished",
      description: "Copy a finished video to a file or folder path on this computer. Use it when the person needs the .mp4 outside JV.",
      inputSchema: obj(
        {
          id: FINISHED_ID,
          destPath: { type: "string", description: "Absolute file or folder path. A folder gets the render's name and extension." },
          workspaceId: WS,
        },
        ["id", "destPath"],
      ),
      async run({ dataRoot }, input) {
        const wsId = await activeId(dataRoot, input.workspaceId);
        const item = await getFinishedItem(dataRoot, input.id, wsId);
        if (!item) throw new Error("That finished video id does not exist in this workspace. jeditor_snapshot lists the finished ids.");
        let dest = path.resolve(String(input.destPath));
        const ext = path.extname(item.file || "") || ".mp4";
        if (fs.existsSync(dest) && fs.statSync(dest).isDirectory()) dest = path.join(dest, safeName(item.name, "finished") + ext);
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.copyFile(finishedFilePath(dataRoot, wsId, item), dest);
        return { path: dest };
      },
    },
    {
      name: "jeditor_list_projects",
      description: "List the workspace's video projects with their ids, names, aspect ratios, pinned state, and how many clips and renders each holds. Use it to find the projectId another call needs.",
      inputSchema: obj({ workspaceId: WS }),
      async run({ dataRoot }, input) {
        const wsId = await activeId(dataRoot, input.workspaceId);
        const rows = projects.listProjects(dataRoot, wsId).map(projectRow);
        return {
          workspaceId: wsId,
          projects: rows,
          note: "Editor state is left out here. jeditor_get_project returns one project with its timeline, assets, and renders.",
        };
      },
    },
    {
      name: "jeditor_get_project",
      description: "Read one project with its timeline state, its clips, and its renders. Use it before editing the timeline or the look.",
      inputSchema: obj({ projectId: PROJECT_ID }, ["projectId"]),
      async run({ dataRoot }, input) {
        const project = projects.getProject(dataRoot, input.projectId);
        if (!project) throw new Error("That project id is not in this workspace. Call jeditor_list_projects for the ids.");
        const ws = await loadWorkspace(dataRoot, project.workspaceId);
        const videos = (rows) => (rows || []).filter((item) => item && item.kind === "video");
        const byId = new Map(videos(ws.finished).map((item) => [String(item.id), item]));
        const libraryById = new Map(videos(ws.library).map((item) => [String(item.id), item]));
        const renders = (project.state && project.state.renders) || {};
        const outputs = [];
        const seen = new Set();
        const addOutput = (item) => {
          if (!item || seen.has(item.id)) return;
          seen.add(item.id);
          outputs.push({ id: item.id, name: item.name, createdAt: item.createdAt });
        };
        for (const renderId of Object.values(renders)) addOutput(byId.get(String(renderId)) || libraryById.get(String(renderId)));
        for (const item of videos(ws.finished)) {
          const owners = Array.isArray(item.projectIds) ? item.projectIds.map(String) : [];
          if (owners.includes(String(project.id))) addOutput(item);
        }
        return {
          id: project.id,
          workspaceId: project.workspaceId,
          name: project.name,
          aspectRatio: project.aspectRatio,
          pinned: Boolean(project.pinned),
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
          assets: (project.assets || []).map((asset) => ({ id: asset.id, kind: asset.kind, position: asset.position })),
          state: project.state,
          outputs,
        };
      },
    },
    {
      name: "jeditor_create_project",
      description: "Create a project from library items. Use it when a clip needs its own timeline; aspectRatio sets the output frame and state can carry the first edits.",
      inputSchema: obj(
        {
          name: { type: "string", description: "Project name, up to 120 characters." },
          aspectRatio: ASPECT_RATIO,
          assetIds: { type: "array", items: { type: "string" }, description: "Library item ids to pin on the project, in timeline order. They must exist already." },
          state: { type: "object", description: "Initial editor state: timeline edits, captions, selected clip. Merged into the new project." },
          workspaceId: WS,
        },
        ["name"],
      ),
      mutates: true,
      async run({ dataRoot }, input) {
        const ws = await loadWorkspace(dataRoot, await activeId(dataRoot, input.workspaceId));
        const assets = (input.assetIds || []).map((id) => {
          const item = ws.library.find((entry) => entry.id === id);
          if (!item) throw new Error("That id is not in the library, so the project was not created. jeditor_list_library lists the ids; import a file with jeditor_add_files first.");
          return { id: item.id, kind: item.kind };
        });
        return projects.createProject(dataRoot, {
          workspaceId: ws.id,
          name: input.name,
          aspectRatio: input.aspectRatio,
          assets,
          state: input.state,
        });
      },
    },
    {
      name: "jeditor_update_project",
      description: "Rename a project, change its aspect ratio, pin it, or patch its editor state. Use it when the frame, the label, or a timeline value changes; state merges instead of replacing, so one clip's edits are safe.",
      inputSchema: obj(
        {
          projectId: PROJECT_ID,
          name: { type: "string", description: "New project name." },
          aspectRatio: ASPECT_RATIO,
          pinned: { type: "boolean", description: "Pin the project to the top of the list." },
          state: { type: "object", description: "Editor state patch. Maps merge key by key, anything else replaces, null deletes a key." },
        },
        ["projectId"],
      ),
      mutates: true,
      async run({ dataRoot }, input) {
        const patch = {};
        for (const key of ["name", "aspectRatio", "pinned"]) if (input[key] !== undefined) patch[key] = input[key];
        if (input.state !== undefined) {
          // Merge instead of replace: a partial state (e.g. only videoEdits)
          // must not wipe the sibling keys the project already holds.
          const current = projects.getProject(dataRoot, input.projectId);
          if (!current) throw new Error("That project id is not in this workspace. Call jeditor_list_projects for the ids.");
          // A null state used to merge as a no-op; keep that so an explicit
          // null cannot blank the project's whole editor snapshot.
          patch.state = input.state == null ? current.state : mergeStatePatch(current.state, input.state);
        }
        return projects.updateProject(dataRoot, input.projectId, patch);
      },
    },
    {
      name: "jeditor_project_add_assets",
      description: "Pin library items on a project as extra clips. Use it when a project needs another clip; the items must already be in the library.",
      inputSchema: obj(
        {
          projectId: PROJECT_ID,
          assetIds: { type: "array", items: { type: "string" }, description: "Library item ids to add, in timeline order." },
        },
        ["projectId", "assetIds"],
      ),
      mutates: true,
      async run({ dataRoot }, input) {
        const meta = projects.getProjectMeta(dataRoot, input.projectId);
        if (!meta) throw new Error("That project id is not in this workspace. Call jeditor_list_projects for the ids.");
        const ws = await loadWorkspace(dataRoot, meta.workspaceId);
        const assets = input.assetIds.map((id) => {
          const item = ws.library.find((entry) => entry.id === id);
          if (!item) throw new Error("That id is not in the library, so nothing was added. Import the file with jeditor_add_files first.");
          return { id: item.id, kind: item.kind };
        });
        return projects.addAssets(dataRoot, input.projectId, assets);
      },
    },
    {
      name: "jeditor_project_remove_asset",
      description: "Remove one clip from a project's timeline. Use it when a clip no longer belongs in the edit; the library file and its other projects stay.",
      inputSchema: obj(
        { projectId: PROJECT_ID, libraryId: { type: "string", description: "Library item id of the clip to remove." } },
        ["projectId", "libraryId"],
      ),
      mutates: true,
      async run({ dataRoot }, input) {
        return projects.removeAsset(dataRoot, input.projectId, input.libraryId);
      },
    },
    {
      name: "jeditor_project_add_render",
      description: "Turn a render back into an editable clip: copy it into the library, pin it on the project, and select it, so cuts and reframing apply to it. Use it to edit a finished video. Omit projectId to start a new project on it.",
      inputSchema: obj(
        {
          finishedId: FINISHED_ID,
          projectId: { type: "string", description: "Project to add the copy to. Omit to open a fresh project on the render instead." },
          workspaceId: WS,
        },
        ["finishedId"],
      ),
      mutates: true,
      async run({ dataRoot }, input) {
        const wsId = await activeId(dataRoot, input.workspaceId);
        const finished = await getFinishedItem(dataRoot, input.finishedId, wsId);
        if (!finished) throw new Error("That finished video id does not exist in this workspace. jeditor_snapshot lists the finished ids.");
        const copied = await copyPathIntoLibrary(dataRoot, finishedFilePath(dataRoot, wsId, finished), {
          workspaceId: wsId,
          name: finished.name + (finished.file ? path.extname(finished.file) : ".mp4"),
          mime: finished.mime || "video/mp4",
          source: "finished-export",
        });
        const item = copied.item;
        let project;
        if (input.projectId) {
          const meta = projects.getProjectMeta(dataRoot, input.projectId);
          if (!meta) throw new Error("That project id is not in this workspace. Call jeditor_list_projects for the ids.");
          projects.addAssets(dataRoot, input.projectId, [{ id: item.id, kind: item.kind }]);
          const current = projects.getProject(dataRoot, input.projectId);
          project = projects.updateProject(dataRoot, input.projectId, {
            state: mergeStatePatch(current.state, { selectedAssetId: item.id }),
          });
        } else {
          project = projects.createProject(dataRoot, {
            workspaceId: wsId,
            name: (finished.name || "Finished video") + " edit",
            assets: [{ id: item.id, kind: item.kind }],
            state: { selectedAssetId: item.id },
          });
        }
        return { item: libraryRow(item), skipped: copied.skipped === true, project };
      },
    },
    {
      name: "jeditor_delete_project",
      description: "Delete a project with its timeline state, drawings, and chats. Use it on a draft that is done with; library files and finished videos stay. confirm:true is required.",
      inputSchema: obj({ projectId: PROJECT_ID, confirm: CONFIRM }, ["projectId", "confirm"]),
      mutates: true,
      async run({ dataRoot }, input) {
        needConfirm(input, "this project");
        const meta = projects.getProjectMeta(dataRoot, input.projectId);
        if (!meta) throw new Error("Project not found: " + input.projectId);
        return deleteProjectCascade({
          dataRoot,
          workspaceId: meta.workspaceId,
          projectId: input.projectId,
          prepareDrawings: options && options.prepareDrawings,
          drawingsDeleted: options && options.drawingsDeleted,
        });
      },
    },
    {
      name: "jeditor_get_timeline",
      description:
        "Read a project clip's timeline and look: kept, cut, sped, and muted segments with frames, the frame (ratio, fit or fill, focus), zooms, texts, flashes, fades, and audio tracks, plus source size, duration, and fps. Use it before editing so ranges line up.",
      inputSchema: obj({ projectId: PROJECT_ID, videoId: VIDEO_ID }, ["projectId"]),
      async run({ dataRoot }, input) {
        const { describeProjectTimeline } = require("./video-render");
        return describeProjectTimeline(dataRoot, input.projectId, input.videoId);
      },
    },
    {
      name: "jeditor_edit_timeline",
      description: EDIT_TIMELINE_DOC,
      inputSchema: obj(
        {
          projectId: PROJECT_ID,
          videoId: VIDEO_ID,
          ops: {
            type: "array",
            description: EDIT_TIMELINE_OPS_DOC,
            items: { type: "object" },
            minItems: 1,
            maxItems: 200,
          },
          frame: {
            type: "object",
            description:
              "Snap the cuts to whole frames. Defaults to the probed source frame rate, so a cut at 1.3 s lands on frame 39 of a 30 fps clip instead of mid-frame.",
            properties: {
              fps: { type: "number", description: "Frame rate to snap to, when the probe is wrong or missing. Usually leave it out." },
              snap: { type: "boolean", description: "false cuts on raw milliseconds with no frame snapping." },
            },
          },
        },
        ["projectId", "ops"],
      ),
      mutates: true,
      validate(input) {
        if (!Array.isArray(input.ops) || !input.ops.length) {
          throw new Error("ops needs at least one op: cut, keep, split, speed, audio, reset, ratio, frame, zoom, unzoom, text, remove_text, flash, fade or sound.");
        }
        if (input.ops.length > 200) throw new Error("Pass 200 ops or fewer per call: split a long edit into several calls.");
      },
      async run({ dataRoot }, input) {
        const { editProjectTimeline } = require("./video-render");
        try {
          return await editProjectTimeline(dataRoot, input);
        } catch (error) {
          throw renderFailure(error, "Check the clip's file is in the library, then try again.");
        }
      },
    },
    {
      name: "jeditor_auto_scale",
      description:
        "Fill the project frame with the clip, cropping around the frame focus instead of showing bars; on:false shows the whole picture again. Use it when the clip's shape differs from the ratio, then check the crop before rendering.",
      inputSchema: obj(
        {
          projectId: PROJECT_ID,
          videoId: VIDEO_ID,
          on: { type: "boolean", description: "true (default) fills the frame; false shows the whole picture again." },
          all: { type: "boolean", description: "Apply to every video in the project instead of one clip." },
        },
        ["projectId"],
      ),
      mutates: true,
      async run({ dataRoot }, input) {
        const { autoScaleProject } = require("./video-render");
        return autoScaleProject(dataRoot, input);
      },
    },
    {
      name: "jeditor_render_project",
      description:
        "Bake the project into a real video at its ratio (1080 on the short side): cuts, speed, audio, framing, zooms, texts, flashes, and fades burned in. Use it once the timeline and look are set, then probe the sound and look at a frame.",
      inputSchema: obj(
        {
          projectId: PROJECT_ID,
          videoId: VIDEO_ID,
          name: { type: "string", description: "Finished video name. Defaults to the project name." },
          audioId: AUDIO_ID,
          audioVolume: AUDIO_VOLUME,
          audioLoop: AUDIO_LOOP,
          duck: AUDIO_DUCK,
          audioIds: AUDIO_IDS,
          audios: {
            type: "array",
            description:
              "Tracks with their own gain: [{audioId, volume, loop, duck}]. Use jeditor_set_audio when the tracks should stay on the timeline and survive a re-render.",
            items: {
              type: "object",
              properties: {
                audioId: AUDIO_ID,
                volume: AUDIO_VOLUME,
                loop: AUDIO_LOOP,
                duck: AUDIO_DUCK,
              },
              required: ["audioId"],
            },
          },
        },
        ["projectId"],
      ),
      mutates: true,
      async run({ dataRoot }, input) {
        const { renderProjectVideo } = require("./video-render");
        try {
          return await renderProjectVideo(dataRoot, input);
        } catch (error) {
          throw renderFailure(error, "Check that the clip plays in a video player, then try again.");
        }
      },
    },
    {
      name: "jeditor_preview_frames",
      description: PREVIEW_FRAMES_DOC,
      inputSchema: obj(
        {
          projectId: PROJECT_ID,
          videoId: VIDEO_ID,
          times: { type: "array", items: { type: "number" }, description: "Source seconds to look at, up to 8.", maxItems: 8 },
          outputTimes: { type: "array", items: { type: "number" }, description: "Finished-video seconds to look at, up to 8. Ignored when times is set.", maxItems: 8 },
          count: { type: "number", description: "With neither times nor outputTimes: how many moments to spread over the finished video. Default 4.", minimum: 1, maximum: 8, default: 4 },
          source: { type: "boolean", description: "Also return the raw source frame with a quarter grid for reading focus points. Default true.", default: true },
        },
        ["projectId"],
      ),
      async run({ dataRoot }, input) {
        const { previewProjectFrames, framesToContent } = require("./video-render");
        let frames;
        try {
          frames = await previewProjectFrames(dataRoot, input);
        } catch (error) {
          throw renderFailure(error, "Check that the clip plays in a video player, then try again.");
        }
        const { content } = framesToContent(frames);
        return { content, isError: false };
      },
    },
    {
      name: "jeditor_render_animation",
      description: ANIMATION_DOC,
      inputSchema: obj(
        Object.assign(animationCodeProps(), {
          name: { type: "string", description: "What the animation is called in Videos and images." },
          projectId: { type: "string", description: "Project that asked for it: the animation joins its assets and becomes the clip on its timeline." },
          replaceClipId: {
            type: "string",
            description: "Library id of a clip in this project that this render replaces (a fixed or changed version of it). Fields you leave out come from that clip's saved source, so send only what changes (\"\" drops a field; new html or another preset starts over). It keeps the clip's frame, length, timeline edits, and captions.",
          },
          asNewClip: {
            type: "boolean",
            description: "Only for a project made from a gallery design: true adds this render as another clip (for example a second counter) instead of replacing the design's clip.",
          },
          audioId: AUDIO_ID,
          audioVolume: AUDIO_VOLUME,
          audioLoop: AUDIO_LOOP,
          audioIds: AUDIO_IDS,
          audios: {
            type: "array",
            description:
              "Tracks with their own gain and timing. scene: N starts a voice line at scene N (1 based) and lengthens that scene if the line runs longer; startMs adds a delay on top. Overrides audioIds and audioId. On a gallery design, audios: [] removes the saved audio.",
            items: {
              type: "object",
              properties: {
                audioId: AUDIO_ID,
                volume: AUDIO_VOLUME,
                loop: AUDIO_LOOP,
                duck: AUDIO_DUCK,
                startMs: { type: "number", description: "Delay before the track starts, in ms.", minimum: 0 },
                scene: { type: "number", description: "Scene the track starts with, 1 based. Needs scenes.", minimum: 1, maximum: 8 },
              },
              required: ["audioId"],
            },
          },
        }),
        [],
      ),
      mutates: true,
      async run({ dataRoot, appRoot }, input) {
        const { renderAnimation } = require("./animation-render");
        const design = require("./project-design");
        // A new render of the project's gallery design (same preset, the
        // preset's own markup) starts from the saved design: params, colors,
        // and extra code the call leaves out keep their saved values, so the
        // clip and the saved design always match. It then replaces the old
        // clip, and "Edit design" in the editor shows what the agent changed.
        const current = input.projectId ? design.liveDesign(projects.getProject(dataRoot, input.projectId)) : null;
        // replaceClipId naming another clip (a second clip of the same preset)
        // fixes that clip, not the design.
        // replaceClipId naming the design's own clip, with no new markup, is a
        // design edit too.
        const sameDesign = Boolean(
          current && !input.html && !input.scenes && input.asNewClip !== true &&
            ((input.preset && input.preset === current.preset && (!input.replaceClipId || input.replaceClipId === current.assetId)) ||
              (!input.preset && input.replaceClipId && input.replaceClipId === current.assetId)),
        );
        if (sameDesign && !input.preset) input = Object.assign({}, input, { preset: current.preset });
        const call = Object.assign({}, input, { dataRoot, appRoot });
        if (sameDesign) {
          call.presetParams = Object.assign({}, current.params, input.presetParams || {});
          call.colors = Object.assign({}, current.colors, input.colors || {});
          if (input.css == null && current.css) call.css = current.css;
          if (input.js == null && current.js) call.js = current.js;
          if (!input.aspectRatio && current.aspectRatio) call.aspectRatio = current.aspectRatio;
          // Length, frame rate, and audio carry over too, so a tweak never
          // drops the voiceover or the longer cut an earlier turn made.
          const extras = current.extras || {};
          // Audio settings travel as one group: naming any of them replaces
          // the saved set (audios: [] removes the audio).
          // Naming a track (audioId, audioIds, audios) replaces the saved
          // tracks; volume and loop alone only adjust the saved ones.
          const AUDIO = ["audioId", "audioIds", "audios", "audioVolume", "audioLoop"];
          const namesAudio = ["audioId", "audioIds", "audios"].some((key) => input[key] != null);
          // Volume or loop alone cannot reach tracks saved as a list (each
          // entry has its own volume): say so before rendering anything.
          if (!namesAudio && (input.audioVolume != null || input.audioLoop != null) && Array.isArray((current.extras || {}).audios) && current.extras.audios.length) {
            throw new Error(
              "This design's audio is saved as an audios list, so audioVolume and audioLoop alone do nothing. Pass audios again, one entry per track with its own volume and loop.",
            );
          }
          for (const key of design.EXTRA_KEYS) {
            if (AUDIO.includes(key) && namesAudio) continue;
            if ((key === "audioVolume" || key === "audioLoop") && input[key] != null) continue;
            if (input[key] == null && extras[key] != null) call[key] = extras[key];
          }
        }
        // A second clip next to the design keeps the project's frame and the
        // design's length unless the call names its own.
        if (current && !sameDesign && input.asNewClip === true) {
          if (!input.aspectRatio && current.aspectRatio) call.aspectRatio = current.aspectRatio;
          const ex = current.extras || {};
          if (input.durationMs == null && ex.durationMs != null) call.durationMs = ex.durationMs;
        }
        let replacing = null;
        let replacingMerged = [];
        let replacingOldMs = 0;
        if (input.projectId && input.replaceClipId && !sameDesign) {
          const target = projects.getProject(dataRoot, input.projectId);
          if (!target) throw new Error("That project id is not in this workspace. Call jeditor_list_projects for the ids.");
          if (!(target.assets || []).some((a) => a.id === input.replaceClipId)) {
            throw new Error("That id is not a clip in this project. Pass one of the asset ids jeditor_get_project returns for it.");
          }
          replacing = target;
          // The fixed clip keeps the old one's frame and length unless the
          // call names its own, so a fix never flips the project's shape.
          const old = require("./animation-source").readAnimationSource(dataRoot, target.workspaceId, input.replaceClipId) || {};
          // Fields the call leaves out come from the clip's saved source, so
          // a fix sends only what changed ("" drops a field).
          const CODE = ["html", "css", "js", "preset", "presetParams", "colors", "vars", "scenes", "transition", "transitionMs", "audioId", "audioIds", "audios", "audioVolume", "audioLoop"];
          const merged = [];
          // A different preset, or new html, starts over instead.
          const fresh = (input.preset && input.preset !== old.preset) || input.html || input.scenes;
          // Audio is one group: naming any track replaces all saved tracks.
          const namesTrack = ["audioId", "audioIds", "audios"].some((key) => input[key] != null);
          if (!namesTrack && (input.audioVolume != null || input.audioLoop != null) && Array.isArray(old.audios) && old.audios.length) {
            throw new Error(
              "This clip's audio is saved as an audios list, so audioVolume and audioLoop alone do nothing. Pass audios again, one entry per track with its own volume and loop.",
            );
          }
          for (const key of CODE) {
            if (fresh && ["html", "css", "js", "preset", "presetParams", "colors", "vars", "scenes", "transition", "transitionMs"].includes(key)) continue;
            // A scene clip fixed with one preset or html becomes that one beat.
            if ((input.preset || input.html) && ["scenes", "transition", "transitionMs"].includes(key)) continue;
            if (namesTrack && ["audioId", "audioIds", "audios"].includes(key)) continue;
            if (input[key] === undefined && old[key] != null) {
              call[key] = old[key];
              merged.push(key);
            }
          }
          // The new clip keeps the old one's name in the library and Finished videos.
          if (!input.name) {
            try {
              const oldItem = await require("./library-io").getLibraryItem(dataRoot, input.replaceClipId, target.workspaceId);
              if (oldItem && oldItem.name) call.name = oldItem.name;
            } catch {
              /* the default name stands */
            }
          }
          if (!fresh && old.preset && input.presetParams && old.presetParams) call.presetParams = Object.assign({}, old.presetParams, input.presetParams);
          if (!fresh && old.preset && input.colors && old.colors) call.colors = Object.assign({}, old.colors, input.colors);
          replacingOldMs = Number(old.durationMs) || 0;
          replacingMerged = merged;
          if (!input.aspectRatio) call.aspectRatio = old.aspectRatio || target.aspectRatio || call.aspectRatio;
          if (input.durationMs == null && old.durationMs && !call.scenes) call.durationMs = old.durationMs;
          if (input.fps == null && old.fps) call.fps = old.fps;
        }
        let result;
        try {
          result = await renderAnimation(call);
        } catch (error) {
          throw renderFailure(error, "Check the html, css and js render as stills with jeditor_animation_frames, then try again.");
        }
        // From here the clip is in the library and the project: a failure
        // still refreshes the window.
        try {
        if (replacing && result && result.item && result.item.id === input.replaceClipId) {
          result.note = "The render matched clip " + input.replaceClipId + " exactly, so nothing changed. Change the code to fix it. " + (result.note || "");
        }
        // replaceClipId: a fixed or changed version of any clip takes that
        // clip's place instead of joining the project as a second one.
        if (!sameDesign && input.projectId && input.replaceClipId && result && result.item && input.replaceClipId !== result.item.id) {
          const { registerClipAsRender } = require("./video-render");
          let registered = false;
          // A clip with timeline edits is not the finished video by itself:
          // the project render applies them. Read now, after the render.
          const hadEdits = design.clipHasEdits(projects.getProject(dataRoot, input.projectId), input.replaceClipId);
          result.project = await design.swapClip(dataRoot, input.projectId, input.replaceClipId, result.item.id, null, { moveEdits: true });
          if (!hadEdits) try {
            await registerClipAsRender(dataRoot, {
              projectId: input.projectId,
              sourceId: result.item.id,
              file: result.path,
              name: result.item.name,
              width: result.width,
              height: result.height,
              durationMs: result.durationMs,
              posterMs: Math.round((result.durationMs || 0) * 0.75),
            });
            registered = true;
          } catch {
            /* the swap still happens */
          }
          if (registered) result.project = projects.getProject(dataRoot, input.projectId) || result.project;
          const moved = hadEdits;
          const rest = String(result.note || "").replace(/\s*The animation is in Videos and images as footage\.\s*Render the project with jeditor_render_project[^.]*\.?/g, "");
          result.note =
            "This replaced clip " + input.replaceClipId + " in the project (the person can go back with Previous version in the editor)" +
            (replacingMerged.length ? " (kept from its saved source: " + replacingMerged.join(", ") + ")" : "") +
            (moved
              ? ". Its timeline edits moved to the new clip, so render the project with jeditor_render_project to apply them. " +
                (replacingOldMs && result.durationMs && Math.abs(result.durationMs - replacingOldMs) > 50
                  ? "The length changed from " + replacingOldMs + " ms to " + result.durationMs + " ms: check that cuts and caption times still fit (jeditor_get_project). "
                  : "")
              : registered
                ? " and is the project's finished video now (no jeditor_render_project needed). "
                : ". Render the project with jeditor_render_project. ") +
            rest;
        }
        if (current && !sameDesign && result && input.asNewClip !== true && !input.replaceClipId) {
          result.note =
            "The project's " + current.preset + " design clip was kept, so the project now has two clips. To change the design in place, pass preset \"" + current.preset + "\" without html. " +
            (result.note || "");
        }
        if (sameDesign && result && result.item) {
          // The new clip is the finished cut: it becomes the project's
          // finished video right away, so Export never goes empty between
          // the swap and a separate project render.
          const { registerClipAsRender } = require("./video-render");
          let registered = false;
          // Cuts or captions on the design clip move to the new one, and only
          // a project render bakes them in.
          const designEdits = design.clipHasEdits(projects.getProject(dataRoot, input.projectId), current.assetId);
          if (!designEdits) try {
            await registerClipAsRender(dataRoot, {
              projectId: input.projectId,
              sourceId: result.item.id,
              file: result.path,
              name: result.item.name,
              width: result.width,
              height: result.height,
              durationMs: result.durationMs,
              posterMs: Math.round((result.durationMs || 0) * 0.75),
            });
            registered = true;
          } catch {
            /* the swap still happens; a project render can add the finished video */
          }
          const extras = {};
          for (const key of design.EXTRA_KEYS) if (call[key] != null) extras[key] = call[key];
          // What was actually rendered, after clamping, not what was asked.
          if (extras.durationMs != null && result.durationMs) extras.durationMs = result.durationMs;
          if (extras.fps != null && result.fps) extras.fps = result.fps;
          result.project = await design.adoptDesign(dataRoot, input.projectId, {
            preset: input.preset,
            params: call.presetParams,
            colors: call.colors,
            aspectRatio: result.aspectRatio || current.aspectRatio,
            css: typeof call.css === "string" ? call.css : "",
            js: typeof call.js === "string" ? call.js : "",
            extras,
            assetId: result.item.id,
          });
          result.note =
            errorNoteFor(result.scriptErrors) +
            "This replaced the project's earlier clip of the " + input.preset + " design" +
            (registered
              ? " and is already the project's finished video (no jeditor_render_project needed unless you edit the timeline)."
              : designEdits
                ? ". Its cuts and captions moved to the new clip; render the project with jeditor_render_project to bake them in."
                : ". Render the project with jeditor_render_project so it has a finished video again.") +
            " The saved design (params, colors, css, js, length, audio) now matches this render, so Edit design in JV shows it.";
        }
        return result && result.scriptErrors && result.scriptErrors.length ? scriptErrorResult(result) : result;
        } catch (error) {
          if (error && typeof error === "object") error.saved = true;
          throw error;
        }
      },
    },
    {
      name: "jeditor_animation_presets",
      description:
        "List the ready-made code animations with what each is for and its params; pass name to get that preset's html, css, and js ready to change. Use it to start from a design instead of a blank page. Read code-animation for the motion kit.",
      inputSchema: obj(
        {
          name: { type: "string", description: "Preset name, from the list this tool returns without one. Gets that preset's code back.", enum: require("./animation-presets").PRESET_NAMES },
          params: { type: "object", description: "With name: the preset's params, filled into the code." },
          durationMs: { type: "number", description: "With name: the length you will render, so the code's exits and pacing land on it. Each preset has a minMs.", minimum: 200, maximum: 60000 },
        },
        [],
      ),
      async run(_ctx, input) {
        const { listPresets, buildPreset } = require("./animation-presets");
        if (input && input.name) {
          const code = buildPreset(input.name, input.params, { durationMs: input.durationMs });
          return Object.assign(code, {
            note: "Render with the same durationMs (" + code.durationMs + "). The code's timing is fixed to it; if you change the length, get the code again with the new durationMs.",
          });
        }
        return { presets: listPresets() };
      },
    },
    {
      name: "jeditor_animation_frames",
      description:
        "Look at an animation before rendering it: stills from the same HTML/CSS/JS document at moments in its timeline, with the paths and, with asImage, the frames inline. Use it to check design and motion, fix the code, then render.",
      inputSchema: obj(
        Object.assign(animationCodeProps(), {
          timesMs: {
            type: "array",
            items: { type: "number" },
            description: "Milliseconds into the animation to capture, up to 8. Defaults to the open, a beat in, near the end, and the last frame.",
            maxItems: 8,
          },
          projectId: { type: "string", description: "For a gallery design: with the same preset, the stills use the saved params, colors, css, and js." },
          asNewClip: { type: "boolean", description: "Previewing a second clip of the design's preset (one you will render with asNewClip): skip the saved design." },
          asImage: { type: "boolean", description: "Also return each still inline as an image, so you can see it." },
        }),
        [],
      ),
      async run({ dataRoot, appRoot }, input) {
        const { animationFrames } = require("./animation-render");
        // maxFrames is for JV's own previews; agents get the usual 8 stills.
        const call = Object.assign({}, input, { dataRoot, appRoot, maxFrames: undefined });
        let designMismatch = "";
        // A look at the project's gallery design starts from the saved design,
        // so the stills match what the project renders.
        if (input.projectId && input.preset && !input.html && input.asNewClip === true) {
          const current = require("./project-design").liveDesign(projects.getProject(dataRoot, input.projectId));
          if (current && !input.aspectRatio && current.aspectRatio) call.aspectRatio = current.aspectRatio;
        } else if (input.projectId && input.preset && !input.html) {
          const design = require("./project-design");
          const current = design.liveDesign(projects.getProject(dataRoot, input.projectId));
          if (current && current.preset === input.preset) {
            call.presetParams = Object.assign({}, current.params, input.presetParams || {});
            call.colors = Object.assign({}, current.colors, input.colors || {});
            if (input.css == null && current.css) call.css = current.css;
            if (input.js == null && current.js) call.js = current.js;
            if (!input.aspectRatio && current.aspectRatio) call.aspectRatio = current.aspectRatio;
            const extras = current.extras || {};
            if (input.durationMs == null && extras.durationMs != null) call.durationMs = extras.durationMs;
          } else if (current) {
            if (!input.aspectRatio && current.aspectRatio) call.aspectRatio = current.aspectRatio;
            designMismatch = "The project's saved design is " + current.preset + ", not " + input.preset + ", so these stills use " + input.preset + " defaults. ";
          }
        }
        const result = await animationFrames(call);
        if (designMismatch) result.note = designMismatch + (result.note || "");
        const broken = Boolean(result.scriptErrors && result.scriptErrors.length);
        if (input.asImage !== true) return broken ? scriptErrorResult(result) : result;
        const info = { files: result.files.map((file) => file.path), timesMs: result.timesMs, width: result.width, height: result.height, durationMs: result.durationMs, scriptErrors: result.scriptErrors || [], note: result.note };
        return {
          content: [
            { type: "text", text: JSON.stringify(info) },
            ...result.files.map((file) => ({
              type: "image",
              data: fs.readFileSync(file.path).toString("base64"),
              mimeType: "image/png",
            })),
          ],
          isError: broken,
        };
      },
    },
    {
      name: "jeditor_export_project",
      description:
        "Export a project to a folder: project.json, copies of its media, the cards, and agent-activity.json with which agent made each edit. Use it to hand the project to someone else; finishedId adds the render.",
      inputSchema: obj(
        {
          projectId: PROJECT_ID,
          destDir: { type: "string", description: "Absolute folder. Defaults to the JV data folder under exports." },
          finishedId: { type: "string", description: "Also copy this render into the folder." },
        },
        ["projectId"],
      ),
      async run({ dataRoot }, input) {
        return exportProjectBundle(dataRoot, input);
      },
    },
    {
      name: "jeditor_get_skill",
      description:
        "Read one JV skill's SKILL.md by name. Use it before editing anything: the matching skill holds the design, motion, audio, and render rules for that job. jeditor_list_skills gives the names.",
      inputSchema: obj({ name: { type: "string", description: "Skill name from jeditor_list_skills." } }, ["name"]),
      validate(input) {
        if (!String((input && input.name) || "").trim()) throw new Error("Pass name: jeditor_list_skills lists the skill names.");
      },
      async run({ appRoot, dataRoot }, input) {
        const { findSkill, discoverSkills } = require("./skills");
        const wanted = String(input.name || "").trim();
        const skill = findSkill(appRoot, wanted, { dataRoot });
        if (!skill) {
          let names = [];
          try {
            names = discoverSkills(appRoot, { dataRoot }).map((entry) => entry.name);
          } catch {
            names = [];
          }
          const near = closestNames(wanted, names, 4);
          throw new Error(
            (wanted ? "No skill is named \"" + wanted + "\". " : "Pass name: no skill was named. ") +
              (near.length ? "Closest: " + near.join(", ") + ". " : "") +
              "jeditor_list_skills lists them all.",
          );
        }
        return {
          name: skill.name,
          description: skill.description,
          path: skill.path,
          source: skill.source,
          body: skill.body,
        };
      },
    },
    {
      name: "jeditor_set_card_html",
      description:
        "Write a card's design: html structure, css styling with keyframes, color vars, library images, placement and length. Use it for a card that floats on footage (overlay) or opens and closes the video (title_card), then check it before composing.",
      inputSchema: obj(
        {
          cardId: { type: "string", description: "Existing card id. Omit to create a new card." },
          html: { type: "string", description: "Body markup. Use {{image:id}} for a library image. Scripts are stripped." },
          css: { type: "string", description: "Stylesheet. var(--primary), var(--secondary), var(--text) and any vars reach it; keyframes animate when the card is composed." },
          vars: { type: "object", description: "Extra CSS variables, e.g. {accent: '#DFF56A'} becomes var(--accent)." },
          colors: { type: "object", description: "{primary, secondary, text} hex colors." },
          placement: { type: "string", enum: ["auto", "intro", "overlay", "end"], description: "Where the card belongs in the cut. Default auto." },
          durationMs: { type: "number", description: "How long the card shows in ms.", minimum: 500, maximum: 60000 },
          kind: { type: "string", enum: ["title_card", "overlay"], description: "title_card for intro and end, overlay to float on footage." },
          aspectRatio: { type: "string", enum: ["vertical", "landscape", "square"], description: "Card frame: vertical 9/16, landscape 16/9, or square 1/1." },
          motion: {
            type: "object",
            description: "{in, out} presets for how the card enters and leaves the frame.",
            properties: {
              in: { type: "string", enum: ["none", "fade", "rise", "drop", "slide", "pop"], description: "Entry preset." },
              out: { type: "string", enum: ["none", "fade", "rise", "drop", "slide", "pop"], description: "Exit preset." },
            },
          },
          name: { type: "string", description: "Card name the person sees." },
          description: { type: "string", description: "What the card is for, in one line." },
          why: { type: "string", description: "Why this design suits the footage, for the person to read." },
          workspaceId: WS,
        },
        [],
      ),
      mutates: true,
      async run({ dataRoot }, input) {
        const patch = {};
        for (const key of ["name", "description", "why", "placement", "durationMs", "kind", "motion", "colors"]) {
          if (input[key] !== undefined) patch[key] = input[key];
        }
        const composition = {};
        for (const key of ["html", "css", "vars", "aspectRatio"]) {
          if (input[key] !== undefined) composition[key] = input[key];
        }
        if (Object.keys(composition).length) patch.composition = composition;
        if (!Object.keys(patch).length) throw new Error("Pass html, css, placement, durationMs, kind, motion, colors, name or description: nothing was changed.");
        const result = await applyCardEdit({
          dataRoot,
          workspaceId: input.workspaceId,
          cardId: input.cardId,
          patch,
        });
        return { card: result.card, created: result.created, workspaceId: result.snapshot.workspace.id };
      },
    },
    {
      name: "jeditor_export_card",
      description:
        "Export a card as a PNG of the exact design the video pipeline burns, or as a self-contained HTML file that opens in any browser. Use it when the person wants the card as a file.",
      inputSchema: obj(
        {
          cardId: CARD_ID,
          destPath: { type: "string", description: "Absolute file or folder path. A folder gets the card's name and extension." },
          format: { type: "string", enum: ["png", "html"], description: "png (default) for an image, html for a document." },
          workspaceId: WS,
        },
        ["cardId", "destPath"],
      ),
      async run({ dataRoot, appRoot }, input) {
        const wsId = await activeId(dataRoot, input.workspaceId);
        const ws = await loadWorkspace(dataRoot, wsId);
        const card = (ws.cards || []).find((entry) => entry.id === input.cardId);
        if (!card) throw new Error("That card id does not exist. jeditor_list_cards lists the card ids.");
        let dest = path.resolve(String(input.destPath));
        if (fs.existsSync(dest) && fs.statSync(dest).isDirectory()) {
          dest = path.join(dest, safeName(card.name, "card"));
        }
        const format = String(input.format || "png").toLowerCase();
        if (format === "html") {
          if (!dest.toLowerCase().endsWith(".html")) dest += ".html";
          const { buildCardDocument } = require("./html-card");
          const { htmlCardDataUris } = require("./card-render");
          const imageDataUris = await htmlCardDataUris(card, dataRoot, wsId);
          const doc = buildCardDocument(card, { imageDataUris, transparent: false });
          await fsp.mkdir(path.dirname(dest), { recursive: true });
          await fsp.writeFile(dest, doc, "utf8");
          return { path: dest, format: "html" };
        }
        if (format !== "png") throw new Error("Pass format png for an image, or html for a document that opens in a browser.");
        if (!dest.toLowerCase().endsWith(".png")) dest += ".png";
        const { renderCardPng, findFfmpeg, findFont } = require("./card-render");
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        let rendered;
        try {
          rendered = await renderCardPng({
            dataRoot,
            workspaceId: wsId,
            card,
            outPath: dest,
            ffmpeg: findFfmpeg(),
            font: findFont(),
            appRoot,
          });
        } catch (error) {
          throw renderFailure(error, "Check the card's images are still in the library, then try again.");
        }
        return { path: rendered.path, width: rendered.width, height: rendered.height, format: "png" };
      },
    },
    {
      name: "jeditor_elevenlabs_setup",
      description:
        "Set up ElevenLabs text to speech: save an API key once, clear it, or check the saved key, with probe:true to verify it against the account. Use it before the first voiceover or music call.",
      inputSchema: obj({
        apiKey: { type: "string", description: "ElevenLabs API key to save into the app's data folder. Never put it in a repo." },
        clear: { type: "boolean", description: "Remove the saved key." },
        probe: { type: "boolean", description: "Verify the key against the account and report usage." },
      }),
      mutates: true,
      async run({ dataRoot }, input) {
        const el = require("./elevenlabs");
        if (input.clear === true) return el.clearKey(dataRoot);
        if (input.apiKey != null) {
          const saved = await el.saveKey(dataRoot, input.apiKey);
          if (input.probe) return Object.assign(saved, await el.testKey(dataRoot));
          return saved;
        }
        const cfg = await el.readConfig(dataRoot);
        if (!cfg.apiKey) return { configured: false, hint: "Pass apiKey here or set ELEVENLABS_API_KEY." };
        const status = { configured: true, source: cfg.source, keyTail: cfg.keyTail };
        if (input.probe) return Object.assign(status, await el.testKey(dataRoot));
        return status;
      },
    },
    {
      name: "jeditor_elevenlabs_voices",
      description: "List the ElevenLabs voices on the saved key: id, name, category. Use it to pick a voiceId before jeditor_tts. Needs a key (jeditor_elevenlabs_setup).",
      inputSchema: obj({}),
      async run({ dataRoot }) {
        return require("./elevenlabs").listVoices(dataRoot);
      },
    },
  ];
}

// Every ElevenLabs call goes through here, so the user's access mode is
// honoured whichever tool asked: the one-shot replace path must not be a way
// around the approval that jeditor_tts asks for. UI calls (no client tag) are
// the user approving directly.
async function assertElevenLabsAgentAccess(ctx, label) {
  const { dataRoot, client, meta } = ctx;
  const isAgentCall = Boolean(client || (meta && (meta.client || meta.harness || meta.sessionId)));
  if (!isAgentCall) return;
  const el = require("./elevenlabs");
  const cfg = await el.readConfig(dataRoot);
  if (cfg.agentAccess === "never") {
    throw new Error("ElevenLabs " + label + "s are turned off for agents. Ask the person to allow them in Settings > Voice and music, then try again.");
  }
  if (cfg.agentAccess !== "always") {
    const scope = (meta && (meta.projectId || meta.workspaceId || meta.sessionId)) || "";
    if (!el.consumeTtsGrant(scope)) {
      throw new Error("This " + label + " needs the person's approval in JV first. Run it while the app is open, then let them answer the prompt.");
    }
  }
}

// Save generated audio (speech or music) into the library, fill in its
// duration, and link it to a video when one was named.
async function ingestGeneratedAudio(dataRoot, input) {
  const wsId = await activeId(dataRoot, input.workspaceId);
  const added = await copyPathIntoLibrary(dataRoot, input.path, {
    workspaceId: wsId,
    name: input.name || "Audio",
    mime: "audio/mpeg",
    source: "agent",
  });
  const item = added.item;
  if (item && item.kind === "audio") {
    let durationMs = 0;
    if (!item.durationMs) {
      try {
        const { findFfmpeg, probeMedia } = require("./card-render");
        const media = await probeMedia(findFfmpeg(), libraryFilePath(dataRoot, wsId, item));
        durationMs = (media && media.durationMs) || 0;
      } catch {
        /* duration is best effort */
      }
    }
    // The description (a voiceover's script) is saved even when the probe
    // fails: captions read the words from it.
    if (durationMs || input.description) {
      const ws = await loadWorkspace(dataRoot, wsId);
      const row = ws.library.find((entry) => entry.id === item.id);
      if (row) {
        if (durationMs) row.durationMs = durationMs;
        if (input.description) row.description = input.description;
        await saveWorkspace(dataRoot, ws);
        if (durationMs) item.durationMs = durationMs;
        if (input.description) item.description = input.description;
      }
    }
  }
  let link = null;
  if (input.videoId && item) {
    const ws = await loadWorkspace(dataRoot, wsId);
    if (ws.library.some((entry) => entry.id === input.videoId) && ws.library.some((entry) => entry.id === item.id)) {
      const existing = ws.links.find((l) => l.refs.includes(input.videoId) && l.refs.includes(item.id));
      link = existing || { id: randomUUID(), refs: [input.videoId, item.id], createdAt: new Date().toISOString() };
      if (!existing) {
        ws.links.push(link);
        await saveWorkspace(dataRoot, ws);
      }
    }
  }
  return { item, linkedTo: link ? input.videoId : "" };
}

async function synthesizeVoiceover(ctx, input) {
  const { dataRoot } = ctx;
  // A narrated explainer is several lines: one approval covers the script,
  // and each line becomes its own audio item to place on its scene.
  if (Array.isArray(input.lines) && input.lines.length) {
    // The approval is used first, so a call that is then refused can never
    // leave an unused yes behind for a later call.
    await assertElevenLabsAgentAccess(ctx, "voiceover");
    const lines = input.lines
      .map((l, index) => Object.assign({ index }, typeof l === "string" ? { text: l } : l || {}))
      .filter((l) => String(l.text || "").trim());
    if (!lines.length) throw new Error("Pass lines with text, or text for one take: every line was empty.");
    if (lines.length > 12) throw new Error("Split the script: lines holds at most 12 lines per call.");
    const long = lines.find((l) => String(l.text).length > 600);
    if (long) throw new Error("Line " + (long.index + 1) + " is over 600 characters. Split it into two lines and pass both.");
    const base = String(input.name || "Voiceover").trim() || "Voiceover";
    const out = [];
    const failed = [];
    let aborted = "";
    for (const line of lines) {
      const n = line.index + 1;
      const one = Object.assign({}, input, { text: String(line.text).trim(), name: line.name || base + " line " + n, lines: undefined });
      let speech = null;
      try {
        speech = await require("./elevenlabs").synthesize(dataRoot, one);
        const ingested = await ingestGeneratedAudio(dataRoot, {
          path: speech.path,
          name: one.name,
          description: "ElevenLabs voice " + speech.voiceId + " (" + speech.model + "). Script: " + one.text.replace(/\s+/g, " ").slice(0, 4000),
          videoId: input.videoId,
          workspaceId: input.workspaceId,
        });
        out.push({ line: n, scene: line.scene || n, item: ingested.item, durationMs: (ingested.item && ingested.item.durationMs) || 0 });
      } catch (error) {
        // The first line failing means nothing was made: a plain error.
        if (!out.length && !failed.length && line === lines[lines.length - 1]) throw error;
        const message = String((error && error.message) || error);
        failed.push({ line: n, scene: line.scene || n, text: one.text, error: message });
        // 429 can be a passing busy limit, so only a refused account stops the rest.
        if (/\b(401|402|403)\b|quota|credits|unauthori[sz]ed|api key/i.test(message)) {
          aborted = message;
          for (const rest of lines.slice(lines.indexOf(line) + 1)) failed.push({ line: rest.index + 1, scene: rest.scene || rest.index + 1, text: String(rest.text).trim(), error: "not tried: " + message });
          break;
        }
      } finally {
        if (speech && speech.path) fsp.unlink(speech.path).catch(() => {});
      }
    }
    if (!out.length) {
      throw new Error(
        aborted
          ? "ElevenLabs refused the account, so no line was made. Do not retry: ask the person to check the key or credits in Settings > Voice and music."
          : "No line was made: " + failed.map((f) => "line " + f.line + ": " + f.error).join("; ").slice(0, 200) + ". Fix the text and call jeditor_tts again.",
      );
    }
    return {
      items: out,
      failed,
      aborted: Boolean(aborted),
      audios: out.map((o) => ({ audioId: o.item && o.item.id, scene: o.scene })),
      note: aborted
        ? "ElevenLabs refused the account (" + aborted + "). Do not retry: tell the person to check the key or credits on the ElevenLabs page. The " + out.length + " finished line(s) are saved in audios."
        : failed.length
          ? failed.length + " line(s) failed (see failed). Do not render yet: call jeditor_tts again with lines holding only the failed ones, each with its scene (the person approves once more), then merge both audios lists and render."
          : "Pass audios to jeditor_render_animation with the same scenes; each line starts with its scene.",
    };
  }
  if (!String(input.text || "").trim()) throw new Error("Pass text for one take, or lines with one entry per scene.");
  await assertElevenLabsAgentAccess(ctx, "voiceover");
  const speech = await require("./elevenlabs").synthesize(dataRoot, input);
  try {
    const ingested = await ingestGeneratedAudio(dataRoot, {
      path: speech.path,
      name: input.name || "Voiceover",
      // The script rides on the item so captions can use the exact words later.
      description: "ElevenLabs voice " + speech.voiceId + " (" + speech.model + "). Script: " + String(input.text || "").replace(/\s+/g, " ").trim().slice(0, 4000),
      videoId: input.videoId,
      workspaceId: input.workspaceId,
    });
    return {
      item: ingested.item,
      voiceId: speech.voiceId,
      model: speech.model,
      bytes: speech.bytes,
      linkedTo: ingested.linkedTo,
    };
  } finally {
    fsp.unlink(speech.path).catch(() => {});
  }
}

// Generate a music bed and save it as a library audio item. Same gate and
// library path as a voiceover, so a bed is attached with the ordinary sound
// op on the music track.
async function generateMusicBed(ctx, input) {
  const { dataRoot } = ctx;
  await assertElevenLabsAgentAccess(ctx, "music track");
  const el = require("./elevenlabs");
  const track = await el.composeMusic(dataRoot, input);
  try {
    const ingested = await ingestGeneratedAudio(dataRoot, {
      path: track.path,
      name: input.name || "Music",
      description: "ElevenLabs music " + track.model + (track.instrumental ? " (instrumental)" : ""),
      videoId: input.videoId,
      workspaceId: input.workspaceId,
    });
    return {
      item: ingested.item,
      model: track.model,
      bytes: track.bytes,
      prompt: track.prompt,
      lengthMs: track.lengthMs,
      instrumental: track.instrumental,
      linkedTo: ingested.linkedTo,
    };
  } finally {
    fsp.unlink(track.path).catch(() => {});
  }
}

// The file behind whatever the agent asked about, for jeditor_probe_audio.
async function resolveAudioTarget(dataRoot, input) {
  const { loadState } = require("./workspace-store");
  const state = await loadState(dataRoot);
  const workspaceId = input.workspaceId || state.activeWorkspaceId;
  if (input.finishedId) {
    const { getFinishedItem } = require("./finished-io");
    const item = await getFinishedItem(dataRoot, input.finishedId, workspaceId);
    if (!item) throw new Error("That finished video id does not exist in this workspace. jeditor_snapshot lists the finished ids.");
    return { file: libraryFilePath(dataRoot, item.workspaceId || workspaceId, item), item, kind: "finished" };
  }
  if (input.projectId) {
    const { timelineContextForAudio } = require("./video-render");
    const ctx = await timelineContextForAudio(dataRoot, input.projectId, input.videoId);
    return { file: ctx.file, item: ctx.item, kind: "project", projectId: ctx.project.id, stale: Boolean(ctx.stale) };
  }
  if (input.libraryId) {
    const { getLibraryItem } = require("./library-io");
    const item = await getLibraryItem(dataRoot, input.libraryId, workspaceId);
    if (!item) throw new Error("That library item id is not in this workspace. jeditor_snapshot lists the library ids.");
    return { file: libraryFilePath(dataRoot, workspaceId, item), item, kind: "library" };
  }
  if (input.path) return { file: String(input.path), item: null, kind: "path" };
  throw new Error("Pass projectId, libraryId, finishedId, or path: one of them names the audio to read.");
}

function audioToolSpecs() {
  return [
    {
      name: "jeditor_probe_audio",
      description:
        "Measure what a clip, a render, or an audio file sounds like: stream present, duration, codec, channels, mean and peak dBFS, headroom, clipping, and silent stretches. Use it before deciding on sound and after a render to check the result.",
      inputSchema: obj({
        projectId: { type: "string", description: "Read the project's clip: its render when one exists, else the source." },
        videoId: { type: "string", description: "With projectId: a specific clip. Defaults to the clip on the timeline." },
        libraryId: { type: "string", description: "Any library item, video or audio." },
        finishedId: { type: "string", description: "A finished video or render." },
        path: { type: "string", description: "An absolute file path on this computer." },
        noiseDbfs: { type: "number", description: "Silence floor in dB. Lower finds quieter gaps.", minimum: -90, maximum: -10, default: -50 },
        workspaceId: WS,
      }),
      async run({ dataRoot }, input) {
        const { probeAudio, audioSummary } = require("./audio-probe");
        const target = await resolveAudioTarget(dataRoot, input);
        const probe = await probeAudio(
          findBin(),
          target.file,
          { noiseDbfs: input.noiseDbfs },
        );
        return Object.assign({}, probe, {
          target: target.kind,
          itemId: target.item ? target.item.id : "",
          name: target.item ? target.item.name : "",
          summary: audioSummary(probe),
        }, target.stale
          ? { stale: true, note: "This is the project's last render, made before the latest edits, so any sound edits since then are not in it. Run jeditor_render_project, then probe again if you changed sound." }
          : {});
      },
    },
    {
      name: "jeditor_replace_audio",
      description:
        "Replace a project clip's audio in one call: generate the voiceover from script (or use audioId), mute the original, attach the new track, and render. Use it for 'strip the audio and narrate it'. Needs the same user approval as jeditor_tts.",
      inputSchema: obj(
        {
          projectId: PROJECT_ID,
          videoId: VIDEO_ID,
          script: { type: "string", description: "The narration to generate. Up to 5000 characters. Omit when you pass audioId." },
          audioId: { type: "string", description: "Use this library track instead of generating speech." },
          voiceId: { type: "string", description: "ElevenLabs voice id. Defaults to the user's saved pick." },
          voiceName: { type: "string", description: "Voice name to look up instead of voiceId." },
          model: { type: "string", description: "ElevenLabs model id. Defaults to the user's saved pick." },
          stability: { type: "number", description: "How steady the read is. Lower is more expressive.", minimum: 0, maximum: 1 },
          similarity: { type: "number", description: "How close to the original voice. Higher sticks closer.", minimum: 0, maximum: 1 },
          style: { type: "number", description: "How much style exaggeration. Higher is more dramatic.", minimum: 0, maximum: 1 },
          speed: { type: "number", description: "Speech rate.", minimum: 0.7, maximum: 1.2 },
          name: { type: "string", description: "Name for the generated voiceover item, and the render unless renderName is set." },
          track: { type: "string", enum: ["voice", "music"], description: "Which layer to replace. Default voice." },
          muteSource: { type: "boolean", description: "Remove the clip's own audio, which is what replacing the audio means. Default true." },
          duck: AUDIO_DUCK,
          volume: AUDIO_VOLUME,
          loop: AUDIO_LOOP,
          render: { type: "boolean", description: "Render the result right away. Default true." },
          renderName: { type: "string", description: "Name for the render. Defaults to name." },
          workspaceId: WS,
        },
        ["projectId"],
      ),
      mutates: true,
      needsApproval: true,
      validate(input) {
        if (!String(input.audioId || "").trim() && !String(input.script || "").trim()) {
          throw new Error("Pass script (the narration to generate) or audioId (an existing track).");
        }
      },
      async run(ctx, input) {
        const { dataRoot } = ctx;
        const script = String(input.script || input.text || "").trim();
        let audioId = String(input.audioId || "").trim();
        let voiceover = null;
        if (!audioId) {
          if (!script) throw new Error("Pass script (narration to generate) or audioId (an existing track).");
          voiceover = await synthesizeVoiceover(ctx, {
            text: script,
            voiceId: input.voiceId,
            voiceName: input.voiceName,
            model: input.model,
            stability: input.stability,
            similarity: input.similarity,
            style: input.style,
            speed: input.speed,
            name: input.name || "Voiceover",
            workspaceId: input.workspaceId,
          });
          audioId = voiceover.item.id;
        }
        const { editProjectTimeline, renderProjectVideo } = require("./video-render");
        const ops = [{ type: "sound", audioId, track: input.track || "voice", volume: input.volume, duck: input.duck }];
        if (input.loop === true) ops[0].loop = true;
        if (input.muteSource !== false) ops.unshift({ type: "audio", muted: true });
        else if (input.duck != null) ops.unshift({ type: "audio", volume: input.duck });
        const timeline = await editProjectTimeline(dataRoot, {
          projectId: input.projectId,
          videoId: input.videoId,
          ops,
        });
        const result = {
          audioId,
          track: input.track || "voice",
          generated: voiceover ? voiceover.item : null,
          voiceId: voiceover ? voiceover.voiceId : "",
          sourceMuted: input.muteSource !== false,
          timeline,
        };
        if (input.render !== false) {
          result.render = await renderProjectVideo(dataRoot, {
            projectId: input.projectId,
            videoId: input.videoId,
            name: input.renderName || input.name || undefined,
          });
        }
        return result;
      },
    },
    {
      name: "jeditor_set_audio",
      description:
        "Attach one audio layer to a project clip without rendering: a voiceover or a music bed. An empty audioId clears that layer, and both layers can play at once. Use it, then render with jeditor_render_project.",
      inputSchema: obj(
        {
          projectId: PROJECT_ID,
          videoId: VIDEO_ID,
          audioId: { type: "string", description: "Library audio item id. An empty string clears this layer." },
          track: { type: "string", enum: ["voice", "music"], description: "Which layer to set. Default voice." },
          volume: AUDIO_VOLUME,
          loop: AUDIO_LOOP,
          duck: AUDIO_DUCK,
        },
        ["projectId", "audioId"],
      ),
      mutates: true,
      async run({ dataRoot }, input) {
        const { editProjectTimeline } = require("./video-render");
        return editProjectTimeline(dataRoot, {
          projectId: input.projectId,
          videoId: input.videoId,
          ops: [
            {
              type: "sound",
              audioId: String(input.audioId == null ? "" : input.audioId),
              track: input.track || "voice",
              volume: input.volume,
              loop: input.loop,
              duck: input.duck,
            },
          ],
        });
      },
    },
    {
      name: "jeditor_mute_audio",
      description:
        "Turn the clip's own audio off or on, for the whole clip or one range. muted:false restores it, and volume sets a level instead of a hard mute. Use it to drop the source sound, or to bring it back.",
      inputSchema: obj(
        {
          projectId: PROJECT_ID,
          videoId: VIDEO_ID,
          muted: { type: "boolean", description: "Mute the source. Default true." },
          volume: { type: "number", description: "Source gain to set instead of a hard mute, 0 to 2. 1 is the original level.", minimum: 0, maximum: 2 },
          start: { type: "number", description: "Range start in source seconds. Omit for the whole clip.", minimum: 0 },
          end: { type: "number", description: "Range end in source seconds.", minimum: 0 },
          fromFrame: { type: "number", description: "Range start as a frame, instead of start.", minimum: 0 },
          toFrame: { type: "number", description: "Range end as a frame, instead of end.", minimum: 0 },
        },
        ["projectId"],
      ),
      mutates: true,
      async run({ dataRoot }, input) {
        const { editProjectTimeline } = require("./video-render");
        const op = { type: "audio", start: input.start, end: input.end, fromFrame: input.fromFrame, toFrame: input.toFrame };
        if (input.volume != null) op.volume = input.volume;
        else op.muted = input.muted !== false;
        return editProjectTimeline(dataRoot, { projectId: input.projectId, videoId: input.videoId, ops: [op] });
      },
    },
    {
      name: "jeditor_clear_audio",
      description:
        "Clear the audio layers saved on a project clip: one layer by name, or both. Use alsoSource to unmute the clip's own audio too, so the clip goes back to its original sound.",
      inputSchema: obj(
        {
          projectId: PROJECT_ID,
          videoId: VIDEO_ID,
          track: { type: "string", enum: ["voice", "music"], description: "Clear only this layer. Omit to clear both." },
          alsoSource: { type: "boolean", description: "Also restore the clip's own audio." },
        },
        ["projectId"],
      ),
      mutates: true,
      async run({ dataRoot }, input) {
        const { editProjectTimeline } = require("./video-render");
        const ops = [{ type: "sound", audioId: "", track: input.track }];
        if (input.track) {
          // A named clear only drops that layer, so ask for it explicitly.
          ops[0].track = input.track;
        } else {
          ops[0].track = "voice";
          ops.push({ type: "sound", audioId: "", track: "music" });
        }
        if (input.alsoSource === true) ops.push({ type: "audio", muted: false, volume: 1 });
        return editProjectTimeline(dataRoot, { projectId: input.projectId, videoId: input.videoId, ops });
      },
    },
  ];
}

function findBin() {
  const { findFfmpeg } = require("./card-render");
  return findFfmpeg();
}

// The id a tool needs, and where that id comes from. Attached in one place so a
// first call without the id answers with a sentence instead of the store's
// "Project id is required."
const REQUIRED_HINTS = {
  projectId: "Pass projectId: jeditor_list_projects lists the project ids.",
  cardId: "Pass cardId: jeditor_list_cards lists the card ids.",
  workspaceId: "Pass workspaceId: jeditor_list_workspaces lists the workspace ids.",
  id: "Pass id: jeditor_snapshot lists the library and finished ids.",
  finishedId: "Pass finishedId: jeditor_snapshot lists the finished ids.",
  libraryId: "Pass libraryId: jeditor_snapshot lists the library ids.",
  assetIds: "Pass assetIds as library item ids, at least one: jeditor_snapshot lists them.",
  destPath: "Pass destPath: the absolute file or folder to write.",
  name: "Pass name: the name to give the new project or workspace.",
};

function withRequiredHints(specs) {
  for (const spec of specs) {
    if (typeof spec.validate === "function") continue;
    const required = (spec.inputSchema && spec.inputSchema.required) || [];
    const keys = required.filter((key) => REQUIRED_HINTS[key]);
    if (!keys.length) continue;
    spec.validate = (input) => {
      for (const key of keys) {
        const value = input && input[key];
        if (value != null && String(value).trim()) continue;
        throw new Error(REQUIRED_HINTS[key]);
      }
    };
  }
  return specs;
}

function agentToolSpecs(options) {
  return withRequiredHints(baseAgentToolSpecs(options).concat(audioToolSpecs(), tailAgentToolSpecs(), require("./slop/check-tool").slopToolSpecs()));
}

function tailAgentToolSpecs() {
  return [
    {
      name: "jeditor_tts",
      description:
        "Generate speech with ElevenLabs into a library audio item: text for one take, or lines ([{text, scene}]) for a whole script under one approval, one item per line. Use it for a voiceover; voice and model default to the user's saved picks.",
      inputSchema: obj(
        {
          text: { type: "string", description: "What to say, up to 5000 characters. Omit when you pass lines." },
          lines: {
            type: "array",
            description: "Several lines in one call and one approval, up to 12, each 600 characters at most. The call returns their items plus audios ready for a scene animation.",
            maxItems: 12,
            items: {
              type: "object",
              properties: {
                text: { type: "string", description: "The line to say." },
                scene: { type: "number", description: "Animation scene this line belongs to, 1 based. Defaults to its position.", minimum: 1, maximum: 8 },
                name: { type: "string", description: "Item name for this line. Defaults to the call name plus the line number." },
              },
              required: ["text"],
            },
          },
          voiceId: { type: "string", description: "ElevenLabs voice id. Defaults to the user's saved pick." },
          voiceName: { type: "string", description: "Voice name to look up instead of voiceId." },
          model: { type: "string", description: "ElevenLabs model id. Defaults to the user's saved pick." },
          stability: { type: "number", description: "How steady the read is. Lower is more expressive.", minimum: 0, maximum: 1 },
          similarity: { type: "number", description: "How close to the original voice. Higher sticks closer.", minimum: 0, maximum: 1 },
          style: { type: "number", description: "How much style exaggeration. Higher is more dramatic.", minimum: 0, maximum: 1 },
          speed: { type: "number", description: "Speech rate.", minimum: 0.7, maximum: 1.2 },
          name: { type: "string", description: "Name for the voiceover item. Defaults to Voiceover." },
          videoId: { type: "string", description: "Library video to link this voiceover to." },
          workspaceId: WS,
        },
        [],
      ),
      mutates: true,
      needsApproval: true,
      validate(input) {
        if (Array.isArray(input.lines) && input.lines.length) {
          const texts = input.lines.map((l) => String(typeof l === "string" ? l : (l && l.text) || ""));
          if (!texts.some((t) => t.trim())) throw new Error("Pass lines with text, or text for one take: every line was empty.");
          if (texts.filter((t) => t.trim()).length > 12) throw new Error("Split the script: lines holds at most 12 lines per call.");
          const long = texts.findIndex((t) => t.length > 600);
          if (long >= 0) throw new Error("Line " + (long + 1) + " is over 600 characters. Split it into two lines and pass both.");
        } else if (!String(input.text || "").trim()) throw new Error("Pass text for one take, or lines with one entry per scene.");
      },
      onRefused(meta, input) {
        const scope = (meta && (meta.projectId || meta.workspaceId || meta.sessionId)) || (input && (input.projectId || input.workspaceId)) || "";
        require("./elevenlabs").consumeTtsGrant(scope);
      },
      async run(ctx, input) {
        return synthesizeVoiceover(ctx, input);
      },
    },
    {
      name: "jeditor_music",
      description:
        "Generate a music bed with ElevenLabs and save it as a library audio item. Use it for background music: prompt says the mood, genre, tempo, and instruments, and instrumental forces no vocals. Attach it with jeditor_set_audio on the music track.",
      inputSchema: obj(
        {
          prompt: { type: "string", description: "What the music should be. Up to 2000 characters." },
          lengthMs: { type: "number", description: "Target length in ms. Omit and the model chooses.", minimum: 3000, maximum: 600000 },
          model: { type: "string", enum: require("./elevenlabs").MUSIC_MODELS, description: "Music model. Default music_v2_5." },
          instrumental: { type: "boolean", description: "Force no vocals." },
          name: { type: "string", description: "Name for the library item. Defaults to Music." },
          videoId: { type: "string", description: "Library video to link this bed to." },
          workspaceId: WS,
        },
        ["prompt"],
      ),
      mutates: true,
      needsApproval: true,
      validate(input) {
        const lengthMs = Number(input.lengthMs);
        if (input.lengthMs != null && (!Number.isFinite(lengthMs) || lengthMs < 3000 || lengthMs > 600000)) {
          throw new Error("Pass lengthMs between 3000 and 600000 milliseconds, or leave it out and the model chooses.");
        }
      },
      async run(ctx, input) {
        return generateMusicBed(ctx, input);
      },
    },
    {
      name: "jeditor_record_note",
      description: "Write a note into the agent activity log: what you changed and why. Use it at the end of a job, so the person and the project export both show the reasoning.",
      inputSchema: obj(
        {
          text: { type: "string", description: "The note." },
          projectId: { type: "string", description: "Project the note belongs to. Omit for a workspace note." },
        },
        ["text"],
      ),
      async run({ dataRoot, client }, input) {
        return recordAction(dataRoot, {
          tool: "note",
          client: client || "",
          projectId: input.projectId || "",
          summary: String(input.text || ""),
          args: {},
        });
      },
    },
    {
      name: "jeditor_activity",
      description: "Read the agent activity log: which agent ran which tool, when, and a summary of the result, newest first. Use it to see what another agent did. Set includeArgs to see the exact call arguments.",
      inputSchema: obj({
        limit: { type: "number", description: "Rows to return. A first look needs a few; read deeper only when the summary is not enough.", minimum: 1, maximum: 500, default: 20 },
        projectId: { type: "string", description: "Only actions on this project." },
        since: { type: "string", description: "Only actions newer than this ISO timestamp, e.g. 2026-01-31T10:00:00Z." },
        includeArgs: {
          type: "boolean",
          description: "Also return each row's tool arguments. Off by default because one row can carry up to 16 KB of arguments.",
          default: false,
        },
      }),
      async run({ dataRoot }, input) {
        const opts = Object.assign({}, input, { limit: input.limit == null ? ACTIVITY_DEFAULT_LIMIT : input.limit });
        const withArgs = input.includeArgs === true;
        const actions = listActions(dataRoot, opts).map((row) => {
          // Session and workspace ids are storage details; the row already says
          // which agent and project it belongs to.
          const out = {
            id: row.id,
            at: row.at,
            tool: row.tool,
            client: row.client,
            projectId: row.projectId,
            ok: row.ok,
            summary: row.summary,
            durationMs: row.durationMs,
          };
          if (withArgs) out.args = row.args;
          return out;
        });
        return { actions };
      },
    },
    {
      name: "jeditor_read_chat",
      description:
        "Read a chat transcript: messages, replies, tool calls with their input and output, and agent switches, each with a row number. Use it after a handoff to see what the previous agent did; page back with before.",
      inputSchema: obj({
        chatId: { type: "string", description: "Chat id. Defaults to the chat this session belongs to." },
        before: { type: "number", description: "Return rows with a smaller row number than this. Take the before value from the last result to page back." },
        limit: { type: "number", description: "Rows per page. A first look needs a few; read deeper only when the summary is not enough.", minimum: 1, maximum: 200, default: 20 },
        row: { type: "number", description: "Return this one row in full instead of a page.", minimum: 0 },
        query: { type: "string", description: "Only rows whose text, tool title, input, or output contains this." },
        includeThoughts: { type: "boolean", description: "Include the agents' thinking rows. Default false." },
      }),
      async run({ dataRoot, meta }, input) {
        const chatId = String(input.chatId || (meta && meta.chatId) || "").trim();
        if (!chatId) throw new Error("Pass chatId: this session is not bound to a chat. Use the id JV shows for the chat you want to read.");
        const { getChat } = require("./editor-chats");
        const { readChatRows } = require("./acp-handoff");
        const read = Object.assign({}, input, { limit: input.limit == null ? CHAT_DEFAULT_LIMIT : input.limit });
        return readChatRows(getChat(dataRoot, chatId), read);
      },
    },
    {
      name: "jeditor_get_user_instructions",
      description:
        "Read the user's standing instructions, the text sent with every AI message. Use it before proposing a change with jeditor_update_user_instructions, which the user must approve.",
      inputSchema: obj({}),
      async run({ dataRoot }) {
        const { readUserInstructions, MAX_INSTRUCTIONS_LENGTH } = require("./user-instructions");
        return { text: await readUserInstructions(dataRoot), maxLength: MAX_INSTRUCTIONS_LENGTH };
      },
    },
    {
      name: "jeditor_update_user_instructions",
      description:
        "Propose a replacement for the user's standing instructions, sent with every AI message from then on. Use it when the person asks to change them; the user approves it in JV, you cannot apply it alone. Never include secrets.",
      inputSchema: obj(
        { text: { type: "string", description: "Full replacement text, up to 32,000 characters." } },
        ["text"],
      ),
      needsApproval: true,
      async run(ctx, input) {
        // The user approves through the app (chat permission card for in-app
        // agents, dialog for outside ones); the approval drops a single-use
        // grant this call consumes. No grant, no write — the agent can never
        // change the instructions by itself.
        const { meta } = ctx;
        const scope = (meta && (meta.projectId || meta.workspaceId || meta.sessionId)) || "";
        const { consumeInstructionsApproval, writeUserInstructions, MAX_INSTRUCTIONS_LENGTH } = require("./user-instructions");
        if (!consumeInstructionsApproval(scope)) {
          throw new Error(
            "Updating the instructions needs the person's approval in JV. Run this while the app is open, then let them answer the prompt.",
          );
        }
        const text = await writeUserInstructions(ctx.dataRoot, input.text);
        return { ok: true, characters: text.length, maxLength: MAX_INSTRUCTIONS_LENGTH };
      },
    },
    {
      name: "jeditor_plugin_list",
      description:
        "List JV plugins with id, name, status, size, and recent runtime errors from the window. Use it before writing one, and to see why a plugin stopped. jeditor_plugin_read returns the code.",
      inputSchema: obj({}),
      async run({ dataRoot }) {
        const { listPlugins } = require("./plugins");
        const rows = await listPlugins(dataRoot);
        // The code hash belongs to the approval check, not to an agent: a row
        // only needs to say whether the plugin is on, off, or changed.
        const plugins = rows.map((row) => {
          const out = Object.assign({}, row);
          delete out.hash;
          return out;
        });
        return { plugins };
      },
    },
    {
      name: "jeditor_plugin_read",
      description: "Read one plugin's code, status, and the runtime errors the window recorded, with counts. Use it to debug a plugin the person says is broken.",
      inputSchema: obj({ id: { type: "string", description: "Plugin id from jeditor_plugin_list." } }, ["id"]),
      async run({ dataRoot }, input) {
        const { readPlugin } = require("./plugins");
        return readPlugin(dataRoot, input.id);
      },
    },
    {
      name: "jeditor_plugin_write",
      description:
        "Create or replace a plugin that extends the window: palette commands, rail pages, project buttons, app events. code is an ES module exporting activate(jv). The person must turn it on in Settings > Plugins; you cannot turn it on or delete it.",
      inputSchema: obj(
        {
          id: { type: "string", description: "Lowercase id with dashes, 2 to 40 characters, e.g. word-count. Reuse an id to update that plugin.", minLength: 2, maxLength: 40 },
          name: { type: "string", description: "Short name the person sees, e.g. Word count." },
          description: { type: "string", description: "One plain sentence on what it adds and where to find it." },
          code: { type: "string", description: "plugin.js source: an ES module with export function activate(jv) { ... }. Up to 256 KB, no imports. See the plugin-maker skill (/plugin)." },
        },
        ["id", "name", "code"],
      ),
      validate(input) {
        const { ID_RE } = require("./plugins");
        if (!ID_RE.test(String((input && input.id) || ""))) throw new Error("Pass id as 2 to 40 lowercase letters, digits or dashes, e.g. word-count.");
        if (/^\s*import\s|\bimport\s*\(/m.test(String((input && input.code) || ""))) throw new Error("Put everything in one module and use the jv API: a plugin cannot import other files.");
      },
      async run(ctx, input) {
        const { writePlugin } = require("./plugins");
        const meta = ctx.meta || {};
        const author = String(meta.harness || ctx.client || meta.client || "");
        const out = await writePlugin(ctx.dataRoot, Object.assign({}, input, { author }));
        const next = out.status === "on" ? "It is on." : out.status === "changed" ? "It changed since the user approved it, so it is off until they turn it on again in Settings > Plugins." : "It is off. Ask the user to turn it on in Settings > Plugins.";
        return Object.assign(out, { next });
      },
    },
  ];
}

module.exports = {
  agentToolSpecs,
  exportProjectBundle,
  deleteLibraryItemFromDisk,
  needConfirm,
  EDIT_TIMELINE_DOC,
  PREVIEW_FRAMES_DOC,
};
