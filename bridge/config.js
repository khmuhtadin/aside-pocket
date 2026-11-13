// Data directory and config.json. Machine-specific values are detected when missing and written back.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

export const DATA_DIR = process.env.ASIDE_POCKET_DIR || path.join(os.homedir(), '.aside-pocket')

const TAILSCALE_PATHS = ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale']

export function writeSecret(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, text, { mode: 0o600 })
  fs.chmodSync(file, 0o600)
}

// `tailscale status --json` as an object, or null when the CLI is missing or fails
export function tailscaleStatus(tailscale) {
  try {
    return JSON.parse(execFileSync(tailscale, ['status', '--json'], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }))
  } catch {
    return null
  }
}

// each returns the value or null when it cannot be found
export const detectors = {
  asideCli: () => firstExisting([path.join(os.homedir(), '.aside/cli/Aside CLI.app/Contents/MacOS/aside')]),
  node: () => firstExisting([path.join(os.homedir(), '.aside/runtime/bin/node')]),
  tailscale: () => firstExisting(TAILSCALE_PATHS),
  login: (tailscale) => {
    const status = tailscale && tailscaleStatus(tailscale)
    return status?.User?.[status.Self?.UserID]?.LoginName || null
  },
}

function firstExisting(files) {
  return files.find((f) => fs.existsSync(f)) || null
}

// config.json with defaults; keys that are missing are detected and saved. A key that cannot be detected stays missing.
export function loadConfig(dir = DATA_DIR, detect = detectors) {
  const file = path.join(dir, 'config.json')
  const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
  const config = { port: 8787, httpsPort: 8443, allowRoutineRetry: false, ntfyTopic: null, ...saved }
  for (const key of ['asideCli', 'node', 'tailscale']) {
    if (!config[key]) config[key] = detect[key]()
  }
  if (!config.allowedLogins) {
    const login = detect.login(config.tailscale)
    config.allowedLogins = login ? [login] : null
  }
  if (!config.contact && config.allowedLogins?.[0]) config.contact = 'mailto:' + config.allowedLogins[0]
  for (const key of ['asideCli', 'node', 'tailscale', 'allowedLogins', 'contact']) {
    if (!config[key]) delete config[key]
  }
  const text = JSON.stringify(config, null, 2) + '\n'
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) writeSecret(file, text)
  return config
}
