import { WebContents, WebContentsView } from "electron";
import { randomUUID } from "crypto";
import { createConnection } from "net";
import { CdpTarget, CdpTargetInfo, decodeRuntimeEvaluateResponse } from "./cdp-runtime-probe-core";
import { RuntimeProbeBrowserClient, RuntimeProbeDependencies, RuntimeProbeEvaluator } from "./runtime-probe";

// A context is a private Electron Session, and a target is one exact WebContents.
// The service retains its normal identity checks and queue without needing Chrome/CDP ports.
export function createElectronProbeDependencies(
    attachView: (view: WebContentsView) => void,
    detachView: (view: WebContentsView) => void,
): Partial<RuntimeProbeDependencies> {
    const contexts = new Map<string, { view?: WebContentsView; id?: string }>();
    const entryFor = (targetId: string) => {
        const entry = [...contexts.entries()].find(([, entry]) => entry.id === targetId && entry.view && !entry.view.webContents.isDestroyed());
        if (!entry) throw new Error("Desktop preview target was lost");
        return entry as [string, { view: WebContentsView; id: string }];
    };
    const infoFor = (targetId: string): CdpTargetInfo => {
        const [contextId, entry] = entryFor(targetId);
        return { targetId, browserContextId: contextId, type: "page", title: entry.view.webContents.getTitle(),
            url: entry.view.webContents.getURL(), attached: true };
    };
    const targetFor = (targetId: string): CdpTarget => {
        const info = infoFor(targetId);
        return { id: targetId, type: "page", title: info.title, url: info.url, webSocketDebuggerUrl: `ws://127.0.0.1/desktop/${targetId}` };
    };
    const browser: RuntimeProbeBrowserClient = {
        getVersion: async () => ({ product: `Electron/${process.versions.electron}`, chrome: process.versions.chrome, transport: "native-webcontents-debugger" }),
        createBrowserContext: async () => { const id = randomUUID(); contexts.set(id, {}); return id; },
        createTarget: async (url, contextId) => {
            const entry = contextId ? contexts.get(contextId) : undefined;
            if (!entry || entry.view) throw new Error("Desktop preview requires a new owned context");
            const view = new WebContentsView({ webPreferences: {
                partition: `cocos-live-probe-${contextId}`, nodeIntegration: false, contextIsolation: true,
                sandbox: true, backgroundThrottling: false,
            } });
            entry.view = view; entry.id = String(view.webContents.id);
            view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
            view.webContents.on("will-navigate", (event, destination) => { if (destination !== url) event.preventDefault(); });
            attachView(view);
            await view.webContents.loadURL(url);
            return entry.id;
        },
        getTargetInfo: async targetId => infoFor(targetId),
        disposeBrowserContext: async contextId => {
            const entry = contexts.get(contextId); contexts.delete(contextId);
            if (entry?.view) { detachView(entry.view); if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close({ waitForBeforeUnload: false }); }
        },
        dispose: () => {},
    };
    return {
        // Even HEAD goes through Creator's homepage initialization handler.
        // Check the local listener without requesting another preview page;
        // loadURL and the service's Cocos readiness check validate its content.
        checkPreview: url => new Promise<boolean>(resolve => {
            const endpoint = new URL(url);
            const socket = createConnection({ host: endpoint.hostname, port: Number(endpoint.port || (endpoint.protocol === "https:" ? 443 : 80)) });
            const finish = (available: boolean) => { socket.destroy(); resolve(available); };
            socket.setTimeout(5000); socket.once("connect", () => finish(true));
            socket.once("error", () => finish(false)); socket.once("timeout", () => finish(false));
        }),
        getBrowserWebSocketUrl: async () => "ws://127.0.0.1/desktop",
        createBrowserClient: () => browser,
        listTargets: async () => [...contexts.values()].filter(entry => entry.id && entry.view && !entry.view.webContents.isDestroyed()).map(entry => targetFor(entry.id!)),
        createEvaluator: address => new ElectronProbeEvaluator(entryFor(address.split("/").pop()!)[1].view.webContents),
        withChromeLaunchLock: operation => operation(),
        withSharedTargetLock: operation => operation(),
    };
}

class ElectronProbeEvaluator implements RuntimeProbeEvaluator {
    private readonly listeners = new Map<string, Set<(params: unknown) => void>>();
    private disposed = false;
    private readonly onMessage = (_event: Electron.Event, method: string, params: unknown) => {
        for (const listener of this.listeners.get(method) ?? []) listener(params);
    };
    private readonly onDetached = (_event: Electron.Event, reason: string) => {
        if (!this.disposed) for (const listener of this.listeners.get("Probe.disconnected") ?? []) listener({ reason, transport: "native-webcontents-debugger" });
    };
    constructor(private readonly page: WebContents) {
        page.debugger.on("message", this.onMessage);
        page.debugger.on("detach", this.onDetached);
    }
    async send(method: string, params: Readonly<Record<string, unknown>> = {}, timeoutMs = 10000): Promise<unknown> {
        if (this.disposed || this.page.isDestroyed()) throw new Error("Desktop preview evaluator is closed");
        if (!this.page.debugger.isAttached()) this.page.debugger.attach("1.3");
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([
                this.page.debugger.sendCommand(method, params),
                new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Desktop ${method} timed out`)), timeoutMs); }),
            ]);
        } finally { if (timer) clearTimeout(timer); }
    }
    async evaluate(expression: string): Promise<unknown> {
        const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
        return decodeRuntimeEvaluateResponse({ result });
    }
    onEvent(method: string, listener: (params: unknown) => void): () => void {
        const listeners = this.listeners.get(method) ?? new Set(); listeners.add(listener); this.listeners.set(method, listeners);
        return () => { listeners.delete(listener); };
    }
    async reload(onAccepted?: () => void): Promise<void> {
        await this.send("Page.enable");
        const tree = await this.send("Page.getFrameTree") as { frameTree: { frame: { id: string; loaderId: string } } };
        const before = tree.frameTree.frame;
        let remove = () => {}; let timer: ReturnType<typeof setTimeout> | undefined;
        const navigated = new Promise<void>((resolve, reject) => {
            remove = this.onEvent("Page.frameNavigated", (params: any) => {
                if (params.frame?.id === before.id && !params.frame.parentId && params.frame.loaderId !== before.loaderId) resolve();
            });
            timer = setTimeout(() => reject(new Error("Desktop preview reload timed out")), 10000);
        });
        void navigated.catch(() => undefined);
        try { await this.send("Page.reload", { ignoreCache: true, loaderId: before.loaderId }); onAccepted?.(); await navigated; }
        finally { remove(); if (timer) clearTimeout(timer); }
    }
    dispose(): void {
        this.disposed = true; this.listeners.clear(); this.page.debugger.off("message", this.onMessage);
        this.page.debugger.off("detach", this.onDetached);
        if (!this.page.isDestroyed() && this.page.debugger.isAttached()) this.page.debugger.detach();
    }
}
