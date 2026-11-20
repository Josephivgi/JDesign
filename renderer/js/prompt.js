// The text an ACP agent receives for one chat message: the user's words, the
// standing JV instructions, and a JSON context naming the exact project.
// Pure, so it is tested on its own (test/chat-prompt.test.js).

// Saved design code longer than this stays out of the chat context.
const CODE_IN_CONTEXT = 2000;

// Same fingerprint as editSig in lib/video-render.js.
function editSig(state, clipId) {
  const st = state || {};
  const studio = st.studio || {};
  const own = (row) => row && typeof row === "object" && (row.videoId ? row.videoId === clipId : !st.selectedAssetId || st.selectedAssetId === clipId);
  const rows = (list) => (Array.isArray(list) ? list.filter(own) : []);
  return JSON.stringify([(st.videoEdits && st.videoEdits[clipId]) || null, rows(studio.texts), rows(studio.overlays)]);
}

function staleRenders(state) {
  const sigs = state.renderSigs || {};
  return Object.keys(state.renders || {}).filter((clipId) => sigs[clipId] != null && sigs[clipId] !== editSig(state, clipId) && editSig(state, clipId) !== JSON.stringify([null, [], []]));
}

export function buildPrompt({ text, projectId, project, workspaceId, chatId, selectedAssetId, pinned, mediaById, userEdits, drawings, openDrawingId }) {
  const proj = project || {};
  const lookup = typeof mediaById === "function" ? mediaById : () => null;
  const pins = (pinned || []).filter(Boolean);
  const arts = (Array.isArray(drawings) ? drawings : []).filter(Boolean);
  const openDrawing = arts.find((d) => d.id === openDrawingId) || null;
  const context = {
    activeProject: { id: projectId, name: proj.name || "", aspectRatio: proj.aspectRatio || "" },
    workspaceId,
    project: {
      id: projectId,
      assets: (proj.assets || []).map((a) => {
        const item = lookup(a.id);
        const row = { id: a.id, kind: a.kind, name: item ? item.name : "" };
        // A clip rendered from code: its source is readable, so a fix or a
        // change edits the code instead of the pixels.
        if (item && item.source === "animation") row.madeFromCode = "jeditor_get_library_item returns its animationSource when JV kept it";
        return row;
      }),
      selectedAssetId: selectedAssetId || "",
      renders: (proj.state && proj.state.renders) || {},
      // Clips whose finished video was made before their latest edits.
      staleRenders: staleRenders(proj.state || {}),
      // The project's drawings. The jdraw tools act only on these.
      drawings: arts.map((d) => ({ id: d.id, name: d.name })),
    },
    viewing: { app: "JV", page: "editor", chatId: chatId || "", openDrawingId: openDrawingId || "" },
  };
  // A project made from a gallery design says so, so the agent changes the
  // design (same preset, new params) instead of rewriting it from scratch.
  const design = proj.state && proj.state.design;
  const designLive = Boolean(design && design.preset && (proj.assets || []).some((a) => a.id === design.assetId));
  if (designLive) {
    context.project.design = { preset: design.preset, params: design.params || {}, colors: design.colors || {}, aspectRatio: design.aspectRatio || "", clipId: design.assetId };
    // Saved code rides along when it is small; a large block is named only,
    // so one styled design cannot fill the agent's context on every turn.
    const SMALL = CODE_IN_CONTEXT;
    // A large block is left out entirely (a placeholder string could be
    // copied back as code); cssChars/jsChars say it exists and where to read it.
    if (design.css && design.css.length <= SMALL) context.project.design.css = design.css;
    else if (design.css) context.project.design.cssChars = design.css.length;
    if (design.js && design.js.length <= SMALL) context.project.design.js = design.js;
    else if (design.js) context.project.design.jsChars = design.js.length;
    if (!context.project.design.css && design.css || !context.project.design.js && design.js) context.project.design.fullCode = "Read state.design with jeditor_get_project.";
    // Only the settings a design keeps (older designs may carry others).
    const KEEP = ["durationMs", "fps", "audioId", "audioVolume", "audioLoop", "audioIds", "audios"];
    const extras = {};
    for (const key of KEEP) if (design.extras && design.extras[key] != null) extras[key] = design.extras[key];
    if (Object.keys(extras).length) context.project.design.extras = extras;
  }
  if (pins.length) context.pinned = pins.map((i) => ({ id: i.id, kind: i.kind, name: i.name }));
  // Cuts the user made by hand on the timeline strip since the agent's last
  // turn. Their cut is the live timeline; the agent builds on it.
  const hand = (Array.isArray(userEdits) ? userEdits : []).filter((e) => e && e.note).slice(-12);
  if (hand.length) context.project.userTimelineEdits = hand.map((e) => ({ at: e.at, clipId: e.clipId || "", note: e.note }));
  const handNote = hand.length
    ? "Since your last turn the user edited the cut by hand on JV's timeline: " + hand.map((e) => e.note).join("; ") + ". That cut is now the project's timeline. Build on it, and do not undo or redo it unless they ask; read jeditor_get_timeline for the exact parts before you change the cut. "
    : "";
  const pinnedNote = pins.length
    ? "The user attached this media for the request: " + pins.map((i) => (i.name || i.kind) + " [" + i.kind + " " + i.id + "]").join(", ") + ". Use it, and do not pull other media unless they ask. "
    : "";
  return (
    text +
    "\n\nYou are working inside JDesign. A project holds one video and any number of drawings. The video tools are the jeditor-app MCP server and the jeditor-cards MCP server (cards_* tools) for edit cards; the drawing tools are the jdraw MCP server: list_drawings, new_drawing and open_drawing act on this project only. " +
    "The user is viewing project " + projectId + (proj.name ? " (" + proj.name + ")" : "") + " in workspace " + workspaceId + "; edit only that project and its drawings. " +
    (openDrawing ? "The drawing open on stage is " + openDrawing.name + " (" + openDrawing.id + "). " : "") +
    "Read jeditor_get_project with this project id before changing anything, and pass the explicit workspaceId and projectId on every tool call. " +
    "When there is no footage, make the video from code with jeditor_render_animation instead of asking for media. " +
    "When the edit is ready, render it with jeditor_render_project so it appears in the project's Finished videos. " +
    pinnedNote +
    handNote +
    (context.project.staleRenders.length
      ? "The finished video of clip " + context.project.staleRenders.join(", ") + " was made before the user's latest edits. Judge the live cut (jeditor_preview_frames with outputTimes) rather than that render, and run jeditor_render_project before anything that needs the finished file (export, an audio probe of the mix). "
      : "") +
    (designLive
      ? "This project was made from the " + design.preset + " design (clip " + design.assetId + "). For changes to it, call jeditor_render_animation with preset \"" + design.preset + "\" and the changed presetParams and colors, plus extra css or js only for what the params cannot do, and projectId. JV keeps everything you leave out (params, colors, css, js, length, audio) and swaps the old clip out for you; css or js you pass replace the saved css or js, so include the saved rules you want to keep" + (design.css && design.css.length > CODE_IN_CONTEXT || design.js && design.js.length > CODE_IN_CONTEXT ? " (the saved code is too long to show here: read state.design with jeditor_get_project before passing css or js)" : "") + ". To add another clip of the same preset beside it, pass asNewClip: true. "
      : "") +
    "If the JV tools are unavailable, say so instead of inventing an edit.\n" +
    "Context from JV:\n" + JSON.stringify(context)
  );
}
