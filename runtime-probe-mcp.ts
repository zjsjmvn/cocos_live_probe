import * as http from "http";
import * as readline from "readline";
import {
    parseRuntimeProbeArgs,
    runtimeProbeOptionsFromEnv,
    RuntimeProbeCommand,
    RuntimeProbeService,
    RuntimeProbeServiceHandle,
} from "./runtime-probe";

type JsonRpcId = number | string | null;
type RuntimeProbeDispatch = (command: RuntimeProbeCommand) => Promise<unknown>;

const observationSchema = {
    type: "object", properties: {
        targetId: { type: "string", minLength: 1 }, instanceId: { type: "string", minLength: 1 },
        refreshGeneration: { type: "integer", minimum: 0 }, documentId: { type: "string", minLength: 1 },
        geometryKey: { type: "string", minLength: 1 },
    }, required: ["targetId", "instanceId", "refreshGeneration", "documentId", "geometryKey"], additionalProperties: false,
};
const pointSchema = { oneOf: [
    { type: "object", properties: { x: { type: "number", minimum: 0 }, y: { type: "number", minimum: 0 } }, required: ["x", "y"], additionalProperties: false },
    { type: "object", properties: { uuid: { type: "string", minLength: 1 }, cameraUuid: { type: "string", minLength: 1 }, canvasId: { type: "string", minLength: 1 } }, required: ["uuid"], additionalProperties: false },
] };

export const COCOS_LIVE_PROBE_MCP_NAME = "cocos-live-probe";

export interface RuntimeProbeMcpHttpServer extends http.Server {
    readonly runtimeProbeCleanup: Promise<void>;
}

interface RuntimeProbeMcpTool {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: Readonly<Record<string, unknown>>;
        readonly required?: readonly string[];
        readonly additionalProperties: false;
    };
}

interface JsonRpcRequest {
    readonly jsonrpc: "2.0";
    readonly id?: JsonRpcId;
    readonly method: string;
    readonly params?: unknown;
}

interface JsonRpcResponse {
    readonly jsonrpc: "2.0";
    readonly id: JsonRpcId;
    readonly result?: unknown;
    readonly error?: {
        readonly code: number;
        readonly message: string;
    };
}

export const RUNTIME_PROBE_MCP_TOOLS: readonly RuntimeProbeMcpTool[] = [
    {
        name: "runtime_input",
        description: "Send real mouse/touch click, long-press, drag or keyboard input to the owned page. Requires current screenshot credentials. Sent input does not prove gameplay success; partial input is never retried.",
        inputSchema: { type: "object", properties: {
            action: { type: "string", enum: ["click", "long-press", "drag", "key"] }, device: { type: "string", enum: ["mouse", "touch"] },
            observation: observationSchema, point: pointSchema, to: pointSchema,
            keys: { type: "array", minItems: 1, maxItems: 8, uniqueItems: true, items: { type: "string" } },
            durationMs: { type: "number", minimum: 0, maximum: 20_000 }, timeoutMs: { type: "number", minimum: 100, maximum: 30_000, default: 10_000 },
        }, required: ["action", "observation"], additionalProperties: false },
    },
    {
        name: "runtime_wait",
        description: "Wait for a node to appear/disappear or a primitive node/component property condition. Inactive nodes still exist. Same-session commands queued after this wait cannot satisfy it.",
        inputSchema: { type: "object", properties: {
            condition: { oneOf: [
                { type: "object", properties: { type: { enum: ["node-exists", "node-absent"] }, selector: { type: "string", minLength: 1 } }, required: ["type", "selector"], additionalProperties: false },
                { type: "object", properties: { type: { const: "property" }, selector: { type: "string", minLength: 1 }, component: { type: "string", minLength: 1 },
                    path: { type: "string", minLength: 1 }, operator: { enum: ["eq", "ne", "gt", "gte", "lt", "lte"] }, value: { type: ["string", "number", "boolean", "null"] } },
                    required: ["type", "selector", "path", "operator", "value"], additionalProperties: false },
            ] },
            timeoutMs: { type: "number", minimum: 1, maximum: 30_000, default: 5000 }, intervalMs: { type: "number", minimum: 10, maximum: 1000, default: 100 },
        }, required: ["condition"], additionalProperties: false },
    },
    {
        name: "runtime_diagnostics",
        description: "Read bounded console, exceptions, unhandled Promise rejections and failed network requests collected during this service connection. Returns collection start, gaps, truncation and incremental cursors; cannot recover earlier history.",
        inputSchema: { type: "object", properties: {
            after: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 1000, default: 100 },
            types: { type: "array", items: { enum: ["console", "exception", "promise-rejection", "network-failure", "http-error", "gap"] } },
            levels: { type: "array", items: { enum: ["log", "info", "warn", "error", "debug"] } },
        }, additionalProperties: false },
    },
    {
        name: "runtime_screenshot",
        description: "Capture the owned viewport as a PNG image and return document/geometry credentials for input.",
        inputSchema: { type: "object", properties: { outputPath: { type: "string", minLength: 1 } }, additionalProperties: false },
    },
    {
        name: "runtime_status",
        description: "Report preview/CDP availability and this service's cached target state without launching Chrome.",
        inputSchema: emptySchema(),
    },
    {
        name: "runtime_launch",
        description: "Launch or attach the localhost-only dedicated Chrome for the active Cocos preview.",
        inputSchema: emptySchema(),
    },
    {
        name: "runtime_refresh",
        description: "Refresh only this probe session's owned Cocos preview and wait until it is ready.",
        inputSchema: emptySchema(),
    },
    {
        name: "runtime_scene_tree",
        description: "Read a bounded JSON snapshot of the running Cocos scene hierarchy.",
        inputSchema: {
            type: "object",
            properties: {
                maxDepth: { type: "integer", minimum: 0, maximum: 12, default: 4 },
                includeInactive: { type: "boolean", default: false },
            },
            additionalProperties: false,
        },
    },
    {
        name: "runtime_find_nodes",
        description: "Find running Cocos nodes by name fragment, UUID, or absolute scene path.",
        inputSchema: selectorSchema(),
    },
    {
        name: "runtime_node_snapshot",
        description: "Read transforms, components, renderer model type, and bounds for one running Cocos node.",
        inputSchema: selectorSchema(),
    },
    {
        name: "runtime_animation_snapshot",
        description: "Read standard or skeletal animation clips and states, plus skeletal evaluation diagnostics and skinning bounds.",
        inputSchema: selectorSchema(),
    },
    {
        name: "runtime_sample_animation",
        description: "Continuously sample a running standard or skeletal animation and root/bounds state for a bounded duration.",
        inputSchema: {
            type: "object",
            properties: {
                selector: { type: "string", minLength: 1 },
                durationSeconds: { type: "number", exclusiveMinimum: 0, maximum: 30, default: 1 },
                intervalSeconds: { type: "number", minimum: 0.01, default: 0.1 },
            },
            required: ["selector"],
            additionalProperties: false,
        },
    },
];

export async function handleRuntimeProbeMcpMessage(
    message: unknown,
    dispatch: RuntimeProbeDispatch,
): Promise<JsonRpcResponse | undefined> {
    if (!isJsonRpcRequest(message)) {
        return jsonRpcError(null, -32600, "Invalid JSON-RPC 2.0 request");
    }

    if (message.id === undefined) {
        return undefined;
    }

    switch (message.method) {
        case "initialize":
            return jsonRpcResult(message.id, {
                protocolVersion: "2024-11-05",
                capabilities: { tools: {} },
                serverInfo: {
                    name: COCOS_LIVE_PROBE_MCP_NAME,
                    version: "1.0.0",
                },
            });
        case "ping":
            return jsonRpcResult(message.id, {});
        case "tools/list":
            return jsonRpcResult(message.id, { tools: RUNTIME_PROBE_MCP_TOOLS });
        case "tools/call":
            return handleToolCall(message.id, message.params, dispatch);
        default:
            return jsonRpcError(message.id, -32601, `Unknown MCP method: ${message.method}`);
    }
}

export async function processRuntimeProbeMcpLine(
    line: string,
    dispatch: RuntimeProbeDispatch,
): Promise<string | undefined> {
    if (!line.trim()) return undefined;
    let message: unknown;
    try {
        message = JSON.parse(line);
    } catch (error) {
        return JSON.stringify(jsonRpcError(
            null,
            -32700,
            `JSON parse error: ${asError(error).message}`,
        ));
    }
    const response = await handleRuntimeProbeMcpMessage(message, dispatch);
    return response === undefined ? undefined : JSON.stringify(response);
}

export async function runRuntimeProbeMcpStdio(
    service: RuntimeProbeServiceHandle = new RuntimeProbeService(runtimeProbeOptionsFromEnv()),
    inputStream: NodeJS.ReadableStream = process.stdin,
    writeOutput: (text: string) => void = text => {
        process.stdout.write(text);
    },
): Promise<void> {
    const input = readline.createInterface({
        input: inputStream,
        crlfDelay: Infinity,
    });
    try {
        for await (const line of input) {
            const response = await processRuntimeProbeMcpLine(
                line,
                command => service.dispatch(command),
            );
            if (response !== undefined) writeOutput(`${response}\n`);
        }
    } finally {
        await service.dispose();
    }
}

export function createRuntimeProbeMcpHttpServer(
    service: RuntimeProbeServiceHandle = new RuntimeProbeService(runtimeProbeOptionsFromEnv()),
): http.Server {
    return http.createServer(async (request, response) => {
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        try {
            const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
            if (request.method === "GET" && requestUrl.pathname === "/health") {
                sendJson(response, 200, {
                    status: "ok",
                    name: COCOS_LIVE_PROBE_MCP_NAME,
                    tools: RUNTIME_PROBE_MCP_TOOLS.length,
                });
                return;
            }
            if (request.method === "POST" && requestUrl.pathname === "/mcp") {
                const body = await readBody(request);
                let message: unknown;
                try {
                    message = JSON.parse(body);
                } catch (error) {
                    sendJson(response, 400, jsonRpcError(
                        null,
                        -32700,
                        `JSON parse error: ${asError(error).message}`,
                    ));
                    return;
                }
                const result = await handleRuntimeProbeMcpMessage(
                    message,
                    command => service.dispatch(command),
                );
                if (result === undefined) {
                    response.statusCode = 202;
                    response.end();
                    return;
                }
                sendJson(response, 200, result);
                return;
            }
            sendJson(response, 404, { error: "Not found" });
        } catch (error) {
            sendJson(response, 500, { error: asError(error).message });
        }
    });
}

export async function runRuntimeProbeMcpHttp(
    service: RuntimeProbeServiceHandle = new RuntimeProbeService(),
    port = 3001,
): Promise<RuntimeProbeMcpHttpServer> {
    const server = createRuntimeProbeMcpHttpServer(service);
    let resolveCleanup!: () => void;
    let rejectCleanup!: (error: unknown) => void;
    const cleanup = new Promise<void>((resolve, reject) => {
        resolveCleanup = resolve;
        rejectCleanup = reject;
    });
    void cleanup.catch(() => undefined);
    Object.defineProperty(server, "runtimeProbeCleanup", {
        configurable: false,
        enumerable: false,
        value: cleanup,
        writable: false,
    });
    let cleanupStarted = false;
    const startCleanup = (): void => {
        if (cleanupStarted) return;
        cleanupStarted = true;
        Promise.resolve()
            .then(() => service.dispose())
            .then(resolveCleanup, rejectCleanup);
    };
    server.once("close", startCleanup);
    try {
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(port, "127.0.0.1", () => {
                server.off("error", reject);
                resolve();
            });
        });
    } catch (listenError) {
        startCleanup();
        try {
            await cleanup;
        } catch {
            // The original listen error is the startup failure callers must receive.
        }
        throw listenError;
    }
    return server as RuntimeProbeMcpHttpServer;
}

async function handleToolCall(
    id: JsonRpcId,
    params: unknown,
    dispatch: RuntimeProbeDispatch,
): Promise<JsonRpcResponse> {
    let command: RuntimeProbeCommand;
    try {
        command = commandForToolCall(params);
    } catch (error) {
        return jsonRpcError(id, -32602, asError(error).message);
    }

    try {
        const value = await dispatch(command);
        if (value && typeof value === "object" && "image" in value) {
            const { image, ...metadata } = value as { image: { data: string; mimeType: string } };
            return jsonRpcResult(id, { content: [
                { type: "image", ...image },
                { type: "text", text: JSON.stringify(metadata, null, 2) },
            ] });
        }
        return jsonRpcResult(id, {
            content: [{ type: "text", text: JSON.stringify(value ?? null, null, 2) }],
            ...(value && typeof value === "object" && "status" in value
                && (value.status === "failed" || value.status === "timeout") ? { isError: true } : {}),
        });
    } catch (error) {
        return jsonRpcResult(id, {
            content: [{ type: "text", text: JSON.stringify({ error: asError(error).message }) }],
            isError: true,
        });
    }
}

function commandForToolCall(params: unknown): RuntimeProbeCommand {
    const record = requireRecord(params, "tools/call params");
    const name = requireString(record.name, "tools/call name");
    const args = record.arguments === undefined
        ? {}
        : requireRecord(record.arguments, `${name} arguments`);
    switch (name) {
        case "runtime_screenshot":
            return parseRuntimeProbeArgs(["screenshot", JSON.stringify(args)]);
        case "runtime_input":
        case "runtime_wait":
        case "runtime_diagnostics":
            return parseRuntimeProbeArgs([name.slice("runtime_".length), JSON.stringify(args)]);
        case "runtime_status":
            requireEmptyArguments(name, args);
            return { kind: "status" };
        case "runtime_launch":
            requireEmptyArguments(name, args);
            return { kind: "launch" };
        case "runtime_refresh":
            requireEmptyArguments(name, args);
            return { kind: "refresh" };
        case "runtime_scene_tree":
            return parseRuntimeProbeArgs([
                "scene-tree",
                ...(args.includeInactive === true ? ["--include-inactive"] : []),
                ...(args.maxDepth === undefined ? [] : ["--max-depth", String(args.maxDepth)]),
            ]);
        case "runtime_find_nodes":
            return parseRuntimeProbeArgs(["find", requireSelector(args)]);
        case "runtime_node_snapshot":
            return parseRuntimeProbeArgs(["node", requireSelector(args)]);
        case "runtime_animation_snapshot":
            return parseRuntimeProbeArgs(["animations", requireSelector(args)]);
        case "runtime_sample_animation":
            return parseRuntimeProbeArgs([
                "sample-animation",
                requireSelector(args),
                ...(args.durationSeconds === undefined
                    ? []
                    : ["--duration", String(args.durationSeconds)]),
                ...(args.intervalSeconds === undefined
                    ? []
                    : ["--interval", String(args.intervalSeconds)]),
            ]);
        default:
            throw new Error(`Unknown runtime probe tool: ${name}`);
    }
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
    if (!isRecord(value)) return false;
    if (value.jsonrpc !== "2.0" || typeof value.method !== "string") return false;
    return value.id === undefined
        || value.id === null
        || typeof value.id === "string"
        || typeof value.id === "number";
}

function jsonRpcResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
    return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
    return { jsonrpc: "2.0", id, error: { code, message } };
}

function emptySchema(): RuntimeProbeMcpTool["inputSchema"] {
    return { type: "object", properties: {}, additionalProperties: false };
}

function selectorSchema(): RuntimeProbeMcpTool["inputSchema"] {
    return {
        type: "object",
        properties: { selector: { type: "string", minLength: 1 } },
        required: ["selector"],
        additionalProperties: false,
    };
}

function requireSelector(args: Readonly<Record<string, unknown>>): string {
    return requireString(args.selector, "selector");
}

function requireEmptyArguments(name: string, args: Readonly<Record<string, unknown>>): void {
    if (Object.keys(args).length > 0) throw new Error(`${name} does not accept arguments`);
}

function requireRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
    if (!isRecord(value)) throw new Error(`${label} must be an object`);
    return value;
}

function requireString(value: unknown, label: string): string {
    if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
    return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBody(request: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let length = 0;
        request.on("data", chunk => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            length += buffer.length;
            if (length > 1_048_576) {
                reject(new Error("MCP request body exceeds 1 MiB"));
                request.destroy();
                return;
            }
            chunks.push(buffer);
        });
        request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        request.on("error", reject);
    });
}

function sendJson(response: http.ServerResponse, statusCode: number, value: unknown): void {
    response.statusCode = statusCode;
    response.end(JSON.stringify(value));
}

function asError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}

export async function runRuntimeProbeMcpCli(argv: readonly string[]): Promise<void> {
    const mode = argv[0] ?? "--stdio";
    if (mode === "--stdio") {
        await runRuntimeProbeMcpStdio();
        return;
    }
    if (mode === "--http") {
        const server = await runRuntimeProbeMcpHttp();
        process.stderr.write(`${COCOS_LIVE_PROBE_MCP_NAME} MCP listening on http://127.0.0.1:3001/mcp\n`);
        await waitForHttpShutdown(server);
        return;
    }
    throw new Error(`Unknown runtime probe MCP mode: ${mode}`);
}

function waitForHttpShutdown(server: RuntimeProbeMcpHttpServer): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        let closeRequested = false;
        const removeSignalListeners = (): void => {
            process.off("SIGINT", close);
            process.off("SIGTERM", close);
        };
        const settleCleanup = (): void => {
            removeSignalListeners();
            server.runtimeProbeCleanup.then(resolve, reject);
        };
        const close = (): void => {
            if (closeRequested) return;
            closeRequested = true;
            server.close(error => {
                if (!error) return;
                removeSignalListeners();
                reject(error);
            });
        };
        server.once("close", settleCleanup);
        process.once("SIGINT", close);
        process.once("SIGTERM", close);
    });
}

if (require.main === module) {
    runRuntimeProbeMcpCli(process.argv.slice(2)).catch(error => {
        process.stderr.write(`${asError(error).message}\n`);
        process.exitCode = 1;
    });
}
