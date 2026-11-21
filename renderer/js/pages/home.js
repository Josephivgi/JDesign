import { api, store, on, emit, refreshProjects, defaultHarnessId, thumbFor, setPrefs } from "../store.js";
import { esc, icon, toast, showMenu, confirmDialog, promptDialog, autosize, timeAgo, errorText } from "../ui.js";
import { mediaChip, pickMedia, wireDrop, importPaths } from "../media.js";
import { agentName, loadModels, agentModelPickerButton, openAgentModelMenu } from "../agent-ui.js";
import { attachSlashMenu, fetchSlashCommands, workflowFor } from "../slash.js";
import { mountGallery } from "../gallery.js";
import { attachMic } from "../voice.js";

const RATIOS = [
  { id: "16/9", label: "16:9", sub: "YouTube, landscape" },
  { id: "9/16", label: "9:16", sub: "Shorts, Reels, TikTok" },
  { id: "1/1", label: "1:1", sub: "Square" },
  { id: "4/5", label: "4:5", sub: "Feed portrait" },
];

// Ideas start a workflow. The ones that work on footage ask for a video
// first when none is attached, so the agent never starts with nothing.
// `finish` ideas end mid-sentence on purpose: the caret waits for the rest.
// Each idea carries the icon of what it makes, the same one its workflow has
// in the / menu where there is one, so six chips do not share one mark.
const IDEAS = [
  { text: "/animate A 10 second animated logo intro for my channel called ", label: "Animated logo intro", icon: "play", finish: "your channel name" },
  { text: "/explainer A 15 second explainer about ", label: "Make an explainer", icon: "presentation", finish: "what it is about" },
  { text: "/animate A title card that says Coming Soon", label: "Coming soon card", icon: "ratio" },
  { text: "/short ", label: "Make a vertical short", icon: "phone", clip: true },
  { text: "/captions ", label: "Add captions", icon: "captions", clip: true },
  { text: "/edit Cut this into a 30 second highlight", label: "30 second highlight", icon: "scissors", clip: true },
];

// What the launcher holds survives a trip to another page.
const draft = { text: "", pins: [], ratio: "16/9", harnessId: "", picked: false, modelId: "", modelFor: "" };
// Project list view state, kept across page visits.
const list = { query: "", sort: "recent" };
const SEARCH_AT = 6;

// What a person needs to know at a glance: is there anything in it yet, and
// is there a finished video.
function projectStatus(project) {
  const renders = project.state && project.state.renders ? Object.keys(project.state.renders).length : 0;
  const clips = (project.assets || []).length;
  if (renders) return { label: renders === 1 ? "Video ready" : renders + " videos ready", ready: true };
  if (clips) return { label: clips === 1 ? "1 clip" : clips + " clips", ready: false };
  return { label: "Empty", ready: false };
}

function sortedProjects(projects) {
  const q = list.query.trim().toLowerCase();
  const rows = projects.filter((p) => !q || String(p.name || "").toLowerCase().includes(q));
  if (list.sort === "name") return rows.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  return rows.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
}

function projectThumb(project, drawing) {
  const sel = project.state && project.state.selectedAssetId;
  const renders = project.state && project.state.renders ? Object.values(project.state.renders) : [];
  const ids = renders.concat(sel ? [sel] : [], (project.assets || []).map((a) => a.id));
  for (const id of ids) {
    const src = thumbFor(store.mediaById(id));
    if (src) return '<img src="' + esc(src) + '" alt="" loading="lazy" draggable="false">';
  }
  // No video poster yet: the first drawing's thumbnail stands in.
  if (drawing && drawing.thumb) return '<img src="' + esc(drawing.thumb) + '" alt="" loading="lazy" draggable="false">';
  // No picture yet: say so plainly, in the project's frame shape.
  const [w, h] = String(project.aspectRatio || "16/9").split("/").map(Number);
  const ratio = w && h ? w / h : 16 / 9;
  // Sized by width in every shape, so the frame and its label always fit the
  // card: a wide frame is 40% across, a square or tall one about half as high
  // as the card.
  const width = ratio > 1 ? 40 : Math.round(30 * ratio * 10) / 10;
  const style = "width:" + width + "%;aspect-ratio:" + (w && h ? w + "/" + h : "16/9");
  return '<span class="proj-frame" style="' + style + '">' + icon("plus", "i-sm") + '</span><span class="proj-empty-text">No media yet</span>';
}

// A short name from the prompt: drop the asking words, keep the subject, cut
// at a word, never end on "the" or "with".
const FILLER = /^(hey|hi|ok|okay|so|please|pls|can you|could you|would you|will you|i want( you)? to|i need( you)? to|i'?d like( you)? to|help me|let'?s|go( in(to)?)?|make( me)? an?|make me|create an?|an?|for me)\b[\s,]*/i;
const TRAILING = /\s+(a|an|the|and|or|of|to|in|on|at|with|for|from|about|how|that|this|my|i|it|is|are|be|so|but|by|as)$/i;
export function nameFrom(text) {
  let clean = String(text || "").split(/\n/)[0].replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim();
  for (let i = 0; i < 4 && FILLER.test(clean); i += 1) clean = clean.replace(FILLER, "");
  clean = clean.replace(/[.,;:!?]+$/, "");
  if (!clean) return "";
  // First clause only: "... with captions, and an intro" stops at the comma.
  clean = clean.split(/[.;:!?](?=\s|$)|,\s/)[0];
  let words = clean.split(" ");
  let out = "";
  for (const w of words) {
    if ((out + " " + w).trim().length > 38) break;
    out = (out + " " + w).trim();
  }
  if (!out) out = words[0].slice(0, 38);
  while (TRAILING.test(out)) out = out.replace(TRAILING, "");
  return out.charAt(0).toUpperCase() + out.slice(1);
}

// "Untitled project", then "Untitled project 2", 3... so blank ones differ.
function untitledName() {
  const taken = new Set((store.projects || []).map((p) => p.name));
  if (!taken.has("Untitled project")) return "Untitled project";
  let n = 2;
  while (taken.has("Untitled project " + n)) n += 1;
  return "Untitled project " + n;
}

const isEmptyProject = (p) => !(p.assets || []).length && !(p.state && p.state.renders && Object.keys(p.state.renders).length);

// "/animate a logo sting" names the project "a logo sting", and a bare
// "/animate" takes the command's label, never the slash text.
function projectName(text, harnessId) {
  const flow = workflowFor(text, harnessId);
  if (!flow) return nameFrom(text) || untitledName();
  const args = String(text).replace(/^\/[a-z0-9-]+\s*/i, "");
  return nameFrom(args) || flow.label;
}

export function renderHome(main) {
  let mic = null; // the prompt box's voice input
  // Follow the default agent from Settings until the person picks one here.
  if (!draft.picked || !draft.harnessId) draft.harnessId = defaultHarnessId();
  // A model picked for one agent means nothing to another.
  const syncModel = () => {
    if (draft.modelFor !== draft.harnessId) {
      draft.modelId = "";
      draft.modelFor = draft.harnessId;
    }
    if (draft.harnessId) void loadModels(draft.harnessId);
  };
  syncModel();
  main.innerHTML = '<div class="page" data-home><div class="page-inner" data-inner></div></div>';
  const inner = main.querySelector("[data-inner]");

  const paint = () => {
    const projects = store.projects || [];
    const ratio = RATIOS.find((r) => r.id === draft.ratio) || RATIOS[0];
    // With no agent installed, Create would only lead to an error. Say what
    // is missing and where to fix it instead.
    const ready = (store.harnesses || []).some((h) => h.available);
    const setup = ready
      ? ""
      : '<div class="notice warn launch-setup">' + icon("alert") +
        '<span class="grow"><strong>No AI agent is ready yet.</strong> JV needs an agent such as Claude Code or OpenCode installed on this computer to edit your videos.</span>' +
        '<button type="button" class="btn btn-sm btn-primary" data-setup>Set up an agent</button></div>';
    // Returning people see their own work first; the design gallery follows.
    const projectsFirst = projects.length > 0;
    const empties = projects.filter(isEmptyProject);
    const projectsHtml =
      '<div class="section-title">Projects <span class="count">' + projects.length + "</span>" +
      '<span class="grow"></span>' +
      (empties.length > 1 ? '<button type="button" class="btn btn-sm btn-ghost" data-clean-empty title="Delete projects that have no media and no video">' + icon("trash", "i-sm") + "Remove " + empties.length + " empty</button>" : "") +
      (projects.length > SEARCH_AT
        ? '<div class="search proj-search">' + icon("search") + '<input class="input" data-proj-q placeholder="Search projects" aria-label="Search projects" value="' + esc(list.query) + '"></div>' +
          '<button type="button" class="picker" data-proj-sort title="Sort projects">' + icon("sort", "i-sm") + "<span>Sort: " + esc(list.sort === "name" ? "Name" : "Recent") + "</span>" + icon("chevDown", "i-sm chev") + "</button>"
        : "") +
      "</div>" +
      '<div data-proj-list>' + projectList(projects) + "</div>";
    inner.innerHTML =
      '<section class="hero"><h1>What are we making?</h1><p>Describe a video or a drawing. An agent makes it, or start a drawing yourself.</p></section>' +
      setup +
      '<form class="launch" data-launch>' +
      '<div class="launch-pins" data-pins></div>' +
      '<textarea data-launch-input rows="3" aria-label="Describe the video" placeholder="A 20 second recap of my match with captions and an upbeat intro">' + esc(draft.text) + "</textarea>" +
      '<div class="launch-foot">' +
      '<button type="button" class="icon-btn" data-attach title="Attach media from your library (optional)" aria-label="Attach media">' + icon("paperclip") + "</button>" +
      '<button type="button" class="icon-btn" data-slash-open title="Workflows (type /)" aria-label="Workflows">' + icon("slash") + "</button>" +
      '<button type="button" class="icon-btn mic-btn" data-mic aria-label="Talk instead of typing"></button>' +
      '<button type="button" class="picker" data-ratio title="Frame">' + icon("ratio", "i-sm") + "<span>" + esc(ratio.label) + "</span>" + icon("chevDown", "i-sm chev") + "</button>" +
      '<span class="launch-pickers" data-agent-model>' + agentModelPickerButton(draft.harnessId, draft.modelId, null, "data-agent") + "</span>" +
      '<span class="grow"></span>' +
      '<button type="button" class="btn btn-ghost" data-manual title="Start a new project yourself, on a blank drawing">' + icon("pencil", "i-sm") + "<span>Start new project manually</span></button>" +
      '<button type="submit" class="btn btn-primary" data-create' + (ready ? "" : ' disabled title="Set up an agent first"') + ">" + icon("sparkles") + "Create</button>" +
      "</div></form>" +
      '<div class="chips">' + IDEAS.map((idea, i) => '<button type="button" class="chip" data-idea="' + i + '" title="' + esc(idea.text.trim()) + (idea.clip ? " (asks you to pick a video)" : "") + '">' + icon(idea.icon, "i-sm") + esc(idea.label) + "</button>").join("") + "</div>" +
      drawSplit() +
      (projectsFirst ? projectsHtml + '<div class="gallery" data-gallery></div>' : '<div class="gallery" data-gallery></div>' + projectsHtml) +
      '<div data-chats></div>';
    paintPins();
    wire();
    drawChats();
  };

  // Under the prompt box the page splits in half: starting a new drawing on
  // one side, the drawings that already exist on the other.
  const drawSplit = () => {
    const projIds = new Set((store.projects || []).map((p) => p.id));
    const nameOf = (id) => ((store.projects || []).find((p) => p.id === id) || {}).name || "A project";
    const rows = (store.drawingsAll || []).filter((d) => d && projIds.has(d.projectId));
    return (
      '<div class="draw-split">' +
      '<section class="draw-half">' +
      '<div class="draw-new">' +
      '<span class="draw-new-ic">' + icon("pencil", "i-lg") + "</span>" +
      "<strong>Start new drawing</strong>" +
      "<p>Opens a blank drawing with the shape and paint tools, inside a new project.</p>" +
      '<button type="button" class="btn" data-draw-new>' + icon("plus", "i-sm") + "New drawing</button>" +
      "</div>" +
      "</section>" +
      '<section class="draw-half">' +
      '<div class="draw-half-head"><strong>Your drawings</strong>' + (rows.length ? '<span class="count">' + rows.length + "</span>" : "") + "</div>" +
      (rows.length
        ? '<div class="draw-rows">' +
          rows.slice(0, 12).map((d) =>
            '<button type="button" class="draw-row" data-draw-open="' + esc(d.id) + '" data-draw-proj="' + esc(d.projectId) + '" title="Open ' + esc(d.name) + '">' +
            '<span class="draw-thumb">' + (d.thumb ? '<img src="' + esc(d.thumb) + '" alt="" loading="lazy" draggable="false">' : icon("pencil", "i-sm")) + "</span>" +
            '<span class="draw-row-main"><span class="ellipsis">' + esc(d.name) + "</span><small>" + esc(nameOf(d.projectId)) + (d.updated ? " \u00b7 " + timeAgo(d.updated) : "") + "</small></span>" +
            icon("chevRight", "i-sm") +
            "</button>",
          ).join("") +
          "</div>"
        : '<p class="draw-none">No drawings yet. Start one on the left.</p>') +
      "</section>" +
      "</div>"
    );
  };

  // Chat history across both studios, newest first. The label at the end of
  // each row says where the chat started: its project or its drawing.
  const importing = (store.importingDrawChats = store.importingDrawChats || new Set());
  const renderChats = async () => {
    if (!inner.querySelector("[data-chats]")) return;
    let video = [];
    let draw = [];
    try { video = (await api.editorChats({ workspaceId: store.workspaceId, page: "ai" })) || []; } catch {}
    try { draw = (await api.jdrawChats()) || []; } catch {}
    const rows = [];
    const projectName = (id) => ((store.projects || []).find((p) => p.id === id) || {}).name || "A project";
    const agentName = (harnessId) => ((store.harnesses || []).find((h) => h.id === harnessId) || {}).name || "";
    // A copied chat keeps the Draw chat's date until someone writes in it
    // again here: only user and agent rows newer than the Draw chat count
    // (connecting an agent also saves status rows, which do not).
    const drawAt = new Map(draw.filter((d) => d.jvChatId).map((d) => [d.jvChatId, d]));
    const when = (v) => (typeof v === "number" ? v : Date.parse(v) || 0);
    const newest = new Map();
    // The transcript is only read again when the chat changed.
    const seen = (store.chatNewest = store.chatNewest || new Map());
    await Promise.all(video.filter((c) => drawAt.has(c.id)).map(async (c) => {
      const since = Number(drawAt.get(c.id).updated) || 0;
      const key = c.id + "|" + c.updatedAt + "|" + since;
      if (seen.has(key)) { newest.set(c.id, seen.get(key)); return; }
      const rec = await api.editorChatGet({ id: c.id }).catch(() => null);
      const rows = (rec && rec.chat && Array.isArray(rec.chat.acpTranscript) ? rec.chat.acpTranscript : []);
      const at = rows.reduce((m, r) => (r && (r.role === "user" || r.role === "agent") && Number(r.at) > since ? Math.max(m, Number(r.at)) : m), 0);
      seen.set(key, at);
      newest.set(c.id, at);
    }));
    const stamp = (c) => {
      const d = drawAt.get(c.id);
      if (!d) return c.updatedAt;
      return Math.max(Number(d.updated) || 0, newest.get(c.id) || 0);
    };
    for (const c of video) {
      if (!(c.messageCount > 0) && !c.hasAcp) continue;
      rows.push({ key: "v" + c.id, title: c.title, sub: [agentName(c.harnessId), timeAgo(stamp(c))].filter(Boolean).join(" · "), from: projectName(c.projectId), at: stamp(c), ico: "film", open: () => {
        if (!c.projectId) { toast("That chat belongs to no project, so it cannot be opened", true); return; }
        emit("navigate", { page: "editor", params: { projectId: c.projectId, chatId: c.id } });
      } });
    }
    const haveVideo = new Set(video.map((v) => v.id));
    for (const c of draw) {
      // A Draw chat already copied into a project chat shows as that chat.
      if (c.jvChatId && haveVideo.has(c.jvChatId)) continue;
      // An old Draw chat opens in the project that owns its drawing.
      rows.push({ key: "d" + c.id, title: c.title, sub: [c.agentName, timeAgo(c.updated)].filter(Boolean).join(" · "), from: c.drawingName || "A drawing", at: c.updated, ico: "palette", open: async () => {
        // A second click while the copy is being made does nothing.
        if (importing.has(c.id)) return;
        importing.add(c.id);
        try {
        const projectId = await api.jdrawProjectOf(c.drawingId).catch(() => "");
        if (!projectId) { toast("That drawing has no project yet", true); return; }
        if (!(store.projects || []).some((p) => p.id === projectId)) { toast("That drawing's project is in another workspace", true); return; }
        // The project chat is where chats continue: the Draw conversation
        // is copied into it once (the link is kept with the Draw chat), then
        // reopened from there every time.
        // The row may be from an earlier render: read the current link.
        const live = ((await api.jdrawChats().catch(() => [])) || []).find((x) => x.id === c.id);
        let chatId = (live && live.jvChatId) || "";
        let failed = false;
        try {
          if (chatId) { const rec = await api.editorChatGet({ id: chatId }); if (!rec || !rec.chat || rec.chat.projectId !== projectId) chatId = ""; }
          if (!chatId) {
            const msgs = await api.jdrawChatMessages({ drawingId: c.drawingId, chatId: c.id });
            if (!msgs) throw new Error("Could not read the Draw chat");
            // Nothing readable to carry over: open the drawing, keep the row.
            if (msgs.length) {
              const rec = await api.editorChatCreate({ workspaceId: store.workspaceId, page: "ai", projectId, model: "" });
              chatId = rec.chat.id;
              try {
                await api.editorChatSave({ chatId, messages: msgs, light: true });
                const patch = { title: c.title };
                if (c.agent && (store.harnesses || []).some((h) => h.id === c.agent)) patch.harnessId = c.agent;
                else if (c.agent) toast((c.agentName || c.agent) + " is not set up here, so this chat continues with your default agent");
                await api.editorChatUpdate({ id: chatId, patch, light: true }).catch(() => {});
                if (!(await api.jdrawChatImported({ chatId: c.id, jvChatId: chatId }))) throw new Error("Could not link the copy");
              } catch (error) {
                await api.editorChatDelete({ id: chatId }).catch(() => {});
                throw error;
              }
            }
          }
        } catch { chatId = ""; failed = true; }
        if (failed) toast("Could not open that chat's history", true);
        emit("navigate", { page: "editor", params: { projectId, drawingId: c.drawingId, chatId } });
        } finally { importing.delete(c.id); }
      } });
    }
    // Video rows carry ISO text and Draw rows epoch ms: compare as times.
    rows.sort((a, b) => when(b.at) - when(a.at));
    store.chatRows = rows;
    drawChats();
  };

  // The list lives in a cache so a page repaint (which rewrites the box)
  // draws it again at once instead of waiting for the next fetch.
  const drawChats = () => {
    const box = inner.querySelector("[data-chats]");
    if (!box) return;
    const rows = store.chatRows || [];
    box.innerHTML = rows.length
      ? '<div class="section-title">Chats <span class="count">' + rows.length + "</span></div>" +
        '<div class="chat-rows">' +
        rows.slice(0, 20).map((r) =>
          '<button type="button" class="chat-row" data-chat="' + esc(r.key) + '" title="Open ' + esc(r.title) + '">' +
          '<span class="chat-ico">' + icon(r.ico) + "</span>" +
          '<span class="chat-main"><span class="chat-t">' + esc(r.title) + "</span>" + (r.sub ? '<span class="chat-s">' + esc(r.sub) + "</span>" : "") + "</span>" +
          '<span class="chat-from">' + esc(r.from) + "</span></button>",
        ).join("") + "</div>"
      : "";
    box.querySelectorAll("[data-chat]").forEach((btn) => {
      const row = rows.find((r) => r.key === btn.dataset.chat);
      if (row) btn.addEventListener("click", () => row.open());
    });
  };

  const paintModel = () => {
    const el = inner.querySelector("[data-agent-model]");
    if (el) el.innerHTML = agentModelPickerButton(draft.harnessId, draft.modelId, null, "data-agent");
  };

  function projectList(projects) {
    // One quiet line: the launcher above already holds Create and Blank
    // project, so this state does not repeat them or push the page down.
    if (!projects.length) return '<p class="proj-none">No projects yet. The videos you make show up here.</p>';
    const rows = sortedProjects(projects.slice());
    if (!rows.length) return '<div class="card empty"><p>No project matches “' + esc(list.query) + '”.</p></div>';
    const drawingMap = store.drawingsAll || [];
    const drawingsFor = (id) => drawingMap.filter((d) => d.projectId === id);
    return '<div class="grid">' + rows.map((p) => {
      const status = projectStatus(p);
      const empty = isEmptyProject(p);
      const ds = drawingsFor(p.id);
      // The card says what is inside: "1 clip, 3 drawings".
      const contents = [status.ready ? "" : status.label, ds.length ? ds.length + (ds.length === 1 ? " drawing" : " drawings") : "", String(p.aspectRatio || "16/9").replace("/", ":"), timeAgo(p.updatedAt)].filter(Boolean).join(" · ");
      return '<div class="proj" role="button" tabindex="0" data-open="' + esc(p.id) + '" title="Open ' + esc(p.name) + '">' +
        '<div class="proj-thumb' + (empty && !ds.length ? " is-empty" : "") + '">' + projectThumb(p, ds[0]) + (status.ready ? '<span class="proj-badge">' + icon("checkCircle", "i-sm") + esc(status.label) + "</span>" : "") + "</div>" +
        // The badge already says a video is ready, so the meta line does not repeat it.
        '<div class="proj-meta"><strong class="ellipsis">' + esc(p.name) + "</strong><small>" + esc(contents) + "</small></div>" +
        '<button type="button" class="icon-btn icon-btn-sm proj-more" data-more="' + esc(p.id) + '" title="Project options" aria-label="Options for ' + esc(p.name) + '">' + icon("more") + "</button></div>";
    }).join("") + "</div>";
  }

  // Search only redraws the list, so the box keeps focus while typing.
  const paintList = () => {
    const el = inner.querySelector("[data-proj-list]");
    if (!el) return;
    el.innerHTML = projectList(store.projects || []);
    wireCards();
  };

  // A manual project starts on a blank drawing with the full drawing tools:
  // drawing is the part a person starts by hand; video comes from the agent.
  const manualProject = async () => {
    try {
      const project = await api.aiProjectCreate({ name: untitledName(), aspectRatio: draft.ratio, assetIds: draft.pins.slice() });
      const d = await api.jdrawDrawingCreate({ projectId: project.id, name: "Drawing 1" }).catch(() => null);
      draft.pins = [];
      await refreshProjects();
      emit("navigate", { page: "editor", params: d && d.id ? { projectId: project.id, drawingId: d.id } : { projectId: project.id } });
    } catch (error) {
      toast(errorText(error), true);
    }
  };

  const paintPins = () => {
    const el = inner.querySelector("[data-pins]");
    if (!el) return;
    draft.pins = draft.pins.filter((id) => store.mediaById(id));
    el.innerHTML = draft.pins.map((id) => mediaChip(store.mediaById(id))).join("");
    el.style.paddingTop = draft.pins.length ? "12px" : "0";
  };

  const create = async () => {
    const btn = inner.querySelector("[data-create]");
    if (!btn || btn.disabled) return;
    const text = draft.text.trim();
    if (btn) btn.disabled = true;
    try {
      // A command typed without opening the menu still needs its label for the name.
      if (text.startsWith("/")) await fetchSlashCommands({ harnessId: draft.harnessId });
      const project = await api.aiProjectCreate({ name: projectName(text, draft.harnessId), aspectRatio: draft.ratio, assetIds: draft.pins.slice() });
      // What gets made (a video, a drawing, both) is up to the ask: the
      // project chat has the video and drawing tools in the same session.
      store.pendingLaunch = text ? { projectId: project.id, text, harnessId: draft.harnessId, modelId: draft.modelId } : null;
      draft.text = "";
      draft.pins = [];
      await refreshProjects();
      emit("navigate", { page: "editor", params: { projectId: project.id } });
    } catch (error) {
      toast(errorText(error), true);
      if (btn) btn.disabled = false;
    }
  };

  const wire = () => {
    const box = inner.querySelector("[data-launch-input]");
    autosize(box, 260);
    if (mic) mic.destroy();
    mic = attachMic(inner.querySelector("[data-mic]"), box, {
      onText: () => {
        if (store.prefs.micAutoSend) void create();
      },
    });
    box.addEventListener("input", () => {
      draft.text = box.value;
      autosize(box, 260);
    });
    const slash = attachSlashMenu(box, {
      host: inner.querySelector("[data-launch]"),
      below: true,
      scope: () => ({ harnessId: draft.harnessId }),
      agentLabel: () => agentName(draft.harnessId),
      // A new project has no footage unless media is attached, so commands
      // that work on a clip are greyed out until something is attached. The
      // agent's own commands belong to a running chat, not a new project.
      disabled: (c) => {
        const needs = String(c.needs || "").split(/\s*,\s*/);
        if (needs.includes("elevenlabs") && store.elevenlabsReady === false) return "Add your ElevenLabs key in Settings > Voice and music first";
        return needs.includes("clip") && !draft.pins.length ? "Attach a clip first, or open a project that has one" : "";
      },
      agentCommands: false,
    });
    inner.querySelector("[data-slash-open]").addEventListener("click", () => slash.openFromButton());
    box.addEventListener("keydown", (event) => {
      const ctrlSend = store.prefs.sendKey === "ctrl-enter";
      if (event.key === "Enter" && (ctrlSend ? event.ctrlKey || event.metaKey : !event.shiftKey)) {
        event.preventDefault();
        void create();
      }
    });
    inner.querySelector("[data-launch]").addEventListener("submit", (event) => {
      event.preventDefault();
      // Only Create (or Enter in the box) starts a project; a picker button
      // inside the form must never submit it.
      if (event.submitter && !event.submitter.matches("[data-create]")) return;
      void create();
    });
    inner.querySelector("[data-attach]").addEventListener("click", async () => {
      const items = await pickMedia({ title: "Attach media", confirm: "Attach", exclude: draft.pins, excludeLabel: "Attached" });
      for (const item of items) if (!draft.pins.includes(item.id)) draft.pins.push(item.id);
      paintPins();
    });
    inner.querySelector("[data-pins]").addEventListener("click", (event) => {
      const x = event.target.closest("[data-unpin]");
      if (!x) return;
      draft.pins = draft.pins.filter((id) => id !== x.dataset.unpin);
      paintPins();
    });
    inner.querySelector("[data-ratio]").addEventListener("click", (event) => {
      showMenu(event.currentTarget, RATIOS.map((r) => ({ label: r.label, sub: r.sub, checked: r.id === draft.ratio, onSelect: () => { draft.ratio = r.id; paint(); } })), { width: 220 });
    });
    inner.querySelector("[data-agent-model]").addEventListener("click", (event) => {
      const agent = event.target.closest("[data-agent]");
      if (agent) {
        openAgentModelMenu(agent, draft.harnessId, draft.modelId, null, {
          onAgent: (id) => {
            draft.harnessId = id;
            draft.picked = true;
            syncModel();
            paint();
          },
          onModel: (modelId) => {
            draft.modelId = modelId;
            paintModel();
          },
          onEffort: (value) => {
            void setPrefs({ effort: value });
            paintModel();
          },
        });
      }
    });
    const setupBtn = inner.querySelector("[data-setup]");
    if (setupBtn) setupBtn.addEventListener("click", () => emit("navigate", { page: "agents" }));
    void mountGallery(inner.querySelector("[data-gallery]"), {
      ratio: () => draft.ratio,
      // The form could not say it: the agent gets the same choice as /animate.
      onAsk: (text, ratio) => {
        draft.text = text;
        draft.ratio = ratio;
        paint();
        const b = inner.querySelector("[data-launch-input]");
        if (b) {
          b.focus();
          b.setSelectionRange(b.value.length, b.value.length);
        }
      },
      onMade: (projectId) => emit("navigate", { page: "editor", params: { projectId } }),
    });
    inner.querySelectorAll("[data-idea]").forEach((chip) =>
      chip.addEventListener("click", async () => {
        const idea = IDEAS[Number(chip.dataset.idea)];
        if (!idea) return;
        if (idea.clip && !draft.pins.some((id) => (store.mediaById(id) || {}).kind === "video")) {
          if (!store.library.some((item) => item.kind === "video")) {
            toast("Add a video in Library first, or drop one on this page.", true);
            return;
          }
          const items = await pickMedia({ title: "Pick the video to use", confirm: "Use it", exclude: draft.pins, excludeLabel: "Attached", kinds: ["video"] });
          const videos = items.filter((item) => item.kind === "video");
          if (!videos.length) {
            if (items.length) toast("Pick a video for this one.", true);
            return;
          }
          for (const item of videos) if (!draft.pins.includes(item.id)) draft.pins.push(item.id);
          paintPins();
        }
        draft.text = idea.text;
        box.value = draft.text;
        autosize(box, 260);
        box.focus();
        box.setSelectionRange(box.value.length, box.value.length);
        if (idea.finish) toast("Add " + idea.finish + ", then press Create.", "info");
      }),
    );
    const clean = inner.querySelector("[data-clean-empty]");
    if (clean) clean.addEventListener("click", async () => {
      const empties = (store.projects || []).filter(isEmptyProject);
      const ok = await confirmDialog({ title: "Remove " + empties.length + " empty projects?", body: "These projects have no media and no video: " + empties.slice(0, 8).map((p) => p.name).join(", ") + (empties.length > 8 ? ", and more" : "") + ". Their chats are removed too.", confirm: "Remove", danger: true });
      if (!ok) return;
      for (const p of empties) await api.aiProjectDelete({ id: p.id }).catch((e) => toast(errorText(e), true));
      await refreshProjects();
      toast("Empty projects removed");
    });
    inner.querySelectorAll("[data-manual], [data-draw-new]").forEach((b) => b.addEventListener("click", () => void manualProject()));
    inner.querySelectorAll("[data-draw-open]").forEach((b) => b.addEventListener("click", () => {
      emit("navigate", { page: "editor", params: { projectId: b.dataset.drawProj, drawingId: b.dataset.drawOpen } });
    }));
    const q = inner.querySelector("[data-proj-q]");
    if (q) q.addEventListener("input", () => {
      list.query = q.value;
      paintList();
    });
    const sortBtn = inner.querySelector("[data-proj-sort]");
    if (sortBtn) sortBtn.addEventListener("click", () => showMenu(sortBtn, [
      { label: "Recent", sub: "Last changed first", checked: list.sort === "recent", onSelect: () => { list.sort = "recent"; paint(); } },
      { label: "Name", sub: "A to Z", checked: list.sort === "name", onSelect: () => { list.sort = "name"; paint(); } },
    ], { width: 200, align: "end" }));
    wireCards();
  };

  const wireCards = () => {
    inner.querySelectorAll("[data-open]").forEach((card) => {
      const open = () => emit("navigate", { page: "editor", params: { projectId: card.dataset.open } });
      card.addEventListener("click", (event) => {
        if (!event.target.closest("[data-more]")) open();
      });
      card.addEventListener("keydown", (event) => {
        if (event.key === "Enter") open();
      });
    });
    inner.querySelectorAll("[data-more]").forEach((btn) =>
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        const project = (store.projects || []).find((p) => p.id === btn.dataset.more);
        if (!project) return;
        showMenu(btn, [
          { label: "Open", icon: "chevRight", onSelect: () => emit("navigate", { page: "editor", params: { projectId: project.id } }) },
          { label: "Rename", icon: "pencil", onSelect: async () => {
            const name = await promptDialog({ title: "Rename project", value: project.name });
            if (!name) return;
            await api.aiProjectUpdate({ id: project.id, patch: { name } }).catch((e) => toast(errorText(e), true));
            await refreshProjects();
          } },
          "sep",
          { label: "Delete project", icon: "trash", danger: true, onSelect: async () => {
            // Deleting a project deletes its drawings too, so the ask names them.
            const ds = await api.projectDrawings(project.id).catch(() => []);
            const named = ds.length ? " Its " + (ds.length === 1 ? "drawing" : "drawings") + " go with it: " + ds.slice(0, 6).map((d) => d.name).join(", ") + (ds.length > 6 ? ", and more" : "") + "." : "";
            const ok = await confirmDialog({ title: "Delete " + project.name + "?", body: "The project and its chats are removed." + named + " Media stays in your library, and renders stay until you clean them up.", confirm: "Delete", danger: true });
            if (!ok) return;
            await api.aiProjectDelete({ id: project.id }).catch((e) => toast(errorText(e), true));
            await refreshProjects();
            toast("Project deleted");
          } },
        ], { align: "end" });
      }),
    );
  };

  paint();
  // Drawing counts and thumbs on the cards come from Draw's store.
  void api.jdrawAllDrawings().then((ds) => { store.drawingsAll = ds || []; paint(); void renderChats(); }).catch(() => {});
  void renderChats();
  // Files dropped anywhere on Home are imported and attached to the launcher.
  const pageEl = main.querySelector("[data-home]");
  wireDrop(pageEl, async (paths) => {
    const items = await importPaths(paths);
    for (const item of items) if (!draft.pins.includes(item.id)) draft.pins.push(item.id);
    paintPins();
  }, "is-drop");
  const offs = [
    on("projects", paint),
    on("snapshot", paintPins),
    // A drawing renamed or made anywhere updates card counts and thumbs.
    on("draw-event", () => {
      store.drawingsAll = null;
      void api.jdrawAllDrawings().then((ds) => { store.drawingsAll = ds || []; paint(); void renderChats(); }).catch(() => {});
    }),
    on("harnesses", () => {
      if (!draft.picked || !draft.harnessId) draft.harnessId = defaultHarnessId();
      syncModel();
      paint();
    }),
    on("models", ({ harnessId }) => {
      if (harnessId === draft.harnessId) paintModel();
    }),
  ];
  setTimeout(() => {
    const box = inner.querySelector("[data-launch-input]");
    if (box && !store.projects?.length) box.focus();
  }, 0);
  return () => {
    if (mic) mic.destroy();
    offs.forEach((off) => off());
  };
}
