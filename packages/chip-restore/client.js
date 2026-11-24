/**
 * dsh-drag-graft-chip-restore — browser half.
 *
 * 解决：dsh-rewind 撤回消息后用 setDraft(纯文本) 回填，消息里的会话引用
 *     @[标题](dsh-session:<base64>) 变成灰底纯文本，不再是蓝色 chip。
 *
 * 本插件不碰 rewind：它只监听输入框，发现这种 token 就原地换成真引用 chip。
 * 插入通道与 dsh-drag-graft 完全一致（宿主 conversation.input.for(scope).insertReference）。
 *
 * 失败安全：拿不到任何宿主 API、或任一步异常，一律静默退出、绝不改写用户草稿。
 */
window.__ModuleLoader__.load({
  id: 'dsh-drag-graft-chip-restore',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    // 纯逻辑：与 lib/token.mjs 同源，内联于此（client 是独立 bundle，不能 import 包内文件）。
    const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    function decodeSessionUri(raw) {
      try {
        const text = String(raw ?? '')
        const at = text.indexOf('dsh-session:')
        if (at < 0) return null
        let payload = text.slice(at + 'dsh-session:'.length)
        const stop = payload.search(/[)\s"'<>]/)
        if (stop >= 0) payload = payload.slice(0, stop)
        if (!/^[A-Za-z0-9_-]+$/.test(payload)) return null
        const base64 = payload.replace(/-/g, '+').replace(/_/g, '/')
        const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
        let binary = ''
        for (let i = 0; i < padded.length; i += 4) {
          const a = B64.indexOf(padded[i]); const b = B64.indexOf(padded[i + 1])
          const c = padded[i + 2] === '=' ? -1 : B64.indexOf(padded[i + 2])
          const d = padded[i + 3] === '=' ? -1 : B64.indexOf(padded[i + 3])
          if (a < 0 || b < 0) return null
          binary += String.fromCharCode((a << 2) | (b >> 4))
          if (c >= 0) binary += String.fromCharCode(((b & 15) << 4) | (c >> 2))
          if (d >= 0) binary += String.fromCharCode(((c & 3) << 6) | d)
        }
        const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0))
        const parsed = JSON.parse(new TextDecoder().decode(bytes))
        return typeof parsed === 'string' && parsed ? parsed : null
      } catch { return null }
    }
    const TOKEN_RE = '@\\[((?:[^\\]\\\\]|\\\\.)*)\\]\\((dsh-session:[A-Za-z0-9_-]+)\\)'
    function findTokens(text) {
      const out = []
      const re = new RegExp(TOKEN_RE, 'g')
      let m
      while ((m = re.exec(String(text ?? ''))) !== null) {
        const sessionId = decodeSessionUri(m[2])
        if (!sessionId) continue
        out.push({
          start: m.index,
          end: m.index + m[0].length,
          raw: m[0],
          title: String(m[1] ?? '').replace(/\\([\\\]])/g, '$1'),
          sessionId,
        })
      }
      return out
    }
    function referenceOf(token) {
      const uri = token.raw.slice(token.raw.indexOf('(dsh-session:') + 1, -1)
      return {
        source: 'reference',
        ref: uri,
        label: token.title || token.sessionId,
        appearance: 'session',
        clipboardText: token.raw,
      }
    }
    function planRestore(text, selfId) {
      const original = String(text ?? '')
      const tokens = findTokens(original)
      if (!tokens.length) return { changed: false, text: original, insertions: [] }
      let cursor = 0
      let cleaned = ''
      const insertions = []
      for (const token of tokens) {
        cleaned += original.slice(cursor, token.start)
        const offset = cleaned.length
        cursor = token.end
        if (selfId && token.sessionId === selfId) { cleaned += token.raw; continue }
        insertions.push({ offset, ref: referenceOf(token) })
      }
      cleaned += original.slice(cursor)
      return { changed: insertions.length > 0, text: insertions.length ? cleaned : original, insertions }
    }

    const inject = ['slots', 'sessions']

    function apply(ctx) {
      let conversationRef = null
      let currentSessionId = null
      let composerAnchor = null
      const disposers = []
      let timer = null
      let busy = false
      let lastHandled = '' // 防自激：已处理过的文本不再处理

      // 与 drag-graft 相同的服务注入方式
      try {
        disposers.push(ctx.inject(['conversation'], (scope) => {
          conversationRef = scope.conversation
          return () => { conversationRef = null }
        }))
      } catch { /* 拿不到就静默失效 */ }

      const findEditor = () => {
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

      const scope = () => {
        try { return ctx.sessions?.scope?.(currentSessionId) } catch { return null }
      }

      const tryRestore = async () => {
        if (busy) return
        const editor = findEditor()
        if (!editor) return
        const text = editor.textContent || ''
        if (!text.includes('dsh-session:')) return
        if (text === lastHandled) return
        const plan = planRestore(text, currentSessionId)
        if (!plan.changed) return

        const sc = scope()
        const input = conversationRef?.input?.for?.(sc)
        if (!input?.setDraft || !input?.insertReference) return // 通道不全，绝不改写

        busy = true
        lastHandled = plan.text
        try {
          // 1) 先把 token 文本去掉
          input.setDraft(plan.text)
          await new Promise((r) => setTimeout(r, 60))
          // 2) 从后往前插 chip，避免前面的插入让后面的 offset 漂移。
          // span 用宿主 captureInsertion() 的原生值（含真实 draftRev，CAS 才过得去）；
          // 拿不到时退回按 offset 构造的 span（draftRev 从 input 状态猜，可能失败——失败安全，不破坏草稿）。
          const sorted = [...plan.insertions].sort((a, b) => b.offset - a.offset)
          for (const ins of sorted) {
            let span = null
            try { span = input.captureInsertion?.() ?? null } catch { span = null }
            if (!span || !Number.isFinite(span?.draftRev)) {
              span = { start: ins.offset, end: ins.offset, draftRev: 0 }
            }
            const applied = input.insertReference(ins.ref, span)
            if (!applied) {
              console.warn('[chip-restore] insertReference 拒绝了 span（CAS 未命中），保留纯文本草稿')
              break
            }
            await new Promise((r) => setTimeout(r, 60))
          }
          console.info('[chip-restore] restored', plan.insertions.length, 'chip(s)')
        } catch (error) {
          console.warn('[chip-restore] restore failed (draft left as-is):', error?.message ?? error)
        } finally {
          busy = false
        }
      }

      const schedule = () => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => { timer = null; void tryRestore() }, 350)
      }

      // 挂一个隐形探针到输入框所在 slot，只为拿到 sessionId
      const Probe = (props) => {
        React.useEffect(() => {
          currentSessionId = props.sessionId ?? null
        }, [props.sessionId])
        return h('span', {
          ref: (el) => { composerAnchor = el ?? null },
          'aria-hidden': true,
          style: { display: 'none' },
        })
      }
      try {
        let mounted = false
        for (const slotName of ['conversation.input.overlay', 'conversation.composer.dock']) {
          try {
            disposers.push(ctx.slots.inject(slotName, () => ctx.slots.register({
              name: slotName, id: 'chip-restore-probe', order: 11,
            }, Probe)))
            mounted = true
            break
          } catch { /* 试下一个 slot */ }
        }
        if (!mounted) console.warn('[chip-restore] 探针挂载失败，功能不可用')
      } catch (error) {
        console.warn('[chip-restore] slot 注入失败：', error?.message ?? error)
      }

      // 监听输入框变化（rewind 回填是 DOM 变更，没有专门事件）
      let observer = null
      try {
        observer = new MutationObserver(() => {
          const editor = findEditor()
          if (!editor) return
          const text = editor.textContent || ''
          if (text.includes('dsh-session:')) schedule()
        })
        observer.observe(document.body, { childList: true, characterData: true, subtree: true })
      } catch (error) {
        console.warn('[chip-restore] MutationObserver 失败：', error?.message ?? error)
      }

      ctx.effect?.(() => () => {
        for (const stop of disposers.splice(0)) { try { stop() } catch { /* ignore */ } }
        if (timer) clearTimeout(timer)
        try { observer?.disconnect() } catch { /* ignore */ }
      }, 'chip-restore: watcher')

      // 调试钩子
      try {
        window.__chipRestore = {
          version: '1.0.0',
          state: () => ({ session: currentSessionId, hasConversation: Boolean(conversationRef), lastHandled }),
          restoreNow: () => tryRestore(),
        }
      } catch { /* ignore */ }
    }

    return { inject, apply }
  },
})
