const fs = require("node:fs");
const path = require("node:path");
const toolRoot = path.resolve(__dirname, "..");
const projectRoot = path.resolve(toolRoot, "../..");
const project = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
if (!project.creator?.version?.startsWith("3.")) throw new Error("安装目标必须是 Cocos Creator 3.x 项目。");
const target = path.join(projectRoot, "extensions/cocos-live-probe");
if (fs.existsSync(path.join(target, "package.json"))) {
    const installed = JSON.parse(fs.readFileSync(path.join(target, "package.json"), "utf8"));
    if (installed.name !== "cocos-live-probe") throw new Error(`目标目录被其他扩展占用：${target}`);
}
fs.cpSync(path.join(toolRoot, "creator-extension"), target, { recursive: true });

// Transfer only the known conflicting binding, preserving the old inspector's
// menus, runtime and any custom shortcuts. Keep an exact backup before writing.
const previousManifest = path.join(projectRoot, "extensions/CocosInspector/package.json");
if (fs.existsSync(previousManifest)) {
    const raw = fs.readFileSync(previousManifest, "utf8");
    const manifest = JSON.parse(raw);
    let changed = false;
    for (const shortcut of manifest.contributions?.shortcuts || []) {
        if (shortcut.message !== "previewMode") continue;
        for (const [platform, replacement] of [["win", "ctrl+shift+enter"], ["mac", "cmd+shift+enter"]]) {
            if (shortcut[platform]?.toLowerCase() === "shift+enter") {
                shortcut[platform] = replacement;
                changed = true;
            }
        }
    }
    if (changed) {
        const backupRoot = path.join(toolRoot, ".tmp/creator-extension-backup");
        fs.mkdirSync(backupRoot, { recursive: true });
        const backup = path.join(backupRoot, "CocosInspector.package.json");
        if (!fs.existsSync(backup)) fs.writeFileSync(backup, raw);
        fs.writeFileSync(previousManifest, JSON.stringify(manifest, null, 2) + "\n");
        console.log("CocosInspector: Shift+Enter → Ctrl+Shift+Enter（macOS: Cmd+Shift+Enter）");
        console.log(`原配置备份：${backup}`);
    }
}
console.log(`已安装：${target}`);
console.log("重新加载两个扩展，或重启 Creator，然后按 Shift+Enter。菜单：扩展 → Cocos Live Probe → 启动检查器。");
