import * as assert from "assert";
import { randomUUID } from "crypto";
import * as http from "http";
import { runInNewContext } from "vm";
import { buildInspectorExpression, InspectorRequest, parseInspectorRequest } from "../runtime-inspector-core";
import { createRuntimeInspectorServer } from "../runtime-inspector";
import { RuntimeProbeCommand } from "../runtime-probe";
import { handleRuntimeProbeMcpMessage } from "../runtime-probe-mcp";

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
    getComponent(type: any) { return this.components.find(component => component instanceof type); }
}
class ComponentFixture {
    static __props__ = ["speed", "label", "target", "_internal", "readonly"];
    uuid = randomUUID(); enabled = true; speed = 5; label = "你好"; target = { uuid: "reference" }; _internal = 1;
    get readonly() { return 4; }
}

async function main() {
    assert.throws(() => parseInspectorRequest({ action: "eval", expression: "1" }), /Unknown/);
    assert.throws(() => parseInspectorRequest({ action: "__proto__" }), /Unknown/);
    assert.throws(() => parseInspectorRequest({ action: "inspect", uuid: "a" }), /context/);
    assert.throws(() => parseInspectorRequest({ action: "move", uuid: "a", context: "b", parentUuid: "c", siblingIndex: -1, keepWorldTransform: true }), /hierarchy/);
    let scene = new NodeFixture("Scene"); const a = new NodeFixture("同名"); const b = new NodeFixture("同名");
    a.setParent(scene); b.setParent(scene); a.components.push(new ComponentFixture());
    let paused = false;
    const environment = { crypto: { randomUUID }, cc: {
        isValid: (value: any) => value?.valid !== false,
        director: { getScene: () => scene, isPaused: () => paused, pause: () => { paused = true; }, resume: () => { paused = false; } },
    } };
    const evaluate = (request: InspectorRequest): Promise<any> => runInNewContext(buildInspectorExpression(request), environment);
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
    await assert.rejects(evaluate({ action: "resume", context }), /场景已变化/);
    await assert.rejects(evaluate({ action: "edit", uuid: a.uuid, context, field: "active", value: false }), /场景已变化/);
    assert.strictEqual(a.active, true);
    const fresh = await evaluate({ action: "tree" });
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
        assert.strictEqual((await fetch(origin + "/../../package.json")).status, 404);
        const response: any = await handleRuntimeProbeMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "runtime_open_inspector", arguments: {} } }, service.dispatch);
        assert.ok(!response.result.isError); assert.strictEqual(commands.at(-1)!.kind, "open-inspector");
    } finally {
        await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    }
    console.log("runtime inspector tests passed");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
