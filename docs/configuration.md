# Configuration

Configuration lives in `${XDG_CONFIG_HOME:-~/.config}/ai-collab/`. Keep the token and local configuration outside the repository. Environment settings can also activate the CLI or override project settings.

## Auto-join every repo (defaults.json)

`defaults.json` holds the shared keys. [`setup`](quick-start.md) writes it; with your own bus or ntfy server, write it by hand:

```json
{ "url": "http://127.0.0.1:8794", "tokenFile": "/absolute/path/to/private/bus/token", "peers": "claude,codex,cursor" }
```

`defaults.json` also takes `"codeMode": false` to turn native code mode off for every session ai-collab starts (default on; see [Code mode](code-mode.md)). `"limitFallback": "harness:model"` is the replacement a usage limit starts without asking (default Cursor DeepSeek). A builder whose Codex run hits its limit retries with it, then Cursor DeepSeek, then `opencode:opencode/deepseek-v4.1-flash-free`, then the first listed model of each other installed harness ([Builders](builders.md)). A session that is not a builder starts the same chain in place and does not raise a choice card. `"readsThroughRunCode": true` makes agents batch the ai-collab read tools through `run_code` instead of calling them one by one, and makes the CLI read commands exit 3 with the `run_code` program for an agent session; `AI_COLLAB_DIRECT_READS=1` bypasses this machine default for CLI reads. New sessions launched by chat tags require code reads (see [Code mode](code-mode.md#run_code)). `"startPlace": "folder" | "worktree" | "openshell"` is where a session starts when the caller names no place (default `openshell`; a harness that cannot run in OpenShell gets the folder; see [Start a session from the phone](phone-ui.md#start-a-session-from-the-phone)). `"runInTerminal": true` turns on the host-only `run_in_terminal` MCP tool and its UI card (default off; see [Run in terminal](run-in-terminal.md)). `"maxSandboxes": N` caps the OpenShell sandboxes on the machine (default 6). It counts every sandbox `openshell sandbox list` shows except `run_code`'s shared `ai-collab-code` and its per-call `aic-ro-*` read sandboxes, which are short-lived tool plumbing. At the cap, `builder start` and a runner OpenShell start that would add a sandbox are refused with an error naming the running sandboxes, and a sandboxed schedule tick is skipped with the reason in its log ([Scheduled workflows](owned-sessions-contract.md#scheduled-workflows)).

`"claudePermissionMode"` sets Claude Code's `--permission-mode` for sessions ai-collab starts: `default` (the default), `acceptEdits`, `auto`, `bypassPermissions`, `dontAsk` or `plan`, `auto-afk` (`default` while AFK mode is `on`, no flag otherwise), or `inherit` (no flag, so the user's Claude settings apply). A Plan start keeps its own `--permission-mode plan`. A runner-owned Claude session takes the value when its caller names no mode. `dontAsk` and `plan` refuse that start, since the runner has no such mode; a setting that passes no flag keeps the runner's `auto` default. Any other value refuses the start and lists the valid values. Builders run in their sandboxes with their own flags and ignore this key. Team and pattern runs take their `team.dot` `permission` attribute, else `auto`; a per-launch value (`ai-collab team start --permission`, a phone start's `permission`) replaces `claudePermissionMode` for that launch, and `/permission` stores the next start's value ([Teams](teams.md#teams), [Phone UI](phone-ui.md)).

`"otlpEndpoint"` is the OTLP/HTTP traces URL every Cursor run reports to (default `http://localhost:6006/v1/traces`, the local Phoenix); `"off"` or `false` turns the traces off. With no `defaults.json` nothing is exported. See [Cursor traces](code-mode.md#cursor-traces).

`"workflowEngine": "dbos"` runs the runner's durable workflows on DBOS Transact over Postgres instead of the SQLite log (default `"sqlite"`); see [DBOS workflow engine](#dbos-workflow-engine).

A session in a git repo without a `projects.json` entry then joins under a project ID made from the origin’s repository name and a hash of its host and repository path. Repos without an origin use their main checkout’s folder name. An empty `.ai-collab-off` file in the repo root keeps that repo out. The first session records the repo in `$AI_COLLAB_STATE_DIR/auto-projects/`, and the UI adds it within 10 seconds. Checkouts with the same origin share one project.

## Per-workspace settings (projects.json)

`projects.json` enables the hooks for listed workspaces:

```json
[
  {
    "root": "/absolute/path/to/project",
    "project": "demo",
    "url": "http://127.0.0.1:8794",
    "tokenFile": "/absolute/path/to/private/bus/token",
    "peers": "claude,codex,cursor"
  }
]
```

An entry may also set `afkWaitSeconds` and `"activity": "off"` (see the table below).

A `teams` map on an entry names mixed-agent teams for that project: keys are 1–24 character names (`a-z`, `0-9`, single hyphens); values are arrays of members `harness` or `harness:model` (models use the same allowlists as phone starts). Global defaults live in `~/.config/ai-collab/teams.json`; a project name overrides the global roster. See [Phone UI](phone-ui.md#teams).

Hooks use the most specific configured workspace and assign a peer name from the harness.

## Sessions and routing

Each session gets a separate inbox cursor and a stable, short sender label derived from its harness session ID. The raw ID stays local. The session hook supplies the exact CLI prefix for sending replies, and the CLI attaches the label to the message. Direct messages to a harness name reach sessions sharing that name. Use `peer#session-label` to target one session. This routing uses the shared topics and does not define separate access permissions.

Cursor shell commands use the conversation identity exported by Cursor, so `ai-collab send` automatically identifies the session within a configured workspace.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `AI_COLLAB_PROJECT` | (required) | Project scope. 1-24 chars of `a-z 0-9` and single hyphens. Topics are scoped by it. |
| `AI_COLLAB_PEER` | Harness name in configured hooks | This agent's peer name. Same rules as the project name, and not `all`. |
| `AI_COLLAB_URL` | `http://127.0.0.1:8794` | Base URL of the message bus (or your own ntfy server). Must be http(s). |
| `AI_COLLAB_TOKEN` | unset | Sent as `Authorization: Bearer <token>` when set. |
| `AI_COLLAB_PEERS` | unset | Shared, comma-separated peer list, e.g. `alice,bob,carol`. Used for `peers` and to reject `send` to unknown names. Same value on every machine. There is no network discovery. |
| `AI_COLLAB_TIMEOUT_MS` | `2000` | Per-request timeout (200-15000). |
| `AI_COLLAB_POLL_INTERVAL_MS` | `10000` | Minimum gap between inbox reads for the throttled events. |
| `AI_COLLAB_DISPATCH` | on | `off` stops the UI server's dispatcher, which pushes messages into idle Codex and OpenCode sessions ([Waking idle sessions](messaging.md#waking-idle-sessions)). |
| `AI_COLLAB_WAITER_MAX_S` | `3300` | Seconds a Claude asyncRewake waiter streams before it exits quietly; the next hook event re-arms it. |
| `AI_COLLAB_STATE_DIR` | `$XDG_STATE_HOME/ai-collab` or `~/.local/state/ai-collab` | Cursors, dedup ids, and the lock directory. |
| `AI_COLLAB_AFK_WAIT_S` | `600` (or `afkWaitSeconds` in `projects.json`) | How long the Stop hook waits for operator messages in AFK mode `on`, after the agent asks with `ask_question` or `wait_for_operator` (0-86400). |
| `AI_COLLAB_STOP_CAP` | `5` | Consecutive Stop continuations for messages before the agent is let stop (0-50). |
| `AI_COLLAB_STOP_POLL_MS` | `5000` | First retry delay when the Stop hook's bus stream fails; doubles to 60 s. |
| `AI_COLLAB_IMPORTANT_MAX_S` | `86400` | Oldest important question the Stop hook still holds for. |
| `AI_COLLAB_ACTIVITY` | `on` (or `"activity": "off"` in `projects.json`) | `off`, `0`, `false`, or `no` stops hooks from publishing [activity](activity.md). The environment overrides `projects.json`. |
| `AI_COLLAB_APPROVAL_S` | `540` | How long a permission hook waits for the phone in AFK mode (0-570; 0 turns [phone approvals](approvals.md#phone-approvals) off). The hooks are registered with a 600-second timeout. |
| `AI_COLLAB_TEAM_AUTHOR_MODEL` | `cursor:deepseek-v41-flash-1017-high` | `harness[:model]` of the writing agent that drafts `team.dot` from a [describe-a-team](teams.md#describe-a-team-in-words) request in the UI. |
| `AI_COLLAB_ALLOW_HOST_AGENT` | unset | `1` lets ai-collab run an agent harness with approvals off on the host: a schedule or `job run` command with `--force`, `--yolo`, `--sandbox disabled`, `--dangerously-*` (not Codex's `--dangerously-bypass-hook-trust`), `--permission-mode bypassPermissions` or OpenCode `--auto`, and a runner `full-access` session outside OpenShell. Unset, each is refused with an error that names the flag (`lib/agent-guard.mjs`). |
| `AI_COLLAB_OTLP_ENDPOINT` | `defaults.json` `otlpEndpoint` | OTLP/HTTP traces URL for Cursor runs; `off` turns them off. Overrides `defaults.json`. |
| `AI_COLLAB_PARENT` | unset | Address (`peer#label`) of the agent that started this one; see [Agents starting agents](messaging.md#agents-starting-agents). A session with it set takes its harness name as its peer and ignores an inherited `AI_COLLAB_SESSION`. |

Invalid values disable the plugin and say why (`ai-collab peers` prints the reason).

## DBOS workflow engine

`lib/workflows.ts` opens the runner's workflows on the engine `AI_COLLAB_WORKFLOW_ENGINE` names, else `defaults.json` `workflowEngine`, else `sqlite`. With `dbos`, `ai-collab postgres up` starts the loopback Postgres container (`deploy/postgres/compose.yaml`); the password lives in `${XDG_CONFIG_HOME:-~/.config}/ai-collab/pg-password` (0600).

| Variable | Default | Meaning |
|---|---|---|
| `AI_COLLAB_WORKFLOW_ENGINE` | `defaults.json` `workflowEngine`, else `sqlite` | `sqlite` or `dbos`. |
| `AI_COLLAB_PG_HOST`, `AI_COLLAB_PG_PORT` | `127.0.0.1`, `5432` | Postgres address. |
| `AI_COLLAB_PG_DATABASE` | `ai_collab` | System database. The DBOS tests use `ai_collab_test` and refuse to run against `ai_collab`. |
| `AI_COLLAB_PG_PASSWORD_FILE` | `<config dir>/pg-password` | Password file. |
| `AI_COLLAB_DBOS_VERSION_GUARD` | `refuse` | Boot check for PENDING runs of the runner's workflows recorded under another `applicationVersion`, which DBOS never recovers: `refuse` fails the boot and lists every such run, `drain` cancels them and boots, `off` skips the check (the test suite sets it). |

DBOS replays a PENDING run against its recorded operations by position and recovers only runs recorded under the current `applicationVersion` (`DBOS_APP_VERSION` in `lib/workflows.ts`, `ai-collab-1`). A change to a workflow's sequence of steps, receives or sleeps must bump that constant; `test/dbos-step-sequences.test.mjs` fails until the bump and a new entry in `test/golden/dbos-step-sequences.json`. Deploy a bump only after the old runs drain.

The engine reads DBOS's own tables in four places, because the public API has no equivalent that is safe inside a workflow: `pendingCount` and `drain` read `dbos.notifications`, the send dedupe probe matches `dbos.notifications.message_uuid` (`<key>::<destination>`) so a key spent toward one workflow is spent for all, like the SQLite log, and the prior-step lookup reads `dbos.operation_outputs` to detect cut steps and set `replaying`. The boot version guard reads and drains `dbos.workflow_status`. These reads depend on the 5.7.0 schema; `package.json` pins `@dbos-inc/dbos-sdk` to exactly `5.7.0`, so an SDK upgrade must recheck them. The engine also imports `runWithTopContext` from the SDK's `internal/context` to start a workflow from inside another one as an independent run.

A graceful close (a runner restart) aborts every run's signal; a run that unwinds on it stays PENDING with its current step cut, and the next boot recovers it and answers the cut step with its `onCut`, as on the SQLite log. A run whose prior-step record cannot be read after 5 attempts stays PENDING untouched until the next boot.

The UI server reads its own variables; see [Phone UI](phone-ui.md#ui-settings) and [wake settings](phone-ui.md#wake-compact-and-context-alerts).

## Bus store

`ai-collab-bus` keeps events and attachments in SQLite (`bus.db` under its data directory) unless `AI_COLLAB_BUS_STORE` or `defaults.json` `busStore` selects `postgres`. The environment variable wins over `defaults.json`; any other value stops the bus at start.

| Variable | Default | Meaning |
|---|---|---|
| `AI_COLLAB_BUS_STORE` | `defaults.json` `busStore`, else `sqlite` | `sqlite` or `postgres`. |

The Postgres store writes to schema `bus` of the database `AI_COLLAB_PG_DATABASE` names (default `ai_collab`), on the container and with the variables of the DBOS engine above. It creates the schema on first open. Ids come from a `bigserial`; each publish runs `NOTIFY bus_events`, and every open stream reads when that notification arrives, so no stream polls. Ids, ordering, `since` values, retention and attachments behave as in the SQLite store.

Events in `bus.db` do not move to Postgres: a bus switched to `postgres` starts with an empty `bus` schema.

## Topics

Topics are project-scoped, DNS-friendly, and at most 64 characters:

- status: `ai-collab-<project>--status`
- direct inbox: `ai-collab-<project>--to--<peer>`
- broadcast: `ai-collab-<project>--to--all`
- activity: `ai-collab-<project>--activity` (written by hooks, read only by the UI; inbox claims never read it)
- receipts: `ai-collab-<project>--receipts` (read receipts written by hooks, MCP tools, and the CLI; read only by the UI; see [Receipts](messaging.md#receipts))

Names never contain `--`, so no project/peer pair can collide with another.
