"use strict";
const $ = id => document.getElementById(id);
const state = { tree: null, selected: null, expanded: new Set(), snapshot: null, busy: false, dirty: false };
const token = document.querySelector('meta[name="inspector-token"]').content;
const desktop = window.liveProbeDesktop;
let ownedEvidenceRun = null;
$("evidence-start").onclick = () => work(async () => {
    const run = await api({ action: "evidence", request: { action: "start", label: "Inspector 调试" } });
    ownedEvidenceRun = run.runId;
    $("evidence-state").textContent = "记录中 · " + run.runId;
    message("已开始记录当前窗口的调试操作");
});
$("evidence-save").onclick = () => work(async () => {
    const status = await api({ action: "status" });
    let runId = status.evidence?.activeRunId;
    let finish = Boolean(runId && runId === ownedEvidenceRun);
    if (!runId) {
        const run = await api({ action: "evidence", request: { action: "start", label: "Inspector 当前现场" } });
        runId = run.runId; finish = true; ownedEvidenceRun = runId;
    }
    if (finish) {
        try { await api({ action: "screenshot" }); } catch (error) { message("画面采集失败，保存已有证据：" + error.message, true); }
    }
    const saved = await api({ action: "evidence", request: { action: finish ? "finish" : "export", runId } });
    if (finish) ownedEvidenceRun = null;
    $("evidence-state").textContent = `${saved.runId} · ${saved.runState === "in-progress" ? "仍在记录" : "已结束"} · ${saved.evidenceStatus === "partial" ? "部分证据" : "证据完整"}`;
    message("验收包：" + saved.manifestPath + (saved.missing?.length ? "；" + saved.missing.join("；") : ""));
});
function message(text, error = false) { $("message").textContent = text; $("message").classList.toggle("error", error); }
async function api(payload) {
    const response = await fetch("/api", { method: "POST", headers: { "Content-Type": "application/json", "X-Inspector-Token": token }, body: JSON.stringify(payload) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    return result;
}
async function work(task) {
    if (state.busy) return;
    state.busy = true;
    const controls = [...document.querySelectorAll("button")].filter(button => !button.disabled);
    controls.forEach(button => { button.disabled = true; });
    try { await task(); }
    catch (error) { message(error.message, true); }
    finally { state.busy = false; controls.filter(button => button.isConnected).forEach(button => { button.disabled = false; }); $("pause").disabled = !state.tree; }
}
function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
}
function emptySelection(text) {
    state.selected = null; state.snapshot = null; state.dirty = false;
    document.body.classList.remove("has-selection");
    $("details").replaceChildren(element("p", text, "empty"));
}
function renderTree() {
    if (!state.tree) return;
    const query = $("search").value.trim().toLowerCase();
    const nodes = state.tree.nodes;
    const byId = new Map(nodes.map(node => [node.uuid, node]));
    const paths = new Map();
    function pathOf(node) {
        if (paths.has(node.uuid)) return paths.get(node.uuid);
        const chain = []; let current = node;
        while (current && !paths.has(current.uuid)) { chain.push(current); current = byId.get(current.parentUuid); }
        let path = current ? paths.get(current.uuid) : "";
        while (chain.length) { const item = chain.pop(); path += "/" + item.name; paths.set(item.uuid, path); }
        return paths.get(node.uuid);
    }
    const visible = new Set(); const matches = new Set();
    for (const node of nodes) {
        if (!$("inactive").checked && !node.activeInHierarchy && node.parentUuid) continue;
        if (!query || node.name.toLowerCase().includes(query) || node.uuid.toLowerCase().includes(query) || pathOf(node).toLowerCase().includes(query)) {
            matches.add(node.uuid);
            for (let current = node; current && !visible.has(current.uuid); current = byId.get(current.parentUuid)) visible.add(current.uuid);
        }
    }
    const children = new Map();
    for (const node of nodes) {
        const list = children.get(node.parentUuid) || []; list.push(node); children.set(node.parentUuid, list);
    }
    const rows = document.createDocumentFragment();
    const stack = (children.get(null) || []).slice().reverse().map(node => ({ node, depth: 0 }));
    while (stack.length) {
        const { node, depth } = stack.pop();
        if (!visible.has(node.uuid)) continue;
        const row = element("div", undefined, "row"); row.style.paddingLeft = `${depth * 16 + 8}px`;
        row.classList.toggle("inactive", !node.activeInHierarchy); row.classList.toggle("selected", state.selected === node.uuid);
        row.setAttribute("role", "treeitem"); row.setAttribute("aria-level", depth + 1); row.setAttribute("aria-selected", String(state.selected === node.uuid));
        row.tabIndex = 0; row.title = pathOf(node) + "\n" + node.uuid;
        const open = Boolean(query) || state.expanded.has(node.uuid);
        const toggle = element("button", node.childCount ? open ? "▾" : "▸" : "·", "toggle");
        toggle.setAttribute("aria-label", open ? "折叠子节点" : "展开子节点"); toggle.disabled = !node.childCount;
        if (node.childCount) row.setAttribute("aria-expanded", String(open));
        toggle.onclick = event => { event.stopPropagation(); if (state.expanded.has(node.uuid)) state.expanded.delete(node.uuid); else state.expanded.add(node.uuid); renderTree(); };
        row.append(toggle, element("span", node.name || "(未命名)", "name"));
        if (node.childCount) row.append(element("span", String(node.childCount), "children-count"));
        const select = () => work(async () => {
            state.selected = node.uuid; state.dirty = false; state.snapshot = null;
            $("details").replaceChildren(element("p", "正在读取节点…", "empty")); renderTree();
            const snapshot = await api({ action: "inspect", uuid: node.uuid, context: state.tree.context });
            renderDetails(snapshot); message("已选择 " + snapshot.path);
        });
        row.onclick = select;
        row.onkeydown = event => {
            if (event.target !== row) return;
            if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(); }
            if (event.key === "ArrowRight") { state.expanded.add(node.uuid); renderTree(); }
            if (event.key === "ArrowLeft") { state.expanded.delete(node.uuid); renderTree(); }
        };
        rows.append(row);
        if (open) for (const child of (children.get(node.uuid) || []).slice().reverse()) stack.push({ node: child, depth: depth + 1 });
    }
    $("tree").replaceChildren(rows);
    if (!$("tree").childElementCount) $("tree").append(element("p", "没有匹配的节点", "empty"));
    $("count").textContent = query ? `${matches.size} / ${nodes.length}` : String(nodes.length);
}
async function refresh(auto = false) {
    const tree = await api({ action: "tree" });
    const changed = state.tree?.context !== tree.context;
    state.tree = tree;
    if (changed) {
        emptySelection("选择节点以查看和调整属性"); state.expanded.clear();
        for (const node of tree.nodes) if (!node.parentUuid || tree.nodes[0]?.uuid === node.parentUuid) state.expanded.add(node.uuid);
        $("shot").hidden = true; $("shot-hint").hidden = false;
    }
    $("scene").textContent = tree.scene; $("pause").textContent = tree.paused ? "继续游戏" : "暂停游戏";
    renderTree();
    if (state.selected && !tree.nodes.some(node => node.uuid === state.selected)) emptySelection("所选节点已移除，请重新选择");
    if (state.selected && !state.dirty && (!auto || !$("details").contains(document.activeElement))) {
        renderDetails(await api({ action: "inspect", uuid: state.selected, context: tree.context }));
    }
    if (!auto) message(`节点树已更新 · ${tree.nodes.length} 个节点`);
}
async function capture() {
    const shot = await api({ action: "screenshot" }); $("shot").src = shot.image; $("shot").hidden = false; $("shot-hint").hidden = true;
    $("shot").title = `${shot.imageWidth} × ${shot.imageHeight} · ${new Date().toLocaleTimeString()}`;
}
function renderDetails(snapshot) {
    state.snapshot = snapshot; state.dirty = false;
    document.body.classList.add("has-selection");
    const panel = $("details"); panel.replaceChildren();
    panel.append(element("h3", snapshot.name || "(未命名)"), element("p", snapshot.path, "metadata"), element("p", "UUID: " + snapshot.uuid, "metadata"),
        element("p", "层级激活: " + snapshot.activeInHierarchy, "metadata"));
    function field(title, name, value, editable = true, componentUuid) {
        const row = element("div", undefined, "field"); const label = element("label", title); row.append(label);
        if (!editable) { row.append(element("span", typeof value === "object" ? JSON.stringify(value) : String(value), "readonly")); panel.append(row); return; }
        const inputs = []; let getValue;
        const input = (initial, type) => {
            const control = element("input"); control.type = type;
            if (type === "checkbox") control.checked = initial; else control.value = initial;
            if (type === "number") control.step = "any";
            control.setAttribute("aria-label", title); control.oninput = () => { state.dirty = true; }; inputs.push(control); return control;
        };
        if (value && typeof value === "object") {
            const group = element("div", undefined, "vector"); const axes = Object.keys(value);
            for (const axis of axes) { const axisLabel = element("label", axis); axisLabel.append(input(value[axis], "number")); group.append(axisLabel); }
            row.append(group); getValue = () => Object.fromEntries(axes.map((axis, index) => [axis, numberValue(inputs[index])]));
        } else {
            const type = typeof value === "boolean" ? "checkbox" : typeof value === "number" ? "number" : "text";
            const control = input(value, type); row.append(control); label.onclick = () => control.focus();
            getValue = () => type === "checkbox" ? control.checked : type === "number" ? numberValue(control) : control.value;
        }
        const apply = element("button", "应用"); row.append(apply);
        apply.onclick = () => work(async () => {
            const result = await api({ action: "edit", uuid: snapshot.uuid, context: snapshot.context, field: name, value: getValue(), ...(componentUuid ? { componentUuid } : {}) });
            renderDetails(result); await refresh(); if (!$("shot").hidden) await capture(); message(`已应用 ${title} · 仅运行时生效`);
        }); panel.append(row);
    }
    field("名称", "name", snapshot.name); field("激活", "active", snapshot.active);
    panel.append(element("h3", "Transform"));
    field("位置", "position", snapshot.position); field("旋转 / °", "eulerAngles", snapshot.eulerAngles); field("缩放", "scale", snapshot.scale);
    field("世界位置", "worldPosition", snapshot.worldPosition, false);
    if (snapshot.uiTransform) { panel.append(element("h3", "UITransform")); field("尺寸", "contentSize", snapshot.uiTransform.contentSize); field("锚点", "anchorPoint", snapshot.uiTransform.anchorPoint); }
    if (snapshot.parentUuid) {
        panel.append(element("h3", "节点层级"));
        const parentRow = element("div", undefined, "field"); parentRow.append(element("label", "父节点"));
        const select = element("select"); select.setAttribute("aria-label", "父节点");
        const descendants = new Set([snapshot.uuid]);
        for (const node of state.tree.nodes) if (descendants.has(node.parentUuid)) descendants.add(node.uuid);
        for (const node of state.tree.nodes) {
            if (descendants.has(node.uuid)) continue;
            const option = element("option", node.name + " · " + node.uuid); option.value = node.uuid; option.selected = node.uuid === snapshot.parentUuid; select.append(option);
        }
        parentRow.append(select); panel.append(parentRow);
        const indexRow = element("div", undefined, "field"); indexRow.append(element("label", "同级顺序"));
        const order = element("input"); order.type = "number"; order.min = "0"; order.step = "1"; order.value = snapshot.siblingIndex; order.setAttribute("aria-label", "同级顺序"); indexRow.append(order); panel.append(indexRow);
        select.onchange = () => { state.dirty = true; order.value = "0"; }; order.oninput = () => { state.dirty = true; };
        const options = element("label", undefined, "move-options"); const keepWorld = element("input"); keepWorld.type = "checkbox"; keepWorld.checked = true;
        options.append(keepWorld, document.createTextNode("改变父节点时保持世界 Transform")); panel.append(options);
        const move = element("button", "应用层级调整", "apply-move"); panel.append(move);
        move.onclick = () => work(async () => {
            const result = await api({ action: "move", uuid: snapshot.uuid, context: snapshot.context, parentUuid: select.value,
                siblingIndex: numberValue(order), keepWorldTransform: keepWorld.checked });
            state.expanded.add(select.value); renderDetails(result); await refresh(); if (!$("shot").hidden) await capture(); message("层级调整已生效 · 仅运行时生效");
        });
    }
    panel.append(element("h3", `组件 (${snapshot.components.length})`));
    for (const component of snapshot.components) {
        const group = element("details"); group.open = true; group.append(element("summary", component.type));
        const start = panel.childNodes.length;
        for (const property of component.fields) field(property.name, property.name, property.value, property.editable, component.uuid);
        while (panel.childNodes.length > start) group.append(panel.childNodes[start]);
        panel.append(group);
    }
}
function numberValue(input) { const value = input.valueAsNumber; if (!Number.isFinite(value)) throw new Error("请输入有限数值"); return value; }
$("refresh").onclick = () => work(() => refresh());
$("capture").onclick = () => work(async () => { await capture(); message("画面已更新"); });
$("pause").onclick = () => work(async () => {
    const result = await api({ action: state.tree.paused ? "resume" : "pause", context: state.tree.context });
    state.tree.paused = result.paused; $("pause").textContent = result.paused ? "继续游戏" : "暂停游戏";
    message(result.paused ? desktop ? "引擎更新已暂停 · 可直接调整节点" : "引擎更新已暂停；可调整节点并更新画面" : "游戏已继续");
});
$("search").oninput = renderTree; $("inactive").onchange = renderTree;
$("deselect").onclick = () => { emptySelection("选择节点以查看和调整属性"); renderTree(); };
if (desktop) {
    $("ai-connect").hidden = false; $("ai-activity").hidden = false; $("ai-activity").textContent = "AI 可接入";
    $("ai-connect").onclick = async () => {
        try { const connection = await desktop.copyAIConnection(state.selected); message("已复制 AI 接入说明 · 把它和 bug 描述一起发给 AI"); $("ai-connect").title = "当前实例: " + connection.instanceId; }
        catch (error) { message(error.message, true); }
    };
    desktop.onAIActivity(activity => {
        const labels = { status: "检查连接", "scene-tree": "读取节点树", find: "查找节点", node: "读取节点属性", animations: "读取动画", diagnostics: "读取日志", screenshot: "读取画面", input: "发送游戏输入", wait: "等待状态", refresh: "重载游戏", launch: "连接游戏", eval: "执行诊断脚本", "eval-file": "执行诊断文件", "sample-animation": "采样动画" };
        $("ai-activity").textContent = "探针: " + (labels[activity.kind] || "检查游戏");
        $("ai-activity").title = new Date(activity.at).toLocaleTimeString();
    });
    $("capture").hidden = true; $("reload-preview").hidden = false; $("devtools").hidden = false; $("splitter").hidden = false;
    $("auto").checked = true;
    $("shot-hint").textContent = "正在载入游戏预览…";
    const canvas = document.querySelector(".preview .canvas");
    const devToolsHost = $("devtools-host");
    const updateBounds = () => {
        const rect = canvas.getBoundingClientRect(); desktop.setPreviewBounds({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
        const tools = devToolsHost.getBoundingClientRect(); desktop.setDevToolsBounds({ x: tools.x, y: tools.y, width: tools.width, height: tools.height });
    };
    const observer = new ResizeObserver(updateBounds); observer.observe(canvas); observer.observe(devToolsHost);
    window.addEventListener("resize", updateBounds); updateBounds();
    $("inspector-tabs").hidden = false;
    function showPanel(mode) {
        const tools = mode === "devtools"; document.body.classList.toggle("devtools-active", tools); devToolsHost.hidden = !tools;
        $("nodes-tab").setAttribute("aria-selected", String(!tools)); $("devtools-tab").setAttribute("aria-selected", String(tools));
        $("devtools").setAttribute("aria-pressed", String(tools)); updateBounds();
        $("close-devtools").hidden = !tools;
    }
    async function selectPanel(mode) {
        showPanel(mode);
        try { await desktop.selectPanel(mode); }
        catch (error) { showPanel("nodes"); message(error.message, true); }
    }
    desktop.onPanelMode(showPanel);
    $("nodes-tab").onclick = () => selectPanel("nodes");
    $("devtools-tab").onclick = () => selectPanel("devtools");
    $("close-devtools").onclick = async () => {
        try { await desktop.closeDevTools(); showPanel("nodes"); }
        catch (error) { message(error.message, true); }
    };
    $("reload-preview").onclick = () => work(async () => { await desktop.reloadPreview(); await refresh(); message("当前桌面游戏实例已重载"); });
    $("devtools").onclick = () => selectPanel(document.body.classList.contains("devtools-active") ? "nodes" : "devtools");
    let dragging = false;
    function splitAt(width) {
        const fraction = Math.max(0.3, Math.min(0.7, width)); document.body.style.setProperty("--preview-width", `${fraction * 100}%`); updateBounds();
    }
    $("splitter").onpointerdown = event => { dragging = true; $("splitter").setPointerCapture(event.pointerId); };
    $("splitter").onpointermove = event => { if (dragging) splitAt(event.clientX / window.innerWidth); };
    $("splitter").onpointerup = () => { dragging = false; };
    $("splitter").onlostpointercapture = () => { dragging = false; };
    $("splitter").onkeydown = event => {
        if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return; event.preventDefault();
        splitAt(canvas.getBoundingClientRect().width / window.innerWidth + (event.key === "ArrowLeft" ? -0.025 : 0.025));
    };
}
setInterval(() => { if ($("auto").checked && !document.hidden && !state.busy) work(() => refresh(true)); }, 1000);
work(async () => {
    await refresh(); const status = await api({ action: "status" });
    $("connection").textContent = `人工调试实例: ${status.instance?.id || "manual-cli"} · Target: ${status.instance?.target?.id || "未知"} · 场景: ${state.tree.scene}`;
    if (desktop) document.title = `Cocos Live Probe Inspector · ${state.tree.scene}`;
    else await capture();
    message(desktop ? "桌面预览已连接 · 左侧直接操作游戏，右侧选择节点调试" : "已连接 · 选择节点开始调试");
});
