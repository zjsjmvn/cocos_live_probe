import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CdpBrowserClient, CdpRuntimeProbe } from "../cdp-runtime-probe-core";
import { createRuntimeProbeWorkspaceDefaults, RuntimeProbeService, runtimeProbeOptionsFromEnv } from "../runtime-probe";
import { buildInspectorExpression, InspectorRequest } from "../runtime-inspector-core";

async function main() {
    const options = runtimeProbeOptionsFromEnv();
    const cdpOrigin = process.env.COCOS_RUNTIME_PROBE_INSPECTOR_TEST_CDP_ORIGIN || "http://127.0.0.1:9233";
    const identity = createRuntimeProbeWorkspaceDefaults().identity;
    const service = new RuntimeProbeService({ ...options, cdpOrigin,
        chromeProfileDirectory: path.join(os.tmpdir(), `cocos-live-inspector-${identity}-acceptance-chrome`),
        ownership: "isolated", instanceId: "inspector-acceptance" });
    let browser: CdpBrowserClient | undefined; let browserContext: string | undefined; let ui: CdpRuntimeProbe | undefined;
    const evaluate = (expression: string): Promise<any> => service.dispatch({ kind: "eval", expression });
    const inspect = (request: InspectorRequest): Promise<any> => evaluate(buildInspectorExpression(request));
    const evidence: Record<string, unknown> = {};
    try {
        await service.dispatch({ kind: "launch" });
        const fixture = await evaluate(`(async () => {
            const cc = await System.import("cc");
            const scene = new cc.Scene("InspectorFixture");
            const root = new cc.Node("FixtureCanvas"); root.layer = cc.Layers.Enum.UI_2D; scene.addChild(root);
            root.addComponent(cc.UITransform).setContentSize(640, 480); const canvas = root.addComponent(cc.Canvas);
            const cameraNode = new cc.Node("Camera"); cameraNode.layer = cc.Layers.Enum.UI_2D; root.addChild(cameraNode);
            cameraNode.setPosition(0, 0, 1000); const camera = cameraNode.addComponent(cc.Camera);
            camera.projection = cc.Camera.ProjectionType.ORTHO; camera.orthoHeight = 240;
            camera.visibility = cc.Layers.Enum.UI_2D; camera.clearFlags = cc.Camera.ClearFlag.SOLID_COLOR;
            camera.clearColor = new cc.Color(30, 40, 55, 255); canvas.cameraComponent = camera;
            const node = new cc.Node("EditableNode"); node.layer = cc.Layers.Enum.UI_2D; root.addChild(node);
            node.addComponent(cc.UITransform).setContentSize(200, 100);
            const label = node.addComponent(cc.Label); label.overflow = cc.Label.Overflow.CLAMP; label.string = "Inspector"; label.fontSize = 36;
            const parent = new cc.Node("NewParent"); root.addChild(parent); parent.setPosition(80, 20, 0);
            const inactive = new cc.Node("InactiveNode"); root.addChild(inactive); inactive.active = false;
            let deep = root; for (let i=0; i<25; i++) { const child = new cc.Node("Deep"+i); deep.addChild(child); deep=child; }
            globalThis.__inspectorFixture = { scene, root, node, parent, label, inactive };
            cc.director.runSceneImmediate(scene);
            await new Promise(resolve => setTimeout(resolve, 200));
            return { uuid: node.uuid, parentUuid: parent.uuid, labelUuid: label.uuid, inactiveUuid: inactive.uuid, deepUuid: deep.uuid };
        })()`);
        const tree = await inspect({ action: "tree" });
        assert.ok(tree.nodes.some((node: any) => node.uuid === fixture.deepUuid), "Tree includes nodes deeper than the CLI depth limit");
        assert.ok(tree.nodes.some((node: any) => node.uuid === fixture.inactiveUuid && !node.activeInHierarchy));
        const context = tree.context;
        const edit = (field: string, value: unknown, componentUuid?: string) => inspect({ action: "edit", uuid: fixture.uuid, context, field, value, componentUuid });
        await edit("position", { x: 30, y: 40, z: 0 });
        await edit("eulerAngles", { x: 0, y: 0, z: 20 });
        await edit("scale", { x: 2, y: 2, z: 1 });
        await edit("contentSize", { width: 240, height: 120 });
        await edit("anchorPoint", { x: 0.25, y: 0.75 });
        const before = await inspect({ action: "inspect", uuid: fixture.uuid, context });
        assert.strictEqual(before.uiTransform.contentSize.width, 240);
        assert.strictEqual(before.uiTransform.anchorPoint.y, 0.75);
        assert.strictEqual(before.eulerAngles.z, 20);
        const label = before.components.find((component: any) => component.uuid === fixture.labelUuid);
        assert.ok(label.fields.some((field: any) => field.name === "string" && field.editable), JSON.stringify(label));
        await edit("string", "真实组件编辑", fixture.labelUuid);
        assert.strictEqual(await evaluate("globalThis.__inspectorFixture.label.string"), "真实组件编辑");
        const moved = await inspect({ action: "move", uuid: fixture.uuid, context, parentUuid: fixture.parentUuid, siblingIndex: 0, keepWorldTransform: true });
        assert.strictEqual(moved.parentUuid, fixture.parentUuid);
        for (const axis of ["x", "y", "z"]) assert.ok(Math.abs(moved.worldPosition[axis] - before.worldPosition[axis]) < 0.001);
        await assert.rejects(inspect({ action: "move", uuid: fixture.parentUuid, context, parentUuid: fixture.uuid, siblingIndex: 0, keepWorldTransform: true }), /子节点/);
        evidence.engine = { deepTree: true, inactive: true, transform: true, uiTransform: true, component: true, reparentPreservesWorld: true, cyclesRejected: true };

        const panel = await service.dispatch({ kind: "open-inspector" }) as { url: string };
        const reopened = await service.dispatch({ kind: "open-inspector" }) as { url: string };
        assert.strictEqual(reopened.url, panel.url);
        const version = await (await fetch(cdpOrigin + "/json/version")).json() as any;
        browser = new CdpBrowserClient(version.webSocketDebuggerUrl); browserContext = await browser.createBrowserContext();
        const targetId = await browser.createTarget(panel.url, browserContext);
        ui = new CdpRuntimeProbe(`ws://${new URL(cdpOrigin).host}/devtools/page/${targetId}`);
        const waitUI = (expression: string) => ui!.evaluate(`(async () => {
            const end = Date.now()+15000; while(Date.now()<end) { if(${expression}) return true; await new Promise(resolve=>setTimeout(resolve,50)); }
            throw new Error("Inspector UI timed out: " + ${JSON.stringify(expression)} + " | " + document.body?.innerText);
        })()`);
        await waitUI('document.getElementById("message")?.textContent.includes("已连接")');
        await ui.evaluate(`document.getElementById("search").value="EditableNode";document.getElementById("search").dispatchEvent(new Event("input"));
            [...document.querySelectorAll(".row")].find(row=>row.title.endsWith(${JSON.stringify(fixture.uuid)})).click()`);
        await waitUI('document.getElementById("details")?.textContent.includes("UUID:")');
        await ui.evaluate(`(() => {
            const row=[...document.querySelectorAll(".field")].find(row=>row.firstChild.textContent==="位置");
            const input=row.querySelector("input"); input.value="42";input.dispatchEvent(new Event("input"));row.querySelector("button").click();
        })()`);
        await waitUI('document.getElementById("message").textContent.includes("已应用 位置")');
        assert.strictEqual(await evaluate("globalThis.__inspectorFixture.node.position.x"), 42);
        await ui.evaluate('document.getElementById("pause").click()');
        await waitUI('document.getElementById("pause").textContent==="继续游戏"');
        assert.strictEqual(await evaluate('(async()=> (await System.import("cc")).director.isPaused())()'), true);
        await ui.evaluate('document.getElementById("pause").click()');
        await waitUI('document.getElementById("pause").textContent==="暂停游戏"');
        const uiErrors = await ui.evaluate('document.getElementById("message").classList.contains("error")'); assert.strictEqual(uiErrors, false);
        const screenshot = await ui.send("Page.captureScreenshot", { format: "png" }) as { data: string };
        const artifact = path.join(os.tmpdir(), "cocos-live-inspector-acceptance.png"); fs.writeFileSync(artifact, Buffer.from(screenshot.data, "base64"));
        evidence.ui = { url: panel.url, screenshot: artifact, treeSelection: true, transformEdit: true, pauseResume: true };

        await evaluate('(async()=>{const cc=await System.import("cc");cc.director.runSceneImmediate(new cc.Scene("NextInspectorScene"));return true})()');
        await assert.rejects(edit("active", false), /场景已变化/);
        evidence.staleSceneRejected = true;
        await service.dispatch({ kind: "refresh" });
        await assert.rejects(inspect({ action: "resume", context }), /场景已变化/);
        evidence.staleDocumentRejected = true;
        await service.dispose();
        await assert.rejects(fetch(panel.url), /fetch failed/);
        evidence.panelClosedWithSession = true;
        console.log(JSON.stringify(evidence, null, 2));
    } finally {
        ui?.dispose(); if (browser && browserContext) await browser.disposeBrowserContext(browserContext); browser?.dispose(); await service.dispose();
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
