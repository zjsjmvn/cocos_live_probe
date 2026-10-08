export interface CdpTarget {
    readonly id?: string;
    readonly title?: string;
    readonly type?: string;
    readonly url?: string;
    readonly webSocketDebuggerUrl?: string;
}

export interface CdpResponse {
    readonly id?: number;
    readonly method?: string;
    readonly params?: unknown;
    readonly error?: {
        readonly code?: number;
        readonly message?: string;
    };
    readonly result?: unknown;
}

export interface CdpTargetInfo {
    readonly targetId: string;
    readonly type: string;
    readonly title: string;
    readonly url: string;
    readonly attached: boolean;
    readonly browserContextId?: string;
}

export type CocosProbeRequest =
    | {
        readonly kind: "scene-tree";
        readonly maxDepth: number;
        readonly includeInactive: boolean;
    }
    | {
        readonly kind: "find" | "node" | "animations";
        readonly selector: string;
    };

export type RuntimeProbeSocketEventName = "open" | "message" | "error" | "close";

export interface RuntimeProbeSocket {
    readonly readyState: number;
    addEventListener(
        type: RuntimeProbeSocketEventName,
        listener: (event: unknown) => void,
    ): void;
    send(data: string): void;
    close(): void;
}

export interface CdpCommandClientOptions {
    readonly createSocket?: (url: string) => RuntimeProbeSocket;
    readonly timeoutMs?: number;
    readonly getDeadline?: () => number | undefined;
}

export type CdpRuntimeProbeOptions = CdpCommandClientOptions;

interface PendingRequest {
    readonly method: string;
    readonly resolve: (value: unknown) => void;
    readonly reject: (error: Error) => void;
    readonly timer: ReturnType<typeof setTimeout>;
}

interface PendingEvent {
    readonly method: string;
    readonly predicate: (params: unknown) => boolean;
    readonly resolve: (value: unknown) => void;
    readonly reject: (error: Error) => void;
    readonly timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_CDP_TIMEOUT_MS = 5_000;

export function selectPreviewTarget(
    targets: readonly CdpTarget[],
    previewOrigin: string,
): CdpTarget {
    const expectedOrigin = new URL(previewOrigin).origin;
    const matches = targets.filter(target => {
        if (target.type !== "page" || !target.webSocketDebuggerUrl || !target.url) return false;
        try {
            return new URL(target.url).origin === expectedOrigin;
        } catch {
            return false;
        }
    });

    if (matches.length === 0) {
        throw new Error(`No CDP page target matches ${expectedOrigin}`);
    }
    if (matches.length > 1) {
        throw new Error(`Multiple CDP page targets match ${expectedOrigin}`);
    }
    return matches[0];
}

export function decodeRuntimeEvaluateResponse(response: CdpResponse): unknown {
    if (response.error) {
        const code = response.error.code === undefined ? "" : ` (${response.error.code})`;
        throw new Error(
            `CDP Runtime.evaluate failed${code}: ${response.error.message ?? "unknown protocol error"}`,
        );
    }

    const runtimeResult = response.result as {
        readonly exceptionDetails?: {
            readonly text?: string;
            readonly exception?: {
                readonly description?: string;
                readonly value?: unknown;
            };
        };
        readonly result?: {
            readonly type?: string;
            readonly value?: unknown;
            readonly unserializableValue?: string;
            readonly description?: string;
        };
    } | undefined;
    const exception = runtimeResult?.exceptionDetails;
    if (exception) {
        const detail = exception.exception?.description
            ?? stringifyUnknown(exception.exception?.value)
            ?? exception.text
            ?? "unknown page exception";
        throw new Error(`Cocos preview evaluation failed: ${detail}`);
    }

    const remoteObject = runtimeResult?.result;
    if (!remoteObject) {
        throw new Error("CDP response is missing Runtime.evaluate result");
    }
    if (Object.prototype.hasOwnProperty.call(remoteObject, "value")) {
        return remoteObject.value;
    }
    if (remoteObject.type === "undefined") return undefined;
    if (remoteObject.unserializableValue !== undefined) return remoteObject.unserializableValue;
    throw new Error(
        `CDP response is missing Runtime.evaluate by-value data${
            remoteObject.description ? `: ${remoteObject.description}` : ""
        }`,
    );
}

export function buildCocosProbeExpression(request: CocosProbeRequest): string {
    validateProbeRequest(request);
    const encodedRequest = JSON.stringify(request);
    return `(async () => {
    const request = ${encodedRequest};
    let cc = globalThis.cc;
    if (globalThis.System && typeof globalThis.System.import === "function") {
        cc = await globalThis.System.import("cc");
    } else if (globalThis.System && typeof globalThis.System.resolve === "function"
        && typeof globalThis.System.get === "function") {
        const ccModuleId = await globalThis.System.resolve("cc");
        cc = globalThis.System.get(ccModuleId);
    }
    if (!cc) throw new Error("Cocos runtime global is unavailable");
    const scene = cc.director.getScene();
    if (!scene) throw new Error("Cocos preview has no active scene");

    const number = value => Number.isFinite(value) ? value : null;
    const vec3 = value => value ? {
        x: number(value.x),
        y: number(value.y),
        z: number(value.z),
    } : null;
    const bounds = value => value ? {
        center: vec3(value.center),
        halfExtents: vec3(value.halfExtents),
    } : null;
    const pathOf = node => {
        const segments = [];
        let current = node;
        while (current) {
            segments.unshift(current.name);
            current = current.parent;
        }
        return "/" + segments.join("/");
    };
    const walk = root => {
        const nodes = [];
        const visit = node => {
            nodes.push(node);
            for (const child of node.children) visit(child);
        };
        visit(root);
        return nodes;
    };
    const allNodes = walk(scene);
    const componentName = component => component?.constructor?.name
        || component?.__classname__
        || "Component";
    const componentSnapshot = component => {
        const model = component?.model;
        return {
            type: componentName(component),
            enabled: typeof component?.enabled === "boolean" ? component.enabled : null,
            model: model?.constructor?.name || null,
            worldBounds: bounds(model?.worldBounds),
        };
    };
    const nodeSummary = node => ({
        name: node.name,
        uuid: node.uuid,
        path: pathOf(node),
        active: node.active,
        activeInHierarchy: node.activeInHierarchy ?? node._activeInHierarchy ?? node.active,
        childCount: node.children.length,
    });
    const nodeSnapshot = node => {
        const components = node.components.map(componentSnapshot);
        return {
            ...nodeSummary(node),
            parentPath: node.parent ? pathOf(node.parent) : null,
            siblingIndex: node.getSiblingIndex(),
            position: vec3(node.position),
            worldPosition: vec3(node.worldPosition),
            eulerAngles: vec3(node.eulerAngles),
            scale: vec3(node.scale),
            components,
            worldBounds: components
                .map(component => component.worldBounds)
                .filter(Boolean),
        };
    };
    const findNodes = selector => {
        if (selector.startsWith("/")) {
            return allNodes.filter(node => pathOf(node) === selector);
        }
        const query = selector.toLocaleLowerCase();
        return allNodes.filter(node => node.uuid === selector
            || node.name.toLocaleLowerCase().includes(query)
            || pathOf(node).toLocaleLowerCase().includes(query));
    };
    const resolveNode = selector => {
        const matches = allNodes.filter(node => node.uuid === selector
            || node.name === selector
            || pathOf(node) === selector);
        if (matches.length === 0) {
            throw new Error("No Cocos node matches selector: " + selector);
        }
        if (matches.length > 1) {
            throw new Error("Cocos node selector is ambiguous: "
                + selector + " -> " + matches.map(pathOf).join(", "));
        }
        return matches[0];
    };
    const serializeTree = (node, depth) => {
        const children = depth >= request.maxDepth
            ? []
            : node.children
                .filter(child => request.includeInactive || child.activeInHierarchy)
                .map(child => serializeTree(child, depth + 1));
        return { ...nodeSummary(node), children };
    };
    const descendantsWithSelf = (node, componentType) => {
        if (!componentType) return [];
        const values = node.getComponentsInChildren
            ? node.getComponentsInChildren(componentType)
            : [];
        const onRoot = node.getComponent ? node.getComponent(componentType) : null;
        if (onRoot && !values.includes(onRoot)) values.unshift(onRoot);
        return values;
    };
    const descendantNamed = (node, name) => {
        for (const candidate of walk(node)) {
            if (candidate.name === name) return candidate;
        }
        return null;
    };
    const animationSnapshot = node => {
        // The original probe only inspected SkeletalAnimation, which made a
        // valid 2D cc.Animation component look like a missing animation. Keep
        // both component types in one list so callers can verify either kind.
        const standardAnimations = descendantsWithSelf(node, cc.Animation)
            .map(animation => ({ animation, componentType: "cc.Animation" }));
        const skeletalAnimations = descendantsWithSelf(node, cc.SkeletalAnimation)
            .map(animation => ({ animation, componentType: "cc.SkeletalAnimation" }));
        const animations = [...standardAnimations, ...skeletalAnimations];
        return {
            node: nodeSummary(node),
            animations: animations.map(({ animation, componentType }) => {
                const clips = Array.isArray(animation.clips) ? animation.clips : [];
                const bip = componentType === "cc.SkeletalAnimation"
                    ? descendantNamed(animation.node, "Bip001")
                    : null;
                const renderers = componentType === "cc.SkeletalAnimation"
                    ? descendantsWithSelf(animation.node, cc.SkinnedMeshRenderer)
                    : [];
                return {
                    componentType,
                    nodePath: pathOf(animation.node),
                    useBakedAnimation: componentType === "cc.SkeletalAnimation"
                        ? animation.useBakedAnimation
                        : null,
                    clips: clips.map(clip => clip ? {
                        name: clip.name,
                        duration: number(clip.duration),
                        wrapMode: clip.wrapMode,
                    } : null),
                    states: clips.filter(Boolean).map(clip => {
                        const state = animation.getState(clip.name);
                        return state ? {
                            name: clip.name,
                            duration: number(state.duration),
                            time: number(state.time),
                            speed: number(state.speed),
                            wrapMode: state.wrapMode,
                            isPlaying: state.isPlaying,
                            curveLoaded: state._curveLoaded,
                            curvesInited: state._curvesInited,
                            doNotCreateEval: state._doNotCreateEval,
                            hasClipEval: Boolean(state._clipEval),
                        } : { name: clip.name, missing: true };
                    }),
                    bip001: bip ? {
                        localPosition: vec3(bip.position),
                        worldPosition: vec3(bip.worldPosition),
                    } : null,
                    renderers: renderers.map(renderer => ({
                        nodePath: pathOf(renderer.node),
                        model: renderer.model?.constructor?.name || null,
                        worldBounds: bounds(renderer.model?.worldBounds),
                    })),
                };
            }),
        };
    };

    switch (request.kind) {
        case "scene-tree":
            return {
                scene: scene.name,
                tree: serializeTree(scene, 0),
            };
        case "find":
            return {
                scene: scene.name,
                matches: findNodes(request.selector).map(nodeSummary),
            };
        case "node":
            return nodeSnapshot(resolveNode(request.selector));
        case "animations":
            return animationSnapshot(resolveNode(request.selector));
        default:
            throw new Error("Unsupported Cocos probe request");
    }
})()`;
}

interface PageFrameTreeResult {
    readonly frameTree?: {
        readonly frame?: {
            readonly id?: string;
            readonly loaderId?: string;
        };
    };
}

interface PageFrameNavigatedEvent {
    readonly frame?: {
        readonly id?: string;
        readonly loaderId?: string;
        readonly parentId?: string;
    };
}

export class CdpCommandClient {
    private readonly createSocket: (url: string) => RuntimeProbeSocket;
    private readonly timeoutMs: number;
    private readonly getDeadline: () => number | undefined;
    private readonly pending = new Map<number, PendingRequest>();
    private readonly pendingEvents = new Set<PendingEvent>();
    private readonly listeners = new Map<string, Set<(params: unknown) => void>>();
    private socket: RuntimeProbeSocket | undefined;
    private connecting: Promise<void> | undefined;
    private nextRequestId = 1;
    private disposed = false;

    public constructor(
        private readonly webSocketDebuggerUrl: string,
        options: CdpCommandClientOptions = {},
    ) {
        this.createSocket = options.createSocket ?? defaultSocketFactory;
        this.timeoutMs = options.timeoutMs ?? DEFAULT_CDP_TIMEOUT_MS;
        this.getDeadline = options.getDeadline ?? (() => undefined);
    }

    public async send<TResult>(
        method: string,
        params: Readonly<Record<string, unknown>> = {},
        timeoutMs: number = this.timeoutMs,
    ): Promise<TResult> {
        const deadline = Math.min(performance.now() + timeoutMs, this.getDeadline() ?? Infinity);
        const remaining = () => {
            const budget = Math.ceil(deadline - performance.now());
            if (budget <= 0) throw new Error(`CDP ${method} timed out before sending`);
            return budget;
        };
        await this.ensureConnected(remaining());
        timeoutMs = remaining();
        const socket = this.socket;
        if (!socket || socket.readyState !== 1) {
            throw new Error("CDP socket is not connected");
        }

        const id = this.nextRequestId;
        this.nextRequestId += 1;
        return new Promise<TResult>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            this.pending.set(id, {
                method,
                resolve: value => resolve(value as TResult),
                reject,
                timer,
            });
            try {
                socket.send(JSON.stringify({
                    id,
                    method,
                    params,
                }));
            } catch (error) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(asError(error, `Failed to send CDP ${method} request`));
            }
        });
    }

    public waitForEvent<TResult>(
        method: string,
        predicate: (params: TResult) => boolean,
    ): Promise<TResult> {
        if (!this.socket || this.socket.readyState !== 1) {
            return Promise.reject(new Error("CDP socket is not connected"));
        }
        return new Promise<TResult>((resolve, reject) => {
            const pending: PendingEvent = {
                method,
                predicate: params => predicate(params as TResult),
                resolve: value => resolve(value as TResult),
                reject,
                timer: setTimeout(() => {
                    this.pendingEvents.delete(pending);
                    reject(new Error(`CDP ${method} event timed out after ${this.timeoutMs}ms`));
                }, this.timeoutMs),
            };
            this.pendingEvents.add(pending);
        });
    }

    public onEvent(method: string, listener: (params: unknown) => void): () => void {
        const listeners = this.listeners.get(method) ?? new Set();
        listeners.add(listener);
        this.listeners.set(method, listeners);
        return () => { listeners.delete(listener); };
    }

    public dispose(): void {
        this.disposed = true;
        this.rejectPending(new Error("CDP command client was disposed"));
        this.socket?.close();
        this.connecting = undefined;
        this.listeners.clear();
    }

    private async ensureConnected(timeoutMs = this.timeoutMs): Promise<void> {
        if (this.disposed) throw new Error("CDP command client was disposed");
        if (this.socket?.readyState === 1) return;
        if (this.connecting) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                await Promise.race([this.connecting, new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(new Error("CDP socket connection timed out")), timeoutMs);
                })]);
            } finally { if (timer) clearTimeout(timer); }
            return;
        }

        const socket = this.createSocket(this.webSocketDebuggerUrl);
        this.socket = socket;
        const connecting = new Promise<void>((resolve, reject) => {
            let settled = false;
            const fail = (error: Error, closeSocket: boolean): void => {
                if (settled || this.socket !== socket) return;
                settled = true;
                clearTimeout(timer);
                if (closeSocket) {
                    try {
                        socket.close();
                    } catch {
                        // Preserve the connection failure that triggered cleanup.
                    }
                }
                if (this.socket === socket) this.socket = undefined;
                reject(error);
            };
            const timer = setTimeout(() => {
                fail(
                    new Error(`CDP socket connection timed out after ${timeoutMs}ms`),
                    true,
                );
            }, timeoutMs);
            socket.addEventListener("open", () => {
                if (settled || this.socket !== socket) return;
                settled = true;
                clearTimeout(timer);
                resolve();
            });
            socket.addEventListener("error", event => {
                fail(asError(event, "CDP socket connection failed"), true);
            });
            socket.addEventListener("close", () => {
                fail(new Error("CDP socket closed before connecting"), false);
            });
        });
        this.connecting = connecting;
        socket.addEventListener("message", event => this.onMessage(socket, event));
        socket.addEventListener("close", () => this.onClose(socket));
        socket.addEventListener("error", event => this.onSocketError(socket, event));
        try {
            await connecting;
        } finally {
            if (this.connecting === connecting) this.connecting = undefined;
        }
    }

    private onMessage(socket: RuntimeProbeSocket, event: unknown): void {
        if (this.socket !== socket) return;
        const data = (event as { data?: unknown } | undefined)?.data;
        if (typeof data !== "string") return;
        let response: CdpResponse;
        try {
            response = JSON.parse(data) as CdpResponse;
        } catch {
            return;
        }
        if (typeof response.id === "number") {
            const pending = this.pending.get(response.id);
            if (!pending) return;
            clearTimeout(pending.timer);
            this.pending.delete(response.id);
            if (response.error) {
                const code = response.error.code === undefined ? "" : ` (${response.error.code})`;
                pending.reject(new Error(
                    `CDP ${pending.method} failed${code}: ${response.error.message ?? "unknown protocol error"}`,
                ));
                return;
            }
            pending.resolve(response.result);
            return;
        }
        if (typeof response.method === "string") this.onProtocolEvent(response.method, response.params);
    }

    private onProtocolEvent(method: string, params: unknown): void {
        for (const listener of this.listeners.get(method) ?? []) {
            try { listener(params); } catch { /* An observer must not interrupt protocol responses. */ }
        }
        for (const pending of [...this.pendingEvents]) {
            if (pending.method !== method) continue;
            let matched = false;
            try {
                matched = pending.predicate(params);
            } catch (error) {
                clearTimeout(pending.timer);
                this.pendingEvents.delete(pending);
                pending.reject(asError(error, `Failed to match CDP ${method} event`));
                continue;
            }
            if (!matched) continue;
            clearTimeout(pending.timer);
            this.pendingEvents.delete(pending);
            pending.resolve(params);
        }
    }

    private onClose(socket: RuntimeProbeSocket): void {
        if (this.socket !== socket) return;
        this.socket = undefined;
        this.onProtocolEvent("Probe.disconnected", { reason: "CDP socket closed" });
        this.rejectPending(new Error("CDP socket closed"));
    }

    private onSocketError(socket: RuntimeProbeSocket, event: unknown): void {
        if (this.socket !== socket) return;
        this.rejectPending(asError(event, "CDP socket failed"));
        this.onProtocolEvent("Probe.disconnected", { reason: "CDP socket error" });
    }

    private rejectPending(error: Error): void {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
        for (const pending of this.pendingEvents) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pendingEvents.clear();
    }
}

export class CdpRuntimeProbe {
    private readonly client: CdpCommandClient;

    public constructor(webSocketDebuggerUrl: string, options: CdpRuntimeProbeOptions = {}) {
        this.client = new CdpCommandClient(webSocketDebuggerUrl, options);
    }

    public send(method: string, params?: Readonly<Record<string, unknown>>, timeoutMs?: number): Promise<unknown> {
        return this.client.send(method, params, timeoutMs);
    }

    public onEvent(method: string, listener: (params: unknown) => void): () => void {
        return this.client.onEvent(method, listener);
    }

    public async evaluate(expression: string): Promise<unknown> {
        const result = await this.client.send("Runtime.evaluate", {
            expression,
            awaitPromise: true,
            returnByValue: true,
        });
        return decodeRuntimeEvaluateResponse({ result });
    }

    public async reload(onAccepted?: () => void): Promise<void> {
        await this.client.send("Page.enable");
        const tree = await this.client.send<PageFrameTreeResult>("Page.getFrameTree");
        const oldFrame = tree.frameTree?.frame;
        if (!oldFrame?.id || !oldFrame.loaderId) {
            throw new Error("CDP Page.getFrameTree did not return the main frame loader");
        }
        const navigation = this.client.waitForEvent<PageFrameNavigatedEvent>(
            "Page.frameNavigated",
            event => {
                const frame = event.frame;
                return Boolean(frame
                    && frame.id === oldFrame.id
                    && frame.parentId === undefined
                    && frame.loaderId
                    && frame.loaderId !== oldFrame.loaderId);
            },
        );
        try {
            await this.client.send("Page.reload", {
                ignoreCache: true,
                loaderId: oldFrame.loaderId,
            });
            onAccepted?.();
        } catch (error) {
            void navigation.catch(() => undefined);
            throw error;
        }
        await navigation;
    }

    public dispose(): void {
        this.client.dispose();
    }
}

export class CdpBrowserClient {
    private readonly client: CdpCommandClient;

    public constructor(webSocketDebuggerUrl: string, options: CdpCommandClientOptions = {}) {
        this.client = new CdpCommandClient(webSocketDebuggerUrl, options);
    }

    public getVersion(): Promise<unknown> {
        return this.client.send("Browser.getVersion");
    }

    public async createBrowserContext(): Promise<string> {
        const result = await this.client.send<{ browserContextId?: string }>(
            "Target.createBrowserContext",
            { disposeOnDetach: true },
        );
        if (!result.browserContextId) throw new Error("CDP did not return browserContextId");
        return result.browserContextId;
    }

    public async createTarget(url: string, browserContextId?: string): Promise<string> {
        const result = await this.client.send<{ targetId?: string }>("Target.createTarget", {
            url,
            ...(browserContextId ? { browserContextId } : {}),
            newWindow: true,
            background: false,
            focus: false,
        });
        if (!result.targetId) throw new Error("CDP did not return targetId");
        return result.targetId;
    }

    public async getTargetInfo(targetId: string, timeoutMs?: number): Promise<CdpTargetInfo> {
        const result = await this.client.send<{ targetInfo?: CdpTargetInfo }>(
            "Target.getTargetInfo",
            { targetId },
            timeoutMs,
        );
        if (!result.targetInfo) throw new Error("CDP did not return targetInfo");
        return result.targetInfo;
    }

    public async disposeBrowserContext(browserContextId: string): Promise<void> {
        await this.client.send("Target.disposeBrowserContext", { browserContextId });
    }

    public dispose(): void {
        this.client.dispose();
    }
}

function validateProbeRequest(request: CocosProbeRequest): void {
    if (request.kind === "scene-tree") {
        if (!Number.isInteger(request.maxDepth) || request.maxDepth < 0 || request.maxDepth > 12) {
            throw new Error("scene-tree maxDepth must be an integer from 0 to 12");
        }
        return;
    }
    if (request.selector.trim().length === 0) {
        throw new Error(`${request.kind} selector must not be empty`);
    }
}

function defaultSocketFactory(url: string): RuntimeProbeSocket {
    const WebSocketConstructor = (globalThis as unknown as {
        WebSocket?: new (socketUrl: string) => RuntimeProbeSocket;
    }).WebSocket;
    if (!WebSocketConstructor) {
        throw new Error("This runtime does not provide a WebSocket implementation; Node 22 or newer is required");
    }
    return new WebSocketConstructor(url);
}

function asError(value: unknown, fallback: string): Error {
    if (value instanceof Error) return value;
    const message = stringifyUnknown(value);
    return new Error(message ? `${fallback}: ${message}` : fallback);
}

function stringifyUnknown(value: unknown): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value === "string") return value;
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}
