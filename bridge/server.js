// Aside Pocket bridge: HTTP API + static PWA files on 127.0.0.1, wrapping the Aside CLI.
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createCli } from './cli.js'
import { DATA_DIR, loadConfig } from './config.js'
import { redeemPairCode, checkToken } from './auth.js'
import {
  ID_RE, EFFORTS, hasValue, mapSession, mapSessionList, filterSessions,
  parseExecId, unwrapRepl, queuedTexts, diffSessions, transitions,
} from './lib.js'

const WEB_DIR = path.join(import.meta.dirname, '..', 'web')
const VERSION = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8')).version
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

// Fixed repl snippets. __ID__ is replaced with a session id that already passed ID_RE.
const REPL_SUSPENDED = `
const has = (v) => Boolean(v) && (typeof v !== 'object' || Object.keys(v).length > 0);
console.log(JSON.stringify(aside.sessions.list({ limit: 200 }).filter((s) => has(s.suspension)).map((s) => ({ id: s.id, suspension: s.suspension }))));`

const REPL_DETAIL = `
const id = '__ID__', limit = __LIMIT__;
// newest first, 200 per call is the most Aside gives; about 2.5 raw messages make one shown message
let raw = [], page;
do {
  page = await aside.sessions.messages(id, { limit: 200, order: 'desc', offset: raw.length });
  raw = raw.concat(page);
} while (page.length === 200 && raw.length < limit * 4);
const unread = page.length === 200 && (await aside.sessions.messages(id, { limit: 1, order: 'desc', offset: raw.length })).length > 0;
raw.reverse();
const failed = new Set(raw.filter((m) => m.role === 'toolResult' && m.isError).map((m) => m.toolCallId));
const text = (c) => String(typeof c === 'string' ? c : c.filter((p) => p.type === 'text').map((p) => p.text).join('\\n')).slice(0, 4000);
const out = [];
for (const m of raw) {
  if (m.role === 'user' || m.role === 'steering') {
    // a steer is stored twice (as steering and as user); show it once
    const last = out[out.length - 1];
    const t = text(m.content);
    if (t && !(last && last.role === 'user' && last.text === t)) out.push({ role: 'user', text: t, ts: m.timestamp });
  }
  if (m.role === 'assistant') {
    if (text(m.content)) out.push({ role: 'assistant', text: text(m.content), ts: m.timestamp });
    for (const p of m.content) {
      if (p.type !== 'toolCall') continue;
      const title = String(p.arguments?.title || p.name).slice(0, 200);
      out.push({ role: 'tool', text: title, tool: { name: p.name, title, isError: failed.has(p.id) }, ts: m.timestamp });
    }
  }
}
console.log(JSON.stringify({ suspension: aside.sessions.get(id).suspension ?? null, messages: out.slice(-limit), more: unread || out.length > limit }));`

// is the session a routine run? Throws "Session not found" for an id the account does not have
const REPL_IS_ROUTINE = `console.log(JSON.stringify(aside.sessions.get('__ID__').trigger?.type === 'routine'));`

// JPEG of the tab a session's agent is using. __TARGET__ is a JSON string that passed TARGET_RE. null = tab is gone.
// The screenshot is always at device pixels; only the quality can be lowered.
const REPL_SHOT = `
let shot = null;
try { await attachBrowserTab(__TARGET__); shot = 1; } catch {}
if (shot) shot = await page.screenshot({ type: 'jpeg', quality: 60 });
if (shot && shot.length > 400000) shot = await page.screenshot({ type: 'jpeg', quality: 30 });
console.log(JSON.stringify(shot && shot.toString('base64')));`
const TARGET_RE = /^[A-Za-z0-9_-]{8,64}$/

// the Aside folder of this user as regex source; only used to recognise paths the CLI reports, the bridge never reads it
const ASIDE_DIR_RE = path.join(os.homedir(), '.aside').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const MEMORY_DIR_RE = new RegExp('^' + ASIDE_DIR_RE + '/u/\\d+/memory/') // `memory search` gives absolute paths, `memory show` wants relative ones
const MEMORY_RE = /^[A-Za-z0-9_][A-Za-z0-9 _.\/-]*\.md$/ // path of a memory file, relative to the account's memory folder

// an image an agent saved in its session folder, read through the CLI. __PATH__ is a JSON string that passed FILE_RE.
const REPL_FILE = `const b = await fs.readFile(__PATH__); if (b.length > 8000000) throw new Error('file too large'); console.log(JSON.stringify(Buffer.from(b).toString('base64')));`
const FILE_RE = new RegExp('^' + ASIDE_DIR_RE + '/u/(\\d{1,2})/sessions/[A-Za-z0-9_-]+/[A-Za-z0-9 _./-]+\\.(png|jpe?g|gif|webp)$')

const REPL_MARK_READ = `await aside.sessions.markRead('__ID__'); console.log('true');`

const REPL_PROJECTS = `console.log(JSON.stringify(aside.projects.list().map((p) => ({ id: p.id, name: p.name, color: p.color || null }))))`

// models named in the account's Aside settings (read-only)
const REPL_MODELS = `
const st = aside.settings.getAll();
console.log(JSON.stringify({ default: st.defaultModel, others: [...Object.values(st.modelCategories || {}), ...(st.customModels || [])] }));`

// __MODEL__ is JSON built by the bridge from a validated provider/model pair. Only the model is changed.
const REPL_SET_MODEL = `await aside.sessions.update('__ID__', { model: __MODEL__ }); console.log('true');`

const WAIT = '5s' // how long `exec` and `session resume` stay attached to a turn

const MODEL_RE = /^([A-Za-z0-9._-]{1,40})\/([A-Za-z0-9._:-]{1,80})$/
const parseModel = (model) => (typeof model === 'string' ? MODEL_RE.exec(model) : null) // -> [, provider, modelId] or null

const REPL_ROUTINES = `
// a routine run is a child session of the routine's parent session
console.log(JSON.stringify(aside.routines.list({ limit: 50 }).map((r) => {
  const runs = r.parentSessionId ? aside.sessions.childSessions(r.parentSessionId).filter((k) => k.routineId === r.id) : [];
  const last = runs.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
  return {
    id: r.id, name: r.name, status: r.status, rrule: r.rrule ?? null, nextRunAt: r.nextRunAt ?? null,
    lastRunStatus: r.lastRunStatus ?? null, projectId: r.projectId ?? null, parentSessionId: r.parentSessionId ?? null,
    lastRunSessionId: last ? last.id : null,
  };
})));`

function fail(status, message) {
  return Object.assign(new Error(message), { status })
}

async function daemonHealth() {
  try {
    const res = await fetch('http://127.0.0.1:21420/health', { signal: AbortSignal.timeout(2000) })
    const { version, ready, status } = await res.json()
    return { version, ready, status }
  } catch {
    return null // daemon is down
  }
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) reject(fail(413, 'body too large')) // the rest is read and dropped
      else chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJson(req) {
  const raw = await readBody(req, 1024 * 1024)
  try {
    const body = JSON.parse(raw)
    if (body && typeof body === 'object') return body
  } catch {}
  throw fail(400, 'invalid JSON body')
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? '/index.html' : decodeURIComponent(pathname)
  const file = path.join(WEB_DIR, path.normalize('/' + rel))
  if (!file.startsWith(WEB_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    return res.end('not found')
  }
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  })
  fs.createReadStream(file).pipe(res)
}

export function createApp({ dir = DATA_DIR, run, start, health = daemonHealth } = {}) {
  const config = loadConfig(dir)
  const aside = createCli(config.asideCli)
  run = run || aside.run
  start = start || aside.start
  const streams = new Set() // open SSE responses
  const children = new Set() // exec/resume processes that are still attached
  let cache = { at: 0, promise: null }
  let accountsCache = { at: 0, promise: null }
  const selectors = new Map() // "u3" -> "u3:<id of its open browser profile>", what the CLI gets as --account
  const sel = (account) => selectors.get(account)
  const modelsCache = new Map() // account -> {at, promise}
  let prev = null // last polled [Session]
  let lastHealth = ''
  let pollTimer = null
  let polling = false
  let pollAgain = false
  let caffeinate = null

  // ---- Aside CLI calls ----

  async function cliOk(args) {
    const out = await run(args)
    if (!out.ok) {
      const message = out.stderr.trim().split('\n').pop().slice(0, 300) || 'aside CLI failed'
      throw fail(/not found/i.test(message) ? 404 : 502, message)
    }
    return out.stdout
  }

  const cliJson = async (args) => JSON.parse(await cliOk(args))

  async function repl(code, account) {
    const out = await run(['repl', '--account', sel(account), '--json', code])
    if (!out.stdout) throw fail(502, out.stderr.trim().split('\n').pop().slice(0, 300) || 'aside repl failed')
    try {
      return unwrapRepl(out.stdout)
    } catch (e) {
      throw fail(/not found/i.test(e.message) ? 404 : 502, e.message.slice(0, 300))
    }
  }

  // signed-in Aside accounts on this Mac as [{id: "u0", name, email, connected}], cached for 60 s.
  // connected = its browser profile is open in Aside; the CLI cannot reach the others.
  function getAccounts() {
    if (Date.now() - accountsCache.at > 60000) {
      accountsCache = {
        at: Date.now(),
        promise: cliJson(['account', 'list', '--json'])
          .then((j) => Promise.all(j.accounts
            .filter((a) => a.authStatus === 'active')
            .map(async (a) => {
              const id = 'u' + a.id
              const { profiles } = await cliJson(['host', 'profiles', '--account', id, '--json'])
              const open = profiles.find((p) => p.connected)
              if (open) selectors.set(id, id + ':' + open.profileId)
              return { id, name: a.name, email: a.email ?? null, connected: Boolean(open) }
            })))
          .catch((e) => {
            accountsCache.at = 0
            throw e
          }),
      }
    }
    return accountsCache.promise
  }

  async function checkAccount(account) {
    if (!(await getAccounts()).some((a) => a.id === account && a.connected)) throw fail(400, 'bad account')
    return account
  }

  async function accountSessions(account) {
    const [list, suspended] = await Promise.all([
      cliJson(['session', 'list', '--account', sel(account), '--json']),
      repl(REPL_SUSPENDED, account),
    ])
    return mapSessionList(list, suspended).map((s) => ({ ...s, account }))
  }

  // non-archived sessions of every account as contract Sessions, newest first, cached for 2 s
  function getSessions() {
    if (Date.now() - cache.at > 2000) {
      cache = {
        at: Date.now(),
        promise: getAccounts()
          .then((accounts) => Promise.all(accounts.filter((a) => a.connected).map((a) => accountSessions(a.id))))
          .then((lists) => lists.flat().sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)))
          .catch((e) => {
            accountsCache.at = 0 // a profile may have been closed: look again who is connected
            throw e
          }),
      }
    }
    return cache.promise
  }

  // models the account can pick from: its Aside defaults plus the ones its 15 latest sessions used. Cached 10 min.
  // Aside has no command that lists every available model, so the app also accepts a typed provider/model.
  function getModels(account) {
    const hit = modelsCache.get(account)
    if (hit && Date.now() - hit.at < 600000) return hit.promise
    const promise = (async () => {
      const [settings, sessions] = await Promise.all([repl(REPL_MODELS, account), getSessions()])
      const recent = sessions.filter((s) => s.account === account).slice(0, 15)
      const used = await Promise.all(recent.map((s) =>
        cliJson(['session', 'inspect', s.id, '--account', sel(account), '--json']).then((j) => j.session.model, () => null)))
      const name = (m) => m.provider + '/' + m.modelId
      const all = [settings.default, ...settings.others, ...used].filter((m) => m && m.provider && m.modelId).map(name)
      // full list built by bridge/catalog.js, as [{id, name, group}]; recently used models it lacks are added bare
      const file = path.join(dir, 'models.json')
      const catalog = (fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8'))[account]) || []
      const known = new Set(catalog.map((m) => m.id))
      const extra = [...new Set(all)].filter((id) => !known.has(id)).map((id) => ({ id, name: id.split('/')[1], group: id.split('/')[0] }))
      return { default: name(settings.default), models: [...catalog, ...extra] }
    })()
    promise.catch(() => modelsCache.delete(account))
    modelsCache.set(account, { at: Date.now(), promise })
    return promise
  }

  // which account a session belongs to
  async function accountOf(id) {
    const listed = (await getSessions()).find((s) => s.id === id)
    if (listed) return listed.account
    // routine runs, other child sessions and sessions newer than the cached list: ask every connected account
    const accounts = (await getAccounts()).filter((a) => a.connected)
    const has = await Promise.all(accounts.map((a) => repl(REPL_IS_ROUTINE.replace('__ID__', id), a.id).then(() => true, () => false)))
    if (!has.includes(true)) throw fail(404, 'Session not found')
    return accounts[has.indexOf(true)].id
  }

  async function getHealth() {
    const [aside, sessions] = await Promise.all([health(), getSessions().catch(() => [])])
    return {
      ok: true,
      version: VERSION,
      features: { routineRetry: config.allowRoutineRetry === true },
      aside,
      running: sessions.filter((s) => s.status === 'running').length,
    }
  }

  async function getDetail(id, limit) {
    const account = await accountOf(id)
    const [inspect, extra] = await Promise.all([
      cliJson(['session', 'inspect', id, '--account', sel(account), '--json']),
      repl(REPL_DETAIL.replace('__ID__', id).replace('__LIMIT__', limit), account),
    ])
    const toolQuestion = inspect.session.toolState?.question
    const waiting = hasValue(extra.suspension) || hasValue(toolQuestion)
    return {
      session: { ...mapSession(inspect.session, extra.suspension), account },
      model: inspect.session.model ? inspect.session.model.provider + '/' + inspect.session.model.modelId : null,
      answer: inspect.answer ?? null,
      error: inspect.error ?? null,
      question: waiting ? { suspension: extra.suspension, toolQuestion: hasValue(toolQuestion) ? toolQuestion : null } : null,
      queued: queuedTexts(inspect.session.queuedMessages),
      messages: extra.messages,
      more: extra.more,
    }
  }

  // starts `aside exec` and resolves with the new session id. The CLI stops waiting after WAIT and the session keeps
  // running in Aside; a CLI process that is killed mid-turn (bridge restart) would abort the turn instead.
  function startSession(prompt, effort, account, model) {
    return new Promise((resolve, reject) => {
      const pick = model ? ['--model', model] : []
      const child = start(['exec', '--account', sel(account), ...pick, '--timeout', WAIT, '--effort', effort, '--permission', 'guard', '--', prompt])
      let stderr = ''
      const timer = setTimeout(() => reject(fail(502, 'Aside did not report a session id')), 15000)
      children.add(child)
      child.stdout.resume()
      child.stderr.on('data', (chunk) => {
        if (stderr.length > 4000) return
        stderr += chunk
        const id = parseExecId(stderr)
        if (id) {
          clearTimeout(timer)
          resolve(id)
        }
      })
      child.on('error', (e) => reject(fail(502, e.message)))
      child.on('close', () => {
        clearTimeout(timer)
        children.delete(child)
        reject(fail(502, stderr.trim().split('\n').pop().slice(0, 300) || 'aside exec exited without a session id'))
      })
    })
  }

  // `session resume` waits for the turn, so: ok unless it fails within 1.5 s
  function resumeSession(id, prompt, account) {
    return new Promise((resolve, reject) => {
      const child = start(['session', 'resume', '--account', sel(account), '--timeout', WAIT, id, '--', prompt])
      let stderr = ''
      const timer = setTimeout(resolve, 1500)
      children.add(child)
      child.stdout.resume()
      child.stderr.on('data', (chunk) => {
        if (stderr.length < 4000) stderr += chunk
      })
      child.on('error', (e) => reject(fail(502, e.message)))
      child.on('close', (code) => {
        clearTimeout(timer)
        children.delete(child)
        if (code === 0) return resolve()
        const message = stderr.trim().split('\n').pop().slice(0, 300) || 'aside resume failed'
        reject(fail(/not found/i.test(message) ? 404 : 502, message))
      })
    })
  }

  // ---- poller, SSE, push ----

  function emit(event, data) {
    for (const res of streams) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  async function notify({ session, kind }) {
    try {
      const inspect = await cliJson(['session', 'inspect', session.id, '--account', sel(session.account), '--json'])
      const label = { done: 'Finished', failed: 'Failed', waiting: 'Needs you' }[kind]
      const push = await import('./push.js')
      await push.sendPush({
        title: `${label}: ${session.title}`,
        body: (inspect.answer || inspect.error || '').slice(0, 120),
        sessionId: session.id,
        kind,
      })
      console.log(`push sent: ${kind} ${session.id}`)
    } catch (e) {
      console.error(`push failed: ${e.message}`)
    }
  }

  function setCaffeinate(on) {
    if (on && !caffeinate) caffeinate = spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' }) // -w: goes away with the bridge, even after a crash
    if (!on && caffeinate) {
      caffeinate.kill()
      caffeinate = null
    }
  }

  async function poll() {
    polling = true
    let running = 0
    try {
      cache.at = 0
      const cur = await getSessions()
      running = cur.filter((s) => s.status === 'running').length
      if (prev) {
        const diff = diffSessions(prev, cur)
        if (diff.changed.length || diff.removed.length) emit('sessions', diff)
        for (const t of transitions(prev, cur)) notify(t)
      }
      prev = cur
    } catch (e) {
      console.error(`poll failed: ${e.message}`)
    }
    const now = await getHealth()
    if (JSON.stringify(now) !== lastHealth) {
      lastHealth = JSON.stringify(now)
      emit('health', now)
    }
    setCaffeinate(running > 0)
    polling = false
    pollTimer = setTimeout(poll, pollAgain ? 0 : running ? 2000 : 15000)
    pollAgain = false
  }

  // poll right now (after the bridge itself changed something)
  function kick() {
    cache.at = 0
    if (pollTimer === null && !polling) return // poller not started (tests)
    if (polling) {
      pollAgain = true
      return
    }
    clearTimeout(pollTimer)
    poll()
  }

  const ping = setInterval(() => {
    for (const res of streams) res.write(': ping\n\n')
  }, 20000)
  ping.unref()

  // ---- HTTP ----

  async function api(req, res, url) {
    const route = `${req.method} ${url.pathname}`

    if (!(config.allowedLogins || []).includes(req.headers['tailscale-user-login'])) throw fail(403, 'forbidden')

    if (route === 'POST /api/pair') {
      const { code } = await readJson(req)
      const token = redeemPairCode(dir, code)
      if (!token) throw fail(401, 'wrong or expired code')
      return sendJson(res, 200, { token })
    }

    if (!checkToken(dir, req.headers.authorization)) throw fail(401, 'unauthorized')

    if (route === 'GET /api/health') return sendJson(res, 200, await getHealth())

    if (route === 'GET /api/sessions') {
      const filter = url.searchParams.get('filter') || 'all'
      const limit = Number(url.searchParams.get('limit') || 100)
      if (!['running', 'waiting', 'done', 'unread', 'all'].includes(filter)) throw fail(400, 'bad filter')
      if (!Number.isInteger(limit) || limit < 1) throw fail(400, 'bad limit')
      return sendJson(res, 200, { sessions: filterSessions(await getSessions(), filter, limit) })
    }

    if (route === 'POST /api/sessions') {
      const { prompt, effort = 'medium', account = 'u0', model } = await readJson(req)
      if (model != null && !parseModel(model)) throw fail(400, 'bad model')
      if (typeof prompt !== 'string' || !prompt.trim()) throw fail(400, 'prompt is required')
      if (!EFFORTS.includes(effort)) throw fail(400, 'bad effort')
      const id = await startSession(prompt, effort, await checkAccount(account), model)
      kick()
      return sendJson(res, 200, { id })
    }

    if (route === 'GET /api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' })
      res.write(`event: sessions\ndata: ${JSON.stringify({ changed: [], removed: [] })}\n\n`)
      streams.add(res)
      res.on('close', () => streams.delete(res))
      return
    }

    if (route === 'GET /api/file') {
      const file = url.searchParams.get('path') || ''
      const m = FILE_RE.exec(file)
      if (!m || file.includes('..')) throw fail(400, 'bad path')
      const data = await repl(REPL_FILE.replace('__PATH__', JSON.stringify(file)), await checkAccount('u' + m[1]))
      res.writeHead(200, { 'Content-Type': TYPES['.' + m[2]] || 'image/jpeg', 'Cache-Control': 'private, max-age=3600' })
      return res.end(Buffer.from(data, 'base64'))
    }

    if (route === 'GET /api/accounts') return sendJson(res, 200, { accounts: await getAccounts() })
    if (route === 'GET /api/models') {
      return sendJson(res, 200, await getModels(await checkAccount(url.searchParams.get('account') || 'u0')))
    }
    if (route === 'GET /api/projects' || route === 'GET /api/routines') {
      const account = await checkAccount(url.searchParams.get('account') || 'u0')
      if (route === 'GET /api/projects') return sendJson(res, 200, { projects: await repl(REPL_PROJECTS, account) })
      const routines = await repl(REPL_ROUTINES, account)
      // why the last run failed, for the routines that failed; and, when Retry is allowed, the permission mode a retry would run with
      const retry = config.allowRoutineRetry === true
      await Promise.all(routines.map(async (r) => {
        const errored = r.lastRunStatus === 'errored'
        if (retry) r.permissionMode = null
        if (!r.lastRunSessionId || !(errored || retry)) return
        const last = await cliJson(['session', 'inspect', r.lastRunSessionId, '--account', sel(account), '--json'])
        if (errored) r.lastRunError = last.error ?? null
        if (retry) r.permissionMode = last.session.permissionMode ?? null
      }))
      return sendJson(res, 200, { routines })
    }

    if (route === 'GET /api/memory' || route === 'GET /api/memory/file') {
      const account = await checkAccount(url.searchParams.get('account') || 'u0')
      if (route === 'GET /api/memory') {
        const q = (url.searchParams.get('q') || '').trim()
        if (!q || q.length > 200) throw fail(400, 'bad q')
        const found = await cliJson(['memory', 'search', '--account', sel(account), '--json', '-n', '10', '--', q])
        return sendJson(res, 200, { results: found.map((r) => ({ path: r.path.replace(MEMORY_DIR_RE, ''), title: r.title, excerpt: r.excerpt, score: r.score })) })
      }
      const file = url.searchParams.get('path') || ''
      if (!MEMORY_RE.test(file) || file.includes('..')) throw fail(400, 'bad path')
      const text = await cliOk(['memory', 'show', '--account', sel(account), '--', file])
      if (!text) throw fail(404, 'not found') // `memory show` prints nothing for a file that does not exist
      return sendJson(res, 200, { path: file, text })
    }

    if (route === 'GET /api/push/key') {
      const push = await import('./push.js')
      return sendJson(res, 200, { publicKey: push.publicKey() })
    }
    if (route === 'POST /api/push/subscribe') {
      const { subscription } = await readJson(req)
      if (!subscription?.endpoint) throw fail(400, 'subscription is required')
      const push = await import('./push.js')
      try {
        push.subscribe(subscription)
      } catch (e) {
        throw fail(400, e.message)
      }
      return sendJson(res, 200, { ok: true })
    }
    if (route === 'POST /api/push/test') {
      const push = await import('./push.js')
      const results = await push.sendPush({ title: 'Aside Pocket', body: 'Test notification', sessionId: '', kind: 'done' })
      return sendJson(res, 200, { results: results.map((r) => ({ status: r.status })) })
    }

    if (route === 'POST /api/voice') {
      const mime = req.headers['content-type'] || ''
      if (!mime.startsWith('audio/')) throw fail(415, 'Content-Type must be audio/*')
      const audio = await readBody(req, 10 * 1024 * 1024)
      const voice = await import('./voice.js')
      return sendJson(res, 200, { text: await voice.transcribe(audio, mime) })
    }

    const m = /^\/api\/sessions\/([^/]+)(?:\/([a-z]+))?$/.exec(url.pathname)
    if (m) {
      const [, id, action] = m
      if (!ID_RE.test(id)) throw fail(400, 'bad session id')

      if (req.method === 'GET' && !action) {
        const limit = Number(url.searchParams.get('limit') || 60)
        if (!Number.isInteger(limit) || limit < 1) throw fail(400, 'bad limit')
        return sendJson(res, 200, await getDetail(id, Math.min(limit, 600)))
      }
      const account = await accountOf(id)

      if (req.method === 'GET' && action === 'screenshot') {
        const { session } = await cliJson(['session', 'inspect', id, '--account', sel(account), '--json'])
        const target = session.activeTabTargetId
        // until the agent opens its own tab, activeTabTargetId is the owner's tab (the anchor): never show that one
        const own = TARGET_RE.test(target || '') && target !== session.browserBinding?.anchorTargetId
        const data = own ? await repl(REPL_SHOT.replace('__TARGET__', JSON.stringify(target)), account) : null
        if (!data) throw fail(404, 'no tab')
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' })
        return res.end(Buffer.from(data, 'base64'))
      }

      if (req.method === 'POST' && ['resume', 'steer', 'queue'].includes(action)) {
        // a routine run keeps the routine's permission mode, which may be full access
        if (config.allowRoutineRetry !== true && await repl(REPL_IS_ROUTINE.replace('__ID__', id), account)) {
          throw fail(403, 'routine retry is disabled')
        }
        const { prompt } = await readJson(req)
        if (typeof prompt !== 'string' || !prompt.trim()) throw fail(400, 'prompt is required')
        if (action === 'resume') await resumeSession(id, prompt, account)
        else await cliOk(['session', action, id, '--account', sel(account), '--', prompt])
        kick()
        return sendJson(res, 200, { ok: true })
      }

      if (req.method === 'POST' && ['stop', 'archive'].includes(action)) {
        await cliOk(['session', action, id, '--account', sel(account)])
        kick()
        return sendJson(res, 200, { ok: true })
      }

      if (req.method === 'POST' && action === 'model') {
        const m = parseModel((await readJson(req)).model)
        if (!m) throw fail(400, 'bad model')
        const { session } = await cliJson(['session', 'inspect', id, '--account', sel(account), '--json'])
        const model = { ...session.model, provider: m[1], modelId: m[2] }
        await repl(REPL_SET_MODEL.replace('__ID__', id).replace('__MODEL__', JSON.stringify(model)), account)
        return sendJson(res, 200, { ok: true })
      }

      if (req.method === 'POST' && action === 'read') {
        await repl(REPL_MARK_READ.replace('__ID__', id), account)
        kick()
        return sendJson(res, 200, { ok: true })
      }
    }

    throw fail(404, 'not found')
  }

  const server = http.createServer(async (req, res) => {
    let url
    try {
      url = new URL(req.url, 'http://localhost')
      decodeURIComponent(url.pathname)
    } catch {
      return sendJson(res, 400, { error: 'bad url' })
    }
    if (!url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res)
    try {
      await api(req, res, url)
      if (req.method !== 'GET') console.log(`${req.method} ${url.pathname} ${res.statusCode}`)
    } catch (e) {
      const status = e.status || 500
      console.error(`${req.method} ${url.pathname} ${status} ${e.message}`)
      if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'internal error' : e.message })
    }
  })

  function close() {
    clearTimeout(pollTimer)
    clearInterval(ping)
    setCaffeinate(false)
    for (const res of streams) res.end()
    server.close()
  }

  return { server, config, startPoller: poll, close }
}

// KEY=VALUE lines of <data dir>/env -> process.env (keeps secrets out of the LaunchAgent plist)
function loadEnvFile() {
  const file = path.join(DATA_DIR, 'env')
  if (!fs.existsSync(file)) return
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (m) process.env[m[1]] = m[2]
  }
}

if (import.meta.main) {
  loadEnvFile()
  const app = createApp()
  if (!app.config.asideCli || !app.config.allowedLogins) {
    console.error('config.json has no asideCli or allowedLogins. Run: aside-pocket setup')
    process.exit(1)
  }
  app.server.listen(app.config.port, '127.0.0.1', () => {
    console.log(`Aside Pocket bridge on http://127.0.0.1:${app.config.port}`)
    app.startPoller()
  })
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      app.close()
      process.exit(0)
    })
  }
}
