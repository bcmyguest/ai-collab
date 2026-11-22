# Feature requests

Operator requests from chat and the terminal, newest last. Status: done (merged and deployed), building, open.

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
| Cursor in run-everything mode inside OpenShell | open (needs OpenShell sandbox) |
| Agent text in the activity feed | done (Claude sessions need `/reload-plugins` to load the hook) |
| Bash rows show the command and its output | done |
| Terminal-typed prompts appear in session chat | done |
| Session chat folds each turn into "Working on … · N steps" plus the final message | done |
| Pulsar feature parity: wake idle sessions, priorities, redelivery, wait idle, tags, interrupt | done |
| MCP `interrupt` tool | done |
| Messages appear in the Claude terminal immediately (socket delivery, like Pulsar) | done (merged main 2026-11-21: `claude-socket.mjs`, dispatcher confirm + wait) |
| Wake closed sessions on a message (durable, DBOS-like) | done in the runner; real wakes wait on harness adapters |
| Owned sessions: runner service, durable workflows, AG-UI event names, four harness adapters | building (runner: broadcasts, runtime mode, approval timeout, scheduled workflows merged 2026-11-21; harness adapters next) |
| Copy T3 Code's code viewer (`@pierre/diffs`) for mobile and web | done (file edits render as diffs) |
| Operator prompts and phone replies (ask_question answers) visible in session and project chat | done (merged main 2026-11-21; coordinator confirmed) |
| Context management and slash commands from the phone: Compact, Clear/new, Model switch, any typed /cmd; context meter plus loaded files | done (compact partial for Claude/Codex; model and passthrough OpenCode only, unverified) |
| Reviews by Cursor `deepseek-v41-flash-1017` | adopted for reviews |
| Agent questions asked in the terminal (Claude AskUserQuestion, etc.) also appear in the UI in the same multiple-choice format and can be answered there | done (merged main 2026-11-21) |
| Merge chat and activity: one session timeline; project chat for cross-session messages, completions, questions and live status; raw activity in the session menu | done (merged main 2026-11-21) |
| A UI message to one session stays out of the project chat | decided |
| Move to AG-UI end to end (official @ag-ui packages) | done; ntfy wire switch AI_COLLAB_WIRE=agui pending plugin rollout |
| Render questions, approvals and choice cards with A2UI over AG-UI | done (A2UI v0.9.1 until @a2ui/react binds v1.0) |
| Message delivery as durable workflows in the runner (reserve, push, confirm, mark/release; durable backoff) instead of UI-server state | done (runner owns delivery; UI dispatcher stands down while it runs) |
| Record feature requests | this file |
