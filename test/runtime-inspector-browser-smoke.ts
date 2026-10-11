import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CdpBrowserClient, CdpRuntimeProbe } from "../cdp-runtime-probe-core";
import { createRuntimeProbeWorkspaceDefaults, RuntimeProbeService, runtimeProbeOptionsFromEnv } from "../runtime-probe";
import { buildInspectorExpression, InspectorRequest } from "../runtime-inspector-core";
import { runWorkbenchSmoke } from "./runtime-inspector-workbench-smoke";

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
        assert.strictEqual(await ui.evaluate('document.getElementById("preview-heading").textContent'), "画面快照");
        assert.ok(await ui.evaluate('!document.getElementById("capture-state").hidden && document.getElementById("capture-state").textContent.includes("更新")'), "Static preview reports its capture freshness");
        await ui.send("Page.bringToFront", {});
        await ui.evaluate(`document.getElementById("search").value="EditableNode";document.getElementById("search").dispatchEvent(new Event("input"));
            [...document.querySelectorAll(".row")].find(row=>row.title.endsWith(${JSON.stringify(fixture.uuid)})).click()`);
        await waitUI('document.getElementById("details")?.textContent.includes("UUID:")');
        await edit("position", { x: 30.123456789, y: 0.123456789123, z: 0.000000987654321 });
        await ui.evaluate('document.getElementById("refresh").click()');
        await waitUI('!document.getElementById("details").hasAttribute("aria-busy")');
        const precisePosition = await evaluate('({x:globalThis.__inspectorFixture.node.position.x,y:globalThis.__inspectorFixture.node.position.y,z:globalThis.__inspectorFixture.node.position.z})');
        assert.strictEqual(await ui.evaluate('document.querySelector(\'input[aria-label="位置 x"]\').value'), "30.1235", "Unfocused numeric fields present a readable value");
        await ui.evaluate('document.querySelector(\'input[aria-label="位置 y"]\').focus()');
        assert.strictEqual(await ui.evaluate('document.activeElement.value'), String(precisePosition.y), "Focus reveals full numeric precision");
        assert.strictEqual(await ui.evaluate('document.getElementById("draft-bar").hidden'), true, "Viewing precision does not create a draft");
        await ui.evaluate(`(() => {
            const input=document.querySelector('input[aria-label="位置 x"]');input.value="31";input.dispatchEvent(new Event("input"));
            input.closest(".field").querySelector("button").click();
        })()`);
        await waitUI('document.getElementById("message").textContent.includes("已应用 位置")');
        const afterOneAxis = await evaluate('({x:globalThis.__inspectorFixture.node.position.x,y:globalThis.__inspectorFixture.node.position.y,z:globalThis.__inspectorFixture.node.position.z})');
        assert.strictEqual(afterOneAxis.x, 31);
        assert.strictEqual(afterOneAxis.y, precisePosition.y, "Editing x preserves all original y digits");
        assert.strictEqual(afterOneAxis.z, precisePosition.z, "Editing x preserves tiny z values despite compact scientific notation");
        await ui.evaluate(`(() => {
            const input=document.querySelector('input[aria-label="位置 y"]');input.focus();input.value="0.1235";input.dispatchEvent(new Event("input"));
            input.closest(".field").querySelector("button").click();
        })()`);
        await waitUI('!document.getElementById("details").hasAttribute("aria-busy")');
        assert.strictEqual(await evaluate('globalThis.__inspectorFixture.node.position.y'), 0.1235, "Explicitly entering the compact value commits that exact new number");
        await edit("position", { x: 30, y: 20, z: 0 });
        await ui.evaluate('document.getElementById("refresh").click()');
        await waitUI('!document.getElementById("details").hasAttribute("aria-busy")');
        await ui.evaluate(`(() => {
            const input=document.querySelector('input[aria-label="位置 x"]');input.focus();input.value="30.0";input.dispatchEvent(new Event("input"));
        })()`);
        assert.strictEqual(await ui.evaluate('document.getElementById("draft-bar").hidden'), true, "Equivalent numeric spelling does not create a draft");
        await ui.evaluate('document.activeElement.blur()');
        assert.strictEqual(await ui.evaluate('document.querySelector(\'input[aria-label="位置 x"]\').value'), "30", "Equivalent numeric spelling returns to compact display on blur");
        await ui.evaluate(`(() => {
            const input=document.querySelector('input[aria-label="同级顺序"]');input.focus();input.value=input.value+'.0';input.dispatchEvent(new Event('input'));input.blur();
        })()`);
        assert.strictEqual(await ui.evaluate('document.getElementById("draft-bar").hidden'), true, "Equivalent sibling index spelling does not create a move draft");
        assert.ok(await ui.evaluate('!document.querySelector(\'input[aria-label="同级顺序"]\').value.includes(".")'), "An unchanged sibling index returns to integer presentation on blur");
        await edit("position", { x: 123456789.123456, y: 20, z: 0 });
        await ui.evaluate('document.getElementById("refresh").click()');
        await waitUI('!document.getElementById("details").hasAttribute("aria-busy")');
        assert.strictEqual(await ui.evaluate('document.querySelector(\'input[aria-label="位置 x"]\').value'), "1.23457e8", "Large coordinates use actual scientific notation in narrow numeric controls");
        await ui.evaluate(`(() => {
            const input=document.querySelector('input[aria-label="位置 y"]');input.value="21";input.dispatchEvent(new Event('input'));input.closest('.field').querySelector('button').click();
        })()`);
        await waitUI('!document.getElementById("details").hasAttribute("aria-busy")');
        assert.strictEqual(await evaluate('globalThis.__inspectorFixture.node.position.x'), 123456789.123456, "Applying another axis preserves the full large-coordinate value");
        await edit("position", { x: 30, y: 20, z: 0 });
        await ui.evaluate('document.getElementById("refresh").click()');
        await waitUI('!document.getElementById("details").hasAttribute("aria-busy")');
        await ui.evaluate(`(() => {
            const row=[...document.querySelectorAll(".field")].find(row=>row.firstChild.textContent==="名称");
            row.querySelector("input").value="Pending name";row.querySelector("input").dispatchEvent(new Event("input"));
        })()`);
        await ui.evaluate(`[...document.querySelectorAll(".row")].find(row=>row.dataset.uuid===${JSON.stringify(fixture.parentUuid)}).click()`);
        await waitUI(`document.querySelector(".metadata.uuid")?.textContent.includes(${JSON.stringify(fixture.parentUuid)})`);
        await ui.evaluate(`[...document.querySelectorAll(".row")].find(row=>row.dataset.uuid===${JSON.stringify(fixture.uuid)}).click()`);
        await waitUI(`document.querySelector(".metadata.uuid")?.textContent.includes(${JSON.stringify(fixture.uuid)})`);
        assert.strictEqual(await ui.evaluate('[...document.querySelectorAll(".field")].find(row=>row.firstChild.textContent==="名称").querySelector("input").value'), "Pending name", "Switching nodes preserves unapplied drafts");
        await ui.evaluate(`(() => {
            const row=[...document.querySelectorAll(".field")].find(row=>row.firstChild.textContent==="位置");
            const input=row.querySelector("input"); input.value="42";input.dispatchEvent(new Event("input"));row.querySelector("button").click();
        })()`);
        await waitUI('document.getElementById("message").textContent.includes("已应用 位置")');
        assert.strictEqual(await evaluate("globalThis.__inspectorFixture.node.position.x"), 42);
        assert.strictEqual(await ui.evaluate('[...document.querySelectorAll(".field")].find(row=>row.firstChild.textContent==="名称").querySelector("input").value'), "Pending name", "Applying position preserves the pending name draft");
        assert.strictEqual(await ui.evaluate('document.getElementById("draft-bar").hidden'), false);
        await ui.evaluate('document.querySelector(\'input[aria-label="名称"]\').focus();document.querySelector(\'input[aria-label="名称"]\').setSelectionRange(2,7);document.getElementById("refresh").click()');
        await waitUI('!document.getElementById("details").hasAttribute("aria-busy")');
        assert.deepStrictEqual(await ui.evaluate('({field:document.activeElement.getAttribute("aria-label"),start:document.activeElement.selectionStart,end:document.activeElement.selectionEnd})'),
            { field: "名称", start: 2, end: 7 }, "Refreshing the same node preserves the text draft's caret selection");
        await ui.evaluate('document.getElementById("discard-draft").click()');
        await waitUI('document.getElementById("draft-bar").hidden');
        assert.strictEqual(await ui.evaluate('[...document.querySelectorAll(".field")].find(row=>row.firstChild.textContent==="名称").querySelector("input").value'), "EditableNode");

        await ui.evaluate(`(() => {
            const input=document.querySelector('input[aria-label="同级顺序"]');
            input.value="0.5";input.dispatchEvent(new Event("input"));document.querySelector(".apply-move").click();
        })()`);
        await waitUI('document.getElementById("message").textContent.includes("请输入有效数值")');
        assert.strictEqual(await ui.evaluate('document.querySelector(\'input[aria-label="同级顺序"]\').getAttribute("aria-invalid")'), "true", "Invalid numeric input is exposed to assistive technology");
        await ui.evaluate(`(() => {
            const input=document.querySelector('input[aria-label="同级顺序"]');
            input.value="0";input.dispatchEvent(new Event("input"));document.querySelector(".apply-move").click();
        })()`);
        await waitUI('document.getElementById("message").textContent.includes("层级调整已生效")');
        assert.strictEqual(await ui.evaluate('document.querySelector(\'input[aria-label="同级顺序"]\').hasAttribute("aria-invalid")'), false, "Correcting numeric input clears its invalid state");

        await ui.evaluate('document.querySelector("#details details").open=false');
        await waitUI('!document.querySelector("#details details").open');
        await ui.evaluate('document.getElementById("refresh").click()');
        await waitUI('!document.getElementById("details").hasAttribute("aria-busy")');
        assert.strictEqual(await ui.evaluate('document.querySelector("#details details").open'), false, "Refresh preserves collapsed component groups");

        await ui.evaluate('document.getElementById("components-tab").click();document.getElementById("component-search").value="string";document.getElementById("component-search").dispatchEvent(new Event("input"))');
        assert.ok(await ui.evaluate('[...document.querySelectorAll("#components-panel details:not([hidden]) .component-meta")].every(meta=>meta.textContent.includes("可编辑"))'), "Component headers report editable fields");
        assert.strictEqual(await ui.evaluate('document.getElementById("basic-panel").hidden'), true);
        assert.strictEqual(await ui.evaluate('document.querySelectorAll("#components-panel details:not([hidden])").length'), 1, "Field search reveals the matching component");
        await ui.evaluate(`(() => {
            const row=[...document.querySelectorAll("#components-panel .field")].find(row=>row.dataset.field==="string");
            const input=row.querySelector("input");input.value="Filtered component edit";input.dispatchEvent(new Event("input"));row.querySelector("button").click();
        })()`);
        await waitUI('document.getElementById("message").textContent.includes("已应用 string")');
        assert.strictEqual(await evaluate("globalThis.__inspectorFixture.label.string"), "Filtered component edit");
        assert.strictEqual(await ui.evaluate('document.getElementById("component-search").value'), "string", "Editing preserves component filters");
        await ui.evaluate('document.getElementById("clear-component-search").click();document.getElementById("editable-only").checked=true;document.getElementById("editable-only").dispatchEvent(new Event("change"))');
        assert.ok(await ui.evaluate('[...document.querySelectorAll("#components-panel details:not([hidden]) .field:not([hidden])")].every(row=>row.dataset.editable==="true")'), "Editable filter hides readonly fields");
        await ui.evaluate('document.getElementById("editable-only").checked=false;document.getElementById("editable-only").dispatchEvent(new Event("change"));document.getElementById("collapse-components").click()');
        assert.ok(await ui.evaluate('[...document.querySelectorAll("#components-panel details")].every(group=>!group.open)'));
        await ui.evaluate('document.getElementById("expand-components").click();document.getElementById("basic-tab").click()');
        assert.strictEqual(await ui.evaluate('document.getElementById("components-panel").hidden'), true);

        await ui.evaluate('document.getElementById("search").value="no-such-node";document.getElementById("search").dispatchEvent(new Event("input"))');
        assert.strictEqual(await ui.evaluate('document.querySelectorAll(".row").length'), 0);
        await ui.evaluate('document.getElementById("reveal-selection").click()');
        assert.strictEqual(await ui.evaluate('document.activeElement.dataset.uuid'), fixture.uuid, "Reveal clears search and focuses the selected node");
        await ui.evaluate('document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowUp",bubbles:true}))');
        assert.notStrictEqual(await ui.evaluate('document.activeElement.dataset.uuid'), fixture.uuid, "Arrow keys navigate visible nodes");
        assert.strictEqual(await ui.evaluate(`document.querySelectorAll('.row[tabindex="0"]').length`), 1, "Tree has a single tab stop");
        await ui.evaluate('document.dispatchEvent(new KeyboardEvent("keydown",{key:"k",ctrlKey:true,bubbles:true}))');
        assert.strictEqual(await ui.evaluate('document.activeElement.id'), "search");
        await ui.evaluate(`document.getElementById('expand-all').click();document.querySelector('.row[data-uuid="${fixture.deepUuid}"]').focus();
            document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}))`);
        const deepNodeGeometry = await ui.evaluate(`(() => {
            const row=document.activeElement;const name=row.querySelector('.name').getBoundingClientRect();const tree=document.getElementById('tree').getBoundingClientRect();
            return {uuid:row.dataset.uuid,level:Number(row.getAttribute('aria-level')),nameWidth:name.width,nameLeft:name.left,nameRight:name.right,treeLeft:tree.left,treeRight:tree.right};
        })()`) as any;
        assert.strictEqual(deepNodeGeometry.uuid, fixture.deepUuid);
        assert.ok(deepNodeGeometry.level > 25);
        assert.ok(deepNodeGeometry.nameWidth >= 40 && deepNodeGeometry.nameLeft >= deepNodeGeometry.treeLeft && deepNodeGeometry.nameRight <= deepNodeGeometry.treeRight,
            `Deep node name stays visible when keyboard navigation reveals it: ${JSON.stringify(deepNodeGeometry)}`);
        const deepTreeShot = await ui.send("Page.captureScreenshot", { format: "png" }) as { data: string };
        const deepTreeScreenshot = path.join(os.tmpdir(), "cocos-live-inspector-deep-tree.png");
        fs.writeFileSync(deepTreeScreenshot, Buffer.from(deepTreeShot.data, "base64"));
        await ui.evaluate('document.getElementById("collapse-all").click();document.getElementById("reveal-selection").click()');

        // Typing again while a write is in flight must remain a draft of the same field.
        await ui.evaluate(`(() => {
            const original=window.fetch;
            window.fetch=async(...args)=>{if(JSON.parse(args[1]?.body||"{}").action==="edit") {
                window.fetch=original;await new Promise(resolve=>setTimeout(resolve,250));
            }return original(...args)};
            const row=[...document.querySelectorAll(".field")].find(row=>row.firstChild.textContent==="位置");
            const input=row.querySelector("input");input.focus();input.value="43";input.dispatchEvent(new Event("input"));
            input.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}));
            setTimeout(()=>{input.value="44";input.dispatchEvent(new Event("input"));},50);
        })()`);
        await waitUI('!document.getElementById("details").hasAttribute("aria-busy")');
        assert.strictEqual(await evaluate("globalThis.__inspectorFixture.node.position.x"), 43, "Enter applies the submitted value");
        assert.strictEqual(await ui.evaluate('[...document.querySelectorAll(".field")].find(row=>row.firstChild.textContent==="位置").querySelector("input").value'), "44", "A newer draft survives the pending write");
        assert.strictEqual(await ui.evaluate('document.activeElement.getAttribute("aria-label")'), "位置 x", "Applying with Enter preserves focus on the edited axis");
        await ui.evaluate('document.getElementById("discard-draft").click()');
        await waitUI('document.getElementById("draft-bar").hidden');

        // Delay a poll to exercise a real click while a background request is pending.
        await ui.evaluate(`(() => {
            const original=window.fetch;
            window.fetch=async(...args)=>{if(JSON.parse(args[1]?.body||"{}").action==="tree") {
                window.fetch=original;await new Promise(resolve=>setTimeout(resolve,250));
            }return original(...args)};
            work(()=>refresh(true),true);
        })()`);
        await ui.evaluate('document.getElementById("pause").click()');
        await waitUI('document.getElementById("pause").textContent==="继续游戏"');
        assert.strictEqual(await evaluate('(async()=> (await System.import("cc")).director.isPaused())()'), true);
        await ui.evaluate('document.getElementById("pause").click()');
        await waitUI('document.getElementById("pause").textContent==="暂停游戏"');
        const uiErrors = await ui.evaluate('document.getElementById("message").classList.contains("error")'); assert.strictEqual(uiErrors, false);
        const backgroundRecovery = await ui.evaluate(`(async () => {
            let failures=2, mutations=0;const original=window.fetch;
            const observer=new MutationObserver(records=>{mutations+=records.length});observer.observe(document.getElementById('message'),{childList:true,subtree:true});
            window.fetch=async(...args)=>{if(JSON.parse(args[1]?.body||'{}').action==='tree'&&failures){if(--failures===0)window.fetch=original;
                return new Response(JSON.stringify({error:'临时连接中断'}),{status:503,headers:{'Content-Type':'application/json'}});}return original(...args)};
            await work(()=>refresh(true),true);await work(()=>refresh(true),true);const repeatedFailureMutations=mutations;
            await work(()=>refresh(true),true);observer.disconnect();window.fetch=original;
            const result={repeatedFailureMutations,recovered:!state.syncFailed,error:document.getElementById('message').classList.contains('error'),message:document.getElementById('message').textContent,userMessagePreserved:false};
            window.fetch=async(...args)=>{if(JSON.parse(args[1]?.body||'{}').action==='tree'){window.fetch=original;
                return new Response(JSON.stringify({error:'再次中断'}),{status:503,headers:{'Content-Type':'application/json'}});}return original(...args)};
            await work(()=>refresh(true),true);document.getElementById('pause').click();await workQueue;
            const userMessage=document.getElementById('message').textContent;
            await work(()=>refresh(true),true);result.userMessagePreserved=document.getElementById('message').textContent===userMessage;
            document.getElementById('pause').click();await workQueue;return result;
        })()`) as any;
        assert.strictEqual(backgroundRecovery.repeatedFailureMutations, 1, "Repeated identical polling failures do not repeat live-region announcements");
        assert.strictEqual(backgroundRecovery.recovered, true);
        assert.strictEqual(backgroundRecovery.error, false, "A successful poll clears its own stale error message");
        assert.strictEqual(backgroundRecovery.message, "自动同步已恢复");
        assert.strictEqual(backgroundRecovery.userMessagePreserved, true, "Polling recovery preserves a newer user action's confirmation");
        const messageGeometry = await ui.evaluate(`(()=>{const r=document.querySelector('.canvas').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`);
        await ui.evaluate('message("长诊断内容\\n"+"文件路径与详细说明。".repeat(100),true);document.getElementById("message-details").click()');
        assert.strictEqual(await ui.evaluate('document.getElementById("message-popover").hidden'), false);
        assert.ok(await ui.evaluate('document.getElementById("message-full").textContent.length>900'));
        assert.strictEqual(await ui.evaluate('document.activeElement.id'), "message-full", "Opening details focuses the full message for keyboard scrolling");
        await ui.send("Page.bringToFront", {});
        const copyMessagePoint = await ui.evaluate('(()=>{const r=document.getElementById("copy-message").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()') as { x: number; y: number };
        await ui.send("Input.dispatchMouseEvent", { type: "mousePressed", ...copyMessagePoint, button: "left", clickCount: 1 });
        await ui.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...copyMessagePoint, button: "left", clickCount: 1 });
        await waitUI('document.getElementById("copy-message").textContent==="已复制"');
        assert.strictEqual(await ui.evaluate('document.getElementById("copy-message").textContent'), "已复制", "Long status details can be copied as one message");
        const originalLongMessage = await ui.evaluate('document.getElementById("message-full").textContent');
        await ui.evaluate(`Object.defineProperty(navigator.clipboard,'writeText',{configurable:true,value:async()=>{throw new Error('clipboard denied')}});document.getElementById('copy-message').click()`);
        await waitUI('!document.getElementById("message-copy-error").hidden');
        assert.strictEqual(await ui.evaluate('document.getElementById("message-full").textContent'), originalLongMessage, "Clipboard failure preserves the diagnostic content for manual copying");
        await ui.evaluate('delete navigator.clipboard.writeText');
        assert.deepStrictEqual(await ui.evaluate(`(()=>{const r=document.querySelector('.canvas').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`), messageGeometry);
        await ui.evaluate('document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
        assert.strictEqual(await ui.evaluate('document.getElementById("message-popover").hidden'), true);
        assert.strictEqual(await ui.evaluate('document.activeElement.id'), "message-details", "Escape closes details and returns focus");
        await ui.evaluate('message("状态详情检查通过")');
        const comfortableRowHeight = await ui.evaluate('document.querySelector(".row").getBoundingClientRect().height') as number;
        await ui.send("Page.bringToFront", {});
        await ui.evaluate(`(() => {
            const input=document.querySelector('input[aria-label="名称"]');input.focus();input.value="Density draft";input.dispatchEvent(new Event("input"));
            document.getElementById("density").value="compact";document.getElementById("density").dispatchEvent(new Event("change"));
        })()`);
        const compactRowHeight = await ui.evaluate('document.querySelector(".row").getBoundingClientRect().height') as number;
        assert.ok(compactRowHeight < comfortableRowHeight && compactRowHeight >= 28, "Compact density shows more readable tree rows");
        assert.strictEqual(await ui.evaluate('document.activeElement.value'), "Density draft", "Changing density preserves the focused input and draft");
        assert.strictEqual(await ui.evaluate('state.selected'), fixture.uuid);
        await ui.evaluate('document.getElementById("density").value="comfortable";document.getElementById("density").dispatchEvent(new Event("change"));document.getElementById("discard-draft").click()');
        await waitUI('document.getElementById("draft-bar").hidden && !state.busy');
        await ui.evaluate(`(() => {
            const row=document.querySelector('#basic-panel .field[data-field="active"]');row.querySelector('label').click();
        })()`);
        assert.strictEqual(await ui.evaluate('document.querySelector(\'input[aria-label="激活"]\').checked'), false, "Clicking a boolean field label toggles its checkbox");
        assert.strictEqual(await ui.evaluate('document.getElementById("draft-bar").hidden'), false, "Clicking a boolean label creates an unapplied draft");
        assert.strictEqual(await evaluate('globalThis.__inspectorFixture.node.active'), true, "Label interaction stays a draft until applied");
        await ui.evaluate('document.getElementById("discard-draft").click()');
        await waitUI('document.getElementById("draft-bar").hidden && !state.busy');
        await ui.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
        assert.strictEqual(await ui.evaluate('document.documentElement.scrollWidth<=innerWidth'), true, "Mobile layout fits without horizontal overflow");
        assert.strictEqual(await ui.evaluate('document.querySelector(".properties").getBoundingClientRect().width<=innerWidth'), true);
        assert.strictEqual(await ui.evaluate('document.querySelector("footer").getBoundingClientRect().bottom'), 844, "Mobile status and appearance settings remain at the viewport bottom");
        await ui.send("Emulation.setDeviceMetricsOverride", { width: 1360, height: 900, deviceScaleFactor: 1, mobile: false });
        const themeEvidence: Record<string, unknown> = {};
        await ui.send("DOM.enable", {}); await ui.send("CSS.enable", {});
        for (const theme of ["graphite", "midnight", "light"]) {
            await ui.evaluate(`document.getElementById("theme").value=${JSON.stringify(theme)};document.getElementById("theme").dispatchEvent(new Event("change"))`);
            const contrast = await ui.evaluate(`(() => {
                const rgb=color=>color.match(/[\\d.]+/g).slice(0,3).map(Number);
                const luminance=color=>rgb(color).map(v=>{v/=255;return v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4}).reduce((sum,v,i)=>sum+v*[0.2126,0.7152,0.0722][i],0);
                const ratio=(a,b)=>{const x=luminance(a),y=luminance(b);return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05)};
                const background=el=>{for(let node=el;node;node=node.parentElement){const color=getComputedStyle(node).backgroundColor;if(color!=="rgba(0, 0, 0, 0)")return color}return "rgb(255,255,255)"};
                const selectors=[".row .name",".row .node-state",".field > label",".metadata",".readonly",".vector label","#property-tabs button","#sync-state",".filter",".tree-actions button:not(:disabled)",".engine-state",".node-status",".appearance-control","#theme","#density"];
                const checks=[];
                for(const selector of selectors) for(const el of document.querySelectorAll(selector)) if(el.getClientRects().length) checks.push({selector,ratio:ratio(getComputedStyle(el).color,background(el))});
                const input=document.querySelector('.field input[type="number"]');
                const control=ratio(getComputedStyle(input).borderColor,background(input));
                return {theme:document.documentElement.dataset.theme,text:checks,control};
            })()`) as { theme: string; text: Array<{ selector: string; ratio: number }>; control: number };
            assert.strictEqual(contrast.theme, theme);
            for (const check of contrast.text) assert.ok(check.ratio >= 4.5, `${theme} ${check.selector} text contrast ${check.ratio.toFixed(2)} must meet 4.5:1`);
            assert.ok(contrast.control >= 3, `${theme} numeric input border contrast ${contrast.control.toFixed(2)} must meet 3:1`);
            const shot = await ui.send("Page.captureScreenshot", { format: "png" }) as { data: string };
            const destination = path.join(os.tmpdir(), `cocos-live-inspector-theme-${theme}.png`);
            fs.writeFileSync(destination, Buffer.from(shot.data, "base64"));
            const documentNode = await ui.send("DOM.getDocument", {}) as { root: { nodeId: number } };
            const inactiveNode = await ui.send("DOM.querySelector", { nodeId: documentNode.root.nodeId, selector: `.row[data-uuid="${fixture.inactiveUuid}"]` }) as { nodeId: number };
            await ui.send("CSS.forcePseudoState", { nodeId: inactiveNode.nodeId, forcedPseudoClasses: ["hover"] });
            const inactiveHoverContrast = await ui.evaluate(`(() => {
                const lum=color=>color.match(/[\\d.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
                const row=document.querySelector('.row[data-uuid="${fixture.inactiveUuid}"]');const background=lum(getComputedStyle(row).backgroundColor);
                return ['.name','.node-state'].map(selector=>{const foreground=lum(getComputedStyle(row.querySelector(selector)).color);return(Math.max(foreground,background)+.05)/(Math.min(foreground,background)+.05)});
            })()`) as number[];
            assert.ok(inactiveHoverContrast.every(ratio => ratio >= 4.5), `${theme} inactive hover contrast ${inactiveHoverContrast.map(ratio=>ratio.toFixed(2))} must meet 4.5:1`);
            await ui.send("CSS.forcePseudoState", { nodeId: inactiveNode.nodeId, forcedPseudoClasses: [] });
            await ui.evaluate(`document.querySelector('.row[data-uuid="${fixture.inactiveUuid}"]').click()`);
            await waitUI(`state.selected===${JSON.stringify(fixture.inactiveUuid)} && !state.busy`);
            const selectedInactiveContrast = await ui.evaluate(`(() => {
                const lum=color=>color.match(/[\\d.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
                const row=document.querySelector('.row.selected.inactive'); const background=lum(getComputedStyle(row).backgroundColor);
                return ['.name','.node-state'].map(selector=>{const foreground=lum(getComputedStyle(row.querySelector(selector)).color);return (Math.max(foreground,background)+.05)/(Math.min(foreground,background)+.05)});
            })()`) as number[];
            assert.ok(selectedInactiveContrast.every(ratio => ratio >= 4.5), `${theme} selected inactive text must remain readable`);
            assert.ok(await ui.evaluate('document.querySelector(".row.selected.inactive").getAttribute("aria-label").includes("未激活")'));
            const inactiveShot = await ui.send("Page.captureScreenshot", { format: "png" }) as { data: string };
            fs.writeFileSync(path.join(os.tmpdir(), `cocos-live-inspector-selected-inactive-${theme}.png`), Buffer.from(inactiveShot.data, "base64"));
            await ui.evaluate(`document.querySelector('.row[data-uuid="${fixture.uuid}"]').click()`);
            await waitUI(`state.selected===${JSON.stringify(fixture.uuid)} && !state.busy`);
            themeEvidence[theme] = { minTextContrast: Math.min(...contrast.text.map(check => check.ratio)), selectedInactiveContrast: Math.min(...selectedInactiveContrast), inactiveHoverContrast: Math.min(...inactiveHoverContrast), controlContrast: contrast.control, screenshot: destination };
        }
        await ui.evaluate('document.getElementById("density").value="compact";document.getElementById("density").dispatchEvent(new Event("change"))');
        await ui.send("Page.reload", {});
        await waitUI('document.getElementById("message")?.textContent.includes("已连接")');
        assert.strictEqual(await ui.evaluate('document.documentElement.dataset.theme'), "light", "Appearance survives a panel reload without reloading the game");
        assert.strictEqual(await ui.evaluate('document.documentElement.dataset.density'), "compact", "Density survives a panel reload alongside the theme");
        await ui.evaluate(`document.getElementById("theme").value="graphite";document.getElementById("theme").dispatchEvent(new Event("change"));
            document.getElementById("density").value="comfortable";document.getElementById("density").dispatchEvent(new Event("change"));
            document.getElementById("search").value="EditableNode";document.getElementById("search").dispatchEvent(new Event("input"));
            [...document.querySelectorAll(".row")].find(row=>row.dataset.uuid===${JSON.stringify(fixture.uuid)}).click()`);
        await waitUI(`document.querySelector(".metadata.uuid")?.textContent.includes(${JSON.stringify(fixture.uuid)})`);
        const screenshot = await ui.send("Page.captureScreenshot", { format: "png" }) as { data: string };
        const artifact = path.join(os.tmpdir(), "cocos-live-inspector-acceptance.png"); fs.writeFileSync(artifact, Buffer.from(screenshot.data, "base64"));
        evidence.ui = { url: panel.url, screenshot: artifact, treeSelection: true, transformEdit: true, pauseResume: true,
            preservesOtherDrafts: true, preservesNewerDraft: true, enterToApply: true, discardDraft: true, componentCollapse: true,
            revealSelection: true, keyboardNavigation: true, deepNodeGeometry, deepTreeScreenshot, clickDuringPoll: true, mobileLayout: true, numberValidationRecovery: true,
            draftsAcrossNodes: true, propertyTabs: true, componentFieldSearch: true, filteredComponentEdit: true, editableFilter: true, bulkComponentCollapse: true,
            compactNumbers: true, focusFullPrecision: true, untouchedAxesPreservePrecision: true, explicitRoundedValueEdit: true, equivalentNumericSpelling: true,
            density: { comfortableRowHeight, compactRowHeight, preservesDraftAndFocus: true, reloadRestores: true }, backgroundRecovery, themes: themeEvidence };

        evidence.workbench = await runWorkbenchSmoke(evaluate, expression => ui!.evaluate(expression), waitUI, fixture.uuid);
        await ui.evaluate(`(() => {
            const row=[...document.querySelectorAll(".field")].find(row=>row.firstChild.textContent==="名称");
            const input=row.querySelector("input");input.value="Scene-local draft";input.dispatchEvent(new Event("input"));
        })()`);
        assert.strictEqual(await ui.evaluate('document.querySelectorAll(".row.has-draft").length'), 1, "Tree marks a node with an unapplied draft");
        assert.ok(await ui.evaluate('document.querySelector(".row.has-draft").getAttribute("aria-label").includes("有待应用修改")'), "Draft state is also available without relying on a colored dot");
        await evaluate('(async()=>{const cc=await System.import("cc");cc.director.runSceneImmediate(new cc.Scene("NextInspectorScene"));return true})()');
        await assert.rejects(edit("active", false), /场景已变化/);
        await ui.evaluate('document.getElementById("refresh").click()');
        await waitUI('document.getElementById("scene").textContent==="NextInspectorScene"');
        assert.strictEqual(await ui.evaluate('document.getElementById("draft-bar").hidden'), true, "Scene changes clear old drafts");
        assert.strictEqual(await ui.evaluate('state.nodeDrafts.size'), 0, "Old-scene drafts cannot be restored by UUID");
        assert.strictEqual(await ui.evaluate('document.getElementById("capture-state").hidden'), true, "A new scene clears the old snapshot freshness");
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
