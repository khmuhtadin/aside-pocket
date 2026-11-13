# Bridge API

The HTTP API between `bridge/` and `web/`. All JSON unless noted. Errors are `{ "error": "<message>" }` with a 4xx or 5xx status.

The base URL is `https://your-mac.your-tailnet.ts.net:8443` (your Mac's Tailscale DNS name and `httpsPort` from the config). The bridge itself listens on `127.0.0.1:<port>`.

## Auth

- Every `/api/*` request needs the `Tailscale-User-Login` header (added by `tailscale serve`) to be in `allowedLogins`, else `403 forbidden`.
- Every `/api/*` request except `POST /api/pair` needs `Authorization: Bearer <token>`, else `401 unauthorized`.
- Static files (`web/`) need no auth.

## Session object

```json
{
  "id": "AAAAAAAAAAAAAAA1",
  "account": "u0",
  "title": "Compare two train routes",
  "status": "running | waiting | done | failed | stopped",
  "unread": false,
  "source": "cli | sidepanel | new-tab | tasks-page | mini-popup | branch | null",
  "projectId": null,
  "createdAt": "2026-11-12T10:00:00.000Z",
  "updatedAt": "2026-11-12T10:00:02.000Z"
}
```

Aside status mapping: `running` -> running, `suspended` or any session with a non-empty `suspension` -> waiting, `idle` -> done, `errored` and `aborted` -> failed (`aborted` means the CLI process that ran the turn died; `error` is "Request aborted"), `interrupted` -> stopped. `unread` is `readAt < updatedAt` while the status is not running.

## Endpoints

| Method + path | Body | Response |
|---|---|---|
| `POST /api/pair` | `{code}` | `{token}`. `401` on a wrong or expired code |
| `GET /api/health` | | `{ok:true, version, features:{routineRetry}, aside:{version, ready, status}, running:<n>}`. `aside` is `null` when the Aside daemon is down |
| `GET /api/accounts` | | `{accounts:[{id:"u0", name, email, connected}]}` |
| `GET /api/sessions?filter=running\|waiting\|done\|unread\|all&limit=100` | | `{sessions:[Session]}`, newest first, all connected accounts together. `done` includes failed and stopped. Archived sessions are never returned |
| `GET /api/sessions/:id?limit=60` | | `{session:Session, model:string\|null, answer:string\|null, error:string\|null, question:object\|null, queued:[string], messages:[Message], more:boolean}` |
| `POST /api/sessions` | `{prompt, effort?, account?, model?}` | `{id}`. `effort` is one of off, minimal, low, medium, high, xhigh, max (default medium). `account` defaults to `u0`. Always Guard permission |
| `POST /api/sessions/:id/resume` `/steer` `/queue` | `{prompt}` | `{ok:true}`. `403` on a routine run session when routine retry is off |
| `POST /api/sessions/:id/stop` `/archive` `/read` | | `{ok:true}` |
| `POST /api/sessions/:id/model` | `{model}` | `{ok:true}` |
| `GET /api/sessions/:id/screenshot` | | `image/jpeg` bytes. `404 {error:"no tab"}` |
| `GET /api/stream` | | SSE, see below |
| `GET /api/projects?account=u0` | | `{projects:[{id, name, color}]}` |
| `GET /api/routines?account=u0` | | `{routines:[Routine]}` |
| `GET /api/models?account=u0` | | `{default:"provider/modelId", models:[{id, name, group}]}` |
| `GET /api/memory?account=u0&q=<text>` | | `{results:[{path, title, excerpt, score}]}` |
| `GET /api/memory/file?account=u0&path=<path>` | | `{path, text}` |
| `GET /api/file?path=<absolute path>` | | image bytes |
| `GET /api/push/key` | | `{publicKey}` (VAPID, base64url) |
| `POST /api/push/subscribe` | `{subscription}` (PushSubscription JSON) | `{ok:true}`. `400` for a non-https or invalid endpoint and for missing keys |
| `POST /api/push/test` | | `{results:[{status}]}` |
| `POST /api/voice` | raw audio bytes, `Content-Type: audio/*` | `{text}`. `503` when `GROQ_API_KEY` is not set |

Other errors: `400 bad url` (the URL cannot be parsed or decoded), `413` for a body over 1 MB (10 MB for voice), `400 invalid JSON body`, `400 bad session id`, `400 bad filter`, `400 bad limit`, `400 bad account`, `400 bad model`, `400 prompt is required`, `400 bad effort`, `415` for voice without `audio/*`, `502` with Aside's own message when the CLI call fails.

## Health

```json
{
  "ok": true,
  "version": "0.1.0",
  "features": { "routineRetry": false },
  "aside": { "version": "1.26.1111.1046", "ready": true, "status": "idle" },
  "running": 0
}
```

`version` is the bridge version from the root `package.json`. `features.routineRetry` mirrors `allowRoutineRetry` in the config; the app shows the Retry button only when it is true. `running` counts running sessions across connected accounts.

## Accounts (Aside profiles)

Aside can hold several signed-in accounts (`u0`, `u1`, ...). Each has its own sessions, projects, routines, models and memory.

- `connected:false` means that account's browser profile is not open in Aside on the Mac. It has no sessions in the list and cannot start tasks.
- `GET /api/sessions` and the SSE stream cover all connected accounts together. The client filters on `Session.account`.
- Endpoints with `?account=` default to `u0` and return `400 bad account` when the account is unknown or not connected. Project ids are only unique within an account.
- Per-session endpoints (`/api/sessions/:id/...`) need no account. The bridge looks the id up in the session list and, when it is not there, asks each connected account (`aside.sessions.get`). So they also work for routine run sessions and other child sessions that are in no list, and right after a bridge restart. An id no account knows is `404 Session not found`.
- Archived sessions are not in the list, but Aside still knows them: `GET /api/sessions/:id` returns them (200), `screenshot` is `404 no tab`, and `resume` on an archived phone or CLI session is `502` ("Session is pending purge").

## Session detail and messages

```json
{ "role": "user | assistant | tool", "text": "...", "tool": { "name": "bash", "title": "List the files", "isError": false }, "ts": 1794541654759 }
```

- `tool` is only present when `role` is `tool`. Thinking, system messages and images are dropped. Text is cut at 4000 characters per message. Oldest first, in Aside's own order (`ts` is not strictly increasing).
- `limit` is how many of the latest messages to return. Default 60. Values over 600 are treated as 600. Anything that is not a whole number >= 1 is `400 bad limit`. `more` is true when older messages exist. "Load earlier" in the app asks again with a bigger limit.
- Rough cost on a session with about 1000 raw messages: under a second for any limit, 15 KB at limit 60 and about 120 KB at limit 600.
- `question` is `{suspension, toolQuestion}` when the session waits for the owner, else null. `queued` holds the prompts queued behind the current turn.
- The bridge stays attached to a new or resumed turn for 5 s only. After that the session keeps running in Aside, so restarting the bridge does not abort running sessions.
- `POST .../resume` on a session that is still running returns `502` with Aside's message ("Agent is already processing..."). Use `steer` or `queue` then.

## Screenshot

`GET /api/sessions/:id/screenshot` returns an `image/jpeg` of the tab the session's agent is using right now, read through `aside repl`. Nothing is clicked and the tab is not activated. It needs the bearer token, so the app fetches it and shows it through an object URL (like `/api/file`).

- `404 {error:"no tab"}` when the session has not opened a tab of its own yet, or the tab is closed. Until the agent opens its own tab Aside reports the owner's tab, which the bridge never shows. Archiving a session closes its tabs.
- The image is at device pixels (2880x1800 on a 1440x900 display at 2x), JPEG quality 60. Aside's `page.screenshot` cannot resize. Over 400 KB the bridge takes it again at quality 30. A simple page is about 130 KB and takes about 0.4 s.

## SSE (`GET /api/stream`)

The app reads it with `fetch` and a stream reader so it can send the `Authorization` header.

- `event: sessions` with `data: {"changed":[Session], "removed":["id"]}`. The first event after connect holds nothing. The client loads the list with `GET /api/sessions` first.
- `event: health` with the same data as `GET /api/health`.
- A `: ping` comment every 20 s.

## Push payload

`{ "title": "Finished: <session title>", "body": "<first 120 chars of answer>", "sessionId": "<id>", "kind": "done | failed | waiting" }`. The title prefix is `Finished`, `Failed` or `Needs you`. The service worker opens `/#/s/<sessionId>` on tap.

A push is sent when a listed session goes from running to done or failed, when it starts waiting, and when a turn started and ended between two polls. The bridge polls every 2 s while something runs and every 15 s when idle. A turn between two polls is recognised like this: the session is done or failed, unread, and its `updatedAt` is newer than at the previous poll (or it was created since). One push per turn. No push for marking unread, archive or unarchive, the first poll after a bridge start, or an account that just connected. Routine runs are child sessions and get no push.

When `ntfyTopic` is set in the config, the same title and body are also posted to `https://ntfy.sh/<ntfyTopic>`.

## Projects

`Session.projectId` matches `id`. `null` means no project. `color` is whatever Aside stores (may be null).

## Routines

Routine: `{id, name, status, rrule, nextRunAt, lastRunStatus, projectId, parentSessionId, lastRunSessionId, lastRunError?, permissionMode}`.

- `lastRunSessionId` is the child session of the latest run, or null. `lastRunError` is only present when `lastRunStatus` is `errored`.
- `permissionMode` is the permission mode of the last run session, read from `session inspect`: `"guard"`, `"full-access"`, or `null`. The field is only present when `allowRoutineRetry` is true.
- A run session can be read with the normal `GET /api/sessions/:id` endpoint.
- Routine retry is off by default (`allowRoutineRetry: false`). `resume`, `steer` and `queue` on a routine run session then return `403 {"error":"routine retry is disabled"}`, and the app shows no Retry button.
- With `allowRoutineRetry: true`, "Retry" in the app is `POST /api/sessions/<lastRunSessionId>/resume`. It continues that run in its own session, so it keeps the routine's permission mode, which may be full access. The app's confirm sheet names that mode.

## Models

Model names are `provider/modelId` strings, e.g. `claude-code/claude-opus-5-5`. `model` values sent to the API are the `id` strings.

- `GET /api/models` returns `models:[{id:"provider/modelId", name:"Claude Opus 5.5", group:"Claude"}]`. The list comes from `~/.aside-pocket/models.json`, built by `aside-pocket catalog`, which reads the model names from Aside's own model menu and keeps the ids Aside accepts. The account's Aside defaults and the models its 15 latest sessions used are appended when the catalog lacks them, with `name` = model id and `group` = provider id. Cached 10 min. Aside has no command that lists every model, so the client also lets the owner type a `provider/modelId`.
- `POST /api/sessions` with `model` omitted uses the account's default. An unavailable model makes the session end at once with an error message in the thread.
- `POST /api/sessions/:id/model` changes the model of an existing session. It applies from the next turn and works while the session runs. `400 bad model` when `model` is not a well-formed string. `502` with Aside's message ("Requested model ... is not available for this account") when the account cannot use it.

## Memory

Read-only, from `aside memory`, per account.

- `GET /api/memory?account=u0&q=<text>` returns up to 10 results, best first. `path` is relative to the account's memory folder (e.g. `notes/example.md`). `score` is a number. `400 bad q` when `q` is empty or longer than 200 characters.
- `GET /api/memory/file?account=u0&path=<path from a result>` returns `{path, text}` (markdown). `404` when the file does not exist, `400 bad path` for anything that is not a relative `.md` path.

## Images in answers

`GET /api/file?path=<absolute path>` returns the image bytes. Only image files (png, jpg, gif, webp) inside an Aside session folder (`~/.aside/u/<n>/sessions/<id>/...`) are allowed. They are read through `aside repl`, not from disk by the bridge. `400 bad path` otherwise. It needs the bearer token, so the app fetches it and shows it through an object URL.

## iOS Shortcut "Send to Aside"

There is no separate endpoint. The Shortcut calls `POST /api/sessions` with `Authorization: Bearer <token>` and JSON `{prompt, account?, effort?, model?}`. The app's Settings has a "Copy token" action for it. `tailscale serve` adds the `Tailscale-User-Login` header, so the phone only needs Tailscale connected. Steps are in the README.

## Notes
- `GET /api/health` returns `{ok:true, version, features:{routineRetry:boolean}, aside, running}`.
- `POST /api/sessions/:id/resume`, `/steer` and `/queue` on a routine run session (its `trigger.type` is `routine`) return `403 {error:"routine retry is disabled"}` unless `allowRoutineRetry` is `true` in `config.json`. So "Retry" on a routine only works when `features.routineRetry` is true.
- `GET /api/routines` items carry `permissionMode` (`"guard"`, `"full-access"` or `null` when the routine never ran) only when `allowRoutineRetry` is true; otherwise the key is absent.
- The model list lives in `<data dir>/models.json` and is built with `aside-pocket catalog`. An account that fails during a build keeps the list it had.
- The pairing code comes from `aside-pocket pair`.
- `GET /api/file` only accepts paths under the Aside folder of the Mac user that runs the bridge (`~/.aside/u/<n>/sessions/...`).
