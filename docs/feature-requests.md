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
| Teams as roles and interaction patterns (Hermes / coding-factory / wteam style), not just roster create — e.g. "Fix and review" with handoffs | open; operator 2026-11-21; Codex sol design; **decision:** guidance vs enforced handoffs |
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
| Wake closed sessions on a message (durable, DBOS-like) | open; owned-sessions runner |
| Owned sessions: runner service, durable workflows, AG-UI event names, four harness adapters | building (runner: broadcasts, runtime mode, approval timeout, scheduled workflows merged 2026-11-21; harness adapters next) |
| Copy T3 Code's code viewer (`@pierre/diffs`) for mobile and web | open |
| Operator prompts and phone replies (ask_question answers) visible in session and project chat | building (operator: both chats) |
| Context management and slash commands from the phone | open |
| Reviews by Cursor `deepseek-v41-flash-1017` | adopted for reviews |
| Agent questions asked in the terminal (Claude AskUserQuestion, etc.) also appear on the phone and can be answered there | open; operator 2026-11-21 |
| Record feature requests | this file |
