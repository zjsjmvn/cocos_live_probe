import { createHash, randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { DIAGNOSTIC_LEVELS, DIAGNOSTIC_TYPES, DiagnosticsOptions } from "./runtime-diagnostics";
import { decodeRuntimeEvaluateResponse } from "./cdp-runtime-probe-core";

export interface PageTransport {
    evaluate(expression: string): Promise<unknown>;
    send(method: string, params?: Readonly<Record<string, unknown>>, timeoutMs?: number): Promise<unknown>;
    onEvent(method: string, listener: (params: unknown) => void): () => void;
}

export interface PageIdentity {
    targetId: string;
    instanceId: string;
    refreshGeneration: number;
}

export interface Observation extends PageIdentity {
    documentId: string;
    geometryKey: string;
}

class OperationDeadlineError extends Error {}

function deadlineTransport(page: PageTransport, deadline: number): PageTransport {
    const send = (method: string, params?: Readonly<Record<string, unknown>>, timeoutMs?: number) => {
        const remaining = Math.ceil(deadline - performance.now());
        if (remaining <= 0) throw new OperationDeadlineError("Operation total timeout exceeded");
        return page.send(method, params, Math.min(timeoutMs ?? remaining, remaining));
    };
    return { send, onEvent: (method, listener) => page.onEvent(method, listener),
        evaluate: async expression => decodeRuntimeEvaluateResponse({ result: await send("Runtime.evaluate", {
            expression, awaitPromise: true, returnByValue: true,
        }) }) };
}

export interface InputPoint { x?: number; y?: number; uuid?: string; cameraUuid?: string; canvasId?: string }
export interface InputCommand {
    kind: "input";
    action: "click" | "long-press" | "drag" | "key";
    device?: "mouse" | "touch";
    observation: Observation;
    point?: InputPoint;
    to?: InputPoint;
    keys?: string[];
    durationMs: number;
    timeoutMs: number;
}

export interface WaitCondition {
    type: "node-exists" | "node-absent" | "property";
    selector: string;
    component?: string;
    path?: string;
    operator?: "eq" | "ne" | "gt" | "gte" | "lt" | "lte";
    value?: string | number | boolean | null;
}
export interface WaitCommand { kind: "wait"; condition: WaitCondition; timeoutMs: number; intervalMs: number }

export type InteractionCommand = InputCommand | WaitCommand | ({ kind: "diagnostics" } & DiagnosticsOptions) | {
    kind: "screenshot";
    outputPath?: string;
};

export function parseInteractionCommand(kind: string, value: unknown): InteractionCommand {
    const args = record(value, "command arguments");
    if (kind === "input") return parseInput(args);
    if (kind === "wait") return parseWait(args);
    if (kind === "diagnostics") {
        checkKeys(args, ["after", "limit", "types", "levels"]);
        const filters = (name: "types" | "levels", allowed: string[]) => {
            if (args[name] === undefined) return undefined;
            if (!Array.isArray(args[name]) || !(args[name] as unknown[]).every(value => typeof value === "string" && allowed.includes(value))) {
                throw new Error(`Unsupported diagnostics ${name}`);
            }
            return args[name] as string[];
        };
        const after = number(args.after ?? 0, "after", 0, Number.MAX_SAFE_INTEGER);
        const limit = number(args.limit ?? 100, "limit", 1, 1000);
        if (!Number.isInteger(after) || !Number.isInteger(limit)) throw new Error("Diagnostic cursors and limits must be integers");
        return { kind, after, limit, types: filters("types", DIAGNOSTIC_TYPES), levels: filters("levels", DIAGNOSTIC_LEVELS) };
    }
    if (kind !== "screenshot") throw new Error(`Unknown interaction command: ${kind}`);
    checkKeys(args, ["outputPath"]);
    return { kind, ...(args.outputPath === undefined ? {} : { outputPath: text(args.outputPath, "outputPath") }) };
}

function parseWait(args: Record<string, unknown>): WaitCommand {
    checkKeys(args, ["condition", "timeoutMs", "intervalMs"]);
    const condition = record(args.condition, "condition");
    const selector = text(condition.selector, "selector");
    const timeoutMs = number(args.timeoutMs ?? 5000, "timeoutMs", 1, 30_000);
    const intervalMs = number(args.intervalMs ?? 100, "intervalMs", 10, 1000);
    if (condition.type === "node-exists" || condition.type === "node-absent") {
        checkKeys(condition, ["type", "selector"]);
        return { kind: "wait", condition: { type: condition.type, selector }, timeoutMs, intervalMs };
    }
    checkKeys(condition, ["type", "selector", "component", "path", "operator", "value"]);
    if (condition.type !== "property") throw new Error("Unsupported wait condition type");
    const propertyPath = text(condition.path, "path");
    if (propertyPath.split(".").length > 16 || propertyPath.split(".").some(part =>
        !/^[a-zA-Z_$][\w$]*$/.test(part) || ["__proto__", "prototype", "constructor"].includes(part))) {
        throw new Error("Unsafe or invalid property path");
    }
    const operator = text(condition.operator, "operator");
    if (!["eq", "ne", "gt", "gte", "lt", "lte"].includes(operator)) throw new Error("Unsupported property operator");
    const value = condition.value;
    if (value !== null && !["string", "boolean", "number"].includes(typeof value)) throw new Error("Condition value must be a JSON primitive");
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Condition value must be finite");
    if (!["eq", "ne"].includes(operator) && typeof value !== "number") throw new Error("Ordered comparison requires a number");
    return { kind: "wait", timeoutMs, intervalMs, condition: { type: "property", selector, path: propertyPath,
        operator: operator as WaitCondition["operator"], value: value as WaitCondition["value"],
        ...(condition.component === undefined ? {} : { component: text(condition.component, "component") }) } };
}

// This structured reader deliberately accepts no executable predicate.
async function readWaitCondition(condition: WaitCondition) {
    const g = globalThis as any;
    let cc = g.cc;
    if (g.System?.import) cc = await g.System.import("cc");
    else if (g.System?.resolve && g.System?.get) cc = g.System.get(await g.System.resolve("cc"));
    if (!cc?.director?.getScene) throw new Error("Cocos condition waiting is unsupported");
    const scene = cc.director.getScene();
    if (!scene) return { satisfied: false, present: false, sceneReady: false };
    const nodes: { node: any; path: string }[] = [];
    const stack = [{ node: scene, path: `/${scene.name}` }];
    while (stack.length) {
        const item = stack.pop()!;
        if (nodes.length >= 10_000) throw new Error("Scene node limit exceeded");
        nodes.push(item);
        for (const child of item.node.children ?? []) stack.push({ node: child, path: `${item.path}/${child.name}` });
    }
    const selector = condition.selector;
    const exact = nodes.filter(item => item.node.uuid === selector || item.node.name === selector || item.path === selector);
    const matches = condition.type === "property" || selector.startsWith("/") || exact.length
        ? exact : nodes.filter(item => item.node.name.toLowerCase().includes(selector.toLowerCase()) || item.path.toLowerCase().includes(selector.toLowerCase()));
    if (condition.type !== "property") return { satisfied: condition.type === "node-exists" ? matches.length > 0 : matches.length === 0, count: matches.length };
    if (matches.length === 0) return { satisfied: false, present: false };
    if (matches.length !== 1) throw new Error("Ambiguous property node selector");
    let value = matches[0].node;
    if (condition.component) {
        const components = value.getComponents(cc.Component).filter((component: any) =>
            component.constructor?.name === condition.component || cc.js?.getClassName?.(component) === condition.component);
        if (components.length !== 1) throw new Error("Component is missing or ambiguous");
        value = components[0];
    }
    for (const key of condition.path!.split(".")) {
        if (value == null || typeof value === "function" || !(key in Object(value))) throw new Error(`Property unavailable: ${condition.path}`);
        value = value[key];
    }
    if (value !== null && !["string", "boolean", "number"].includes(typeof value)) throw new Error("Property is not a JSON primitive");
    const expected = condition.value;
    let satisfied = false;
    switch (condition.operator) {
        case "eq": satisfied = value === expected; break;
        case "ne": satisfied = value !== expected; break;
        default:
            if (typeof value !== "number" || typeof expected !== "number") throw new Error("Property comparison requires numbers");
            if (condition.operator === "gt") satisfied = value > expected;
            if (condition.operator === "gte") satisfied = value >= expected;
            if (condition.operator === "lt") satisfied = value < expected;
            if (condition.operator === "lte") satisfied = value <= expected;
    }
    return { satisfied, present: true, value };
}

export async function waitForCondition(
    page: PageTransport, identity: PageIdentity, command: WaitCommand, validateTarget: (remainingMs: number) => Promise<unknown>,
    started = performance.now(),
) {
    const deadline = started + command.timeoutMs;
    const boundedPage = deadlineTransport(page, deadline);
    let initial: Awaited<ReturnType<typeof observePage>> | undefined;
    let last: unknown;
    try {
        initial = await observePage(boundedPage, identity);
        do {
            await validateTarget(Math.max(1, deadline - performance.now()));
            const current = await observePage(boundedPage, identity);
            if (current.observation.documentId !== initial.observation.documentId) throw new Error("Page document changed during wait");
            last = await boundedPage.evaluate(`(${readWaitCondition.toString()})(${JSON.stringify(command.condition)})`);
            if ((last as { satisfied: boolean }).satisfied) return { ...identity,
                capturedAt: new Date().toISOString(), observation: current.observation, status: "satisfied",
                elapsedMs: performance.now() - started, condition: command.condition, last };
            const remaining = command.timeoutMs - (performance.now() - started);
            if (remaining <= 0) break;
            await new Promise(resolve => setTimeout(resolve, Math.min(command.intervalMs, remaining)));
        } while (performance.now() - started < command.timeoutMs);
    } catch (error) {
        if (!(error instanceof OperationDeadlineError)
            && !(performance.now() >= deadline && error instanceof Error && /timed out/.test(error.message))) throw error;
    }
    return { ...identity, capturedAt: new Date().toISOString(), observation: initial?.observation ?? null,
        status: "timeout", elapsedMs: performance.now() - started, condition: command.condition, last };
}

function number(value: unknown, name: string, min: number, max: number): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
        throw new Error(`${name} must be a finite number from ${min} to ${max}`);
    }
    return value;
}

function parseObservation(value: unknown): Observation {
    const observation = record(value, "observation");
    checkKeys(observation, ["targetId", "instanceId", "refreshGeneration", "documentId", "geometryKey"]);
    return {
        targetId: text(observation.targetId, "targetId"), instanceId: text(observation.instanceId, "instanceId"),
        documentId: text(observation.documentId, "documentId"), geometryKey: text(observation.geometryKey, "geometryKey"),
        refreshGeneration: number(observation.refreshGeneration, "refreshGeneration", 0, Number.MAX_SAFE_INTEGER),
    };
}

function parsePoint(value: unknown): InputPoint {
    const point = record(value, "point");
    if (point.uuid !== undefined) {
        checkKeys(point, ["uuid", "cameraUuid", "canvasId"]);
        return { uuid: text(point.uuid, "uuid"),
            ...(point.cameraUuid === undefined ? {} : { cameraUuid: text(point.cameraUuid, "cameraUuid") }),
            ...(point.canvasId === undefined ? {} : { canvasId: text(point.canvasId, "canvasId") }) };
    }
    checkKeys(point, ["x", "y"]);
    return { x: number(point.x, "x", 0, 1_000_000), y: number(point.y, "y", 0, 1_000_000) };
}

function parseInput(args: Record<string, unknown>): InputCommand {
    checkKeys(args, ["action", "device", "observation", "point", "to", "keys", "durationMs", "timeoutMs"]);
    const action = text(args.action, "action");
    if (!["click", "long-press", "drag", "key"].includes(action)) throw new Error("Unsupported input action");
    const durationMs = number(args.durationMs ?? (action === "click" ? 0 : 500), "durationMs", 0, 20_000);
    const timeoutMs = number(args.timeoutMs ?? 10_000, "timeoutMs", 100, 30_000);
    if (durationMs >= timeoutMs) throw new Error("durationMs must be less than timeoutMs");
    const observation = parseObservation(args.observation);
    if (action === "key") {
        if (args.device !== undefined || args.point !== undefined || args.to !== undefined) throw new Error("Key input cannot have pointer arguments");
        if (!Array.isArray(args.keys) || !args.keys.length || args.keys.length > 8) throw new Error("keys must contain 1..8 key names");
        const keys = args.keys.map(key => text(key, "key"));
        if (new Set(keys).size !== keys.length) throw new Error("Duplicate key names are not allowed");
        keys.forEach(key => keyDescription(key));
        return { kind: "input", action, observation, keys, durationMs, timeoutMs };
    }
    if (args.keys !== undefined || (action !== "drag" && args.to !== undefined)) throw new Error("Unexpected arguments for pointer action");
    if (args.device !== "mouse" && args.device !== "touch") throw new Error("Pointer input device must be mouse or touch");
    return { kind: "input", action: action as InputCommand["action"], device: args.device,
        observation, point: parsePoint(args.point), ...(action === "drag" ? { to: parsePoint(args.to) } : {}), durationMs, timeoutMs };
}

function keyDescription(key: string): { key: string; code: string; windowsVirtualKeyCode: number; modifier: number } {
    const named: Record<string, [string, number, number]> = {
        Control: ["ControlLeft", 17, 2], Shift: ["ShiftLeft", 16, 8], Alt: ["AltLeft", 18, 1], Meta: ["MetaLeft", 91, 4],
        Enter: ["Enter", 13, 0], Escape: ["Escape", 27, 0], Tab: ["Tab", 9, 0], Backspace: ["Backspace", 8, 0],
        Delete: ["Delete", 46, 0], ArrowLeft: ["ArrowLeft", 37, 0], ArrowUp: ["ArrowUp", 38, 0],
        ArrowRight: ["ArrowRight", 39, 0], ArrowDown: ["ArrowDown", 40, 0], Space: ["Space", 32, 0],
        Home: ["Home", 36, 0], End: ["End", 35, 0], PageUp: ["PageUp", 33, 0], PageDown: ["PageDown", 34, 0],
    };
    const value = named[key] ?? (/^[a-zA-Z]$/.test(key) ? [`Key${key.toUpperCase()}`, key.toUpperCase().charCodeAt(0), 0]
        : /^[0-9]$/.test(key) ? [`Digit${key}`, key.charCodeAt(0), 0] : undefined);
    if (!value) throw new Error(`Unsupported key: ${key}`);
    return { key: key === "Space" ? " " : key, code: value[0] as string, windowsVirtualKeyCode: value[1] as number, modifier: value[2] as number };
}

function modifiedKeyDescription(key: string, modifiers: number): ReturnType<typeof keyDescription> {
    const description = keyDescription(key);
    if (modifiers & 8) {
        if (/^[a-zA-Z]$/.test(key)) description.key = key.toUpperCase();
        if (/^[0-9]$/.test(key)) description.key = ")!@#$%^&*("[Number(key)];
    }
    return description;
}

// Executed inside the Cocos page. Browser input still performs normal hit testing.
async function projectUiNode(point: InputPoint) {
    const g = globalThis as any;
    let cc = g.cc;
    if (g.System?.import) cc = await g.System.import("cc");
    else if (g.System?.resolve && g.System?.get) cc = g.System.get(await g.System.resolve("cc"));
    if (!cc?.director?.getScene || !cc.UITransform || !cc.Camera) throw new Error("Cocos UI projection is unsupported");
    const scene = cc.director.getScene();
    if (!scene) throw new Error("Cocos scene is unavailable");
    const nodes: any[] = [];
    const visit = (node: any) => { nodes.push(node); for (const child of node.children ?? []) visit(child); };
    visit(scene);
    const matches = nodes.filter(node => node.uuid === point.uuid);
    if (matches.length !== 1) throw new Error("Node UUID is missing or ambiguous");
    const node = matches[0];
    if (node.isValid === false || !(node.activeInHierarchy ?? node._activeInHierarchy)) throw new Error("Node is inactive or invalid");
    const ui = node.getComponent(cc.UITransform);
    if (!ui) throw new Error("Node does not support UITransform projection");
    const cameras = scene.getComponentsInChildren(cc.Camera).filter((camera: any) =>
        camera.enabled && camera.node.activeInHierarchy && (camera.visibility & node.layer)
        && (!point.cameraUuid || camera.node.uuid === point.cameraUuid));
    if (cameras.length !== 1) throw new Error("Camera is unavailable or ambiguous; provide cameraUuid");
    const canvases = Array.from(g.document.querySelectorAll("canvas")) as any[];
    const selected = canvases.filter(canvas => !point.canvasId || canvas.id === point.canvasId);
    if (selected.length !== 1) throw new Error("Canvas is unavailable or ambiguous; provide canvasId");
    const canvas = selected[0];
    if (cc.game?.canvas && cc.game.canvas !== canvas) throw new Error("Selected canvas is not the Cocos rendering canvas");
    const world = ui.convertToWorldSpaceAR(new cc.Vec3(
        (0.5 - ui.anchorPoint.x) * ui.width, (0.5 - ui.anchorPoint.y) * ui.height, 0));
    const screen = cameras[0].worldToScreen(world);
    const r = canvas.getBoundingClientRect();
    if (!canvas.width || !canvas.height || !r.width || !r.height) throw new Error("Canvas has no visible size");
    return { x: r.left + screen.x * r.width / canvas.width,
        y: r.top + (canvas.height - screen.y) * r.height / canvas.height, uuid: node.uuid };
}

async function resolvePoint(page: PageTransport, point: InputPoint, width: number, height: number) {
    const result = point.uuid
        ? await page.evaluate(`(${projectUiNode.toString()})(${JSON.stringify(point)})`) as { x: number; y: number }
        : { x: point.x!, y: point.y! };
    if (!Number.isFinite(result.x) || !Number.isFinite(result.y) || result.x < 0 || result.x >= width || result.y < 0 || result.y >= height) {
        throw new Error("Input point is outside the viewport or cannot be projected");
    }
    return result;
}

export async function sendInput(page: PageTransport, identity: PageIdentity, command: InputCommand,
    validateTarget: (remainingMs: number) => Promise<unknown>, startedAt = performance.now()) {
    const deadline = startedAt + command.timeoutMs;
    const boundedPage = deadlineTransport(page, deadline);
    const current = await observePage(boundedPage, identity);
    const expected = command.observation;
    if (expected.targetId !== identity.targetId || expected.instanceId !== identity.instanceId
        || expected.documentId !== current.observation.documentId) throw new Error("Stale page observation; screenshot again");
    if (expected.refreshGeneration !== identity.refreshGeneration) throw new Error("Stale refresh generation; screenshot again");
    if (expected.geometryKey !== current.observation.geometryKey) throw new Error("Stale screenshot geometry; screenshot again");
    const point = command.point ? await resolvePoint(boundedPage, command.point, current.viewport.width, current.viewport.height) : undefined;
    const end = command.to ? await resolvePoint(boundedPage, command.to, current.viewport.width, current.viewport.height) : point;
    let started = false;
    let completed = false;
    let cleanupConfirmed = true;
    let pointerHeld = false;
    let touchEnabled = false;
    let lastPoint = point;
    const heldKeys: ReturnType<typeof keyDescription>[] = [];
    let modifiers = 0;
    let errorMessage: string | undefined;
    const send = async (method: string, params: Record<string, unknown>) => {
        await validateTarget(Math.max(1, deadline - performance.now()));
        const latest = await observePage(boundedPage, identity);
        if (latest.observation.documentId !== expected.documentId) throw new Error("Page changed during input");
        if (latest.observation.geometryKey !== expected.geometryKey) throw new Error("Page geometry changed during input");
        return boundedPage.send(method, params);
    };
    const pause = async (ms: number) => {
        if (performance.now() + ms > deadline) throw new Error("Input total timeout exceeded");
        if (ms > 0) await new Promise(resolve => setTimeout(resolve, ms));
    };
    try {
        await send("Page.bringToFront", {});
        const focused = await boundedPage.evaluate("document.hasFocus()");
        if (!focused) throw new Error("Owned page did not acquire keyboard/input focus");
        if (command.action === "key") {
            for (const key of command.keys!) {
                const desc = modifiedKeyDescription(key, modifiers);
                modifiers |= desc.modifier;
                heldKeys.push(desc); started = true;
                const { modifier, ...params } = desc;
                await send("Input.dispatchKeyEvent", { type: "keyDown", ...params, modifiers,
                    ...(desc.key.length === 1 && !(modifiers & 7) ? { text: desc.key } : {}) });
            }
            await pause(command.durationMs);
        } else {
            if (command.device === "touch") {
                touchEnabled = true;
                await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
            }
            pointerHeld = true; started = true;
            await send(command.device === "touch" ? "Input.dispatchTouchEvent" : "Input.dispatchMouseEvent",
                command.device === "touch" ? { type: "touchStart", touchPoints: [{ x: point!.x, y: point!.y, id: 0 }] }
                    : { type: "mousePressed", x: point!.x, y: point!.y, button: "left", buttons: 1, clickCount: 1 });
            if (command.action === "drag") {
                const steps = Math.max(1, Math.min(100, Math.ceil(command.durationMs / 16)));
                for (let index = 1; index <= steps; index++) {
                    await pause(command.durationMs / steps);
                    lastPoint = { x: point!.x + (end!.x - point!.x) * index / steps,
                        y: point!.y + (end!.y - point!.y) * index / steps };
                    await send(command.device === "touch" ? "Input.dispatchTouchEvent" : "Input.dispatchMouseEvent",
                        command.device === "touch" ? { type: "touchMove", touchPoints: [{ ...lastPoint, id: 0 }] }
                            : { type: "mouseMoved", ...lastPoint, button: "left", buttons: 1 });
                }
            } else await pause(command.durationMs);
        }
        completed = true;
    } catch (error) { errorMessage = error instanceof Error ? error.message : String(error); }
    finally {
        const cleanup = async (method: string, params: Record<string, unknown>) => {
            try { await page.send(method, params, 1000); } catch { cleanupConfirmed = false; }
        };
        if (pointerHeld) await cleanup(command.device === "touch" ? "Input.dispatchTouchEvent" : "Input.dispatchMouseEvent",
            command.device === "touch" ? { type: completed ? "touchEnd" : "touchCancel", touchPoints: [] }
                : { type: "mouseReleased", x: lastPoint!.x, y: lastPoint!.y, button: "left", buttons: 0, clickCount: 1 });
        for (const desc of heldKeys.reverse()) {
            modifiers &= ~desc.modifier;
            const { modifier, ...params } = desc;
            await cleanup("Input.dispatchKeyEvent", { type: "keyUp", ...params, modifiers });
        }
        if (touchEnabled) await cleanup("Emulation.setTouchEmulationEnabled", { enabled: false });
    }
    return { ...identity, observation: current.observation, capturedAt: new Date().toISOString(),
        status: completed && cleanupConfirmed ? "sent" : "failed", located: Boolean(point) || command.action === "key",
        started, completed: completed && cleanupConfirmed, cleanupConfirmed, point, to: end,
        ...(errorMessage ? { error: errorMessage } : !cleanupConfirmed ? { error: "Input cleanup could not be confirmed" } : {}) };
}

export function record(value: unknown, name: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
    return value as Record<string, unknown>;
}

export function text(value: unknown, name: string): string {
    if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a nonempty string`);
    return value;
}

export function checkKeys(value: Record<string, unknown>, allowed: string[]): void {
    for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown argument: ${key}`);
}

// This function is serialized into the preview page; it must be self-contained.
async function readPageObservation() {
    const g = globalThis as any;
    const key = "__cocosLiveProbeDocumentIdentity";
    if (!g[key]) Object.defineProperty(g, key, { value: g.crypto.randomUUID() });
    const canvases = Array.from(g.document.querySelectorAll("canvas")) as any[];
    const vv = g.visualViewport;
    let cc = g.cc;
    try {
        if (g.System?.import) cc = await g.System.import("cc");
        else if (g.System?.resolve && g.System?.get) cc = g.System.get(await g.System.resolve("cc"));
    } catch { /* Browser diagnostics remain available before Cocos is ready. */ }
    return {
        documentToken: g[key],
        viewport: { width: g.innerWidth, height: g.innerHeight },
        devicePixelRatio: g.devicePixelRatio,
        visualViewport: { width: vv?.width ?? g.innerWidth, height: vv?.height ?? g.innerHeight,
            scale: vv?.scale ?? 1, offsetLeft: vv?.offsetLeft ?? 0, offsetTop: vv?.offsetTop ?? 0 },
        canvases: canvases.map(canvas => {
            const r = canvas.getBoundingClientRect();
            return { id: canvas.id ?? "", left: r.left, top: r.top, width: r.width, height: r.height,
                bufferWidth: canvas.width, bufferHeight: canvas.height };
        }),
        visibility: g.document.visibilityState,
        focused: g.document.hasFocus(),
        cocos: { version: cc?.ENGINE_VERSION ?? cc?.VERSION ?? g.cc?.ENGINE_VERSION ?? null,
            capabilities: { nodeProjection: Boolean(cc?.UITransform && cc?.Camera),
                conditionWait: Boolean(cc?.director?.getScene) }, scene: cc?.director?.getScene?.()?.name ?? null },
    };
}

export async function observePage(page: PageTransport, identity: PageIdentity) {
    const tree = await page.send("Page.getFrameTree") as { frameTree?: { frame?: { loaderId?: string } } };
    if (!tree.frameTree?.frame?.loaderId) throw new Error("Page document loader is unavailable");
    const value = await page.evaluate(`(${readPageObservation.toString()})()`) as Awaited<ReturnType<typeof readPageObservation>>;
    const geometry = { viewport: value.viewport, visualViewport: value.visualViewport,
        devicePixelRatio: value.devicePixelRatio, canvases: value.canvases };
    const observation: Observation = { ...identity,
        documentId: `${tree.frameTree.frame.loaderId}:${value.documentToken}`,
        geometryKey: createHash("sha256").update(JSON.stringify(geometry)).digest("hex"),
    };
    return { ...geometry, visibility: value.visibility, focused: value.focused, cocos: value.cocos, observation };
}

export async function captureScreenshot(
    page: PageTransport, identity: PageIdentity, directory: string, outputPath?: string,
) {
    const before = await observePage(page, identity);
    const image = await page.send("Page.captureScreenshot", {
        format: "png", fromSurface: true, captureBeyondViewport: false,
    }) as { data: string };
    const after = await observePage(page, identity);
    if (before.observation.documentId !== after.observation.documentId
        || before.observation.geometryKey !== after.observation.geometryKey) {
        throw new Error("Page changed during screenshot; observe again");
    }
    const png = Buffer.from(image.data, "base64");
    if (png.length < 24 || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
        throw new Error("CDP did not return a valid PNG screenshot");
    }
    const destination = path.resolve(outputPath ?? path.join(directory, `${Date.now()}-${randomUUID()}.png`));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, png);
    if (!outputPath) retainScreenshots(directory, destination);
    return { ...identity, capturedAt: new Date().toISOString(), ...after,
        imageWidth: png.readUInt32BE(16), imageHeight: png.readUInt32BE(20), outputPath: destination,
        image: { mimeType: "image/png", data: image.data },
    };
}

function retainScreenshots(directory: string, current: string): void {
    const files = fs.readdirSync(directory).filter(name => name.endsWith(".png")).flatMap(name => {
        const file = path.join(directory, name);
        try { const stat = fs.statSync(file); return [{ file, size: stat.size, time: stat.mtimeMs }]; }
        catch { return []; }
    }).sort((a, b) => a.time - b.time);
    let total = files.reduce((sum, file) => sum + file.size, 0);
    let count = files.length;
    for (const file of files) {
        if (count <= 100 && total <= 100 * 1024 * 1024) break;
        if (file.file === current) continue;
        try { fs.unlinkSync(file.file); total -= file.size; count -= 1; } catch { /* Another session may prune it. */ }
    }
    if (total > 100 * 1024 * 1024) {
        fs.unlinkSync(current);
        throw new Error("Screenshot exceeds the 100 MiB artifact capacity; supply an explicit outputPath");
    }
}
