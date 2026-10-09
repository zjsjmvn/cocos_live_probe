import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { RuntimeProbeService, parseRuntimeProbeArgs } from "../runtime-probe";
import { gameEnvironment } from "./fixtures/game-environment";
import { handleRuntimeProbeMcpMessage } from "../runtime-probe-mcp";
import { createRuntimeProbeMcpHttpServer, runRuntimeProbeMcpStdio } from "../runtime-probe-mcp";
import { Readable } from "stream";

async function main(): Promise<void> {
    const service = new RuntimeProbeService();
    try {
        await assert.rejects(service.dispatch(parseRuntimeProbeArgs(["game-state"])), /game extension is not configured/i);
    } finally { await service.dispose(); }
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "game-extension-test-"));
    const entry = path.join(directory, "extension.cjs");
    fs.writeFileSync(entry, `module.exports = {
        id: 'fixture', apiVersion: 1, gameId: 'fixture', stateVersion: 1, bridgeName: '__gameProbe',
        goalSchema: { type: 'object', properties: { count: { type: 'integer', minimum: 0 } }, required: ['count'], additionalProperties: false },
        readState: state => state,
        decide: (state, goal) => state.count >= goal.count ? { kind: 'done', reason: 'Count reached' }
            : { kind: 'input', reason: 'Increase count', input: { action: 'click', device: 'mouse', point: { x: 100, y: 100 } } },
        verify: (before, after) => ({ status: after.count > before.count ? 'satisfied' : 'pending', progress: after.count > before.count }),
    };`);
    const fixture = gameEnvironment(entry);
    try {
        const state = await fixture.service.dispatch(parseRuntimeProbeArgs(["game-state"])) as any;
        assert.strictEqual(state.pluginId, "fixture");
        assert.strictEqual(state.targetId, "game-test");
        assert.strictEqual(state.state.count, 0);
        assert.ok(state.documentId);
        assert.strictEqual(fixture.globals.inputCount, 0, "state reading is read-only");
        const tools = await handleRuntimeProbeMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" },
            command => fixture.service.dispatch(command), fixture.service) as any;
        assert.ok(tools.result.tools.some((tool: any) => tool.name === "game_autoplay"));
        const stateTool = await handleRuntimeProbeMcpMessage({ jsonrpc: "2.0", id: 2, method: "tools/call",
            params: { name: "game_state", arguments: {} } }, command => fixture.service.dispatch(command), fixture.service) as any;
        assert.strictEqual(JSON.parse(stateTool.result.content[0].text).state.count, 0);
        const server = createRuntimeProbeMcpHttpServer(fixture.service);
        await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
        try {
            const address = server.address() as { port: number };
            const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, { method: "POST",
                headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
            const httpTools = await response.json() as any;
            assert.strictEqual(httpTools.result.tools.filter((tool: any) => tool.name.startsWith("game_")).length, 3);
        } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
        const stepped = await fixture.service.dispatch(parseRuntimeProbeArgs(["game-step", JSON.stringify({ goal: { count: 1 } })])) as any;
        assert.strictEqual(stepped.before.state.count, 0);
        assert.strictEqual(stepped.after.state.count, 1);
        assert.strictEqual(stepped.decision.reason, "Increase count");
        assert.strictEqual(stepped.verification.status, "satisfied");
        const complete = await fixture.service.dispatch(parseRuntimeProbeArgs(["game-step", JSON.stringify({ goal: { count: 1 } })])) as any;
        assert.strictEqual(complete.reason, "goal-reached");
        assert.strictEqual(fixture.globals.inputCount, 1, "an already met goal sends no input");
        await assert.rejects(fixture.service.dispatch(parseRuntimeProbeArgs(["game-step", JSON.stringify({ goal: { count: 2, script: "bad" } })])), /goal/i);
        assert.strictEqual(fixture.globals.inputCount, 1, "invalid goals send no input");
        const limited = await fixture.service.dispatch(parseRuntimeProbeArgs(["game-autoplay", JSON.stringify({ goal: { count: 5 }, maxSteps: 2 })])) as any;
        assert.strictEqual(limited.reason, "step-limit");
        assert.strictEqual(limited.steps, 2);
        assert.strictEqual(limited.after.state.count, 3);
        assert.strictEqual(limited.goalReached, false);
        const completed = await fixture.service.dispatch(parseRuntimeProbeArgs(["game-autoplay", JSON.stringify({ goal: { count: 5 }, maxSteps: 10 })])) as any;
        assert.strictEqual(completed.reason, "goal-reached");
        assert.strictEqual(completed.steps, 2);
        assert.strictEqual(fixture.globals.count, 5);
        fixture.globals.blocked = true;
        const hidden = await fixture.service.dispatch(parseRuntimeProbeArgs(["game-step", JSON.stringify({ goal: { count: 6 }, timeoutMs: 250 })])) as any;
        assert.strictEqual(hidden.reason, "result-unknown", "sent input is not business success");
        assert.strictEqual(hidden.steps, 1);
        assert.strictEqual(fixture.globals.count, 5);
        fixture.globals.blocked = false;
        fixture.globals.failInput = true;
        const failed = await fixture.service.dispatch(parseRuntimeProbeArgs(["game-autoplay", JSON.stringify({ goal: { count: 10 } })])) as any;
        assert.strictEqual(failed.reason, "input-failed");
        assert.strictEqual(failed.steps, 1);
        assert.strictEqual(failed.input.cleanupConfirmed, true);
        assert.strictEqual(fixture.globals.pressed, false);
        const bridgeEntry = path.join(directory, "changed.cjs");
        fs.writeFileSync(bridgeEntry, `module.exports = { ...require('./extension.cjs'),
            decide: async (state, goal) => { await new Promise(resolve => setTimeout(resolve, 30));
                return { kind: 'input', reason: 'Pending decision', input: { action: 'click', device: 'mouse', point: { x: 100, y: 100 } } }; } };`);
        const changing = gameEnvironment(bridgeEntry);
        try {
            setTimeout(() => { changing.globals.bridgeInstance = "replacement"; }, 15);
            const changed = await changing.service.dispatch(parseRuntimeProbeArgs(["game-step", JSON.stringify({ goal: { count: 1 } })])) as any;
            assert.strictEqual(changed.reason, "page-changed");
            assert.strictEqual(changing.globals.inputCount, 0, "bridge replacement stops input");
        } finally { await changing.service.dispose(); }
        const other = gameEnvironment(entry, "other-game");
        try {
            const otherState = await other.service.dispatch(parseRuntimeProbeArgs(["game-state"])) as any;
            assert.strictEqual(otherState.state.count, 0, "another service has independent gameplay");
            assert.strictEqual(otherState.targetId, "other-game");
        } finally { await other.service.dispose(); }
        const waitEntry = path.join(directory, "waiting.cjs");
        fs.writeFileSync(waitEntry, `module.exports = { ...require('./extension.cjs'),
            decide: () => ({ kind: 'wait', reason: 'Waiting for gameplay', durationMs: 20 }),
            verify: () => ({ status: 'satisfied', progress: false }) };`);
        const waiting = gameEnvironment(waitEntry);
        try {
            const stalled = await waiting.service.dispatch(parseRuntimeProbeArgs(["game-autoplay", JSON.stringify({
                goal: { count: 1 }, timeoutMs: 400, noProgressTimeoutMs: 60,
            })])) as any;
            assert.strictEqual(stalled.reason, "no-progress");
            assert.ok(stalled.steps >= 2);
            assert.strictEqual(waiting.globals.inputCount, 0);
        } finally { await waiting.service.dispose(); }
        const slowEntry = path.join(directory, "slow.cjs");
        fs.writeFileSync(slowEntry, `module.exports = { ...require('./extension.cjs'),
            decide: async () => { await new Promise(resolve => setTimeout(resolve, 100));
                return { kind: 'input', reason: 'Late decision', input: { action: 'click', device: 'mouse', point: { x: 100, y: 100 } } }; } };`);
        const slow = gameEnvironment(slowEntry);
        try {
            const timed = await slow.service.dispatch(parseRuntimeProbeArgs(["game-autoplay", JSON.stringify({ goal: { count: 1 }, timeoutMs: 40 })])) as any;
            assert.strictEqual(timed.reason, "time-limit");
            await new Promise(resolve => setTimeout(resolve, 130));
            assert.strictEqual(slow.globals.inputCount, 0, "late plugin completion cannot send input");
            const recovered = await slow.service.dispatch(parseRuntimeProbeArgs(["game-state"])) as any;
            assert.strictEqual(recovered.state.count, 0, "timeout leaves the queue usable");
        } finally { await slow.service.dispose(); }
        const queued = gameEnvironment(slowEntry);
        try {
            const first = queued.service.dispatch(parseRuntimeProbeArgs(["game-step", JSON.stringify({ goal: { count: 1 }, timeoutMs: 500 })]));
            const second = queued.service.dispatch(parseRuntimeProbeArgs(["game-step", JSON.stringify({ goal: { count: 2 }, timeoutMs: 30 })]));
            await first;
            await assert.rejects(second, /timeout/i);
            assert.strictEqual(queued.globals.inputCount, 1, "expired queued command does not send input");
        } finally { await queued.service.dispose(); }
        const stdio = gameEnvironment(entry);
        let output = "";
        await runRuntimeProbeMcpStdio(stdio.service, Readable.from([JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n"]), text => { output += text; });
        assert.ok(JSON.parse(output).result.tools.some((tool: any) => tool.name === "game_step"));
        assert.throws(() => new RuntimeProbeService({ gameExtension: path.join(directory, "missing.cjs") }), /extension load failed/i);
    } finally { await fixture.service.dispose(); fs.rmSync(directory, { recursive: true }); }
    console.log("Runtime game extension tests passed");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
