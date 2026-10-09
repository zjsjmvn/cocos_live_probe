import * as assert from "assert";
import { gameEnvironment } from "./fixtures/game-environment";
import { parseRuntimeProbeArgs } from "../runtime-probe";
import { EventEmitter } from "events";

async function main(): Promise<void> {
    const fixture = gameEnvironment("");
    try {
        const result: any = await fixture.service.dispatch(parseRuntimeProbeArgs(["render-ready", '{"timeoutMs":100}']));
        assert.strictEqual(result.status, "unsupported", "scene existence cannot prove drawing");
        assert.strictEqual(result.engineReady, true);
        const strict: any = await fixture.service.dispatch(parseRuntimeProbeArgs(["screenshot", '{"waitForRender":true,"timeoutMs":100}']));
        assert.strictEqual(strict.status, "failed");
        assert.strictEqual(strict.reason, "unsupported");
        assert.strictEqual(strict.outputPath, undefined);
    } finally { await fixture.service.dispose(); }
    const supported = gameEnvironment("");
    const events = new EventEmitter();
    let scene = { name: "scene-a" };
    let paused = false;
    supported.globals.cc.Director = { EVENT_AFTER_DRAW: "after-draw", EVENT_BEFORE_SCENE_LAUNCH: "before-scene" };
    supported.globals.cc.director = { getScene: () => scene, isPaused: () => paused,
        on: events.on.bind(events), off: events.off.bind(events), getTotalFrames: () => 7 };
    try {
        const pending = supported.service.dispatch({ kind: "render-ready", timeoutMs: 500 });
        setTimeout(() => events.emit("after-draw"), 50);
        const rendered: any = await pending;
        assert.strictEqual(rendered.status, "rendered");
        assert.strictEqual(rendered.frame, 7);
        paused = true;
        assert.strictEqual((await supported.service.dispatch({ kind: "render-ready", timeoutMs: 100 }) as any).status, "rendered");
        events.emit("before-scene"); scene = { name: "scene-a" };
        assert.strictEqual((await supported.service.dispatch({ kind: "render-ready", timeoutMs: 100 }) as any).status, "paused-unverified");
        paused = false;
        assert.strictEqual((await supported.service.dispatch({ kind: "render-ready", timeoutMs: 80 }) as any).status, "timeout");
        const shot: any = await supported.service.dispatch({ kind: "screenshot" });
        assert.ok(shot.outputPath, "ordinary screenshots still work without drawing");
        assert.strictEqual(shot.render.status, "unverified");
    } finally { await supported.service.dispose(); }
    console.log("Runtime render tests passed");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
