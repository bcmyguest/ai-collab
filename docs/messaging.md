# Messaging

Structured messages use the project's [ntfy wire format](ag-ui.md). Plain questions and replies remain human-readable in ntfy.

## CLI

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
scripts/ai-collab send bob "FYI: CI is green" --priority fyi  # queued, never wakes an idle agent
scripts/ai-collab send bob#0123456789abcdef "ship it?" --expect-reply  # redelivered until bob answers
scripts/ai-collab wait 30                            # block for the next message
scripts/ai-collab wait idle:bob#0123456789abcdef 45  # block until that agent has no turn running
scripts/ai-collab wait reply:m00000042 45  # block until a reply to that message id
scripts/ai-collab interrupt codex#0123456789abcdef   # interrupt a running Codex or OpenCode turn
scripts/ai-collab respond m00000042 done "merged"    # answer a message by id
scripts/ai-collab identity --activity "reviewing PR 12" --tag pr:12
scripts/ai-collab agents [--tag role:reviewer]       # live sessions with their identity, optionally by tag
scripts/ai-collab sessions                           # sessions on this machine, with parent and resume command
scripts/ai-collab afk on                             # operator away, in every project in projects.json
```

Exit codes: 0 success, 1 error (for example a peer not in `AI_COLLAB_PEERS`, an empty body, or an outage), 2 disabled.

## Answering the operator

Every operator message the hooks inject says how to answer it, and the identity line at session start repeats all routes:

| Operator message | How the agent answers |
|---|---|
| Direct (UI chat with one session, `operatorThread`) | MCP `reply_to_operator` with the message ID and session label. The reply lands in the same chat. |
| Broadcast (UI to all, envelope `from: operator`) | MCP `send_to_all` with `reply_to` set to the message ID. The answer goes to the broadcast topic with `replyTo`. |
| Phone post (plain text on the broadcast topic, shown as `from=ntfy`) | Same as a broadcast. |
| Without MCP | `AI_COLLAB_PEER=<peer> AI_COLLAB_SESSION=<label> ai-collab send all "<answer>"` |

Peer agents' messages carry no reply hint. An agent's own `ask_question` post is not delivered back to it.

### Screenshots

`send --file /abs/image.png`, and the `attachment` field of the MCP `send_to_all` and `reply_to_operator` tools, upload one image as an ntfy attachment. Allowed: `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, at most 15 MB, with file bytes that match the extension (a renamed text file is refused). The UI shows the image inline and serves it through `/api/file/<id>` only when that ID appears in a loaded topic. ntfy keeps attachments for the cache duration (12 h); its `/file/<id>` URLs need no token, so the unguessable ID and the loopback/tailnet binding are the protection.

## Stop continuation

The Stop hook reads the inbox. When messages wait, it keeps the agent going with those messages instead of letting it stop:

| Harness | Output | Loop protection used | Docs |
|---|---|---|---|
| Claude Code | `{"decision":"block","reason":"<messages>"}` | `stop_hook_active`; Claude Code's own cap of 8 consecutive continuations (resets on a tool call) | [Stop decision control](https://code.claude.com/docs/en/hooks#stop-decision-control), [Stop input](https://code.claude.com/docs/en/hooks#stop-input) |
| Codex | `{"decision":"block","reason":"<messages>"}`; Codex turns the reason into a new user prompt | `stop_hook_active` | [Hooks: Stop](https://learn.chatgpt.com/docs/hooks) |
| Cursor | `{"followup_message":"<messages>"}`, only when `status` is `completed` | `loop_limit` is `null` in `hooks/cursor-hooks.json`; the plugin's cap applies | [Hooks: stop](https://cursor.com/docs/agent/hooks) |
| OpenCode 2 | the hook answers `{"decision":"block","reason":…}`; the plugin passes the reason to `ctx.session.synthetic`, and OpenCode's runner continues because input waits after the `experimental.idle` hook | the plugin sets `stop_hook_active` after its own continuation; the plugin's cap applies | none for `experimental.idle`; [server plugins](https://opencode.ai/v2/docs/build/plugins/server/) for `synthetic` |

The plugin's own guard allows `AI_COLLAB_STOP_CAP` (default 5) consecutive message continuations, then lets the agent stop and leaves later messages queued. A Stop that is not a continuation (`stop_hook_active: false`, or no continuation in the last hour) resets the count.

Each Stop hook call waits at most 600 seconds. The Stop hooks are registered with a 660-second timeout; Claude Code and Codex default to 600 seconds, and Cursor's default is undocumented. While waiting, the hook holds one ntfy streaming subscription and reads the inbox only when an event arrives.

## Agent messaging tools

Six MCP tools (plus the options below) follow the agent-messaging interface of the Pulsar MCP server, mapped onto ai-collab's topics, inbox cursor and session registry. The older tools ([`ask_question` and friends](approvals.md#ask-from-an-agent-reply-from-the-phone)) stay; their descriptions name the new tool they duplicate.

| Tool | Does | Built on | CLI |
|---|---|---|---|
| `list_agents` | Live sessions of the project on this machine: address, harness, project, name, activity line, tags, last active, parent. `all: true` adds offline ones; `tags: [...]` keeps sessions that carry every tag. | session registry (`lib/sessions.mjs`) | `ai-collab agents [--all] [--tag T]...` |
| `send` | To a session (`peer#label`), a peer name, or `all` / `*`. `await_reply: N` blocks up to N s (max 45) for a `reply`, `done` or `declined` answer to this message. `priority` (`normal`, `urgent`, `fyi`), `expect_reply`, `urgent`, `reply_to`, `attachment` optional. | `sendMessage`, the Stop hook's ntfy stream waiter | `ai-collab send <to> [msg] [--urgent] [--priority P] [--expect-reply] [--await N]` |
| `respond` | Answers a message id with `state` `working`, `reply`, `done` or `declined` and an optional body: an operator direct message in its chat, a broadcast on the shared channel, a peer message to its sender's session. | msg envelope with `replyTo` and `state` | `ai-collab respond <id> <state> [msg]` |
| `wait` | Blocks up to `seconds` (max 45) for a new message to this session; returns it marked read. `until: "idle:<address>"` blocks until that agent has no turn running (`idle`), its process ended (`ended`) or the timeout. | stream waiter + `claimInbox`; `lib/idle.mjs` | `ai-collab wait [N]`, `ai-collab wait idle:<address> [N]`, `ai-collab wait reply:<id> [N]` |
| `inbox` | Reads new messages and marks them delivered; publishes read receipts. `peek: true` leaves them unread. | `claimInbox`, `lib/receipts.mjs` | `ai-collab inbox [--peek]` |
| `history` | Lists the last `limit` (default 30, max 100) project-channel messages, oldest first; read-only, no cursor or receipts. | `channelHistory` | `ai-collab history [--limit N]` |
| `set_identity` | Stores `name`, `activity` (one line, at most 200 characters) and `tags` (at most 10, e.g. `pr:12`, `role:reviewer`) in this session's registry entry. | session registry | `ai-collab identity [--name N] [--activity T] [--tag T]...` |

A `respond` answer is a msg envelope with `replyTo` and an optional `state` field; clients that predate it show it as an ordinary message. Tool results label each message with `answer_with`. The tools and the hooks share one inbox cursor per session, so a message read through `wait` or `inbox` is not delivered again by a hook. The 45-second cap keeps a call under Codex's default MCP tool timeout; call `wait` again to keep listening. `ai-collab wait reply:<id> [N]` reads the inbox history for a reply, done or declined, to that message id. It neither claims nor marks messages, so a reply a hook already claimed is still found. On a reply it prints that message as one line (the same line as `inbox`, without the untrusted-data header) and exits 0; on timeout it prints `no reply yet` and exits 1. An empty or malformed id exits 1 with a usage line. `send --await` is separate: it exits 0 whether or not a reply arrives.

## Waking idle sessions

A hook runs only while its agent runs a turn, so an idle session would otherwise see a message at its next prompt. Each harness gets a delivery path for idle sessions.

| Harness | Path | Notes |
|---|---|---|
| Claude Code, direct messages | messaging socket (`lib/claude-socket.mjs`, dispatcher in the UI server) | Tried first when the session's gate is open (see [Claude messaging socket](#claude-messaging-socket)). A message it cannot deliver stays for the rows below. |
| Claude Code | `asyncRewake` hook (`hooks/hooks.json`, `lib/waiter.mjs`) | A second hook on `SessionStart`, `UserPromptSubmit` and `Stop`: `ai-collab-hook.mjs --rewake --host claude`, registered with `"asyncRewake": true`, `"timeout": 3600`, `rewakeMessage` and `rewakeSummary`. It streams the session's inbox and the project `--to--all` topic. A message that is not `fyi` is claimed (read receipt sent), printed on stderr, and the process exits 2, which wakes the idle session and shows the message. Exactly one waiter runs per session: it records its pid and /proc start tick in `<state>/<project>/sessions/<peer>/<session>.waiter.json`, and a new waiter sends SIGTERM to the old one. It runs nothing for a subagent (`agent_id` present), exits quietly after 3300 s (`AI_COLLAB_WAITER_MAX_S` overrides it) or when the Claude process is gone, and the next event re-arms it. |
| Codex | dispatcher in the UI server (`web/server/dispatch.mjs`) | For a direct message to an idle Codex session it runs `codex queue --thread <native id> --message <text> --resume`. Idle means the last hook event the registry recorded is `Stop`, `SessionStart` or `SessionEnd`. A busy session gets the message from its Stop hook. |
| OpenCode | the same dispatcher | `POST /api/session/<id>/prompt` on the OpenCode service with `{text, delivery: "queue" \| "steer", resume: true}`: `steer` for an urgent message, `queue` otherwise, in any state. The endpoint is read from `$XDG_STATE_HOME/opencode/service.json` (loopback only); a `--standalone` OpenCode has no service, so its hooks deliver. |
| Cursor | hooks only | no push path |

The dispatcher polls every 5 s, only for online Claude (with an open gate), Codex and OpenCode sessions, and only for direct messages: broadcasts and `fyi` messages stay in the inbox. After a push it marks the message seen for that session (`markDelivered`), so the session's hooks skip it. A failed push leaves the message for the hooks. `AI_COLLAB_DISPATCH=off` stops the dispatcher. Native session ids come from the registry (`lib/sessions.mjs`).

While the runner is up (its control socket answers `runnerUp()` in `runner/client.mjs`), the UI dispatcher stands down and the runner delivers instead, one durable workflow per message (see [Delivery and wake workflows](owned-sessions-contract.md#delivery-and-wake-workflows)). The dispatcher runs again once the runner is down. Both write the same inbox reservations, so a message goes out once.

### Closed sessions

A direct message to a closed session wakes it: the runner resumes the session through its adapter, sends the message as one run, and closes the session again. Broadcasts never wake a closed session.

- An owned session (started by the runner) is woken in place.
- A session the runner does not own yet is adopted: the runner creates an owned record from its registry entry (native session id, harness, cwd, model), then wakes it the same way.
- A harness with no loaded adapter records `no <harness> adapter yet` for that delivery and leaves the message for the hooks.

One paid turn covers every unseen direct message queued for the session when the turn starts; messages that arrive during a turn take one more turn. Only a message addressed to the session wakes it: a message to the peer as a whole does not. A session seen online outside the runner (the user resumed it) is not woken. A closed session not seen in the last 7 days is not adopted. At most two sessions wake per runner tick. Wakes of one session run one after another.

### Claude messaging socket

For a direct message to a Claude session, the dispatcher writes the message to the session's messaging socket and then confirms it in the transcript. A confirmed message appears as a user turn, and an urgent one lands mid-turn. The socket is used only when every check below passes; otherwise the message stays unread for the hooks and the waiter.

Checks before the write (`claudeTarget` in `lib/claude-socket.mjs`):

- The registry entry is `claude` with a `pid` and `pidStart`, and `/proc/<pid>/stat` still shows that start tick (no PID reuse).
- `<config dir>/sessions/<pid>.json` (config dir: `CLAUDE_CONFIG_DIR`, else `~/.claude`) is a regular file owned by this user, not a symlink, with the same `sessionId` and, when present, `pid`. Its `messagingSocketPath` is an absolute path to a unix socket owned by this user, not a symlink.
- Exactly one `<pid>.*.key` token file exists and is owned by this user. Zero or several key files, or a read error, leave the message for the hooks: the write never goes unauthenticated.
- The gate is open. The user's `settings.json` must set `crossSessionInbound` to `"accept"`. A project `.claude/settings.json` or `settings.local.json` in the session's cwd, and `/etc/claude-code/managed-settings.json` or any `managed-settings.d/*.json`, must not set it to anything else (`hold`, `refuse`, another value, or an unparsable file). A closed or unknown gate leaves the message for the hooks. Server-managed settings and a `--settings` flag cannot be read from disk, so a session that uses either is not covered by this check.
- The cwd is absolute and at most 200 characters, so the transcript path is known.

The write: newline-delimited JSON with an `auth` frame (the token), then a `user` frame whose content is the `<cross-session-message from-name="…">` envelope. `urgent` sets `priority: "next"` (lands after the current step); other messages use `"later"` (queued behind the current turn). The body is the text the hooks print (`formatInbox`): sender, message id, the `respond` hint and the untrusted-body warning. The socket write has a 5 s timeout.

The confirmation: the dispatcher records the transcript's size before the write, then reads only the bytes written after it (`<config dir>/projects/<cwd with non-alphanumerics as "-">/<sessionId>.jsonl`, at most the last 4 MB). Each line is parsed as JSON, and a string value must hold `<cross-session-message from-name="<sender>">` and `id=<message id> ` for every message in the batch. A quoted id outside an envelope, an earlier delivery, or another sender's name does not count. The window is 5 s (`AI_COLLAB_CLAUDE_CONFIRM_MS`, a positive number of ms).

A write that is not confirmed in the window is `unconfirmed`. The reservation stays, and the dispatcher keeps checking the same bytes until the window plus `AI_COLLAB_CLAUDE_WATCH_MS` (default 35 s) ends. A late confirmation marks the message delivered; otherwise the reservation is released and the hooks take the message. The reservation (60 s) outlives that window, so the hooks cannot take a message mid-watch. A message that Claude enqueues after the window ends can still reach the session twice, once from the socket and once from the hooks. That case is not detected.

A message whose push or confirmation fails is backed off per (session, message): the next attempt waits 5 s, then 10 s, 20 s and so on, up to 10 min, so a held message is not re-written to the socket on every tick. `fyi` messages, reserved messages and messages in backoff are skipped before the claim cap, so they do not use up the 4 messages a tick pushes.

What Claude does with a frame, from its binary (`claude.exe` 2.1.330 `strings`): a message can be held (`crossSessionInbound` is `hold`, or a managed or repo setting holds it), refused for a permission-mode mismatch (`mode-mismatch`, `no-mode-asserted`: this session bypasses prompts and the sender sends no mode attestation, so these messages are held), rate-limited ("Too many messages to this session just now"), or dropped when the queue is full. Each of these leaves no confirmed line in the transcript, so the message stays with the hooks. A message that is confirmed but later dropped from a queue is not detected.

Claude's socket protocol is undocumented. Pulsar's dist sends the same frames (`~/.local/share/pulsar/current/dist/cli-sqgan6a2.js`, `claudeEnvelope` and the `deliver` method). The transcript line format and the envelope were read from the binary, not observed in a live session.

Delivery is one owner per message: the dispatcher reserves each message under the inbox lock before the push, and every claim skips reserved ids. A claim that meets a reserved message stops before it (its cursor does not pass it), so a push that then fails leaves the message for the next claim. Reserved ids never enter the seen list. A reservation expires after 60 s if the process dies.

A socket delivery with `expect_reply` is redelivered like any other push (see below). A copy that is not confirmed is never recorded in the redelivery ledger, so the ledger does not redeliver it. A copy confirmed late by the watch is delivered but not added to the ledger, so it gets no redelivery.

### Priority

`priority` is `normal` (wakes an idle session), `urgent` (same as `urgent: true`) or `fyi` (queued; no waiter or dispatcher wakes the session for it). A hook still delivers an `fyi` message at the next hook event, including a Stop that already runs.

### Redelivery with `expect_reply`

`sendMessage(..., { expectReply: true })` (CLI `--expect-reply`, MCP `expect_reply`) marks a direct, non-`fyi` message that needs an answer. The receiver's text ends with "The sender is waiting for your reply: answer with respond message_id=...". When the dispatcher pushes it, it records the message in `<state>/<project>/dispatch.json` and redelivers it:

- after 10 min without an acknowledgement, with the text "This is attempt N of 5";
- at most 5 attempts, and no later than 24 h after the first;
- until the target acknowledges: a `respond` of any state (`working`, `reply`, `done`, `declined`) or a read receipt from that session.

Redelivery covers sessions the runner or the dispatcher serves (Claude with an open gate, Codex, OpenCode). The runner keeps a redelivering message in its delivery workflow. When the runner starts, it takes over the dispatcher's `dispatch.json` entries, so their redelivery continues. It sends no notice to the sender when it gives up. Claude's waiter and hooks deliver once.

### Interrupt

The UI action `interrupt` (POST `/api/interrupt` with `{project, target}`; an **Interrupt** button on Codex and OpenCode session pages) and `ai-collab interrupt <peer#session>` stop a running turn. OpenCode: `POST /api/session/<id>/interrupt`. Codex: `turn/interrupt` on the in-progress turn of a thread loaded in the app-server daemon (`codex app-server proxy`; `codex queue` has no interrupt). A Codex session outside the daemon reports `unsupported`. Claude and Cursor report `unsupported`. There is no MCP interrupt tool yet, because `test/mcp.test.mjs` pins the exact tool list.

## Urgent messages ("send now")

A msg envelope may carry `urgent: true` (UI **Send now**, send body field `urgent`, CLI `--urgent`, MCP `urgent`). Hooks normally read the inbox at most once per `AI_COLLAB_POLL_INTERVAL_MS` (10 s). The sender also writes a marker `$AI_COLLAB_STATE_DIR/<project>/urgent/<target>` holding the send time; `claimInbox` reads the markers for `all`, its peer and its session before the throttle and polls ntfy at once when one is newer than its last poll. The check costs up to three small file reads per hook and no network request, so it runs on every hook event; one stream subscription per hook event would cost a connection each time. The marker works only between processes that share a state directory (the UI server and agents of the same user on one machine); an urgent message from elsewhere arrives at the next unthrottled poll. Nothing interrupts a model mid-generation: delivery happens at the next hook event, its next tool call (`PostToolUse`) or its stop.

## Agents starting agents

An agent can start another harness's agent from its shell, and the two can then message each other:

1. **Parent link.** At `SessionStart`, the Claude Code hook appends `export AI_COLLAB_PARENT=claude#<label>` to `$CLAUDE_ENV_FILE`, which Claude runs before each Bash command ([persist environment variables](https://code.claude.com/docs/en/hooks#persist-environment-variables)). Cursor's agent shell exports `CURSOR_CONVERSATION_ID`, so a harness started there names `cursor#<label>` as its parent. Codex hooks cannot set its shell environment: a Codex agent prefixes the command itself, for example `AI_COLLAB_PARENT=codex#<label> claude -p "<prompt>"`; its SessionStart context gives the exact prefix.
2. **Child side.** A session started with `AI_COLLAB_PARENT` gets both addresses in its SessionStart context, records the parent in its registry entry and status envelope (the UI shows "started by …"), and sends the parent one direct message, `started: <child address> (<harness>, <folder name>)`. The child takes its harness name as its peer and never the parent's inherited `AI_COLLAB_PEER` or `AI_COLLAB_SESSION`.
3. **Messages.** `ai-collab send codex#<label> "…"` and the MCP tool `send_to_peer` reach that one session at its next hook. A headless child (`codex exec`, `claude -p`, `cursor-agent -p`) runs hooks only while its run lasts: a message sent after it ends waits until the parent resumes it with the command `ai-collab sessions` prints (`codex exec resume <id> "<prompt>"`, `claude -p --resume <id> "<prompt>"`, `cursor-agent -p --resume <id> "<prompt>"`), or the operator wakes it. In AFK mode `on`, the child's Stop hook keeps it listening for up to `AI_COLLAB_AFK_WAIT_S`.
4. **Finding agents.** `ai-collab sessions` and the MCP tool `list_sessions` list this project's sessions on this machine: address, harness, online, last active, parent, cwd, and the resume command. They read the local registry only; nothing there is published.

Tested with fake hook payloads, not with real harness runs.

## Receipts

An agent publishes a read receipt the moment a message reaches it: when a hook injects it (SessionStart, UserPromptSubmit, PostToolUse, or a Stop continuation), when `ai-collab inbox` prints it (with or without `--peek`), or when `wait_for_answer` (or the Stop hook's important-question check) returns a phone reply. One delivery is one publish to `ai-collab-<project>--receipts`, split only to stay within 4095 bytes:

```json
{"v":1,"kind":"receipt","from":"claude","session":"<16-hex label>","ids":["<ntfy message id>","…"],"state":"read","ts":"<ISO time>"}
```

Receipts are best effort: the publish runs in the background under a 1.5-second deadline, alongside activity, and a failure never blocks or changes delivery. Like the status topic, receipts carry no priority or tags and no phone subscribes to them, so they never notify. The UI loads the topic's history once and keeps it live through the shared subscription.

The operator's own messages show ticks:

| Tick | Label | Direct message | Broadcast or harness message |
|---|---|---|---|
| ✓ | Sent | ntfy accepted it | ntfy accepted it |
| ✓✓ | Read by some sessions | not used: a direct message stays ✓ until its session reads it | at least one recipient session sent a receipt |
| ✓✓ in the primary colour | Read | that session sent a receipt | every session online when the UI first saw the message sent a receipt; with none online then, the first receipt |

"Online when sent" is the set of online sessions when the UI server first saw the message, so history loaded after a UI restart, older than 30 minutes, has no such set and turns read on its first receipt.

## Claude Code channels (not used)

Claude Code [channels](https://code.claude.com/docs/en/channels-reference) let an MCP server push messages into an idle session: the server declares `capabilities.experimental["claude/channel"]` and emits `notifications/claude/channel`. This plugin does not declare it, because a custom channel needs a changed launch:

- Every session must start with `claude --dangerously-load-development-channels plugin:ai-collab@<marketplace>` (or `server:<name>`), interactively, and accept a warning dialog. `--channels` accepts only plugins on Anthropic's allowlist or an organization's `allowedChannelPlugins`; the flag is ignored with `-p` and the Agent SDK. ([Test during the research preview](https://code.claude.com/docs/en/channels-reference#test-during-the-research-preview), [Research preview](https://code.claude.com/docs/en/channels#research-preview))
- It needs claude.ai or Console authentication, and Team and Enterprise organizations must set `channelsEnabled`. ([Enterprise controls](https://code.claude.com/docs/en/channels#enterprise-controls))
- The MCP server learns the session label only from tool calls, so it cannot tell which session's inbox to stream until the agent calls a tool.
