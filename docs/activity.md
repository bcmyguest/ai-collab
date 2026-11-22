# Activity

Hooks publish what each harness exposes about a session's work to `ai-collab-<project>--activity`, one ntfy message per event. The operator UI shows it live. Turn it off with `AI_COLLAB_ACTIVITY=off` in the harness environment or `"activity": "off"` in the `projects.json` entry.

## What is published

User prompts, assistant text where a hook exposes it, every tool call with its input, tool results and errors, and session or turn start and end. Tool input and output can contain file contents, paths, command lines, and secrets that a tool printed. Thinking is never read: Cursor's `afterAgentThought` is not registered, and Claude's `MessageDisplay` carries message text only. Transcripts are never read. Each event is one envelope:

```json
{"v":1,"kind":"activity","from":"claude","session":"<16-hex label>","harness":"claude","ts":"<ISO time>",
 "type":"prompt|text|tool_call|tool_result|error|start|stop|compact","tool":"Bash","input":"…","output":"…","callId":"toolu_…",
 "agent":{"id":"<subagent id>","type":"Explore"}}
```

`agent` appears only on events from inside a subagent: Claude and Codex put `agent_id` and `agent_type` on every hook a subagent fires, so its tool calls stay under the parent session but carry their run. A `SubagentStop` row carries the subagent's `last_assistant_message` as `output`, capped like other text; its transcript path is never published.

`input` holds a prompt, tool input (JSON text), or the start and stop reason; `output` holds assistant text, a tool result, or an error. `callId` pairs a call with its result. For Claude's streamed text it is `<message id>#<batch>`. Control and bidi characters are stripped. Each message stays under ntfy's 4096-byte limit (at most 4095 bytes: the server answers HTTP 500 to exactly 4096; `ai-collab send` uses the same cap): an oversized field ends with `…[truncated N bytes]`. A truncated result or error is also uploaded whole (up to 1 MB) as an `output.txt` attachment; the UI links it as **Full output**.

## Where it lives

Only on your ntfy server: with `deploy/compose.yaml`, messages stay in its cache for 12 hours (`NTFY_CACHE_DURATION`) and attachments for 12 hours (`NTFY_ATTACHMENT_EXPIRY_DURATION`). The UI server keeps the newest 500 events per project in memory. Phone subscriptions never include the activity topic unless you add it.

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

Every compact row carries `compaction: {trigger?, phase, tokensBefore?, tokensAfter?, filesDropped?}` (lib/compaction.mjs). A PreCompact row takes `tokensBefore` (the context meter's last reading, lib/usage.mjs) and `filesDropped` (on-demand instruction files that the compaction drops) from the session state. `phase` is `started`, `finished` or `failed`; `trigger` is `auto` or `manual` and is absent when the harness does not report it. Sources:

| Source | Phase | Where |
|---|---|---|
| Claude `compact_boundary` system message (`pre_tokens`, `post_tokens`), `@anthropic-ai/claude-agent-sdk` sdk.d.ts:4058 | finished, with token counts | runner/adapters/claude.mjs |
| Claude `PreCompact` (sdk.d.ts:2902) | started, with `tokensBefore` and `filesDropped` | lib/activity.mjs, scripts/ai-collab-hook.mjs |
| Claude `PostCompact` (sdk.d.ts:2778), wired in hooks/hooks.json | finished | lib/activity.mjs |
| Codex `contextCompaction` item | started and finished together | runner/adapters/codex.mjs |
| OpenCode `session.compaction.started`, `.ended`, `.failed` | started, finished, failed | runner/adapters/opencode.mjs |

The compact row from a finished step reads `compacted · <trigger>`, and a failed one reads `compaction failed`. `tokensAfter` is set only by the Claude runner (`post_tokens`). Hook rows have no after-reading: the meter's first reading after a compaction is not recorded yet, so the timeline shows no after count for them.

### Clear and model switch

A `clear` row (`clear: {tokensBefore?, tokensAfter: 0}`) comes from Claude's `SessionStart` with `source: "clear"` (sdk.d.ts:7266). The hook script stamps `tokensBefore` from the meter's last reading. `tokensAfter` is 0 by definition: a clear empties the context. The text is `Cleared · 140k → 0`.

A `model` row (`modelSwitch: {from, to}`) comes from Claude's `PostModelSwitch` hook (sdk.d.ts `PostModelSwitchHookInput`: `from_model`, `to_model`, resolved ids), wired in hooks/hooks.json. The runner emits a model row for a `STEP_FINISHED` step named `model` with `metadata.aiCollab.modelSwitch`; no adapter emits one yet. Codex, OpenCode and Cursor report no clear or model event.

## Cost to the agent

Activity publishing starts before delivery and runs alongside it under one 1.5-second deadline; errors are swallowed. Claude's activity-only hooks run with `"async": true`, so Claude never waits for them. Measured on this machine against the in-process fake ntfy (median of 25 runs): an activity-only `PreToolUse` takes 49 ms with activity on versus 27 ms off (Node start-up plus one publish); hooks that also deliver messages add 2-4 ms.

## In the UI

See [Phone UI](phone-ui.md#chat-and-activity-views) for how the UI renders activity rows, subagent runs, and step counts.
