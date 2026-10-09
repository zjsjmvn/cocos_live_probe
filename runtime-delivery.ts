import { randomUUID } from "crypto";
import { deadlineTransport, InputCommand, observePage, PageIdentity, PageTransport } from "./runtime-interaction";

// Serialized into the preview. It observes existing dispatches; it adds no node listeners.
export async function deliveryObserver(operation: string, args: any): Promise<any> {
    const g = globalThis as any;
    const key = "__cocosLiveProbeInputDelivery";
    if (operation !== "install") {
        const state = g[key];
        if (!state || state.actionId !== args.actionId) return { hit: "unknown", completeness: "partial", reason: "observation-unavailable", nodes: [], events: [] };
        if (state.director?.getScene?.() !== state.scene) state.interference = true;
        const result = () => ({ actionId: state.actionId, device: state.device, status: "observed", completeness: state.complete && !state.overflow && !state.interference ? "complete" : "partial",
            hit: state.complete && !state.overflow && !state.interference ? state.nodes.length ? "hit" : "miss" : "unknown",
            nodes: state.nodes, events: state.events, rawEvents: state.rawEvents,
            eventSource: "public Node.dispatchEvent targets; distinct derived mouse/touch phases retained, targets and recursive dispatches deduplicated",
            reason: state.overflow ? "observation-limit" : state.interference ? "input-or-scene-association-unconfirmed" : !state.complete ? "event-processing-boundary-unconfirmed" : undefined });
        if (operation === "cancel") { state.dispose(); return result(); }
        try {
            if (!state.rawEnd || !state.director?.on || !state.drawEvent) return result();
            await new Promise<void>(resolve => {
                let timer: ReturnType<typeof setTimeout>;
                const done = () => { clearTimeout(timer); state.director.off(state.drawEvent, drawn); state.cancelWait = undefined; resolve(); };
                const drawn = () => { state.complete = true; done(); };
                timer = setTimeout(done, Math.max(1, args.waitMs));
                state.director.on(state.drawEvent, drawn);
                state.cancelWait = done;
            });
            return result();
        } finally { state.dispose(); }
    }
    let cc = g.cc;
    try {
        if (g.System?.resolve && g.System?.get) cc = g.System.get(await g.System.resolve("cc"));
        else if (g.System?.import) cc = await g.System.import("cc");
    } catch { return { hit: "unsupported", completeness: "partial", reason: "engine-unavailable" }; }
    const proto = cc?.Node?.prototype;
    const descriptor = proto && Object.getOwnPropertyDescriptor(proto, "dispatchEvent");
    if (!descriptor?.value || !descriptor.writable || !g.document?.addEventListener) return { hit: "unsupported", completeness: "partial", reason: "public-event-dispatch-unavailable" };
    if (g[key]) return { hit: "unknown", completeness: "partial", reason: "observation-already-active" };
    const original = descriptor.value;
    const state: any = { actionId: args.actionId, device: args.device, nodes: [], events: [], rawEvents: [], rawEnd: false,
        complete: false, enabled: true, overflow: false, processing: new WeakSet(), director: cc.director, scene: cc.director?.getScene?.(), drawEvent: cc.Director?.EVENT_AFTER_DRAW };
    const types = args.device === "touch" ? ["touchstart", "touchmove", "touchend", "touchcancel"] : ["mousedown", "mousemove", "mouseup"];
    const raw = (event: any) => {
        if (!state.enabled || !event.isTrusted) return;
        const point = event.changedTouches?.[0] ?? event;
        const first = args.point; const last = args.to ?? first;
        if (!Number.isFinite(point.clientX) || point.clientX < Math.min(first.x, last.x) - 3 || point.clientX > Math.max(first.x, last.x) + 3
            || point.clientY < Math.min(first.y, last.y) - 3 || point.clientY > Math.max(first.y, last.y) + 3) {
            if (event.type !== "mousemove") state.interference = true;
            return;
        }
        state.accepted = true;
        if (["mouseup", "touchend", "touchcancel"].includes(event.type)) state.rawEnd = true;
        if (state.rawEvents.length < 128) state.rawEvents.push({ type: event.type, x: point.clientX, y: point.clientY });
        else state.overflow = true;
    };
    const capture = (node: any, event: any) => {
        if (!state.enabled || !state.accepted || !event || !/^(touch|mouse)-(start|move|end|cancel|down|up)$/.test(event.type)) return;
        const target = event.target ?? node;
        const parts = []; let cursor = target;
        for (let i = 0; cursor && i < 64; i++, cursor = cursor.parent) parts.push(String(cursor.name).slice(0, 128));
        const path = ("/" + parts.reverse().join("/")).slice(0, 2048);
        const uuid = String(target.uuid ?? "").slice(0, 128);
        if (!uuid) { state.interference = true; return; }
        if (!state.nodes.some((item: any) => item.uuid === uuid)) {
            if (state.nodes.length < 32) state.nodes.push({ uuid, path, role: "event-target" }); else state.overflow = true;
        }
        if (state.events.length < 128) state.events.push({ type: event.type, uuid, phase: event.eventPhase,
            pointerId: event.getID?.() ?? event.touch?.getID?.() ?? null, location: event.getLocation?.(), uiLocation: event.getUILocation?.() });
        else state.overflow = true;
    };
    const wrapper = function(this: any, ...values: any[]) {
        const event = values[0];
        const outer = event && typeof event === "object" && !state.processing.has(event);
        if (outer) state.processing.add(event);
        try { return Reflect.apply(original, this, values); }
        finally { if (outer) { try { capture(this, event); } catch { state.interference = true; } finally { state.processing.delete(event); } } }
    };
    let timer: ReturnType<typeof setTimeout>;
    state.dispose = () => {
        state.enabled = false; clearTimeout(timer); state.cancelWait?.();
        for (const type of types) g.document.removeEventListener(type, raw, true);
        if (proto.dispatchEvent === wrapper) Object.defineProperty(proto, "dispatchEvent", descriptor);
        if (g[key] === state) delete g[key];
    };
    try {
        Object.defineProperty(proto, "dispatchEvent", { ...descriptor, value: wrapper });
        for (const type of types) g.document.addEventListener(type, raw, true);
        Object.defineProperty(g, key, { configurable: true, value: state });
        timer = setTimeout(state.dispose, args.lifetimeMs);
    } catch { state.dispose(); return { hit: "unsupported", completeness: "partial", reason: "observer-install-failed" }; }
    return { actionId: state.actionId, hit: "unknown", completeness: "partial", status: "installed" };
}

export async function installDelivery(page: PageTransport, command: InputCommand, point: unknown, to: unknown, deadline: number): Promise<any> {
    const actionId = randomUUID();
    if (command.action === "key") return { actionId, device: "keyboard", hit: "not-applicable", completeness: "complete", status: "not-applicable", nodes: [], events: [] };
    try {
        return { actionId, device: command.device, ...await page.evaluate(`(${deliveryObserver.toString()})("install",${JSON.stringify({ actionId, device: command.device, point, to, lifetimeMs: Math.max(1, deadline - performance.now()) + 3000 })})`) as object };
    } catch { return { actionId, device: command.device, hit: "unknown", completeness: "partial", reason: "observer-install-failed", nodes: [], events: [] }; }
}

export async function finishDelivery(page: PageTransport, identity: PageIdentity, command: InputCommand, installed: any, successful: boolean, deadline: number): Promise<any> {
    if (installed.status !== "installed") return installed;
    let result: any = installed;
    try {
        const remaining = Math.floor(deadline - performance.now());
        if (remaining > 20) {
            const bounded = deadlineTransport(page, deadline);
            const current = await observePage(bounded, identity);
            if (current.observation.documentId !== command.observation.documentId) throw new Error("document-changed");
            result = await bounded.evaluate(`(${deliveryObserver.toString()})("finish",${JSON.stringify({ actionId: installed.actionId, waitMs: Math.max(1, deadline - performance.now() - 20) })})`);
        }
    } catch (error) { result = { ...installed, reason: String(error).slice(0, 200) }; }
    finally {
        // Observer removal is cleanup, never a second input or a continuation of the action.
        try { await page.send("Runtime.evaluate", { expression: `(${deliveryObserver.toString()})("cancel",${JSON.stringify({ actionId: installed.actionId })})`, awaitPromise: true, returnByValue: true }, 250); } catch { /* The page may have closed; its bounded timer also removes the observer. */ }
    }
    return { ...result, ...(successful ? {} : { hit: "unknown", completeness: "partial", reason: "input-incomplete" }), observation: command.observation };
}
