# What the Aside CLI exposes and how Aside Pocket uses it

A technical note for anyone who changes the bridge. It lists the Aside CLI commands the bridge calls, the JSON they return, and how the bridge works out the state of a session.

Tested with Aside 1.26.x. Aside documents little of this, so any of it can change with an Aside update. Where it matters, a statement is marked verified (it was run and observed) or inferred.

- CLI: `~/.aside/cli/Aside CLI.app/Contents/MacOS/aside`. The path has spaces, so always pass it as one argument.
- Daemon: `http://127.0.0.1:21420`. The bridge only calls `GET /health`.
- Example shapes: `docs/fixtures/*.json`. All values in them are invented. Field names and enum values are the real ones.

## Commands

Timings are rough figures on an M-series MacBook, wall clock of the whole CLI process.

| Command | Purpose | Output | Time |
|---|---|---|---|
| `aside --version` | version | text | 60 ms |
| `GET /health` | daemon up, running count | `{service, version, pid, host, port, ready, status:"idle\|running", startedAt, runningSessionCount, semaphore:{available, capacity}}` | 5 ms |
| `account list --json` | signed-in accounts | `{accounts:[{id, name, email, authStatus}]}` | 0.15 s |
| `host profiles --account u<n> --json` | browser profiles of an account | `{profiles:[{profileId, connected}]}` | 0.15 s |
| `session list --json` | all root sessions, including CLI ones | `{sessions:[{id, projectId, title, trigger?, status, incognito, ephemeral, readAt, createdAt, updatedAt, branchedFrom?}]}` | 0.15 s |
| `session inspect <id> --json` | one session and its latest answer | `{session:{...}, answer, error}`. About 140 KB, most of it `systemPrompt`. No transcript | 0.15 s |
| `exec --permission guard --effort <e> "<prompt>"` | start a session | stderr line 1 is `created new session: <id>` within about 1 s, then progress. The answer goes to stdout. With `--json` there is one JSON at the end only | runs until done |
| `session resume <id> "<prompt>"` | new turn on an existing session | like `exec`. stderr line 1 is `continuing existing session: <id>` | runs until done |
| `session steer <id> "<prompt>"` | interrupt the current step with a prompt | receipt, exits at once | 0.15 s |
| `session queue <id> "<prompt>"` | run a prompt after the current turn | receipt, exits at once | 0.15 s |
| `session stop <id>` | stop a running session | receipt | 0.15 s |
| `session archive <id>` | archive | receipt | 0.15 s |
| `repl --json "<js>"` | read the `aside` global, take screenshots | `{run:{content:[{type:"text",text} \| {type:"image",data,mimeType}], error, elapsedMs}}` | 0.15 s and up |
| `memory search "<q>" --json` | semantic search | array, up to 10 | 0.12 s |
| `memory show <path>` | one memory file | markdown text | 0.12 s |

Every command takes `--account`. The bridge passes `u<n>:<profileId>`, the account plus its open browser profile.

Each CLI call costs 0.12 to 0.16 s of process start, so polling `session list --json` every 2 s is cheap. Loops belong inside one `repl` script, not one process per session: scanning 200 transcripts in a single `repl` call takes about 6 s.

### Receipts and exit codes (verified)

| Call | stdout | stderr | exit |
|---|---|---|---|
| `session steer <id> "<p>"` on a running session | `Steered session <id> (running)` | empty | 0 |
| `session steer <id> "<p>"` on an idle session | `Steered session <id> (idle)`. It starts a new turn and the status becomes `running` | empty | 0 |
| `session steer <id> --json "<p>"` | `{"session":{"id":"...","status":"running"},"outcome":"steered"}` | empty | 0 |
| `session queue <id> "<p>"` | `Queued session <id> (running)` or `(idle)` | empty | 0 |
| `session queue <id> --json "<p>"` | `{"session":{"id":"...","status":"running"},"outcome":"queued"}` | empty | 0 |
| `session stop <id>` while running | `Stopped session <id> (interrupted)` | empty | 0 |
| `session stop <id>` when already idle | `Stopped session <id> (idle)`. Nothing changes | empty | 0 |
| `session stop <id> --json` | `{"session":{"id":"...","status":"interrupted"},"outcome":"stopped"}` | empty | 0 |
| `session archive <id>` | `Archived session <id>` | empty | 0 |
| `session archive <id> --json` | `{"session":{"id":"...","status":null},"outcome":"archived"}`, also when already archived | empty | 0 |
| `session resume <id> --json "<p>"` | `{"session":{"id":"..."},"outcome":"completed","answer":"...","error":null}` at the end | empty | 0 |
| `session resume <id> --timeout 8s "<p>"` | empty | progress lines, then `Error: Stopped waiting after 8s; session <id> keeps running.` | 1 |
| `session resume <id>` with no prompt and no stdin | empty | `Error: Pass a prompt in argv or on stdin: aside exec "<PROMPT>"` | 2 |
| `session resume <archived id> --json "<p>"` | `{"session":{"id":"..."},"outcome":"failed","answer":null,"error":"Session is pending purge: <id>"}` | empty | 1 |
| `stop` or `steer` with an unknown id | empty | `Error: Session not found` | 1 |
| `resume` with an unknown id | empty | `continuing existing session: <id>` then ` • Error Session not found: <id>` | 1 |
| `exec` whose session gets stopped from elsewhere | empty | progress lines | 1 |

Behaviour (verified):

- Steer and queue on an idle session both start a new turn. They return at once. `resume` and `exec` block until the turn ends or `--timeout` passes. After the timeout the session keeps running.
- The bridge runs `exec` and `resume` with `--timeout 5s`. A CLI process that is killed in the middle of a turn aborts the turn, so a short timeout keeps a bridge restart from aborting sessions.
- A message queued on a running session sits in `queuedMessages` of `session inspect` (a `user` message plus an injected `system-message`). After `stop` it stays queued. The next `resume` runs its own prompt and then the queued one, so `inspect.answer` ends up being the answer to the queued prompt.
- A steer sent while running shows in the transcript as a `steering` message and then again as a `user` message. The bridge shows it once.
- After `stop`, `inspect` gives `status:"interrupted"`, `answer:null`, `error:null`.
- Archive removes the session from `session list --json` at once. `session inspect <id> --json` and `aside.sessions.get(id)` still work, and inspect gains `archivedAt`. Archiving closes the tabs the session opened. An archived CLI session is "pending purge" and cannot be resumed. Whether an archived session that was started in the Aside UI can be resumed has not been tested.

### The two session lists do not match

| | `session list --json` | repl `aside.sessions.list()` |
|---|---|---|
| CLI-started sessions (`ephemeral:true`, `trigger.source:"cli"`) | yes | no |
| Subagent and routine run sessions (have `parentId`) | no | no (use `childSessions(parentId)`) |
| Archived | no | no |
| Extra fields | none | `parentId`, `branchedFrom`, `routineId`, `suspension` |
| Page size | everything | at most 200, `cursor` is an offset |

Sessions the bridge starts through the CLI only show up in `session list --json`. `suspension` is only visible through the repl (`list`, `get`) and through `session inspect --json`. So the bridge reads both and merges them.

`aside.sessions.get(id)` works for any id of that account, including child, ephemeral and archived sessions. It throws `Session not found: <id>` otherwise, also for another account's id. The bridge uses that to find which account a session belongs to.

The bridge's own `aside repl` calls appear in `session list --json` for a moment as ephemeral sessions titled `Aside CLI REPL`. The bridge filters them out.

## Session states

Status values Aside returns: `running`, `idle`, `interrupted`, `errored`, `aborted`, `suspended`.

| Bridge state | How it is detected | Confidence |
|---|---|---|
| running | `status == "running"` in `session list --json` | verified |
| done | `status == "idle"`. `inspect.answer` holds the last assistant text | verified |
| failed | `status == "errored"`. `inspect.error` is a plain string such as `"Request timed out."` or `"Connection error."`, and `answer` is null. Also `status == "aborted"`: the CLI process that ran the turn died, and `error` is "Request aborted" | verified |
| stopped | `status == "interrupted"`, set by `session stop` on a running session. `answer` and `error` are null | verified |
| unread | `readAt < updatedAt` and not running | verified |
| waiting (approval) | `status == "suspended"`, or a non-empty `suspension` object | verified on one session, a routine run |
| waiting (question) | a non-empty `toolState.question` in `session inspect` | inferred, never observed |

### Unread (verified)

- `aside.sessions.markUnread(id)` sets `readAt` to `1970-01-01T00:00:00.000Z`. `updatedAt` does not change.
- `aside.sessions.markRead(id)` sets `readAt` to now. `updatedAt` does not change.
- Timestamps in `session list` are truncated to whole seconds.
- CLI-started sessions get `readAt = createdAt` and nothing marks them read. Every finished CLI session counts as unread until the bridge calls `markRead`, which it does when the owner opens the session on the phone.
- `markRead` is the only repl write call the bridge makes on sessions, apart from an explicit model change.

### Waiting

Verified:

- A session blocked on a file-write approval has `status:"suspended"`. `session inspect` prints `Status suspended`, and both `inspect --json` and `aside.sessions.get(id)` return:
  ```json
  "suspension": {
    "id": "<uuid>",
    "kind": "approval",
    "toolCallId": "<id of the waiting toolCall>",
    "request": { "scope": { "type": "file", "path": "<path>", "mode": "write" } },
    "createdAt": "2026-11-10T09:30:00.000Z"
  }
  ```
  See `fixtures/suspension.json`. The observed session was a routine run, which is a child session and in neither list.
- `suspension` is not documented in `aside skills show aside`, `aside guide`, `aside guide repl` or any `--help`.
- The tool an agent uses to ask the owner is `ask_user_question`. Its arguments:
  ```json
  { "questions": [ { "question": "...", "header": "...", "multiple": true, "options": [ { "label": "...", "description": "..." } ] } ] }
  ```
  `multiple` is optional. One call can carry several questions. Options only have `label` and `description`.
- When answered, the `toolResult` (`toolName:"ask_user_question"`, `isError:false`) has one text part:
  ```
  Asked user 2 question(s). Received response.

  User responses to asked questions:
  - <header>: <chosen label>
  - <header>: <label>, <label>          (multiple)
  - <header>: custom: <free text>       (the owner typed their own answer)
  ```
  The free text can contain secrets the owner pasted. The bridge must not log tool results.
- Stopping a session while a question is open writes a `toolResult` with `isError:true` and text `Session interrupted by user.` The session ends `interrupted`.
- `inspect.session.toolState.question` was `{}` on every session checked, including ones that had asked questions before and the suspended one.

Inferred, not verified:

- A session waiting on `ask_user_question` probably has `status:"suspended"` with a `suspension` of another `kind`, and `suspension.toolCallId` pointing at the tool call. It may instead stay `running` with the pending question in `toolState.question`. No unanswered question has been caught live.
- `session list --json` probably shows `status:"suspended"` for a root session in that state. It has only been seen through inspect, on a child session.

What the bridge does: a session is waiting when its status is `suspended` or its `suspension` is non-empty. For root sessions it gets `suspension` from `aside.sessions.list({limit:200})`. In the detail view it also treats a non-empty `toolState.question` as waiting and passes both objects to the app as `question`.

There is no CLI command to answer a question or grant an approval. The bridge sends the owner's reply with `session resume`. That has not been tested against a live suspended session, so it may not release the approval.

Sessions started from the CLI cannot reach this state. They run with `runtimeConfig.unattended:true`, have no ask-user tool, and a Guard denial fails the tool call instead of prompting. Waiting can only come from sessions started in the Aside UI or by routines.

### Transcript messages

`await aside.sessions.messages(id, {limit, order, offset})`. The default is the first 50 ascending; use `order:'desc'` for the tail. At most 200 per call whatever `limit` says. Page with `offset` (`cursor` is ignored). Timestamps are not strictly increasing in the returned order. See `fixtures/repl-messages.json`.

Roles: `user`, `assistant`, `toolResult`, `turn-lifecycle`, `system-message`, `steering`, `user-message-metadata`, `compaction`.

- `user`: `{role, content:[{type:"text",text}], timestamp, metadata?}`
- `assistant`: `{role, content:[parts], api, provider, model, usage, stopReason:"toolUse|stop", rawStopReason, timestamp, durationMs, completedAt, ...}`. Parts are `text`, `thinking`, `toolCall {id, name, arguments}`. Most tools put a human-readable `arguments.title`, which the bridge shows as the tool line.
- `toolResult`: `{role, toolCallId, toolName, content:[text|image parts], details, isError, durationMs, timestamp, timing}`
- `turn-lifecycle`: `{role, event:"started|final-started|finished", turnId, timestamp}`
- `system-message`: `{role, content:<string>, kind, metadata, timestamp}`. Kinds: `memory_recall`, `site_skill`, `agent_peers`, `routine_notification`, `tab_lifecycle`, `subagent_done`, `agent_message`, `recovery`, `routine_trigger`
- `steering`: `{role, id, content:[text], attachments, timestamp, after}`
- Tool names: `repl`, `bash`, `read_file`, `subagent`, `websearch`, `webfetch`, `subagent_wait`, `memory_search`, `write_file`, `message_agent`, `write_todos`, `routine_update`, `bash_interact`, `history_search`, `ask_user_question`, `edit_file`, `get_time`, `search_tools`, `mcp__*`.
- `aside.sessions.messageRows(id)` does not return an array. Do not use it.

The bridge keeps `user`, `steering` and `assistant` text plus one line per tool call, and drops everything else.

### Child sessions

`aside.sessions.childSessions(parentId, {triggeredBy?})` returns summaries with `parentId` set and one of two triggers:

- `{type:"subagent", toolCallId, label, profile:"default|fork_self|context_explorer", modelSelectionSource?}`
- `{type:"routine", title}` plus a top-level `routineId`

`{triggeredBy: <toolCallId>}` narrows to the children of one `subagent` tool call.

## Accounts and profiles

Aside can hold several signed-in accounts. The CLI names them `u0`, `u1`, and so on.

- `account list --json` returns the accounts. The bridge keeps those with `authStatus == "active"`.
- `host profiles --account u<n> --json` returns that account's browser profiles with a `connected` flag. Connected means the profile is open in Aside on the Mac. The CLI cannot reach an account with no connected profile, so the bridge reports it as `connected:false` and skips it.
- For every other call the bridge passes `--account u<n>:<profileId>` with the connected profile.
- Sessions, projects, routines, models and memory are per account. Project ids are only unique within an account.

The bridge caches this for 60 s, so a profile that was just opened shows up within a minute.

## Routines

`aside.routines.list({limit})` (at most 200, default 20) and `aside.routines.get(id)`. Read-only. Shape, see `fixtures/routines.json`:

`{id, name, prompt, rrule, type:"child", environment:"device", deviceId, revision, parentSessionId, projectId, channelId, status, nextRunAt, metadata:{origin:{type:"session-message", sessionId, messageId}, memoryPath}, sessionConfig:{model:{provider, modelId, thinkingLevel, fastMode}, harnessId, permissionMode}, createdAt, updatedAt, pausedAt, deletedAt, lastRunStatus}`

- `status`: `active`, `paused`, `completed`. `lastRunStatus`: `idle`, `errored`, `null`.
- `rrule` is two lines: `DTSTART;TZID=...:...\nRRULE:...`.
- Date fields are `Date` objects inside the repl. `JSON.stringify` turns them into ISO strings.
- Each run is a child session of `parentSessionId` with `trigger.type:"routine"` and `routineId`. Run sessions are in neither session list. The bridge gets them with `aside.sessions.childSessions(parentSessionId)`, filters on `routineId`, and takes the most recently updated one as the last run.
- A run session keeps the routine's `permissionMode`, which can be `full-access`. A `resume`, `steer` or `queue` on it continues in that mode. This is why the bridge refuses those three calls on routine run sessions unless `allowRoutineRetry` is set (see `docs/config.md`).
- There is no CLI or repl call to pause, edit or run a routine. Only the agent's `routine_update` tool can. The bridge shows routines read-only.

## Models

Aside has no command that lists the models an account can use. The bridge gets a list from three places:

- `aside.settings.getAll()` in the repl gives `defaultModel`, `modelCategories` and `customModels`, each `{provider, modelId, ...}`. Read-only.
- `session inspect` gives the `model` each recent session used.
- `aside-pocket catalog` builds `~/.aside-pocket/models.json`. Per connected account it opens Aside's side panel in a tab, opens the model menu and reads the group and model names. It clicks nothing else. It then guesses a `provider/modelId` for each name and tries each guess with `aside.sessions.update(id, {model})` on a helper session it started for this purpose. Aside rejects a model the account cannot use, so the guesses that are accepted are kept. The helper session is archived at the end.

The catalog can miss models: a name whose id the guessing does not hit is left out, and a change to Aside's menu markup would break the reading step. The app therefore always accepts a typed `provider/modelId`.

A model is set on a new session with `exec --model provider/modelId`, and changed on an existing one with `aside.sessions.update(id, {model})`. The change applies from the next turn.

## Screenshots

Verified with a tab opened by a test session.

- `session inspect --json` gives `session.activeTabTargetId`. For a session started with `aside exec` it is set from the start and equals `browserBinding.anchorTargetId` until the agent opens its own tab. The anchor is the tab the owner had active when the session started. The bridge treats "equal to the anchor" as "no tab" and never screenshots it.
- Script:
  ```js
  await attachBrowserTab('<activeTabTargetId>');
  const shot = await page.screenshot({ type: 'jpeg', quality: 60 });
  console.log(JSON.stringify(shot.toString('base64')));
  ```
  The whole call takes about 0.2 s for a simple page.
- `page.screenshot()` takes `type` and `quality`. `scale`, `clip.scale` and other size options are ignored. The image is always at device pixels, 2880x1800 on a 1440x900 display at 2x. It returns a Node `Buffer`.
- Sizes for a simple page: PNG about 200 KB, JPEG at quality 60 about 130 KB. A background tab gives a smaller file.
- Attaching by `targetId` did not activate the tab or change which tab is active, and the tab stayed open after the repl process exited. Aside's docs say nothing on this. It was checked on one tab.
- `listBrowserTabs()` returns every open tab, including the owner's. The bridge never calls it.
- If the tab is gone (session archived, tab closed) `attachBrowserTab` throws.

## Memory

Read-only. `aside memory <search|list|show|path>`, all with `--account`.

- `memory search "<q>" --json [-n 1..10]` returns `[{path, title, headings:[...], excerpt, line, lineEnd, score, chunkId, date}]`, 5 results by default. `path` is absolute here.
- `memory show <path>` prints the markdown file and wants a path relative to the memory folder. It answers `Error: Path escapes memory directory` for `..`. An unknown path prints nothing and still exits 0, so the bridge treats empty output as not found.
- `memory list --json` returns `[{path, absolutePath, lastUpdatedAt, sizeBytes}]`. The bridge does not use it.

The bridge strips the memory folder prefix from search results and only accepts relative `.md` paths for `show`.

## Images

Agents save images into their session folder, `~/.aside/u/<n>/sessions/<id>/`, and name the absolute path in the answer. The bridge does not read that file from disk. It checks that the path is an image file (png, jpg, gif, webp) inside a session folder, then reads it through `aside repl` with `fs.readFile`, with an 8 MB cap.

## Limits

- Sessions started from the CLI are unattended. They cannot ask questions or request approvals. A denied action fails.
- There is no way to answer a question or approve from the CLI, only `steer` or `resume` with text.
- Aside has no event stream. The bridge polls.
- The CLI has no transcript command. Transcripts come through `repl` and `aside.sessions.messages`.
- Archived CLI sessions are purged and cannot be resumed.
- `exec --json` gives the session id only at the end. To get the id early, run without `--json` and read stderr line 1.
- `inspect --json` is large because of `systemPrompt`. Do not call it per session per poll.
- A `repl` call times out after 120 s.
- `aside host list` can fail with "Remote Control requires the Pro plan". The bridge uses the local host only.

## Things the bridge must never call

- `aside session delete`. It cannot be undone.
- `aside.settings.set`, `aside settings save-sessions|computer-use|analytics`.
- `aside.sessions.update` with anything but `{model}`. It can also change the permission mode and permissions. The bridge uses it only for an explicit model change, and the catalog only on its own helper session.
- `aside.sessions.archive` or `unarchive` from the repl. Use `aside session archive <id>`, and only when the owner asks for it.
- `aside.channels.create|update|restart`.
- `aside.device.listPendingConnections`, `approveConnection`.
- `aside host use`, `aside account use`, `aside login`, `aside logout`, `aside update`, `aside --update`.
- `--permission full-access` on `exec`. Always pass `--permission guard`.
- `attachActiveBrowserTab()`, or `attachBrowserTab` on anything other than a session's own `activeTabTargetId`.
- Any direct read or write under `~/.aside/`, and any daemon endpoint other than `GET /health`.
- Logging transcript content, tool results, `systemPrompt`, memory or `listBrowserTabs()` output.
