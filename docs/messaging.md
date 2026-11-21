# Messaging

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
scripts/ai-collab wait 30                            # block for the next message
scripts/ai-collab respond m00000042 done "merged"    # answer a message by id
scripts/ai-collab identity --activity "reviewing PR 12" --tag pr:12
scripts/ai-collab agents                             # live sessions with their identity
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

Six MCP tools follow the agent-messaging interface of the Pulsar MCP server, mapped onto ai-collab's topics, inbox cursor and session registry. The older tools ([`ask_question` and friends](approvals.md#ask-from-an-agent-reply-from-the-phone)) stay; their descriptions name the new tool they duplicate.

| Tool | Does | Built on | CLI |
|---|---|---|---|
| `list_agents` | Live sessions of the project on this machine: address, harness, project, name, activity line, tags, last active, parent. `all: true` adds offline ones. | session registry (`lib/sessions.mjs`) | `ai-collab agents [--all]` |
| `send` | To a session (`peer#label`), a peer name, or `all` / `*`. `await_reply: N` blocks up to N s (max 45) for a `reply`, `done` or `declined` answer to this message. `urgent`, `reply_to`, `attachment` optional. | `sendMessage`, the Stop hook's ntfy stream waiter | `ai-collab send <to> [msg] [--urgent] [--await N]` |
| `respond` | Answers a message id with `state` `working`, `reply`, `done` or `declined` and an optional body: an operator direct message in its chat, a broadcast on the shared channel, a peer message to its sender's session. | msg envelope with `replyTo` and `state` | `ai-collab respond <id> <state> [msg]` |
| `wait` | Blocks up to `seconds` (max 45) for a new message to this session; returns it marked read. | stream waiter + `claimInbox` | `ai-collab wait [N]` |
| `inbox` | Reads new messages and marks them delivered; publishes read receipts. `peek: true` leaves them unread. | `claimInbox`, `lib/receipts.mjs` | `ai-collab inbox [--peek]` |
| `set_identity` | Stores `name`, `activity` (one line, at most 200 characters) and `tags` (at most 10, e.g. `pr:12`, `role:reviewer`) in this session's registry entry. | session registry | `ai-collab identity [--name N] [--activity T] [--tag T]...` |

A `respond` answer is a msg envelope with `replyTo` and an optional `state` field; clients that predate it show it as an ordinary message. Tool results label each message with `answer_with`. The tools and the hooks share one inbox cursor per session, so a message read through `wait` or `inbox` is not delivered again by a hook. The 45-second cap keeps a call under Codex's default MCP tool timeout; call `wait` again to keep listening.

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
| ✓✓ | Delivered | the session was online when sent, or has been active since | at least one recipient session was online when sent, or active since |
| ✓✓ in the primary colour | Read | that session sent a receipt | every session online when the UI first saw the message sent a receipt; with none online then, the first receipt |

"Online when sent" is the set of online sessions when the UI server first saw the message, so history loaded after a UI restart, older than 30 minutes, has no such set and turns read on its first receipt.

## Claude Code channels (not used)

Claude Code [channels](https://code.claude.com/docs/en/channels-reference) let an MCP server push messages into an idle session: the server declares `capabilities.experimental["claude/channel"]` and emits `notifications/claude/channel`. This plugin does not declare it, because a custom channel needs a changed launch:

- Every session must start with `claude --dangerously-load-development-channels plugin:ai-collab@<marketplace>` (or `server:<name>`), interactively, and accept a warning dialog. `--channels` accepts only plugins on Anthropic's allowlist or an organization's `allowedChannelPlugins`; the flag is ignored with `-p` and the Agent SDK. ([Test during the research preview](https://code.claude.com/docs/en/channels-reference#test-during-the-research-preview), [Research preview](https://code.claude.com/docs/en/channels#research-preview))
- It needs claude.ai or Console authentication, and Team and Enterprise organizations must set `channelsEnabled`. ([Enterprise controls](https://code.claude.com/docs/en/channels#enterprise-controls))
- The MCP server learns the session label only from tool calls, so it cannot tell which session's inbox to stream until the agent calls a tool.
