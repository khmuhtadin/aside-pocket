# Configuration and layout (contract for the public release)

Everything machine-specific is detected at install time and stored in `config.json`. Nothing in the code may contain a user name, home path, e-mail address or tailnet host name.

## Data directory
`~/.aside-pocket/` (override with the `ASIDE_POCKET_DIR` environment variable, used by tests and sandbox installs). Mode 0700, files 0600.

| File | What |
|---|---|
| `config.json` | see below |
| `token`, `pair.json` | bearer token, pending pairing code (hash only) |
| `vapid.json`, `subscriptions.json` | Web Push |
| `models.json` | model catalog built by `aside-pocket catalog` |
| `env` | optional `KEY=VALUE` lines, e.g. `GROQ_API_KEY` |
| `logs/` | bridge logs |
| `app/` | the installed code when installed with `install.sh` (a checkout or unpacked release) |

## config.json
```json
{
  "port": 8787,
  "httpsPort": 8443,
  "allowedLogins": ["you@example.com"],
  "asideCli": "/Users/you/.aside/cli/Aside CLI.app/Contents/MacOS/aside",
  "node": "/Users/you/.aside/runtime/bin/node",
  "tailscale": "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  "contact": "mailto:you@example.com",
  "allowRoutineRetry": false,
  "ntfyTopic": null
}
```
- `asideCli`, `node`, `tailscale`, `allowedLogins`, `contact` are detected when the key is missing and then written back, so a hand-written config can be partial. Detection: Aside CLI at `~/.aside/cli/Aside CLI.app/Contents/MacOS/aside`; Node at `~/.aside/runtime/bin/node` (the Node that ships with Aside; the code may rely on its version); Tailscale CLI at `/Applications/Tailscale.app/Contents/MacOS/Tailscale`, else `/usr/local/bin/tailscale`, else `/opt/homebrew/bin/tailscale`; `allowedLogins` = the login of this node from `tailscale status --json`; `contact` = `mailto:` + that login (VAPID subject).
- `allowRoutineRetry` (default false): when false the bridge refuses `resume`, `steer` and `queue` on routine run sessions with `403 {error:"routine retry is disabled"}` and the app shows no Retry button. When true, Retry works and the app's confirm sheet names the routine's permission mode.
- The public URL is never stored: it is `https://<this node's DNSName from tailscale status>:<httpsPort>`.

## API additions
- `GET /api/health` also returns `version` (from the root `package.json`) and `features: { routineRetry: boolean }`.
- `GET /api/routines` items also carry `permissionMode` of the last run session (`"guard"`, `"full-access"`, or null), read from `session inspect`, only when `allowRoutineRetry` is true.

## LaunchAgent
Label `dev.asidepocket.bridge`, plist `~/Library/LaunchAgents/dev.asidepocket.bridge.plist`, runs `<node> <app>/bridge/server.js`, KeepAlive, logs to `<data dir>/logs/`. The label and port can be overridden for a sandbox install with `ASIDE_POCKET_LABEL` and `--port`.

## Command line
`aside-pocket <command>` (a small shell wrapper in `bin/aside-pocket` that runs `<node> tools/cli.js`):
`setup` (detect, write config, install LaunchAgent, `tailscale serve`, health check, print URL and pairing code), `pair` (code), `status`, `logs`, `doctor` (checks every link and prints a report with e-mail addresses, host names and home paths masked, safe to paste into an issue), `catalog` (build the model list), `update`, `uninstall` (stops the agent, removes the plist and `tailscale serve` entry; keeps the data directory unless `--purge`).
`install.sh` (repo root) only: checks macOS and that the Aside CLI exists, downloads the latest release (or `main`) into `<data dir>/app`, links `aside-pocket` into `~/.local/bin` (and says so if that is not on PATH), then runs `aside-pocket setup`.
