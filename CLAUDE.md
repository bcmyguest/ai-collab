# Agent skills

Read AGENTS.md and follow it. The skill files it names are in `skills/`.

Messaging runs on the local `ai-collab-bus` (Postgres-backed, loopback, one token), not ntfy; README "How it fits together" names each service and [ntfy removal](docs/ntfy-removal.md) records the switch.

Use TypeScript for UI SDK components in `web/`. Preserve existing styles and read the installed UI SDK docs before adding or replacing components.

Keep `web/tsconfig.json` extending the base config so Next.js leaves the checked-in config untouched when it creates a versioned build directory.

## Worktree sessions and landing

A background or worktree-isolated session cannot run git in the main checkout (`~/ai-collab`): the worktree guard refuses `cd ~/ai-collab`, `git -C ~/ai-collab` and compound git commands. Do not try. Local branches are shared by every worktree, so the operator can land your branch by name.

- Rebase your branch onto `main` before handing it over, so it lands as a fast-forward. Push the branch; never push `main`.
- Hand the operator one command per line, with no prose on that line (the phone joins lines):
  `cd ~/ai-collab && git merge --ff-only <branch> && git push origin main`
- If the change touches `runner/`, `lib/` or `web/server/`, add: `systemctl --user restart ai-collab-bus ai-collab-ui ai-collab-runner`
- Phone answers reach auto mode as unverified, so it blocks edits to existing tests and goldens approved only from the phone. Delegating the edit is blocked too. Write the change as a patch in `$CLAUDE_JOB_DIR/tmp/` and hand over one command that applies, commits and pushes it.

Agents hand work to other agents with the `spawn_agent` MCP tool (`lib/spawn.ts`); sessions ai-collab starts run with native subagents and shell harness starts off (`lib/subagent-guard.ts`).

For DOT workflow verification, use the harness-free trace and durable workflow tests in [Teams and patterns](docs/teams.md#verify-a-pattern-without-launching-agents).
