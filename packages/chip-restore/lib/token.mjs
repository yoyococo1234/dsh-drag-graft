/**
 * chip-restore 的纯逻辑层（无 DOM / 无宿主依赖，可单测）。
 *
 * 两种回填形态都要还原成真 chip：
 *   A) 完整 token： @[标题](dsh-session:<base64url(JSON.stringify(sessionId))>)
 *      —— drag-graft 刚插入、或宿主未规范化时会出现
 *   B) 纯 @标题：   @模型选择重复或不可用\n正文
 *      —— dsh-rewind 撤回后回填的真实形态（会话日志里 token 已被规范化掉）
 *
 * B 形态没有 sessionId，只能按标题反查会话列表：精确且唯一命中才还原，
 * 0 个或多个匹配一律跳过——绝不插错会话（沿用 drag-graft 的纪律）。
 *
 * 编码格式与 @deepseek-ai/dsh-session-reference / dsh-drag-graft 完全一致。
 */

/** 匹配一个完整的会话引用 token（标题内允许转义的 \] ）。 */
export const TOKEN_RE = /@\[((?:[^\]\\]|\\.)*)\]\((dsh-session:[A-Za-z0-9_-]+)\)/g

/** 匹配一行/一段开头附近的 @标题（不含 [，避免与 A 形态重复匹配）。 */
const AT_TITLE_RE = /(^|[\s(（])@([^\s@\[(\n\r]+)/g

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

function unescapeLabel(label) {
  return String(label ?? '').replace(/\\([\]\\])/g, '$1')
}

/** 从会话列表快照（{byId:{id:{title,displayTitle}}}）建「标题→id」索引。 */
export function indexByTitle(snapshot) {
  const byId = snapshot?.byId ?? {}
  const exact = new Map() // 精确标题 -> Set<id>
  for (const [id, row] of Object.entries(byId)) {
    const titles = new Set()
    for (const value of [row?.displayTitle, row?.title]) {
      const t = String(value ?? '').trim()
      if (t) titles.add(t)
    }
    for (const t of titles) {
      if (!exact.has(t)) exact.set(t, new Set())
      exact.get(t).add(String(id))
    }
  }
  return exact
}

/** 按标题精确反查：唯一命中返回 id；0 个或多个返回 null。 */
export function resolveByTitle(index, title) {
  const ids = index.get(String(title ?? '').trim())
  if (!ids || ids.size !== 1) return null
  return [...ids][0]
}

/**
 * 找出文本里所有「可还原为 chip」的项。
 * token 形态优先（有 sessionId）；其余 @标题 用 index 反查。
 * 返回 [{ start, end, raw, title, sessionId, via }]，按位置排序、互不重叠。
 */
export function findReferences(text, titleIndex, selfId) {
  const original = String(text ?? '')
  const found = []
  const occupied = []

  // A) 完整 token
  const re = new RegExp(TOKEN_RE.source, 'g')
  let m
  while ((m = re.exec(original)) !== null) {
    const sessionId = decodeSessionUri(m[2])
    if (!sessionId) continue
    found.push({
      start: m.index, end: m.index + m[0].length, raw: m[0],
      title: unescapeLabel(m[1]), sessionId, via: 'token',
    })
    occupied.push([m.index, m.index + m[0].length])
  }

  // B) @标题：只处理没被 A 覆盖的、且能唯一反查到会话的
  const at = new RegExp(AT_TITLE_RE.source, 'g')
  while ((m = at.exec(original)) !== null) {
    // 整段 @标题 都要换成 chip：start 指向 @，end 覆盖 @ + 标题
    const start = m.index + m[1].length
    const end = start + 1 + m[2].length
    if (occupied.some(([s, e]) => start < e && end > s)) continue
    const title = m[2]
    const sessionId = titleIndex ? resolveByTitle(titleIndex, title) : null
    if (!sessionId) continue // 反查不到或重名 -> 当普通文本
    found.push({ start, end, raw: m[2], title, sessionId, via: 'title' })
    occupied.push([start, end])
  }

  found.sort((a, b) => a.start - b.start)
  return found
}

/** 构造 insertReference 需要的 ref 对象。 */
export function referenceOf(ref) {
  if (ref.via === 'token') {
    const uri = ref.raw.slice(ref.raw.indexOf('(dsh-session:') + 1, -1)
    return { source: 'reference', ref: uri, label: ref.title || ref.sessionId, appearance: 'session', clipboardText: ref.raw }
  }
  // 标题反查：mention 用现成的编码函数（与宿主一致）
  const json = JSON.stringify(String(ref.sessionId))
  let binary = ''
  const bytes = new TextEncoder().encode(json)
  for (const b of bytes) binary += String.fromCharCode(b)
  const payload = btoaCompat(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
  const mention = `dsh-session:${payload}`
  return { source: 'reference', ref: mention, label: ref.title, appearance: 'session', clipboardText: `@${ref.title}` }
}

function btoaCompat(binary) {
  if (typeof btoa === 'function') return btoa(binary)
  const B = B64
  let out = ''
  for (let i = 0; i < binary.length; i += 3) {
    const a = binary.charCodeAt(i)
    const b = i + 1 < binary.length ? binary.charCodeAt(i + 1) : -1
    const c = i + 2 < binary.length ? binary.charCodeAt(i + 2) : -1
    out += B[a >> 2] + B[((a & 3) << 4) | (b < 0 ? 0 : b >> 4)] + (b < 0 ? '=' : B[((b & 15) << 2) | (c < 0 ? 0 : c >> 6)]) + (c < 0 ? '=' : B[c & 63])
  }
  return out
}

/**
 * 规划一次还原：给出「去掉引用文本后的纯文本」和插 chip 的位置。
 */
export function planRestore(text, { byId, selfId, titleIndex } = {}) {
  const original = String(text ?? '')
  const index = titleIndex ?? (byId ? indexByTitle({ byId }) : null)
  const refs = findReferences(original, index, selfId)
  const usable = refs.filter((r) => !(selfId && r.sessionId === selfId)) // 自引用不还原
  if (!usable.length) return { changed: false, text: original, insertions: [], refs }

  let cursor = 0
  let cleaned = ''
  const insertions = []
  for (const ref of usable) {
    cleaned += original.slice(cursor, ref.start)
    insertions.push({ offset: cleaned.length, ref })
    cursor = ref.end
  }
  cleaned += original.slice(cursor)
  return { changed: true, text: cleaned, insertions, refs }
}

/** 纯函数版分段，供测试验证顺序。 */
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
