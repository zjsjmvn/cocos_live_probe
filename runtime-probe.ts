import { spawn } from "child_process";
import { createHash, randomUUID } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { captureScreenshot, deadlineTransport, InteractionCommand, observePage, PageTransport, parseInteractionCommand, sendInput, waitForCondition } from "./runtime-interaction";
import { GameFailure, readGameBridge, RuntimeGame } from "./runtime-game";
import { RuntimeDiagnostics } from "./runtime-diagnostics";
import {
    buildCocosProbeExpression,
    CdpBrowserClient,
    CdpRuntimeProbe,
    CdpTarget,
    CdpTargetInfo,
} from "./cdp-runtime-probe-core";

export const DEFAULT_PREVIEW_URL = "http://127.0.0.1:7456/";
export const DEFAULT_CDP_ORIGIN = "http://127.0.0.1:9222";
export const DEFAULT_HTTP_MCP_ORIGIN = "http://127.0.0.1:3001";

const DEFAULT_SCENE_TREE_DEPTH = 4;
const DEFAULT_SAMPLE_DURATION_SECONDS = 1;
const DEFAULT_SAMPLE_INTERVAL_SECONDS = 0.1;
const MAX_SAMPLE_DURATION_SECONDS = 30;
const MIN_SAMPLE_INTERVAL_SECONDS = 0.01;
const MAX_ANIMATION_SAMPLES = 301;
const CHROME_LOCK_STALE_GRACE_MS = 5_000;
const COCOS_READY_EXPRESSION = `(async () => {
    let cc = globalThis.cc;
    if (globalThis.System && typeof globalThis.System.resolve === "function"
        && typeof globalThis.System.get === "function") {
        const ccModuleId = await globalThis.System.resolve("cc");
        cc = globalThis.System.get(ccModuleId);
    }
    return {
        ready: Boolean(cc && cc.director && cc.director.getScene()),
        scene: cc && cc.director ? cc.director.getScene()?.name ?? null : null,
    };
})()`;

interface ReadyResult {
    readonly ready: boolean;
    readonly scene: string | null;
}

interface DefaultDependencyOptions {
    readonly cdpOrigin: string;
    readonly getDeadline: () => number | undefined;
    readonly lockPath: string;
    readonly sharedTargetLockPath: string;
    readonly lockTimeoutMs: number;
    readonly pollIntervalMs: number;
}

interface ChromeLaunchLockRecord {
    readonly pid: number;
    readonly nonce: string;
    readonly createdAtMs: number;
}

interface OwnedTargetCreation {
    readonly target: CdpTarget;
    readonly created: boolean;
}

class OwnedTargetLostError extends Error {}
class OwnedTargetMismatchError extends Error {}

export type RuntimeProbeCommand =
    | { readonly kind: "game-state" | "game-step" | "game-autoplay"; readonly args: Readonly<Record<string, unknown>> }
    | InteractionCommand
    | { readonly kind: "status" | "launch" | "refresh" }
    | {
        readonly kind: "scene-tree";
        readonly maxDepth: number;
        readonly includeInactive: boolean;
    }
    | {
        readonly kind: "find" | "node" | "animations";
        readonly selector: string;
    }
    | {
        readonly kind: "sample-animation";
        readonly selector: string;
        readonly durationSeconds: number;
        readonly intervalSeconds: number;
    }
    | {
        readonly kind: "eval";
        readonly expression: string;
        readonly captureDiagnostics?: boolean;
    }
    | {
        readonly kind: "eval-file";
        readonly path: string;
        readonly captureDiagnostics?: boolean;
    };

export interface ChromeLaunchOptions {
    readonly debuggingAddress: string;
    readonly debuggingPort: number;
    readonly profileDirectory: string;
}

export interface RuntimeProbeEvaluator {
    send?(method: string, params?: Readonly<Record<string, unknown>>, timeoutMs?: number): Promise<unknown>;
    onEvent?(method: string, listener: (params: unknown) => void): () => void;
    evaluate(expression: string): Promise<unknown>;
    reload(onAccepted?: () => void): Promise<void>;
    dispose(): void;
}

export interface RuntimeProbeBrowserClient {
    getVersion?(): Promise<unknown>;
    createBrowserContext(): Promise<string>;
    createTarget(url: string, browserContextId?: string): Promise<string>;
    getTargetInfo(targetId: string, timeoutMs?: number): Promise<CdpTargetInfo>;
    disposeBrowserContext(browserContextId: string): Promise<void>;
    dispose(): void;
}

export interface RuntimeProbeDependencies {
    readonly checkPreview: (previewUrl: string) => Promise<boolean>;
    readonly listTargets: (cdpOrigin: string, timeoutMs?: number) => Promise<readonly CdpTarget[]>;
    readonly getBrowserWebSocketUrl: (cdpOrigin: string) => Promise<string>;
    readonly withChromeLaunchLock: <T>(operation: () => Promise<T>) => Promise<T>;
    readonly withSharedTargetLock: <T>(operation: () => Promise<T>) => Promise<T>;
    readonly fileExists: (candidate: string) => boolean;
    readonly spawnChrome: (executable: string, args: readonly string[]) => void;
    readonly createBrowserClient: (webSocketDebuggerUrl: string) => RuntimeProbeBrowserClient;
    readonly createEvaluator: (webSocketDebuggerUrl: string) => RuntimeProbeEvaluator;
    readonly readTextFile: (filePath: string) => string;
    readonly randomUUID: () => string;
    readonly nowMs: () => number;
    readonly sleep: (milliseconds: number) => Promise<void>;
}

export interface RuntimeProbeServiceOptions {
    readonly gameExtension?: string;
    readonly browserExecutable?: string;
    readonly workspaceRoot?: string;
    readonly previewUrl?: string;
    readonly cdpOrigin?: string;
    readonly chromeProfileDirectory?: string;
    readonly chromeCandidates?: readonly string[];
    readonly launchTimeoutMs?: number;
    readonly readyTimeoutMs?: number;
    readonly pollIntervalMs?: number;
    readonly ownership?: "isolated" | "shared";
    readonly instanceId?: string;
    readonly chromeLaunchLockPath?: string;
    readonly sharedTargetLockPath?: string;
    readonly dependencies?: Partial<RuntimeProbeDependencies>;
}

export interface RuntimeProbeServiceHandle {
    readonly game?: RuntimeGame;
    dispatch(command: RuntimeProbeCommand): Promise<unknown>;
    dispose(): Promise<void>;
}

export type RuntimeProbeServiceFactory = (
    options: RuntimeProbeServiceOptions,
) => RuntimeProbeServiceHandle;

export function parseRuntimeProbeArgs(argv: readonly string[]): RuntimeProbeCommand {
    const [command, ...args] = argv;
    switch (command) {
        case "game-state":
        case "game-step":
        case "game-autoplay": {
            const values = args[0] === "--file"
                ? [fs.readFileSync(requireSingleValue(command, args.slice(1)), "utf8").replace(/^\uFEFF/, "")]
                : args;
            if (values.length > 1) throw new Error(`${command} accepts one JSON argument object`);
            const options: unknown = values[0] ? JSON.parse(values[0]) : {};
            if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("Game arguments must be an object");
            return { kind: command, args: options as Readonly<Record<string, unknown>> };
        }
        case "screenshot":
        case "input":
        case "wait":
        case "diagnostics":
            if (args[0] === "--file") {
                if (args.length !== 2) throw new Error(`${command} --file requires one JSON file path`);
                return parseInteractionCommand(command, JSON.parse(fs.readFileSync(args[1], "utf8").replace(/^\uFEFF/, "")));
            }
            if (args.length > 1) throw new Error(`${command} accepts one JSON argument object`);
            return parseInteractionCommand(command, args[0] ? JSON.parse(args[0]) : {});
        case "status":
        case "launch":
        case "refresh":
            requireNoArgs(command, args);
            return { kind: command };
        case "scene-tree":
            return parseSceneTreeArgs(args);
        case "find":
        case "node":
        case "animations":
            return {
                kind: command,
                selector: requireSingleValue(command, args),
            };
        case "sample-animation":
            return parseSampleAnimationArgs(args);
        case "eval": {
            const captureDiagnostics = args[0] === "--diagnostics";
            const expression = (captureDiagnostics ? args.slice(1) : args).join(" ").trim();
            if (!expression) throw new Error("eval requires a JavaScript expression");
            return { kind: "eval", expression, ...(captureDiagnostics ? { captureDiagnostics: true } : {}) };
        }
        case "eval-file":
            return { kind: "eval-file", path: requireSingleValue(command, args[0] === "--diagnostics" ? args.slice(1) : args),
                ...(args[0] === "--diagnostics" ? { captureDiagnostics: true } : {}) };
        case undefined:
            throw new Error("Runtime probe requires a command");
        default:
            throw new Error(`Unknown runtime probe command: ${command}`);
    }
}

export function resolveChromeExecutable(
    candidates: readonly string[],
    fileExists: (candidate: string) => boolean = fs.existsSync,
): string {
    const executable = candidates.find(candidate => candidate.length > 0 && fileExists(candidate));
    if (!executable) {
        throw new Error(
            "Chrome executable was not found; install Chrome or pass a valid runtime probe candidate",
        );
    }
    return executable;
}

export function buildChromeLaunchArgs(options: ChromeLaunchOptions): string[] {
    if (options.debuggingAddress !== "127.0.0.1") {
        throw new Error("Chrome remote debugging must bind to 127.0.0.1");
    }
    if (!Number.isInteger(options.debuggingPort) || options.debuggingPort < 1 || options.debuggingPort > 65_535) {
        throw new Error("Chrome remote debugging port must be an integer from 1 to 65535");
    }
    if (!options.profileDirectory.trim()) {
        throw new Error("Chrome runtime probe profile directory must not be empty");
    }
    return [
        `--remote-debugging-address=${options.debuggingAddress}`,
        `--remote-debugging-port=${options.debuggingPort}`,
        `--user-data-dir=${options.profileDirectory}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--no-startup-window",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
    ];
}

export function buildManagedPreviewUrl(previewUrl: string, instanceId: string): string {
    if (!instanceId.trim()) throw new Error("Runtime probe instance ID must not be empty");
    const url = new URL(previewUrl);
    if (url.hostname !== "127.0.0.1") {
        throw new Error("Cocos preview URL must use 127.0.0.1");
    }
    url.searchParams.set("autoReload", "false");
    url.searchParams.set("runtimeProbeInstance", instanceId);
    return url.toString();
}

export interface RuntimeProbeWorkspaceDefaults {
    readonly identity: string;
    readonly chromeProfileDirectory: string;
    readonly chromeLaunchLockPath: string;
}

export function createRuntimeProbeWorkspaceDefaults(
    workspaceRoot: string = path.resolve(__dirname, "..", ".."),
): RuntimeProbeWorkspaceDefaults {
    const normalizedRoot = path.resolve(workspaceRoot).replace(/\\/g, "/").toLowerCase();
    const identity = createHash("sha256").update(normalizedRoot).digest("hex").slice(0, 16);
    return {
        identity,
        chromeProfileDirectory: path.join(
            os.tmpdir(),
            `cocos-live-probe-${identity}-chrome`,
        ),
        chromeLaunchLockPath: path.join(
            os.tmpdir(),
            `cocos-live-probe-${identity}-chrome-launch.lock`,
        ),
    };
}

function defaultSharedTargetLockPath(
    managedPreviewUrl: string,
    workspaceIdentity: string,
): string {
    const targetIdentity = createHash("sha256")
        .update(managedPreviewUrl)
        .digest("hex")
        .slice(0, 24);
    return path.join(
        os.tmpdir(),
        `cocos-live-probe-${workspaceIdentity}-shared-target-${targetIdentity}.lock`,
    );
}

export class RuntimeProbeService {
    public readonly game: RuntimeGame | undefined;
    private readonly previewUrl: string;
    private readonly managedPreviewUrl: string;
    private readonly cdpOrigin: string;
    private readonly chromeProfileDirectory: string;
    private readonly chromeCandidates: readonly string[];
    private readonly browserExecutable: string | undefined;
    private readonly artifactDirectory: string;
    private readonly launchTimeoutMs: number;
    private readonly readyTimeoutMs: number;
    private readonly pollIntervalMs: number;
    private readonly ownership: "isolated" | "shared";
    private readonly instanceId: string;
    private readonly dependencies: RuntimeProbeDependencies;
    private evaluator: RuntimeProbeEvaluator | undefined;
    private evaluatorSocketUrl: string | undefined;
    private browserClient: RuntimeProbeBrowserClient | undefined;
    private browserContextId: string | undefined;
    private targetId: string | undefined;
    private targetTitle: string | undefined;
    private refreshGeneration = 0;
    private readonly diagnostics = new RuntimeDiagnostics();
    private browserVersion: unknown = null;
    private launchedExecutable: string | null = null;
    private navigationUnsubscribe: (() => void) | undefined;
    private documentLoader: string | undefined;
    private explicitRefresh = false;
    private operationDeadline: number | undefined;
    private ready = false;
    private scene: string | null = null;
    private dispatchTail: Promise<void> = Promise.resolve();
    private acceptingDispatches = true;
    private disposePromise: Promise<void> | undefined;

    public constructor(options: RuntimeProbeServiceOptions = {}) {
        const extension = options.gameExtension ?? process.env.COCOS_RUNTIME_PROBE_GAME_EXTENSION?.trim();
        this.game = extension ? new RuntimeGame(extension, options.workspaceRoot ?? path.resolve(__dirname, "..", "..")) : undefined;
        const workspaceDefaults = createRuntimeProbeWorkspaceDefaults(options.workspaceRoot);
        this.artifactDirectory = path.join(os.tmpdir(), `cocos-live-probe-${workspaceDefaults.identity}-artifacts`);
        this.previewUrl = options.previewUrl ?? DEFAULT_PREVIEW_URL;
        this.cdpOrigin = options.cdpOrigin ?? DEFAULT_CDP_ORIGIN;
        this.chromeProfileDirectory = options.chromeProfileDirectory
            ?? workspaceDefaults.chromeProfileDirectory;
        this.browserExecutable = options.browserExecutable ?? (process.env.COCOS_RUNTIME_PROBE_BROWSER_EXECUTABLE?.trim() || undefined);
        this.chromeCandidates = this.browserExecutable
            ? [this.browserExecutable] : options.chromeCandidates ?? defaultChromeCandidates();
        this.launchTimeoutMs = options.launchTimeoutMs ?? 10_000;
        this.readyTimeoutMs = options.readyTimeoutMs ?? 10_000;
        this.pollIntervalMs = options.pollIntervalMs ?? 100;
        this.ownership = options.ownership ?? "isolated";
        this.instanceId = options.instanceId
            ?? options.dependencies?.randomUUID?.()
            ?? randomUUID();
        this.managedPreviewUrl = buildManagedPreviewUrl(this.previewUrl, this.instanceId);
        const defaultDependencyOptions: DefaultDependencyOptions = {
            cdpOrigin: this.cdpOrigin,
            getDeadline: () => this.operationDeadline,
            lockPath: options.chromeLaunchLockPath
                ?? workspaceDefaults.chromeLaunchLockPath,
            sharedTargetLockPath: options.sharedTargetLockPath
                ?? defaultSharedTargetLockPath(this.managedPreviewUrl, workspaceDefaults.identity),
            lockTimeoutMs: this.launchTimeoutMs,
            pollIntervalMs: this.pollIntervalMs,
        };
        const defaultDependencies = createDefaultDependencies(defaultDependencyOptions);
        const browserDiscovery = options.dependencies?.getBrowserWebSocketUrl
            ?? defaultDependencies.getBrowserWebSocketUrl;
        this.dependencies = {
            ...defaultDependencies,
            ...options.dependencies,
            withChromeLaunchLock: options.dependencies?.withChromeLaunchLock
                ?? (operation => withChromeLaunchLock(
                    defaultDependencyOptions,
                    browserDiscovery,
                    operation,
                )),
        };
    }

    public dispatch(command: RuntimeProbeCommand): Promise<unknown> {
        if (!this.acceptingDispatches) {
            return Promise.reject(new Error("Runtime probe service is disposing or disposed"));
        }
        const enqueuedAt = performance.now();
        const result = this.dispatchTail.then(() => this.dispatchCommand(command, enqueuedAt));
        this.dispatchTail = result.then(() => undefined, () => undefined);
        return result;
    }

    public dispose(): Promise<void> {
        if (this.disposePromise) return this.disposePromise;
        this.acceptingDispatches = false;
        this.disposePromise = this.disposeAfterQueue();
        return this.disposePromise;
    }

    private async dispatchCommand(command: RuntimeProbeCommand, enqueuedAt = performance.now()): Promise<unknown> {
        switch (command.kind) {
            case "game-state":
            case "game-step":
            case "game-autoplay":
                return this.dispatchGame(command, enqueuedAt);
            case "diagnostics":
            case "wait":
            case "input":
            case "screenshot":
                return this.dispatchInteraction(command);
            case "status":
                return this.status();
            case "launch":
                return this.launch();
            case "refresh":
                return this.refresh();
            case "scene-tree":
                return this.evaluateCocos({
                    kind: "scene-tree",
                    maxDepth: command.maxDepth,
                    includeInactive: command.includeInactive,
                });
            case "find":
            case "node":
            case "animations":
                return this.evaluateCocos({ kind: command.kind, selector: command.selector });
            case "sample-animation":
                return this.sampleAnimation(command);
            case "eval":
                return command.captureDiagnostics ? this.evaluateWithDiagnostics(command.expression) : this.evaluateExpression(command.expression);
            case "eval-file":
                return command.captureDiagnostics ? this.evaluateWithDiagnostics(this.dependencies.readTextFile(command.path))
                    : this.evaluateExpression(this.dependencies.readTextFile(command.path));
        }
    }

    private async dispatchGame(command: Extract<RuntimeProbeCommand, { args: unknown }>, enqueuedAt: number): Promise<unknown> {
        if (!this.game) throw new Error("Game extension is not configured");
        const request = this.game.request(command.kind, command.args);
        const deadline = enqueuedAt + request.timeoutMs;
        this.operationDeadline = deadline;
        let active = true;
        try {
            this.checkOperationDeadline();
            if (!this.targetId) { await this.requirePreview(); await this.createOwnedTarget(true, false); }
            let evaluator = await this.getEvaluatorForOwnedTarget();
            if (!this.ready) evaluator = await this.waitForCocosReady(evaluator);
            if (!evaluator.send || !evaluator.onEvent) throw new Error("Game interaction transport is unsupported");
            const checkedPage = (operationDeadline: number) => {
                if (!active || !this.acceptingDispatches) throw new GameFailure("stopped", "Game context is no longer active");
                this.operationDeadline = Math.min(deadline, operationDeadline);
                this.checkOperationDeadline();
                return deadlineTransport(evaluator as PageTransport, this.operationDeadline);
            };
            const read = async (operationDeadline: number) => {
                const page = checkedPage(operationDeadline);
                await this.resolveOwnedTarget(Math.max(1, operationDeadline - performance.now()));
                const identity = { targetId: this.targetId!, instanceId: this.instanceId, refreshGeneration: this.refreshGeneration };
                const before = await observePage(page, identity);
                const bridge = await page.evaluate(`(${readGameBridge.toString()})(${JSON.stringify(this.game!.extension.bridgeName)})`);
                const after = await observePage(page, identity);
                if (before.observation.documentId !== after.observation.documentId) throw new Error("Game page document changed");
                return { observation: after.observation, bridge, cocosVersion: after.cocos.version };
            };
            return await this.game.execute(request, { read,
                diagnostics: after => this.diagnostics.read({ after, limit: 50 }),
                input: async (decision, before, operationDeadline) => {
                    const page = checkedPage(operationDeadline);
                    const latest = await read(operationDeadline);
                    const bridge = latest.bridge as { instanceId?: string };
                    if (latest.observation.documentId !== before.documentId || bridge.instanceId !== before.bridgeInstanceId) {
                        throw new GameFailure("page-changed", "Game page or bridge changed before input");
                    }
                    const identity = { targetId: this.targetId!, instanceId: this.instanceId, refreshGeneration: this.refreshGeneration };
                    const screenshot = await captureScreenshot(page, identity, this.artifactDirectory);
                    const remaining = Math.floor(operationDeadline - performance.now());
                    if (remaining < 100) throw new GameFailure("time-limit", "Insufficient time for input");
                    const input = parseInteractionCommand("input", { ...decision.input, observation: screenshot.observation, timeoutMs: remaining });
                    if (input.kind !== "input") throw new Error("Invalid game input");
                    // sendInput owns its deadline; its release path needs the original transport after that deadline.
                    this.operationDeadline = undefined;
                    const result = await sendInput(evaluator as PageTransport, identity, input, async ms => {
                        if (!active || !this.acceptingDispatches) throw new GameFailure("stopped", "Game context is no longer active");
                        return this.resolveOwnedTarget(ms);
                    });
                    return { ...result, screenshotPath: screenshot.outputPath };
                },
            }, enqueuedAt);
        } finally { active = false; this.operationDeadline = undefined; }
    }

    private async dispatchInteraction(command: InteractionCommand): Promise<unknown> {
        const { kind, ...args } = command;
        const validated = parseInteractionCommand(kind, args);
        const started = performance.now();
        const timed = validated.kind === "input" || validated.kind === "wait";
        this.operationDeadline = timed ? started + validated.timeoutMs : undefined;
        const identity = () => ({ targetId: this.targetId ?? null, instanceId: this.instanceId,
            refreshGeneration: this.refreshGeneration });
        let evaluator: RuntimeProbeEvaluator;
        try {
            if (!this.targetId) {
                await this.requirePreview();
                this.checkOperationDeadline();
                await this.createOwnedTarget(true, false);
            }
            evaluator = await this.getEvaluatorForOwnedTarget();
            if (validated.kind !== "diagnostics" && !this.ready) evaluator = await this.waitForCocosReady(evaluator);
            this.checkOperationDeadline();
            if (!evaluator.send || !evaluator.onEvent) throw new Error("Browser interaction transport is unsupported");
        } catch (error) {
            if (!timed || performance.now() < this.operationDeadline!) throw error;
            return { ...identity(), capturedAt: new Date().toISOString(), elapsedMs: performance.now() - started,
                ...(validated.kind === "wait" ? { status: "timeout", condition: validated.condition, observation: null }
                    : { status: "failed", located: false, started: false, completed: false, cleanupConfirmed: true,
                        error: "Input total timeout exceeded during preparation" }) };
        } finally {
            // Cleanup must remain possible after the input's execution budget expires.
            this.operationDeadline = undefined;
        }
        const pageIdentity = { ...identity(), targetId: this.targetId! };
        const page = evaluator as PageTransport;
        switch (validated.kind) {
            case "diagnostics": return { ...pageIdentity, capturedAt: new Date().toISOString(), ...this.diagnostics.read(validated) };
            case "screenshot": return captureScreenshot(page, pageIdentity, this.artifactDirectory, validated.outputPath);
            case "wait": return waitForCondition(page, pageIdentity, validated, remaining => this.resolveOwnedTarget(remaining), started);
            case "input": return sendInput(page, pageIdentity, validated, remaining => this.resolveOwnedTarget(remaining), started);
        }
    }

    private checkOperationDeadline(): void {
        if (this.operationDeadline !== undefined && performance.now() >= this.operationDeadline) {
            throw new Error("Operation total timeout exceeded during preparation");
        }
    }

    private async status(): Promise<unknown> {
        const [previewAvailable, cdpAvailable] = await Promise.all([
            safeBoolean(() => this.dependencies.checkPreview(this.previewUrl)),
            safeBoolean(async () => Boolean(
                await this.dependencies.getBrowserWebSocketUrl(this.cdpOrigin),
            )),
        ]);
        return {
            preview: { available: previewAvailable, url: this.previewUrl },
            cdp: { available: cdpAvailable, url: this.cdpOrigin },
            browser: { version: this.browserVersion, configuredExecutable: this.browserExecutable ?? null,
                launchedExecutable: this.launchedExecutable, executableAppliesTo: "new launches only" },
            instance: {
                id: this.instanceId,
                ownership: this.ownership,
                browserContextId: this.browserContextId ?? null,
                target: this.targetId ? {
                    id: this.targetId,
                    title: this.targetTitle ?? null,
                    url: this.managedPreviewUrl,
                } : null,
                refreshGeneration: this.refreshGeneration,
                ready: this.ready,
                scene: this.scene,
            },
        };
    }

    private async launch(): Promise<unknown> {
        await this.requirePreview();
        if (this.targetId) {
            try {
                await this.resolveOwnedTarget();
            } catch (error) {
                if (!(error instanceof OwnedTargetLostError)) throw error;
                await this.clearOwnershipForRecovery();
                await this.createOwnedTarget(true);
            }
        } else {
            await this.createOwnedTarget(true);
        }
        if (!this.ready) await this.waitForCocosReady(await this.getEvaluatorForOwnedTarget());
        return this.status();
    }

    private async refresh(): Promise<unknown> {
        await this.requirePreview();
        // A Creator preview can replace a shared page while the runner is
        // between probes. In that case the old target id is permanently
        // invalid, so retry the whole refresh after rebinding to the current
        // URL-owned page. Isolated targets keep their existing strict
        // ownership checks and only get this recovery for a genuine loss.
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                return await this.refreshOnce();
            } catch (error) {
                if (!(error instanceof OwnedTargetLostError) || attempt > 0) throw error;
                await this.clearOwnershipForRecovery();
                await this.createOwnedTarget(this.ownership === "shared");
            }
        }
        throw new Error("Runtime probe refresh recovery exhausted");
    }

    private async refreshOnce(): Promise<unknown> {
        if (!this.targetId) {
            const ownership = await this.createOwnedTarget(this.ownership === "shared");
            if (ownership.created) {
                return {
                    ...(await this.status() as object),
                    created: true,
                    refreshed: false,
                };
            }
        }

        await this.resolveOwnedTarget();
        const evaluator = await this.getEvaluatorForOwnedTarget();
        this.ready = false;
        this.scene = null;
        try {
            this.explicitRefresh = true;
            await evaluator.reload(() => {
                this.refreshGeneration += 1;
            });
        } catch (error) {
            if (this.evaluator === evaluator) this.closeEvaluator();
            throw error;
        } finally {
            this.explicitRefresh = false;
        }
        await this.resolveOwnedTarget();
        await this.waitForCocosReady(await this.getEvaluatorForOwnedTarget());
        return {
            ...(await this.status() as object),
            created: false,
            refreshed: true,
        };
    }

    private async evaluateCocos(
        request: Parameters<typeof buildCocosProbeExpression>[0],
    ): Promise<unknown> {
        return this.evaluateExpression(buildCocosProbeExpression(request));
    }

    private async evaluateExpression(expression: string): Promise<unknown> {
        const evaluator = await this.ensureEvaluator();
        try {
            return await evaluator.evaluate(expression);
        } catch (error) {
            if (this.evaluator === evaluator) this.closeEvaluator();
            throw error;
        }
    }

    private async evaluateWithDiagnostics(expression: string): Promise<unknown> {
        const evaluator = await this.ensureEvaluator();
        if (!evaluator.send || !evaluator.onEvent) throw new Error("Browser diagnostics transport is unsupported");
        const after = this.diagnostics.read({ limit: 1000 }).nextCursor;
        const started = performance.now();
        let result: unknown;
        let error: string | undefined;
        try { result = await evaluator.evaluate(expression); }
        catch (failure) { error = asError(failure).message; }
        return { status: error ? "failed" : "completed", result: result ?? null, elapsedMs: performance.now() - started,
            ...(error ? { error } : {}), diagnostics: this.diagnostics.read({ after, limit: 1000 }),
            targetId: this.targetId, instanceId: this.instanceId, refreshGeneration: this.refreshGeneration };
    }

    private async sampleAnimation(
        command: Extract<RuntimeProbeCommand, { kind: "sample-animation" }>,
    ): Promise<unknown> {
        validateSampling(command.durationSeconds, command.intervalSeconds);
        const offsets = buildSampleOffsets(command.durationSeconds, command.intervalSeconds);
        const evaluator = await this.ensureEvaluator();
        const expression = buildCocosProbeExpression({
            kind: "animations",
            selector: command.selector,
        });
        const startedAt = this.dependencies.nowMs();
        const samples: Array<{ realTimeSeconds: number; snapshot: unknown }> = [];
        try {
            for (const offsetSeconds of offsets) {
                const waitMs = Math.max(
                    0,
                    startedAt + offsetSeconds * 1_000 - this.dependencies.nowMs(),
                );
                if (waitMs > 0) await this.dependencies.sleep(waitMs);
                samples.push({
                    realTimeSeconds: roundSeconds((this.dependencies.nowMs() - startedAt) / 1_000),
                    snapshot: await evaluator.evaluate(expression),
                });
            }
        } catch (error) {
            if (this.evaluator === evaluator) this.closeEvaluator();
            throw error;
        }
        return {
            selector: command.selector,
            durationSeconds: command.durationSeconds,
            intervalSeconds: command.intervalSeconds,
            samples,
        };
    }

    private async ensureEvaluator(): Promise<RuntimeProbeEvaluator> {
        if (!this.targetId) {
            await this.requirePreview();
            await this.createOwnedTarget(true);
        } else {
            await this.resolveOwnedTarget();
        }
        const evaluator = await this.getEvaluatorForOwnedTarget();
        if (!this.ready) return this.waitForCocosReady(evaluator);
        return evaluator;
    }

    private async getEvaluatorForOwnedTarget(): Promise<RuntimeProbeEvaluator> {
        const target = await this.resolveOwnedTarget();
        const socketUrl = target.webSocketDebuggerUrl!;
        if (!this.evaluator || this.evaluatorSocketUrl !== socketUrl) {
            this.closeEvaluator();
            this.evaluator = this.dependencies.createEvaluator(socketUrl);
            this.evaluatorSocketUrl = socketUrl;
            if (this.evaluator.onEvent) {
                this.navigationUnsubscribe = this.evaluator.onEvent("Page.frameNavigated", params => {
                    const frame = (params as { frame?: { parentId?: string; loaderId?: string } }).frame;
                    if (!frame || frame.parentId !== undefined || !frame.loaderId) return;
                    if (this.documentLoader && this.documentLoader !== frame.loaderId) {
                        if (!this.explicitRefresh) this.refreshGeneration++;
                        this.ready = false; this.scene = null;
                    }
                    this.documentLoader = frame.loaderId;
                });
            }
        }
        if (this.evaluator.send && this.evaluator.onEvent) {
            await this.diagnostics.attach(this.evaluator as PageTransport, () => ({
                targetId: this.targetId!, instanceId: this.instanceId, refreshGeneration: this.refreshGeneration,
            }));
            if (!this.documentLoader) {
                const tree = await this.evaluator.send("Page.getFrameTree") as { frameTree?: { frame?: { loaderId?: string } } };
                this.documentLoader = tree.frameTree?.frame?.loaderId;
            }
        }
        return this.evaluator;
    }

    private async createOwnedTarget(allowSharedReuse: boolean, waitUntilReady = true): Promise<OwnedTargetCreation> {
        const browser = await this.ensureBrowserClient();
        if (this.ownership === "shared" && allowSharedReuse) {
            const shared = await this.findSharedTarget(browser);
            if (shared) return this.attachSharedTarget(shared, waitUntilReady);
            const ownership = await this.dependencies.withSharedTargetLock(async () => {
                const claimed = await this.findSharedTarget(browser);
                if (claimed) return this.bindSharedTarget(claimed);
                return this.createNewOwnedTarget(browser, false);
            });
            if (waitUntilReady) await this.waitForCocosReady(await this.getEvaluatorForOwnedTarget());
            return ownership;
        }

        return this.createNewOwnedTarget(browser, waitUntilReady);
    }

    private async attachSharedTarget(shared: CdpTarget, waitUntilReady = true): Promise<OwnedTargetCreation> {
        const ownership = this.bindSharedTarget(shared);
        if (waitUntilReady) await this.waitForCocosReady(await this.getEvaluatorForOwnedTarget());
        return ownership;
    }

    private bindSharedTarget(shared: CdpTarget): OwnedTargetCreation {
        this.browserContextId = undefined;
        this.targetId = shared.id;
        this.targetTitle = shared.title;
        return { target: shared, created: false };
    }

    private async createNewOwnedTarget(
        browser: RuntimeProbeBrowserClient,
        waitUntilReady = true,
    ): Promise<OwnedTargetCreation> {
        let contextId: string | undefined;
        let target: CdpTarget;
        try {
            if (this.ownership === "isolated") {
                contextId = await browser.createBrowserContext();
                this.browserContextId = contextId;
            }
            this.targetId = await browser.createTarget(this.managedPreviewUrl, contextId);
            target = await this.waitForOwnedTarget();
            this.targetTitle = target.title;
        } catch (error) {
            this.closeEvaluator();
            this.targetId = undefined;
            this.targetTitle = undefined;
            this.ready = false;
            this.scene = null;
            if (this.operationDeadline !== undefined) {
                browser.dispose();
                this.browserClient = undefined;
                this.browserContextId = undefined;
            } else if (contextId) {
                try {
                    await browser.disposeBrowserContext(contextId);
                } catch {
                    // Closing the disposeOnDetach browser connection below is the cleanup fallback.
                }
                this.browserContextId = undefined;
                browser.dispose();
                this.browserClient = undefined;
            }
            throw error;
        }
        if (waitUntilReady) {
            await this.waitForCocosReady(await this.getEvaluatorForOwnedTarget());
        }
        return { target, created: true };
    }

    private async ensureBrowserClient(): Promise<RuntimeProbeBrowserClient> {
        if (this.browserClient) return this.browserClient;
        if (this.browserExecutable && !this.dependencies.fileExists(this.browserExecutable)) {
            throw new Error(`Configured browser executable was not found: ${this.browserExecutable}`);
        }
        let socketUrl: string;
        try {
            socketUrl = await this.dependencies.getBrowserWebSocketUrl(this.cdpOrigin);
        } catch {
            this.checkOperationDeadline();
            socketUrl = await this.dependencies.withChromeLaunchLock(async () => {
                try {
                    return await this.dependencies.getBrowserWebSocketUrl(this.cdpOrigin);
                } catch {
                    this.checkOperationDeadline();
                    const executable = resolveChromeExecutable(
                        this.chromeCandidates,
                        this.dependencies.fileExists,
                    );
                    const cdpUrl = new URL(this.cdpOrigin);
                    this.dependencies.spawnChrome(executable, buildChromeLaunchArgs({
                        debuggingAddress: "127.0.0.1",
                        debuggingPort: Number(cdpUrl.port),
                        profileDirectory: this.chromeProfileDirectory,
                    }));
                    this.launchedExecutable = executable;
                    return this.waitForBrowserWebSocket();
                }
            });
        }
        this.browserClient = this.dependencies.createBrowserClient(socketUrl);
        this.browserVersion = this.browserClient.getVersion ? await this.browserClient.getVersion() : null;
        return this.browserClient;
    }

    private async waitForBrowserWebSocket(): Promise<string> {
        const deadline = this.dependencies.nowMs() + this.launchTimeoutMs;
        let lastError: Error | undefined;
        do {
            try {
                return await this.dependencies.getBrowserWebSocketUrl(this.cdpOrigin);
            } catch (error) {
                lastError = asError(error);
            }
            this.checkOperationDeadline();
            const remaining = deadline - this.dependencies.nowMs();
            if (remaining <= 0) break;
            await this.dependencies.sleep(Math.min(this.pollIntervalMs, remaining, this.operationDeadline === undefined
                ? Infinity : Math.max(1, this.operationDeadline - performance.now())));
        } while (this.dependencies.nowMs() <= deadline);
        throw new Error(
            `Chrome did not expose its browser CDP WebSocket within ${this.launchTimeoutMs}ms${
                lastError ? `: ${lastError.message}` : ""
            }`,
        );
    }

    private async findSharedTarget(
        browser: RuntimeProbeBrowserClient,
    ): Promise<CdpTarget | undefined> {
        const targets = await this.dependencies.listTargets(this.cdpOrigin);
        const matches: CdpTarget[] = [];
        for (const target of targets) {
            if (target.type !== "page" || target.url !== this.managedPreviewUrl
                || !target.id || !target.webSocketDebuggerUrl) continue;
            let info: CdpTargetInfo;
            try {
                info = await browser.getTargetInfo(target.id);
            } catch {
                continue;
            }
            // Chrome 154 reports a concrete browserContextId for the default
            // context as well. Shared probes do not own that context, so the
            // URL is the ownership boundary here; isolated probes still use
            // the strict context check in resolveOwnedTarget().
            if (info.targetId === target.id && info.url === this.managedPreviewUrl) matches.push(target);
        }
        // A crashed/manual probe can leave duplicate shared pages behind.
        // Reuse the newest CDP-listed page instead of failing before the
        // evaluator can inspect the currently loaded preview.
        return matches.at(-1);
    }

    private async waitForOwnedTarget(): Promise<CdpTarget> {
        const deadline = this.dependencies.nowMs() + this.launchTimeoutMs;
        let lastError: Error | undefined;
        do {
            try {
                return await this.resolveOwnedTarget();
            } catch (error) {
                lastError = asError(error);
                if (error instanceof OwnedTargetMismatchError) throw error;
            }
            this.checkOperationDeadline();
            const remaining = deadline - this.dependencies.nowMs();
            if (remaining <= 0) break;
            await this.dependencies.sleep(Math.min(this.pollIntervalMs, remaining, this.operationDeadline === undefined
                ? Infinity : Math.max(1, this.operationDeadline - performance.now())));
        } while (this.dependencies.nowMs() <= deadline);
        throw new Error(
            `Owned runtime probe target did not become discoverable within ${this.launchTimeoutMs}ms${
                lastError ? `: ${lastError.message}` : ""
            }`,
        );
    }

    private async resolveOwnedTarget(timeoutMs?: number): Promise<CdpTarget> {
        const deadline = timeoutMs === undefined ? undefined : performance.now() + timeoutMs;
        const remaining = () => deadline === undefined ? undefined : Math.max(1, Math.floor(deadline - performance.now()));
        if (!this.targetId || !this.browserClient) {
            throw this.ownedTargetLost("Owned runtime probe target was lost");
        }

        let info: CdpTargetInfo;
        try {
            info = await this.browserClient.getTargetInfo(this.targetId, remaining());
        } catch (error) {
            throw this.ownedTargetLost(
                `Owned runtime probe target was lost: ${asError(error).message}`,
            );
        }
        if (info.targetId !== this.targetId) {
            throw this.ownedTargetMismatch("Owned runtime probe target ID mismatch");
        }
        const actualContextId = info.browserContextId;
        const sharedDefaultContext = this.ownership === "shared" && this.browserContextId === undefined;
        if (!sharedDefaultContext && actualContextId !== this.browserContextId) {
            throw this.ownedTargetMismatch(
                `Owned runtime probe context mismatch: expected ${
                    this.browserContextId ?? "default"
                }, received ${actualContextId ?? "default"}`,
            );
        }
        if (info.url !== this.managedPreviewUrl) {
            // Creator-managed navigation briefly reports an empty URL for the
            // old shared target. That transient state is recoverable; a
            // non-empty mismatch remains an ownership violation.
            if (this.ownership === "shared" && !info.url) {
                throw this.ownedTargetLost("Owned shared runtime probe target is navigating");
            }
            throw this.ownedTargetMismatch(
                `Owned runtime probe URL mismatch: expected ${this.managedPreviewUrl}, received ${info.url}`,
            );
        }

        let targets: readonly CdpTarget[];
        try {
            targets = await this.dependencies.listTargets(this.cdpOrigin, remaining());
        } catch (error) {
            throw this.ownedTargetLost(
                `Owned runtime probe target was lost during discovery: ${asError(error).message}`,
            );
        }
        const target = targets.find(candidate => candidate.id === this.targetId);
        if (!target || target.type !== "page" || !target.webSocketDebuggerUrl) {
            throw this.ownedTargetLost("Owned runtime probe target was lost from CDP discovery");
        }
        if (target.url !== this.managedPreviewUrl) {
            if (this.ownership === "shared" && !target.url) {
                throw this.ownedTargetLost("Owned shared runtime probe target is navigating");
            }
            throw this.ownedTargetMismatch(
                `Owned runtime probe URL mismatch: expected ${this.managedPreviewUrl}, received ${target.url}`,
            );
        }
        this.targetTitle = info.title || target.title;
        return target;
    }

    private ownedTargetLost(message: string): OwnedTargetLostError {
        this.ready = false;
        this.scene = null;
        this.closeEvaluator();
        return new OwnedTargetLostError(message);
    }

    private ownedTargetMismatch(message: string): OwnedTargetMismatchError {
        this.ready = false;
        this.scene = null;
        this.closeEvaluator();
        return new OwnedTargetMismatchError(message);
    }

    private async waitForCocosReady(initialEvaluator: RuntimeProbeEvaluator): Promise<RuntimeProbeEvaluator> {
        const deadline = this.dependencies.nowMs() + this.readyTimeoutMs;
        let lastError: Error | undefined;
        let evaluator = initialEvaluator;
        do {
            try {
                const result = await evaluator.evaluate(COCOS_READY_EXPRESSION);
                const ready = parseReadyResult(result);
                if (ready.ready) {
                    this.ready = true;
                    this.scene = ready.scene;
                    return evaluator;
                }
            } catch (error) {
                lastError = asError(error);
                if (this.evaluator === evaluator) this.closeEvaluator();
                try {
                    evaluator = await this.getEvaluatorForOwnedTarget();
                } catch (reconnectError) {
                    lastError = asError(reconnectError);
                }
            }
            this.ready = false;
            this.scene = null;
            this.checkOperationDeadline();
            const remaining = deadline - this.dependencies.nowMs();
            if (remaining <= 0) break;
            await this.dependencies.sleep(Math.min(this.pollIntervalMs, remaining, this.operationDeadline === undefined
                ? Infinity : Math.max(1, this.operationDeadline - performance.now())));
        } while (this.dependencies.nowMs() <= deadline);

        throw new Error(
            `Cocos preview ready timed out within ${this.readyTimeoutMs}ms${
                lastError ? `: ${lastError.message}` : ""
            }`,
        );
    }

    private async requirePreview(): Promise<void> {
        if (!await this.dependencies.checkPreview(this.previewUrl)) {
            throw new Error(
                `Cocos preview is unavailable at ${this.previewUrl}; start Preview in Creator first`,
            );
        }
    }

    private closeEvaluator(): void {
        this.navigationUnsubscribe?.();
        this.navigationUnsubscribe = undefined;
        this.documentLoader = undefined;
        this.diagnostics.detach();
        this.evaluator?.dispose();
        this.evaluator = undefined;
        this.evaluatorSocketUrl = undefined;
    }

    private async clearOwnershipForRecovery(): Promise<void> {
        this.closeEvaluator();
        const browser = this.browserClient;
        const contextId = this.browserContextId;
        try {
            if (browser && contextId && this.ownership === "isolated") {
                await browser.disposeBrowserContext(contextId);
            }
        } catch {
            // The browser-level connection is closed below so disposeOnDetach can finish cleanup.
        } finally {
            browser?.dispose();
            this.browserClient = undefined;
            this.browserContextId = undefined;
            this.targetId = undefined;
            this.targetTitle = undefined;
            this.ready = false;
            this.scene = null;
        }
    }

    private async disposeAfterQueue(): Promise<void> {
        await this.dispatchTail;
        this.closeEvaluator();
        const browser = this.browserClient;
        try {
            if (browser && this.browserContextId && this.ownership === "isolated") {
                await browser.disposeBrowserContext(this.browserContextId);
            }
        } finally {
            browser?.dispose();
            this.browserClient = undefined;
            this.browserContextId = undefined;
            this.targetId = undefined;
            this.targetTitle = undefined;
            this.ready = false;
            this.scene = null;
        }
    }
}

export async function runRuntimeProbeCli(
    argv: readonly string[],
    createService: RuntimeProbeServiceFactory = options => new RuntimeProbeService(options),
    writeOutput: (text: string) => void = text => {
        process.stdout.write(text);
    },
): Promise<void> {
    const service = createService({
        ...runtimeProbeOptionsFromEnv(),
        ownership: process.env.COCOS_RUNTIME_PROBE_OWNERSHIP === "isolated"
            ? "isolated"
            : "shared",
        instanceId: "manual-cli",
    });
    try {
        const result = await service.dispatch(parseRuntimeProbeArgs(argv));
        const output = result && typeof result === "object" && "image" in result
            ? Object.fromEntries(Object.entries(result).filter(([key]) => key !== "image")) : result;
        writeOutput(`${JSON.stringify(output, null, 2)}\n`);
    } finally {
        await service.dispose();
    }
}

/**
 * Resolve optional endpoint overrides for local comparisons. The defaults stay
 * on the normal Creator preview/CDP ports, while a second preview can be
 * inspected by setting COCOS_RUNTIME_PROBE_PREVIEW_URL and
 * COCOS_RUNTIME_PROBE_CDP_ORIGIN.
 */
export function runtimeProbeOptionsFromEnv(
    env: NodeJS.ProcessEnv = process.env,
): RuntimeProbeServiceOptions {
    const options: { previewUrl?: string; cdpOrigin?: string; browserExecutable?: string; gameExtension?: string } = {};
    if (env.COCOS_RUNTIME_PROBE_GAME_EXTENSION?.trim()) options.gameExtension = env.COCOS_RUNTIME_PROBE_GAME_EXTENSION.trim();
    if (env.COCOS_RUNTIME_PROBE_BROWSER_EXECUTABLE?.trim()) {
        options.browserExecutable = env.COCOS_RUNTIME_PROBE_BROWSER_EXECUTABLE.trim();
    }
    if (env.COCOS_RUNTIME_PROBE_PREVIEW_URL?.trim()) {
        options.previewUrl = env.COCOS_RUNTIME_PROBE_PREVIEW_URL.trim();
    }
    if (env.COCOS_RUNTIME_PROBE_CDP_ORIGIN?.trim()) {
        options.cdpOrigin = env.COCOS_RUNTIME_PROBE_CDP_ORIGIN.trim();
    }
    return options;
}

function parseSceneTreeArgs(args: readonly string[]): RuntimeProbeCommand {
    let maxDepth = DEFAULT_SCENE_TREE_DEPTH;
    let includeInactive = false;
    for (let index = 0; index < args.length; index += 1) {
        const option = args[index];
        if (option === "--include-inactive") {
            includeInactive = true;
            continue;
        }
        if (option === "--max-depth") {
            maxDepth = parseIntegerOption(option, args[index + 1], 0, 12);
            index += 1;
            continue;
        }
        throw new Error(`Unknown scene-tree option: ${option}`);
    }
    return { kind: "scene-tree", maxDepth, includeInactive };
}

function parseSampleAnimationArgs(args: readonly string[]): RuntimeProbeCommand {
    const selector = args[0];
    if (!selector || selector.startsWith("--")) {
        throw new Error("sample-animation requires a node selector");
    }
    let durationSeconds = DEFAULT_SAMPLE_DURATION_SECONDS;
    let intervalSeconds = DEFAULT_SAMPLE_INTERVAL_SECONDS;
    for (let index = 1; index < args.length; index += 1) {
        const option = args[index];
        const value = args[index + 1];
        if (option === "--duration") {
            durationSeconds = parseNumberOption(option, value);
            index += 1;
            continue;
        }
        if (option === "--interval") {
            intervalSeconds = parseNumberOption(option, value);
            index += 1;
            continue;
        }
        throw new Error(`Unknown sample-animation option: ${option}`);
    }
    validateSampling(durationSeconds, intervalSeconds);
    return { kind: "sample-animation", selector, durationSeconds, intervalSeconds };
}

function requireNoArgs(command: string, args: readonly string[]): void {
    if (args.length > 0) throw new Error(`${command} does not accept arguments`);
}

function requireSingleValue(command: string, args: readonly string[]): string {
    if (args.length !== 1 || !args[0].trim()) {
        throw new Error(`${command} requires exactly one value`);
    }
    return args[0];
}

function parseIntegerOption(option: string, value: string | undefined, min: number, max: number): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
        throw new Error(`${option} must be an integer from ${min} to ${max}`);
    }
    return parsed;
}

function parseNumberOption(option: string, value: string | undefined): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`${option} must be a finite number`);
    return parsed;
}

function validateSampling(durationSeconds: number, intervalSeconds: number): void {
    if (!(durationSeconds > 0) || durationSeconds > MAX_SAMPLE_DURATION_SECONDS) {
        throw new Error(`sample duration must be greater than 0 and at most ${MAX_SAMPLE_DURATION_SECONDS}`);
    }
    if (intervalSeconds < MIN_SAMPLE_INTERVAL_SECONDS || intervalSeconds > durationSeconds) {
        throw new Error(
            `sample interval must be from ${MIN_SAMPLE_INTERVAL_SECONDS} to the requested duration`,
        );
    }
    const count = buildSampleOffsets(durationSeconds, intervalSeconds, false).length;
    if (count > MAX_ANIMATION_SAMPLES) {
        throw new Error(`sample request exceeds the ${MAX_ANIMATION_SAMPLES} sample limit`);
    }
}

function buildSampleOffsets(
    durationSeconds: number,
    intervalSeconds: number,
    validate = true,
): number[] {
    if (validate) validateSampling(durationSeconds, intervalSeconds);
    const offsets = [0];
    for (let offset = intervalSeconds; offset < durationSeconds - 1e-9; offset += intervalSeconds) {
        offsets.push(roundSeconds(offset));
    }
    if (durationSeconds > 0) offsets.push(roundSeconds(durationSeconds));
    return offsets;
}

function roundSeconds(value: number): number {
    return Number(value.toFixed(6));
}

function defaultChromeCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
    return [
        env.LOCALAPPDATA
            ? path.join(env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")
            : "",
        env.ProgramFiles
            ? path.join(env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe")
            : "",
        env["ProgramFiles(x86)"]
            ? path.join(env["ProgramFiles(x86)"]!, "Google", "Chrome", "Application", "chrome.exe")
            : "",
    ];
}

function dependencyTimeout(options: DefaultDependencyOptions, timeoutMs: number): number {
    const deadline = options.getDeadline();
    const remaining = deadline === undefined ? timeoutMs : Math.min(timeoutMs, deadline - performance.now());
    if (remaining <= 0) throw new Error("Operation total timeout exceeded during preparation");
    return Math.max(1, Math.ceil(remaining));
}

function createDefaultDependencies(options: DefaultDependencyOptions): RuntimeProbeDependencies {
    const getBrowserWebSocketUrl = async (cdpOrigin: string): Promise<string> => {
        const response = await fetch(`${cdpOrigin}/json/version`, { signal: AbortSignal.timeout(dependencyTimeout(options, 5000)) });
        if (!response.ok) {
            throw new Error(`CDP browser discovery failed with HTTP ${response.status}`);
        }
        const version = await response.json() as { webSocketDebuggerUrl?: unknown };
        if (typeof version.webSocketDebuggerUrl !== "string"
            || !version.webSocketDebuggerUrl.startsWith("ws")) {
            throw new Error("CDP /json/version did not return webSocketDebuggerUrl");
        }
        return version.webSocketDebuggerUrl;
    };
    return {
        checkPreview: async previewUrl => {
            try {
                const response = await fetch(previewUrl, { method: "GET", signal: AbortSignal.timeout(dependencyTimeout(options, 5000)) });
                return response.ok;
            } catch {
                return false;
            }
        },
        listTargets: async (cdpOrigin, timeoutMs = 5000) => {
            const response = await fetch(`${cdpOrigin}/json/list`, { signal: AbortSignal.timeout(dependencyTimeout(options, timeoutMs)) });
            if (!response.ok) {
                throw new Error(`CDP target discovery failed with HTTP ${response.status}`);
            }
            const targets = await response.json();
            if (!Array.isArray(targets)) throw new Error("CDP /json/list did not return an array");
            return targets as CdpTarget[];
        },
        getBrowserWebSocketUrl,
        withChromeLaunchLock: operation => withChromeLaunchLock(
            options,
            getBrowserWebSocketUrl,
            operation,
        ),
        withSharedTargetLock: operation => withRuntimeProbeFileLock(
            options.sharedTargetLockPath,
            dependencyTimeout(options, options.lockTimeoutMs),
            options.pollIntervalMs,
            operation,
        ),
        fileExists: fs.existsSync,
        spawnChrome: (executable, args) => {
            const child = spawn(executable, [...args], {
                detached: true,
                stdio: "ignore",
                windowsHide: true,
            });
            child.unref();
        },
        createBrowserClient: webSocketDebuggerUrl => new CdpBrowserClient(webSocketDebuggerUrl, { getDeadline: options.getDeadline }),
        createEvaluator: webSocketDebuggerUrl => new CdpRuntimeProbe(webSocketDebuggerUrl, { getDeadline: options.getDeadline }),
        readTextFile: filePath => fs.readFileSync(filePath, "utf8"),
        randomUUID,
        nowMs: Date.now,
        sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    };
}

async function withChromeLaunchLock<T>(
    options: DefaultDependencyOptions,
    getBrowserWebSocketUrl: (cdpOrigin: string) => Promise<string>,
    operation: () => Promise<T>,
): Promise<T> {
    return withRuntimeProbeFileLock(
        options.lockPath,
        dependencyTimeout(options, options.lockTimeoutMs),
        options.pollIntervalMs,
        operation,
        async () => {
            try {
                await getBrowserWebSocketUrl(options.cdpOrigin);
                // The holder exposed CDP, but the operation still needs its mandatory
                // second probe while owning the launch lock.
            } catch {
                // The lock holder has not exposed CDP yet; stale ownership is checked next.
            }
        },
    );
}

async function withRuntimeProbeFileLock<T>(
    lockPath: string,
    lockTimeoutMs: number,
    pollIntervalMs: number,
    operation: () => Promise<T>,
    onWait?: () => Promise<void>,
): Promise<T> {
    const deadline = performance.now() + lockTimeoutMs;
    while (true) {
        const owner = tryAcquireChromeLaunchLock(lockPath);
        if (owner) {
            try {
                return await operation();
            } finally {
                releaseChromeLaunchLock(lockPath, owner.nonce);
            }
        }

        await onWait?.();
        tryTakeOverStaleChromeLaunchLock(lockPath);
        const remaining = deadline - performance.now();
        if (remaining <= 0) {
            throw new Error(`Timed out waiting for runtime probe lock at ${lockPath}`);
        }
        await new Promise(resolve => setTimeout(
            resolve,
            Math.min(pollIntervalMs, remaining),
        ));
    }
}

function tryAcquireChromeLaunchLock(lockPath: string): ChromeLaunchLockRecord | undefined {
    const owner: ChromeLaunchLockRecord = {
        pid: process.pid,
        nonce: randomUUID(),
        createdAtMs: Date.now(),
    };
    let handle: number;
    try {
        handle = fs.openSync(lockPath, "wx");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
        throw error;
    }

    try {
        fs.writeFileSync(handle, JSON.stringify(owner), "utf8");
        fs.closeSync(handle);
        return owner;
    } catch (error) {
        try {
            fs.closeSync(handle);
        } catch {
            // Preserve the original write or close error.
        }
        try {
            fs.unlinkSync(lockPath);
        } catch {
            // Preserve the original write or close error.
        }
        throw error;
    }
}

function tryTakeOverStaleChromeLaunchLock(lockPath: string): void {
    let raw: string;
    let modifiedAtMs: number;
    try {
        raw = fs.readFileSync(lockPath, "utf8");
        modifiedAtMs = fs.statSync(lockPath).mtimeMs;
    } catch {
        return;
    }

    const owner = parseChromeLaunchLockRecord(raw);
    const createdAtMs = owner?.createdAtMs ?? modifiedAtMs;
    if (Date.now() - createdAtMs <= CHROME_LOCK_STALE_GRACE_MS) return;
    if (owner && isProcessAlive(owner.pid)) return;

    const recoveryPath = `${lockPath}.recovery-${process.pid}-${randomUUID()}`;
    try {
        fs.linkSync(lockPath, recoveryPath);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EEXIST" || code === "ENOENT") return;
        throw error;
    }

    let quarantinedPath: string | undefined;
    try {
        if (fs.readFileSync(recoveryPath, "utf8") !== raw) return;
        if (!pathsReferToSameFile(lockPath, recoveryPath)) return;
        quarantinedPath = `${lockPath}.stale-${randomUUID()}`;
        fs.renameSync(lockPath, quarantinedPath);
        fs.unlinkSync(quarantinedPath);
        quarantinedPath = undefined;
    } catch {
        // Another process completed recovery or the filesystem rejected the claim.
    } finally {
        if (quarantinedPath) {
            try {
                fs.unlinkSync(quarantinedPath);
            } catch {
                // The quarantined stale file is no longer the active lock path.
            }
        }
        try {
            fs.unlinkSync(recoveryPath);
        } catch {
            // A missing recovery link means another cleanup path already finished.
        }
    }
}

function pathsReferToSameFile(first: string, second: string): boolean {
    const firstStats = fs.statSync(first, { bigint: true });
    const secondStats = fs.statSync(second, { bigint: true });
    return firstStats.dev === secondStats.dev && firstStats.ino === secondStats.ino;
}

function releaseChromeLaunchLock(lockPath: string, nonce: string): void {
    try {
        const owner = parseChromeLaunchLockRecord(fs.readFileSync(lockPath, "utf8"));
        if (owner?.nonce !== nonce) return;
        fs.unlinkSync(lockPath);
    } catch {
        // Missing or unreadable locks are never deleted without a matching nonce.
    }
}

function parseChromeLaunchLockRecord(raw: string): ChromeLaunchLockRecord | undefined {
    try {
        const value = JSON.parse(raw) as Partial<ChromeLaunchLockRecord>;
        if (!Number.isInteger(value.pid) || !(value.pid! > 0)
            || typeof value.nonce !== "string" || !value.nonce
            || !Number.isFinite(value.createdAtMs)) return undefined;
        return {
            pid: value.pid!,
            nonce: value.nonce,
            createdAtMs: value.createdAtMs!,
        };
    } catch {
        return undefined;
    }
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

function parseReadyResult(value: unknown): ReadyResult {
    if (!value || typeof value !== "object") return { ready: false, scene: null };
    const candidate = value as { ready?: unknown; scene?: unknown };
    return {
        ready: candidate.ready === true,
        scene: typeof candidate.scene === "string" ? candidate.scene : null,
    };
}

async function safeBoolean(operation: () => Promise<boolean>): Promise<boolean> {
    try {
        return await operation();
    } catch {
        return false;
    }
}

function asError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}

if (require.main === module) {
    runRuntimeProbeCli(process.argv.slice(2)).catch(error => {
        process.stderr.write(`${asError(error).message}\n`);
        process.exitCode = 1;
    });
}
