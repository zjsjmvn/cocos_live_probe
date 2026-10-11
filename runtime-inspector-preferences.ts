export interface InspectorPreferences {
    autoSync?: boolean; syncDetails?: boolean; showIcons?: boolean; showCounts?: boolean; alignLeft?: boolean;
    sortFields?: boolean; fairyNames?: boolean; arrayLimit?: number;
    resolutions?: { name: string; width: number; height: number }[];
}
export function parseInspectorPreferences(value: unknown): InspectorPreferences {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid inspector preferences");
    const preferences = value as Record<string, unknown>;
    for (const [key, entry] of Object.entries(preferences)) {
        if (["autoSync", "syncDetails", "showIcons", "showCounts", "alignLeft", "sortFields", "fairyNames"].includes(key)) {
            if (typeof entry !== "boolean") throw new Error("Invalid inspector preference " + key);
        } else if (key === "arrayLimit") {
            if (!Number.isInteger(entry) || Number(entry) < 0 || Number(entry) > 40) throw new Error("Invalid array expansion limit");
        } else if (key === "resolutions") {
            if (!Array.isArray(entry) || entry.length > 20 || entry.some(item => !item || typeof item !== "object"
                || Object.keys(item).length !== 3 || typeof item.name !== "string" || !item.name.length || item.name.length > 40
                || [item.width, item.height].some(size => !Number.isInteger(size) || size < 160 || size > 4096))) throw new Error("Invalid saved resolutions");
        } else throw new Error("Unknown inspector preference " + key);
    }
    return preferences as InspectorPreferences;
}
