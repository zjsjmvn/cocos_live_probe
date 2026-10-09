# Issue #3 验收记录

2026-10-09，Cocos Creator 3.8.8，Windows，Node 22，Chrome 154，Electron 44。

## 已通过

- `npm run typecheck`：工具及测试类型检查通过。
- `npm test`：通用协议、互动、游戏扩展、Inspector、AI 接入、渲染、证据和输入反馈八组测试通过。
- `COCOS_RUNTIME_PROBE_CDP_ORIGIN=http://127.0.0.1:9223 npm run test:browser`（环境变量按当前 shell 设置）：独立 BrowserContext，真实鼠标/触摸命中、遮挡接收者、空白 miss、键盘不适用、拖动、暂停缓存、缩放、刷新和严格渲染截图通过。
- `npm run test:inspector:desktop`：实际 WebContents，AI/跨进程 CLI 保持同一 target/document，输入命中、原生键鼠、属性编辑、暂停、保存验收包、嵌入 DevTools 和窗口布局通过。保存包后没有恢复或重载暂停游戏。
- `npm run test:inspector:browser`：独立浏览器 Inspector，节点编辑、刷新身份拒绝、面板生命周期通过。
- 最终源码构建后另行打包到 `releases/Cocos Live Probe Inspector Issue 3-win32-x64`，执行打包 exe 的 `--smoke-test`：全部桌面验收通过。原人工窗口占用默认发布目录，因此使用同级独立目录打包并等待测试进程成功退出，未关闭原窗口。当前已验证版本可直接运行该目录内的 `Cocos Live Probe Inspector.exe`。
- 宿主 CountRice `node -r ts-node/register -e "require('../game-extensions/count-rice/browser-smoke.ts')"`：独立页面，正常触摸完成引导与 countPower 升级、阶段继续、鸡店升级和普通离线领取；验证桥生命周期。最终来源检查版保存 run `4e1ca6c2-fdee-4017-b13d-990842bfd6b1`，129 个步骤产物，包含真实命中与业务 verification，实际引擎版本 3.8.8。清单记录 12 条外部命令、201 项产物，共 20,472,413 字节。

CountRice 包按事实标为 partial：诊断存在截断，部分游戏工具回执只保留最近 50 步；可用的较早步骤已经及时外置保存。最终运行的有界 Git 查询未取得来源，commit/dirty 如实记录为 unknown，且 `provesLoadedCode:false`；实际运行版本独立记录，没有将源码提交宣称为预览加载版本。

## 文件与生命周期覆盖

公共 dispatch / CLI / stdio / HTTP 入口验证默认无新目录、准确 runId、活动冲突、共享运行、自动归档终态、EOF 结束、截图副本、相对包内引用、实际清单字节、容量截断和不可用导出。保留数量为 1 时，finish 返回的包仍存在；下一轮才清理旧包。活动包与带人工文件的包不清理。缺失截图文件返回 damaged。容量不足不重复输入，任意 eval 数组仍返回原形状。

渲染模拟夹具只通过真实 after-draw 事件模拟引擎边界：无事件能力为 unsupported，同名替换场景使缓存失效，无新绘制有界超时，普通截图保持可用。输入实机验收使用浏览器/CDP 和 Electron 原生输入，未通过直接 emit 代替引擎输入。

复用显式截图路径会按内容摘要保留不同版本，截图容量失败不会借用旧副本。渲染等待与严格截图在返回/保存前再次验证场景与文档。关闭时即使落盘失败，也会释放本服务的活动运行身份。

输入反馈核对当前 trusted DOM 事件、阶段、指针 ID 和引擎 DPR 坐标；相同 ID/坐标的延迟脚本派发降级为 unknown/partial，不收录为真实命中。真实 Chrome、打包 Electron 和 CountRice 已验证同步派发链路；不支持来源观察或异步派发的环境明确降级，仍执行既有输入。

## 最终审查

固定基准使用用户已批准的 `e0edb61`，审查 `git diff e0edb61...HEAD`；最后实现复审提交为 `b7ff9fc`。标准轴与规格轴分别由独立代理复核，剩余发现均为 0。审查发现的截图版本、输入来源、场景二次确认和关闭状态问题均已修复并回归。最终文档提交只补齐本记录及规格交付状态。
