# 项目级游戏扩展

游戏扩展是宿主仓库维护的本地模块，复用当前 RuntimeProbeService 的受管页面。它读取开发观察桥、选择一个动作并验证业务效果；通用探针负责真实输入、页面所有权、截止时间和有界报告。

## 启用

显式服务选项 `gameExtension` 优先于 `COCOS_RUNTIME_PROBE_GAME_EXTENSION`。相对路径以 `workspaceRoot` 为基准，默认 workspace 是本工具所在目录向上两级的宿主根目录。插件在进程启动时加载，不热更新；路径错误或契约版本不兼容会使启动失败。

```powershell
$env:COCOS_RUNTIME_PROBE_GAME_EXTENSION = 'tools/game-extensions/count-rice/index.ts'
npm run runtime:probe -- launch
npm run runtime:probe -- game-state
```

先 `launch` 可以把浏览器/预览的冷启动和后续游戏命令的时间预算分开。插件可为当前 Node/ts-node 能加载的本地 CommonJS 模块或带 default export 的 TypeScript 模块；工具不下载插件或自动安装插件依赖。

stdio MCP 启动环境设置相同变量后，工具列表增加 `game_state`、`game_step`、`game_autoplay`。未配置时原来的工具列表不变。CLI 使用 manual-cli 页面；stdio 每个会话独占页面；HTTP 的全部客户端共享服务实例。CLI 的多个进程不具备整个自动玩批次的互斥保证，持续交互优先使用长期服务实例。

## 观察桥

在游戏开发预览注册一个只读全局对象，提供同步 `getState()`：

```ts
globalThis.__myGameProbe = {
  getState: () => ({
    gameId: "my-game", stateVersion: 1, instanceId: "current-screen-instance",
    state: { score: 0, inputReady: true, button: { uuid: "current-button-uuid" } },
  }),
};
```

桥的实例标记在屏幕重新启用或运行时替换时更新，屏幕停用/销毁时只解除自己注册的桥。发布构建不启用它。`state` 必须是可序列化 JSON 对象，最多 64 KiB，不返回 Cocos 对象、函数或 ECS 对象引用。玩法来自既有快照，输入锁和弹窗来自必要的只读投影；观察不会调用 tick、保存或修改游戏。

## 插件契约

插件满足导出的 `GameExtension`：

- `id`、`apiVersion: 1`、`gameId`、`stateVersion`、`bridgeName` 声明身份与兼容性。可用 `cocosVersions` 限定已支持版本。
- `goalSchema` 和可选 `policySchema` 使用 JSON Schema。Ajv 在输入前校验，建议对象明确 `additionalProperties: false`。这些 schema 也用于 MCP 工具发现。
- `readState(raw)` 返回供策略使用的 JSON 状态，可校验或收窄游戏载荷。
- `decide(state, goal, policy)` 返回 `done`、`blocked`、`wait` 或 `input`，以及人可读的 `reason`。
- `verify(before, after, decision, goal)` 返回 `status: satisfied/pending/blocked`、`progress: boolean` 和可选原因。验证针对本次动作，不能因为无关倒计时或被动金币变化就把购买判为成功。

`input` 决策包含现有输入参数：action、device、point、to、keys、durationMs；其中 point 可以是当前节点 UUID。插件不提供 observation 和 timeoutMs，探针取得最新截图凭据并按剩余预算限制输入。`wait` 可指定 `durationMs: 1..1000`，缺省 100 毫秒。等待后再次观察，不发输入。

插件不持有底层浏览器或服务上下文，因此不能递归进入 dispatch 造成队列死锁。插件为受信任本地代码，不是沙箱；须保持异步、无后台工作，不阻塞 Node 事件循环。异步决定超时后的迟到返回不会触发输入。

## 调用与预算

三个命令接受一个 JSON 对象，CLI 也支持 `--file <JSON文件>`，相对文件路径按 CLI 当前目录解析。

| 参数 | state | step | autoplay |
| --- | --- | --- | --- |
| `goal` | 无 | 必填，插件 schema | 必填，插件 schema |
| `policy` | 无 | 默认 `{}` | 默认 `{}` |
| `timeoutMs` | 默认 5000，最多 10000 | 默认 5000，最多 10000 | 默认 20000，最多 30000 |
| `maxSteps` | 无 | 无 | 默认 100，最多 1000 |
| `noProgressTimeoutMs` | 无 | 无 | 默认 min(5000, timeoutMs)，最多 timeoutMs |

预算包含排队、页面准备、观察、截图、输入和验证；指针/按键释放另有现有输入工具的短清理时限。MCP 工具超时应覆盖执行预算和清理；本项目使用 45 秒。已达成目标不输入。等待也计步数。每个自动玩批次最多保留最近 50 条记录，报告最多 256 KiB，截断和省略都有标记。

报告含前后状态、目标完成情况、决策及理由、输入状态、业务验证、耗时、步骤记录和诊断范围。主要停止原因是 `goal-reached`、`time-limit`、`step-limit`、`no-progress`、`blocked`、`result-unknown`、`input-failed`、`page-changed`、`bridge-unavailable`、`plugin-error`。

`time-limit` 和 `step-limit` 正常结束当前批次，目标可能尚未完成；失败返回 `status: failed`，MCP 标记工具错误。输入部分失败或结果不明不重放。人工刷新、顶层导航、页面丢失或桥实例替换时停止；显式恢复后再观察。普通已支持的同文档场景变化须重新解析节点。

返回后不会自动续跑。运行较长流程时，调用者重新读取状态并明确发起下一批。客户端断开不保证立即取消，执行仍受既定预算限制。诊断仅为当前服务连接期间已采集的记录；CLI 不提供跨进程日志历史。

## CountRice 接入

数米插件保留在 CountRice 宿主，声明开发桥 `__countRiceProbe`、游戏 ID `count-rice`、状态版本 1，并支持 Cocos 3.8.8。其目标例子为：

```json
{"goal":{"type":"upgrade","target":"countPower","level":2},"timeoutMs":20000,"maxSteps":150}
```

```json
{"goal":{"type":"stage","stage":"eatRice"},"timeoutMs":20000}
```

CountRice 状态独立报告米桶、物理米袋、首轮吃米储备和米槽，升级价格来自已有快照。策略跟随引导、处理普通离线收益与已支持解锁提示、等待动画，再通过真实触摸进行升级、数米、吃米和正常阶段继续。未知弹窗、广告与付费流程停止。

测试准备和诊断仍可单独使用既有 CLI eval；它们不是游戏 MCP 接口，不用于代替真实输入。接入另一个游戏时，只需增加它自己的桥和插件，并运行同样的公共命令测试与真实预览验收。
