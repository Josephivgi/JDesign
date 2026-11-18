// The cut strip under the stage: the user's own hands on the same timeline
// the agent edits. Every change goes through jeditor_edit_timeline's code (IPC
// ai-project-edit-timeline), so the user and the agent share one cut, and each
// hand edit leaves a note the next chat message hands to the agent.

import { api } from "./store.js";
import { esc, icon, toast, showMenu, errorText } from "./ui.js";

const SPEEDS = [0.5, 0.75, 1, 1.5, 2, 3, 4];
const MIN_PART_MS = 100;
const DRAG_PX = 4;

function fmt(msValue) {
  const t = Math.max(0, Number(msValue) || 0) / 1000;
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return m + ":" + (s < 10 ? "0" : "") + s.toFixed(1);
}

function speedLabel(rate) {
  return (Math.round(rate * 100) / 100) + "×";
}

// The frame grid lib/video-timeline.js snaps a cut to (snapMsToFrame), so a
// selection made here lands on the same boundary the agent's cut does.
function snapToFrame(msValue, fps) {
  const value = Math.round(Number(msValue) || 0);
  const rate = Number(fps) || 0;
  if (!(rate > 0)) return value;
  return Math.round((Math.round((value * rate) / 1000) / rate) * 1000);
}

// frameMs in lib/video-timeline.js is the frame -> ms side of the same grid;
// frameAt is enough here because every move snaps back onto the grid.
function frameAt(msValue, fps) {
  const rate = Number(fps) || 0;
  if (!(rate > 0)) return 0;
  return Math.round((Number(msValue) || 0) * rate / 1000);
}

// The kept parts of a clip, the same reading normalizeSegments in
// lib/video-timeline.js makes: segments first, then legacy trim fields, then
// the whole clip.
export function keptParts(state, clipId, durationMs) {
  const edit = state && state.videoEdits && state.videoEdits[clipId];
  const dur = Number(durationMs) || 0;
  if (edit && Array.isArray(edit.segments) && edit.segments.length) {
    return edit.segments
      .map((s) => ({ startMs: Number(s.startMs) || 0, endMs: Math.min(Number(s.endMs) || 0, dur || Infinity), speed: Number(s.speed) || 1, muted: s.muted === true, volume: s.volume == null ? 1 : Number(s.volume) }))
      .filter((s) => s.endMs > s.startMs)
      .sort((a, b) => a.startMs - b.startMs);
  }
  if (!dur) return [];
  const start = edit && Number(edit.trimInMs) > 0 ? Number(edit.trimInMs) : 0;
  const end = edit && Number(edit.trimOutMs) > 0 ? Math.min(Number(edit.trimOutMs), dur) : dur;
  return end > start ? [{ startMs: start, endMs: end, speed: 1, muted: Boolean(edit && edit.muted), volume: edit && edit.volume != null ? Number(edit.volume) : 1 }] : [];
}

// Ops that turn any timeline into exactly these parts: start from the whole
// clip, cut the gaps, then set speed and sound per part.
function rebuildOps(parts, durationMs) {
  const ops = [{ type: "reset" }];
  let at = 0;
  for (const p of parts) {
    if (p.startMs - at >= 1) ops.push({ type: "cut", startMs: at, endMs: p.startMs });
    at = p.endMs;
  }
  if (durationMs - at >= 1) ops.push({ type: "cut", startMs: at, endMs: durationMs });
  for (const p of parts) {
    if (p.speed && p.speed !== 1) ops.push({ type: "speed", startMs: p.startMs, endMs: p.endMs, rate: p.speed });
    if (p.muted) ops.push({ type: "audio", startMs: p.startMs, endMs: p.endMs, muted: true });
    else if (p.volume != null && p.volume !== 1) ops.push({ type: "audio", startMs: p.startMs, endMs: p.endMs, volume: p.volume });
  }
  return ops;
}

export function mountCutStrip(el, ctx) {
  const st = {
    sel: null, // { startMs, endMs }
    busy: false,
    undo: [], // [{ clipId, parts }]
    sig: "",
    clipId: "",
    flash: 0,
    destroyed: false,
    cursor: null, // playhead the arrow keys move, in ms
    trackFocused: false, // the track has the keyboard
    playUntil: null, // where a keyboard play of the pick stops
  };

  const clip = () => ctx.getClip();
  // The source frame rate the timeline edit snaps to, when it is known.
  const fps = () => Number((clip() || {}).fps) || 0;
  const snap = (value) => snapToFrame(value, fps());
  const stepMs = () => (fps() > 0 ? 1000 / fps() : 100);
  const durationMs = () => {
    const c = clip();
    const fromItem = c && Number(c.durationMs);
    if (fromItem > 0) return fromItem;
    const p = ctx.getPlayer();
    const d = p && p.video && Number.isFinite(p.video.duration) ? p.video.duration : 0;
    return Math.round(d * 1000);
  };
  const parts = () => {
    const c = clip();
    const project = ctx.getProject();
    return c ? keptParts(project && project.state, c.id, durationMs()) : [];
  };
  const untouched = (list, dur) => list.length === 1 && list[0].startMs <= 0 && list[0].endMs >= dur - 1 && list[0].speed === 1 && !list[0].muted && list[0].volume === 1;

  const visible = () => {
    const c = clip();
    return Boolean(ctx.isSourceMode() && c && c.kind === "video" && ctx.getPlayer());
  };

  const pct = (value) => ((value / Math.max(1, durationMs())) * 100).toFixed(3) + "%";

  // Seconds, and the frames they land on when the source rate is known: what
  // the cut will say on the other side of the edit.
  const selText = () => {
    if (!st.sel) return "";
    const rate = fps();
    const base = fmt(st.sel.startMs) + " to " + fmt(st.sel.endMs);
    return rate > 0 ? base + " · frames " + frameAt(st.sel.startMs, rate) + " to " + frameAt(st.sel.endMs, rate) : base;
  };

  // One short line, not a tooltip: what the strip does, what the keys do, and
  // that the agent shares this cut.
  const hintText = () => {
    if (st.trackFocused) return "Arrows step one frame, Shift + arrow grows the pick, Enter plays it, Delete cuts, Escape clears.";
    if (st.sel) return "Delete cuts the picked stretch, Escape clears it. The agent is told what you changed.";
    return "Click or drag to pick a stretch, drag an edge to trim. Tab to the track for keys. The agent edits this same cut.";
  };

  const cursorMs = () => {
    if (st.cursor != null) return st.cursor;
    const p = ctx.getPlayer();
    st.cursor = snap(p && p.video ? p.video.currentTime * 1000 : 0);
    return st.cursor;
  };

  // ---------- painting ----------

  const paint = () => {
    if (st.destroyed) return;
    const show = visible();
    el.classList.toggle("hidden", !show);
    if (!show) {
      st.trackFocused = false;
      return;
    }
    const c = clip();
    const dur = durationMs();
    const list = parts();
    const sig = c.id + "|" + JSON.stringify(list);
    // A change that did not come from this strip came from the agent.
    if (st.sig && st.clipId === c.id && sig !== st.sig && !st.busy) {
      st.flash = Date.now();
      st.sel = null;
      setTimeout(() => { if (!st.destroyed) paint(); }, 4200);
    }
    if (st.clipId !== c.id) {
      st.sel = null;
      st.cursor = null;
      st.undo = st.undo.filter((u) => u.clipId === c.id);
    }
    st.sig = sig;
    st.clipId = c.id;
    const keptMs = list.reduce((sum, p) => sum + (p.endMs - p.startMs) / (p.speed || 1), 0);
    const agentChanged = Date.now() - st.flash < 4000;
    const summary = !(dur > 0)
      ? "Reading this clip's length"
      : untouched(list, dur)
        ? "Whole clip, " + fmt(dur)
        : list.length + (list.length === 1 ? " part" : " parts") + ", " + fmt(keptMs) + " of " + fmt(dur);
    const sel = st.sel;
    const selDis = st.busy || !sel ? " disabled" : "";
    const selMuted = sel && list.filter((p) => p.startMs < sel.endMs && p.endMs > sel.startMs).every((p) => p.muted);
    // An empty track says what it is for in one line instead of a bare bar.
    const trackBody = dur > 0
      ? list.map((p, i) =>
        '<div class="cut-part' + (p.muted ? " is-muted" : "") + '" data-part="' + i + '" style="left:' + pct(p.startMs) + ";width:" + pct(p.endMs - p.startMs) + '" title="' + esc(fmt(p.startMs) + " to " + fmt(p.endMs)) + '">' +
        '<span class="cut-edge is-l" data-edge="l" data-part="' + i + '" title="Drag to trim"></span>' +
        '<span class="cut-tags">' + (p.speed !== 1 ? "<b>" + esc(speedLabel(p.speed)) + "</b>" : "") + (p.muted ? icon("volumeX", "i-xs") : "") + "</span>" +
        '<span class="cut-edge is-r" data-edge="r" data-part="' + i + '" title="Drag to trim"></span></div>').join("") +
        (list.length ? "" : '<span class="cut-empty">Nothing kept from this clip yet. Restore brings the whole clip back.</span>') +
        (sel ? '<div class="cut-sel" data-cut-sel style="left:' + pct(sel.startMs) + ";width:" + pct(sel.endMs - sel.startMs) + '"></div>' : "") +
        '<div class="cut-played" data-cut-played></div>' +
        '<div class="cut-head-line" data-cut-playhead></div>'
      : '<span class="cut-empty">Reading this clip\'s length.</span>';
    el.innerHTML =
      '<div class="cut-head">' +
      "<strong>Your cut</strong>" +
      '<span class="cut-sum" data-cut-sum>' + esc(agentChanged ? "The agent changed the cut" : summary) + "</span>" +
      '<span class="grow"></span>' +
      '<span class="cut-selinfo" data-cut-selinfo' + (sel ? "" : " hidden") + ">" + esc(selText()) + "</span>" +
      '<button class="btn btn-sm" data-cut-act="cut" title="Remove the picked part from the video (Delete)"' + selDis + ">" + icon("scissors", "i-sm") + "<span>Cut</span></button>" +
      '<button class="btn btn-sm" data-cut-act="speed" title="Play the picked part faster or slower"' + selDis + ">" + icon("gauge", "i-sm") + "<span>Speed</span></button>" +
      '<button class="btn btn-sm" data-cut-act="mute" title="' + (selMuted ? "Bring back the sound of the picked part" : "Silence the picked part") + '"' + selDis + ">" + icon(selMuted ? "volume" : "volumeX", "i-sm") + "<span>" + (selMuted ? "Unmute" : "Mute") + "</span></button>" +
      '<span class="topbar-sep"></span>' +
      '<button class="icon-btn icon-btn-sm" data-cut-act="undo" title="Undo your last change here (Ctrl Z)" aria-label="Undo"' + (st.busy || !st.undo.length ? " disabled" : "") + ">" + icon("undo", "i-sm") + "</button>" +
      '<button class="icon-btn icon-btn-sm" data-cut-act="reset" title="Bring back the whole clip with no cuts" aria-label="Restore whole clip"' + (st.busy || untouched(list, dur) ? " disabled" : "") + ">" + icon("refresh", "i-sm") + "</button>" +
      "</div>" +
      '<div class="cut-track' + (dur > 0 ? "" : " is-empty") + (agentChanged ? " is-agent" : "") + (st.busy ? " is-busy" : "") + '" data-cut-track tabindex="0" role="group" aria-label="Cut timeline" aria-describedby="cut-hint">' +
      trackBody +
      "</div>" +
      '<div class="cut-hint" id="cut-hint" data-cut-hint aria-live="polite">' + esc(hintText()) + "</div>";
    const p = ctx.getPlayer();
    if (p && p.video) playhead(p.video.currentTime);
    // The track is rebuilt, so the keyboard stays where the person left it.
    if (st.trackFocused) {
      const track = el.querySelector("[data-cut-track]");
      if (track && document.activeElement !== track) track.focus({ preventScroll: true });
    }
  };

  const playhead = (seconds) => {
    const dur = durationMs();
    const line = el.querySelector("[data-cut-playhead]");
    // The length can arrive with the video metadata after the first paint; the
    // empty plate has no playhead, so that paint asks for a real one once.
    if (!line) {
      if (dur > 0 && !st.busy && visible()) paint();
      return;
    }
    const played = el.querySelector("[data-cut-played]");
    if (!dur) return;
    // A play started from the pick stops at its end, not at the clip's.
    if (st.playUntil != null && seconds * 1000 >= st.playUntil - 8) {
      st.playUntil = null;
      const p = ctx.getPlayer();
      if (p) p.video.pause();
    }
    const share = Math.max(0, Math.min(100, ((seconds * 1000) / dur) * 100));
    line.style.left = share + "%";
    if (played) played.style.width = share + "%";
  };

  // ---------- editing ----------

  const apply = async (ops, note) => {
    const c = clip();
    if (!c || st.busy) return false;
    const before = parts();
    st.busy = true;
    paint();
    try {
      const res = await api.aiProjectEditTimeline({ id: ctx.projectId, videoId: c.id, ops, note });
      st.undo.push({ clipId: c.id, parts: before });
      if (st.undo.length > 40) st.undo.shift();
      // Mark the new cut as ours before the editor repaints with it.
      st.sig = c.id + "|" + JSON.stringify(keptParts(res.project && res.project.state, c.id, durationMs()));
      st.sel = null;
      st.busy = false;
      ctx.onEdited(res.project);
      return true;
    } catch (error) {
      st.busy = false;
      paint();
      toast(errorText(error).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""), true);
      return false;
    }
  };

  const range = () => st.sel && { startMs: Math.round(st.sel.startMs), endMs: Math.round(st.sel.endMs) };

  const cutSelection = () => {
    const r = range();
    if (!r) return;
    void apply([{ type: "cut", startMs: r.startMs, endMs: r.endMs }], "cut out " + fmt(r.startMs) + " to " + fmt(r.endMs));
  };

  const setSpeed = (rate) => {
    const r = range();
    if (!r) return;
    void apply([{ type: "speed", startMs: r.startMs, endMs: r.endMs, rate }], "set " + fmt(r.startMs) + " to " + fmt(r.endMs) + " to " + speedLabel(rate) + " speed");
  };

  const toggleMute = () => {
    const r = range();
    if (!r) return;
    const hit = parts().filter((p) => p.startMs < r.endMs && p.endMs > r.startMs);
    const muted = !(hit.length && hit.every((p) => p.muted));
    void apply([{ type: "audio", startMs: r.startMs, endMs: r.endMs, muted }], (muted ? "muted " : "unmuted ") + fmt(r.startMs) + " to " + fmt(r.endMs));
  };

  const undo = () => {
    const c = clip();
    const last = st.undo.length ? st.undo[st.undo.length - 1] : null;
    if (!c || !last || last.clipId !== c.id || st.busy) return;
    const target = last.parts;
    void apply(rebuildOps(target, durationMs()), "undid their last change; the cut keeps " + target.map((p) => fmt(p.startMs) + " to " + fmt(p.endMs)).join(", ")).then((ok) => {
      // The undo itself is not something to undo back into.
      if (ok) st.undo.splice(-2, 2);
      paint();
    });
  };

  const resetAll = () => void apply([{ type: "reset" }], "restored the whole clip with no cuts, speed changes or muting");

  // ---------- pointer ----------

  const msAt = (clientX) => {
    const track = el.querySelector("[data-cut-track]");
    const r = track.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width))) * durationMs();
  };

  // A selection kept on the frame grid. A drag shorter than a frame still picks
  // one, so a small drag is never silently thrown away.
  const selectRange = (a, b) => {
    const dur = durationMs();
    if (!(dur > 0)) return;
    let startMs = snap(Math.min(a, b));
    let endMs = snap(Math.max(a, b));
    startMs = Math.max(0, Math.min(startMs, dur - 1));
    endMs = Math.max(startMs, Math.min(endMs, dur));
    if (endMs - startMs < 1) {
      const one = Math.max(1, Math.round(stepMs()));
      endMs = Math.min(dur, startMs + one);
      startMs = Math.max(0, Math.min(startMs, endMs - one));
    }
    st.sel = { startMs, endMs };
  };

  // Only the highlight, the readout and the three selection buttons change
  // while a drag or an arrow key runs, so the track is never rebuilt under the
  // hand (or under the keyboard focus).
  const paintSelection = () => {
    const info = el.querySelector("[data-cut-selinfo]");
    if (info) {
      info.textContent = selText();
      info.hidden = !st.sel;
    }
    el.querySelectorAll('[data-cut-act="cut"], [data-cut-act="speed"], [data-cut-act="mute"]').forEach((b) => {
      b.disabled = st.busy || !st.sel;
    });
    const track = el.querySelector("[data-cut-track]");
    if (!track) return;
    let box = track.querySelector("[data-cut-sel]");
    if (!st.sel || !(durationMs() > 0)) {
      if (box) box.remove();
      return;
    }
    if (!box) {
      box = document.createElement("div");
      box.className = "cut-sel";
      box.dataset.cutSel = "";
      track.insertBefore(box, track.querySelector("[data-cut-playhead]"));
    }
    box.style.left = pct(st.sel.startMs);
    box.style.width = pct(st.sel.endMs - st.sel.startMs);
  };

  const paintHint = () => {
    const hint = el.querySelector("[data-cut-hint]");
    if (hint) hint.textContent = hintText();
  };

  let drag = null;
  const onDown = (event) => {
    if (event.button !== 0 || st.busy) return;
    const track = event.target.closest("[data-cut-track]");
    if (!track || !(durationMs() > 0)) return;
    event.preventDefault();
    st.playUntil = null;
    track.focus({ preventScroll: true });
    const edge = event.target.closest("[data-edge]");
    drag = { x: event.clientX, startMs: snap(msAt(event.clientX)), moved: false, edge: edge ? edge.dataset.edge : "", part: edge ? Number(edge.dataset.part) : -1 };
    // Captured on the strip itself: it outlives the repaints of its insides.
    el.setPointerCapture(event.pointerId);
  };
  const onMove = (event) => {
    if (!drag) return;
    if (!drag.moved && Math.abs(event.clientX - drag.x) < DRAG_PX) return;
    drag.moved = true;
    const now = snap(msAt(event.clientX));
    if (drag.edge) {
      drag.toMs = now;
      const node = el.querySelector('.cut-part[data-part="' + drag.part + '"]');
      const list = parts();
      const p = list[drag.part];
      if (node && p) {
        const next = trimmed(list, drag.part, drag.edge, now)[drag.part];
        node.style.left = pct(next.startMs);
        node.style.width = pct(next.endMs - next.startMs);
      }
      return;
    }
    selectRange(drag.startMs, now);
    paintSelection();
  };
  const onUp = (event) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    const now = snap(msAt(event.clientX));
    if (d.edge && d.moved) {
      const list = parts();
      const next = trimmed(list, d.part, d.edge, now);
      const p = next[d.part];
      void apply(rebuildOps(next, durationMs()), "trimmed a part so it now runs " + fmt(p.startMs) + " to " + fmt(p.endMs));
      return;
    }
    if (d.moved) {
      // A drag that never left one frame is a click, not a pick.
      const minPick = fps() > 0 ? Math.round(stepMs()) : 40;
      if (st.sel && st.sel.endMs - st.sel.startMs < minPick) st.sel = null;
      paint();
      return;
    }
    // A click: move the playhead there and pick the kept part under it.
    const p = ctx.getPlayer();
    if (p) p.seek(now / 1000);
    st.cursor = now;
    const hit = parts().find((part) => now >= part.startMs && now <= part.endMs);
    st.sel = hit ? { startMs: hit.startMs, endMs: hit.endMs } : null;
    paint();
  };

  // A part with one edge moved, held between its neighbours and the clip. Trim
  // edges land on the same frame grid as cuts, so the strip and the agent
  // agree on where a part starts.
  function trimmed(list, index, side, toMs) {
    const copy = list.map((p) => Object.assign({}, p));
    const p = copy[index];
    const prevEnd = index > 0 ? copy[index - 1].endMs : 0;
    const nextStart = index < copy.length - 1 ? copy[index + 1].startMs : durationMs();
    const at = snap(toMs);
    if (side === "l") p.startMs = Math.max(prevEnd, Math.min(at, p.endMs - MIN_PART_MS));
    else p.endMs = Math.min(nextStart, Math.max(at, p.startMs + MIN_PART_MS));
    return copy;
  }

  const onClick = (event) => {
    const btn = event.target.closest("[data-cut-act]");
    if (!btn || btn.disabled) return;
    const act = btn.dataset.cutAct;
    if (act === "cut") cutSelection();
    else if (act === "mute") toggleMute();
    else if (act === "undo") undo();
    else if (act === "reset") resetAll();
    else if (act === "speed") {
      const r = range();
      const hit = r ? parts().filter((p) => p.startMs < r.endMs && p.endMs > r.startMs) : [];
      const current = hit.length && hit.every((p) => p.speed === hit[0].speed) ? hit[0].speed : null;
      showMenu(btn, SPEEDS.map((rate) => ({ label: speedLabel(rate) + (rate === 1 ? " (normal)" : ""), checked: rate === current, onSelect: () => setSpeed(rate) })), { above: true });
    }
  };

  el.addEventListener("pointerdown", onDown);
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointercancel", () => { drag = null; paint(); });
  el.addEventListener("click", onClick);

  // ---------- keyboard ----------
  // The track is the focus stop. Arrows move a playhead, or step the pick by
  // one frame when one is picked; Shift grows it; Enter plays it; Delete cuts;
  // Escape clears. None of these bubble: the page has its own keys.
  const onKeyDown = (event) => {
    if (!event.target.closest || !event.target.closest("[data-cut-track]")) return;
    const dur = durationMs();
    if (!(dur > 0)) return;
    const step = stepMs();
    const clamp = (value) => Math.max(0, Math.min(dur, value));
    const key = event.key;
    if (key === "ArrowLeft" || key === "ArrowRight") {
      event.preventDefault();
      event.stopPropagation();
      const dir = key === "ArrowRight" ? 1 : -1;
      if (!st.sel) {
        if (!event.shiftKey) {
          // No pick yet: the arrow moves the playhead one frame.
          st.cursor = snap(clamp(cursorMs() + dir * step));
          const p = ctx.getPlayer();
          if (p) p.seek(st.cursor / 1000);
          return;
        }
        const at = cursorMs();
        selectRange(at, at + dir * step);
      } else if (event.shiftKey) {
        if (dir > 0) selectRange(st.sel.startMs, st.sel.endMs + step);
        else selectRange(st.sel.startMs - step, st.sel.endMs);
      } else {
        // The whole pick moves and keeps its length.
        const width = st.sel.endMs - st.sel.startMs;
        const startMs = snap(Math.max(0, Math.min(dur - width, st.sel.startMs + dir * step)));
        st.sel = { startMs, endMs: startMs + width };
        st.cursor = startMs;
        const p = ctx.getPlayer();
        if (p) p.seek(startMs / 1000);
      }
      paintSelection();
      return;
    }
    if (key === "Enter" || key === " " || key === "Spacebar") {
      event.preventDefault();
      event.stopPropagation();
      const p = ctx.getPlayer();
      if (!p) return;
      if (p.video.paused) {
        const at = st.sel ? st.sel.startMs : cursorMs();
        p.seek(at / 1000);
        st.cursor = at;
        // With a pick, play just that stretch and stop at its end.
        st.playUntil = st.sel ? st.sel.endMs : null;
      } else {
        st.playUntil = null;
      }
      p.toggle();
      return;
    }
    if (key === "Delete" || key === "Backspace") {
      if (!st.sel || st.busy) return;
      event.preventDefault();
      event.stopPropagation();
      cutSelection();
      return;
    }
    if (key === "Escape" && st.sel) {
      event.preventDefault();
      event.stopPropagation();
      st.sel = null;
      st.playUntil = null;
      paint();
    }
  };
  el.addEventListener("keydown", onKeyDown);
  el.addEventListener("focusin", (event) => {
    if (!event.target.closest || !event.target.closest("[data-cut-track]")) return;
    st.trackFocused = true;
    paintHint();
  });
  el.addEventListener("focusout", (event) => {
    if (!event.target.closest || !event.target.closest("[data-cut-track]")) return;
    st.trackFocused = false;
    paintHint();
  });

  // ---------- preview playback ----------

  // While the Original plays, skip what the cut removes and play each part at
  // its speed and sound, so the user hears and sees their cut right away.
  const steer = (video, baseRate, baseMuted, loop) => {
    if (!visible() || video.paused) return;
    const dur = durationMs();
    const list = parts();
    if (!list.length || untouched(list, dur)) {
      if (video.playbackRate !== baseRate) video.playbackRate = baseRate;
      if (video.muted !== baseMuted) video.muted = baseMuted;
      return;
    }
    const t = video.currentTime * 1000;
    const here = list.find((p) => t >= p.startMs && t < p.endMs);
    if (here) {
      const rate = baseRate * (here.speed || 1);
      if (Math.abs(video.playbackRate - rate) > 0.001) video.playbackRate = rate;
      const muted = baseMuted || here.muted;
      if (video.muted !== muted) video.muted = muted;
      return;
    }
    const next = list.find((p) => p.startMs > t);
    if (next) video.currentTime = (next.startMs + 1) / 1000;
    else if (loop) video.currentTime = (list[0].startMs + 1) / 1000;
    else {
      video.pause();
      video.currentTime = list[list.length - 1].endMs / 1000;
    }
  };

  return {
    paint,
    playhead,
    steer,
    hasSelection: () => Boolean(st.sel) && visible(),
    clearSelection: () => {
      st.playUntil = null;
      if (!st.sel) return;
      st.sel = null;
      paint();
    },
    cutSelection,
    undo,
    canUndo: () => visible() && st.undo.length > 0,
    destroy: () => {
      st.destroyed = true;
    },
  };
}
