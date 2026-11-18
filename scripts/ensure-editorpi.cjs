"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.join(__dirname, "..");
const vendorDir = path.join(root, "vendor", "editorpi");
const cliJs = path.join(vendorDir, "dist", "cli.js");
const pkgJson = path.join(vendorDir, "package.json");
const piAgent = path.join(vendorDir, "node_modules", "@earendil-works", "pi-coding-agent");

function run(label, command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    console.error(label + " failed with exit code " + (result.status == null ? 1 : result.status));
    process.exit(result.status == null ? 1 : result.status);
  }
}

function ensureSubmodule() {
  const gitmodules = path.join(root, ".gitmodules");
  if (!fs.existsSync(gitmodules)) return;
  if (fs.existsSync(pkgJson)) return;
  run("git submodule update", "git", ["submodule", "update", "--init", "--recursive", "vendor/editorpi"], root);
}

function newestMtime(dir, relPaths) {
  let newest = 0;
  for (const rel of relPaths) {
    const file = path.join(dir, rel);
    try {
      const stat = fs.statSync(file);
      if (stat.isFile() && stat.mtimeMs > newest) newest = stat.mtimeMs;
    } catch {
      // Missing file is handled elsewhere.
    }
  }
  return newest;
}

function newestSourceMtime(dir) {
  let newest = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return newest;
  }
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const child = newestSourceMtime(file);
      if (child > newest) newest = child;
    } else if (/\.(ts|mts|cts)$/.test(entry.name)) {
      try {
        const stat = fs.statSync(file);
        if (stat.mtimeMs > newest) newest = stat.mtimeMs;
      } catch {
        /* ignore */
      }
    }
  }
  return newest;
}

function needsBuild() {
  if (!fs.existsSync(cliJs)) return true;
  // Any source file can carry a patch the dist must rebuild for (for example
  // kernel/isolate-nested-pi.ts), not just the entry points.
  const srcNewest = newestSourceMtime(path.join(vendorDir, "src"));
  const distNewest = newestMtime(vendorDir, [path.join("dist", "cli.js")]);
  return srcNewest > distNewest;
}

function main() {
  ensureSubmodule();
  if (!fs.existsSync(pkgJson)) {
    console.error(
      "Bundled editorpi is missing at vendor/editorpi. Run: git submodule update --init --recursive",
    );
    process.exit(1);
  }
  if (!fs.existsSync(piAgent)) {
    run("editorpi npm install", "npm", ["install"], vendorDir);
  }
  if (needsBuild()) {
    run("editorpi build", "npm", ["run", "build"], vendorDir);
  }
  if (!fs.existsSync(cliJs)) {
    console.error("editorpi build did not produce vendor/editorpi/dist/cli.js");
    process.exit(1);
  }
}

main();
