# Agent skills

Read AGENTS.md and follow it. The skill files it names are in `skills/`.

Use TypeScript for UI SDK components in `web/`. Preserve existing styles and read the installed UI SDK docs before adding or replacing components.

Keep `web/tsconfig.json` extending the base config so Next.js leaves the checked-in config untouched when it creates a versioned build directory.

For DOT workflow verification, use the harness-free trace and durable workflow tests in [Teams and patterns](docs/teams.md#verify-a-pattern-without-launching-agents).
