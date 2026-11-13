import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig } from '../config.js'

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aside-pocket-test-'))
const read = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'))

// fake detection: what a Mac with Aside and Tailscale would give; `asked` counts the calls
function fakeDetect(found = {}) {
  const asked = []
  const answer = { asideCli: '/fake/aside', node: '/fake/node', tailscale: '/fake/tailscale', login: 'you@example.com', ...found }
  const detect = {}
  for (const key of Object.keys(answer)) {
    detect[key] = (arg) => {
      asked.push(key + (arg ? ':' + arg : ''))
      return answer[key]
    }
  }
  return { detect, asked }
}

test('config: a fresh data directory gets defaults plus everything detected, mode 0600 in a 0700 directory', () => {
  const dir = path.join(tmpDir(), 'data')
  const { detect } = fakeDetect()
  const expected = {
    port: 8787,
    httpsPort: 8443,
    allowRoutineRetry: false,
    ntfyTopic: null,
    asideCli: '/fake/aside',
    node: '/fake/node',
    tailscale: '/fake/tailscale',
    allowedLogins: ['you@example.com'],
    contact: 'mailto:you@example.com',
  }
  assert.deepEqual(loadConfig(dir, detect), expected)
  assert.deepEqual(read(dir), expected)
  assert.equal(fs.statSync(path.join(dir, 'config.json')).mode & 0o777, 0o600)
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700)
})

test('config: a partial hand-written file keeps its values; only the missing keys are detected and written back', () => {
  const dir = tmpDir()
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port: 9000, tailscale: '/my/tailscale', allowedLogins: ['a@example.com', 'b@example.com'], allowRoutineRetry: true }))
  const { detect, asked } = fakeDetect()
  const config = loadConfig(dir, detect)
  assert.deepEqual(asked, ['asideCli', 'node'])
  assert.equal(config.port, 9000)
  assert.equal(config.httpsPort, 8443)
  assert.equal(config.tailscale, '/my/tailscale')
  assert.deepEqual(config.allowedLogins, ['a@example.com', 'b@example.com'])
  assert.equal(config.contact, 'mailto:a@example.com')
  assert.equal(config.allowRoutineRetry, true)
  assert.deepEqual(read(dir), config)
  assert.equal(fs.statSync(path.join(dir, 'config.json')).mode & 0o777, 0o600)
})

test('config: the login is asked from the Tailscale CLI that was found', () => {
  const { detect, asked } = fakeDetect({ tailscale: '/opt/homebrew/bin/tailscale' })
  loadConfig(tmpDir(), detect)
  assert.deepEqual(asked, ['asideCli', 'node', 'tailscale', 'login:/opt/homebrew/bin/tailscale'])
})

test('config: what cannot be detected stays missing, and is detected on a later load', () => {
  const dir = tmpDir()
  const config = loadConfig(dir, fakeDetect({ asideCli: null, tailscale: null, login: null }).detect)
  for (const key of ['asideCli', 'tailscale', 'allowedLogins', 'contact']) {
    assert.ok(!(key in config), key)
    assert.ok(!(key in read(dir)), key)
  }
  assert.equal(config.node, '/fake/node')

  const later = loadConfig(dir, fakeDetect().detect)
  assert.equal(later.asideCli, '/fake/aside')
  assert.deepEqual(later.allowedLogins, ['you@example.com'])
  assert.equal(later.contact, 'mailto:you@example.com')
})

test('config: a complete file is not detected again and not rewritten', () => {
  const dir = tmpDir()
  loadConfig(dir, fakeDetect().detect)
  const file = path.join(dir, 'config.json')
  fs.utimesSync(file, 1000, 1000)
  const { detect, asked } = fakeDetect({ login: 'other@example.com' })
  assert.deepEqual(loadConfig(dir, detect).allowedLogins, ['you@example.com'])
  assert.deepEqual(asked, [])
  assert.equal(fs.statSync(file).mtimeMs, 1000000)
})
