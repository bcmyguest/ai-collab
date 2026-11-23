# Impact of run_code reads, generated 2026-11-23

Measured from local harness logs. Periods split at the cutover instants below; every figure counts only what the logs record.

- Cutover (CLI and MCP reads both enforced): 2026-11-23T03:15:00Z
- Partial marker (MCP reads enforced, CLI reads not yet): 2026-11-23T02:30:00Z
- Window: 2026-11-16T00:00:00Z to now
- ISO weeks in America/Toronto
- Agent filter: none
- Sources: claude-transcripts, codex-sessions, opencode-db, cursor-chats, runner-journal, task-store
- Early data: the after period covers 0.3 hours (latest turn 2026-11-23T03:30:51.677Z); read its figures as a first look.

## Headline by period

| Period | Turns | MCP reads | CLI reads | run_code | run_read_code | Bypass reads | MCP refused | CLI refused | run_code failures | Calls/turn | Tokens | List $ |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| before | 24,692 | 2 | 200 | 3 | 0 | 254 | 0 | 1 | 1 | 1.20 | 1,982,469,726 | $537.86* |
| partial | 511 | 4 | 5 | 2 | 5 | 27 | 4 | 1 | 3 | 1.14 | 104,573,751 | $29.19 |
| after | 240 | 0 | 1 | 0 | 1 | 3 | 0 | 0 | 0 | 1.07 | 47,926,828 | $14.62 |

Tokens sum uncached input, cache writes, cache reads and output over turns with usage data. List $ prices only turns whose model has a published price; `*` marks a partly priced group.

## Read paths by harness, model and period

| Harness | Model | Period | Turns | Read turns | MCP | CLI | run_code | run_read_code | Bypass | MCP refused | CLI refused | run_code failures | Calls/turn |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| claude | claude-fable-5-2 | before | 167 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1.10 |
| claude | claude-haiku-5-5 | before | 3,661 | 2 | 2 | 0 | 1 | 0 | 3 | 0 | 0 | 0 | 1.19 |
| claude | claude-haiku-5-5 | partial | 38 | 10 | 4 | 2 | 2 | 4 | 0 | 4 | 1 | 3 | 0.47 |
| claude | claude-opus-5-5 | before | 7,009 | 49 | 0 | 47 | 2 | 0 | 42 | 0 | 0 | 1 | 1.08 |
| claude | claude-opus-5-5 | partial | 418 | 3 | 0 | 2 | 0 | 1 | 0 | 0 | 0 | 0 | 1.02 |
| claude | claude-opus-5-5 | after | 213 | 1 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 1.07 |
| claude | claude-sonnet-5-5 | before | 287 | 0 | 0 | 0 | 0 | 0 | 4 | 0 | 0 | 0 | 1.20 |
| claude | claude-sonnet-5-5 | after | 27 | 1 | 0 | 1 | 0 | 0 | 3 | 0 | 0 | 0 | 1.15 |
| codex | codex-auto-review | before | 52 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0.00 |
| codex | gpt-5.6-luna | before | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0.00 |
| codex | gpt-6-luna | before | 92 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0.95 |
| codex | gpt-6-sol | before | 16 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0.94 |
| codex | gpt-6.1-terra | before | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0.00 |
| codex | gpt-6.2-astra | before | 109 | 2 | 0 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0.94 |
| codex | gpt-6.2-sol | before | 678 | 11 | 0 | 11 | 0 | 0 | 0 | 0 | 0 | 0 | 0.82 |
| cursor | composer-2.5 | before | 1,340 | 0 | 0 | 111 | 0 | 0 | 136 | 0 | 1 | 0 | 2.09 |
| cursor | deepseek-v41-flash-1017-high | before | 11,180 | 0 | 0 | 29 | 0 | 0 | 69 | 0 | 0 | 0 | 1.20 |
| cursor | deepseek-v41-flash-1017-high | partial | 55 | 0 | 0 | 1 | 0 | 0 | 27 | 0 | 0 | 0 | 2.51 |
| cursor | gemini-4-carbon-medium | before | 66 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2.36 |
| cursor | gemini-4-hydrogen-low | before | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0.00 |
| cursor | gpt-5.6-sol-medium | before | 13 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1.08 |
| cursor | unknown | before | 18 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0.33 |

## Tokens per turn: turns with ai-collab reads vs without

Input counts uncached input plus cache writes; cached is cache reads. Turns without usage data (Cursor) are left out.

| Harness | Model | Period | Read turns | Input | Cached | Output | Plain turns | Input | Cached | Output |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| claude | claude-fable-5-2 | before | 0 | - | - | - | 167 | 3,647 | 84,069 | 577 |
| claude | claude-haiku-5-5 | before | 2 | 2,101 | 25,626 | 118 | 3659 | 2,903 | 158,511 | 1,045 |
| claude | claude-haiku-5-5 | partial | 10 | 3,334 | 34,652 | 277 | 28 | 4,626 | 38,559 | 240 |
| claude | claude-opus-5-5 | before | 49 | 1,244 | 222,379 | 366 | 6960 | 2,672 | 172,863 | 596 |
| claude | claude-opus-5-5 | partial | 3 | 1,572 | 183,460 | 480 | 415 | 1,808 | 244,501 | 483 |
| claude | claude-opus-5-5 | after | 1 | 867 | 609,537 | 460 | 212 | 1,269 | 211,113 | 668 |
| claude | claude-sonnet-5-5 | before | 0 | - | - | - | 287 | 3,249 | 84,102 | 766 |
| claude | claude-sonnet-5-5 | after | 1 | 4,821 | 80,600 | 8,751 | 26 | 5,077 | 71,897 | 2,080 |
| codex | codex-auto-review | before | 0 | - | - | - | 52 | 7,646 | 29,199 | 126 |
| codex | gpt-5.6-luna | before | 0 | - | - | - | 2 | 4,226 | 14,080 | 34 |
| codex | gpt-6-luna | before | 0 | - | - | - | 92 | 3,688 | 43,449 | 259 |
| codex | gpt-6-sol | before | 0 | - | - | - | 16 | 3,030 | 30,904 | 272 |
| codex | gpt-6.1-terra | before | 0 | - | - | - | 1 | 12,187 | 12,160 | 8 |
| codex | gpt-6.2-astra | before | 2 | 1,834 | 34,752 | 146 | 107 | 1,644 | 42,118 | 237 |
| codex | gpt-6.2-sol | before | 11 | 2,955 | 156,497 | 268 | 667 | 3,196 | 142,894 | 332 |

## By role and period

| Role | Period | Turns | Read calls | Refused | Bypass | run_code failures | Calls/turn | Tokens | List $ |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| pm | before | 1,394 | 101 | 1 | 145 | 0 | 2.00 | 0 | no usage data |
| builder | before | 54 | 3 | 0 | 0 | 0 | 0.91 | 4,720,552 | $1.01 |
| interactive | before | 16,181 | 97 | 0 | 97 | 1 | 1.13 | 909,791,561 | $312.63 |
| interactive | partial | 302 | 14 | 5 | 27 | 3 | 1.21 | 85,626,305 | $21.28 |
| interactive | after | 39 | 1 | 0 | 0 | 0 | 1.26 | 18,122,545 | $4.48 |
| subagent | before | 7,063 | 4 | 0 | 12 | 0 | 1.20 | 1,067,957,613 | $224.22* |
| subagent | partial | 209 | 2 | 0 | 0 | 0 | 1.03 | 18,947,446 | $7.92 |
| subagent | after | 201 | 1 | 0 | 3 | 0 | 1.04 | 29,804,283 | $10.15 |

## Tokens and list price per ISO week

| Week | Harness | Model | Turns | Input | Cache write | Cache read | Output | List $ |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 2026-W46 | claude | claude-opus-5-5 | 631 | 18,750 | 3,676,991 | 66,536,746 | 280,136 | $47.86 |
| 2026-W47 | claude | claude-fable-5-2 | 167 | 334 | 608,753 | 14,039,466 | 96,419 | $12.75 |
| 2026-W47 | claude | claude-haiku-5-5 | 3,699 | 7,524 | 10,780,308 | 581,470,197 | 3,834,626 | $37.52 |
| 2026-W47 | claude | claude-opus-5-5 | 7,009 | 22,892 | 15,965,745 | 1,294,867,269 | 4,232,024 | $449.03 |
| 2026-W47 | claude | claude-sonnet-5-5 | 314 | 632 | 1,068,614 | 26,087,306 | 282,632 | $8.11 |
| 2026-W47 | codex | codex-auto-review | 52 | 397,569 | 0 | 1,518,336 | 6,562 | unpriced |
| 2026-W47 | codex | gpt-5.6-luna | 2 | 8,451 | 0 | 28,160 | 67 | $0.00 |
| 2026-W47 | codex | gpt-6-luna | 92 | 339,267 | 0 | 3,997,312 | 23,846 | $0.09 |
| 2026-W47 | codex | gpt-6-sol | 16 | 48,485 | 0 | 494,464 | 4,354 | $0.24 |
| 2026-W47 | codex | gpt-6.1-terra | 1 | 12,187 | 0 | 12,160 | 8 | $0.01 |
| 2026-W47 | codex | gpt-6.2-astra | 109 | 179,620 | 0 | 4,576,128 | 25,641 | $4.29 |
| 2026-W47 | codex | gpt-6.2-sol | 678 | 2,164,329 | 0 | 97,031,552 | 224,443 | $21.77 |
| 2026-W47 | cursor | composer-2.5 | 1,340 | 0 | 0 | 0 | 0 | no usage data |
| 2026-W47 | cursor | deepseek-v41-flash-1017-high | 11,235 | 0 | 0 | 0 | 0 | no usage data |
| 2026-W47 | cursor | gemini-4-carbon-medium | 66 | 0 | 0 | 0 | 0 | no usage data |
| 2026-W47 | cursor | gemini-4-hydrogen-low | 1 | 0 | 0 | 0 | 0 | no usage data |
| 2026-W47 | cursor | gpt-5.6-sol-medium | 13 | 0 | 0 | 0 | 0 | no usage data |
| 2026-W47 | cursor | unknown | 18 | 0 | 0 | 0 | 0 | no usage data |

## Per-agent (top by tokens)

| Agent | Harness | Role | Models | Turns | Tokens | MCP | CLI | run_code | run_read_code | Bypass | Refused | List $ |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| claude#28d7fa484e39f900 | claude | subagent | claude-opus-5-5, claude-haiku-5-5, claude-sonnet-5-5 | 6,449 | 1,027,834,570 | 0 | 2 | 0 | 0 | 12 | 0 | $202.20 |
| claude#28d7fa484e39f900 | claude | interactive | claude-opus-5-5 | 2,917 | 662,468,746 | 0 | 34 | 0 | 0 | 33 | 0 | $201.53 |
| claude#9378d7ca84943af4 | claude | interactive | claude-opus-5-5 | 455 | 150,481,844 | 0 | 11 | 2 | 2 | 3 | 0 | $39.24 |
| codex#2464f104320bb2c8 | codex | interactive | gpt-6.2-sol | 280 | 58,171,244 | 0 | 8 | 0 | 0 | 0 | 0 | $12.95 |
| claude#52e0484afadc0bc4 | claude | interactive | claude-opus-5-5 | 402 | 55,083,634 | 0 | 0 | 0 | 0 | 0 | 0 | $44.86 |
| claude#9378d7ca84943af4 | claude | subagent | claude-opus-5-5, claude-sonnet-5-5 | 475 | 52,779,780 | 0 | 3 | 0 | 0 | 3 | 0 | $20.15 |
| claude#52e0484afadc0bc4 | claude | subagent | claude-haiku-5-5, claude-opus-5-5, claude-fable-5-2 | 330 | 24,932,423 | 0 | 0 | 0 | 0 | 0 | 0 | $16.18 |
| codex#414a3841939931d2 | codex | interactive | gpt-6.2-sol | 125 | 23,642,988 | 0 | 0 | 0 | 0 | 0 | 0 | $4.73 |
| claude#8d94139d114721de | claude | interactive | claude-opus-5-5 | 119 | 11,280,810 | 0 | 0 | 0 | 0 | 0 | 0 | $6.72 |
| claude#c082ff1baf599645 | claude | interactive | claude-opus-5-5 | 94 | 8,705,599 | 0 | 0 | 0 | 0 | 0 | 0 | $4.23 |
| codex#5ef71b5e24f8116e | codex | interactive | gpt-6.2-sol | 90 | 7,853,433 | 0 | 0 | 0 | 0 | 0 | 0 | $1.13 |
| claude#7a96bfae55ee7446 | claude | interactive | claude-opus-5-5 | 63 | 4,888,244 | 0 | 0 | 0 | 0 | 1 | 0 | $2.33 |
| codex#527de53bf137e32c | codex | builder | gpt-6.2-sol | 48 | 4,505,884 | 0 | 3 | 0 | 0 | 0 | 0 | $0.90 |
| claude#7a96bfae55ee7446 | claude | subagent | claude-haiku-5-5, claude-sonnet-5-5 | 45 | 2,879,928 | 0 | 0 | 0 | 0 | 0 | 0 | $0.44 |
| codex#d46357c8da621dea | codex | subagent | gpt-6-luna | 35 | 2,478,616 | 0 | 0 | 0 | 0 | 0 | 0 | $0.04 |

230 agents in total; the table lists the top 15. The JSONL file holds every agent.

## Runner schedule runs (wall time)

| Schedule | Period | Runs | Failed | Median | p90 | Mean |
|---|---:|---:|---:|---:|---:|---:|
| pm | before | 122 | 23 | 27.0s | 151.6s | 65.5s |
| pm | partial | 10 | 0 | 122.5s | 257.7s | 125.2s |
| pm | after | 3 | 0 | 145.1s | 499.3s | 249.0s |
| rule-steward | before | 15 | 10 | 0.0s | 2.7s | 90.7s |
| rule-steward | partial | 2 | 0 | 659.8s | 659.8s | 638.1s |
| runner-reload | before | 31 | 0 | 0.0s | 0.0s | 0.0s |
| runner-reload | partial | 9 | 0 | 0.0s | 0.0s | 0.0s |
| runner-reload | after | 4 | 0 | 0.0s | 0.0s | 0.0s |
| stakeholders | before | 6 | 0 | 0.0s | 767.8s | 128.0s |
| stakeholders | partial | 1 | 0 | 0.1s | 0.1s | 0.1s |

These are machine-wide schedule runs, not filtered by --agent.

## Task store throughput

| Period | Tasks last updated as done |
|---|---:|
| before | 131 |
| partial | 1 |
| after | 5 |

A task's last update time stands for its completion time; later edits move it.

## Method and gaps

- Turn = one model response. Claude: one per message.id + requestId, keeping the largest output count; tool_use blocks are the union over the split lines. Codex: one per response_id of token_usage_record, with tool calls attached to the next record. OpenCode: one per assistant message.
- Read paths: MCP read tools of the ai-collab server (task_list, list_agents, list_sessions, channel_history, team_status, pattern_list, pattern_status); CLI reads (`ai-collab task list|show`, `agents`, `sessions`, `history`, `peers`, `team status`, `pattern list`, `status`); run_code; run_read_code; bypass reads (read tools, cat, grep, jq and similar on ~/.local/share/ai-collab/tasks or ~/.local/state/ai-collab, builder state excluded).
- A refusal is a result containing `through run_code` (MCP isError, CLI exit 3). A run_code failure is `ok:false`, a staging error, or an error that is not a refusal. Calls from an agent that runs a CLI read inside a Codex `exec` script are matched by text.
- Roles: subagent = sidechain or child session; pm = a session a schedule named `pm` resumes (`--resume <id>` in schedules.json); builder = cwd in an ai-collab-wt-* worktree, a builder state directory or /sandbox; everything else is interactive. The builder rule also matches an interactive session that works in such a worktree.
- Agent address = harness#sha256(native session id)[0:16]. Subagents carry their parent's address.
- Prices: list prices from docs/research/api-cost-estimate-2026-11-22.md for Claude and Codex models; other models show tokens only. Pay-as-you-go list price, not what the subscription costs.
- Cursor stores tool calls but no token usage and no per-message time, so its turns date from the session's creation and a session that spans a cutover counts wholly before it. A long-lived resumed PM session therefore lands in the period it started.
- Before/after is not a controlled comparison: workload, models and sessions differ between periods, and the after period holds only the hours since the cutover.
- Cursor stores no token usage and no per-message time: turns date from session creation.
