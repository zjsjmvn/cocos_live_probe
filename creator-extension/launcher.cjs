// Electron virtualizes app.asar paths: statSync returns synthetic timestamps
// and opens an archive handle. Use physical file stats to select the newest
// build, and avoid locking package archives inside the long-lived editor.
const fs = (() => {
    try { return require("original-fs"); }
    catch (error) {
        if (error.code !== "MODULE_NOT_FOUND") throw error;
        return require("node:fs");
    }
})();
const path = require("node:path");
const { spawn } = require("node:child_process");

function findPackagedInspector(toolRoot) {
    const candidates = [];
    for (const directory of fs.readdirSync(toolRoot, { withFileTypes: true })) {
        if (!directory.isDirectory() || !/^releases(?:-|$)/.test(directory.name)) continue;
        const packageRoot = path.join(toolRoot, directory.name, "Cocos Live Probe Inspector-win32-x64");
        const executable = path.join(packageRoot, "Cocos Live Probe Inspector.exe");
        const archive = path.join(packageRoot, "resources/app.asar");
        if (fs.existsSync(executable) && fs.existsSync(archive)) {
            candidates.push({ executable, builtAt: fs.statSync(archive).mtimeMs });
        }
    }
    return candidates.sort((a, b) => b.builtAt - a.builtAt)[0]?.executable;
}

function createLauncher({ editor, spawnProcess = spawn, platform = process.platform, env = process.env }) {
    let opening;
    async function launch() {
        const workspaceRoot = path.resolve(editor.Project.path);
        const toolRoot = path.join(workspaceRoot, "tools/cocos_live_probe");
        if (platform !== "win32") throw new Error("当前打包的检查器仅支持 Windows。");
        if (!fs.existsSync(toolRoot)) throw new Error(`找不到检查器工具目录：${toolRoot}`);
        const executable = findPackagedInspector(toolRoot);
        if (!executable) throw new Error(`请先在 ${toolRoot} 运行 npm run package:inspector，再从编辑器启动。`);

        // Creator serves the game itself; querying the editor respects its port,
        // start-scene setting and preview URL without opening another browser.
        const previewUrl = new URL(await editor.Message.request("preview", "query-preview-url"));
        if (!["http:", "https:"].includes(previewUrl.protocol)) throw new Error("Creator 返回了无效的预览地址。");
        previewUrl.hostname = "127.0.0.1";
        const childEnv = { ...env,
            COCOS_RUNTIME_PROBE_WORKSPACE_ROOT: workspaceRoot,
            COCOS_RUNTIME_PROBE_PREVIEW_URL: previewUrl.href,
        };
        // Extensions run inside Electron. A development/editor environment may
        // carry this variable, which would otherwise turn our GUI into Node.
        delete childEnv.ELECTRON_RUN_AS_NODE;
        const child = spawnProcess(executable, [], {
            cwd: toolRoot, env: childEnv, detached: true, stdio: "ignore", windowsHide: false,
        });
        await new Promise((resolve, reject) => {
            child.once("error", reject);
            child.once("spawn", resolve);
        });
        child.on("error", error => console.error("[Cocos Live Probe]", error));
        child.unref();
        return { executable, workspaceRoot, previewUrl: previewUrl.href };
    }
    return {
        // Collapse repeated shortcut presses while querying/spawning. Once
        // open, Electron's per-project single-instance lock focuses the window.
        open() {
            if (!opening) opening = launch().finally(() => { opening = undefined; });
            return opening;
        },
    };
}

module.exports = { createLauncher, findPackagedInspector };
