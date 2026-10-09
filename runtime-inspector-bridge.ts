import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { randomBytes } from "crypto";
import { createRuntimeProbeWorkspaceDefaults, parseRuntimeProbeArgs, RuntimeProbeCommand, RuntimeProbeServiceHandle } from "./runtime-probe";

export interface InspectorConnectionRecord {
    version: 1;
    workspaceIdentity: string;
    workspaceRoot: string;
    instanceId: string;
    origin: string;
    token: string;
    pid: number;
    startedAt: string;
}
export function inspectorConnectionPath(workspaceRoot = path.resolve(__dirname, "../..")): string {
    return path.join(os.tmpdir(), `cocos-live-probe-${createRuntimeProbeWorkspaceDefaults(workspaceRoot).identity}-desktop.json`);
}
export function readInspectorConnection(workspaceRoot: string, expectedInstanceId?: string): InspectorConnectionRecord {
    let record: InspectorConnectionRecord;
    try { record = JSON.parse(fs.readFileSync(inspectorConnectionPath(workspaceRoot), "utf8")); }
    catch { throw new Error("当前项目没有可接入的 Probe Inspector。请启动带有「AI 接入」按钮的桌面版；不会自动启动另一游戏实例。"); }
    let origin: URL;
    try { origin = new URL(record?.origin); }
    catch { throw new Error("Invalid desktop Inspector connection record"); }
    if (record.version !== 1 || typeof record.workspaceRoot !== "string" || path.resolve(record.workspaceRoot) !== path.resolve(workspaceRoot)
        || record.workspaceIdentity !== createRuntimeProbeWorkspaceDefaults(workspaceRoot).identity
        || origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || !origin.port || origin.pathname !== "/"
        || origin.search || origin.hash || origin.username || origin.password || origin.origin !== record.origin
        || typeof record.token !== "string" || !/^[a-f0-9]{64}$/.test(record.token)
        || typeof record.instanceId !== "string" || !record.instanceId || !Number.isInteger(record.pid)) {
        throw new Error("Invalid desktop Inspector connection record");
    }
    if (expectedInstanceId && record.instanceId !== expectedInstanceId) throw new Error("Inspector 实例已变化，请核对窗口并重新连接；旧现场不会自动替换。");
    return record;
}

export async function startInspectorBridge(service: RuntimeProbeServiceHandle, options: {
    workspaceRoot: string; instanceId: string; openWindow?: () => void; onCommand?: (kind: string) => void;
}): Promise<{ server: http.Server; connection: InspectorConnectionRecord }> {
    const token = randomBytes(32).toString("hex");
    const workspaceIdentity = createRuntimeProbeWorkspaceDefaults(options.workspaceRoot).identity;
    const server = http.createServer(async (request, response) => {
        const origin = `http://127.0.0.1:${request.socket.localPort}`;
        const send = (status: number, value: unknown) => {
            response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
            response.end(JSON.stringify(value));
        };
        if (request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin)
            || request.headers["x-inspector-token"] !== token || request.headers["x-inspector-instance"] !== options.instanceId) {
            send(403, { error: "Inspector instance and session token required" }); return;
        }
        try {
            if (request.method === "GET" && request.url === "/identity") {
                send(200, { instanceId: options.instanceId, workspaceIdentity }); return;
            }
            if (request.method !== "POST" || request.url !== "/command") { send(404, { error: "Not found" }); return; }
            if (request.headers["content-type"]?.split(";")[0] !== "application/json") { send(400, { error: "JSON required" }); return; }
            let size = 0; const chunks: Buffer[] = [];
            for await (const chunk of request) {
                size += Buffer.byteLength(chunk);
                if (size > 65536) { send(413, { error: "Request exceeds 64 KiB" }); return; }
                chunks.push(Buffer.from(chunk));
            }
            const payload: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).some(key => key !== "argv")) throw new Error("Expected argv only");
            const argv = (payload as { argv?: unknown }).argv;
            if (!Array.isArray(argv) || !argv.length || argv.some(argument => typeof argument !== "string")) throw new Error("Expected CLI argument strings");
            if (argv[0] === "inspector-connect" || argv[0] === "inspector-disconnect") throw new Error("Nested Inspector connection is not allowed");
            let result: unknown;
            if (argv[0] === "open-inspector" && argv.length === 1) {
                options.openWindow?.(); result = { mode: "desktop", instanceId: options.instanceId, message: "已显示当前 Probe Inspector 窗口" };
            } else {
                const command = parseRuntimeProbeArgs(argv); options.onCommand?.(command.kind);
                result = await service.dispatch(command);
            }
            send(200, { instanceId: options.instanceId, workspaceIdentity, result });
        } catch (error) { send(400, { error: error instanceof Error ? error.message : String(error) }); }
    });
    server.requestTimeout = 10000; server.headersTimeout = 10000;
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    const connection: InspectorConnectionRecord = { version: 1, workspaceRoot: path.resolve(options.workspaceRoot), workspaceIdentity,
        instanceId: options.instanceId, origin: `http://127.0.0.1:${(server.address() as import("net").AddressInfo).port}`,
        token, pid: process.pid, startedAt: new Date().toISOString() };
    const registry = inspectorConnectionPath(options.workspaceRoot);
    const temporary = `${registry}.${token}.tmp`;
    try {
        fs.writeFileSync(temporary, JSON.stringify(connection), { mode: 0o600 }); fs.renameSync(temporary, registry);
    } catch (error) {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
        await new Promise<void>(resolve => server.close(() => resolve())); throw error;
    }
    server.once("close", () => {
        try { if (JSON.parse(fs.readFileSync(registry, "utf8")).token === token) fs.unlinkSync(registry); }
        catch { /* A crash/replacement must not remove a newer registration. */ }
    });
    return { server, connection };
}

export class InspectorProbeClient implements RuntimeProbeServiceHandle {
    private constructor(public readonly connection: InspectorConnectionRecord) {}
    static async connect(workspaceRoot: string, expectedInstanceId?: string): Promise<InspectorProbeClient> {
        const client = new InspectorProbeClient(readInspectorConnection(workspaceRoot, expectedInstanceId));
        await client.request("/identity"); return client;
    }
    private async request(route: string, argv?: readonly string[]): Promise<any> {
        let response: Response;
        try {
            response = await fetch(this.connection.origin + route, { method: argv ? "POST" : "GET", signal: AbortSignal.timeout(argv ? 65000 : 5000),
                headers: { "X-Inspector-Token": this.connection.token, "X-Inspector-Instance": this.connection.instanceId, "Content-Type": "application/json" },
                ...(argv ? { body: JSON.stringify({ argv }) } : {}) });
        } catch { throw new Error("Probe Inspector 连接已断开或请求超时；不会刷新、重试操作或切换到另一游戏实例。请核对窗口后显式重新连接。"); }
        const value = await response.json() as any;
        if (!response.ok) throw new Error(value.error || `Inspector HTTP ${response.status}`);
        if (value.instanceId !== this.connection.instanceId || value.workspaceIdentity !== this.connection.workspaceIdentity) throw new Error("Inspector response identity mismatch");
        return value;
    }
    async dispatch(command: RuntimeProbeCommand): Promise<unknown> {
        const result = (await this.request("/command", commandArguments(command))).result;
        if (command.kind === "status" && result?.instance?.id !== this.connection.instanceId) throw new Error("Inspector runtime identity mismatch");
        return command.kind === "status" ? { ...result, connection: { mode: "inspector", instanceId: this.connection.instanceId,
            workspaceRoot: this.connection.workspaceRoot, startedAt: this.connection.startedAt, sharedWithHuman: true } } : result;
    }
    async dispose(): Promise<void> { /* Borrowing the user's window never owns its lifetime. */ }
}

function commandArguments(command: RuntimeProbeCommand): string[] {
    switch (command.kind) {
        case "status": case "launch": case "refresh": return [command.kind];
        case "open-inspector": return ["open-inspector"];
        case "scene-tree": return ["scene-tree", "--max-depth", String(command.maxDepth), ...(command.includeInactive ? ["--include-inactive"] : [])];
        case "find": case "node": case "animations": return [command.kind, command.selector];
        case "sample-animation": return [command.kind, command.selector, "--duration", String(command.durationSeconds), "--interval", String(command.intervalSeconds)];
        case "eval": return ["eval", ...(command.captureDiagnostics ? ["--diagnostics"] : []), command.expression];
        case "eval-file": return ["eval-file", ...(command.captureDiagnostics ? ["--diagnostics"] : []), path.resolve(command.path)];
        case "game-state": case "game-step": case "game-autoplay": return [command.kind, JSON.stringify(command.args)];
        case "render-ready": case "evidence": {
            const { kind, ...args } = command; return [kind, JSON.stringify(args)];
        }
        case "screenshot": case "input": case "wait": case "diagnostics": {
            const { kind, ...args } = command; return [kind, JSON.stringify(args)];
        }
        default: throw new Error("Inspector connect/disconnect cannot be forwarded");
    }
}
