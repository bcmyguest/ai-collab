# Install

[Quick start](quick-start.md) installs everything with one command. This page covers each harness by hand.

Requirements: Node 24+ and Docker. The bus stores its events in Postgres: run `ai-collab postgres up` before starting `ai-collab-bus` ([Bus store](configuration.md#bus-store)). Run `npm ci && npm run build && npm test` in the checkout. The UI uses shadcn/ui, Tailwind CSS, and the prompt-kit chat components with React, built by Next.js into a fresh directory under `web/.next-builds/`. Tests run the real bus server on an in-memory store and need no network or API access.

Each harness also needs a server to talk to: write `defaults.json` or `projects.json` first (see [Configuration](configuration.md)).

## Claude Code

`setup` copies only the package files (`package.json` `files`, at most 50 MB; `lib/plugin-copy.mjs`) to `~/.local/share/ai-collab/claude-plugin` and adds that folder as the marketplace. Never add the checkout itself: Claude copies the whole marketplace folder into `~/.claude/plugins/cache`, and a checkout with agent worktrees once made a 42 GB cache.

```sh
claude plugin marketplace add ~/.local/share/ai-collab/claude-plugin
claude plugin install ai-collab@ai-collab
```

To ship a change from the checkout, refresh the copy; new sessions and `/reload-plugins` read it:

```sh
node -e 'import("./lib/plugin-copy.mjs").then(m => m.packPluginCopy(process.cwd(), process.env.HOME + "/.local/share/ai-collab/claude-plugin"))'
```

Or load the directory as a plugin, for example during development:

```sh
claude --plugin-dir /path/to/ai-collab
```

The hook file is `hooks/hooks.json`, and it uses `${CLAUDE_PLUGIN_ROOT}`.

## Codex

```sh
codex plugin marketplace add https://github.com/bcmyguest/ai-collab
codex plugin add ai-collab@ai-collab
```

Update with `codex plugin marketplace upgrade`. Codex copies the marketplace folder and hashes all of it before every hook, so a local checkout with `node_modules` or worktrees makes each hook time out. The Git source clones only tracked files. For a local checkout, `setup` installs the same clean copy into `~/.local/share/ai-collab/codex-plugin`; after refreshing it, run `codex plugin add ai-collab@ai-collab` again. Cursor's `--copy` install uses the same copy, without `hooks/`.

Restart Codex and check `/hooks` to trust the enabled plugin hooks; trust again after each update. The manifest is `.codex-plugin/plugin.json` and points to `hooks/codex-hooks.json`.

**Headless runs.** Codex runs a plugin's hooks only when that trust is persisted in `config.toml`, and only the interactive `/hooks` review writes it (measured on codex-cli 0.171.0). So `codex exec` in a fresh worktree fires no `SessionStart`, `UserPromptSubmit` or `PostToolUse` hooks at all: the session never registers, and the UI never shows it. Codex has no non-interactive trust command, so every `codex exec` this project starts carries `--dangerously-bypass-hook-trust`, which asks for the same thing once for that invocation ("run enabled hooks without requiring persisted hook trust; intended only for automation that already vets hook sources"). It does not widen what may run: hooks a repository ships in its own `.codex/` stay off in a project Codex has not marked trusted, which is every worktree and sandbox this project creates. Hooks from `$CODEX_HOME` and from installed plugins run. Resuming a session by hand needs the same flag: `codex exec --dangerously-bypass-hook-trust resume <id> "<prompt>"`.

## Cursor

```sh
node /path/to/ai-collab/scripts/install-cursor.mjs --copy
```

The installer puts the plugin in `~/.cursor/plugins/local/ai-collab` (a symlink without `--copy`). Cursor requires a copy when the source is outside its local plugin directory. Restart Cursor afterwards.

Cursor's CLI runs only `sessionStart` and `stop` from a plugin's hooks (observed with cursor-agent 2026.11.19: prompts, tool results and replies never reached plugin hooks, while the same events reached `~/.cursor/hooks.json`). So the installer writes `hooks/cursor-hooks.json`, with the plugin path filled in, into `~/.cursor/hooks.json`: it replaces earlier ai-collab entries and keeps every other tool's hooks. The plugin manifest registers no hooks, so nothing fires twice.

## OpenCode

OpenCode 2 (checked with 2.2.5) loads ai-collab as a server plugin:

```sh
node /path/to/ai-collab/scripts/install-opencode.mjs
```

`installOpenCode` (`lib/install-opencode.mjs`) writes three things under `$XDG_CONFIG_HOME/opencode` (default `~/.config/opencode`) and keeps every other setting:

| What | Where | Content |
|---|---|---|
| Plugin | `plugins/ai-collab.js` | a one-line shim that re-exports `lib/opencode-plugin.mjs` from the checkout; the first line marks it as ai-collab's, and a file without that mark is never overwritten |
| MCP server | `opencode.json` `mcp.servers.ai-collab` (or `mcp.ai-collab` when the file lists servers flat) | `{"type":"local","command":["node","<checkout>/scripts/ai-collab-mcp.mjs","opencode"],"cwd":".","enabled":true}`; OpenCode names the tools `ai-collab_<tool>` |
| Skill | `opencode.json` `skills` (a list, or `paths` in the `{paths, urls}` form) | `<checkout>/skills` |

An unparsable `opencode.json`, or only an `opencode.jsonc`, is left alone and the installer says so. Restart OpenCode (or its background service) afterwards.

The plugin runs inside the OpenCode server and starts `node scripts/ai-collab-hook.mjs --host opencode` once per event with Claude-shaped input (`hook_event_name`, `session_id`, `cwd`, `tool_name`, …), so `node` must be on the server's `PATH`. Each OpenCode location (folder) loads its own plugin instance; it handles only sessions and events of its own folder. Activity-only events are not awaited; delivery hooks wait at most as long as the Claude registrations (10 s, Stop 660 s, approvals 600 s).

| OpenCode | Hook input | Plugin applies |
|---|---|---|
| session `prompt`, first in a session | `SessionStart` | context appended to `prompt.text` |
| session `prompt` | `UserPromptSubmit` | context appended to `prompt.text`; ends a running AFK wait |
| session `experimental.idle` | `Stop` (`stop_hook_active`, `context_tokens`) | `reason` sent with `ctx.session.synthetic` |
| tool `execute.before` | `PreToolUse` (activity) | — |
| tool `execute.after`, completed | `PostToolUse` | context appended to `result.content` |
| tool `execute.after`, error | `PostToolUseFailure` (activity) | — |
| permission `evaluate`, `effect: "ask"` | `PermissionRequest` | `effect` = `allow` or `deny` + `message` |
| event `session.text.ended` | `AfterAgentResponse` (activity) | — |
| event `session.compaction.started` | `PreCompact` (activity) | — |
| event `session.deleted` | `SessionEnd` (activity) | — |
| event `session.step.ended` | none | stores `context_tokens` |
| child session (`parentID`) | `SubagentStart`, `SubagentStop`, and its tool events with `agent_id` (activity only) | — |

**Verified** in an isolated `opencode serve` (temporary XDG dirs, no provider credentials, no prompt sent, so no model call): the server loads `plugins/ai-collab.js` and follows the re-export; `setup` succeeds against the real context and all five hook registrations (`session` `prompt` and `experimental.idle`, `tool` `execute.before` and `execute.after`, `permission` `evaluate`) return a registration; `ctx.session.get` returns the session info itself with `location.directory`; `ctx.event.subscribe` yields `{id, created, type, location, data}`; the `mcp.servers` entry connects (12 tools) with the workspace as its cwd; the `skills` path lists the `ai-collab` skill; `opencode mcp add` writes `mcp.servers`; `opencode api <operation> --param sessionID=<id>` works (checked with `session.get`); session IDs look like `ses_` plus 26 characters; the server's argv[0] is `opencode`. The hook side is covered by `test/opencode.test.mjs` against the in-process bus.

**Inferred, not run** (from the [server plugin docs](https://opencode.ai/v2/docs/build/plugins/server/) and the bundled 2.2.5 source): the hook payloads and which fields are mutable; that `experimental.idle` (undocumented, used by OpenCode's own goal feature the same way) is awaited and that a `synthetic` input queued in it continues the session; that `evaluate` waits for the plugin before showing a prompt; the `session.text.ended`, `session.step.ended`, and `session.compaction.started` payloads; `opencode run --format json` printing `sessionID`; `opencode models` printing one `provider/model` per line; and `session.compact` compacting a running session. No real OpenCode session ran.

**Limits.** OpenCode runs hooks in the server, not in the `opencode run` client, so a phone start's `AI_COLLAB_WAKE=1` and an `AI_COLLAB_PARENT` set for a child `opencode run` never reach the hook: a phone start's first prompt counts as the operator's, and an OpenCode child names no parent.

## Skill for agents

`skills/ai-collab/SKILL.md` is a small skill for agents: it covers `peers`, `send`, `inbox`, `afk`, the operator reply routes, and the AFK rules, with the untrusted-message rules. Make sure `scripts/ai-collab` is on PATH, or use its full path.

## The UI by hand

Without `setup`, build and start the UI from the checkout:

```sh
npm ci
npm run build                 # build and publish the next UI release
npm run ui
```

`npm run ui` runs `next start web -H 127.0.0.1 -p ${AI_COLLAB_UI_PORT:-8795}`. To run it as a service, see [Phone UI](phone-ui.md#run-as-a-service). On the host, `ai-collab deploy --install-units` adds systemd drop-ins so the services run through a deploy link, and `ai-collab deploy --from <branch>` can then serve a branch; see [Deploy a branch or worktree](phone-ui.md#deploy-a-branch-or-worktree).
