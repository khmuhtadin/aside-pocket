# Contributing

Aside Pocket is a small project with one maintainer. Bug reports and small, focused pull requests are welcome. For anything larger, open an issue first so we can agree on it before you write code.

## Layout

| Path | What |
|---|---|
| `bridge/` | The Node bridge: HTTP API, auth, push, the Aside CLI wrapper. Tests in `bridge/test/`. |
| `tools/` | The code behind the `aside-pocket` command (setup, pair, doctor, catalog and the rest). |
| `bin/` | `aside-pocket`, a shell wrapper that runs `tools/cli.js` with Aside's Node. |
| `web/` | The PWA. Plain ES modules, served as they are. Vendored libraries in `web/vendor/`. |
| `docs/` | `config.md` (config and layout), `api.md` (bridge API), `aside-surface.md` (what the Aside CLI exposes), `fixtures/` (example JSON shapes, invented data). |

## Running the tests

The tests use Node's built-in test runner and need no install step.

```sh
npm test
```

or directly, with the Node that ships with Aside:

```sh
~/.aside/runtime/bin/node --test 'bridge/test/*.test.js' 'tools/test/*.test.js'
```

The tests do not call Aside or Tailscale. They run against fake CLI output and a temporary data directory (`ASIDE_POCKET_DIR`).

To try a change against your own Aside without touching your real install, use a sandbox install: set `ASIDE_POCKET_DIR` and `ASIDE_POCKET_LABEL` and pass `--port` and `--https-port` to `aside-pocket setup`. See `docs/config.md`.

## Ground rules

These are constraints of the project, not preferences.

- No build step. The files in `web/` are what the browser loads.
- No npm dependencies. Node built-ins only in `bridge/` and `tools/`. A library for the web app can be vendored into `web/vendor/` if it is pure JavaScript and its license allows it. Add it to `THIRD_PARTY_NOTICES.md`.
- Talk to Aside only through the official CLI. No daemon endpoint other than `GET /health`. No reading or writing Aside's files directly.
- Never call `session delete`. Never raise a permission mode. New sessions always get `--permission guard`. The full list is at the end of `docs/aside-surface.md`.
- Never log secrets or content: no token, pairing code, VAPID key, prompt, transcript, tool result or memory text in logs or error messages.
- Nothing machine-specific in the code: no user name, home path, e-mail address or tailnet host. Those are detected at setup and stored in `config.json`.
- Keep the code plain. A longer obvious function beats a short clever one. No fallbacks or compatibility layers for cases that do not exist yet.
- A change to the API goes into `docs/api.md` in the same pull request. A change to config keys or commands goes into `docs/config.md`.

## Reporting a bug

1. Run `aside-pocket doctor` and paste its output. It masks host names and home paths and cuts e-mail addresses to the first letter and the domain.
2. Add your Aside version, macOS version and iOS version, and how you installed (the `install.sh` one-liner or a clone).
3. Say what you did, what you expected and what happened.

Never paste your token, a pairing code, or session content such as prompts and answers. Read the doctor output once before you post it.

For a security problem do not open an issue. See [SECURITY.md](SECURITY.md).

## Pull requests

- Run the tests.
- Add a test when you change behaviour in `bridge/`.
- Say in the description how you tried the change: against which Aside version, and on a phone or only in a desktop browser.
