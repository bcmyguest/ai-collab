# Approvals and questions

## Ask from an agent, reply from the phone

The MCP server (`scripts/ai-collab-mcp.mjs`, version read from `package.json`) exposes `ask_question`, `wait_for_answer`, `wait_for_operator`, `reply_to_operator`, `send_to_all`, `send_to_peer`, and `list_sessions`, plus the [agent messaging tools](messaging.md#agent-messaging-tools). `ask_question` posts to the same broadcast topic that the phone subscribes to. Use the session label from the hook context. It waits up to 25 seconds by default and returns a question ID if nobody has replied yet. The agent can call `wait_for_answer` with that ID to continue waiting in intervals of up to 45 seconds. `important: true` titles the post "Important question" and records it, so the Stop hook in [AFK mode](afk.md) `on` or `quiet` holds the session until the answer arrives.

On the phone, post `reply <question-id> <answer>` to the same broadcast topic. The waiting tool matches the ID, so concurrent questions stay independent. Keep the topic private and authorize only the intended participants. A reply is a message on a shared topic; the tool cannot verify who wrote it. Replies are read by the waiting tool and do not re-enter ordinary agent inboxes.

The UI shows each question as a card with its answer, or an answer field while it is open; **Reply from the composer** still works.

## Phone approvals

In AFK mode `on` or `quiet`, a permission prompt becomes a card in the UI and a high-priority notification on the phone. In mode `off` the hook returns at once with no decision, so the terminal prompt shows as usual.

| Harness | Hook | Phone answer | No answer |
|---|---|---|---|
| Claude Code | `PermissionRequest` (fires only when a dialog is about to show) | `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`, or `deny` with a message | `{}` |
| Claude Code `AskUserQuestion` | the same `PermissionRequest` | `allow` with `updatedInput` = the original `questions` plus `answers` (question → label; multi-select labels joined with `, `) | `{}` |
| Codex | `PermissionRequest` | `behavior` and, for deny, `message` only | `{}` |
| Cursor | `beforeShellExecution`, `beforeMCPExecution` (not registered; see [Unverified](#unverified)) | `{"permission":"allow"\|"deny", user_message, agent_message}` | `{"permission":"ask"}` |
| OpenCode 2 | permission `evaluate` with `effect: "ask"` (tool name = `action`, summary = its `resources`) | the plugin sets `effect` to `allow`, or `deny` with `message` | `effect` stays `ask`: OpenCode publishes its own prompt |

OpenCode runs `evaluate` before it shows its prompt, so while the phone wait lasts (AFK `on` or `quiet` only) the terminal shows no prompt; after `AI_COLLAB_APPROVAL_S` it shows OpenCode's own.

The hook publishes `{v:1, kind:"approval", from, session, harness, id, tool, summary, questions?, expiresAt, ts}` to the broadcast topic (titled with the session, tool, and summary; ntfy priority 4) and holds one streaming subscription. **Allow** or **Deny** in the UI posts `reply <id> allow|deny`; a choice posts `reply <id> {"<question>":"<answer>",…}`. From the ntfy app, post `reply <id> allow` (also `yes`, `ok`) or `reply <id> deny` (`no`); a single-question choice accepts a label or free text. The hook reads the first usable reply, publishes a read receipt for it, and closes the request with `{v:1, kind:"approval-end", id, reason}` (priority 1), where reason is `allowed`, `denied`, `answered`, `timeout`, `afk-off`, or `cancelled`.

The wait ends with no decision when `AI_COLLAB_APPROVAL_S` (540 s) passes, when the operator turns AFK mode off, or when the harness kills the hook. The hook never allows or denies on its own; any failure is no decision. The UI shows closed requests as "Timed out: the terminal prompt took over" or "Closed: answered in the terminal or the agent stopped".

**Trust.** Any client that can write the broadcast topic can approve, exactly as it can answer a question. Protect the topic with the ntfy token and ACLs. See [Security model](security.md).

### Unverified

Whether Claude Code shows its terminal dialog while a `PermissionRequest` hook waits, and what happens to the hook when you answer the dialog first, were not observed. Claude's docs state that `PermissionRequest` accepts `updatedInput` for `AskUserQuestion`; no live session confirmed it. Cursor's `beforeShellExecution` and `beforeMCPExecution` run before every command, and their only no-decision answer, `ask`, forces Cursor's prompt even for commands it would auto-run, so the installer does not register them; `lib/approvals.mjs` keeps the Cursor output shape for when a pass-through answer is confirmed. Codex's `request_user_input` has no hook, so its questions are unsupported.
