// "Start from a design": the ready-made animations as real thumbnails. A
// person picks one, types their words, picks colors, and JV renders it into a
// new project with no prompt. "Ask the agent" hands the same choice to the
// agent as an /animate request for changes the form cannot make.

import { api, store, refreshProjects, refreshSnapshot } from "./store.js";
import { esc, icon, toast, openDialog, closeDialog, errorText, showMenu, promptDialog } from "./ui.js";

let presets = null;
const thumbs = new Map(); // ratio -> { name: dataUrl }
const pending = new Map(); // ratio -> Promise
const retries = new Map(); // ratio -> times a failed thumbnail was retried

const RATIO_LABEL = { "16/9": "16:9", "9/16": "9:16", "1/1": "1:1", "4/5": "4:5" };
const DEFAULT_COLORS = { primary: "#111a33", secondary: "#ffb454", text: "#ffffff" };

async function loadPresets() {
  if (!presets) presets = (await api.animationPresets().catch(() => [])) || [];
  return presets;
}

// A failed or empty load is not cached, so Try again can really try again.
function retryPresets() {
  presets = null;
  thumbs.clear();
  pending.clear();
  retries.clear();
}

function loadThumbs(ratio) {
  if (thumbs.has(ratio)) return Promise.resolve(thumbs.get(ratio));
  if (!pending.has(ratio)) {
    pending.set(
      ratio,
      api
        .animationPresetThumbs({ ratio })
        .then((map) => {
          thumbs.set(ratio, map || {});
          return map || {};
        })
        .catch(() => ({}))
        .finally(() => pending.delete(ratio)),
    );
  }
  return pending.get(ratio);
}

// src: a data URL, "" when that thumbnail failed (a plain plate), or
// undefined while it is still rendering. The name sits under every tile, so a
// failed still says what is missing instead of repeating the label.
function tile(p, src, ratio) {
  return (
    '<button type="button" class="design" data-design="' + esc(p.name) + '" title="' + esc(p.about || p.description) + '">' +
    '<span class="design-shot" style="aspect-ratio:' + ratio.replace("/", " / ") + '">' +
    (src ? '<img src="' + src + '" alt="">' : src === "" ? '<span class="design-plain">' + icon("image", "i-lg") + "<span>No still yet</span></span>" : '<span class="design-wait">' + icon("loader", "spin") + "</span>") +
    "</span>" +
    '<span class="design-name">' + esc(p.label) + "</span>" +
    "</button>"
  );
}

// opts: { ratio(), onAsk(text), onMade(projectId, made) }
export async function mountGallery(el, opts) {
  const ratio = opts.ratio();
  const list = await loadPresets();
  if (!el.isConnected) return;
  if (!list.length) {
    // No designs is a state of its own: one line, one action, not a blank strip.
    el.innerHTML =
      '<div class="section-title">Start from a design</div>' +
      '<div class="empty designs-empty"><p>Designs did not load. They ship with JV, so this is a loading problem, not a missing feature.</p>' +
      '<button type="button" class="btn btn-sm" data-design-retry>' + icon("refresh", "i-sm") + "Try again</button></div>";
    el.onclick = (event) => {
      if (!event.target.closest("[data-design-retry]")) return;
      retryPresets();
      el.innerHTML = "";
      void mountGallery(el, opts);
    };
    return;
  }
  const paint = (map) => {
    el.innerHTML =
      '<div class="section-title">Start from a design <span class="faint" style="font-weight:400">Pick one, type your words, and JV makes it</span></div>' +
      '<div class="designs">' + list.map((p) => tile(p, map[p.name], ratio)).join("") + "</div>";
  };
  paint(thumbs.get(ratio) || {});
  el.onclick = (event) => {
    const b = event.target.closest("[data-design]");
    if (!b) return;
    const p = list.find((x) => x.name === b.dataset.design);
    if (p) openDesign(p, opts, (thumbs.get(opts.ratio()) || {})[p.name]);
  };
  if (!thumbs.has(ratio)) {
    const map = await loadThumbs(ratio);
    if (el.isConnected && opts.ratio() === ratio) paint(map);
    // A thumbnail that failed is tried again the next time Home opens, twice
    // at most, so one broken design does not re-render on every visit.
    if (Object.values(map).some((v) => v === "") && (retries.get(ratio) || 0) < 2) {
      retries.set(ratio, (retries.get(ratio) || 0) + 1);
      thumbs.delete(ratio);
    }
  }
}

// Label, rule and sample are each said once: the label names the field, the
// rule stays under it while typing, and the placeholder shows what a blank
// field makes.
function fieldFor(key, help, sample) {
  const id = "dz-" + key;
  const sampleText = sample ? String(sample) : "";
  if (key === "items") {
    return (
      '<div class="field"><label for="' + id + '">Bars</label>' +
      '<textarea class="textarea" id="' + id + '" data-param="items" rows="4" placeholder="' + esc(sampleText || "Mon, 12\nTue, 19") + '"></textarea>' +
      '<div class="field-help">One bar per line: a label, a comma, then the number. Up to 6. Blank shows the sample.</div></div>'
    );
  }
  const raw = String(help || key);
  const optional = /optional/i.test(raw);
  const clean = raw.replace(/\s*\(optional\)\s*$/i, "");
  const cut = clean.indexOf(",");
  const label = key === "words" ? "Words" : cut > 0 ? clean.slice(0, cut) : clean;
  const rule = key === "words" ? "2 to 5 short words, separated by commas." : cut > 0 ? clean.slice(cut + 1).trim().replace(/^./, (c) => c.toUpperCase()) + "." : "";
  const placeholder = sampleText ? "Blank shows: " + sampleText : optional ? "Leave blank to skip" : "";
  return (
    '<div class="field"><label for="' + id + '">' + esc(label) + (optional ? ' <span class="faint" style="font-weight:400">optional</span>' : "") + "</label>" +
    '<input class="input" id="' + id + '" data-param="' + esc(key) + '" placeholder="' + esc(placeholder) + '">' +
    (rule ? '<div class="field-help">' + esc(rule) + "</div>" : "") +
    "</div>"
  );
}

function readParams(dialog) {
  const params = {};
  for (const input of dialog.querySelectorAll("[data-param]")) {
    const key = input.dataset.param;
    const value = input.value.trim();
    if (!value) continue;
    if (key === "items") {
      params.items = value
        .split(/\n+/)
        .map((line) => {
          const at = line.lastIndexOf(",");
          return at > 0 ? { label: line.slice(0, at).trim(), value: Number(line.slice(at + 1).replace(/[^0-9.\-]/g, "")) } : null;
        })
        .filter((it) => it && it.label && Number.isFinite(it.value));
    } else if (key === "words") {
      params.words = value.split(",").map((w) => w.trim()).filter(Boolean);
    } else params[key] = value;
  }
  return params;
}

function describe(p, params, colors, ratio) {
  const bits = Object.entries(params).map(([k, v]) =>
    k === "items" ? "bars " + v.map((it) => it.label + " " + it.value).join(", ") : k === "words" ? "words " + v.join(", ") : k + " \"" + v + "\"",
  );
  return (
    "/animate Start from the " + p.label.toLowerCase() + " preset (" + p.name + ")" +
    (bits.length ? " with " + bits.join("; ") : "") +
    ". Background " + colors.primary + ", accent " + colors.secondary + ", text " + colors.text + ", " + RATIO_LABEL[ratio] + ". "
  );
}

// The text a saved param shows in its field.
function paramText(key, value) {
  if (key === "items" && Array.isArray(value)) return value.map((it) => it.label + ", " + it.value).join("\n");
  if (key === "words" && Array.isArray(value)) return value.join(", ");
  return value == null ? "" : String(value);
}

// Reopens the design a project was made from, filled in, so a typo or a
// color is fixed in place: "Update video" re-renders into the same project.
export async function editDesign(projectId, design, onDone) {
  const list = await loadPresets();
  const p = list.find((x) => x.name === design.preset);
  if (!p) {
    toast("This design is no longer available.", true);
    return;
  }
  openDesign(p, { ratio: () => design.aspectRatio || "16/9", onMade: onDone, onAsk: () => {} }, "", { projectId, design });
}

function openDesign(p, opts, src, existing) {
  let ratio = opts.ratio();
  const editing = Boolean(existing && existing.projectId);
  // Code an agent layered on this design rides along on every update.
  const extra = {};
  if (editing && existing.design.css) extra.css = existing.design.css;
  if (editing && existing.design.js) extra.js = existing.design.js;
  if (editing && existing.design.extras && Object.keys(existing.design.extras).length) extra.extras = existing.design.extras;
  const fields = Object.keys(p.params || {}).map((k) => fieldFor(k, p.params[k], (p.samples || {})[k])).join("");
  // Length: the design's own length, its shortest, and a longer cut. A
  // length the agent set that is none of these shows as its own choice.
  const baseMs = Number(p.durationMs) || 4000;
  const minMs = Number(p.minMs) || 1000;
  const savedExtras = (editing && existing.design.extras) || {};
  const lengths = Array.from(new Set([Math.ceil(minMs / 500) * 500, baseMs, Math.max(baseMs + 3000, 8000), 15000]))
    .filter((ms) => ms >= minMs)
    .sort((a, b) => a - b);
  let lengthMs = Number(savedExtras.durationMs) || baseMs;
  if (!lengths.includes(lengthMs)) lengths.push(lengthMs), lengths.sort((a, b) => a - b);
  const secs = (ms) => (Math.round(ms / 100) / 10).toString().replace(/\.0$/, "") + " s";
  // Music: a library track under the whole video. Tracks an agent mixed
  // (several, with their own volumes) stay as they are unless replaced.
  const agentMix = Boolean((savedExtras.audios && savedExtras.audios.length) || (savedExtras.audioIds && savedExtras.audioIds.length));
  let musicId = agentMix ? "keep" : String(savedExtras.audioId || "");
  const tracks = () => store.library.filter((item) => item.kind === "audio");
  const musicLabel = () => (musicId === "keep" ? "Keep the agent's sound" : musicId ? ((tracks().find((t) => t.id === musicId) || {}).name || "Audio") : "No music");
  const applyExtras = () => {
    const next = Object.assign({}, savedExtras, { durationMs: lengthMs });
    if (musicId !== "keep") {
      delete next.audios;
      delete next.audioIds;
      if (musicId) Object.assign(next, { audioId: musicId, audioVolume: next.audioId === musicId && next.audioVolume != null ? next.audioVolume : 0.6, audioLoop: true });
      else {
        delete next.audioId;
        delete next.audioVolume;
        delete next.audioLoop;
      }
    }
    extra.extras = next;
  };
  applyExtras();
  const dialog = openDialog({
    title: p.label,
    wide: true,
    className: "design-dialog",
    body:
      '<div class="design-form">' +
      '<div class="design-preview"><div class="design-still" data-dz-still style="aspect-ratio:' + ratio.replace("/", " / ") + '">' + (src ? '<img src="' + src + '" alt="">' : "") + '<span class="design-still-wait" hidden>' + icon("loader", "spin") + "</span></div>" +
      '<div class="row design-preview-row"><button type="button" class="btn btn-sm" data-dz-play aria-label="Play the motion">' + icon("play", "i-sm") + "<span>Play</span></button>" +
      '<span class="faint grow design-hint">The preview follows your changes.</span></div>' +
      '<p class="faint design-about">' + esc(p.about || p.description) + "</p></div>" +
      '<div class="design-fields">' +
      // Frame first: it changes the preview the most.
      '<div class="field"><span class="field-label">Frame</span><div class="seg" data-dz-ratio>' +
      Object.keys(RATIO_LABEL).map((r) => '<button type="button" data-r="' + r + '"' + (r === ratio ? ' class="is-on"' : "") + ">" + RATIO_LABEL[r] + "</button>").join("") +
      "</div></div>" +
      fields +
      '<div class="field"><span class="field-label">Colors</span><div class="design-colors">' +
      [["primary", "Background"], ["secondary", "Accent"], ["text", "Text"]]
        .map(([k, l]) => '<label class="design-color"><input type="color" data-color="' + k + '" value="' + DEFAULT_COLORS[k] + '"><span>' + l + "</span></label>")
        .join("") +
      "</div></div>" +
      '<div class="field"><span class="field-label">Length</span><div class="seg" data-dz-len>' +
      lengths.map((ms) => '<button type="button" data-ms="' + ms + '"' + (ms === lengthMs ? ' class="is-on"' : "") + ">" + secs(ms) + "</button>").join("") +
      '<button type="button" data-ms-custom title="Type a length in seconds">Custom</button>' +
      "</div></div>" +
      '<div class="field"><span class="field-label">Music</span><div><button type="button" class="picker is-boxed" data-dz-music>' + icon("music", "i-sm") + '<span data-dz-music-label>' + esc(musicLabel()) + "</span>" + icon("chevDown", "i-sm chev") + "</button></div>" +
      '<div class="field-help" data-dz-music-help' + (tracks().length ? " hidden" : "") + '>Add a song in Library to use it here.</div></div>' +
      '<p class="design-status faint" data-dz-status role="status"></p>' +
      "</div></div>",
    foot:
      (editing ? "" : '<button type="button" class="btn" data-dz-ask title="Closes this form and puts the request in the Home box, where you can add anything the form cannot do">' + icon("bot") + "Customize with the agent</button>") +
      '<span class="grow"></span>' +
      '<button type="button" class="btn btn-primary" data-dz-make>' + icon(editing ? "refresh" : "sparkles") + (editing ? "Update video" : "Make video") + "</button>",
  });
  if (editing) {
    const d = existing.design;
    for (const input of dialog.querySelectorAll("[data-param]")) input.value = paramText(input.dataset.param, (d.params || {})[input.dataset.param]);
    for (const input of dialog.querySelectorAll("[data-color]")) if (d.colors && d.colors[input.dataset.color]) input.value = d.colors[input.dataset.color];
  }
  const colors = () => {
    const out = {};
    dialog.querySelectorAll("[data-color]").forEach((c) => (out[c.dataset.color] = c.value));
    return out;
  };
  // The preview follows the form: a moment after the person stops typing or
  // picks a color or frame, it shows their own version of the design.
  const still = dialog.querySelector("[data-dz-still]");
  let stillToken = 0;
  let stillTimer = null;
  // Play: the whole design in motion, small, looped three times, then back
  // to the finished pose. Any change to the form stops it and drops the
  // frames, since they no longer match.
  const playBtn = dialog.querySelector("[data-dz-play]");
  let motion = null; // { key, frames, intervalMs }
  let playTimer = null;
  let playToken = 0;
  let poseSrc = "";
  const formKey = () => JSON.stringify([readParams(dialog), colors(), ratio, lengthMs]);
  const setPlayLabel = (state) => {
    playBtn.innerHTML =
      state === "loading" ? icon("loader", "i-sm spin") + "<span>Loading</span>" : state === "playing" ? icon("pause", "i-sm") + "<span>Stop</span>" : icon("play", "i-sm") + "<span>Play</span>";
    playBtn.setAttribute("aria-label", state === "playing" ? "Stop the motion" : "Play the motion");
  };
  const stopPlay = () => {
    clearInterval(playTimer);
    playTimer = null;
    playToken += 1;
    const img = still.querySelector("img");
    if (img && poseSrc) img.src = poseSrc;
    setPlayLabel("idle");
    // Played before any still arrived: fetch the finished pose to stop on.
    if (!poseSrc && dialog.isConnected) void fetchStill();
  };
  const runLoop = () => {
    let img = still.querySelector("img");
    if (!img) {
      img = document.createElement("img");
      img.alt = "";
      still.prepend(img);
    }
    poseSrc = poseSrc || img.src;
    let i = 0;
    let loops = 0;
    setPlayLabel("playing");
    playTimer = setInterval(() => {
      if (!dialog.isConnected) return stopPlay();
      img.src = motion.frames[i];
      i += 1;
      if (i >= motion.frames.length) {
        i = 0;
        loops += 1;
        if (loops >= 3) stopPlay();
      }
    }, motion.intervalMs);
  };
  playBtn.addEventListener("click", async () => {
    if (playTimer) return stopPlay();
    // A second press while the frames load cancels the load.
    if (playBtn.querySelector(".spin")) return stopPlay();
    if (motion && motion.key === formKey()) return runLoop();
    const mine = ++playToken;
    const key = formKey();
    setPlayLabel("loading");
    try {
      const got = await api.animationPresetMotion(Object.assign({ preset: p.name, params: readParams(dialog), colors: colors(), aspectRatio: ratio }, extra));
      if (mine !== playToken || !dialog.isConnected) return;
      if (!got || !got.frames || !got.frames.length) return stopPlay();
      motion = { key, frames: got.frames, intervalMs: got.intervalMs || 83 };
      runLoop();
    } catch (error) {
      if (mine === playToken) {
        stopPlay();
        toast(errorText(error), true);
      }
    }
  });

  const refreshStill = () => {
    if (playTimer || playBtn.querySelector(".spin")) stopPlay();
    motion = null;
    poseSrc = "";
    clearTimeout(stillTimer);
    still.style.aspectRatio = ratio.replace("/", " / ");
    still.querySelector(".design-still-wait").hidden = false;
    stillTimer = setTimeout(() => {
      stillTimer = null;
      void fetchStill();
    }, 600);
  };
  async function fetchStill() {
    still.querySelector(".design-still-wait").hidden = false;
    const mine = ++stillToken;
    try {
      const url = await api.animationPresetStill(Object.assign({ preset: p.name, params: readParams(dialog), colors: colors(), aspectRatio: ratio }, extra));
      if (mine !== stillToken || !dialog.isConnected) return;
      // While the motion plays, a new still waits as the pose it returns to.
      if (url && playTimer) poseSrc = url;
      else if (url) {
        let img = still.querySelector("img");
        if (!img) {
          img = document.createElement("img");
          img.alt = "";
          still.prepend(img);
        }
        img.src = url;
      }
    } catch {
      /* the old picture stays */
    }
    if (mine === stillToken && dialog.isConnected) still.querySelector(".design-still-wait").hidden = true;
  }
  if (editing) refreshStill();
  dialog.querySelector(".design-fields").addEventListener("input", (event) => {
    if (event.target.closest("[data-param], [data-color]")) refreshStill();
  });
  const musicBtn = dialog.querySelector("[data-dz-music]");
  const paintMusic = () => {
    dialog.querySelector("[data-dz-music-label]").textContent = musicLabel();
    dialog.querySelector("[data-dz-music-help]").hidden = tracks().length > 0;
  };
  // The library may have changed since the window last loaded it.
  void refreshSnapshot()
    .then(() => {
      if (!dialog.isConnected) return;
      // A saved track that is no longer in the library would fail the render.
      if (musicId && musicId !== "keep" && !tracks().some((t) => t.id === musicId)) {
        musicId = "";
        applyExtras();
      }
      paintMusic();
    })
    .catch(() => {});
  musicBtn.addEventListener("click", () => {
    const pick = (id) => () => {
      musicId = id;
      applyExtras();
      paintMusic();
    };
    const items = [{ label: "No music", checked: !musicId, onSelect: pick("") }];
    if (agentMix) items.push({ label: "Keep the agent's sound", checked: musicId === "keep", onSelect: pick("keep") });
    if (tracks().length) items.push("sep", { heading: "From your library" });
    for (const t of tracks()) items.push({ label: t.name || "Audio", icon: "music", checked: musicId === t.id, onSelect: pick(t.id) });
    showMenu(musicBtn, items, { width: 280, search: tracks().length > 8 ? "Search music" : "" });
  });
  dialog.querySelector("[data-dz-len]").addEventListener("click", async (event) => {
    if (event.target.closest("[data-ms-custom]")) {
      const typed = await promptDialog({ title: "Video length", label: "Seconds (" + secs(minMs) + " to 60 s)", value: String(lengthMs / 1000), confirm: "Use it" });
      const s = Number(String(typed || "").replace(",", "."));
      if (!typed || !Number.isFinite(s)) return;
      const ms = Math.round(Math.min(60, Math.max(minMs / 1000, s)) * 10) * 100;
      const seg = dialog.querySelector("[data-dz-len]");
      if (!seg.querySelector('[data-ms="' + ms + '"]')) seg.querySelector("[data-ms-custom]").insertAdjacentHTML("beforebegin", '<button type="button" data-ms="' + ms + '">' + secs(ms) + "</button>");
      seg.querySelector('[data-ms="' + ms + '"]').click();
      return;
    }
    const b = event.target.closest("[data-ms]");
    if (!b || Number(b.dataset.ms) === lengthMs) return;
    lengthMs = Number(b.dataset.ms);
    dialog.querySelectorAll("[data-dz-len] [data-ms]").forEach((x) => x.classList.toggle("is-on", x === b));
    applyExtras();
    // The still is the finished pose, the same at any length; the motion
    // preview picks the new length up on the next Play.
    if (playTimer || playBtn.querySelector(".spin")) stopPlay();
    motion = null;
  });
  dialog.querySelector("[data-dz-ratio]").addEventListener("click", (event) => {
    const b = event.target.closest("[data-r]");
    if (!b || b.dataset.r === ratio) return;
    ratio = b.dataset.r;
    dialog.querySelectorAll("[data-dz-ratio] [data-r]").forEach((x) => x.classList.toggle("is-on", x === b));
    refreshStill();
  });
  dialog.querySelector("[data-dz-ask]")?.addEventListener("click", () => {
    const text = describe(p, readParams(dialog), colors(), ratio);
    closeDialog();
    opts.onAsk(text, ratio);
  });
  const make = dialog.querySelector("[data-dz-make]");
  make.addEventListener("click", async () => {
    const params = readParams(dialog);
    const status = dialog.querySelector("[data-dz-status]");
    make.disabled = true;
    make.innerHTML = icon("loader", "spin") + (editing ? "Updating" : "Making video");
    status.textContent = "Rendering the video. This usually takes under a minute.";
    let project = null;
    let madeOk = false;
    let made = null;
    try {
      const first = Object.values(params).find((v) => typeof v === "string");
      project = editing ? { id: existing.projectId } : await api.aiProjectCreate({ name: (first || p.label).slice(0, 48), aspectRatio: ratio, assetIds: [] });
      made = await api.animationPresetRender(Object.assign({ projectId: project.id, workspaceId: store.workspaceId, preset: p.name, params, colors: colors(), aspectRatio: ratio, name: p.label + (first ? ": " + first : "") }, extra));
      madeOk = true;
      if (made && made.scriptErrors && made.scriptErrors.length) toast("Some motion may be missing from this video. Type /fix in the chat to repair it.", true);
      else if (made && made.durationMs && made.durationMs > lengthMs + 50) toast("This design needs " + secs(made.durationMs) + ", so the video is that long.");
      // The video exists now: a refresh that fails must not keep the dialog
      // open, where a second click would make a second project.
      closeDialog();
      await Promise.all([refreshProjects(), refreshSnapshot()]);
      opts.onMade(project.id, made);
    } catch (error) {
      if (madeOk) {
        opts.onMade(project.id, made);
        return;
      }
      // A render that failed leaves no empty project behind; trying again
      // makes one fresh project, not a second.
      if (!editing && !madeOk && project && project.id) await api.aiProjectDelete({ id: project.id }).catch(() => {});
      make.disabled = false;
      make.innerHTML = icon(editing ? "refresh" : "sparkles") + (editing ? "Update video" : "Make video");
      status.textContent = "";
      toast(errorText(error), true);
    }
  });
}
