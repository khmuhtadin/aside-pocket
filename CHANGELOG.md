# Changelog

All notable changes to this project are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-13

First public release. Tested with Aside 1.26.x on macOS and an iPhone.

### Added

- Bridge on the Mac that wraps the official Aside CLI and serves the app over `tailscale serve`. It listens on `127.0.0.1` only.
- iPhone web app (PWA) that installs to the Home Screen.
- Inbox of sessions across profiles, with waiting, running and earlier groups, an unread filter, search and a per-project view.
- Thread view with prompts, answers, tool calls and images the agent saved.
- Start a task with a model and an effort level. Tasks started from the phone always run with Guard permission.
- Reply to a finished session, steer or queue on a running one, stop, archive, mark read.
- Multiple Aside profiles, with a switcher.
- Model picker, fed by `aside-pocket catalog`, plus a typed model id. Change the model of an existing session.
- Routines list with each routine's last run. Retry of a failed run is behind `allowRoutineRetry`, off by default.
- Approvals tab for sessions that wait for the owner.
- Web Push notifications for finished, failed and waiting sessions. Optional ntfy copy through `ntfyTopic`.
- Voice input through Groq, when `GROQ_API_KEY` is set.
- Memory search and file view, read-only.
- Screenshot of the tab a session's agent is using.
- Pairing with a one-time 6-digit code or a QR code, valid for 5 minutes.
- Access control: Tailscale login allow-list plus a bearer token.
- `aside-pocket` command: `setup`, `pair`, `status`, `logs`, `doctor`, `catalog`, `update`, `uninstall`.
- `install.sh` one-line installer and a LaunchAgent (`dev.asidepocket.bridge`) that keeps the bridge running.
- iOS Shortcut recipe "Send to Aside" that starts a task from the share sheet.

### Known limits

- Replies to a pending approval are sent with `session resume` and have not been verified against a live pending approval.
- The model catalog is read from Aside's model menu and may miss entries.
- macOS only.
