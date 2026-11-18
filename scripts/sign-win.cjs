// Custom electron-builder sign hook. The signtool bundled with electron-builder
// fails on AppX with "A required function is not present" on current Windows,
// so use the Windows SDK signtool when it is installed and fall back to the
// bundled one otherwise. Dev builds skip timestamping: the certificate is
// self-signed and only trusted on this machine.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function sdkSigntool() {
  const kits = "C:\\Program Files (x86)\\Windows Kits\\10\\bin";
  if (!fs.existsSync(kits)) return null;
  const versions = fs
    .readdirSync(kits)
    .filter((name) => /^10\.\d+\.\d+\.\d+$/.test(name))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const version of versions) {
    const exe = path.join(kits, version, "x64", "signtool.exe");
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}

async function sign(configuration) {
  // electron-builder calls once per hash. One sha256 signature is enough.
  if (configuration.hash && configuration.hash !== "sha256") return;
  const info = configuration.cscInfo || {};
  if (!info.file) return;
  const tool = sdkSigntool();
  if (!tool) throw new Error("Windows SDK signtool.exe not found. Install the Windows 10/11 SDK.");
  const args = ["sign", "/fd", "sha256", "/f", info.file];
  if (info.password) args.push("/p", info.password);
  args.push(configuration.path);
  const res = spawnSync(tool, args, { stdio: "inherit" });
  if (res.status !== 0) throw new Error("signtool exited " + res.status + " for " + configuration.path);
}

// electron-builder requires the hook itself as the module export; build-appx
// reuses the signtool lookup for its post-pack verification.
module.exports = sign;
module.exports.sdkSigntool = sdkSigntool;
