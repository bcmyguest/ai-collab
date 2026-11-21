---
name: afk
description: Set the AI Collab operator AFK mode (on, off, quiet) for every running agent in every project.
argument-hint: on|off|quiet
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Set the operator AFK mode to `$ARGUMENTS`.

1. Accept only `on`, `off`, or `quiet` (no argument: show the current mode). Stop and ask for anything else.
2. Run exactly one command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/ai-collab.mjs" afk $ARGUMENTS`.
   If `${CLAUDE_PLUGIN_ROOT}` was not replaced with a path, run `scripts/ai-collab afk $ARGUMENTS` from the ai-collab plugin directory (Cursor: `${CURSOR_PLUGIN_ROOT}`).
3. Report the command's output in one line. Do not message any agent.

Modes: `on` means the operator is away: agents post milestone progress, ask on the phone, and wait at Stop for operator messages.
`off` means the operator is present (the default). `quiet` means only context alerts and blocking questions.
