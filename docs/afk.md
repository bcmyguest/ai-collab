# AFK mode

`/afk on|off|quiet` tells every running agent in every project in `projects.json` whether the operator is at the terminal.

| Mode | Progress | Questions | At Stop |
|---|---|---|---|
| `off` (default) | none | as needed | deliver waiting messages, then stop |
| `on` (operator away) | one line per milestone via `send_to_all` with `progress: true` | phone via `ask_question`; `important: true` when blocked | after `ask_question` or `wait_for_operator` in that turn, wait up to `AI_COLLAB_AFK_WAIT_S` (10 min) for operator messages or the answer; otherwise stop at once. Hold an important question until it is answered |
| `quiet` | dropped: `send_to_all` refuses `progress: true` | blocking questions only, `important: true` | hold an important question until it is answered; no idle wait |

In mode `on` or `quiet`, permission prompts also go to the phone; see [Approvals](approvals.md#phone-approvals). In mode `off`, Claude Code and Codex prompts (`AskUserQuestion` included) show in the UI as view-only cards labelled "Answer in the terminal", while the terminal asks as usual; see [View-only cards](approvals.md#view-only-cards-afk-off).

**Why AFK sessions use `default` permission mode.** Claude Code's `auto` mode lets a classifier deny risky tool calls outright, and the operator cannot approve a denial from the phone. In `default` mode the same call becomes a permission prompt, which ai-collab sends to the phone as an approval card ([Approvals](approvals.md#phone-approvals)). Claude sessions start in `default` by default ([`claudePermissionMode`](configuration.md)); the `auto-afk` value does so only while AFK is `on`, and `inherit` leaves the user's own mode.

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

Each project's broadcast topic carries a mode record. The default writer sends:

```json
{"v":1,"kind":"mode","from":"operator","mode":"on","ts":1795243066000}
```

The highest `ts` wins. With no mode event, the mode is `off`. Agents never see it as chat. Each session records the mode when it reads its inbox, and its next hook injects a one-time note with the new rules. SessionStart fetches the last 12 hours of the broadcast topic and injects the current mode. The 12-hour window is policy: the bus keeps events for days, but a mode set more than 12 hours ago no longer describes the operator's state, so new sessions then start in `off`. `lib/mode.ts` exports `publishMode(cfgs, mode)`, `currentMode(cfg)`, and `operatorConfigs(env)` for the UI server.

A **failed** read is not `off`, which is a reading the topic itself gives when its cached history holds no envelope. `currentModeKnown(cfg)` returns `null` for a read that failed when neither the session nor the project has a recorded mode, and `lib/approvals.mjs` asks the phone rather than publishing a view-only "Answer in the terminal" card on a mode it could not read. Each successful read also writes `<state dir>/<project>/operator-mode.json`, so a session whose own read fails (a headless run, a short bus outage) uses the mode this machine read last instead of assuming the operator is present. `ai-collab afk` with no argument prints `unknown` for that case, never `off`.

The agent asks for the AFK wait: `ask_question` (any question) or the `wait_for_operator` MCP tool records a wait request for the session, and the next Stop waits. The Stop clears the request when it ends or delivers a message or answer, so each wait needs a new request.

An important question survives hook and tool timeouts: the Stop hook waits one 600-second slice for the answer, then continues the agent with an instruction to call `wait_for_answer` once and end its turn, and waits again. That costs one model turn per slice. An AFK wait longer than one slice costs one turn per extra slice; on Claude Code, raise `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` for more than 8 slices in a row.

## Coming back to the terminal

AFK stays on until you turn it off in the UI or with `afk off`; typing in a session, at the terminal or through Remote Control, does not change the mode. A session in the AFK wait is running its Stop hook, so it looks busy. Either of these ends that session's wait:

- **Esc** interrupts a running Stop hook in Claude Code, Codex, and Cursor.
- **A prompt queued in the waiting session ends its wait at once**; AFK stays on. Claude Code queues a prompt typed, or sent through Remote Control, while the hook runs and records it in the transcript as a `queue-operation` `enqueue` line; Codex appends it to `$CODEX_HOME/history.jsonl` (default `~/.codex`) with the session ID. The Stop hook checks only the lines appended since its wait began, about once a second, and ignores machine text (task notifications, agent hand-backs, `[ai-collab]`). Both formats are undocumented: a missing or unparsable file means the wait goes on as before. Cursor has no reliable signal and keeps Esc. In OpenCode, a prompt that reaches the session's `prompt` hook during the wait stops the Stop hook process (SIGTERM) and no continuation is added.

For a one-key return, run `ai-collab afk park` while using the phone. In tmux, open it over the running agent pane with this optional binding in `~/.tmux.conf`:

```tmux
bind-key a display-popup -E -d '#{pane_current_path}' 'ai-collab afk park'
```

Press the tmux prefix followed by **a** to open the popup. **Space** publishes AFK off across the same projects as `ai-collab afk off` and closes the popup, returning keyboard input to the pane. **Ctrl-C** closes the popup and leaves AFK mode as it was. Set AFK on or quiet separately from the phone or CLI.
