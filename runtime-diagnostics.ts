import { PageIdentity, PageTransport } from "./runtime-interaction";

export interface DiagnosticsOptions { after?: number; limit?: number; types?: string[]; levels?: string[] }
export const DIAGNOSTIC_TYPES = ["console", "exception", "promise-rejection", "network-failure", "http-error", "gap"];
export const DIAGNOSTIC_LEVELS = ["log", "info", "warn", "error", "debug"];

interface DiagnosticRecord extends PageIdentity {
    cursor: number;
    capturedAt: string;
    documentId: string | null;
    type: string;
    level: string;
    message: string;
    details: unknown;
    truncated: boolean;
}

/** Only protocol data is kept: no remote handles, response bodies, or unbounded object graphs. */
function boundedValue(value: unknown): { value: unknown; truncated: boolean } {
    const seen = new Set<object>();
    let remaining = 200;
    let truncated = false;
    const copy = (item: unknown, depth: number): unknown => {
        if (--remaining < 0 || depth > 5) { truncated = true; return "[truncated]"; }
        if (typeof item === "string") {
            if (item.length > 2048) { truncated = true; return item.slice(0, 2048) + "[truncated]"; }
            return item;
        }
        if (item === null || typeof item === "boolean" || typeof item === "number") return item;
        if (typeof item !== "object") return String(item);
        if (seen.has(item)) { truncated = true; return "[circular]"; }
        seen.add(item);
        if (Array.isArray(item)) {
            if (item.length > 40) truncated = true;
            return item.slice(0, 40).map(child => copy(child, depth + 1));
        }
        const entries = Object.entries(item).filter(([key]) => key !== "objectId");
        if (entries.length > 40) truncated = true;
        return Object.fromEntries(entries.slice(0, 40).map(([key, child]) => [key.slice(0, 128), copy(child, depth + 1)]));
    };
    return { value: copy(value, 0), truncated };
}

export class RuntimeDiagnostics {
    private readonly records: { record: DiagnosticRecord; bytes: number }[] = [];
    private bytes = 0;
    private cursor = 0;
    private dropped = 0;
    private unsubscribers: (() => void)[] = [];
    private connected = false;
    private startedAt: string | null = null;
    private currentDocument: string | null = null;
    private currentPage: PageTransport | undefined;
    private readonly requests = new Map<string, string>();
    private identity: (() => PageIdentity) | undefined;

    public async attach(page: PageTransport, identity: () => PageIdentity): Promise<void> {
        if (this.currentPage === page && this.connected) return;
        this.detach();
        this.currentPage = page;
        this.identity = identity;
        this.startedAt ??= new Date().toISOString();
        const subscribe = (method: string, listener: (params: any) => void) => {
            this.unsubscribers.push(page.onEvent(method, listener));
        };
        subscribe("Runtime.consoleAPICalled", event => {
            const argumentsList = (event.args ?? []).slice(0, 40);
            const message = argumentsList.map((arg: any) => typeof arg.value === "string" ? arg.value
                : arg.value !== undefined ? JSON.stringify(boundedValue(arg.value).value)
                    : arg.description ?? arg.unserializableValue ?? arg.type).join(" ");
            const level = event.type === "warning" ? "warn" : DIAGNOSTIC_LEVELS.includes(event.type) ? event.type : "log";
            this.append("console", level, message, { protocolTimestamp: event.timestamp,
                args: argumentsList, stackTrace: event.stackTrace });
        });
        subscribe("Runtime.exceptionThrown", event => {
            const details = event.exceptionDetails ?? {};
            const type = String(details.text).toLowerCase().includes("promise") ? "promise-rejection" : "exception";
            this.append(type, "error", details.exception?.description ?? details.text ?? "Runtime exception",
                { protocolTimestamp: event.timestamp, ...details });
        });
        subscribe("Network.requestWillBeSent", event => {
            if (this.requests.size >= 1000) this.requests.delete(this.requests.keys().next().value!);
            this.requests.set(event.requestId, event.request?.url ?? "");
        });
        subscribe("Network.loadingFailed", event => {
            const url = this.requests.get(event.requestId);
            this.requests.delete(event.requestId);
            this.append("network-failure", "error", event.errorText ?? "Network loading failed", { ...event, url });
        });
        subscribe("Network.loadingFinished", event => { this.requests.delete(event.requestId); });
        subscribe("Network.responseReceived", event => {
            const response = event.response;
            if (response?.status >= 400) this.append("http-error", "error", `HTTP ${response.status} ${response.url}`,
                { url: response.url, status: response.status, requestId: event.requestId, protocolTimestamp: event.timestamp });
        });
        subscribe("Page.frameNavigated", event => {
            if (event.frame?.parentId === undefined) {
                this.currentDocument = event.frame?.loaderId ?? null;
                this.requests.clear();
            }
        });
        subscribe("Probe.disconnected", event => {
            this.connected = false;
            this.append("gap", "warn", "CDP connection lost; collection interrupted", event);
        });
        try {
            await page.send("Runtime.enable");
            await page.send("Page.enable");
            await page.send("Network.enable", { maxTotalBufferSize: 0, maxResourceBufferSize: 0 });
            const tree = await page.send("Page.getFrameTree") as { frameTree?: { frame?: { loaderId?: string } } };
            this.currentDocument = tree.frameTree?.frame?.loaderId ?? null;
            this.connected = true;
        } catch (error) {
            this.append("gap", "warn", "Diagnostic subscription could not be enabled", { error: String(error) });
            this.detach();
            throw error;
        }
    }

    private append(type: string, level: string, message: string, details: unknown): void {
        if (!this.identity) return;
        const bounded = boundedValue(details);
        const record: DiagnosticRecord = { ...this.identity(), cursor: ++this.cursor,
            capturedAt: new Date().toISOString(), documentId: this.currentDocument, type, level,
            message: message.slice(0, 4096), details: bounded.value,
            truncated: bounded.truncated || message.length > 4096 };
        let bytes = Buffer.byteLength(JSON.stringify(record));
        if (bytes > 16 * 1024) {
            record.details = "[details exceeded 16 KiB entry capacity]";
            record.truncated = true;
            bytes = Buffer.byteLength(JSON.stringify(record));
        }
        this.records.push({ record, bytes }); this.bytes += bytes;
        while (this.records.length > 1000 || this.bytes > 2 * 1024 * 1024) {
            const removed = this.records.shift()!;
            this.bytes -= removed.bytes; this.dropped++;
        }
    }

    public read(options: DiagnosticsOptions = {}) {
        const after = options.after ?? 0;
        const oldestCursor = this.records[0]?.record.cursor ?? this.cursor + 1;
        const matching = this.records.filter(item => item.record.cursor > after
            && (!options.types || options.types.includes(item.record.type))
            && (!options.levels || options.levels.includes(item.record.level)));
        const selected = matching.slice(0, options.limit ?? 100).map(item => item.record);
        const hasMore = matching.length > selected.length;
        return { startedAt: this.startedAt, connected: this.connected, scope: "current service connection only",
            records: selected, nextCursor: hasMore ? selected[selected.length - 1].cursor : this.cursor,
            oldestCursor, hasMore, cursorGap: after < oldestCursor - 1, dropped: this.dropped,
            retainedBytes: this.bytes, capacity: { entries: 1000, bytes: 2 * 1024 * 1024, entryBytes: 16 * 1024 } };
    }

    public detach(): void {
        for (const unsubscribe of this.unsubscribers) unsubscribe();
        this.unsubscribers = [];
        if (this.connected) this.append("gap", "warn", "Diagnostic connection detached; collection interrupted", {});
        this.connected = false;
        this.currentPage = undefined;
        this.requests.clear();
    }
}
