// This factory is serialized into the owned preview; keep all helpers inside it.
export function inspectorValueTools(cc: any, nodes: any[]) {
    const primitive = (value: any) => typeof value === "boolean" || typeof value === "string"
        || (typeof value === "number" && Number.isFinite(value));
    const writable = (object: any, field: string): boolean => {
        for (let current = object; current; current = Object.getPrototypeOf(current)) {
            const info = Object.getOwnPropertyDescriptor(current, field);
            if (info) return Boolean(info.set || info.writable);
        }
        return false;
    };
    const shape = (value: any): { kind: string; axes: string[]; type: string } | null => {
        for (const [kind, axes] of Object.entries({ Color: ["r", "g", "b", "a"], Vec2: ["x", "y"], Vec3: ["x", "y", "z"],
            Vec4: ["x", "y", "z", "w"], Quat: ["x", "y", "z", "w"], Size: ["width", "height"], Rect: ["x", "y", "width", "height"] })) {
            if (typeof cc[kind] === "function" && value instanceof cc[kind]) return { kind, axes, type: kind === "Color" ? "color" : "vector" };
        }
        return null;
    };
    const names = (component: any): string[] => Array.from(new Set<string>(["enabled", ...(component.constructor.__props__ || [])]))
        .filter(name => /^[a-zA-Z][\w]*$/.test(name) && !["node", "uuid", "name", "constructor", "prototype"].includes(name)).slice(0, 100);
    const enums = (component: any, field: string): any[] | undefined => {
        const attrs = cc.Class?.Attr?.getClassAttrs?.(component.constructor) || cc.CCClass?.Attr?.getClassAttrs?.(component.constructor)
            || component.constructor.__attrs__;
        const list = attrs?.[field + "$_$enumList"];
        return Array.isArray(list) && list.length <= 200 ? list.filter(item => typeof item.name === "string" && Number.isFinite(item.value))
            .map(item => ({ name: item.name, value: item.value })) : undefined;
    };
    const fields = (component: any): any[] => {
        let remaining = 600;
        const seen = new Set<any>();
        const describe = (name: string, value: any, editable: boolean, path: string[], depth: number): any => {
            const base = { name, path, editable: false };
            if (--remaining < 0) return { ...base, type: "reference", value: "[字段容量已达上限]", truncated: true };
            if (primitive(value)) {
                const options = path.length === 0 ? enums(component, name) : undefined;
                return { ...base, value: typeof value === "string" ? value.slice(0, 8192) : value,
                    editable: editable && !(typeof value === "string" && value.length > 8192),
                    type: options?.length ? "enum" : typeof value, options, truncated: typeof value === "string" && value.length > 8192 };
            }
            if (value == null) return { ...base, type: "reference", value: null };
            const structured = shape(value);
            if (structured) return { ...base, ...structured, value: Object.fromEntries(structured.axes.map(axis => [axis, value[axis]])),
                editable: editable && structured.axes.every(axis => Number.isFinite(value[axis])) };
            if (value.uuid || value._uuid) {
                const node = nodes.find(item => item === value || item.components.includes(value));
                const kind = node ? node === value ? "node" : "component" : cc.Asset && value instanceof cc.Asset ? "asset" : "object";
                return { ...base, type: "reference", value: `${value.name || cc.js?.getClassName(value) || value.constructor?.name || "Object"} (${value.uuid || value._uuid})`,
                    reference: { kind, uuid: value.uuid || value._uuid, nodeUuid: node?.uuid } };
            }
            if (typeof value !== "object") return { ...base, type: "reference", value: `[${typeof value}]` };
            if (seen.has(value)) return { ...base, type: "reference", value: "[循环引用]" };
            if (depth >= 3 || remaining <= 0) return { ...base, type: "reference", value: `[${Array.isArray(value) ? "Array(" + value.length + ")" : value.constructor?.name || "Object"}]`, truncated: true };
            seen.add(value);
            const keys = Object.keys(value).filter(key => /^(?:[a-zA-Z][\w]*|\d+)$/.test(key)
                && !["constructor", "prototype", "__proto__"].includes(key));
            const children = keys.slice(0, Math.min(40, Math.max(0, remaining))).map(key => {
                try { return describe(key, value[key], Array.isArray(value) && editable && writable(value, key), [...path, key], depth + 1); }
                catch { return { name: key, path: [...path, key], value: "[读取失败]", editable: false, type: "reference" }; }
            });
            seen.delete(value);
            return { ...base, type: Array.isArray(value) ? "array" : "object", value: Array.isArray(value) ? `[Array(${value.length})]` : `[${value.constructor?.name || "Object"}]`,
                children, truncated: children.length < keys.length };
        };
        return names(component).map(name => {
            try { return describe(name, component[name], writable(component, name), [], 0); }
            catch { return { name, value: "[读取失败]", editable: false, type: "reference", path: [] }; }
        });
    };
    const edit = (component: any, field: string, path: string[], value: any) => {
        let property = fields(component).find(item => item.name === field);
        let owner = component, key = field;
        for (const segment of path) {
            property = property?.children?.find((item: any) => item.name === segment);
            owner = owner[key]; key = segment;
        }
        if (!property?.editable || !writable(owner, key)) throw new Error("组件字段只接受同类型的可写公开属性");
        const current = owner[key];
        if (property.type === "color" || property.type === "vector") {
            const axes: string[] = property.axes;
            if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== axes.length
                || axes.some(axis => !Number.isFinite(value[axis]))) throw new Error("向量必须包含有限数值");
            if (property.type === "color" && axes.some(axis => !Number.isInteger(value[axis]) || value[axis] < 0 || value[axis] > 255)) throw new Error("颜色通道须为 0–255 的整数");
            const replacement = current.clone ? current.clone() : new cc[property.kind]();
            for (const axis of axes) replacement[axis] = value[axis];
            owner[key] = replacement;
        } else {
            if (typeof value !== typeof current || !primitive(value) || (typeof value === "string" && value.length > 8192)) throw new Error("组件字段只接受同类型的可写公开属性");
            if (property.options?.length && !property.options.some((item: any) => item.value === value)) throw new Error("枚举值不在公开选项中");
            owner[key] = value;
        }
    };
    return { fields, edit };
}
