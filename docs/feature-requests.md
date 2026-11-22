# Feature requests

Operator requests from chat and the terminal, newest last. Status: open, decided, building, blocked, done.

Generated from the task store by `ai-collab task render`. Change tasks with `ai-collab task`, not this file.

<!-- tasks:start -->
| Request | Priority | Status |
|---|---|---|
| System messages (compact request etc.) render as from operator; give them a system sender | P2 | building |
| Posts that only @harness:model-start a session still wake running agents (ui.mjs routeMentions) | P2 | building |
| Notification settings lost after UI rebuild: alert level and/or browser push not surviving deploy | P2 | building |
| #task tags: tapping a task opens a message tagged #<id>; it goes direct to the task's owner agent, else to the project chat | P2 | building |
| Builders the PM starts live in the runner's cgroup, so a runner restart (deploy) kills them; launch each as its own systemd-run --user unit | P2 | building |
| Sessions started from the UI live in the ai-collab-ui cgroup; a UI restart kills them (killed the Codex research session) | P2 | building |
| Codex exec builders in a fresh worktree: ai-collab hooks fail (SessionStart/UserPromptSubmit/PostToolUse 'Failed'), so the session never registers or shows in the UI | P2 | open |
| Scheduler card: a skipped extra trigger (previous run still going) must not replace the last real run's status | P2 | open |
| Session view: hide dead sessions older than a day by default (one tap shows them), and drop sessions whose worktree is gone | P2 | open |
| Operator's pending messages in project chat | P2 | open |
| Session view shows which agent is running now | P2 | open |
| Inspect and edit teams in the UI | P2 | open |
| Move to AG-UI end to end (official @ag-ui packages) | P2 | open (operator yes 2026-11-22: plugin 0.11.0 everywhere, then AI_COLLAB_WIRE=agui default; coordinator starting) |
| Owned sessions: runner service, durable workflows, AG-UI event names, four harness adapters | P2 | open runner adapters on: claude, codex (2026-11-22); cursor/opencode need auth |
| Cursor in run-everything mode inside OpenShell | P2 | open OpenShell branch merged a30cd83; live verification on phone still open |
| Read state and durable history with search; ntfy as transport only (HAPI idea, clean-room) | P2 | open |
| Job meters: sessions report real jobs (ai-collab job run); a running job counts as working, so 'building' claims are honest (HAPI idea, clean-room) | P2 | open |
| Queue bar: queued messages listed with Edit/Cancel/Steer, replacing the one-way queued badge (HAPI idea, clean-room) | P2 | open |
| Draft guard: hold a phone message while the terminal has unsent text; Send anyway row (HAPI idea, clean-room) | P2 | open |
| Space to switch to local: a key in the terminal takes a phone-controlled session back to local control (as HAPI does) | P2 | open Design: /dev/shm/research/hapi-steal.md §2.1. HAPI is AGPL-3.0: clean-room, copy no code. |
| PM tracked handoffs: builders start as runner-owned sessions linked to tasks (rides on team-runs/OpenShell) | P2 | open |
| PM feedback loop: each run ends with a review; lessons go to openmem (substrate approved) and the mission file | P2 | open |
| PM mission file: a file the PM owns and edits (mission, goals, rules), versioned in git, read each tick | P2 | open |
| Code-mode workflows: inference decides, code executes — map to DOT teams, runner/DBOS, OpenShell sandbox | P2 | decided Research /dev/shm/research/code-mode.md; operator agreed 2026-11-22; split into tasks A, team-runs, B, cap-suspend |
| cap/max_visits hit suspends the run for the operator instead of failing it (operator: yes, confirm) | P2 | open |
| Code mode B now: compile team.dot to a runner durable workflow; agents keep pattern advance (operator: yes) | P2 | open |
| Team runs live in the runner and run in OpenShell, not the project folder (operator: yes) | P2 | open |
| Code mode A: ai-collab tool-API client for programs in the OpenShell sandbox; sandbox policy replaces per-call approval (operator: yes) | P2 | open |
| Hosted multi-user: users reach only their own agents; agents from other users are identified as such | P2 | open shelved by operator 2026-11-22; draft + Opus review on branch worktree-agent-ae3bb980a5eec65ea, unmerged |
| task add treats --help as a title; add help output and a remove command | P2 | open |
| A UI message to one session stays out of the project chat | P2 | decided |
| Modern visual refresh of the whole UI | P2 | open (last; coordinator shows 2–3 design directions first; do not PM-dispatch) |
| Move off ntfy eventually, so attachments and links work | P2 | open (operator 2026-11-22) |
| Phone model switch: switch a runner-owned Claude session's model from the phone via SDK Query.setModel (sdk.d.ts:3227) | P2 | open deferred by operator |
| Scheduled jobs and agents shown apart: the PM agent is not its schedule entry (operator: agent != scheduled job) | P2 | done |
| Left panel lists named agents (PM and other set_identity names); tapping one opens a direct chat, no address needed | P2 | done |
| Reply to any message: when the server can't accept a reply id, send it as text quoting the first/last bit of the original instead of failing 'Invalid reply' | P2 | done |
| Chat to design teams: a Team Author agent that writes and edits team.dot from a plain-language conversation instead of the DOT editor | P2 | done |
| Task priority P0-P3 (default P2): set via CLI/MCP, shown on cards, lists and board ordered by priority; 'decided' shown as 'Ready' (approved, waiting for a builder) | P2 | done |
| Task board glitches while scrolling large lists | P2 | done |
| Task board as its own left-sidebar entry, not a link beside SESSIONS | P2 | done |
| Compact button really compacts the session (today it only asks the agent by message) | P2 | done |
| PM run detail: each schedule run links to the PM session timeline (tool calls, messages, builders started) | P2 | done |
| Limit card: typed rate_limit_event suppressed by earlier untyped StopFailure card (lib/limit-alert.mjs:207) | P2 | done merged on main (limit-alert republish); cherry-pick empty = already present |
| Schedule run kills builders the PM started: runner SIGKILLs the whole process group on exit (runner/schedules.mjs:129) | P2 | done |
| CLI send puts unknown flags (--reply-to, --progress) into the message body; add --reply-to and reject unknown flags | P2 | done |
| Runner wake.send retries a codex thread that is closing (runner/runner.mjs:379-399) | P2 | done merged 0d2bd07 + 31cd4e3; retryable JSON-RPC refusals retried 3x, backoff capped 4s; mayHaveStarted never retried |
| CI prek gate fails on main: end-of-file newlines in lib/compaction.mjs, lib/teams.mjs, test/teams.test.mjs, test/teams-mentions.test.mjs | P2 | done |
| Operator @mention of the PM wakes its schedule at once (runner has no run-now) | P2 | done An @session tag in any chat wakes that idle session (ui.mjs routeMentions) |
| DOT prompt optional in parser but required by validatePattern (lib/dot.mjs:150-155) | P2 | done Team check reports the missing prompt with its line; parser unchanged |
| onOverage true on overageEnabled even when overageStatus rejected (lib/limits.mjs:37-38) | P2 | done branch cursor-verify-fixes (Cursor deepseek, started 16:23); do not dispatch |
| OpenCode 429 branch unreachable: status not forwarded (lib/limits.mjs:81, opencode.mjs:165) | P2 | done branch cursor-verify-fixes (Cursor deepseek, started 16:23); do not dispatch |
| Cursor limit detection drops error.code/data and exit-path text (runner/adapters/cursor.mjs:109,95) | P2 | done branch cursor-verify-fixes (Cursor deepseek, started 16:23); do not dispatch |
| Limit card: two open cards for one window when resetsAt differs (lib/limit-alert.mjs:202) | P2 | done branch cursor-verify-fixes (Cursor deepseek, started 16:23); do not dispatch |
| Fan-in hangs when another role stays live (lib/pattern-runs.mjs:354-360) | P2 | done branch cursor-verify-fixes (Cursor deepseek, started 16:23); do not dispatch |
| Live wake verification for durable delivery across harness adapters | P2 | done claude+codex+cursor pass; codex closing-window bug separate task |
| Subscription limits: phone alert with a choice card to pick the replacement model; no auto-switch | P2 | done merged 154a628, deployed; Claude limit types verified, others UNVERIFIED |
| Fallback instructions per team role (e.g. a `fallback` attribute in team.dot that agents follow on a limit) | P2 | done merged 5494323, deployed; wteam role mapping/$pairs/gates not supported |
| Teams as wteam-style DOT graphs: team.dot per team (project and global), full wteam semantics (agent, count, skill, prompt; on, kind broadcast/pair/fan-in; description, max_visits), DOT text editor with live graph | P2 | done merged 5494323, deployed; wteam role mapping/$pairs/gates not supported |
| Two near-identical bell icons: make them distinct or merge | P2 | done merged 4c444e5, deployed |
| Context info fits the phone (no cutoff at 390px) | P2 | done merged 4c444e5, deployed |
| Clear and model/provider switch tracked like compaction, phone commands for every harness | P2 | done tracking merged 706b619; phone Clear/Model commands deferred (phone model switch row) |
| Fix-and-review team: lead/reviewer uses deepseek (reviews policy) | P2 | done merged 706b619, deployed 2026-11-22 |
| Tap a scheduled job for read-only detail (schedule, next run, command/prompt, recent runs) | P2 | done merged 706b619, deployed 2026-11-22 |
| Structured task list (tasks.json) with status board, dependency graph and live links to agents | P2 | done merged 706b619, deployed 2026-11-22 |
| Compaction in all agents: compact every harness, before/after tokens per compaction, a cross-agent compaction map, one compaction event model | P2 | done merged 706b619, deployed 2026-11-22 |
| Session ⋯ menu in the sidebar and hamburger | P2 | done |
| @mention a subagent of the current run | P2 | done |
| `:model` part of an @mention highlighted | P2 | done |
| Reply button on chat messages | P2 | done |
| Online/offline marker in the Subagents view | P2 | done |
| A child session counts as its parent's subagent | P2 | done |
| Teams: dynamic, stored in projects.json plus a global config; orchestrator starts and keeps members alive | P2 | done (first version) |
| Teams as roles and interaction patterns (Hermes / coding-factory / wteam style), not just roster create — e.g. "Fix and review" with handoffs | P2 | done; operator 2026-11-21; Codex sol design; decided: each handoff is required or guidance, set per pattern |
| OpenCode taggable; one OpenCode instance with Qwen 3.8 Flash Next | P2 | done (peer added) |
| Codex install without the plugin-hash timeout (GitHub marketplace) | P2 | done |
| Agents can read the project's public channel | P2 | done (`ai-collab history`, MCP `channel_history`) |
| Model and worktree beside the agent id in chat | P2 | done |
| Cursor starts without the trust prompt | P2 | done (`--trust`) |
| Agent text in the activity feed | P2 | done (Claude sessions need `/reload-plugins` to load the hook) |
| Bash rows show the command and its output | P2 | done |
| Terminal-typed prompts appear in session chat | P2 | done |
| Session chat folds each turn into "Working on … · N steps" plus the final message | P2 | done |
| Pulsar feature parity: wake idle sessions, priorities, redelivery, wait idle, tags, interrupt | P2 | done |
| MCP `interrupt` tool | P2 | done |
| Messages appear in the Claude terminal immediately (socket delivery, like Pulsar) | P2 | done (merged main 2026-11-21: `claude-socket.mjs`, dispatcher confirm + wait) |
| Wake closed sessions on a message (durable, DBOS-like) | P2 | done in the runner (adapters merged main 2026-11-22; live wake verification open) |
| Copy T3 Code's code viewer (`@pierre/diffs`) for mobile and web | P2 | done (file edits render as diffs) |
| Operator prompts and phone replies (ask_question answers) visible in session and project chat | P2 | done (merged main 2026-11-21; coordinator confirmed) |
| Context management and slash commands from the phone: Compact, Clear/new, Model switch, any typed /cmd; context meter plus loaded files | P2 | done (compact partial for Claude/Codex; model and passthrough OpenCode only, unverified) |
| Reviews by Cursor `deepseek-v41-flash-1017` | P2 | done adopted for reviews |
| Agent questions asked in the terminal (Claude AskUserQuestion, etc.) also appear in the UI in the same multiple-choice format and can be answered there | P2 | done (merged main 2026-11-21) |
| Merge chat and activity: one session timeline; project chat for cross-session messages, completions, questions and live status; raw activity in the session menu | P2 | done (merged main 2026-11-21) |
| Render questions, approvals and choice cards with A2UI over AG-UI | P2 | done (A2UI v0.9.1 until @a2ui/react binds v1.0) |
| Message delivery as durable workflows in the runner (reserve, push, confirm, mark/release; durable backoff) instead of UI-server state | P2 | done (runner owns delivery; UI dispatcher stands down while it runs) |
| Cursor-style tool groups between assistant messages in the session timeline | P2 | done |
| Running-subagent count; hide long-idle subagents; fix 2 shown of 4 running | P2 | done (UI merge 21a47722, deployed 2026-11-22) |
| Close or delete a project | P2 | done (UI merge 21a47722, deployed 2026-11-22) |
| Sidebar projects show running/inactive counts, not harness types | P2 | done (UI merge 21a47722, deployed 2026-11-22) |
| Scheduled jobs in the left panel | P2 | done (UI merge 21a47722; detail view still building) |
| Reply shows a quote of the replied message; reply-to visible in composer (quote bar: sender + first line) | P2 | done (UI merge 21a47722, deployed 2026-11-22) |
| Tap a notification opens the right view | P2 | done (UI merge 21a47722, deployed 2026-11-22) |
| Notification filter: all / questions and replies / questions only / none | P2 | done (UI merge 21a47722; sidebar alert level, deployed 2026-11-22) |
| Record feature requests | P2 | done this file |
<!-- tasks:end -->
