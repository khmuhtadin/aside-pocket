// Pure helpers: parsing Aside CLI output and diffing session snapshots.

export const ID_RE = /^[A-Za-z0-9_-]{8,40}$/
export const EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

// aborted = the CLI process that ran the turn died (error "Request aborted")
const STATUS = { running: 'running', suspended: 'waiting', idle: 'done', errored: 'failed', aborted: 'failed', interrupted: 'stopped' }

// true for any non-empty value ({} and [] count as empty)
export function hasValue(v) {
  return Boolean(v) && (typeof v !== 'object' || Object.keys(v).length > 0)
}

// Aside session (from `session list` / `session inspect`) -> contract Session
export function mapSession(raw, suspension) {
  const status = hasValue(suspension) ? 'waiting' : STATUS[raw.status]
  return {
    id: raw.id,
    title: raw.title,
    status,
    unread: status !== 'running' && new Date(raw.readAt) < new Date(raw.updatedAt),
    source: raw.trigger?.source ?? null,
    projectId: raw.projectId ?? null,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  }
}

const REPL_TITLE = 'Aside CLI REPL'

// `session list --json` output + [{id, suspension}] -> [Session] newest first
export function mapSessionList(listJson, suspended) {
  const byId = new Map(suspended.map((s) => [s.id, s.suspension]))
  return listJson.sessions
    .filter((raw) => !(raw.ephemeral && raw.title === REPL_TITLE)) // our own `aside repl` calls show up for a moment
    .map((raw) => mapSession(raw, byId.get(raw.id)))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
}

export function filterSessions(sessions, filter, limit) {
  const keep = {
    all: () => true,
    running: (s) => s.status === 'running',
    waiting: (s) => s.status === 'waiting',
    done: (s) => ['done', 'failed', 'stopped'].includes(s.status),
    unread: (s) => s.unread,
  }[filter]
  return sessions.filter(keep).slice(0, limit)
}

// stderr of `aside exec` -> session id or null
export function parseExecId(stderr) {
  const m = /created new session: ([A-Za-z0-9_-]{8,40})/.exec(stderr)
  return m ? m[1] : null
}

// stdout of `aside repl --json` whose snippet console.logs one JSON value -> that value
export function unwrapRepl(stdout) {
  const { run } = JSON.parse(stdout)
  if (run.error) throw new Error(run.error.split('\n')[0])
  return JSON.parse(run.content.map((c) => c.text).join(''))
}

// queuedMessages of `session inspect` -> texts of the user's queued prompts
export function queuedTexts(queuedMessages) {
  return queuedMessages
    .filter((m) => m.role === 'user')
    .map((m) => m.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n'))
}

// previous and current [Session] -> what to send in the SSE `sessions` event
export function diffSessions(prev, cur) {
  const before = new Map(prev.map((s) => [s.id, JSON.stringify(s)]))
  const ids = new Set(cur.map((s) => s.id))
  return {
    changed: cur.filter((s) => before.get(s.id) !== JSON.stringify(s)),
    removed: prev.filter((s) => !ids.has(s.id)).map((s) => s.id),
  }
}

// previous and current [Session] -> [{session, kind}] worth a push notification
export function transitions(prev, cur) {
  const before = new Map(prev.map((s) => [s.id, s]))
  const accounts = new Set(prev.map((s) => s.account))
  const newest = prev.map((s) => s.updatedAt).sort().at(-1)
  const out = []
  for (const session of cur) {
    if (!accounts.has(session.account)) continue // account just connected: its sessions are old news
    const old = before.get(session.id)
    if (session.status === 'waiting' && old?.status !== 'waiting') out.push({ session, kind: 'waiting' })
    if (session.status !== 'done' && session.status !== 'failed') continue
    // a turn that started and ended between two polls: unread, and updated (or created) after the previous poll.
    // Marking unread keeps updatedAt; an unarchived session is not in prev but was created before prev's newest update.
    const quick = session.unread && (old ? session.updatedAt > old.updatedAt : session.createdAt >= newest)
    if (old?.status === 'running' || quick) out.push({ session, kind: session.status })
  }
  return out
}
