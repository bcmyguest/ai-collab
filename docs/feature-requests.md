# Feature requests

Operator requests from chat and the terminal, newest last. Status: open, decided, building, blocked, done.

Generated from the task store by `ai-collab task render`. Change tasks with `ai-collab task`, not this file.

<!-- tasks:start -->
| Request | Priority | Status |
|---|---|---|
| Baseline UI suite: three terminal-prompt tests fail on main | P1 | blocked Fix committed as bffe82a. Expanded regression reproduces session echoes on main and passes with the fix. All 47 focused UI tests and oncebitten pass. Required isolated npm test is blocked by missing npm and denied registry access. The equivalent full node --test run hits unrelated baseline failures and stalls. |
| Cursor OpenShell run-everything: live turn under runner-owned session | P2 | building |
| PM tracked handoffs: builders start as runner-owned sessions linked to tasks (rides on team-runs/OpenShell) | P2 | blocked Implementation committed as 41a0afb. Full isolated test gate blocked by sandbox runtime failures reproduced on main, including the missing Playwright path and process-group termination failures. |
| Modern visual refresh of the whole UI | P2 | open (last; coordinator shows 2–3 design directions first; do not PM-dispatch) |
| Cursor in run-everything mode inside OpenShell | P2 | done Offline verification documented and automated in ca93a89. Live verification remains open. |
| Move off ntfy eventually, so attachments and links work | P2 | done builder builder-move-off-ntfy-eventually-so-attachments exited 1 with 1 commit(s) and set no status |
| Hosted multi-user: users reach only their own agents; agents from other users are identified as such | P2 | done builder builder-hosted-multi-user-users-reach-only-their exited 74 with 1 commit(s) and set no status |
| Owned sessions: runner service, durable workflows, AG-UI event names, four harness adapters | P2 | done All four adapters are implemented and 109 focused tests passed. Cursor and OpenCode still need authenticated live turns under the runner service account; this sandbox has neither a signed-in Cursor CLI nor a registered OpenCode service. The broader suite reported failures on unchanged main. |
| Phone model switch: switch a runner-owned Claude session's model from the phone via SDK Query.setModel (sdk.d.ts:3227) | P2 | done Implemented and committed as 7c1c903. All 45 focused tests and oncebitten passed. Required isolated npm test is blocked because npm is absent; the direct node test run reports builder, plugin-import, and process-group failures reproduced on main. After merge, run build-ui and smoke-ui on the host. |
| Team runs live in the runner and run in OpenShell, not the project folder (operator: yes) | P2 | done OpenShell DOT runs committed on main base as 85ab0eb. Oncebitten and 130 related tests pass. npm is missing in the sandbox and registry access is denied. The package test script run directly with Node reproduces the same full-suite failures on unmodified main, so the green suite requirement is blocked. |
| Code-mode workflows: inference decides, code executes — map to DOT teams, runner/DBOS, OpenShell sandbox | P2 | done Commit 38ee1e6 is rebased on main and focused tests pass. The builder lacks /dev/shm/research/code-mode.md, npm, and the OpenShell CLI. Isolated node --test reproduced the same 15 failures and hanging runner suites on main. Full-suite gate and live OpenShell policy verification remain pending. |
| Move to AG-UI end to end (official @ag-ui packages) | P2 | done AG-UI default committed as c983918; rollout tests and oncebitten passed. Full suite failed in OpenShell; process-group signals return EPERM, and builder, plugin, and runner failures reproduce on main. |
| Read state and durable history with search; ntfy as transport only (HAPI idea, clean-room) | P2 | done Committed 0d2fbf5 on main-based builder branch. oncebitten and focused UI/history tests passed. npm is absent and registry access is denied. The equivalent Node suite has failures reproduced on main and did not finish. |
| Space to switch to local: a key in the terminal takes a phone-controlled session back to local control (as HAPI does) | P2 | done Design: /dev/shm/research/hapi-steal.md §2.1. HAPI is AGPL-3.0: clean-room, copy no code. |
| A UI message to one session stays out of the project chat | P2 | done |
| Queue bar: queued messages listed with Edit/Cancel/Steer, replacing the one-way queued badge (HAPI idea, clean-room) | P2 | done builder builder-queue-bar-queued-messages-listed-with-ed exited 1 with 0 commit(s) and set no status |
| Inspect and edit teams in the UI | P2 | done builder builder-inspect-and-edit-teams-in-the-ui exited 1 with 0 commit(s) and set no status |
| Draft guard: hold a phone message while the terminal has unsent text; Send anyway row (HAPI idea, clean-room) | P2 | done |
| Operator's pending messages in project chat | P2 | done builder builder-operators-pending-messages-in-project-ch exited 1 with 0 commit(s) and set no status |
| Session view shows which agent is running now | P2 | done builder builder-session-view-shows-which-agent-is-runnin exited 1 with 0 commit(s) and set no status |
| Code mode B now: compile team.dot to a runner durable workflow; agents keep pattern advance (operator: yes) | P2 | done Implemented and committed as 0f6dd10. Focused pattern and runner tests and oncebitten pass. The required isolated suite gate is blocked: npm is absent and the equivalent node --test reproduces baseline builder, limit-alert, plugin import, and process-group failures on main. |
| cap/max_visits hit suspends the run for the operator instead of failing it (operator: yes, confirm) | P2 | done |
| Deploys break the live site: next build rewrites web/.next under the running server (missing chunks) until the restart; build to a fresh dir and switch on restart | P2 | done Committed 84cdfdc. Local webpack deploy verified old assets remain available and restart selects the new build. Required verification blocked in sandbox: mise Node 24.18.0 npm is absent, isolated node --test reports failures outside the new regression coverage, default Turbopack cannot resolve next/package.json, and smoke-ui cannot load its hard-coded host Playwright path. oncebitten passed. |
| Codex exec builders in a fresh worktree: ai-collab hooks fail (SessionStart/UserPromptSubmit/PostToolUse 'Failed'), so the session never registers or shows in the UI | P2 | done |
| PM feedback loop: each run ends with a review; lessons go to openmem (substrate approved) and the mission file | P2 | done |
| Job meters: sessions report real jobs (ai-collab job run); a running job counts as working, so 'building' claims are honest (HAPI idea, clean-room) | P2 | done Implemented in d29b890 and focused tests pass. Required isolated-HOME full suite fails on builder, limit-alert, and runner process-group tests that reproduce on main in OpenShell, and the full run timed out. |
| sandbox smoke test: claude builder adds one line | P2 | done throwaway smoke test of ai-collab builder start --harness claude; do not review or merge; branch deleted after the run |
| Code mode A: ai-collab tool-API client for programs in the OpenShell sandbox; sandbox policy replaces per-call approval (operator: yes) | P2 | done Tool API committed and targeted tests pass. Required isolated npm test cannot pass here: npm is missing, registry access is denied, and node --test reproduces existing builder and limit-alert failures on the pre-change revision. |
| Session view: hide dead sessions older than a day by default (one tap shows them), and drop sessions whose worktree is gone | P2 | done |
| Scheduler card: a skipped extra trigger (previous run still going) must not replace the last real run's status | P2 | done |
| Fetch each ntfy attachment once: UI and agents cache attachments locally instead of re-downloading (hit ntfy's daily attachment bandwidth limit) | P2 | done |
| System messages (compact request etc.) render as from operator; give them a system sender | P2 | done |
| Posts that only @harness:model-start a session still wake running agents (ui.mjs routeMentions) | P2 | done Start-only posts (only @harness:model tags) carry startOnly: claimInbox, the runner broadcast path and the UI receipts skip them. Branch fix/harness-start-wake c1f3fb0, not pushed. |
| sandbox smoke test: add one line to docs/builders.md | P2 | done throwaway smoke test of ai-collab builder start; do not review or merge; branch deleted after the run |
| PM mission file: a file the PM owns and edits (mission, goals, rules), versioned in git, read each tick | P2 | done |
| Notification settings lost after UI rebuild: alert level and/or browser push not surviving deploy | P2 | done |
| task add treats --help as a title; add help output and a remove command | P2 | done |
| #task tags: tapping a task opens a message tagged #<id>; it goes direct to the task's owner agent, else to the project chat | P2 | done |
| Sessions started from the UI live in the ai-collab-ui cgroup; a UI restart kills them (killed the Codex research session) | P2 | done |
| Builders the PM starts live in the runner's cgroup, so a runner restart (deploy) kills them; launch each as its own systemd-run --user unit | P2 | done |
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
| CI prek gate fails on main: end-of-file newlines in lib/compaction.ts, lib/teams.mjs, test/teams.test.mjs, test/teams-mentions.test.mjs | P2 | done |
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
| A child session counts as its parent's subagent | P2 | done |
| Agent questions asked in the terminal (Claude AskUserQuestion, etc.) also appear in the UI in the same multiple-choice format and can be answered there | P2 | done (merged main 2026-11-21) |
| Agent text in the activity feed | P2 | done (Claude sessions need `/reload-plugins` to load the hook) |
| Agents can read the project's public channel | P2 | done (`ai-collab history`, MCP `channel_history`) |
| Bash rows show the command and its output | P2 | done |
| Close or delete a project | P2 | done (UI merge 21a47722, deployed 2026-11-22) |
| Codex install without the plugin-hash timeout (GitHub marketplace) | P2 | done |
| Context management and slash commands from the phone: Compact, Clear/new, Model switch, any typed /cmd; context meter plus loaded files | P2 | done (compact partial for Claude/Codex; model and passthrough OpenCode only, unverified) |
| Copy T3 Code's code viewer (`@pierre/diffs`) for mobile and web | P2 | done (file edits render as diffs) |
| Cursor starts without the trust prompt | P2 | done (`--trust`) |
| Cursor-style tool groups between assistant messages in the session timeline | P2 | done |
| MCP `interrupt` tool | P2 | done |
| @mention a subagent of the current run | P2 | done |
| Merge chat and activity: one session timeline; project chat for cross-session messages, completions, questions and live status; raw activity in the session menu | P2 | done (merged main 2026-11-21) |
| Message delivery as durable workflows in the runner (reserve, push, confirm, mark/release; durable backoff) instead of UI-server state | P2 | done (runner owns delivery; UI dispatcher stands down while it runs) |
| Messages appear in the Claude terminal immediately (socket delivery, like Pulsar) | P2 | done (merged main 2026-11-21: `claude-socket.mjs`, dispatcher confirm + wait) |
| Model and worktree beside the agent id in chat | P2 | done |
| `:model` part of an @mention highlighted | P2 | done |
| Notification filter: all / questions and replies / questions only / none | P2 | done (UI merge 21a47722; sidebar alert level, deployed 2026-11-22) |
| Online/offline marker in the Subagents view | P2 | done |
| OpenCode taggable; one OpenCode instance with Qwen 3.8 Flash Next | P2 | done (peer added) |
| Operator prompts and phone replies (ask_question answers) visible in session and project chat | P2 | done (merged main 2026-11-21; coordinator confirmed) |
| Pulsar feature parity: wake idle sessions, priorities, redelivery, wait idle, tags, interrupt | P2 | done |
| Record feature requests | P2 | done this file |
| Render questions, approvals and choice cards with A2UI over AG-UI | P2 | done (A2UI v0.9.1 until @a2ui/react binds v1.0) |
| Reply button on chat messages | P2 | done |
| Reply shows a quote of the replied message; reply-to visible in composer (quote bar: sender + first line) | P2 | done (UI merge 21a47722, deployed 2026-11-22) |
| Reviews by Cursor `deepseek-v41-flash-1017` | P2 | done adopted for reviews |
| Running-subagent count; hide long-idle subagents; fix 2 shown of 4 running | P2 | done (UI merge 21a47722, deployed 2026-11-22) |
| Scheduled jobs in the left panel | P2 | done (UI merge 21a47722; detail view still building) |
| Session chat folds each turn into "Working on … · N steps" plus the final message | P2 | done |
| Session ⋯ menu in the sidebar and hamburger | P2 | done |
| Sidebar projects show running/inactive counts, not harness types | P2 | done (UI merge 21a47722, deployed 2026-11-22) |
| Tap a notification opens the right view | P2 | done (UI merge 21a47722, deployed 2026-11-22) |
| Teams as roles and interaction patterns (Hermes / coding-factory / wteam style), not just roster create — e.g. "Fix and review" with handoffs | P2 | done; operator 2026-11-21; Codex sol design; decided: each handoff is required or guidance, set per pattern |
| Teams: dynamic, stored in projects.json plus a global config; orchestrator starts and keeps members alive | P2 | done (first version) |
| Terminal-typed prompts appear in session chat | P2 | done |
| Wake closed sessions on a message (durable, DBOS-like) | P2 | done in the runner (adapters merged main 2026-11-22; live wake verification open) |
| Commit task-rendered docs/feature-requests.md when board changes (PM or hook) | P3 | done |
<!-- tasks:end -->
