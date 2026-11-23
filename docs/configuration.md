# Configuration

Configuration lives in `${XDG_CONFIG_HOME:-~/.config}/ai-collab/`. Keep the token and local configuration outside the repository. Environment settings can also activate the CLI or override project settings.

## Auto-join every repo (defaults.json)

`defaults.json` holds the shared keys. [`setup`](quick-start.md) writes it; with your own ntfy server, write it by hand:

```json
{ "url": "http://127.0.0.1:8794", "tokenFile": "/absolute/path/to/private/ntfy/token", "peers": "claude,codex,cursor" }
```

`defaults.json` also takes `"codeMode": false` to turn native code mode off for every session ai-collab starts (default on; see [Code mode](code-mode.md)). `"limitFallback": "harness:model"` is the replacement for a usage limit: a builder whose Codex run hits its limit retries with it (default Cursor DeepSeek), and it is the first option on a limit card when the session's role names no fallback; `opencode:opencode/deepseek-v4.1-flash-free` is free. `"readsThroughRunCode": true` makes agents batch the ai-collab read tools through `run_code` instead of calling them one by one, and makes the CLI read commands exit 3 with the `run_code` program for an agent session; `AI_COLLAB_DIRECT_READS=1` keeps a CLI read direct (see [Code mode](code-mode.md#run_code)). `"startPlace": "folder" | "worktree" | "openshell"` is where a session starts when the caller names no place (default `openshell`; a harness that cannot run in OpenShell gets the folder; see [Start a session from the phone](phone-ui.md#start-a-session-from-the-phone)). `"maxSandboxes": N` caps the OpenShell sandboxes on the machine: a sandboxed schedule tick refuses to start while `openshell sandbox list` shows N or more (default 8; see [Scheduled workflows](owned-sessions-contract.md#scheduled-workflows)).

A session in a git repo without a `projects.json` entry then joins under the repo's folder name: lowercase, other characters become hyphens, cut to 24 characters, and a linked worktree uses its main repo's name. An empty `.ai-collab-off` file in the repo root keeps that repo out. The first session records the repo in `$AI_COLLAB_STATE_DIR/auto-projects/`, and the UI adds it within 10 seconds. Two repos with the same folder name share one project.

## Per-workspace settings (projects.json)

`projects.json` enables the hooks for listed workspaces:

```json
[
  {
    "root": "/absolute/path/to/project",
    "project": "demo",
    "url": "http://127.0.0.1:8794",
    "tokenFile": "/absolute/path/to/private/ntfy/token",
    "peers": "claude,codex,cursor"
  }
]
```

An entry may also set `afkWaitSeconds` and `"activity": "off"` (see the table below).

A `teams` map on an entry names mixed-agent teams for that project: keys are 1–24 character names (`a-z`, `0-9`, single hyphens); values are arrays of members `harness` or `harness:model` (models use the same allowlists as phone starts). Global defaults live in `~/.config/ai-collab/teams.json`; a project name overrides the global roster. See [Phone UI](phone-ui.md#teams).

Hooks use the most specific configured workspace and assign a peer name from the harness.

## Sessions and routing

Each session gets a separate inbox cursor and a stable, short sender label derived from its harness session ID. The raw ID stays local. The session hook supplies the exact CLI prefix for sending replies, and the CLI attaches the label to the message. Direct messages to a harness name reach sessions sharing that name. Use `peer#session-label` to target one session. This routing uses the shared ntfy topics and does not define separate access permissions.

Cursor shell commands use the conversation identity exported by Cursor, so `ai-collab send` automatically identifies the session within a configured workspace.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `AI_COLLAB_PROJECT` | (required) | Project scope. 1-24 chars of `a-z 0-9` and single hyphens. Topics are scoped by it. |
| `AI_COLLAB_PEER` | Harness name in configured hooks | This agent's peer name. Same rules as the project name, and not `all`. |
| `AI_COLLAB_URL` | `http://127.0.0.1:8794` | Base URL of your private ntfy server. Must be http(s). |
| `AI_COLLAB_TOKEN` | unset | Sent as `Authorization: Bearer <token>` when set. |
| `AI_COLLAB_PEERS` | unset | Shared, comma-separated peer list, e.g. `alice,bob,carol`. Used for `peers` and to reject `send` to unknown names. Same value on every machine. There is no network discovery. |
| `AI_COLLAB_TIMEOUT_MS` | `2000` | Per-request timeout (200-15000). |
| `AI_COLLAB_POLL_INTERVAL_MS` | `10000` | Minimum gap between inbox reads for the throttled events. |
| `AI_COLLAB_DISPATCH` | on | `off` stops the UI server's dispatcher, which pushes messages into idle Codex and OpenCode sessions ([Waking idle sessions](messaging.md#waking-idle-sessions)). |
| `AI_COLLAB_WAITER_MAX_S` | `3300` | Seconds a Claude asyncRewake waiter streams before it exits quietly; the next hook event re-arms it. |
| `AI_COLLAB_STATE_DIR` | `$XDG_STATE_HOME/ai-collab` or `~/.local/state/ai-collab` | Cursors, dedup ids, and the lock directory. |
| `AI_COLLAB_AFK_WAIT_S` | `600` (or `afkWaitSeconds` in `projects.json`) | How long the Stop hook waits for operator messages in AFK mode `on`, after the agent asks with `ask_question` or `wait_for_operator` (0-86400). |
| `AI_COLLAB_STOP_CAP` | `5` | Consecutive Stop continuations for messages before the agent is let stop (0-50). |
| `AI_COLLAB_STOP_POLL_MS` | `5000` | First retry delay when the Stop hook's ntfy stream fails; doubles to 60 s. |
| `AI_COLLAB_IMPORTANT_MAX_S` | `86400` | Oldest important question the Stop hook still holds for. |
| `AI_COLLAB_ACTIVITY` | `on` (or `"activity": "off"` in `projects.json`) | `off`, `0`, `false`, or `no` stops hooks from publishing [activity](activity.md). The environment overrides `projects.json`. |
| `AI_COLLAB_APPROVAL_S` | `540` | How long a permission hook waits for the phone in AFK mode (0-570; 0 turns [phone approvals](approvals.md#phone-approvals) off). The hooks are registered with a 600-second timeout. |
| `AI_COLLAB_TEAM_AUTHOR_MODEL` | `cursor:deepseek-v41-flash-1017-high` | `harness[:model]` of the writing agent that drafts `team.dot` from a [describe-a-team](teams.md#describe-a-team-in-words) request in the UI. |
| `AI_COLLAB_ALLOW_HOST_AGENT` | unset | `1` lets ai-collab run an agent harness with approvals off on the host: a schedule or `job run` command with `--force`, `--yolo`, `--sandbox disabled`, `--dangerously-*` (not Codex's `--dangerously-bypass-hook-trust`), `--permission-mode bypassPermissions` or OpenCode `--auto`, and a runner `full-access` session outside OpenShell. Unset, each is refused with an error that names the flag (`lib/agent-guard.mjs`). |
| `AI_COLLAB_PARENT` | unset | Address (`peer#label`) of the agent that started this one; see [Agents starting agents](messaging.md#agents-starting-agents). A session with it set takes its harness name as its peer and ignores an inherited `AI_COLLAB_SESSION`. |

Invalid values disable the plugin and say why (`ai-collab peers` prints the reason).

The UI server reads its own variables; see [Phone UI](phone-ui.md#ui-settings) and [wake settings](phone-ui.md#wake-compact-and-context-alerts).

## Topics

Topics are project-scoped, DNS-friendly, and at most 64 characters:

- status: `ai-collab-<project>--status`
- direct inbox: `ai-collab-<project>--to--<peer>`
- broadcast: `ai-collab-<project>--to--all`
- activity: `ai-collab-<project>--activity` (written by hooks, read only by the UI; inbox claims never read it)
- receipts: `ai-collab-<project>--receipts` (read receipts written by hooks, MCP tools, and the CLI; read only by the UI; see [Receipts](messaging.md#receipts))

Names never contain `--`, so no project/peer pair can collide with another.
