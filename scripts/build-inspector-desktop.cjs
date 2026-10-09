const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const root = path.resolve(__dirname, "..");
const result = spawnSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", "tsconfig.desktop.json"], { cwd: root, stdio: "inherit", windowsHide: true });
if (result.error) throw result.error;
if (result.status) process.exit(result.status);
fs.cpSync(path.join(root, "inspector"), path.join(root, "dist-desktop/inspector"), { recursive: true });
