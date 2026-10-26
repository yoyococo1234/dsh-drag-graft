# Changelog

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
