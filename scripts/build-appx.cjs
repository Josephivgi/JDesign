// Build the signed AppX (MSIX) package. Needs build/dev-cert from
// `npm run dev-cert`. The cache lives outside the home directory because a
// package.json with "type": "module" above the cache breaks the icon tool.
//
// Each pack bumps Identity Version (1.0.N) above the installed package so
// Windows updates in place. Same-version Remove-AppxPackage drops camsvc
// grants. ConsentStore restore is not a grant.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.join(__dirname, "..");
const APPX_PACKAGE_NAME = "Cutline.Desktop";

function installedAppxVersion() {
  const r = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "(Get-AppxPackage -Name " + APPX_PACKAGE_NAME + " -ErrorAction SilentlyContinue).Version",
    ],
    { encoding: "utf8", windowsHide: true, shell: false },
  );
  return String(r.stdout || "").trim();
}

function nextAppxVersion() {
  const revPath = path.join(root, "build", "appx-revision");
  let stamped = 0;
  try {
    stamped = parseInt(fs.readFileSync(revPath, "utf8").trim(), 10) || 0;
  } catch {
    stamped = 0;
  }
  const inst = installedAppxVersion();
  let installedPatch = 0;
  if (/^\d+\.\d+\.\d+/.test(inst)) {
    const parts = inst.split(".").map((part) => parseInt(part, 10));
    installedPatch = parts[2] || 0;
  }
  const n = Math.max(stamped, installedPatch) + 1;
  fs.mkdirSync(path.dirname(revPath), { recursive: true });
  fs.writeFileSync(revPath, String(n) + "\n");
  return "1.0." + n;
}

const pfx = path.join(root, "build", "dev-cert", "cutline-dev.pfx");
const pwFile = path.join(root, "build", "dev-cert", "password.txt");
if (!fs.existsSync(pfx) || !fs.existsSync(pwFile)) {
  console.error("Missing build/dev-cert. Run `npm run dev-cert` first.");
  process.exit(1);
}
const iconScript = path.join(root, "scripts", "generate-icon.ps1");
const appxScript = path.join(root, "scripts", "generate-appx-assets.ps1");
for (const script of [iconScript, appxScript]) {
  const gen = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], {
    cwd: root,
    stdio: "inherit",
    shell: false,
  });
  if (gen.status !== 0) process.exit(gen.status == null ? 1 : gen.status);
}
const appxVersion = nextAppxVersion();
console.log("AppX version " + appxVersion);
const ensure = spawnSync(process.execPath, [path.join(root, "scripts", "ensure-editorpi.cjs")], {
  cwd: root,
  stdio: "inherit",
});
if (ensure.status !== 0) process.exit(ensure.status == null ? 1 : ensure.status);
const env = {
  ...process.env,
  CSC_LINK: pfx,
  CSC_KEY_PASSWORD: fs.readFileSync(pwFile, "utf8").trim(),
  ELECTRON_BUILDER_CACHE: process.env.ELECTRON_BUILDER_CACHE || "C:\\Users\\Public\\electron-builder-cache",
};
const bin = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "electron-builder.cmd" : "electron-builder");
const res = spawnSync(bin, ["--win", "appx", "-c.extraMetadata.version=" + appxVersion], {
  cwd: root,
  env,
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (res.status !== 0) process.exit(res.status == null ? 1 : res.status);

// electron-builder has signed the package while makeappx was still writing
// it, which leaves the finished file unsigned and Add-AppxPackage rejects it.
// Wait for makeappx to exit AND the file to settle, then verify and re-sign
// if needed. Size alone is not enough: makeappx stalls for a minute or more
// mid-write, so a short quiet window does not mean it finished.
function sleep(ms) {
  spawnSync(process.execPath, ["-e", "setTimeout(() => {}, " + ms + ")"]);
}
function latestAppx() {
  const dir = path.join(root, "dist-app");
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith(".appx"))
    .map((name) => path.join(dir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0] || null;
}
function packerRunning() {
  const r = spawnSync(
    "powershell",
    ["-NoProfile", "-Command", "(Get-Process makeappx -ErrorAction SilentlyContinue | Measure-Object).Count"],
    { encoding: "utf8", windowsHide: true, shell: false },
  );
  return (parseInt(String(r.stdout || "").trim(), 10) || 0) > 0;
}
function settled(file) {
  let last = -1;
  let quiet = 0;
  for (let i = 0; i < 900; i += 1) {
    if (packerRunning()) {
      last = -1;
      quiet = 0;
      sleep(1000);
      continue;
    }
    const size = fs.statSync(file).size;
    quiet = size === last && size > 0 ? quiet + 1 : 0;
    if (quiet >= 5) return true;
    last = size;
    sleep(1000);
  }
  return false;
}
const appx = latestAppx();
if (!appx) {
  console.error("No .appx found in dist-app.");
  process.exit(1);
}
if (!settled(appx)) {
  console.error("Package is still being written: " + appx);
  process.exit(1);
}
const { sdkSigntool } = require("./sign-win.cjs");
const signtool = sdkSigntool();
if (signtool) {
  const verify = spawnSync(signtool, ["verify", "/pa", "/q", appx], { stdio: "ignore" });
  if (verify.status !== 0) {
    console.log("Package was not signed after packing; signing " + path.basename(appx));
    const sign = spawnSync(signtool, ["sign", "/fd", "sha256", "/f", pfx, "/p", env.CSC_KEY_PASSWORD, appx], {
      stdio: "inherit",
    });
    if (sign.status !== 0) process.exit(sign.status == null ? 1 : sign.status);
    const again = spawnSync(signtool, ["verify", "/pa", "/q", appx], { stdio: "ignore" });
    if (again.status !== 0) {
      console.error("Signature still invalid on " + appx);
      process.exit(1);
    }
  }
}
process.exit(0);
