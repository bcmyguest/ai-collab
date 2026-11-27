# Activity

Hooks publish what each harness exposes about a session's work to `ai-collab-<project>--activity`, one bus message per event. The operator UI shows it live. Turn it off with `AI_COLLAB_ACTIVITY=off` in the harness environment or `"activity": "off"` in the `projects.json` entry.

## What is published

User prompts, assistant text where a hook exposes it, every tool call with its input, tool results and errors, and session or turn start and end. Tool input and output can contain file contents, paths, command lines, and secrets that a tool printed. Thinking is never read: Cursor's `afterAgentThought` is not registered, and Claude's `MessageDisplay` carries message text only. Transcripts are never read. Each event is one envelope:

```json
{"v":1,"kind":"activity","from":"claude","session":"<16-hex label>","harness":"claude","ts":"<ISO time>",
 "type":"prompt|text|tool_call|tool_result|error|start|stop|compact","tool":"Bash","input":"…","output":"…","callId":"toolu_…",
 "agent":{"id":"<subagent id>","type":"Explore"}}
```

`agent` appears only on events from inside a subagent: Claude and Codex put `agent_id` and `agent_type` on every hook a subagent fires, so its tool calls stay under the parent session but carry their run. A `SubagentStop` row carries the subagent's `last_assistant_message` as `output`, capped like other text; its transcript path is never published.

`input` holds a prompt, tool input (JSON text), or the start and stop reason; `output` holds assistant text, a tool result, or an error. `callId` pairs a call with its result. For Claude's streamed text it is `<message id>#<batch>`. Control and bidi characters are stripped. Each message stays under the 4095-byte wire cap (`ai-collab send` uses the same cap, so an operator-run ntfy server stays happy): an oversized field ends with `…[truncated N bytes]`. A truncated result or error is also uploaded whole (up to 1 MB) as an `output.txt` attachment; the UI links it as **Full output**.

## Where it lives

The bus keeps messages and attachments for 7 days by default (`AI_COLLAB_BUS_RETENTION_HOURS`); an operator-run ntfy server keeps its own cache window. The UI server keeps the newest 500 events per project in memory. Phone subscriptions never include the activity topic unless you add it.

## Per harness

| Event | Claude Code | Codex | Cursor | OpenCode 2 |
|---|---|---|---|---|
| Prompt | `UserPromptSubmit` | `UserPromptSubmit` | `beforeSubmitPrompt` | session `prompt` hook `prompt.text` |
| Assistant text | `MessageDisplay` (streamed batches) | `Stop` `last_assistant_message` (final message only) | `afterAgentResponse` | `session.text.ended` event `text` (one row per text part) |
| Tool call | `PreToolUse` | `PreToolUse` | `postToolUse` (sent with the result) | tool `execute.before` (`tool`, `input`, `id`) |
| Tool result | `PostToolUse` `tool_response` | `PostToolUse` `tool_response` | `postToolUse` `tool_output` | tool `execute.after` `result.output` (else its text parts) |
| Error | `PostToolUseFailure`, `StopFailure` | none (no failure hook) | `postToolUseFailure` | `execute.after` with `status: "error"` |
| Start / stop | `SessionStart`, `Stop`, `SessionEnd` | `SessionStart`, `Stop`, `SessionEnd` | `sessionStart`, `stop`, `sessionEnd` | first `prompt`, `experimental.idle`, `session.deleted` |
| Notification | `Notification` (as text) | none | none | none |
| Subagent | `SubagentStart`, `SubagentStop`; `agent_id` on its hooks | `SubagentStart`, `SubagentStop`; `agent_id` on its hooks (schemas in the Codex 0.171 binary) | unsupported: `subagentStart` and `subagentStop` exist (cursor-agent 2026.11.19), but its tool hooks carry only an unverified `parent_tool_call_id`, and which conversation a subagent's hooks report is unclear | a child session (`parentID` set, e.g. the task tool): its first `prompt` is `SubagentStart`, its `experimental.idle` is `SubagentStop`; its hooks carry `agent_id` = the child session id and `agent_type` = its agent, under the root session |
| Compaction | `PreCompact` (`trigger`, short `custom_instructions`) | `PreCompact` (`trigger`) | `preCompact` (`trigger`) | `session.compaction.started` (`reason` as `trigger`) |

### Compaction

Every compact row carries `compaction: {trigger?, phase, tokensBefore?, tokensAfter?, filesDropped?}` (lib/compaction.ts). A PreCompact row takes `tokensBefore` (the context meter's last reading, lib/usage.ts) and `filesDropped` (on-demand instruction files that the compaction drops) from the session state. `phase` is `started`, `finished` or `failed`; `trigger` is `auto` or `manual` and is absent when the harness does not report it. Sources:

| Source | Phase | Where |
|---|---|---|
| Claude `compact_boundary` system message (`pre_tokens`, `post_tokens`), `@anthropic-ai/claude-agent-sdk` sdk.d.ts:4058 | finished, with token counts | runner/adapters/claude.ts |
| Claude `PreCompact` (sdk.d.ts:2902) | started, with `tokensBefore` and `filesDropped` | lib/activity.mjs, scripts/ai-collab-hook.mjs |
| Claude `PostCompact` (sdk.d.ts:2778), wired in hooks/hooks.json | finished | lib/activity.mjs |
| Codex `contextCompaction` item | started and finished together | runner/adapters/codex.ts |
| OpenCode `session.compaction.started`, `.ended`, `.failed` | started, finished, failed | runner/adapters/opencode.ts |

The compact row from a finished step reads `compacted · <trigger>`, and a failed one reads `compaction failed`. `tokensAfter` is set only by the Claude runner (`post_tokens`). Hook rows have no after-reading: the meter's first reading after a compaction is not recorded yet, so the timeline shows no after count for them.

### Clear and model switch

A `clear` row (`clear: {tokensBefore?, tokensAfter: 0}`) comes from Claude's `SessionStart` with `source: "clear"` (sdk.d.ts:7266). The hook script stamps `tokensBefore` from the meter's last reading. `tokensAfter` is 0 by definition: a clear empties the context. The text is `Cleared · 140k → 0`.

A `model` row (`modelSwitch: {from, to}`) comes from Claude's `PostModelSwitch` hook (sdk.d.ts `PostModelSwitchHookInput`: `from_model`, `to_model`, resolved ids), wired in hooks/hooks.json. The runner emits a model row for a `STEP_FINISHED` step named `model` with `metadata.aiCollab.modelSwitch`; no adapter emits one yet. Codex, OpenCode and Cursor report no clear or model event.

## Cost to the agent

Activity publishing starts before delivery and runs alongside it under one 1.5-second deadline; errors are swallowed. Claude's activity-only hooks run with `"async": true`, so Claude never waits for them. Measured on this machine against the in-process bus (median of 25 runs): an activity-only `PreToolUse` takes 49 ms with activity on versus 27 ms off (Node start-up plus one publish); hooks that also deliver messages add 2-4 ms.

## In the UI

See [Phone UI](phone-ui.md#chat-and-activity-views) for how the UI renders activity rows, subagent runs, and step counts.

## Running jobs

Wrap a foreground build, test, or other command in `ai-collab job run -- <command> [args...]` to report it as active work for your session. Use the session's usual project configuration and set `AI_COLLAB_PEER` and `AI_COLLAB_SESSION` to the two parts of its registered address. For example, replace the label below with yours.

```sh
AI_COLLAB_PEER=codex AI_COLLAB_SESSION=0123456789abcdef ai-collab job run -- npm test
```

The wrapper inherits the terminal streams and returns the command's exit status. It tracks the foreground command for as long as that process runs. If the command launches background work, have it wait for that work before exiting.

Job counts are local to the machine that runs the wrapper. A running job keeps `wait idle:<address>` waiting and counts as working on the session card. Building task cards show the owner's running job count when the owner reports jobs. The count covers the whole session. Job reporting leaves the task's stored status under the task owner's control.
