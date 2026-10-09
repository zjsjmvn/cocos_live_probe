import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { gameEnvironment } from "./fixtures/game-environment";
import { parseRuntimeProbeArgs, runRuntimeProbeCli, runtimeProbeOptionsFromEnv, RuntimeProbeService } from "../runtime-probe";
import { handleRuntimeProbeMcpMessage, runRuntimeProbeMcpStdio, runRuntimeProbeMcpHttp } from "../runtime-probe-mcp";
import { Readable } from "stream";

async function main(): Promise<void> {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "probe-evidence-test-"));
    const root = path.join(directory, "evidence");
    const fixture = gameEnvironment("", "evidence-test", { workspaceRoot: directory, evidenceRoot: root } as any);
    const dispatch = (args: unknown) => fixture.service.dispatch(parseRuntimeProbeArgs(["evidence", JSON.stringify(args)])) as Promise<any>;
    try {
        await fixture.service.dispatch({ kind: "status" });
        assert.strictEqual(fs.existsSync(root), false, "recording is disabled by default");
        const started = await dispatch({ action: "start", label: "A bug" });
        const tools: any = await handleRuntimeProbeMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }, command => fixture.service.dispatch(command));
        assert.ok(tools.result.tools.some((tool: any) => tool.name === "runtime_evidence"));
        await assert.rejects(dispatch({ action: "start" }), /active/i);
        assert.strictEqual((await fixture.service.dispatch({ kind: "status" }) as any).evidence.activeRunId, started.runId);
        const shot = await fixture.service.dispatch({ kind: "screenshot" }) as any;
        const array = await fixture.service.dispatch({ kind: "eval", expression: "[1,2]" });
        assert.deepStrictEqual(Array.from(array as number[]), [1,2], "recording preserves arbitrary eval return shapes");
        const finished = await dispatch({ action: "finish", runId: started.runId });
        assert.strictEqual(finished.runState, "finished");
        fs.unlinkSync(shot.outputPath);
        const exported = await dispatch({ action: "export", runId: started.runId });
        const manifest = JSON.parse(fs.readFileSync(exported.manifestPath, "utf8"));
        assert.strictEqual(manifest.runId, started.runId);
        assert.strictEqual(manifest.commands.length, 3);
        assert.strictEqual(manifest.commands[1].kind, "screenshot");
        assert.strictEqual(manifest.commands[1].identity.targetId, "evidence-test");
        assert.strictEqual(manifest.bytes, fs.readdirSync(exported.directory).reduce((sum, file) => sum + fs.statSync(path.join(exported.directory, file)).size, 0));
        assert.ok(fs.existsSync(path.join(exported.directory, manifest.artifacts.find((item: any) => item.kind === "screenshot").file)), "archived image survives temporary pruning");
        await fixture.service.dispose();
        const reader = gameEnvironment("", "offline-reader", { workspaceRoot: directory, evidenceRoot: root } as any);
        try {
            const result = await reader.service.dispatch(parseRuntimeProbeArgs(["evidence", JSON.stringify({ action: "export", runId: started.runId })])) as any;
            assert.strictEqual(result.runState, "finished");
            assert.strictEqual(reader.globals.inputCount, 0);
        } finally { await reader.service.dispose(); }
        const automatic = gameEnvironment("", "automatic", { workspaceRoot: directory, evidenceRoot: root, evidence: true });
        try {
            const result: any = await automatic.service.dispatch({ kind: "screenshot" });
            assert.strictEqual(result.evidence.runState, "finished");
            assert.ok(fs.existsSync(result.evidence.manifestPath));
        } finally { await automatic.service.dispose(); }
        const capped = gameEnvironment("", "capped", { workspaceRoot: directory, evidenceRoot: path.join(directory, "capped"), evidenceLimits: { commands: 1 } });
        try {
            const run: any = await capped.service.dispatch(parseRuntimeProbeArgs(["evidence", '{"action":"start"}']));
            await capped.service.dispatch({ kind: "screenshot" }); await capped.service.dispatch({ kind: "status" });
            const result: any = await capped.service.dispatch(parseRuntimeProbeArgs(["evidence", JSON.stringify({ action: "finish", runId: run.runId })]));
            assert.strictEqual(result.evidenceStatus, "partial");
            assert.strictEqual(result.truncated, true);
        } finally { await capped.service.dispose(); }
        const retainedRoot = path.join(directory, "retained");
        const retained = gameEnvironment("", "retained", { workspaceRoot: directory, evidenceRoot: retainedRoot, evidenceLimits: { runs: 1 } });
        try {
            const first: any = await retained.service.dispatch(parseRuntimeProbeArgs(["evidence", '{"action":"start"}']));
            const end: any = await retained.service.dispatch(parseRuntimeProbeArgs(["evidence", JSON.stringify({ action: "finish", runId: first.runId })]));
            assert.ok(fs.existsSync(end.manifestPath), "finishing must preserve the package it returns");
            const second: any = await retained.service.dispatch(parseRuntimeProbeArgs(["evidence", '{"action":"start"}']));
            assert.notStrictEqual(first.runId, second.runId);
            await assert.rejects(retained.service.dispatch(parseRuntimeProbeArgs(["evidence", JSON.stringify({ action: "export", runId: first.runId })])), /unavailable/);
        } finally { await retained.service.dispose(); }
        const sharedRoot = path.join(directory, "shared");
        const one = gameEnvironment("", "one", { workspaceRoot: directory, evidenceRoot: sharedRoot, evidenceLimits: { runs: 1 } });
        const two = gameEnvironment("", "two", { workspaceRoot: directory, evidenceRoot: sharedRoot, evidenceLimits: { runs: 1 } });
        try {
            const run: any = await one.service.dispatch(parseRuntimeProbeArgs(["evidence", '{"action":"start"}']));
            const exported: any = await two.service.dispatch(parseRuntimeProbeArgs(["evidence", JSON.stringify({ action: "export", runId: run.runId })]));
            assert.strictEqual(exported.runState, "in-progress", "another live service is still recording");
            await assert.rejects(two.service.dispatch(parseRuntimeProbeArgs(["evidence", '{"action":"start"}'])), /capacity/);
            await one.service.dispatch({ kind: "screenshot" });
            await one.service.dispatch(parseRuntimeProbeArgs(["evidence", JSON.stringify({ action: "finish", runId: run.runId })]));
            const manual = path.join(exported.directory, "human-note.txt"); fs.writeFileSync(manual, "Keep this note");
            await assert.rejects(two.service.dispatch(parseRuntimeProbeArgs(["evidence", '{"action":"start"}'])), /capacity/);
            assert.strictEqual(fs.readFileSync(manual, "utf8"), "Keep this note");
            const manifest = JSON.parse(fs.readFileSync(exported.manifestPath, "utf8"));
            const archived = manifest.artifacts.find((item: any) => item.kind === "screenshot");
            fs.unlinkSync(path.join(exported.directory, archived.file));
            await assert.rejects(two.service.dispatch(parseRuntimeProbeArgs(["evidence", JSON.stringify({ action: "export", runId: run.runId })])), /damaged/);
        } finally { await one.service.dispose(); await two.service.dispose(); }
        const small = gameEnvironment("", "small", { workspaceRoot: directory, evidenceRoot: path.join(directory, "small"), evidence: true, evidenceLimits: { runBytes: 4096, totalBytes: 4096 } });
        try {
            const shot: any = await small.service.dispatch({ kind: "screenshot" });
            const input: any = await small.service.dispatch(parseRuntimeProbeArgs(["input", JSON.stringify({ action: "click", device: "mouse", point: { x: 20, y: 20 }, observation: shot.observation })]));
            assert.strictEqual(input.status, "sent", "archive capacity never rewrites the business input result");
            assert.strictEqual(small.globals.inputCount, 1, "archive failure never repeats an input");
            assert.ok(input.evidence || input.evidenceError);
        } finally { await small.service.dispose(); }
        const cli = gameEnvironment("", "cli", { workspaceRoot: directory, evidenceRoot: path.join(directory, "cli"), evidence: true });
        let output = "";
        await runRuntimeProbeCli(["screenshot"], () => cli.service, text => { output += text; });
        assert.strictEqual(JSON.parse(output).evidence.runState, "finished");
        const stdio = gameEnvironment("", "stdio", { workspaceRoot: directory, evidenceRoot: path.join(directory, "stdio") });
        const requests = [
            { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "runtime_evidence", arguments: { action: "start" } } },
            { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "runtime_render_ready", arguments: { timeoutMs: 100 } } },
        ];
        const lines: string[] = [];
        await runRuntimeProbeMcpStdio(stdio.service, Readable.from(requests.map(item => JSON.stringify(item) + "\n")), text => lines.push(text));
        const begun = JSON.parse(JSON.parse(lines[0]).result.content[0].text);
        assert.strictEqual(JSON.parse(fs.readFileSync(begun.manifestPath, "utf8")).finishReason, "service-closed");
        assert.strictEqual(JSON.parse(JSON.parse(lines[1]).result.content[0].text).status, "unsupported");
        const httpFixture = gameEnvironment("", "http", { workspaceRoot: directory, evidenceRoot: path.join(directory, "http") });
        const http = await runRuntimeProbeMcpHttp(httpFixture.service, 0);
        try {
            const url = `http://127.0.0.1:${(http.address() as { port: number }).port}/mcp`;
            const response: any = await (await fetch(url, { method: "POST", body: JSON.stringify(requests[0]), headers: { "Content-Type": "application/json" } })).json();
            const run = JSON.parse(response.result.content[0].text);
            assert.ok(fs.existsSync(run.manifestPath));
            const invalid: any = await (await fetch(url, { method: "POST", body: JSON.stringify({ ...requests[0], params: { name: "runtime_evidence", arguments: { action: "export", runId: "../escape" } } }) })).json();
            assert.strictEqual(invalid.error.code, -32602);
        } finally { await new Promise<void>(resolve => http.close(() => resolve())); await http.runtimeProbeCleanup; }
        assert.throws(() => runtimeProbeOptionsFromEnv({ COCOS_RUNTIME_PROBE_EVIDENCE: "bad" }), /on or off/);
        const override = new RuntimeProbeService({ evidence: false, evidenceRoot: root }); await override.dispose();
    } finally { await fixture.service.dispose(); fs.rmSync(directory, { recursive: true }); }
    console.log("Runtime evidence tests passed");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
