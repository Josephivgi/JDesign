// Dev smoke test for the card render + compose pipeline. Not part of `npm test`.
// Usage: node scripts/dev-card-smoke.cjs
const fs = require("fs");
const os = require("os");
const path = require("path");

const { loadState, loadWorkspace, saveWorkspace } = require("../lib/workspace-store");
const { applyCardEdit } = require("../lib/card-apply");
const { copyPathIntoLibrary } = require("../lib/library-io");
const { renderCardPng, findFfmpeg, findFont } = require("../lib/card-render");
const { composeFinished } = require("../lib/compose-finished");
const { spawnSync } = require("child_process");

async function main() {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cutline-smoke-"));
  console.log("dataRoot:", dataRoot);
  const ffmpeg = findFfmpeg();
  console.log("ffmpeg:", ffmpeg);
  const font = findFont();
  console.log("font:", font);
  if (!ffmpeg) throw new Error("no ffmpeg");

  const state = await loadState(dataRoot);
  const workspaceId = state.activeWorkspaceId;
  console.log("workspace:", workspaceId);

  // 1. Generate a 6s test clip WITH audio.
  const srcVideo = path.join(dataRoot, "src.mp4");
  const gen = spawnSync(ffmpeg, [
    "-y",
    "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=6",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    srcVideo,
  ], { encoding: "utf8" });
  if (gen.status !== 0) {
    console.error(gen.stderr.slice(-2000));
    throw new Error("test clip generation failed");
  }
  const vid = await copyPathIntoLibrary(dataRoot, srcVideo, { name: "demo clip", mime: "video/mp4", workspaceId });
  const videoId = vid.item.id;
  console.log("video item:", videoId);

  // 2. Cards via applyCardEdit — one intro (template), one overlay, one end.
  const intro = await applyCardEdit({
    dataRoot, workspaceId, cardId: "",
    patch: {
      template: "hook",
      name: "Intro hook",
      composition: { headline: "Smoke test hook" },
    },
  });
  console.log("intro card:", intro.card.id, "placement:", intro.card.placement);

  const overlay = await applyCardEdit({
    dataRoot, workspaceId, cardId: "",
    patch: {
      name: "Mid overlay",
      kind: "overlay",
      placement: "overlay",
      durationMs: 2500,
      colors: { primary: "#223344", secondary: "#DFF56A", text: "#FFFFFF" },
      composition: {
        aspectRatio: "landscape", surface: "transparent", align: "center",
        headline: "Overlay on footage", body: "drawn inside a time window",
        cta: "", eyebrow: "",
        blockLayout: {
          headline: { x: 0.08, y: 0.55, width: 0.84, fontSize: 44, align: "center", bold: true },
          body: { x: 0.15, y: 0.72, width: 0.7, fontSize: 24, align: "center" },
        },
      },
    },
  });
  console.log("overlay card:", overlay.card.id);

  const end = await applyCardEdit({
    dataRoot, workspaceId, cardId: "",
    patch: { template: "cta-end", name: "Outro CTA" },
  });
  console.log("end card:", end.card.id);

  // 3. Render each card to PNG.
  for (const card of [intro.card, overlay.card, end.card]) {
    const out = path.join(dataRoot, "card-" + card.id.slice(0, 8) + ".png");
    const res = await renderCardPng({ dataRoot, workspaceId, card, outPath: out, ffmpeg, font });
    console.log("PNG:", out, res.width + "x" + res.height, fs.statSync(out).size, "bytes");
  }

  // 4. Compose with all enabled cards.
  const finished = await composeFinished({ dataRoot, workspaceId, videoId, name: "smoke compose" });
  console.log("finished:", JSON.stringify(finished.composed), finished.id);

  // 5. Check the finished file exists + probe duration/audio.
  const finDir = path.join(dataRoot, "workspaces", workspaceId, "finished");
  const files = fs.readdirSync(finDir).filter((f) => f.endsWith(".mp4"));
  console.log("finished dir files:", files);
  const probe = spawnSync(ffmpeg, ["-hide_banner", "-i", path.join(finDir, files[0])], { encoding: "utf8" });
  const info = probe.stderr || "";
  console.log("duration:", /Duration: ([\d:.]+)/.exec(info)?.[1], "| audio:", /Audio:/.test(info));
}

main().catch((error) => {
  console.error("SMOKE FAILED:", error.message);
  process.exit(1);
});
