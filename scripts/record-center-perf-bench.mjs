import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.join(import.meta.dirname, "..");
const moduleUrl = pathToFileURL(path.join(root, "renderer", "js", "record-center.js")).href;

const ITER = 30;
const DOC_IDS = ["start", "record", "delay", "max", "window", "stop", "close"];
const SOURCE_COUNT = 8;
const THUMB_ENCODE_MS = 2.5;

function median(nums) {
  const sorted = nums.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function benchAsync(fn, times = ITER) {
  const samples = [];
  for (let i = 0; i < times; i += 1) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  return median(samples);
}

function benchSync(fn, times = ITER) {
  const samples = [];
  for (let i = 0; i < times; i += 1) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  return median(samples);
}

function flushMicrotasks() {
  return new Promise((resolve) => queueMicrotask(resolve));
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function mediaStream(spec = {}) {
  const videoTracks = spec.video ? [{ kind: "video", readyState: "live", stop() { this.readyState = "ended"; } }] : [];
  const audioTracks = spec.audio ? [{ kind: "audio", readyState: "live", stop() { this.readyState = "ended"; } }] : [];
  return {
    getVideoTracks: () => videoTracks,
    getAudioTracks: () => audioTracks,
    getTracks: () => videoTracks.concat(audioTracks),
    addTrack(track) {
      if (track.kind === "video") videoTracks.push(track);
      else audioTracks.push(track);
    },
    removeTrack(track) {
      const bucket = track.kind === "video" ? videoTracks : audioTracks;
      const idx = bucket.indexOf(track);
      if (idx >= 0) bucket.splice(idx, 1);
    },
  };
}

function domNode(tag = "div") {
  const children = [];
  const node = {
    tagName: tag.toUpperCase(),
    disabled: false,
    textContent: "",
    innerHTML: "",
    outerHTML: "",
    className: "",
    style: {},
    attrs: {},
    _child: null,
    addEventListener() {},
    removeEventListener() {},
    removeAttribute(name) {
      delete node.attrs[name];
    },
    remove() {
      children.length = 0;
    },
    setAttribute(name, value) {
      node.attrs[name] = value;
    },
    getAttribute(name) {
      return node.attrs[name] || "";
    },
    appendChild(child) {
      children.push(child);
      node._child = child;
      return child;
    },
    insertBefore(child, ref) {
      if (!ref) {
        children.unshift(child);
      } else {
        const idx = children.indexOf(ref);
        if (idx >= 0) children.splice(idx, 0, child);
        else children.push(child);
      }
      node._child = children[0] || null;
      return child;
    },
    removeChild(child) {
      const idx = children.indexOf(child);
      if (idx >= 0) children.splice(idx, 1);
      node._child = children[0] || null;
      return child;
    },
    get firstChild() {
      return children[0] || null;
    },
    get childElementCount() {
      return children.length;
    },
    get children() {
      return children;
    },
    replaceChildren(...next) {
      children.length = 0;
      for (let i = 0; i < next.length; i += 1) children.push(next[i]);
      node._child = children[0] || null;
    },
    querySelector(sel) {
      if (sel === ".record-source-tab-name") {
        return children.find((c) => c.className === "record-source-tab-name") || null;
      }
      if (sel === ".record-source-tab-thumb") {
        return children.find((c) => c.className === "record-source-tab-thumb") || null;
      }
      return null;
    },
    querySelectorAll(sel) {
      if (sel === "[data-record-source-tab]") return children.filter((c) => c.attrs["data-record-source-tab"]);
      return [];
    },
    closest() {
      return null;
    },
  };
  Object.defineProperty(node, "firstElementChild", {
    get() {
      return node._child || children[0] || null;
    },
  });
  return node;
}

function buildLab() {
  const stub = () => domNode();

  let shellHtml = "";
  let titleText = "";
  let snapshotEl = null;
  const botEl = { innerHTML: "" };
  const videoEl = {
    muted: true,
    srcObject: null,
    style: { clipPath: "" },
    play: async () => {},
    load() {},
    pause() {},
    removeAttribute() {},
    setAttribute() {},
    addEventListener() {},
    removeEventListener() {},
  };

  const guideBtns = DOC_IDS.map((id) => {
    const btn = stub();
    btn.attrs = { "data-record-open-guide": id };
    btn.getAttribute = (name) => btn.attrs[name] || "";
    btn.closest = (sel) => (sel === "[data-record-open-guide]" ? btn : null);
    return btn;
  });

  let tablist = null;
  const recordStartPage = domNode("div");
  recordStartPage.className = "record-start-page";
  recordStartPage.querySelector = (sel) => {
    if (sel === "[data-record-preview]") return rootPreview;
    if (sel === ".record-source-tabs") return tablist;
    return null;
  };
  const pageInsertBefore = recordStartPage.insertBefore.bind(recordStartPage);
  recordStartPage.insertBefore = (child, ref) => {
    if (child && child.className === "record-source-tabs") tablist = child;
    return pageInsertBefore(child, ref);
  };

  const rootPreview = {
    querySelector(sel) {
      if (sel === "video") return videoEl;
      if (sel === "[data-record-snapshot]") return snapshotEl;
      if (sel === ".record-hud-bot") return botEl;
      return null;
    },
    prepend(node) {
      void node;
    },
  };

  const root = {
    attrs: { "data-record-route": "home" },
    docs: { innerHTML: "" },
    windows: { outerHTML: "" },
    open: { outerHTML: "" },
    status: { textContent: "" },
    preview: rootPreview,
    recordStartPage,
    getAttribute(name) {
      return this.attrs[name] || "";
    },
    setAttribute(name, value) {
      this.attrs[name] = value;
    },
    removeAttribute(name) {
      delete this.attrs[name];
    },
    addEventListener() {},
    querySelector(sel) {
      if (sel === "[data-record-docs]") return this.docs;
      if (sel === "[data-record-windows]") return this.windows;
      if (sel === ".record-docs-open") return this.open;
      if (sel === "[data-record-status]") return this.status;
      if (sel === "[data-record-preview]") return this.preview;
      if (sel === ".record-start-page") return this.recordStartPage;
      if (sel === "[data-record-snapshot]") return snapshotEl;
      return stub();
    },
    querySelectorAll(sel) {
      if (sel === "[data-record-source]") return [];
      if (sel === "[data-record-open-guide]") return guideBtns;
      if (sel === "[data-record-snapshot]") return snapshotEl ? [snapshotEl] : [];
      return [];
    },
  };

  const app = {
    page: "record",
    state: { activeWorkspaceId: "w", workspace: { library: [] } },
    shell(body, title) {
      shellHtml = body;
      titleText = title;
    },
    render() {},
    mergeState() {},
  };

  globalThis.window = globalThis;
  globalThis.Image = class {
    constructor() {
      this.decoding = "async";
      this.onload = null;
      this.onerror = null;
    }
    set src(_value) {
      queueMicrotask(() => {
        if (this.onload) this.onload();
      });
    }
  };
  globalThis.requestAnimationFrame = (fn) => {
    queueMicrotask(fn);
    return 1;
  };
  globalThis.cancelAnimationFrame = () => {};
  globalThis.MediaRecorder = class {
    constructor() {
      this.state = "inactive";
      this.mimeType = "video/webm";
      this.onstop = null;
    }
    start() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      queueMicrotask(() => {
        if (this.onstop) this.onstop();
      });
    }
  };
  MediaRecorder.isTypeSupported = () => true;
  globalThis.Blob = class {
    constructor(parts, opts) {
      this.size = parts.reduce((n, p) => n + (p.byteLength || p.length || 0), 0);
      this.type = (opts && opts.type) || "";
    }
    arrayBuffer() {
      return Promise.resolve(new ArrayBuffer(Math.max(1, this.size)));
    }
  };

  navigator.mediaDevices = {
    addEventListener() {},
    removeEventListener() {},
    getUserMedia: async () => mediaStream({ audio: 1 }),
    getDisplayMedia: async () => mediaStream({ video: 1 }),
  };

  globalThis.document = {
    getElementById() {
      return null;
    },
    querySelector(sel) {
      if (sel === "[data-record-center]") return root;
      if (sel === ".content h1") {
        return {
          textContent: titleText,
          set textContent(v) {
            titleText = v;
          },
        };
      }
      if (sel === "[data-record-open-library]") return stub();
      return null;
    },
    querySelectorAll() {
      return [];
    },
    createElement(tag) {
      const node = domNode(tag);
      if (tag === "div") {
        Object.defineProperty(node, "innerHTML", {
          set() {
            snapshotEl = domNode("img");
            snapshotEl.className = "record-source-tab-thumb";
            node._child = snapshotEl;
          },
          get() {
            return "";
          },
        });
      }
      return node;
    },
  };

  globalThis.window.cutline = {
    captureSetupStatus: async () => ({
      ready: true,
      screen: { ok: true },
      camera: { ok: true },
      mic: { ok: true },
    }),
    listCaptureSources: async () =>
      Array.from({ length: SOURCE_COUNT }, (_, i) => ({
        id: "w" + i,
        name: "Window " + i,
        kind: i % 2 ? "window" : "screen",
      })),
    captureSourceThumbnails: async (payload) => {
      const mode = payload && payload.mode ? payload.mode : "all";
      const encodeCount = mode === "selected" ? 1 : mode === "tabs" ? SOURCE_COUNT - 1 : SOURCE_COUNT;
      if (encodeCount > 0) {
        await new Promise((resolve) => setTimeout(resolve, encodeCount * THUMB_ENCODE_MS));
      }
      return Array.from({ length: SOURCE_COUNT }, (_, i) => {
        const item = {
          id: "w" + i,
          name: "Window " + i,
          kind: i % 2 ? "window" : "screen",
        };
        if (mode === "selected") {
          const pick = payload && payload.sourceId ? String(payload.sourceId) : "w0";
          if (String(item.id) === pick) item.thumbnail = "data:image/png;base64," + String(i).repeat(40);
          return item;
        }
        if (mode === "tabs" && String(item.id) === ((payload && payload.sourceId) || "w0")) return item;
        if (mode !== "selected") item.thumbnail = "data:image/png;base64," + String(i).repeat(40);
        return item;
      });
    },
    setCaptureIntent: async () => {},
    setCaptureSource: async () => {},
    addBuffer: async () => ({ added: [{ id: "take1", name: "Take 1", kind: "video" }], snapshot: null }),
    resetCaptureConsent: async () => {},
    saveRecordCenterPrefs: async (patch) => ({ ready: true, prefs: patch }),
    startCountdownOverlay(payload) {
      void payload;
    },
    updateCountdownOverlay(payload) {
      void payload;
    },
    stopCountdownOverlay() {},
    onCountdownOverlayEvent() {
      return () => {};
    },
  };

  function readySession(session) {
    Object.assign(session, {
      setupLoaded: true,
      setupContinued: true,
      setup: {
        ready: true,
        platform: "win32",
        screen: { ok: true },
        camera: { ok: true },
        mic: { ok: true },
      },
      docPage: "",
      phase: "idle",
      source: "screen",
      displays: [],
      area: "custom",
      crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
    });
  }

  return {
    app,
    root,
    readySession,
    shellHtml: () => shellHtml,
    setSnapshot(node) {
      snapshotEl = node;
    },
    getSnapshot() {
      return snapshotEl;
    },
  };
}

async function runBench(mod, lab) {
  const {
    renderRecordCenterPage,
    resetRecordSession,
    session,
    loadDisplays,
    teardownRecord,
    startCountdown,
    AREA_CUSTOM,
  } = mod;

  const results = {};

  results["RC home load"] = await benchAsync(async () => {
    resetRecordSession();
    lab.readySession(session);
    renderRecordCenterPage(lab.app, { now: true });
    await flushMicrotasks();
    await tick();
    teardownRecord(lab.app);
  }, 25);

  results["help nav 7 topics"] = await benchAsync(async () => {
    resetRecordSession();
    lab.readySession(session);
    renderRecordCenterPage(lab.app, { now: true, skipDisplays: true });
    await flushMicrotasks();
    const t0 = performance.now();
    for (const id of DOC_IDS) {
      session.docPage = id;
      renderRecordCenterPage(lab.app, { skipDisplays: true, now: true });
    }
    return performance.now() - t0;
  }, 12);

  results["overlay open"] = benchSync(() => {
    resetRecordSession();
    lab.readySession(session);
    session.phase = "ready";
    session.stream = mediaStream({ video: 1 });
    session.area = AREA_CUSTOM;
    session.app = lab.app;
    startCountdown(lab.app);
  }, 25);

  results["loadDisplays first paint"] = await benchAsync(async () => {
    resetRecordSession();
    lab.readySession(session);
    renderRecordCenterPage(lab.app, { now: true, skipDisplays: true });
    await flushMicrotasks();
    const t0 = performance.now();
    loadDisplays(lab.app);
    await flushMicrotasks();
    teardownRecord(lab.app);
    return performance.now() - t0;
  }, 15);

  results["loadDisplays selected thumb"] = await benchAsync(async () => {
    resetRecordSession();
    lab.readySession(session);
    renderRecordCenterPage(lab.app, { now: true, skipDisplays: true });
    await flushMicrotasks();
    loadDisplays(lab.app);
    await flushMicrotasks();
    const t0 = performance.now();
    await flushMicrotasks();
    teardownRecord(lab.app);
    return performance.now() - t0;
  }, 15);

  results["record start"] = await benchAsync(async () => {
    resetRecordSession();
    lab.readySession(session);
    session.stream = mediaStream({ video: 1 });
    session.phase = "ready";
    session.area = AREA_CUSTOM;
    session.app = lab.app;
    const t0 = performance.now();
    startCountdown(lab.app);
    return performance.now() - t0;
  }, 25);

  results["record stop teardown"] = await benchAsync(async () => {
    resetRecordSession();
    lab.readySession(session);
    session.stream = mediaStream({ video: 1, audio: 1 });
    session.recordStream = session.stream;
    session.recorder = new MediaRecorder();
    session.recorder.state = "recording";
    session.phase = "recording";
    session.chunks = [new Uint8Array(128)];
    session.timer = setInterval(() => {}, 10000);
    session.app = lab.app;
    const t0 = performance.now();
    window.cutline.stopCountdownOverlay();
    teardownRecord(lab.app);
    await flushMicrotasks();
    return performance.now() - t0;
  }, 20);

  results["route switch recorder↔RC"] = await benchAsync(async () => {
    resetRecordSession();
    lab.readySession(session);
    renderRecordCenterPage(lab.app, { now: true, skipDisplays: true });
    await flushMicrotasks();
    const t0 = performance.now();
    lab.app.page = "recorder";
    teardownRecord(lab.app);
    lab.app.page = "record";
    renderRecordCenterPage(lab.app, { now: true, skipDisplays: true });
    await flushMicrotasks();
    return performance.now() - t0;
  }, 20);

  resetRecordSession();
  lab.readySession(session);
  renderRecordCenterPage(lab.app, { now: true, skipDisplays: true });
  await flushMicrotasks();
  if (globalThis.gc) globalThis.gc();
  const heapBefore = process.memoryUsage().heapUsed;
  for (let i = 0; i < 20; i += 1) {
    session.docPage = DOC_IDS[i % DOC_IDS.length];
    renderRecordCenterPage(lab.app, { skipDisplays: true, now: true });
  }
  if (globalThis.gc) globalThis.gc();
  results["20x help nav memory"] = Math.max(0, process.memoryUsage().heapUsed - heapBefore) / 1024;

  results["IPC roundtrip"] = await benchAsync(async () => {
    resetRecordSession();
    session.setupLoaded = false;
    session.setupContinued = false;
    session.setup = null;
    renderRecordCenterPage(lab.app, { now: true });
    await flushMicrotasks();
    await tick();
  }, 15);

  resetRecordSession();
  lab.readySession(session);
  session.displays = Array.from({ length: 8 }, (_, i) => ({
    id: "w" + i,
    name: "Window " + i,
    thumbnail: "data:image/png;base64," + "x".repeat(120),
  }));
  session.displayId = "w0";
  renderRecordCenterPage(lab.app, { now: true, skipDisplays: true });
  await flushMicrotasks();
  lab.setSnapshot({
    attrs: {},
    setAttribute(n, v) {
      this.attrs[n] = v;
    },
    getAttribute(n) {
      return this.attrs[n] || "";
    },
    remove() {},
  });
  lab.getSnapshot().setAttribute("src", session.displays[0].thumbnail);
  if (typeof mod.resetSnapshotPaintState === "function") mod.resetSnapshotPaintState();

  results["idle thumbnail CPU"] = benchSync(() => {
    const baseThumb = session.displays[0].thumbnail;
    for (let i = 0; i < 50; i += 1) {
      session.displayId = "w" + (i % 8);
      if (i % 10 === 0) {
        const idx = i % 8;
        session.displays[idx] = Object.assign({}, session.displays[idx], {
          thumbnail: baseThumb.slice(0, -3) + String(i).padStart(3, "0"),
        });
        if (typeof mod.resetSnapshotPaintState === "function") mod.resetSnapshotPaintState();
      }
      if (typeof mod.paintSnapshot === "function") mod.paintSnapshot();
    }
  }, 12);

  return results;
}

async function main() {
  const mod = await import(moduleUrl);
  const lab = buildLab();
  const results = await runBench(mod, lab);
  const outPath = process.argv[2];
  const payload = { results, at: new Date().toISOString() };
  if (outPath) fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  else console.log(JSON.stringify(payload, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
