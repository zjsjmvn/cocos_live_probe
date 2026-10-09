import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as http from "http";
import { randomUUID } from "crypto";
import { inspectorConnectionPath, InspectorProbeClient, readInspectorConnection, startInspectorBridge } from "../runtime-inspector-bridge";
import { RuntimeProbeCommand, RuntimeProbeService, runtimeProbeOptionsFromEnv } from "../runtime-probe";
import { handleRuntimeProbeMcpMessage } from "../runtime-probe-mcp";

async function close(server: http.Server) { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); }
async function main() {
    const root = path.join(os.tmpdir(), "inspector-bridge-test-" + randomUUID());
    const commands: RuntimeProbeCommand[] = [];
    let activeInstance = "human-instance";
    const service = { dispatch: async (command: RuntimeProbeCommand) => {
        commands.push(command);
        return command.kind === "status" ? { instance: { id: activeInstance, target: { id: "human-target" } } } : { source: "human-target", command };
    }, dispose: async () => { throw new Error("Borrowed client must never dispose the desktop service"); } };
    const first = await startInspectorBridge(service, { workspaceRoot: root, instanceId: "human-instance" });
    let second: Awaited<ReturnType<typeof startInspectorBridge>> | undefined;
    let localCalls = 0;
    const ai = new RuntimeProbeService({ workspaceRoot: root, dependencies: {
        checkPreview: async () => { localCalls++; return false; },
        spawnChrome: () => { throw new Error("Cannot launch Chrome when attached"); },
    } });
    try {
        const client = await InspectorProbeClient.connect(root, "human-instance");
        assert.strictEqual(commands.length, 0, "Connection identity handshake does not touch the game");
        await assert.rejects(InspectorProbeClient.connect(root, "another-instance"), /实例已变化/);
        const status: any = await ai.dispatch({ kind: "inspector-connect", instanceId: "human-instance" });
        assert.strictEqual(status.instance.target.id, "human-target"); assert.strictEqual(status.connection.mode, "inspector");
        assert.deepStrictEqual(commands.map(command => command.kind), ["status"], "MCP connection only reads status; never launches/refreshes");
        const inspected: any = await ai.dispatch({ kind: "node", selector: "uuid" });
        assert.strictEqual(inspected.source, "human-target"); assert.strictEqual(localCalls, 0);
        await client.dispatch({ kind: "scene-tree", maxDepth: 6, includeInactive: true });
        assert.deepStrictEqual(commands.at(-1), { kind: "scene-tree", maxDepth: 6, includeInactive: true });
        await client.dispatch({ kind: "eval", expression: '({text:"中文",quote:"x\\n"})', captureDiagnostics: true });
        assert.strictEqual(commands.at(-1)!.kind, "eval");
        const beforeRejected = commands.length;
        const response = await fetch(first.connection.origin + "/command", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ argv: ["refresh"] }) });
        assert.strictEqual(response.status, 403);
        const headers = { "Content-Type": "application/json", "X-Inspector-Token": first.connection.token, "X-Inspector-Instance": first.connection.instanceId };
        const crossOrigin = await fetch(first.connection.origin + "/command", { method: "POST", headers: { ...headers, Origin: "https://example.com" }, body: '{"argv":["refresh"]}' });
        assert.strictEqual(crossOrigin.status, 403);
        const nested = await fetch(first.connection.origin + "/command", { method: "POST", headers, body: '{"argv":["inspector-connect"]}' });
        assert.strictEqual(nested.status, 400); assert.strictEqual(commands.length, beforeRejected);
        const unknownArgs: any = await handleRuntimeProbeMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/call",
            params: { name: "runtime_inspector_connect", arguments: { surprise: true } } }, command => ai.dispatch(command));
        assert.strictEqual(unknownArgs.error.code, -32602);
        await close(first.server);
        assert.ok(!fs.existsSync(inspectorConnectionPath(root)), "Closing the window removes its own registration");
        await assert.rejects(ai.dispatch({ kind: "node", selector: "uuid" }), /连接已断开/);
        assert.strictEqual(localCalls, 0, "Lost desktop never silently falls back to a new Chrome page");
        activeInstance = "replacement-instance";
        second = await startInspectorBridge(service, { workspaceRoot: root, instanceId: "replacement-instance" });
        await assert.rejects(ai.dispatch({ kind: "status" }), /连接已断开/);
        await assert.rejects(InspectorProbeClient.connect(root, "human-instance"), /实例已变化/);
        await ai.dispatch({ kind: "inspector-connect", instanceId: "replacement-instance" });
        activeInstance = "incorrect-instance";
        await assert.rejects(ai.dispatch({ kind: "status" }), /runtime identity mismatch/);
        activeInstance = "replacement-instance";
        await ai.dispose();
        assert.ok(second.server.listening, "AI session disposal leaves the user's Inspector alive");
        const record = readInspectorConnection(root);
        fs.writeFileSync(inspectorConnectionPath(root), JSON.stringify({ ...record, origin: "http://example.com:3000" }));
        assert.throws(() => readInspectorConnection(root), /Invalid desktop/);
        fs.writeFileSync(inspectorConnectionPath(root), JSON.stringify({ ...record, origin: "invalid" }));
        assert.throws(() => readInspectorConnection(root), /Invalid desktop/);
        fs.writeFileSync(inspectorConnectionPath(root), JSON.stringify(record));
        assert.deepStrictEqual(runtimeProbeOptionsFromEnv({ COCOS_RUNTIME_PROBE_WORKSPACE_ROOT: root }), { workspaceRoot: path.resolve(root) });
    } finally { await ai.dispose(); if (first.server.listening) await close(first.server); if (second?.server.listening) await close(second.server); }
    console.log("runtime Inspector AI bridge tests passed");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
