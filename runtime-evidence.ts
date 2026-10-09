import * as fs from "fs";
import * as path from "path";
import { randomUUID, createHash } from "crypto";
import { execFileSync } from "child_process";

const MAX_JSON = 256 * 1024;
const OWNER = "cocos-live-probe-evidence-v1";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ACTIVE_RUNS = new Set<string>();
export interface EvidenceLimits { runBytes?: number; totalBytes?: number; runs?: number; commands?: number; diagnostics?: number }
export interface EvidenceCommand { kind: "evidence"; action: "start" | "finish" | "export"; runId?: string; label?: string; timeoutMs: number }
export function parseEvidence(value: unknown): EvidenceCommand {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Evidence arguments must be an object");
    const args = value as Record<string, unknown>;
    if (Object.keys(args).some(key => !["action", "runId", "label", "timeoutMs"].includes(key))) throw new Error("Unknown evidence argument");
    if (!["start", "finish", "export"].includes(String(args.action))) throw new Error("Expected evidence action start/finish/export");
    const timeoutMs = args.timeoutMs ?? 5000;
    if (!Number.isInteger(timeoutMs) || Number(timeoutMs) < 1 || Number(timeoutMs) > 10000) throw new Error("Evidence timeoutMs must be 1..10000");
    if (args.action === "start") {
        if (args.runId !== undefined || args.label !== undefined && (typeof args.label !== "string" || args.label.length > 64)) throw new Error("Invalid evidence start arguments");
    } else if (args.label !== undefined || typeof args.runId !== "string" || !UUID.test(args.runId)) throw new Error("An exact evidence runId is required");
    return { kind: "evidence", action: args.action as EvidenceCommand["action"], timeoutMs: Number(timeoutMs),
        ...(args.label !== undefined ? { label: args.label as string } : {}), ...(args.runId ? { runId: args.runId as string } : {}) };
}

export function evidenceEnabled(value: string | undefined): boolean {
    if (value === undefined || value === "off") return false;
    if (value === "on") return true;
    throw new Error("COCOS_RUNTIME_PROBE_EVIDENCE must be on or off");
}

function limited(value: unknown, bytes = MAX_JSON): unknown {
    let text: string;
    try { text = JSON.stringify(value, (key, item) => /token|secret|authorization|password|api.?key/i.test(key) ? "[redacted]" : item); } catch { return { omitted: true, reason: "not-json" }; }
    if (text === undefined) return null;
    return Buffer.byteLength(text) <= bytes ? JSON.parse(text) : { omitted: true, reason: "byte-limit" };
}
function limit(value: number | undefined, fallback: number, maximum: number): number {
    const result = value ?? fallback;
    if (!Number.isInteger(result) || result < 1 || result > maximum) throw new Error(`Invalid evidence capacity (1..${maximum})`);
    return result;
}
export class RuntimeEvidence {
    public readonly root: string;
    private readonly ownerIdentity: string;
    private readonly caps: Required<EvidenceLimits>;
    private active: any;
    private bytes = 0;
    private sequence = 0;
    private diagnosticCursor = 0;
    private diagnosticCount = 0;
    private readonly sessionId = randomUUID();
    private readonly screenshotCopies = new Map<string, { file: string; digest: string }>();
    public constructor(private readonly workspace: string, private readonly instanceId: string, root?: string, caps: EvidenceLimits = {}) {
        this.root = path.resolve(workspace, root ?? ".runtime-probe-evidence");
        this.ownerIdentity = createHash("sha256").update(path.resolve(workspace).toLowerCase()).digest("hex");
        this.caps = { runBytes: limit(caps.runBytes, 32 * 1024 * 1024, 128 * 1024 * 1024),
            totalBytes: limit(caps.totalBytes, 256 * 1024 * 1024, 1024 * 1024 * 1024),
            runs: limit(caps.runs, 20, 100), commands: limit(caps.commands, 1000, 1000), diagnostics: limit(caps.diagnostics, 1000, 1000) };
        if (this.caps.totalBytes < this.caps.runBytes) throw new Error("Evidence totalBytes must cover runBytes");
    }
    public get runId(): string | undefined { return this.active?.runId; }
    public get cursor(): number { return this.diagnosticCursor; }
    public start(label: string | undefined, diagnostics: any, deadline: number): any {
        this.check(deadline);
        if (this.active) throw new Error(`Evidence run already active: ${this.active.runId}`);
        this.safeRoot();
        fs.mkdirSync(this.root, { recursive: true });
        const runId = randomUUID();
        const directory = path.join(this.root, runId);
        this.lockRoot(() => {
            this.prune();
            fs.mkdirSync(directory);
            fs.writeFileSync(path.join(directory, "owner.json"), JSON.stringify({ marker: OWNER, runId, workspace: this.ownerIdentity,
                pid: process.pid, sessionId: this.sessionId, reservedBytes: this.caps.runBytes }), { flag: "wx" });
        });
        try {
            const timeout = Math.max(1, Math.min(150, Math.floor((deadline - performance.now()) / 3)));
            let source: unknown;
            try { source = { commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: this.workspace, timeout, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(),
                dirty: Boolean(execFileSync("git", ["status", "--porcelain"], { cwd: this.workspace, timeout, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).length), source: "workspace Git; not loaded-script proof", provesLoadedCode: false }; }
            catch { source = { commit: "unknown", dirty: "unknown", provesLoadedCode: false }; }
            this.active = { schemaVersion: 1, runId, label: label ?? "", instanceId: this.instanceId, startedAt: new Date().toISOString(),
                sessionId: this.sessionId, pid: process.pid, runState: "in-progress", evidenceStatus: "complete", source, runtimeVersion: "unknown", commands: [], artifacts: [], missing: [], boundaries: [],
                coverage: { inputs: "probe commands only; human and background input are not fully recorded", diagnostics: limited(diagnostics, 8192) },
                capacity: this.caps, bytes: 0, truncated: false };
            this.bytes = Buffer.byteLength(fs.readFileSync(path.join(directory, "owner.json")));
            this.sequence = 0; this.diagnosticCount = 0; this.diagnosticCursor = diagnostics?.nextCursor ?? 0;
            this.screenshotCopies.clear(); ACTIVE_RUNS.add(runId);
            this.persist(deadline);
            return this.reply(this.active);
        } catch (error) { ACTIVE_RUNS.delete(runId); this.active = undefined; throw error; }
    }
    public problem(reason: string): void {
        if (!this.active) return;
        this.active.evidenceStatus = "partial";
        if (this.active.missing.length < 32 && !this.active.missing.includes(reason)) this.active.missing.push(reason.slice(0, 300));
    }
    private check(deadline: number): void { if (performance.now() >= deadline) throw new Error("Evidence total timeout exceeded"); }
    private directory(): string {
        this.safeRoot();
        const directory = path.join(this.root, this.active.runId);
        if (fs.lstatSync(directory).isSymbolicLink()) throw new Error("Evidence run cannot be a symbolic link");
        return directory;
    }
    public artifact(kind: string, value: unknown, deadline: number, commandId?: number): string | undefined {
        if (!this.active) return;
        const existing = kind === "screenshot" ? this.screenshotCopies.get(String(value)) : undefined;
        if (kind === "screenshot") this.screenshotCopies.delete(String(value));
        try {
            this.check(deadline);
            if (existing && !fs.existsSync(String(value))) { this.screenshotCopies.set(String(value), existing); return existing.file; }
            const reserve = Math.min(MAX_JSON, Math.max(2048, Math.floor(this.caps.runBytes / 4)));
            if (kind === "screenshot" && fs.statSync(String(value)).size + reserve > this.caps.runBytes) { this.problem("run-byte-limit"); this.active.truncated = true; return; }
            const payload: any = kind === "screenshot" ? null : limited(value);
            if (payload?.omitted) { this.problem("artifact-payload-limit"); this.active.truncated = true; }
            const data = kind === "screenshot" ? fs.readFileSync(String(value)) : Buffer.from(JSON.stringify(payload));
            const digest = kind === "screenshot" ? createHash("sha256").update(data).digest("hex") : "";
            if (existing?.digest === digest) { this.screenshotCopies.set(String(value), existing); return existing.file; }
            if (this.active.artifacts.length >= 1000 || this.bytes + data.length + reserve > this.caps.runBytes) { this.problem("run-byte-or-artifact-limit"); this.active.truncated = true; return; }
            const file = `${this.active.artifacts.length + 1}-${kind}.${kind === "screenshot" ? "png" : "json"}`;
            fs.writeFileSync(path.join(this.directory(), file), data, { flag: "wx" }); this.bytes += data.length;
            this.active.artifacts.push({ file, kind, bytes: data.length, commandId });
            if (kind === "screenshot") this.screenshotCopies.set(String(value), { file, digest });
            return file;
        } catch (error) { this.problem(`artifact-unavailable: ${String(error)}`); return; }
    }
    public record(command: { kind: string }, result: any, error: unknown, startedAt: string, elapsedMs: number, identity: unknown, diagnostics: any, deadline: number): void {
        if (!this.active) return;
        const commandId = ++this.sequence;
        if (command.kind === "screenshot" && (!result?.outputPath || error)) this.problem("screenshot-unavailable");
        if (this.active.commands.length >= this.caps.commands) { this.active.truncated = true; this.problem("command-limit"); return; }
        const image = result?.outputPath;
        if (image) this.artifact("screenshot", image, deadline, commandId);
        const files = new Set<string>();
        if (result?.input?.screenshotPath) files.add(result.input.screenshotPath);
        for (const item of result?.records ?? []) if (item.input?.screenshotPath) files.add(item.input.screenshotPath);
        for (const file of files) this.artifact("screenshot", file, deadline, commandId);
        const sanitized = this.portableResult(result);
        const report = this.artifact("result", sanitized ?? { error: String(error).slice(0, 2000) }, deadline, commandId);
        if (diagnostics?.cursorGap || diagnostics?.hasMore) this.problem("diagnostic-gap-or-truncation");
        const rows = diagnostics?.records?.slice(0, Math.max(0, this.caps.diagnostics - this.diagnosticCount)) ?? [];
        this.diagnosticCount += rows.length;
        if (rows.length < (diagnostics?.records?.length ?? 0)) { this.active.truncated = true; this.problem("diagnostic-limit"); }
        if (rows.length) this.artifact("diagnostics", { ...diagnostics, records: rows }, deadline, commandId);
        this.diagnosticCursor = diagnostics?.nextCursor ?? this.diagnosticCursor;
        if (rows.some((row: any) => row.type === "gap" || row.truncated)) this.problem("diagnostic-gap-or-truncation");
        const rawIdentity = result?.observation ?? result?.after ?? result?.instance ?? result ?? identity;
        const actualIdentity: Record<string, unknown> = { ...identity as object, ...Object.fromEntries(["instanceId", "targetId", "documentId", "refreshGeneration", "geometryKey", "pluginId", "gameId", "bridgeInstanceId", "sceneId", "capturedAt"].filter(key => rawIdentity?.[key] !== undefined).map(key => [key, rawIdentity[key]])) };
        if (result?.instance?.target?.id) actualIdentity.targetId = result.instance.target.id;
        if (result?.cocos?.version) this.active.runtimeVersion = result.cocos.version;
        if (result?.cocos?.scene) actualIdentity.scene = result.cocos.scene;
        if (rawIdentity?.pluginId) this.active.game = { pluginId: rawIdentity.pluginId, gameId: rawIdentity.gameId, stateVersion: rawIdentity.stateVersion };
        const previous = this.active.commands[this.active.commands.length - 1]?.identity;
        if (previous?.documentId && actualIdentity?.documentId && previous.documentId !== actualIdentity.documentId) {
            if (this.active.boundaries.length < 32) this.active.boundaries.push({ commandId, reason: "document-changed", from: previous.documentId, to: actualIdentity.documentId });
        }
        const params = command as any;
        this.active.commands.push({ commandId, kind: command.kind, parameters: limited({ action: params.action, device: params.device, durationMs: params.durationMs, timeoutMs: params.timeoutMs,
            selector: params.selector, goal: params.args?.goal }, 1024), startedAt, elapsedMs, identity: limited(actualIdentity, 2048), report,
            status: String(result?.status ?? (error ? "failed" : "returned")).slice(0, 64), reason: typeof result?.reason === "string" ? result.reason.slice(0, 500) : undefined, goalReached: result?.goalReached === true,
            steps: result?.steps, error: error ? String(error).slice(0, 500) : undefined });
        if (result?.truncated) this.problem("command-result-truncated; step artifacts contain available earlier evidence");
        try { this.persist(deadline); } catch (caught) { this.problem(`manifest-unavailable: ${String(caught)}`); }
    }
    private persist(deadline: number): void {
        this.check(deadline);
        this.active.bytes = this.bytes;
        let data = JSON.stringify(this.active);
        const budget = Math.min(MAX_JSON, this.caps.runBytes - this.bytes);
        while (Buffer.byteLength(data) > budget && this.active.commands.length > 1) {
            this.active.commands.shift(); this.active.truncated = true; this.problem("manifest-byte-limit"); data = JSON.stringify(this.active);
        }
        for (let i = 0; i < 5; i++) { this.active.bytes = this.bytes + Buffer.byteLength(data); data = JSON.stringify(this.active); }
        if (Buffer.byteLength(data) > MAX_JSON || this.bytes + Buffer.byteLength(data) > this.caps.runBytes) throw new Error("Evidence manifest capacity exceeded");
        const temporary = path.join(this.directory(), "manifest.tmp");
        fs.writeFileSync(temporary, data); fs.renameSync(temporary, path.join(this.directory(), "manifest.json"));
    }
    public finish(runId: string, deadline: number, reason = "requested"): any {
        if (runId !== this.active?.runId) throw new Error("No matching active evidence run");
        this.active.runState = "finished"; this.active.finishedAt = new Date().toISOString(); this.active.finishReason = reason;
        try { this.persist(deadline); } catch (error) { this.problem(String(error)); throw error; }
        const reply = this.reply(this.active); ACTIVE_RUNS.delete(runId); this.active = undefined; return reply;
    }
    public abandon(): void { if (this.runId) ACTIVE_RUNS.delete(this.runId); this.active = undefined; }
    public noteRuntime(version: string | null): void { if (this.active && version) this.active.runtimeVersion = version; }
    private portableResult(value: unknown): unknown {
        if (value === undefined) return null;
        return JSON.parse(JSON.stringify(value, (key, item) => key === "image" ? undefined
            : ["outputPath", "screenshotPath"].includes(key) && typeof item === "string" ? this.screenshotCopies.get(item)?.file ?? { missing: true, reason: "screenshot-not-archived" } : item));
    }
    public recordStep(result: any, step: number, deadline: number): void {
        if (!this.active) return;
        const commandId = this.sequence + 1;
        const screenshot = result.input?.screenshotPath ? this.artifact("screenshot", result.input.screenshotPath, deadline, commandId) : undefined;
        this.artifact("step", { ...this.portableResult(result) as object, parentCommandId: commandId, step, archivedScreenshot: screenshot }, deadline, commandId);
    }
    public export(runId: string, deadline: number): any {
        this.check(deadline);
        if (runId === this.active?.runId) this.persist(deadline);
        const manifest = this.readOwned(runId);
        if (!manifest) throw new Error("Evidence run unavailable or damaged");
        const alive = manifest.pid === process.pid ? ACTIVE_RUNS.has(runId) : this.alive(manifest.pid);
        const current = manifest.runState === "in-progress" && !alive ? { ...manifest, runState: "incomplete", evidenceStatus: "partial", missing: [...manifest.missing, "owner-process-unavailable"] } : manifest;
        return this.reply(current);
    }
    private reply(manifest: any): any {
        return { runId: manifest.runId, runState: manifest.runState, evidenceStatus: manifest.evidenceStatus, truncated: manifest.truncated,
            directory: path.join(this.root, manifest.runId), manifestPath: path.join(this.root, manifest.runId, "manifest.json"), missing: manifest.missing };
    }
    private safeRoot(): void {
        for (let current = this.root; ; current = path.dirname(current)) {
            if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error("Evidence root cannot contain symbolic links");
            if (path.dirname(current) === current) break;
        }
    }
    private alive(pid: unknown): boolean { try { if (!Number.isInteger(pid) || Number(pid) <= 0) return false; process.kill(Number(pid), 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } }
    private lockRoot<T>(operation: () => T): T {
        const file = path.join(this.root, ".evidence.lock");
        let descriptor: number;
        try { descriptor = fs.openSync(file, "wx"); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            let stale: string;
            try { if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 1024) throw error; stale = fs.readFileSync(file, "utf8"); if (this.alive(JSON.parse(stale).pid)) throw error; }
            catch { throw new Error("Evidence root is busy or its lock is damaged"); }
            if (fs.readFileSync(file, "utf8") !== stale) throw new Error("Evidence root is busy");
            fs.unlinkSync(file); descriptor = fs.openSync(file, "wx");
        }
        try { fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, sessionId: this.sessionId })); return operation(); }
        finally { fs.closeSync(descriptor); fs.unlinkSync(file); }
    }
    private readOwned(runId: string): any {
        try {
            this.safeRoot();
            const directory = path.join(this.root, runId);
            if (!UUID.test(runId) || fs.lstatSync(directory).isSymbolicLink()) return;
            if (fs.lstatSync(path.join(directory, "owner.json")).isSymbolicLink() || fs.statSync(path.join(directory, "owner.json")).size > 2048) return;
            const owner = JSON.parse(fs.readFileSync(path.join(directory, "owner.json"), "utf8"));
            if (owner.marker !== OWNER || owner.runId !== runId || owner.workspace !== this.ownerIdentity) return;
            const file = path.join(directory, "manifest.json");
            if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > MAX_JSON) return;
            const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
            if (manifest.runId !== runId || manifest.schemaVersion !== 1 || !["in-progress", "finished", "incomplete"].includes(manifest.runState)
                || !Array.isArray(manifest.artifacts) || manifest.artifacts.length > 1000 || !Array.isArray(manifest.missing)) return;
            for (const item of manifest.artifacts) {
                if (!/^\d+-(screenshot|result|step|diagnostics)\.(png|json)$/.test(item.file)) return;
                const stat = fs.lstatSync(path.join(directory, item.file));
                if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== item.bytes) return;
            }
            return manifest;
        } catch { return; }
    }
    private prune(): void {
        const names = fs.readdirSync(this.root);
        if (names.length > 1000) throw new Error("Evidence root entry limit exceeded");
        const owned = names.filter(name => UUID.test(name)).map(runId => {
            const manifest = this.readOwned(runId);
            const directory = path.join(this.root, runId);
            let bytes = this.caps.runBytes;
            let removable = false;
            if (manifest) {
                const files = fs.readdirSync(directory);
                const expected = new Set(["owner.json", "manifest.json", ...manifest.artifacts.map((item: any) => item.file)]);
                removable = files.every(name => expected.has(name) && fs.lstatSync(path.join(directory, name)).isFile());
                bytes = files.reduce((sum, name) => sum + fs.lstatSync(path.join(directory, name)).size, 0);
                if (manifest.runState === "in-progress") bytes = Math.max(bytes, Number(JSON.parse(fs.readFileSync(path.join(directory, "owner.json"), "utf8")).reservedBytes) || this.caps.runBytes);
            }
            return { runId, manifest, bytes, removable };
        });
        let count = owned.length;
        let total = owned.reduce((sum, item) => sum + item.bytes, 0);
        for (const item of owned.sort((a, b) => String(a.manifest?.startedAt).localeCompare(String(b.manifest?.startedAt)))) {
            if (count < this.caps.runs && total + this.caps.runBytes <= this.caps.totalBytes) break;
            if (!item.removable || item.manifest?.runState !== "finished" || item.runId === this.runId) continue;
            const target = path.resolve(this.root, item.runId);
            if (path.dirname(target) !== this.root || !this.readOwned(item.runId)) continue;
            fs.rmSync(target, { recursive: true }); count--; total -= item.bytes;
        }
        if (count >= this.caps.runs || total + this.caps.runBytes > this.caps.totalBytes) throw new Error("Evidence retained capacity exhausted by active/incomplete runs");
    }
}
