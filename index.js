/**
 * @local/drag-graft — Host half（只读）
 *
 * 职责两件：
 *   1) 把「任意一个会话」的日志渲染成一段可嫁接的 transcript 文本（旧通道，只读）；
 *   2) 告诉浏览器半区：宿主这条消息最多收几个会话引用（MAX_REFERENCES）。
 *
 * 本半区**不写任何东西**：不建会话、不改文件、不发消息。
 * 建会话 / 投消息都由 Browser half 走官方 sessions 服务完成。
 *
 * RPC channel: /drag-graft
 *   draggraft.ping        {}                       -> { ok, version, sessionController, limits }
 *   draggraft.limits      {}                       -> { ok, maxReferences, candidateLimit, patched, source }
 *   draggraft.transcript  { source, maxChars?, maxBlockChars? }
 *     -> { sessionId, title, cwd, transcript, events, turns, range, truncated }
 */

export const name = 'dsh-drag-graft'
export const CHANNEL = '/drag-graft'
export const PLUGIN_VERSION = '2.1.0'

/** 只需要官方 Session 控制器；不注入未文档化的服务名。 */
export const inject = ['sessionController']

const freshSignal = () => new AbortController().signal

const DEFAULT_MAX_CHARS = 60000
const DEFAULT_MAX_BLOCK = 4000
const MAX_EVENTS = 4000

// ── RPC 信封（与 dsh rpcErrorSchema 兼容）───────────────────────────────────
const ok = (value) => ({ ok: true, value })
const fail = (code, message, details = {}) => ({
  ok: false,
  error: { code, message, details: { issues: [{ message }], ...details } },
})

// ── transcript 渲染（与 dsh-graft 的事件语义保持一致）────────────────────────
const textBlocks = (blocks) => (Array.isArray(blocks) ? blocks : [])
  .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
  .map((b) => b.text)
  .join('\n')
  .trim()

const clampBlock = (text, maxBlockChars) =>
  text.length > maxBlockChars ? `${text.slice(0, maxBlockChars)}\n…[本条截断]` : text

/**
 * 只保留真正的往来之所以重要：宿主注入的运行时上下文、system-reminder、
 * 工具调用/结果都**不进** transcript，否则会把目标会话的上下文挤爆。
 */
const renderEvent = (event, maxBlockChars) => {
  if (event?.type === 'user/message') {
    if (event.data?.source?.kind !== 'user') return null
    const text = clampBlock(
      textBlocks(event.data.content).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim(),
      maxBlockChars,
    )
    return text ? `#${event.seq} [user]\n${text}` : null
  }
  if (event?.type === 'assistant/message') {
    const text = clampBlock(textBlocks(event.data?.message?.content), maxBlockChars)
    return text ? `#${event.seq} [assistant]\n${text}` : null
  }
  return null
}

const listSummaries = async (sessionController) => {
  const { items } = await sessionController.list({}, freshSignal())
  return (items ?? []).map((s) => ({
    sessionId: s.sessionId,
    cwd: s.cwd ?? '',
    title: s.projections?.values?.title ?? '',
    blank: Boolean(s.blank),
    running: Boolean(s.running),
    updatedAt: s.updatedAt,
  }))
}

/** 侧栏拖拽给出的是完整 id；这里仍接受无歧义前缀，便于手工调试。 */
const resolveSession = async (sessionController, idOrPrefix) => {
  const items = await listSummaries(sessionController)
  const exact = items.find((s) => s.sessionId === idOrPrefix)
  if (exact) return exact
  const normalized = idOrPrefix.startsWith('session-') || idOrPrefix.startsWith('import-') || idOrPrefix.startsWith('od-')
    ? idOrPrefix
    : `session-${idOrPrefix}`
  const hits = items.filter((s) => s.sessionId.startsWith(normalized))
  if (hits.length === 1) return hits[0]
  if (hits.length > 1) throw Object.assign(new Error(`会话 id 前缀有歧义：${idOrPrefix}`), { code: 'bad-request' })
  throw Object.assign(new Error(`未知会话：${idOrPrefix}`), { code: 'not-found' })
}

const buildTranscript = async (sessionController, sessionId, { maxChars, maxBlockChars }) => {
  const inspection = await sessionController.inspect(sessionId, freshSignal())
  const events = (inspection.events ?? [])
    .filter((event) => typeof event?.seq === 'number')
    .slice(-MAX_EVENTS)
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))

  const lines = []
  const seqs = []
  let turns = 0
  let chars = 0
  let truncated = false
  for (const event of events) {
    if (event.type === 'turn/end') turns += 1
    const line = renderEvent(event, maxBlockChars)
    if (line === null) continue
    if (chars + line.length > maxChars) {
      truncated = true
      break
    }
    chars += line.length + 2
    lines.push(line)
    seqs.push(event.seq)
  }
  const range = seqs.length ? `seq ${seqs[0]}..${seqs[seqs.length - 1]}` : ''
  return {
    transcript: truncated
      ? `${lines.join('\n\n')}\n\n…[已按 ${maxChars} 字符上限截断，后续轮次未包含]`
      : lines.join('\n\n'),
    messages: lines.length,
    turns,
    range,
    truncated,
    totalEvents: events.length,
  }
}

// ── dispatch ────────────────────────────────────────────────────────────────
const makeDispatch = (ctx, logger, readLimits) => async (endpoint, payload = {}) => {
  try {
    if (endpoint === 'draggraft.ping') {
      return ok({
        version: PLUGIN_VERSION,
        sessionController: typeof ctx.sessionController?.inspect === 'function',
        limits: readLimits(),
      })
    }
    if (endpoint === 'draggraft.limits') {
      return ok(readLimits())
    }
    if (endpoint === 'draggraft.transcript') {
      const source = String(payload?.source ?? '').trim()
      if (!source) return fail('bad-request', '缺少 source 会话 id')
      const maxChars = Math.max(2000, Math.min(400000, Number(payload?.maxChars ?? DEFAULT_MAX_CHARS) || DEFAULT_MAX_CHARS))
      const maxBlockChars = Math.max(200, Math.min(20000, Number(payload?.maxBlockChars ?? DEFAULT_MAX_BLOCK) || DEFAULT_MAX_BLOCK))

      const resolved = await resolveSession(ctx.sessionController, source)
      const built = await buildTranscript(ctx.sessionController, resolved.sessionId, { maxChars, maxBlockChars })
      if (!built.messages) {
        return fail('empty', `会话 ${resolved.sessionId} 没有可嫁接的文本往来（可能只有工具活动）`)
      }
      return ok({ ...resolved, ...built })
    }
    return fail('bad-request', `未知 endpoint '${endpoint}'`)
  } catch (error) {
    const code = error?.code === 'not-found' || error?.code === 'bad-request' ? error.code : 'internal'
    if (code === 'internal') logger?.warn?.(`[drag-graft] ${endpoint} failed: ${error?.message ?? error}`)
    return fail(code, error?.message ?? String(error))
  }
}

/**
 * Fail-soft entry: a throwing apply() marks the entry as "did not activate", which
 * blocks the whole web boot. Every failure inside must stay contained here.
 */
export function apply(ctx) {
  try {
    return applyInner(ctx)
  } catch (error) {
    try { (ctx.logger ?? console).error('[drag-graft] host apply failed; plugin stays inert:', error) } catch { /* ignore */ }
    return () => {}
  }
}

function applyInner(ctx) {
  const logger = ctx.logger ?? console

  // 宿主对「一条消息最多几个会话引用」的硬限制就藏在 sessionReferenceResolver 的
  // config 里（原版 MAX_REFERENCES = 3）。浏览器半区靠它决定什么时候拦用户。
  // 该服务是可选的：拿不到就按原版 3 处理，绝不因为缺它而让插件不激活。
  let resolverRef = null
  const readLimits = () => {
    let config = resolverRef?.config ?? null
    if (!config) {
      try { config = ctx.get?.('sessionReferenceResolver')?.config ?? null } catch { config = null }
    }
    const max = Number(config?.maxReferences)
    const candidate = Number(config?.candidateLimit)
    const maxReferences = Number.isFinite(max) && max > 0 ? max : 3
    return {
      maxReferences,
      candidateLimit: Number.isFinite(candidate) && candidate > 0 ? candidate : 50,
      patched: maxReferences > 3,
      source: config ? 'sessionReferenceResolver' : 'default',
    }
  }
  try {
    ctx.inject?.(['sessionReferenceResolver'], (scoped) => {
      resolverRef = scoped.sessionReferenceResolver
      return () => { resolverRef = null }
    })
  } catch (error) {
    logger?.warn?.(`[drag-graft] sessionReferenceResolver 注入失败，按默认上限 3 处理：${error?.message ?? error}`)
  }

  const dispatch = makeDispatch(ctx, logger, readLimits)

  const mount = (owner) => {
    const connection = owner?.connection
    if (!connection?.rpc?.handle) {
      logger?.warn?.('[drag-graft] connection.rpc 不可用：Browser half 的拖拽会读不到会话记录')
      return
    }
    // DSH 0.1.5+ 的 rpc getter 保留 Connection 服务自身的 context；重新绑定到被
    // 注入的 web context，rpc.handle() 才能注册到 webServer 上（同 workspace-mover）。
    const rawConnection = connection[Symbol.for('cordis.original')] ?? connection
    const scopedConnection = rawConnection?.[Symbol.for('cordis.extend')]?.({ ctx: owner }) ?? connection
    const dispose = scopedConnection.rpc.handle(CHANNEL, (endpoint, payload, signal) => (
      signal?.aborted
        ? { ok: false, error: { code: 'cancelled', message: 'cancelled', details: {} } }
        : dispatch(endpoint, payload ?? {})
    ), { authority: 'loopback' })
    owner.effect?.(() => () => {
      try { dispose?.() } catch { /* 卸载期忽略 */ }
    }, 'drag-graft: rpc dispose')
  }

  if (typeof ctx.inject === 'function') {
    // 与 dsh-workspace-mover 相同的挂载姿势：rpc.handle 需要 webServer 在场才注册得上。
    ctx.inject(['connection', 'webServer'], (webCtx) => mount(webCtx))
  } else {
    mount(ctx)
  }

  // 诊断用 agent 工具：让 agent 直接验证 host 侧读取链路，不必让用户翻 F12。只读无副作用。
  const tools = (() => { try { return ctx.tools } catch { return null } })()
  if (tools?.register) {
    tools.register({
      name: 'draggraft_probe',
      description: 'Read-only probe for the drag-graft plugin: reports whether the host can list/inspect sessions and, given a session id, how many transcript messages that session would contribute. Used to diagnose drag-and-drop grafting failures.',
      parameters: {
        type: 'object',
        properties: {
          session: { type: 'string', description: 'Optional session id (or unambiguous prefix) to test transcript extraction on' },
        },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      execute: async (args) => {
        const capabilities = {
          sessionController: Boolean(ctx.sessionController),
          list: typeof ctx.sessionController?.list === 'function',
          inspect: typeof ctx.sessionController?.inspect === 'function',
          rpcChannel: CHANNEL,
          version: PLUGIN_VERSION,
        }
        const lines = [`capabilities: ${JSON.stringify(capabilities)}`]
        try {
          const all = await listSummaries(ctx.sessionController)
          lines.push(`sessions visible: ${all.length}`)
        } catch (error) {
          lines.push(`list FAILED: ${error?.message ?? error}`)
          return lines.join('\n')
        }
        const wanted = String(args?.session ?? '').trim()
        if (!wanted) return lines.join('\n')
        try {
          const resolved = await resolveSession(ctx.sessionController, wanted)
          const built = await buildTranscript(ctx.sessionController, resolved.sessionId, {
            maxChars: DEFAULT_MAX_CHARS,
            maxBlockChars: DEFAULT_MAX_BLOCK,
          })
          lines.push(`source: ${resolved.sessionId} "${resolved.title}" cwd=${resolved.cwd || '?'}`)
          lines.push(`transcript: ${built.messages} message(s), ${built.turns} turn(s), range=${built.range || '-'}, truncated=${built.truncated}, totalEvents=${built.totalEvents}`)
          lines.push(`preview: ${JSON.stringify(built.transcript.slice(0, 240))}`)
        } catch (error) {
          lines.push(`transcript FAILED: ${error?.message ?? error}`)
        }
        return lines.join('\n')
      },
    })
  } else {
    logger?.warn?.('[drag-graft] ctx.tools 不可用：诊断工具未注册（不影响拖拽）')
  }

  logger?.info?.(`[drag-graft] transcript channel ready (v${PLUGIN_VERSION})`)
  return () => { /* 通道随插件作用域销毁 */ }
}
