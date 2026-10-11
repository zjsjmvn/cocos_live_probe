export type WorkbenchRequest =
    | { action: "runtime-info"; context: string }
    | { action: "runtime-assets"; context: string; query: string; offset: number }
    | { action: "runtime-setting"; context: string; name: "frameRate" | "retina"; value: number | boolean }
    | { action: "storage"; context: string; operation: "read" }
    | { action: "storage"; context: string; operation: "set" | "remove"; key: string; expected: string | null; value?: string };

export function parseWorkbenchRequest(value: unknown): WorkbenchRequest {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid workbench request");
    const request = value as Record<string, unknown>;
    const keys: Record<string, string[]> = { "runtime-info": ["action", "context"], "runtime-assets": ["action", "context", "query", "offset"],
        "runtime-setting": ["action", "context", "name", "value"], storage: request.operation === "read" ? ["action", "context", "operation"]
            : request.operation === "set" ? ["action", "context", "operation", "key", "expected", "value"] : ["action", "context", "operation", "key", "expected"] };
    const allowed = Object.prototype.hasOwnProperty.call(keys, String(request.action)) ? keys[String(request.action)] : undefined;
    if (!allowed || Object.keys(request).length !== allowed.length || Object.keys(request).some(key => !allowed.includes(key))) throw new Error("Invalid workbench arguments");
    if (typeof request.context !== "string" || !request.context.length || request.context.length > 4096) throw new Error("Invalid scene context");
    if (request.action === "runtime-assets" && (typeof request.query !== "string" || request.query.length > 256
        || !Number.isInteger(request.offset) || Number(request.offset) < 0 || Number(request.offset) > 20000)) throw new Error("Invalid asset query");
    if (request.action === "runtime-setting" && !(request.name === "frameRate" && Number.isInteger(request.value) && Number(request.value) >= 1 && Number(request.value) <= 240)
        && !(request.name === "retina" && typeof request.value === "boolean")) throw new Error("Invalid runtime setting");
    if (request.action === "storage") {
        if (!["read", "set", "remove"].includes(String(request.operation))) throw new Error("Invalid storage operation");
        if (request.operation !== "read" && (typeof request.key !== "string" || !request.key.length || request.key.length > 1024
            || !(request.expected === null || typeof request.expected === "string" && request.expected.length <= 16384)
            || request.operation === "set" && (typeof request.value !== "string" || request.value.length > 16384))) throw new Error("Invalid storage entry");
    }
    return request as WorkbenchRequest;
}

async function runtimeWorkbench(request: WorkbenchRequest): Promise<unknown> {
    const runtime = globalThis as any;
    let cc = runtime.cc;
    if (runtime.System?.import) cc = await runtime.System.import("cc");
    else if (runtime.System?.resolve && runtime.System?.get) cc = runtime.System.get(await runtime.System.resolve("cc"));
    const scene = cc?.director?.getScene();
    const identity = runtime.__cocosLiveInspectorContext;
    if (!scene || identity?.scene !== scene || identity.token !== request.context) throw new Error("页面或场景已变化，请刷新节点树后重试");
    const storage = cc.sys?.localStorage || runtime.localStorage;
    if (request.action === "storage") {
        if (!storage) throw new Error("当前预览不支持本地存储");
        if (request.operation !== "read") {
            if (storage.getItem(request.key) !== request.expected) throw new Error("存储值已变化，请刷新后再修改");
            if (request.operation === "set") storage.setItem(request.key, request.value);
            else storage.removeItem(request.key);
        }
        const entries = [];
        let budget = 60000, truncated = false;
        for (let i = 0; i < storage.length; i++) {
            if (entries.length >= 200 || budget <= 0) { truncated = true; break; }
            const key = storage.key(i), original = storage.getItem(key);
            const value = original == null ? "" : String(original);
            const limit = Math.min(16384, budget), shortened = value.length > limit || key.length > 1024;
            entries.push({ key: String(key).slice(0, 1024), value: value.slice(0, limit), editable: !shortened, truncated: shortened });
            budget -= Math.min(value.length, limit) + Math.min(key.length, 1024); truncated ||= shortened;
        }
        return { context: request.context, origin: runtime.location?.origin ?? "unknown", total: storage.length, entries, truncated };
    }
    if (request.action === "runtime-assets") {
        const cache = cc.assetManager?.assets;
        if (!cache?.forEach) throw new Error("当前引擎不支持读取已加载资源");
        const assets: any[] = [];
        let visited = 0, matched = 0;
        cache.forEach((asset: any, key: string) => {
            if (++visited > 20000) return;
            const type = cc.js?.getClassName(asset) || asset.constructor?.name || "Asset";
            const name = String(asset.name || "").slice(0, 256), uuid = String(asset.uuid || asset._uuid || key).slice(0, 256);
            if (![name, uuid, type].some(value => value.toLowerCase().includes(request.query.toLowerCase()))) return;
            if (matched++ < request.offset || assets.length >= 100) return;
            const texture = asset.texture || (typeof asset.getGFXTexture === "function" ? asset : null);
            assets.push({ uuid, name, type, refCount: Number.isFinite(asset.refCount) ? asset.refCount : null,
                width: Number.isFinite(texture?.width) ? texture.width : null, height: Number.isFinite(texture?.height) ? texture.height : null,
                nativeUrl: typeof asset.nativeUrl === "string" ? asset.nativeUrl.slice(0, 1024) : null });
        });
        return { context: request.context, assets, total: Math.min(visited, 20000), matched, offset: request.offset,
            hasMore: matched > request.offset + assets.length, truncated: visited > 20000 };
    }
    if (request.action === "runtime-setting") {
        if (request.name === "frameRate") {
            if (!cc.game || !("frameRate" in cc.game)) throw new Error("当前引擎不支持修改目标帧率");
            cc.game.frameRate = request.value;
        } else {
            if (typeof cc.view?.enableRetina !== "function") throw new Error("当前引擎不支持 Retina 设置");
            cc.view.enableRetina(request.value);
        }
        if (cc.director.getScene() !== scene) throw new Error("设置触发场景切换，请刷新节点树；修改可能已生效");
    }
    let env: any = {};
    try { if (runtime.System?.import) env = await runtime.System.import("cc/env"); } catch { /* Older runtimes have no cc/env module. */ }
    // Revalidate after the optional import so a read never combines two scenes.
    if (cc.director.getScene() !== scene) throw new Error("场景已变化，请刷新节点树后重试");
    const flags = Object.fromEntries(Object.keys(env).filter(key => /^[A-Z][A-Z_\d]+$/.test(key) && typeof env[key] === "boolean").map(key => [key, env[key]]));
    const device = cc.director.root?.device;
    const renderers: any[] = [], stack = [scene];
    let nodeCount = 0, componentCount = 0, activeCount = 0, rendererCount = 0;
    const categories: Record<string, number> = {};
    while (stack.length && nodeCount < 20000) {
        const node = stack.pop(); if (!cc.isValid(node, true)) continue;
        nodeCount++; componentCount += node.components.length; if (node.activeInHierarchy) activeCount++;
        for (const component of node.components) {
            const type = cc.js?.getClassName(component) || component.constructor?.name || "Component";
            if (!node.activeInHierarchy || component.enabled === false || !/Sprite|Label|Mask|Graphics|MeshRenderer|Particle|Skeleton|DragonBones/.test(type)) continue;
            categories[type] = (categories[type] || 0) + 1; rendererCount++;
            if (renderers.length >= 300) continue;
            const material = component.sharedMaterial || component.sharedMaterials?.[0];
            const frame = component.spriteFrame;
            renderers.push({ uuid: node.uuid, name: String(node.name).slice(0, 256), type, layer: node.layer,
                texture: frame?.texture?.uuid || null, material: material?.uuid || null,
                hint: /Mask/.test(type) ? "Mask 裁剪" : /Graphics/.test(type) ? "独立几何" : /Label/.test(type) ? "文字缓存 / 字体" : "纹理 / 材质 / 层" });
        }
        for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
    }
    const metric = (key: string) => Number.isFinite(device?.[key]) ? device[key] : null;
    const rect = cc.game?.canvas?.getBoundingClientRect?.();
    const size = cc.view?.getDesignResolutionSize?.();
    return { context: request.context, scene: scene.name, version: cc.ENGINE_VERSION || cc.VERSION || "unknown", paused: cc.director.isPaused(),
        frameRate: cc.game?.frameRate ?? null, retina: cc.view?.isRetinaEnabled?.() ?? null,
        capabilities: { frameRate: Boolean(cc.game && "frameRate" in cc.game), retina: typeof cc.view?.enableRetina === "function", assets: Boolean(cc.assetManager?.assets?.forEach), storage: Boolean(storage) },
        flags, system: { os: cc.sys?.os ?? null, platform: cc.sys?.platform ?? null, browser: cc.sys?.browserType ?? null,
            language: cc.sys?.language ?? null, mobile: cc.sys?.isMobile ?? null, pixelRatio: runtime.devicePixelRatio ?? null },
        canvas: { width: cc.game?.canvas?.width ?? null, height: cc.game?.canvas?.height ?? null, displayWidth: rect?.width ?? null,
            displayHeight: rect?.height ?? null, designWidth: size?.width ?? null, designHeight: size?.height ?? null },
        stats: { nodes: nodeCount, activeNodes: activeCount, components: componentCount, renderers: rendererCount,
            drawCalls: metric("numDrawCalls"), triangles: metric("numTris"), instances: metric("numInstances") },
        categories, renderers, renderersTruncated: rendererCount > renderers.length, truncated: stack.length > 0 };
}

export function buildWorkbenchExpression(request: WorkbenchRequest): string {
    return `(${runtimeWorkbench.toString()})(${JSON.stringify(parseWorkbenchRequest(request))})`;
}
