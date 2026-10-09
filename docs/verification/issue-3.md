# Issue #3 验收记录

2026-10-09，Cocos Creator 3.8.8，Windows，Node 22，Chrome 154，Electron 44。

## 已通过

- `npm run typecheck`：工具及测试类型检查通过。
- `npm test`：通用协议、互动、游戏扩展、Inspector、AI 接入、渲染和证据七组测试通过。
- `COCOS_RUNTIME_PROBE_CDP_ORIGIN=http://127.0.0.1:9223 npm run test:browser`（环境变量按当前 shell 设置）：独立 BrowserContext，真实鼠标/触摸命中、遮挡接收者、空白 miss、键盘不适用、拖动、暂停缓存、缩放、刷新和严格渲染截图通过。
- `npm run test:inspector:desktop`：实际 WebContents，AI/跨进程 CLI 保持同一 target/document，输入命中、原生键鼠、属性编辑、暂停、保存验收包、嵌入 DevTools 和窗口布局通过。保存包后没有恢复或重载暂停游戏。
- 宿主 CountRice `node -r ts-node/register -e "require('../game-extensions/count-rice/browser-smoke.ts')"`：独立页面，正常触摸完成引导与 countPower 升级、阶段继续、鸡店升级和普通离线领取；验证桥生命周期。保存 run `3141dee0-c3ef-45aa-931e-43fbd61c9649`，129 个步骤产物，包含真实命中与业务 verification，实际引擎版本 3.8.8。

CountRice 包按事实标为 partial：诊断存在截断，部分游戏工具回执只保留最近 50 步；可用的较早步骤已经及时外置保存。Git 来源标记 dirty 且 `provesLoadedCode:false`，没有将源码提交宣称为预览加载版本。

## 文件与生命周期覆盖

公共 dispatch / CLI / stdio / HTTP 入口验证默认无新目录、准确 runId、活动冲突、共享运行、自动归档终态、EOF 结束、截图副本、相对包内引用、实际清单字节、容量截断和不可用导出。保留数量为 1 时，finish 返回的包仍存在；下一轮才清理旧包。活动包与带人工文件的包不清理。缺失截图文件返回 damaged。容量不足不重复输入，任意 eval 数组仍返回原形状。

渲染模拟夹具只通过真实 after-draw 事件模拟引擎边界：无事件能力为 unsupported，同名替换场景使缓存失效，无新绘制有界超时，普通截图保持可用。输入实机验收使用浏览器/CDP 和 Electron 原生输入，未通过直接 emit 代替引擎输入。

打包版本、浏览器 Inspector 与最终代码审查的结果在交付提交前补齐。
