const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "..", "test");
const files = fs
  .readdirSync(dir)
  .filter((name) => name.endsWith(".test.js"))
  .map((name) => path.join(dir, name));
if (!files.length) {
  process.stderr.write("No tests in " + dir + "\n");
  process.exit(1);
}
const result = spawnSync(process.execPath, ["--test"].concat(files), { stdio: "inherit" });
process.exit(result.status === null ? 1 : result.status);
