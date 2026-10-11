"use strict";
// Uses the same authenticated API, scene credentials and action queue as the inspector.
const bench = { mode: "nodes", result: null, context: null, assetsOffset: 0, assetsQuery: "", logs: [], cursor: 0,
    logQuery: "", logLevel: "all", logFollow: true, storageDraft: null, dragging: null };
const content = $("workbench-content");
const copyText = async (text, label) => {
    try { await navigator.clipboard.writeText(text); message("已复制 " + label); }
    catch (error) { message("复制失败：" + error.message, true); }
};
function closeNodeMenu(restore = false) {
    const menu = $("node-menu"); menu.hidden = true;
    if (restore) menu.opener?.focus({ preventScroll: true });
}
function openNodeMenu(event, items, opener) {
    event.preventDefault(); event.stopPropagation();
    const menu = $("node-menu"); menu.replaceChildren(); menu.opener = opener;
    for (const [label, action, disabled] of items) {
        const button = element("button", label); button.setAttribute("role", "menuitem"); button.disabled = Boolean(disabled);
        button.onclick = () => { closeNodeMenu(); action(); }; menu.append(button);
    }
    menu.hidden = false;
    const host = desktop ? $("node-panels").getBoundingClientRect() : document.body.getBoundingClientRect();
    menu.style.left = Math.max(host.left, Math.min(event.clientX, host.right - menu.offsetWidth)) + "px";
    menu.style.top = Math.max(0, Math.min(event.clientY, window.innerHeight - menu.offsetHeight - 8)) + "px";
    menu.querySelector("button:not(:disabled)")?.focus({ preventScroll: true });
}
$("node-menu").onkeydown = event => {
    const buttons = [...$("node-menu").querySelectorAll("button:not(:disabled)")], index = buttons.indexOf(document.activeElement);
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault(); buttons[event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 :
            (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    }
};
document.addEventListener("pointerdown", event => { if (!$("node-menu").contains(event.target)) closeNodeMenu(); });
document.addEventListener("keydown", event => {
    if (event.key === "Escape") { if (!$("node-menu").hidden) { event.preventDefault(); closeNodeMenu(true); } $("runtime-confirm").hidden = true; }
});
function confirmRuntime(title, text, action) {
    $("runtime-confirm-title").textContent = title; $("runtime-confirm-text").textContent = text;
    $("runtime-confirm").hidden = false; $("runtime-confirm-cancel").focus();
    $("runtime-confirm-cancel").onclick = () => { $("runtime-confirm").hidden = true; };
    $("runtime-confirm-apply").onclick = () => { $("runtime-confirm").hidden = true; work(action); };
}
function accessCode(uuid, componentUuid) {
    return `await (async () => { const cc = globalThis.System?.import ? await System.import("cc") : globalThis.cc; const stack = [cc.director.getScene()]; while (stack.length) { const node = stack.pop(); if (node.uuid === ${JSON.stringify(uuid)}) return ${componentUuid ? "node.components.find(component => component.uuid === " + JSON.stringify(componentUuid) + ")" : "node"}; stack.push(...node.children); } return null; })()`;
}
function expose(uuid, componentUuid, context = state.tree.context) {
    return work(async () => {
        const result = await api({ action: "expose", uuid, context, ...(componentUuid ? { componentUuid } : {}) });
        message(`已打印对象 · 在游戏控制台使用 ${result.name}`);
    });
}
function revealNode(uuid, componentUuid, context = state.tree?.context) {
    return work(async () => {
        if (state.tree?.context !== context) throw new Error("场景已变化，请刷新节点树后重试");
        if (bench.mode !== "nodes") await selectInspectorPanel("nodes");
        $("search").value = ""; $("search-subtree").checked = false; $("search-mode").value = "node"; $("inactive").checked = true;
        await selectNode(uuid); revealSelection();
        if (componentUuid) {
            selectPropertyTab("components");
            const group = [...$("components-panel").querySelectorAll("details[data-uuid]")].find(item => item.dataset.uuid === componentUuid);
            if (group) { group.open = true; group.scrollIntoView({ block: "nearest" }); }
        }
    });
}
decorateTreeRow = (row, node) => {
    const treeContext = state.tree.context;
    row.oncontextmenu = event => openNodeMenu(event, [
        ["复制 UUID", () => copyText(node.uuid, "节点 UUID")],
        ["复制路径", () => copyText(row.title.split("\n")[0], "节点路径")],
        ["复制访问代码", () => copyText(accessCode(node.uuid), "访问代码")],
        ["打印 / 存为 $probeNode", () => expose(node.uuid, undefined, treeContext)],
        ["在此子树搜索组件", () => { state.searchRoot = node.uuid; $("search-mode").value = "component"; $("search-subtree").checked = true;
            work(async () => { await selectNode(node.uuid); $("search").value = ""; renderTree(); $("search").focus(); }); }],
        [node.active ? "关闭节点" : "激活节点", () => work(async () => {
            await api({ action: "edit", uuid: node.uuid, context: treeContext, field: "active", value: !node.active }); await refresh();
        })],
        ["移除运行时节点…", () => confirmRuntime("移除节点", `移除 ${node.name} 及其子节点。重新载入游戏可恢复。`, async () => {
            await api({ action: "remove", uuid: node.uuid, context: treeContext }); await refresh(); message("已移除运行时节点 " + node.name);
        }), !node.parentUuid],
    ], row);
    row.draggable = Boolean(node.parentUuid);
    row.ondragstart = event => {
        if (event.target.closest("button")) { event.preventDefault(); return; }
        bench.dragging = { uuid: node.uuid, context: treeContext }; event.dataTransfer.setData("text/plain", node.uuid); event.dataTransfer.effectAllowed = "move";
    };
    row.ondragover = event => {
        if (!bench.dragging || bench.dragging.uuid === node.uuid) return;
        event.preventDefault(); event.dataTransfer.dropEffect = "move"; row.classList.add("drop-target");
    };
    row.ondragleave = () => row.classList.remove("drop-target");
    row.ondragend = () => { bench.dragging = null; document.querySelectorAll(".drop-target").forEach(item => item.classList.remove("drop-target")); };
    row.ondrop = event => {
        event.preventDefault(); row.classList.remove("drop-target"); const dragged = bench.dragging; bench.dragging = null;
        if (!dragged || dragged.uuid === node.uuid) return;
        work(async () => {
            const current = state.tree.nodes.find(item => item.uuid === dragged.uuid);
            await api({ action: "move", uuid: dragged.uuid, context: dragged.context, parentUuid: node.uuid,
                siblingIndex: node.childCount - (current?.parentUuid === node.uuid ? 1 : 0), keepWorldTransform: true });
            state.expanded.add(node.uuid); await refresh(); message("已改变父节点 · 保持世界 Transform");
        });
    };
};
decorateComponentSummary = (summary, component, snapshot) => {
    const button = element("button", "…", "component-menu"); button.setAttribute("aria-label", component.type + " 操作");
    const open = event => openNodeMenu(event, [
        ["复制组件 UUID", () => copyText(component.uuid, "组件 UUID")],
        ["复制访问代码", () => copyText(accessCode(snapshot.uuid, component.uuid), "组件访问代码")],
        ["打印 / 存为 $probeComponent", () => expose(snapshot.uuid, component.uuid, snapshot.context)],
        ["在场景搜索同类组件", () => { $("search-mode").value = "component"; $("search-subtree").checked = false;
            $("search-exact").checked = true; $("search").value = component.type; renderTree(); $("search").focus(); }],
    ], button);
    button.onclick = open; button.oncontextmenu = open; summary.querySelector(".component-summary-content").append(button);
};
navigateReference = reference => {
    if (reference.kind !== "asset") return revealNode(reference.nodeUuid || reference.uuid, reference.kind === "component" ? reference.uuid : undefined);
    bench.assetsQuery = reference.uuid; bench.assetsOffset = 0; $("workbench-section").value = "assets"; return showWorkbench("info");
};
for (const id of ["search-mode", "search-exact", "search-subtree", "hide-builtin", "fairy-tree"]) $(id).onchange = () => {
    if (id === "search-subtree") state.searchRoot = $(id).checked ? state.selected : null;
    renderTree();
};
$("sort-fields").onchange = () => { if (state.snapshot) renderDetails(state.snapshot); };

function showBenchState(mode) {
    bench.mode = mode; document.body.classList.toggle("workbench-active", ["info", "logs", "extensions"].includes(mode));
    $("workbench-host").hidden = !["info", "logs", "extensions"].includes(mode);
    for (const name of ["nodes", "devtools", "info", "logs", "extensions"]) {
        $(name + "-tab").setAttribute("aria-selected", String(name === mode)); $(name + "-tab").tabIndex = name === mode ? 0 : -1;
    }
    $("workbench-host").setAttribute("aria-labelledby", mode + "-tab");
    $("workbench-section").hidden = mode !== "info"; $("close-devtools").hidden = mode !== "devtools";
}
inspectorPanelChanged = showBenchState;
async function showWorkbench(mode) {
    document.body.classList.remove("devtools-active"); $("devtools-host").hidden = true;
    showBenchState(mode);
    if (desktop) {
        try { await desktop.selectPanel("workbench"); } catch (error) { showBenchState("nodes"); message(error.message, true); return; }
    }
    return work(() => loadWorkbench());
}
for (const name of ["info", "logs", "extensions"]) $(name + "-tab").onclick = () => showWorkbench(name);
$("inspector-tabs").hidden = false;
if (!desktop) {
    $("devtools-tab").hidden = true; selectInspectorPanel = async mode => showBenchState(mode); $("nodes-tab").onclick = () => showBenchState("nodes");
}
$("inspector-tabs").onkeydown = event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || !event.target.matches("[role=tab]")) return;
    const tabs = [...$("inspector-tabs").querySelectorAll("[role=tab]")].filter(tab => !tab.hidden);
    event.preventDefault(); const index = tabs.indexOf(event.target);
    const next = tabs[event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowLeft" ? -1 : 1) + tabs.length) % tabs.length];
    next.click(); next.focus();
};
$("workbench-refresh").onclick = () => work(() => loadWorkbench());
$("workbench-section").onchange = () => work(() => loadWorkbench());
$("workbench-copy").onclick = () => copyText(JSON.stringify(bench.result, null, 2), "当前结果");
function infoLine(container, label, value) {
    const row = element("div", undefined, "info-line"); row.append(element("span", label), element("span", value == null ? "当前引擎未提供" : String(value))); container.append(row);
}
function infoSection(title) {
    const group = element("section", undefined, "workbench-section"); group.append(element("h3", title)); content.append(group); return group;
}
function table(headers, rows) {
    const wrapper = element("div", undefined, "workbench-table"); const grid = element("table"); const head = element("tr");
    headers.forEach(header => head.append(element("th", header))); const thead = element("thead"); thead.append(head); grid.append(thead);
    const body = element("tbody");
    for (const cells of rows) { const row = element("tr"); for (const cell of cells) { const td = element("td"); td.append(cell instanceof Node ? cell : document.createTextNode(cell == null ? "—" : String(cell))); row.append(td); } body.append(row); }
    grid.append(body); wrapper.append(grid); return wrapper;
}
function renderInfo(info) {
    content.replaceChildren();
    const engine = infoSection("Cocos " + info.version + " · " + info.scene);
    infoLine(engine, "状态", info.paused ? "暂停" : "运行");
    const rate = element("input"); rate.type = "number"; rate.min = "1"; rate.max = "240"; rate.value = info.frameRate; rate.setAttribute("aria-label", "目标帧率");
    const applyRate = element("button", "应用帧率"); applyRate.disabled = !info.capabilities.frameRate;
    applyRate.onclick = () => work(async () => { await api({ action: "runtime-setting", context: info.context, name: "frameRate", value: numberValue(rate) }); await loadWorkbench(); });
    const retina = element("input"); retina.type = "checkbox"; retina.checked = Boolean(info.retina); retina.disabled = !info.capabilities.retina;
    const retinaLabel = element("label", undefined, "filter"); retinaLabel.append(retina, document.createTextNode("Retina"));
    retina.onchange = () => work(async () => { await api({ action: "runtime-setting", context: info.context, name: "retina", value: retina.checked }); await loadWorkbench(); });
    const controls = element("div", undefined, "workbench-controls"); controls.append(rate, applyRate, retinaLabel); engine.append(controls);
    const stats = infoSection("场景 / 渲染");
    for (const [key, label] of Object.entries({ nodes: "节点", activeNodes: "激活节点", components: "组件", renderers: "渲染相关组件", drawCalls: "DrawCall · 引擎设备报告", triangles: "三角形 · 引擎设备报告", instances: "实例 · 引擎设备报告" })) infoLine(stats, label, info.stats[key]);
    stats.append(element("p", "设备统计对应最近一次引擎更新；暂停时保留上次值。下表用于排查合批因素，节点或组件数量不代表 DrawCall 数。", "menu-help"));
    stats.append(table(["节点", "组件", "纹理 / 材质", "排查线索"], info.renderers.map(item => {
        const link = element("button", item.name, "reference-link"); link.onclick = () => revealNode(item.uuid);
        return [link, item.type, [item.texture, item.material].filter(Boolean).join(" / ") || "—", item.hint];
    })));
    if (info.renderersTruncated || info.truncated) stats.append(element("p", "已达到显示容量，结果为部分内容。", "menu-help"));
    for (const [title, values] of [["平台", info.system], ["画布 / 设计分辨率", info.canvas], ["引擎环境开关", info.flags]]) {
        const section = infoSection(title); for (const [key, value] of Object.entries(values)) infoLine(section, key, value);
        if (!Object.keys(values).length) section.append(element("p", "当前引擎未提供此信息", "menu-help"));
    }
}
function renderAssets(result) {
    content.replaceChildren();
    const tools = element("div", undefined, "workbench-controls"); const search = element("input"); search.type = "search"; search.value = bench.assetsQuery;
    search.placeholder = "资源名称、类型或 UUID"; search.setAttribute("aria-label", "搜索已加载资源");
    const find = element("button", "搜索"); find.onclick = () => { bench.assetsQuery = search.value; bench.assetsOffset = 0; work(() => loadWorkbench()); };
    search.onkeydown = event => { if (event.key === "Enter") find.click(); };
    tools.append(search, find, element("span", `${result.matched} / ${result.total} 已加载资源`)); content.append(tools);
    content.append(table(["名称 / UUID", "类型", "引用计数", "纹理尺寸", "原生地址"], result.assets.map(asset => {
        const id = element("button", (asset.name || "(未命名)") + "\n" + asset.uuid, "reference-link"); id.onclick = () => copyText(asset.uuid, "资源 UUID");
        return [id, asset.type, asset.refCount, asset.width && asset.height ? asset.width + " × " + asset.height : null, asset.nativeUrl];
    })));
    if (!result.assets.length) content.append(element("p", "没有匹配的已加载资源", "empty"));
    const pages = element("div", undefined, "workbench-controls");
    const prev = element("button", "上一页"); prev.disabled = result.offset === 0;
    prev.onclick = () => { bench.assetsOffset = Math.max(0, result.offset - 100); work(() => loadWorkbench()); };
    const next = element("button", "下一页"); next.disabled = !result.hasMore; next.onclick = () => { bench.assetsOffset = result.offset + 100; work(() => loadWorkbench()); };
    pages.append(prev, element("span", `第 ${Math.floor(result.offset / 100) + 1} 页`), next); content.append(pages);
    if (result.truncated) content.append(element("p", "资源超过 20000，仅查询前 20000 项", "menu-help"));
}
function renderStorage(result) {
    content.replaceChildren(); bench.storageDraft = null;
    content.append(element("p", `当前游戏存储 · ${result.origin} · ${result.total} 项`, "menu-help"));
    const editor = element("div", undefined, "storage-editor");
    const key = element("input"); key.placeholder = "键"; key.maxLength = 1024; key.setAttribute("aria-label", "存储键");
    const value = element("textarea"); value.placeholder = "值"; value.maxLength = 16384; value.setAttribute("aria-label", "存储值");
    const save = element("button", "保存键值");
    const editEntry = entry => { key.value = entry.key; value.value = entry.value; bench.storageDraft = { key: entry.key, value: entry.value }; key.focus(); };
    key.oninput = value.oninput = () => { if (!bench.storageDraft) bench.storageDraft = { key: "", value: null }; };
    save.onclick = () => work(async () => {
        const expected = result.entries.find(entry => entry.key === key.value);
        if (expected?.editable === false) throw new Error("此项超出显示容量，不能使用截断值覆盖");
        await api({ action: "storage", context: result.context, operation: "set", key: key.value, value: value.value, expected: expected?.value ?? null });
        await loadWorkbench(); message("已保存当前游戏的本地存储");
    });
    editor.append(key, value, save); content.append(editor);
    content.append(table(["键", "值", "操作"], result.entries.map(entry => {
        const actions = element("div", undefined, "workbench-controls"); const edit = element("button", "编辑"); edit.disabled = !entry.editable; edit.onclick = () => editEntry(entry);
        const remove = element("button", "删除…"); remove.disabled = !entry.editable; remove.onclick = () => confirmRuntime("删除存储项", entry.key, async () => {
            await api({ action: "storage", context: result.context, operation: "remove", key: entry.key, expected: entry.value }); await loadWorkbench();
        }); actions.append(edit, remove); return [entry.key, entry.value + (entry.truncated ? " [部分内容]" : ""), actions];
    })));
    if (result.truncated) content.append(element("p", "已达到显示容量，部分存储项未显示或只显示摘要。", "menu-help"));
}
function renderLogs() {
    const focused = document.activeElement?.id, scroll = $("log-list")?.scrollTop || 0;
    content.replaceChildren(); const controls = element("div", undefined, "workbench-controls");
    const query = element("input"); query.id = "log-search"; query.type = "search"; query.placeholder = "筛选日志"; query.value = bench.logQuery; query.setAttribute("aria-label", "筛选日志");
    const level = element("select"); level.id = "log-level"; level.setAttribute("aria-label", "日志级别");
    for (const [value, label] of [["all", "全部"], ["error", "错误"], ["warn", "警告"], ["info", "信息"], ["log", "日志"], ["debug", "调试"]]) { const option = element("option", label); option.value = value; level.append(option); } level.value = bench.logLevel;
    const clear = element("button", "清除显示"); clear.onclick = () => { bench.logs = []; renderLogs(); };
    const follow = element("label", undefined, "filter"), check = element("input"); check.type = "checkbox"; check.checked = bench.logFollow;
    follow.append(check, document.createTextNode("跟随最新")); check.onchange = () => { bench.logFollow = check.checked; };
    controls.append(query, level, clear, follow); content.append(controls);
    const list = element("div", undefined, "log-list"); list.id = "log-list";
    const update = () => {
        list.replaceChildren(); const filtered = bench.logs.filter(log => (bench.logLevel === "all" || log.level === bench.logLevel) && log.message.toLowerCase().includes(bench.logQuery.toLowerCase()));
        for (const log of filtered) { const row = element("details", undefined, "log-entry " + log.level); const heading = element("summary", `${new Date(log.capturedAt).toLocaleTimeString()} · ${log.level} · ${log.message}`);
            row.append(heading, element("pre", JSON.stringify(log.details, null, 2))); list.append(row); }
        if (!filtered.length) list.append(element("p", "没有匹配的日志", "empty"));
        if (bench.logFollow) list.scrollTop = list.scrollHeight;
    };
    query.oninput = () => { bench.logQuery = query.value; update(); }; level.onchange = () => { bench.logLevel = level.value; update(); };
    content.append(element("p", `当前连接日志 · 保留最近 1000 条${bench.result?.cursorGap ? " · 部分日志已淘汰" : ""} · 清除显示保留取证记录`, "menu-help"), list); update();
    if (!bench.logFollow) list.scrollTop = scroll;
    if (focused === "log-search" || focused === "log-level") $(focused).focus({ preventScroll: true });
}
async function loadWorkbench(auto = false) {
    if (!state.tree) return;
    const context = state.tree.context;
    if (bench.context !== context) { bench.context = context; bench.storageDraft = null; bench.assetsOffset = 0; }
    if (bench.mode === "logs") {
        const result = await api({ action: "diagnostics", options: { after: bench.cursor, limit: 1000 } });
        bench.cursor = result.nextCursor; bench.logs.push(...result.records); bench.logs = bench.logs.slice(-1000); bench.result = result;
        if (!auto || result.records.length) renderLogs(); return;
    }
    if (bench.mode === "extensions") {
        if (auto) return;
        content.replaceChildren(); const group = infoSection("项目游戏扩展");
        try { bench.result = await api({ action: "game-state" }); group.append(element("pre", JSON.stringify(bench.result, null, 2))); }
        catch (error) { bench.result = { available: false, reason: error.message }; group.append(element("p", error.message, "menu-help")); }
        group.append(element("p", "此页读取已配置的项目扩展状态。调试输入与验收继续使用 AI 接入和调试记录。", "menu-help")); return;
    }
    if (bench.mode !== "info") return;
    const section = $("workbench-section").value;
    if (auto && section !== "info") return;
    if (auto && content.contains(document.activeElement)) return;
    const scroll = content.scrollTop;
    const result = await api(section === "assets" ? { action: "runtime-assets", context, query: bench.assetsQuery, offset: bench.assetsOffset }
        : section === "storage" ? { action: "storage", context, operation: "read" } : { action: "runtime-info", context });
    bench.result = result;
    if (section === "assets") renderAssets(result); else if (section === "storage") renderStorage(result); else renderInfo(result);
    if (auto) content.scrollTop = scroll;
}
syncWorkbench = async auto => {
    if (bench.context && bench.context !== state.tree?.context) {
        $("runtime-confirm").hidden = true; closeNodeMenu(); bench.storageDraft = null; bench.result = null; bench.context = state.tree.context;
        content.replaceChildren(element("p", "场景已变化，点击刷新读取当前游戏", "empty"));
    }
    if (auto) await loadWorkbench(true);
};

const preferenceDefaults = { autoSync: Boolean(desktop), syncDetails: true, showIcons: true, showCounts: true, alignLeft: false,
    sortFields: false, fairyNames: false, arrayLimit: 0, resolutions: [] };
const preferenceControls = new Map();
let preferences = { ...preferenceDefaults };
async function savePreferences(update) {
    preferences = { ...preferences, ...update }; state.preferences = preferences;
    try { if (desktop) await desktop.preferences({ action: "set", value: preferences }); else localStorage.setItem("inspector-preferences", JSON.stringify(preferences)); }
    catch (error) { message("设置已应用，保存失败：" + error.message, true); }
}
function applyPreferences(saved, restoreSync = false) {
    preferences = { ...preferenceDefaults, ...saved }; state.preferences = preferences;
    for (const [name, control] of preferenceControls) { if (control.type === "checkbox") control.checked = preferences[name]; else control.value = preferences[name]; }
    if (restoreSync) $("auto").checked = preferences.autoSync;
    $("sort-fields").checked = preferences.sortFields; $("fairy-tree").checked = preferences.fairyNames;
    document.body.classList.toggle("hide-node-icons", !preferences.showIcons); document.body.classList.toggle("hide-child-counts", !preferences.showCounts);
    document.body.classList.toggle("property-align-left", preferences.alignLeft);
    renderTree(); if (state.snapshot) renderDetails(state.snapshot); renderSavedResolutions();
}
const settings = $("menu-settings");
for (const [name, label] of [["syncDetails", "自动同步选中节点属性"], ["showIcons", "显示节点图标"], ["showCounts", "显示子节点数量"],
    ["alignLeft", "属性名左对齐"]]) {
    const row = element("label", undefined, "filter"); const control = element("input"); control.type = "checkbox"; control.checked = preferenceDefaults[name];
    row.append(control, document.createTextNode(label)); settings.append(row); preferenceControls.set(name, control);
    control.onchange = async () => { await savePreferences({ [name]: control.checked }); applyPreferences(preferences); };
}
const arrayRow = element("label", "自动展开数组长度 ≤ ", "filter"); const arrayLimit = element("input");
arrayLimit.type = "number"; arrayLimit.min = "0"; arrayLimit.max = "40"; arrayLimit.step = "1"; arrayLimit.value = "0";
arrayLimit.setAttribute("aria-label", "自动展开数组长度"); arrayRow.append(arrayLimit); settings.append(arrayRow); preferenceControls.set("arrayLimit", arrayLimit);
arrayLimit.onchange = async () => { if (arrayLimit.reportValidity()) { await savePreferences({ arrayLimit: arrayLimit.valueAsNumber }); if (state.snapshot) renderDetails(state.snapshot); } };
$("auto").addEventListener("change", () => savePreferences({ autoSync: $("auto").checked }));
$("sort-fields").addEventListener("change", () => savePreferences({ sortFields: $("sort-fields").checked }));
$("fairy-tree").addEventListener("change", () => savePreferences({ fairyNames: $("fairy-tree").checked }));
if (!desktop) {
    const opener = element("button", "设置"); $("inspector-tabs").append(opener);
    opener.onclick = () => { $("menu-heading").textContent = "设置"; settings.hidden = false; $("menu-help").hidden = $("menu-evidence").hidden = true; $("inspector-menu").hidden = !$("inspector-menu").hidden; };
    settings.prepend($("auto").closest("label")); $("close-menu").onclick = () => { $("inspector-menu").hidden = true; };
}
let savedResolutionControls;
function renderSavedResolutions() {
    if (!desktop) return;
    $("resolution-preset").querySelectorAll("option[data-saved]").forEach(option => option.remove());
    for (const profile of preferences.resolutions || []) {
        const option = element("option", `${profile.name} · ${profile.width} × ${profile.height}`); option.value = `${profile.width}x${profile.height}`; option.dataset.saved = "true";
        $("resolution-preset").append(option);
    }
}
if (desktop) {
    savedResolutionControls = element("div", undefined, "workbench-controls saved-resolution-controls");
    const name = element("input"); name.placeholder = "预设名称"; name.maxLength = 40; name.setAttribute("aria-label", "分辨率预设名称");
    const save = element("button", "保存预设"), remove = element("button", "删除当前预设");
    save.onclick = async () => {
        if (!name.value.trim() || !$("resolution-width").reportValidity() || !$("resolution-height").reportValidity()) { message("请输入预设名称与有效宽高", true); return; }
        const width = $("resolution-width").valueAsNumber, height = $("resolution-height").valueAsNumber;
        const profiles = (preferences.resolutions || []).filter(profile => profile.name !== name.value.trim());
        if (profiles.length >= 20) { message("最多保存 20 个预设", true); return; }
        await savePreferences({ resolutions: [...profiles, { name: name.value.trim(), width, height }] }); renderSavedResolutions(); message("已保存分辨率预设");
    };
    remove.onclick = async () => {
        const [width, height] = $("resolution-preset").value.split("x").map(Number);
        const profiles = (preferences.resolutions || []).filter(profile => profile.width !== width || profile.height !== height);
        if (profiles.length === (preferences.resolutions || []).length) { message("先选择一个已保存的分辨率预设"); return; }
        await savePreferences({ resolutions: profiles }); renderSavedResolutions(); $("resolution-preset").value = "custom"; message("已删除分辨率预设");
    };
    savedResolutionControls.append(name, save, remove); $("resolution-panel").append(savedResolutionControls);
    for (const [operation, label] of [["http", "清除当前游戏 HTTP 缓存"], ["cookies", "清除当前游戏 Cookies"]]) {
        const button = element("button", label); settings.append(button);
        button.onclick = () => confirmRuntime(label, "只清理当前检查器的游戏会话。保留当前画面，重新请求资源时生效。", async () => {
            await desktop.previewTool({ action: "cache", operation }); message(label + "完成");
        });
    }
    const simple = element("button", "简洁模式"); simple.id = "simple-mode";
    const restore = element("button", "显示检查面板"); restore.id = "restore-panels"; restore.hidden = true;
    settings.append(simple); document.querySelector(".preview-tools-left").append(restore);
    simple.onclick = async () => { await selectInspectorPanel("nodes"); $("inspector-menu").hidden = true; document.body.classList.add("simple-mode"); restore.hidden = false; };
    restore.onclick = () => { document.body.classList.remove("simple-mode"); restore.hidden = true; };
}
void (async () => {
    try { const stored = desktop ? await desktop.preferences({ action: "get" }) : JSON.parse(localStorage.getItem("inspector-preferences") || "{}"); applyPreferences(stored, true); }
    catch { applyPreferences({}, true); }
})();
