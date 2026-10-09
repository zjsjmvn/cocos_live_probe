import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { packager } from "@electron/packager";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = path.join(root, ".tmp"); fs.mkdirSync(temporary, { recursive: true });
const stage = fs.mkdtempSync(path.join(temporary, "inspector-package-"));
fs.cpSync(path.join(root, "dist-desktop"), stage, { recursive: true, filter: source => !source.endsWith(".log") });
const project = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
fs.writeFileSync(path.join(stage, "package.json"), JSON.stringify({ name: "cocos-live-probe-inspector", productName: "Cocos Live Probe Inspector", version: project.version,
    private: true, main: "runtime-inspector-desktop.js", dependencies: project.dependencies }, null, 2));
const copied = new Set();
function copyDependency(name) {
    if (copied.has(name)) return; copied.add(name);
    const source = path.join(root, "node_modules", name);
    const info = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8"));
    fs.cpSync(source, path.join(stage, "node_modules", name), { recursive: true });
    for (const dependency of Object.keys(info.dependencies || {})) copyDependency(dependency);
}
for (const dependency of Object.keys(project.dependencies || {})) copyDependency(dependency);
const output = path.resolve(root, "releases");
if (!output.startsWith(root + path.sep)) throw new Error("Package output must remain inside this workspace");
const electronVersion = JSON.parse(fs.readFileSync(path.join(root, "node_modules/electron/package.json"), "utf8")).version;
// Reuse the downloaded runtime even when it came from a mirror. Verify against
// Electron's pinned checksums before handing a local archive to the packager.
const archive = `electron-v${electronVersion}-win32-x64.zip`;
const expectedHash = JSON.parse(fs.readFileSync(path.join(root, "node_modules/electron/checksums.json"), "utf8"))[archive];
const cacheRoot = process.env.electron_config_cache || (process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "electron/Cache"));
let electronZipDir;
if (cacheRoot && fs.existsSync(cacheRoot)) {
    for (const directory of fs.readdirSync(cacheRoot, { withFileTypes: true }).filter(entry => entry.isDirectory())) {
        const candidate = path.join(cacheRoot, directory.name, archive);
        if (!fs.existsSync(candidate)) continue;
        const hash = createHash("sha256"); for await (const chunk of fs.createReadStream(candidate)) hash.update(chunk);
        if (hash.digest("hex") === expectedHash) { electronZipDir = path.dirname(candidate); break; }
    }
}
const result = await packager({ dir: stage, out: output, name: "Cocos Live Probe Inspector", platform: "win32", arch: "x64", electronVersion,
    electronZipDir, asar: true, overwrite: true, prune: false, executableName: "Cocos Live Probe Inspector", win32metadata: {
        CompanyName: "Cocos Live Probe", FileDescription: "Cocos runtime node inspector", ProductName: "Cocos Live Probe Inspector",
    } });
console.log(result.join("\n"));
