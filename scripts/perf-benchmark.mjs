#!/usr/bin/env node
/**
 * Unified perf benchmark runner for Cutline desktop.
 * Runs all registered microbenches and merges results into one JSON payload.
 *
 * Usage:
 *   node scripts/perf-benchmark.mjs [out.json]
 *   node scripts/perf-benchmark.mjs --suite record-center [out.json]
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(scriptsDir, "..");

const SUITES = {
  "record-center": "record-center-perf-bench.mjs",
};

function parseArgs(argv) {
  const args = argv.slice(2);
  let suite = "all";
  let outPath = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--suite" && args[i + 1]) {
      suite = args[i + 1];
      i += 1;
      continue;
    }
    if (!arg.startsWith("-")) outPath = arg;
  }
  return { suite, outPath };
}

function runBenchScript(scriptName, outFile) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(scriptsDir, scriptName);
    const child = spawn(process.execPath, [scriptPath, outFile], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(scriptName + " exited " + code + (stderr ? "\n" + stderr : "")));
        return;
      }
      try {
        const raw = fs.readFileSync(outFile, "utf8");
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function main() {
  const { suite, outPath } = parseArgs(process.argv);
  const names =
    suite === "all" ? Object.keys(SUITES) : suite.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = names.filter((name) => !SUITES[name]);
  if (unknown.length) {
    console.error("Unknown suite(s): " + unknown.join(", "));
    console.error("Available: " + Object.keys(SUITES).join(", "));
    process.exit(1);
  }

  const merged = {};
  const suites = {};
  const tmpDir = fs.mkdtempSync(path.join(root, ".perf-bench-"));

  for (const name of names) {
    const tmpOut = path.join(tmpDir, name + ".json");
    const payload = await runBenchScript(SUITES[name], tmpOut);
    suites[name] = payload;
    Object.assign(merged, payload.results || {});
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });

  const output = {
    results: merged,
    suites,
    at: new Date().toISOString(),
  };

  if (outPath) fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  else console.log(JSON.stringify(output, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
