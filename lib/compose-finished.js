const fs = require("fs");
const os = require("os");
const path = require("path");
const { getLibraryItem, libraryFilePath } = require("./library-io");
const { copyPathIntoFinished } = require("./finished-io");
const { loadState, loadWorkspace, defaultCard } = require("./workspace-store");
const {
  findFfmpeg,
  findFont,
  runFfmpeg,
  probeMedia,
  renderCardPng,
  renderCardOverlayPng,
  resolveCardMedia,
  cardPlacement,
  cardDurationMs,
  buildCardGraph,
  ffColor,
  htmlCardDataUris,
} = require("./card-render");
const { cardIsHtml, cardHasMotion, hasCssAnimation, buildCardDocument, normalizeMotion } = require("./html-card");

const SCRIM = {
  solid: (card) => ffColor(card.colors && card.colors.primary, 0.5),
  soft: () => "0xFFFFFF@0.45",
  transparent: () => "0x0A0F1A@0.5",
};

// An overlay card draws its elements over the footage inside a translucent
// scrim tinted by the card's surface; the card's opaque surface/background is
// not used  -  the video itself is the base.
function overlayScrim(card) {
  const composition = (card && card.composition) || {};
  const make = SCRIM[composition.surface] || SCRIM.transparent;
  return make(card);
}

async function cardsForCompose(opts, ws) {
  const cards = Array.isArray(ws.cards) ? ws.cards : [];
  if (opts.cardId) {
    const found = cards.find((entry) => entry && entry.id === opts.cardId);
    if (!found) throw new Error("Card not found.");
    return [found];
  }
  return cards.filter(Boolean);
}

function ephemeralCard(opts) {
  const card = defaultCard();
  card.name = opts.name || "Ad-hoc card";
  card.composition.headline = opts.headline || "";
  card.composition.body = opts.body || "";
  card.composition.cta = opts.cta || "";
  card.placement = "intro";
  card.durationMs = Math.min(10000, Math.max(1500, Number(opts.cardSeconds) * 1000 || 3000));
  return card;
}

function segmentSpec(card) {
  const placement = cardPlacement(card);
  return { card, placement, durationMs: cardDurationMs(card) };
}

function n2(v) {
  return Number(v).toFixed(2);
}

// Smoothstep eased progress from 0 to 1 over [start, start+dur], in overlay
// expression form. t is the frame's seconds.
function easeExpr(start, dur) {
  const p = "clip((t-" + n2(start) + ")/" + Math.max(0.05, dur).toFixed(2) + ",0,1)";
  return "(" + p + "*" + p + "*(3-2*" + p + "))";
}

// The opposite ease for an exit over [end-dur, end].
function easeOutExpr(end, dur) {
  const p = "clip((" + n2(end) + "-t)/" + Math.max(0.05, dur).toFixed(2) + ",0,1)";
  return "(" + p + "*" + p + "*(3-2*" + p + "))";
}

// Builds the per-card overlay filter pieces for a card rendered as a single
// transparent layer: input prep (scale for pop, alpha fades), then the
// overlay x/y expressions for slide, rise, and drop. Motion presets are
// {in,out} over the card's own window; "none" anywhere leaves that edge
// static, and a card with no motion at all draws as a plain gated overlay.
function overlayMotionFilters(idx, card, window, dims, opts) {
  const options = opts || {};
  const motion = normalizeMotion(card && card.motion);
  const dur = Math.max(0.2, window.end - window.start);
  const dIn = Math.min(0.4, dur * 0.35);
  const dOut = Math.min(0.4, dur * 0.35);
  const pre = [options.prepPrefix ? options.prepPrefix + ",format=rgba" : "format=rgba"];
  let scaleExpr = null;
  const fades = [];
  let xShift = "0";
  let yShift = "0";

  // Moving entrances and exits fade too (over the first 60 percent of the
  // move), so a card glides in instead of jumping in already opaque.
  const MOVES = ["rise", "drop", "slide", "pop"];
  if (motion.in === "fade") fades.push("fade=t=in:st=" + n2(window.start) + ":d=" + n2(dIn) + ":alpha=1");
  else if (MOVES.includes(motion.in)) fades.push("fade=t=in:st=" + n2(window.start) + ":d=" + n2(dIn * 0.6) + ":alpha=1");
  if (motion.out === "fade") fades.push("fade=t=out:st=" + n2(window.end - dOut) + ":d=" + n2(dOut) + ":alpha=1");
  else if (MOVES.includes(motion.out)) fades.push("fade=t=out:st=" + n2(window.end - dOut * 0.6) + ":d=" + n2(dOut * 0.6) + ":alpha=1");

  const eIn = easeExpr(window.start, dIn);
  const eOut = easeOutExpr(window.end, dOut);
  if (motion.in === "slide") xShift += "-(1-" + eIn + ")*W";
  if (motion.out === "slide") xShift += "-(1-" + eOut + ")*W";
  if (motion.in === "rise") yShift += "+(1-" + eIn + ")*0.12*H";
  if (motion.out === "rise") yShift += "-(1-" + eOut + ")*0.12*H";
  if (motion.in === "drop") yShift += "-(1-" + eIn + ")*0.12*H";
  if (motion.out === "drop") yShift += "+(1-" + eOut + ")*0.12*H";
  if (motion.in === "pop" || motion.out === "pop") {
    const inF = motion.in === "pop" ? "(0.8+0.2*" + eIn + ")" : "1";
    const outF = motion.out === "pop" ? "(1-0.15*(1-" + eOut + "))" : "1";
    scaleExpr = "iw*(" + inF + "*" + outF + ")";
  }

  const label = "ovp" + idx;
  const gate = ":enable='between(t," + n2(window.start) + "," + n2(window.end) + ")'";
  // Full-frame title cards anchor centered so slide/rise/drop move the whole
  // card block over its background; footage overlays anchor at the corner.
  let x = options.centered ? "(W-w)/2" : "0";
  let y = options.centered ? "(H-h)/2" : "0";
  if (scaleExpr) {
    pre.push("scale=w='" + scaleExpr + "':h='" + scaleExpr.replace(/iw/g, "ih") + "':eval=frame");
    x = "(W-w)/2";
    y = "(H-h)/2";
  }
  x += xShift === "0" ? "" : xShift;
  y += yShift === "0" ? "" : yShift;
  const parts = pre.concat(fades);
  return {
    prep: "[" + idx + ":v]" + parts.join(",") + "[" + label + "]",
    overlay: "overlay=x='" + x + "':y='" + y + "'" + gate,
    label,
  };
}

async function resolveAudioOverlay(opts, dataRoot, workspaceId) {
  const audioId = String(opts.audioId || "").trim();
  if (!audioId) return null;
  const item = await getLibraryItem(dataRoot, audioId, workspaceId);
  if (!item || item.kind !== "audio") throw new Error("audioId must name a library audio item.");
  const file = libraryFilePath(dataRoot, workspaceId, item);
  if (!fs.existsSync(file)) throw new Error("The audio file is missing on disk.");
  const volume = Math.max(0, Math.min(4, Number(opts.audioVolume == null ? 1 : opts.audioVolume)));
  const duck = opts.duck == null || opts.duck === false ? 1 : Math.max(0, Math.min(1, opts.duck === true ? 0.3 : Number(opts.duck)));
  const startMs = Math.max(0, Math.round(Number(opts.startMs) || 0));
  const scene = Number.isInteger(Number(opts.scene)) && Number(opts.scene) > 0 ? Number(opts.scene) : 0;
  return { file, volume, duck: duck < 1 ? duck : null, loop: opts.audioLoop === true, name: item.name, audioId, startMs, scene, durationMs: Number(item.durationMs) || 0 };
}

// One track (audioId + its gains) or several: audioIds alone, or an audios
// array carrying per-track volume, loop, and duck. A voiceover under music is
// one call, not two renders.
async function resolveAudioTracks(opts, dataRoot, workspaceId) {
  const o = opts || {};
  const list = [];
  if (Array.isArray(o.audios)) {
    for (const track of o.audios) {
      if (track && typeof track === "object" && String(track.audioId || "").trim()) {
        list.push({
          audioId: String(track.audioId).trim(),
          audioVolume: track.volume == null ? track.audioVolume : track.volume,
          audioLoop: track.loop == null ? track.audioLoop : track.loop,
          duck: track.duck,
          track: track.track,
          startMs: track.startMs,
          scene: track.scene,
        });
      }
    }
  } else if (Array.isArray(o.audioIds)) {
    for (const id of o.audioIds) {
      const audioId = String(id || "").trim();
      if (audioId) list.push({ audioId, audioVolume: o.audioVolume, audioLoop: o.audioLoop, duck: o.duck });
    }
  } else if (String(o.audioId || "").trim()) {
    list.push(o);
  }
  const resolved = [];
  for (const track of list) {
    const one = await resolveAudioOverlay(track, dataRoot, workspaceId);
    if (one) {
      if (track.track) one.track = track.track;
      resolved.push(one);
    }
  }
  return resolved;
}

async function composeFinished(options) {
  const opts = options || {};
  const dataRoot = opts.dataRoot;
  if (!dataRoot) throw new Error("dataRoot is required");
  const videoId = String(opts.videoId || "").trim();
  if (!videoId) throw new Error("videoId is required");

  // Validate the ids before the ffmpeg lookup: a missing card or video is a
  // fixable agent mistake and must error clearly even when ffmpeg is absent.
  const state = await loadState(dataRoot);
  const workspaceId = opts.workspaceId || state.activeWorkspaceId;
  const item = await getLibraryItem(dataRoot, videoId, workspaceId);
  if (!item || item.kind !== "video") throw new Error("Library video not found.");
  const source = libraryFilePath(dataRoot, workspaceId, item);
  if (!fs.existsSync(source)) throw new Error("Library video file is missing.");

  const ws = await loadWorkspace(dataRoot, workspaceId);
  let cards = await cardsForCompose(opts, ws);
  if (!cards.length && (opts.headline || opts.body || opts.cta)) {
    cards = [ephemeralCard(opts)];
  }
  // Resolved once the ffmpeg path is known; recorded on the finished item below.
  let resolvedAudio = [];

  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error("ffmpeg is not installed. Finished compose needs ffmpeg on this computer.");
  const font = findFont();

  const media = await probeMedia(ffmpeg, source);
  // yuv420p needs even dimensions, and a source with an odd side (a crop from
  // another tool) would otherwise fail the encode after the whole graph ran.
  const even = (value, fallback) => {
    const n = Math.round(Number(value) || 0) || fallback;
    return Math.max(2, n - (n % 2));
  };
  const dims = { w: even(media.width, 1280), h: even(media.height, 720) };
  const hasAudio = media.hasAudio;
  const sourceDurMs = media.durationMs || 0;
  const capMs = Math.min(300000, Math.max(1000, Number(opts.seconds) * 1000 || sourceDurMs || 15000));
  const mainMs = Math.min(capMs, sourceDurMs || capMs);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cutline-compose-"));
  const cleanup = [];
  const tmpOut = path.join(tempRoot, "finished.mp4");
  try {
    // Split cards by placement. opts.placement overrides a single card's
    // authored placement so the same design can be tested in each slot.
    const segments = { intro: [], overlay: [], end: [] };
    for (const card of cards) {
      const spec = segmentSpec(card);
      const placement = opts.placement && cards.length === 1 ? String(opts.placement) : spec.placement;
      if (segments[placement]) segments[placement].push({ card, durationMs: spec.durationMs });
      else segments.intro.push({ card, durationMs: spec.durationMs });
    }

    const inputs = [{ file: source }];
    const filters = [];

    // Overlay cards draw on the footage inside sequential time windows. Each
    // gets a translucent scrim tinted by its surface plus its own design
    // elements, all gated by between(t, start, end).
    let mainLabel = "0:v";
    let overlayCursor = 0;
    for (let i = 0; i < segments.overlay.length; i += 1) {
      const seg = segments.overlay[i];
      const start = overlayCursor / 1000;
      const end = start + seg.durationMs / 1000;
      overlayCursor += seg.durationMs;
      const gate = ":enable='between(t," + start.toFixed(2) + "," + end.toFixed(2) + ")'";
      const baseLabel = "oscrim" + i;
      const html = cardIsHtml(seg.card);
      const animated = html && hasCssAnimation(seg.card);
      const layered = html || cardHasMotion(seg.card);
      // HTML cards own their backdrop through CSS, so they skip the scrim.
      // FFmpeg-designed overlays keep the translucent tint behind them.
      if (!html) {
        filters.push(
          "[" +
            mainLabel +
            "]drawbox=x=0:y=0:w=iw:h=ih:color=" +
            overlayScrim(seg.card) +
            ":t=fill" +
            gate +
            "[" +
            baseLabel +
            "]",
        );
      } else {
        filters.push("[" + mainLabel + "]null[" + baseLabel + "]");
      }
      if (animated) {
        // CSS-animated HTML: rasterize each frame and play the sequence over
        // the window. The page clock is seeked per frame so keyframes land
        // exactly on video time.
        const doc = buildCardDocument(seg.card, {
          imageDataUris: await htmlCardDataUris(seg.card, dataRoot, workspaceId),
          transparent: true,
        });
        const seqDir = path.join(tempRoot, "ovseq-" + i);
        fs.mkdirSync(seqDir, { recursive: true });
        const { renderHtmlSequence } = require("./html-render");
        const seq = await renderHtmlSequence({
          doc,
          width: dims.w,
          height: dims.h,
          durationMs: seg.durationMs,
          transparent: true,
          outDir: seqDir,
          appRoot: opts.appRoot,
          tempRoot,
        });
        inputs.push({ seq: path.join(seq.dir, seq.pattern), fps: seq.fps, itsoffset: start });
        const idx = inputs.length - 1;
        // The same motion path as PNG overlays: a CSS-animated card with fade,
        // slide, rise, drop, or pop presets gets them on top of its keyframes.
        const parts = overlayMotionFilters(idx, seg.card, { start, end }, dims);
        filters.push(parts.prep);
        const out = "ovm" + i;
        filters.push("[" + baseLabel + "][" + parts.label + "]" + parts.overlay + "[" + out + "]");
        mainLabel = out;
      } else if (layered) {
        // One-layer overlays: HTML stills and every card with motion presets
        // render to a transparent PNG at the video's frame size, then the
        // whole card fades, slides, rises, drops, or pops through its window.
        const png = await renderCardOverlayPng({
          dataRoot,
          workspaceId,
          card: seg.card,
          dims,
          ffmpeg,
          font,
          outPath: path.join(tempRoot, "overlay-" + i + ".png"),
          appRoot: opts.appRoot,
          tempRoot,
        });
        // itsoffset puts the still on the overlay window's clock: the fade and
        // scale prep filters evaluate t against this stream's own timestamps,
        // so without the shift every motion preset only worked on the first
        // overlay card (windows that start at t=0).
        inputs.push({ file: png.path, loop: true, itsoffset: start });
        const idx = inputs.length - 1;
        const parts = overlayMotionFilters(idx, seg.card, { start, end }, dims);
        filters.push(parts.prep);
        const out = "ovm" + i;
        filters.push("[" + baseLabel + "][" + parts.label + "]" + parts.overlay + "[" + out + "]");
        mainLabel = out;
      } else {
        const ctx = await resolveCardMedia(seg.card, { dataRoot, workspaceId });
        if (ctx.drawingTemp) cleanup.push(ctx.drawingTemp);
        const graph = buildCardGraph(seg.card, dims, {
          font,
          images: ctx.images,
          drawingFile: ctx.drawingFile,
          noBase: true,
          baseLabel,
          labelPrefix: "ov" + i + "_",
          window: { start, end },
          inputs,
        });
        filters.push(...graph.filters);
        mainLabel = graph.out;
      }
    }
    const vMain = "vmain";
    filters.push(
      "[" + mainLabel + "]trim=duration=" + (mainMs / 1000).toFixed(2) + ",setpts=PTS-STARTPTS,fps=30[" + vMain + "]",
    );

    // Intro/end cards render at their design resolution, then fit the output
    // frame and are padded (never cropped) to it, so the copy a person saw in
    // the card still is the copy in the clip. Animated HTML cards come in as
    // frame sequences; everything else is a still.
    const cardSegments = [];
    for (const which of ["intro", "end"]) {
      for (const seg of segments[which]) {
        const animated = cardIsHtml(seg.card) && hasCssAnimation(seg.card);
        const moving = cardHasMotion(seg.card);
        const entry = { which, card: seg.card, durationMs: seg.durationMs, moving };
        if (animated) {
          const doc = buildCardDocument(seg.card, {
            imageDataUris: await htmlCardDataUris(seg.card, dataRoot, workspaceId),
            // A moving title card sits on its own background color, so the
            // frames can stay alpha-clear and the whole card can fade.
            transparent: moving,
          });
          const seqDir = path.join(tempRoot, "segseq-" + cardSegments.length);
          fs.mkdirSync(seqDir, { recursive: true });
          const { renderHtmlSequence } = require("./html-render");
          const { renderSize, aspectOf } = require("./card-render");
          const size = renderSize(aspectOf(seg.card));
          const seq = await renderHtmlSequence({
            doc,
            width: size.w,
            height: size.h,
            durationMs: seg.durationMs,
            transparent: moving,
            outDir: seqDir,
            appRoot: opts.appRoot,
            tempRoot,
          });
          inputs.push({ seq: path.join(seq.dir, seq.pattern), fps: seq.fps });
          entry.inputIdx = inputs.length - 1;
        } else {
          const png = await renderCardPng({
            dataRoot,
            workspaceId,
            card: seg.card,
            outPath: path.join(tempRoot, "card-" + cardSegments.length + ".png"),
            ffmpeg,
            font,
            appRoot: opts.appRoot,
            tempRoot,
          });
          inputs.push({ file: png.path, loop: true });
          entry.inputIdx = inputs.length - 1;
        }
        if (moving) {
          // The pad color becomes the segment's background; the card block
          // fades, slides, rises, drops, or pops on top of it.
          const pad = ffColor(seg.card.colors && seg.card.colors.primary) || "0x000000";
          const secs = (seg.durationMs / 1000).toFixed(2);
          inputs.push({ lavfi: "color=c=" + pad + ":s=" + dims.w + "x" + dims.h + ":d=" + secs + ":r=30" });
          entry.baseIdx = inputs.length - 1;
        }
        cardSegments.push(entry);
      }
    }

    const concatParts = [];
    const audioParts = [];
    cardSegments.forEach((seg, i) => {
      const v = "vseg" + i;
      const secs = (seg.durationMs / 1000).toFixed(2);
      const pad = ffColor(seg.card.colors && seg.card.colors.primary) || "black";
      if (seg.moving) {
        // Fit the card (PNG or animation frames) to the output frame without
        // padding: the pad is the lavfi base the card moves over.
        const fit = "scale=" + dims.w + ":" + dims.h + ":force_original_aspect_ratio=decrease,setsar=1";
        const parts = overlayMotionFilters(seg.inputIdx, seg.card, { start: 0, end: seg.durationMs / 1000 }, dims, {
          centered: true,
          prepPrefix: fit,
        });
        filters.push("[" + seg.baseIdx + ":v]format=rgba,setsar=1[sgb" + i + "]");
        filters.push(parts.prep);
        filters.push("[sgb" + i + "][" + parts.label + "]" + parts.overlay + "[vov" + i + "]");
        filters.push("[vov" + i + "]trim=duration=" + secs + ",setpts=PTS-STARTPTS,fps=30,format=yuv420p[" + v + "]");
      } else {
        filters.push(
          "[" +
            seg.inputIdx +
            ":v]scale=" +
            dims.w +
            ":" +
            dims.h +
            ":force_original_aspect_ratio=decrease:flags=lanczos,pad=" +
            dims.w +
            ":" +
            dims.h +
            ":(ow-iw)/2:(oh-ih)/2:" +
            pad +
            ",setsar=1,fps=30,trim=duration=" +
            secs +
            ",setpts=PTS-STARTPTS[" +
            v +
            "]",
        );
      }
      concatParts.push("[" + v + "]");
      if (hasAudio) {
        const a = "aseg" + i;
        inputs.push({ lavfi: "anullsrc=r=48000:cl=stereo:d=" + secs });
        const aidx = inputs.length - 1;
        filters.push("[" + aidx + ":a]aformat=channel_layouts=stereo[" + a + "]");
        audioParts.push("[" + a + "]");
      }
    });

    // Order: intro segments, main video, end segments.
    const ordered = concatParts.slice(0, segments.intro.length);
    const orderedAudio = audioParts.slice(0, segments.intro.length);
    ordered.push("[" + vMain + "]");
    if (hasAudio) {
      filters.push(
        "[0:a]aresample=48000,aformat=channel_layouts=stereo,atrim=duration=" +
          (mainMs / 1000).toFixed(2) +
          ",asetpts=PTS-STARTPTS[amain]",
      );
      orderedAudio.push("[amain]");
    }
    ordered.push(...concatParts.slice(segments.intro.length));
    orderedAudio.push(...audioParts.slice(segments.intro.length));

    const total = ordered.length;
    let audioBase = "";
    if (hasAudio) {
      const interleaved = [];
      ordered.forEach((v, i) => {
        interleaved.push(v, orderedAudio[i]);
      });
      filters.push(interleaved.join("") + "concat=n=" + total + ":v=1:a=1[vout][abase]");
      audioBase = "abase";
    } else {
      filters.push(ordered.join("") + "concat=n=" + total + ":v=1:a=0[vout]");
    }
    const totalSecs = (mainMs + cardSegments.reduce((a, s) => a + s.durationMs, 0)) / 1000;
    filters.push(
      "[vout]fade=t=in:st=0:d=0.3,fade=t=out:st=" + Math.max(0.2, totalSecs - 0.4).toFixed(2) + ":d=0.35,format=yuv420p[v]",
    );

    // A voiceover or music bed mixes over the finished audio: duck lowers the
    // footage track under them, audioLoop repeats a short bed for the length.
    // Several tracks mix together, with normalize=0 so none of them is halved.
    let audioOut = audioBase;
    const audioTracks = await resolveAudioTracks(opts, dataRoot, workspaceId);
    resolvedAudio = audioTracks;
    if (audioTracks.length) {
      const labels = [];
      audioTracks.forEach((track, i) => {
        inputs.push({ file: track.file, streamLoop: track.loop });
        const aidx = inputs.length - 1;
        const label = "vox" + (audioTracks.length === 1 ? "" : String(i));
        const voxChain =
          "[" +
          aidx +
          ":a]aresample=48000,aformat=channel_layouts=stereo,atrim=duration=" +
          totalSecs.toFixed(2) +
          ",asetpts=PTS-STARTPTS" +
          (track.volume !== 1 ? ",volume=" + track.volume.toFixed(3) : "") +
          "[" +
          label +
          "]";
        filters.push(voxChain);
        labels.push("[" + label + "]");
      });
      // The deepest duck wins, so the footage gets out of the way of both.
      const duck = Math.min.apply(null, audioTracks.map((track) => (track.duck == null ? 1 : track.duck)));
      if (audioBase) {
        let base = audioBase;
        if (duck < 1) {
          filters.push("[" + audioBase + "]volume=" + duck.toFixed(3) + "[aduck]");
          base = "aduck";
        }
        // normalize=0 keeps each track at its own level: amix's default
        // normalize=1 divides every input by the input count, which made a
        // voiceover 6 dB quieter than the file the user picked.
        filters.push(
          "[" + base + "]" + labels.join("") + "amix=inputs=" + (labels.length + 1) + ":duration=first:dropout_transition=0:normalize=0[aout]",
        );
        audioOut = "aout";
      } else if (labels.length === 1) {
        filters.push(labels[0] + "anull[aout]");
        audioOut = "aout";
      } else {
        filters.push(labels.join("") + "amix=inputs=" + labels.length + ":duration=first:dropout_transition=0:normalize=0[aout]");
        audioOut = "aout";
      }
    }

    const args = ["-y"];
    for (const input of inputs) {
      if (input.lavfi) args.push("-f", "lavfi", "-i", input.lavfi);
      else if (input.seq) {
        if (input.itsoffset) args.push("-itsoffset", input.itsoffset.toFixed(2));
        args.push("-framerate", String(input.fps || 24), "-start_number", "1", "-i", input.seq);
      } else if (input.streamLoop) args.push("-stream_loop", "-1", "-i", input.file);
      else if (input.loop) {
        if (input.itsoffset) args.push("-itsoffset", input.itsoffset.toFixed(2));
        args.push("-loop", "1", "-i", input.file);
      }
      else args.push("-i", input.file);
    }
    args.push("-filter_complex", filters.join(";"));
    args.push("-map", "[v]");
    if (audioOut) args.push("-map", "[" + audioOut + "]", "-c:a", "aac", "-b:a", "160k");
    else args.push("-an");
    // One deliverable encode: High profile, yuv420p, faststart. crf 20 is the
    // point where burned card text stops showing mosquito noise over footage;
    // the preset stays medium (the x264 default) so a compose costs the same.
    args.push(
      "-c:v", "libx264",
      "-preset", "medium",
      "-crf", "20",
      "-profile:v", "high",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "-r", "30",
      tmpOut,
    );

    await runFfmpeg(ffmpeg, args, 420000);
    if (!fs.existsSync(tmpOut) || fs.statSync(tmpOut).size < 32) {
      throw new Error("ffmpeg did not write a clip.");
    }

    const name = String(opts.name || (cards[0] && cards[0].name) || item.name + " ad").trim() || "Finished clip";
    const finished = await copyPathIntoFinished(dataRoot, tmpOut, {
      name,
      mime: "video/mp4",
      workspaceId,
      source: "compose",
      // A compose started from an open project belongs to it; a studio compose
      // with no project stays a loose clip the cleanup page can find.
      projectId: opts.projectId,
    });
    finished.composed = {
      videoId,
      durationSec: Math.round(totalSecs * 10) / 10,
      intro: segments.intro.length,
      overlay: segments.overlay.length,
      end: segments.end.length,
      audioId: resolvedAudio.length ? String(opts.audioId || (resolvedAudio[0] && resolvedAudio[0].audioId) || "") : undefined,
      audioIds: resolvedAudio.length ? resolvedAudio.map((track) => track.audioId) : undefined,
    };
    return finished;
  } finally {
    for (const file of cleanup) {
      try {
        fs.unlinkSync(file);
      } catch {
        /* ignore */
      }
    }
    // Async so hundreds of animation frames do not block the main process.
    await fs.promises.rm(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {});
  }
}

module.exports = { composeFinished, findFfmpeg, findFont, resolveAudioOverlay, resolveAudioTracks };
