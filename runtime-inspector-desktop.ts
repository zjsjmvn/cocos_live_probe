import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, WebContentsView } from "electron";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { randomUUID } from "crypto";
import { createElectronProbeDependencies } from "./runtime-electron-adapter";
import { createRuntimeInspectorServer } from "./runtime-inspector";
import { startInspectorBridge } from "./runtime-inspector-bridge";
import { createRuntimeProbeWorkspaceDefaults, RuntimeProbeService, runtimeProbeOptionsFromEnv } from "./runtime-probe";
import { buildPreviewToolsExpression, parsePreviewToolRequest, PreviewInteractionMode } from "./runtime-inspector-preview-tools";
import { InspectorPreferences, parseInspectorPreferences } from "./runtime-inspector-preferences";

const workspaceRoot = path.resolve(process.env.COCOS_RUNTIME_PROBE_WORKSPACE_ROOT || (app.isPackaged
    ? path.join(path.dirname(app.getPath("exe")), "../../../..")
    : path.join(__dirname, "../../..")));
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
let panelMode: "nodes" | "devtools" | "workbench" = "nodes";
let service: RuntimeProbeService | undefined;
let server: import("http").Server | undefined;
let bridgeServer: import("http").Server | undefined;
let quitting = false;
let previewBounds = { x: 0, y: 48, width: 680, height: 800 };
let devToolsBounds = { x: 680, y: 78, width: 760, height: 800 };
let boundsRevision = 0;
let previewResolution = { width: 0, height: 0 };
let previewMode: PreviewInteractionMode = "off";
let previewFps: boolean | null = null;
const appearancePath = path.join(app.getPath("userData"), "appearance.json");
function savedAppearance(): { theme: "graphite" | "midnight" | "light"; density: "comfortable" | "compact"; preferences: InspectorPreferences } {
    try {
        const stored = JSON.parse(fs.readFileSync(appearancePath, "utf8"));
        return { theme: stored.theme === "midnight" || stored.theme === "light" ? stored.theme : "graphite",
            density: stored.density === "compact" ? "compact" : "comfortable", preferences: parseInspectorPreferences(stored.preferences || {}) };
    } catch { /* Missing or invalid preferences use the default appearance. */ }
    return { theme: "graphite", density: "comfortable", preferences: {} };
}
function savedTheme() { return savedAppearance().theme; }
function saveAppearance(update: Partial<ReturnType<typeof savedAppearance>>) {
    const appearance = { ...savedAppearance(), ...update };
    fs.mkdirSync(path.dirname(appearancePath), { recursive: true });
    fs.writeFileSync(appearancePath + ".tmp", JSON.stringify(appearance), "utf8");
    fs.renameSync(appearancePath + ".tmp", appearancePath);
    return appearance;
}

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

function selectPanel(mode: "nodes" | "devtools" | "workbench"): void {
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

// 「等比缩放预览」是用 webContents.setZoomFactor() 实现的，而 Chromium 的页面缩放会连乘进
// window.devicePixelRatio。Cocos 引擎只在它自己的 dpr media-query 状态翻转时才重算画布后备
// （pal/screen-adapter/web/screen-adapter.js 的 updateDPRChangeListener），而该查询用的是被
// Math.min(dpr, 2) 钳位后的值 —— 真实 dpr 一旦越过 2，这个查询就永远处于不匹配态，状态不会再
// 翻转，画布后备会被永久冻结。此后 输入换算用的 dpr 与 canvas.width 脱节，命中位置随时间成比例
// 偏移（ratio < 1 时点上面的按钮会命中下面那个）。所以每次改过 zoom 之后，都让渲染根按当前 dpr
// 重算一次。注入体是幂等的：只有真的对不上才动手。
const GAME_VIEWPORT_SYNC = `(() => {
    const cc = globalThis.cc;
    const canvas = cc && cc.game && cc.game.canvas;
    const root = cc && cc.director && cc.director.root;
    if (!canvas || !root) return "engine-not-ready";
    let target = null;
    try {
        const size = cc.screen && cc.screen.windowSize;
        if (size && size.width > 0 && size.height > 0) target = { width: size.width, height: size.height };
    } catch (error) { /* 回退到画布 rect × dpr 的估算 */ }
    if (!target) {
        const dpr = (cc.screen && cc.screen.devicePixelRatio) || Math.min(window.devicePixelRatio || 1, 2);
        const rect = canvas.getBoundingClientRect();
        target = { width: rect.width * dpr, height: rect.height * dpr };
    }
    if (Math.abs(canvas.width - target.width) <= 1 && Math.abs(canvas.height - target.height) <= 1) return "synced";
    root.resize(target.width, target.height, 1);
    return "resized";
})()`;
let viewportSyncSchedule: ReturnType<typeof setTimeout> | undefined;
// 预览布局每次变化后核对一次画布后备。setZoomFactor 会改 dpr，把窗口移到另一块缩放不同的
// 显示器也会改，而引擎在钳位之后就不再跟踪 dpr 了。注入体是幂等的，这里再做一次防抖。
function scheduleGameViewportSync(): void {
    if (viewportSyncSchedule) clearTimeout(viewportSyncSchedule);
    viewportSyncSchedule = setTimeout(() => {
        viewportSyncSchedule = undefined;
        if (!service || !gameView || gameView.webContents.isDestroyed() || gameView.webContents.isLoading()) return;
        void service.dispatch({ kind: "eval", expression: GAME_VIEWPORT_SYNC }).catch(() => { /* 页面可能在缩放期间导航或退出 */ });
    }, 160);
}

function applyBounds(): void {
    if (!window || window.isDestroyed()) return;
    const [width, height] = window.getContentSize();
    for (const [view, bounds] of [[gameView, previewBounds], [devToolsView, devToolsBounds]] as const) {
        if (!view) continue;
        const x = Math.min(bounds.x, width); const y = Math.min(bounds.y, height);
        const availableWidth = Math.max(0, Math.min(bounds.width, width - x)), availableHeight = Math.max(0, Math.min(bounds.height, height - y));
        if (view === gameView && previewResolution.width && availableWidth && availableHeight) {
            const scale = Math.min(availableWidth / previewResolution.width, availableHeight / previewResolution.height, 2);
            const gameWidth = Math.floor(previewResolution.width * scale), gameHeight = Math.floor(previewResolution.height * scale);
            if (Math.abs(view.webContents.getZoomFactor() - scale) > 0.0001) view.webContents.setZoomFactor(scale);
            view.setBounds({ x: Math.round(x + (availableWidth - gameWidth) / 2), y: Math.round(y + (availableHeight - gameHeight) / 2), width: gameWidth, height: gameHeight });
        } else {
            if (view === gameView && view.webContents.getZoomFactor() !== 1) view.webContents.setZoomFactor(1);
            view.setBounds({ x, y, width: availableWidth, height: availableHeight });
        }
    }
    scheduleGameViewportSync();
}
async function previewToolState(): Promise<any> {
    const state = await service!.dispatch({ kind: "eval", expression: buildPreviewToolsExpression({ action: "state" }) }) as any;
    return { ...state, muted: gameView!.webContents.isAudioMuted(), resolution: previewResolution };
}
async function restorePreviewTools(): Promise<void> {
    await service!.dispatch({ kind: "launch" });
    if (previewFps !== null) await service!.dispatch({ kind: "eval", expression: buildPreviewToolsExpression({ action: "fps", enabled: previewFps }) });
    if (previewMode !== "off") await service!.dispatch({ kind: "eval", expression: buildPreviewToolsExpression({ action: "mode", mode: previewMode }) });
    const state = await previewToolState();
    if (window && !window.isDestroyed()) window.webContents.send("inspector:game-tool-event", { kind: "state", state });
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
    const theme = savedTheme();
    window = new BrowserWindow({ width: 1460, height: 940, minWidth: 960, minHeight: 640,
        title: "Cocos Live Probe Inspector", backgroundColor: theme === "light" ? "#eef1f5" : theme === "midnight" ? "#111824" : "#16191f", show: false,
        webPreferences: { preload: path.join(__dirname, "inspector/desktop-preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false },
    });
    const native = createElectronProbeDependencies(view => {
        gameView = view; window!.contentView.addChildView(view); applyBounds();
        view.webContents.on("devtools-closed", destroyDevToolsView);
        view.webContents.on("did-finish-load", () => {
            if (previewFps !== null || previewMode !== "off") void restorePreviewTools().catch(error => {
                if (window && !window.isDestroyed()) window.webContents.send("inspector:game-tool-event", { kind: "error", message: String(error) });
            });
        });
    }, view => {
        view.webContents.closeDevTools(); destroyDevToolsView();
        if (window && !window.isDestroyed()) window.contentView.removeChildView(view);
        if (gameView === view) gameView = undefined;
    });
    // Native Session isolation is independent of the Chrome used by CLI/stdio clients.
    service = new RuntimeProbeService({ ...runtimeProbeOptionsFromEnv(), workspaceRoot, browserExecutable: "",
        instanceId: desktopInstanceId, ownership: "isolated", readyTimeoutMs: 30000, dependencies: native,
    });
    server = createRuntimeInspectorServer(service, savedTheme, () => savedAppearance().density);
    await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(0, "127.0.0.1", resolve); });
    const origin = `http://127.0.0.1:${(server.address() as import("net").AddressInfo).port}`;
    const bridge = await startInspectorBridge(service, { workspaceRoot: bridgeWorkspaceRoot, instanceId: desktopInstanceId,
        openWindow: () => { window!.show(); window!.focus(); },
        onCommand: kind => { if (window && !window.isDestroyed()) window.webContents.send("inspector:ai-activity", { kind, at: Date.now() }); },
    });
    bridgeServer = bridge.server;
    ipcMain.handle("inspector:theme-save", (event, selected) => {
        if (!isPanelSender(event.sender) || !["graphite", "midnight", "light"].includes(selected)) throw new Error("Invalid inspector theme");
        const appearance = saveAppearance({ theme: selected });
        window!.setBackgroundColor(selected === "light" ? "#eef1f5" : selected === "midnight" ? "#111824" : "#16191f");
        return appearance;
    });
    ipcMain.handle("inspector:density-save", (event, selected) => {
        if (!isPanelSender(event.sender) || !["comfortable", "compact"].includes(selected)) throw new Error("Invalid inspector density");
        return saveAppearance({ density: selected });
    });
    ipcMain.handle("inspector:preferences", (event, request) => {
        if (!isPanelSender(event.sender) || !request || typeof request !== "object") throw new Error("Unknown inspector sender");
        if (request.action === "get" && Object.keys(request).length === 1) return savedAppearance().preferences;
        if (request.action !== "set" || Object.keys(request).length !== 2) throw new Error("Invalid preference request");
        return saveAppearance({ preferences: parseInspectorPreferences(request.value) }).preferences;
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, destination) => { if (destination !== origin + "/desktop") event.preventDefault(); });
    ipcMain.handle("inspector:preview-tool", async (event, value) => {
        if (!isPanelSender(event.sender) || !gameView || gameView.webContents.isDestroyed()) throw new Error("Unknown inspector sender or unavailable preview");
        const request = parsePreviewToolRequest(value);
        if (request.action === "mute") gameView.webContents.setAudioMuted(request.enabled);
        else if (request.action === "cache") {
            if (request.operation === "http") await gameView.webContents.session.clearCache();
            else await gameView.webContents.session.clearStorageData({ storages: ["cookies"] });
        }
        else if (request.action === "resolution") {
            const previous = previewResolution;
            try { previewResolution = { width: request.width, height: request.height }; applyBounds(); }
            catch (error) { previewResolution = previous; applyBounds(); throw error; }
            await new Promise(resolve => setTimeout(resolve, 80));
        } else {
            await service!.dispatch({ kind: "eval", expression: buildPreviewToolsExpression(request) });
            if (request.action === "fps") previewFps = request.enabled;
            if (request.action === "mode") previewMode = request.mode;
        }
        return previewToolState();
    });
    ipcMain.on("inspector:game-tool-event", (event, payload) => {
        if (!gameView || event.sender !== gameView.webContents || event.senderFrame !== gameView.webContents.mainFrame
            || !payload || typeof payload !== "object" || !window || window.isDestroyed()) return;
        if (["select", "drag"].includes(payload.kind) && typeof payload.uuid === "string" && payload.uuid.length <= 256) {
            window.webContents.send("inspector:game-tool-event", { kind: payload.kind, uuid: payload.uuid });
        } else if (payload.kind === "mode" && payload.mode === "off") {
            previewMode = "off"; window.webContents.send("inspector:game-tool-event", { kind: "mode", mode: "off" });
        } else if (payload.kind === "error" && typeof payload.message === "string") {
            window.webContents.send("inspector:game-tool-event", { kind: "error", message: payload.message.slice(0, 1000) });
        }
    });
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
        if (!isPanelSender(event.sender) || !["nodes", "devtools", "workbench"].includes(mode)) throw new Error("Invalid inspector panel request");
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
