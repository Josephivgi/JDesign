// On Windows, launch the installed Cutline AppX when present. That build has
// package identity (Cutline.Desktop), so Windows lists it by name on the privacy
// pages and mic access works the way it did before. Set JEDITOR_ELECTRON=1 (or
// the old CUTLINE_ELECTRON=1) to run electron . from source instead (process
// shows as Electron; desktop mic uses a separate privacy switch). Keep this
// launch split. Do not make npm start open electron.exe when the AppX is
// installed.
const path = require("path");
const { execSync } = require("child_process");
const { launchDetached } = require("./launch-detached.cjs");

const root = path.join(__dirname, "..");
const electron = path.join(root, "node_modules", "electron", "dist", "electron.exe");

// Renamed variable first, old spelling second, so existing shell profiles and
// scripts keep working.
function env(name) {
  return process.env["JEDITOR_" + name] || process.env["CUTLINE_" + name] || "";
}

function launchElectron() {
  launchDetached(electron, ["."], { cwd: root });
  process.exit(0);
}

function packageFamily() {
  try {
    return execSync(
      'powershell -NoProfile -Command "(Get-AppxPackage -Name Cutline.Desktop -ErrorAction SilentlyContinue).PackageFamilyName"',
      { encoding: "utf8", timeout: 30000, windowsHide: true },
    ).trim();
  } catch {
    return "";
  }
}

function tryLaunchAppx() {
  // Right after install-appx.ps1 the package service is still settling and a
  // single quick lookup can time out. Falling back to electron then would
  // spawn a window Windows treats as a different app for mic/camera, so try
  // again before giving up.
  for (let i = 0; i < 3; i += 1) {
    const family = packageFamily();
    if (family) {
      launchDetached("explorer.exe", [`shell:AppsFolder\\${family}!Cutline`]);
      return true;
    }
    if (i < 2) execSync("ping -n 3 127.0.0.1 > nul", { windowsHide: true });
  }
  return false;
}

if (env("START_DRY_RUN")) {
  // Tests check the launcher resolves without leaving a real app window behind.
  process.stdout.write(process.platform === "win32" && !env("ELECTRON") && packageFamily() ? "appx\n" : "electron\n");
  process.exit(0);
}

if (process.platform === "win32" && !env("ELECTRON")) {
  if (tryLaunchAppx()) process.exit(0);
}

launchElectron();
