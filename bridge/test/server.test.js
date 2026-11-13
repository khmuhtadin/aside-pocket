import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createApp } from '../server.js'
import { createPairCode, redeemPairCode, checkToken } from '../auth.js'

const fixture = (name) => fs.readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf8')
const LOGIN = { 'Tailscale-User-Login': 'owner@example.com' }
const VERSION = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'package.json'), 'utf8')).version

// a data directory with a complete config.json, so nothing is detected on the machine that runs the tests
function tmpDir(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-pocket-test-'))
  const config = { asideCli: '/nonexistent/aside', node: process.execPath, tailscale: '/nonexistent/tailscale', allowedLogins: ['owner@example.com'], contact: 'mailto:owner@example.com', ...extra }
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config), { mode: 0o600 })
  return dir
}

// fake CLI runner: answers `session list` and `repl` from fixtures
async function fakeRun(args) {
  if (args[0] === 'session' && args[1] === 'list') return { ok: true, stdout: fixture('session-list.json'), stderr: '' }
  if (args[0] === 'account') {
    const accounts = [{ id: 0, name: 'main', email: 'main@example.com', authStatus: 'active' }, { id: 1, name: 'old', authStatus: 'expired' }]
    return { ok: true, stdout: JSON.stringify({ accounts }), stderr: '' }
  }
  if (args[0] === 'host') return { ok: true, stdout: JSON.stringify({ profiles: [{ profileId: 'p1', connected: true }] }), stderr: '' }
  if (args[0] === 'repl') return { ok: true, stdout: fixture('repl-suspended.json'), stderr: '' }
  return { ok: false, stdout: '', stderr: 'Error: unexpected call' }
}

async function startApp(t) {
  const dir = tmpDir()
  const app = createApp({ dir, run: fakeRun, health: async () => ({ version: '1.0', ready: true, status: 'idle' }) })
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve))
  t.after(() => app.close())
  const base = `http://127.0.0.1:${app.server.address().port}`
  const pair = (code) =>
    fetch(`${base}/api/pair`, { method: 'POST', headers: LOGIN, body: JSON.stringify({ code }) })
  return { dir, base, pair }
}

test('auth: 403 without or with a wrong Tailscale login', async (t) => {
  const { base } = await startApp(t)
  assert.equal((await fetch(`${base}/api/health`)).status, 403)
  assert.equal((await fetch(`${base}/api/health`, { headers: { 'Tailscale-User-Login': 'someone@example.com' } })).status, 403)
  const res = await fetch(`${base}/api/pair`, { method: 'POST', body: JSON.stringify({ code: '000000' }) })
  assert.equal(res.status, 403)
})

test('auth: 401 without or with a wrong token, 200 with the paired token', async (t) => {
  const { dir, base, pair } = await startApp(t)
  assert.equal((await fetch(`${base}/api/health`, { headers: LOGIN })).status, 401) // no token exists yet

  const res = await pair(createPairCode(dir))
  assert.equal(res.status, 200)
  const { token } = await res.json()
  assert.match(token, /^[0-9a-f]{64}$/)
  assert.equal(fs.statSync(path.join(dir, 'token')).mode & 0o777, 0o600)

  assert.equal((await fetch(`${base}/api/health`, { headers: LOGIN })).status, 401)
  assert.equal((await fetch(`${base}/api/health`, { headers: { ...LOGIN, Authorization: `Bearer ${'0'.repeat(64)}` } })).status, 401)
  assert.equal((await fetch(`${base}/api/health`, { headers: { Authorization: `Bearer ${token}` } })).status, 403)

  const auth = { ...LOGIN, Authorization: `Bearer ${token}` }
  const health = await fetch(`${base}/api/health`, { headers: auth })
  assert.equal(health.status, 200)
  assert.deepEqual(await health.json(), { ok: true, version: VERSION, features: { routineRetry: false }, aside: { version: '1.0', ready: true, status: 'idle' }, running: 1 })

  const list = await (await fetch(`${base}/api/sessions?filter=done&limit=2`, { headers: auth })).json()
  assert.deepEqual(list.sessions.map((s) => s.status), ['done', 'failed'])

  assert.equal((await fetch(`${base}/api/sessions/bad!id`, { headers: auth })).status, 400)
  assert.equal((await fetch(`${base}/api/nope`, { headers: auth })).status, 404)
})

test('pairing over HTTP: one-time use and same token on re-pair', async (t) => {
  const { dir, base, pair } = await startApp(t)
  const code = createPairCode(dir)
  const first = await pair(code)
  assert.equal(first.status, 200)
  assert.equal((await pair(code)).status, 401) // already used
  const second = await pair(createPairCode(dir))
  assert.equal((await second.json()).token, (await first.json()).token)
})

test('pairing: code expires after 5 minutes', () => {
  const dir = tmpDir()
  const now = Date.now()
  const code = createPairCode(dir, now)
  assert.match(code, /^\d{6}$/)
  assert.equal(redeemPairCode(dir, code, now + 5 * 60 * 1000 + 1), null)
  assert.ok(!fs.existsSync(path.join(dir, 'pair.json')))
  assert.equal(redeemPairCode(dir, code, now), null) // gone for good
})

test('pairing: only the hash is stored, mode 0600', () => {
  const dir = tmpDir()
  const code = createPairCode(dir)
  const file = path.join(dir, 'pair.json')
  assert.ok(!fs.readFileSync(file, 'utf8').includes(code))
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
})

test('pairing: 5 wrong attempts kill the code', () => {
  const dir = tmpDir()
  const code = createPairCode(dir)
  const wrong = code === '111111' ? '222222' : '111111'
  for (let i = 0; i < 5; i++) assert.equal(redeemPairCode(dir, wrong), null)
  assert.equal(redeemPairCode(dir, code), null)
})

test('pairing: a right code after a few wrong ones still works, then the token checks out', () => {
  const dir = tmpDir()
  const code = createPairCode(dir)
  const wrong = code === '111111' ? '222222' : '111111'
  for (let i = 0; i < 4; i++) assert.equal(redeemPairCode(dir, wrong), null)
  const token = redeemPairCode(dir, code)
  assert.ok(checkToken(dir, `Bearer ${token}`))
  assert.ok(!checkToken(dir, `Bearer ${token}x`))
  assert.ok(!checkToken(dir, token))
  assert.ok(!checkToken(dir, undefined))
})

test('accounts: only active accounts are listed and every session carries its account', async (t) => {
  const { dir, base, pair } = await startApp(t)
  const { token } = await (await pair(createPairCode(dir))).json()
  const auth = { ...LOGIN, Authorization: `Bearer ${token}` }
  const { accounts } = await (await fetch(`${base}/api/accounts`, { headers: auth })).json()
  assert.deepEqual(accounts, [{ id: 'u0', name: 'main', email: 'main@example.com', connected: true }])
  const { sessions } = await (await fetch(`${base}/api/sessions`, { headers: auth })).json()
  assert.ok(sessions.length > 0 && sessions.every((s) => s.account === 'u0'))
  assert.equal((await fetch(`${base}/api/routines?account=u1`, { headers: auth })).status, 400)
})

// ---- several accounts, models ----

const replOut = (value) => JSON.stringify({ run: { content: [{ type: 'text', text: JSON.stringify(value) }], error: null } })
const rawSession = (id, updatedAt) => ({ id, title: id, status: 'idle', ephemeral: false, readAt: updatedAt, createdAt: updatedAt, updatedAt })

// fake Aside with three signed-in accounts: u0 (profile p1 open), u1 (no profile open), u2 (profile q9 open).
// `calls` collects the args of every CLI call; `state` lets a test break things.
function fakeAside() {
  const calls = []
  const state = { u2Open: true, u2ListFails: false, tabOpen: true }
  const ok = (value) => ({ ok: true, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' })
  const accountArg = (args) => args[args.indexOf('--account') + 1]

  async function run(args) {
    calls.push(args)
    const account = accountArg(args)
    if (args[0] === 'account') {
      return ok({ accounts: [0, 1, 2].map((id) => ({ id, name: 'name' + id, email: `u${id}@example.com`, authStatus: 'active' })) })
    }
    if (args[0] === 'host') {
      const profiles = {
        u0: [{ profileId: 'p0', connected: false }, { profileId: 'p1', connected: true }],
        u1: [{ profileId: 'x', connected: false }],
        u2: [{ profileId: 'q9', connected: state.u2Open }],
      }[account]
      return ok({ profiles })
    }
    if (args[0] === 'session' && args[1] === 'list') {
      if (account === 'u0:p1') return ok({ sessions: [rawSession('u0-old-session', '2026-01-01T00:00:00.000Z'), rawSession('u0-new-session', '2026-01-03T00:00:00.000Z')] })
      if (account === 'u2:q9' && !state.u2ListFails) return ok({ sessions: [rawSession('u2-mid-session', '2026-01-02T00:00:00.000Z')] })
      return { ok: false, stdout: '', stderr: 'Error: profile is not connected' }
    }
    if (args[0] === 'session' && args[1] === 'inspect') {
      const modelId = { 'u0-old-session': 'old-model', 'u0-new-session': 'new-model', 'u2-mid-session': 'mid-model' }[args[2]]
      const tab = {
        'u2-run-session': { activeTabTargetId: 'TARGET0123456789', browserBinding: { anchorTargetId: 'OWNERTAB12345678' } },
        'u2-mid-session': { activeTabTargetId: 'OWNERTAB12345678', browserBinding: { anchorTargetId: 'OWNERTAB12345678' } }, // has not opened a tab yet
      }[args[2]]
      const permissionMode = args[2] === 'u2-run-session' ? 'full-access' : 'guard'
      return ok({ session: { id: args[2], status: 'idle', permissionMode, queuedMessages: [], model: { provider: 'prov', modelId, thinkingLevel: 'low', fastMode: false }, ...tab } })
    }
    if (args[0] === 'session' && ['steer', 'queue'].includes(args[1])) return ok('')
    if (args[0] === 'memory' && args[1] === 'search') {
      return ok([{ path: path.join(os.homedir(), '.aside/u/2/memory/notes/a.md'), title: 'A', headings: [], excerpt: 'text', line: 1, lineEnd: 2, score: 0.5, chunkId: 'c1' }])
    }
    if (args[0] === 'memory' && args[1] === 'show') return ok(args.at(-1) === 'notes/a.md' ? '# A\n' : '')
    if (args[0] === 'repl') {
      const code = args.at(-1)
      if (code.includes('settings.getAll')) {
        const model = (modelId) => ({ provider: 'prov', modelId })
        return ok(replOut({ default: model('default-model'), others: [model('new-model'), model('custom-model'), null] }))
      }
      if (code.includes('sessions.update')) return ok(replOut(true))
      if (code.includes('sessions.messages')) return ok(replOut({ suspension: null, messages: [{ role: 'user', text: 'hi', ts: 1 }], more: true }))
      if (code.includes('attachBrowserTab')) return ok(replOut(state.tabOpen ? Buffer.from('jpeg bytes').toString('base64') : null))
      if (code.includes('trigger?.type')) { // "is it a routine run?", which also tells whether the account has the session
        const id = /get\('([^']+)'\)/.exec(code)[1]
        // u2-run-session (a routine run) and u2-sub-session (a subagent) are child sessions: in no list, only u2 has them
        const has = { 'u0:p1': ['u0-old-session', 'u0-new-session'], 'u2:q9': ['u2-mid-session', 'u2-run-session', 'u2-sub-session'] }[account]
        if (has.includes(id)) return ok(replOut(id === 'u2-run-session'))
        return ok(JSON.stringify({ run: { content: [], error: 'Error: Session not found: x\n    at apply' } }))
      }
      if (code.includes('routines.list')) {
        const routine = { status: 'active', rrule: null, nextRunAt: null, projectId: null, parentSessionId: 'u2-mid-session' }
        return ok(replOut([
          { ...routine, id: 'routine-1', name: 'Example routine', lastRunStatus: 'idle', lastRunSessionId: 'u2-run-session' },
          { ...routine, id: 'routine-2', name: 'Never ran', lastRunStatus: null, lastRunSessionId: null },
        ]))
      }
      return ok(replOut([])) // suspended sessions, projects, routines
    }
    return { ok: false, stdout: '', stderr: 'Error: unexpected call' }
  }

  // fake `aside exec`: reports a session id on stderr and keeps running
  function start(args) {
    calls.push(args)
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    if (args[0] === 'exec') setImmediate(() => child.stderr.write('created new session: startedSession01\n'))
    else setImmediate(() => child.emit('close', 0)) // `session resume`
    return child
  }

  return { run, start, calls, state }
}

async function startFake(t, config = {}) {
  const aside = fakeAside()
  const dir = tmpDir(config)
  const app = createApp({ dir, run: aside.run, start: aside.start, health: async () => null })
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve))
  t.after(() => app.close())
  const base = `http://127.0.0.1:${app.server.address().port}`
  const headers = { ...LOGIN, Authorization: `Bearer ${redeemPairCode(dir, createPairCode(dir))}` }
  const get = (url) => fetch(base + url, { headers })
  const post = (url, body) => fetch(base + url, { method: 'POST', headers, body: JSON.stringify(body) })
  return { ...aside, base, get, post, dir }
}

test('account selector is uN:<id of the connected profile>; an account with no open profile is skipped', async (t) => {
  const { get, post, calls } = await startFake(t)
  const { accounts } = await (await get('/api/accounts')).json()
  assert.deepEqual(accounts.map((a) => [a.id, a.connected]), [['u0', true], ['u1', false], ['u2', true]])

  assert.equal((await get('/api/sessions')).status, 200)
  assert.equal((await get('/api/projects?account=u2')).status, 200)
  const used = new Set(calls.filter((c) => c[0] !== 'account' && c[0] !== 'host').map((c) => c[c.indexOf('--account') + 1]))
  assert.deepEqual([...used].sort(), ['u0:p1', 'u2:q9'])

  for (const url of ['/api/projects?account=u1', '/api/routines?account=u1', '/api/models?account=u1', '/api/projects?account=u7']) {
    const res = await get(url)
    assert.equal(res.status, 400, url)
    assert.deepEqual(await res.json(), { error: 'bad account' })
  }
  assert.equal((await post('/api/sessions', { prompt: 'hi', account: 'u1' })).status, 400)
  assert.ok(!calls.some((c) => c[0] === 'exec'))
})

test('sessions of two accounts are merged newest first, each with its account', async (t) => {
  const { get } = await startFake(t)
  const { sessions } = await (await get('/api/sessions')).json()
  assert.deepEqual(sessions.map((s) => [s.id, s.account]), [
    ['u0-new-session', 'u0'],
    ['u2-mid-session', 'u2'],
    ['u0-old-session', 'u0'],
  ])
})

test('a failing account makes the bridge look again at who is connected', async (t) => {
  const { get, state } = await startFake(t)
  assert.equal((await (await get('/api/sessions')).json()).sessions.length, 3)
  state.u2ListFails = true // its profile was closed after the accounts were read
  state.u2Open = false
  await new Promise((resolve) => setTimeout(resolve, 2100)) // session cache
  assert.equal((await get('/api/sessions')).status, 502)
  await new Promise((resolve) => setTimeout(resolve, 2100))
  const { sessions } = await (await get('/api/sessions')).json()
  assert.deepEqual([...new Set(sessions.map((s) => s.account))], ['u0'])
})

test('model validation', async (t) => {
  const { post, calls } = await startFake(t)
  for (const model of ['nomodel', 'a/b/c', 'a/ b', '', "a/b'); process.exit(); ('", 5, ['a/b'], { a: 1 }]) {
    assert.equal((await post('/api/sessions', { prompt: 'hi', model })).status, 400, JSON.stringify(model))
    assert.equal((await post('/api/sessions/u0-new-session/model', { model })).status, 400, JSON.stringify(model))
  }
  assert.equal((await post('/api/sessions/u0-new-session/model', {})).status, 400)
  assert.ok(!calls.some((c) => c[0] === 'exec' || String(c.at(-1)).includes('sessions.update')))
})

test('a session starts on the picked account and model', async (t) => {
  const { post, calls } = await startFake(t)
  const res = await post('/api/sessions', { prompt: 'hi', effort: 'low', account: 'u2', model: 'prov/some-model:v1' })
  assert.deepEqual(await res.json(), { id: 'startedSession01' })
  assert.deepEqual(calls.find((c) => c[0] === 'exec'),
    ['exec', '--account', 'u2:q9', '--model', 'prov/some-model:v1', '--timeout', '5s', '--effort', 'low', '--permission', 'guard', '--', 'hi'])

  await post('/api/sessions', { prompt: 'hi' })
  const plain = calls.filter((c) => c[0] === 'exec')[1]
  assert.ok(plain.includes('u0:p1') && !plain.includes('--model'))
})

test('changing the model of a session keeps its other model settings', async (t) => {
  const { post, calls } = await startFake(t)
  assert.deepEqual(await (await post('/api/sessions/u2-mid-session/model', { model: 'other/big-model' })).json(), { ok: true })
  const call = calls.find((c) => String(c.at(-1)).includes('sessions.update'))
  assert.equal(call[2], 'u2:q9')
  assert.ok(call.at(-1).includes(`update('u2-mid-session', { model: {"provider":"other","modelId":"big-model","thinkingLevel":"low","fastMode":false} })`))
  assert.equal((await post('/api/sessions/unknownSession01/model', { model: 'other/big-model' })).status, 404)
})

test('models: defaults plus the models of recent sessions, no duplicates, cached', async (t) => {
  const { get, calls } = await startFake(t)
  const res = await get('/api/models?account=u0')
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), {
    default: 'prov/default-model',
    models: ['default-model', 'new-model', 'custom-model', 'old-model'].map((m) => ({ id: 'prov/' + m, name: m, group: 'prov' })),
  })
  const inspects = calls.filter((c) => c[1] === 'inspect')
  assert.deepEqual(inspects.map((c) => c[2]), ['u0-new-session', 'u0-old-session']) // only u0's sessions
  const before = calls.length
  assert.equal((await get('/api/models')).status, 200) // account defaults to u0
  assert.equal(calls.length, before)
})

test('a malformed URL gets 400 and does not stop the server', async (t) => {
  const { base } = await startFake(t)
  const status = (rawPath) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: new URL(base).port, path: rawPath }, (res) => resolve(res.statusCode)).on('error', reject)
  })
  assert.equal(await status('/%E0%A4%A'), 400)
  assert.equal(await status('//'), 400)
  assert.equal(await status('/api/%zz'), 400)
  assert.equal(await status('/..%2f..%2fbridge/server.js'), 404)
  assert.equal(await status('/api/health'), 403)
})

test('push subscribe: a bad subscription is a 400', async (t) => {
  const { post } = await startFake(t)
  const keys = { p256dh: 'a', auth: 'b' }
  assert.equal((await post('/api/push/subscribe', { subscription: { endpoint: 'http://example.com/x', keys } })).status, 400)
  assert.equal((await post('/api/push/subscribe', { subscription: { endpoint: 'not a url', keys } })).status, 400)
  assert.equal((await post('/api/push/subscribe', { subscription: { endpoint: 'https://example.com/x' } })).status, 400)
  assert.equal((await post('/api/push/subscribe', {})).status, 400)
})

test('models: the catalog file comes first, recent models it lacks are appended', async (t) => {
  const { get, dir } = await startFake(t)
  fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify({ u0: [{ id: 'prov/default-model', name: 'Default Model', group: 'Prov' }] }))
  const { models } = await (await get('/api/models')).json()
  assert.deepEqual(models[0], { id: 'prov/default-model', name: 'Default Model', group: 'Prov' })
  assert.deepEqual(models.map((m) => m.id).sort(), ['prov/custom-model', 'prov/default-model', 'prov/new-model', 'prov/old-model'])
})

// ---- round 3 ----

test('detail: limit is passed to the repl (default 60, max 600) and more is returned', async (t) => {
  const { get, calls } = await startFake(t)
  const res = await get('/api/sessions/u0-new-session')
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.more, true)
  assert.deepEqual(body.messages, [{ role: 'user', text: 'hi', ts: 1 }])
  assert.equal((await get('/api/sessions/u0-new-session?limit=200')).status, 200)
  assert.equal((await get('/api/sessions/u0-new-session?limit=5000')).status, 200)
  const limits = calls.filter((c) => String(c.at(-1)).includes('sessions.messages')).map((c) => /limit = (\d+);/.exec(c.at(-1))[1])
  assert.deepEqual(limits, ['60', '200', '600'])
  for (const bad of ['0', '-1', '1.5', 'abc', '1;x']) assert.equal((await get('/api/sessions/u0-new-session?limit=' + bad)).status, 400, bad)
})

test('a child session that is in no list is found by asking each account', async (t) => {
  const { get, post, calls } = await startFake(t)
  const res = await get('/api/sessions/u2-run-session') // first request of a fresh bridge
  assert.equal(res.status, 200)
  assert.equal((await res.json()).session.account, 'u2')
  assert.deepEqual(await (await post('/api/sessions/u2-run-session/read')).json(), { ok: true })
  assert.equal(calls.find((c) => String(c.at(-1)).includes('markRead'))[2], 'u2:q9')
  const asked = calls.filter((c) => String(c.at(-1)).includes('trigger?.type')).map((c) => c[2])
  assert.deepEqual([...new Set(asked)].sort(), ['u0:p1', 'u2:q9']) // only connected accounts
  for (const url of ['/api/sessions/unknownSession01', '/api/sessions/unknownSession01/screenshot']) {
    const miss = await get(url)
    assert.equal(miss.status, 404)
    assert.deepEqual(await miss.json(), { error: 'Session not found' })
  }
  assert.equal((await post('/api/sessions/unknownSession01/archive')).status, 404)
})

test('screenshot: jpeg of the session tab, 404 when there is no tab or it is gone', async (t) => {
  const { get, calls, state } = await startFake(t)
  const res = await get('/api/sessions/u2-run-session/screenshot')
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'image/jpeg')
  assert.equal(Buffer.from(await res.arrayBuffer()).toString(), 'jpeg bytes')
  const call = calls.find((c) => String(c.at(-1)).includes('attachBrowserTab'))
  assert.equal(call[2], 'u2:q9')
  assert.ok(call.at(-1).includes('attachBrowserTab("TARGET0123456789")'))

  state.tabOpen = false
  const gone = await get('/api/sessions/u2-run-session/screenshot')
  assert.equal(gone.status, 404)
  assert.deepEqual(await gone.json(), { error: 'no tab' })

  const before = calls.filter((c) => String(c.at(-1)).includes('attachBrowserTab')).length
  state.tabOpen = true
  for (const id of ['u0-new-session', 'u2-mid-session']) { // no tab id at all; only the owner's tab
    const none = await get(`/api/sessions/${id}/screenshot`)
    assert.equal(none.status, 404, id)
    assert.deepEqual(await none.json(), { error: 'no tab' })
  }
  assert.equal(calls.filter((c) => String(c.at(-1)).includes('attachBrowserTab')).length, before)
})

test('memory search: max 10 results with four fields, 400 without q', async (t) => {
  const { get, calls } = await startFake(t)
  const res = await get('/api/memory?account=u2&q=' + encodeURIComponent(' --json; rm x '))
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { results: [{ path: 'notes/a.md', title: 'A', excerpt: 'text', score: 0.5 }] })
  assert.deepEqual(calls.find((c) => c[0] === 'memory'), ['memory', 'search', '--account', 'u2:q9', '--json', '-n', '10', '--', '--json; rm x'])
  for (const url of ['/api/memory', '/api/memory?q=', '/api/memory?q=%20', '/api/memory?q=' + 'x'.repeat(201)]) assert.equal((await get(url)).status, 400, url)
  assert.equal((await get('/api/memory?q=a&account=u1')).status, 400)
})

test('memory file: text of a memory file, 404 when it does not exist, 400 for a bad path', async (t) => {
  const { get, calls } = await startFake(t)
  const res = await get('/api/memory/file?path=notes%2Fa.md')
  assert.deepEqual(await res.json(), { path: 'notes/a.md', text: '# A\n' })
  assert.deepEqual(calls.find((c) => c[1] === 'show'), ['memory', 'show', '--account', 'u0:p1', '--', 'notes/a.md'])
  assert.equal((await get('/api/memory/file?path=notes%2Fnone.md')).status, 404)
  const shows = calls.filter((c) => c[1] === 'show').length
  for (const bad of ['', '../x.md', 'a/../b.md', '/etc/x.md', '-x.md', '.hidden.md', 'notes/a.txt', 'a.md;ls', 'a\nb.md']) {
    assert.equal((await get('/api/memory/file?path=' + encodeURIComponent(bad))).status, 400, bad)
  }
  assert.equal(calls.filter((c) => c[1] === 'show').length, shows)
})

// ---- routine retry ----

const sessionCalls = (calls) => calls.filter((c) => c[0] === 'session' && ['resume', 'steer', 'queue'].includes(c[1])).map((c) => c[1])

test('routine retry is off by default: resume, steer and queue on a routine run are 403', async (t) => {
  const { get, post, calls } = await startFake(t)
  assert.deepEqual((await (await get('/api/health')).json()).features, { routineRetry: false })
  for (const action of ['resume', 'steer', 'queue']) {
    const res = await post(`/api/sessions/u2-run-session/${action}`, { prompt: 'again' })
    assert.equal(res.status, 403, action)
    assert.deepEqual(await res.json(), { error: 'routine retry is disabled' })
  }
  assert.deepEqual(sessionCalls(calls), [])

  // other sessions are not affected: a listed one and a child session that is not a routine run
  for (const id of ['u0-new-session', 'u2-sub-session']) {
    for (const action of ['resume', 'steer', 'queue']) {
      assert.deepEqual(await (await post(`/api/sessions/${id}/${action}`, { prompt: 'go on' })).json(), { ok: true }, id + ' ' + action)
    }
  }
  assert.deepEqual(sessionCalls(calls), ['resume', 'steer', 'queue', 'resume', 'steer', 'queue'])

  const { routines } = await (await get('/api/routines?account=u2')).json()
  assert.equal(routines.length, 2)
  assert.ok(routines.every((r) => !('permissionMode' in r)))
  assert.ok(!calls.some((c) => c[1] === 'inspect' && c[2] === 'u2-run-session'))
})

test('routine retry switched on in config.json: retry works and routines carry the permission mode', async (t) => {
  const { get, post, calls } = await startFake(t, { allowRoutineRetry: true })
  assert.deepEqual((await (await get('/api/health')).json()).features, { routineRetry: true })
  for (const action of ['resume', 'steer', 'queue']) {
    assert.deepEqual(await (await post(`/api/sessions/u2-run-session/${action}`, { prompt: 'again' })).json(), { ok: true }, action)
  }
  assert.deepEqual(sessionCalls(calls), ['resume', 'steer', 'queue'])
  assert.deepEqual(calls.find((c) => c[1] === 'resume'), ['session', 'resume', '--account', 'u2:q9', '--timeout', '5s', 'u2-run-session', '--', 'again'])

  const { routines } = await (await get('/api/routines?account=u2')).json()
  assert.deepEqual(routines.map((r) => [r.id, r.lastRunSessionId, r.permissionMode]), [
    ['routine-1', 'u2-run-session', 'full-access'],
    ['routine-2', null, null],
  ])
})

test('only allowRoutineRetry: true switches retry on', async (t) => {
  const { post } = await startFake(t, { allowRoutineRetry: 'yes' })
  assert.equal((await post('/api/sessions/u2-run-session/resume', { prompt: 'again' })).status, 403)
})

test('file: only images in an Aside session folder under the real home directory', async (t) => {
  const { get, calls } = await startFake(t)
  const inHome = (rel) => '/api/file?path=' + encodeURIComponent(path.join(os.homedir(), rel))
  const res = await get(inHome('.aside/u/2/sessions/u2-mid-session/out/chart.png'))
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'image/png')
  const reads = () => calls.filter((c) => String(c.at(-1)).includes('fs.readFile')).length
  assert.equal(reads(), 1)
  for (const bad of [
    inHome('.aside/u/2/sessions/u2-mid-session/out/notes.txt'),
    inHome('.aside/u/2/sessions/u2-mid-session/../../secret.png'),
    inHome('.aside/u/2/memory/a.png'),
    inHome('Documents/a.png'),
    '/api/file?path=' + encodeURIComponent('/home/other/.aside/u/2/sessions/u2-mid-session/a.png'),
    '/api/file?path=' + encodeURIComponent('x' + path.join(os.homedir(), '.aside/u/2/sessions/u2-mid-session/a.png')),
  ]) assert.equal((await get(bad)).status, 400, bad)
  assert.equal(reads(), 1)
})
