import test from 'node:test'
import assert from 'node:assert/strict'
import {
  decodeSessionUri,
  findTokens,
  referenceOf,
  planRestore,
  applyPlanToSegments,
} from '../lib/token.mjs'

// 从真实会话日志里取出的 token（session-58531e0b-185b-4339-a9e9-c1dbaf11a86f）
const REAL_TOKEN = '@[模型选择重复或不可用](dsh-session:InNlc3Npb24tNTg1MzFlMGItMTg1Yi00MzM5LWE5ZTktYzFkYmFmMTFhODZmIg)'
const REAL_ID = 'session-58531e0b-185b-4339-a9e9-c1dbaf11a86f'

test('decodeSessionUri：真实日志 token 解出正确 session id', () => {
  const uri = REAL_TOKEN.slice(REAL_TOKEN.indexOf('(dsh-session:') + 1, -1)
  assert.equal(decodeSessionUri(uri), REAL_ID)
})

test('decodeSessionUri：脏输入返回 null，不抛', () => {
  assert.equal(decodeSessionUri(null), null)
  assert.equal(decodeSessionUri(''), null)
  assert.equal(decodeSessionUri('dsh-session:!!!!'), null)
  assert.equal(decodeSessionUri('dsh-session:abcd'), null)
  assert.equal(decodeSessionUri('no-prefix-abc'), null)
})

test('findTokens：从回填文本里找出 token 并带正确偏移', () => {
  const text = `${REAL_TOKEN} 我的意思是`
  const tokens = findTokens(text)
  assert.equal(tokens.length, 1)
  assert.equal(tokens[0].sessionId, REAL_ID)
  assert.equal(tokens[0].title, '模型选择重复或不可用')
  assert.equal(tokens[0].start, 0)
  assert.equal(tokens[0].end, REAL_TOKEN.length)
  assert.equal(text.slice(tokens[0].start, tokens[0].end), REAL_TOKEN)
})

test('findTokens：标题里的转义 \\] 能正确反转义', () => {
  const escaped = '@[标题\\]后缀](dsh-session:InNlc3Npb24tNTg1MzFlMGItMTg1Yi00MzM5LWE5ZTktYzFkYmFmMTFhODZmIg)'
  const tokens = findTokens(escaped)
  assert.equal(tokens.length, 1)
  assert.equal(tokens[0].title, '标题]后缀')
})

test('findTokens：解不出的 token 不算，当普通文本', () => {
  assert.equal(findTokens('@[坏的](dsh-session:!!!!) 后面').length, 0)
  assert.equal(findTokens('普通文本 @某人 没有 token').length, 0)
})

test('referenceOf：生成 insertReference 需要的 ref 形状', () => {
  const token = findTokens(REAL_TOKEN)[0]
  const ref = referenceOf(token)
  assert.equal(ref.source, 'reference')
  assert.equal(ref.appearance, 'session')
  assert.equal(ref.label, '模型选择重复或不可用')
  assert.equal(ref.clipboardText, REAL_TOKEN)
  assert.ok(ref.ref.startsWith('dsh-session:'))
})

test('planRestore：去掉 token、保留后面正文、给出插入点', () => {
  const text = `${REAL_TOKEN} 我的意思是`
  const plan = planRestore(text, 'session-current')
  assert.equal(plan.changed, true)
  assert.equal(plan.text, ' 我的意思是')
  assert.equal(plan.insertions.length, 1)
  assert.equal(plan.insertions[0].offset, 0)
  assert.equal(plan.insertions[0].token.sessionId, REAL_ID)
})

test('planRestore：token 在中间时偏移正确', () => {
  const text = `开头 ${REAL_TOKEN} 结尾`
  const plan = planRestore(text, 'session-current')
  assert.equal(plan.text, '开头  结尾')
  assert.equal(plan.insertions[0].offset, 3) // '开头 ' 的长度
})

test('planRestore：自引用 token 保留文本、不插 chip', () => {
  const text = `${REAL_TOKEN} 我的意思是`
  const plan = planRestore(text, REAL_ID)
  assert.equal(plan.changed, false)
  assert.equal(plan.text, text)
  assert.equal(plan.insertions.length, 0)
})

test('planRestore：多个 token 都能规划，按出现顺序', () => {
  const second = '@[另一个会话](dsh-session:InNlc3Npb24tNTg1MzFlMGItMTg1Yi00MzM5LWE5ZTktYzFkYmFmMTFhODZmIg)'
  const text = `${REAL_TOKEN} 中间 ${second} 尾`
  const plan = planRestore(text, 'session-current')
  assert.equal(plan.insertions.length, 2)
  assert.ok(plan.insertions[0].offset < plan.insertions[1].offset)
})

test('planRestore：无 token 时 changed=false，原样返回', () => {
  const plan = planRestore('普通文本', 'session-current')
  assert.equal(plan.changed, false)
  assert.equal(plan.text, '普通文本')
  assert.equal(plan.insertions.length, 0)
})

test('applyPlanToSegments：chip 落在正确位置，顺序对', () => {
  const text = `开头 ${REAL_TOKEN} 结尾`
  const plan = planRestore(text, 'session-current')
  const pieces = applyPlanToSegments(plan, '[chip]')
  assert.deepEqual(pieces, ['开头 ', '[chip]', ' 结尾'])
})

test('applyPlanToSegments：无变化时原样一段', () => {
  const plan = planRestore('普通文本', 'session-current')
  assert.deepEqual(applyPlanToSegments(plan), ['普通文本'])
})
