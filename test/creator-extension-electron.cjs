const { app } = require("electron");
const assert = require("node:assert/strict");
const fs = require("original-fs");
const path = require("node:path");
const extensionRoot = process.env.COCOS_INSPECTOR_EXTENSION_TEST_ROOT
    ? path.resolve(process.env.COCOS_INSPECTOR_EXTENSION_TEST_ROOT)
    : path.resolve(__dirname, "../creator-extension");
const { findPackagedInspector } = require(path.join(extensionRoot, "launcher.cjs"));

// Use real packaged ASAR files. Node-only fixtures cannot reproduce Electron's
// synthetic ASAR stat timestamps, which previously selected the oldest build.
try {
    const root = path.resolve(__dirname, "..");
    const candidates = [];
    for (const name of fs.readdirSync(root).filter(name => /^releases(?:-|$)/.test(name))) {
        const executable = path.join(root, name, "Cocos Live Probe Inspector-win32-x64/Cocos Live Probe Inspector.exe");
        const archive = path.join(path.dirname(executable), "resources/app.asar");
        if (fs.existsSync(executable) && fs.existsSync(archive)) candidates.push({ executable, time: fs.statSync(archive).mtimeMs });
    }
    assert.ok(candidates.length >= 2, "This regression needs at least two real inspector packages");
    candidates.sort((a, b) => b.time - a.time);
    const actual = findPackagedInspector(root);
    assert.equal(actual, candidates[0].executable, "Electron must select the physically newest complete package");
    console.log("Electron package selection: PASS", actual);
    app.exit(0);
} catch (error) {
    console.error(error);
    app.exit(1);
}
