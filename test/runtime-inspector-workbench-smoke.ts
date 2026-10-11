import * as assert from "assert";

export async function runWorkbenchSmoke(game: (expression: string) => Promise<any>, panel: (expression: string) => Promise<any>,
    waitPanel: (expression: string) => Promise<any>, restoreUuid: string, capture?: (name: string) => Promise<void>): Promise<Record<string, boolean>> {
    const wait = async (expression: string) => {
        try { return await waitPanel(expression); }
        catch (error) { throw new Error(`Workbench waiting for ${expression}: ${error}; panel: ${JSON.stringify(await panel('({message:document.getElementById("message").textContent,mode:bench.mode,busy:state.busy,logCount:bench.logs.length})'))}`); }
    };
    const fixture = await game(`(async () => {
        const cc = await System.import("cc");
        class Fixture extends cc.Component { tint = new cc.Color(10,20,30,40); direction = new cc.Vec3(1,2,3); choice = 0; numbers = [1,2]; target = null; }
        cc._decorator.property(cc.Color)(Fixture.prototype,"tint");cc._decorator.property(cc.Vec3)(Fixture.prototype,"direction");
        cc._decorator.property({type:cc.Enum({First:0,Second:1})})(Fixture.prototype,"choice");
        cc._decorator.property([Number])(Fixture.prototype,"numbers");cc._decorator.property(cc.Node)(Fixture.prototype,"target");
        cc._decorator.ccclass("LiveProbeWorkbenchFixture")(Fixture);
        const scene=cc.director.getScene(),node=new cc.Node("WorkbenchNode"),target=new cc.Node("WorkbenchTarget"),parent=new cc.Node("WorkbenchParent");
        scene.addChild(node);scene.addChild(target);scene.addChild(parent);node.addComponent(cc.UITransform);target.addComponent(cc.UITransform);
        const component=node.addComponent(Fixture);component.target=target;
        const asset=new cc.JsonAsset();asset.name="WorkbenchLoadedAsset";asset.json={test:true};cc.assetManager.assets.add("workbench-fixture-asset",asset);
        globalThis.__workbenchFixture={node,target,parent,component,asset};
        return {uuid:node.uuid,targetUuid:target.uuid,parentUuid:parent.uuid,paused:cc.director.isPaused(),frameRate:cc.game.frameRate};
    })()`);
    await panel('document.getElementById("auto").checked=false;document.getElementById("refresh").click()');
    await wait('!state.busy && state.tree.nodes.some(node=>node.name==="WorkbenchNode")');
    const context = await panel("state.tree.context");
    const request = (payload: unknown) => panel(`api(${JSON.stringify(payload)})`);
    await panel(`revealNode(${JSON.stringify(fixture.uuid)})`); await wait('!state.busy');
    await panel('selectPropertyTab("components")');
    const snapshot = await request({ action: "inspect", uuid: fixture.uuid, context });
    const fields = snapshot.components.find((component: any) => component.type === "LiveProbeWorkbenchFixture").fields;
    assert.strictEqual(fields.find((field: any) => field.name === "tint").type, "color", JSON.stringify(fields));
    assert.strictEqual(fields.find((field: any) => field.name === "choice").type, "enum", JSON.stringify(fields));
    assert.ok(await panel(`(() => { const row=document.querySelector('.field[data-field=tint]');const r=row.getBoundingClientRect();return [...row.querySelectorAll('input[type=number]')].every(input=>{const b=input.getBoundingClientRect();return b.width>=25 && b.right<=r.right && b.left>=r.left}); })()`), "All RGBA channels are visible inside their field");
    assert.ok(await panel('getComputedStyle(document.querySelector(".field[data-field=target] .reference-link")).opacity==="1"'), "References are visible without hovering");
    await panel(`(() => { const color=document.querySelector('input[aria-label="tint 色板"]');color.value="#aabbcc";color.dispatchEvent(new Event("input"));color.closest(".field").querySelector("button").click(); })()`);
    await wait('!state.busy && document.getElementById("message").textContent.includes("已应用 tint")');
    assert.deepStrictEqual(await game('({r:__workbenchFixture.component.tint.r,g:__workbenchFixture.component.tint.g,b:__workbenchFixture.component.tint.b,a:__workbenchFixture.component.tint.a})'), { r: 170, g: 187, b: 204, a: 40 });
    await panel('(() => { const select=document.querySelector("select[aria-label=choice]");select.value="1";select.dispatchEvent(new Event("change"));select.closest(".field").querySelector("button").click(); })()');
    await wait('!state.busy && document.getElementById("message").textContent.includes("已应用 choice")');
    assert.strictEqual(await game("__workbenchFixture.component.choice"), 1);
    await panel('document.getElementById("component-search").value="numbers.1";document.getElementById("component-search").dispatchEvent(new Event("input"))');
    assert.ok(await panel('document.querySelector(".structured-field[data-field=numbers]").open'));
    await panel('clearComponentSearch()');
    assert.ok(!(await panel('document.querySelector(".structured-field[data-field=numbers]").open')), "Clearing a field search restores the array collapse state");
    await panel(`(() => { const input=document.querySelector('input[aria-label="numbers.1"]');input.closest(".structured-field").open=true;input.value="8";input.dispatchEvent(new Event("input"));input.closest(".field").querySelector("button").click(); })()`);
    await wait('!state.busy && document.getElementById("message").textContent.includes("已应用 numbers.1")');
    assert.strictEqual(await game("__workbenchFixture.component.numbers[1]"), 8);
    if (capture) await capture("fields");
    console.log("Workbench acceptance: real typed fields passed");
    await panel('document.querySelector(".field[data-field=target] .reference-link").click()');
    await wait(`!state.busy && state.selected===${JSON.stringify(fixture.targetUuid)}`);
    await panel('document.getElementById("search-mode").value="component";document.getElementById("search-exact").checked=true;document.getElementById("search").value="LiveProbeWorkbenchFixture";document.getElementById("search").dispatchEvent(new Event("input"))');
    assert.ok(await panel(`Boolean(document.querySelector('.row[data-uuid="${fixture.uuid}"]'))`));
    assert.ok(!(await panel(`Boolean(document.querySelector('.row[data-uuid="${fixture.targetUuid}"]'))`)));
    await panel('document.getElementById("search-mode").value="node";document.getElementById("search-exact").checked=false;document.getElementById("search").value="";document.getElementById("expand-all").click()');
    await panel(`(() => {const dataTransfer=new DataTransfer();document.querySelector('.row[data-uuid="${fixture.targetUuid}"]').dispatchEvent(new DragEvent("dragstart",{bubbles:true,dataTransfer}));document.querySelector('.row[data-uuid="${fixture.parentUuid}"]').dispatchEvent(new DragEvent("drop",{bubbles:true,dataTransfer}));})()`);
    await wait('!state.busy && document.getElementById("message").textContent.includes("已改变父节点")');
    assert.strictEqual(await game("__workbenchFixture.target.parent.uuid"), fixture.parentUuid);
    console.log("Workbench acceptance: references, component search and hierarchy passed");
    await panel('document.getElementById("info-tab").click()');
    await wait('!state.busy && document.getElementById("workbench-content").textContent.includes("场景 / 渲染")');
    assert.ok(await panel('bench.result.version.startsWith("3.8.")'));
    assert.strictEqual(await panel('document.getElementById("info-tab").getAttribute("aria-selected")'), "true");
    if (capture) await capture("info");
    await panel('(() => {const rate=document.querySelector("input[aria-label=目标帧率]");rate.value="30";[...document.querySelectorAll("#workbench-content button")].find(button=>button.textContent==="应用帧率").click();})()');
    await wait('!state.busy && bench.result.frameRate===30');
    await request({ action: "runtime-setting", context, name: "frameRate", value: fixture.frameRate });
    await panel('document.getElementById("workbench-section").value="assets";document.getElementById("workbench-section").dispatchEvent(new Event("change"))');
    await wait('!state.busy && Boolean(document.querySelector("input[aria-label=搜索已加载资源]"))');
    await panel('document.querySelector("input[aria-label=搜索已加载资源]").value="WorkbenchLoadedAsset";[...document.querySelectorAll("#workbench-content button")].find(button=>button.textContent==="搜索").click()');
    await wait('!state.busy && bench.result.assets?.some(asset=>asset.name==="WorkbenchLoadedAsset")');
    assert.strictEqual(await panel('bench.result.matched'), 1);
    if (capture) await capture("assets");
    await panel('document.getElementById("workbench-section").value="storage";document.getElementById("workbench-section").dispatchEvent(new Event("change"))');
    await wait('!state.busy && Boolean(document.querySelector("input[aria-label=存储键]"))');
    const key = "__probe_workbench_acceptance";
    await panel(`document.querySelector("input[aria-label=存储键]").value=${JSON.stringify(key)};document.querySelector("textarea[aria-label=存储值]").value="UI saved";[...document.querySelectorAll("#workbench-content button")].find(button=>button.textContent==="保存键值").click()`);
    await wait('!state.busy && document.getElementById("message").textContent.includes("已保存")');
    assert.strictEqual(await game(`localStorage.getItem(${JSON.stringify(key)})`), "UI saved");
    await game(`localStorage.setItem(${JSON.stringify(key)},"game changed");true`);
    await panel(`document.querySelector("input[aria-label=存储键]").value=${JSON.stringify(key)};document.querySelector("textarea[aria-label=存储值]").value="stale overwrite";[...document.querySelectorAll("#workbench-content button")].find(button=>button.textContent==="保存键值").click()`);
    await wait('!state.busy && document.getElementById("message").textContent.includes("存储值已变化")');
    assert.strictEqual(await game(`localStorage.getItem(${JSON.stringify(key)})`), "game changed");
    await request({ action: "storage", operation: "remove", context, key, expected: "game changed" });
    await game('console.warn("WorkbenchLogSentinel");true'); await panel('document.getElementById("logs-tab").click()');
    await wait('!state.busy && bench.logs.some(log=>log.message.includes("WorkbenchLogSentinel"))');
    await panel('document.getElementById("log-search").value="WorkbenchLogSentinel";document.getElementById("log-search").dispatchEvent(new Event("input"));document.getElementById("log-level").value="warn";document.getElementById("log-level").dispatchEvent(new Event("change"))');
    assert.ok(await panel('document.getElementById("log-list").textContent.includes("WorkbenchLogSentinel")'));
    if (capture) await capture("logs");
    assert.strictEqual(await game('(async()=>{const cc=await System.import("cc");return cc.director.isPaused()})()'), fixture.paused);
    await panel(`revealNode(${JSON.stringify(fixture.uuid)})`); await wait('!state.busy && bench.mode==="nodes"');
    await panel(`document.querySelector('.row[data-uuid="${fixture.uuid}"]').dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,clientX:700,clientY:140}));[...document.querySelectorAll("#node-menu button")].find(button=>button.textContent.includes("$probeNode")).click()`);
    await wait('!state.busy && document.getElementById("message").textContent.includes("$probeNode")');
    assert.strictEqual(await game("$probeNode.uuid"), fixture.uuid);
    await panel(`document.querySelector('.row[data-uuid="${fixture.uuid}"]').dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,clientX:700,clientY:140}));[...document.querySelectorAll("#node-menu button")].find(button=>button.textContent.includes("移除运行时")).click();document.getElementById("runtime-confirm-apply").click()`);
    await wait('!state.busy && document.getElementById("message").textContent.includes("已移除运行时")');
    assert.ok(await game('(async()=>{const cc=await System.import("cc");return !cc.isValid(__workbenchFixture.node,true)})()'));
    await game('(async()=>{const cc=await System.import("cc");cc.assetManager.assets.remove("workbench-fixture-asset");__workbenchFixture.asset.destroy();__workbenchFixture.parent.destroy();return true})()');
    await panel('document.getElementById("refresh").click()'); await wait('!state.busy');
    await panel(`revealNode(${JSON.stringify(restoreUuid)})`); await wait('!state.busy');
    return { typedColor: true, realEnums: true, arrayElementEdit: true, referenceNavigation: true, componentSearch: true, hierarchyDrag: true,
        engineInfo: true, frameRate: true, loadedAssets: true, storageEdit: true, staleStorageRejected: true, filteredLogs: true, contextMenu: true, runtimeRemoval: true };
}
