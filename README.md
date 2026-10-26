# dsh-drag-graft（拖拽引用对话）

把侧边栏的**会话行拖到对话区松手** → 会话引用以**原生 chip** 形式落进输入框，你接着打字/语音，最后自己按发送：**一条消息里既有引用又有你的问题**。

[English README](README_EN.md)

## 行为

1. 拖起侧边栏任意会话行，拖到对话区（输入框/聊天区）松手
2. 输入框里出现一个**蓝标 chip**（与手打 `@` 选对话完全一样，是 Lexical decorator 节点，不是文本、不是 base64）
3. 光标在 chip 后面，继续打字
4. 回车 → 一条消息里同时有引用和你的问题

- **零常驻 UI**：没有投放条、没有浮层面板、没有按钮、没有高亮动画
- 成功静默；只有失败才在底部出现一行红字
- 落在**侧边栏**里的拖拽完全不拦截（官方同组排序、`dsh-workspace-mover` 跨组搬家照旧）
- 文件拖拽不拦截（宿主上传行为不受影响）
- 插入失败**自动降级**：直接发一条只含引用的蓝标消息，输入框保持干净，不留残留

## 实现原理（依赖 DSH 内部 API，升级可能失效）

DSH 输入框是 **Lexical** 编辑器：DOM 直写 / `execCommand` / 合成 `paste` 都**不会**进入它的状态，所以"程序化打 `@` 再触发弹层"是死路（实测：字进 DOM，弹层永不出现）。

能用的只有官方 launcher 管线，四步：

| 步骤 | API | 说明 |
|---|---|---|
| 1 | `ctx.inject(['inputTriggers'])` | 取 `@` 触发服务（必须经 `ctx.inject`，`ctx.get` 拿不到作用域实例） |
| 2 | `controller.toggleSource('reference', hit)` | 用**合成 hit**（`trigger:'@'`、`query:标题`）直接打开 reference 候选，不需要真打字 |
| 3 | `controller.pick('reference', index)` | → `settle()` → `execute()` → 官方事件 `slash/input-insert-reference` |
| 4 | `hit.span.draftRev` | 输入机对插入做 **CAS**；rev 通过包一层 `controller.track(draft, caret, guard, draftRev)` 捕获（页面加载即调用，之后每次编辑 +1） |

`query` 用会话标题可把候选收窄到目标那一条（否则前面全是文件/文件夹）。rev 未知时按 `[lastTrack.rev, 0..8]` 试探；**CAS 不匹配时官方什么都不插**，所以试探安全、不留残留。

## 兼容性

| 宿主 | 状态 |
|---|---|
| DSH Desktop `0.2.1-rc.3`（Electron 44.7 / Chrome 152） | 端到端实测通过（chip 落入，`rev = 8`） |
| 更早的版本线 | 未测，`engines.dsh` 会拒绝 |
| 将来的版本 | 降级为"直接发引用消息"，不会崩 |

## 踩过的坑（别重走）

1. **别往 Lexical 输入框写文本再指望 `@` 弹层**：状态不更新，只会留下垃圾串
2. **别设 `dataTransfer.dropEffect='copy'`**：官方拖拽 `effectAllowed` 是 `move`，冲突时浏览器**直接取消投放**（高亮正常、松手无事件）
3. **别在页面开着时改 `client.js` 再 reload**：可能读到半截 bundle → `import failed` → **整个 web boot 起不来**。正确流程：停用插件 → 改文件 → `node --check` → 启用
4. `document` 级 `drop` 监听必须用**冒泡**（capture 会先于组件 `onDrop` 清状态，把组件卸掉）

## 边界

- 一条消息最多 **3 个**会话引用（宿主硬限制 `MAX_REFERENCES`）
- 引用正文由 `@deepseek-ai/dsh-session-reference` 压缩注入（默认 64KB，超出截断并落盘留档），只保留真实往来
- 目标会话运行中时走 `queue` 排队，不打断当前回合

## 安装 / 停用 / 卸载

```powershell
plugin_manager { action: "install_bundle", target: "<目录或包名>" }
plugin_manager { action: "set_bundle", target: "dsh-drag-graft", enabled: false }
plugin_manager { action: "remove_bundle", target: "dsh-drag-graft" }
```

万一某个版本坏了、应用起不来：桌面弹窗里的 **「禁用第三方插件、备份 profile patch 并重启」** 是官方安全出口。

## 开发

```powershell
npm run check   # 语法 + manifest/契约测试（node --test）
```

诊断：客户端半区暴露 `window.__dragGraft`（`state()` / `controller()` / `insert(id, title)`），可用 CDP 只读检查；它自身不写任何东西。

MIT License。
