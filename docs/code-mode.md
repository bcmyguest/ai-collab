# Code mode

Code mode lets a model write one program that calls many tools in a loop; only the program's result returns to the
model. ai-collab has two parts:

1. **Native code mode** for the sessions ai-collab starts (Claude Code and Codex have one; Cursor and OpenCode do not).
2. **`run_code`**, an MCP tool in every harness: one JavaScript program runs in an OpenShell sandbox with an `ai`
   client for the ai-collab tools.

## Native code mode

Default **on**. Precedence, highest first:

| Where | How |
|---|---|
| One start (UI) | The `{} Code` pill in the new-session composer for Claude Agent starts in folders or worktrees and for Codex starts. The start request accepts `codeMode: true\|false`. |
| One start (runner control API) | `POST /v1/sessions` with `codeMode: true\|false` |
| One role (team.dot) | `code_mode="on"` or `code_mode="off"` on the node ([Teams](teams.md)) |
| Everything | `"codeMode": false` in `~/.config/ai-collab/defaults.json` ([Configuration](configuration.md)) |
| Built in | on (`lib/code-mode.mjs` `CODE_MODE_DEFAULT`) |

What each harness gets:

| Harness | Switch ai-collab sets | Status |
|---|---|---|
| Claude Code 2.1.330, runner-owned session (Agent SDK) | SDK `settings: { env: { CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: "1" } }` (`"0"` for off) | Verified with `claude -p --settings`: the transcript shows `REPL` calls. A headless Claude reads the variable only from the flag-settings layer; the same variable in the shell env leaves code mode off. |
| Claude Code, UI start | The UI sends Agent starts with code mode on to the owned runner. Claude Plan, OpenShell, and requests with code mode off or omitted use `claude --bg`. | The owned SDK adapter forwards `REPL` calls as transcript tool events. The builder's live SDK probe reached inference and returned “Not logged in”. |
| Codex 0.171.0, UI start (`codex exec`) | `-c features.code_mode=true` (`false` for off) | Verified: Codex prints "Under-development features enabled: code_mode". |
| Codex, runner-owned session (`codex app-server`) | `thread/start` and `thread/resume` `config: { "features.code_mode": true }` | A live 0.171.0 run with gpt-6-luna recorded `exec` and output `323`. After restarting the app-server and resuming the thread, it recorded another `exec` and output `667`. New threads receive raw tool events. Resumed threads read code calls from the native rollout at turn completion. |
| Cursor, OpenCode | nothing | No native code mode found. They use `run_code`. |

A model can override the switch. Codex's model catalog marks gpt-6.2-sol `"tool_mode": "code_mode_only"`: it ran
its `exec` code tool with `features.code_mode=false` too. Measurements: `/dev/shm/research/code-mode-spike.md`.

## run_code

`scripts/ai-collab-code-mcp.mjs` is a second MCP server, `ai-collab-code`, with the tools `run_code` and `run_read_code`. Call `run_code` like this:

```json
{ "code": "const { tasks } = await ai.task_list(); return tasks.length;", "session": "<your session label>", "timeout_ms": 30000 }
```

- The program is the body of an async function: `await` the `ai.*` calls and `return` a JSON value. `console.log`
  lines come back as `logs`. The reply is `{ ok, result | error, logs?, calls, ms }`, clipped to 16,000 characters.
- `ai.*` tools: `list_agents`, `list_sessions`, `channel_history`, `task_list`, `team_status`, `pattern_list`,
  `pattern_status`, `send`, `task_update`. Start, interrupt and operator-only tools are not exposed; they keep their
  approval. The tool description lists each call's arguments, generated from the MCP schemas in
  `lib/tool-api.mjs`.
- Each `ai.*` call runs on the host through `lib/tool-api.mjs`, after a check of its arguments against the tool's
  schema. `session` is always the caller's.
- Limits: `timeout_ms` 1000-120000 (default 30000), 200 `ai.*` calls, 4 MB of program output, 256 MB of heap.

### Where the program runs

Never on the host. The server runs `openshell sandbox exec` into the sandbox `ai-collab-code` (override:
`AI_COLLAB_CODE_SANDBOX`, 1-19 characters), creating it on first use with OpenShell's default policy (no network:
`fetch` fails with `EACCES`; no host files). `AI_COLLAB_CODE_POLICY` names a policy file for a new sandbox. Without
`openshell` on PATH (or `AI_COLLAB_OPENSHELL_BIN`), or when the sandbox cannot be created, `run_code` returns an error
and runs nothing.

The sandbox image has no node, so the first run uploads the host's node binary and the libraries the image lacks
(`libatomic.so.1`) to `/sandbox/.ai-collab-code/rt/`, about 150 MB, and reuses them while the node build matches
(`AI_COLLAB_CODE_NODE` picks another node). The `ai.*` calls travel as JSON lines over the exec's stdin and stdout,
the only channel into a sandbox. Measured: a two-call program returns in about 1.5 s, the first run included.

Remove the sandbox with `openshell sandbox delete ai-collab-code`; the next run creates it again.

### Read-only programs for roles

Call `run_read_code` with the same input and result shape. It exposes the seven read-only queries listed above. The host checks that allowlist before dispatching each request, including requests written directly to stdout.

Each invocation provisions a fresh `aic-ro-*` sandbox using `lib/code-read-policy.yaml` and deletes it on completion. The policy has no network routes and grants writes to the staged runtime directory and scratch paths. Fresh sandboxes keep those files from carrying across invocations. The role programs show what to query before making a coordination decision. [Role programs](../skills/ai-collab/references/role-programs.md)

### Registration

| Harness | Where | Server name | Checked 2026-11-22 |
|---|---|---|---|
| Claude Code | `.mcp.json` (plugin) | `plugin:ai-collab:ai-collab-code` | `claude -p --mcp-config` with the server: the model called `run_code` once and got `{"ok":true,"result":{"tasks":108,"agents":1}}` from the real sandbox |
| Codex | `.codex-plugin/plugin.json`, with `tool_timeout_sec: 150` (Codex's default tool timeout is shorter than the longest program) | `ai-collab-code` | `codex mcp get` parses the entry and its `tool_timeout_sec`; tool listing UNVERIFIED (Codex has no tool-list command) |
| Cursor | `.cursor-plugin/plugin.json` (`node scripts/install-cursor.mjs --copy`) | `ai-collab-code` | `cursor-agent mcp list-tools ai-collab-code` lists `run_code (code, session, timeout_ms)` |
| OpenCode | `opencode.json` `mcp.servers` (`node scripts/install-opencode.mjs`) | `ai-collab-code` | UNVERIFIED: `opencode mcp list` (2.2.5) printed "No MCP servers configured" even for servers already in the global config |

`run_code` is registered next to native code mode, not instead of it. Inside a native code-mode program, Claude
and Codex expose MCP tools as nested tools, so `run_code` is one of them; neither replaces the other. Native code
mode runs the harness's own tools in the harness's sandbox; `run_code` is the only one that runs inside OpenShell
and the only one Cursor and OpenCode have.

## Files

| Path | Role |
|---|---|
| `lib/code-mode.mjs` | the setting and each harness's switch |
| `lib/code-run.mjs` | run_code: description, schema check, sandbox staging, the in-sandbox bootstrap, limits |
| `scripts/ai-collab-code-mcp.mjs` | the `ai-collab-code` MCP server |
| `test/code-mode.test.mjs`, `test/code-mode-ui.test.mjs`, `test/code-run.test.mjs`, `test/code-mcp-register.test.mjs` | tests with fakes (fake openshell, fake Codex app-server, fake SDK query) |
