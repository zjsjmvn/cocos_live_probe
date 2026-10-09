export type InspectorRequest =
    | { action: "tree" }
    | { action: "inspect"; uuid: string; context: string }
    | { action: "edit"; uuid: string; context: string; field: string; value: unknown; componentUuid?: string }
    | { action: "move"; uuid: string; context: string; parentUuid: string; siblingIndex: number; keepWorldTransform: boolean }
    | { action: "pause"; context: string }
    | { action: "resume"; context: string };

export function parseInspectorRequest(value: unknown): InspectorRequest {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an inspector request object");
    const request = value as Record<string, unknown>;
    const allowed: Record<string, string[]> = {
        tree: ["action"], inspect: ["action", "uuid", "context"],
        edit: ["action", "uuid", "context", "field", "value", "componentUuid"],
        move: ["action", "uuid", "context", "parentUuid", "siblingIndex", "keepWorldTransform"],
        pause: ["action", "context"], resume: ["action", "context"],
    };
    const keys = Object.prototype.hasOwnProperty.call(allowed, String(request.action)) ? allowed[String(request.action)] : undefined;
    if (!keys || Object.keys(request).some(key => !keys.includes(key))) throw new Error("Unknown inspector action or argument");
    for (const key of keys.filter(key => !["action", "value", "componentUuid", "siblingIndex", "keepWorldTransform"].includes(key))) {
        if (typeof request[key] !== "string" || !(request[key] as string).length || (request[key] as string).length > 4096) {
            throw new Error(`Invalid ${key}`);
        }
    }
    if (request.action === "edit") {
        if (!("value" in request)) throw new Error("Missing edit value");
        if (request.componentUuid !== undefined && (typeof request.componentUuid !== "string" || !request.componentUuid.length)) throw new Error("Invalid componentUuid");
    }
    if (request.action === "move" && (!Number.isInteger(request.siblingIndex) || Number(request.siblingIndex) < 0
        || typeof request.keepWorldTransform !== "boolean")) throw new Error("Invalid hierarchy arguments");
    return request as InspectorRequest;
}

// Kept as a function so browser evaluation and engine fixtures execute the same implementation.
async function inspectRuntime(request: InspectorRequest): Promise<unknown> {
    const runtime = globalThis as any;
    let cc = runtime.cc;
    if (runtime.System?.import) cc = await runtime.System.import("cc");
    else if (runtime.System?.resolve && runtime.System?.get) cc = runtime.System.get(await runtime.System.resolve("cc"));
    if (!cc?.director) throw new Error("Cocos runtime is unavailable");
    const scene = cc.director.getScene();
    if (!scene) throw new Error("Cocos preview has no active scene");
    const key = "__cocosLiveInspectorContext";
    if (runtime[key]?.scene !== scene) runtime[key] = { scene, token: runtime.crypto.randomUUID() };
    const context = runtime[key].token;
    if (request.action !== "tree" && request.context !== context) throw new Error("页面或场景已变化，请刷新节点树后重试");
    const nodes: any[] = [];
    const stack = [scene];
    // Iterative traversal supports deep trees without overflowing the JS call stack.
    while (stack.length) {
        const node = stack.pop();
        if (!cc.isValid(node, true)) continue;
        nodes.push(node);
        if (nodes.length >= 20000) {
            if (stack.length || node.children.length) throw new Error("节点超过 20000，无法完整显示节点树");
            break;
        }
        for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
    }
    const resolve = (uuid: string): any => {
        const node = nodes.find(item => item.uuid === uuid);
        if (!node) throw new Error("节点已移除，请刷新节点树");
        return node;
    };
    const primitive = (value: any) => typeof value === "boolean" || typeof value === "string"
        || (typeof value === "number" && Number.isFinite(value));
    const descriptor = (object: any, field: string): PropertyDescriptor | undefined => {
        for (let current = object; current; current = Object.getPrototypeOf(current)) {
            const found = Object.getOwnPropertyDescriptor(current, field);
            if (found) return found;
        }
        return undefined;
    };
    const writable = (object: any, field: string): boolean => {
        const info = descriptor(object, field);
        return Boolean(info && (info.set || info.writable));
    };
    const componentFields = (component: any): any[] => {
        const names: string[] = Array.from(new Set<string>(["enabled", ...(component.constructor.__props__ || [])]));
        return names.filter(name => /^[a-zA-Z][\w]*$/.test(name) && !["node", "uuid", "name", "constructor", "prototype"].includes(name))
            .slice(0, 100).map(name => {
                try {
                    const value = component[name];
                    const scalar = primitive(value);
                    const summary = scalar || value == null ? value ?? null : Array.isArray(value)
                        ? `[Array(${value.length})]` : value.uuid ? `${value.name || value.constructor?.name || "Object"} (${value.uuid})`
                            : `[${value.constructor?.name || "Object"}]`;
                    return { name, value: summary, editable: scalar && writable(component, name), type: scalar ? typeof value : "reference" };
                } catch { return { name, value: "[读取失败]", editable: false, type: "reference" }; }
            });
    };
    if (request.action === "pause" || request.action === "resume") {
        cc.director[request.action]();
        return { context, paused: cc.director.isPaused() };
    }
    if (request.action === "tree") return {
        context, scene: scene.name, paused: cc.director.isPaused(),
        nodes: nodes.map(node => ({ uuid: node.uuid, name: node.name, parentUuid: node === scene ? null : node.parent?.uuid,
            active: node.active, activeInHierarchy: node.activeInHierarchy, childCount: node.children.length })),
    };
    const node = resolve(request.uuid);
    if (request.action === "move") {
        if (node === scene) throw new Error("不能移动场景根节点");
        const parent = resolve(request.parentUuid);
        for (let ancestor = parent; ancestor; ancestor = ancestor.parent) {
            if (ancestor === node) throw new Error("不能将节点放到自身或其子节点下");
        }
        const maximum = parent.children.length - (node.parent === parent ? 1 : 0);
        if (request.siblingIndex > maximum) throw new Error("同级顺序超出范围，请刷新节点树");
        if (node.parent !== parent) node.setParent(parent, request.keepWorldTransform);
        if (!cc.isValid(node, true) || !cc.isValid(parent, true) || cc.director.getScene() !== scene) {
            throw new Error("层级调整触发了节点移除或场景切换，请刷新节点树；修改可能已经生效");
        }
        node.setSiblingIndex(request.siblingIndex);
    }
    const vector = (value: any, dimensions: string[]) => Object.fromEntries(dimensions.map(axis => [axis, value[axis]]));
    const finiteVector = (value: any, dimensions: string[]) => {
        if (!value || typeof value !== "object" || Object.keys(value).length !== dimensions.length
            || dimensions.some(axis => !Number.isFinite(value[axis]))) throw new Error("向量必须包含有限数值");
        return dimensions.map(axis => value[axis]);
    };
    if (request.action === "edit") {
        const { field, value } = request;
        if (request.componentUuid) {
            const component = node.components.find((item: any) => item.uuid === request.componentUuid && cc.isValid(item, true));
            if (!component) throw new Error("组件已移除，请重新选择节点");
            const property = componentFields(component).find(item => item.name === field && item.editable);
            if (!property || typeof value !== property.type || !primitive(value)) throw new Error("组件字段只接受同类型的可写公开基础属性");
            component[field] = value;
        } else if (field === "name" && typeof value === "string" && value.length <= 1024) node.name = value;
        else if (field === "active" && typeof value === "boolean") node.active = value;
        else if (["position", "eulerAngles", "scale"].includes(field)) {
            const args = finiteVector(value, ["x", "y", "z"]);
            const method = { position: "setPosition", eulerAngles: "setRotationFromEuler", scale: "setScale" }[field as "position"];
            node[method](...args);
        } else if (field === "contentSize" || field === "anchorPoint") {
            const transform = cc.UITransform && node.getComponent(cc.UITransform);
            if (!transform) throw new Error("节点没有 UITransform");
            if (field === "contentSize") {
                const args = finiteVector(value, ["width", "height"]);
                if (args.some(item => item < 0)) throw new Error("尺寸不能为负数");
                transform.setContentSize(...args);
            } else transform.setAnchorPoint(...finiteVector(value, ["x", "y"]));
        } else throw new Error("不支持的节点字段或值");
        if (!cc.isValid(node, true) || cc.director.getScene() !== scene) throw new Error("编辑触发了节点移除或场景切换，请刷新节点树；修改可能已经生效");
    }
    const transform = cc.UITransform && node.getComponent(cc.UITransform);
    const path: string[] = [];
    for (let current = node; current; current = current.parent) path.unshift(current.name);
    return { context, uuid: node.uuid, name: node.name, path: "/" + path.join("/"), active: node.active,
        activeInHierarchy: node.activeInHierarchy, parentUuid: node === scene ? null : node.parent?.uuid,
        siblingIndex: node.getSiblingIndex(), position: vector(node.position, ["x", "y", "z"]),
        eulerAngles: vector(node.eulerAngles, ["x", "y", "z"]), scale: vector(node.scale, ["x", "y", "z"]),
        worldPosition: vector(node.worldPosition, ["x", "y", "z"]),
        uiTransform: transform ? { contentSize: vector(transform.contentSize, ["width", "height"]), anchorPoint: vector(transform.anchorPoint, ["x", "y"]) } : null,
        components: node.components.filter((item: any) => cc.isValid(item, true)).map((component: any) => ({
            uuid: component.uuid, type: cc.js?.getClassName(component) || component.constructor.name, fields: componentFields(component),
        })),
    };
}

export function buildInspectorExpression(request: InspectorRequest): string {
    return `(${inspectRuntime.toString()})(${JSON.stringify(parseInspectorRequest(request))})`;
}
