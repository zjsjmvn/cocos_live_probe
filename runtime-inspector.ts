import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { randomBytes } from "crypto";
import { buildInspectorExpression, parseInspectorRequest } from "./runtime-inspector-core";
import { RuntimeProbeService, RuntimeProbeServiceHandle, runtimeProbeOptionsFromEnv, parseRuntimeProbeArgs } from "./runtime-probe";

export function createRuntimeInspectorServer(service: RuntimeProbeServiceHandle): http.Server {
    const token = randomBytes(32).toString("hex");
    const page = fs.readFileSync(path.join(__dirname, "inspector/index.html"), "utf8").replace("__INSPECTOR_TOKEN__", token);
    const desktopPage = page.replace("<body>", '<body class="desktop-mode">');
    return http.createServer(async (request, response) => {
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("X-Frame-Options", "DENY");
        response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
        const address = request.socket.localPort;
        const origin = `http://127.0.0.1:${address}`;
        const json = (status: number, value: unknown) => {
            response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
            response.end(JSON.stringify(value));
        };
        if (request.headers.host !== `127.0.0.1:${address}` || (request.headers.origin && request.headers.origin !== origin)) {
            json(403, { error: "Only the local inspector origin is allowed" }); return;
        }
        if (request.method === "GET") {
            const assets: Record<string, [string, string]> = {
                "/": ["text/html; charset=utf-8", page],
                "/desktop": ["text/html; charset=utf-8", desktopPage],
                "/inspector.js": ["text/javascript; charset=utf-8", fs.readFileSync(path.join(__dirname, "inspector/inspector.js"), "utf8")],
                "/inspector.css": ["text/css; charset=utf-8", fs.readFileSync(path.join(__dirname, "inspector/inspector.css"), "utf8")],
            };
            const asset = Object.prototype.hasOwnProperty.call(assets, request.url ?? "") ? assets[request.url!] : undefined;
            if (!asset) { json(404, { error: "Not found" }); return; }
            response.writeHead(200, { "Content-Type": asset[0] }); response.end(asset[1]); return;
        }
        if (request.method !== "POST" || request.url !== "/api") { json(404, { error: "Not found" }); return; }
        if (request.headers["x-inspector-token"] !== token || request.headers["content-type"]?.split(";")[0] !== "application/json") {
            json(403, { error: "Inspector session token and JSON content type required" }); return;
        }
        try {
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const chunk of request) {
                size += Buffer.byteLength(chunk);
                if (size > 65536) { json(413, { error: "Request exceeds 64 KiB" }); return; }
                chunks.push(Buffer.from(chunk));
            }
            const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            let result: unknown;
            if (payload.action === "status" && Object.keys(payload).length === 1) {
                result = await service.dispatch({ kind: "status" });
            } else if (payload.action === "evidence" && Object.keys(payload).every(key => ["action", "request"].includes(key))) {
                result = await service.dispatch(parseRuntimeProbeArgs(["evidence", JSON.stringify(payload.request)]));
            } else if (payload.action === "screenshot" && Object.keys(payload).length === 1) {
                const shot = await service.dispatch({ kind: "screenshot" }) as { outputPath: string };
                result = { ...shot, image: `data:image/png;base64,${fs.readFileSync(shot.outputPath).toString("base64")}` };
            } else {
                const inspectorRequest = parseInspectorRequest(payload);
                result = await service.dispatch({ kind: "eval", expression: buildInspectorExpression(inspectorRequest) });
            }
            json(200, result);
        } catch (error) {
            json(400, { error: error instanceof Error ? error.message : String(error) });
        }
    });
}

export async function runRuntimeInspector(port = 3002): Promise<http.Server> {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Inspector port must be 1..65535");
    // Share the existing human CLI page; never select another stdio session by origin.
    const service = new RuntimeProbeService({ ...runtimeProbeOptionsFromEnv(), ownership: "shared", instanceId: "manual-cli" });
    const server = createRuntimeInspectorServer(service);
    server.requestTimeout = 35000;
    server.headersTimeout = 10000;
    server.on("close", () => { void service.dispose().catch(error => process.stderr.write(`${error}\n`)); });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    return server;
}

if (require.main === module) {
    const args = process.argv.slice(2);
    const port = args.length === 0 ? 3002 : args.length === 2 && args[0] === "--port" ? Number(args[1]) : NaN;
    runRuntimeInspector(port).then(server => {
        process.stdout.write(`Cocos Live Probe Inspector: http://127.0.0.1:${port}/\n`);
        const shutdown = () => { server.close(); server.closeIdleConnections(); };
        process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
    }).catch(error => { process.stderr.write(`${error instanceof Error ? error.message : error}\n`); process.exitCode = 1; });
}
