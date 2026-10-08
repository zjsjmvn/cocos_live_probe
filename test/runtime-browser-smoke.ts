import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync, spawnSync } from "child_process";
import { parseRuntimeProbeArgs, RuntimeProbeService, runtimeProbeOptionsFromEnv } from "../runtime-probe";
import { CdpCommandClient, CdpRuntimeProbe } from "../cdp-runtime-probe-core";

// A generic scene built with the real engine; no host-game state or components are used.
const installFixture = `(async () => {
    const cc = await System.import("cc");
    const resizeFixture = () => {
        cc.screen.windowSize = new cc.Size(Math.max(320, Math.min(640, innerWidth - 100)), Math.max(240, Math.min(480, innerHeight - 100)));
    };
    resizeFixture(); window.addEventListener("resize", resizeFixture);
    const scene = new cc.Scene("LiveProbeFixture");
    const root = new cc.Node("FixtureCanvas"); root.layer = cc.Layers.Enum.UI_2D; scene.addChild(root);
    root.addComponent(cc.UITransform).setContentSize(640, 480);
    const canvas = root.addComponent(cc.Canvas);
    const cameraNode = new cc.Node("FixtureCamera"); cameraNode.layer = cc.Layers.Enum.UI_2D; root.addChild(cameraNode);
    cameraNode.setPosition(0, 0, 1000);
    const camera = cameraNode.addComponent(cc.Camera);
    camera.projection = cc.Camera.ProjectionType.ORTHO; camera.orthoHeight = 240;
    camera.near = 0.1; camera.far = 2000; camera.visibility = cc.Layers.Enum.UI_2D;
    camera.clearFlags = cc.Camera.ClearFlag.SOLID_COLOR; camera.clearColor = new cc.Color(30, 40, 55, 255);
    canvas.cameraComponent = camera;
    function button(name, color) {
        const node = new cc.Node(name); node.layer = cc.Layers.Enum.UI_2D; root.addChild(node);
        node.addComponent(cc.UITransform).setContentSize(200, 100);
        const graphics = node.addComponent(cc.Graphics); graphics.fillColor = color;
        graphics.rect(-100, -50, 200, 100); graphics.fill();
        node.addComponent(cc.Button).transition = cc.Button.Transition.NONE;
        return node;
    }
    const node = button("FixtureButton", new cc.Color(40, 190, 110, 255));
    node.__probeCount = 0; node.__probeMoves = 0; node.__probeStarts = 0;
    node.on(cc.Button.EventType.CLICK, () => node.__probeCount++);
    node.on(cc.Node.EventType.TOUCH_START, () => node.__probeStarts++);
    node.on(cc.Node.EventType.TOUCH_MOVE, () => node.__probeMoves++);
    cc.input.on(cc.Input.EventType.TOUCH_START, event => {
        globalThis.__liveProbeFixture.lastTouch = { location: event.getLocation(), ui: event.getUILocation() };
    });
    const overlay = button("FixtureOverlay", new cc.Color(220, 80, 70, 255));
    overlay.addComponent(cc.BlockInputEvents); overlay.active = false; overlay.__probeCount = 0;
    overlay.on(cc.Button.EventType.CLICK, () => overlay.__probeCount++);
    globalThis.__liveProbeFixture = { scene, root, node, overlay, cameraNode, keys: [],
        snapshot: () => ({ count: node.__probeCount, moves: node.__probeMoves, starts: node.__probeStarts,
            overlayCount: overlay.__probeCount, keys: globalThis.__liveProbeFixture.keys }) };
    window.addEventListener("keydown", event => globalThis.__liveProbeFixture.keys.push({ key: event.key, ctrl: event.ctrlKey, shift: event.shiftKey }), true);
    window.addEventListener("mousedown", event => { globalThis.__liveProbeFixture.lastMouse = { x: event.clientX, y: event.clientY, target: event.target.id }; }, true);
    cc.director.runSceneImmediate(scene);
    await new Promise(resolve => setTimeout(resolve, 200));
    return { uuid: node.uuid, overlayUuid: overlay.uuid, cameraUuid: cameraNode.uuid, version: cc.ENGINE_VERSION || globalThis.cc?.ENGINE_VERSION };
})()`;

async function main() {
    const service = new RuntimeProbeService({ ...runtimeProbeOptionsFromEnv(), ownership: "isolated", instanceId: "browser-acceptance" });
    const evidence: Record<string, unknown> = {};
    const dispatch = async (kind: string, args: unknown = {}) => service.dispatch(parseRuntimeProbeArgs([kind, JSON.stringify(args)])) as Promise<any>;
    const snapshot = async () => service.dispatch({ kind: "eval", expression: "globalThis.__liveProbeFixture.snapshot()" }) as Promise<any>;
    try {
        evidence.launch = await service.dispatch({ kind: "launch" });
        const fixture = await service.dispatch({ kind: "eval", expression: installFixture }) as any;
        evidence.fixture = fixture;
        const screen = await dispatch("screenshot");
        assert.ok(screen.imageWidth > 100 && screen.imageHeight > 100);
        assert.strictEqual(screen.cocos.scene, "LiveProbeFixture");
        assert.strictEqual(fs.readFileSync(screen.outputPath).subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
        evidence.screenshot = { path: screen.outputPath, width: screen.imageWidth, height: screen.imageHeight, viewport: screen.viewport };
        const click = await dispatch("input", { action: "click", device: "mouse", point: { uuid: fixture.uuid }, observation: screen.observation });
        assert.strictEqual(click.status, "sent", JSON.stringify(click));
        const waited = await dispatch("wait", { condition: { type: "property", selector: fixture.uuid, path: "__probeCount", operator: "eq", value: 1 } });
        assert.strictEqual(waited.status, "satisfied", JSON.stringify(waited));
        evidence.mouse = await snapshot();
        const coordinateClick = await dispatch("input", { action: "click", device: "mouse", point: click.point && { x: click.point.x, y: click.point.y }, observation: screen.observation });
        assert.strictEqual(coordinateClick.status, "sent");
        assert.strictEqual((await dispatch("wait", { condition: { type: "property", selector: fixture.uuid, path: "__probeCount", operator: "eq", value: 2 } })).status, "satisfied");
        const touch = await dispatch("input", { action: "click", device: "touch", point: { uuid: fixture.uuid }, observation: screen.observation });
        assert.strictEqual(touch.status, "sent", JSON.stringify(touch));
        assert.strictEqual((await dispatch("wait", { condition: { type: "property", selector: fixture.uuid, path: "__probeCount", operator: "eq", value: 3 } })).status, "satisfied");
        evidence.touch = await snapshot();
        await service.dispatch({ kind: "eval", expression: "globalThis.__liveProbeFixture.overlay.active = true" });
        await dispatch("input", { action: "click", device: "mouse", point: { uuid: fixture.uuid }, observation: screen.observation });
        assert.strictEqual((await dispatch("wait", { condition: { type: "property", selector: fixture.overlayUuid, path: "__probeCount", operator: "eq", value: 1 } })).status, "satisfied");
        assert.strictEqual((await snapshot()).count, 3);
        evidence.occlusion = await snapshot();
        await service.dispatch({ kind: "eval", expression: "globalThis.__liveProbeFixture.overlay.active = false" });
        const keyboard = await dispatch("input", { action: "key", keys: ["Control", "a"], durationMs: 20, observation: screen.observation });
        assert.strictEqual(keyboard.status, "sent");
        const keySnapshot = await snapshot();
        assert.ok(keySnapshot.keys.some((key: any) => key.key === "a" && key.ctrl), JSON.stringify(keySnapshot));
        const singleKey = await dispatch("input", { action: "key", keys: ["b"], durationMs: 0, observation: screen.observation });
        assert.strictEqual(singleKey.cleanupConfirmed, true);
        assert.ok((await snapshot()).keys.some((key: any) => key.key === "b" && !key.ctrl));
        await service.dispatch({ kind: "eval", expression: `(() => {
            const field = document.createElement("input"); field.id = "probe-keyboard-field";
            field.style.cssText = "position:fixed;left:0;top:0;width:100px";
            document.body.appendChild(field); field.focus(); return true;
        })()` });
        for (const key of ["a", "1"]) {
            const shifted = await dispatch("input", { action: "key", keys: ["Shift", key], durationMs: 0, observation: screen.observation });
            assert.strictEqual(shifted.status, "sent");
        }
        await dispatch("input", { action: "key", keys: ["b"], durationMs: 0, observation: screen.observation });
        const textInput = await service.dispatch({ kind: "eval", expression: `document.getElementById("probe-keyboard-field").value` });
        assert.strictEqual(textInput, "A!b", "Shift maps DOM key and text, and releases before the next key");
        const shiftedKeys = (await snapshot()).keys;
        assert.ok(shiftedKeys.some((key: any) => key.key === "A" && key.shift));
        assert.ok(shiftedKeys.some((key: any) => key.key === "!" && key.shift));
        await service.dispatch({ kind: "eval", expression: `document.getElementById("probe-keyboard-field").remove()` });
        evidence.shiftText = textInput;
        evidence.keyboard = await snapshot();
        const longPress = await dispatch("input", { action: "long-press", device: "mouse", point: { uuid: fixture.uuid }, durationMs: 100, observation: screen.observation });
        assert.strictEqual(longPress.cleanupConfirmed, true);
        const drag = await dispatch("input", { action: "drag", device: "mouse", point: { uuid: fixture.uuid },
            to: { x: click.point.x + 30, y: click.point.y }, durationMs: 100, observation: screen.observation });
        assert.strictEqual(drag.status, "sent", JSON.stringify(drag));
        assert.ok((await snapshot()).moves > 0);
        evidence.drag = await snapshot();
        await service.dispatch({ kind: "eval", expression: `console.warn("live-probe-smoke-warning");
            setTimeout(() => { throw new Error("live-probe-smoke-exception"); }, 10);
            Promise.reject(new Error("live-probe-smoke-promise"));
            fetch("/live-probe-nonexistent-resource").catch(() => {});
            fetch("http://127.0.0.1:1/live-probe-failure").catch(() => {});
            new Promise(resolve => setTimeout(() => resolve(true), 200));` });
        const diagnostics = await dispatch("diagnostics", { limit: 1000 });
        const ownRecords = diagnostics.records.filter((record: any) => record.message.includes("live-probe") || record.details?.url?.includes("live-probe"));
        for (const type of ["console", "exception", "promise-rejection", "http-error", "network-failure"]) {
            assert.ok(ownRecords.some((record: any) => record.type === type), `Missing ${type}: ${JSON.stringify(ownRecords)}`);
        }
        evidence.diagnostics = ownRecords.map((record: any) => ({ type: record.type, message: record.message, url: record.details?.url,
            hasStack: Boolean(record.details?.stackTrace), targetId: record.targetId }));
        const loggedEval = await service.dispatch(parseRuntimeProbeArgs(["eval", "--diagnostics", '(() => { console.warn("live-probe-eval-feedback"); return { answer: 42 }; })()'])) as any;
        assert.strictEqual(loggedEval.result.answer, 42);
        assert.ok(loggedEval.diagnostics.records.some((record: any) => record.message.includes("live-probe-eval-feedback")));
        evidence.evalDiagnostics = true;
        // Creator displays intentional fixture exceptions in a DOM error panel.
        // Dismiss that test artifact before resuming the independent input checks.
        await service.dispatch({ kind: "eval", expression: "document.getElementById('error')?.remove()" });
        await service.dispatch({ kind: "eval", expression: "document.querySelector('canvas').style.transform = 'scale(0.9)'" });
        await assert.rejects(dispatch("input", { action: "click", device: "mouse", point: { uuid: fixture.uuid }, observation: screen.observation }), /stale.*geometry/i);
        await service.dispatch({ kind: "eval", expression: "document.querySelector('canvas').style.transform = ''" });
        const resized = await dispatch("screenshot");
        const beforeScaledCount = (await snapshot()).count;
        const resizedInput = await dispatch("input", { action: "click", device: "mouse", point: { uuid: fixture.uuid }, observation: resized.observation });
        assert.strictEqual(resizedInput.status, "sent");
        const scaledWait = await dispatch("wait", { condition: { type: "property", selector: fixture.uuid, path: "__probeCount", operator: "eq", value: beforeScaledCount + 1 } });
        assert.strictEqual(scaledWait.status, "satisfied", JSON.stringify(scaledWait));
        const scaledCount = (await snapshot()).count;
        await service.dispatch({ kind: "eval", expression: "globalThis.__liveProbeFixture.node.setPosition(40, 20, 0)" });
        const transformedInput = await dispatch("input", { action: "click", device: "mouse", point: { uuid: fixture.uuid }, observation: resized.observation });
        assert.strictEqual(transformedInput.status, "sent");
        assert.notStrictEqual(transformedInput.point.x, resizedInput.point.x);
        const transformedWait = await dispatch("wait", { condition: { type: "property", selector: fixture.uuid, path: "__probeCount", operator: "eq", value: scaledCount + 1 } });
        assert.strictEqual(transformedWait.status, "satisfied", JSON.stringify({ transformedWait, transformedInput }));
        evidence.scaledInput = resizedInput;
        const cdpOrigin = runtimeProbeOptionsFromEnv().cdpOrigin ?? "http://127.0.0.1:9222";
        const version = await (await fetch(`${cdpOrigin}/json/version`)).json() as any;
        const browser = new CdpCommandClient(version.webSocketDebuggerUrl);
        const targets = await (await fetch(`${cdpOrigin}/json/list`)).json() as any[];
        const target = targets.find(target => target.id === screen.targetId);
        const page = new CdpRuntimeProbe(target.webSocketDebuggerUrl);
        const window = await browser.send<{ windowId: number; bounds: Record<string, unknown> }>("Browser.getWindowForTarget", { targetId: screen.targetId });
        try {
            await browser.send("Browser.setWindowBounds", { windowId: window.windowId, bounds: { windowState: "normal" } });
            await browser.send("Browser.setWindowBounds", { windowId: window.windowId,
                bounds: { width: resized.viewport.width + 100, height: resized.viewport.height + 160 } });
            await page.evaluate("new Promise(resolve => setTimeout(() => resolve(true), 100))");
            await assert.rejects(dispatch("input", { action: "click", device: "mouse", point: { uuid: fixture.uuid }, observation: resized.observation }), /stale.*geometry/i);
            const windowScreen = await dispatch("screenshot");
            const windowCount = (await snapshot()).count;
            assert.strictEqual((await dispatch("input", { action: "click", device: "mouse", point: { uuid: fixture.uuid }, observation: windowScreen.observation })).status, "sent");
            assert.strictEqual((await dispatch("wait", { condition: { type: "property", selector: fixture.uuid, path: "__probeCount", operator: "eq", value: windowCount + 1 } })).status, "satisfied");
            evidence.windowResize = windowScreen.viewport;
            await page.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1.2 });
            await assert.rejects(dispatch("input", { action: "click", device: "mouse", point: { x: 20, y: 20 }, observation: windowScreen.observation }), /stale.*geometry/i);
            const zoomScreen = await dispatch("screenshot");
            const zoomCount = (await snapshot()).count;
            const zoomInput = await dispatch("input", { action: "click", device: "mouse", point: { uuid: fixture.uuid }, observation: zoomScreen.observation });
            assert.strictEqual(zoomInput.status, "sent");
            assert.strictEqual((await dispatch("wait", { condition: { type: "property", selector: fixture.uuid, path: "__probeCount", operator: "eq", value: zoomCount + 1 } })).status, "satisfied");
            evidence.browserZoom = zoomScreen.visualViewport;
            await page.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
            await page.evaluate("document.querySelector('canvas').style.transform = ''");
            const sceneScreen = await dispatch("screenshot");
            const replacement = await service.dispatch({ kind: "eval", expression: installFixture }) as any;
            await assert.rejects(dispatch("input", { action: "click", device: "mouse", point: { uuid: fixture.uuid }, observation: sceneScreen.observation }), /UUID.*missing|inactive|invalid/i);
            assert.strictEqual((await dispatch("input", { action: "click", device: "mouse", point: { uuid: replacement.uuid }, observation: sceneScreen.observation })).status, "sent");
            evidence.sceneSwitch = true;
            await page.reload();
            await assert.rejects(dispatch("input", { action: "click", device: "mouse", point: { x: 10, y: 10 }, observation: sceneScreen.observation }), /stale.*page/i);
            evidence.manualReloadRejectsStale = true;
        } finally {
            try {
                await browser.send("Browser.setWindowBounds", { windowId: window.windowId,
                    bounds: window.bounds.windowState === "normal" ? window.bounds : { windowState: window.bounds.windowState } });
            } finally { page.dispose(); browser.dispose(); }
        }
        const beforeRefresh = await dispatch("screenshot");
        await service.dispatch({ kind: "refresh" });
        await assert.rejects(dispatch("input", { action: "click", device: "mouse", point: { x: 10, y: 10 }, observation: beforeRefresh.observation }), /stale.*page/i);
        evidence.refreshRejectsStale = true;
        const cliEnv = { ...process.env, COCOS_RUNTIME_PROBE_OWNERSHIP: "shared" };
        const beforeCliTargets = await (await fetch(`${cdpOrigin}/json/list`)).json() as any[];
        if (beforeCliTargets.some(target => target.url?.includes("runtimeProbeInstance=manual-cli"))) {
            throw new Error("Cross-process CLI acceptance requires a dedicated CDP browser without an existing manual-cli page");
        }
        const cli = (args: string[]) => execFileSync(process.execPath, ["-r", "ts-node/register", "runtime-probe.ts", ...args], { env: cliEnv, encoding: "utf8" });
        const cliScreenshot = JSON.parse(cli(["screenshot"]));
        const optionsFile = path.join(os.tmpdir(), `live-probe-stale-${process.pid}.json`);
        const cliBrowser = new CdpCommandClient(version.webSocketDebuggerUrl);
        try {
            const cliScreenshotAgain = JSON.parse(cli(["screenshot"]));
            assert.strictEqual(cliScreenshotAgain.observation.documentId, cliScreenshot.observation.documentId);
            cli(["refresh"]);
            fs.writeFileSync(optionsFile, JSON.stringify({ action: "click", device: "mouse", point: { x: 10, y: 10 }, observation: cliScreenshot.observation }));
            const rejected = spawnSync(process.execPath, ["-r", "ts-node/register", "runtime-probe.ts", "input", "--file", optionsFile], { env: cliEnv, encoding: "utf8" });
            assert.strictEqual(rejected.status, 1);
            assert.match(rejected.stderr, /stale.*page/i);
            evidence.cliProcessRejectsStale = true;
        } finally {
            if (fs.existsSync(optionsFile)) fs.unlinkSync(optionsFile);
            await cliBrowser.send("Target.closeTarget", { targetId: cliScreenshot.targetId });
            cliBrowser.dispose();
        }
        console.log(JSON.stringify({ passed: true, evidence }, null, 2));
    } catch (error) {
        try {
            const debug = await service.dispatch({ kind: "eval", expression: `(async () => {
                const cc = await System.import("cc"), f = globalThis.__liveProbeFixture;
                const r = cc.game.canvas.getBoundingClientRect();
                return { state: f.snapshot(), lastTouch: f.lastTouch, canvas: { width: cc.game.canvas.width, height: cc.game.canvas.height,
                    rect: { left: r.left, top: r.top, width: r.width, height: r.height } }, world: f.node.worldPosition,
                    projected: f.cameraNode.getComponent(cc.Camera).worldToScreen(f.node.worldPosition),
                    camera: { width: f.cameraNode.getComponent(cc.Camera).camera.width, height: f.cameraNode.getComponent(cc.Camera).camera.height },
                    hit: f.node.getComponent(cc.UITransform).hitTest(f.cameraNode.getComponent(cc.Camera).worldToScreen(f.node.worldPosition)), lastMouse: f.lastMouse,
                    viewport: cc.view.getViewportRect(), scale: { x: cc.view.getScaleX(), y: cc.view.getScaleY() } };
            })()` });
            console.error(JSON.stringify({ debug }));
        } catch { /* Preserve the acceptance failure if the page was lost. */ }
        throw error;
    } finally { await service.dispose(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
