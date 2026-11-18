"use strict";

// Runs the development version from this repo: its own "JV Dev" data folder
// and window title, so it sits beside the everyday app.
const path = require("path");
const { launchDetached } = require("./launch-detached.cjs");

const root = path.join(__dirname, "..");
const electron = path.join(root, "node_modules", "electron", "dist", "electron.exe");
// Both spellings of the electron flag: the app reads the renamed one first and
// scripts written before the rename may still pass the old one.
const env = Object.assign({}, process.env, { JEDITOR_ELECTRON: "1", CUTLINE_ELECTRON: "1", JEDITOR_DEV: "1" });
delete env.ELECTRON_RUN_AS_NODE;

launchDetached(electron, ["."], { cwd: root, env });
process.exit(0);
