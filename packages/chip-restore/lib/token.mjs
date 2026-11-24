/**
 * chip-restore 的纯逻辑层（无 DOM / 无宿主依赖，可单测）。
 *
 * 背景：dsh-rewind 撤回消息后，用 setDraft(纯文本) 把消息回填进输入框。
 * 消息里的会话引用在日志中是这种 token：
 *     @[标题](dsh-session:<base64url(JSON.stringify(sessionId))>)
 * 把它当纯文本塞回输入框时宿主不认，渲染成灰底 `@标题`。
 * 本模块负责把这种 token 找出来、解码出 sessionId，并给出还原成真 chip 所需的数据。
 *
 * 编码格式与 @deepseek-ai/dsh-session-reference / dsh-drag-graft 完全一致。
 */

/** 匹配一个完整的会话引用 token（标题内允许转义的 \] ）。 */
export const TOKEN_RE = /@\[((?:[^\]\\]|\\.)*)\]\((dsh-session:[A-Za-z0-9_-]+)\)/g

/** 用纯 JS 实现 base64url 编解码，浏览器/Node 都能用（不依赖 Buffer/btoa）。 */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function decodeSessionUri(raw) {
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
    // 手写 base64 解码，避免 atob 在 Node 单测里要 polyfill
    let binary = ''
    for (let i = 0; i < padded.length; i += 4) {
      const a = B64.indexOf(padded[i])
      const b = B64.indexOf(padded[i + 1])
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
  } catch {
    return null
  }
}

/** 反转义 token 标题里的 \] 和 \\ 。 */
function unescapeLabel(label) {
  return String(label ?? '').replace(/\\([\]\\])/g, '$1')
}

/**
 * 在一段文本里找出所有合法的会话引用 token。
 * 返回 [{ start, end, raw, title, sessionId }]，按出现顺序。
 */
export function findTokens(text) {
  const out = []
  const re = new RegExp(TOKEN_RE.source, 'g')
  let m
  while ((m = re.exec(String(text ?? ''))) !== null) {
    const sessionId = decodeSessionUri(m[2])
    if (!sessionId) continue // 解不出的当普通文本，绝不乱动
    out.push({
      start: m.index,
      end: m.index + m[0].length,
      raw: m[0],
      title: unescapeLabel(m[1]),
      sessionId,
    })
  }
  return out
}

/**
 * 构造 insertReference 需要的 ref 对象（形状与 drag-graft 的 folderRefOf 一致，
 * 只是 appearance 换成 session）。mention 复用原 token 里的 URI，保证与宿主编码一致。
 */
export function referenceOf(token) {
  const uri = token.raw.slice(token.raw.indexOf('(dsh-session:') + 1, -1)
  return {
    source: 'reference',
    ref: uri,
    label: token.title || token.sessionId,
    appearance: 'session',
    clipboardText: token.raw,
  }
}

/**
 * 规划一次还原：给出「去掉 token 后的纯文本」和「要在哪些偏移插 chip」。
 * 这里只算文本、不碰 DOM，方便测试。insertion 的 offset 指去 token 后字符串里的位置。
 */
export function planRestore(text, selfId) {
  const original = String(text ?? '')
  const tokens = findTokens(original)
  if (!tokens.length) return { changed: false, text: original, insertions: [], tokens }

  let cursor = 0
  let cleaned = ''
  const insertions = []
  for (const token of tokens) {
    cleaned += original.slice(cursor, token.start)
    const offset = cleaned.length
    cursor = token.end
    if (selfId && token.sessionId === selfId) {
      // 自引用：宿主会整轮拒绝。保留原 token 文本，不插 chip（交给用户自己删）
      cleaned += token.raw
      continue
    }
    insertions.push({ offset, token, ref: referenceOf(token) })
  }
  cleaned += original.slice(cursor)

  const changed = insertions.length > 0
  return {
    changed,
    text: changed ? cleaned : original,
    insertions, // 每个含 offset + token + ref，调用方按 offset 从大到小插，避免偏移漂移
    tokens,
  }
}

/**
 * 把 planRestore 的 insertions 应用到编辑器结构里。
 * 纯函数版：接受「按 offset 切好的段」，返回新的字符串序列，供测试验证顺序正确。
 * 真实 DOM 版在 client.js 里用 insertReference 实现。
 */
export function applyPlanToSegments(plan, chipMarker = '[chip]') {
  if (!plan.changed) return [plan.text]
  const pieces = []
  const sorted = [...plan.insertions].sort((a, b) => a.offset - b.offset)
  let cursor = 0
  for (const ins of sorted) {
    pieces.push(plan.text.slice(cursor, ins.offset))
    pieces.push(chipMarker)
    cursor = ins.offset
  }
  pieces.push(plan.text.slice(cursor))
  return pieces.filter((p) => p !== '')
}
