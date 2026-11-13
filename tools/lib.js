// Small pure helpers of the command line, kept apart so they can be tested without Aside or Tailscale.
import os from 'node:os'

export const COMMANDS = ['setup', 'pair', 'status', 'logs', 'doctor', 'catalog', 'update', 'uninstall']

export const USAGE = `Usage: aside-pocket <command>

  setup [--port N] [--https-port N]   detect, write config, start the bridge, turn on tailscale serve, pair
  pair                                print a new pairing code
  status                              is the bridge running, and where
  logs [-f]                           last lines of the bridge logs (-f keeps following)
  doctor                              check every link; the report is safe to paste into an issue
  catalog                             build the model list (starts one short helper session per account)
  update                              get the newest version and restart the bridge
  uninstall [--purge]                 stop and remove the bridge; --purge also deletes the data directory`

// A message for the user, printed without a stack trace.
export function stop(message) {
  return Object.assign(new Error(message), { stop: true })
}

function port(name, value) {
  const n = Number(value)
  if (!/^\d+$/.test(value || '') || n < 1024 || n > 65535) throw stop(`${name} needs a port number between 1024 and 65535.`)
  return n
}

// ['setup', '--port', '8797'] -> { command: 'setup', port: 8797 }
export function parseArgs(argv) {
  const [command, ...rest] = argv
  if (!command || command === 'help' || command === '--help' || command === '-h') return { command: 'help' }
  if (!COMMANDS.includes(command)) throw stop(`Unknown command: ${command}\n\n${USAGE}`)
  const args = { command }
  const allowed = { setup: ['--port', '--https-port'], logs: ['-f'], uninstall: ['--purge'] }[command] || []
  for (let i = 0; i < rest.length; i++) {
    const [flag, inline] = rest[i].split('=')
    if (!allowed.includes(flag)) throw stop(`Unknown option for ${command}: ${rest[i]}`)
    if (flag === '--port') args.port = port(flag, inline ?? rest[++i])
    if (flag === '--https-port') args.httpsPort = port(flag, inline ?? rest[++i])
    if (flag === '-f') args.follow = true
    if (flag === '--purge') args.purge = true
  }
  return args
}

// Hides e-mail addresses, tailnet host names and the home path, for reports that get pasted in public.
export function mask(text, home = os.homedir()) {
  return String(text)
    .replaceAll(home, '~')
    .replace(/\/Users\/[^/\s]+/g, '~') // any other macOS home folder
    .replace(/[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.ts\.net/g, '<host>.ts.net')
    .replace(/([A-Za-z0-9])[A-Za-z0-9._%+-]*@([A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+)/g, '$1***@$2')
}

// What the setup needs from `tailscale status --json`.
export function tailnetSelf(status) {
  return {
    loggedIn: status?.BackendState === 'Running',
    host: (status?.Self?.DNSName || '').replace(/\.$/, ''),
    https: (status?.CertDomains || []).length > 0,
  }
}

// What `tailscale serve status --json` says about one https port:
// 'free', 'ours' (it proxies to the bridge) or 'taken' (something else is served there).
export function serveState(serve, host, httpsPort, bridgePort) {
  const web = serve?.Web?.[`${host}:${httpsPort}`]
  if (!web && !serve?.TCP?.[httpsPort]) return 'free'
  const handlers = web?.Handlers || {}
  const ours = Object.keys(handlers).length === 1 && handlers['/']?.Proxy === `http://127.0.0.1:${bridgePort}`
  return ours ? 'ours' : 'taken'
}

// Does this error text (from `tailscale serve` or a failed TLS request) mean HTTPS is not enabled for the tailnet?
export function httpsDisabled(text) {
  return /certificate|certs?\b|TLS|SSL|enable HTTPS|HTTPS[^\n]*not (enabled|available|supported)/i.test(String(text))
}

export const HTTPS_STEPS = `HTTPS certificates are not enabled for your tailnet. Turn them on once:
  1. Open https://login.tailscale.com/admin/dns
  2. Enable MagicDNS (if it is off)
  3. Under "HTTPS Certificates", click "Enable HTTPS"
Then run: aside-pocket setup`

const xml = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

// LaunchAgent that keeps the bridge running.
export function plist({ label, node, app, dataDir }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(node)}</string>
    <string>${xml(app)}/bridge/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(app)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ASIDE_POCKET_DIR</key><string>${xml(dataDir)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(dataDir)}/logs/bridge.out.log</string>
  <key>StandardErrorPath</key><string>${xml(dataDir)}/logs/bridge.err.log</string>
</dict>
</plist>
`
}
