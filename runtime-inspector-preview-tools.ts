export type PreviewInteractionMode = "off" | "pick2d" | "pick3d" | "drag";
export type PreviewRuntimeTool = { action: "state" } | { action: "fps"; enabled: boolean }
    | { action: "mode"; mode: PreviewInteractionMode }
    | { action: "selection"; uuid: string | null };
export type PreviewToolRequest = PreviewRuntimeTool | { action: "mute"; enabled: boolean }
    | { action: "cache"; operation: "http" | "cookies" }
    | { action: "resolution"; width: number; height: number };

export function parsePreviewToolRequest(value: unknown): PreviewToolRequest {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid preview tool request");
    const request = value as Record<string, unknown>;
    const keys: Record<string, string[]> = { state: ["action"], fps: ["action", "enabled"], mute: ["action", "enabled"],
        mode: ["action", "mode"], selection: ["action", "uuid"], resolution: ["action", "width", "height"], cache: ["action", "operation"] };
    const allowed = Object.prototype.hasOwnProperty.call(keys, String(request.action)) ? keys[String(request.action)] : undefined;
    if (!allowed || Object.keys(request).length !== allowed.length || Object.keys(request).some(key => !allowed.includes(key))) {
        throw new Error("Invalid preview tool arguments");
    }
    if (["fps", "mute"].includes(String(request.action)) && typeof request.enabled !== "boolean") throw new Error("Expected enabled boolean");
    if (request.action === "cache" && !["http", "cookies"].includes(String(request.operation))) throw new Error("Invalid cache operation");
    if (request.action === "mode" && !["off", "pick2d", "pick3d", "drag"].includes(String(request.mode))) throw new Error("Invalid interaction mode");
    if (request.action === "selection" && request.uuid !== null && (typeof request.uuid !== "string" || request.uuid.length > 256)) {
        throw new Error("Invalid selected node UUID");
    }
    if (request.action === "resolution") {
        const dimensions = [request.width, request.height];
        if (!(request.width === 0 && request.height === 0) && dimensions.some(size => !Number.isInteger(size) || Number(size) < 160 || Number(size) > 4096)) {
            throw new Error("分辨率须为 160–4096 的整数；0 × 0 表示适应窗口");
        }
    }
    return request as PreviewToolRequest;
}

// Executed in the owned game page. The overlay uses DOM pointer capture, so
// picking/design gestures cannot also trigger Cocos buttons or touch handlers.
async function runtimePreviewTools(request: PreviewRuntimeTool): Promise<unknown> {
    const runtime = globalThis as any;
    let cc = runtime.cc;
    if (runtime.System?.import) cc = await runtime.System.import("cc");
    else if (runtime.System?.resolve && runtime.System?.get) cc = runtime.System.get(await runtime.System.resolve("cc"));
    if (!cc?.director?.getScene()) throw new Error("游戏场景尚未就绪");
    const key = "__cocosLiveInspectorPreviewTools";
    const state = runtime[key] || (runtime[key] = { mode: "off", overlay: null, drag: null, frame: 0, hover: null,
        selectionUuid: null, selectionNode: null, selectionScene: null, selectionCameras: null,
        selectionOverlay: null, selectionOutline: null, selectionFrame: 0 });
    const notify = (event: unknown) => runtime.liveProbeGameTools?.report(event);
    const valid = (node: any) => cc.isValid(node, true) && node.activeInHierarchy;
    const sceneNodes = (scene: any) => {
        const nodes: any[] = [], stack = [{ node: scene, visited: false }];
        while (stack.length && nodes.length < 20000) {
            const { node, visited } = stack.pop()!; if (!valid(node)) continue;
            if (visited) nodes.push(node);
            else {
                // Later siblings render above earlier ones; a child is picked
                // before the enclosing Canvas/container rectangle.
                stack.push({ node, visited: true });
                for (const child of node.children) stack.push({ node: child, visited: false });
            }
        }
        return nodes;
    };
    const geometry = () => {
        const canvas = cc.game?.canvas;
        const rect = canvas?.getBoundingClientRect();
        if (!canvas?.width || !canvas.height || !rect?.width || !rect.height) throw new Error("游戏画布不可见");
        return { canvas, rect };
    };
    const screenPoint = (x: number, y: number) => {
        const { canvas, rect } = geometry();
        return new cc.Vec3((x - rect.left) * canvas.width / rect.width, (rect.bottom - y) * canvas.height / rect.height, 0);
    };
    const pagePoint = (point: any) => {
        const { canvas, rect } = geometry();
        return { x: rect.left + point.x * rect.width / canvas.width, y: rect.bottom - point.y * rect.height / canvas.height };
    };
    const quadFor = (node: any, camera: any) => {
        const ui = cc.UITransform && node.getComponent(cc.UITransform);
        if (!ui?.width || !ui.height) return null;
        const x = -ui.anchorPoint.x * ui.width, y = -ui.anchorPoint.y * ui.height;
        return [[x, y], [x + ui.width, y], [x + ui.width, y + ui.height], [x, y + ui.height]]
            .map(([px, py]) => pagePoint(camera.worldToScreen(ui.convertToWorldSpaceAR(new cc.Vec3(px, py, 0)))));
    };
    const modelQuadFor = (node: any, camera: any) => {
        const bounds = node.components.find((component: any) => component.model?.worldBounds)?.model?.worldBounds;
        if (!bounds) return null;
        const projected = [];
        for (const dx of [-1, 1]) for (const dy of [-1, 1]) for (const dz of [-1, 1]) projected.push(pagePoint(camera.worldToScreen(new cc.Vec3(
            bounds.center.x + dx * bounds.halfExtents.x, bounds.center.y + dy * bounds.halfExtents.y, bounds.center.z + dz * bounds.halfExtents.z))));
        const left = Math.min(...projected.map((point: any) => point.x)), right = Math.max(...projected.map((point: any) => point.x));
        const top = Math.min(...projected.map((point: any) => point.y)), bottom = Math.max(...projected.map((point: any) => point.y));
        return [{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }];
    };
    const camerasFor = (nodes: any[]) => nodes.flatMap(node => node.components.filter((component: any) => component instanceof cc.Camera))
        .filter(camera => camera.enabled && !camera.targetTexture).sort((a, b) => b.priority - a.priority);
    const selectionHit = () => {
        if (!state.selectionUuid) return null;
        const scene = cc.director.getScene();
        if (state.selectionScene !== scene || !valid(state.selectionNode) || state.selectionNode?.uuid !== state.selectionUuid) {
            const nodes = sceneNodes(scene);
            state.selectionNode = nodes.find(item => item.uuid === state.selectionUuid) || null;
            state.selectionScene = scene; state.selectionCameras = camerasFor(nodes);
        }
        const node = state.selectionNode;
        if (!node) return null;
        for (const camera of state.selectionCameras || []) {
            if (!(camera.visibility & node.layer)) continue;
            const points = quadFor(node, camera) || modelQuadFor(node, camera);
            if (points?.length) return { node, camera, scene, points };
        }
        return null;
    };
    const contains = (points: any[], x: number, y: number) => {
        let inside = false;
        for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
            const a = points[i], b = points[j];
            if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
        }
        return inside;
    };
    const pick = (x: number, y: number) => {
        const scene = cc.director.getScene(), nodes = sceneNodes(scene), screen = screenPoint(x, y);
        const { rect } = geometry(); if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return null;
        const cameras = camerasFor(nodes);
        if (state.mode === "pick3d") {
            let closest: any = null;
            for (const camera of cameras) {
                const ray = camera.screenPointToRay(screen.x, screen.y);
                for (const node of nodes) {
                    if (!(camera.visibility & node.layer)) continue;
                    for (const component of node.components) {
                        const bounds = component.model?.worldBounds;
                        if (!bounds || component.enabled === false) continue;
                        const distance = cc.geometry.intersect.rayAABB(ray, bounds);
                        if (distance > 0 && (!closest || distance < closest.distance)) {
                            const projected = [];
                            for (const dx of [-1, 1]) for (const dy of [-1, 1]) for (const dz of [-1, 1]) projected.push(pagePoint(camera.worldToScreen(new cc.Vec3(
                                bounds.center.x + dx * bounds.halfExtents.x, bounds.center.y + dy * bounds.halfExtents.y, bounds.center.z + dz * bounds.halfExtents.z))));
                            const left = Math.min(...projected.map(p => p.x)), right = Math.max(...projected.map(p => p.x)),
                                top = Math.min(...projected.map(p => p.y)), bottom = Math.max(...projected.map(p => p.y));
                            closest = { node, camera, scene, distance, points: [{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }] };
                        }
                    }
                }
                if (closest) break;
            }
            return closest;
        }
        for (const camera of cameras) for (const node of nodes) {
            if (!(camera.visibility & node.layer) || node === scene || node.name === "PROFILER_NODE") continue;
            // Match CocosInspector's 2D hover targets: UITransform alone is a
            // layout rectangle, and must not obscure smaller rendered nodes.
            const renderer = cc.UIRenderer && node.getComponent(cc.UIRenderer);
            if (!renderer?.enabledInHierarchy) continue;
            const points = quadFor(node, camera); if (!points || !contains(points, x, y)) continue;
            let clipped = false;
            // Mask.isHit expects world coordinates, like UITransform.hitTest in
            // Cocos' node event path (used by CocosInspector), not screen pixels.
            const world = camera.screenToWorld(screen);
            for (let ancestor = node; ancestor; ancestor = ancestor.parent) {
                const mask = cc.Mask && ancestor.getComponent(cc.Mask);
                if (!mask?.enabled) continue;
                if (typeof mask.isHit === "function" ? !mask.isHit(new cc.Vec2(world.x, world.y))
                    : !contains(quadFor(ancestor, camera) || [], x, y)) { clipped = true; break; }
            }
            if (!clipped) return { node, camera, scene, points };
        }
        return null;
    };
    const hideHighlight = () => { state.hover = null; state.outline?.setAttribute("points", ""); if (state.label) state.label.hidden = true; };
    const highlight = (hit: any) => {
        state.hover = hit;
        state.outline.setAttribute("points", hit?.points?.map((p: any) => `${p.x},${p.y}`).join(" ") || "");
        state.label.hidden = !hit;
        if (hit) {
            state.label.textContent = (state.mode === "drag" ? "拖拽 · " : "选择 · ") + (hit.node.name || "(未命名)");
            const p = hit.points?.[3] || { x: 8, y: 32 };
            state.label.style.left = `${Math.max(4, Math.min(innerWidth - 180, p.x))}px`;
            state.label.style.top = `${Math.max(4, Math.min(innerHeight - 24, p.y - 25))}px`;
        }
    };
    const removeSelectionOverlay = () => {
        if (state.selectionFrame) cancelAnimationFrame(state.selectionFrame);
        state.selectionFrame = 0; state.selectionOverlay?.remove(); state.selectionOverlay = null; state.selectionOutline = null;
    };
    const renderSelection = () => {
        state.selectionFrame = 0;
        if (!state.selectionUuid || !state.selectionOutline) return;
        let hit = null;
        try { hit = selectionHit(); } catch { /* The scene can be replaced between frames. */ }
        state.selectionOutline.setAttribute("points", hit?.points?.map((point: any) => `${point.x},${point.y}`).join(" ") || "");
        if (state.selectionUuid) state.selectionFrame = requestAnimationFrame(renderSelection);
    };
    const ensureSelectionOverlay = () => {
        if (state.selectionOverlay) return;
        const overlay = document.createElement("div"); overlay.id = "live-probe-selection-overlay";
        overlay.style.cssText = "position:fixed;inset:0;z-index:2147483645;pointer-events:none;user-select:none;";
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.style.cssText = "position:absolute;inset:0;width:100%;height:100%;overflow:visible";
        const outline = document.createElementNS(svg.namespaceURI, "polygon");
        outline.setAttribute("fill", "rgba(255,255,255,.035)"); outline.setAttribute("stroke", "#fff"); outline.setAttribute("stroke-width", "2");
        outline.setAttribute("vector-effect", "non-scaling-stroke"); svg.append(outline); overlay.append(svg); document.body.append(overlay);
        state.selectionOverlay = overlay; state.selectionOutline = outline;
    };
    const cancelDrag = (restore: boolean) => {
        const drag = state.drag; state.drag = null;
        if (restore && drag && cc.director.getScene() === drag.scene && cc.isValid(drag.node, true) && drag.node.parent === drag.parent) drag.node.setPosition(drag.local);
    };
    const stop = () => {
        cancelDrag(true); if (state.frame) cancelAnimationFrame(state.frame); state.frame = 0;
        state.overlay?.remove(); state.overlay = null; hideHighlight();
        if (state.escape) window.removeEventListener("keydown", state.escape, true);
        state.escape = null; state.mode = "off";
    };
    if (request.action === "selection") {
        state.selectionUuid = request.uuid;
        state.selectionNode = null; state.selectionScene = null; state.selectionCameras = null;
        if (!request.uuid) removeSelectionOverlay();
        else { ensureSelectionOverlay(); if (!state.selectionFrame) state.selectionFrame = requestAnimationFrame(renderSelection); }
    }
    if (request.action === "fps") {
        if (!cc.profiler?.showStats || !cc.profiler.hideStats) throw new Error("当前引擎未提供 FPS profiler");
        cc.profiler[request.enabled ? "showStats" : "hideStats"]();
    }
    if (request.action === "mode") {
        if (request.mode === "pick3d" && !cc.geometry?.intersect?.rayAABB) throw new Error("当前引擎未提供 3D 模型射线检测");
        stop(); state.mode = request.mode;
        if (state.mode !== "off") {
            if (!runtime.liveProbeGameTools) { state.mode = "off"; throw new Error("画面工具须通过桌面预览使用"); }
            const overlay = document.createElement("div"); overlay.id = "live-probe-design-overlay";
            overlay.style.cssText = "position:fixed;inset:0;z-index:2147483646;touch-action:none;user-select:none;background:transparent;";
            overlay.style.cursor = state.mode === "drag" ? "move" : "crosshair";
            const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            svg.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible";
            const outline = document.createElementNS(svg.namespaceURI, "polygon");
            outline.setAttribute("fill", "rgba(72,170,255,.12)"); outline.setAttribute("stroke", "#5bb8ff"); outline.setAttribute("stroke-width", "2"); svg.append(outline);
            const label = document.createElement("div"); label.hidden = true;
            label.style.cssText = "position:absolute;pointer-events:none;padding:2px 6px;max-width:240px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;background:#163b60;color:white;font:12px/18px sans-serif;border-radius:3px";
            overlay.append(svg, label); document.body.append(overlay); state.overlay = overlay; state.outline = outline; state.label = label;
            const reportSelection = (hit: any, changed = false) => {
                if (hit) notify({ kind: changed ? "drag" : "select", uuid: hit.node.uuid });
            };
            const runPointer = (x: number, y: number) => {
                const drag = state.drag;
                if (drag) {
                    if (cc.director.getScene() !== drag.scene || !valid(drag.node) || drag.node.parent !== drag.parent) { cancelDrag(false); hideHighlight(); return; }
                    const screen = screenPoint(x, y); screen.z = drag.depth;
                    const world = drag.camera.screenToWorld(screen);
                    drag.node.setWorldPosition(new cc.Vec3(drag.world.x + world.x - drag.start.x,
                        drag.world.y + world.y - drag.start.y, drag.world.z + world.z - drag.start.z));
                    highlight({ ...drag, points: quadFor(drag.node, drag.camera) });
                } else highlight(pick(x, y));
            };
            const safePointer = (x: number, y: number) => {
                try { runPointer(x, y); } catch (error) { cancelDrag(true); hideHighlight(); notify({ kind: "error", message: String(error) }); }
            };
            overlay.onpointermove = event => {
                state.pointer = { x: event.clientX, y: event.clientY };
                if (!state.frame) state.frame = requestAnimationFrame(() => { state.frame = 0; safePointer(state.pointer.x, state.pointer.y); });
            };
            overlay.onpointerdown = event => {
                if (event.button !== 0) return; event.preventDefault();
                try {
                    const hit = pick(event.clientX, event.clientY); highlight(hit); if (!hit) return;
                    reportSelection(hit); overlay.setPointerCapture(event.pointerId);
                    if (state.mode === "drag") {
                        const world = hit.node.worldPosition.clone(), screen = screenPoint(event.clientX, event.clientY);
                        screen.z = hit.camera.worldToScreen(world).z;
                        state.drag = { ...hit, world, local: hit.node.position.clone(), parent: hit.node.parent, depth: screen.z, start: hit.camera.screenToWorld(screen) };
                    }
                } catch (error) { notify({ kind: "error", message: String(error) }); }
            };
            overlay.onpointerup = event => {
                if (!state.drag) return;
                safePointer(event.clientX, event.clientY); const drag = state.drag;
                cancelDrag(false); if (drag && cc.director.getScene() === drag.scene && valid(drag.node)) reportSelection(drag, true);
            };
            overlay.onpointercancel = overlay.onlostpointercapture = () => cancelDrag(true);
            overlay.onpointerleave = () => { if (!state.drag) hideHighlight(); };
            state.escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); stop(); notify({ kind: "mode", mode: "off" }); } };
            window.addEventListener("keydown", state.escape, true);
        }
    }
    return { mode: state.mode, fps: Boolean(cc.profiler?.isShowingStats?.()), selectionUuid: state.selectionUuid,
        viewport: { width: innerWidth, height: innerHeight } };
}

export function buildPreviewToolsExpression(request: PreviewRuntimeTool): string {
    const parsed = parsePreviewToolRequest(request);
    if (!["state", "fps", "mode", "selection"].includes(parsed.action)) throw new Error("Expected a runtime preview tool");
    return `(${runtimePreviewTools.toString()})(${JSON.stringify(parsed)})`;
}
