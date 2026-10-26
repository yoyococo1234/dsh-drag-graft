// @local/drag-graft — Browser half (v0.5)
//
// 零 UI 版：把侧边栏的会话行拖到对话区松手 → 直接投一条**原生会话引用**消息。
//
// 为什么这么做：DSH 自带 session-reference 机制——消息文本里写
//     @[标题](dsh-session:<base64url(JSON.stringify(sessionId))>)
// 宿主会解析成结构化引用，UI 渲染成一个蓝标 chip，并把对方会话**压缩成有界预览**
// （默认 64KB，超长部分落盘留档）注入模型上下文。所以这里不需要倒原文、不需要
// 自绘任何界面，也没有任何特效：不注册常驻条、不弹面板、不显示按钮。
//
// 唯一保留的挂载点是一个 **渲染 null 的探针**（conversation.input.overlay），
// 只为拿到「当前会话 id」这个 prop；它在页面上不可见。
//
// 失败才提示（右下角一行字），成功静默——聊天里出现的蓝标就是反馈。

window.__ModuleLoader__.load({
  id: 'dsh-drag-graft',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')
    const h = React.createElement

    const SESSION_ID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
    const ID_PREFIX_RE = /^(?:session|sid|session-id)\s*[:#]\s*/i
    const POLL_INTERVAL = 100
    const POLL_TIMEOUT = 5000

    const inject = ['slots', 'sessions']

    // ── 会话引用编码（与 @deepseek-ai/dsh-session-reference 完全一致）──────────
    const encodeSessionUri = (sessionId) => {
      const json = JSON.stringify(String(sessionId))
      const bytes = new TextEncoder().encode(json)
      let binary = ''
      for (const byte of bytes) binary += String.fromCharCode(byte)
      return `dsh-session:${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`
    }

    const escapeLabel = (label) => String(label).replace(/[\\\]]/gu, (match) => `\\${match}`)

    const formatMention = (sessionId, label) =>
      `@[${escapeLabel(label || sessionId)}](${encodeSessionUri(sessionId)})`

    // ── 从拖拽里取出会话 id ──────────────────────────────────────────────────
    const normalizeId = (raw) => {
      const text = String(raw ?? '').trim().split(/[\r\n]/)[0].trim().replace(ID_PREFIX_RE, '')
      const hit = SESSION_ID_RE.exec(text)
      if (!hit) return null
      const prefix = text.slice(0, hit.index).trim().toLowerCase()
      const head = prefix === 'import-' || prefix === 'od-' ? prefix : prefix === 'session-' ? 'session-' : ''
      return `${head}${hit[0].toLowerCase()}`
    }

    const idFromTransfer = (dt) => {
      try {
        const types = [...(dt?.types ?? [])]
        for (const type of ['application/x-dsh-session-id', 'text/plain', 'text/uri-list', ...types]) {
          try {
            const id = normalizeId(dt.getData(type))
            if (id) return id
          } catch { /* 该类型不可读 */ }
        }
      } catch { /* ignore */ }
      return null
    }

    const isFileDrag = (event) => {
      try { return [...(event?.dataTransfer?.types ?? [])].includes('Files') } catch { return false }
    }

    const idFromElement = (el, byId) => {
      const accept = (value) => {
        if (typeof value !== 'string' || !value) return null
        const cleaned = value.replace(ID_PREFIX_RE, '')
        return byId[cleaned] !== undefined ? cleaned : null
      }
      let node = el
      for (let depth = 0; node && depth < 16; depth += 1, node = node.parentElement) {
        try {
          for (const attr of ['data-row-key', 'data-session-id', 'data-id', 'data-key']) {
            const hit = accept(node.getAttribute?.(attr))
            if (hit) return hit
          }
        } catch { /* ignore */ }
        try {
          const fiberKey = Object.getOwnPropertyNames(node).find((k) => k.startsWith('__reactFiber$'))
          if (!fiberKey) continue
          let fiber = node[fiberKey]
          for (let hop = 0; fiber && hop < 26; hop += 1, fiber = fiber.return) {
            const props = fiber.memoizedProps
            if (!props || typeof props !== 'object') continue
            for (const candidate of [props.node?.id, props.sessionId, props.session?.id, props.node?.sessionId, props.row?.id, props.item?.id]) {
              const hit = accept(candidate)
              if (hit) return hit
            }
            if (typeof props.id === 'string') {
              const hit = accept(props.id)
              if (hit) return hit
            }
          }
        } catch { /* ignore */ }
      }
      return null
    }

    /** 侧边栏的行/分组标题：这些落点交给官方与 workspace-mover，不抢。 */
    const insideSidebarRow = (el) => {
      let node = el
      for (let depth = 0; node && depth < 12; depth += 1, node = node.parentElement) {
        try {
          if (node.getAttribute?.('data-row-key') !== null && node.getAttribute?.('data-row-key') !== undefined) return true
        } catch { /* ignore */ }
      }
      return false
    }

    // ── apply ────────────────────────────────────────────────────────────────
    let applied = false

    // 失败即静默：apply 里任何异常都不能冒到加载器（entry 激活失败会阻断整个 web boot）。
    function apply(ctx) {
      try {
        applyInner(ctx)
      } catch (error) {
        console.error('[drag-graft] apply failed; plugin stays inert:', error)
      }
    }

    function applyInner(ctx) {
      if (applied) return
      applied = true

      const sessions = ctx.sessions
      const sessionStore = () => sessions.list.getSnapshot()
      const disposers = []
      const timers = new Set()

      let currentSessionId = null
      let composerAnchor = null // 输入卡片内的隐藏锚点，用来定位输入框
      let dragSource = null // { id, title }
      let dragElement = null
      let busy = false
      let inputTriggers = null // 官方 @ 触发服务（用 ctx.inject 拿到作用域内的实例）
      let lastTrack = null // 输入机最近一次 track(draft, caret, guard, draftRev)

      // 关键：服务必须通过 ctx.inject 取，直接 ctx.get 拿不到（作用域未声明）。
      try {
        ctx.inject(['inputTriggers'], (scope) => {
          inputTriggers = scope.inputTriggers
          console.info('[drag-graft] inputTriggers ready')
          return () => { inputTriggers = null }
        })
      } catch (error) {
        console.warn('[drag-graft] inputTriggers 注入失败：', error)
      }

      const toast = (text, isError) => {
        try {
          const el = document.createElement('div')
          el.setAttribute('role', 'status')
          el.textContent = text
          el.style.cssText = [
            'position:fixed', 'left:50%', 'transform:translateX(-50%)', 'bottom:120px', 'z-index:2147483000',
            'max-width:min(680px, 60vw)', 'padding:9px 13px', 'border-radius:9px',
            'font-size:12.5px', 'line-height:1.5', 'white-space:pre-wrap',
            'box-shadow:0 8px 28px rgba(0,0,0,.22)', 'pointer-events:none',
            `background:${isError ? 'var(--dsw-alias-state-error, #cf222e)' : 'var(--dsw-alias-bg-overlay, #1f2328)'}`,
            'color:#fff', 'border:1px solid rgba(127,127,127,.28)',
          ].join(';')
          document.body.appendChild(el)
          const timer = setTimeout(() => {
            timers.delete(timer)
            try { el.remove() } catch { /* ignore */ }
          }, isError ? 9000 : 3000)
          timers.add(timer)
        } catch (error) { console.warn('[drag-graft] toast failed:', error) }
      }

      const poll = async (probe, describe) => {
        const deadline = Date.now() + POLL_TIMEOUT
        for (;;) {
          const value = probe()
          if (value !== undefined && value !== null) return value
          if (Date.now() > deadline) throw new Error(`等待${describe}超时`)
          await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL))
        }
      }

      const resolveDropId = (event) => {
        const byId = sessionStore().byId ?? {}
        const fromTransfer = idFromTransfer(event?.dataTransfer)
        if (fromTransfer) return fromTransfer
        if (dragElement?.isConnected) return idFromElement(dragElement, byId)
        return null
      }

      /** 把引用文本插进当前输入框（不发送），保留继续打字/语音的能力。 */
      const findComposerEditor = () => {
        if (composerAnchor?.isConnected) {
          let node = composerAnchor
          for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
            const editors = node.querySelectorAll?.('[contenteditable="true"], textarea')
            if (editors?.length) return editors[editors.length - 1]
          }
        }
        const all = [...document.querySelectorAll('[contenteditable="true"], textarea')]
          .filter((el) => el.offsetParent !== null || el.getClientRects().length > 0)
        return all.length ? all[all.length - 1] : null
      }

      const insertIntoComposer = (text) => {
        try {
          const editor = findComposerEditor()
          if (!editor) return false
          editor.focus?.()
          if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
            const before = editor.value ?? ''
            const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
              ?? Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
            setter?.call(editor, `${before}${before && !before.endsWith(' ') ? ' ' : ''}${text}`)
            editor.dispatchEvent(new Event('input', { bubbles: true }))
            return (editor.value ?? '').length > before.length
          }
          // contenteditable：光标移到末尾后插入
          try {
            const selection = window.getSelection()
            const range = document.createRange()
            range.selectNodeContents(editor)
            range.collapse(false)
            selection?.removeAllRanges()
            selection?.addRange(range)
          } catch { /* 选择失败也继续试插入 */ }
          const before = editor.textContent ?? ''
          try { document.execCommand('insertText', false, text) } catch { /* 继续走 paste 兜底 */ }
          if ((editor.textContent ?? '').length > before.length) return true
          // 合成 paste：Lexical / ProseMirror / CodeMirror 都监听 paste 并读 clipboardData
          try {
            const dt = new DataTransfer()
            dt.setData('text/plain', text)
            const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt })
            Object.defineProperty(event, 'clipboardData', { value: dt })
            editor.dispatchEvent(event)
          } catch { /* ignore */ }
          return (editor.textContent ?? '').length > before.length
        } catch (error) {
          console.warn('[drag-graft] 插入输入框失败：', error)
          return false
        }
      }

      /**
       * 走官方 @ 触发流程把「真 chip」插进输入框：
       *   1) 在输入框打 `@标题片段` → 官方 inputTriggers 弹出候选
       *   2) 读 controller.menu 快照，找到目标会话那一行
       *   3) 调 controller.pick('reference', index) —— 官方自己插入结构化引用节点
       * 任何一步不成立就撤销刚才打的字并返回 false（调用方退回直接发送）。
       */
      const insertChipViaTrigger = async (sourceId, title) => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
        const undo = () => {
          try { document.execCommand('undo'); document.execCommand('undo') } catch { /* ignore */ }
        }
        try {
          const service = inputTriggers ?? (() => { try { return ctx.get('inputTriggers') } catch { return null } })()
          if (!service?.sessionOf) {
            console.warn('[drag-graft] inputTriggers 不可用（注入未完成或该版本无此服务）')
            return false
          }
          if (!currentSessionId) {
            console.warn('[drag-graft] 当前会话 id 未知')
            return false
          }
          // scope 可能在会话刚打开时短暂缺失，重试几次
          let scope = null
          for (let attempt = 0; attempt < 12 && !scope; attempt += 1) {
            scope = sessions.scope?.(currentSessionId) ?? null
            if (!scope) await sleep(60)
          }
          if (!scope) {
            console.warn('[drag-graft] sessions.scope 取不到，放弃插入')
            return false
          }
          const controller = service.sessionOf(scope)
          if (!controller?.menu || typeof controller.pick !== 'function') {
            console.warn('[drag-graft] controller 形状不符', Object.keys(controller ?? {}))
            return false
          }

          const editor = findComposerEditor()
          const query = `@${String(title ?? '').slice(0, 18)}`
          if (!insertIntoComposer(query)) {
            console.warn('[drag-graft] 打不出 @ 查询串（编辑器拒绝插入）')
            return false
          }

          const deadline = Date.now() + 2500
          while (Date.now() < deadline) {
            await sleep(120)
            let state = null
            try {
              const snap = controller.menu.getSnapshot?.()
              state = snap?.state ?? snap
            } catch { state = null }
            if (!state?.open) continue
            const groups = Array.isArray(state.groups) ? state.groups : []
            const group = groups.find((g) => g?.source === 'reference' && g?.status !== 'pending' && (g?.items?.length ?? 0) > 0)
            if (!group) continue
            const items = group.items
            const wanted = String(title ?? '').trim().toLowerCase()
            let index = items.findIndex((item) => String(item?.label ?? item?.name ?? '').trim().toLowerCase() === wanted)
            if (index < 0 && items.length === 1) index = 0
            if (index < 0) continue
            try {
              controller.pick('reference', index)
            } catch (error) {
              console.warn('[drag-graft] controller.pick 失败：', error?.message ?? error)
              break
            }
            await sleep(120)
            // 校验：chip 落进草稿后，刚才打的 `@查询串` 应当消失
            const text = (findComposerEditor() ?? editor)?.textContent ?? ''
            if (query.length > 2 && text.includes(query)) {
              console.warn('[drag-graft] pick 后草稿仍含查询串，判定插入失败')
              undo()
              return false
            }
            console.info('[drag-graft] chip inserted via @ trigger', sourceId, 'index', index)
            return true
          }
          undo()
          return false
        } catch (error) {
          console.warn('[drag-graft] 触发式插入失败：', error)
          undo()
          return false
        }
      }

      /**
       * 官方 launcher 路径：`controller.toggleSource(source, hit)` + `pick()`。
       *
       * 与"打字触发"不同，这里**不往输入框写任何东西**：
       *   toggleSource 用合成 hit（trigger/query/span）直接打开 reference 源菜单，
       *   pick 之后走官方事件 `slash/input-insert-reference` 把 chip 插进草稿。
       *   span 带 draftRev 做 CAS：rev 不匹配时官方直接不插入（不会留垃圾），
       *   所以可以安全地用"最近一次 track 记录的 rev / 邻近 rev / 不带 rev"依次试探。
       *
       * 返回 true 表示草稿确实变了（chip 落进去了）。
       */
      const insertChipViaLauncher = async (sourceId, title) => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
        try {
          const service = inputTriggers ?? (() => { try { return ctx.get('inputTriggers') } catch { return null } })()
          if (!service?.sessionOf) { console.warn('[drag-graft] inputTriggers 不可用'); return false }
          if (!currentSessionId) return false
          let scope = null
          for (let i = 0; i < 12 && !scope; i += 1) {
            scope = sessions.scope?.(currentSessionId) ?? null
            if (!scope) await sleep(60)
          }
          if (!scope) { console.warn('[drag-graft] 取不到 sessions.scope'); return false }
          const controller = service.sessionOf(scope)
          if (!controller?.toggleSource || typeof controller.pick !== 'function') {
            console.warn('[drag-graft] controller 缺少 toggleSource/pick')
            return false
          }

          // 记录输入机真实 draftRev（track 是它每次草稿变化的入口）
          if (!controller.__dragGraftPatched) {
            const original = controller.track?.bind(controller)
            if (original) {
              controller.track = (...args) => {
                try { lastTrack = { draft: args[0], caret: args[1], rev: args[3] } } catch { /* ignore */ }
                return original(...args)
              }
              controller.__dragGraftPatched = true
            }
          }

          const editor = findComposerEditor()
          const before = editor?.textContent ?? ''
          const caret = before.length
          const wanted = String(title ?? '').trim().toLowerCase()

          const revs = []
          if (lastTrack && typeof lastTrack.rev === 'number') {
            revs.push(lastTrack.rev, lastTrack.rev + 1, lastTrack.rev + 2)
          }
          revs.push(undefined) // 不带 rev：若官方不做 CAS 也能直接成功

          for (const rev of revs) {
            const hit = {
              trigger: '@',
              query: '',
              quoted: false,
              position: 'leading',
              span: rev === undefined ? { start: caret, end: caret } : { start: caret, end: caret, draftRev: rev },
            }
            try { controller.toggleSource('reference', hit) } catch (error) {
              console.warn('[drag-graft] toggleSource 失败：', error?.message ?? error)
              return false
            }

            // 等候选落地
            let picked = null
            const deadline = Date.now() + 2000
            while (Date.now() < deadline) {
              await sleep(100)
              let state = null
              try { const snap = controller.menu.getSnapshot?.(); state = snap?.state ?? snap } catch { state = null }
              if (!state?.open) break
              const group = (state.groups ?? []).find((g) => g?.source === 'reference' && g?.status === 'ready' && (g?.items?.length ?? 0) > 0)
              if (!group) continue
              const items = group.items
              let index = items.findIndex((item) => String(item?.label ?? item?.name ?? '').trim().toLowerCase() === wanted)
              if (index < 0 && items.length === 1) index = 0
              if (index < 0) index = 0 // 候选里第一条通常就是最近会话
              picked = index
              break
            }
            if (picked === null) { try { controller.dismiss() } catch { /* ignore */ } ; continue }

            try { controller.pick('reference', picked) } catch (error) {
              console.warn('[drag-graft] pick 失败：', error?.message ?? error)
              try { controller.dismiss() } catch { /* ignore */ }
              continue
            }
            await sleep(160)
            const after = (findComposerEditor() ?? editor)?.textContent ?? ''
            if (after !== before) {
              console.info('[drag-graft] chip inserted via launcher', sourceId, 'rev', rev, 'index', picked)
              return true
            }
            try { controller.dismiss() } catch { /* ignore */ }
          }
          console.info('[drag-graft] launcher 路径未插入（CAS 未命中）')
          return false
        } catch (error) {
          console.warn('[drag-graft] launcher 插入失败：', error)
          return false
        }
      }

      /**
       * 按 draftRev 逐个试探的插入：官方 settle 每次 pick 都会关菜单，所以每轮重新
       * toggleSource。rev 用"输入机 track 记录的真实 rev"优先，其次 0..8 兜底；
       * CAS 不匹配时官方不插入，因此重试是安全的（不会留下任何残留）。
       */
      const insertChipByRevs = async (sourceId, title) => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
        try {
          if (!inputTriggers?.sessionOf || !currentSessionId) return false
          const scope = sessions.scope?.(currentSessionId)
          if (!scope) return false
          const controller = inputTriggers.sessionOf(scope)
          if (!controller?.toggleSource || typeof controller.pick !== 'function') return false
          patchTrack(currentSessionId)

          const editor = findComposerEditor()
          const draftNow = editor?.textContent ?? ''
          const caret = lastTrack && lastTrack.draft === draftNow && typeof lastTrack.caret === 'number'
            ? lastTrack.caret
            : draftNow.length
          const wanted = String(title ?? '').trim().toLowerCase()
          const query = String(title ?? '').slice(0, 24)

          const revs = []
          if (lastTrack && typeof lastTrack.rev === 'number') revs.push(lastTrack.rev)
          for (let r = 0; r <= 8; r += 1) if (!revs.includes(r)) revs.push(r)

          for (const rev of revs) {
            const hit = {
              trigger: '@', query, quoted: false, position: 'leading',
              span: { start: caret, end: caret, draftRev: rev },
            }
            try { controller.toggleSource('reference', hit) } catch (error) {
              console.warn('[drag-graft] toggleSource 失败：', error?.message ?? error)
              return false
            }

            let index = -1
            const deadline = Date.now() + 1500
            while (Date.now() < deadline) {
              await sleep(100)
              let state = null
              try { const snap = controller.menu.getSnapshot?.(); state = snap?.state ?? snap } catch { state = null }
              if (!state?.open) break
              const group = (state.groups ?? []).find((g) => g?.source === 'reference' && g?.status === 'ready' && (g?.items?.length ?? 0) > 0)
              if (!group) continue
              const items = group.items
              let found = items.findIndex((item) => String(item?.label ?? item?.name ?? '').trim().toLowerCase() === wanted)
              if (found < 0) found = 0
              index = found
              break
            }
            if (index < 0) { try { controller.dismiss() } catch { /* ignore */ } ; continue }

            try { controller.pick('reference', index) } catch (error) {
              console.warn('[drag-graft] pick 失败：', error?.message ?? error)
            }
            await sleep(130)
            const after = (findComposerEditor() ?? editor)?.textContent ?? ''
            if (after !== draftNow) {
              console.info('[drag-graft] chip inserted, rev =', rev, 'index =', index)
              return true
            }
          }
          console.info('[drag-graft] 所有 rev 试探均未插入')
          return false
        } catch (error) {
          console.warn('[drag-graft] insertChipByRevs 失败：', error)
          return false
        }
      }

      /** 兜底：直接投一条只含会话引用的消息（宿主解析成蓝标 + 有界预览）。 */
      const dropReference = async (sourceId, label) => {
        if (busy) return
        busy = true
        try {
          const targetId = currentSessionId
          if (!targetId) throw new Error('拿不到当前会话 id，请刷新页面后再试')
          const target = await poll(() => sessions.binding(targetId)?.session ?? null, '当前会话绑定')
          const text = formatMention(sourceId, label)
          const result = await target.prompt([{ type: 'text', text }], 'queue')
          if (!result?.ok) throw new Error(`投递被拒绝[${result?.error?.code ?? 'unknown'}]：${result?.error?.message ?? ''}`)
          console.info('[drag-graft] referenced', sourceId, '→', targetId)
          // 投完把焦点交回输入框：立刻就能打字或按语音键。
          try { findComposerEditor()?.focus?.() } catch { /* 焦点拿不到不影响引用 */ }
        } catch (error) {
          toast(`引用对话失败：${error?.message ?? String(error)}`, true)
          console.warn('[drag-graft] reference failed:', error)
        } finally {
          busy = false
        }
      }

      // ── 拖拽拦截：只认「非文件 + 落在对话区（非侧栏行）」的投放 ────────────────
      const onDragStart = (event) => {
        dragElement = null
        dragSource = null
        try {
          if (isFileDrag(event)) return
          const byId = sessionStore().byId ?? {}
          dragElement = event.target ?? null
          const fromTransfer = idFromTransfer(event.dataTransfer)
          const id = (fromTransfer && byId[fromTransfer] !== undefined ? fromTransfer : null)
            ?? idFromElement(event.target, byId)
            ?? fromTransfer
          if (!id) return
          const row = byId[id]
          dragSource = { id, title: row?.displayTitle ?? row?.title ?? '' }
          console.info('[drag-graft] dragging', dragSource)
        } catch (error) {
          dragSource = null
          console.warn('[drag-graft] dragstart 识别失败：', error)
        }
      }

      const onDragOver = (event) => {
        if (!dragSource || isFileDrag(event)) return
        if (insideSidebarRow(event.target)) return // 侧栏内部：交给官方与 workspace-mover
        event.preventDefault() // 没有这一行 drop 不会触发
      }

      const onDrop = (event) => {
        const source = dragSource
        dragSource = null
        dragElement = null
        if (!source || isFileDrag(event)) return
        if (insideSidebarRow(event.target)) return
        event.preventDefault()
        event.stopPropagation()
        const id = resolveDropId(event) ?? source.id
        if (!id) {
          toast('没认出被拖的是哪个对话（拖拽数据里没有会话 id）。', true)
          return
        }
        const row = sessionStore().byId?.[id]
        const label = row?.displayTitle ?? row?.title ?? source.title ?? ''
        void (async () => {
          // 首选：把真 chip 插进草稿（可继续打字再发送）。CAS 不匹配时官方不插入，无残留。
          if (await insertChipByRevs(id, label)) return
          // 兜底：直接发一条引用消息（对话里出现蓝标），输入框保持干净。
          void dropReference(id, label)
        })()
      }

      const listen = (type, handler, capture) => {
        document.addEventListener(type, handler, capture)
        disposers.push(() => document.removeEventListener(type, handler, capture))
      }
      listen('dragstart', onDragStart, true)
      listen('dragover', onDragOver, true)
      listen('drop', onDrop, true)
      listen('dragend', () => { dragSource = null; dragElement = null }, true)

      // ── 不可见探针：拿当前会话 id + 提供一个定位输入框的 DOM 锚点（零视觉）──────
      // 顺便在输入机上挂 track 钩子，记录真实 draftRev（官方插入事件的 CAS 依据）。
      const patchTrack = (sessionId) => {
        try {
          const scope = sessionId ? sessions.scope?.(sessionId) : null
          const controller = scope && inputTriggers?.sessionOf ? inputTriggers.sessionOf(scope) : null
          if (!controller || typeof controller.track !== 'function' || controller.__dragGraftPatched) return false
          const original = controller.track.bind(controller)
          controller.track = (...args) => {
            try { lastTrack = { draft: args[0], caret: args[1], rev: args[3] } } catch { /* ignore */ }
            return original(...args)
          }
          controller.__dragGraftPatched = true
          console.info('[drag-graft] track hook installed')
          return true
        } catch (error) {
          console.warn('[drag-graft] track hook failed:', error)
          return false
        }
      }

      const Probe = ({ sessionId }) => {
        React.useEffect(() => {
          currentSessionId = sessionId ?? null
          if (!patchTrack(sessionId)) {
            // inputTriggers 可能晚一步就绪：短暂重试
            let tries = 0
            const timer = setInterval(() => {
              tries += 1
              if (patchTrack(sessionId) || tries > 20) clearInterval(timer)
            }, 250)
            return () => clearInterval(timer)
          }
          return undefined
        }, [sessionId])
        return h('span', {
          ref: (el) => { composerAnchor = el ?? null },
          'aria-hidden': true,
          style: { display: 'none' },
        })
      }
      const registerProbe = (slotName) => {
        try {
          disposers.push(ctx.slots.inject(slotName, () => ctx.slots.register({
            name: slotName, id: 'drag-graft-probe', order: 10,
          }, Probe)))
          console.info('[drag-graft] probe mounted on', slotName)
          return true
        } catch (error) {
          console.warn(`[drag-graft] slot ${slotName} 注册失败：`, error)
          return false
        }
      }
      if (!registerProbe('conversation.input.overlay')) registerProbe('conversation.composer.dock')

      const dispose = () => {
        for (const stop of disposers.splice(0)) {
          try { stop() } catch { /* ignore */ }
        }
        for (const timer of timers) clearTimeout(timer)
        timers.clear()
      }
      ctx.effect?.(() => () => {
        dispose()
        applied = false
      }, 'drag-graft: listeners')

      // 调试钩子（CDP 用）：暴露内部状态与插入函数，方便定位 launcher 失败原因。
      try {
        window.__dragGraft = {
          state: () => ({
            currentSessionId,
            hasInputTriggers: Boolean(inputTriggers),
            hasScope: Boolean(sessions.scope?.(currentSessionId)),
            lastTrack,
            sessionsCount: (sessionStore().ids ?? []).length,
          }),
          controller: () => {
            const scope = sessions.scope?.(currentSessionId)
            if (!scope || !inputTriggers?.sessionOf) return null
            const c = inputTriggers.sessionOf(scope)
            return {
              keys: Object.keys(c ?? {}),
              hasToggleSource: typeof c?.toggleSource === 'function',
              hasPick: typeof c?.pick === 'function',
              menu: (() => { try { const s = c?.menu?.getSnapshot?.(); return s?.state ?? s ?? null } catch (e) { return String(e) } })(),
            }
          },
          insert: (id, title) => insertChipByRevs(id, title),
          insertLegacy: (id, title) => insertChipViaLauncher(id, title),
          send: (id, title) => dropReference(id, title),
          // 分步调试：打开 reference 菜单（不拾取）。spanMode: 'zero' | 'none' | 数字(draftRev)
          open: async (spanMode = 'zero', query = '', caret = 0) => {
            const scope = sessions.scope?.(currentSessionId)
            if (!scope) return { error: 'no scope' }
            const c = inputTriggers.sessionOf(scope)
            if (!c?.toggleSource) return { error: 'no toggleSource' }
            let span
            if (spanMode === 'none') span = undefined
            else if (typeof spanMode === 'number') span = { start: caret, end: caret, draftRev: spanMode }
            else span = { start: caret, end: caret }
            const hit = { trigger: '@', query, quoted: false, position: 'leading', ...(span === undefined ? {} : { span }) }
            try { c.toggleSource('reference', hit) } catch (error) { return { error: String(error?.message ?? error) } }
            await new Promise((resolve) => setTimeout(resolve, 500))
            let st = null
            try { const snap = c.menu.getSnapshot?.(); st = snap?.state ?? snap } catch (error) { return { error: String(error) } }
            return {
              open: st?.open ?? null,
              hit: c.hit ?? null,
              depsKeys: Object.keys(c.deps ?? {}),
              groups: (st?.groups ?? []).map((g) => ({
                source: g.source, status: g.status,
                items: (g.items ?? []).map((i) => i.label ?? i.name).slice(0, 6),
              })),
            }
          },
          // 分步调试：拾取当前菜单里的第 index 条
          pick: async (index = 0) => {
            const scope = sessions.scope?.(currentSessionId)
            if (!scope) return { error: 'no scope' }
            const c = inputTriggers.sessionOf(scope)
            const before = document.querySelector('[data-composer-input]')?.textContent ?? ''
            try { c.pick('reference', index) } catch (error) { return { error: String(error?.message ?? error), before } }
            await new Promise((resolve) => setTimeout(resolve, 400))
            return { before, after: document.querySelector('[data-composer-input]')?.textContent ?? '' }
          },
        }
      } catch (error) { console.warn('[drag-graft] debug hook failed:', error) }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
