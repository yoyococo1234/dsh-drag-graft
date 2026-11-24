# dsh-drag-graft-chip-restore

撤回对话后，自动把输入框里**灰底的** `@[会话标题](dsh-session:…)` **纯文本引用还原成蓝色 chip**。

## 它解决什么

`dsh-rewind` 撤回一条消息时，把消息文本用 `setDraft(纯文本)` 回填输入框。但会话引用在日志里其实是 text block 里的一个特殊串：

```
@[会话标题](dsh-session:<base64url(sessionId)>)
```

宿主只有在草稿里把它当成**结构化引用节点**时才渲染成蓝色 chip。rewind 塞回纯文本后，宿主不认，就显示成灰底的 `@会话标题`——外观和发送前不一样，看着像坏了。

本插件监听输入框，处理**两种**回填形态：

- **完整 token** `@[标题](dsh-session:…)`：解码出 session id；
- **@标题**（dsh-rewind 撤回后的真实形态——token 在日志里已被规范化成 `@标题`）：用会话列表按标题**精确且唯一**反查 session id，重名或找不到就跳过（绝不插错会话）。

然后：
1. 去掉 `@标题` / token 的纯文本；
2. 用宿主的 `conversation.input.for(scope).insertReference()` 在原位置插回真正的 chip。

**不改 dsh-rewind、不改宿主、不动原版 dsh-drag-graft。**

## 和原版 dsh-drag-graft 的区别（两个版本都能装）

| | `dsh-drag-graft` | `dsh-drag-graft-chip-restore`（本包） |
|---|---|---|
| 作用 | 把侧栏会话/文件夹**拖进输入框**变 chip | 撤回后把**已有的**纯文本引用 token 变回 chip |
| 触发 | 拖拽 | 输入框出现 `dsh-session:` token 时自动 |
| 依赖 rewind | 否 | 是（为修 rewind 的回填副作用） |
| 是否需要对方配合 | — | 否，纯本地 client 行为 |

两者可以**同时安装**：原版负责"拖进去"，本包负责"撤回后还原"。也可以只装一个。

⚠️ **重要：本插件修复的是"撤回回填那一侧"的显示。** 消息**发送出去后本来就是正常的蓝色 chip**（宿主正常渲染），这一侧不需要修。

## 安装

```sh
dsh plugin --profile desktop add dsh-drag-graft-chip-restore
# 或插件市场搜索 dsh-drag-graft-chip-restore
```

安装后**重启 DSH**（client bundle 要重新加载）。

## 验证是否已生效

重启后在浏览器控制台输入：

```js
__chipRestore?.state()
```

返回 `hasConversation: true` 说明宿主通道已就绪。撤回一条带会话引用的消息后，输入框里应立即从灰底 `@标题` 变成蓝色 chip。控制台会打印 `[chip-restore] restored N chip(s)`。

## 行为边界（失败安全）

- 拿不到宿主 `insertReference` / `setDraft` 通道时**静默退出**，绝不改写草稿；
- 自引用（引用当前会话自己）保留原样——宿主会拒绝自引用，不擅自处理；
- `@标题` 只有**精确且唯一**命中一个会话时才还原；标题重名、找不到、只是部分匹配都当普通文本，绝不插错；
- 你手动输入的 `@某人` / `@附件` 这类文本，因反查不到会话，不会被误改；
- DOM 结构异常、API 抛错都不影响输入。

## 测试

`npm test`：17 项纯逻辑测试，覆盖真实日志 token 的解码、rewind 真实回填形态（`@标题`）、标题反查与重名跳过、偏移、ref 构造、多引用、自引用、client/lib 逻辑一致性。

**未做浏览器实测**：本仓库的开发环境无法启动浏览器自动化，最后一步"token 真的变 chip"依赖真实 DSH 输入框验证。纯逻辑部分已测；如果重启后实测不顺，请带控制台日志提 issue。
