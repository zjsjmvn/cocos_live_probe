# Cocos Live Probe（Cocos 实时探针）

Cocos Live Probe 用于直接读取运行中的 Cocos Creator 浏览器预览。它让 AI 或开发者通过结构化命令获得场景节点、Transform、组件、蒙皮模型、动画状态、骨骼和渲染范围，不再需要在浏览器控制台执行脚本后手工复制数据。

## 工作方式

```text
Codex 对话 A -> stdio MCP A -> BrowserContext A -> 受管页面 A
Codex 对话 B -> stdio MCP B -> BrowserContext B -> 受管页面 B
CLI manual-cli / HTTP MCP 单实例 ---------> 各自的受管页面
                                      |
                                      +-> 共享 Chrome/CDP（127.0.0.1:9222）
                                      +-> 共享 Creator 资源服务（127.0.0.1:7456）
```

工具会启动或复用一个独立 Chrome profile。每个 stdio MCP 对话创建自己的 BrowserContext 和 page target，并用 target ID、BrowserContext ID 和完整 URL 校验所有后续操作，不会按 origin 接管其他页面。受管 URL 带有 `autoReload=false`，因此 Creator 的 `browser:reload`、`browser:close` 和 `browser:disconnect` 广播不会刷新或关闭这些页面。

刷新是显式的会话级操作。只有修改代码且确实需要载入新内容的对话才调用 `runtime_refresh`；它只刷新调用者自己的 target，并与该对话正在执行的采样或读取串行。其他正在执行任务的对话保持原页面和运行状态。

各页面仍从同一个 `127.0.0.1:7456` 读取资源。BrowserContext 隔离运行时内存、Storage 和页面生命周期，但不提供资源版本快照；刷新后的页面会读取当前资源，未刷新的页面若随后懒加载资源，也可能读取到资源服务上的新版本。

在接入了 Cocos Creator 编辑器 MCP 的宿主项目中，两个 MCP 的职责不同：

- `cocos_creator`：编辑器场景、资源数据库、编辑器控制台和资源刷新。
- `cocos_live_probe`：运行中浏览器预览的节点、动画、骨骼、蒙皮和 bounds。

## 前置条件

- Cocos Creator 已打开宿主项目，并已启动目标场景的浏览器预览。
- 预览地址可通过 `http://127.0.0.1:7456/` 访问。
- 已安装 Node.js，并在本工具目录执行过 `npm install`。
- Windows 上已安装 Google Chrome；工具会从常见的用户或 Program Files 路径查找 `chrome.exe`。
- 本地端口 `9222` 用于 CDP；启用 HTTP MCP 时还需要端口 `3001`。

## 快速开始

在宿主项目根目录添加并安装工具：

```powershell
git submodule add https://github.com/zjsjmvn/cocos_live_probe.git tools/cocos_live_probe
cd tools/cocos_live_probe
npm install
```

后续命令都从 `tools/cocos_live_probe` 目录运行：

```powershell
# 1. 只检查状态，不启动 Chrome
npm run runtime:probe -- status

# 2. 启动或连接专用 Chrome
npm run runtime:probe -- launch

# 3. 修改代码后，只刷新 manual-cli 自己的页面
npm run runtime:probe -- refresh

# 4. 查看有界场景树
npm run runtime:probe -- scene-tree

# 5. 查找玩家实例
npm run runtime:probe -- find "player-taiyi"

# 6. 选择 name=player-taiyi 且 activeInHierarchy=true 的 UUID 后读取动画
npm run runtime:probe -- animations "<active-player-node-uuid>"

# 7. 连续采样玩家动画
npm run runtime:probe -- sample-animation "<active-player-node-uuid>" --duration 0.5 --interval 0.1
```

`scene-tree`、`find`、`node`、`animations` 和 `sample-animation` 会在需要时自动执行 `launch`。显式运行 `launch` 的价值是提前确认 Chrome、CDP 和当前实例拥有的 target 都正常。CLI 使用固定的 `manual-cli` 单实例；不同 CLI 进程会复用这个实例，不会创建每命令一个隔离页面。

`status` 中的 `instance.target`、`ready` 和 `scene` 是本服务缓存的最近状态，不是一次隐式 target 恢复或页面接管。精确 target ID、BrowserContext ID 和 URL 会在结构化读取、`launch` 与 `refresh` 时重新校验；仅调用 `status` 不代表 target 此刻仍然存活。

## CLI 命令

所有 CLI 调用都使用 `npm run runtime:probe -- <command>`。

| 命令 | 参数 | 用途 |
| --- | --- | --- |
| `status` | 无 | 检查预览/CDP 可用性并报告本服务缓存的最近实例状态；不会启动 Chrome 或实时校验 target。 |
| `launch` | 无 | 启动或复用 localhost 专用 Chrome，并返回 target 摘要。 |
| `refresh` | 无 | 只刷新 `manual-cli` target，等待新页面进入活动场景。 |
| `scene-tree` | `--max-depth 0..12`、`--include-inactive` | 读取场景树；默认深度为 `4`，默认忽略 inactive 节点。 |
| `find` | 一个 selector | 按名称片段、UUID 或路径查找节点，可返回多个结果。 |
| `node` | 一个 selector | 读取唯一节点的 Transform、组件、renderer model 和 world bounds。 |
| `animations` | 一个 selector | 读取唯一节点下的骨骼动画、状态、evaluator、`Bip001` 和蒙皮 bounds。 |
| `sample-animation` | selector、`--duration`、`--interval` | 连续读取动画快照；默认 `1s / 0.1s`。 |
| `eval` | JavaScript 表达式 | 在预览 target 中执行高级诊断表达式。 |
| `eval-file` | JavaScript 文件路径 | 读取文件并在预览 target 中执行。 |

采样时长必须大于 `0` 且不超过 `30s`；间隔不得小于 `0.01s`，不得大于总时长，单次最多 `301` 个样本。

示例：

```powershell
npm run runtime:probe -- scene-tree --max-depth 6 --include-inactive
npm run runtime:probe -- node "/battle/Actors/<unique-node-name>"
npm run runtime:probe -- sample-animation "<uuid>" --duration 0.5 --interval 0.1
npm run runtime:probe -- eval '(async () => { const id = await globalThis.System.resolve("cc"); const cc = globalThis.System.get(id); return { scene: cc?.director.getScene()?.name }; })()'
```

`eval-file` 路径相对于当前工作目录解析。使用它时传入已经检查且实际存在的 JavaScript 诊断文件。

## 选择器规则

`find` 是宽松查询：

- 以 `/` 开头时只匹配完整场景路径。
- UUID 使用精确匹配。
- 其他文本不区分大小写地匹配节点名称或完整路径片段。

`node` 和 `animations` 是严格查询，只接受精确 UUID、精确节点名或精确完整路径，并要求结果唯一。对象池中通常存在多个 `enemy-0`，推荐先运行：

```powershell
npm run runtime:probe -- find "enemy-0"
```

然后从结果中选择目标节点的 UUID。直接把不唯一的 `enemy-0` 传给 `node`、`animations` 或 `sample-animation` 会返回 ambiguous selector 错误，这是为了防止读取错误对象。

采样死亡动画时，先开始战斗并等待目标敌人出现，再运行 `find "enemy-0"`，选择 `activeInHierarchy=true` 的目标 UUID：

```powershell
npm run runtime:probe -- sample-animation "<active-enemy-node-uuid>" --duration 1.2 --interval 0.05
```

## stdio MCP

项目配置位于 `.codex/config.toml`：

```toml
[mcp_servers.cocos_live_probe]
command = "npm"
args = ["run", "--silent", "runtime:probe:mcp"]
cwd = "<absolute-project-path>\\tools\\cocos_live_probe"
startup_timeout_sec = 20
tool_timeout_sec = 45
```

工具按自身目录向上两级解析宿主项目根目录，并以该绝对路径生成稳定的
workspace identity。不同宿主项目因此使用不同的 Chrome profile 和锁文件；
无需在宿主项目中增加额外配置。

Codex 通常在会话启动时加载项目 MCP 配置。修改 `.codex/config.toml` 后，当前会话不保证热加载 `cocos_live_probe`；重新打开项目会话后再检查工具列表。当前会话未加载时，可先用 CLI 完成同样的结构化读取。

每个 stdio MCP 进程对应一个对话实例。首次 `runtime_launch` 或结构化读取会创建该对话独占的 BrowserContext 和 target；stdio 结束时只释放本实例，不关闭共享 Chrome，也不影响其他对话。Creator 的全局刷新广播不会更新这些受管页面；需要新代码的对话应在自己的任务空闲点显式调用 `runtime_refresh`。

stdio MCP 暴露以下工具：

| MCP 工具 | 对应 CLI |
| --- | --- |
| `runtime_status` | `status` |
| `runtime_launch` | `launch` |
| `runtime_refresh` | `refresh` |
| `runtime_scene_tree` | `scene-tree` |
| `runtime_find_nodes` | `find` |
| `runtime_node_snapshot` | `node` |
| `runtime_animation_snapshot` | `animations` |
| `runtime_sample_animation` | `sample-animation` |

出于安全边界考虑，MCP 不暴露通用 `eval` 或 `eval-file`。

人工检查 stdio 握手：

```powershell
$initialize = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
$initialize | npm run --silent runtime:probe:mcp
```

返回的 `serverInfo.name` 应为 `cocos-live-probe`。

## HTTP MCP

HTTP MCP 只监听 `127.0.0.1:3001`：

```powershell
npm run runtime:probe:mcp:http
```

健康检查：

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:3001/health"
```

JSON-RPC 初始化和工具列表：

```powershell
$headers = @{ "Content-Type" = "application/json" }
$initialize = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:3001/mcp" -Headers $headers -Body $initialize

$tools = '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:3001/mcp" -Headers $headers -Body $tools
```

调用场景树工具：

```powershell
$body = '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"runtime_scene_tree","arguments":{"maxDepth":4,"includeInactive":false}}}'
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:3001/mcp" -Headers $headers -Body $body
```

`GET /health` 和 `POST /mcp` 是当前实现的完整 HTTP 表面；它使用逐请求 JSON-RPC，不要求 MCP session id。

HTTP MCP 服务只有一个长期 `RuntimeProbeService`。所有 HTTP 客户端共享同一实例、命令队列和受管 target；它不是按客户端隔离的多会话入口。需要对话级隔离时使用 stdio MCP。

## 使用建议

1. 日常 AI 诊断优先使用 `cocos_live_probe` MCP；人工复核或当前会话没有加载 MCP 时使用 CLI。
2. 先调用 `runtime_status`。只有需要预览数据时才启动 Chrome 或执行结构化查询。
3. 优先使用 `scene-tree`、`find`、`node`、`animations` 和 `sample-animation`，结构化能力不足时才使用 CLI `eval/eval-file`。
4. 同名节点先 `find`，再用 UUID 查询和采样。
5. 普通状态采样使用 `0.5s / 0.1s`；死亡动画使用 `1.2s / 0.05s`。长采样前先缩小节点范围。
6. 修改脚本并确认 Creator 已完成资源编译后，只由需要新内容的对话调用自己的 `runtime_refresh`。正在采样或执行任务的其他对话不要刷新；不要用 Creator 全局广播代替定向刷新。
7. 编辑器问题交给 `cocos_creator`，运行时画面、动画和节点问题交给 `cocos_live_probe`，需要时用 UUID 对齐两侧对象。

## 安全边界

- 预览 URL、CDP、HTTP MCP 都固定在 `127.0.0.1`，不要改成局域网或公网监听。
- Chrome 使用按宿主项目绝对路径生成的 `%TEMP%\cocos-live-probe-<workspace-id>-chrome` 独立 profile，不复用日常浏览器 profile，也不与其他项目共享探针状态。
- stdio 对话只操作自己创建并严格校验的 BrowserContext/target；同源存在多个受管页面是正常状态，不要手工关闭其他对话的页面。
- CLI 固定使用 `manual-cli` 共享实例；HTTP MCP 的所有客户端共享该 HTTP 服务实例。不要把这两个入口当作对话级隔离通道。
- `127.0.0.1:7456` 是所有实例共享的当前资源源，不是版本快照。未刷新的页面保持当前内存状态，但后续懒加载仍可能看到新资源。
- `eval` 和 `eval-file` 能执行任意 JavaScript，也能修改运行时状态。只运行经过检查的诊断表达式和文件，并确认目标仍是专用预览页。
- 探针读取或临时修改的是运行中内存，不能代替源码、prefab、scene 或资源文件中的正式修复。

## 常见问题

### `Cocos preview is unavailable`

确认 Creator 已启动浏览器预览，且 `http://127.0.0.1:7456/` 能访问。仅在编辑器中打开场景还不够。

### `Chrome executable was not found`

确认 Google Chrome 安装在当前用户或 Program Files 的标准路径。当前版本没有 CLI 自定义 Chrome 路径参数。

### `Owned runtime probe target was lost`

当前实例拥有的 target 已关闭或 BrowserContext 已释放。不要接管同源的其他页面；调用本实例的 `runtime_launch` 创建新的 owned target。若仍失败，检查 `9222` 的专用 Chrome 是否正常。

### `Owned runtime probe context mismatch` 或 URL mismatch

当前服务记录的 target 身份与 Chrome 返回的 BrowserContext 或完整 URL 不一致。探针对此保持 fail-closed，不会通过再次调用 `runtime_launch` 自动接管或覆盖该页面。停止并重启当前探针服务，让该服务建立新的受管实例；不要关闭、刷新或接管其他对话的 target。

### `Cocos node selector is ambiguous`

节点名不唯一。先执行 `find`，再将唯一 UUID 传给 `node`、`animations` 或 `sample-animation`。

### 场景树为空或 `game.inited` 尚未完成

等待预览初始化；仍为空或出现 `Cocos preview ready timed out` 时，回到 Creator 检查资源编译和预览控制台。修复后调用当前实例的 `runtime_launch` 或 `runtime_refresh`，不要刷新其他对话。若专用 Chrome 在重复引擎初始化后已异常，只关闭确认属于 `%TEMP%\cocos-live-probe-<workspace-id>-chrome` 且占用 `9222` 的进程，再重新 `launch`。

### `Dedicated Chrome did not expose` 或 CDP 不可用

确认端口 `9222` 没有被其他 Chrome 调试实例占用。若共享 Chrome 意外退出，各 stdio 实例原有 BrowserContext 都已失效；只结束确认属于探针专用 profile 的残留进程，然后由各自对话按需重新 `runtime_launch`。不要结束日常 Chrome 进程。

### HTTP MCP 无法启动

检查 `3001` 是否已被另一实例占用。若已有 Cocos Live Probe HTTP 服务，直接访问 `/health`；否则只结束确认属于本工具的旧进程后再启动。

### 修改配置后 Codex 看不到 `cocos_live_probe`

项目 MCP 配置通常不会在已打开会话中自动刷新。重新打开项目会话；等待期间使用 `npm run runtime:probe -- ...`，无需复制浏览器控制台数据。
