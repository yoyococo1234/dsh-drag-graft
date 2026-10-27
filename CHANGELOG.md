# Changelog

## 2.1.1 — 2026-10-27

底部提示停留时长砍半（原来报错那条要挂 9 秒，太占视线）。

- 普通提示：3000ms → **1500ms**
- 报错提示：9000ms → **4500ms**
- 抽成常量 `TOAST_MS` / `TOAST_ERROR_MS`，想再调改这两行即可。

## 2.1.0 — 2026-10-27

首个「装完就能用、不用改任何配置」的版本。核心变化：**引用上限跟着宿主走**，
不再写死 3 或 100；同时清掉三条并存的历史插入路径。

### 新增

- 宿主半区新增只读 RPC `draggraft.limits`，从 `sessionReferenceResolver.config` 读出
  `maxReferences` / `candidateLimit`（读不到就按原版 3 处理）；`draggraft.ping` 也带上了 `limits`。
- 浏览器半区启动时向宿主询问上限，拖拽时按**真实上限**提前拦截，并在提示里写清具体数字。
- 调试钩子补齐：`state()`（含 limits / refCount / hasInputActions）、`limits()`、
  `refreshLimits()`、`span()`、`refCount()`、`insert()`、`send()`。

### 修复

- **文件引用不再占用会话引用配额**：只统计 `appearance === 'session'` 的 occurrence
  （以前连文件 chip 一起数，会提前误拦）。
- **连拖不再叠加**：插入/直发在飞时，第二次投放直接忽略（以前可能并发插两次）。
- 删除历史遗留的两条插入路径（打字触发 / launcher 试探）与 `track` 猴补丁：
  它们用的是错的坐标和猜出来的 draftRev，只会制造「插不进去」的假象。
- `PLUGIN_VERSION` 与 `package.json` 对齐，并加测试锁死三处版本号一致。

### 测试

- 20 项（原 9 项契约 + 11 项行为）：自引用拦截、盲选防护、连续多 chip、
  上限跟随宿主（3 / 100 两种）、文件引用不占配额、版本一致性、RPC 契约。

## 2.0.4 — 2026-10-27

跟上宿主侧补丁：引用上限从 3 提到 **100**（宿主 `app.asar` 已重打包：
`@deepseek-ai/dsh-session-reference` 的 `MAX_REFERENCES`、schema 上限、构造校验三处同时放开，
候选会话数 50 → 200）。

### 改动

- 插件自身的提前拦截阈值 3 → 100（只在真的到 100 时才提示；4 个、10 个都正常插）；
- 新增测试：草稿已有 4 个引用时能正常插第 5 个；已有 100 个时拦第 101 个。

### 注意

- 宿主补丁在 `app.asar` 里，**DSH 每次更新会被整包覆盖**，上限会回到 3；
  更新后要么重打宿主补丁，要么把这里阈值改回 3。
- 每个引用预览最多 64KB，100 个 ≈ 6.4MB 文本；宿主按上下文比例截断、超出落盘，
  实际能塞几个取决于模型窗口。

## 2.0.3 — 2026-10-27

拖第 4 个引用时提前拦下，不再让用户拼出一条注定失败的草稿。

### 背景（宿主硬限制，不是本插件）

宿主 `@deepseek-ai/dsh-session-reference` 里写死 `MAX_REFERENCES = 3`：一条消息最多 3 个
会话引用，第 4 个会在提交时整轮拒绝——`a message may reference at most 3 sessions`。

### 改动

- 通过插槽标准 prop `useInput` 读 `InputState.occurrences`，实时知道草稿里已有几个引用；
- 已有 3 个时再拖第 4 个：只弹提示（分两条消息发 / 用 `graft_forward` 把内容当正文带进来），
  不插 chip、不发送；
- 调试钩子新增 `window.__dragGraft.refCount()`。

### 说明

放开 3 这个数字需要改宿主常量（在 `app.asar` 内的 `dsh-session-reference`，含客户端副本），
属于 fork 安装包：需要管理员权限、每次 DSH 更新被整包覆盖、可能触发 asar 完整性校验。
本插件不做这件事，只在 3 以内保证好用。

## 2.0.2 — 2026-10-27

修「只能拖一个进去」：第二个及之后的会话引用插不进草稿。

### 根因

插入引用 chip 时，宿主用 `span.draftRev !== rev` 做 CAS，且 span 必须是 **detect 坐标**
（chip 在 detect 文本里只占一个占位符，不是它的标签文字）。旧代码拿
`editor.textContent.length` 当 caret、再猜 `draftRev`（`lastTrack.rev` + 0..8 试探）：
草稿为空时恰好能中；一旦草稿里已经有 chip，两个坐标都错位 → 宿主拒绝 → 只能插一个。

### 修复

- 改用宿主公开的 `inputActions.captureInsertion()`（插槽标准 prop）现取
  `{ start, end, draftRev }`，每次尝试都重新取，不再猜 rev。
- 探针（`conversation.input.overlay` 上的隐藏节点）现在会接住 `inputActions`。
- 调试钩子新增 `window.__dragGraft.span()` 与 `state().hasInputActions`。

### 已知限制（宿主侧，不是本插件）

- 单条消息最多 **3** 个会话引用（宿主 `MAX_REFERENCES = 3`），第 4 个会在发送时被拒。

## 2.0.1 — 2026-10-27

修一个会让整轮对话直接失败的硬伤：**引用到自己**。

### 修复

- **不再可能插入自引用**：拖的是当前对话自己时直接提示并放弃（宿主会拒绝整轮：`session "…" cannot reference itself`）。
- **删掉「候选里挑不到就选第一条」的盲选兜底**（三处：打字触发、launcher、按 rev 试探）。候选第一条通常就是最近/当前会话，盲选会把错的会话塞进草稿——这是自引用报错的真正来源。
- 改成按标题严格匹配（精确 → 唯一前缀/包含），匹配不到或有歧义就**什么都不做**，不再污染草稿。
- 直发兜底（`dropReference`）同样加自引用拦截。

### 行为变化

- 拖当前对话到对话区：弹一行提示，草稿不变、不发消息。
- 候选里没有同名会话：不插入、不发送，输入框保持干净（以前会插入「最近的那一个」）。

## 2.0.0 — 2026-10-26

首个可发布版本。

### 新增

- 拖拽会话行到对话区 → 会话引用以**原生 chip** 落进输入框（Lexical decorator 节点），可继续打字再发送。
- 经官方 launcher 管线插入：`inputTriggers.toggleSource`（合成 hit）→ `pick` → `slash/input-insert-reference`；用 `track` 钩子取得 `draftRev` 通过 CAS。
- 插入失败自动降级为「直接发送一条只含引用的蓝标消息」，输入框不留残留。
- 侧边栏内的拖拽、文件拖拽完全不拦截（与 `dsh-workspace-mover`、宿主上传共存）。
- 诊断钩子 `window.__dragGraft`（只读状态 + 手动插入），供 CDP 排查。

### 健壮性

- 客户端与宿主两半区的 `apply` 均包 `try/catch`：异常只记录日志并保持惰性，不再出现「entry did not activate」导致整个 web boot 失败。
- `engines.dsh` 钉到实测区间 `>=0.2.1-rc.2 <0.3.0-0`。
- 9 项契约测试（manifest 可发布性、files/exports 完整性、patch 引用、client module id、两半区 fail-soft、session URI 编解码、locale meta）。

### 已知限制

- 依赖 DSH 内部 API（`inputTriggers`、`slash/input-insert-reference`、`track` 签名），宿主升级可能失效；失效时降级为发消息，不会崩。
- 单条消息最多 3 个会话引用（宿主 `MAX_REFERENCES`）。

## 1.3.0 — 2026-10-26

- 内部迭代：修通 `draftRev` CAS，chip 首次成功落入草稿。

## 1.0.0 — 2026-10-26

- 稳定形态：拖拽 → 直接发送一条原生会话引用消息（蓝标），零常驻 UI。
