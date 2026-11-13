# Aside Pocket

[![test](https://github.com/khmuhtadin/aside-pocket/actions/workflows/test.yml/badge.svg)](https://github.com/khmuhtadin/aside-pocket/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Aside Pocket lets you watch and steer your Aside Browser agent sessions from your iPhone. A small Node bridge on your Mac wraps the official Aside CLI and serves a web app to the phone over Tailscale.

```
iPhone PWA  --HTTPS over Tailscale-->  bridge on 127.0.0.1 (Node)  -->  Aside CLI  -->  Aside
```

The agents keep running in Aside on the Mac. The phone shows what they do and sends them prompts.

Not affiliated with Aside. This is a personal project that calls the CLI Aside ships. It is built for one person: one Mac, one phone, one Tailscale account.

## Requirements

- A Mac with Aside Browser installed and signed in, and the Aside CLI installed (`~/.aside/cli/Aside CLI.app`).
- Tailscale on the Mac and on the iPhone, both in the same tailnet.
- MagicDNS and HTTPS certificates turned on for the tailnet (Tailscale admin console, DNS page).
- iOS 16.4 or later for push notifications.

No Node install is needed. The bridge runs on the Node that ships with Aside.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/khmuhtadin/aside-pocket/main/install.sh | bash
```

The installer:

1. Checks that this is macOS and that the Aside CLI exists.
2. Downloads the latest release (or `main`) into `~/.aside-pocket/app`.
3. Links `aside-pocket` into `~/.local/bin`, and tells you if that directory is not on your `PATH`.
4. Runs `aside-pocket setup`.

`setup` finds the Aside CLI, Aside's Node, the Tailscale CLI and your Tailscale login, and writes them to `~/.aside-pocket/config.json`. It installs a LaunchAgent (`dev.asidepocket.bridge`) that keeps the bridge running, points `tailscale serve` at it, checks that the bridge answers, and prints the URL and a pairing QR code.

To install by hand instead:

```sh
git clone https://github.com/khmuhtadin/aside-pocket.git
cd aside-pocket
bin/aside-pocket setup
```

## First run on the iPhone

1. Connect Tailscale on the iPhone.
2. Open the URL that `setup` printed in Safari. It looks like `https://your-mac.your-tailnet.ts.net:8443/`.
3. Share > Add to Home Screen. Open "Aside Pocket" from the Home Screen.
4. On the Mac run `aside-pocket pair`. It prints a 6-digit code and a QR code.
5. In the app tap Scan QR code, or type the code. The code works once and expires after 5 minutes.
6. In Settings tap Enable notifications and allow them, then Send test.

Pair inside the Home Screen app, not in the Safari tab. iOS gives the two separate storage, so a token saved in Safari is not visible to the Home Screen app. Notifications also only work from the Home Screen app.

## What you can do

- See all sessions in an inbox: waiting, running, finished, unread. Search them, or group them by project.
- Open a session and read its thread: prompts, answers, tool calls, images the agent saved.
- Start a task, with a model and an effort level. Dictate the prompt by voice (optional, see Configuration).
- Reply to a finished session, steer a running one, queue a follow-up, stop it, archive it.
- Switch between Aside profiles. Each has its own sessions, projects, routines, models and memory.
- Change the model of a session.
- See your routines and open each one's last run.
- Get a push notification when a session finishes, fails or waits for you.
- Search Aside's memory and read the files. Read-only.
- View a screenshot of the tab a session's agent is using. Nothing is clicked, and your own tabs are never shown.

## Commands

| Command | What it does |
|---|---|
| `aside-pocket setup` | Options `--port N` and `--https-port N`. Detects paths and your Tailscale login, writes the config, installs the LaunchAgent, runs `tailscale serve`, checks health, prints the URL and a pairing QR. Safe to run again. |
| `aside-pocket pair` | Prints a new pairing code and QR. |
| `aside-pocket status` | Shows whether the bridge is running, its address and its version. |
| `aside-pocket logs` | Shows the last lines of the bridge logs in `~/.aside-pocket/logs/`. `-f` keeps following. |
| `aside-pocket doctor` | Checks every link between the phone and Aside and prints a report. Host names and home paths are masked and e-mail addresses are cut to the first letter and the domain, so the report can go into an issue. |
| `aside-pocket catalog` | Builds the model list (see Limits). |
| `aside-pocket update` | Gets the newest version and restarts the bridge. |
| `aside-pocket uninstall` | Stops the LaunchAgent and removes its plist and the `tailscale serve` entry. Keeps `~/.aside-pocket` unless you add `--purge`. |

## Configuration

Everything lives in `~/.aside-pocket/`. `config.json` is written by `setup` and can be edited by hand. All keys are described in [docs/config.md](docs/config.md). Restart the bridge after a change:

```sh
launchctl kickstart -k gui/$(id -u)/dev.asidepocket.bridge
```

Three settings you may want:

- `allowRoutineRetry` (default `false`). With `true`, a failed routine run gets a Retry button. It is off by default because Retry continues the run in the routine's own session, and that session keeps the routine's permission mode, which may be full access. A retry from the phone would then run with more than Guard. The confirm sheet names the permission mode before you retry.
- Voice input. Put `GROQ_API_KEY=<key>` in `~/.aside-pocket/env` and `chmod 600` the file. Recordings are sent to Groq for transcription. Without the key the microphone button reports that voice is not set up.
- `ntfyTopic` (default `null`). Set it to a long random string and subscribe to that topic in the ntfy app to also get notifications through ntfy.sh. Use it only if Web Push does not work for you: ntfy.sh receives the session title and the start of the answer in plain text, and anyone who knows the topic can read them.

## iOS Shortcut: Send to Aside

Sends shared text or a link to Aside as a new task. Tailscale must be connected on the phone.

1. In Aside Pocket: Settings > Copy token.
2. Shortcuts app > + > name it "Send to Aside".
3. Tap the (i) button and turn on "Show in Share Sheet". In the "Receive" line at the top keep only Text and URLs.
4. Add the action "Get Contents of URL":
   - URL: `https://your-mac.your-tailnet.ts.net:8443/api/sessions`
   - Method: POST
   - Headers: `Authorization` = `Bearer <token>` (paste the token after "Bearer "), `Content-Type` = `application/json`
   - Request Body: JSON, one Text field `prompt` = Shortcut Input
5. Optional body fields: `account` (`u0`, `u1`, ...), `effort` (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`), `model` (`provider/modelId`).
6. Use it: Share > Send to Aside. The task shows up in the inbox and runs with Guard permission.

The Shortcut holds the token. Keep the Shortcut private and do not share it.

## Security model

- The bridge listens on `127.0.0.1` only. `tailscale serve` makes it reachable over HTTPS inside your tailnet. No port is opened to the internet, and Tailscale Funnel is not used.
- Every API request must come from a Tailscale login on the allow-list (`allowedLogins`, by default only the login of the Mac) and must carry the bearer token. The app's static files are served without a token to anyone in your tailnet who can reach the Mac.
- The phone gets the token by pairing. A pairing code is 6 digits, works once, expires after 5 minutes, and is dropped after 5 wrong attempts. Only its hash is stored.
- A task started from the phone always runs with Aside's Guard permission. The bridge never passes full access.
- A reply to an existing session continues that session, so it keeps whatever permission mode the session already has. The same holds for routine Retry, which is why it is off by default.
- The bridge can start sessions, send prompts to them, stop and archive them, mark them read, change a session's model, read transcripts and memory, take a screenshot of the agent's own tab, and read image files inside Aside's session folders.
- The bridge cannot delete sessions, raise a permission mode, change Aside settings, create or edit routines, read other files, or show your own tabs. It talks to Aside only through the CLI.
- The token, the push keys and the config stay in `~/.aside-pocket` (directory mode 0700, files 0600). Nothing secret is in this repository.
- Push notifications carry the session title and the first 120 characters of the answer. They are encrypted for your phone (Web Push) and pass through Apple's push service.
- Any process running as you on the Mac can reach `127.0.0.1` directly and set the login header itself. It still needs the token. The bridge does not protect you from software already running under your account.

To report a vulnerability see [SECURITY.md](SECURITY.md).

## Limits and known issues

- It depends on the Aside CLI and on details the CLI does not document. An Aside update can break it. Tested with Aside 1.26.x.
- macOS only. The phone side is built and tested for iPhone.
- The Mac must be awake. The bridge keeps it from idle sleep while a session runs, and only then. A closed lid still sleeps.
- Tasks started from the phone are unattended. Aside gives them no way to ask you a question, so they never wait for approval. A denied action fails instead.
- The Approvals tab lists sessions that wait for you. Those can only be sessions started in Aside itself or by a routine. A reply from the phone is sent with `session resume`. I have not been able to verify that against a live pending approval, so it may not answer the approval.
- Aside has no command that lists models. `aside-pocket catalog` reads the names from Aside's own model menu and keeps the ids Aside accepts, so it may miss entries. You can always type a model id (`provider/modelId`). Run `catalog` again after an Aside update or after connecting a provider. It starts one small helper task per profile and archives it.
- Routines are read-only. You cannot create, edit, pause or start one from the phone.
- A profile only works while its browser profile is open in Aside on the Mac.
- Screenshots are full size. Aside cannot scale them down, so heavy pages are sent at lower JPEG quality.
- Routine runs do not send push notifications.

## Troubleshooting

Start with `aside-pocket doctor`. It checks every link between the phone's URL and Aside and reports which one fails.

The three most likely failures:

- The URL does not load or shows a certificate error. HTTPS certificates are not enabled for your tailnet. Turn on MagicDNS and HTTPS certificates in the Tailscale admin console, then run `aside-pocket setup` again. Also check that Tailscale is connected on the phone.
- A profile shows as not connected. Its browser profile is not open in Aside on the Mac. Open a window of that profile in Aside. The app picks it up within a minute.
- The app does not update on iOS. Close the app and reopen it, twice. The first open downloads the new version and the second one runs it. If that does not help, remove the Home Screen icon, add it again from Safari, and pair again.

`aside-pocket logs` shows what the bridge did. The logs hold request paths and error messages from the Aside CLI. Answers are never logged; read the output before you post it anywhere.

## Uninstall

```sh
aside-pocket uninstall           # stops the bridge, removes the LaunchAgent and the tailscale serve entry
aside-pocket uninstall --purge   # also deletes ~/.aside-pocket: the installed code, the token and the push keys
```

Then remove the Home Screen icon on the iPhone.

## Contributing and issues

Bug reports are welcome. Run `aside-pocket doctor` and paste its output into the issue. See [CONTRIBUTING.md](CONTRIBUTING.md) for the ground rules and how to run the tests. The bridge API is described in [docs/api.md](docs/api.md), and what the Aside CLI exposes in [docs/aside-surface.md](docs/aside-surface.md).

## License

MIT, see [LICENSE](LICENSE). Vendored code is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
