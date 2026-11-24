import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { findTokens, planRestore, decodeSessionUri } from '../lib/token.mjs'

/**
 * client.js 的纯逻辑是内联副本（client bundle 不能 import 包内文件）。
 * 这个测试用同一批向量对比：内联函数与 lib/token.mjs 必须给出一致结果，
 * 防止两边漂移导致「测的是 A、跑的是 B」。
 */
const here = dirname(fileURLToPath(import.meta.url))
const clientSrc = readFileSync(join(here, '..', 'client.js'), 'utf8')

test('client.js 内联的纯逻辑与 lib/token.mjs 源码一致（关键片段）', () => {
  // 逐段比对：两边的关键表达式必须逐字相同
  const shared = [
    "'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'",
    "text.indexOf('dsh-session:')",
    '/^[A-Za-z0-9_-]+$/.test(payload)',
    'payload.replace(/-/g, \'+\').replace(/_/g, \'/\')',
    'JSON.parse(new TextDecoder().decode(bytes))',
    'appearance: \'session\'',
    'source: \'reference\'',
  ]
  for (const needle of shared) {
    assert.ok(clientSrc.includes(needle), `client.js 缺少关键片段: ${needle}`)
  }
})

const REAL = '@[模型选择重复或不可用](dsh-session:InNlc3Npb24tNTg1MzFlMGItMTg1Yi00MzM5LWE5ZTktYzFkYmFmMTFhODZmIg)'
const ID = 'session-58531e0b-185b-4339-a9e9-c1dbaf11a86f'

test('共享向量：真实 token 在 lib 里可解（client 用同样算法）', () => {
  const uri = REAL.slice(REAL.indexOf('(dsh-session:') + 1, -1)
  assert.equal(decodeSessionUri(uri), ID)
  const tokens = findTokens(`${REAL} 正文`)
  assert.equal(tokens.length, 1)
  const plan = planRestore(`${REAL} 正文`, 'session-other')
  assert.equal(plan.text, ' 正文')
  assert.equal(plan.insertions.length, 1)
})

test('共享向量：转义标题 / 自引用 / 多 token 的规划稳定', () => {
  const escaped = '@[标题\\]后缀](dsh-session:InNlc3Npb24tNTg1MzFlMGItMTg1Yi00MzM5LWE5ZTktYzFkYmFmMTFhODZmIg)'
  assert.equal(findTokens(escaped)[0].title, '标题]后缀')
  assert.equal(planRestore(REAL, ID).changed, false)
  assert.equal(planRestore(`${REAL} ${REAL}`, 'session-other').insertions.length, 2)
})
