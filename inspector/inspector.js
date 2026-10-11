"use strict";
const $ = id => document.getElementById(id);
const state = { tree: null, selected: null, expanded: new Set(), snapshot: null, busy: false, dirty: false,
    drafts: new Map(), nodeDrafts: new Map(), collapsedComponents: new Set(), pending: 0, syncedAt: null, syncFailed: false, background: false,
    detailTab: "basic", detailScroll: { basic: 0, components: 0 }, backgroundError: null, expandedFields: new Set(),
    closedFields: new Set(), preferences: { syncDetails: true, arrayLimit: 0 } };
let workQueue = Promise.resolve();
const token = document.querySelector('meta[name="inspector-token"]').content;
const desktop = window.liveProbeDesktop;
let syncPreviewTools = async () => {};
let syncPreviewSelection = async () => {};
let syncWorkbench = async () => {};
let decorateTreeRow = () => {};
let decorateComponentSummary = () => {};
let navigateReference = () => {};
let inspectorPanelChanged = () => {};
let selectInspectorPanel = async () => {};
function inspectorIcon(name, className = "") {
    const paths = {
        refresh: 'M20 7v5h-5M4 17v-5h5M5.1 8a7 7 0 0 1 12-3L20 8M4 16l2.9 3a7 7 0 0 0 12-3',
        pause: 'M8 5v14M16 5v14', play: 'M8 5l11 7-11 7z',
        terminal: 'M3 5h18v14H3zM6 9l3 3-3 3M12 15h5',
        settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM10 2h4l1 3 3 1 3 3-1 3 1 3-3 3-3 1-1 3h-4l-1-3-3-1-3-3 1-3-1-3 3-3 3-1z',
        help: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9 9a3 3 0 1 1 5 2c-2 1-2 2-2 3M12 17h.01',
        record: 'M4 4h16v16H4zM8 8h8M8 12h8M8 16h5',
        ai: 'M12 3l2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z',
        flame: 'M12 2c1 5 6 6 6 12a6 6 0 0 1-12 0c0-3 1-5 3-7 0 3 1 4 2 4 2-2 2-5 1-9z',
        node: 'M5 5h14v14H5zM5 2v6M19 2v6M5 16v6M19 16v6M2 5h6M16 5h6M2 19h6M16 19h6',
        scene: 'M12 2l9 5v10l-9 5-9-5V7zM3 7l9 5 9-5M12 12v10',
        camera: 'M3 7h12v12H3zM15 11l6-4v12l-6-4M7 3h4v4H7z',
        image: 'M3 4h18v16H3zM3 16l6-6 5 5 3-3 4 4M15 8h.01',
        text: 'M4 4h16M12 4v16M8 20h8',
        component: 'M9 3h6v4h4v5h-4v5H9v-5H5V7h4z',
        more: 'M5 12h.01M12 12h.01M19 12h.01',
        locate: 'M12 3v4M12 17v4M3 12h4M17 12h4M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z',
        fps: 'M3 18h18M3 14l5-5 5 3 7-7M16 5h4v4',
        sound: 'M3 9h4l5-4v14l-5-4H3zM16 8a6 6 0 0 1 0 8M19 5a10 10 0 0 1 0 14',
        muted: 'M3 9h4l5-4v14l-5-4H3zM16 9l6 6M22 9l-6 6',
        move: 'M12 2v20M2 12h20M8 6l4-4 4 4M8 18l4 4 4-4M6 8l-4 4 4 4M18 8l4 4-4 4',
        resolution: 'M7 3H3v4M3 3l5 5M10 7h11v14H7V10M10 7v3H7',
    };
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", "inspector-icon " + className);
    const path = document.createElementNS(svg.namespaceURI, "path"); path.setAttribute("d", paths[name] || paths.component); svg.append(path);
    return svg;
}
function componentIcon(type) {
    return /Camera/.test(type) ? "camera" : /Sprite/.test(type) ? "image" : /Label/.test(type) ? "text" : /UITransform|Canvas/.test(type) ? "node" : "component";
}
const themes = new Set(["graphite", "midnight", "light"]);
function applyTheme(theme) {
    const selected = themes.has(theme) ? theme : "graphite";
    document.documentElement.classList.add("theme-changing");
    document.documentElement.dataset.theme = selected; $("theme").value = selected;
    // A palette switch should not animate old backgrounds under the new text color.
    void document.documentElement.offsetWidth;
    requestAnimationFrame(() => document.documentElement.classList.remove("theme-changing"));
}
if (desktop) applyTheme(document.documentElement.dataset.theme);
else {
    try { applyTheme(localStorage.getItem("inspector-theme")); } catch { applyTheme("graphite"); }
}
$("theme").onchange = async () => {
    const theme = $("theme").value; applyTheme(theme);
    try {
        if (desktop) await desktop.saveTheme(theme); else localStorage.setItem("inspector-theme", theme);
    } catch (error) { message("配色已切换，偏好保存失败：" + error.message, true); }
};
function applyDensity(density) {
    const selected = density === "compact" ? "compact" : "comfortable";
    document.documentElement.dataset.density = selected; $("density").value = selected;
}
if (desktop) applyDensity(document.documentElement.dataset.density);
else {
    try { applyDensity(localStorage.getItem("inspector-density")); } catch { applyDensity("comfortable"); }
}
$("density").onchange = async () => {
    const density = $("density").value; applyDensity(density);
    try {
        if (desktop) await desktop.saveDensity(density); else localStorage.setItem("inspector-density", density);
    } catch (error) { message("密度已切换，偏好保存失败：" + error.message, true); }
};
let ownedEvidenceRun = null;
$("evidence-start").onclick = () => work(async () => {
    const run = await api({ action: "evidence", request: { action: "start", label: "Inspector 调试" } });
    ownedEvidenceRun = run.runId;
    $("evidence-state").textContent = "记录中 · " + run.runId;
    $("evidence-state").title = run.runId;
    $("evidence-bar").classList.add("recording");
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
    $("evidence-state").title = saved.manifestPath;
    $("evidence-bar").classList.toggle("recording", saved.runState === "in-progress");
    message("验收包：" + saved.manifestPath + (saved.missing?.length ? "；" + saved.missing.join("；") : ""));
});
function updateMessageDetails() {
    $("message-details").hidden = $("message-popover").hidden && !$("message").classList.contains("error") && $("message").scrollWidth <= $("message").clientWidth;
}
function closeMessageDetails(restoreFocus = false) {
    $("message-popover").hidden = true; $("message-details").setAttribute("aria-expanded", "false"); updateMessageDetails();
    if (restoreFocus) ($("message-details").hidden ? $("message") : $("message-details")).focus({ preventScroll: true });
}
function message(text, error = false) {
    $("message").textContent = text; $("message").title = text; $("message").classList.toggle("error", error);
    $("message-full").textContent = text; $("message-popover").classList.toggle("error", error); updateMessageDetails();
    $("message-copy-error").hidden = true;
}
$("message-details").onclick = () => {
    if (!$("message-popover").hidden) { closeMessageDetails(true); return; }
    $("message-popover").hidden = false; $("message-details").setAttribute("aria-expanded", "true"); $("message-full").focus({ preventScroll: true });
};
$("close-message").onclick = () => closeMessageDetails(true);
$("copy-message").onclick = async () => {
    $("message-copy-error").hidden = true;
    $("copy-message").textContent = "复制全文";
    try {
        await navigator.clipboard.writeText($("message-full").textContent || "");
        const button = $("copy-message"); button.textContent = "已复制";
        setTimeout(() => { if (button.isConnected) button.textContent = "复制全文"; }, 1200);
    } catch (error) {
        $("message-copy-error").textContent = "复制失败，可选择下方文本手动复制。";
        $("message-copy-error").title = error.message; $("message-copy-error").hidden = false;
    }
};
document.addEventListener("keydown", event => { if (event.key === "Escape" && !$("message-popover").hidden) { event.preventDefault(); closeMessageDetails($("message-popover").contains(document.activeElement)); } });
new ResizeObserver(updateMessageDetails).observe($("message"));
async function api(payload) {
    const response = await fetch("/api", { method: "POST", headers: { "Content-Type": "application/json", "X-Inspector-Token": token }, body: JSON.stringify(payload) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    return result;
}
function updateControls() {
    $("pause").disabled = !state.tree;
    $("expand-all").disabled = $("collapse-all").disabled = !state.tree;
    $("reveal-selection").disabled = !state.selected;
    $("evidence-start").disabled = $("evidence-bar").classList.contains("recording");
    $("deselect").disabled = !state.selected;
    $("expand-components").disabled = $("collapse-components").disabled = !state.snapshot || Boolean($("component-search").value.trim());
}
function updateSyncState() {
    $("sync-state").textContent = state.syncFailed ? "同步失败 · 点击刷新重试" : state.busy && !state.background ? "正在处理…" :
        state.syncedAt ? `${$("auto").checked ? "自动同步" : "手动同步"} · ${state.syncedAt}` : "连接中…";
}
function updateDraftState() {
    state.dirty = state.drafts.size > 0;
    if (state.selected) {
        if (state.dirty) state.nodeDrafts.set(state.selected, state.drafts); else state.nodeDrafts.delete(state.selected);
        for (const row of $("tree").querySelectorAll(".row")) {
            describeTreeRow(row);
        }
    }
    $("draft-bar").hidden = !state.dirty;
    $("draft-state").textContent = `${state.drafts.size} 项待应用 · 仅运行时生效`;
    $("basic-tab").classList.toggle("has-draft", [...state.drafts.keys()].some(key => key === "move" || JSON.parse(key)[0] === null));
    $("components-tab").classList.toggle("has-draft", [...state.drafts.keys()].some(key => key !== "move" && JSON.parse(key)[0] !== null));
}
function describeTreeRow(row) {
    const hasDraft = Boolean(state.nodeDrafts.get(row.dataset.uuid)?.size);
    row.classList.toggle("has-draft", hasDraft);
    row.setAttribute("aria-label", [row.querySelector(".name")?.textContent || "(未命名)",
        row.classList.contains("inactive") ? "未激活" : "", hasDraft ? "有待应用修改" : ""].filter(Boolean).join(" · "));
}
// User actions queue behind a poll; polling never disables the controls or drops a click.
function work(task, background = false) {
    if (background && state.pending) return workQueue;
    state.pending++;
    const run = async () => {
        state.busy = true;
        state.background = background;
        document.body.classList.toggle("working", !background);
        if (!background) $("details").setAttribute("aria-busy", "true");
        const controls = background ? [] : [...document.querySelectorAll("button")].filter(button => !button.disabled);
        controls.forEach(button => { button.disabled = true; }); updateSyncState();
        try {
            await task();
            if (background && state.backgroundError !== null) {
                if ($("message").classList.contains("error") && $("message").textContent === "自动同步失败：" + state.backgroundError) message("自动同步已恢复");
                state.backgroundError = null; state.syncFailed = false;
            }
        }
        catch (error) {
            if (background) {
                state.syncFailed = true;
                if (state.backgroundError !== error.message) message("自动同步失败：" + error.message, true);
                state.backgroundError = error.message;
            } else message(error.message, true);
        }
        finally {
            state.busy = false; state.pending--;
            document.body.classList.remove("working"); $("details").removeAttribute("aria-busy");
            controls.filter(button => button.isConnected).forEach(button => { button.disabled = false; });
            updateControls(); updateSyncState();
        }
    };
    workQueue = workQueue.then(run);
    return workQueue;
}
function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
}
function emptySelection(text) {
    const componentTools = $("component-tools");
    if (desktop) document.querySelector(".properties").insertBefore(componentTools, $("draft-bar"));
    document.querySelector(".node-active")?.remove();
    state.selected = null; state.snapshot = null; state.dirty = false;
    state.drafts = new Map(); state.collapsedComponents.clear(); updateDraftState(); updateControls();
    void syncPreviewSelection(null);
    $("property-tabs").hidden = $("component-tools").hidden = true;
    $("property-heading").textContent = "属性检查器";
    document.body.classList.remove("has-selection");
    const empty = element("div", undefined, "empty selection-empty");
    const icon = element("span", "◇", "empty-icon"); icon.setAttribute("aria-hidden", "true");
    empty.append(icon, element("strong", "从节点开始调试"), element("p", text), element("span", "修改仅在当前运行实例中生效"));
    $("details").replaceChildren(empty);
}
function renderTree() {
    if (!state.tree) return;
    const focused = document.activeElement.closest?.(".row")?.dataset.uuid;
    const scrollTop = $("tree").scrollTop;
    const scrollLeft = $("tree").scrollLeft;
    const query = $("search").value.trim().toLowerCase();
    $("clear-search").hidden = !$("search").value;
    $("search-shortcut").hidden = Boolean($("search").value);
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
    const subtree = new Set();
    if ($("search-subtree").checked && (state.searchRoot || state.selected)) {
        subtree.add(state.searchRoot || state.selected);
        for (const node of nodes) if (subtree.has(node.parentUuid)) subtree.add(node.uuid);
    }
    const matchText = text => $("search-exact").checked ? String(text).toLowerCase() === query : String(text).toLowerCase().includes(query);
    for (const node of nodes) {
        if (!$("inactive").checked && !node.activeInHierarchy && node.parentUuid) continue;
        if (subtree.size && !subtree.has(node.uuid)) continue;
        const componentSearch = $("search-mode").value === "component";
        const types = (node.componentTypes || []).filter(type => !$("hide-builtin").checked || !/^cc\.|^sp\.|^dragonBones\./.test(type));
        if (componentSearch ? types.some(type => !query || matchText(type) || matchText(type.replace(/^cc\./, "")))
            : !query || [node.name, node.uuid, pathOf(node), node.fairyName || ""].some(matchText)) {
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
        const row = element("div", undefined, "row"); row.style.setProperty("--indent", `${depth * 16 + 8}px`);
        row.classList.toggle("inactive", !node.activeInHierarchy); row.classList.toggle("selected", state.selected === node.uuid);
        row.setAttribute("role", "treeitem"); row.setAttribute("aria-level", depth + 1); row.setAttribute("aria-selected", String(state.selected === node.uuid));
        row.dataset.uuid = node.uuid;
        row.tabIndex = -1; row.title = pathOf(node) + "\n" + node.uuid;
        const open = Boolean(query) || $("search-mode").value === "component" || subtree.size > 0 || state.expanded.has(node.uuid);
        const toggle = element("button", node.childCount ? open ? "▾" : "▸" : "·", "toggle");
        toggle.tabIndex = -1;
        toggle.setAttribute("aria-label", open ? "折叠子节点" : "展开子节点"); toggle.disabled = !node.childCount;
        if (node.childCount) row.setAttribute("aria-expanded", String(open));
        toggle.onclick = event => { event.stopPropagation(); if (state.expanded.has(node.uuid)) state.expanded.delete(node.uuid); else state.expanded.add(node.uuid); renderTree(); };
        const type = node.componentTypes?.find(type => /Camera|Sprite|Label|Canvas/.test(type));
        const iconKind = node.parentUuid ? type ? componentIcon(type) : "node" : "scene";
        const icon = desktop ? inspectorIcon(iconKind, "node-icon " + iconKind) : element("span", node.parentUuid ? "◇" : "▣", "node-icon"); icon.setAttribute("aria-hidden", "true");
        row.append(toggle, icon, element("span", $("fairy-tree").checked && node.fairyName ? node.fairyName + " · " + node.name : node.name || "(未命名)", "name"));
        if (node.prefab) { row.classList.add("prefab-node"); const marker = element("span", "P", "node-marker"); marker.title = "Prefab 实例根节点"; row.append(marker); }
        if (!node.activeInHierarchy) row.append(element("span", "未激活", "node-state"));
        describeTreeRow(row);
        if (node.childCount) row.append(element("span", String(node.childCount), "children-count"));
        const select = () => work(() => selectNode(node.uuid));
        row.onclick = select;
        decorateTreeRow(row, node);
        row.onkeydown = event => {
            if (event.target !== row) return;
            if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(); }
            const rows = [...$("tree").querySelectorAll(".row")]; const index = rows.indexOf(row);
            if (["ArrowDown", "ArrowUp", "Home", "End", "ArrowRight", "ArrowLeft"].includes(event.key)) event.preventDefault();
            if (event.key === "ArrowDown") focusTreeRow(rows[Math.min(rows.length - 1, index + 1)]);
            if (event.key === "ArrowUp") focusTreeRow(rows[Math.max(0, index - 1)]);
            if (event.key === "Home") focusTreeRow(rows[0]);
            if (event.key === "End") focusTreeRow(rows[rows.length - 1]);
            if (event.key === "ArrowRight" && node.childCount) {
                if (!open) { state.expanded.add(node.uuid); renderTree(); }
                else focusTreeRow(rows[index + 1]);
            }
            if (event.key === "ArrowLeft") {
                if (open && !query && node.childCount) { state.expanded.delete(node.uuid); renderTree(); }
                else focusTreeRow(rows.find(item => item.dataset.uuid === node.parentUuid));
            }
        };
        row.onfocus = () => { for (const item of $("tree").querySelectorAll(".row")) item.tabIndex = item === row ? 0 : -1; };
        rows.append(row);
        if (open) for (const child of (children.get(node.uuid) || []).slice().reverse()) stack.push({ node: child, depth: depth + 1 });
    }
    $("tree").replaceChildren(rows);
    if (!$("tree").childElementCount) $("tree").append(element("p", query ? "没有匹配的节点，试试其他名称或清除搜索。" : "没有可显示的节点", "empty"));
    const rendered = [...$("tree").querySelectorAll(".row")];
    const focusRow = rendered.find(row => row.dataset.uuid === focused);
    const tabStop = focusRow || rendered.find(row => row.dataset.uuid === state.selected) || rendered[0];
    if (tabStop) tabStop.tabIndex = 0;
    if (focusRow) focusRow.focus({ preventScroll: true });
    $("tree").scrollTop = scrollTop;
    $("tree").scrollLeft = scrollLeft;
    $("count").textContent = query || !$("inactive").checked ? `${matches.size} / ${nodes.length}` : String(nodes.length);
    updateControls();
}
function focusTreeRow(row) {
    if (row) { row.focus({ preventScroll: true }); (row.querySelector(".name") || row).scrollIntoView({ block: "nearest", inline: "nearest" }); }
}
async function selectNode(uuid) {
    if (!state.tree?.nodes.some(node => node.uuid === uuid)) throw new Error("节点已移除，请刷新节点树");
    const snapshot = await api({ action: "inspect", uuid, context: state.tree.context });
    if (state.selected !== uuid) {
        state.drafts = state.nodeDrafts.get(uuid) || new Map(); state.collapsedComponents.clear();
        state.snapshot = null; state.detailScroll = { basic: 0, components: 0 }; $("component-search").value = "";
    }
    state.selected = uuid;
    await syncPreviewSelection(uuid);
    renderTree(); renderDetails(snapshot);
    message("已选择 " + snapshot.path + (state.dirty ? " · 已恢复待应用草稿" : ""));
}
function updateEngineState() {
    const paused = Boolean(state.tree?.paused);
    $("pause").textContent = paused ? "继续游戏" : "暂停游戏";
    if (desktop) {
        $("pause").setAttribute("aria-label", paused ? "继续游戏" : "暂停游戏"); $("pause").title = paused ? "继续游戏" : "暂停游戏";
        $("pause").replaceChildren(inspectorIcon(paused ? "play" : "pause"), element("span", paused ? "继续游戏" : "暂停游戏", "sr-only"));
    }
    $("pause").setAttribute("aria-pressed", String(paused));
    $("engine-state").textContent = paused ? "已暂停" : "运行中";
    $("engine-state").classList.toggle("paused", paused);
}
async function refresh(auto = false) {
    let tree;
    try { tree = await api({ action: "tree" }); }
    catch (error) { state.syncFailed = true; updateSyncState(); throw error; }
    state.syncFailed = false; state.syncedAt = new Date().toLocaleTimeString();
    const changed = state.tree?.context !== tree.context;
    state.tree = tree;
    if (changed) {
        state.expandedFields.clear(); state.closedFields.clear(); state.searchRoot = null;
        state.nodeDrafts.clear(); state.detailScroll = { basic: 0, components: 0 };
        emptySelection("选择节点以查看和调整属性"); state.expanded.clear();
        for (const node of tree.nodes) if (!node.parentUuid || tree.nodes[0]?.uuid === node.parentUuid) state.expanded.add(node.uuid);
        $("shot").hidden = true; $("shot-hint").hidden = false;
        $("capture-state").hidden = true;
    }
    $("scene").textContent = tree.scene; $("scene").title = tree.scene; updateEngineState();
    renderTree();
    const liveNodes = new Set(tree.nodes.map(node => node.uuid));
    for (const uuid of state.nodeDrafts.keys()) if (!liveNodes.has(uuid)) state.nodeDrafts.delete(uuid);
    if (state.selected && !tree.nodes.some(node => node.uuid === state.selected)) emptySelection("所选节点已移除，请重新选择");
    if (state.selected && !state.dirty && (!auto || state.preferences.syncDetails && !$("details").contains(document.activeElement))) {
        renderDetails(await api({ action: "inspect", uuid: state.selected, context: tree.context }));
    }
    if (!auto) message(`节点树已更新 · ${tree.nodes.length} 个节点`);
    await syncWorkbench(auto);
}
async function capture() {
    const shot = await api({ action: "screenshot" }); $("shot").src = shot.image; $("shot").hidden = false; $("shot-hint").hidden = true;
    const capturedAt = new Date().toLocaleTimeString();
    $("shot").title = `${shot.imageWidth} × ${shot.imageHeight} · ${capturedAt}`;
    $("capture-state").textContent = `截图 · ${capturedAt} 更新 · 点击「更新画面」获取当前状态`;
    $("capture-state").hidden = false;
}
function compactNumber(value) {
    if (!Number.isFinite(value)) return String(value);
    const magnitude = Math.abs(value);
    return magnitude && (magnitude < 0.0001 || magnitude >= 10000000)
        ? value.toExponential(5).replace(/(\.\d*?[1-9])0+(?=e)/, "$1").replace(/\.0+(?=e)/, "").replace("e+", "e")
        : String(Number(value.toFixed(4)));
}
function axisLabel(axis) { return axis === "width" ? "宽" : axis === "height" ? "高" : axis; }
function controlValue(control) {
    if (control.type === "checkbox") return control.checked;
    if (control.type === "number" && control.value !== "" && control.valueAsNumber === control.originalNumber) return String(control.originalNumber);
    if (control.type === "number" && !control.numberEdited &&
        (control.value === control.compactValue || control.value === String(control.originalNumber))) return String(control.originalNumber);
    return control.value;
}
function editedNumber(control) {
    // Compact text is only a presentation; an untouched axis keeps its exact snapshot value.
    return !control.numberEdited && control.value === control.compactValue ? control.originalNumber : numberValue(control);
}
function renderDetails(snapshot) {
    const sameNode = state.snapshot?.uuid === snapshot.uuid;
    const scrollTop = sameNode ? $("details").scrollTop : 0;
    const activeControl = document.activeElement;
    const focusedKey = sameNode && document.querySelector(".properties").contains(activeControl) ? activeControl.dataset.focusKey : null;
    const textSelection = focusedKey && ["text", "textarea"].includes(activeControl.type) ? { value: activeControl.value, start: activeControl.selectionStart, end: activeControl.selectionEnd } : null;
    state.snapshot = snapshot;
    document.body.classList.add("has-selection");
    const componentTools = $("component-tools");
    const panel = $("details"); const nodeInfoOpen = sameNode && Boolean(panel.querySelector(".node-advanced")?.open); panel.replaceChildren();
    document.querySelector(".node-active")?.remove();
    const uuid = element("p", undefined, "metadata uuid");
    const uuidText = element("span", "UUID: " + snapshot.uuid); uuidText.title = snapshot.uuid;
    const copy = element("button", "复制", "copy-uuid"); copy.title = "复制节点 UUID";
    copy.onclick = async () => {
        try { await navigator.clipboard.writeText(snapshot.uuid); message("已复制节点 UUID"); }
        catch (error) { message("复制失败，可在节点信息中选择 UUID：" + error.message, true); }
    };
    uuid.append(uuidText, copy);
    const summary = element("div", undefined, "node-summary");
    const heading = element("div", undefined, "node-heading");
    const active = element("span", snapshot.activeInHierarchy ? "已激活" : "未激活", "node-status");
    active.classList.toggle("inactive", !snapshot.activeInHierarchy);
    heading.append(element("strong", snapshot.name || "(未命名)"), active);
    const path = element("p", snapshot.path, "metadata path"); path.title = snapshot.path;
    summary.append(heading, path, uuid); if (!desktop) panel.append(summary);
    const basic = element("div"); basic.id = "basic-panel"; basic.setAttribute("role", "tabpanel"); basic.setAttribute("aria-labelledby", "basic-tab");
    const components = element("div"); components.id = "components-panel"; components.setAttribute("role", "tabpanel"); components.setAttribute("aria-labelledby", "components-tab");
    let fieldPanel = basic; let fieldSequence = 0;
    if (desktop) panel.append(basic, componentTools, components); else panel.append(basic, components);
    function field(title, name, value, editable = true, componentUuid, metadata = {}) {
        const row = element("div", undefined, "field"); const label = element("label", title); label.title = title; row.append(label);
        if (componentUuid) {
            const words = title.split(/(?<=[a-z0-9])(?=[A-Z])/);
            if (words.length > 1) {
                const text = element("span");
                words.forEach((word, index) => { if (index) text.append(element("wbr")); text.append(document.createTextNode(word)); });
                label.replaceChildren(text);
            }
        }
        row.dataset.field = name.toLowerCase(); row.dataset.editable = String(editable);
        if (!editable) {
            const axes = value && typeof value === "object" ? Object.keys(value) : [];
            if (axes.length && axes.length <= 4 && axes.every(axis => Number.isFinite(value[axis]))) {
                row.classList.add("vector-field");
                const group = element("div", undefined, "readonly vector readonly-vector");
                for (const axis of axes) {
                    const axisText = element("label", axisLabel(axis)); axisText.dataset.axis = axis;
                    const number = element("span", compactNumber(value[axis]), "readonly-number"); number.title = `${axis}: ${value[axis]}`;
                    axisText.append(number); group.append(axisText);
                }
                row.append(group);
            } else if (metadata.reference && ["node", "component", "asset"].includes(metadata.reference.kind)) {
                const link = element("button", String(value), "reference-link"); link.title = "定位引用";
                link.onclick = () => navigateReference(metadata.reference); row.append(link);
            } else row.append(element("span", typeof value === "object" ? JSON.stringify(value) : String(value), "readonly"));
            fieldPanel.append(row); return;
        }
        const key = JSON.stringify([componentUuid || null, name]);
        const inputs = []; let getValue;
        const input = (initial, type) => {
            const multiline = type === "text" && (String(initial).includes("\n") || String(initial).length > 160);
            const control = element(multiline ? "textarea" : "input"); if (!multiline) control.type = type;
            if (multiline) { control.rows = 3; control.className = "multiline-field"; }
            control.dataset.focusKey = JSON.stringify([componentUuid || null, name, inputs.length]);
            if (type === "checkbox") control.checked = initial; else control.value = initial;
            if (type === "number") {
                control.step = "any"; control.originalNumber = initial; control.compactValue = compactNumber(initial); control.numberEdited = false;
                control.value = control.compactValue; control.title = `原始值：${initial} · 聚焦查看完整精度`;
                control.onfocus = () => { if (!control.numberEdited && control.value === control.compactValue) control.value = String(initial); };
                control.onblur = () => {
                    if (control.value !== "" && control.valueAsNumber === initial) { control.numberEdited = false; control.value = control.compactValue; }
                };
            }
            control.setAttribute("aria-label", title); inputs.push(control); return control;
        };
        if (value && typeof value === "object") {
            row.classList.add("vector-field");
            const group = element("div", undefined, "vector");
            const orderedAxes = ["x", "y", "z", "w", "width", "height", "r", "g", "b", "a"].filter(axis => Object.prototype.hasOwnProperty.call(value, axis));
            const axes = metadata.axes || (orderedAxes.length === Object.keys(value).length ? orderedAxes : Object.keys(value));
            for (const axis of axes) {
                const axisText = element("label", axisLabel(axis)); axisText.dataset.axis = axis; const control = input(value[axis], "number");
                control.setAttribute("aria-label", `${title} ${axis}`); axisText.append(control); group.append(axisText);
            }
            row.append(group); getValue = () => Object.fromEntries(axes.map((axis, index) => [axis, editedNumber(inputs[index])]));
            if (metadata.type === "color") {
                const color = element("input"); color.type = "color"; color.className = "color-swatch"; color.setAttribute("aria-label", `${title} 色板`);
                const hex = () => "#" + inputs.slice(0, 3).map(control => Math.round(Math.max(0, Math.min(255, Number(control.value)))).toString(16).padStart(2, "0")).join("");
                color.value = "#" + [value.r, value.g, value.b].map(channel => channel.toString(16).padStart(2, "0")).join("");
                color.oninput = () => { const selected = color.value; for (let i = 0; i < 3; i++) { inputs[i].value = parseInt(selected.slice(1 + i * 2, 3 + i * 2), 16); inputs[i].dispatchEvent(new Event("input")); } };
                inputs.forEach(control => control.addEventListener("input", () => { if (inputs.every(control => control.value !== "" && Number.isFinite(Number(control.value)))) color.value = hex(); }));
                const editor = element("div", undefined, "color-editor"); group.replaceWith(editor); editor.append(color, group); row.classList.add("color-field");
            }
        } else if (metadata.type === "enum" && metadata.options?.length) {
            const control = element("select"); control.setAttribute("aria-label", title); control.dataset.focusKey = JSON.stringify([componentUuid || null, name, 0]);
            for (const option of metadata.options) { const item = element("option", option.name + " · " + option.value); item.value = option.value; control.append(item); }
            control.value = value; inputs.push(control); row.append(control); getValue = () => Number(control.value);
        } else {
            const type = typeof value === "boolean" ? "checkbox" : typeof value === "number" ? "number" : "text";
            const control = input(value, type); control.id = `property-field-${fieldSequence++}`;
            label.htmlFor = control.id; row.append(control);
            getValue = () => type === "checkbox" ? control.checked : type === "number" ? editedNumber(control) : control.value;
        }
        const apply = element("button", "应用"); apply.dataset.focusKey = JSON.stringify([componentUuid || null, name, "apply"]); apply.setAttribute("aria-label", `应用${title}`); row.append(apply);
        const values = () => inputs.map(controlValue);
        const initial = values();
        if (state.drafts.has(key)) state.drafts.get(key).forEach((value, index) => {
            const control = inputs[index];
            if (control.type === "checkbox") control.checked = value;
            else if (control.type === "number") {
                control.numberEdited = value !== String(control.originalNumber);
                control.value = control.numberEdited ? value : control.compactValue;
            } else control.value = value;
        });
        row.classList.toggle("dirty", state.drafts.has(key));
        for (const control of inputs) {
            control.oninput = () => {
                control.setCustomValidity("");
                control.removeAttribute("aria-invalid");
                if (control.type === "number") control.numberEdited = true;
                const current = values();
                if (JSON.stringify(current) === JSON.stringify(initial)) state.drafts.delete(key); else state.drafts.set(key, current);
                row.classList.toggle("dirty", state.drafts.has(key)); updateDraftState();
            };
            control.onkeydown = event => { if (event.key === "Enter") { event.preventDefault(); apply.click(); } };
            if (control.tagName === "SELECT") control.onchange = control.oninput;
        }
        apply.title = `应用${title} · Enter`;
        apply.onclick = () => work(async () => {
            const submittedDraft = state.drafts.get(key);
            const result = await api({ action: "edit", uuid: snapshot.uuid, context: snapshot.context, field: metadata.rootField || name, value: getValue(),
                ...(componentUuid ? { componentUuid, ...(metadata.path?.length ? { propertyPath: metadata.path } : {}) } : {}) });
            if (state.drafts.get(key) === submittedDraft) state.drafts.delete(key);
            renderDetails(result); await refresh(); if (!$("shot").hidden) await capture(); message(`已应用 ${title} · 仅运行时生效`);
        }); fieldPanel.append(row); return row;
    }
    const nameField = field("名称", "name", snapshot.name); const activeField = field("激活", "active", snapshot.active);
    if (desktop) {
        activeField.classList.add("node-active"); document.querySelector(".properties > .section-title").prepend(activeField);
    }
    if (!desktop) basic.append(element("h3", "Transform"));
    field("位置", "position", snapshot.position); field("旋转 / °", "eulerAngles", snapshot.eulerAngles); field("缩放", "scale", snapshot.scale);
    if (!desktop) field("世界位置", "worldPosition", snapshot.worldPosition, false);
    if (snapshot.uiTransform) { if (!desktop) basic.append(element("h3", "UITransform")); field("尺寸", "contentSize", snapshot.uiTransform.contentSize); field("锚点", "anchorPoint", snapshot.uiTransform.anchorPoint); }
    if (desktop) {
        const advanced = element("details", undefined, "node-advanced");
        advanced.open = nodeInfoOpen;
        advanced.append(element("summary", "节点信息 / 层级"), summary); panel.append(advanced); fieldPanel = advanced;
        advanced.append(nameField);
        field("世界位置", "worldPosition", snapshot.worldPosition, false);
    }
    field("Layer", "layer", snapshot.layer, false); field("有效透明度", "opacity", snapshot.opacity, false);
    if (snapshot.parentUuid) {
        if (!desktop) basic.append(element("h3", "节点层级"));
        const parentRow = element("div", undefined, "field"); parentRow.append(element("label", "父节点"));
        const select = element("select"); select.id = "property-parent"; select.setAttribute("aria-label", "父节点"); parentRow.firstElementChild.htmlFor = select.id;
        select.dataset.focusKey = "move-parent";
        const descendants = new Set([snapshot.uuid]);
        for (const node of state.tree.nodes) if (descendants.has(node.parentUuid)) descendants.add(node.uuid);
        for (const node of state.tree.nodes) {
            if (descendants.has(node.uuid)) continue;
            const option = element("option", node.name + " · " + node.uuid); option.value = node.uuid; option.selected = node.uuid === snapshot.parentUuid; select.append(option);
        }
        parentRow.append(select); fieldPanel.append(parentRow);
        const indexRow = element("div", undefined, "field"); indexRow.append(element("label", "同级顺序"));
        const order = element("input"); order.type = "number"; order.id = "property-order"; indexRow.firstElementChild.htmlFor = order.id;
        order.dataset.focusKey = "move-order";
        order.min = "0"; order.step = "1"; order.originalNumber = snapshot.siblingIndex; order.value = snapshot.siblingIndex; order.setAttribute("aria-label", "同级顺序"); indexRow.append(order); fieldPanel.append(indexRow);
        const options = element("label", undefined, "move-options"); const keepWorld = element("input"); keepWorld.type = "checkbox"; keepWorld.checked = true;
        keepWorld.dataset.focusKey = "move-keep-world";
        options.append(keepWorld, document.createTextNode("改变父节点时保持世界 Transform")); fieldPanel.append(options);
        const initialMove = [select.value, order.value, keepWorld.checked];
        const draft = state.drafts.get("move");
        if (draft) { select.value = draft[0]; order.value = draft[1]; keepWorld.checked = draft[2]; }
        const trackMove = () => {
            order.setCustomValidity("");
            order.removeAttribute("aria-invalid");
            const current = [select.value, controlValue(order), keepWorld.checked];
            if (JSON.stringify(current) === JSON.stringify(initialMove)) state.drafts.delete("move"); else state.drafts.set("move", current);
            parentRow.classList.toggle("dirty", state.drafts.has("move")); indexRow.classList.toggle("dirty", state.drafts.has("move")); updateDraftState();
        };
        parentRow.classList.toggle("dirty", Boolean(draft)); indexRow.classList.toggle("dirty", Boolean(draft));
        select.onchange = () => { order.value = "0"; trackMove(); }; order.oninput = trackMove; keepWorld.onchange = trackMove;
        order.onblur = () => { if (order.value !== "" && order.valueAsNumber === order.originalNumber) order.value = String(order.originalNumber); };
        const move = element("button", "应用层级调整", "apply-move"); fieldPanel.append(move);
        move.onclick = () => work(async () => {
            const submittedDraft = state.drafts.get("move");
            const result = await api({ action: "move", uuid: snapshot.uuid, context: snapshot.context, parentUuid: select.value,
                siblingIndex: numberValue(order), keepWorldTransform: keepWorld.checked });
            if (state.drafts.get("move") === submittedDraft) state.drafts.delete("move");
            state.expanded.add(select.value); renderDetails(result); await refresh(); if (!$("shot").hidden) await capture(); message("层级调整已生效 · 仅运行时生效");
        });
    }
    for (const component of snapshot.components) {
        const group = element("details"); group.open = !state.collapsedComponents.has(component.uuid);
        const summary = element("summary"); const content = element("span", undefined, "component-summary-content");
        const type = element("span", desktop ? `<${component.type.replace(/^cc\./, "")}>` : component.type, "component-type"); type.title = component.type;
        const editable = component.fields.filter(property => property.editable).length;
        const meta = element("span", editable ? `${editable} 可编辑` : "只读", "component-meta");
        meta.title = `${component.fields.length} 个公开字段 · ${editable} 个可编辑`;
        if (desktop) content.append(inspectorIcon(componentIcon(component.type), "component-icon " + componentIcon(component.type)));
        content.append(type, meta); summary.append(content); group.append(summary);
        decorateComponentSummary(summary, component, snapshot);
        group.dataset.uuid = component.uuid; group.dataset.type = component.type.toLowerCase();
        group.ontoggle = () => {
            if (!group.isConnected || $("component-search").value.trim()) return;
            if (group.open) state.collapsedComponents.delete(component.uuid); else state.collapsedComponents.add(component.uuid);
        };
        fieldPanel = group;
        const renderProperty = (property, rootField) => {
            const name = [rootField, ...(property.path || [])].join(".");
            if (property.children) {
                const outer = fieldPanel; const structure = element("details", undefined, "structured-field");
                const structureKey = JSON.stringify([component.uuid, name]); structure.dataset.structureKey = structureKey;
                structure.dataset.autoOpen = String(property.type === "array" && property.children.length <= state.preferences.arrayLimit);
                structure.open = Boolean($("component-search").value) || state.expandedFields.has(structureKey)
                    || !state.closedFields.has(structureKey) && property.type === "array" && property.children.length <= state.preferences.arrayLimit;
                structure.ontoggle = () => {
                    if (!structure.isConnected || $("component-search").value.trim()) return;
                    if (structure.open) { state.expandedFields.add(structureKey); state.closedFields.delete(structureKey); }
                    else { state.expandedFields.delete(structureKey); state.closedFields.add(structureKey); }
                };
                structure.dataset.field = name.toLowerCase(); structure.append(element("summary", name + " " + property.value + (property.truncated ? " · 部分内容" : "")));
                outer.append(structure); fieldPanel = structure;
                for (const child of property.children) renderProperty(child, rootField);
                fieldPanel = outer;
            } else field(name, name, property.value, property.editable, component.uuid, { ...property, rootField });
        };
        const properties = $("sort-fields").checked ? component.fields.slice().sort((a, b) => a.name.localeCompare(b.name)) : component.fields;
        for (const property of properties) renderProperty(property, property.name);
        if (desktop) {
            const enabled = group.querySelector('.field[data-field="enabled"][data-editable="true"]');
            if (enabled) { enabled.classList.add("component-enabled"); content.prepend(enabled); }
        }
        if (!component.fields.length) group.append(element("p", "此组件没有公开字段", "empty"));
        components.append(group);
    }
    components.append(element("p", "没有匹配的组件或字段", "empty component-empty"));
    $("component-count").textContent = snapshot.components.length;
    updatePropertyView(); panel.scrollTop = scrollTop; updateDraftState(); updateControls();
    if (focusedKey) {
        const focused = [...document.querySelectorAll(".properties [data-focus-key]")].find(control => control.dataset.focusKey === focusedKey);
        if (focused && focused.getClientRects().length) {
            focused.focus({ preventScroll: true });
            if (textSelection && focused.value === textSelection.value) focused.setSelectionRange(textSelection.start, textSelection.end);
        }
    }
}
function updatePropertyView() {
    const basic = $("basic-panel"); const components = $("components-panel");
    if (!basic || !components) return;
    const showComponents = state.detailTab === "components";
    document.querySelector(".properties").classList.toggle("components-active", !desktop && showComponents);
    $("property-heading").textContent = desktop ? "节点: " + (state.snapshot.name || "(未命名)") : showComponents ? `${state.snapshot.name || "(未命名)"} · 组件` : "属性检查器";
    $("property-heading").title = state.snapshot.path;
    $("property-tabs").hidden = Boolean(desktop); $("component-tools").hidden = !desktop && !showComponents;
    basic.hidden = !desktop && showComponents; components.hidden = !desktop && !showComponents;
    for (const [id, selected] of [["basic-tab", !showComponents], ["components-tab", showComponents]]) {
        $(id).setAttribute("aria-selected", String(selected)); $(id).tabIndex = selected ? 0 : -1;
    }
    const query = $("component-search").value.trim().toLowerCase();
    $("clear-component-search").hidden = !$("component-search").value;
    let visibleCount = 0;
    for (const group of components.querySelectorAll("details[data-uuid]")) {
        const typeMatches = group.dataset.type.includes(query);
        let visibleFields = 0;
        const rows = group.querySelectorAll(".field");
        for (const row of rows) {
            row.hidden = (!typeMatches && !row.dataset.field.includes(query)) || ($("editable-only").checked && row.dataset.editable !== "true");
            if (!row.hidden) visibleFields++;
        }
        group.hidden = rows.length ? visibleFields === 0 : !typeMatches || $("editable-only").checked;
        if (!group.hidden) visibleCount++;
        group.open = query ? true : !state.collapsedComponents.has(group.dataset.uuid);
        for (const structure of [...group.querySelectorAll(".structured-field")].reverse()) {
            structure.hidden = ![...structure.querySelectorAll(".field")].some(row => !row.hidden);
            if (query && !structure.hidden) structure.open = true;
            else if (!query) structure.open = state.expandedFields.has(structure.dataset.structureKey)
                || structure.dataset.autoOpen === "true" && !state.closedFields.has(structure.dataset.structureKey);
        }
    }
    $("component-count").textContent = query || $("editable-only").checked ? `${visibleCount} / ${state.snapshot.components.length}` : state.snapshot.components.length;
    components.querySelector(".component-empty").hidden = visibleCount > 0;
    components.querySelector(".component-empty").textContent = !state.snapshot.components.length ? "此节点没有组件" : "没有匹配的组件或字段，试试清除筛选。";
    updateControls();
}
function selectPropertyTab(tab) {
    if (desktop) {
        state.detailTab = tab; updatePropertyView();
        $("details").scrollTop = tab === "basic" ? 0 : $("component-tools").offsetTop - $("details").offsetTop;
        return;
    }
    state.detailScroll[state.detailTab] = $("details").scrollTop;
    state.detailTab = tab; updatePropertyView(); $("details").scrollTop = state.detailScroll[tab];
}
$("basic-tab").onclick = () => selectPropertyTab("basic");
$("components-tab").onclick = () => selectPropertyTab("components");
$("component-search").oninput = () => { updatePropertyView(); if (!desktop) $("details").scrollTop = 0; };
$("editable-only").onchange = updatePropertyView;
function clearComponentSearch() { $("component-search").value = ""; updatePropertyView(); $("component-search").focus(); }
$("clear-component-search").onclick = clearComponentSearch;
$("component-search").onkeydown = event => { if (event.key === "Escape") { event.preventDefault(); clearComponentSearch(); } };
function setComponentsExpanded(expanded) {
    if (!state.snapshot) return;
    for (const component of state.snapshot.components) {
        if (expanded) state.collapsedComponents.delete(component.uuid); else state.collapsedComponents.add(component.uuid);
    }
    updatePropertyView();
    for (const structure of $("components-panel").querySelectorAll(".structured-field")) {
        if (expanded) { state.expandedFields.add(structure.dataset.structureKey); state.closedFields.delete(structure.dataset.structureKey); }
        else { state.expandedFields.delete(structure.dataset.structureKey); state.closedFields.add(structure.dataset.structureKey); }
        structure.open = expanded;
    }
}
$("expand-components").onclick = () => setComponentsExpanded(true);
$("collapse-components").onclick = () => setComponentsExpanded(false);
$("property-tabs").onkeydown = event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const components = event.key === "End" || event.key !== "Home" && state.detailTab === "basic";
    selectPropertyTab(components ? "components" : "basic"); $(components ? "components-tab" : "basic-tab").focus();
};
function numberValue(input) {
    const value = input.valueAsNumber;
    if (!Number.isFinite(value) || !input.checkValidity()) {
        input.setCustomValidity("请输入有效数值"); input.setAttribute("aria-invalid", "true"); input.reportValidity(); input.focus();
        throw new Error("请输入有效数值，再应用修改");
    }
    return value;
}
$("refresh").onclick = () => work(() => refresh());
$("capture").onclick = () => work(async () => { await capture(); message("画面已更新"); });
$("pause").onclick = () => work(async () => {
    const result = await api({ action: state.tree.paused ? "resume" : "pause", context: state.tree.context });
    state.tree.paused = result.paused; updateEngineState();
    message(result.paused ? desktop ? "引擎更新已暂停 · 可直接调整节点" : "引擎更新已暂停；可调整节点并更新画面" : "游戏已继续");
});
$("search").oninput = renderTree; $("inactive").onchange = renderTree;
function clearSearch() { $("search").value = ""; renderTree(); $("search").focus(); }
$("clear-search").onclick = clearSearch;
$("search").onkeydown = event => { if (event.key === "Escape") { event.preventDefault(); clearSearch(); } };
$("auto").onchange = updateSyncState;
$("expand-all").onclick = () => { if (state.tree) for (const node of state.tree.nodes) if (node.childCount) state.expanded.add(node.uuid); renderTree(); };
$("collapse-all").onclick = () => { state.expanded.clear(); clearSearch(); };
function revealSelection() {
    if (!state.selected || !state.tree) return;
    const byId = new Map(state.tree.nodes.map(node => [node.uuid, node]));
    const selected = byId.get(state.selected);
    if (selected && !selected.activeInHierarchy) $("inactive").checked = true;
    for (let node = selected; node; node = byId.get(node.parentUuid)) state.expanded.add(node.uuid);
    $("search").value = ""; renderTree();
    focusTreeRow([...$("tree").querySelectorAll(".row")].find(row => row.dataset.uuid === state.selected));
}
$("reveal-selection").onclick = revealSelection;
$("discard-draft").onclick = () => work(async () => {
    if (!state.selected || !state.tree) return;
    const snapshot = await api({ action: "inspect", uuid: state.selected, context: state.tree.context });
    state.drafts.clear(); renderDetails(snapshot); message("已放弃待应用修改，恢复当前运行时属性");
});
document.addEventListener("keydown", event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault(); if (desktop) $("nodes-tab").click(); $("search").focus(); $("search").select();
    }
});
$("deselect").onclick = () => { emptySelection("选择节点以查看和调整属性"); renderTree(); };
if (desktop) {
    // Keep the browser entry's controls intact; the native window arranges them
    // like CocosInspector's game toolbar and scene tabs.
    const iconButton = (button, name, label) => {
        button.classList.add("icon-button"); button.setAttribute("aria-label", label); button.title = button.title || label;
        button.replaceChildren(inspectorIcon(name), element("span", label, "sr-only")); return button;
    };
    const previewTools = $("preview-tools"); previewTools.hidden = false;
    previewTools.querySelector(".preview-tools-left").append(iconButton($("reload-preview"), "refresh", "重载游戏"));
    const gameButtons = previewTools.querySelector(".preview-tools-right");
    gameButtons.append(iconButton($("pause"), "pause", "暂停游戏"));
    for (const [id, icon, label] of [["fps", "fps", "显示 / 隐藏 FPS"], ["mute", "sound", "静音 / 恢复声音"],
        ["pick", "locate", "画面选择节点 · 左键 2D / 右键 3D"], ["design", "move", "设计模式 · 拖拽 2D 节点"], ["resolution", "resolution", "调整预览分辨率"]]) {
        const button = iconButton(element("button"), icon, label); button.id = id; button.setAttribute("aria-pressed", "false"); gameButtons.append(button);
    }
    let previewState = { fps: false, muted: false, mode: "off", resolution: { width: 0, height: 0 }, viewport: null };
    const drawPreviewTools = () => {
        for (const [id, pressed] of [["fps", previewState.fps], ["mute", previewState.muted], ["pick", previewState.mode.startsWith("pick")],
            ["design", previewState.mode === "drag"], ["resolution", !$("resolution-panel").hidden]]) $(id).setAttribute("aria-pressed", String(pressed));
        $("mute").replaceChildren(inspectorIcon(previewState.muted ? "muted" : "sound"), element("span", previewState.muted ? "恢复声音" : "静音", "sr-only"));
        $("mute").title = previewState.muted ? "恢复声音" : "静音";
        $("pick").classList.toggle("pick-3d", previewState.mode === "pick3d");
        $("pick").title = (previewState.mode === "pick3d" ? "3D 模型选取" : "2D 节点选取") + " · 左键切换 2D / 右键切换 3D · Esc 退出";
        $("design").title = previewState.mode === "drag" ? "设计模式已开启 · 拖拽 2D 节点 · Esc 退出 / 取消拖拽" : "设计模式 · 拖拽 2D 节点";
        const size = previewState.resolution;
        $("resolution-state").textContent = size.width ? `${size.width} × ${size.height} · 等比缩放，保留当前游戏` : "适应窗口 · 切换分辨率保留当前游戏";
    };
    syncPreviewTools = async () => { previewState = await desktop.previewTool({ action: "state" }); drawPreviewTools(); };
    syncPreviewSelection = async uuid => { await desktop.previewTool({ action: "selection", uuid }); };
    const changePreviewTool = async request => {
        previewState = await desktop.previewTool(request); drawPreviewTools();
        if (request.action === "mode") {
            if (previewState.mode === "off") await refresh();
            message(previewState.mode === "off" ? "已退出画面工具 · 恢复正常游戏操作" :
                previewState.mode === "drag" ? "设计模式 · 在画面中拖拽节点，Esc 取消 / 退出" : "在画面中点击选择节点 · Esc 退出");
        }
        else if (request.action === "fps") message(previewState.fps ? "FPS 已显示" : "FPS 已隐藏");
        else if (request.action === "mute") message(previewState.muted ? "当前游戏已静音" : "当前游戏声音已恢复");
        else if (request.action === "resolution") message($("resolution-state").textContent);
    };
    $("fps").onclick = () => work(() => changePreviewTool({ action: "fps", enabled: !previewState.fps }));
    $("mute").onclick = () => work(() => changePreviewTool({ action: "mute", enabled: !previewState.muted }));
    $("pick").onclick = () => work(() => changePreviewTool({ action: "mode", mode: previewState.mode === "pick2d" ? "off" : "pick2d" }));
    $("pick").oncontextmenu = event => { event.preventDefault(); if ($("pick").disabled) return; work(() => changePreviewTool({ action: "mode", mode: previewState.mode === "pick3d" ? "off" : "pick3d" })); };
    $("design").onclick = () => work(() => changePreviewTool({ action: "mode", mode: previewState.mode === "drag" ? "off" : "drag" }));
    $("resolution").setAttribute("aria-controls", "resolution-panel"); $("resolution").setAttribute("aria-expanded", "false");
    const closeResolution = () => { $("resolution-panel").hidden = true; $("resolution").setAttribute("aria-expanded", "false"); drawPreviewTools(); };
    $("resolution").onclick = () => { $("resolution-panel").hidden = !$("resolution-panel").hidden; $("resolution").setAttribute("aria-expanded", String(!$("resolution-panel").hidden)); drawPreviewTools(); };
    $("resolution-close").onclick = closeResolution;
    const sizeInputs = [$("resolution-width"), $("resolution-height")];
    const applyResolution = () => work(async () => {
        if (!sizeInputs.every(input => input.reportValidity())) throw new Error("请输入 160–4096 的整数分辨率");
        await changePreviewTool({ action: "resolution", width: sizeInputs[0].valueAsNumber, height: sizeInputs[1].valueAsNumber });
    });
    $("resolution-apply").onclick = () => { $("resolution-preset").value = "custom"; applyResolution(); };
    sizeInputs.forEach(input => { input.oninput = () => { $("resolution-preset").value = "custom"; }; input.onkeydown = event => { if (event.key === "Enter") { event.preventDefault(); applyResolution(); } }; });
    $("resolution-preset").onchange = () => {
        const preset = $("resolution-preset").value;
        if (preset === "auto") work(() => changePreviewTool({ action: "resolution", width: 0, height: 0 }));
        else if (preset !== "custom") { preset.split("x").forEach((value, index) => { sizeInputs[index].value = value; }); applyResolution(); }
    };
    $("resolution-rotate").onclick = () => {
        const size = previewState.resolution.width ? previewState.resolution : previewState.viewport;
        if (!size) return;
        sizeInputs[0].value = size.height; sizeInputs[1].value = size.width; $("resolution-preset").value = "custom"; applyResolution();
    };
    document.addEventListener("keydown", event => { if (event.key === "Escape" && !$("resolution-panel").hidden) { closeResolution(); $("resolution").focus(); } });
    desktop.onGameToolEvent(event => {
        if (event.kind === "state") { previewState = event.state; drawPreviewTools(); }
        else if (event.kind === "mode") { previewState.mode = event.mode; drawPreviewTools(); work(async () => { await refresh(); message("已退出画面工具 · 恢复正常游戏操作"); }); }
        else if (event.kind === "error") message("画面工具：" + event.message, true);
        else if (["select", "drag"].includes(event.kind)) work(async () => {
            await refresh(); await selectNode(event.uuid); await selectPanel("nodes");
            const byId = new Map(state.tree.nodes.map(node => [node.uuid, node]));
            for (let node = byId.get(event.uuid); node; node = byId.get(node.parentUuid)) state.expanded.add(node.uuid);
            $("search").value = ""; renderTree();
            [...$("tree").querySelectorAll(".row")].find(row => row.dataset.uuid === event.uuid)?.querySelector(".name").scrollIntoView({ block: "nearest", inline: "nearest" });
            if (event.kind === "drag") message("已拖拽 " + state.snapshot.name + " · 仅运行时生效");
        });
    });
    drawPreviewTools();
    const tabs = $("inspector-tabs");
    $("nodes-tab").replaceChildren(inspectorIcon("flame", "scene-icon"), document.createTextNode("game"));
    $("nodes-tab").append($("scene"));
    $("devtools-tab").prepend(inspectorIcon("terminal"));
    tabs.insertBefore(iconButton($("refresh"), "refresh", "刷新节点树"), $("devtools-tab"));
    const actions = element("div", undefined, "panel-actions"); tabs.append(actions);
    actions.append(iconButton($("ai-connect"), "ai", "AI 接入"));
    const menu = $("inspector-menu"); let menuOpener = null;
    const closeMenu = (restoreFocus = true) => {
        menu.hidden = true;
        for (const button of actions.querySelectorAll("[aria-expanded]")) button.setAttribute("aria-expanded", "false");
        if (restoreFocus) menuOpener?.focus({ preventScroll: true });
    };
    for (const [id, label, icon] of [["evidence", "调试记录", "record"], ["help", "帮助", "help"], ["settings", "设置", "settings"]]) {
        const button = iconButton(element("button"), icon, label); button.id = id + "-menu";
        button.setAttribute("aria-controls", "inspector-menu"); button.setAttribute("aria-expanded", "false"); actions.append(button);
        button.onclick = () => {
            const closing = !menu.hidden && menuOpener === button; closeMenu(false); if (closing) return;
            menuOpener = button; $("menu-heading").textContent = label;
            for (const section of ["settings", "help", "evidence"]) $("menu-" + section).hidden = section !== id;
            menu.hidden = false; button.setAttribute("aria-expanded", "true"); $("close-menu").focus({ preventScroll: true });
        };
    }
    $("close-menu").onclick = () => closeMenu();
    document.addEventListener("keydown", event => { if (event.key === "Escape" && !menu.hidden) { event.preventDefault(); closeMenu(); } });
    document.addEventListener("pointerdown", event => { if (!menu.hidden && !menu.contains(event.target) && !actions.contains(event.target)) closeMenu(false); });
    $("menu-settings").prepend($("auto").closest("label"), ...document.querySelectorAll(".appearance-control"));
    $("menu-settings").append($("devtools")); $("devtools").textContent = "打开游戏开发者工具";
    $("menu-evidence").append($("evidence-bar"));
    const footer = document.querySelector("footer"); footer.append($("ai-activity"));
    const treeTools = document.querySelector(".tree-tools");
    document.querySelector(".hierarchy").append(treeTools);
    const treeOptions = treeTools.querySelector(".tree-actions"); treeOptions.id = "tree-options"; treeOptions.hidden = true;
    const treeMenu = iconButton(element("button"), "more", "节点树选项"); treeMenu.id = "tree-menu";
    treeMenu.setAttribute("aria-controls", "tree-options"); treeMenu.setAttribute("aria-expanded", "false");
    treeTools.querySelector(".search-box").append(treeMenu);
    treeMenu.onclick = () => { treeOptions.hidden = !treeOptions.hidden; treeMenu.setAttribute("aria-expanded", String(!treeOptions.hidden)); };
    treeTools.addEventListener("keydown", event => { if (event.key === "Escape") { treeOptions.hidden = true; treeMenu.setAttribute("aria-expanded", "false"); } });
    document.addEventListener("pointerdown", event => { if (!treeTools.contains(event.target)) { treeOptions.hidden = true; treeMenu.setAttribute("aria-expanded", "false"); } });
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
        const main = document.querySelector("main").getBoundingClientRect();
        $("splitter").style.top = `${main.top}px`; $("splitter").style.bottom = `${window.innerHeight - main.bottom}px`;
    };
    const observer = new ResizeObserver(updateBounds); observer.observe(canvas); observer.observe(devToolsHost);
    window.addEventListener("resize", updateBounds); updateBounds();
    $("inspector-tabs").hidden = false;
    $("node-panels").setAttribute("role", "tabpanel"); $("node-panels").setAttribute("aria-labelledby", "nodes-tab");
    $("property-splitter").hidden = false;
    const propertySplitter = $("property-splitter");
    const nodePanels = $("node-panels");
    const hierarchy = document.querySelector(".hierarchy");
    let treeFraction = 0.45; let draggingProperties = false;
    function propertyLimits() {
        const available = nodePanels.getBoundingClientRect().width - 5;
        return { available, minimum: 220 / available, maximum: 1 - 360 / available };
    }
    function updatePropertySize() {
        const limits = propertyLimits();
        if (limits.available <= 0 || limits.minimum > limits.maximum) return;
        const fraction = Math.max(limits.minimum, Math.min(limits.maximum, treeFraction));
        document.body.style.setProperty("--tree-width", `${fraction}fr`);
        document.body.style.setProperty("--property-width", `${1 - fraction}fr`);
        propertySplitter.setAttribute("aria-valuemin", String(Math.round(limits.minimum * 100)));
        propertySplitter.setAttribute("aria-valuemax", String(Math.round(limits.maximum * 100)));
        propertySplitter.setAttribute("aria-valuenow", String(Math.round(fraction * 100)));
        propertySplitter.title = "拖动调整宽度 · ← → 调整 · 双击恢复默认";
    }
    function setPropertyFraction(fraction) {
        const limits = propertyLimits();
        if (limits.available <= 0 || limits.minimum > limits.maximum) return;
        treeFraction = Math.max(limits.minimum, Math.min(limits.maximum, fraction));
        updatePropertySize();
    }
    const propertyObserver = new ResizeObserver(updatePropertySize); propertyObserver.observe(nodePanels);
    propertySplitter.onpointerdown = event => { draggingProperties = true; document.body.classList.add("resizing-properties"); propertySplitter.setPointerCapture(event.pointerId); };
    propertySplitter.onpointermove = event => {
        if (draggingProperties) setPropertyFraction((event.clientX - nodePanels.getBoundingClientRect().left) / propertyLimits().available);
    };
    const stopPropertyDrag = () => { draggingProperties = false; document.body.classList.remove("resizing-properties"); };
    propertySplitter.onpointerup = propertySplitter.onlostpointercapture = propertySplitter.onpointercancel = stopPropertyDrag;
    propertySplitter.ondblclick = () => { treeFraction = 0.45; updatePropertySize(); };
    propertySplitter.onkeydown = event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault(); const limits = propertyLimits();
        const fraction = hierarchy.getBoundingClientRect().width / limits.available;
        setPropertyFraction(event.key === "Home" ? limits.minimum : event.key === "End" ? limits.maximum : fraction + (event.key === "ArrowLeft" ? -0.025 : 0.025));
    };
    function showPanel(mode) {
        const tools = mode === "devtools"; document.body.classList.toggle("devtools-active", tools); devToolsHost.hidden = !tools;
        $("nodes-tab").setAttribute("aria-selected", String(!tools)); $("devtools-tab").setAttribute("aria-selected", String(tools));
        $("nodes-tab").tabIndex = tools ? -1 : 0; $("devtools-tab").tabIndex = tools ? 0 : -1;
        $("devtools").setAttribute("aria-pressed", String(tools)); updateBounds();
        $("close-devtools").hidden = !tools;
        inspectorPanelChanged(mode);
    }
    async function selectPanel(mode) {
        showPanel(mode);
        try { await desktop.selectPanel(mode); }
        catch (error) { showPanel("nodes"); message(error.message, true); }
    }
    selectInspectorPanel = selectPanel;
    desktop.onPanelMode(showPanel);
    $("nodes-tab").onclick = () => selectPanel("nodes");
    $("devtools-tab").onclick = () => selectPanel("devtools");
    $("inspector-tabs").onkeydown = event => {
        if (!["nodes-tab", "devtools-tab"].includes(event.target.id) || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const tab = event.key === "Home" ? $("nodes-tab") : event.key === "End" ? $("devtools-tab") :
            event.target.id === "nodes-tab" ? $("devtools-tab") : $("nodes-tab");
        tab.click(); tab.focus();
    };
    $("close-devtools").onclick = async () => {
        try { await desktop.closeDevTools(); showPanel("nodes"); }
        catch (error) { message(error.message, true); }
    };
    $("reload-preview").onclick = () => work(async () => { await desktop.reloadPreview(); await refresh(); message("当前桌面游戏实例已重载"); });
    $("devtools").onclick = () => selectPanel(document.body.classList.contains("devtools-active") ? "nodes" : "devtools");
    let dragging = false;
    function splitAt(width) {
        const maximum = Math.min(0.7, 1 - 585 / window.innerWidth);
        const fraction = Math.max(0.3, Math.min(maximum, width)); document.body.style.setProperty("--preview-width", `${fraction * 100}%`);
        $("splitter").setAttribute("aria-valuemax", String(Math.round(maximum * 100)));
        $("splitter").setAttribute("aria-valuenow", String(Math.round(fraction * 100)));
        updateBounds();
        try { localStorage.setItem("inspector-preview-width", String(fraction)); } catch { /* Layout still works when storage is unavailable. */ }
    }
    let initialPreviewWidth = 0.46;
    try { const saved = Number(localStorage.getItem("inspector-preview-width")); if (saved >= 0.3 && saved <= 0.7) initialPreviewWidth = saved; } catch { /* Use the default width. */ }
    splitAt(initialPreviewWidth);
    window.addEventListener("resize", () => splitAt(parseFloat(document.body.style.getPropertyValue("--preview-width") || "46") / 100));
    $("splitter").onpointerdown = event => { dragging = true; document.body.classList.add("resizing"); $("splitter").setPointerCapture(event.pointerId); };
    $("splitter").onpointermove = event => { if (dragging) splitAt(event.clientX / window.innerWidth); };
    const stopDragging = () => { dragging = false; document.body.classList.remove("resizing"); };
    $("splitter").onpointerup = stopDragging;
    $("splitter").onlostpointercapture = stopDragging;
    $("splitter").onpointercancel = stopDragging;
    $("splitter").ondblclick = () => splitAt(0.46);
    $("splitter").onkeydown = event => {
        if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return; event.preventDefault();
        splitAt(parseFloat(document.body.style.getPropertyValue("--preview-width") || "46") / 100 + (event.key === "ArrowLeft" ? -0.025 : 0.025));
    };
}
updateControls();
if (!desktop) $("preview-heading").textContent = "画面快照";
setInterval(() => { if ($("auto").checked && !document.hidden) work(() => refresh(true), true); }, 1000);
work(async () => {
    await refresh(); const status = await api({ action: "status" });
    if (desktop) await syncPreviewTools();
    $("connection").textContent = `人工调试实例: ${status.instance?.id || "manual-cli"} · Target: ${status.instance?.target?.id || "未知"} · 场景: ${state.tree.scene}`;
    if (desktop) document.title = `Cocos Live Probe Inspector · ${state.tree.scene}`;
    else await capture();
    message(desktop ? "桌面预览已连接 · 左侧直接操作游戏，右侧选择节点调试" : "已连接 · 选择节点开始调试");
});
