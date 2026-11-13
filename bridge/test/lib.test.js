import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  ID_RE, mapSessionList, filterSessions, parseExecId, unwrapRepl, queuedTexts, diffSessions, transitions,
} from '../lib.js'

const fixture = (name) => fs.readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf8')
const sessions = () => mapSessionList(JSON.parse(fixture('session-list.json')), unwrapRepl(fixture('repl-suspended.json')))
const byId = (id) => sessions().find((s) => s.id === id)

test('session list maps to the contract Session shape', () => {
  assert.deepEqual(byId('aaaaaaaaaaaaaaa1'), {
    id: 'aaaaaaaaaaaaaaa1',
    title: 'Compare two laptops',
    status: 'running',
    unread: false,
    source: 'cli',
    projectId: null,
    createdAt: '2026-01-02T10:00:00.000Z',
    updatedAt: '2026-01-02T10:05:00.000Z',
  })
})

test('status mapping', () => {
  assert.equal(byId('aaaaaaaaaaaaaaa1').status, 'running')
  assert.equal(byId('aaaaaaaaaaaaaaa2').status, 'done')
  assert.equal(byId('aaaaaaaaaaaaaaa3').status, 'failed')
  assert.equal(byId('aaaaaaaaaaaaaaa4').status, 'stopped')
  assert.equal(byId('aaaaaaaaaaaaaaa5').status, 'waiting') // idle but suspended
})

test('a turn aborted by a dead CLI process counts as failed', () => {
  const raw = { id: 'aaaaaaaaaaaaaaa8', title: 't', status: 'aborted', readAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }
  assert.equal(mapSessionList({ sessions: [raw] }, [])[0].status, 'failed')
})

test('unread is readAt < updatedAt, never while running', () => {
  assert.equal(byId('aaaaaaaaaaaaaaa1').unread, false) // running
  assert.equal(byId('aaaaaaaaaaaaaaa2').unread, true)
  assert.equal(byId('aaaaaaaaaaaaaaa3').unread, false) // readAt == updatedAt
})

test('missing trigger gives source null', () => {
  assert.equal(byId('aaaaaaaaaaaaaaa3').source, null)
  assert.equal(byId('aaaaaaaaaaaaaaa2').projectId, 'proj1')
})

test('list is newest first', () => {
  assert.deepEqual(sessions().map((s) => s.id.at(-1)), ['5', '1', '2', '3', '4'])
})

test('transient sessions of our own repl calls are dropped', () => {
  assert.equal(byId('aaaaaaaaaaaaaaa7'), undefined)
})

test('filters', () => {
  const ids = (filter, limit = 100) => filterSessions(sessions(), filter, limit).map((s) => s.id.at(-1))
  assert.deepEqual(ids('all'), ['5', '1', '2', '3', '4'])
  assert.deepEqual(ids('running'), ['1'])
  assert.deepEqual(ids('waiting'), ['5'])
  assert.deepEqual(ids('done'), ['2', '3', '4'])
  assert.deepEqual(ids('unread'), ['2'])
  assert.deepEqual(ids('all', 2), ['5', '1'])
})

test('exec stderr id regex', () => {
  assert.equal(parseExecId(fixture('exec-stderr.txt')), 'Zx9_abc-DEF12345')
  assert.equal(parseExecId('created new session: Zx9_abcDEF123456\n'), 'Zx9_abcDEF123456')
  assert.equal(parseExecId('Error: daemon is not running\n'), null)
  assert.equal(parseExecId(''), null)
})

test('repl JSON unwrap', () => {
  assert.deepEqual(unwrapRepl(fixture('repl-suspended.json')), [{ id: 'aaaaaaaaaaaaaaa5', suspension: { kind: 'question' } }])
  assert.throws(() => unwrapRepl(fixture('repl-error.json')), /^Error: Error: Session not found: aaaaaaaaaaaaaaa9$/)
})

test('session id validation', () => {
  assert.ok(ID_RE.test('Zx9_abcDEF123456'))
  assert.ok(!ID_RE.test('short'))
  assert.ok(!ID_RE.test("abcdefgh');process.exit()//"))
  assert.ok(!ID_RE.test('../../etc/passwd'))
})

test('queued texts keep only user prompts', () => {
  assert.deepEqual(
    queuedTexts([
      { role: 'user', content: [{ type: 'text', text: 'then do this' }], timestamp: 1 },
      { role: 'system-message', content: 'internal', timestamp: 2 },
    ]),
    ['then do this'],
  )
})

test('diff: changed, new and removed sessions', () => {
  const prev = sessions()
  const cur = sessions()
    .filter((s) => s.id !== 'aaaaaaaaaaaaaaa4') // archived
    .map((s) => (s.id === 'aaaaaaaaaaaaaaa1' ? { ...s, status: 'done', unread: true } : s))
  cur.push({ ...prev[0], id: 'aaaaaaaaaaaaaaa6' })
  const diff = diffSessions(prev, cur)
  assert.deepEqual(diff.changed.map((s) => s.id), ['aaaaaaaaaaaaaaa1', 'aaaaaaaaaaaaaaa6'])
  assert.deepEqual(diff.removed, ['aaaaaaaaaaaaaaa4'])
})

test('diff: nothing changed', () => {
  assert.deepEqual(diffSessions(sessions(), sessions()), { changed: [], removed: [] })
})

test('transitions that deserve a push', () => {
  const s = (id, status) => ({ id, status })
  const prev = [s('a', 'running'), s('b', 'running'), s('c', 'running'), s('d', 'done'), s('e', 'waiting'), s('f', 'running')]
  const cur = [s('a', 'done'), s('b', 'failed'), s('c', 'stopped'), s('d', 'waiting'), s('e', 'waiting'), s('f', 'running'), s('g', 'done')]
  assert.deepEqual(
    transitions(prev, cur).map((t) => [t.session.id, t.kind]),
    [['a', 'done'], ['b', 'failed'], ['d', 'waiting']],
  )
})

test('no push for the sessions of an account that just connected', () => {
  const s = (id, status, account) => ({ id, status, account })
  const prev = [s('a', 'running', 'u0')]
  const cur = [s('a', 'done', 'u0'), s('b', 'waiting', 'u0'), s('c', 'waiting', 'u3')]
  assert.deepEqual(transitions(prev, cur).map((t) => [t.session.id, t.kind]), [['a', 'done'], ['b', 'waiting']])
})

// ---- push for a turn that started and ended between two polls ----

const T1 = '2026-01-02T10:00:00.000Z'
const T2 = '2026-01-02T10:00:09.000Z'
const ses = (id, status, updatedAt, more = {}) => ({ id, status, unread: true, account: 'u0', createdAt: T1, updatedAt, ...more })
const kinds = (prev, cur) => transitions(prev, cur).map((t) => [t.session.id, t.kind])

test('quick turn: a finished session gets a push when it is unread and was updated since the last poll', () => {
  const prev = [ses('a', 'done', T1), ses('b', 'done', T1), ses('c', 'stopped', T1), ses('w', 'waiting', T1)]
  const cur = [ses('a', 'done', T2), ses('b', 'failed', T2), ses('c', 'stopped', T2), ses('w', 'done', T2)]
  assert.deepEqual(kinds(prev, cur), [['a', 'done'], ['b', 'failed'], ['w', 'done']])
})

test('quick turn: a session created and finished since the last poll gets a push', () => {
  const prev = [ses('a', 'done', T1)]
  const cur = [ses('a', 'done', T1), ses('n', 'done', T2, { createdAt: T2 }), ses('f', 'failed', T2, { createdAt: T1 })]
  assert.deepEqual(kinds(prev, cur), [['n', 'done'], ['f', 'failed']]) // f was created in the same second as the last update
})

test('quick turn: no push when the owner only marks a session unread', () => {
  const prev = [ses('a', 'done', T1, { unread: false })]
  assert.deepEqual(kinds(prev, [ses('a', 'done', T1)]), [])
})

test('quick turn: no push for an update the owner has already read', () => {
  const prev = [ses('a', 'done', T1)]
  assert.deepEqual(kinds(prev, [ses('a', 'done', T2, { unread: false })]), [])
})

test('quick turn: no push for archive and unarchive', () => {
  const old = '2026-01-01T08:00:00.000Z'
  const a = ses('a', 'done', T1)
  const b = ses('b', 'done', old, { createdAt: old })
  assert.deepEqual(kinds([a, b], [a]), []) // b archived
  assert.deepEqual(kinds([a], [a, b]), []) // b unarchived
  assert.deepEqual(kinds([a], [a, { ...b, updatedAt: T2 }]), []) // also when unarchiving touches updatedAt
})

test('quick turn: no push for an account that just connected', () => {
  const prev = [ses('a', 'done', T1)]
  const cur = [ses('a', 'done', T1), ses('x', 'done', T2, { account: 'u3', createdAt: T2 })]
  assert.deepEqual(kinds(prev, cur), [])
})

test('quick turn: one push only when the normal running -> done path already sent it', () => {
  const running = ses('a', 'running', T1, { unread: false })
  const done = ses('a', 'done', T2)
  assert.deepEqual(kinds([running], [done]), [['a', 'done']])
  assert.deepEqual(kinds([done], [done]), [])
  assert.deepEqual(kinds([ses('a', 'running', T2, { unread: false })], [done]), [['a', 'done']]) // same second: still one
})
