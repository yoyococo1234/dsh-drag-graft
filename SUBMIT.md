# 发布与市场提交清单

> 这份文件只给发布者看，不需要随包分发（不在 `files` 里，`npm pack` 不会带上）。

## 0. 元数据现状（已填好，发布前确认一遍）

```jsonc
{
  "author": "yoyococo1234 <yoyococo1234@users.noreply.github.com>",
  "repository": { "type": "git", "url": "git+https://github.com/yoyococo1234/dsh-drag-graft.git" },
  "homepage": "https://github.com/yoyococo1234/dsh-drag-graft#readme",
  "bugs": { "url": "https://github.com/yoyococo1234/dsh-drag-graft/issues" }
}
```

`LICENSE` 里的作者名要和上面一致。

## 1. 发布前自检（缺一不可）

```powershell
cd C:\Users\Lenovo\Desktop\dsh-drag-graft
node --check index.js
node --check client.js
node --test "test/*.test.mjs"      # 期望：20 项全过
npm pack --dry-run                 # 期望：只含 index.js / client.js / patch / locale / icon / README* / CHANGELOG / test
```

版本号三处必须一致（有测试锁）：`package.json` 的 `version`、
`index.js` 的 `PLUGIN_VERSION`、`client.js` 调试钩子里的 `version`。

## 2. 发 GitHub

```powershell
git add -A
git commit -m "release: v2.1.0 — reference limit follows the host"
git push origin main
git tag v2.1.0 && git push origin v2.1.0
```

推上去后 CI（`.github/workflows/ci.yml`）会在 ubuntu/windows × node 22/24 跑
`node --check` + 全部 `test/*.test.mjs`。

## 3. 发 npm（注意本机默认 registry 是镜像）

本机 `~/.npmrc` 把默认 registry 指到了 `registry.npmmirror.com`，
而发布凭据是 `//registry.npmjs.org/:_authToken=`。所以**必须显式指定 registry**：

```powershell
# 0) 确认 npmjs 侧身份（不要用默认 registry，会报 ENEEDAUTH）
npm whoami --registry=https://registry.npmjs.org/

# 1) 确认远端已有版本，避免覆盖
npm view dsh-drag-graft version --registry=https://registry.npmjs.org/

# 2) 发布（无 scope，不需要 --access public）
npm publish --registry=https://registry.npmjs.org/
```

发布后验证：

```powershell
npm view dsh-drag-graft version --registry=https://registry.npmjs.org/
npm view dsh-drag-graft dist-tags --registry=https://registry.npmjs.org/
```

装回验证（另起一个空目录，别污染 profile）：

```powershell
mkdir $env:TEMP\dgg-verify; cd $env:TEMP\dgg-verify
npm init -y | Out-Null
npm i dsh-drag-graft@latest --registry=https://registry.npmjs.org/
node -e "import('dsh-drag-graft').then(m=>console.log('host exports:', Object.keys(m)))"
```

## 4. 装进 DSH 自测（真机验收）

```powershell
dsh plugin --profile desktop add dsh-drag-graft@2.1.0
```

然后刷新页面，按 README 的「30 秒自检」跑一遍：

1. 拖别的会话行 → 草稿出现蓝标 chip；
2. 连拖两个 → 两个 chip；
3. 拖当前对话自己 → 提示、不插；
4. `__dragGraft.state()` 里 `limits.maxReferences` 与 `__dragGraft.limits()` 一致。

## 5. 市场/社区提交（可选）

- 提 issue / PR 到 DSH 插件市场列表时，贴 `README.md` 的「快速开始」+ 一张拖拽 GIF。
- 强调三条：零 UI、上限跟宿主走、插入失败会降级而不是静默失败。

## 6. 回滚

```powershell
npm unpublish dsh-drag-graft@2.1.0 --registry=https://registry.npmjs.org/   # 72 小时内有效
# 或直接发一个修复版本（推荐）
```
