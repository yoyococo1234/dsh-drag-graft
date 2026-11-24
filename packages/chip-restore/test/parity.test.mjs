import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { planRestore, decodeSessionUri, indexByTitle } from '../lib/token.mjs'

/**
 * client.js 的纯逻辑是内联副本（client bundle 不能 import 包内文件）。
 * 这个测试确认两边共享同样的关键表达式，防止「测的是 A、跑的是 B」。
 */
const here = dirname(fileURLToPath(import.meta.url))
const clientSrc = readFileSync(join(here, '..', 'client.js'), 'utf8')

test('client.js 内联逻辑含标题反查所需的关键片段', () => {
  const needles = [
    "text.indexOf('dsh-session:')",
    '/^[A-Za-z0-9_-]+$/.test(payload)',
    'JSON.parse(new TextDecoder().decode(bytes))',
    'function indexByTitle(snapshot)',
    'function resolveByTitle(index, title)',
    'function findReferences(original0, titleIndex, selfId)',
    'const end = start + 1 + m[2].length', // @标题 整段覆盖的偏移修正（两边一致）
    'appearance: \'session\'',
    'source: \'reference\'',
    'text.includes(\'@\')', // 触发条件要覆盖 B 形态
  ]
  for (const needle of needles) {
    assert.ok(clientSrc.includes(needle), `client.js 缺少关键片段: ${needle}`)
  }
})

const TITLE = '模型选择重复或不可用'
const ID = 'session-58531e0b-185b-4339-a9e9-c1dbaf11a86f'
const byId = { [ID]: { title: TITLE, displayTitle: TITLE } }
const index = indexByTitle({ byId })
const REWIND_TEXT = `@${TITLE}\n为什么不是蓝色的`

test('共享向量：真实 token 与 rewind 回填形态在 lib 里都能规划', () => {
  const real = '@[模型选择重复或不可用](dsh-session:InNlc3Npb24tNTg1MzFlMGItMTg1Yi00MzM5LWE5ZTktYzFkYmFmMTFhODZmIg)'
  const uri = real.slice(real.indexOf('(dsh-session:') + 1, -1)
  assert.equal(decodeSessionUri(uri), ID)
  const p1 = planRestore(`${real} 正文`, { byId })
  assert.equal(p1.text, ' 正文')
  const p2 = planRestore(REWIND_TEXT, { byId })
  assert.equal(p2.text, '\n为什么不是蓝色的')
  assert.equal(p2.insertions[0].ref.sessionId, ID)
  assert.ok(index.has(TITLE))
})
