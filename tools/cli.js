// aside-pocket command line: setup, pair, status, logs, doctor, catalog, update, uninstall.
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import readline from 'node:readline/promises'
import { spawnSync } from 'node:child_process'
import { DATA_DIR, loadConfig, writeSecret, tailscaleStatus } from '../bridge/config.js'
import { createPairCode } from '../bridge/auth.js'
import { USAGE, stop, parseArgs, mask, tailnetSelf, serveState, httpsDisabled, HTTPS_STEPS, plist } from './lib.js'

const APP = path.join(import.meta.dirname, '..')
const LABEL = process.env.ASIDE_POCKET_LABEL || 'dev.asidepocket.bridge'
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', LABEL + '.plist')
const TARGET = `gui/${process.getuid()}`
const LOGS = path.join(DATA_DIR, 'logs')
const CONFIG_FILE = path.join(DATA_DIR, 'config.json')
const BIN_LINK = path.join(os.homedir(), '.local', 'bin', 'aside-pocket')

const say = (text) => console.log(text)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// runs a program -> { ok, out, stdout }; out is stdout and stderr together
function sh(file, args, timeout = 30000) {
  const r = spawnSync(file, args, { encoding: 'utf8', timeout })
  return { ok: r.status === 0, stdout: r.stdout || '', out: ((r.stdout || '') + (r.stderr || '') + (r.error ? r.error.message : '')).trim() }
}

// HTTP status of a GET, or the error message as a string
async function httpStatus(url) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(8000) })).status
  } catch (e) {
    return e.cause?.code || e.cause?.message || e.message
  }
}

async function asideDaemonUp() {
  return (await httpStatus('http://127.0.0.1:21420/health')) === 200
}

function asideAccounts(config) {
  const r = sh(config.asideCli, ['account', 'list', '--json'])
  if (!r.ok) return null
  try {
    return JSON.parse(r.stdout).accounts.filter((a) => a.authStatus === 'active')
  } catch {
    return null
  }
}

function serveJson(config) {
  const r = spawnSync(config.tailscale, ['serve', 'status', '--json'], { encoding: 'utf8', timeout: 15000 })
  try {
    return JSON.parse(r.stdout)
  } catch {
    return {}
  }
}

const agentLoaded = () => sh('/bin/launchctl', ['print', `${TARGET}/${LABEL}`])
const agentRunning = () => /state = running/.test(agentLoaded().out)

async function stopAgent() {
  sh('/bin/launchctl', ['bootout', `${TARGET}/${LABEL}`])
  for (let i = 0; i < 50 && agentLoaded().ok; i++) await sleep(200)
}

function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

// the bridge answers 403 to a local request: it only trusts requests that come through tailscale serve
async function bridgeAnswers(config) {
  return (await httpStatus(`http://127.0.0.1:${config.port}/api/health`)) === 403
}

async function ask(question) {
  if (!process.stdin.isTTY) return false
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question(question + ' [y/N] ')
  rl.close()
  return /^y/i.test(answer.trim())
}

// ---- commands ----

async function setup(args) {
  if (process.platform !== 'darwin') throw stop('Aside Pocket only runs on macOS.')
  if (process.getuid() === 0) throw stop('Do not run this as root or with sudo. Run it as your normal user.')

  let config = loadConfig()
  if (args.port) config.port = args.port
  if (args.httpsPort) config.httpsPort = args.httpsPort
  writeSecret(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n')
  fs.chmodSync(DATA_DIR, 0o700)

  if (!config.asideCli || !config.node) {
    throw stop('Aside was not found in ~/.aside (its command line tool and Node runtime live there).\nInstall Aside, open it once and sign in, then run: aside-pocket setup')
  }
  say('Aside CLI found.')
  if (!(await asideDaemonUp())) throw stop('Aside is not running. Open the Aside browser, then run: aside-pocket setup')
  if (!(asideAccounts(config) || []).length) throw stop('Aside is not signed in. Open Aside, sign in, then run: aside-pocket setup')
  say('Aside is running and signed in.')

  if (!config.tailscale) {
    throw stop('Tailscale was not found. Install it from https://tailscale.com/download on this Mac and on your iPhone,\nsign in on both with the same account, then run: aside-pocket setup')
  }
  let self = tailnetSelf(tailscaleStatus(config.tailscale))
  if (!self.loggedIn) {
    if (await ask('Tailscale is not logged in. Run "tailscale up" now?')) {
      spawnSync(config.tailscale, ['up'], { stdio: 'inherit' })
      self = tailnetSelf(tailscaleStatus(config.tailscale))
    }
    if (!self.loggedIn) throw stop(`Tailscale is not logged in. Open the Tailscale app and sign in, or run:\n  "${config.tailscale}" up\nThen run: aside-pocket setup`)
  }
  config = loadConfig() // picks up the Tailscale login when it was missing before
  if (!config.allowedLogins) throw stop('Could not read your Tailscale login from "tailscale status". Add "allowedLogins": ["you@example.com"] to\n' + CONFIG_FILE + ' and run: aside-pocket setup')
  if (!self.host || !self.https) throw stop(HTTPS_STEPS)
  say('Tailscale is logged in.')

  await stopAgent()
  if (!(await portFree(config.port))) {
    throw stop(`Port ${config.port} is already in use by another program. Pick another one:\n  aside-pocket setup --port <number>`)
  }
  const serve = serveState(serveJson(config), self.host, config.httpsPort, config.port)
  if (serve === 'taken') {
    throw stop(`Tailscale already serves something else on HTTPS port ${config.httpsPort}. Pick another one:\n  aside-pocket setup --https-port <number>`)
  }

  fs.mkdirSync(LOGS, { recursive: true, mode: 0o700 })
  fs.mkdirSync(path.dirname(PLIST), { recursive: true })
  fs.writeFileSync(PLIST, plist({ label: LABEL, node: config.node, app: APP, dataDir: DATA_DIR }))
  const boot = sh('/bin/launchctl', ['bootstrap', TARGET, PLIST])
  if (!boot.ok) throw stop(`launchctl could not start the bridge: ${boot.out}`)
  let up = false
  for (let i = 0; i < 40 && !up; i++) {
    await sleep(250)
    up = await bridgeAnswers(config)
  }
  if (!up) throw stop('The bridge did not start. See: aside-pocket logs')
  say(`Bridge is running (LaunchAgent ${LABEL}, port ${config.port}).`)

  if (serve === 'free') {
    const r = sh(config.tailscale, ['serve', '--bg', `--https=${config.httpsPort}`, `http://127.0.0.1:${config.port}`], 20000)
    if (!r.ok) throw stop(httpsDisabled(r.out) ? HTTPS_STEPS : `"tailscale serve" failed:\n${r.out || 'no answer within 20 seconds'}\nFix that, then run: aside-pocket setup`)
  }
  const url = `https://${self.host}:${config.httpsPort}`
  let status
  for (let i = 0; i < 6 && status !== 401; i++) { // the first request can wait for a certificate
    if (i) await sleep(3000)
    status = await httpStatus(url + '/api/health')
  }
  if (status !== 401) {
    throw stop(typeof status === 'string' && httpsDisabled(status)
      ? HTTPS_STEPS
      : `${url} does not answer as expected (got ${status}, wanted 401 without a token). Run: aside-pocket doctor`)
  }
  say(`Tailscale serves it at ${url} (only devices in your tailnet can reach it).\n`)
  say('On the iPhone: connect Tailscale, open that address in Safari, then Share > Add to Home Screen.\n')
  pair()
}

function pair() {
  const code = createPairCode(DATA_DIR)
  say(`Pairing code: ${code}  (valid 5 minutes, one use)`)
}

async function status() {
  if (!fs.existsSync(CONFIG_FILE)) throw stop('Not set up yet. Run: aside-pocket setup')
  const config = loadConfig()
  const running = agentRunning()
  const answers = await bridgeAnswers(config)
  const { host } = tailnetSelf(config.tailscale && tailscaleStatus(config.tailscale))
  say(`LaunchAgent  ${running ? 'running' : 'not running'} (${LABEL})`)
  say(`Bridge       ${answers ? 'answers' : 'does not answer'} on 127.0.0.1:${config.port}`)
  say(`Address      ${host ? `https://${host}:${config.httpsPort}` : 'unknown (Tailscale is not logged in)'}`)
  say(`Version      ${JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8')).version}`)
  say(`Data         ${DATA_DIR}`)
  if (!running || !answers) throw stop('The bridge is not healthy. Run: aside-pocket doctor')
}

function logs(args) {
  const files = ['bridge.out.log', 'bridge.err.log'].map((f) => path.join(LOGS, f)).filter((f) => fs.existsSync(f))
  if (!files.length) throw stop(`No logs yet in ${LOGS}`)
  const r = spawnSync('/usr/bin/tail', [...(args.follow ? ['-f'] : []), '-n', '50', ...files], { stdio: 'inherit' })
  if (r.status) throw stop('tail failed')
}

// Every link between the phone and Aside, in order. Each check returns [ok, detail].
async function doctor() {
  const config = fs.existsSync(CONFIG_FILE) ? loadConfig() : null
  if (!config) throw stop('Not set up yet. Run: aside-pocket setup')
  const self = tailnetSelf(config.tailscale && tailscaleStatus(config.tailscale))
  const url = `https://${self.host}:${config.httpsPort}`
  const checks = [
    ['Aside CLI runs', () => {
      if (!config.asideCli) return [false, 'not found in ~/.aside']
      const r = sh(config.asideCli, ['--version'])
      return [r.ok, `${config.asideCli} ${r.out.split('\n')[0]}`]
    }],
    ['Aside daemon health', async () => [await asideDaemonUp(), 'http://127.0.0.1:21420/health']],
    ['An Aside account is connected', () => {
      const accounts = (config.asideCli && asideAccounts(config)) || []
      const connected = accounts.filter((a) => {
        const r = sh(config.asideCli, ['host', 'profiles', '--account', 'u' + a.id, '--json'])
        return r.ok && /"connected":\s*true/.test(r.stdout)
      })
      return [connected.length > 0, `${connected.length} of ${accounts.length} signed-in accounts have a browser profile open`]
    }],
    ['LaunchAgent loaded', () => [agentRunning(), `${LABEL}, ${PLIST}`]],
    ['Bridge answers locally', async () => [await bridgeAnswers(config), `127.0.0.1:${config.port}`]],
    ['Tailscale logged in', () => [self.loggedIn, `${config.tailscale || 'Tailscale CLI not found'}, allowed logins: ${(config.allowedLogins || []).join(', ') || 'none'}`]],
    ['tailscale serve entry', () => {
      const state = config.tailscale ? serveState(serveJson(config), self.host, config.httpsPort, config.port) : 'free'
      return [state === 'ours', { ours: `${url} -> 127.0.0.1:${config.port}`, free: `nothing is served on HTTPS port ${config.httpsPort}`, taken: `HTTPS port ${config.httpsPort} serves something else` }[state]]
    }],
    ['HTTPS address answers 401 without a token', async () => {
      if (!self.host) return [false, 'no tailnet host name']
      const got = await httpStatus(url + '/api/health')
      return [got === 401, `${url}/api/health -> ${got}`]
    }],
  ]
  let failed = 0
  for (const [name, check] of checks) {
    const [ok, detail] = await check()
    if (!ok) failed++
    say(mask(`${ok ? 'OK  ' : 'FAIL'}  ${name}  (${detail})`))
  }
  if (failed) throw stop(`${failed} of ${checks.length} checks failed. "aside-pocket setup" repairs most of them.`)
  say('All checks passed.')
}

function catalog() {
  const config = loadConfig()
  const r = spawnSync(config.node || process.execPath, [path.join(APP, 'bridge', 'catalog.js')], { stdio: 'inherit' })
  if (r.status !== 0) throw stop('The model list was not built.')
}

function update() {
  if (fs.existsSync(path.join(APP, '.git'))) {
    const r = spawnSync('git', ['-C', APP, 'pull', '--ff-only'], { stdio: 'inherit' })
    if (r.status !== 0) throw stop('git pull failed. Nothing was restarted.')
  } else if (APP === path.join(DATA_DIR, 'app')) {
    const r = spawnSync('/bin/sh', [path.join(APP, 'install.sh')], { stdio: 'inherit', env: { ...process.env, ASIDE_POCKET_NO_SETUP: '1' } })
    if (r.status !== 0) throw stop('The download failed. Nothing was restarted.')
  } else {
    throw stop(`${APP} is neither a git checkout nor an install.sh install, so it cannot update itself. Replace the folder by hand.`)
  }
  if (!agentLoaded().ok) return say('Updated. The bridge is not installed as a LaunchAgent; run: aside-pocket setup')
  const r = sh('/bin/launchctl', ['kickstart', '-k', `${TARGET}/${LABEL}`])
  if (!r.ok) throw stop(`Updated, but the bridge did not restart: ${r.out}`)
  say('Updated and restarted the bridge.')
}

async function uninstall(args) {
  await stopAgent()
  fs.rmSync(PLIST, { force: true })
  say(`Stopped and removed the LaunchAgent ${LABEL}.`)
  const config = fs.existsSync(CONFIG_FILE) ? loadConfig() : null
  if (config?.tailscale) {
    const { host } = tailnetSelf(tailscaleStatus(config.tailscale))
    const state = serveState(serveJson(config), host, config.httpsPort, config.port)
    if (state === 'ours') {
      const r = sh(config.tailscale, ['serve', `--https=${config.httpsPort}`, 'off'])
      say(r.ok ? `Removed the tailscale serve entry on HTTPS port ${config.httpsPort}.` : `Could not remove the tailscale serve entry: ${r.out}`)
      if (!r.ok) process.exitCode = 1
    } else if (state === 'taken') {
      say(`Left the tailscale serve entry on HTTPS port ${config.httpsPort} alone: it does not point to this bridge.`)
    }
  }
  if (!fs.existsSync(DATA_DIR)) return
  if (!args.purge) return say(`Kept the data directory ${DATA_DIR} (remove it with: aside-pocket uninstall --purge).`)
  if (fs.existsSync(BIN_LINK) && fs.realpathSync(BIN_LINK).startsWith(fs.realpathSync(DATA_DIR) + path.sep)) fs.rmSync(BIN_LINK)
  fs.rmSync(DATA_DIR, { recursive: true, force: true })
  say(`Deleted the data directory ${DATA_DIR}.`)
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2))
    if (args.command === 'help') say(USAGE)
    else await { setup, pair, status, logs, doctor, catalog, update, uninstall }[args.command](args)
  } catch (e) {
    console.error(e.stop ? e.message : `Error: ${e.message}`)
    process.exit(1)
  }
}
