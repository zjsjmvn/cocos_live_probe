import * as assert from "assert";
import { randomUUID } from "crypto";
import * as http from "http";
import { runInNewContext } from "vm";
import { buildInspectorExpression, InspectorRequest, parseInspectorRequest } from "../runtime-inspector-core";
import { createRuntimeInspectorServer } from "../runtime-inspector";
import { RuntimeProbeCommand } from "../runtime-probe";
import { handleRuntimeProbeMcpMessage } from "../runtime-probe-mcp";
import { parsePreviewToolRequest } from "../runtime-inspector-preview-tools";
import { buildWorkbenchExpression, parseWorkbenchRequest, WorkbenchRequest } from "../runtime-inspector-workbench";

class NodeFixture {
    public uuid = randomUUID(); public active = true; public activeInHierarchy = true;
    public parent: NodeFixture | null = null; public children: NodeFixture[] = []; public components: any[] = [];
    public position = { x: 0, y: 0, z: 0 }; public eulerAngles = { x: 0, y: 0, z: 0 }; public scale = { x: 1, y: 1, z: 1 };
    public worldPosition = { x: 0, y: 0, z: 0 }; public valid = true; public keepWorld: boolean | undefined;
    constructor(public name: string) {}
    setParent(parent: NodeFixture, keepWorld?: boolean) {
        if (this.parent) this.parent.children.splice(this.getSiblingIndex(), 1);
        this.parent = parent; parent.children.push(this); this.keepWorld = keepWorld;
    }
    getSiblingIndex() { return this.parent ? this.parent.children.indexOf(this) : 0; }
    setSiblingIndex(index: number) {
        const list = this.parent!.children; list.splice(list.indexOf(this), 1); list.splice(index, 0, this);
    }
    setPosition(x: number, y: number, z: number) { this.position = { x, y, z }; }
    setScale(x: number, y: number, z: number) { this.scale = { x, y, z }; }
    setRotationFromEuler(x: number, y: number, z: number) { this.eulerAngles = { x, y, z }; }
    destroy() { this.valid = false; if (this.parent) this.parent.children.splice(this.getSiblingIndex(), 1); }
    getComponent(type: any) { return this.components.find(component => component instanceof type); }
}
class ComponentFixture {
    static __props__ = ["speed", "label", "target", "_internal", "readonly", "color", "direction", "mode", "weights", "options", "readonlyColor"];
    static __attrs__ = { "mode$_$enumList": [{ name: "A", value: 0 }, { name: "B", value: 1 }] };
    uuid = randomUUID(); enabled = true; speed = 5; label = "你好"; target = { uuid: "reference" }; _internal = 1;
    color = new ColorFixture(20, 30, 40, 50); direction = new Vec3Fixture(1, 2, 3); mode = 0; weights = [1, 2]; options = { secret: 3 };
    get readonly() { return 4; }
    get readonlyColor() { return new ColorFixture(1, 2, 3, 4); }
}
class ColorFixture {
    constructor(public r: number, public g: number, public b: number, public a: number) {}
    clone() { return new ColorFixture(this.r, this.g, this.b, this.a); }
}
class Vec3Fixture { constructor(public x: number, public y: number, public z: number) {} clone() { return new Vec3Fixture(this.x, this.y, this.z); } }

async function main() {
    assert.throws(() => parsePreviewToolRequest({ action: "__proto__" }), /Invalid/);
    assert.throws(() => parsePreviewToolRequest({ action: "fps", enabled: "true" }), /boolean/);
    assert.throws(() => parsePreviewToolRequest({ action: "cache", operation: "all" }), /cache/);
    assert.throws(() => parsePreviewToolRequest({ action: "mode", mode: "eval" }), /Invalid/);
    assert.deepStrictEqual(parsePreviewToolRequest({ action: "selection", uuid: "node-uuid" }), { action: "selection", uuid: "node-uuid" });
    assert.deepStrictEqual(parsePreviewToolRequest({ action: "selection", uuid: null }), { action: "selection", uuid: null });
    assert.throws(() => parsePreviewToolRequest({ action: "selection", uuid: "x".repeat(257) }), /UUID/);
    assert.throws(() => parsePreviewToolRequest({ action: "state", expression: "1" }), /arguments/);
    for (const dimensions of [[0, 720], [390.5, 844], [-1, 720], [4097, 720]]) assert.throws(() => parsePreviewToolRequest({ action: "resolution", width: dimensions[0], height: dimensions[1] }), /分辨率/);
    assert.deepStrictEqual(parsePreviewToolRequest({ action: "resolution", width: 0, height: 0 }), { action: "resolution", width: 0, height: 0 });
    assert.throws(() => parseInspectorRequest({ action: "eval", expression: "1" }), /Unknown/);
    assert.throws(() => parseInspectorRequest({ action: "__proto__" }), /Unknown/);
    assert.throws(() => parseInspectorRequest({ action: "inspect", uuid: "a" }), /context/);
    assert.throws(() => parseInspectorRequest({ action: "edit", uuid: "a", context: "b", componentUuid: "c", field: "weights", propertyPath: ["__proto__"], value: 1 }), /path/);
    assert.throws(() => parseWorkbenchRequest({ action: "storage", context: "c", operation: "clear" }), /Invalid/);
    assert.throws(() => parseWorkbenchRequest({ action: "runtime-setting", context: "c", name: "frameRate", value: 0 }), /Invalid/);
    assert.throws(() => parseInspectorRequest({ action: "move", uuid: "a", context: "b", parentUuid: "c", siblingIndex: -1, keepWorldTransform: true }), /hierarchy/);
    let scene = new NodeFixture("Scene"); const a = new NodeFixture("同名"); const b = new NodeFixture("同名");
    a.setParent(scene); b.setParent(scene); a.components.push(new ComponentFixture());
    let paused = false;
    const stored = new Map<string, string>([["game", "old"]]);
    const storage = { get length() { return stored.size; }, key: (index: number) => [...stored.keys()][index], getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key) };
    const environment = { crypto: { randomUUID }, localStorage: storage, cc: {
        Color: ColorFixture, Vec3: Vec3Fixture, game: { frameRate: 60 },
        assetManager: { assets: { forEach: (visit: (asset: any, key: string) => void) => { for (let i = 0; i < 140; i++) visit({ name: "Asset" + i, uuid: "asset-" + i, refCount: i }, "asset-" + i); } } },
        isValid: (value: any) => value?.valid !== false,
        director: { getScene: () => scene, isPaused: () => paused, pause: () => { paused = true; }, resume: () => { paused = false; } },
    } };
    const evaluate = (request: InspectorRequest): Promise<any> => runInNewContext(buildInspectorExpression(request), environment);
    const workbench = (request: WorkbenchRequest): Promise<any> => runInNewContext(buildWorkbenchExpression(request), environment);
    const tree = await evaluate({ action: "tree" }); assert.strictEqual(tree.nodes.length, 3);
    const context = tree.context;
    const snapshot = await evaluate({ action: "inspect", uuid: a.uuid, context });
    assert.strictEqual(snapshot.uuid, a.uuid, "Duplicate names must use UUID identity");
    assert.strictEqual(snapshot.components[0].fields.find((field: any) => field.name === "readonly").editable, false);
    assert.ok(!snapshot.components[0].fields.some((field: any) => field.name === "_internal"));
    await evaluate({ action: "edit", uuid: a.uuid, context, field: "position", value: { x: 12, y: 34, z: 56 } });
    assert.deepStrictEqual(a.position, { x: 12, y: 34, z: 56 });
    await assert.rejects(evaluate({ action: "edit", uuid: a.uuid, context, field: "position", value: { x: 1, y: 2 } }), /向量/);
    await assert.rejects(evaluate({ action: "edit", uuid: a.uuid, context, field: "constructor", value: "x" }), /不支持/);
    const componentUuid = a.components[0].uuid;
    const color = snapshot.components[0].fields.find((field: any) => field.name === "color");
    assert.strictEqual(color.type, "color"); assert.strictEqual(color.value.a, 50);
    assert.strictEqual(snapshot.components[0].fields.find((field: any) => field.name === "mode").type, "enum");
    assert.strictEqual(snapshot.components[0].fields.find((field: any) => field.name === "readonlyColor").editable, false);
    const previousColor = a.components[0].color;
    await evaluate({ action: "edit", uuid: a.uuid, context, componentUuid, field: "color", value: { r: 100, g: 110, b: 120, a: 130 } });
    assert.ok(a.components[0].color instanceof ColorFixture); assert.notStrictEqual(a.components[0].color, previousColor, "Typed edits replace values to run engine setters");
    assert.strictEqual(previousColor.r, 20, "Typed edits do not mutate an aliased value");
    await assert.rejects(evaluate({ action: "edit", uuid: a.uuid, context, componentUuid, field: "color", value: { r: -1, g: 1, b: 2, a: 3 } }), /颜色/);
    await evaluate({ action: "edit", uuid: a.uuid, context, componentUuid, field: "direction", value: { x: 4, y: 5, z: 6 } });
    assert.ok(a.components[0].direction instanceof Vec3Fixture); assert.strictEqual(a.components[0].direction.z, 6);
    await evaluate({ action: "edit", uuid: a.uuid, context, componentUuid, field: "mode", value: 1 });
    await assert.rejects(evaluate({ action: "edit", uuid: a.uuid, context, componentUuid, field: "mode", value: 9 }), /枚举/);
    await evaluate({ action: "edit", uuid: a.uuid, context, componentUuid, field: "weights", propertyPath: ["1"], value: 7 });
    assert.deepStrictEqual(a.components[0].weights, [1, 7]);
    await assert.rejects(evaluate({ action: "edit", uuid: a.uuid, context, componentUuid, field: "options", propertyPath: ["secret"], value: 7 }), /可写/);
    a.components[0].target = b;
    const referenced = await evaluate({ action: "inspect", uuid: a.uuid, context });
    assert.strictEqual(referenced.components[0].fields.find((field: any) => field.name === "target").reference.nodeUuid, b.uuid);
    const exposed = await evaluate({ action: "expose", uuid: a.uuid, context, componentUuid });
    assert.strictEqual(exposed.name, "$probeComponent"); assert.strictEqual((environment as any).$probeComponent, a.components[0]);
    const info = await workbench({ action: "runtime-info", context }); assert.strictEqual(info.stats.nodes, 3); assert.strictEqual(info.stats.drawCalls, null);
    await workbench({ action: "runtime-setting", context, name: "frameRate", value: 30 }); assert.strictEqual(environment.cc.game.frameRate, 30);
    assert.strictEqual(paused, false, "Runtime settings preserve the pause state");
    const assets = await workbench({ action: "runtime-assets", context, query: "", offset: 100 });
    assert.strictEqual(assets.assets.length, 40); assert.strictEqual(assets.assets[0].uuid, "asset-100"); assert.strictEqual(assets.matched, 140);
    await workbench({ action: "storage", context, operation: "set", key: "game", expected: "old", value: "new" });
    await assert.rejects(workbench({ action: "storage", context, operation: "remove", key: "game", expected: "old" }), /已变化/);
    assert.strictEqual(stored.get("game"), "new");
    await workbench({ action: "storage", context, operation: "remove", key: "game", expected: "new" }); assert.ok(!stored.has("game"));
    stored.set("large", "x".repeat(20000));
    const storageResult = await workbench({ action: "storage", context, operation: "read" });
    assert.ok(storageResult.truncated); assert.strictEqual(storageResult.entries[0].editable, false);
    await evaluate({ action: "edit", uuid: a.uuid, context, componentUuid, field: "speed", value: 9 });
    assert.strictEqual(a.components[0].speed, 9);
    await assert.rejects(evaluate({ action: "edit", uuid: a.uuid, context, componentUuid, field: "speed", value: "9" }), /同类型/);
    await assert.rejects(evaluate({ action: "edit", uuid: a.uuid, context, componentUuid, field: "target", value: "x" }), /同类型/);
    await evaluate({ action: "move", uuid: a.uuid, context, parentUuid: b.uuid, siblingIndex: 0, keepWorldTransform: true });
    assert.strictEqual(a.parent, b); assert.strictEqual(a.keepWorld, true);
    await assert.rejects(evaluate({ action: "move", uuid: b.uuid, context, parentUuid: a.uuid, siblingIndex: 0, keepWorldTransform: true }), /子节点/);
    assert.strictEqual(b.parent, scene, "Cycle rejection must happen before mutation");
    await assert.rejects(evaluate({ action: "move", uuid: scene.uuid, context, parentUuid: b.uuid, siblingIndex: 0, keepWorldTransform: true }), /根节点/);
    await evaluate({ action: "pause", context }); assert.ok(paused);
    scene = new NodeFixture("Next scene");
    await assert.rejects(workbench({ action: "storage", context, operation: "set", key: "stale", expected: null, value: "x" }), /场景已变化/);
    assert.ok(!stored.has("stale"));
    await assert.rejects(evaluate({ action: "resume", context }), /场景已变化/);
    await assert.rejects(evaluate({ action: "edit", uuid: a.uuid, context, field: "active", value: false }), /场景已变化/);
    assert.strictEqual(a.active, true);
    const fresh = await evaluate({ action: "tree" });
    await assert.rejects(evaluate({ action: "remove", uuid: scene.uuid, context: fresh.context }), /根节点/);
    const disposable = new NodeFixture("Remove"); disposable.setParent(scene);
    await evaluate({ action: "remove", uuid: disposable.uuid, context: fresh.context }); assert.strictEqual(disposable.valid, false);
    await assert.rejects(evaluate({ action: "inspect", uuid: a.uuid, context: fresh.context }), /节点已移除/);

    const commands: RuntimeProbeCommand[] = [];
    const service = { dispatch: async (command: RuntimeProbeCommand) => { commands.push(command); return { ok: true }; }, dispose: async () => {} };
    const server = createRuntimeInspectorServer(service);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as any).port}`;
    try {
        const page = await (await fetch(origin)).text();
        const token = /name="inspector-token" content="([^"]+)"/.exec(page)![1];
        assert.ok(token && !token.includes("__INSPECTOR"));
        assert.ok((await (await fetch(origin + "/desktop")).text()).includes('body class="desktop-mode"'));
        const headers = { "Content-Type": "application/json", "X-Inspector-Token": token };
        const request = (body: unknown, extra = {}) => fetch(origin + "/api", { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) });
        assert.strictEqual((await request({ action: "tree" }, { "X-Inspector-Token": "wrong" })).status, 403);
        assert.strictEqual((await request({ action: "tree" }, { Origin: "https://example.com" })).status, 403);
        const spoofedHost = await new Promise<number>(resolve => {
            const request = http.request(origin + "/api", { method: "POST", headers: { ...headers, Host: "example.com" } }, response => {
                response.resume(); resolve(response.statusCode!);
            }); request.end(JSON.stringify({ action: "tree" }));
        });
        assert.strictEqual(spoofedHost, 403);
        assert.strictEqual(commands.length, 0, "Rejected requests must never reach the runtime");
        assert.strictEqual((await request({ action: "eval", expression: "1" })).status, 400);
        assert.strictEqual((await request({ action: "tree" })).status, 200);
        assert.strictEqual(commands[0].kind, "eval");
        assert.ok("expression" in commands[0] && commands[0].expression.includes('"action":"tree"'));
        assert.strictEqual((await request({ action: "status" })).status, 200);
        assert.strictEqual((await request({ action: "edit", uuid: "a", context: "b", field: "name", value: "界".repeat(30000) })).status, 413);
        assert.strictEqual((await fetch(origin + "/inspector.js")).status, 200);
        assert.strictEqual((await fetch(origin + "/inspector.css")).status, 200);
        assert.strictEqual((await fetch(origin + "/workbench.js")).status, 200);
        assert.strictEqual((await request({ action: "runtime-setting", context, name: "frameRate", value: 999 })).status, 400);
        assert.strictEqual((await request({ action: "runtime-info", context })).status, 200);
        assert.strictEqual((await request({ action: "diagnostics", options: { limit: 10 } })).status, 200);
        assert.strictEqual(commands.at(-1)!.kind, "diagnostics");
        assert.strictEqual((await fetch(origin + "/../../package.json")).status, 404);
        const response: any = await handleRuntimeProbeMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "runtime_open_inspector", arguments: {} } }, service.dispatch);
        assert.ok(!response.result.isError); assert.strictEqual(commands.at(-1)!.kind, "open-inspector");
    } finally {
        await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    }
    console.log("runtime inspector tests passed");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
