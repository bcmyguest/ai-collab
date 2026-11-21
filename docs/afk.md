# AFK mode

`/afk on|off|quiet` tells every running agent in every project in `projects.json` whether the operator is at the terminal.

| Mode | Progress | Questions | At Stop |
|---|---|---|---|
| `off` (default) | none | as needed | deliver waiting messages, then stop |
| `on` (operator away) | one line per milestone via `send_to_all` with `progress: true` | phone via `ask_question`; `important: true` when blocked | after `ask_question` or `wait_for_operator` in that turn, wait up to `AI_COLLAB_AFK_WAIT_S` (10 min) for operator messages or the answer; otherwise stop at once. Hold an important question until it is answered |
| `quiet` | dropped: `send_to_all` refuses `progress: true` | blocking questions only, `important: true` | hold an important question until it is answered; no idle wait |

In mode `on` or `quiet`, permission prompts also go to the phone; see [Approvals](approvals.md#phone-approvals).

## Entry points

| Harness | Command | Mechanism |
|---|---|---|
| Shell | `scripts/ai-collab afk on\|off\|quiet` (no argument: show the mode) | CLI |
| Claude Code | `/afk on` (or `/ai-collab:afk on`) | Plugin command `commands/afk.md` ([plugin commands](https://code.claude.com/docs/en/plugins-reference#standard-layout)) |
| Cursor | `/afk on` | Plugin command `commands/afk.md` ([commands format](https://cursor.com/docs/reference/plugins)) |
| Codex | `$ai-collab afk on` | Codex plugins carry skills, MCP servers, apps, and hooks but no commands, so the `ai-collab` skill covers it ([build plugins](https://developers.openai.com/codex/plugins/build)) |
| OpenCode 2 | ask the agent to set AFK on | the installer adds `skills/` to `opencode.json` `skills`, so the `ai-collab` skill covers it |
| Phone UI | the **AFK** switch in the header | publishes to every project; see [Phone UI](phone-ui.md) |

## How the mode travels

The mode travels as an envelope on each project's broadcast topic:

```json
{"v":1,"kind":"mode","from":"operator","mode":"on","ts":1795243066000}
```

The highest `ts` wins; no envelope means `off`. Agents never see it as chat. Each session records the mode when it reads its inbox, and its next hook injects a one-time note with the new rules. SessionStart fetches the last 12 hours of the broadcast topic (the ntfy cache duration) and injects the current mode. A mode set more than 12 hours ago is gone from the cache; new sessions then start in `off`. `lib/mode.mjs` exports `publishMode(cfgs, mode)`, `currentMode(cfg)`, and `operatorConfigs(env)` for the UI server.

The agent asks for the AFK wait: `ask_question` (any question) or the `wait_for_operator` MCP tool records a wait request for the session, and the next Stop waits. The Stop clears the request when it ends or delivers a message or answer, so each wait needs a new request.

An important question survives hook and tool timeouts: the Stop hook waits one 600-second slice for the answer, then continues the agent with an instruction to call `wait_for_answer` once and end its turn, and waits again. That costs one model turn per slice. An AFK wait longer than one slice costs one turn per extra slice; on Claude Code, raise `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` for more than 8 slices in a row.

## Coming back to the terminal

AFK stays on until you turn it off in the UI or with `afk off`; typing in a session, at the terminal or through Remote Control, does not change the mode. A session in the AFK wait is running its Stop hook, so it looks busy. Either of these ends that session's wait:

- **Esc** interrupts a running Stop hook in Claude Code, Codex, and Cursor.
- **A prompt queued in the waiting session ends its wait at once**; AFK stays on. Claude Code queues a prompt typed, or sent through Remote Control, while the hook runs and records it in the transcript as a `queue-operation` `enqueue` line; Codex appends it to `$CODEX_HOME/history.jsonl` (default `~/.codex`) with the session ID. The Stop hook checks only the lines appended since its wait began, about once a second, and ignores machine text (task notifications, agent hand-backs, `[ai-collab]`). Both formats are undocumented: a missing or unparsable file means the wait goes on as before. Cursor has no reliable signal and keeps Esc. In OpenCode, a prompt that reaches the session's `prompt` hook during the wait stops the Stop hook process (SIGTERM) and no continuation is added.
