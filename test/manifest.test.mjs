import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (name) => readFileSync(join(root, name), 'utf8')
const pkg = JSON.parse(read('package.json'))

test('manifest is publishable', () => {
  assert.equal(typeof pkg.name, 'string')
  assert.ok(!pkg.name.startsWith('@local/'), 'published packages need a registry-usable name')
  assert.equal(pkg.private, undefined, 'private must not be set for publication')
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/)
  assert.equal(pkg.license, 'MIT')
  assert.ok(pkg.description.length > 40)
  assert.ok(Array.isArray(pkg.keywords) && pkg.keywords.includes('dsh-plugin'))
  assert.ok(pkg.engines?.dsh, 'engines.dsh pins the tested host line')
  assert.ok(pkg.engines?.node)
})

test('every runtime file is listed in files[] and exists', () => {
  for (const required of ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'README.md', 'README_EN.md']) {
    assert.ok(pkg.files.some((p) => p === required || (p.endsWith('/*.json') && required.endsWith('.json'))),
      `${required} must be shipped`)
    assert.ok(existsSync(join(root, required)), `${required} must exist`)
  }
  assert.ok(existsSync(join(root, 'locale', 'en.json')))
  assert.ok(existsSync(join(root, 'locale', 'zh.json')))
})

test('exports map covers client, locales and icon', () => {
  assert.equal(pkg.exports['./client'], './client.js')
  assert.equal(pkg.exports['./icon'], './icon.svg')
  assert.ok(pkg.exports['./locale/*.json'])
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
})

test('bundle patch inserts exactly this package', () => {
  const patch = read('cordis.patch.yml')
  assert.match(patch, /insert:/)
  assert.ok(patch.includes(`name: ${pkg.name}`), 'patch must reference the package name')
})

test('client module id matches the package name', () => {
  const client = read('client.js')
  const id = /__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/.exec(client)?.[1]
  assert.equal(id, pkg.name, 'the loader requires the factory id to equal the package name')
  assert.equal((client.match(/__ModuleLoader__\.load/g) ?? []).length, 1)
})

test('client half is fail-soft: apply is wrapped and inert on error', () => {
  const client = read('client.js')
  assert.match(client, /function apply\(ctx\) \{\s*try \{\s*applyInner\(ctx\)/)
  assert.match(client, /catch \(error\) \{\s*console\.error\('\[drag-graft\] apply failed/)
})

test('host half exports the contract and is fail-soft', () => {
  const host = read('index.js')
  assert.match(host, new RegExp(`export const name = '${pkg.name}'`))
  assert.match(host, /export const inject = \[[^\]]*'sessionController'/)
  assert.match(host, /export function apply\(ctx\) \{\s*try \{\s*return applyInner\(ctx\)/)
  assert.match(host, /return \(\) => \{\}/, 'a failed apply must return a no-op disposer')
})

test('session reference URI encoding round-trips (host contract)', () => {
  // Must match @deepseek-ai/dsh-session-reference: dsh-session:base64url(JSON.stringify(id))
  const encode = (sessionId) => `dsh-session:${Buffer.from(JSON.stringify(sessionId), 'utf8').toString('base64url')}`
  const decode = (uri) => {
    assert.ok(uri.startsWith('dsh-session:'))
    const payload = uri.slice('dsh-session:'.length)
    assert.match(payload, /^[A-Za-z0-9_-]+$/)
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    assert.equal(typeof parsed, 'string')
    return parsed
  }
  for (const id of ['session-93b08d91-0209-45c9-9cd0-e846fada010d', 'import-01a167e0-bcf2-7123-b5bb-42db71c206ec', 'od-44ff93d6-d929-4cd2-8d92-c228f757689c']) {
    assert.equal(decode(encode(id)), id)
  }
  assert.equal(
    encode('session-93b08d91-0209-45c9-9cd0-e846fada010d'),
    'dsh-session:InNlc3Npb24tOTNiMDhkOTEtMDIwOS00NWM5LTljZDAtZTg0NmZhZGEwMTBkIg',
  )
})

test('locale metadata carries a title and description', () => {
  for (const file of ['locale/en.json', 'locale/zh.json']) {
    const dict = JSON.parse(read(file))
    assert.ok(dict.meta?.title?.length > 0, `${file} needs meta.title`)
    assert.ok(dict.meta?.description?.length > 20, `${file} needs meta.description`)
  }
})
