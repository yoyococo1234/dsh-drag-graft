import test from 'node:test'
import assert from 'node:assert/strict'
import {
  decodeSessionUri,
  indexByTitle,
  resolveByTitle,
  findReferences,
  referenceOf,
  planRestore,
  applyPlanToSegments,
} from '../lib/token.mjs'

const REAL_ID = 'session-58531e0b-185b-4339-a9e9-c1dbaf11a86f'
const TITLE = '模型选择重复或不可用'
const REAL_TOKEN = `@[${TITLE}](dsh-session:InNlc3Npb24tNTg1MzFlMGItMTg1Yi00MzM5LWE5ZTktYzFkYmFmMTFhODZmIg)`
// dsh-rewind 撤回后回填的真实形态（来自当前会话日志 seq 1863）
const REWIND_TEXT = `@${TITLE}\n为什么不是蓝色的`

const byId = {
  [REAL_ID]: { id: REAL_ID, title: TITLE, displayTitle: TITLE },
  'session-other': { id: 'session-other', title: '别的会话' },
}

test('decodeSessionUri：真实 token 解出正确 session id', () => {
  const uri = REAL_TOKEN.slice(REAL_TOKEN.indexOf('(dsh-session:') + 1, -1)
  assert.equal(decodeSessionUri(uri), REAL_ID)
})

test('decodeSessionUri：脏输入返回 null，不抛', () => {
  assert.equal(decodeSessionUri(null), null)
  assert.equal(decodeSessionUri('dsh-session:!!!!'), null)
  assert.equal(decodeSessionUri('dsh-session:abcd'), null)
})

test('indexByTitle + resolveByTitle：精确唯一命中才返回 id', () => {
  const index = indexByTitle({ byId })
  assert.equal(resolveByTitle(index, TITLE), REAL_ID)
  assert.equal(resolveByTitle(index, '别的会话'), 'session-other')
  assert.equal(resolveByTitle(index, '模'), null, '部分匹配不算')
  assert.equal(resolveByTitle(index, '不存在'), null)
})

test('resolveByTitle：重名返回 null（绝不盲选）', () => {
  const dup = indexByTitle({ byId: {
    a: { title: '重名' },
    b: { displayTitle: '重名' },
    c: { title: '唯一' },
  } })
  assert.equal(resolveByTitle(dup, '重名'), null)
  assert.equal(resolveByTitle(dup, '唯一'), 'c')
})

test('findReferences：A 形态完整 token 直接解 id', () => {
  const refs = findReferences(`${REAL_TOKEN} 正文`, indexByTitle({ byId }), 'session-current')
  assert.equal(refs.length, 1)
  assert.equal(refs[0].via, 'token')
  assert.equal(refs[0].sessionId, REAL_ID)
})

test('findReferences：B 形态 @标题 按标题反查（rewind 真实形态）', () => {
  const refs = findReferences(REWIND_TEXT, indexByTitle({ byId }), 'session-current')
  assert.equal(refs.length, 1)
  assert.equal(refs[0].via, 'title')
  assert.equal(refs[0].sessionId, REAL_ID)
  assert.equal(refs[0].title, TITLE)
  assert.equal(REWIND_TEXT.slice(refs[0].start, refs[0].end), `@${TITLE}`, '整段 @标题 都要替换')
})

test('findReferences：B 形态标题重名/找不到时跳过，当普通文本', () => {
  const index = indexByTitle({ byId: {
    a: { title: '重名' },
    b: { title: '重名' },
  } })
  assert.equal(findReferences('@重名\n正文', index, 'session-current').length, 0)
  assert.equal(findReferences('@找不到\n正文', index, 'session-current').length, 0)
})

test('findReferences：@ 出现在句中也能识别（前面是空白/括号）', () => {
  const refs = findReferences(`开头 @${TITLE} 结尾`, indexByTitle({ byId }), 'session-current')
  assert.equal(refs.length, 1)
  assert.equal(refs[0].sessionId, REAL_ID)
})

test('findReferences：A 和 B 同时存在不重复匹配同一段', () => {
  const text = `${REAL_TOKEN} 和 @${TITLE}`
  const refs = findReferences(text, indexByTitle({ byId }), 'session-current')
  assert.equal(refs.length, 2, 'A 的 token 与 B 的 @标题 是两处不同文本')
})

test('referenceOf：标题反查的 ref 带正确 mention（dsh-session:base64）', () => {
  const ref = findReferences(REWIND_TEXT, indexByTitle({ byId }), 'session-current')[0]
  const built = referenceOf(ref)
  assert.equal(built.source, 'reference')
  assert.equal(built.appearance, 'session')
  assert.equal(built.label, TITLE)
  assert.ok(built.ref.startsWith('dsh-session:'))
  assert.equal(decodeSessionUri(built.ref), REAL_ID, '生成的 mention 能反解回 id')
})

test('planRestore：rewind 真实形态去掉 @标题、保留正文、给出插入点', () => {
  const plan = planRestore(REWIND_TEXT, { byId })
  assert.equal(plan.changed, true)
  assert.equal(plan.text, '\n为什么不是蓝色的')
  assert.equal(plan.insertions.length, 1)
  assert.equal(plan.insertions[0].offset, 0)
  assert.equal(plan.insertions[0].ref.sessionId, REAL_ID)
})

test('planRestore：自引用不还原', () => {
  const plan = planRestore(`@${TITLE}\n正文`, { byId, selfId: REAL_ID })
  assert.equal(plan.changed, false)
  assert.equal(plan.text, `@${TITLE}\n正文`)
})

test('planRestore：多个引用按位置给出插入点', () => {
  const text = `@${TITLE} 然后 @别的会话 尾`
  const plan = planRestore(text, { byId })
  assert.equal(plan.insertions.length, 2)
  assert.ok(plan.insertions[0].offset <= plan.insertions[1].offset)
})

test('planRestore：纯正文无 @ 引用时原样', () => {
  const plan = planRestore('这就是普通问题', { byId })
  assert.equal(plan.changed, false)
  assert.equal(plan.text, '这就是普通问题')
})

test('applyPlanToSegments：chip 落在正确位置', () => {
  const plan = planRestore(`前面 @${TITLE} 后面`, { byId })
  const pieces = applyPlanToSegments(plan, '[chip]')
  assert.equal(pieces[1], '[chip]')
  assert.ok(pieces[0].startsWith('前面'))
  assert.ok(pieces[2].startsWith(' 后面'))
})
