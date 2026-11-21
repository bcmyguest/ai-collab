# Pulsar parity research

Pulsar 2.0.0 (github.com/yocontra/pulsar). Anchors are in the shipped bundle `~/.local/share/pulsar/current/dist/`. Claude Code claims come from strings in the 2.1.330 binary. Nothing ran against live agents; idle-wake behaviour is read from code, not observed.

## 1. Pulsar features vs AI Collab

| Pulsar feature | AI Collab today | Gap |
|---|---|---|
| `list_agents` selector: name, `*`, `key=value` ANDed (`project=`, `harness=`, `status=idle`, self-set tags), `~text`; `question` ("who edits file X") | `list_agents` lists this project's sessions with name, activity, tags (`lib/sessions.mjs` `agentDirectory`); `send` takes address, peer name, `all` | No selector grammar; no tag filter on send; no `question` lookup; no group send by tag |
| `send` priority `urgent` (mid-turn) / `normal` (wakes idle) / `fyi` (no wake) | boolean `urgent` (marker file, earlier poll, `lib/inbox.mjs:92`) | No `fyi`; "urgent" only shortens the poll, it never lands mid-turn |
| `expect_reply`; footer "waiting for your reply" | none | Missing |
| `respond` working/reply/done/declined, `retry` on declined | `RESPOND_STATES`, `respond()` (`lib/agents.mjs:61`) | No `retry`; `working` does not lease the message |
| Redelivery: 10 min ack timeout, 30 min lease, 5 attempts, 24 h TTL, "attempt 2 of 5" note, sender notice on give-up (`run-daemon-bvewb3t3.js:3032-3038`, `:3300-3330`) | read receipts only (`lib/receipts.mjs`) | No redelivery, attempt counter or dead-letter notice |
| `wait` for `message`, `reply:<id>`, `idle:<agent>` (also ends when the agent's session ends) (`mcp-0pzhrq2f.js:909`) | `wait` for next message only | Add `reply:<id>` (cheap) and `idle:<agent>` (needs an idle signal) |
| `set_identity`: activity, tags, name, model, cwd, `inbound` accept/hold/refuse; auto tags `harness`, `model`, `project`, `branch`, `worktree`, `pr` | name, activity, tags (`lib/sessions.mjs:71`) | No auto tags; no inbound policy; no inbox cap (Pulsar: 50 unread); no rate limits (60 sends/min, 6 broadcasts/min) |
| `inbox`, plus history by `query`, `message_id`, `thread_id` with receipts | `inbox` with `peek` | No history search or thread view |
| Operator tag `[human operator - <name>]`, proven by passkey (Face ID/Touch ID, 12 h browser, 7 d phone); agents cannot forge it (`cli-4r79phja.js:2`, `cli-pt72qgmp.js:241-265`) | Operator trust comes from the ntfy topic and GitHub sign-in (`docs/github-sign-in.md`); hook text marks peers untrusted | No WebAuthn (D5) |
| `pulsar interrupt` / app Stop (tmux Esc for Claude; `turn/interrupt` for Codex; OpenCode `interrupt`; pi/omp abort) | none | Missing |
| Inline delivery shown in the transcript | additionalContext only | The main gap (section 2) |

## 2. How Pulsar delivers

Pulsar does not use hooks, channels or `asyncRewake` for messages. A daemon pushes each message into the harness through a per-harness driver (`push.canPush` / `push.deliver`). `wakeOf` (`cli-pt72qgmp.js:628`) maps `fyi` to inbox-only and everything else to "wakes" when the agent has a push path. Cursor and any other MCP client have none, so messages wait in the inbox and every tool result states the unread count.

| Harness | Mechanism | Anchor | Idle / mid-turn |
|---|---|---|---|
| Claude Code | Session Unix socket from `~/.claude/sessions/<pid>.json` (`messagingSocketPath`, e.g. `/run/user/1000/cc-socks/<pid>.sock`). Pulsar writes newline JSON: `{type:"auth",token}` (token from `<pid>.<hash>.key`), then `{type:"user",message:{role:"user",content:"<cross-session-message from-name=\"X via Pulsar\">…"},priority}` | `cli-sqgan6a2.js:3317-3380`; envelope `:3251`; token `:3242` | `urgent` sends `priority:"next"`, the rest `"later"`. Claude treats it as a user message: it starts a turn when idle and queues mid-turn. The transcript shows "Another Claude session sent a message: <cross-session-message…>" (`:2867-2900` parses it back) |
| Codex | `codex queue --thread <sessionId> --message <text> --resume` | `cli-v2jyqg2w.js:1274-1295` | `codex queue --help`: "Queue a message for an existing session"; `--resume` wakes a stopped one. Codex exposes no busy/idle state, so `wait idle:` never resolves for it |
| OpenCode | `POST /api/session/<id>/prompt` on the OpenCode service, `{text, delivery: "steer"\|"queue", resume:true}` | `cli-v2jyqg2w.js:1764-1795` | `urgent` steers mid-turn; others queue; `resume` wakes an idle session. Needs the OpenCode service, not `--standalone` |
| pi / omp | In-process extension: `pi.sendMessage({customType:"pulsar", display:true}, {triggerTurn:true, deliverAs: urgent ? "steer" : "followUp"})` | `extension.js:372-379` | Same steer/followUp split |
| Cursor, Gemini | none (MCP tools only) | `cli-v2jyqg2w.js:1400` | Inbox only |

Claude details to check before relying on the socket:
- `claude --messaging-socket-path` exists, behind a server-side gate (binary log: "cross-session messaging gate off"). This machine's session has the socket.
- Settings key `crossSessionInbound` is `accept` or `hold`. `hold` queues messages for review; managed or repo settings can force `hold`. Pulsar setup writes `accept` (`cli-sqgan6a2.js:3438`).
- The protocol is undocumented (`peerProtocol: 1`) and may change between releases.

**Claude Code `asyncRewake` hooks** (binary, function `YWt`): a hook with `asyncRewake: true` runs in the background. When it exits 2, Claude calls `slr({summary, body, priority:"next", stopHookActive:true})`, which enqueues a `task-notification` (the same queue that background-task completions use) with the hook's stdout/stderr as the body. `rewakeMessage` sets the prefix and `rewakeSummary` sets the one-line terminal summary. The field is in the hook schema ("wakes the model on exit code 2"); `rewakeMessage` is marked `@internal`. By the code path it should start a turn on an idle session, as task notifications do. Limits: it fires once per hook run, so the hook must be re-armed (SessionStart, then after each wake from the next hook event); it is bound by the hook timeout; and it works only if the hook process stays alive on an ntfy stream.

## 3. Delivery per harness for AI Collab

| Harness | Idle wake | Mid-turn | Visible in transcript | Recommendation |
|---|---|---|---|---|
| Claude Code | `asyncRewake` hook (supported) or socket push | socket `priority:"next"` lands after the current step; the PostToolUse hook already catches it | `task-notification` with summary (rewake); cross-session message (socket) | Primary: asyncRewake SessionStart hook that streams ntfy and exits 2 with the formatted message, re-armed per wake. Optional: socket driver behind a flag |
| Codex | `codex queue --resume` from a daemon | same queue | user message | A watcher in the UI server calls `codex queue` for sessions whose inbox is non-empty and idle; keep the Stop hook as fallback |
| OpenCode | `/api/session/<id>/prompt` with `resume:true` | `delivery:"steer"` | user message | The plugin (`lib/opencode-plugin.mjs`) subscribes to ntfy itself and calls the same API, or the UI server does |
| Cursor | none found | hooks only | followup at stop | Keep hooks; document the limit |

Format pushed text like Pulsar (`[ai-collab] <name> (<harness>): <body>`, footer `— agent message · reply: respond m_…`) in `lib/format.mjs` (`formatInbox`), so hook, rewake and socket paths share one function.

## 4. Open decisions

1. **Claude delivery path.**
   - a) `asyncRewake` hook: no gate, ships with the plugin; costs one long-lived process per session plus re-arming.
   - b) Socket push from the UI server: real mid-turn `next`, no per-session process; costs an undocumented, gated protocol and `crossSessionInbound`.
   - c) Both: most coverage, most code.
2. **Who pushes for Codex and OpenCode.**
   - a) One dispatcher in the UI server (must be running; sees all sessions).
   - b) Per-harness watcher (no central dependency; duplicated logic).
3. **Redelivery.** a) None (today). b) Pulsar's lease model (10 min ack, 5 attempts, 24 h TTL): needs server-side state keyed by message id plus a ticker. c) Redeliver only messages flagged `expect_reply`: smaller state, covers the case that matters.
4. **Selectors and priority.** a) Keep addresses; add `fyi` and tag filters only. b) Full Pulsar grammar (`key=value`, `~text`, `question`): parity, plus a parser and a registry index. Pulsar's `fyi` means "no wake", which needs the dispatcher from D2 to honour it.
5. **Operator proof.** a) Keep topic and GitHub sign-in as the trust root. b) Add WebAuthn passkeys so only a proven operator message carries an operator tag: matches Pulsar, but adds a credential store and a phone enrolment flow. Face ID needs HTTPS on the phone.
6. **Idle signal for `wait idle:`.** a) Claude session file `status`, OpenCode `/api/session/active`, hook events elsewhere. b) Skip Codex and Cursor, as Pulsar skips Codex.
7. **Interrupt.** a) Skip. b) OpenCode API and Codex `turn/interrupt` only; Claude needs tmux Esc.
