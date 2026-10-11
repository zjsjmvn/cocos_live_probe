import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { app, BrowserWindow, desktopCapturer, WebContentsView } from "electron";
import { RuntimeProbeService } from "../runtime-probe";
import { buildInspectorExpression, InspectorRequest } from "../runtime-inspector-core";
import { parseInteractionCommand } from "../runtime-interaction";
import { InspectorProbeClient } from "../runtime-inspector-bridge";
import { handleRuntimeProbeMcpMessage } from "../runtime-probe-mcp";
import { execFile } from "child_process";
import { promisify } from "util";
import { runWorkbenchSmoke } from "./runtime-inspector-workbench-smoke";

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
    await evaluate('new Promise(resolve=>setTimeout(resolve,50))');
    assert.strictEqual(await evaluate('globalThis.__cocosLiveInspectorPreviewTools && globalThis.__cocosLiveInspectorPreviewTools.selectionUuid'), fixture.uuid,
        "Selecting a node in the tree syncs the selected UUID to the live game");
    assert.ok(await evaluate('Boolean(globalThis.__cocosLiveInspectorPreviewTools?.selectionOutline?.getAttribute("points"))'),
        "Selecting a node in the tree outlines its bounds in the live game");
    const layout = await panel.webContents.executeJavaScript(`(() => {
        const canvas=document.querySelector('.canvas').getBoundingClientRect(), tree=document.getElementById('tree').getBoundingClientRect(),
            search=document.querySelector('.tree-tools').getBoundingClientRect();
        return {canvasTop:canvas.top,treeTop:tree.top,treeBottom:tree.bottom,searchTop:search.top,
            basicVisible:!document.getElementById('basic-panel').hidden,componentsVisible:!document.getElementById('components-panel').hidden};
    })()`);
    assert.strictEqual(layout.canvasTop, 36, "Game starts directly below the compact toolbar");
    assert.strictEqual(layout.treeTop, layout.canvasTop, "Scene tree aligns with the live game");
    assert.ok(layout.searchTop >= layout.treeBottom, "Node search sits below the tree");
    assert.ok(layout.basicVisible && layout.componentsVisible, "Node and component properties share one continuous inspector");
    const clickPanelControl = async (selector: string) => {
        const point = await panel.webContents.executeJavaScript(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
        panel.webContents.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 });
        panel.webContents.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 1 });
        await new Promise(resolve => setTimeout(resolve,100));
    };
    const boundsBeforeMenus = view().getBounds();
    await clickPanelControl('#settings-menu');
    await waitUI('!document.getElementById("inspector-menu").hidden && !document.getElementById("menu-settings").hidden');
    assert.ok(await panel.webContents.executeJavaScript('document.getElementById("theme").getClientRects().length>0'), "Settings exposes appearance controls");
    await clickPanelControl('#close-menu');
    assert.strictEqual(await panel.webContents.executeJavaScript('document.getElementById("inspector-menu").hidden'), true);
    await clickPanelControl('#tree-menu');
    assert.ok(await panel.webContents.executeJavaScript('!document.getElementById("tree-options").hidden'), "Bottom search exposes hierarchy options");
    await clickPanelControl('#tree-menu');
    await clickPanelControl('#evidence-menu');
    await waitUI('!document.getElementById("menu-evidence").hidden && !document.getElementById("inspector-menu").hidden');
    assert.ok(await panel.webContents.executeJavaScript('document.getElementById("evidence-save").getClientRects().length>0'), "Recording menu exposes evidence actions");
    await clickPanelControl('#close-menu');
    assert.deepStrictEqual(view().getBounds(), boundsBeforeMenus, "Menus preserve native game geometry");
    await clickPanelControl('#components-panel details:first-child .component-enabled input');
    assert.ok(await panel.webContents.executeJavaScript('document.querySelector("#components-panel details").open'), "Enabled checkbox leaves its component expanded");
    assert.ok(await panel.webContents.executeJavaScript('!document.getElementById("draft-bar").hidden'), "Component header checkbox creates an unapplied draft");
    assert.strictEqual(await evaluate('(async()=>globalThis.__desktopInspectorFixture.node.getComponent((await System.import("cc")).UITransform).enabled)()'), true,
        "Component header edits preserve the explicit apply step");
    await clickPanelControl('#discard-draft');
    await waitUI('document.getElementById("draft-bar").hidden && !state.busy');
    await panel.webContents.executeJavaScript('document.querySelector(".node-advanced").open=true;document.getElementById("refresh").click()');
    await waitUI('!state.busy && document.querySelector(".node-advanced").open');
    await panel.webContents.executeJavaScript('document.querySelector(".node-advanced").open=false');
    await clickPanelControl('#fps');
    await waitUI('!state.busy && document.getElementById("fps").getAttribute("aria-pressed")==="true"');
    assert.strictEqual(await evaluate('(async()=>(await System.import("cc")).profiler.isShowingStats())()'), true, "FPS button shows the engine profiler");
    await clickPanelControl('#fps'); await waitUI('!state.busy');
    assert.strictEqual(await evaluate('(async()=>(await System.import("cc")).profiler.isShowingStats())()'), false);
    await clickPanelControl('#mute'); await waitUI('!state.busy');
    assert.strictEqual(view().webContents.isAudioMuted(), true, "Sound button mutes the owned game WebContents");
    await clickPanelControl('#mute'); await waitUI('!state.busy');
    assert.strictEqual(view().webContents.isAudioMuted(), false);
    const uiPoint = async (uuid: string, offsetX = 0, offsetY = 0) => evaluate(`(async()=>{
        const cc=await System.import('cc'), scene=cc.director.getScene();let node;
        const stack=[scene];while(stack.length){const n=stack.pop();if(n.uuid===${JSON.stringify(uuid)}){node=n;break}stack.push(...n.children)}
        const camera=scene.getComponentsInChildren(cc.Camera).find(camera=>camera.visibility&node.layer);
        const ui=node.getComponent(cc.UITransform),world=ui.convertToWorldSpaceAR(new cc.Vec3(${offsetX},${offsetY},0)),screen=camera.worldToScreen(world),r=cc.game.canvas.getBoundingClientRect();
        return{x:r.left+screen.x*r.width/cc.game.canvas.width,y:r.bottom-screen.y*r.height/cc.game.canvas.height};
    })()`);
    const gameMouse = (type: "mouseDown" | "mouseUp" | "mouseMove", point: { x: number; y: number }) => {
        view().webContents.sendInputEvent({ type, x: Math.round(point.x), y: Math.round(point.y), button: "left", clickCount: 1 });
    };
    const clicksBeforeTools = await evaluate('globalThis.__desktopInspectorFixture.node.__count');
    await clickPanelControl('#pick'); await waitUI('!state.busy && document.getElementById("pick").getAttribute("aria-pressed")==="true"');
    const pickedPoint = await uiPoint(fixture.uuid, -70, 30);
    view().webContents.focus(); gameMouse("mouseMove", pickedPoint); gameMouse("mouseDown", pickedPoint); gameMouse("mouseUp", pickedPoint);
    await waitUI(`state.selected===${JSON.stringify(fixture.uuid)} && document.getElementById('search').value==='' && !state.busy`);
    assert.strictEqual(await evaluate('globalThis.__desktopInspectorFixture.node.__count'), clicksBeforeTools, "Picker intercepts gestures without clicking the game button");
    assert.strictEqual(await evaluate('globalThis.__cocosLiveInspectorPreviewTools.hover.node.uuid'), fixture.uuid, "Picker hits the displayed UI node");
    await evaluate(`(async()=>{
        const cc=await System.import('cc'),f=globalThis.__desktopInspectorFixture;
        const outer=new cc.Node('OuterLayoutContainer');outer.layer=f.node.layer;f.node.parent.addChild(outer);
        outer.addComponent(cc.UITransform).setContentSize(2000,2000);
        globalThis.__pickerOuterFixture=outer;return true;
    })()`);
    gameMouse("mouseMove", pickedPoint);
    await evaluate('new Promise(resolve=>setTimeout(resolve,100))');
    assert.strictEqual(await evaluate('globalThis.__cocosLiveInspectorPreviewTools.hover?.node.uuid'), fixture.uuid,
        "A later full-screen layout container must not block picking a smaller rendered node");
    const labelUuid = await evaluate('globalThis.__desktopInspectorFixture.node.children[0].uuid');
    const labelPoint = await uiPoint(labelUuid);
    gameMouse("mouseMove", labelPoint);
    await evaluate('new Promise(resolve=>setTimeout(resolve,100))');
    assert.strictEqual(await evaluate('globalThis.__cocosLiveInspectorPreviewTools.hover?.node.uuid'), labelUuid,
        "A small rendered child is picked before its enclosing rendered parent");
    gameMouse("mouseDown", labelPoint); gameMouse("mouseUp", labelPoint);
    await waitUI(`state.selected===${JSON.stringify(labelUuid)} && !state.busy`);
    await evaluate('globalThis.__pickerOuterFixture.destroy();true');
    const maskedUuid = await evaluate(`(async()=>{
        const cc=await System.import('cc'),parent=globalThis.__desktopInspectorFixture.node;
        const maskNode=new cc.Node('PickerMask');maskNode.layer=parent.layer;parent.addChild(maskNode);
        maskNode.addComponent(cc.UITransform).setContentSize(80,60);maskNode.addComponent(cc.Mask);
        const child=new cc.Node('MaskedPickTarget');child.layer=parent.layer;maskNode.addChild(child);
        child.addComponent(cc.UITransform).setContentSize(160,100);
        const graphics=child.addComponent(cc.Graphics);graphics.rect(-80,-50,160,100);graphics.fill();
        globalThis.__pickerMaskFixture={maskNode,child};
        await new Promise(resolve=>setTimeout(resolve,100));return child.uuid;
    })()`);
    const maskedPoint = await uiPoint(maskedUuid, 10, 20);
    gameMouse("mouseMove", maskedPoint);
    await evaluate('new Promise(resolve=>setTimeout(resolve,100))');
    assert.strictEqual(await evaluate('globalThis.__cocosLiveInspectorPreviewTools.hover?.node.uuid'), maskedUuid,
        "Picker selects visible mask content using world coordinates, even when screen coordinates differ");
    gameMouse("mouseDown", maskedPoint); gameMouse("mouseUp", maskedPoint);
    await waitUI(`state.selected===${JSON.stringify(maskedUuid)} && !state.busy`);
    const clippedPoint = await uiPoint(maskedUuid, 65, 35);
    gameMouse("mouseMove", clippedPoint);
    await evaluate('new Promise(resolve=>setTimeout(resolve,100))');
    assert.strictEqual(await evaluate('globalThis.__cocosLiveInspectorPreviewTools.hover?.node.uuid'), fixture.uuid,
        "Picker ignores mask content outside the visible clipping region");
    await evaluate('globalThis.__pickerMaskFixture.maskNode.destroy();true');
    gameMouse("mouseDown", pickedPoint); gameMouse("mouseUp", pickedPoint);
    await waitUI(`state.selected===${JSON.stringify(fixture.uuid)} && !state.busy`);
    // A rotated/scaled parent catches implementations that apply screen deltas
    // directly to local position rather than preserving the world-space grab point.
    await evaluate('(async()=>{const cc=await System.import("cc"),f=globalThis.__desktopInspectorFixture;f.node.setParent(f.parent,true);f.parent.setRotationFromEuler(0,0,25);f.parent.setScale(1.2,.8,1);return true})()');
    const originalWorld = await evaluate('({...globalThis.__desktopInspectorFixture.node.worldPosition})');
    await clickPanelControl('#design'); await waitUI('!state.busy && document.getElementById("design").getAttribute("aria-pressed")==="true"');
    assert.strictEqual(await panel.webContents.executeJavaScript('document.getElementById("pick").getAttribute("aria-pressed")'), "false", "Picking and design mode are mutually exclusive");
    const dragStart = await uiPoint(fixture.uuid, -70, 30), dragEnd = { x: dragStart.x + 45, y: dragStart.y + 20 };
    view().webContents.focus(); gameMouse("mouseDown", dragStart); gameMouse("mouseMove", dragEnd);
    await new Promise(resolve => setTimeout(resolve,120)); gameMouse("mouseUp", dragEnd);
    await waitUI('document.getElementById("message").textContent.includes("已拖拽") && !state.busy');
    const draggedPoint = await uiPoint(fixture.uuid, -70, 30);
    assert.ok(Math.abs(draggedPoint.x - dragEnd.x) < 2 && Math.abs(draggedPoint.y - dragEnd.y) < 2,
        `Drag tracks the pointer through rotated/scaled parents: ${JSON.stringify({ draggedPoint, dragEnd })}`);
    const committedWorld = await evaluate('({...globalThis.__desktopInspectorFixture.node.worldPosition})');
    gameMouse("mouseDown", draggedPoint); gameMouse("mouseMove", { x: draggedPoint.x + 20, y: draggedPoint.y - 15 });
    await new Promise(resolve => setTimeout(resolve,120));
    view().webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" }); view().webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    gameMouse("mouseUp", draggedPoint);
    await waitUI('document.getElementById("design").getAttribute("aria-pressed")==="false"');
    const cancelledWorld = await evaluate('({...globalThis.__desktopInspectorFixture.node.worldPosition})');
    for (const axis of ["x", "y", "z"]) assert.ok(Math.abs(cancelledWorld[axis] - committedWorld[axis]) < 1e-8, "Escape restores the committed position and exits design mode");
    assert.strictEqual(await evaluate('Boolean(document.getElementById("live-probe-design-overlay"))'), false, "Exiting removes the input interception layer");
    await evaluate(`(async()=>{const cc=await System.import('cc'),f=globalThis.__desktopInspectorFixture;f.node.setWorldPosition(new cc.Vec3(${originalWorld.x},${originalWorld.y},${originalWorld.z}));f.parent.setRotationFromEuler(0,0,0);f.parent.setScale(1,1,1);f.node.setParent(f.scene.getChildByName('FixtureCanvas'),true);f.node.setPosition(0,0,0);return true})()`);
    const meshFixture = await evaluate(`(async()=>{
        const cc=await System.import('cc'),scene=cc.director.getScene();
        const node=new cc.Node('Pick3DFixture');node.layer=cc.Layers.Enum.DEFAULT;scene.addChild(node);node.setPosition(2000,0,0);
        const renderer=node.addComponent(cc.MeshRenderer);renderer.mesh=cc.utils.createMesh(cc.primitives.box());
        const cameraNode=new cc.Node('Pick3DCamera');scene.addChild(cameraNode);cameraNode.setPosition(2000,0,10);
        const camera=cameraNode.addComponent(cc.Camera);camera.visibility=cc.Layers.Enum.DEFAULT;camera.priority=1;
        camera.clearFlags=cc.Camera.ClearFlag.DEPTH_ONLY;camera.rect=new cc.Rect(.75,.75,.25,.25);
        globalThis.__pick3DFixture={node,cameraNode};await new Promise(resolve=>setTimeout(resolve,300));
        const screen=camera.worldToScreen(node.worldPosition),r=cc.game.canvas.getBoundingClientRect();
        return{uuid:node.uuid,x:r.left+screen.x*r.width/cc.game.canvas.width,y:r.bottom-screen.y*r.height/cc.game.canvas.height};
    })()`);
    await panel.webContents.executeJavaScript('document.getElementById("pick").dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true}))');
    await waitUI('!state.busy && document.getElementById("pick").classList.contains("pick-3d")');
    view().webContents.focus(); gameMouse("mouseDown", meshFixture); gameMouse("mouseUp", meshFixture);
    await waitUI(`state.selected===${JSON.stringify(meshFixture.uuid)} && !state.busy`);
    assert.strictEqual(await evaluate('globalThis.__cocosLiveInspectorPreviewTools.hover.node.uuid'), meshFixture.uuid, "3D picker selects the model intersected by the camera ray");
    await panel.webContents.executeJavaScript('document.getElementById("pick").dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true}))');
    await waitUI('!state.busy');
    await evaluate('globalThis.__pick3DFixture.node.destroy();globalThis.__pick3DFixture.cameraNode.destroy();true');
    await panel.webContents.executeJavaScript('document.getElementById("refresh").click()'); await waitUI('!state.busy');
    await panel.webContents.executeJavaScript(`document.querySelector('.row[data-uuid="${fixture.uuid}"]').click()`); await waitUI('!state.busy');
    await clickPanelControl('#resolution');
    await panel.webContents.executeJavaScript('document.getElementById("resolution-preset").value="390x844";document.getElementById("resolution-preset").dispatchEvent(new Event("change"))');
    await waitUI('!state.busy && document.getElementById("resolution-state").textContent.includes("390 × 844")');
    const preservedDocument = (await probe.dispatch({ kind: "screenshot" }) as any).observation.documentId;
    const portrait = await evaluate('({width:innerWidth,height:innerHeight})');
    assert.ok(Math.abs(portrait.width - 390) < 3 && Math.abs(portrait.height - 844) < 3, JSON.stringify(portrait));
    await clickPanelControl('#resolution-rotate'); await waitUI('!state.busy && document.getElementById("resolution-state").textContent.includes("844 × 390")');
    const landscape = await evaluate('({width:innerWidth,height:innerHeight})');
    assert.ok(Math.abs(landscape.width - 844) < 3 && Math.abs(landscape.height - 390) < 3, JSON.stringify(landscape));
    assert.strictEqual((await probe.dispatch({ kind: "screenshot" }) as any).observation.documentId, preservedDocument, "Resolution and rotation preserve the current game document");
    await panel.webContents.executeJavaScript('document.getElementById("resolution-preset").value="auto";document.getElementById("resolution-preset").dispatchEvent(new Event("change"))');
    await waitUI('!state.busy'); await clickPanelControl('#resolution-close');
    assert.strictEqual(view().webContents.getZoomFactor(), 1, "Fit-window mode restores native zoom");
    await panel.webContents.executeJavaScript('document.getElementById("refresh").click()'); await waitUI('!state.busy');
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

    const nodeLayout = await panel.webContents.executeJavaScript(`(() => {
        const tree=document.querySelector('.hierarchy').getBoundingClientRect(), properties=document.querySelector('.properties').getBoundingClientRect();
        return {tree:{right:tree.right,top:tree.top,bottom:tree.bottom,width:tree.width},properties:{left:properties.left,top:properties.top,bottom:properties.bottom}};
    })()`);
    assert.ok(nodeLayout.properties.left >= nodeLayout.tree.right && nodeLayout.properties.left - nodeLayout.tree.right <= 6,
        "Properties sit immediately to the right of the hierarchy");
    assert.strictEqual(nodeLayout.tree.top, nodeLayout.properties.top, "Node panels share the full available height");
    assert.strictEqual(nodeLayout.tree.bottom, nodeLayout.properties.bottom);
    const boundsBeforePropertyResize = view().getBounds();
    await panel.webContents.executeJavaScript('document.getElementById("property-splitter").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowLeft",bubbles:true}))');
    assert.ok(await panel.webContents.executeJavaScript('document.querySelector(".hierarchy").getBoundingClientRect().width') < nodeLayout.tree.width,
        "Vertical splitter gives the property inspector more width");
    assert.deepStrictEqual(view().getBounds(), boundsBeforePropertyResize, "Property resizing preserves native game bounds");
    const stableGameBounds = view().getBounds();
    await panel.webContents.executeJavaScript('document.getElementById("components-tab").click()');
    await waitUI('!document.getElementById("components-panel").hidden');
    await new Promise(resolve => setTimeout(resolve,100));
    assert.deepStrictEqual(view().getBounds(), stableGameBounds, "Property tab switches preserve native game bounds");
    const componentScreenshot = path.join(os.tmpdir(), "cocos-live-inspector-components-acceptance.png");
    await captureNativePanel(panel, componentScreenshot);
    await panel.webContents.executeJavaScript('document.getElementById("basic-tab").click();document.getElementById("property-splitter").dispatchEvent(new MouseEvent("dblclick",{bubbles:true}))');
    assert.strictEqual(await panel.webContents.executeJavaScript('document.getElementById("property-splitter").getAttribute("aria-valuenow")'), "45", "Double-click resets the tree/property split");

    const boundsBeforeLongMessage = view().getBounds();
    await panel.webContents.executeJavaScript('message("调试信息：" + "长路径与错误详情。".repeat(80),true)');
    await new Promise(resolve => setTimeout(resolve,150));
    assert.deepStrictEqual(view().getBounds(), boundsBeforeLongMessage, "Long diagnostics preserve native game bounds");
    await panel.webContents.executeJavaScript('document.getElementById("message-details").click()');
    assert.ok(await panel.webContents.executeJavaScript('!document.getElementById("message-popover").hidden && document.getElementById("message-full").textContent.length>600'));
    const messageBounds = await panel.webContents.executeJavaScript('(()=>{const r=document.getElementById("message-popover").getBoundingClientRect();return {left:r.left,right:r.right}})()');
    assert.ok(messageBounds.left >= boundsBeforeLongMessage.x + boundsBeforeLongMessage.width && messageBounds.right <= panel.getContentSize()[0], "Message details stay beside the native game view");
    assert.deepStrictEqual(view().getBounds(), boundsBeforeLongMessage);
    await panel.webContents.executeJavaScript('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));message("长信息检查通过")');
    const boundsBeforeTheme = view().getBounds();
    const comfortableRowHeight = await panel.webContents.executeJavaScript('document.querySelector(".row").getBoundingClientRect().height');
    await panel.webContents.executeJavaScript('document.getElementById("density").value="compact";document.getElementById("density").dispatchEvent(new Event("change"))');
    await new Promise(resolve => setTimeout(resolve,100));
    const compactRowHeight = await panel.webContents.executeJavaScript('document.querySelector(".row").getBoundingClientRect().height');
    assert.ok(compactRowHeight < comfortableRowHeight && compactRowHeight >= 21);
    assert.deepStrictEqual(view().getBounds(), boundsBeforeTheme, "Density changes preserve native game bounds");
    const nativeThemes: Record<string, string> = {};
    for (const theme of ["graphite", "midnight", "light"]) {
        await panel.webContents.executeJavaScript(`document.getElementById("theme").value=${JSON.stringify(theme)};document.getElementById("theme").dispatchEvent(new Event("change"))`);
        await waitUI(`document.documentElement.dataset.theme===${JSON.stringify(theme)}`);
        await new Promise(resolve => setTimeout(resolve,100));
        assert.deepStrictEqual(view().getBounds(), boundsBeforeTheme, "Palette changes preserve native game bounds");
        const file = path.join(os.tmpdir(), `cocos-live-inspector-native-theme-${theme}.png`);
        await captureNativePanel(panel, file); nativeThemes[theme] = file;
    }
    const preferences = JSON.parse(fs.readFileSync(path.join(app.getPath("userData"), "appearance.json"), "utf8"));
    assert.strictEqual(preferences.theme, "light", "Desktop saves appearance in its isolated application profile");
    assert.strictEqual(preferences.density, "compact", "Theme writes preserve the density preference");
    await new Promise<void>(resolve => { panel.webContents.once("did-finish-load", () => resolve()); panel.webContents.reload(); });
    await waitUI('document.getElementById("message").textContent.includes("桌面预览已连接")');
    assert.strictEqual(await panel.webContents.executeJavaScript('document.documentElement.dataset.theme'), "light", "Native panel reload restores persisted appearance");
    assert.strictEqual(await panel.webContents.executeJavaScript('document.documentElement.dataset.density'), "compact", "Native panel reload restores density");
    assert.strictEqual((await probe.dispatch({ kind: "screenshot" }) as any).observation.documentId, preservedShot.observation.documentId, "Reloading Inspector preserves the live game document");
    await panel.webContents.executeJavaScript(`document.getElementById("auto").checked=false;
        document.getElementById("search").value="EditableNode";document.getElementById("search").dispatchEvent(new Event("input"));
        [...document.querySelectorAll(".row")].find(row=>row.dataset.uuid===${JSON.stringify(fixture.uuid)}).click()`);
    await waitUI('document.getElementById("details").textContent.includes("UUID:")');
    await panel.webContents.executeJavaScript('document.getElementById("theme").value="graphite";document.getElementById("theme").dispatchEvent(new Event("change"))');
    await panel.webContents.executeJavaScript('document.getElementById("density").value="comfortable";document.getElementById("density").dispatchEvent(new Event("change"))');

    panel.setSize(960, 640);
    await waitUI(`innerWidth===${panel.getContentSize()[0]} && innerHeight===${panel.getContentSize()[1]}`);
    await panel.webContents.executeJavaScript('for(let i=0;i<12;i++) document.getElementById("splitter").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true}))');
    assert.ok(await panel.webContents.executeJavaScript('document.querySelector(".properties").getBoundingClientRect().width>=359'), "Splitter keeps properties usable at the minimum window size");
    assert.ok(await panel.webContents.executeJavaScript('document.getElementById("inspector-tabs").scrollWidth<=document.getElementById("inspector-tabs").clientWidth'), "Toolbar fits the minimum window width");
    assert.ok(await panel.webContents.executeJavaScript('document.querySelector("footer").getBoundingClientRect().bottom<=innerHeight'), "Footer remains visible at the minimum window height");
    assert.ok(await panel.webContents.executeJavaScript('document.getElementById("tree").clientHeight>=90'), "Compact hierarchy leaves space for navigating multiple rows");
    const narrowVector = await panel.webContents.executeJavaScript(`(() => {
        const row=document.querySelector('#basic-panel .vector-field');const label=row.querySelector(':scope > label').getBoundingClientRect();
        const inputs=[...row.querySelectorAll('input')].map(input=>{const r=input.getBoundingClientRect();return {width:r.width,top:r.top,bottom:r.bottom,right:r.right}});
        return {labelTop:label.top,labelBottom:label.bottom,inputs,panelRight:document.querySelector('.properties').getBoundingClientRect().right};
    })()`);
    assert.ok(narrowVector.inputs.every((input: any) => input.width >= 55 && input.top < narrowVector.labelBottom && input.bottom > narrowVector.labelTop && input.right < narrowVector.panelRight),
        `Compact vectors keep the label and readable axes on the same row: ${JSON.stringify(narrowVector)}`);
    await new Promise(resolve => setTimeout(resolve,300));
    const compactBounds = await panel.webContents.executeJavaScript('(()=>{const r=document.querySelector(".canvas").getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()');
    for (const field of ["x", "y", "width", "height"] as const) assert.ok(Math.abs(view().getBounds()[field] - compactBounds[field]) < 2, `Native preview fits compact layout: ${field}`);
    await captureNativePanel(panel, path.join(os.tmpdir(), "cocos-live-inspector-compact-acceptance.png"));
    await panel.webContents.executeJavaScript("document.querySelector('#basic-panel .vector-field').scrollIntoView({block:'start'})");
    await captureNativePanel(panel, path.join(os.tmpdir(), "cocos-live-inspector-narrow-vectors.png"));
    await panel.webContents.executeJavaScript('document.getElementById("splitter").dispatchEvent(new MouseEvent("dblclick",{bubbles:true}))');
    assert.strictEqual(await panel.webContents.executeJavaScript('document.getElementById("splitter").getAttribute("aria-valuenow")'),
        String(Math.round(Math.min(0.46, 1 - 585 / panel.getContentSize()[0]) * 100)), "Double-click resets the split within the panel width limits");
    panel.setSize(width + 140, height + 80);
    await waitUI(`innerWidth===${panel.getContentSize()[0]} && innerHeight===${panel.getContentSize()[1]}`);
    await new Promise(resolve => setTimeout(resolve,300));

    const workbenchEvidence = await runWorkbenchSmoke(evaluate, expression => panel.webContents.executeJavaScript(expression), waitUI, fixture.uuid,
        name => captureNativePanel(panel, path.join(os.tmpdir(), `cocos-live-inspector-workbench-${name}.png`)));
    await panel.webContents.executeJavaScript('document.getElementById("simple-mode").click()');
    await waitUI('document.body.classList.contains("simple-mode")');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(view().getBounds().width > panel.getContentSize()[0] - 10, "Simple mode expands the same native game");
    await panel.webContents.executeJavaScript('document.getElementById("restore-panels").click()');
    await waitUI('!document.body.classList.contains("simple-mode")');
    assert.strictEqual((await probe.dispatch({ kind: "screenshot" }) as any).observation.documentId, preservedShot.observation.documentId);
    const storedPreferences = await panel.webContents.executeJavaScript('liveProbeDesktop.preferences({action:"get"})');
    await panel.webContents.executeJavaScript('preferenceControls.get("showIcons").checked=false;preferenceControls.get("showIcons").dispatchEvent(new Event("change"))');
    await waitUI('document.body.classList.contains("hide-node-icons")');
    assert.strictEqual((await panel.webContents.executeJavaScript('liveProbeDesktop.preferences({action:"get"})')).showIcons, false, "Preferences are saved in the native project configuration");
    await panel.webContents.executeJavaScript('preferenceControls.get("showIcons").checked=true;preferenceControls.get("showIcons").dispatchEvent(new Event("change"))');
    await waitUI('!document.body.classList.contains("hide-node-icons")');
    await panel.webContents.executeJavaScript(`document.querySelector('input[aria-label="分辨率预设名称"]').value="Acceptance preset";
        document.getElementById("resolution-width").value="640";document.getElementById("resolution-height").value="960";
        [...document.querySelectorAll(".saved-resolution-controls button")].find(button=>button.textContent==="保存预设").click()`);
    await waitUI('Boolean(document.querySelector("#resolution-preset option[data-saved]"))');
    assert.ok((await panel.webContents.executeJavaScript('liveProbeDesktop.preferences({action:"get"})')).resolutions.some((profile: any) => profile.name === "Acceptance preset" && profile.width === 640 && profile.height === 960));
    await panel.webContents.executeJavaScript(`(async()=>{await liveProbeDesktop.preferences({action:"set",value:${JSON.stringify(storedPreferences)}});applyPreferences(${JSON.stringify(storedPreferences)});return true})()`);
    await evaluate('document.cookie="__probe_cache_acceptance=value;path=/";true');
    assert.ok((await evaluate('document.cookie')).includes("__probe_cache_acceptance"));
    await panel.webContents.executeJavaScript('liveProbeDesktop.previewTool({action:"cache",operation:"cookies"})');
    assert.ok(!(await evaluate('document.cookie')).includes("__probe_cache_acceptance"));
    await panel.webContents.executeJavaScript('liveProbeDesktop.previewTool({action:"cache",operation:"http"})');
    assert.strictEqual((await probe.dispatch({ kind: "screenshot" }) as any).observation.documentId, preservedShot.observation.documentId, "Cache cleanup preserves the game document");
    workbenchEvidence.desktopSettings = true; workbenchEvidence.savedResolutions = true; workbenchEvidence.cacheCleanup = true; workbenchEvidence.simpleMode = true;
    const screenshot = path.join(os.tmpdir(), "cocos-live-inspector-desktop-acceptance.png");
    await captureNativePanel(panel, screenshot);
    await probe.dispatch({ kind: "refresh" });
    await assert.rejects(inspect({ action: "edit", uuid: fixture.uuid, context: tree.context, field: "active", value: false }), /场景已变化/);
    const evidence = { transport: "native Electron", sameTarget: true, aiMcpSameTarget: true, aiAttachPreservesDocument: true, crossProcessCli: true,
        aiInputSameGame: true, aiDisconnectPreservesWindow: true, realMouse: true, realKeyboard: true, propertyEdit: true, reparent: true,
        pause: true, resize: true, diagnostics: true, devtools: true, embeddedDevTools: true, devToolsSameGame: true,
        devToolsNoExtraWindow: true, devToolsTabsPreserveSelection: true, devToolsResize: true, compactLayout: true, splitterReset: true,
        propertyWidthResize: true, continuousProperties: true, bottomSearch: true, compactToolbar: true, toolMenus: true,
        componentHeaderDraft: true, nodeInfoExpansionPreserved: true, fpsToggle: true, audioMute: true, uiPicking: true,
        modelPicking3d: true, designDrag: true, rotatedParentDrag: true, escapeCancelsDrag: true, previewResolution: true, rotateWithoutReload: true,
        componentScreenshot, nativeThemes, workbench: workbenchEvidence, refreshRejectsOldEdits: true, screenshot, devToolsScreenshot };
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
