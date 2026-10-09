import * as assert from "assert";
import { EventEmitter } from "events";
import { gameEnvironment } from "./fixtures/game-environment";
import { parseRuntimeProbeArgs } from "../runtime-probe";

async function inputCase(unrelated: boolean, fail = false, replaceBoundary = false, deferredReplay = false): Promise<void> {
    const fixture = gameEnvironment("");
    const events = new EventEmitter();
    const dom = new Map<string, (event: unknown) => void>();
    let businessCalls = 0;
    class Node {
        name = unrelated ? "background" : "button";
        uuid = unrelated ? "background-node" : "button-node";
        parent = null;
        dispatchEvent(_event: unknown): string {
            businessCalls++;
            if (replaceBoundary) Node.prototype.dispatchEvent = function(event: unknown) { businessCalls++; return "third-party-return"; };
            return "original-return";
        }
    }
    fixture.globals.cc.Node = Node;
    const canvas = { width: 640, height: 480, getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }) };
    fixture.globals.cc.game = { canvas };
    fixture.globals.cc.Director = { EVENT_AFTER_DRAW: "after-draw" };
    fixture.globals.cc.director.on = events.on.bind(events);
    fixture.globals.cc.director.off = events.off.bind(events);
    const document = fixture.globals.document as any;
    const globals = fixture.globals as any;
    globals.event = null;
    document.addEventListener = (type: string, fn: (event: unknown) => void) => dom.set(type, fn);
    document.removeEventListener = (type: string) => dom.delete(type);
    const target = new Node();
    let pressed = false;
    Object.defineProperty(fixture.globals, "pressed", { get: () => pressed, set: value => {
        pressed = value;
        const type = value ? "mousedown" : "mouseup";
        globals.event = { isTrusted: true, type, clientX: 20, clientY: 20 };
        dom.get(type)?.(globals.event);
        const dispatch = () => target.dispatchEvent({ type: value ? "touch-start" : "touch-end", target, eventPhase: 2,
            getID: () => unrelated ? 99 : 0, getLocation: () => unrelated ? { x: 9000, y: 9000 } : { x: 20, y: 460 } });
        if (deferredReplay) setTimeout(dispatch, 5); else dispatch();
        globals.event = null;
        if (!value) setTimeout(() => events.emit("after-draw"), 20);
    } });
    fixture.globals.failInput = fail;
    try {
        const shot: any = await fixture.service.dispatch({ kind: "screenshot" });
        const result: any = await fixture.service.dispatch(parseRuntimeProbeArgs(["input", JSON.stringify({ action: "click", device: "mouse", point: { x: 20, y: 20 }, observation: shot.observation, timeoutMs: 500 })]));
        assert.strictEqual(result.status, fail ? "failed" : "sent");
        assert.strictEqual(result.cleanupConfirmed, true);
        assert.strictEqual(businessCalls, 2, "observation does not change normal dispatch calls");
        assert.strictEqual(result.deliveryEvidence.hit, unrelated || fail || replaceBoundary || deferredReplay ? "unknown" : "hit");
        assert.strictEqual(result.deliveryEvidence.completeness, unrelated || fail || replaceBoundary || deferredReplay ? "partial" : "complete");
        if (unrelated || deferredReplay) assert.strictEqual(result.deliveryEvidence.nodes.length, 0);
        else assert.strictEqual(result.deliveryEvidence.nodes[0].uuid, "button-node");
        if (replaceBoundary) assert.strictEqual(await fixture.service.dispatch({ kind: "eval", expression: 'cc.Node.prototype.dispatchEvent.call({}, {})' }), "third-party-return", "cleanup preserves a later third-party boundary");
    } finally { await fixture.service.dispose(); }
}

async function main(): Promise<void> {
    await inputCase(true);
    await inputCase(false);
    await inputCase(false, true);
    await inputCase(false, false, true);
    await inputCase(false, false, false, true);
    console.log("Runtime delivery tests passed");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
