// @local/drag-graft — Browser half (v2.1.1)
//
// 把侧边栏的会话行拖到对话区松手 → 在输入框里插一枚**原生会话引用 chip**，
// 你可以继续打字，然后自己按发送。
//
// 原理：DSH 自带 session-reference 机制——草稿里的引用节点在提交时变成
//     @[标题](dsh-session:<base64url(JSON.stringify(sessionId))>)
// 宿主解析成结构化引用，UI 渲染成蓝标 chip，并把对方会话**压缩成有界预览**
// （默认每个 64KB，超长部分落盘留档）注入模型上下文。
// 所以本插件不搬原文、不自绘界面、不注册常驻条、不显示按钮。
//
// 唯一挂载点是一个**渲染不可见 span 的探针**（conversation.input.overlay），
// 只用它拿宿主通过插槽标准 prop 传来的东西：
//   sessionId     当前会话 id（自引用防护要用）
//   inputActions  captureInsertion() → detect 坐标 + 当前 draftRev（插入 chip 的 CAS 依据）
//   useInput      InputState.occurrences（草稿里已有几个引用）
//
// 失败才提示（底部一行字），成功静默——草稿里多出来的 chip 就是反馈。

window.__ModuleLoader__.load({
  id: 'dsh-drag-graft',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')
    const h = React.createElement

    /** 与宿主半区一致的 RPC 通道（用来读宿主的引用上限）。 */
    const CHANNEL = '/drag-graft'
    const SESSION_ID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
    const ID_PREFIX_RE = /^(?:session|sid|session-id)\s*[:#]\s*/i
    const POLL_INTERVAL = 100
    const POLL_TIMEOUT = 5000
    /** 宿主原版上限。真实值在运行时从宿主半区读，读不到就按这个保守值。 */
    const DEFAULT_MAX_REFERENCES = 3
    /** 底部提示的停留时长：普通 1.5s、报错 4.5s（比早期版本各砍一半）。 */
    const TOAST_MS = 1500
    const TOAST_ERROR_MS = 4500
    const PROBE_ID = 'drag-graft-probe'

    // connection 用来问宿主「你这条消息最多收几个引用」，读不到就按 3 处理。
    const inject = ['slots', 'sessions', 'connection']

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

    /** 草稿里的一条 occurrence 是不是「会话引用」（文件/目录引用不占宿主配额）。 */
    const isSessionOccurrence = (item) => {
      if (!item || typeof item !== 'object') return true
      const appearance = item.appearance ?? item.kind
      if (typeof appearance === 'string') return appearance === 'session'
      return String(item.ref ?? '').startsWith('dsh-session:')
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
      let inserting = false // 正在插 chip（防连拖叠加）
      let sending = false // 正在直发兜底
      let inputTriggers = null // 官方 @ 触发服务
      let inputActionsRef = null // 官方插入位点服务（captureInsertion）
      let occurrencesRef = null // InputState.occurrences：草稿里已有的引用
      let hostLimits = { maxReferences: DEFAULT_MAX_REFERENCES, candidateLimit: null, source: 'default' }

      // ── 提示 ──────────────────────────────────────────────────────────────
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
          }, isError ? TOAST_ERROR_MS : TOAST_MS)
          timers.add(timer)
        } catch (error) { console.warn('[drag-graft] toast failed:', error) }
      }

      // ── 宿主上限：跟着宿主走，不再写死 ────────────────────────────────────
      // 宿主 @deepseek-ai/dsh-session-reference 有 MAX_REFERENCES（原版 3），
      // 超了在提交时整轮拒绝：a message may reference at most N sessions。
      // 这里向宿主半区要真实值；宿主被改过（比如提到 100）就跟着放宽。
      const maxReferences = () => {
        const value = Number(hostLimits?.maxReferences)
        return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_REFERENCES
      }
      const referenceCount = () => {
        try {
          const list = Array.isArray(occurrencesRef) ? occurrencesRef : []
          return list.filter(isSessionOccurrence).length
        } catch { return 0 }
      }
      const warnTooMany = () => {
        toast(`一条消息最多 ${maxReferences()} 个会话引用（宿主上限）。再多的请分条发，或用 graft_forward 把内容当正文带进来。`, true)
      }
      const refreshLimits = async () => {
        try {
          const rpc = ctx.connection?.rpc
          if (typeof rpc?.call !== 'function') {
            console.warn('[drag-graft] connection.rpc 不可用，按默认上限', DEFAULT_MAX_REFERENCES, '处理')
            return hostLimits
          }
          const res = await rpc.call(CHANNEL, 'draggraft.limits', {})
          const value = res?.ok ? res.value : null
          const max = Number(value?.maxReferences)
          if (Number.isFinite(max) && max > 0) {
            hostLimits = { ...value, source: 'host' }
            console.info('[drag-graft] host reference limit =', max, value?.patched ? '(patched host)' : '')
          } else {
            console.warn('[drag-graft] 宿主没返回 maxReferences，按默认', DEFAULT_MAX_REFERENCES, '处理', res?.error ?? '')
          }
        } catch (error) {
          console.warn('[drag-graft] 读取宿主引用上限失败，按默认', DEFAULT_MAX_REFERENCES, '处理：', error?.message ?? error)
        }
        return hostLimits
      }

      // ── 自引用防护 ────────────────────────────────────────────────────────
      // 宿主对「消息引用了自己这个会话」是硬拒绝：session "…" cannot reference itself。
      /** 这条候选是不是当前会话自己（item 里带 session id 时才算得出）。 */
      const itemRefersToSelf = (item) => {
        if (!currentSessionId) return false
        try { return JSON.stringify(item ?? {}).includes(currentSessionId) } catch { return false }
      }

      /**
       * 在候选里按标题挑一条：先精确匹配，再允许唯一的前缀/包含匹配。
       * 自引用候选一律跳过；匹配不到或有歧义就返回 -1（**绝不盲选第一条**——
       * 第一条往往就是最近/当前会话，盲选会把错的会话塞进草稿）。
       */
      const pickIndexFor = (items, title) => {
        const list = Array.isArray(items) ? items : []
        const labelOf = (index) => String(list[index]?.label ?? list[index]?.name ?? '').trim().toLowerCase()
        const usable = []
        for (let index = 0; index < list.length; index += 1) {
          if (itemRefersToSelf(list[index])) continue
          usable.push(index)
        }
        if (!usable.length) return -1
        const wanted = String(title ?? '').trim().toLowerCase()
        if (!wanted) return usable.length === 1 ? usable[0] : -1
        const exact = usable.filter((index) => labelOf(index) === wanted)
        if (exact.length === 1) return exact[0]
        if (wanted.length >= 4) {
          const loose = usable.filter((index) => {
            const label = labelOf(index)
            return label.length >= 4 && (label.startsWith(wanted) || wanted.startsWith(label))
          })
          if (loose.length === 1) return loose[0]
        }
        return -1
      }

      let lastSelfWarnAt = 0
      const warnSelfReference = () => {
        const now = Date.now()
        if (now - lastSelfWarnAt < 1500) return
        lastSelfWarnAt = now
        toast('这是当前对话自己，不能引用自己（宿主会拒绝整轮）。请拖别的对话。', true)
      }

      // ── 官方插入位点 ──────────────────────────────────────────────────────
      // 必须用宿主给的 inputActions.captureInsertion()：它返回 **detect 坐标**里的
      // 当前位置 + 当前 draftRev，正是 insertReference 的 CAS 依据
      // （span.draftRev !== rev 就整条拒绝）。自己用 textContent 长度算坐标、
      // 再猜 rev，在草稿里已经有 chip 时必然失配——那就是「只能拖一个进去」。
      const captureSpan = () => {
        try {
          const span = inputActionsRef?.captureInsertion?.()
          if (span && Number.isFinite(span.start) && Number.isFinite(span.end) && Number.isFinite(span.draftRev)) return span
        } catch (error) { console.warn('[drag-graft] captureInsertion 失败：', error?.message ?? error) }
        return null
      }

      // ── 服务注入 ──────────────────────────────────────────────────────────
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
      void refreshLimits()

      // ── 输入框定位 ────────────────────────────────────────────────────────
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

      const resolveDropId = (event) => {
        const byId = sessionStore().byId ?? {}
        const fromTransfer = idFromTransfer(event?.dataTransfer)
        if (fromTransfer) return fromTransfer
        if (dragElement?.isConnected) return idFromElement(dragElement, byId)
        return null
      }

      /**
       * 把目标会话插成草稿里的真 chip（不发送）。
       * 每次尝试都重新 captureInsertion()：rev 随每次编辑递增，猜不得。
       */
      const insertChip = async (sourceId, title) => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
        try {
          if (!inputTriggers?.sessionOf || !currentSessionId) return false
          const scope = sessions.scope?.(currentSessionId)
          if (!scope) return false
          const controller = inputTriggers.sessionOf(scope)
          if (!controller?.toggleSource || typeof controller.pick !== 'function') {
            console.warn('[drag-graft] inputTriggers controller 形状不符')
            return false
          }

          const editor = findComposerEditor()
          const query = String(title ?? '').slice(0, 24)
          const attempts = 4
          for (let attempt = 0; attempt < attempts; attempt += 1) {
            const span = captureSpan()
            if (!span) {
              console.info('[drag-graft] 拿不到官方插入位点（captureInsertion 不可用），放弃插 chip')
              return false
            }
            const before = (findComposerEditor() ?? editor)?.textContent ?? ''
            const hit = { trigger: '@', query, quoted: false, position: 'leading', span }
            try { controller.toggleSource('reference', hit) } catch (error) {
              console.warn('[drag-graft] toggleSource 失败：', error?.message ?? error)
              return false
            }

            let index = -1
            let noMatch = false
            const deadline = Date.now() + 1500
            while (Date.now() < deadline) {
              await sleep(100)
              let state = null
              try { const snap = controller.menu.getSnapshot?.(); state = snap?.state ?? snap } catch { state = null }
              if (!state?.open) break
              const group = (state.groups ?? []).find((g) => g?.source === 'reference' && g?.status === 'ready' && (g?.items?.length ?? 0) > 0)
              if (!group) continue
              const matched = pickIndexFor(group.items, title)
              // 候选已就绪但没有目标：换一次尝试也不会变出目标，立刻放弃（交给直发兜底）
              if (matched < 0) { noMatch = true; break }
              index = matched
              break
            }
            if (noMatch) { try { controller.dismiss() } catch { /* ignore */ } ; break }
            if (index < 0) { try { controller.dismiss() } catch { /* ignore */ } ; continue }

            try { controller.pick('reference', index) } catch (error) {
              console.warn('[drag-graft] pick 失败：', error?.message ?? error)
            }
            await sleep(130)
            const after = (findComposerEditor() ?? editor)?.textContent ?? ''
            if (after !== before) {
              console.info('[drag-graft] chip inserted, draftRev =', span.draftRev, 'index =', index, 'attempt =', attempt)
              return true
            }
            try { controller.dismiss() } catch { /* ignore */ }
          }
          console.info('[drag-graft] 插 chip 未成功（span / CAS 未命中）')
          return false
        } catch (error) {
          console.warn('[drag-graft] insertChip 失败：', error)
          return false
        }
      }

      /** 兜底：直接投一条只含会话引用的消息（宿主解析成蓝标 + 有界预览）。 */
      const dropReference = async (sourceId, label) => {
        if (currentSessionId && sourceId === currentSessionId) { warnSelfReference(); return }
        try {
          const targetId = currentSessionId
          if (!targetId) throw new Error('拿不到当前会话 id，请刷新页面后再试')
          const target = await new Promise((resolve, reject) => {
            const deadline = Date.now() + POLL_TIMEOUT
            const tick = () => {
              const session = sessions.binding(targetId)?.session ?? null
              if (session) return resolve(session)
              if (Date.now() > deadline) return reject(new Error('等待当前会话绑定超时'))
              setTimeout(tick, POLL_INTERVAL)
            }
            tick()
          })
          const text = formatMention(sourceId, label)
          const result = await target.prompt([{ type: 'text', text }], 'queue')
          if (!result?.ok) throw new Error(`投递被拒绝[${result?.error?.code ?? 'unknown'}]：${result?.error?.message ?? ''}`)
          console.info('[drag-graft] referenced', sourceId, '→', targetId)
          // 投完把焦点交回输入框：立刻就能打字或按语音键。
          try { findComposerEditor()?.focus?.() } catch { /* 焦点拿不到不影响引用 */ }
        } catch (error) {
          toast(`引用对话失败：${error?.message ?? String(error)}`, true)
          console.warn('[drag-graft] reference failed:', error)
        }
      }

      // ── 拖拽拦截：只认「非文件 + 落在对话区（非侧栏行）」的投放 ────────────
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
        if (currentSessionId && id === currentSessionId) {
          warnSelfReference()
          return
        }
        if (referenceCount() >= maxReferences()) {
          warnTooMany()
          return
        }
        if (inserting || sending) return // 连拖不叠加
        const row = sessionStore().byId?.[id]
        const label = row?.displayTitle ?? row?.title ?? source.title ?? ''
        inserting = true
        void (async () => {
          try {
            // 首选：把真 chip 插进草稿（可继续打字再发送）。CAS 不匹配时官方不插入，无残留。
            if (await insertChip(id, label)) return
            // 兜底：直接发一条引用消息（对话里出现蓝标），输入框保持干净。
            sending = true
            await dropReference(id, label)
          } finally {
            inserting = false
            sending = false
          }
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

      // ── 不可见探针：接住宿主发来的 sessionId / inputActions / useInput ──────
      const Probe = (props) => {
        const { sessionId, inputActions, useInput } = props
        // InputState.occurrences = 草稿里已有的引用条目；用来在到顶时提前拦下。
        let occurrences = null
        try { occurrences = useInput ? useInput((state) => state.occurrences) : null } catch { occurrences = null }
        if (Array.isArray(occurrences)) occurrencesRef = occurrences
        React.useEffect(() => {
          currentSessionId = sessionId ?? null
          if (inputActions) inputActionsRef = inputActions
        }, [sessionId, inputActions])
        return h('span', {
          ref: (el) => { composerAnchor = el ?? null },
          'aria-hidden': true,
          style: { display: 'none' },
        })
      }
      const registerProbe = (slotName) => {
        try {
          disposers.push(ctx.slots.inject(slotName, () => ctx.slots.register({
            name: slotName, id: PROBE_ID, order: 10,
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

      // 调试钩子（F12 / CDP 用）：只读为主，定位「为什么没插进去」。
      try {
        window.__dragGraft = {
          version: '2.1.1',
          state: () => ({
            currentSessionId,
            hasInputTriggers: Boolean(inputTriggers),
            hasInputActions: Boolean(inputActionsRef),
            hasScope: Boolean(sessions.scope?.(currentSessionId)),
            limits: hostLimits,
            maxReferences: maxReferences(),
            refCount: referenceCount(),
            sessionsCount: (sessionStore().ids ?? []).length,
          }),
          limits: () => hostLimits,
          refreshLimits: () => refreshLimits(),
          span: () => captureSpan(),
          refCount: () => referenceCount(),
          insert: (id, title) => insertChip(id, title),
          send: (id, title) => dropReference(id, title),
        }
      } catch (error) { console.warn('[drag-graft] debug hook failed:', error) }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
