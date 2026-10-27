# dsh-drag-graft · 拖拽引用对话

把侧边栏的**会话行拖到对话区松手**，它会变成输入框里一枚**原生会话引用 chip**；
你接着打字/语音，最后自己按发送 —— **一条消息里既有别的对话的上下文，又有你的问题**。

- 零常驻 UI：没有按钮、没有投放条、没有浮层面板
- 成功静默（草稿里多出来的 chip 就是反馈），只有失败才在底部闪一行字
- 不改宿主文件、不联网、不发消息（除非插入失败走兜底，见下）

[English README](README_EN.md)

---

## 快速开始（下载就能用）

**方式 A：让 DSH 里的 agent 装**（最省事）

```
plugin_manager { action: "install_bundle", target: "dsh-drag-graft" }
```

**方式 B：命令行**

```powershell
dsh plugin --profile desktop add dsh-drag-graft
```

**方式 C：设置面板**
DSH → 设置 → 插件 → 安装 → 输入包名 `dsh-drag-graft` → 安装 → 刷新页面。

装好后**刷新页面**，然后：

1. 侧边栏拖起任意一个**别的**会话行
2. 拖到对话区（输入框或聊天区）松手
3. 输入框里出现蓝标 chip（和手打 `@` 选对话完全一样，是原生引用节点）
4. 继续打字 → 回车

30 秒自检：拖完之后按 F12 在控制台输入 `__dragGraft.state()`，应看到
`{ currentSessionId: "session-…", hasInputTriggers: true, hasInputActions: true, limits: { maxReferences: 3, … } }`。

---

## 使用说明

| 操作 | 结果 |
|---|---|
| 拖别的会话行 → 对话区 | 草稿里插入引用 chip，可继续编辑后发送 |
| 连拖多个不同会话 | 依次插入多个 chip（上限见下） |
| 拖**当前对话自己** | 拦下并提示（宿主会拒绝 `cannot reference itself`，整轮失败） |
| 拖到**侧边栏内部** | 完全不拦截：官方排序、`dsh-workspace-mover` 跨组搬家照旧 |
| 拖**文件**到对话区 | 完全不拦截：宿主上传行为不受影响 |
| 候选里找不到该会话 | 什么都不插，不会把错的会话塞进草稿 |

### 一条消息能引用几个？

上限由**宿主**决定，本插件跟着宿主走（通过 `draggraft.limits` 读取）：

- 原版 DSH：**3 个**（`@deepseek-ai/dsh-session-reference` 的 `MAX_REFERENCES = 3`），第 4 个会在发送时被整轮拒绝，所以插件在拖第 4 个时就拦住你并提示。
- 如果你的宿主被打过补丁（例如把上限改到 100），插件会自动放宽，不需要改插件。

> 想突破 3：那属于改宿主（重打包 `app.asar`），不是本插件的能力范围。
>
> **但这件事可以直接丢给你的 AI 做。** 开一个新对话，把下面这段贴给它：
>
> ```text
> 帮我把 DSH 宿主里 @deepseek-ai/dsh-session-reference 的会话引用上限从 3 改大（比如 100），
> 让 dsh-drag-graft 这类插件一条消息能拖进更多对话。
>
> 要点：
> 1. MAX_REFERENCES 不止一处：const 常量、Config schema 的 .max(3).default(3)、构造函数里的 > 3
>    硬校验，三处都要改；只改一处会被另一处拒绝（SESSION_REFERENCE_INVALID_CONFIG）。
> 2. 改完要重打包 app.asar：头布局 [4][size][fieldSize][jsonLen][json][pad4]，数据起点 8+size，
>    重算每个 file 的 offset/size 和 integrity（sha256 + 4MB blocks）。
> 3. 换包前必须完全退出 DSH（asar 被占用会报「正由另一进程使用」），换完起进程并探监听端口做
>    健康检查，失败自动回滚。
> 4. DSH 每次更新会整包覆盖 app.asar，上限会回到 3，所以请做成可重复执行的脚本。
> ```
>
> 改完之后不用动本插件：它每次插入前都会重新向宿主读一次上限（`__dragGraft.refreshLimits()` 可手动重读）。

### 插入失败时的兜底

如果宿主内部 API 变化导致 chip 插不进去，插件会**退化为直接发一条只含引用的消息**（聊天里出现蓝标引用），输入框保持干净。
这是刻意的降级设计：**宁可少一个 chip，也不要静默失败**。

---

## 故障排查

先看控制台（F12）：

| 你想知道 | 命令 |
|---|---|
| 插件是否活着 | `__dragGraft.state()` |
| 宿主给的上限 | `__dragGraft.limits()` |
| 当前插入位点（detect 坐标 + draftRev） | `__dragGraft.span()` |
| 草稿里已有几个会话引用 | `__dragGraft.refCount()` |
| 手动插一次（调试） | `__dragGraft.insert("<session-id>", "标题")` |
| 重新读宿主上限 | `__dragGraft.refreshLimits()` |

常见症状：

| 症状 | 原因 | 处理 |
|---|---|---|
| 拖了没反应 | 拖的是当前对话自己 / 已达上限 / 候选里没有该会话 | 看控制台 toast 与 `state()` |
| 提示「拿不到官方插入位点」 | 宿主没把 `inputActions` 传下来（版本不匹配） | 会走直发兜底；升级/降级 DSH 或提 issue |
| 第二个之后插不进 | 旧版 bug（已修，2.0.2 起用 `captureInsertion`） | 升级到 ≥2.1.0 |
| 整轮报 `cannot reference itself` | 旧版 bug（2.0.1 起已拦） | 升级 |
| 整轮报 `may reference at most N sessions` | 超过宿主上限 | 分两条消息发，或用 `graft_forward` 把内容当正文 |
| 页面白屏 / 起不来 | 插件半区抛错（已做 fail-soft） | 桌面弹窗「禁用第三方插件并重启」是官方安全出口 |

---

## 停用 / 卸载

```
plugin_manager { action: "set_bundle", target: "dsh-drag-graft", enabled: false }   # 临时停用
plugin_manager { action: "remove_bundle", target: "dsh-drag-graft" }                # 卸载
```

命令行等价：`dsh plugin --profile desktop remove dsh-drag-graft`

---

## 隐私与安全

- **不联网**：没有任何网络请求。
- **不读文件**：只通过宿主公开的 `sessions` / `inputTriggers` 服务操作当前 UI。
- **宿主半区只读**：`index.js` 不建会话、不改文件、不发消息，只提供两个只读 RPC（`draggraft.limits` / `draggraft.transcript`）和一个诊断工具 `draggraft_probe`。
- **不绕过任何权限**：走的都是你在界面里本来就能做的操作。

---

## 实现原理（依赖 DSH 内部 API，升级可能失效）

DSH 输入框是 **Lexical** 编辑器：DOM 直写 / `execCommand` / 合成 `paste` 都不会进入它的状态，所以「程序化打 `@` 再触发弹层」是死路。

能用的只有官方管线：

| 步骤 | API | 说明 |
|---|---|---|
| 1 | `ctx.inject(['inputTriggers'])` | 取 `@` 触发服务（必须经 `ctx.inject`，`ctx.get` 拿不到作用域实例） |
| 2 | `controller.toggleSource('reference', hit)` | 用**合成 hit** 直接打开 reference 候选，不需要真打字 |
| 3 | `controller.pick('reference', index)` | → `settle()` → `execute()` → 官方事件 `slash/input-insert-reference` |
| 4 | `inputActions.captureInsertion()` | 宿主插槽标准 prop，返回 **detect 坐标 + 当前 draftRev**；`insertReference` 用它做 CAS |

两个关键细节（都踩过）：

- **坐标必须是 detect 坐标**：chip 在 detect 文本里只占一个占位符，不是它的标签文字；用 `textContent.length` 当 caret，草稿里一旦有 chip 就错位 → 第二个插不进去。
- **draftRev 必须现取**：每次编辑 rev 都会 +1，猜 rev 会被 CAS 拒绝。

## 兼容性

| 宿主 | 状态 |
|---|---|
| DSH Desktop `0.2.1-rc.3`（Electron 44 / Chrome 152） | 端到端实测通过 |
| 更早的版本线 | 未测，`engines.dsh` 会拒绝 |
| 将来的版本 | 内部 API 变了会降级为「直接发引用消息」，不会崩 |

## 开发

```powershell
npm run check   # 语法检查 + manifest/契约/行为测试（node --test，20 项）
```

测试里用最小 DOM/React/宿主桩把 `client.js` 真跑起来，覆盖：自引用拦截、盲选防护、连续多 chip、上限跟随宿主、文件引用不占配额。

## 与 `@mars.liu/dsh-graft` 的区别

| | dsh-drag-graft（本插件） | @mars.liu/dsh-graft |
|---|---|---|
| 形态 | 拖拽 → 草稿里的原生引用 chip | 会话头 🌱 开关 + 每轮选段 + 转发 |
| 结果 | 宿主自动压缩对方会话（默认 64KB）注入 | 把选定轮次原文作为一条 `<graft>` 消息写进目标会话 |
| 界面 | 零 UI | 有按钮/选择条 |
| 适用 | 想让当前模型知道那边聊了什么，且还能继续打字 | 需要精确的某几轮原文 |

两者可以共存，不抢插槽、不抢拖拽事件。

MIT License。
