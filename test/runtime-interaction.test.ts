import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runInNewContext } from "vm";
import { webcrypto } from "crypto";
import { createServer } from "http";
import { parseRuntimeProbeArgs, runtimeProbeOptionsFromEnv, RuntimeProbeService } from "../runtime-probe";
import { handleRuntimeProbeMcpMessage } from "../runtime-probe-mcp";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";

function environment() {
    const rect = { x: 0, y: 0, left: 0, top: 0, width: 640, height: 480 };
    const canvas = { width: 640, height: 480, getBoundingClientRect: () => rect };
    const scene: any = { name: "fixture", children: [], parent: null };
    const globals: any = {
        crypto: webcrypto, innerWidth: 640, innerHeight: 480, devicePixelRatio: 1,
        performance: { timeOrigin: 1000 },
        document: { querySelectorAll: () => [canvas], hasFocus: () => true, visibilityState: "visible" },
        cc: { director: { getScene: () => scene }, ENGINE_VERSION: "3.8.8" },
    };
    globals.globalThis = globals;
    const listeners = new Map<string, Set<(params: any) => void>>();
    globals.pressed = false;
    globals.clicks = 0;
    globals.loaderId = "loader-1";
    globals.keysHeld = new Set();
    globals.keyEvents = [];
    const evaluator = {
        evaluate: async (expression: string) => runInNewContext(expression, globals),
        reload: async (accepted?: () => void) => { accepted?.(); },
        dispose: () => {},
        send: async (method: string, params?: Readonly<Record<string, unknown>>) => {
            if (globals.failMethod === method && (!globals.failEventType || globals.failEventType === params?.type)) {
                globals.failMethod = undefined;
                throw new Error("Injected external protocol failure");
            }
            if (method === "Input.dispatchKeyEvent") {
                globals.keyEvents.push(params);
                if (params?.type === "keyDown") globals.keysHeld.add(params.key);
                if (params?.type === "keyUp") globals.keysHeld.delete(params.key);
            }
            if (method === "Input.dispatchMouseEvent") {
                if (params?.type === "mousePressed") globals.pressed = true;
                if (params?.type === "mouseReleased" && globals.pressed) { globals.pressed = false; globals.clicks++; }
            }
            if (method === "Page.captureScreenshot") return { data: PNG };
            if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main", loaderId: globals.loaderId } } };
            if (method === "Browser.getVersion") return { product: "Chrome/151" };
            if (method === "Runtime.evaluate") return { result: { type: "object", value: await runInNewContext(params!.expression as string, globals) } };
            return {};
        },
        onEvent: (method: string, listener: (params: any) => void) => {
            const set = listeners.get(method) ?? new Set(); set.add(listener); listeners.set(method, set);
            return () => { set.delete(listener); };
        },
    };
    const url = "http://127.0.0.1:7456/?autoReload=false&runtimeProbeInstance=test";
    const service = new RuntimeProbeService({
        instanceId: "test", ownership: "shared",
        dependencies: {
            checkPreview: async () => true,
            getBrowserWebSocketUrl: async () => "ws://127.0.0.1/browser",
            listTargets: async () => [{ id: "page-1", type: "page", url, webSocketDebuggerUrl: "ws://127.0.0.1/page-1" }],
            createBrowserClient: () => ({
                createBrowserContext: async () => "context", createTarget: async () => "page-1",
                getTargetInfo: async () => ({ targetId: "page-1", type: "page", title: "fixture", url, attached: true }),
                disposeBrowserContext: async () => {}, dispose: () => {},
                getVersion: async () => ({ product: "Chrome/151", protocolVersion: "1.3" }),
            }),
            createEvaluator: () => {
                let disposed = false;
                return { ...evaluator,
                    dispose: () => { disposed = true; },
                    evaluate: async (expression: string) => {
                        if (disposed) throw new Error("Disposed fixture evaluator");
                        if (globals.failReadyOnce && expression.includes("ready: Boolean")) {
                            globals.failReadyOnce = false;
                            throw new Error("Execution context destroyed during initial navigation");
                        }
                        return evaluator.evaluate(expression);
                    },
                    send: async (method: string, params?: Readonly<Record<string, unknown>>) => {
                        if (disposed) throw new Error("Disposed fixture evaluator");
                        return evaluator.send(method, params);
                    },
                };
            },
        },
    });
    return { service, globals, emit: (method: string, params: unknown) => {
        for (const listener of listeners.get(method) ?? []) listener(params);
    }, listenerCount: () => Array.from(listeners.values()).reduce((count, set) => count + set.size, 0) };
}

async function main(): Promise<void> {
    const slowPreview = createServer(() => { /* Simulate a preview that never responds. */ });
    await new Promise<void>(resolve => slowPreview.listen(0, "127.0.0.1", resolve));
    const port = (slowPreview.address() as { port: number }).port;
    const slowService = new RuntimeProbeService({ previewUrl: `http://127.0.0.1:${port}/` });
    try {
        const started = performance.now();
        const result = await slowService.dispatch(parseRuntimeProbeArgs(["wait", JSON.stringify({
            condition: { type: "node-exists", selector: "anything" }, timeoutMs: 100,
        })])) as any;
        assert.strictEqual(result.status, "timeout");
        assert.ok(performance.now() - started < 500, "preparation must share the request timeout");
        assert.ok(result.elapsedMs >= 90, "elapsed time includes preparation");
    } finally {
        await slowService.dispose();
        slowPreview.closeAllConnections();
        await new Promise<void>(resolve => slowPreview.close(() => resolve()));
    }
    const loading = environment();
    loading.globals.cc.director.getScene = () => null;
    try {
        const started = performance.now();
        const result = await loading.service.dispatch(parseRuntimeProbeArgs(["wait", JSON.stringify({
            condition: { type: "node-exists", selector: "anything" }, timeoutMs: 40,
        })])) as any;
        assert.strictEqual(result.status, "timeout");
        assert.ok(performance.now() - started < 300, "Cocos readiness must share the request timeout");
        assert.ok(result.elapsedMs >= 35);
    } finally { await loading.service.dispose(); }
    const reconnecting = environment();
    reconnecting.globals.failReadyOnce = true;
    try {
        const result = await reconnecting.service.dispatch(parseRuntimeProbeArgs(["screenshot"])) as any;
        assert.strictEqual(result.imageWidth, 1, "initial navigation recovery uses the replacement evaluator");
    } finally { await reconnecting.service.dispose(); }
    assert.deepStrictEqual(runtimeProbeOptionsFromEnv({
        COCOS_RUNTIME_PROBE_BROWSER_EXECUTABLE: " C:\\Browser With Spaces\\chrome.exe ",
    }), { browserExecutable: "C:\\Browser With Spaces\\chrome.exe" });
    const service = new RuntimeProbeService({
        ...runtimeProbeOptionsFromEnv({ COCOS_RUNTIME_PROBE_BROWSER_EXECUTABLE: "missing-browser.exe" }),
        dependencies: { fileExists: () => false, checkPreview: async () => true },
    });
    await assert.rejects(service.dispatch({ kind: "launch" }), /configured browser executable/i);
    await service.dispose();
    const fixture = environment();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "probe-screenshot-test-"));
    try {
        const outputPath = path.join(directory, "capture.png");
        const screenshot = await fixture.service.dispatch(parseRuntimeProbeArgs([
            "screenshot", JSON.stringify({ outputPath }),
        ])) as any;
        assert.strictEqual(screenshot.targetId, "page-1");
        assert.strictEqual(screenshot.imageWidth, 1);
        assert.strictEqual(screenshot.viewport.width, 640);
        assert.strictEqual(screenshot.outputPath, outputPath);
        assert.strictEqual(fs.readFileSync(outputPath).subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
        assert.ok(screenshot.observation.documentId);
        const response = await handleRuntimeProbeMcpMessage({
            jsonrpc: "2.0", id: 1, method: "tools/call",
            params: { name: "runtime_screenshot", arguments: { outputPath } },
        }, command => fixture.service.dispatch(command)) as any;
        assert.strictEqual(response.result.content[0].type, "image");
        assert.strictEqual(response.result.content[0].mimeType, "image/png");
        assert.strictEqual(JSON.parse(response.result.content[1].text).targetId, "page-1");
        const input = { action: "click", device: "mouse", point: { x: 100, y: 120 }, observation: screenshot.observation };
        for (const [key, expected] of [["a", "A"], ["1", "!"]]) {
            const shifted = await fixture.service.dispatch(parseRuntimeProbeArgs(["input", JSON.stringify({
                action: "key", keys: ["Shift", key], durationMs: 0, observation: screenshot.observation,
            })])) as any;
            assert.strictEqual(shifted.status, "sent");
            assert.ok(fixture.globals.keyEvents.some((event: any) => event.type === "keyDown"
                && event.key === expected && event.text === expected && event.modifiers === 8));
            assert.ok(fixture.globals.keyEvents.some((event: any) => event.type === "keyUp" && event.key === expected));
            assert.strictEqual(fixture.globals.keysHeld.size, 0);
        }
        const clicked = await fixture.service.dispatch(parseRuntimeProbeArgs(["input", JSON.stringify(input)])) as any;
        assert.strictEqual(clicked.status, "sent");
        assert.strictEqual(fixture.globals.clicks, 1);
        assert.strictEqual(fixture.globals.pressed, false);
        fixture.globals.innerWidth = 800;
        await assert.rejects(fixture.service.dispatch(parseRuntimeProbeArgs(["input", JSON.stringify(input)])), /stale.*geometry/i);
        assert.strictEqual(fixture.globals.clicks, 1, "stale input must not send another click");
        const scene = fixture.globals.cc.director.getScene();
        const waiting = fixture.service.dispatch(parseRuntimeProbeArgs(["wait", JSON.stringify({
            condition: { type: "node-exists", selector: "async-node" }, timeoutMs: 500, intervalMs: 10,
        })]));
        setTimeout(() => { scene.children.push({ name: "async-node", uuid: "async-node", activeInHierarchy: false, children: [], parent: scene }); }, 30);
        const waited = await waiting as any;
        assert.strictEqual(waited.status, "satisfied", "inactive nodes still exist");
        const timeout = await fixture.service.dispatch(parseRuntimeProbeArgs(["wait", JSON.stringify({
            condition: { type: "property", selector: "async-node", path: "activeInHierarchy", operator: "eq", value: true },
            timeoutMs: 40, intervalMs: 10,
        })])) as any;
        assert.strictEqual(timeout.status, "timeout");
        assert.strictEqual(timeout.last.value, false);
        const afterTimeout = await fixture.service.dispatch({ kind: "status" }) as any;
        assert.strictEqual(afterTimeout.instance.target.id, "page-1", "queue remains usable after timeout");
        fixture.emit("Runtime.consoleAPICalled", { type: "warning", timestamp: 1000, args: [{ type: "string", value: "fixture warning" }] });
        fixture.emit("Runtime.exceptionThrown", { timestamp: 1001, exceptionDetails: { text: "Uncaught (in promise)", exception: { description: "Error: async fixture" } } });
        fixture.emit("Network.responseReceived", { requestId: "r1", response: { status: 404, url: "http://127.0.0.1:7456/missing" } });
        const diagnostics = await fixture.service.dispatch(parseRuntimeProbeArgs(["diagnostics"])) as any;
        assert.deepStrictEqual(diagnostics.records.map((item: any) => item.type), ["console", "promise-rejection", "http-error"]);
        assert.strictEqual(diagnostics.records[0].message, "fixture warning");
        assert.ok(diagnostics.startedAt);
        const incremental = await fixture.service.dispatch(parseRuntimeProbeArgs(["diagnostics", JSON.stringify({ after: diagnostics.nextCursor })])) as any;
        assert.strictEqual(incremental.records.length, 0);
        const tools = await handleRuntimeProbeMcpMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, command => fixture.service.dispatch(command)) as any;
        for (const name of ["runtime_input", "runtime_wait", "runtime_diagnostics"]) {
            assert.ok(tools.result.tools.some((tool: any) => tool.name === name), `MCP must expose ${name}`);
        }
        const mcpWait = await handleRuntimeProbeMcpMessage({ jsonrpc: "2.0", id: 3, method: "tools/call",
            params: { name: "runtime_wait", arguments: { condition: { type: "node-exists", selector: "async-node" } } },
        }, command => fixture.service.dispatch(command)) as any;
        assert.strictEqual(JSON.parse(mcpWait.result.content[0].text).status, "satisfied");
        const withLogs = await fixture.service.dispatch(parseRuntimeProbeArgs(["eval", "--diagnostics", "({ answer: 42 })"])) as any;
        assert.strictEqual(withLogs.result.answer, 42);
        assert.ok(withLogs.diagnostics.startedAt);
        assert.ok(withLogs.elapsedMs >= 0);
        const fresh = await fixture.service.dispatch(parseRuntimeProbeArgs(["screenshot", JSON.stringify({ outputPath })])) as any;
        await assert.rejects(fixture.service.dispatch(parseRuntimeProbeArgs(["input", JSON.stringify({
            action: "click", device: "mouse", point: { x: 30, y: 30 },
            observation: { ...fresh.observation, refreshGeneration: fresh.observation.refreshGeneration + 1 },
        })])), /stale.*generation/i);
        fixture.globals.failMethod = "Input.dispatchMouseEvent";
        fixture.globals.failEventType = "mouseMoved";
        const failedDrag = await fixture.service.dispatch(parseRuntimeProbeArgs(["input", JSON.stringify({
            action: "drag", device: "mouse", point: { x: 30, y: 30 }, to: { x: 80, y: 80 }, durationMs: 20, observation: fresh.observation,
        })])) as any;
        assert.strictEqual(failedDrag.status, "failed");
        assert.strictEqual(failedDrag.cleanupConfirmed, true);
        assert.strictEqual(fixture.globals.pressed, false);
        fixture.globals.failMethod = "Input.dispatchKeyEvent";
        fixture.globals.failEventType = "keyDown";
        const failedKey = await fixture.service.dispatch(parseRuntimeProbeArgs(["input", JSON.stringify({
            action: "key", keys: ["Control", "a"], observation: fresh.observation,
        })])) as any;
        assert.strictEqual(failedKey.status, "failed");
        assert.strictEqual(fixture.globals.keysHeld.size, 0);
        const circular: any = { name: "large" }; circular.self = circular;
        fixture.emit("Runtime.consoleAPICalled", { type: "log", args: [{ value: circular }] });
        const circularLogs = await fixture.service.dispatch(parseRuntimeProbeArgs(["diagnostics", JSON.stringify({ limit: 1000 })])) as any;
        assert.ok(circularLogs.records.some((item: any) => item.truncated));
        for (let index = 0; index < 1100; index++) fixture.emit("Runtime.consoleAPICalled", { type: "log", args: [{ value: `line ${index}` }] });
        const flooded = await fixture.service.dispatch(parseRuntimeProbeArgs(["diagnostics", JSON.stringify({ limit: 1000 })])) as any;
        assert.strictEqual(flooded.records.length, 1000);
        assert.ok(flooded.cursorGap && flooded.dropped > 0);
        assert.ok(flooded.retainedBytes <= 2 * 1024 * 1024);
        fixture.globals.loaderId = "loader-2";
        fixture.emit("Page.frameNavigated", { frame: { id: "main", loaderId: "loader-2" } });
        await assert.rejects(fixture.service.dispatch(parseRuntimeProbeArgs(["input", JSON.stringify(input)])), /stale.*page/i);
        const refreshedStatus = await fixture.service.dispatch({ kind: "status" }) as any;
        assert.strictEqual(refreshedStatus.instance.refreshGeneration, 1);
        assert.throws(() => parseRuntimeProbeArgs(["wait", JSON.stringify({ condition: {
            type: "property", selector: "x", path: "constructor.name", operator: "eq", value: "Object",
        } })]), /unsafe/i);
        assert.throws(() => parseRuntimeProbeArgs(["input", JSON.stringify({ ...input, surprise: true })]), /unknown argument/i);
    } finally { await fixture.service.dispose(); fs.rmSync(directory, { recursive: true, force: true }); }
    assert.strictEqual(fixture.listenerCount(), 0, "dispose must release subscriptions");
    const noScene = environment();
    noScene.globals.cc.director.getScene = () => null;
    try {
        const unavailable = await noScene.service.dispatch(parseRuntimeProbeArgs(["diagnostics"])) as any;
        assert.ok(unavailable.connected, "diagnostics must remain available before the Cocos scene is ready");
    } finally { await noScene.service.dispose(); }
    console.log("runtime-interaction.test passed");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
