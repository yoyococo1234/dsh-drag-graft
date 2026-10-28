// 行为测试：拖拽引用插件的三条硬约束
//   1) 绝不产生「自引用」（宿主硬拒绝：cannot reference itself）
//   2) 绝不盲选错会话（候选匹配不到就不动草稿）
//   3) 连续拖多个对话都能落成 chip，且上限跟着宿主走（默认 3，宿主被改过就放宽）
//
// 用最小 DOM/React/宿主桩把 client.js 真跑起来。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'client.js')

const SELF = 'session-11111111-2222-3333-4444-555555555555'
const OTHER = 'session-99999999-8888-7777-6666-555555555555'
const THIRD = 'session-77777777-6666-5555-4444-333333333333'
let bootCounter = 0

/** 真实宿主的候选形状：{ name, value: JSON.stringify({ kind, mention, label }) }。 */
const hostItem = (sessionId, label) => ({
  name: label,
  value: JSON.stringify({
    kind: 'session',
    mention: `@[${label}](dsh-session:${Buffer.from(JSON.stringify(sessionId), 'utf8').toString('base64url')})`,
    label,
  }),
})

function buildHarness (options = {}) {
  const hostMax = options.hostMax ?? 3
  const items = options.items ?? [{ label: '别的对话', id: OTHER }, { label: '本对话标题', id: SELF }]
  const toasts = []
  const pickCalls = []
  const promptCalls = []
  const spans = []
  const rpcCalls = []
  const listeners = new Map()
  let probeComponent = null
  let rev = 0

  // 假的可编辑输入框：textContent 会随 pick 变长（模拟 chip 落进草稿）
  const editor = {
    tagName: 'DIV',
    textContent: '',
    offsetParent: {},
    getClientRects: () => [{}],
    focus: () => {},
    dispatchEvent: () => {},
    querySelectorAll: () => [],
    parentElement: null,
  }

  const controller = {
    toggleSource: (_source, hit) => { spans.push(hit.span) },
    dismiss: () => {},
    pick: (source, index) => {
      pickCalls.push({ source, index })
      // 模拟官方插入：草稿变化 + rev 递增
      const item = controller.menu.getSnapshot().state.groups[0].items[index]
      const label = item?.label ?? item?.name ?? ''
      editor.textContent += `[${label}]`
      rev += 1
    },
    menu: {
      getSnapshot: () => ({
        state: {
          open: true,
          groups: [{
            source: 'reference',
            status: 'ready',
            // 同时包含「别的对话」和「当前对话自己」，后者必须被跳过
            items,
          }],
        },
      }),
    },
  }

  const byId = {
    [SELF]: { id: SELF, title: '本对话标题', displayTitle: '本对话标题' },
    [OTHER]: { id: OTHER, title: '别的对话', displayTitle: '别的对话' },
  }

  const inputActions = {
    captureInsertion: () => ({ start: editor.textContent.length, end: editor.textContent.length, draftRev: rev }),
  }

  const ctx = {
    sessions: {
      list: { getSnapshot: () => ({ byId, ids: Object.keys(byId) }) },
      scope: (id) => ({ id }),
      binding: () => ({
        session: {
          prompt: async (content) => { promptCalls.push(content); return { ok: true } },
        },
      }),
    },
    inject: (names, cb) => cb({ inputTriggers: { sessionOf: () => controller } }),
    connection: {
      rpc: {
        call: async (channel, endpoint, payload) => {
          rpcCalls.push({ channel, endpoint, payload })
          if (endpoint === 'draggraft.limits') {
            return { ok: true, value: { maxReferences: hostMax, candidateLimit: 200, patched: hostMax > 3, source: 'test' } }
          }
          return { ok: false, error: { code: 'bad-request', message: 'unknown endpoint' } }
        },
      },
    },
    slots: {
      inject: (name, cb) => cb(),
      register: (config, Component) => {
        if (config.id === 'drag-graft-probe') probeComponent = Component
        return () => {}
      },
    },
    effect: () => {},
    get: () => null,
  }

  const documentStub = {
    addEventListener: (type, handler) => {
      if (!listeners.has(type)) listeners.set(type, [])
      listeners.get(type).push(handler)
    },
    removeEventListener: () => {},
    createElement: () => ({ style: {}, textContent: '', setAttribute: () => {}, remove: () => {}, appendChild: () => {} }),
    body: { appendChild: (el) => toasts.push(el.textContent) },
    querySelectorAll: () => [editor],
    querySelector: () => editor,
    execCommand: () => true,
    getSelection: () => ({ removeAllRanges: () => {}, addRange: () => {} }),
    createRange: () => ({ selectNodeContents: () => {}, collapse: () => {} }),
  }

  const ReactStub = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useEffect: (fn) => { fn() },
  }

  return {
    ctx, ReactStub, controller, byId, toasts, pickCalls, promptCalls, spans, rpcCalls, listeners, documentStub,
    editor, inputActions, hostMax, getProbe: () => probeComponent,
  }
}

async function boot (options = {}) {
  const harness = buildHarness(options)
  let captured = null

  globalThis.window = { __ModuleLoader__: { load: (cfg) => { captured = cfg } } }
  globalThis.document = harness.documentStub
  globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64')
  globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary')
  globalThis.TextEncoder = TextEncoder
  globalThis.DataTransfer = class { constructor () { this.map = new Map() } setData (k, v) { this.map.set(k, v) } getData (k) { return this.map.get(k) ?? '' } }
  globalThis.ClipboardEvent = class { constructor (type, init) { this.type = type; Object.assign(this, init) } }

  bootCounter += 1
  await import(`${pathToFileURL(clientPath).href}?boot=${bootCounter}`)

  assert.ok(captured, 'client.js 必须向 __ModuleLoader__ 注册工厂')
  assert.equal(captured.id, 'dsh-drag-graft')

  const mod = captured.factory(() => harness.ReactStub)
  assert.equal(typeof mod.apply, 'function', 'client half 必须导出 apply')
  mod.apply(harness.ctx)

  const Probe = harness.getProbe()
  assert.ok(Probe, '探针组件应已注册到 conversation.input.overlay')
  // 真实宿主会把 inputActions / useInput 作为标准 prop 发给插槽组件
  harness.renderProbe = (occurrences = []) => Probe({
    sessionId: SELF,
    inputActions: harness.inputActions,
    useInput: (selector) => selector({ occurrences }),
  })
  harness.renderProbe()

  // 等宿主上限落地（apply 里是异步拉的）
  await globalThis.window.__dragGraft.refreshLimits()

  return { ...harness, mod }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))
const waitFor = async (predicate, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return predicate()
}

const dropEvent = (id) => {
  const dataTransfer = { types: ['text/plain'], getData: () => id }
  const target = { getAttribute: () => null, parentElement: null }
  return { dataTransfer, target, preventDefault: () => {}, stopPropagation: () => {} }
}

test('上限从宿主读：原版宿主报 3', async () => {
  const h = await boot()
  const state = globalThis.window.__dragGraft.state()
  assert.equal(state.maxReferences, 3, '原版宿主应读到 3')
  assert.ok(h.rpcCalls.some((c) => c.endpoint === 'draggraft.limits'), '应调用过 draggraft.limits')
})

test('拖当前对话自己：只提示，不插 chip、不发消息', async () => {
  const h = await boot()
  const dragStart = h.listeners.get('dragstart')?.[0]
  const drop = h.listeners.get('drop')?.[0]
  assert.ok(dragStart && drop, 'dragstart / drop 监听应已注册')

  const event = dropEvent(SELF)
  dragStart(event)
  drop(event)
  await flush()

  assert.equal(h.pickCalls.length, 0, '不得 pick 任何候选')
  assert.equal(h.promptCalls.length, 0, '不得直接发送自引用消息')
  assert.ok(h.toasts.some((t) => String(t).includes('不能引用自己')), '应给出自引用提示')
})

test('候选里没有目标会话：不 pick，不做盲选兜底', async () => {
  const h = await boot()
  const insert = globalThis.window.__dragGraft?.insert
  assert.equal(typeof insert, 'function', '调试钩子 insert 应可用')

  const startedAt = Date.now()
  // THIRD 根本不在候选里，标题也不像任何一条：绝不能顺手拿第一条
  const ok = await insert(THIRD, '根本不存在的对话')
  await flush()

  assert.equal(ok, false, '匹配不到应返回 false')
  assert.equal(h.pickCalls.length, 0, '匹配不到时绝不能 pick 第一条')
  assert.ok(Date.now() - startedAt < 3000, '匹配不到应快速放弃')
})

test('标题对不上但 id 命中：按 id 插（标题可能刚被改过）', async () => {
  const h = await boot({ hostMax: 100 })
  const insert = globalThis.window.__dragGraft?.insert

  const ok = await insert(OTHER, '这个标题已经不在了')

  assert.equal(ok, true, 'id 命中时不该被过期标题挡住')
  assert.equal(h.pickCalls[0].index, 0)
})

test('直发兜底 dropReference 也拦自引用', async () => {
  const h = await boot()
  const send = globalThis.window.__dragGraft?.send
  assert.equal(typeof send, 'function', '调试钩子 send 应可用')

  await send(SELF, '本对话标题')
  await flush()

  assert.equal(h.promptCalls.length, 0, '不得把自引用消息投递给宿主')
  assert.ok(h.toasts.some((t) => String(t).includes('不能引用自己')), '应给出自引用提示')
})

test('连续拖两个对话都能插入 chip（rev 用 captureInsertion 现取，不猜）', async () => {
  const h = await boot({ hostMax: 100 })
  const insert = globalThis.window.__dragGraft?.insert

  const first = await insert(OTHER, '别的对话')
  const afterFirst = h.editor.textContent
  const second = await insert(OTHER, '别的对话')

  assert.equal(first, true, '第一个 chip 应插入成功')
  assert.equal(second, true, '第二个 chip 也应插入成功（不能只允许一个）')
  assert.equal(h.pickCalls.length, 2, '两次都应走到 pick')
  assert.equal(h.editor.textContent, `${afterFirst}[别的对话]`, '两次插入都应追加进草稿')

  const revs = h.spans.map((s) => s.draftRev)
  assert.deepEqual(revs, [0, 1], `span 的 draftRev 必须逐次递增，实际 ${JSON.stringify(revs)}`)
  assert.equal(h.spans[1].start, afterFirst.length, '第二次 span 必须落在当前草稿末尾（detect 坐标）')
})

test('原版宿主：草稿已有 3 个会话引用时，拖第 4 个直接拦下', async () => {
  const h = await boot({ hostMax: 3 })
  const dragStart = h.listeners.get('dragstart')?.[0]
  const drop = h.listeners.get('drop')?.[0]

  h.renderProbe([{ appearance: 'session' }, { appearance: 'session' }, { appearance: 'session' }])
  assert.equal(globalThis.window.__dragGraft.refCount(), 3, 'refCount 应读到 3')

  const event = dropEvent(OTHER)
  dragStart(event)
  drop(event)
  await flush()

  assert.equal(h.spans.length, 0, '不该再去打开候选菜单')
  assert.equal(h.pickCalls.length, 0, '不该再插第 4 个 chip')
  assert.equal(h.promptCalls.length, 0, '也不该退化成发一条注定被拒的消息')
  assert.ok(h.toasts.some((t) => String(t).includes('最多 3 个')), '应提示宿主上限')
})

test('宿主被放宽到 100 时，已有 4 个也照常能插第 5 个', async () => {
  const h = await boot({ hostMax: 100 })
  const dragStart = h.listeners.get('dragstart')?.[0]
  const drop = h.listeners.get('drop')?.[0]

  h.renderProbe([{ appearance: 'session' }, { appearance: 'session' }, { appearance: 'session' }, { appearance: 'session' }])
  assert.equal(globalThis.window.__dragGraft.refCount(), 4)

  const event = dropEvent(OTHER)
  dragStart(event)
  drop(event)
  await waitFor(() => h.pickCalls.length > 0)

  assert.equal(h.pickCalls.length, 1, '第 5 个应该正常插入')
  assert.ok(!h.toasts.some((t) => String(t).includes('最多')), '不该弹上限提示')
})

test('文件引用不占会话引用配额', async () => {
  const h = await boot({ hostMax: 3 })
  const dragStart = h.listeners.get('dragstart')?.[0]
  const drop = h.listeners.get('drop')?.[0]

  // 3 个文件引用 + 0 个会话引用：不该拦
  h.renderProbe([{ appearance: 'file' }, { appearance: 'file' }, { appearance: 'file' }])
  assert.equal(globalThis.window.__dragGraft.refCount(), 0, '文件引用不该计入会话配额')

  const event = dropEvent(OTHER)
  dragStart(event)
  drop(event)
  await waitFor(() => h.pickCalls.length > 0)

  assert.equal(h.pickCalls.length, 1, '应当正常插入会话引用')
})

// ── 候选身份：按 session id 命中，而不是靠标题猜 ─────────────────────────────
// 真实宿主的候选是 { name, value: JSON.stringify({ kind, mention, label }) }，
// 标题会重名、会为空、可能和文件名撞，只有 mention 里的 id 是唯一可信的身份。

test('两个会话同名：按 id 命中被拖的那个，不靠标题猜', async () => {
  const h = await boot({ hostMax: 100, items: [hostItem(OTHER, '同名对话'), hostItem(THIRD, '同名对话')] })
  const insert = globalThis.window.__dragGraft?.insert

  const ok = await insert(THIRD, '同名对话')

  assert.equal(ok, true, '有 id 信息时应能插入')
  assert.equal(h.pickCalls.length, 1)
  assert.equal(h.pickCalls[0].index, 1, '必须选中 id 匹配的那一条（index 1），而不是第一条')
})

test('标题为空且只有一个候选：不盲选，交回兜底', async () => {
  const h = await boot({ hostMax: 100, items: [hostItem(OTHER, '别的对话')] })
  const insert = globalThis.window.__dragGraft?.insert

  // 被拖的会话（THIRD）根本不在候选里，标题又为空——不能顺手把唯一候选塞进草稿
  const ok = await insert(THIRD, '')

  assert.equal(ok, false, '标题为空且 id 不匹配时必须放弃')
  assert.equal(h.pickCalls.length, 0, '绝不能盲选唯一候选')
})

test('候选里混着同名文件：只认会话候选，不插文件引用', async () => {
  const h = await boot({
    hostMax: 100,
    items: [
      { name: '设计稿', value: JSON.stringify({ kind: 'file', mention: '@assets/设计稿.png', label: '设计稿' }) },
      hostItem(OTHER, '设计稿'),
    ],
  })
  const insert = globalThis.window.__dragGraft?.insert

  const ok = await insert(OTHER, '设计稿')

  assert.equal(ok, true)
  assert.equal(h.pickCalls.length, 1)
  assert.equal(h.pickCalls[0].index, 1, '文件候选必须被跳过，选会话那条')
})

test('真实候选形状下，当前会话自己按 id 被跳过', async () => {
  const h = await boot({ hostMax: 100, items: [hostItem(SELF, '同名标题'), hostItem(OTHER, '同名标题')] })
  const insert = globalThis.window.__dragGraft?.insert

  const ok = await insert(OTHER, '同名标题')

  assert.equal(ok, true)
  assert.equal(h.pickCalls[0].index, 1, '自己的候选（index 0）必须被跳过')
})

test('occurrences 里的空值不计入会话引用配额', async () => {
  const h = await boot({ hostMax: 3 })

  h.renderProbe([null, undefined, 'dsh-session:abc', { appearance: 'file' }, { appearance: 'session' }])

  assert.equal(globalThis.window.__dragGraft.refCount(), 2, '只数 dsh-session 字符串和 session 外观的两条')
})
