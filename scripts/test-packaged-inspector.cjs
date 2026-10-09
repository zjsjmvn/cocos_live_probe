const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const root = path.resolve(__dirname, "..");
const executable = path.join(root, "releases/Cocos Live Probe Inspector-win32-x64/Cocos Live Probe Inspector.exe");
if (!fs.existsSync(executable)) throw new Error("Run npm run package:inspector first");
// This acceptance test exercises a visible native game window. Hiding the GUI
// process at startup can prevent Creator's first animation frames on Windows.
const child = spawn(executable, ["--smoke-test"], { cwd: root, stdio: "inherit", windowsHide: false });
child.on("error", error => { console.error(error); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
