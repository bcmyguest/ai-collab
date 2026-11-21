# Owned sessions: shared contract

The contract the four harness adapters (Claude, Codex, Cursor, OpenCode) code against. The `ai-collab-runner` user service drives these sessions directly instead of observing them through hooks. Background: [research](research/owned-sessions.md), [review](research/owned-sessions-review.md), [message delivery](research/pulsar-parity.md).

The types live in `runner/types.d.ts`, the constants and validators in `runner/contract.mjs`, and the reference adapter in `runner/adapters/fake.mjs`. Where this page and the code disagree, the code wins; fix the page.

## Settled decisions

| Topic | Decision | Source |
|---|---|---|
| Process | A separate `ai-collab-runner` systemd user unit (`deploy/ai-collab-runner.service`) | operator |
| Language | ESM JS with JSDoc and a `.d.ts` contract. TypeScript is allowed; adapters in `.ts` must use erasable syntax only, so Node runs them without a build step. Rust is a long-term option. | operator |
| Execution | Durable workflows: a SQLite workflow/step log shaped like DBOS (see [Durable execution](#durable-execution)) | operator; this page picks the implementation |
| Codex | Its own `codex app-server` child per runner, launched with `-c thread_unload_delay_secs=0` | review |
| Claude | Agent SDK `query()` with an `AsyncIterable` prompt; the adapter picks the session UUID and passes it as `options.sessionId` (sdk.d.ts L2273) | research |
| OpenCode | The registered OpenCode service (`~/.local/state/opencode/service.json`), HTTP plus SSE; permission replies are always `once` | research, review |
| Cursor | `cursor-agent acp`, in a git worktree outside OpenShell for now; `--force` inside an OpenShell sandbox later | operator |
| Events | ntfy envelopes now; normalized event names follow AG-UI so a later AG-UI or SSE stream maps one to one | operator |
| Hook stand-down | Owned record keyed by session label; only the process the runner spawned stands down, and agents started inside it register as its children | operator |
| Cut runs | Never resent. Every cut run, on every adapter, is marked interrupted | operator |
| T3 Code | MIT; may be ported with its notice kept (one-line header naming T3 Code, the file, and the commit) | operator |

## Architecture

```mermaid
flowchart LR
  phone[Phone / browser] --> ui[ai-collab-ui.service]
  ui -- "start / interrupt / close<br/>HTTP over runner.sock" --> runner[ai-collab-runner.service]
  ui -- "chat, approval replies" --> ntfy[(ntfy)]
  ntfy -- "inbox + broadcast stream" --> runner
  runner -- "activity, status, approval, receipt" --> ntfy
  ntfy --> ui
  runner --- log[(runner.db<br/>workflow log)]
  runner --- owned[(owned/&lt;label&gt;.json)]
  runner --> codex[codex app-server child]
  runner --> claude[claude CLI via Agent SDK]
  runner --> oc[OpenCode service]
  runner --> cursor[cursor-agent acp]
  hooks[harness hooks] -- "stand down if owned" --> owned
```

## Durable execution

The operator asked for DBOS-style durable execution: workflows and steps are checkpointed, so a runner restart resumes each session's workflow instead of every adapter inventing its own recovery.

### DBOS Transact for TypeScript vs a minimal layer

| | DBOS Transact (`@dbos-inc/dbos-sdk` 5.6.0) | Minimal layer (`runner/durable.mjs`) |
|---|---|---|
| Storage | Postgres only. The README says "built on top of Postgres"; `dist/src/config.js` builds `postgresql://` URLs; the 5.6.0 package has no SQLite code path (searched `dist/` for "sqlite": no match). No Postgres is installed on this machine. | `node:sqlite` (built into Node 22.13+; Node 26 here). One file: `$AI_COLLAB_STATE_DIR/runner.db`, mode 0600 |
| Licence | MIT | Ours (Apache-2.0) |
| Weight | 2.04 MB unpacked, plus `pg`, `yaml`, `commander`, `superjson`, `serialize-error` | About 200 lines, no dependency |
| Features | Workflows, steps, durable queues, notifications (`send`/`recv`), scheduling, workflow management, client API | Workflows, steps, `send`/`recv` with dedupe, key-value store, recovery of PENDING workflows |
| Cut steps | Re-executes an unfinished step at recovery (at-least-once) | A step may declare `onCut`, which replaces re-execution; this enforces "never resend" |
| Operations | A Postgres server to run, upgrade and back up | One SQLite file next to the existing state |

**Pick: the minimal layer.** DBOS would add a Postgres server to a single-user machine to run a single-process runner with a few concurrent sessions. The minimal layer keeps DBOS's names (`startWorkflow`, `step`, `recv`, `send`, `recover`), so if Postgres ever arrives, porting means swapping `runner/durable.mjs` for DBOS and wrapping the session workflow with `DBOS.registerWorkflow`. Costs: we own the layer's correctness (covered by `test/runner-durable.test.mjs`), and it has no queues, scheduler or workflow UI.

### Log schema (`runner.db`)

| Table | Columns | Meaning |
|---|---|---|
| `workflows` | `id, name, input, status (PENDING, SUCCESS, ERROR, CANCELLED), output, error, created_at, updated_at` | One row per session workflow |
| `steps` | `workflow_id, seq, name, status (started, done, error), output, error, started_at, finished_at` | A checkpoint per step and per `recv`, numbered in call order |
| `messages` | `id, workflow_id, topic, value, dedupe UNIQUE, consumed, created_at` | Durable input to a workflow; `dedupe` holds `ntfy:<event id>` |
| `kv` | `key, value` | `ntfy-cursor:<project>`, the last ntfy event the runner handled |

Replay rule: a step whose row is `done` returns its recorded output without running. A step whose row is `started` was cut by a stop or crash: it runs `onCut` when one is given and re-executes otherwise. A step whose name differs from the recorded one throws `NonDeterminismError`, so workflow code must call steps in a deterministic order.

### The session workflow

One workflow per owned session, id `session-<uuid>`, name `session`, input `{project, harness, place, permissionMode, prompt, model?}`. Code: `sessionWorkflow` in `runner/runner.mjs`.

| Step | Does | On replay | When cut |
|---|---|---|---|
| `place` | Resolves the project root; for `worktree`, runs `git worktree add -b ai-collab/<harness>-<stamp>` under `.claude/worktrees/` | returns the cwd; never adds a second worktree | re-executes |
| `open` | `adapter.open(options, ctx)`; records `{nativeId}` | returns `nativeId`; there is no live handle until the next input | the workflow ends: "the runner stopped while the session opened" |
| `claim` | Writes `owned/<label>.json` (status `idle`) | skipped; the record is read from disk | re-executes (idempotent) |
| *(not a step)* | Registry entry (`lib/sessions.mjs` `recordSession`, pid = runner); "owned session started" notice on the first run only | runs again, so the registry shows the restarted runner's pid | |
| `recv:input` | Waits for durable `input` messages and takes them all as one run (texts joined by a blank line, message ids merged); `{close:true}` ends the loop | returns the recorded batch | not checkpointed until consumed, so nothing is lost |
| `run.send` | `liveHandle()` (resumes when needed), `handle.send(input)` → `{runId}`, then read receipts | returns `{runId}` | `onCut`: the run is marked interrupted ("runner restarted before the harness accepted the input"); **not resent** |
| `run.wait` | Waits for `RUN_FINISHED` or `RUN_ERROR` with that `runId` | returns the outcome | `onCut` marks the run interrupted |
| `close` | Cancels open approvals, `handle.close()`, record `ended`, registry pid cleared, "session ended" row | returns | re-executes |

The first prompt is the first input; the loop starts with it, not with `recv`.

### Restart and resume rules

| Situation at restart | Result |
|---|---|
| Waiting in `recv:input` (idle) | Workflow replays to `recv`; no harness call until the next input, which resumes the native session lazily |
| Cut inside `run.send` | Marked interrupted with `RUN_FINISHED {outcome:"cancelled", reason}`; the operator resends by hand |
| Cut inside `run.wait` | Marked interrupted (`turn ended · interrupted · runner restarted`); `record.cut = {runId, at, reason}`; open approval cards end with reason `cancelled` |
| `resume: "none"` | Next input fails with 409; the operator closes the session |
| Adapter module missing at boot | The workflow fails (status ERROR); its owned record stays as it was |
| Messages that arrived on ntfy while the runner was down | Read from the stored `ntfy-cursor:<project>` and deduplicated by `ntfy:<event id>` |

`runner.stop()` (SIGTERM) aborts workflows where they wait and leaves open steps `started`, so the rules above apply at the next boot. The cut row is published at that boot, not at stop, so it appears exactly once.

### Scheduled workflows

`scheduled(name, {everyMs}, fn)` in `runner/durable.mjs` registers a DBOS-style scheduled workflow (DBOS `@DBOS.scheduled`). Each tick is a workflow named `scheduled:<name>` with id `<name>@<scheduledTime ISO>`, and `fn(scheduledTime, actualTime, wf)` runs in it. Ticks align to the Unix epoch: a 30-minute schedule fires at :00 and :30 UTC. Cron is not supported.

| Case | Result |
|---|---|
| Tick due, id unused | Runs; the id stays in the log, so a tick never runs twice, even across restarts |
| Runner down across one or more ticks, then started | Runs the latest due tick once. Earlier missed ticks never run: no backlog |
| Tick due while the previous tick still runs | Recorded as `SUCCESS` with output `{"skipped":"previous run still going"}`; not retried |
| Runner stops during a run | Its command gets SIGTERM and the step stays `started`; at the next boot the step records `cut` and the command is not re-run |
| `POST /v1/schedules/:name/run` | Starts a tick at the current time under its own id, with the same overlap rule; returns 202 without waiting |

The command step runs `execFile` with argv (no shell), `cwd` and `timeoutSec` from the entry. Its result is `{ok, exitCode, timedOut, durationMs, tail, scheduledTime, actualTime}`, where `tail` is the last 2000 characters of stdout and stderr. Ticks publish no ntfy rows: a schedule has no session to publish under.

Config: `$XDG_CONFIG_HOME/ai-collab/schedules.json` (default `~/.config/ai-collab/schedules.json`), or the path in `AI_COLLAB_SCHEDULES`. A JSON array; the runner reads it at start and refuses to start on an invalid entry. A missing file means no schedules. Code: `runner/schedules.mjs`.

```json
[
  { "name": "pm", "everyMinutes": 30, "cwd": "/home/b/ai-collab",
    "command": ["cursor-agent", "-p", "--trust", "--model", "composer-2.5", "--resume", "<id>", "PM tick: follow the goal from your first message (steps 1-5)."],
    "timeoutSec": 900 }
]
```

| Key | Type | Required |
|---|---|---|
| `name` | 1–40 chars of `a-z`, `0-9`, `-`; unique | yes |
| `everyMinutes` | positive integer | yes |
| `cwd` | absolute path | yes |
| `command` | non-empty array of strings: argv, no shell | yes |
| `timeoutSec` | positive integer, default 900 | no |

Control socket only (operator): `GET /v1/schedules` returns `{schedules: [{name, everyMs, nextRun, last: {id, status, scheduledTime, output, error}}]}`; `POST /v1/schedules/:name/run` runs a tick now. Neither route is on MCP or ntfy.

## Adapter interface

The native calls below come from the research doc; each adapter agent verifies its own column against the harness before relying on it.

Each adapter is `runner/adapters/<harness>.mjs` with a default export `(options: {env, stateDir}) => Adapter` (`AdapterFactory` in `runner/types.d.ts`). `runner/main.mjs` loads the harnesses in `AI_COLLAB_RUNNER_HARNESSES` (default all four) and skips a missing module.

| Member | Contract | Claude | Codex | OpenCode | Cursor |
|---|---|---|---|---|---|
| `capabilities.resume` | `transcript` or `none` | `transcript` | `transcript` (own child dies with the runner) | `transcript` | `transcript` |
| `capabilities.steer` | whether `steer()` exists | `streamInput` | `turn/steer` | `/prompt` `delivery:"steer"` | false until verified |
| `available(env)` | `{ok, detail?}`, no tokens | CLI present | `codex --version` | service reachable | `cursor-agent --version` |
| `open(options, ctx)` | Native session, no prompt. `handle.nativeId` is set when it resolves | `query()` with `sessionId` = new UUID | `initialize`, `thread/start` | create a session (endpoint unverified) | `initialize`, `session/new` |
| `resume(record, ctx, env)` | Reattach to `record.nativeId` for the next input; a cut run is not resumed | `options.resume` | `thread/resume` | reconnect SSE, list pending permissions | `session/load` |
| `handle.send(input)` | Starts a run; resolves `{runId}` once the harness accepted it | yield an `SDKUserMessage` | `turn/start` | `POST .../prompt` | `session/prompt` |
| `handle.steer(input)` | Adds input to the running run | `streamInput` | `turn/steer` | `delivery:"steer"` | — |
| `handle.interrupt()` | Ends the run; the adapter then emits `RUN_FINISHED {outcome:"cancelled"}` | `query.interrupt()` | `turn/interrupt` | `POST .../interrupt` | `session/cancel` |
| `handle.setPermissionMode(mode)` | Applies a mode from the permission table to the open session; called only by the runner on the operator's control-socket request | `query.setPermissionMode()` | next `turn/start` settings | the runner's auto-reply set | unverified |
| `handle.respond(interruptId, decision)` | `{behavior:"allow"\|"deny", answers?}` | `canUseTool` resolves | approval response | `.../permission/:id/reply` `once` or `reject` | `request_permission` result |
| `listModels(env)` | `[{id, label?, default?}]` | `initializationResult()` | `model/list` | `model.list` | unverified |
| `listCommands(cwd, env)` | `[{name, description?, argumentHint?}]`, no tokens | `initializationResult()` (T3 ClaudeProvider.ts L520-L601) | `skills/list` | `command.list` | — |
| `handle.contextUsage()` | `{tokens, window?}` or null | `getContextUsage()` | last `thread/tokenUsage/updated` | session stats | — |
| `handle.close()` | Ends the session's process; the native session stays resumable | end the prompt iterable | adapter decides | drop SSE | adapter decides |
| `adapter.shutdown()` | Stops shared children after all sessions closed | — | kill the app-server child | — | kill the ACP child |

Rules for every adapter:

- Emit only the events below, through `ctx.emit`. The runner validates each with `eventProblem` and drops malformed ones.
- Spawn children with `options.env`, `shell: false`, and argv from a fixed template; the prompt is never an argv element that a CLI could read as a flag (`checkPrompt` already rejects a leading `-`).
- Export `AI_COLLAB_PARENT=<harness>#<label>` (`label` = `sessionLabel(nativeId)`) into the shell environment the agent runs commands in, as `lib/family.mjs` does for hook-driven sessions, so an agent it starts registers as the owned session's child.
- Map `options.permission` (from the permission table) onto the harness; never widen it.
- Emit completed items. `TEXT_MESSAGE_CHUNK` is allowed but the ntfy path drops it; it is for the later SSE stream.
- Reject `open` with an `Error` whose message the operator can act on. Never print secrets into it.
- No real CLI runs in tests: drive the adapter against a fake transport (a stub JSON-RPC peer, a stub HTTP server) plus `test/helpers/fake-ntfy.mjs`.

## Normalized events

Names follow AG-UI 1.0 (`@ag-ui/core` 1.0.5 `EventType`, MIT). The runner adds `threadId` (the session address) and the AG-UI envelope when an AG-UI stream replaces ntfy.

| Runner event | Fields | AG-UI event(s) | ntfy today |
|---|---|---|---|
| `RUN_STARTED` | `runId, prompt?` | `RUN_STARTED {threadId, runId}` | activity `prompt` (input = prompt); status `start` |
| `TEXT_MESSAGE_CHUNK` | `messageId, delta, subagent*` | `TEXT_MESSAGE_CONTENT` (after one `TEXT_MESSAGE_START`) | none (4 KB cap, no streaming) |
| `TEXT_MESSAGE_END` | `messageId, text, subagent*` | `TEXT_MESSAGE_START` + `TEXT_MESSAGE_CONTENT` + `TEXT_MESSAGE_END`, or `TEXT_MESSAGE_CHUNK` | activity `text` (output, callId = messageId) |
| `TOOL_CALL_START` | `toolCallId, toolCallName, args?, subagent*` | `TOOL_CALL_START` + `TOOL_CALL_ARGS` + `TOOL_CALL_END` | activity `tool_call` (tool, input, callId) |
| `TOOL_CALL_RESULT` | `toolCallId, toolCallName, content?, ok` | `TOOL_CALL_RESULT` | activity `tool_result`, or `error` when `ok` is false; a long result also travels as a .txt attachment |
| `INTERRUPT_REQUESTED` | `interruptId, reason (tool_approval, question), toolCallId?, toolCallName, summary, args?, questions?` | `RUN_FINISHED {outcome:{type:"interrupt", interrupts:[{id, reason, toolCallId}]}}` | `approval` envelope with `owned:true` on the broadcast topic |
| `INTERRUPT_RESOLVED` | `interruptId, status (resolved, cancelled), reason (allowed, denied, answered, cancelled)` | the next run's `RunAgentInput.resume: [{interruptId, status, payload}]` | `approval-end` with `owned:true` |
| `STEP_STARTED` / `STEP_FINISHED` | `stepName, note?` | same | `stepName:"compact"` → activity `compact` |
| `STATE_DELTA` | `delta` (JSON Patch on `/contextTokens`, `/contextWindow`, `/model`, `/permissionMode`) | `STATE_DELTA` | `/contextTokens` feeds `lib/usage.mjs` `reportContext` (the 200 k alert) |
| `CUSTOM` | `name (notice, error), value` | `CUSTOM {name, value}` | activity `text` with tool `Notification`, or activity `error` |
| `RUN_FINISHED` | `runId, outcome (success, cancelled), reason?` | `RUN_FINISHED {outcome:{type:"success"}}` or `{type:"cancelled"}` | activity `stop` ("turn ended", "turn ended · interrupted · <reason>"); status `stop` |
| `RUN_ERROR` | `runId, message` | `RUN_ERROR` | activity `error`, then `stop` "turn ended · failed"; status `stop` |

`subagent*` is `subagentRunId?` and `subagentType?` (AG-UI `subagentRunId`), which become the activity row's `agent: {id, type}` as hook rows carry today. A session's end has no AG-UI event; the runner publishes activity `stop` "session ended · <reason>" and status `stop`.

AG-UI ends a run at an interrupt and resumes it as a new run; the harnesses keep the turn open while they wait. The future mapping therefore emits the interrupt outcome only on an AG-UI stream that the UI answers with `resume`, and keeps one runner `runId` across both AG-UI runs.

### Envelope details

All envelopes are `v: 1` and publish through the existing helpers: `publishActivity` (`lib/activity.mjs`, one 1.5 s deadline per batch, clipping to 4,095 bytes), `publishStatus` (`lib/inbox.mjs`), `sendReceipts` (`lib/receipts.mjs`) and `publish` (`lib/ntfy.mjs`) for approvals. The sender of every envelope is `from: <harness>, session: <label>`, the same as a hook in that session, so `web/server/ui.mjs` (`activityItem`, `approvalEntry`, `outcomes`, `agents`) renders owned rows, cards and presence without change. Publishes for one session are serialized, so rows keep their order.

- **Approval card:** `lib/approvals.mjs` `approvalMessage` shape plus `owned: true`: `{v, kind:"approval", from, session, harness, id (12 hex), tool, summary, questions?, expiresAt, ts, owned}`. The runner, not the adapter, makes the 12-hex `id` and maps it to the adapter's `interruptId`. `expiresAt` is `ts` + `AI_COLLAB_APPROVAL_TIMEOUT_MIN` minutes (default 30, at most 720, ntfy's cache window). The runner denies an unanswered card at that time and ends it with `denied`. The UI's existing Allow / Deny publishes `reply <id> allow|deny` (or the answers as JSON) on the broadcast topic; the runner streams that topic and calls `handle.respond`. Ends: `allowed`, `denied` (operator or timeout), `answered`, `cancelled` (run ended, session closed, or runner restarted).
- **Read receipts:** published when `handle.send` or `handle.steer` resolves, for the ntfy ids the input carried.
- **Status:** `start` at `RUN_STARTED`, `stop` at a run's end and at session end. Today's UI counts a session online for `ONLINE_MS` after `start`, as with hooks.

## Session identity and the registry

| Item | Value |
|---|---|
| Native id | The harness's own id: Claude session UUID (chosen by the adapter), Codex `threadId`, OpenCode session id, Cursor ACP `sessionId` |
| Label | `sessionLabel(nativeId)`: first 16 hex of SHA-256 (`lib/config.mjs`), the same label hooks compute from the same id |
| Address | `<harness>#<label>`, for example `codex#3f2a9c0d1e4b5a69`; peer name = harness name |
| Owned record | `$AI_COLLAB_STATE_DIR/<project>/owned/<label>.json`, written by `lib/owned.mjs` `writeOwned` (0600 file, 0700 dir); shape `OwnedRecord` in `runner/types.d.ts` |
| Registry entry | `$AI_COLLAB_STATE_DIR/<project>/registry/<address>.json` via `lib/sessions.mjs` `recordSession`, with `pid`/`pidStart` = the runner, `event: "owned"`; `list_agents`, `list_sessions` and the UI's agent list read it unchanged. At session end the entry is rewritten without a pid, so it shows offline |
| Workflow | `OwnedRecord.workflowId` = `session-<uuid>` in `runner.db` |

`OwnedRecord.status` is `starting`, `idle`, `running` or `ended`. The durable log is the source of truth; the owned record is a projection that hooks and the UI can read without opening SQLite.

## Hook stand-down

`scripts/ai-collab-hook.mjs` calls `lib/owned.mjs` `standsDown(cfg, {label})` right after loading its config. When it returns true, the hook prints its neutral output (`{}`; `{permission:"ask"}` for Cursor permission hooks; `{continue:true}` for Cursor `beforeSubmitPrompt`) and publishes nothing: no activity, status, approval, inbox claim, receipt, Stop wait or registry write. It returns true when `owned/<label>.json` exists for the hook input's session id and its status is not `ended`. Only the process the runner spawned matches: its native session id is the one in the record.

An agent started inside an owned session (say `claude -p` from an owned Claude's Bash) has its own native session id, matches no record, and reports normally. It registers as the owned session's child through `AI_COLLAB_PARENT` (`lib/family.mjs`, `lib/config.mjs` `ownEnv`); the adapter exports that variable into the shell its agent runs commands in (see the adapter rules).

Known limits:

- Hooks that fire before the `claim` step writes the record (a Claude CLI's `SessionStart`, a Codex app-server child's first events, the shared OpenCode service) may publish one stray row.
- Once a session is `ended`, its hooks report again, so a later `claude --resume <id>` from a terminal shows up as a normal session.

## Control API (runner ↔ UI)

HTTP/1.1 JSON over a unix socket: `AI_COLLAB_RUNNER_SOCKET`, else `$XDG_RUNTIME_DIR/ai-collab/runner.sock`, else `$AI_COLLAB_STATE_DIR/runner.sock`. The socket is 0600 in a 0700 dir; the runner refuses to start when another runner answers on it. Bodies are limited to 64 KB. Errors are `{error}` with status 400, 404, 405, 409, 413, 429, 502 or 504. Server: `runner/control.mjs`; client: `runner/client.mjs` `runnerClient({socket})`.

| Method and path | Body | Answer |
|---|---|---|
| `GET /v1/health` | | `{ok, version: 1, harnesses: [...]}` |
| `GET /v1/harnesses` | | `{harnesses: [{harness, capabilities, ok, detail?}]}` |
| `GET /v1/harnesses/:harness/models` | | `{models}` |
| `GET /v1/harnesses/:harness/commands?project=` | | `{commands}` |
| `GET /v1/sessions` | | `{sessions: [view]}` |
| `POST /v1/sessions` | `{project, harness, prompt, model?, place?: "folder"\|"worktree", permissionMode? (default: see Permission modes)}` | 201 `{status:"started", session, nativeId, workflowId, detail}` once `open` and `claim` are done; at most one start per 10 s |
| `GET /v1/sessions/:harness/:label` | | `view`: `{session, harness, project, nativeId, workflowId, cwd, place, status, permissionMode, model?, run, approvals, cut?}` |
| `POST /v1/sessions/:harness/:label/send` | `{text, steer?}` | 202 `{status: "sent"\|"queued"\|"steered"}` |
| `POST /v1/sessions/:harness/:label/interrupt` | | 202 `{status: "interrupting"\|"idle"}` |
| `POST /v1/sessions/:harness/:label/mode` | `{mode}` | `{status:"changed", permissionMode}`; 400 when the harness or place does not allow the mode, 409 when the adapter cannot change it while open |
| `POST /v1/sessions/:harness/:label/approvals/:id` | `{decision: "allow"\|"deny"}` or `{answers}` | `{status:"answered"}` |
| `GET /v1/sessions/:harness/:label/context` | | `{context: {tokens, window?} \| null}` |
| `DELETE /v1/sessions/:harness/:label` | | `{status: "ended"\|"closing"}` |
| `GET /v1/schedules` | | `{schedules: [{name, everyMs, nextRun, last}]}`; see [Scheduled workflows](#scheduled-workflows) |
| `POST /v1/schedules/:name/run` | | 202 `{id, status: "started"\|"skipped"}`; 404 for an unknown schedule |

How a UI start reaches the runner (the UI change comes with the first adapter, not in this skeleton):

1. The phone's Start form gains an "owned" switch. `POST /api/start` with `owned: true` keeps every existing check in `web/server/ui.mjs` (harness, place, prompt, model, the 10 s gap), then calls `runnerClient().start({project, harness, prompt, model, place, permissionMode})` instead of `startSession`.
2. When the socket is missing, the UI answers 503 "The runner is not running" and does not fall back to a terminal start.
3. Chat, Allow / Deny and replies need no new route: they already travel over ntfy, and the runner streams them.
4. Interrupt and Close are new UI buttons that call the runner directly; ntfy has no interrupt envelope.

## Input from ntfy

The runner streams, per project, `ai-collab-<project>--to--all` plus `ai-collab-<project>--to--<harness>` for every loaded adapter, from the stored cursor.

- A `msg` envelope with `to: <harness>` and `toSession: <label>` of an owned session (a direct message or an @mention) becomes a durable `input` message for that session.
- A `msg` envelope with `to: "all"` on the broadcast topic, and raw operator text there that is neither a phone reply nor a question, becomes an `input` message for every owned session of the project, like a terminal session. A session's own broadcast is skipped. Each delivery to an idle owned session starts a turn.
- Every input is deduplicated by `ntfy:<event id>:<label>`. The text is `lib/format.mjs` `formatInbox([message])`, the same block hooks inject, so agents answer with `reply_to_operator` or `send_to_all` as they do today. `urgent: true` steers when the adapter can steer; otherwise it queues.
- `reply <id> <answer>` on the broadcast topic answers the owned approval with that id (`lib/approvals.mjs` `replyDecision`). Anyone who can post to the project topic may answer.

## Permission modes

Modes: `supervised`, `accept-edits`, `auto`, `full-access`. The table is `PERMISSION_TABLE` in `runner/contract.mjs`; `permissionSettings(harness, mode, place)` returns the settings the adapter receives as `options.permission`, or an error. Codex values follow T3 Code `CodexAdapterV2.ts` L751-L800 at `5935157` (MIT).

| Mode | Claude `permissionMode` | Codex `approvalPolicy` / `approvalsReviewer` / `sandboxPolicy` | OpenCode (auto-reply `once` to) | Cursor |
|---|---|---|---|---|
| `supervised` | `default` | `untrusted` / `user` / `readOnly` | nothing; every ask goes to the phone (**default**) | ACP `request_permission` goes to the phone (**default**) |
| `accept-edits` | `acceptEdits` | `on-request` / `user` / `workspaceWrite` | edit asks | — |
| `auto` | `auto` (**default**) | `on-request` / `auto_review` / `workspaceWrite` (**default**) | — | — |
| `full-access` | `bypassPermissions` | granular (only MCP elicitations ask) / `user` / `dangerFullAccess` | every ask | `--force`; only with `place: "openshell"` (rejected until OpenShell starts are built) |

Defaults: Claude `auto`, Codex `auto`, OpenCode `supervised`, Cursor `supervised` (`DEFAULT_PERMISSION`). With `place: "openshell"` the default is `full-access` for every harness (`defaultPermission(harness, place)`).

The operator changes a running session's mode with `POST /v1/sessions/:harness/:label/mode` on the control socket (0600, the operator's user only). Neither ntfy nor the MCP server offers the operation, so an agent cannot raise its own mode; it can ask the operator. The runner validates the pair with `permissionSettings`, calls `handle.setPermissionMode`, updates the owned record and publishes a notice row.

Cursor's `full-access` needs OpenShell. OpenCode replies are always `once`, never `always`, because an "always" grant covers the whole project. An adapter that cannot honour a mode leaves it out of `capabilities.permissionModes`, and the runner answers 400.

## Files

| Path | Role |
|---|---|
| `runner/types.d.ts` | Adapter interface, events, records |
| `runner/contract.mjs` | Harness, mode and event constants; `PERMISSION_TABLE`; `eventProblem` |
| `runner/durable.mjs` | SQLite workflow/step/message log; `scheduled` ticks |
| `runner/schedules.mjs` | `schedules.json` loader and the scheduled command step |
| `runner/runner.mjs` | Session workflow, control operations, ntfy input |
| `runner/publish.mjs` | Event → envelope mapping |
| `runner/control.mjs`, `runner/client.mjs` | Control socket server and client |
| `runner/main.mjs` | Service entry (`npm run runner`) |
| `runner/adapters/fake.mjs` | Scripted adapter for tests and a template for real adapters |
| `runner/adapters/<harness>.mjs` | Real adapters, one per agent (not written yet) |
| `lib/owned.mjs` | Owned-record read/write and `standsDown` |
| `deploy/ai-collab-runner.service` | User unit template; not installed |
| `test/runner*.test.mjs` | Tests with the fake adapter and fake ntfy |

Environment: `AI_COLLAB_APPROVAL_TIMEOUT_MIN` (minutes before an unanswered owned approval is denied; default 30), `AI_COLLAB_RUNNER_SOCKET`, `AI_COLLAB_RUNNER_DB` (default `$AI_COLLAB_STATE_DIR/runner.db`), `AI_COLLAB_RUNNER_HARNESSES` (comma list), `AI_COLLAB_SCHEDULES` (path of `schedules.json`), and the usual `AI_COLLAB_*` project settings, read through `loadProjects`.

## Operator decisions (2026-11-21)

- **DBOS:** keep the DBOS-shaped `node:sqlite` layer now; move to DBOS later.
- **1 Broadcast delivery:** owned sessions receive every project-chat broadcast and every @mention, like terminal sessions. Each delivery to an idle owned session starts a turn.
- **2 Cut runs:** every cut run is marked interrupted, on every adapter. No adapter resumes a cut run.
- **3 Default modes:** each harness's auto mode where it has one, else the mode a user's own session uses:
  - Claude `auto`; Codex `auto` (on-request plus auto review); OpenCode `supervised` (its default asks go to the phone); Cursor `supervised` in a worktree.
  - Inside OpenShell, `full-access` is the default for every harness.
  - The operator can change a session's mode at runtime from the UI or CLI. An agent cannot raise its own mode; it can ask the operator.
- **4 Approval expiry:** an unanswered owned approval is denied after `AI_COLLAB_APPROVAL_TIMEOUT_MIN` (default 30).
- **5 Who approves:** anyone who can post to the project topic, as today.
- **6 Nested agents:** only the process the runner spawned stands down; agents started inside it join AI Collab as its children.
