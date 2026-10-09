import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { BrowserWindow, desktopCapturer, WebContentsView } from "electron";
import { RuntimeProbeService } from "../runtime-probe";
import { buildInspectorExpression, InspectorRequest } from "../runtime-inspector-core";
import { parseInteractionCommand } from "../runtime-interaction";
import { InspectorProbeClient } from "../runtime-inspector-bridge";
import { handleRuntimeProbeMcpMessage } from "../runtime-probe-mcp";
import { execFile } from "child_process";
import { promisify } from "util";

export async function runDesktopInspectorSmoke(panel: BrowserWindow, probe: RuntimeProbeService, view: () => WebContentsView,
    bridge: { workspaceRoot: string; instanceId: string; cliRoot: string; devToolsView: () => WebContentsView | undefined }): Promise<void> {
    const evaluate = (expression: string): Promise<any> => probe.dispatch({ kind: "eval", expression });
    const inspect = (request: InspectorRequest): Promise<any> => evaluate(buildInspectorExpression(request));
    const waitUI = async (expression: string) => {
        const end = Date.now() + 45000;
        while (Date.now() < end) {
            if (await panel.webContents.executeJavaScript(expression)) return true;
            await new Promise(resolve => setTimeout(resolve,50));
        }
        throw new Error("Desktop UI timed out: " + expression + " | " + await panel.webContents.executeJavaScript("document.body.innerText"));
    };
    // Await game startup in the main process before polling the panel renderer;
    // pending renderer execution can otherwise delay Creator's module startup.
    await probe.dispatch({ kind: "launch" });
    await waitUI('document.getElementById("message").textContent.includes("桌面预览已连接")');
    const fixture = await evaluate(`(async () => {
        const cc=await System.import("cc"); const scene=new cc.Scene("DesktopInspectorFixture");
        const root=new cc.Node("FixtureCanvas");root.layer=cc.Layers.Enum.UI_2D;scene.addChild(root);
        root.addComponent(cc.UITransform).setContentSize(640,480);const canvas=root.addComponent(cc.Canvas);
        const cameraNode=new cc.Node("Camera");cameraNode.layer=cc.Layers.Enum.UI_2D;root.addChild(cameraNode);cameraNode.setPosition(0,0,1000);
        const camera=cameraNode.addComponent(cc.Camera);camera.projection=cc.Camera.ProjectionType.ORTHO;camera.orthoHeight=240;
        camera.visibility=cc.Layers.Enum.UI_2D;camera.clearFlags=cc.Camera.ClearFlag.SOLID_COLOR;camera.clearColor=new cc.Color(22,25,36,255);canvas.cameraComponent=camera;
        const node=new cc.Node("EditableNode");node.layer=cc.Layers.Enum.UI_2D;root.addChild(node);
        node.addComponent(cc.UITransform).setContentSize(200,100);const graphics=node.addComponent(cc.Graphics);
        graphics.fillColor=new cc.Color(60,180,120,255);graphics.rect(-100,-50,200,100);graphics.fill();
        node.addComponent(cc.Button).transition=cc.Button.Transition.NONE;
        node.__count=0;node.on(cc.Button.EventType.CLICK,()=>node.__count++);
        const labelNode=new cc.Node("Label");labelNode.layer=cc.Layers.Enum.UI_2D;node.addChild(labelNode);
        labelNode.addComponent(cc.UITransform);const label=labelNode.addComponent(cc.Label);label.string="Native live preview";label.fontSize=20;
        const parent=new cc.Node("NewParent");root.addChild(parent);parent.setPosition(40,0,0);
        globalThis.__desktopInspectorFixture={scene,node,parent,keys:[]};
        window.addEventListener("keydown",event=>globalThis.__desktopInspectorFixture.keys.push(event.key),true);
        cc.director.runSceneImmediate(scene);await new Promise(resolve=>setTimeout(resolve,200));return {uuid:node.uuid,parentUuid:parent.uuid};
    })()`);
    // Disable polling during explicit UI steps to prevent an automatic request taking the button click.
    await panel.webContents.executeJavaScript('document.getElementById("auto").checked=false;document.getElementById("refresh").click()');
    await waitUI('document.getElementById("scene").textContent==="DesktopInspectorFixture"');
    const status = await probe.dispatch({ kind: "status" }) as any;
    console.log("Desktop acceptance: game and fixture ready");
    assert.strictEqual(status.instance.target.id, String(view().webContents.id), "Panel and live game must use the exact same native WebContents");
    const shot = await probe.dispatch({ kind: "screenshot", waitForRender: true }) as any;
    assert.strictEqual(shot.render.status, "rendered", JSON.stringify(shot));
    await panel.webContents.executeJavaScript('document.getElementById("evidence-start").click()');
    await waitUI('document.getElementById("evidence-state").textContent.includes("记录中")');
    const ai = new RuntimeProbeService({ workspaceRoot: bridge.workspaceRoot, dependencies: {
        spawnChrome: () => { throw new Error("AI attachment must never start Chrome"); },
        createEvaluator: () => { throw new Error("AI attachment must never create its own preview"); },
    } });
    try {
        const rpc: any = await handleRuntimeProbeMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/call",
            params: { name: "runtime_inspector_connect", arguments: { instanceId: bridge.instanceId } } }, command => ai.dispatch(command));
        assert.ok(!rpc.result.isError, JSON.stringify(rpc));
        const connected = JSON.parse(rpc.result.content[0].text);
        assert.strictEqual(connected.instance.id, status.instance.id);
        assert.strictEqual(connected.instance.target.id, status.instance.target.id);
        const borrowedShot = await ai.dispatch({ kind: "screenshot" }) as any;
        assert.strictEqual(borrowedShot.observation.documentId, shot.observation.documentId, "Attaching preserves the bug document");
        const node: any = await ai.dispatch({ kind: "node", selector: fixture.uuid }); assert.strictEqual(node.uuid, fixture.uuid);
        const cli = await promisify(execFile)("node", ["-r", "ts-node/register", "runtime-probe.ts", "--inspector", "--instance-id", bridge.instanceId, "node", fixture.uuid],
            { cwd: bridge.cliRoot, env: { ...process.env, COCOS_RUNTIME_PROBE_WORKSPACE_ROOT: bridge.workspaceRoot }, timeout: 15000, windowsHide: true });
        assert.strictEqual(JSON.parse(cli.stdout).uuid, fixture.uuid, "A separate CLI process reads the native game, not Chrome");
        const borrowedInput = await ai.dispatch(parseInteractionCommand("input", { action: "click", device: "mouse", point: { uuid: fixture.uuid }, observation: borrowedShot.observation })) as any;
        assert.strictEqual(borrowedInput.status, "sent");
        assert.strictEqual(borrowedInput.deliveryEvidence.hit, "hit", JSON.stringify(borrowedInput));
        assert.strictEqual(borrowedInput.deliveryEvidence.nodes[0].uuid, fixture.uuid);
        assert.strictEqual(await evaluate("globalThis.__desktopInspectorFixture.node.__count"), 1, "AI input reaches the same game");
        await evaluate("globalThis.__desktopInspectorFixture.node.__count=0;true");
        await ai.dispatch({ kind: "inspector-disconnect" });
    } finally { await ai.dispose(); }
    assert.ok(!view().webContents.isDestroyed(), "AI disconnect/EOF does not close the human's window");
    const input = await probe.dispatch(parseInteractionCommand("input", { action: "click", device: "mouse", point: { uuid: fixture.uuid }, observation: shot.observation })) as any;
    assert.strictEqual(input.status, "sent", JSON.stringify(input));
    assert.strictEqual(input.deliveryEvidence.hit, "hit", JSON.stringify(input));
    assert.strictEqual(await evaluate("globalThis.__desktopInspectorFixture.node.__count"), 1);
    view().webContents.sendInputEvent({ type: "mouseDown", x: Math.round(input.point.x), y: Math.round(input.point.y), button: "left", clickCount: 1 });
    view().webContents.sendInputEvent({ type: "mouseUp", x: Math.round(input.point.x), y: Math.round(input.point.y), button: "left", clickCount: 1 });
    await evaluate("new Promise(resolve=>setTimeout(resolve,100))");
    assert.strictEqual(await evaluate("globalThis.__desktopInspectorFixture.node.__count"), 2, "Native view receives direct mouse events");
    panel.focus(); view().webContents.focus();
    await new Promise(resolve => setTimeout(resolve,150));
    view().webContents.sendInputEvent({ type: "keyDown", keyCode: "A" }); view().webContents.sendInputEvent({ type: "keyUp", keyCode: "A" });
    await evaluate("new Promise(resolve=>setTimeout(resolve,50))");
    assert.ok((await evaluate("globalThis.__desktopInspectorFixture.keys")).length > 0,
        JSON.stringify({ windowFocused: panel.isFocused(), gameFocused: view().webContents.isFocused(),
            document: await evaluate("({focus:document.hasFocus(),active:document.activeElement?.tagName,frame:window===window.top})") }));
    await panel.webContents.executeJavaScript(`document.getElementById("search").value="EditableNode";document.getElementById("search").dispatchEvent(new Event("input"));
        [...document.querySelectorAll(".row")].find(row=>row.title.endsWith(${JSON.stringify(fixture.uuid)})).click()`);
    await waitUI('document.getElementById("details").textContent.includes("UUID:")');
    await panel.webContents.executeJavaScript(`(() => {const row=[...document.querySelectorAll(".field")].find(row=>row.firstChild.textContent==="位置");
        const input=row.querySelector("input");input.value="42";input.dispatchEvent(new Event("input"));row.querySelector("button").click();})()`);
    await waitUI('document.getElementById("message").textContent.includes("已应用 位置")');
    assert.strictEqual(await evaluate("globalThis.__desktopInspectorFixture.node.position.x"), 42);
    await panel.webContents.executeJavaScript('document.getElementById("pause").click()');
    await waitUI('document.getElementById("pause").textContent==="继续游戏"');
    assert.strictEqual(await evaluate('(async()=>(await System.import("cc")).director.isPaused())()'), true);
    assert.strictEqual((await probe.dispatch({ kind: "render-ready", timeoutMs: 200 }) as any).status, "rendered");
    await waitUI('!document.getElementById("evidence-save").disabled');
    await panel.webContents.executeJavaScript('document.getElementById("evidence-save").click()');
    await waitUI('document.getElementById("evidence-state").textContent.includes("已结束")');
    const savedPath = await panel.webContents.executeJavaScript('document.getElementById("message").textContent.slice("验收包：".length).split("；")[0]');
    const savedManifest = JSON.parse(fs.readFileSync(savedPath, "utf8"));
    assert.strictEqual(savedManifest.runState, "finished");
    assert.ok(savedManifest.commands.some((command: any) => command.kind === "input"));
    assert.strictEqual(await evaluate('(async()=>(await System.import("cc")).director.isPaused())()'), true, "export preserves the paused human scene");
    assert.strictEqual((await probe.dispatch({ kind: "screenshot" }) as any).observation.documentId, shot.observation.documentId);
    const tree = await inspect({ action: "tree" });
    const before = await inspect({ action: "inspect", uuid: fixture.uuid, context: tree.context });
    const moved = await inspect({ action: "move", uuid: fixture.uuid, context: tree.context, parentUuid: fixture.parentUuid, siblingIndex: 0, keepWorldTransform: true });
    assert.ok(Math.abs(moved.worldPosition.x - before.worldPosition.x) < 0.001);
    const [width, height] = panel.getSize(); panel.setSize(width + 80, height + 40);
    console.log("Desktop acceptance: AI attachment, input and node edits passed");
    await waitUI(`innerWidth===${panel.getContentSize()[0]} && innerHeight===${panel.getContentSize()[1]}`);
    await new Promise(resolve => setTimeout(resolve,300));
    const expectedBounds = await panel.webContents.executeJavaScript('(()=>{const r=document.querySelector(".canvas").getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()');
    const bounds = view().getBounds();
    for (const field of ["x", "y", "width", "height"] as const) assert.ok(Math.abs(bounds[field] - expectedBounds[field]) < 2, `Native bounds follow window resize: ${field} ${JSON.stringify({bounds,expectedBounds})}`);
    const after = (await probe.dispatch({ kind: "diagnostics", limit: 1000 }) as any).nextCursor;
    await evaluate('console.warn("native-inspector-smoke-diagnostics");new Promise(resolve=>setTimeout(()=>resolve(true),50))');
    const diagnostics = await probe.dispatch({ kind: "diagnostics", after, limit: 1000 }) as any;
    assert.ok(diagnostics.records.some((record: any) => record.message.includes("native-inspector-smoke-diagnostics")), JSON.stringify(diagnostics));
    await panel.webContents.executeJavaScript('document.getElementById("devtools").click()');
    console.log("Desktop acceptance: opening embedded DevTools");
    await waitUI('document.body.classList.contains("devtools-active")');
    const toolsDeadline = Date.now() + 15000;
    while (!view().webContents.isDevToolsOpened() && Date.now() < toolsDeadline) await new Promise(resolve => setTimeout(resolve,50));
    const tools = bridge.devToolsView(); assert.ok(tools, "DevTools has an embedded native view");
    assert.strictEqual(view().webContents.devToolsWebContents, tools.webContents, "Embedded DevTools inspects the game WebContents");
    assert.deepStrictEqual(BrowserWindow.getAllWindows().map(item => item.id), [panel.id], "Opening DevTools creates no separate window");
    // Exercise the real DevTools protocol connection, not the probe's evaluator.
    const consoleResult = await tools.webContents.executeJavaScript(`(async()=>{
        const SDK=await import("./core/sdk/sdk.js");
        const target=SDK.TargetManager.TargetManager.instance().primaryPageTarget();
        const result=await target.runtimeAgent().invoke_evaluate({expression:"globalThis.__desktopInspectorFixture.node.uuid",returnByValue:true});
        return {value:result.result?.value,error:result.error};
    })()`);
    assert.strictEqual(consoleResult.value, fixture.uuid, "DevTools console uses the same live game");
    const preservedShot = await probe.dispatch({ kind: "screenshot" }) as any;
    console.log("Desktop acceptance: DevTools connected to the same game");
    assert.strictEqual(preservedShot.observation.documentId, shot.observation.documentId, "Opening DevTools preserves the game document");
    panel.setSize(width + 140, height + 80);
    await waitUI(`innerWidth===${panel.getContentSize()[0]} && innerHeight===${panel.getContentSize()[1]}`);
    await panel.webContents.executeJavaScript('document.getElementById("splitter").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true}))');
    await new Promise(resolve => setTimeout(resolve,300));
    const host = await panel.webContents.executeJavaScript('(()=>{const r=document.getElementById("devtools-host").getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()');
    for (const field of ["x", "y", "width", "height"] as const) assert.ok(Math.abs(tools.getBounds()[field] - host[field]) < 2, `Embedded DevTools follows resize/split: ${field}`);
    const devToolsScreenshot = path.join(os.tmpdir(), "cocos-live-inspector-devtools-acceptance.png");
    await captureNativePanel(panel, devToolsScreenshot);
    console.log("Desktop acceptance: embedded layout and capture passed");
    await panel.webContents.executeJavaScript('document.getElementById("nodes-tab").click()');
    await waitUI('!document.body.classList.contains("devtools-active")');
    assert.strictEqual(bridge.devToolsView(), tools, "Tab switching retains the loaded DevTools");
    assert.ok(!tools.getVisible());
    assert.ok(await panel.webContents.executeJavaScript('document.getElementById("details").textContent.includes("UUID:")'), "Tab switching preserves selected node");
    await panel.webContents.executeJavaScript('document.getElementById("devtools-tab").click()');
    await waitUI('document.body.classList.contains("devtools-active")');
    assert.strictEqual(bridge.devToolsView(), tools); assert.ok(tools.getVisible());
    await inspect({ action: "tree" });
    await panel.webContents.executeJavaScript('document.getElementById("close-devtools").click()');
    await waitUI('!document.body.classList.contains("devtools-active")');
    assert.strictEqual(bridge.devToolsView(), undefined, "Closing DevTools releases its native view");
    await evaluate('console.warn("native-inspector-after-devtools");new Promise(resolve=>setTimeout(()=>resolve(true),50))');
    const afterDevTools = await probe.dispatch({ kind: "diagnostics", after: diagnostics.nextCursor, limit: 1000 }) as any;
    assert.ok(afterDevTools.records.some((record: any) => record.message.includes("native-inspector-after-devtools")), "Diagnostics resume after DevTools opens/closes");

    const screenshot = path.join(os.tmpdir(), "cocos-live-inspector-desktop-acceptance.png");
    await captureNativePanel(panel, screenshot);
    await probe.dispatch({ kind: "refresh" });
    await assert.rejects(inspect({ action: "edit", uuid: fixture.uuid, context: tree.context, field: "active", value: false }), /场景已变化/);
    const evidence = { transport: "native Electron", sameTarget: true, aiMcpSameTarget: true, aiAttachPreservesDocument: true, crossProcessCli: true,
        aiInputSameGame: true, aiDisconnectPreservesWindow: true, realMouse: true, realKeyboard: true, propertyEdit: true, reparent: true,
        pause: true, resize: true, diagnostics: true, devtools: true, embeddedDevTools: true, devToolsSameGame: true,
        devToolsNoExtraWindow: true, devToolsTabsPreserveSelection: true, devToolsResize: true, refreshRejectsOldEdits: true, screenshot, devToolsScreenshot };
    const report = path.join(os.tmpdir(), "cocos-live-inspector-desktop-acceptance.json"); fs.writeFileSync(report, JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence, null, 2));
    const client = await InspectorProbeClient.connect(bridge.workspaceRoot, bridge.instanceId);
    assert.strictEqual((await client.dispatch({ kind: "status" }) as any).instance.target.id, String(view().webContents.id));
}

async function captureNativePanel(panel: BrowserWindow, destination: string): Promise<void> {
    // Capture the actual native window, including all child WebContentsViews.
    // A renderer's capturePage only captures that page, excluding native siblings.
    const [width, height] = panel.getSize();
    const sources = await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width, height } });
    const source = sources.find(item => item.id === panel.getMediaSourceId());
    assert.ok(source && !source.thumbnail.isEmpty(), "Native window screenshot is available");
    fs.writeFileSync(destination, source.thumbnail.toPNG());
}
