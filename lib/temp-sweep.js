"use strict";

// Removes stale JV scratch dirs from the OS temp folder. Renders and
// cookie imports clean up after themselves, but a crash, a kill, or a locked
// file can leave a dir behind, and hundreds of them make %TEMP% slow to list.
// Only dirs directly under tmpDir whose names start with a known prefix and
// whose mtime is older than the threshold are touched. Async throughout, with
// a small concurrency cap, and it never throws.

const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_PREFIXES = [
  "cutline-compose-",
  "cutline-html-",
  "cutline-render-",
  "cutline-frames-",
  "cutline-cookies-",
  "cutline-fxcookies-",
  // test/cache-usage.test.js (removed in cf924e6) made these per run and never
  // cleaned them; thousands are still on disk.
  "cutline-usage-",
  // Older runs of test/video-look and test/browser-cookie-import leaked these.
  "cutline-look-test-",
  "cutline-srcs-",
];
const CONCURRENCY = 4;

async function sweepStaleTemp(options) {
  const opts = options || {};
  const olderThanMs = Number.isFinite(opts.olderThanMs) ? opts.olderThanMs : 6 * 3600 * 1000;
  const prefixes = Array.isArray(opts.prefixes) ? opts.prefixes.filter((p) => typeof p === "string" && p.length > 0) : DEFAULT_PREFIXES;
  const tmpDir = opts.tmpDir || os.tmpdir();
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : Infinity;
  const result = { removed: 0, failed: 0, scanned: 0 };
  if (!prefixes.length) return result;
  const cutoff = Date.now() - olderThanMs;
  let dir;
  try {
    dir = await fs.promises.opendir(tmpDir);
  } catch {
    return result;
  }
  const queue = [];
  try {
    // opendir streams entries, so a huge temp folder is never held in memory
    // as one array.
    for await (const entry of dir) {
      if (!entry.isDirectory()) continue;
      if (!prefixes.some((p) => entry.name.startsWith(p))) continue;
      result.scanned += 1;
      queue.push(entry.name);
    }
  } catch {
    /* a partial listing still sweeps what it saw */
  }
  let next = 0;
  let attempted = 0;
  const lane = async () => {
    while (next < queue.length && attempted < limit) {
      const full = path.join(tmpDir, queue[next]);
      next += 1;
      let st;
      try {
        st = await fs.promises.lstat(full);
      } catch {
        continue;
      }
      if (!st.isDirectory() || st.mtimeMs > cutoff) continue;
      if (attempted >= limit) break;
      attempted += 1;
      try {
        await fs.promises.rm(full, { recursive: true, force: true, maxRetries: 2 });
        result.removed += 1;
      } catch {
        result.failed += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, lane));
  return result;
}

module.exports = { sweepStaleTemp, DEFAULT_PREFIXES };
