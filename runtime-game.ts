import * as path from "path";
import Ajv, { ValidateFunction } from "ajv";
import { InputCommand, Observation } from "./runtime-interaction";

export type GameState = Readonly<Record<string, unknown>>;
export type GameDecision =
    | { kind: "done"; reason: string }
    | { kind: "blocked"; reason: string }
    | { kind: "wait"; reason: string; durationMs?: number }
    | { kind: "input"; reason: string; input: Omit<Partial<InputCommand>, "kind" | "observation" | "timeoutMs"> };
export interface GameVerification { status: "satisfied" | "pending" | "blocked"; progress: boolean; reason?: string }
export interface GameExtension {
    id: string;
    apiVersion: 1;
    gameId: string;
    stateVersion: number;
    bridgeName: string;
    goalSchema: Record<string, unknown>;
    policySchema?: Record<string, unknown>;
    cocosVersions?: string[];
    readState(raw: GameState): GameState | Promise<GameState>;
    decide(state: GameState, goal: GameState, policy: GameState): GameDecision | Promise<GameDecision>;
    verify(before: GameState, after: GameState, decision: GameDecision, goal: GameState): GameVerification | Promise<GameVerification>;
}
export interface GameObservation extends Observation {
    pluginId: string;
    apiVersion: number;
    gameId: string;
    stateVersion: number;
    bridgeInstanceId: string;
    capturedAt: string;
    state: GameState;
}
export interface GamePort {
    read(deadline: number): Promise<{ observation: Observation; bridge: unknown; cocosVersion: string | null }>;
    input(decision: Extract<GameDecision, { kind: "input" }>, before: GameObservation, deadline: number): Promise<unknown>;
    diagnostics?(after?: number): { nextCursor: number; [key: string]: unknown };
}
interface GameStepResult {
    status: string;
    reason: string;
    before: GameObservation;
    after: GameObservation;
    decision: GameDecision;
    verification: GameVerification;
    input?: unknown;
    error?: string;
}
export interface GameRequest {
    kind: "game-state" | "game-step" | "game-autoplay";
    timeoutMs: number;
    goal: GameState;
    policy: GameState;
    maxSteps: number;
    noProgressTimeoutMs: number;
}
export class GameFailure extends Error {
    public constructor(public readonly reason: string, message: string) { super(message); }
}

function budget(value: unknown, fallback: number, label: string, maximum: number): number {
    const result = value ?? fallback;
    if (typeof result !== "number" || !Number.isInteger(result) || result < 1 || result > maximum) {
        throw new Error(`${label} must be an integer from 1 to ${maximum}`);
    }
    return result;
}

async function within<T>(deadline: number, operation: () => T | Promise<T>): Promise<T> {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new GameFailure("time-limit", "Game operation total timeout exceeded");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const result = await Promise.race([Promise.resolve().then(operation), new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new GameFailure("time-limit", "Game operation total timeout exceeded")), remaining);
        })]);
        if (performance.now() >= deadline) throw new GameFailure("time-limit", "Game operation total timeout exceeded");
        return result;
    } finally { if (timer) clearTimeout(timer); }
}

export function gameRecord(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
    return value as Record<string, unknown>;
}

function jsonState(value: unknown, label: string): GameState {
    const text = JSON.stringify(gameRecord(value, label), (_key, member: unknown) => {
        if (typeof member === "number" && !Number.isFinite(member)) throw new Error(`${label} contains a non-finite number`);
        if (["function", "symbol", "bigint", "undefined"].includes(typeof member)) throw new Error(`${label} is not JSON data`);
        return member;
    });
    if (Buffer.byteLength(text) > 64 * 1024) throw new Error(`${label} exceeds 64 KiB`);
    return JSON.parse(text) as GameState;
}

export class RuntimeGame {
    public readonly extension: GameExtension;
    private readonly goalValidator: ValidateFunction;
    private readonly policyValidator: ValidateFunction;

    public constructor(entry: string, workspaceRoot: string) {
        let loaded: unknown;
        try { loaded = require(path.resolve(workspaceRoot, entry)); }
        catch (error) { throw new Error(`Game extension load failed: ${String(error)}`); }
        const module = gameRecord(loaded, "Game extension");
        const candidate = gameRecord(module.default ?? module, "Game extension");
        if (candidate.apiVersion !== 1) throw new Error("Unsupported game extension apiVersion");
        for (const key of ["id", "gameId", "bridgeName"]) {
            if (typeof candidate[key] !== "string" || !candidate[key]) throw new Error(`Game extension requires ${key}`);
        }
        if (!Number.isInteger(candidate.stateVersion) || Number(candidate.stateVersion) < 1) throw new Error("Invalid game stateVersion");
        for (const key of ["readState", "decide", "verify"]) {
            if (typeof candidate[key] !== "function") throw new Error(`Game extension requires ${key}`);
        }
        this.extension = candidate as unknown as GameExtension;
        const validator = new Ajv({ strict: true, allErrors: true });
        this.goalValidator = validator.compile(gameRecord(candidate.goalSchema, "goalSchema"));
        this.policyValidator = validator.compile(candidate.policySchema ?? { type: "object", additionalProperties: false });
    }

    public request(kind: GameRequest["kind"], args: GameState): GameRequest {
        const allowed = kind === "game-state" ? ["timeoutMs"] : kind === "game-step" ? ["goal", "policy", "timeoutMs"]
            : ["goal", "policy", "timeoutMs", "maxSteps", "noProgressTimeoutMs"];
        for (const key of Object.keys(args)) if (!allowed.includes(key)) throw new Error(`Unknown game argument: ${key}`);
        const timeoutMs = budget(args.timeoutMs, kind === "game-autoplay" ? 20_000 : 5000, "timeoutMs", kind === "game-autoplay" ? 30_000 : 10_000);
        const goal = kind === "game-state" ? {} : jsonState(args.goal, "goal");
        const policy = jsonState(args.policy ?? {}, "policy");
        if (kind !== "game-state" && !this.goalValidator(goal)) throw new Error(`Invalid goal: ${JSON.stringify(this.goalValidator.errors)}`);
        if (!this.policyValidator(policy)) throw new Error(`Invalid policy: ${JSON.stringify(this.policyValidator.errors)}`);
        const noProgressTimeoutMs = budget(args.noProgressTimeoutMs, Math.min(5000, timeoutMs), "noProgressTimeoutMs", timeoutMs);
        return { kind, timeoutMs, goal, policy, noProgressTimeoutMs, maxSteps: budget(args.maxSteps, 100, "maxSteps", 1000) };
    }

    public async observe(port: GamePort, deadline: number, baseline?: GameObservation): Promise<GameObservation> {
        const { observation, bridge: raw, cocosVersion } = await within(deadline, () => port.read(deadline));
        const bridge = gameRecord(raw, "Game bridge");
        if (bridge.gameId !== this.extension.gameId) throw new Error("Game bridge gameId mismatch");
        if (bridge.stateVersion !== this.extension.stateVersion) throw new Error("Game bridge stateVersion mismatch");
        if (typeof bridge.instanceId !== "string" || !bridge.instanceId) throw new Error("Game bridge instanceId is missing");
        if (baseline && (baseline.documentId !== observation.documentId || baseline.targetId !== observation.targetId
            || baseline.refreshGeneration !== observation.refreshGeneration || baseline.bridgeInstanceId !== bridge.instanceId)) {
            throw new GameFailure("page-changed", "Game page or bridge instance changed");
        }
        if (this.extension.cocosVersions && (!cocosVersion || !this.extension.cocosVersions.includes(cocosVersion))) {
            throw new Error(`Unsupported Cocos version: ${cocosVersion}`);
        }
        const state = jsonState(await within(deadline, () => this.extension.readState(jsonState(bridge.state, "Game bridge state"))), "Game state");
        return { ...observation, pluginId: this.extension.id, apiVersion: 1, gameId: this.extension.gameId,
            stateVersion: this.extension.stateVersion, bridgeInstanceId: bridge.instanceId,
            capturedAt: new Date().toISOString(), state };
    }

    public async execute(request: GameRequest, port: GamePort, started: number): Promise<unknown> {
        const deadline = started + request.timeoutMs;
        if (request.kind === "game-state") return { ...await this.observe(port, deadline),
            capabilities: { goalSchema: this.extension.goalSchema, policySchema: this.extension.policySchema ?? { type: "object", additionalProperties: false } } };
        const diagnosticsStart = port.diagnostics?.().nextCursor;
        let before: GameObservation | undefined;
        let after: GameObservation | undefined;
        let steps = 0;
        let lastProgress = performance.now();
        let stepDeadline = deadline;
        let expirationReason = "time-limit";
        const records: GameStepResult[] = [];
        let status = "limited", reason = "step-limit", error: string | undefined;
        try {
            before = after = await this.observe(port, deadline);
            do {
                if (performance.now() >= deadline) { reason = "time-limit"; break; }
                if (performance.now() - lastProgress >= request.noProgressTimeoutMs) { status = "failed"; reason = "no-progress"; break; }
                const progressDeadline = request.kind === "game-autoplay" ? lastProgress + request.noProgressTimeoutMs : Infinity;
                stepDeadline = Math.min(deadline, performance.now() + 10_000, progressDeadline);
                expirationReason = stepDeadline === progressDeadline && progressDeadline < deadline ? "no-progress" : "time-limit";
                steps++;
                const result = await this.step(request, port, after, stepDeadline, expirationReason);
                after = result.after;
                if (result.decision.kind === "done") steps--;
                records.push(result);
                if (records.length > 50) records.shift();
                if (result.verification.progress) lastProgress = performance.now();
                if (result.status === "completed" || result.status === "failed" || request.kind === "game-step") {
                    status = result.status; reason = result.reason; break;
                }
            } while (steps < request.maxSteps);
        } catch (caught) {
            reason = caught instanceof GameFailure ? caught.reason === "time-limit" ? expirationReason : caught.reason
                : performance.now() >= stepDeadline ? expirationReason : /bridge|gameId|stateVersion/i.test(String(caught)) ? "bridge-unavailable"
                : /target|document|context|URL/i.test(String(caught)) ? "page-changed" : "plugin-error";
            status = reason === "time-limit" ? "limited" : "failed";
            error = String(caught).slice(0, 2000);
        }
        const last = records[records.length - 1];
        const report: Record<string, unknown> = { status, reason, goalReached: reason === "goal-reached", goal: request.goal,
            before, after, steps, elapsedMs: performance.now() - started, records,
            ...(last ? { decision: last.decision, verification: last.verification, input: last.input } : {}),
            ...(error ? { error } : {}), diagnostics: port.diagnostics?.(diagnosticsStart), truncated: steps > records.length };
        while (Buffer.byteLength(JSON.stringify(report)) > 256 * 1024 && records.length) { records.shift(); report.truncated = true; }
        if (Buffer.byteLength(JSON.stringify(report)) > 256 * 1024) {
            report.diagnostics = { omitted: true, nextCursor: port.diagnostics?.().nextCursor };
            report.truncated = true;
        }
        if (Buffer.byteLength(JSON.stringify(report)) > 256 * 1024) {
            for (const key of ["before", "after", "input", "decision", "goal"]) report[key] = { omitted: true };
        }
        return report;
    }

    private async decide(state: GameState, request: GameRequest, deadline: number): Promise<GameDecision> {
        const decision = await within(deadline, () => this.extension.decide(state, request.goal, request.policy));
        if (!decision || !["done", "blocked", "wait", "input"].includes(decision.kind) || typeof decision.reason !== "string") {
            throw new GameFailure("plugin-error", "Invalid game decision");
        }
        return jsonState(decision, "Game decision") as unknown as GameDecision;
    }

    private async step(request: GameRequest, port: GamePort, before: GameObservation, deadline: number, expirationReason: string): Promise<GameStepResult> {
        const decision = await this.decide(before.state, request, deadline);
        let after = before;
        let input: unknown;
        let verification: GameVerification = { status: "satisfied", progress: false };
        if (decision.kind === "done" || decision.kind === "blocked") {
            return { status: decision.kind === "done" ? "completed" : "failed", reason: decision.kind === "done" ? "goal-reached" : "blocked",
                before, after, decision, verification };
        }
        try {
            if (decision.kind === "wait") {
                const duration = budget(decision.durationMs, 100, "wait durationMs", 1000);
                await within(deadline, () => new Promise<void>(resolve => setTimeout(resolve, Math.min(duration, Math.max(1, deadline - performance.now())))));
            } else {
                if (performance.now() >= deadline) throw new GameFailure("time-limit", "Game operation timeout exceeded before input");
                input = await port.input(decision, before, deadline);
                const inputResult = gameRecord(input, "Input result");
                if (inputResult.status !== "sent") {
                    const failureReason = typeof inputResult.failureReason === "string" && ["page-changed", "stopped"].includes(inputResult.failureReason)
                        ? inputResult.failureReason : performance.now() >= deadline && expirationReason === "no-progress" ? "no-progress" : "input-failed";
                    return { status: "failed", reason: failureReason,
                        before, after, decision, input, verification };
                }
            }
            do {
                after = await this.observe(port, deadline, before);
                verification = jsonState(await within(deadline, () => this.extension.verify(before.state, after.state, decision, request.goal)), "Game verification") as unknown as GameVerification;
                if (!verification || !["satisfied", "pending", "blocked"].includes(verification.status) || typeof verification.progress !== "boolean") {
                    throw new GameFailure("plugin-error", "Invalid game verification");
                }
                if (verification.status !== "pending" || decision.kind === "wait") break;
                await within(deadline, () => new Promise<void>(resolve => setTimeout(resolve, Math.min(50, Math.max(1, deadline - performance.now())))));
            } while (true);
            const finished = (await this.decide(after.state, request, deadline)).kind === "done";
            return { status: verification.status === "blocked" ? "failed" : finished ? "completed" : "stepped",
                reason: verification.status === "blocked" ? "blocked" : finished ? "goal-reached" : "step-complete",
                before, after, decision, input, verification };
        } catch (error) {
            if (expirationReason === "no-progress" && (performance.now() >= deadline || error instanceof GameFailure && error.reason === "time-limit")) {
                if (input) return { status: "failed", reason: "no-progress", before, after, decision, input, verification };
                throw new GameFailure("no-progress", "Game operation no-progress timeout exceeded");
            }
            if (input) return { status: "failed", reason: error instanceof GameFailure && error.reason === "page-changed" ? "page-changed"
                : performance.now() >= deadline ? "result-unknown" : "plugin-error", before, after, decision, input, verification,
                error: String(error).slice(0, 2000) };
            throw error;
        }
    }
}

// This reader is executed in the owned preview. It accepts a bridge name, not executable client code.
export function readGameBridge(bridgeName: string): unknown {
    const bridge = (globalThis as unknown as Record<string, { getState?: () => unknown }>)[bridgeName];
    if (!bridge || typeof bridge.getState !== "function") throw new Error("Game bridge is not ready");
    return bridge.getState();
}
