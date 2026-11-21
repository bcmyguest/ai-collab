# ai-collab

![AI Collab demo](docs/demo.gif)

Best-effort messages and start/stop status between coding-agent peers, carried over a **private, self-hosted ntfy server**. Packaged for Claude Code, Codex, and Cursor, using the same layout as smarter-compact. The peer hooks and MCP server need only Node 22+ (builtin `fetch`); the operator UI uses Next.js with shadcn/ui, Tailwind CSS, and prompt-kit, and remote Claude compaction uses the Claude Agent SDK. Nothing here talks to ntfy.sh or any other public service.

## What it does

| Event | Claude Code | Codex | Cursor | Action |
|---|---|---|---|---|
| Session start | yes | yes | yes | Publish `start` status. Fetch the current AFK mode. Inject the mode, reply instructions, and new inbox messages. |
| Prompt submit | yes | yes | not registered | Read inbox (throttled). Inject new messages and a changed AFK mode. |
| After tool use | yes | not registered | yes | Sample current context (Claude). Read inbox (throttled). Inject new messages and a changed AFK mode. |
| Top-level stop | yes | yes | yes | Sample current context. Read inbox. If messages wait, keep the agent going with them (see [Stop](#stop-continuation)). In AFK mode, wait for operator messages first. Otherwise publish `stop` status. |
| Before compaction | activity only (`PreCompact`, async) | activity only (`PreCompact`) | yes | Publish a `compact` activity row (Cursor also samples `context_tokens`). Output `{}`. |
| Permission prompt (see [Phone approvals](#phone-approvals)) | `PermissionRequest` (also `AskUserQuestion`) | `PermissionRequest` | not registered (see below) | In AFK mode `on` or `quiet`, ask the operator's phone and wait up to `AI_COLLAB_APPROVAL_S`; otherwise, or without an answer, no decision. |
| Activity (see [Activity](#activity)) | `PreToolUse`, `PostToolUseFailure`, `MessageDisplay`, `Notification`, `SubagentStart`, `SubagentStop`, `StopFailure` (async), `SessionEnd` | `PreToolUse`, `PostToolUse`, `SubagentStart`, `SubagentStop`, `SessionEnd` | `beforeSubmitPrompt`, `afterAgentResponse`, `postToolUseFailure`, `sessionEnd` | Publish activity only and output the neutral answer (`{}`; Cursor `beforeSubmitPrompt` gets `{"continue":true}`). Every hook above also publishes its activity. |

- **No idle wake-up.** The plugin only runs when the host fires one of the hooks above. An agent idle at its prompt hears a message at its next hook; in AFK mode `on`, the Stop hook keeps the agent listening for up to 10 minutes after it finishes. There is no background process.
- **Fail open.** A timeout, outage, bad config, or malformed input prints `{}` and exits 0. The session continues unchanged.
- **Activity-only registrations never deliver messages.** Cursor `beforeSubmitPrompt` and Codex `PostToolUse` run with `--activity`: they publish activity and inject nothing, because their context-injection output is unverified for this plugin.

## Configuration

Enable automatic hooks for a workspace by creating
`${XDG_CONFIG_HOME:-~/.config}/ai-collab/projects.json`:

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

To join every git repo with no per-repo entry, create
`${XDG_CONFIG_HOME:-~/.config}/ai-collab/defaults.json` with the shared keys:

```json
{ "url": "http://127.0.0.1:8794", "tokenFile": "/absolute/path/to/private/ntfy/token", "peers": "claude,codex,cursor" }
```

A session in a repo without a `projects.json` entry then joins under the repo's
folder name: lowercase, other characters become hyphens, cut to 24 characters,
and a linked worktree uses its main repo's name. An empty `.ai-collab-off` file
in the repo root keeps that repo out. The first session records the repo in
`$AI_COLLAB_STATE_DIR/auto-projects/`, and the UI adds it within 10 seconds.
Two repos with the same folder name share one project.

Hooks use the most specific configured workspace and assign a peer name from
the harness. Keep the token and local configuration outside the repository.
Environment settings can also activate the CLI or override project settings.

Each session gets a separate inbox cursor and a stable, short sender label
derived from its harness session ID. The raw ID stays local. The session hook
supplies the exact CLI prefix for sending replies, and the CLI attaches the
label to the message. Direct messages to a harness name reach sessions sharing that name. Use
`peer#session-label` to target one session. This routing uses the shared
ntfy topics and does not define separate access permissions.

Cursor shell commands use the conversation identity exported by Cursor, so
`ai-collab send` automatically identifies the session within a configured workspace.

| Variable | Default | Meaning |
|---|---|---|
| `AI_COLLAB_PROJECT` | (required) | Project scope. 1-24 chars of `a-z 0-9` and single hyphens. Topics are scoped by it. |
| `AI_COLLAB_PEER` | Harness name in configured hooks | This agent's peer name. Same rules as the project name, and not `all`. |
| `AI_COLLAB_URL` | `http://127.0.0.1:8794` | Base URL of your private ntfy server. Must be http(s). |
| `AI_COLLAB_TOKEN` | unset | Sent as `Authorization: Bearer <token>` when set. |
| `AI_COLLAB_PEERS` | unset | Shared, comma-separated peer list, e.g. `alice,bob,carol`. Used for `peers` and to reject `send` to unknown names. Same value on every machine. There is no network discovery. |
| `AI_COLLAB_TIMEOUT_MS` | `2000` | Per-request timeout (200-15000). |
| `AI_COLLAB_POLL_INTERVAL_MS` | `10000` | Minimum gap between inbox reads for the throttled events. |
| `AI_COLLAB_STATE_DIR` | `$XDG_STATE_HOME/ai-collab` or `~/.local/state/ai-collab` | Cursors, dedup ids, and the lock directory. |
| `AI_COLLAB_AFK_WAIT_S` | `600` (or `afkWaitSeconds` in `projects.json`) | How long the Stop hook waits for operator messages in AFK mode `on` (0-86400). |
| `AI_COLLAB_STOP_CAP` | `5` | Consecutive Stop continuations for messages before the agent is let stop (0-50). |
| `AI_COLLAB_STOP_POLL_MS` | `5000` | First retry delay when the Stop hook's ntfy stream fails; doubles to 60 s. |
| `AI_COLLAB_IMPORTANT_MAX_S` | `86400` | Oldest important question the Stop hook still holds for. |
| `AI_COLLAB_ACTIVITY` | `on` (or `"activity": "off"` in `projects.json`) | `off`, `0`, `false`, or `no` stops hooks from publishing [activity](#activity). The environment overrides `projects.json`. |
| `AI_COLLAB_APPROVAL_S` | `540` | How long a permission hook waits for the phone in AFK mode (0-570; 0 turns [phone approvals](#phone-approvals) off). The hooks are registered with a 600-second timeout. |
| `AI_COLLAB_PARENT` | unset | Address (`peer#label`) of the agent that started this one; see [Agents starting agents](#agents-starting-agents). A session with it set takes its harness name as its peer and ignores an inherited `AI_COLLAB_SESSION`. |

Invalid values disable the plugin and say why (`ai-collab peers` prints the reason).

### Topics

Topics are project-scoped, DNS-friendly, and at most 64 characters:

- status: `ai-collab-<project>--status`
- direct inbox: `ai-collab-<project>--to--<peer>`
- broadcast: `ai-collab-<project>--to--all`
- activity: `ai-collab-<project>--activity` (written by hooks, read only by the UI; inbox claims never read it)
- receipts: `ai-collab-<project>--receipts` (read receipts written by hooks, MCP tools, and the CLI; read only by the UI; see [Receipts](#receipts))

Names never contain `--`, so no project/peer pair can collide with another.

## Trust model and privacy

- **Scope of what is sent.** Hooks publish session activity (below) unless `AI_COLLAB_ACTIVITY=off`. Hooks never read thinking, never publish cwd (a child agent's greeting to its parent names only its folder), and attach no file chosen by an agent. The Stop hook reads only the lines a Claude transcript or Codex `history.jsonl` gains during an AFK wait, to notice a queued prompt; nothing from them is published. Status carries the peer, short session label, event, harness, time, and the parent's address for a child agent. A permission request publishes the tool name and a one-line input summary (the command, path, or URL) to the broadcast topic; an `AskUserQuestion` request publishes its questions and options. Agents send messages explicitly with `ai-collab send`. The ntfy app can publish plain text to the broadcast topic. Agents label those messages as from `ntfy` and treat the contents as untrusted.
- **Inbound text is untrusted.** Every message is injected as a single JSON-quoted line, with control and bidi characters stripped and the body capped at 2000 characters for display. It is labelled as sender-claimed and untrusted data. Peer text cannot override the user’s request.
- **Sender names are claimed.** Anyone who can publish to a topic can claim any `from`. Protect the ntfy server with auth and ACLs. Treat the token as the trust boundary.
- **Best effort.** There is no outbox or retry; [read receipts](#receipts) only drive the operator UI's ticks. A message sent while the server is down is lost. Messages are delivered to peers that read them within the server's cache window.
- **Bounded work.** Each claim reads at most 20 messages and 256 KB per topic. Inbox reads are throttled. Hooks deliver messages once per session using a cursor and recent message IDs. Sessions that share a peer name each see the broadcast.

## Activity

Hooks publish what each harness exposes about a session's work to
`ai-collab-<project>--activity`, one ntfy message per event. The operator UI
shows it live. Turn it off with `AI_COLLAB_ACTIVITY=off` in the harness
environment or `"activity": "off"` in the `projects.json` entry.

**What is published.** User prompts, assistant text where a hook exposes it,
every tool call with its input, tool results and errors, and session or turn
start and end. Tool input and output can contain file contents, paths,
command lines, and secrets that a tool printed. Thinking is never read:
Cursor's `afterAgentThought` is not registered, and Claude's `MessageDisplay`
carries message text only. Transcripts are never read. Each event is one
envelope:

```json
{"v":1,"kind":"activity","from":"claude","session":"<16-hex label>","harness":"claude","ts":"<ISO time>",
 "type":"prompt|text|tool_call|tool_result|error|start|stop|compact","tool":"Bash","input":"…","output":"…","callId":"toolu_…",
 "agent":{"id":"<subagent id>","type":"Explore"}}
```

`agent` appears only on events from inside a subagent: Claude and Codex put
`agent_id` and `agent_type` on every hook a subagent fires, so its tool calls
stay under the parent session but carry their run. A `SubagentStop` row
carries the subagent's `last_assistant_message` as `output`, capped like other
text; its transcript path is never published.

`input` holds a prompt, tool input (JSON text), or the start and stop reason;
`output` holds assistant text, a tool result, or an error. `callId` pairs a
call with its result. For Claude's streamed text it is `<message id>#<batch>`.
Control and bidi characters are stripped. Each message stays under ntfy's
4096-byte limit (at most 4095 bytes: the server answers HTTP 500 to exactly 4096; `ai-collab send` uses the same cap): an oversized field ends with `…[truncated N bytes]`. A
truncated result or error is also uploaded whole (up to 1 MB) as an
`output.txt` attachment; the UI links it as **Full output**.

**Where it lives.** Only on your ntfy server: messages stay in its cache for 12
hours (`cache-duration`) and attachments for 12 hours
(`attachment-expiry-duration`) with the managed `server.yml`. The UI server
keeps the newest 500 events per project in memory. Phone subscriptions never
include the activity topic unless you add it.

| Event | Claude Code | Codex | Cursor |
|---|---|---|---|
| Prompt | `UserPromptSubmit` | `UserPromptSubmit` | `beforeSubmitPrompt` |
| Assistant text | `MessageDisplay` (streamed batches) | `Stop` `last_assistant_message` (final message only) | `afterAgentResponse` |
| Tool call | `PreToolUse` | `PreToolUse` | `postToolUse` (sent with the result) |
| Tool result | `PostToolUse` `tool_response` | `PostToolUse` `tool_response` | `postToolUse` `tool_output` |
| Error | `PostToolUseFailure`, `StopFailure` | none (no failure hook) | `postToolUseFailure` |
| Start / stop | `SessionStart`, `Stop`, `SessionEnd` | `SessionStart`, `Stop`, `SessionEnd` | `sessionStart`, `stop`, `sessionEnd` |
| Notification | `Notification` (as text) | none | none |
| Subagent | `SubagentStart`, `SubagentStop`; `agent_id` on its hooks | `SubagentStart`, `SubagentStop`; `agent_id` on its hooks (schemas in the Codex 0.171 binary) | unsupported: `subagentStart` and `subagentStop` exist (cursor-agent 2026.11.19), but its tool hooks carry only an unverified `parent_tool_call_id`, and which conversation a subagent's hooks report is unclear |
| Compaction | `PreCompact` (`trigger`, short `custom_instructions`) | `PreCompact` (`trigger`) | `preCompact` (`trigger`) |

**Cost to the agent.** Activity publishing starts before delivery and runs
alongside it under one 1.5-second deadline; errors are swallowed. Claude's
activity-only hooks run with `"async": true`, so Claude never waits for them.
Measured on this machine against the in-process fake ntfy (median of 25
runs): an activity-only `PreToolUse` takes 49 ms with activity on versus 27 ms
off (Node start-up plus one publish); hooks that also deliver messages add 2-4 ms.

## ntfy server (private, Docker)

Deploy an authenticated ntfy server (for example with Docker). It runs on
loopback port 8794 and writes a private client environment file. With the named Tailscale Service enabled, use its
HTTPS URL for clients on other tailnet machines.

On the host, load the credentials before launching an agent or using the CLI:

```sh
set -a
. ~/.config/ai-collab/ntfy/client.env
set +a
```

If the tailnet route is pending, set `AI_COLLAB_URL=http://127.0.0.1:8794` on the
host. Use a private credential transfer for remote clients.

## Usage (shell / CLI)

```sh
export AI_COLLAB_PROJECT=demo AI_COLLAB_PEER=alice AI_COLLAB_PEERS=alice,bob

scripts/ai-collab peers                              # peers and last status
scripts/ai-collab send bob "can you review the lock change?"
printf 'longer body\n' | scripts/ai-collab send all  # body from stdin
scripts/ai-collab send all "login page after fix" --file /tmp/shot.png  # attach an image
scripts/ai-collab inbox                              # show and mark read
scripts/ai-collab inbox --peek                       # show without marking read
scripts/ai-collab send bob "stop: main is broken" --urgent  # delivered at bob's next hook
scripts/ai-collab send bob#0123456789abcdef "review?" --await 45  # wait for the answer
scripts/ai-collab wait 30                            # block for the next message
scripts/ai-collab respond m00000042 done "merged"    # answer a message by id
scripts/ai-collab identity --activity "reviewing PR 12" --tag pr:12
scripts/ai-collab agents                             # live sessions with their identity
scripts/ai-collab sessions                           # sessions on this machine, with parent and resume command
scripts/ai-collab afk on                             # operator away, in every project in projects.json
```

Exit codes: 0 success, 1 error (for example a peer not in `AI_COLLAB_PEERS`, an empty body, or an outage), 2 disabled.

## Answering the operator

Every operator message the hooks inject says how to answer it, and the
identity line at session start repeats all routes:

| Operator message | How the agent answers |
|---|---|
| Direct (UI chat with one session, `operatorThread`) | MCP `reply_to_operator` with the message ID and session label. The reply lands in the same chat. |
| Broadcast (UI to all, envelope `from: operator`) | MCP `send_to_all` with `reply_to` set to the message ID. The answer goes to the broadcast topic with `replyTo`. |
| Phone post (plain text on the broadcast topic, shown as `from=ntfy`) | Same as a broadcast. |
| Without MCP | `AI_COLLAB_PEER=<peer> AI_COLLAB_SESSION=<label> ai-collab send all "<answer>"` |

### Screenshots

`send --file /abs/image.png`, and the `attachment` field of the MCP `send_to_all`
and `reply_to_operator` tools, upload one image as an ntfy attachment. Allowed:
`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, at most 15 MB, with file bytes that match
the extension (a renamed text file is refused). The UI shows the image inline and
serves it through `/api/file/<id>` only when that ID appears in a loaded topic.
ntfy keeps attachments for the cache duration (12 h); its `/file/<id>` URLs need no
token, so the unguessable ID and the loopback/tailnet binding are the protection.

Peer agents' messages carry no reply hint. An agent's own `ask_question` post
is not delivered back to it.

### Stop continuation

The Stop hook reads the inbox. When messages wait, it keeps the agent going
with those messages instead of letting it stop:

| Harness | Output | Loop protection used | Docs |
|---|---|---|---|
| Claude Code | `{"decision":"block","reason":"<messages>"}` | `stop_hook_active`; Claude Code's own cap of 8 consecutive continuations (resets on a tool call) | [Stop decision control](https://code.claude.com/docs/en/hooks#stop-decision-control), [Stop input](https://code.claude.com/docs/en/hooks#stop-input) |
| Codex | `{"decision":"block","reason":"<messages>"}`; Codex turns the reason into a new user prompt | `stop_hook_active` | [Hooks: Stop](https://learn.chatgpt.com/docs/hooks) |
| Cursor | `{"followup_message":"<messages>"}`, only when `status` is `completed` | `loop_limit` is `null` in `hooks/cursor-hooks.json`; the plugin's cap applies | [Hooks: stop](https://cursor.com/docs/agent/hooks) |

The plugin's own guard allows `AI_COLLAB_STOP_CAP` (default 5) consecutive
message continuations, then lets the agent stop and leaves later messages
queued. A Stop that is not a continuation (`stop_hook_active: false`, or no
continuation in the last hour) resets the count.

Each Stop hook call waits at most 600 seconds. The Stop hooks are registered
with a 660-second timeout; Claude Code and Codex default to 600 seconds, and
Cursor's default is undocumented. While waiting, the hook holds one ntfy
streaming subscription and reads the inbox only when an event arrives.

## AFK mode

`/afk on|off|quiet` tells every running agent in every project in
`projects.json` whether the operator is at the terminal.

| Mode | Progress | Questions | At Stop |
|---|---|---|---|
| `off` (default) | none | as needed | deliver waiting messages, then stop |
| `on` (operator away) | one line per milestone via `send_to_all` with `progress: true` | phone via `ask_question`; `important: true` when blocked | wait up to `AI_COLLAB_AFK_WAIT_S` (10 min) for operator messages; hold an important question until it is answered |
| `quiet` | dropped: `send_to_all` refuses `progress: true` | blocking questions only, `important: true` | hold an important question until it is answered; no idle wait |

Entry points:

| Harness | Command | Mechanism |
|---|---|---|
| Shell | `scripts/ai-collab afk on\|off\|quiet` (no argument: show the mode) | CLI |
| Claude Code | `/afk on` (or `/ai-collab:afk on`) | Plugin command `commands/afk.md` ([plugin commands](https://code.claude.com/docs/en/plugins-reference#standard-layout)) |
| Cursor | `/afk on` | Plugin command `commands/afk.md` ([commands format](https://cursor.com/docs/reference/plugins)) |
| Codex | `$ai-collab afk on` | Codex plugins carry skills, MCP servers, apps, and hooks but no commands, so the `ai-collab` skill covers it ([build plugins](https://developers.openai.com/codex/plugins/build)) |

The mode travels as an envelope on each project's broadcast topic:

```json
{"v":1,"kind":"mode","from":"operator","mode":"on","ts":1795243066000}
```

The highest `ts` wins; no envelope means `off`. Agents never see it as chat.
Each session records the mode when it reads its inbox, and its next hook
injects a one-time note with the new rules. SessionStart fetches the last 12
hours of the broadcast topic (the ntfy cache duration) and injects the current
mode. A mode set more than 12 hours ago is gone from the cache; new sessions
then start in `off`. `lib/mode.mjs` exports `publishMode(cfgs, mode)`,
`currentMode(cfg)`, and `operatorConfigs(env)` for the UI server.

An important question survives hook and tool timeouts: the Stop hook waits
one 600-second slice for the answer, then continues the agent with an
instruction to call `wait_for_answer` once and end its turn, and waits again.
That costs one model turn per slice. An AFK wait longer than one slice costs
one turn per extra slice; on Claude Code, raise
`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` for more than 8 slices in a row.

### Coming back to the terminal

AFK stays on until you turn it off in the UI or with `afk off`; typing in a
session, at the terminal or through Remote Control, does not change the mode.
A session in the AFK wait is running its Stop hook, so it looks busy. Either
of these ends that session's wait:

- **Esc** interrupts a running Stop hook in Claude Code, Codex, and Cursor.
- **A prompt queued in the waiting session ends its wait at once**; AFK stays
  on. Claude Code queues a prompt typed, or sent through Remote Control, while
  the hook runs and records it in the transcript as a `queue-operation`
  `enqueue` line; Codex appends it to `$CODEX_HOME/history.jsonl` (default
  `~/.codex`) with the session ID. The Stop hook checks only the lines
  appended since its wait began, about once a second, and ignores machine
  text (task notifications, agent hand-backs, `[ai-collab]`). Both formats are
  undocumented: a missing or unparsable file means the wait goes on as before.
  Cursor has no reliable signal and keeps Esc.

## Ask from an agent, reply from the phone

The MCP server (`scripts/ai-collab-mcp.mjs`, version read from
`package.json`) exposes `ask_question`, `wait_for_answer`,
`reply_to_operator`, `send_to_all`, `send_to_peer`, and `list_sessions`, plus
the agent messaging tools below. `ask_question` posts to the same broadcast
topic that the phone subscribes to. Use the session label from the hook
context. It waits up to 25 seconds by default and returns a question ID if
nobody has replied yet. The agent can call `wait_for_answer` with that ID to
continue waiting in intervals of up to 45 seconds. `important: true` titles the
post "Important question" and records it, so the Stop hook in AFK mode `on` or
`quiet` holds the session until the answer arrives.

On the phone, post `reply <question-id> <answer>` to the same broadcast topic.
The waiting tool matches the ID, so concurrent questions stay independent.
Keep the topic private and authorize only the intended participants. A reply
is a message on a shared topic; the tool cannot verify who wrote it. Replies
are read by the waiting tool and do not re-enter ordinary agent inboxes.

The UI shows each question as a card with its answer, or an answer field
while it is open; **Reply from the composer** still works.

## Phone approvals

In AFK mode `on` or `quiet`, a permission prompt becomes a card in the UI and a
high-priority notification on the phone. In mode `off` the hook returns at once
with no decision, so the terminal prompt shows as usual.

| Harness | Hook | Phone answer | No answer |
|---|---|---|---|
| Claude Code | `PermissionRequest` (fires only when a dialog is about to show) | `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`, or `deny` with a message | `{}` |
| Claude Code `AskUserQuestion` | the same `PermissionRequest` | `allow` with `updatedInput` = the original `questions` plus `answers` (question → label; multi-select labels joined with `, `) | `{}` |
| Codex | `PermissionRequest` | `behavior` and, for deny, `message` only | `{}` |
| Cursor | `beforeShellExecution`, `beforeMCPExecution` | `{"permission":"allow"\|"deny", user_message, agent_message}` | `{"permission":"ask"}` |

The hook publishes `{v:1, kind:"approval", from, session, harness, id, tool,
summary, questions?, expiresAt, ts}` to the broadcast topic (titled with the
session, tool, and summary; ntfy priority 4) and holds one streaming
subscription. **Allow** or **Deny** in the UI posts `reply <id> allow|deny`; a
choice posts `reply <id> {"<question>":"<answer>",…}`. From the ntfy app, post
`reply <id> allow` (also `yes`, `ok`) or `reply <id> deny` (`no`); a
single-question choice accepts a label or free text. The hook reads the first
usable reply, publishes a read receipt for it, and closes the request with
`{v:1, kind:"approval-end", id, reason}` (priority 1), where reason is
`allowed`, `denied`, `answered`, `timeout`, `afk-off`, or `cancelled`.

The wait ends with no decision when `AI_COLLAB_APPROVAL_S` (540 s) passes, when
the operator turns AFK mode off, or when the harness kills the hook. The hook
never allows or denies on its own; any failure is no decision. The UI shows
closed requests as "Timed out: the terminal prompt took over" or "Closed:
answered in the terminal or the agent stopped".

**Trust.** Any client that can write the broadcast topic can approve, exactly
as it can answer a question today. Protect the topic with the ntfy token and
ACLs.

**Unverified.** Whether Claude Code shows its terminal dialog while a
`PermissionRequest` hook waits, and what happens to the hook when you answer
the dialog first, were not observed. Claude's docs state that
`PermissionRequest` accepts `updatedInput` for `AskUserQuestion`; no live
session confirmed it. Cursor's `beforeShellExecution` and
`beforeMCPExecution` run before every command, and their only no-decision
answer, `ask`, forces Cursor's prompt even for commands it would auto-run, so
the installer does not register them; `lib/approvals.mjs` keeps the Cursor
output shape for when a pass-through answer is confirmed.
Codex's `request_user_input` has no hook, so its questions are unsupported.

## Agent messaging tools

Six MCP tools follow the agent-messaging interface of the Pulsar MCP server,
mapped onto ai-collab's topics, inbox cursor and session registry. The older
tools stay; their descriptions name the new tool they duplicate.

| Tool | Does | Built on | CLI |
|---|---|---|---|
| `list_agents` | Live sessions of the project on this machine: address, harness, project, name, activity line, tags, last active, parent. `all: true` adds offline ones. | session registry (`lib/sessions.mjs`) | `ai-collab agents [--all]` |
| `send` | To a session (`peer#label`), a peer name, or `all` / `*`. `await_reply: N` blocks up to N s (max 45) for a `reply`, `done` or `declined` answer to this message. `urgent`, `reply_to`, `attachment` optional. | `sendMessage`, the Stop hook's ntfy stream waiter | `ai-collab send <to> [msg] [--urgent] [--await N]` |
| `respond` | Answers a message id with `state` `working`, `reply`, `done` or `declined` and an optional body: an operator direct message in its chat, a broadcast on the shared channel, a peer message to its sender's session. | msg envelope with `replyTo` and `state` | `ai-collab respond <id> <state> [msg]` |
| `wait` | Blocks up to `seconds` (max 45) for a new message to this session; returns it marked read. | stream waiter + `claimInbox` | `ai-collab wait [N]` |
| `inbox` | Reads new messages and marks them delivered; publishes read receipts. `peek: true` leaves them unread. | `claimInbox`, `lib/receipts.mjs` | `ai-collab inbox [--peek]` |
| `set_identity` | Stores `name`, `activity` (one line, at most 200 characters) and `tags` (at most 10, e.g. `pr:12`, `role:reviewer`) in this session's registry entry. | session registry | `ai-collab identity [--name N] [--activity T] [--tag T]...` |

A `respond` answer is a msg envelope with `replyTo` and an optional
`state` field; clients that predate it show it as an ordinary message.
Tool results label each message with `answer_with`. The tools and the hooks
share one inbox cursor per session, so a message read through `wait` or
`inbox` is not delivered again by a hook. The 45-second cap keeps a call under
Codex's default MCP tool timeout; call `wait` again to keep listening.

### Urgent messages ("send now")

A msg envelope may carry `urgent: true` (UI send body field `urgent`, CLI
`--urgent`, MCP `urgent`). Hooks normally read the inbox at most once per
`AI_COLLAB_POLL_INTERVAL_MS` (10 s). The sender also writes a marker
`$AI_COLLAB_STATE_DIR/<project>/urgent/<target>` holding the send time;
`claimInbox` reads the markers for `all`, its peer and its session before the
throttle and polls ntfy at once when one is newer than its last poll. The
check costs up to three small file reads per hook and no network request, so
it runs on every hook event; one stream subscription per hook event would cost
a connection each time. The marker works only between processes that share a
state directory (the UI server and agents of the same user on one machine); an
urgent message from elsewhere arrives at the next unthrottled poll. Nothing
interrupts a model mid-generation: delivery happens at the next hook event,
its next tool call (`PostToolUse`) or its stop.

## Start a session from the phone

Each project in the sidebar has a **+** button: pick a harness, type the first
prompt, and tap **Start**. The server accepts only a project name from
`projects.json` and one of `claude`, `codex`, `cursor` that is in the project's
peers and on `PATH` (plus Node's directory and `~/.local/bin`). It never takes
a path from the client. It spawns the harness detached, with `shell: false`,
in the project's `root`, at most once every 10 seconds:

| Harness | argv |
|---|---|
| Claude Code | `claude --bg [--model <m>] <prompt>` |
| Codex | `codex exec --json [-m <m>] <prompt>` |
| Cursor | `cursor-agent -p --output-format stream-json --workspace <root> [--model <m>] <prompt>` |

The start request body is `{project, harness, prompt, model?}`. A `model`
must be in the harness's allowlist, which the `models` action
(`POST /api/models`, body `{}`) returns as `{claude:[...], codex:[...], cursor:[...]}`:

| Harness | Allowlist source |
|---|---|
| Claude Code | fixed: the aliases and full ids in the [model configuration docs](https://code.claude.com/docs/en/model-config#model-aliases) (`fable`, `opus`, `sonnet`, `haiku`, `best`, `opusplan`, `sonnet[1m]`, `opus[1m]`, `claude-…` ids) |
| Codex | slugs not marked `hide` in `$CODEX_HOME/models_cache.json` (Codex's model catalog cache), plus `model` from `config.toml` |
| Cursor | `cursor-agent --list-models`, cached a day in `$AI_COLLAB_STATE_DIR/models-cursor.json` |

Any other value is rejected with 400 before anything is spawned.

The prompt is one argv element, 1-4000 characters, and may not start with `-`.
No flag skips permissions or trust (`--force`, `--trust`,
`--dangerously-bypass-hook-trust` are never passed). Output goes to
`$AI_COLLAB_STATE_DIR/<project>/starts/<time>-<harness>.log`. The child gets no
`AI_COLLAB_*` settings, so its hooks find the project from `projects.json` by
its cwd, like any session; it gets `AI_COLLAB_WAKE=1`, so its first prompt
is not mistaken for the operator at a terminal. The server waits up to 15
seconds for the id the CLI prints (Claude: a UUID in its output; Codex:
`thread.started` `thread_id`; Cursor: `session_id`) and returns the session's
public address `harness#label`; the raw id stays in the log. The UI links the
session once its `SessionStart` status arrives. For Codex, the result warns
when `config.toml` has no trust entry for the plugin's hooks; trust them in
`/hooks`.

**Where to start.** A second picker offers only the places the server can use:

| Place | Shown when | argv |
|---|---|---|
| In the project folder | always | as above |
| In a new git worktree | `root/.git` exists and `git` is on `PATH` | Claude: `claude --bg --worktree ai-collab-claude-<UTC stamp> <prompt>` (Claude makes its own worktree). Codex, Cursor: `git -C <root> worktree add -b ai-collab/<harness>-<stamp> <root>/.claude/worktrees/ai-collab-<harness>-<stamp>`, then the harness argv with that folder as cwd (and Cursor's `--workspace`) |
| In the openshell sandbox | `AI_COLLAB_OPENSHELL_SANDBOX` is a valid name and `openshell` is on `PATH` | `openshell sandbox exec --name <sandbox> --workdir <root> --no-tty --no-login-shell -- <harness argv>`, the wrapper wake uses (`lib/controls.mjs`) |

The server validates the place against that list; a failed `git worktree add` starts nothing.

**Unverified.** Only fake executables were run (`test/start-places.test.mjs`, and the 390 px browser check). Whether `claude --bg --worktree` works together, whether the sandbox has the project at the same path, and whether hooks inside the sandbox reach `projects.json` and ntfy were not checked. Whether `claude --bg` prints
the session ID that its hooks report, and whether `cursor-agent -p` runs in a
workspace it has not trusted, were not checked.

## Agents starting agents

An agent can start another harness's agent from its shell, and the two can
then message each other:

1. **Parent link.** At `SessionStart`, the Claude Code hook appends `export
   AI_COLLAB_PARENT=claude#<label>` to `$CLAUDE_ENV_FILE`, which Claude runs
   before each Bash command ([persist environment
   variables](https://code.claude.com/docs/en/hooks#persist-environment-variables)).
   Cursor's agent shell exports `CURSOR_CONVERSATION_ID`, so a harness started
   there names `cursor#<label>` as its parent. Codex hooks cannot set its
   shell environment: a Codex agent prefixes the command itself, for example
   `AI_COLLAB_PARENT=codex#<label> claude -p "<prompt>"`; its SessionStart
   context gives the exact prefix.
2. **Child side.** A session started with `AI_COLLAB_PARENT` gets both
   addresses in its SessionStart context, records the parent in its registry
   entry and status envelope (the UI shows "started by …"), and sends the parent
   one direct message, `started: <child address> (<harness>, <folder name>)`.
   The child takes its harness name as its peer and never the parent's
   inherited `AI_COLLAB_PEER` or `AI_COLLAB_SESSION`.
3. **Messages.** `ai-collab send codex#<label> "…"` and the MCP tool
   `send_to_peer` reach that one session at its next hook. A headless child
   (`codex exec`, `claude -p`, `cursor-agent -p`) runs hooks only while its run
   lasts: a message sent after it ends waits until the parent resumes it with
   the command `ai-collab sessions` prints (`codex exec resume <id>
   "<prompt>"`, `claude -p --resume <id> "<prompt>"`, `cursor-agent -p --resume
   <id> "<prompt>"`), or the operator wakes it. In AFK mode `on`, the child's
   Stop hook keeps it listening for up to `AI_COLLAB_AFK_WAIT_S`.
4. **Finding agents.** `ai-collab sessions` and the MCP tool `list_sessions`
   list this project's sessions on this machine: address, harness, online, last
   active, parent, cwd, and the resume command. They read the local registry
   only; nothing there is published.

Tested with fake hook payloads, not with real harness runs.

## Receipts

An agent publishes a read receipt the moment a message reaches it: when a hook
injects it (SessionStart, UserPromptSubmit, PostToolUse, or a Stop
continuation), when `ai-collab inbox` prints it (with or without `--peek`), or
when `wait_for_answer` (or the Stop hook's important-question check) returns a
phone reply. One delivery is one publish to `ai-collab-<project>--receipts`,
split only to stay within 4095 bytes:

```json
{"v":1,"kind":"receipt","from":"claude","session":"<16-hex label>","ids":["<ntfy message id>","…"],"state":"read","ts":"<ISO time>"}
```

Receipts are best effort: the publish runs in the background under a
1.5-second deadline, alongside activity, and a failure never blocks or changes
delivery. Like the status topic, receipts carry no priority or tags and no
phone subscribes to them, so they never notify. The UI loads the topic's
history once and keeps it live through the shared subscription.

The operator's own messages show ticks:

| Tick | Label | Direct message | Broadcast or harness message |
|---|---|---|---|
| ✓ | Sent | ntfy accepted it | ntfy accepted it |
| ✓✓ | Delivered | the session was online when sent, or has been active since | at least one recipient session was online when sent, or active since |
| ✓✓ in the primary colour | Read | that session sent a receipt | every session online when the UI first saw the message sent a receipt; with none online then, the first receipt |

"Online when sent" is the set of online sessions when the UI server first saw
the message, so history loaded after a UI restart, older than 30 minutes, has
no such set and turns read on its first receipt.

## Web messaging

The operator UI is a Next.js (App Router) app in `web/`. Build it once, then
start it from the repository root:

```sh
npm ci
npm run build                 # next build web
npm run ui
```

`npm run ui` runs `next start web -H 127.0.0.1 -p ${AI_COLLAB_UI_PORT:-8795}`.
The server serves every project in `~/.config/ai-collab/projects.json`, each
resolved from its own `root` with its own URL, token file, and peers. It keeps
ntfy tokens and raw harness session IDs server-side. The browser sees only
public `peer#label` identities.

| Variable | Default | Meaning |
|---|---|---|
| `AI_COLLAB_UI_WORKSPACE` | current directory | Fallback project directory, used only when `projects.json` lists no usable project |
| `AI_COLLAB_UI_PORT` | `8795` | Loopback port for `npm run ui` |
| `AI_COLLAB_UI_ORIGIN` | — | HTTPS origin allowed to post, e.g. `https://ai-collab-ui.<tailnet>.ts.net` (no trailing slash) |

The UI has no login. Access control is the loopback bind plus Tailscale: only
tailnet clients granted the `ai-collab-ui` service reach it. Every `POST
/api/*` must come from the UI's own origin (`AI_COLLAB_UI_ORIGIN`, or
`http://127.0.0.1:<port>` locally), which blocks cross-site request forgery.
Pages carry a per-request script nonce in their Content Security Policy.

The browser opens one `EventSource` on `/api/events` and re-renders on each
pushed `state` event; it never polls. In an Activity view (`view=activity`) the
same stream also carries `activity` events: first `{reset:true, items}` with
the history, then only new rows. The server holds a single ntfy streaming
subscription (`/<topic1>,<topic2>/json`) shared by all browsers and by every
project on the same ntfy server and account. It fetches a topic's history once
(`poll=1&since=all`) when a browser first opens that project (broadcast,
status, and each peer inbox), and reconnects with `since=<last id>` after a
drop, backing off 30 seconds on HTTP 429. The activity topic's history keeps
the newest 3 MB of the cache, and the hub keeps 500 events per topic.

**Home** (`#home`, the landing page, the header's house button, or the sidebar
logo) shows one card per session across every project in `projects.json`:
avatar, human name, `harness#label`, project, state, last action (tool and
summary), last active, "started by …", and running subagents nested under the
card. A child session whose registry `parent` is listed nests under its parent.
Cards group by state; Offline starts collapsed:

| State | Rule (`web/lib/session-state.js`) |
|---|---|
| Waiting on you | an open approval or choice (not expired), or an unanswered important question |
| AFK hold | online, AFK mode not `off`, the latest row is `turn ended`, and no `stop` status after it: the Stop hook is waiting |
| Working | an open tool call or running subagent under 15 minutes old, or any activity in the last 60 seconds |
| Idle / Offline | the registry PID check |

Approvals, choices and questions are answered on the card. The browser opens
`/api/events?view=home`; the server adds a `sessions` list to the pushed state
and opens each project's status, broadcast and activity topics once on the
shared hubs, so Home adds no polling. A project whose topics fail is listed as
unavailable. The Project level's **Sessions** tab (`view=sessions`) shows the
same cards for one project.

**Session names** appear next to `harness#label` in the session picker, the
mention picker, the sidebar and the cards. Claude Code: the `session_title`
field of its SessionStart and UserPromptSubmit hook input (in the Claude
2.1.330 hook schema). Codex: the thread's newest `thread_name` in
`$CODEX_HOME/session_index.jsonl`. Hooks record it in the local registry at
SessionStart, UserPromptSubmit and Stop (`lib/names.mjs`). Cursor gives none;
the UI falls back to the folder name and the first six words of the session's
earliest prompt still in the activity history.

The Session level's **Subagents** tab lists each run: type, parent session,
running or done, step count, description, start time and last action. Tap one
to see only its rows (`&tab=subagents&run=<id>`).

A subagent run is **running** while it has a row from the last 2 minutes,
**idle** after that, and **done** at its stop row or completion notice; the
"N subagents" badges on Home and the Activity overview count running runs only.

A **Go to agent** button sits on every Home card, its "started by" parent,
each subagent run (in threads, the overview and on cards), each overview
row's agent, and each agent's message. A session started by another shows
**Back to parent** under its title; a subagent run's view has **Back to parent**
to its session's thread.

The wake banner disappears once the session reports a hook or status after the
wake began, or is online again after the wake finished; a failed wake keeps its
Retry, hidden while the session is online. A direct message to a running
session returns `wake: {status: "online"}` with no note; its ticks show
delivery.

**Send now** in the composer adds `urgent: true` to the send request, and a
message whose envelope has `urgent: true` shows ⚡. Delivery at the next tool
call is built on another branch; this branch only sends the field.

The **New session** panel sends `{project, harness, prompt, model?, worktree?,
openshell?}` (`worktree: true` and `openshell: true` choose the place; both at
once is rejected). It reads per-harness models from `GET
/api/models?project=<name>` (`{harness: [model, …]}`) and shows a **Model**
picker only when that returns a list; that endpoint and the `model` check are
built on another branch. Until then the browser logs one 405 per panel open.

The sidebar (a drawer on phones) lists the projects. Inside a project, zoom by
sender:

| Level | Shows | Composer sends to |
|---|---|---|
| Project | The broadcast topic: all agents and the operator | `all` |
| Harness | Broadcast posts from, to, or mentioning that harness, plus its inbox | The harness inbox (every session) |
| Session | That session's direct thread and its broadcast posts | The session directly; wakes it if offline |

The Session level shows one thread: the session's chat messages and its
activity interleaved by time, with the composer below. The **Activity on/off**
switch hides or shows the activity rows (default on, remembered in the
browser). The Project level has **Chat | Activity** tabs; **Activity**, also in
the sidebar, is the project overview: every agent's activity and the
operator's own broadcasts interleaved by time, newest last, with a composer
that sends to `all`. Tap an agent's name on an overview row, a
message's sender avatar or name, or an `@peer#session` tag to open that
session (an `@harness` tag opens the harness level); the operator's own
messages stay plain. Rows render
by type: prompts as user bubbles, assistant text as Markdown, tool calls as an
icon, the tool name, and a one-line summary (tap to see the input), results as
a collapsed preview (tap to expand; **Full output** opens the attachment),
and errors in red. A call and its result share a row when the harness supplies
a call ID. Each subagent run folds into one collapsed row in its parent's
thread, **Subagent · <type> · running/done · N steps** (N counts tool calls);
tap it to show that run's rows indented below it. A step is one tool use: its
call row, or its result alone. A run is done at its stop row, at the parent's
`<task-notification>` prompt with that `<task-id>` and a final `<status>`, or
when the parent's Agent tool result says `"status": "completed"`; that result's
`agentId` also gives the run its description. On 2026-11-21 the
`ai-collab-ai-collab--activity` topic held only `tool_result` rows inside
subagents and no `tool_call`, `text`, or subagent start/stop rows at all: none
of Claude's `"async": true` registrations (PreToolUse, MessageDisplay,
SubagentStart, SubagentStop) had published, so runs showed 0 steps before this
counting rule. The page remembers which
runs are open until it reloads. On the overview, a badge after an agent's name
counts its running subagents. A `compact` row marks a context compaction. **Working…** shows while an agent's latest event is a tool call
without a result (for at most 15 minutes). The view follows the newest row
like the chat and keeps the last 500 rows.

On a phone, drag the list down from its top, or up from its bottom, past 70 px to refresh: the app
reconnects its stream like **Retry** and shows the same toasts. The gesture
uses touch events only and is ignored while text is selected or the composer
has focus; the page keeps `overscroll-none`, so the browser's own reload never
fires. `/api/file/<name>` serves a
`text/plain` file only when an activity event in memory references it; chat
topics still serve images only.

After a deploy, an open page shows an "Update available" toast when it reconnects; tap Reload to load the new build. The page compares its build id with `GET /api/version`.


Mention options, the session picker, and the sidebar show when each session
and harness last sent a `msg` envelope (`3m ago`, `never`), computed from
history the server already holds.

The **AFK** switch in the header sets the operator mode to `on`, `off`, or
`quiet`. Each change publishes `{v:1, kind:"mode", from:"operator", mode, ts}`
to the broadcast topic of every project. The latest mode envelope in history is
the current mode (none means `off`); the chat never shows mode envelopes.

The UI uses [shadcn/ui](https://ui.shadcn.com/docs) components with Tailwind
CSS v4 and the [prompt-kit](https://www.prompt-kit.com/docs) chat components
(`chat-container`, `message`, `prompt-input`, `scroll-button`), copied into
`web/components/ui/` by the shadcn CLI. `web/app/shadcn.css` vendors the
shadcn style's Tailwind variants. Code is highlighted with
[shiki](https://shiki.style/guide/regex-engines#javascript-regexp-engine) through
prompt-kit's `CodeBlockCode`: fenced blocks in chat Markdown, tool inputs (a
shell command as bash, other input as JSON), and tool results whose language
is clear (a diff, shell output, a read file by extension, JSON). Shiki loads on
first use with its JavaScript regex engine, which needs no
`'wasm-unsafe-eval'` in the CSP, and fetches each of its 12 languages (js, ts,
jsx, tsx, json, bash, python, diff, markdown, yaml, css, html) on demand. Light
and dark colours follow the theme. Only expanded blocks are highlighted, and
blocks over 20 KB stay plain text. The theme
defaults to dark; the header toggle switches to light or the system setting.

`next build` records the absolute path of `web/server/ui.mjs`; rebuild after
moving the checkout.

A systemd user unit that runs the build from the checkout:

```ini
[Unit]
Description=AI Collab messaging UI

[Service]
WorkingDirectory=%h/ai-collab
Environment=NODE_ENV=production
Environment=AI_COLLAB_UI_WORKSPACE=%h/my-project
Environment=AI_COLLAB_UI_ORIGIN=https://ai-collab-ui.<tailnet>.ts.net
ExecStart=/usr/bin/node %h/ai-collab/node_modules/next/dist/bin/next start %h/ai-collab/web -H 127.0.0.1 -p 8795
Restart=on-failure
RestartSec=2
UMask=0077

[Install]
WantedBy=default.target
```

Run `npm ci && npm run build` in `~/ai-collab` before `systemctl --user
restart ai-collab-ui`.

Type `@` or tap **Mention** to tag a session or harness in a post. Pick
**Session** and a session (or tap it in the sidebar) to chat directly. Use
**Reply to question** to answer an MCP question on the broadcast topic.

### Re-record the demo

```sh
npm ci
npm run demo                  # next build web, then scripts/demo/record.mjs → docs/demo.gif
```

`scripts/demo/record.mjs` runs the built UI against the in-process fake ntfy
(`test/helpers/fake-ntfy.mjs`) with a throwaway `HOME` and project `calc-demo`,
so it touches no real topic, config or session. Real hook processes
(`scripts/ai-collab-hook.mjs` with fake payloads) and `sendMessage` drive
`scripts/demo/scenario.mjs`; a screenshot loop records a 390×844 dark phone
viewport at 2× and `scripts/demo/encode.mjs` adds captions, zooms and 3×
fast-forward and writes the GIF (10 fps, changed pixels only). Beats the UI
lacks (approval card, Home) are skipped and listed. Options:
`node scripts/demo/record.mjs --out /tmp/demo.gif --keep` keeps the frames;
`node scripts/demo/encode.mjs <frames-dir> out.gif --stills 5,12` re-encodes
them and writes PNG stills to check. Set `DEMO_CHROME` to pick a Chromium
binary; by default it uses `~/.cache/ms-playwright/chromium-*`.

### Wake, compact, and context alerts

Each hook records the harness process as its PID plus the process start time
(field 22 of `/proc/<pid>/stat`), so a reused PID never counts as the session.
A session counts as online only while that pair matches a live process.

| Action | Session running | Session exited |
|---|---|---|
| Direct message (wake) | `queued`: the next hook delivers it | Resume the exact session: `claude --print --resume`, `codex exec resume`, `agent --print --resume` |
| Compact | Codex: `thread/compact/start` over the local app-server daemon when the thread is loaded there and idle. Otherwise `requested`: an urgent operator message asks the session to finish its step, and the operator runs `/compact` | Claude: `/compact` through the Claude Agent SDK (`query` with `resume`). Codex: `thread/compact/start` over `codex app-server`. Cursor: `unsupported` |

Compacting a running session, per harness:

| Harness | Outside trigger | What Compact does |
|---|---|---|
| Codex | The TUI attaches to the local app-server daemon (`daemon_auto_start` in `codex features list`); `codex app-server proxy` connects another client to it. The protocol (`codex app-server generate-json-schema`) has `thread/loaded/list`, `thread/read` (status `idle` or `active`), `thread/resume` ("If thread_id identifies a running thread, app-server rejoins that thread"), and `thread/compact/start`. | Lists loaded threads; if the thread is loaded and idle, rejoins it with only its id and compacts it. A busy thread or one outside the daemon gets the urgent request; press Compact again once its turn ends. |
| Claude Code | None documented. [Hook outputs](https://code.claude.com/docs/en/hooks#precompact-output) cannot start a compaction (PreCompact only shapes one), a Stop `reason` is text for the model, and `/compact` runs only when typed in the session or sent from [Remote Control](https://code.claude.com/docs/en/remote-control). | Urgent request; run `/compact` in the terminal or from Remote Control. |
| Cursor | None: `cursor-agent --help` lists no compaction command or flag. | Urgent request; run `/compact` in the session. |

ai-collab never writes another process's transcript or rollout files.

**Unverified.** The live Codex path ran only against a fake daemon proxy; no
real running thread was compacted, and whether the daemon rejects
`thread/compact/start` when a turn starts between `thread/read` and the request
was not checked.

Concurrent requests for one session share a single run. A wake and a compact
never run at the same time. The child gets no `AI_COLLAB_*` variables. Its own
hook reads the private project config.

| Variable | Default | Meaning |
|---|---|---|
| `AI_COLLAB_WAKE_RUNNER` | `host` | `host` runs the harness directly. `openshell` runs it with `openshell sandbox exec`. |
| `AI_COLLAB_OPENSHELL_SANDBOX` | — | Sandbox name, required when the runner is `openshell`. |

Context alerts post one `alert` envelope to the broadcast topic each time a
session's current context rises above 200,000 tokens. A sample of 200,000 or
fewer re-arms the alert, and a failed publish retries on the next sample.
Agents skip these envelopes. The sources are the harnesses' own counters, read
locally:

| Harness | Source |
|---|---|
| Claude Code | Last assistant `usage` in the transcript: `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` |
| Codex | Last `token_count` event in the rollout: `info.last_token_usage.total_tokens` |
| Cursor | `preCompact` hook `context_tokens` (sampled only before compaction) |

### Tailscale

To make the UI available privately over Tailscale, define a Service named
`ai-collab-ui` for TCP 443, then advertise the local listener:

```sh
tailscale serve --service=svc:ai-collab-ui --https=443 http://127.0.0.1:8795
```

Set `AI_COLLAB_UI_ORIGIN` to the HTTPS service URL without a trailing slash
in the UI service environment. Approve the host and grant the intended clients
access in the Tailscale admin console.

### Push notifications

The UI server sends a Web Push notification, even with every tab closed, for actions the operator must take:

| Event | Title | Important |
|---|---|---|
| Permission approval | `Approve <tool> · <peer#session>`, body is the command or path summary | yes |
| Choice card (`AskUserQuestion`) | `Choose · <peer#session>`, body is the first question | yes |
| `ask_question` | `Question · …` or `Important question · …`, body is the question | when the agent set `important` |
| Direct message to the operator | `Message · <peer#session>` | no |

Progress, activity, and status send nothing. The server keeps every project's broadcast and inbox topics open from startup (`web/instrumentation.js`) and notifies an item once: only while it is still pending and less than 15 minutes old, with sent IDs remembered for 24 hours across restarts. Important notifications replace the earlier one for the same item with a new alert (`renotify`) and stay on screen until dismissed. Tapping a notification focuses or opens the UI at that session's thread.

Enable it on an Android phone:

1. Open the Tailscale HTTPS URL (`AI_COLLAB_UI_ORIGIN`) in Chrome or Firefox. Push needs HTTPS; a plain `http://` tailnet address does not work.
2. Tap the bell in the header, then **Turn on**, and allow notifications when the browser asks. The browser asks only after this tap.
3. Tap the bell again and **Send test**.

The bell shows **off**, **on**, **blocked by browser** (re-allow in the site settings), or **unsupported**. On iPhone and iPad, Safari delivers Web Push only to a Home Screen app: share, **Add to Home Screen**, open AI Collab from there, then tap the bell. The web manifest (`/manifest.webmanifest`, standalone display) provides this; its only icon is `icon.svg`, so iOS may show a generic Home Screen icon.

State lives under `$AI_COLLAB_STATE_DIR/push/` (default `~/.local/state/ai-collab/push/`), each file mode 0600: `vapid.json` (the VAPID key pair, generated on first use), `subscriptions.json` (one entry per browser; removed when the push service answers 404 or 410, or when the bell turns off), and `sent.json` (recent item IDs). Delete `vapid.json` to rotate keys; browsers then need to turn notifications on again. The VAPID subject is `AI_COLLAB_UI_ORIGIN`.

Privacy: the server encrypts each payload end to end for the subscribed browser (RFC 8291, `aes128gcm`) and sends it through the browser vendor's free push service, Google FCM for Chrome and Mozilla autopush for Firefox. The vendor sees the ciphertext, its size, the delivery time, and the endpoint, not the contents. A payload holds the harness, session address, project, and a summary clipped to 200 characters (tool and command, or the question text), never file contents.

### GitHub sign-in

Optional. With `~/.config/ai-collab/github.json` (`$XDG_CONFIG_HOME/ai-collab/github.json`) present, the UI asks each visitor to sign in with GitHub, and every message, question answer, approval and AFK change sent from the UI carries the sender's GitHub login. Without the file, the UI behaves as before: no sign-in, every message from `operator`.

1. Register an OAuth app at <https://github.com/settings/applications/new> ([GitHub docs](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app)):

   | Field | Value |
   |---|---|
   | Application name | `AI Collab` (any) |
   | Homepage URL | `AI_COLLAB_UI_ORIGIN`, e.g. `https://ai-collab-ui.<tailnet>.ts.net` |
   | Authorization callback URL | `AI_COLLAB_UI_ORIGIN` + `/api/auth/callback`, e.g. `https://ai-collab-ui.<tailnet>.ts.net/api/auth/callback` |
   | Enable Device Flow | off |

2. Generate a client secret and save it in a file only you can read, e.g. `install -m 600 /dev/null ~/.config/ai-collab/github-client-secret`, then paste the secret into it.
3. Write `~/.config/ai-collab/github.json`; `users` lists the GitHub logins allowed in (case-insensitive):

   ```json
   {
     "clientId": "Ov23liEXAMPLE",
     "clientSecretFile": "/home/you/.config/ai-collab/github-client-secret",
     "users": ["octocat", "hubot"]
   }
   ```

4. Restart the UI service. Sign-in needs `AI_COLLAB_UI_ORIGIN`; the UI refuses to start with `github.json` and no origin.

How it works ([web application flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#web-application-flow)):

- **Sign in with GitHub** opens `/api/auth/login`, which redirects to GitHub with a random `state` held in a 10-minute HttpOnly cookie and an empty scope (public profile only).
- `/api/auth/callback` checks `state`, exchanges the code for a token, reads `GET https://api.github.com/user`, checks the login against `users`, and drops the token. The client secret file is read at each callback and never logged.
- The session cookie (`__Host-ai-collab-session`: HttpOnly, Secure, SameSite=Lax, 30 days) holds `{login, name, exp}` signed with HMAC-SHA256. The key is 32 random bytes at `$AI_COLLAB_STATE_DIR/auth/secret` (mode 0600), created on first start. Delete it to sign everyone out.
- Every `/api` route except `/api/auth/*` and `/api/version` answers 401 without a valid session. A login removed from `users` is refused at the next request after the UI restarts.
- The header shows **signed in as \<login\> · sign out**. Each person on the allowlist signs in with their own account; the UI labels their messages with their login, and the viewer's own as **You**.

What agents see: routing stays `from: "operator"`. Messages gain an envelope field `by` (the login), and hooks render the sender as `from=operator (octocat)`. Question answers and approvals stay the plain `reply <id> <answer>` text, with the login in the ntfy title (`Reply from operator (octocat)`), which the UI shows next to the answer. AFK mode envelopes carry `by` too.

## Install

Requirements: Node 22+. Run `npm ci && npm run build && npm test`. The UI uses shadcn/ui, Tailwind CSS, and the prompt-kit chat components with React, built by Next.js into `web/.next/`. Tests use an in-process fake ntfy server and need no network or API access.

### Claude Code

Load the directory as a plugin, for example during development:

```sh
claude --plugin-dir /path/to/ai-collab
```

Verify the flag and marketplace flow against your Claude Code version. The hook file is `hooks/hooks.json`, and it uses `${CLAUDE_PLUGIN_ROOT}`.

### Codex

```sh
codex plugin marketplace add /path/to/ai-collab
codex plugin add ai-collab@ai-collab
```

Restart Codex and check `/hooks` to trust the enabled plugin hooks. The
manifest is `.codex-plugin/plugin.json` and points to `hooks/codex-hooks.json`.

### Cursor

```sh
node /path/to/ai-collab/scripts/install-cursor.mjs --copy
```

Cursor requires a copy here when the source is outside its local plugin directory. Restart Cursor afterwards. Cursor's CLI runs only `sessionStart` and `stop` from a plugin's hooks (observed with cursor-agent 2026.11.19: prompts, tool results and replies never reached plugin hooks, while the same events reached `~/.cursor/hooks.json`). So the installer writes `hooks/cursor-hooks.json`, with the plugin path filled in, into `~/.cursor/hooks.json`: it replaces earlier ai-collab entries and keeps every other tool's hooks. The plugin manifest registers no hooks, so nothing fires twice.

### Skill for agents

`skills/ai-collab/SKILL.md` is a small skill for agents: it covers `peers`, `send`, `inbox`, `afk`, the operator reply routes, and the AFK rules, with the untrusted-message rules. Make sure `scripts/ai-collab` is on PATH, or use its full path.

## Development

Run `./setup_prek.sh` once. It installs [prek](https://github.com/j178/prek) (through `uv`), runs `npm ci`, and installs two git hooks from `.pre-commit-config.yaml`: whitespace and JSON/YAML checks on `pre-commit`, and [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) on `commit-msg` (`feat:`, `fix:`, `docs:`, `ci:`, `chore:` ...). Run `prek run --all-files` to check the whole repo as CI does.

`.github/workflows/tests.yml` runs prek, `npm test` with an empty `HOME`, and `npm run build` on every push and pull request.

Releases are manual. Run the **Prepare release** workflow on `main` (tick `dry_run` to preview). git-cliff (`cliff.toml`) computes the next version from the commits since the last tag: `feat` bumps the minor version, `fix` the patch, and `!` or `BREAKING CHANGE` the minor version below 1.0.0. The workflow writes that version into `package.json`, `package-lock.json`, and the three `*-plugin/plugin.json` manifests, commits `chore(release): vX.Y.Z`, tags it, and dispatches **Release**, which checks the manifests against the tag, re-runs tests and build, and publishes a GitHub Release with git-cliff notes. With no tag yet, the first run tags `v0.7.0`.

## Claude Code channels (not used)

Claude Code [channels](https://code.claude.com/docs/en/channels-reference) let an
MCP server push messages into an idle session: the server declares
`capabilities.experimental["claude/channel"]` and emits
`notifications/claude/channel`. This plugin does not declare it, because a
custom channel needs a changed launch:

- Every session must start with `claude --dangerously-load-development-channels plugin:ai-collab@<marketplace>` (or `server:<name>`), interactively, and accept a warning dialog. `--channels` accepts only plugins on Anthropic's allowlist or an organization's `allowedChannelPlugins`; the flag is ignored with `-p` and the Agent SDK. ([Test during the research preview](https://code.claude.com/docs/en/channels-reference#test-during-the-research-preview), [Research preview](https://code.claude.com/docs/en/channels#research-preview))
- It needs claude.ai or Console authentication, and Team and Enterprise organizations must set `channelsEnabled`. ([Enterprise controls](https://code.claude.com/docs/en/channels#enterprise-controls))
- The MCP server learns the session label only from tool calls, so it cannot tell which session's inbox to stream until the agent calls a tool.

## Known limits

- Peer names are self-asserted. Use ntfy ACLs to restrict who can publish.
- Delivery is best effort with no retry; read receipts are best effort too. An offline peer only gets messages still inside the server's cache window.
- Codex and Cursor event shapes are not verified against live hosts. `beforeSubmitPrompt` and Codex `PostToolUse` are deliberately not registered.
- Status shows peers that have started or stopped. It is not a presence system.
- An agent idle at its prompt with AFK mode `off` still hears a message only at its next hook.
- ntfy rate-limits requests per client IP (default burst 60, one more every 5 s). All local agents and the UI share `127.0.0.1`; many AFK agents waking at once can hit HTTP 429. Adding `127.0.0.1` to the server's `visitor-request-limit-exempt-hosts` lifts that.
