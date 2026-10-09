import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, WebContentsView } from "electron";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { randomUUID } from "crypto";
import { createElectronProbeDependencies } from "./runtime-electron-adapter";
import { createRuntimeInspectorServer } from "./runtime-inspector";
import { startInspectorBridge } from "./runtime-inspector-bridge";
import { createRuntimeProbeWorkspaceDefaults, RuntimeProbeService, runtimeProbeOptionsFromEnv } from "./runtime-probe";

const workspaceRoot = app.isPackaged
    ? path.resolve(process.env.COCOS_RUNTIME_PROBE_WORKSPACE_ROOT || path.join(path.dirname(app.getPath("exe")), "../../../.."))
    : path.resolve(__dirname, "../../..");
const identity = createRuntimeProbeWorkspaceDefaults(workspaceRoot).identity;
const desktopInstanceId = `desktop-${randomUUID()}`;
const smokeMode = process.argv.includes("--smoke-test");
const bridgeWorkspaceRoot = smokeMode ? path.join(os.tmpdir(), `inspector-acceptance-${randomUUID()}`) : workspaceRoot;
if (process.platform === "win32") {
    // Windows occlusion detection can stop the panel and embedded DevTools from
    // painting/resizing while the native game remains visible. Keep this debug
    // window responsive even when another application covers it during AI work.
    const disabled = new Set(app.commandLine.getSwitchValue("disable-features").split(",").filter(Boolean));
    disabled.add("CalculateNativeWinOcclusion");
    app.commandLine.appendSwitch("disable-features", [...disabled].join(","));
}
app.setName("Cocos Live Probe Inspector");
app.setPath("userData", path.join(app.getPath("appData"), `cocos-live-probe-${identity}-desktop${smokeMode ? "-" + randomUUID() : ""}`));
let window: BrowserWindow | undefined;
let gameView: WebContentsView | undefined;
let devToolsView: WebContentsView | undefined;
let panelMode: "nodes" | "devtools" = "nodes";
let service: RuntimeProbeService | undefined;
let server: import("http").Server | undefined;
let bridgeServer: import("http").Server | undefined;
let quitting = false;
let previewBounds = { x: 0, y: 48, width: 680, height: 800 };
let devToolsBounds = { x: 680, y: 78, width: 760, height: 800 };
let boundsRevision = 0;

function isPanelSender(sender: Electron.WebContents): boolean {
    return !!window && !window.isDestroyed() && sender === window.webContents;
}

async function syncPanelBounds(): Promise<void> {
    if (!window || window.isDestroyed() || window.webContents.isLoadingMainFrame()) return;
    const revision = ++boundsRevision;
    try {
        const layout = await window.webContents.executeJavaScript(`(() => {
            const measure = selector => { const element=document.querySelector(selector); if(!element) return null;
                const r=element.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}; };
            return {preview:measure(".preview .canvas"),tools:measure("#devtools-host")};
        })()`);
        if (revision !== boundsRevision || !window || window.isDestroyed()) return;
        if (layout.preview?.width > 0 && layout.preview?.height > 0) previewBounds = layout.preview;
        if (layout.tools?.width > 0 && layout.tools?.height > 0) devToolsBounds = layout.tools;
        previewBounds = Object.fromEntries(Object.entries(previewBounds).map(([key, value]) => [key, Math.round(value)])) as typeof previewBounds;
        devToolsBounds = Object.fromEntries(Object.entries(devToolsBounds).map(([key, value]) => [key, Math.round(value)])) as typeof devToolsBounds;
        applyBounds();
    } catch { /* The panel can navigate or close during a native resize. */ }
}

function destroyDevToolsView(): void {
    const view = devToolsView; devToolsView = undefined; panelMode = "nodes";
    if (view) {
        if (window && !window.isDestroyed()) window.contentView.removeChildView(view);
        if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
    }
    if (window && !window.isDestroyed()) window.webContents.send("inspector:panel-mode", "nodes");
}

function selectPanel(mode: "nodes" | "devtools"): void {
    if (mode === "devtools") {
        if (!gameView || gameView.webContents.isDestroyed()) throw new Error("游戏预览尚未连接");
        if (!devToolsView) {
            // A dedicated, initially unnavigated WebContents hosts Chromium's
            // real DevTools inside the existing window, inspecting the game.
            devToolsView = new WebContentsView({ webPreferences: {
                nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false,
                partition: `cocos-live-probe-devtools-${desktopInstanceId}`,
            } });
            devToolsView.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
            window!.contentView.addChildView(devToolsView);
            gameView.webContents.setDevToolsWebContents(devToolsView.webContents);
            gameView.webContents.openDevTools({ mode: "detach", activate: false });
        }
    }
    panelMode = mode; devToolsView?.setVisible(mode === "devtools"); applyBounds();
}

function applyBounds(): void {
    if (!window || window.isDestroyed()) return;
    const [width, height] = window.getContentSize();
    for (const [view, bounds] of [[gameView, previewBounds], [devToolsView, devToolsBounds]] as const) {
        if (!view) continue;
        const x = Math.min(bounds.x, width); const y = Math.min(bounds.y, height);
        view.setBounds({ x, y, width: Math.max(0, Math.min(bounds.width, width - x)), height: Math.max(0, Math.min(bounds.height, height - y)) });
    }
}
async function shutdown(exitCode = 0): Promise<void> {
    if (quitting) return; quitting = true;
    try {
        if (server) await new Promise<void>(resolve => { server!.close(() => resolve()); server!.closeAllConnections(); });
        if (bridgeServer) await new Promise<void>(resolve => { bridgeServer!.close(() => resolve()); bridgeServer!.closeAllConnections(); });
        gameView?.webContents.closeDevTools(); destroyDevToolsView();
        await service?.dispose();
    } finally { if (exitCode || smokeMode) app.exit(exitCode); else app.quit(); }
}

async function start(): Promise<void> {
    Menu.setApplicationMenu(null);
    window = new BrowserWindow({ width: 1460, height: 940, minWidth: 960, minHeight: 640,
        title: "Cocos Live Probe Inspector", backgroundColor: "#252526", show: false,
        webPreferences: { preload: path.join(__dirname, "inspector/desktop-preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false },
    });
    const native = createElectronProbeDependencies(view => {
        gameView = view; window!.contentView.addChildView(view); applyBounds();
        view.webContents.on("devtools-closed", destroyDevToolsView);
    }, view => {
        view.webContents.closeDevTools(); destroyDevToolsView();
        if (window && !window.isDestroyed()) window.contentView.removeChildView(view);
        if (gameView === view) gameView = undefined;
    });
    // Native Session isolation is independent of the Chrome used by CLI/stdio clients.
    service = new RuntimeProbeService({ ...runtimeProbeOptionsFromEnv(), workspaceRoot, browserExecutable: "",
        instanceId: desktopInstanceId, ownership: "isolated", readyTimeoutMs: 30000, dependencies: native,
    });
    server = createRuntimeInspectorServer(service);
    await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(0, "127.0.0.1", resolve); });
    const origin = `http://127.0.0.1:${(server.address() as import("net").AddressInfo).port}`;
    const bridge = await startInspectorBridge(service, { workspaceRoot: bridgeWorkspaceRoot, instanceId: desktopInstanceId,
        openWindow: () => { window!.show(); window!.focus(); },
        onCommand: kind => { if (window && !window.isDestroyed()) window.webContents.send("inspector:ai-activity", { kind, at: Date.now() }); },
    });
    bridgeServer = bridge.server;
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, destination) => { if (destination !== origin + "/desktop") event.preventDefault(); });
    ipcMain.on("inspector:bounds", (event, bounds) => {
        if (!isPanelSender(event.sender) || !bounds || !["x", "y", "width", "height"].every(key => Number.isFinite(bounds[key]) && bounds[key] >= 0)) return;
        previewBounds = Object.fromEntries(Object.entries(bounds).filter(([key]) => ["x", "y", "width", "height"].includes(key)).map(([key, value]) => [key, Math.round(Number(value))])) as typeof previewBounds;
        applyBounds();
    });
    ipcMain.on("inspector:devtools-bounds", (event, bounds) => {
        if (!isPanelSender(event.sender) || !bounds || !["x", "y", "width", "height"].every(key => Number.isFinite(bounds[key]) && bounds[key] >= 0)) return;
        // A hidden host has zero dimensions; retain its last visible bounds.
        if (!bounds.width || !bounds.height) return;
        devToolsBounds = { x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) };
        applyBounds();
    });
    ipcMain.handle("inspector:reload", async event => {
        if (!isPanelSender(event.sender)) throw new Error("Unknown inspector sender");
        return service!.dispatch({ kind: "refresh" });
    });
    ipcMain.handle("inspector:panel-mode", (event, mode) => {
        if (!isPanelSender(event.sender) || !["nodes", "devtools"].includes(mode)) throw new Error("Invalid inspector panel request");
        selectPanel(mode); return { mode: panelMode };
    });
    ipcMain.handle("inspector:devtools-close", event => {
        if (!isPanelSender(event.sender)) throw new Error("Unknown inspector sender");
        gameView?.webContents.closeDevTools(); destroyDevToolsView();
    });
    ipcMain.handle("inspector:ai-copy", (event, selectedUuid) => {
        if (!isPanelSender(event.sender)) throw new Error("Unknown inspector sender");
        if (selectedUuid != null && (typeof selectedUuid !== "string" || selectedUuid.length > 256)) throw new Error("Invalid selected node");
        const instructions = `请接入正在运行的 Probe Inspector，检查我在游戏中遇到的 bug。\n项目：${workspaceRoot}\n`
            + `调用 runtime_inspector_connect，参数 instanceId: "${desktopInstanceId}"。连接后先核对 runtime_status 的 instance.id，再读取节点、截图和诊断日志。`
            + `\n保留当前现场，不要重载游戏或创建另一个预览实例。${selectedUuid ? "\n当前选中的节点 UUID：" + selectedUuid : ""}`
            + `\n如果当前 MCP 尚未提供接入工具，可以在 ${path.join(workspaceRoot, "tools/cocos_live_probe")} 运行：`
            + `\nnpm run --silent runtime:probe -- --inspector --instance-id "${desktopInstanceId}" status`
            + `\n后续 scene-tree、find、node、animations、screenshot、diagnostics 命令也带同样的 --inspector --instance-id 参数。`;
        clipboard.writeText(instructions); return { instanceId: desktopInstanceId };
    });
    window.on("resize", () => { applyBounds(); void syncPanelBounds(); });
    window.on("close", event => { if (!quitting) { event.preventDefault(); void shutdown(); } });
    window.show();
    await service.dispatch({ kind: "launch" });
    await window.loadURL(origin + "/desktop");
    await syncPanelBounds();
    if (process.argv.includes("--smoke-test")) {
        await runSmokeTest(window, service);
        await shutdown();
    }
}

// Real Electron/Cocos acceptance checks run in their own private desktop Session.
async function runSmokeTest(panel: BrowserWindow, probe: RuntimeProbeService): Promise<void> {
    const { runDesktopInspectorSmoke } = await import("./test/runtime-inspector-desktop-smoke");
    await runDesktopInspectorSmoke(panel, probe, () => gameView!, { workspaceRoot: bridgeWorkspaceRoot, instanceId: desktopInstanceId,
        devToolsView: () => devToolsView,
        cliRoot: path.join(workspaceRoot, "tools/cocos_live_probe") });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
    app.on("second-instance", () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
    app.on("before-quit", event => { if (!quitting) { event.preventDefault(); void shutdown(); } });
    app.whenReady().then(start).catch(async error => {
        const message = error instanceof Error ? error.stack || error.message : String(error);
        if (process.argv.includes("--smoke-test")) {
            fs.writeFileSync(path.join(os.tmpdir(), "cocos-live-inspector-desktop-error.log"), message); process.stderr.write(message + "\n");
            if (service) {
                try { process.stderr.write(JSON.stringify(await service.dispatch({ kind: "diagnostics", levels: ["error", "warn"], limit: 30 }), null, 2) + "\n"); }
                catch { /* Preserve the original failure if the renderer is already gone. */ }
            }
        }
        else dialog.showErrorBox("Cocos Live Probe Inspector 启动失败", message);
        await shutdown(1);
    });
}
