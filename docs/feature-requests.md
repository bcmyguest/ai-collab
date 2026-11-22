# Feature requests

Operator requests from chat and the terminal, newest last. Status: open, decided, building, blocked, done.

Generated from the task store by `ai-collab task render`. Change tasks with `ai-collab task`, not this file.

<!-- tasks:start -->
| Request | Status |
|---|---|
| Session ⋯ menu in the sidebar and hamburger | done |
| @mention a subagent of the current run | done |
| `:model` part of an @mention highlighted | done |
| Reply button on chat messages | done |
| Online/offline marker in the Subagents view | done |
| A child session counts as its parent's subagent | done |
| Teams: dynamic, stored in projects.json plus a global config; orchestrator starts and keeps members alive | done (first version) |
| Teams as roles and interaction patterns (Hermes / coding-factory / wteam style), not just roster create — e.g. "Fix and review" with handoffs | done; operator 2026-11-21; Codex sol design; decided: each handoff is required or guidance, set per pattern |
| OpenCode taggable; one OpenCode instance with Qwen 3.8 Flash Next | done (peer added) |
| Codex install without the plugin-hash timeout (GitHub marketplace) | done |
| Agents can read the project's public channel | done (`ai-collab history`, MCP `channel_history`) |
| Model and worktree beside the agent id in chat | done |
| Cursor starts without the trust prompt | done (`--trust`) |
| Cursor in run-everything mode inside OpenShell | building (operator yes 2026-11-22; OpenShell, no limits for now; coordinator starting) |
| Agent text in the activity feed | done (Claude sessions need `/reload-plugins` to load the hook) |
| Bash rows show the command and its output | done |
| Terminal-typed prompts appear in session chat | done |
| Session chat folds each turn into "Working on … · N steps" plus the final message | done |
| Pulsar feature parity: wake idle sessions, priorities, redelivery, wait idle, tags, interrupt | done |
| MCP `interrupt` tool | done |
| Messages appear in the Claude terminal immediately (socket delivery, like Pulsar) | done (merged main 2026-11-21: `claude-socket.mjs`, dispatcher confirm + wait) |
| Wake closed sessions on a message (durable, DBOS-like) | done in the runner (adapters merged main 2026-11-22; live wake verification open) |
| Live wake verification for durable delivery across harness adapters | done claude+codex+cursor pass; codex closing-window bug separate task |
| Owned sessions: runner service, durable workflows, AG-UI event names, four harness adapters | building runner adapters on: claude, codex (2026-11-22); cursor/opencode need auth |
| Copy T3 Code's code viewer (`@pierre/diffs`) for mobile and web | done (file edits render as diffs) |
| Operator prompts and phone replies (ask_question answers) visible in session and project chat | done (merged main 2026-11-21; coordinator confirmed) |
| Context management and slash commands from the phone: Compact, Clear/new, Model switch, any typed /cmd; context meter plus loaded files | done (compact partial for Claude/Codex; model and passthrough OpenCode only, unverified) |
| Reviews by Cursor `deepseek-v41-flash-1017` | done adopted for reviews |
| Agent questions asked in the terminal (Claude AskUserQuestion, etc.) also appear in the UI in the same multiple-choice format and can be answered there | done (merged main 2026-11-21) |
| Merge chat and activity: one session timeline; project chat for cross-session messages, completions, questions and live status; raw activity in the session menu | done (merged main 2026-11-21) |
| A UI message to one session stays out of the project chat | decided |
| Move to AG-UI end to end (official @ag-ui packages) | building (operator yes 2026-11-22: plugin 0.11.0 everywhere, then AI_COLLAB_WIRE=agui default; coordinator starting) |
| Render questions, approvals and choice cards with A2UI over AG-UI | done (A2UI v0.9.1 until @a2ui/react binds v1.0) |
| Message delivery as durable workflows in the runner (reserve, push, confirm, mark/release; durable backoff) instead of UI-server state | done (runner owns delivery; UI dispatcher stands down while it runs) |
| Cursor-style tool groups between assistant messages in the session timeline | done |
| Modern visual refresh of the whole UI | open (last; coordinator shows 2–3 design directions first; do not PM-dispatch) |
| Teams as wteam-style DOT graphs: team.dot per team (project and global), full wteam semantics (agent, count, skill, prompt; on, kind broadcast/pair/fan-in; description, max_visits), DOT text editor with live graph | done merged 5494323, deployed; wteam role mapping/$pairs/gates not supported |
| Inspect and edit teams in the UI | building |
| Compaction in all agents: compact every harness, before/after tokens per compaction, a cross-agent compaction map, one compaction event model | done merged 706b619, deployed 2026-11-22 |
| Structured task list (tasks.json) with status board, dependency graph and live links to agents | done merged 706b619, deployed 2026-11-22 |
| Clear and model/provider switch tracked like compaction, phone commands for every harness | done tracking merged 706b619; phone Clear/Model commands deferred (phone model switch row) |
| Running-subagent count; hide long-idle subagents; fix 2 shown of 4 running | done (UI merge 21a47722, deployed 2026-11-22) |
| Session view shows which agent is running now | building |
| Close or delete a project | done (UI merge 21a47722, deployed 2026-11-22) |
| Operator's pending messages in project chat | building |
| Sidebar projects show running/inactive counts, not harness types | done (UI merge 21a47722, deployed 2026-11-22) |
| Subscription limits: phone alert with a choice card to pick the replacement model; no auto-switch | done merged 154a628, deployed; Claude limit types verified, others UNVERIFIED |
| Fallback instructions per team role (e.g. a `fallback` attribute in team.dot that agents follow on a limit) | done merged 5494323, deployed; wteam role mapping/$pairs/gates not supported |
| Move off ntfy eventually, so attachments and links work | open (operator 2026-11-22) |
| Scheduled jobs in the left panel | done (UI merge 21a47722; detail view still building) |
| Tap a scheduled job for read-only detail (schedule, next run, command/prompt, recent runs) | done merged 706b619, deployed 2026-11-22 |
| Reply shows a quote of the replied message; reply-to visible in composer (quote bar: sender + first line) | done (UI merge 21a47722, deployed 2026-11-22) |
| Tap a notification opens the right view | done (UI merge 21a47722, deployed 2026-11-22) |
| Notification filter: all / questions and replies / questions only / none | done (UI merge 21a47722; sidebar alert level, deployed 2026-11-22) |
| Fix-and-review team: lead/reviewer uses deepseek (reviews policy) | done merged 706b619, deployed 2026-11-22 |
| Hosted multi-user: users reach only their own agents; agents from other users are identified as such | open shelved by operator 2026-11-22; draft + Opus review on branch worktree-agent-ae3bb980a5eec65ea, unmerged |
| Record feature requests | done this file |
| Phone model switch: switch a runner-owned Claude session's model from the phone via SDK Query.setModel (sdk.d.ts:3227) | open deferred by operator |
| Context info fits the phone (no cutoff at 390px) | done merged 4c444e5, deployed |
| Two near-identical bell icons: make them distinct or merge | done merged 4c444e5, deployed |
| task add treats --help as a title; add help output and a remove command | open |
| Runner wake.send retries a codex thread that is closing (runner/runner.mjs:379-399) | done merged 0d2bd07 + 31cd4e3; retryable JSON-RPC refusals retried 3x, backoff capped 4s; mayHaveStarted never retried |
| Limit card: typed rate_limit_event suppressed by earlier untyped StopFailure card (lib/limit-alert.mjs:207) | building Fix needs test/limit-alert.test.mjs:135-136 changed (upgrade republishes the card) or a state-only upgrade |
| Fan-in hangs when another role stays live (lib/pattern-runs.mjs:354-360) | done branch cursor-verify-fixes (Cursor deepseek, started 16:23); do not dispatch |
| Limit card: two open cards for one window when resetsAt differs (lib/limit-alert.mjs:202) | done branch cursor-verify-fixes (Cursor deepseek, started 16:23); do not dispatch |
| Cursor limit detection drops error.code/data and exit-path text (runner/adapters/cursor.mjs:109,95) | done branch cursor-verify-fixes (Cursor deepseek, started 16:23); do not dispatch |
| OpenCode 429 branch unreachable: status not forwarded (lib/limits.mjs:81, opencode.mjs:165) | done branch cursor-verify-fixes (Cursor deepseek, started 16:23); do not dispatch |
| onOverage true on overageEnabled even when overageStatus rejected (lib/limits.mjs:37-38) | done branch cursor-verify-fixes (Cursor deepseek, started 16:23); do not dispatch |
| DOT prompt optional in parser but required by validatePattern (lib/dot.mjs:150-155) | done Team check reports the missing prompt with its line; parser unchanged |
| System messages (compact request etc.) render as from operator; give them a system sender | open |
| Posts that only @harness:model-start a session still wake running agents (ui.mjs routeMentions) | open |
| Operator @mention of the PM wakes its schedule at once (runner has no run-now) | done An @session tag in any chat wakes that idle session (ui.mjs routeMentions) |
| Code-mode workflows: inference decides, code executes — map to DOT teams, runner/DBOS, OpenShell sandbox | decided Research /dev/shm/research/code-mode.md; operator agreed 2026-11-22; split into tasks A, team-runs, B, cap-suspend |
| CI prek gate fails on main: end-of-file newlines in lib/compaction.mjs, lib/teams.mjs, test/teams.test.mjs, test/teams-mentions.test.mjs | done |
| Chat to design teams: a Team Author agent that writes and edits team.dot from a plain-language conversation instead of the DOT editor | building |
| CLI send puts unknown flags (--reply-to, --progress) into the message body; add --reply-to and reject unknown flags | done |
| Code mode A: ai-collab tool-API client for programs in the OpenShell sandbox; sandbox policy replaces per-call approval (operator: yes) | open |
| Team runs live in the runner and run in OpenShell, not the project folder (operator: yes) | open |
| Code mode B now: compile team.dot to a runner durable workflow; agents keep pattern advance (operator: yes) | open |
| cap/max_visits hit suspends the run for the operator instead of failing it (operator: yes, confirm) | open |
| Notification settings lost after UI rebuild: alert level and/or browser push not surviving deploy | open |
| PM run detail: each schedule run links to the PM session timeline (tool calls, messages, builders started) | open |
| PM mission file: a file the PM owns and edits (mission, goals, rules), versioned in git, read each tick | open |
| PM feedback loop: each run ends with a review; lessons go to openmem (substrate approved) and the mission file | open |
| PM tracked handoffs: builders start as runner-owned sessions linked to tasks (rides on team-runs/OpenShell) | open |
| Compact button really compacts the session (today it only asks the agent by message) | open |
| Task board as its own left-sidebar entry, not a link beside SESSIONS | open |
| Task board glitches while scrolling large lists | open |
| #task tags: tapping a task opens a message tagged #<id>; it goes direct to the task's owner agent, else to the project chat | open |
| Left panel lists named agents (PM and other set_identity names); tapping one opens a direct chat, no address needed | open |
| Scheduled jobs and agents shown apart: the PM agent is not its schedule entry (operator: agent != scheduled job) | open |
| Schedule run kills builders the PM started: runner SIGKILLs the whole process group on exit (runner/schedules.mjs:129) | open |
<!-- tasks:end -->
