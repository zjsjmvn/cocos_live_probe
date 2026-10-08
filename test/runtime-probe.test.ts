import * as assert from "assert";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { Readable } from "stream";
import { runInNewContext } from "vm";
import {
    buildCocosProbeExpression,
    CdpBrowserClient,
    CdpCommandClient,
    CdpRuntimeProbe,
    CdpTarget,
    CdpTargetInfo,
    decodeRuntimeEvaluateResponse,
    RuntimeProbeSocket,
    selectPreviewTarget,
} from "../cdp-runtime-probe-core";
import {
    buildChromeLaunchArgs,
    buildManagedPreviewUrl,
    createRuntimeProbeWorkspaceDefaults,
    parseRuntimeProbeArgs,
    resolveChromeExecutable,
    RuntimeProbeBrowserClient,
    RuntimeProbeDependencies,
    RuntimeProbeEvaluator,
    RuntimeProbeService,
    RuntimeProbeServiceOptions,
    runRuntimeProbeCli,
    runtimeProbeOptionsFromEnv,
} from "../runtime-probe";
import {
    handleRuntimeProbeMcpMessage,
    processRuntimeProbeMcpLine,
    RUNTIME_PROBE_MCP_TOOLS,
    runRuntimeProbeMcpHttp,
    runRuntimeProbeMcpStdio,
} from "../runtime-probe-mcp";

const PREVIEW_ORIGIN = "http://127.0.0.1:7456";
const LEGACY_HOST_NAME = ["zhuan", "dao"].join("");
const LEGACY_HOST_PATTERN = new RegExp(LEGACY_HOST_NAME, "i");

assert.throws(
    () => selectPreviewTarget([], PREVIEW_ORIGIN),
    /No CDP page target matches http:\/\/127\.0\.0\.1:7456/,
);
assert.throws(
    () => selectPreviewTarget([
        {
            id: "wrong-origin",
            type: "page",
            url: "http://127.0.0.1:7457/",
            webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/wrong-origin",
        },
    ], PREVIEW_ORIGIN),
    /No CDP page target matches/,
);
assert.throws(
    () => selectPreviewTarget([
        {
            id: "one",
            type: "page",
            url: "http://127.0.0.1:7456/",
            webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/one",
        },
        {
            id: "two",
            type: "page",
            url: "http://127.0.0.1:7456/?duplicate=1",
            webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/two",
        },
    ], PREVIEW_ORIGIN),
    /Multiple CDP page targets match/,
);

const selected = selectPreviewTarget([
    {
        id: "browser",
        type: "browser",
        url: "",
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/one",
    },
    {
        id: "missing-socket",
        type: "page",
        url: "http://127.0.0.1:7456/",
    },
    {
        id: "preview",
        title: "Cocos Creator - Cocos Preview",
        type: "page",
        url: "http://127.0.0.1:7456/?v=1",
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/preview",
    },
], PREVIEW_ORIGIN);
assert.strictEqual(selected.id, "preview");

assert.deepStrictEqual(
    decodeRuntimeEvaluateResponse({
        id: 1,
        result: {
            result: {
                type: "object",
                value: { scene: "battle" },
            },
        },
    }),
    { scene: "battle" },
);
assert.strictEqual(
    decodeRuntimeEvaluateResponse({
        id: 2,
        result: { result: { type: "undefined" } },
    }),
    undefined,
);
assert.throws(
    () => decodeRuntimeEvaluateResponse({
        id: 3,
        error: { code: -32000, message: "Runtime agent unavailable" },
    }),
    /CDP Runtime\.evaluate failed.*Runtime agent unavailable/,
);
assert.throws(
    () => decodeRuntimeEvaluateResponse({
        id: 4,
        result: {
            exceptionDetails: {
                text: "Uncaught",
                exception: { description: "Error: scene unavailable" },
            },
            result: { type: "object" },
        },
    }),
    /Cocos preview evaluation failed.*scene unavailable/,
);
assert.throws(
    () => decodeRuntimeEvaluateResponse({ id: 5, result: {} }),
    /missing Runtime\.evaluate result/,
);

const treeExpression = buildCocosProbeExpression({
    kind: "scene-tree",
    maxDepth: 4,
    includeInactive: false,
});
assert.ok(treeExpression.includes('globalThis.System.import("cc")'));
assert.ok(treeExpression.includes("cc.director.getScene()"));
assert.ok(treeExpression.includes('"kind":"scene-tree"'));
assert.ok(treeExpression.includes('"maxDepth":4'));
assert.ok(treeExpression.includes('"includeInactive":false'));

const injectedSelector = 'enemy-0"; throw new Error("injected") //';
const findExpression = buildCocosProbeExpression({
    kind: "find",
    selector: injectedSelector,
});
assert.ok(findExpression.includes(JSON.stringify(injectedSelector)));
assert.ok(!findExpression.includes(`const selector = "${injectedSelector}"`));
assert.ok(findExpression.includes("pathOf"));

const nodeExpression = buildCocosProbeExpression({
    kind: "node",
    selector: "/battle/Actors/enemy-0",
});
for (const contract of [
    "activeInHierarchy",
    "worldPosition",
    "eulerAngles",
    "components",
    "worldBounds",
]) {
    assert.ok(nodeExpression.includes(contract), `node probe must include ${contract}`);
}

const animationExpression = buildCocosProbeExpression({
    kind: "animations",
    selector: "enemy-0",
});
for (const contract of [
    "SkeletalAnimation",
    "SkinnedMeshRenderer",
    "useBakedAnimation",
    "wrapMode",
    "_curveLoaded",
    "_curvesInited",
    "_doNotCreateEval",
    "_clipEval",
    "Bip001",
    "worldBounds",
]) {
    assert.ok(animationExpression.includes(contract), `animation probe must include ${contract}`);
}

assert.deepStrictEqual(parseRuntimeProbeArgs(["status"]), { kind: "status" });
assert.deepStrictEqual(parseRuntimeProbeArgs(["launch"]), { kind: "launch" });
assert.deepStrictEqual(parseRuntimeProbeArgs(["refresh"]), { kind: "refresh" });
assert.deepStrictEqual(parseRuntimeProbeArgs(["scene-tree"]), {
    kind: "scene-tree",
    maxDepth: 4,
    includeInactive: false,
});
assert.deepStrictEqual(
    parseRuntimeProbeArgs(["scene-tree", "--include-inactive", "--max-depth", "6"]),
    { kind: "scene-tree", maxDepth: 6, includeInactive: true },
);
assert.deepStrictEqual(parseRuntimeProbeArgs(["find", "enemy-0"]), {
    kind: "find",
    selector: "enemy-0",
});
assert.deepStrictEqual(parseRuntimeProbeArgs(["node", "/battle/Actors/enemy-0"]), {
    kind: "node",
    selector: "/battle/Actors/enemy-0",
});
assert.deepStrictEqual(parseRuntimeProbeArgs(["animations", "enemy-0"]), {
    kind: "animations",
    selector: "enemy-0",
});
assert.deepStrictEqual(parseRuntimeProbeArgs(["sample-animation", "enemy-0"]), {
    kind: "sample-animation",
    selector: "enemy-0",
    durationSeconds: 1,
    intervalSeconds: 0.1,
});
assert.deepStrictEqual(
    parseRuntimeProbeArgs([
        "sample-animation",
        "enemy-0",
        "--duration",
        "0.25",
        "--interval",
        "0.1",
    ]),
    {
        kind: "sample-animation",
        selector: "enemy-0",
        durationSeconds: 0.25,
        intervalSeconds: 0.1,
    },
);
assert.deepStrictEqual(parseRuntimeProbeArgs(["eval", "({", "answer:", "42", "})"]), {
    kind: "eval",
    expression: "({ answer: 42 })",
});
assert.deepStrictEqual(parseRuntimeProbeArgs(["eval-file", "diagnostics/dead.js"]), {
    kind: "eval-file",
    path: "diagnostics/dead.js",
});
for (const invalidArgs of [
    [],
    ["unknown"],
    ["find"],
    ["scene-tree", "--max-depth", "13"],
    ["sample-animation", "enemy-0", "--duration", "31"],
    ["sample-animation", "enemy-0", "--interval", "0"],
]) {
    assert.throws(() => parseRuntimeProbeArgs(invalidArgs), /runtime probe|requires|must be|Unknown/i);
}

assert.strictEqual(
    resolveChromeExecutable(["missing.exe", "chrome.exe"], candidate => candidate === "chrome.exe"),
    "chrome.exe",
);
assert.throws(
    () => resolveChromeExecutable(["missing.exe"], () => false),
    /Chrome executable was not found/,
);
assert.deepStrictEqual(buildChromeLaunchArgs({
    debuggingAddress: "127.0.0.1",
    debuggingPort: 9222,
    profileDirectory: "C:\\tmp\\cocos-live-probe",
}), [
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=9222",
    "--user-data-dir=C:\\tmp\\cocos-live-probe",
    "--no-first-run",
    "--no-default-browser-check",
    "--no-startup-window",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
]);
assert.strictEqual(
    buildManagedPreviewUrl("http://127.0.0.1:7456/", "dialog-a"),
    "http://127.0.0.1:7456/?autoReload=false&runtimeProbeInstance=dialog-a",
);

const projectARoot = path.join(os.tmpdir(), "cocos-project-a");
const projectA = createRuntimeProbeWorkspaceDefaults(projectARoot);
const projectARepeat = createRuntimeProbeWorkspaceDefaults(projectARoot);
const projectB = createRuntimeProbeWorkspaceDefaults(
    path.join(os.tmpdir(), "cocos-project-b"),
);
assert.deepStrictEqual(projectA, projectARepeat);
assert.notStrictEqual(projectA.identity, projectB.identity);
assert.notStrictEqual(projectA.chromeProfileDirectory, projectB.chromeProfileDirectory);
assert.notStrictEqual(projectA.chromeLaunchLockPath, projectB.chromeLaunchLockPath);
assert.match(projectA.chromeProfileDirectory, /cocos-live-probe/);
assert.doesNotMatch(JSON.stringify(projectA), LEGACY_HOST_PATTERN);
const projectAService = new RuntimeProbeService({ workspaceRoot: projectARoot });
assert.strictEqual(
    (projectAService as unknown as { chromeProfileDirectory: string }).chromeProfileDirectory,
    projectA.chromeProfileDirectory,
);

type SocketEventName = "open" | "message" | "error" | "close";

class FakeSocket implements RuntimeProbeSocket {
    public readyState = 0;
    public readonly sent: string[] = [];
    public readonly reloadResponseSent = deferred<void>();
    public holdReloadNavigation = false;
    private readonly listeners = new Map<SocketEventName, Array<(event: unknown) => void>>();
    private pendingReloadNavigation = false;

    public addEventListener(type: SocketEventName, listener: (event: unknown) => void): void {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
    }

    public send(data: string): void {
        this.sent.push(data);
        const request = JSON.parse(data) as {
            id: number;
            method: string;
            params: Readonly<Record<string, unknown>>;
        };
        queueMicrotask(() => {
            this.emitProtocolMessage({
                id: request.id,
                result: this.resultFor(request.method),
            });
            if (request.method === "Page.reload") {
                this.reloadResponseSent.resolve(undefined);
                this.emitProtocolMessage({
                    method: "Page.frameNavigated",
                    params: {
                        frame: {
                            id: "frame-main",
                            loaderId: "loader-old",
                            url: "http://127.0.0.1:7456/",
                        },
                    },
                });
                if (this.holdReloadNavigation) {
                    this.pendingReloadNavigation = true;
                } else {
                    queueMicrotask(() => this.emitReloadNavigation());
                }
            }
        });
    }

    public releaseReloadNavigation(): void {
        if (!this.pendingReloadNavigation) return;
        this.pendingReloadNavigation = false;
        this.emitReloadNavigation();
    }

    private resultFor(method: string): Readonly<Record<string, unknown>> {
        switch (method) {
            case "Runtime.evaluate":
                return {
                    result: {
                        type: "object",
                        value: { requestId: this.sent.length },
                    },
                };
            case "Page.getFrameTree":
                return {
                    frameTree: {
                        frame: {
                            id: "frame-main",
                            loaderId: "loader-old",
                            url: "http://127.0.0.1:7456/",
                        },
                    },
                };
            case "Target.createBrowserContext":
                return { browserContextId: "context-a" };
            case "Target.createTarget":
                return { targetId: "target-a" };
            case "Target.getTargetInfo":
                return {
                    targetInfo: {
                        targetId: "target-a",
                        type: "page",
                        title: "Cocos Creator - Cocos Preview",
                        url: "http://127.0.0.1:7456/?autoReload=false&runtimeProbeInstance=a",
                        attached: false,
                        browserContextId: "context-a",
                    },
                };
            default:
                return {};
        }
    }

    public close(): void {
        this.readyState = 3;
        this.emit("close", {});
    }

    public open(): void {
        this.readyState = 1;
        this.emit("open", {});
    }

    private emit(type: SocketEventName, event: unknown): void {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
    }

    private emitProtocolMessage(message: unknown): void {
        this.emit("message", { data: JSON.stringify(message) });
    }

    private emitReloadNavigation(): void {
        this.emitProtocolMessage({
            method: "Page.frameNavigated",
            params: {
                frame: {
                    id: "frame-main",
                    loaderId: "loader-new",
                    url: "http://127.0.0.1:7456/",
                },
            },
        });
    }
}

class ManualSocket implements RuntimeProbeSocket {
    public readyState = 0;
    public readonly sent: string[] = [];
    public closeCount = 0;
    private readonly listeners = new Map<SocketEventName, Array<(event: unknown) => void>>();

    public addEventListener(type: SocketEventName, listener: (event: unknown) => void): void {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
    }

    public send(data: string): void {
        this.sent.push(data);
    }

    public close(): void {
        this.closeCount += 1;
        this.readyState = 3;
        this.emitClose();
    }

    public open(): void {
        this.readyState = 1;
        this.emit("open", {});
    }

    public emitMessage(message: unknown): void {
        this.emit("message", { data: JSON.stringify(message) });
    }

    public emitError(error: Error): void {
        this.emit("error", error);
    }

    public emitClose(): void {
        this.emit("close", {});
    }

    private emit(type: SocketEventName, event: unknown): void {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
}

async function verifyCdpClient(): Promise<void> {
    let socket: FakeSocket | undefined;
    let socketUrl = "";
    const probe = new CdpRuntimeProbe("ws://127.0.0.1:9222/devtools/page/preview", {
        createSocket: url => {
            socketUrl = url;
            socket = new FakeSocket();
            queueMicrotask(() => socket?.open());
            return socket;
        },
        timeoutMs: 100,
    });

    assert.deepStrictEqual(await probe.evaluate("({ scene: 'battle' })"), { requestId: 1 });
    assert.ok(socket);
    assert.strictEqual(socketUrl, "ws://127.0.0.1:9222/devtools/page/preview");
    const firstRequest = JSON.parse(socket!.sent[0]) as {
        id: number;
        method: string;
        params: Record<string, unknown>;
    };
    assert.deepStrictEqual(firstRequest, {
        id: 1,
        method: "Runtime.evaluate",
        params: {
            expression: "({ scene: 'battle' })",
            awaitPromise: true,
            returnByValue: true,
        },
    });

    assert.deepStrictEqual(await probe.evaluate("2 + 2"), { requestId: 2 });
    assert.strictEqual(socket!.sent.length, 2, "a connected CDP socket should be reused");

    socket!.holdReloadNavigation = true;
    let reloadAccepted = false;
    let reloadCompleted = false;
    const reloadAcceptedSignal = deferred<void>();
    const reload = probe.reload(() => {
        reloadAccepted = true;
        reloadAcceptedSignal.resolve(undefined);
    }).then(() => {
        reloadCompleted = true;
    });
    await socket!.reloadResponseSent.promise;
    await reloadAcceptedSignal.promise;
    assert.strictEqual(reloadAccepted, true, "reload acceptance must be observable before navigation");
    assert.strictEqual(reloadCompleted, false, "reload must still wait for the new main-frame loader");
    socket!.releaseReloadNavigation();
    await reload;
    assert.deepStrictEqual(
        socket!.sent.slice(-3).map(data => {
            const request = JSON.parse(data) as {
                method: string;
                params: Readonly<Record<string, unknown>>;
            };
            return [request.method, request.params];
        }),
        [
            ["Page.enable", {}],
            ["Page.getFrameTree", {}],
            ["Page.reload", { ignoreCache: true, loaderId: "loader-old" }],
        ],
    );
    probe.dispose();
    assert.strictEqual(socket!.readyState, 3);

    let browserSocket: FakeSocket | undefined;
    const browser = new CdpBrowserClient("ws://127.0.0.1:9222/devtools/browser/test", {
        createSocket: () => {
            browserSocket = new FakeSocket();
            queueMicrotask(() => browserSocket?.open());
            return browserSocket;
        },
        timeoutMs: 100,
    });
    assert.strictEqual(await browser.createBrowserContext(), "context-a");
    const managedUrl = "http://127.0.0.1:7456/?autoReload=false&runtimeProbeInstance=a";
    assert.strictEqual(await browser.createTarget(managedUrl, "context-a"), "target-a");
    assert.deepStrictEqual(await browser.getTargetInfo("target-a"), {
        targetId: "target-a",
        type: "page",
        title: "Cocos Creator - Cocos Preview",
        url: managedUrl,
        attached: false,
        browserContextId: "context-a",
    });
    await browser.disposeBrowserContext("context-a");
    assert.deepStrictEqual(
        browserSocket!.sent.map(data => {
            const request = JSON.parse(data) as {
                method: string;
                params: Readonly<Record<string, unknown>>;
            };
            return [request.method, request.params];
        }),
        [
            ["Target.createBrowserContext", { disposeOnDetach: true }],
            ["Target.createTarget", {
                url: managedUrl,
                browserContextId: "context-a",
                newWindow: true,
                background: false,
                focus: false,
            }],
            ["Target.getTargetInfo", { targetId: "target-a" }],
            ["Target.disposeBrowserContext", { browserContextId: "context-a" }],
        ],
    );
    browser.dispose();
    assert.strictEqual(browserSocket!.readyState, 3);

    const failedSocket = new ManualSocket();
    const connectedSocket = new ManualSocket();
    const reconnectSockets = [failedSocket, connectedSocket];
    let reconnectSocketIndex = 0;
    const reconnectingClient = new CdpCommandClient(
        "ws://127.0.0.1:9222/devtools/page/reconnect",
        {
            createSocket: () => {
                const candidate = reconnectSockets[reconnectSocketIndex++];
                if (!candidate) throw new Error("unexpected third socket candidate");
                if (candidate === connectedSocket) queueMicrotask(() => candidate.open());
                return candidate;
            },
            timeoutMs: 20,
        },
    );
    await assert.rejects(
        reconnectingClient.send("Runtime.evaluate", { expression: "first" }),
        /connection timed out/,
    );
    assert.strictEqual(failedSocket.closeCount, 1, "a timed-out candidate socket must be closed");

    const connectedCommand = reconnectingClient.send<{ source: string }>(
        "Runtime.evaluate",
        { expression: "second" },
    );
    await new Promise(resolve => setImmediate(resolve));
    const connectedRequest = JSON.parse(connectedSocket.sent[0]) as { id: number };
    connectedSocket.emitMessage({ id: connectedRequest.id, result: { source: "connected" } });
    assert.deepStrictEqual(await connectedCommand, { source: "connected" });

    const commandAfterReconnect = reconnectingClient.send<{ source: string }>(
        "Runtime.evaluate",
        { expression: "third" },
    );
    await new Promise(resolve => setImmediate(resolve));
    const requestAfterReconnect = JSON.parse(connectedSocket.sent[1]) as { id: number };
    failedSocket.emitMessage({ id: requestAfterReconnect.id, result: { source: "stale" } });
    failedSocket.emitError(new Error("late failure from stale socket"));
    failedSocket.emitClose();
    connectedSocket.emitMessage({
        id: requestAfterReconnect.id,
        result: { source: "still-connected" },
    });
    assert.deepStrictEqual(await commandAfterReconnect, { source: "still-connected" });
    assert.strictEqual(reconnectSocketIndex, 2, "late stale events must not force another reconnect");
    reconnectingClient.dispose();
}

interface Deferred<T> {
    readonly promise: Promise<T>;
    readonly resolve: (value: T | PromiseLike<T>) => void;
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>(resolver => {
        resolve = resolver;
    });
    return { promise, resolve };
}

class FakeManagedEvaluator implements RuntimeProbeEvaluator {
    public readonly expressions: string[] = [];
    public reloadCount = 0;
    public disposed = false;
    public ready = true;
    public failReloadAfterAccept = false;
    private animationHold: {
        readonly started: Deferred<void>;
        readonly released: Deferred<void>;
    } | undefined;

    public constructor(public readonly targetId: string) {}

    public holdNextAnimation(): { readonly started: Promise<void>; readonly release: () => void } {
        const started = deferred<void>();
        const released = deferred<void>();
        this.animationHold = { started, released };
        return {
            started: started.promise,
            release: () => released.resolve(undefined),
        };
    }

    public async evaluate(expression: string): Promise<unknown> {
        this.expressions.push(expression);
        if (expression === "fail-command") throw new Error("planned evaluator failure");
        if (expression.includes('"kind":"animations"') && this.animationHold) {
            const hold = this.animationHold;
            this.animationHold = undefined;
            hold.started.resolve(undefined);
            await hold.released.promise;
        }
        if (expression.includes("ready:") && expression.includes("getScene()")) {
            return { ready: this.ready, scene: this.ready ? "battle" : null };
        }
        return { targetId: this.targetId, expressionIndex: this.expressions.length };
    }

    public async reload(onAccepted?: () => void): Promise<void> {
        this.reloadCount += 1;
        onAccepted?.();
        if (this.failReloadAfterAccept) throw new Error("planned navigation failure after reload acceptance");
    }

    public dispose(): void {
        this.disposed = true;
    }
}

interface FakeTargetRecord {
    readonly descriptor: CdpTarget;
    info: CdpTargetInfo;
    readonly evaluator: FakeManagedEvaluator;
    visible: boolean;
}

class FakeRuntimeProbeEnvironment {
    public previewAvailable = true;
    public browserAvailable = false;
    public spawnCount = 0;
    public browserClientDisposeCount = 0;
    public readonly disposedContexts: string[] = [];
    private readonly records = new Map<string, FakeTargetRecord>();
    private readonly contexts = new Set<string>();
    private nextContext = 1;
    private nextTarget = 1;
    private nextUuid = 1;
    private now = 10_000;
    private lockTail: Promise<void> = Promise.resolve();
    private sharedTargetLockTail: Promise<void> = Promise.resolve();

    public dependencies(): RuntimeProbeDependencies {
        return {
            checkPreview: async () => this.previewAvailable,
            listTargets: async () => [...this.records.values()]
                .filter(record => record.visible)
                .map(record => record.descriptor),
            getBrowserWebSocketUrl: async () => {
                if (!this.browserAvailable) throw new Error("CDP unavailable");
                return "ws://127.0.0.1:9222/devtools/browser/shared";
            },
            withChromeLaunchLock: operation => this.withChromeLaunchLock(operation),
            withSharedTargetLock: operation => this.withSharedTargetLock(operation),
            fileExists: candidate => candidate === "chrome.exe",
            spawnChrome: (executable, args) => {
                assert.strictEqual(executable, "chrome.exe");
                assert.ok(args.includes("--remote-debugging-port=9222"));
                assert.ok(!args.some(arg => arg.includes("7456")));
                this.spawnCount += 1;
                this.browserAvailable = true;
            },
            createBrowserClient: socketUrl => {
                assert.strictEqual(socketUrl, "ws://127.0.0.1:9222/devtools/browser/shared");
                return this.createBrowserClient();
            },
            createEvaluator: socketUrl => {
                const record = [...this.records.values()].find(candidate =>
                    candidate.visible && candidate.descriptor.webSocketDebuggerUrl === socketUrl);
                if (!record) throw new Error(`Unknown fake target socket: ${socketUrl}`);
                return record.evaluator;
            },
            readTextFile: filePath => `file:${filePath}`,
            randomUUID: () => `generated-${this.nextUuid++}`,
            nowMs: () => this.now,
            sleep: async milliseconds => {
                this.now += milliseconds;
            },
        };
    }

    public targetForInstance(instanceId: string): FakeTargetRecord {
        const record = [...this.records.values()].find(candidate =>
            candidate.visible && candidate.descriptor.url?.includes(`runtimeProbeInstance=${instanceId}`));
        if (!record) throw new Error(`Missing fake target for ${instanceId}`);
        return record;
    }

    public targetsForInstance(instanceId: string): readonly FakeTargetRecord[] {
        return [...this.records.values()].filter(candidate =>
            candidate.visible && candidate.descriptor.url?.includes(`runtimeProbeInstance=${instanceId}`));
    }

    public hideTarget(targetId: string): void {
        const record = this.requireRecord(targetId);
        record.visible = false;
    }

    public setTargetContext(targetId: string, browserContextId: string): void {
        const record = this.requireRecord(targetId);
        record.info = { ...record.info, browserContextId };
    }

    private createBrowserClient(): RuntimeProbeBrowserClient {
        return {
            createBrowserContext: async () => {
                const id = `context-${this.nextContext++}`;
                this.contexts.add(id);
                return id;
            },
            createTarget: async (url, browserContextId) => {
                if (browserContextId && !this.contexts.has(browserContextId)) {
                    throw new Error(`Unknown fake browser context: ${browserContextId}`);
                }
                const targetId = `target-${this.nextTarget++}`;
                const record: FakeTargetRecord = {
                    descriptor: {
                        id: targetId,
                        title: "Cocos Creator - Cocos Preview",
                        type: "page",
                        url,
                        webSocketDebuggerUrl: `ws://127.0.0.1:9222/devtools/page/${targetId}`,
                    },
                    info: {
                        targetId,
                        type: "page",
                        title: "Cocos Creator - Cocos Preview",
                        url,
                        attached: false,
                        browserContextId,
                    },
                    evaluator: new FakeManagedEvaluator(targetId),
                    visible: true,
                };
                this.records.set(targetId, record);
                return targetId;
            },
            getTargetInfo: async targetId => this.requireRecord(targetId).info,
            disposeBrowserContext: async browserContextId => {
                this.disposedContexts.push(browserContextId);
                this.contexts.delete(browserContextId);
                for (const [targetId, record] of this.records) {
                    if (record.info.browserContextId === browserContextId) this.records.delete(targetId);
                }
            },
            dispose: () => {
                this.browserClientDisposeCount += 1;
            },
        };
    }

    private requireRecord(targetId: string): FakeTargetRecord {
        const record = this.records.get(targetId);
        if (!record || !record.visible) throw new Error(`Unknown fake target: ${targetId}`);
        return record;
    }

    private async withChromeLaunchLock<T>(operation: () => Promise<T>): Promise<T> {
        const previous = this.lockTail;
        const released = deferred<void>();
        this.lockTail = released.promise;
        await previous;
        try {
            return await operation();
        } finally {
            released.resolve(undefined);
        }
    }

    private async withSharedTargetLock<T>(operation: () => Promise<T>): Promise<T> {
        const previous = this.sharedTargetLockTail;
        const released = deferred<void>();
        this.sharedTargetLockTail = released.promise;
        await previous;
        try {
            return await operation();
        } finally {
            released.resolve(undefined);
        }
    }
}

interface ProbeServiceStatus {
    readonly preview: { readonly available: boolean; readonly url: string };
    readonly cdp: { readonly available: boolean; readonly url: string };
    readonly instance: {
        readonly id: string;
        readonly ownership: "isolated" | "shared";
        readonly browserContextId: string | null;
        readonly refreshGeneration: number;
        readonly ready: boolean;
        readonly scene: string | null;
        readonly target: { readonly id: string | null; readonly url: string | null } | null;
    };
}

async function verifyRuntimeProbeService(): Promise<void> {
    const environment = new FakeRuntimeProbeEnvironment();
    const serviceOptions = (instanceId: string) => ({
        instanceId,
        ownership: "isolated" as const,
        chromeCandidates: ["chrome.exe"],
        dependencies: environment.dependencies(),
        launchTimeoutMs: 100,
        readyTimeoutMs: 20,
        pollIntervalMs: 10,
    });
    const serviceA = new RuntimeProbeService(serviceOptions("dialog-a"));
    const serviceB = new RuntimeProbeService(serviceOptions("dialog-b"));

    const initial = await serviceA.dispatch({ kind: "status" }) as ProbeServiceStatus;
    assert.strictEqual(initial.preview.available, true);
    assert.strictEqual(initial.cdp.available, false);
    assert.strictEqual(initial.instance.id, "dialog-a");
    assert.strictEqual(initial.instance.target, null);
    assert.strictEqual(environment.spawnCount, 0, "status must not start Chrome");

    const [launchedA, launchedB] = await Promise.all([
        serviceA.dispatch({ kind: "launch" }),
        serviceB.dispatch({ kind: "launch" }),
    ]) as [ProbeServiceStatus, ProbeServiceStatus];
    assert.strictEqual(environment.spawnCount, 1, "concurrent services must start shared Chrome once");
    assert.notStrictEqual(launchedA.instance.browserContextId, launchedB.instance.browserContextId);
    assert.notStrictEqual(launchedA.instance.target?.id, launchedB.instance.target?.id);
    assert.match(launchedA.instance.target?.url ?? "", /autoReload=false/);
    assert.match(launchedB.instance.target?.url ?? "", /autoReload=false/);
    assert.strictEqual(launchedA.instance.ready, true);
    assert.strictEqual(launchedB.instance.ready, true);

    const recordA = environment.targetForInstance("dialog-a");
    const recordB = environment.targetForInstance("dialog-b");
    const readyExpression = recordA.evaluator.expressions[0];
    assert.match(readyExpression, /await globalThis\.System\.resolve\("cc"\)/);
    assert.match(readyExpression, /globalThis\.System\.get\(ccModuleId\)/);
    assert.doesNotMatch(
        readyExpression,
        /System\.import\("cc"\)/,
        "readiness polling must not import or re-bootstrap the Cocos engine",
    );
    assert.deepStrictEqual(await serviceA.dispatch({ kind: "eval", expression: "owner-a" }), {
        targetId: recordA.info.targetId,
        expressionIndex: recordA.evaluator.expressions.length,
    });
    assert.deepStrictEqual(await serviceB.dispatch({ kind: "eval", expression: "owner-b" }), {
        targetId: recordB.info.targetId,
        expressionIndex: recordB.evaluator.expressions.length,
    });

    environment.setTargetContext(recordA.info.targetId, launchedB.instance.browserContextId!);
    await assert.rejects(
        serviceA.dispatch({ kind: "scene-tree", maxDepth: 1, includeInactive: false }),
        /owned.*context.*mismatch/i,
    );
    environment.setTargetContext(recordA.info.targetId, launchedA.instance.browserContextId!);

    environment.previewAvailable = false;
    await serviceA.dispatch({ kind: "scene-tree", maxDepth: 1, includeInactive: false });
    await assert.rejects(serviceA.dispatch({ kind: "refresh" }), /preview.*unavailable/i);
    const serviceC = new RuntimeProbeService(serviceOptions("dialog-c"));
    await assert.rejects(serviceC.dispatch({ kind: "launch" }), /preview.*unavailable/i);
    environment.previewAvailable = true;

    const serviceD = new RuntimeProbeService(serviceOptions("dialog-d"));
    const createdD = await serviceD.dispatch({ kind: "refresh" }) as ProbeServiceStatus & {
        readonly created: boolean;
        readonly refreshed: boolean;
    };
    assert.strictEqual(createdD.created, true);
    assert.strictEqual(createdD.refreshed, false);
    assert.ok(createdD.instance.target?.id);

    const sampleB = serviceB.dispatch({
        kind: "sample-animation",
        selector: "enemy-b",
        durationSeconds: 0.1,
        intervalSeconds: 0.1,
    });
    const refreshA = serviceA.dispatch({ kind: "refresh" });
    await Promise.all([sampleB, refreshA]);
    assert.strictEqual(recordA.evaluator.reloadCount, 1);
    assert.strictEqual(recordB.evaluator.reloadCount, 0);
    assert.strictEqual(
        (await serviceA.dispatch({ kind: "status" }) as ProbeServiceStatus).instance.refreshGeneration,
        1,
    );
    assert.strictEqual(
        (await serviceB.dispatch({ kind: "status" }) as ProbeServiceStatus).instance.refreshGeneration,
        0,
    );

    const hold = recordA.evaluator.holdNextAnimation();
    const queuedSample = serviceA.dispatch({
        kind: "sample-animation",
        selector: "enemy-a",
        durationSeconds: 0.1,
        intervalSeconds: 0.1,
    });
    await hold.started;
    const queuedRefresh = serviceA.dispatch({ kind: "refresh" });
    await Promise.resolve();
    assert.strictEqual(recordA.evaluator.reloadCount, 1, "refresh must wait for this service's sample");
    hold.release();
    await Promise.all([queuedSample, queuedRefresh]);
    assert.strictEqual(recordA.evaluator.reloadCount, 2);

    await assert.rejects(
        serviceA.dispatch({ kind: "eval", expression: "fail-command" }),
        /planned evaluator failure/,
    );
    assert.strictEqual(
        (await serviceA.dispatch({ kind: "status" }) as ProbeServiceStatus).instance.id,
        "dialog-a",
        "a rejected command must not poison the service queue",
    );

    const generationBeforeNavigationFailure = (
        await serviceA.dispatch({ kind: "status" }) as ProbeServiceStatus
    ).instance.refreshGeneration;
    recordA.evaluator.failReloadAfterAccept = true;
    await assert.rejects(
        serviceA.dispatch({ kind: "refresh" }),
        /navigation failure after reload acceptance/,
    );
    const navigationFailedStatus = await serviceA.dispatch({ kind: "status" }) as ProbeServiceStatus;
    assert.strictEqual(
        navigationFailedStatus.instance.refreshGeneration,
        generationBeforeNavigationFailure + 1,
        "an accepted reload must advance generation even when navigation observation fails",
    );
    assert.strictEqual(navigationFailedStatus.instance.ready, false);
    recordA.evaluator.failReloadAfterAccept = false;
    await serviceA.dispatch({ kind: "launch" });

    const generationBeforeTimeout = (
        await serviceA.dispatch({ kind: "status" }) as ProbeServiceStatus
    ).instance.refreshGeneration;
    recordA.evaluator.ready = false;
    await assert.rejects(serviceA.dispatch({ kind: "refresh" }), /ready.*timed out/i);
    const timedOutStatus = await serviceA.dispatch({ kind: "status" }) as ProbeServiceStatus;
    assert.strictEqual(timedOutStatus.instance.refreshGeneration, generationBeforeTimeout + 1);
    assert.strictEqual(timedOutStatus.instance.ready, false);
    recordA.evaluator.ready = true;

    const oldContextA = timedOutStatus.instance.browserContextId!;
    const oldTargetA = timedOutStatus.instance.target!.id!;
    environment.hideTarget(oldTargetA);
    await assert.rejects(
        serviceA.dispatch({ kind: "scene-tree", maxDepth: 1, includeInactive: false }),
        /owned.*target.*lost/i,
    );
    const recoveredA = await serviceA.dispatch({ kind: "launch" }) as ProbeServiceStatus;
    assert.notStrictEqual(recoveredA.instance.browserContextId, oldContextA);
    assert.notStrictEqual(recoveredA.instance.target?.id, oldTargetA);
    assert.ok(environment.disposedContexts.includes(oldContextA));

    const sharedOptions = {
        ...serviceOptions("manual-cli"),
        ownership: "shared" as const,
    };
    const sharedFirst = new RuntimeProbeService(sharedOptions);
    const sharedLaunch = await sharedFirst.dispatch({ kind: "launch" }) as ProbeServiceStatus;
    const sharedTargetId = sharedLaunch.instance.target!.id!;
    const disposedContextCountBeforeShared = environment.disposedContexts.length;
    await sharedFirst.dispose();
    assert.strictEqual(
        environment.disposedContexts.length,
        disposedContextCountBeforeShared,
        "shared service disposal must leave the default-context target alive",
    );

    const sharedSecond = new RuntimeProbeService(sharedOptions);
    const sharedRefresh = await sharedSecond.dispatch({ kind: "refresh" }) as ProbeServiceStatus & {
        readonly created: boolean;
        readonly refreshed: boolean;
    };
    assert.strictEqual(sharedRefresh.instance.target?.id, sharedTargetId);
    assert.strictEqual(sharedRefresh.created, false);
    assert.strictEqual(sharedRefresh.refreshed, true);
    assert.strictEqual(sharedRefresh.instance.refreshGeneration, 1);
    assert.strictEqual(environment.targetsForInstance("manual-cli").length, 1);
    assert.strictEqual(environment.targetForInstance("manual-cli").evaluator.reloadCount, 1);

    environment.setTargetContext(sharedTargetId, "default-context-chrome-154");
    const defaultContextRefresh = await sharedSecond.dispatch({ kind: "refresh" }) as ProbeServiceStatus;
    assert.strictEqual(defaultContextRefresh.instance.target?.id, sharedTargetId,
        "shared pages may report a concrete default browser context");

    environment.hideTarget(sharedTargetId);
    const replacementRefresh = await sharedSecond.dispatch({ kind: "refresh" }) as ProbeServiceStatus;
    assert.notStrictEqual(replacementRefresh.instance.target?.id, sharedTargetId,
        "refresh must recover when Creator replaces the owned shared target");
    const replacementRecord = environment.targetForInstance("manual-cli");
    const ownedUrl = replacementRecord.info.url;
    replacementRecord.info = { ...replacementRecord.info, url: "http://127.0.0.1:7456/?other-session=true" };
    await assert.rejects(sharedSecond.dispatch({ kind: "refresh" }), /URL mismatch/,
        "recovery must not hide a nonempty shared target URL mismatch");
    replacementRecord.info = { ...replacementRecord.info, url: ownedUrl };
    await sharedSecond.dispose();

    const finalContextA = recoveredA.instance.browserContextId!;
    await serviceA.dispose();
    assert.ok(environment.disposedContexts.includes(finalContextA));
    await serviceB.dispatch({ kind: "scene-tree", maxDepth: 1, includeInactive: false });
    const contextB = launchedB.instance.browserContextId!;
    const browserDisposeCountBeforeB = environment.browserClientDisposeCount;
    const holdB = recordB.evaluator.holdNextAnimation();
    const queuedB = serviceB.dispatch({
        kind: "sample-animation",
        selector: "enemy-b",
        durationSeconds: 0.1,
        intervalSeconds: 0.1,
    });
    await holdB.started;
    const disposeB = serviceB.dispose();
    await assert.rejects(serviceB.dispatch({ kind: "status" }), /disposing or disposed/i);
    assert.ok(!environment.disposedContexts.includes(contextB));
    holdB.release();
    await queuedB;
    await disposeB;
    assert.ok(environment.disposedContexts.includes(contextB));
    assert.ok(environment.browserClientDisposeCount > browserDisposeCountBeforeB);
    await serviceC.dispose();
    await serviceD.dispose();
}

async function verifyProductionChromeLaunchLock(): Promise<void> {
    const lockPath = path.join(
        os.tmpdir(),
        `cocos-live-probe-lock-test-${process.pid}-${Date.now()}.lock`,
    );
    const staleLockPath = `${lockPath}.stale-case`;
    const cleanupPaths = [
        lockPath,
        `${lockPath}.recovery`,
        staleLockPath,
        `${staleLockPath}.recovery`,
    ];
    const cleanup = (): void => {
        for (const candidate of cleanupPaths) {
            try {
                fs.unlinkSync(candidate);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
        }
    };
    cleanup();

    const environment = new FakeRuntimeProbeEnvironment();
    const base = environment.dependencies();
    const { withChromeLaunchLock: _unusedLock, ...dependenciesWithoutLock } = base;
    let unavailableProbes = 0;
    const bothInitialProbes = deferred<void>();
    const getBrowserWebSocketUrl = async (): Promise<string> => {
        if (environment.browserAvailable) {
            return "ws://127.0.0.1:9222/devtools/browser/shared";
        }
        unavailableProbes += 1;
        if (unavailableProbes === 1) {
            await bothInitialProbes.promise;
        } else if (unavailableProbes === 2) {
            bothInitialProbes.resolve(undefined);
        }
        throw new Error("CDP unavailable");
    };
    const optionsFor = (instanceId: string, chromeLaunchLockPath: string) => ({
        instanceId,
        ownership: "isolated" as const,
        chromeCandidates: ["chrome.exe"],
        chromeLaunchLockPath,
        launchTimeoutMs: 1_000,
        readyTimeoutMs: 100,
        pollIntervalMs: 1,
        dependencies: {
            ...dependenciesWithoutLock,
            getBrowserWebSocketUrl,
        },
    });
    const serviceA = new RuntimeProbeService(optionsFor("lock-a", lockPath));
    const serviceB = new RuntimeProbeService(optionsFor("lock-b", lockPath));
    try {
        await Promise.all([
            serviceA.dispatch({ kind: "launch" }),
            serviceB.dispatch({ kind: "launch" }),
        ]);
        assert.strictEqual(environment.spawnCount, 1);
        assert.strictEqual(fs.existsSync(lockPath), false);
    } finally {
        await Promise.all([serviceA.dispose(), serviceB.dispose()]);
    }

    const staleEnvironment = new FakeRuntimeProbeEnvironment();
    const staleBase = staleEnvironment.dependencies();
    const { withChromeLaunchLock: _unusedStaleLock, ...staleDependenciesWithoutLock } = staleBase;
    fs.writeFileSync(staleLockPath, JSON.stringify({
        pid: 2_147_483_647,
        nonce: "dead-owner",
        createdAtMs: Date.now() - 60_000,
    }), "utf8");
    fs.linkSync(staleLockPath, `${staleLockPath}.recovery`);
    const staleService = new RuntimeProbeService({
        ...optionsFor("stale-lock", staleLockPath),
        dependencies: staleDependenciesWithoutLock,
    });
    try {
        await staleService.dispatch({ kind: "launch" });
        assert.strictEqual(staleEnvironment.spawnCount, 1);
        assert.strictEqual(fs.existsSync(staleLockPath), false);
        assert.strictEqual(
            fs.existsSync(`${staleLockPath}.recovery`),
            true,
            "a recovery contender must only clean up its own nonce claim",
        );
    } finally {
        await staleService.dispose();
        cleanup();
    }
}

async function verifySharedTargetCreationLock(): Promise<void> {
    const environment = new FakeRuntimeProbeEnvironment();
    environment.browserAvailable = true;
    const baseDependencies = environment.dependencies();
    const {
        withSharedTargetLock: _unusedSharedTargetLock,
        ...dependenciesWithoutSharedTargetLock
    } = baseDependencies;
    const bothInitialQueries = deferred<void>();
    let initialEmptyQueries = 0;
    const sharedTargetLockPath = path.join(
        os.tmpdir(),
        `cocos-live-probe-shared-target-test-${process.pid}-${Date.now()}.lock`,
    );
    const dependencies = {
        ...dependenciesWithoutSharedTargetLock,
        listTargets: async (cdpOrigin: string) => {
            const snapshot = await baseDependencies.listTargets(cdpOrigin);
            if (initialEmptyQueries < 2 && snapshot.length === 0) {
                initialEmptyQueries += 1;
                if (initialEmptyQueries === 1) {
                    await bothInitialQueries.promise;
                } else {
                    bothInitialQueries.resolve(undefined);
                }
            }
            return snapshot;
        },
    };
    const options = {
        instanceId: "manual-cli",
        ownership: "shared" as const,
        sharedTargetLockPath,
        chromeCandidates: ["chrome.exe"],
        launchTimeoutMs: 1_000,
        readyTimeoutMs: 100,
        pollIntervalMs: 1,
        dependencies,
    };
    const serviceA = new RuntimeProbeService(options);
    const serviceB = new RuntimeProbeService(options);
    try {
        const [launchedA, launchedB] = await Promise.all([
            serviceA.dispatch({ kind: "launch" }),
            serviceB.dispatch({ kind: "launch" }),
        ]) as [ProbeServiceStatus, ProbeServiceStatus];
        assert.strictEqual(initialEmptyQueries, 2);
        assert.strictEqual(environment.targetsForInstance("manual-cli").length, 1);
        assert.strictEqual(launchedA.instance.target?.id, launchedB.instance.target?.id);
        assert.strictEqual(launchedA.instance.browserContextId, null);
        assert.strictEqual(launchedB.instance.browserContextId, null);
    } finally {
        await Promise.all([serviceA.dispose(), serviceB.dispose()]);
        try {
            fs.unlinkSync(sharedTargetLockPath);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
    }
    assert.strictEqual(
        environment.targetsForInstance("manual-cli").length,
        1,
        "shared service disposal must not close the default-context target",
    );
}

async function verifyRuntimeProbeMcp(): Promise<void> {
    const dispatched: unknown[] = [];
    const dispatch = async (command: unknown): Promise<unknown> => {
        dispatched.push(command);
        if ((command as { kind?: string }).kind === "node") {
            throw new Error("ambiguous node selector");
        }
        return { dispatched: command };
    };

    const initialize = await handleRuntimeProbeMcpMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
    }, dispatch) as {
        id: number;
        result: {
            protocolVersion: string;
            capabilities: { tools: Record<string, unknown> };
            serverInfo: { name: string };
        };
    };
    assert.strictEqual(initialize.id, 1);
    assert.strictEqual(initialize.result.protocolVersion, "2024-11-05");
    assert.deepStrictEqual(initialize.result.capabilities, { tools: {} });
    assert.strictEqual(initialize.result.serverInfo.name, "cocos-live-probe");

    assert.strictEqual(
        await handleRuntimeProbeMcpMessage({
            jsonrpc: "2.0",
            method: "notifications/initialized",
        }, dispatch),
        undefined,
        "MCP notifications must not receive a response",
    );

    const list = await handleRuntimeProbeMcpMessage({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
    }, dispatch) as { result: { tools: typeof RUNTIME_PROBE_MCP_TOOLS } };
    assert.deepStrictEqual(
        list.result.tools.map(tool => tool.name),
        [
            "runtime_input",
            "runtime_wait",
            "runtime_diagnostics",
            "runtime_screenshot",
            "runtime_status",
            "runtime_launch",
            "runtime_refresh",
            "runtime_scene_tree",
            "runtime_find_nodes",
            "runtime_node_snapshot",
            "runtime_animation_snapshot",
            "runtime_sample_animation",
        ],
    );
    assert.doesNotMatch(JSON.stringify(RUNTIME_PROBE_MCP_TOOLS), LEGACY_HOST_PATTERN);

    const refreshCall = await handleRuntimeProbeMcpMessage({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "runtime_refresh", arguments: {} },
    }, dispatch) as {
        result: { content: Array<{ type: string; text: string }> };
    };
    assert.deepStrictEqual(dispatched[0], { kind: "refresh" });
    assert.deepStrictEqual(JSON.parse(refreshCall.result.content[0].text), {
        dispatched: dispatched[0],
    });

    const invalidRefresh = await handleRuntimeProbeMcpMessage({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "runtime_refresh", arguments: { all: true } },
    }, dispatch) as { error: { code: number; message: string } };
    assert.strictEqual(invalidRefresh.error.code, -32602);
    assert.match(invalidRefresh.error.message, /does not accept arguments/);

    const call = await handleRuntimeProbeMcpMessage({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
            name: "runtime_scene_tree",
            arguments: { maxDepth: 5, includeInactive: true },
        },
    }, dispatch) as {
        result: { content: Array<{ type: string; text: string }> };
    };
    assert.deepStrictEqual(dispatched[1], {
        kind: "scene-tree",
        maxDepth: 5,
        includeInactive: true,
    });
    assert.deepStrictEqual(JSON.parse(call.result.content[0].text), {
        dispatched: dispatched[1],
    });

    const toolError = await handleRuntimeProbeMcpMessage({
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
            name: "runtime_node_snapshot",
            arguments: { selector: "enemy-0" },
        },
    }, dispatch) as {
        result: { isError: boolean; content: Array<{ text: string }> };
    };
    assert.strictEqual(toolError.result.isError, true);
    assert.match(toolError.result.content[0].text, /ambiguous node selector/);

    const unknownTool = await handleRuntimeProbeMcpMessage({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "runtime_eval", arguments: {} },
    }, dispatch) as { error: { code: number; message: string } };
    assert.strictEqual(unknownTool.error.code, -32602);
    assert.match(unknownTool.error.message, /Unknown runtime probe tool/);

    const invalidRequest = await handleRuntimeProbeMcpMessage(null, dispatch) as {
        id: null;
        error: { code: number };
    };
    assert.strictEqual(invalidRequest.id, null);
    assert.strictEqual(invalidRequest.error.code, -32600);

    assert.strictEqual(
        await processRuntimeProbeMcpLine(JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/initialized",
        }), dispatch),
        undefined,
    );
    const firstLine = await processRuntimeProbeMcpLine(JSON.stringify({
        jsonrpc: "2.0",
        id: 8,
        method: "tools/list",
    }), dispatch);
    const secondLine = await processRuntimeProbeMcpLine(JSON.stringify({
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "runtime_status", arguments: {} },
    }), dispatch);
    assert.strictEqual(JSON.parse(firstLine!).id, 8);
    assert.strictEqual(JSON.parse(secondLine!).id, 9);
    const parseError = JSON.parse((await processRuntimeProbeMcpLine("{broken", dispatch))!);
    assert.strictEqual(parseError.id, null);
    assert.strictEqual(parseError.error.code, -32700);

    const server = await runRuntimeProbeMcpHttp(undefined, 0);
    try {
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        const health = await requestJson(`http://127.0.0.1:${address.port}/health`);
        assert.strictEqual(health.statusCode, 200);
        assert.deepStrictEqual(health.body, {
            status: "ok",
            name: "cocos-live-probe",
            tools: RUNTIME_PROBE_MCP_TOOLS.length,
        });
    } finally {
        await new Promise<void>((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
        });
        await server.runtimeProbeCleanup;
    }
}

async function verifyRuntimeProbeLifecycles(): Promise<void> {
    const cliDisposeStarted = deferred<void>();
    const releaseCliDispose = deferred<void>();
    let cliOptions: RuntimeProbeServiceOptions | undefined;
    let cliFinished = false;
    const cliRun = runRuntimeProbeCli(
        ["status"],
        (options: RuntimeProbeServiceOptions) => {
            cliOptions = options;
            return {
                dispatch: async command => ({ command }),
                dispose: async () => {
                    cliDisposeStarted.resolve(undefined);
                    await releaseCliDispose.promise;
                },
            };
        },
        () => undefined,
    ).then(() => {
        cliFinished = true;
    });
    await cliDisposeStarted.promise;
    assert.deepStrictEqual(cliOptions, { ownership: "shared", instanceId: "manual-cli" });
    assert.strictEqual(cliFinished, false, "CLI must await its service disposal");
    releaseCliDispose.resolve(undefined);
    await cliRun;

    const stdioDisposeStarted = deferred<void>();
    const releaseStdioDispose = deferred<void>();
    let stdioFinished = false;
    const stdioService = {
        dispatch: async () => null,
        dispose: async () => {
            stdioDisposeStarted.resolve(undefined);
            await releaseStdioDispose.promise;
        },
    } as unknown as RuntimeProbeService;
    const stdioRun = runRuntimeProbeMcpStdio(
        stdioService,
        Readable.from([]),
        () => undefined,
    ).then(() => {
        stdioFinished = true;
    });
    await stdioDisposeStarted.promise;
    assert.strictEqual(stdioFinished, false, "stdio EOF must await its service disposal");
    releaseStdioDispose.resolve(undefined);
    await stdioRun;

    const httpDisposeStarted = deferred<void>();
    const releaseHttpDispose = deferred<void>();
    let httpDisposeFinished = false;
    const httpService = {
        dispatch: async () => null,
        dispose: async () => {
            httpDisposeStarted.resolve(undefined);
            await releaseHttpDispose.promise;
            httpDisposeFinished = true;
        },
    } as unknown as RuntimeProbeService;
    const server = await runRuntimeProbeMcpHttp(httpService, 0) as http.Server & {
        readonly runtimeProbeCleanup: Promise<void>;
    };
    const closed = new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
    });
    await httpDisposeStarted.promise;
    assert.ok(server.runtimeProbeCleanup instanceof Promise);
    let cleanupFinished = false;
    const cleanup = server.runtimeProbeCleanup.then(() => {
        cleanupFinished = true;
    });
    await closed;
    assert.strictEqual(cleanupFinished, false, "HTTP close must expose pending service cleanup");
    assert.strictEqual(httpDisposeFinished, false);
    releaseHttpDispose.resolve(undefined);
    await cleanup;
    assert.strictEqual(httpDisposeFinished, true);

    const occupiedServer = http.createServer();
    await new Promise<void>((resolve, reject) => {
        occupiedServer.once("error", reject);
        occupiedServer.listen(0, "127.0.0.1", () => {
            occupiedServer.off("error", reject);
            resolve();
        });
    });
    try {
        const address = occupiedServer.address();
        assert.ok(address && typeof address !== "string");
        const listenFailureDisposeStarted = deferred<void>();
        const releaseListenFailureDispose = deferred<void>();
        let listenFailureDisposeCount = 0;
        const listenFailureService = {
            dispatch: async () => null,
            dispose: async () => {
                listenFailureDisposeCount += 1;
                listenFailureDisposeStarted.resolve(undefined);
                await releaseListenFailureDispose.promise;
            },
        } as unknown as RuntimeProbeService;
        let listenFailureSettled = false;
        const listenFailure = runRuntimeProbeMcpHttp(
            listenFailureService,
            address.port,
        ).then(
            () => ({ error: undefined }),
            error => ({ error: error as NodeJS.ErrnoException }),
        ).finally(() => {
            listenFailureSettled = true;
        });
        const disposeStarted = await Promise.race([
            listenFailureDisposeStarted.promise.then(() => true),
            new Promise<boolean>(resolve => setTimeout(() => resolve(false), 100)),
        ]);
        assert.strictEqual(disposeStarted, true, "listen failure must dispose the injected service");
        await new Promise(resolve => setImmediate(resolve));
        assert.strictEqual(
            listenFailureSettled,
            false,
            "listen failure must await service cleanup before rejecting",
        );
        releaseListenFailureDispose.resolve(undefined);
        const failedResult = await listenFailure;
        assert.strictEqual(failedResult.error?.code, "EADDRINUSE");
        assert.strictEqual(listenFailureDisposeCount, 1);
    } finally {
        await new Promise<void>((resolve, reject) => {
            occupiedServer.close(error => error ? reject(error) : resolve());
        });
    }
}

function requestJson(url: string): Promise<{ statusCode: number | undefined; body: unknown }> {
    return new Promise((resolve, reject) => {
        const request = http.get(url, response => {
            const chunks: Buffer[] = [];
            response.on("data", chunk => chunks.push(Buffer.from(chunk)));
            response.on("end", () => {
                try {
                    resolve({
                        statusCode: response.statusCode,
                        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
                    });
                } catch (error) {
                    reject(error);
                }
            });
        });
        request.on("error", reject);
    });
}

async function verifyRuntimeCompatibility(): Promise<void> {
    function Animation() {}
    const scene = { name: "scene", children: [] as unknown[], parent: null };
    const actor = {
        name: "actor", uuid: "actor-uuid", active: true, _activeInHierarchy: true,
        children: [], parent: scene,
        getComponentsInChildren: (type: unknown) => type === Animation ? [animation] : [],
        getComponent: (type: unknown) => type === Animation ? animation : null,
    };
    const animation = {
        node: actor,
        clips: [{ name: "idle", duration: 0.5, wrapMode: 2 }],
        getState: () => ({ duration: 0.5, time: 0.25, speed: 1, isPlaying: true }),
    };
    scene.children.push(actor);
    const cc = { Animation, director: { getScene: () => scene } };
    const expression = buildCocosProbeExpression({ kind: "animations", selector: "actor-uuid" });
    for (const globals of [
        { cc },
        { System: { import: async () => cc } },
        { System: { resolve: async () => "cc-module", get: () => cc } },
    ]) {
        const result = await runInNewContext(expression, globals);
        assert.strictEqual(result.node.activeInHierarchy, true);
        assert.strictEqual(result.animations.length, 1);
        assert.strictEqual(result.animations[0].componentType, "cc.Animation");
        assert.strictEqual(result.animations[0].states[0].time, 0.25);
        assert.strictEqual(result.animations[0].states[0].isPlaying, true);
        assert.strictEqual(result.animations[0].bip001, null);
        assert.strictEqual(result.animations[0].renderers.length, 0);
    }
    await assert.rejects(runInNewContext(expression, {}), /Cocos runtime global is unavailable/);
    assert.deepStrictEqual(runtimeProbeOptionsFromEnv({
        COCOS_RUNTIME_PROBE_PREVIEW_URL: " http://127.0.0.1:7457/ ",
        COCOS_RUNTIME_PROBE_CDP_ORIGIN: " http://127.0.0.1:9334 ",
    }), { previewUrl: "http://127.0.0.1:7457/", cdpOrigin: "http://127.0.0.1:9334" });
}

verifyCdpClient()
    .then(verifyRuntimeProbeService)
    .then(verifyProductionChromeLaunchLock)
    .then(verifySharedTargetCreationLock)
    .then(verifyRuntimeProbeMcp)
    .then(verifyRuntimeProbeLifecycles)
    .then(verifyRuntimeCompatibility)
    .then(() => console.log("runtime-probe.test passed"))
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
