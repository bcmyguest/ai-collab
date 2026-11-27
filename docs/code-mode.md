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

When `@harness:model` or `@harness` starts a new session from a chat post, AI Collab requires `run_code` or
`run_read_code` for the supported AI Collab reads, regardless of `readsThroughRunCode` in `defaults.json`.
Direct MCP reads return a program to run and CLI reads exit 3, including when `AI_COLLAB_DIRECT_READS=1` is set.
The session keeps this policy when AI Collab wakes it. Codex tag launches register both AI Collab MCP servers
in the session folder. Reads through code require a working OpenShell installation.

**Saved programs.** Instead of inline `code`, pass `file`: a `.js` or `.mjs` program (at most 20,000 characters) inside the session's working folder. The `ai-collab-code` MCP server is a local process started by the harness, so it reads the file itself (from the host, or from the sandbox's copy of the worktree for a builder) and sends its text into the sandbox exactly like inline code; a path outside the working folder, a symlink pointing out of it, or another extension is refused. `input` (any JSON value) is bound as `const input = ...` before the program, so one saved program takes arguments: `{ "file": "programs/pm-reads.mjs", "input": { "limit": 40 }, "session": "<label>" }`.

**Reads go through run_code.** With `"readsThroughRunCode": true` in `~/.config/ai-collab/defaults.json` and `openshell` on PATH, the `ai-collab` MCP server prefixes the read tools' descriptions (`list_agents`, `list_sessions`, `channel_history`, `task_list`, `team_status`, `pattern_list`, `pattern_status`) with "Do not call directly: call run_code" and refuses a direct call with the `run_code` call to make instead. The tools stay listed: a probe with them hidden fell back to the `ai-collab` CLI. Writes and operator tools (`send`, `ask_question`, `reply_to_operator`, `wait`) stay direct. Without OpenShell, as inside a builder sandbox, reads stay direct. An agent Read, Grep, Glob, or shell read (`cat`, `jq`, and the same readers the run-code analyzer counts) of `~/.local/share/ai-collab/tasks` or `~/.local/state/ai-collab` is refused by the session hook with that same recipe. `~/.local/state/ai-collab/builders` stays readable. The hook does not run for a human shell.

The CLI read commands follow the same rule: `peers`, `history`, `agents`, `sessions`, `task list`, `task show`, `team status`, `pattern list` and `pattern status` exit 3 and print the `run_code` program that answers them on stderr when the caller is an agent session (`AI_COLLAB_SESSION` set, or a Claude Code, Codex, Cursor or OpenCode process among its ancestors). A human at a terminal, `AI_COLLAB_DIRECT_READS=1`, and runner schedules that start no harness keep direct reads. Builder sandboxes have no `openshell` and use their own `ai-collab` shim, so their `task show` stays direct. `task show` maps to the `task_list` entry, which carries the last progress line only.

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

## Measuring

`ai-collab analyze run-code` compares agent behaviour and cost before and after reads were forced through run_code. It reads local logs only: Claude Code transcripts, Codex sessions, the OpenCode database, Cursor chat stores, the runner journal (`journalctl --user -u ai-collab-runner`) and the task store.

```bash
ai-collab analyze run-code --since 2026-11-16T00:00:00Z \
  --cutover 2026-11-23T03:15:00Z --partial 2026-11-23T02:30:00Z \
  --out docs/research/run-code-impact-2026-11-23.md --jsonl /tmp/run-code-impact.jsonl
ai-collab analyze run-code --agent pm --agent claude       # only Claude sessions with the role pm
```

- `--cutover` is the instant CLI and MCP reads were both enforced (default 2026-11-23T03:15:00Z). `--partial` marks the earlier instant MCP reads were enforced; `--partial none` drops the middle period.
- `--agent` takes `harness#<16 hex label>`, a harness (`claude`, `codex`, `cursor`, `opencode`) or a role (`pm`, `builder`, `interactive`, `subagent`). Values of one kind are alternatives; different kinds must all match.
- The report counts read calls by path (MCP, CLI, run_code, run_read_code, bypass reads of the task store), refusals, run_code failures, tool calls per turn, tokens per turn with and without reads, list-price dollars per ISO week, runner schedule wall times and a per-agent table. Its "Method and gaps" section states what each source cannot show (Cursor has no token usage and no per-message time).
- `--jsonl` writes one row per agent x model x role x period x week, each carrying `agent`, `harness`, `model` and `role`.
- Phoenix: `--otlp-export http://localhost:6006/v1/traces` posts one span per turn as OTLP/HTTP protobuf (Phoenix rejects OTLP JSON with 415). Spans carry `session.id` (the agent address), `llm.model_name`, token counts and `ai_collab.*` attributes; `--phoenix-project` names the Phoenix project. A Phoenix source can join the analysis later by implementing `{name, load({since, until}) -> {turns}}` in `lib/analyze-sources.mjs`.

### Cursor traces

Every Cursor run sends one OTLP trace to `defaults.json` `"otlpEndpoint"` (default `http://localhost:6006/v1/traces`; `"off"` or `AI_COLLAB_OTLP_ENDPOINT=off` turns it off). The CLI's own OpenTelemetry exporter cannot be used: in 2026.11.22 it posts only to Cursor's backend with the login token, and `OTEL_EXPORTER_OTLP_*` does not redirect it (a run with those set sent nothing to a local receiver). `lib/cursor-trace.mjs` builds the spans instead.

| Run | Source | Model | Tokens | Tool calls |
|---|---|---|---|---|
| Builder (`ai-collab builder`, code mode) | stream-json on the host | `--model` | yes, from the `result` event | yes |
| Runner-owned session (ACP) | ACP `session/update` | `--model` or `session/new` | no: ACP's `session/prompt` returns only `stopReason` | yes |
| Interactive, host `cursor-agent -p`, `ai-collab start`, schedules | Cursor hooks | hook `model` | no: hooks and transcripts carry none | yes |

Each trace has an `AGENT` root (`cursor-agent run`), one `LLM` child (`llm.model_name`, `llm.token_count.prompt|completion|total`, `llm.token_count.prompt_details.cache_read|cache_write`; the prompt count includes cached tokens) and one `TOOL` child per tool call (`tool.name`, `input.value` cut to 1000 characters). Every span carries `session.id` (`cursor#<label>`) and `ai_collab.role` (`builder`, `runner`, `schedule:<name>` or `session`). A hook-traced turn runs from `sessionStart` or `beforeSubmitPrompt` to `stop` or `sessionEnd`; a `-p` run fires no `stop`, so it is one trace. Export is one POST with a 1.5 s timeout whose failure is ignored. A sandboxed builder or runner session is traced on the host from its output, so no sandbox needs a route to Phoenix; such processes carry `AI_COLLAB_CURSOR_TRACE=launcher` or `AI_COLLAB_OWNED`, and their hooks record nothing.

## Files

| Path | Role |
|---|---|
| `lib/code-mode.mjs` | the setting and each harness's switch |
| `lib/code-run.mjs` | run_code: description, schema check, sandbox staging, the in-sandbox bootstrap, limits |
| `lib/analyze-run-code.ts`, `lib/analyze-sources.ts`, `lib/analyze-otlp.ts` | `ai-collab analyze run-code`: aggregation and report, per-harness log readers, OTLP encoder |
| `lib/cursor-trace.ts` | Cursor run traces: stream-json, ACP and hook recorders, OTLP export |
| `scripts/ai-collab-code-mcp.mjs` | the `ai-collab-code` MCP server |
| `test/code-mode.test.mjs`, `test/code-mode-ui.test.mjs`, `test/code-run.test.mjs`, `test/code-mcp-register.test.mjs`, `test/analyze-run-code.test.mjs` | tests with fakes (fake openshell, fake Codex app-server, fake SDK query) |

## Cursor and OpenCode builders

These builders get an `ai-collab-code` MCP server staged directly into their session sandbox. Its `run_code` starts in the builder worktree. Pass `code` and optionally `timeout_ms`. This registration exposes the local worktree helpers.

```js
const matches = grep("oldName", "src");
const source = read("src/example.js");
if (!source.includes("oldName")) throw new Error("Expected oldName in example.js");
edit("src/example.js", "oldName", "newName");
const check = sh("git diff --check");
if (check.code !== 0) throw new Error(check.stderr || check.stdout);
return { matches: matches.trim().split("\n").length, diffCheck: check.code };
```

Group a search and related reads in one call, then batch a known edit with its verification. Use ordinary JavaScript to filter results and return a short summary. Check `sh`'s `code`, `stdout`, and `stderr` before relying on its result. `grep` uses extended regex and returns an empty string for no matches. `edit` replaces one literal occurrence and throws for missing or ambiguous matches. Use worktree-relative paths. The helpers share the sandbox's access and run under its OpenShell policy.

The default timeout is 30 seconds, up to 120 seconds. A program can call up to 200 helpers. Reads and individual command streams are capped at 1 MiB, and the tool response is clipped at 16,000 characters.

The fixed worktree task in `test/code-run.test.mjs` searches, reads, edits, and checks the same file in both paths. Its scripted transcripts record four top-level tool calls for the separate operations and one for the batch. The test checks both resulting files and command results. Live harness transcripts can be collected from the builder unit journal, which receives Cursor stream JSON and OpenCode JSON events.
