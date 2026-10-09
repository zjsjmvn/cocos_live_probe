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
- 已安装 Node.js 22 或更新版本，并在本工具目录执行过 `npm ci`。
- Windows 上已安装 Google Chrome 或 Chromium。可设置 `COCOS_RUNTIME_PROBE_BROWSER_EXECUTABLE` 指定可执行文件；未设置时从常见用户/Program Files 路径查找 Chrome。
- 本地端口 `9222` 用于 CDP；启用 HTTP MCP 时还需要端口 `3001`。

## 快速开始

在宿主项目根目录添加并安装工具：

```powershell
git submodule add https://github.com/zjsjmvn/cocos_live_probe.git tools/cocos_live_probe
cd tools/cocos_live_probe
npm ci
```

后续命令都从 `tools/cocos_live_probe` 目录运行：

已有项目重新克隆后，先在项目根目录执行 `git submodule update --init --recursive`，再进入工具目录执行 `npm ci`。子模块固定到宿主项目记录的提交；升级时先在子模块提交并推送，再提交宿主项目的子模块引用。

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

## 项目级游戏扩展

宿主项目可以通过 `COCOS_RUNTIME_PROBE_GAME_EXTENSION` 显式加载本地游戏插件，增加 `game_state`、`game_step`、`game_autoplay`（CLI 为连字符命名）。插件使用只读游戏状态和现有真实浏览器输入，始终复用当前会话页面。配置、契约、预算和 CountRice 示例见 [游戏扩展说明](docs/game-extensions.md)。

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
| `screenshot` | 可选 JSON 对象或 `--file <JSON文件>` | 保存视口 PNG，返回尺寸、缩放和输入观察凭据。 |
| `input` | JSON 对象或 `--file <JSON文件>` | 浏览器鼠标/触摸点击、长按、拖动和键盘输入。 |
| `wait` | JSON 对象或 `--file <JSON文件>` | 有界等待节点存在/消失或节点/组件属性条件。 |
| `diagnostics` | 可选 JSON 对象或 `--file <JSON文件>` | 读取本连接期间的 console、异常和网络失败。 |

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
| `runtime_screenshot` | `screenshot` |
| `runtime_input` | `input` |
| `runtime_wait` | `wait` |
| `runtime_diagnostics` | `diagnostics` |

出于安全边界考虑，MCP 不暴露通用 `eval` 或 `eval-file`。

## Chromium 与浏览器信息

使用已经安装的有窗口 Chromium 时，将 `COCOS_RUNTIME_PROBE_BROWSER_EXECUTABLE` 设置为实际 `chrome.exe` 的绝对路径。明确配置的文件不存在时直接报错。服务选项 `browserExecutable` 优先于环境配置；未配置时保留 Chrome 自动发现。环境变量也可放入 stdio MCP 的启动环境。

版本固定可采用选定且锁定版本的 Playwright 安装命令：`npx playwright@<选定版本> install chromium --no-shell`，然后配置下载所得可执行文件。工具不自动安装或升级浏览器，也不假定 Playwright 缓存中的版本目录。

`launch` 返回实际浏览器的 `Browser.getVersion` 信息、CDP 地址和 target。`browser.configuredExecutable` 只影响本工具新发起的启动；复用一个已经监听 CDP 的浏览器不会改变它的版本。`browser.launchedExecutable` 仅在当前服务确实启动了浏览器时有值。`status` 继续是可用性检查与缓存状态，不隐式启动或恢复页面。

## 截图、真实输入与等待

先截图取得 `observation`，再把它原样传给输入。CLI 默认复用 `manual-cli` 页面，所以不同 CLI 进程可使用同一文档的凭据。使用 `COCOS_RUNTIME_PROBE_OWNERSHIP=isolated` 时，每次 CLI 调用结束都释放页面，适合单次诊断；连续交互应使用长期 MCP 服务或 CLI shared 模式。

PowerShell 示例使用 JSON 文件避免原生命令参数的引号问题：

```powershell
$shot = npm run --silent runtime:probe -- screenshot | ConvertFrom-Json
$payload = @{
  action = 'click'
  device = 'mouse'
  point = @{ x = 200; y = 300 }
  observation = $shot.observation
}
$payload | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 input.json
npm run --silent runtime:probe -- input --file input.json
```

截图是视口 PNG，MCP 直接返回 `image` 内容块与元数据文本，CLI 返回图片绝对路径。元数据包含图片像素尺寸、视口 CSS 尺寸、devicePixelRatio、visual viewport 的缩放/偏移、Canvas 边界和 Cocos 能力信息。CSS 坐标以页面视口左上角为原点；图片像素不能简单当作 CSS 像素。没有 pinch 缩放时，按图片/视口尺寸比例换算；visual viewport 有缩放时，应结合其 CSS 宽高和偏移换算，或直接使用节点 UUID 定位。

默认图片保存到 `%TEMP%/cocos-live-probe-<workspace-id>-artifacts`，按旧到新保留最多 100 张、总计 100 MiB。只有本工具默认目录受自动清理；指定 `outputPath` 时由调用者管理文件。可在确认不再需要后清理该默认产物目录。

输入参数：

| 参数 | 说明 |
| --- | --- |
| `action` | `click`、`long-press`、`drag`、`key`。 |
| `device` | 指针操作必须为 `mouse` 或 `touch`；一次操作只发送一种输入。 |
| `observation` | 当前截图返回的完整观察凭据；包含 target、实例、刷新代次、文档身份和几何指纹。 |
| `point` | `{ "x": 200, "y": 300 }` 或 `{ "uuid": "节点UUID" }`。 |
| `to` | 拖动终点，格式与 `point` 相同。 |
| `keys` | 键盘操作的按键列表，如 `["Control", "a"]`；最多 8 个，不重复。 |
| `durationMs` | 最多 20000；点击默认 0，其他操作默认 500。 |
| `timeoutMs` | 总时限默认 10000，范围 100..30000，须大于 durationMs；失败清理另有短暂上限。 |

支持字母、数字，以及 Control/Shift/Alt/Meta、Enter/Escape/Tab/Backspace/Delete、ArrowLeft/Up/Right/Down、Space、Home/End/PageUp/PageDown。键盘输入先让受管页面获得焦点；不支持的键在发送前报错。

UUID 定位首轮面向 Cocos 3.8 UITransform 节点，计算节点中心的相机投影，再转换为 CSS 坐标。多相机时提供 `cameraUuid`，多 Canvas 时提供 `canvasId`；这些字段放在 UUID point 对象中。节点失效、inactive、无法投影、坐标越界或无法唯一选择时拒绝操作。任意 3D 对象定位和多指手势不在本轮范围内。

所有操作经过 CDP Input 和正常命中测试；不会绕过 Cocos 或 DOM 弹窗遮挡。`status=sent` 表示定位和输入发送/释放完成，业务是否成功须通过现有查询或 `wait` 验证。部分发送后不重试；失败返回 `started`、`completed`、`cleanupConfirmed` 和错误。连接失去时可能无法确认释放，结果会明确说明。

显式刷新、人工 F5、导航、target 更换，以及视口/Canvas 几何变化后，旧观察凭据被拒绝。重新截图后再操作；场景切换需重新查询节点 UUID。动态对象在同一文档内移动仍需调用者判断最新位置，凭据不冻结游戏画面。

等待参数为 `condition`、`timeoutMs`（默认 5000，最多 30000）和 `intervalMs`（默认 100，范围 10..1000）：

```json
{ "condition": { "type": "node-exists", "selector": "Dialog" } }
```

```json
{ "condition": { "type": "property", "selector": "节点UUID", "component": "cc.Button", "path": "interactable", "operator": "eq", "value": true }, "timeoutMs": 5000 }
```

存在性条件支持 `node-exists` / `node-absent`，inactive 节点仍存在。属性条件要求唯一节点，component 可省略以直接读取节点属性；path 为只读属性路径，不接受方法调用或任意 JS。比较支持 eq/ne/gt/gte/lt/lte，值为 JSON 基本类型；有序比较只接受数值。属性/组件缺失、歧义或版本不支持明确报错。条件超时返回 `status=timeout`、最后观察值及耗时；页面丢失或文档变化另报错误。MCP 把输入失败或等待超时标记为工具错误，并保留结构化结果。

等待占用当前会话队列。先发送输入再等待，不能用排在等待后面的同会话命令使条件成立。本轮不提供引擎帧等待。

## 持续诊断与脚本反馈

连接 target 后自动订阅 console、运行时异常、未处理 Promise 拒绝、Network 传输失败和 HTTP 4xx/5xx。它不要求活动场景就绪。诊断结果包含 `startedAt`、连接状态、target/文档代次、事件时间、可用调用栈及增量游标；未提供的栈或 URL 不会补造。

`diagnostics` 可传 `after` 游标、`limit`（默认 100，最多 1000）、`types` 和 `levels`。类型为 console/exception/promise-rejection/network-failure/http-error/gap；级别为 log/info/warn/error/debug。读取不清空缓冲区。将 `nextCursor` 用作后续 `after`；`hasMore=true` 时继续分页。游标早于保留范围会显示 `cursorGap`，丢弃数量在 `dropped` 中。

容量同时限制为 1000 条、总计 2 MiB、单条 16 KiB；对象按深度和成员数截断，循环引用和超长内容有标记，不保留远程对象句柄或网络响应体。断连、重连和刷新保留原文档标记，并报告采集空档。

长期 stdio/HTTP MCP 在服务连接期间持续采集；CLI 每次只有自身连接期间的记录，不提供跨进程日志历史。`startedAt` 不能证明订阅之前没有错误，也不保证恢复页面启动早期日志。

CLI 既有 eval 输出默认保持不变。需要一次取得脚本结果、耗时、日志及异常时，显式添加 `--diagnostics`：

```powershell
npm run --silent runtime:probe -- eval --diagnostics '(() => { console.warn("probe"); return { ready: true }; })()'
npm run --silent runtime:probe -- eval-file --diagnostics diagnostic.js
```

这些选项返回 `{ status, result, elapsedMs, diagnostics, targetId, instanceId, refreshGeneration }`。脚本异常为 `status=failed`，不假定脚本状态修改能自动回滚；异步记录只有在返回之前发生才属于本次反馈。MCP 仍不暴露任意 eval。

运行 `npm test` 和 `npm run typecheck` 验证公共命令/协议行为。`npm run test:browser` 另需正在运行的 Creator 预览与独立 CDP 浏览器；它在独占上下文里创建通用 Cocos 场景，验证截图、真实输入、遮挡、缩放、等待、诊断、场景切换和旧凭据拒绝。跨进程 CLI 验收要求该浏览器没有已有 manual-cli 页面；测试创建的 CLI 页面会在结束时关闭。

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

CLI、stdio MCP 和 HTTP MCP 均支持 `COCOS_RUNTIME_PROBE_PREVIEW_URL` 与 `COCOS_RUNTIME_PROBE_CDP_ORIGIN`，可分别指定 Creator 资源服务和浏览器 CDP 地址。CLI 默认复用 `manual-cli` 页面，设置 `COCOS_RUNTIME_PROBE_OWNERSHIP=isolated` 可改为一次命令一个隔离上下文；stdio MCP 默认按会话隔离。

`animations` 与 `sample-animation` 同时读取普通 `cc.Animation` 和 `cc.SkeletalAnimation`。运行时既支持 SystemJS 的 `cc` 模块，也支持 `globalThis.cc`；不同版本的私有动画字段可能缺失。

在工具目录运行 `npm run typecheck` 和 `npm test` 验证通用实现。游戏专用的 `eval-file` 脚本与回归 runner 放在宿主项目，使用绝对路径或宿主工作目录下的相对路径执行。

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
