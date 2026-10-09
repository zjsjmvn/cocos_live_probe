import { runInNewContext } from "vm";
import { webcrypto } from "crypto";
import { RuntimeProbeService, RuntimeProbeServiceOptions } from "../../runtime-probe";

export function gameEnvironment(gameExtension: string, instanceId = "game-test", options: RuntimeProbeServiceOptions = {}) {
    const scene = { name: "fixture", children: [] };
    const globals = {
        crypto: webcrypto, innerWidth: 640, innerHeight: 480, devicePixelRatio: 1,
        performance: { timeOrigin: 1000 }, setTimeout, clearTimeout,
        document: { querySelectorAll: () => [], hasFocus: () => true, visibilityState: "visible" },
        cc: { director: { getScene: () => scene }, ENGINE_VERSION: "3.8.8" } as any,
        count: 0, blocked: false, pressed: false, loaderId: "loader-1", bridgeInstance: "bridge-1",
        failInput: false, inputCount: 0, replaceBridgeOnScreenshot: false, replaceBridgeOnFocus: false,
        extraState: {} as Record<string, unknown>,
        screenshotData: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
        __gameProbe: {
            getState: () => ({ gameId: "fixture", stateVersion: 1, instanceId: globals.bridgeInstance,
                state: { count: globals.count, blocked: globals.blocked, ...globals.extraState } }),
        },
    };
    const listeners = new Map<string, Set<(params: unknown) => void>>();
    const url = `http://127.0.0.1:7456/?autoReload=false&runtimeProbeInstance=${instanceId}`;
    const service = new RuntimeProbeService({
        ...options,
        gameExtension, instanceId, ownership: "shared",
        dependencies: {
            checkPreview: async () => true,
            getBrowserWebSocketUrl: async () => "ws://127.0.0.1/browser",
            listTargets: async () => [{ id: instanceId, type: "page", url, webSocketDebuggerUrl: `ws://127.0.0.1/${instanceId}` }],
            createBrowserClient: () => ({
                createBrowserContext: async () => "context", createTarget: async () => instanceId,
                getTargetInfo: async () => ({ targetId: instanceId, type: "page", title: "fixture", url, attached: true }),
                disposeBrowserContext: async () => {}, dispose: () => {},
            }),
            createEvaluator: () => ({
                evaluate: async expression => {
                    if (expression === "document.hasFocus()" && globals.replaceBridgeOnFocus) globals.bridgeInstance = "replacement";
                    return runInNewContext(expression, globals);
                },
                reload: async accepted => { accepted?.(); globals.loaderId += "-new"; }, dispose: () => {},
                onEvent: (method, listener) => {
                    const set = listeners.get(method) ?? new Set(); set.add(listener); listeners.set(method, set);
                    return () => { set.delete(listener); };
                },
                send: async (method, params) => {
                    if (method === "Runtime.evaluate") {
                        if (params?.expression === "document.hasFocus()" && globals.replaceBridgeOnFocus) globals.bridgeInstance = "replacement";
                        return { result: { type: "object", value: await runInNewContext(String(params?.expression), globals) } };
                    }
                    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main", loaderId: globals.loaderId } } };
                    if (method === "Page.captureScreenshot") {
                        if (globals.replaceBridgeOnScreenshot) globals.bridgeInstance = "replacement";
                        return { data: globals.screenshotData };
                    }
                    if (method === "Input.dispatchMouseEvent") {
                        if (params?.type === "mousePressed") { globals.pressed = true; globals.inputCount++; }
                        if (globals.failInput && params?.type === "mousePressed") { globals.failInput = false; throw new Error("Partial input failure"); }
                        if (params?.type === "mouseReleased") {
                            if (globals.pressed && !globals.blocked) globals.count++;
                            globals.pressed = false;
                        }
                    }
                    return {};
                },
            }),
        },
    });
    return { service, globals };
}
