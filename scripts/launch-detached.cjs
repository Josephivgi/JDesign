"use strict";

const { spawn } = require("child_process");

function launchDetached(command, args, options) {
  const child = spawn(
    command,
    args,
    Object.assign(
      {
        detached: true,
        stdio: "ignore",
        shell: false,
      },
      options || {},
    ),
  );
  child.unref();
  return child;
}

module.exports = { launchDetached };
