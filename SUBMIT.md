# 发布与市场提交清单

> 这份文件只给发布者看，不需要随包分发（可加进 `.npmignore` 或从 `files` 移除）。

## 0. 先补三个真实值

`package.json` 里现在有两个占位，发布前必须替换：

```jsonc
{
  "author": "<你的名字或 GitHub 用户名> <邮箱>",
  "repository": { "type": "git", "url": "git+https://github.com/<你>/dsh-drag-graft.git" },
  "homepage": "https://github.com/<你>/dsh-drag-graft#readme",
  "bugs": { "url": "https://github.com/<你>/dsh-drag-graft/issues" }
}
```

`LICENSE` 里把 `<AUTHOR>` 换成同一名字。

## 1. 建 GitHub 仓库

```powershell
cd C:\Users\Lenovo\Desktop\dsh-drag-graft
git init -b main
git add -A
git commit -m "feat: drag a session row into the composer as a native reference chip"
# 在 GitHub 上建空仓库 dsh-drag-graft（不要勾 README/LICENSE，本地已有）
git remote add origin https://github.com/<你>/dsh-drag-graft.git
git push -u origin main
```

推上去后 CI（`.github/workflows/ci.yml`）会自动在 ubuntu/windows × node 22/24 跑 `node --check` + 9 项契约测试。

## 2. 发 npm

```powershell
# 先确认包名没被占（当前 404 = 可用）
npm view dsh-drag-graft version
npm login                     # 需要你手动登录
npm publish                   # 无 scope，不需要 --access public
```

发布后验证：

```powershell
npm view dsh-drag-graft version dist.tarball
```

装包方式（给用户）：

```powershell
plugin_manager { action: "install_bundle", target: "dsh-drag-graft" }
```

## 3. 市场提交素材（可直接复制）

### 一句话简介（中）

> 把侧边栏的会话行拖进对话框，会话引用以原生 chip 落进草稿——你继续打字，一条消息里既有引用又有问题。

### 一句话简介（英）

> Drag a conversation row from the DSH sidebar into the composer and it lands as a native session-reference chip; keep typing, then send one message that carries both.

### 长描述要点

- 零常驻 UI：没有投放条、面板、按钮、动画
- 落点在**草稿**里而不是发一条消息，所以你还能接着打字/语音
- 侧边栏内拖拽、文件拖拽都不拦截（与 workspace-mover / 宿主上传共存）
- 插入失败自动降级为"发送一条引用消息"，不留残留
- 引用正文由宿主 `session-reference` 压缩注入（64KB 上限），只保留真实往来

### 兼容矩阵（提交时填）

| 宿主版本 | 结果 |
|---|---|
| DSH Desktop 0.2.1-rc.3（Electron 44.7 / Chrome 152 / Windows 11） | ✅ 端到端通过（chip 落入 `rev=2`，输入框清理干净） |
| 其它版本 | 未测；`engines.dsh` 已限制 `>=0.2.1-rc.2 <0.3.0-0` |

### 风险自评（如实写，市场会看）

- 依赖 **内部 API**：`inputTriggers.toggleSource/pick`、官方事件 `slash/input-insert-reference`、`controller.track` 的 `draftRev` 语义。宿主升级可能失效。
- 失效行为：**静默降级**为发送一条引用消息，不写文件、不改会话、不崩溃。
- 不读磁盘、不发网络请求、不写会话档案；只做「把官方引用节点放进草稿」。
- 最坏情况曾出现：客户端 bundle 导入失败会让 web boot 起不来——已用 `try/catch` 包住两半区 `apply`，并在 README 写了恢复入口（桌面「禁用第三方插件并重启」）。

### 截图清单

| 文件 | 内容 | 状态 |
|---|---|---|
| `docs/screenshot-chip.png` | 输入框里一个蓝标 chip，光标在其后 | **待截**：用带 `--remote-debugging-port=9222` 的启动方式，我可以自动生成（`work\shot.mjs`）；或你手动截 |
| 建议补一张 | 拖拽瞬间（侧栏行 + 落点） | 待截 |
| 建议补一张 | 发送后消息里 chip + 提问同框 | 待截 |

## 4. 提交渠道

| 渠道 | 需要 |
|---|---|
| [dshplugin.store](https://www.dshplugin.store/) | 仓库链接、简介、截图、兼容版本 |
| [awesome-dsh-plugin.com](https://awesome-dsh-plugin.com/) | PR 到 awesome 列表，一行描述 + 分类（Sessions & Messages） |
| dsh.so / dsh-plugin-registry | 按各站规则；通常要风险评级与 `engines.dsh` |
| 本地插件市场（`dshmarket`） | 装 npm 包即可被索引；确保 `dsh.bundle.patch` 与 `dsh.client` 字段齐全 |

## 5. 发布后回归（每次 DSH 升级都要做）

```powershell
# 1. 确认插件仍加载（浏览器控制台应出现）
#    [drag-graft] probe mounted on conversation.input.overlay
#    [drag-graft] inputTriggers ready
#    [drag-graft] track hook installed
# 2. 真拖一次：chip 是否落进输入框；失败会打印
#    [drag-graft] 所有 rev 试探均未插入
# 3. 契约测试
node --test "test/*.test.mjs"
```

若第 2 步开始失败，说明内部 API 变了：优先修 `insertChipByRevs`，其次确认降级路径（`dropReference`）仍可用。
