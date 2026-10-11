const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { createLauncher, findPackagedInspector } = require("../creator-extension/launcher.cjs");

function fixture(t) {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "probe-launch-"));
    t.after(() => {
        assert.ok(path.resolve(projectRoot).startsWith(path.resolve(os.tmpdir()) + path.sep));
        fs.rmSync(projectRoot, { recursive: true, force: true });
    });
    const toolRoot = path.join(projectRoot, "tools/cocos_live_probe");
    fs.mkdirSync(toolRoot, { recursive: true });
    function packaged(name, date, complete = true) {
        const dir = path.join(toolRoot, name, "Cocos Live Probe Inspector-win32-x64");
        fs.mkdirSync(path.join(dir, "resources"), { recursive: true });
        const executable = path.join(dir, "Cocos Live Probe Inspector.exe");
        if (complete) fs.writeFileSync(executable, "");
        const archive = path.join(dir, "resources/app.asar");
        fs.writeFileSync(archive, "");
        fs.utimesSync(archive, date, date);
        return executable;
    }
    return { projectRoot, toolRoot, packaged };
}

test("launch uses the owning editor's project and non-default preview URL, ignoring inherited target", async t => {
    const f = fixture(t);
    const exe = f.packaged("releases-new", new Date());
    const calls = [];
    let requests = 0;
    const launcher = createLauncher({
        platform: "win32", env: { ELECTRON_RUN_AS_NODE: "1", COCOS_RUNTIME_PROBE_WORKSPACE_ROOT: "other-project", COCOS_RUNTIME_PROBE_PREVIEW_URL: "http://127.0.0.1:7456/" },
        editor: { Project: { path: f.projectRoot }, Message: { async request(pkg, message) {
            assert.deepEqual([pkg, message], ["preview", "query-preview-url"]);
            requests++;
            return "http://192.168.0.2:7567/?scene=own-game";
        } } },
        spawnProcess(executable, args, options) {
            calls.push({ executable, args, options });
            const child = new EventEmitter();
            child.unref = () => {};
            queueMicrotask(() => child.emit("spawn"));
            return child;
        },
    });
    const first = launcher.open();
    const repeat = launcher.open();
    assert.strictEqual(first, repeat);
    const result = await first;
    assert.equal(requests, 1);
    assert.equal(calls.length, 1);
    assert.equal(result.previewUrl, "http://127.0.0.1:7567/?scene=own-game");
    assert.equal(calls[0].executable, exe);
    assert.equal(calls[0].options.cwd, f.toolRoot);
    assert.equal(calls[0].options.env.COCOS_RUNTIME_PROBE_WORKSPACE_ROOT, f.projectRoot);
    assert.equal(calls[0].options.env.COCOS_RUNTIME_PROBE_PREVIEW_URL, result.previewUrl);
    assert.equal(calls[0].options.env.ELECTRON_RUN_AS_NODE, undefined);
    await launcher.open();
    assert.equal(calls.length, 2);
});

test("latest complete package is selected; incomplete and unrelated directories are ignored", t => {
    const f = fixture(t);
    f.packaged("releases", new Date("2026-10-01"));
    const latest = f.packaged("releases-tools", new Date("2026-10-02"));
    f.packaged("releases-broken", new Date("2026-10-03"), false);
    f.packaged("releasesUnrelated", new Date("2026-10-04"));
    assert.equal(findPackagedInspector(f.toolRoot), latest);
});

test("query and spawn failures reject cleanly and allow retry without falling back to another game", async t => {
    const f = fixture(t);
    f.packaged("releases", new Date());
    let unavailable = true;
    let spawns = 0;
    const launcher = createLauncher({ platform: "win32", env: {},
        editor: { Project: { path: f.projectRoot }, Message: { async request() {
            if (unavailable) throw new Error("Editor preview unavailable");
            return "http://127.0.0.1:7567/";
        } } },
        spawnProcess() {
            spawns++;
            const child = new EventEmitter();
            queueMicrotask(() => child.emit("error", new Error("Launch failed")));
            return child;
        },
    });
    await assert.rejects(launcher.open(), /Editor preview unavailable/);
    assert.equal(spawns, 0);
    unavailable = false;
    await assert.rejects(launcher.open(), /Launch failed/);
    await assert.rejects(launcher.open(), /Launch failed/);
    assert.equal(spawns, 2);
});
