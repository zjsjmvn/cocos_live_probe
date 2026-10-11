const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const assert = require("node:assert/strict");
const asar = require("@electron/asar");
const root = path.resolve(__dirname, "..");
const output = path.resolve(root, process.env.COCOS_INSPECTOR_PACKAGE_OUTPUT || "releases");
const executable = path.join(output, "Cocos Live Probe Inspector-win32-x64/Cocos Live Probe Inspector.exe");
if (!fs.existsSync(executable)) throw new Error("Run npm run package:inspector first");
// Old packages also carry old smoke tests and can pass without exercising a new
// feature. Verify the selected package contains the current selection code first.
const archive = path.join(path.dirname(executable), "resources/app.asar");
for (const [entry, source] of [
    ["inspector/inspector.js", "inspector/inspector.js"],
    ["inspector/workbench.js", "inspector/workbench.js"],
    ["inspector/inspector.css", "inspector/inspector.css"],
    ["inspector/index.html", "inspector/index.html"],
    ["runtime-inspector-core.js", "dist-desktop/runtime-inspector-core.js"],
    ["runtime-inspector-values.js", "dist-desktop/runtime-inspector-values.js"],
    ["runtime-inspector-workbench.js", "dist-desktop/runtime-inspector-workbench.js"],
    ["runtime-inspector-preferences.js", "dist-desktop/runtime-inspector-preferences.js"],
    ["runtime-inspector-preview-tools.js", "dist-desktop/runtime-inspector-preview-tools.js"],
]) {
    assert.ok(asar.extractFile(archive, entry).equals(fs.readFileSync(path.join(root, source))),
        `Packaged ${entry} is stale. Run npm run package:inspector before testing.`);
}
// This acceptance test exercises a visible native game window. Hiding the GUI
// process at startup can prevent Creator's first animation frames on Windows.
const child = spawn(executable, ["--smoke-test"], { cwd: root, stdio: "inherit", windowsHide: false });
child.on("error", error => { console.error(error); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
