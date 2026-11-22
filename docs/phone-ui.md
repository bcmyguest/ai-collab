# Phone UI

The operator UI is a Next.js (App Router) app in `web/`. [`setup`](quick-start.md) builds it and runs it as the `ai-collab-ui` systemd user service on `http://127.0.0.1:8795`. To run it by hand, see [Install](install.md#the-ui-by-hand).

The server serves every project in `~/.config/ai-collab/projects.json`, each resolved from its own `root` with its own URL, token file, and peers, plus every auto-joined repo (see [Configuration](configuration.md#auto-join-every-repo-defaultsjson)). It keeps ntfy tokens and raw harness session IDs server-side. The browser sees only public `peer#label` identities.

## UI settings

| Variable | Default | Meaning |
|---|---|---|
| `AI_COLLAB_UI_WORKSPACE` | current directory | Fallback project directory, used only when `projects.json` lists no usable project |
| `AI_COLLAB_UI_PORT` | `8795` | Loopback port for `npm run ui` |
| `AI_COLLAB_UI_ORIGIN` | — | HTTPS origin allowed to post, e.g. `https://ai-collab-ui.<tailnet>.ts.net` (no trailing slash) |

The UI has no login unless you add [GitHub sign-in](github-sign-in.md). Access control is the loopback bind plus Tailscale. Every `POST /api/*` must come from the UI's own origin (`AI_COLLAB_UI_ORIGIN`, or `http://127.0.0.1:<port>` locally), which blocks cross-site request forgery. Pages carry a per-request script nonce in their Content Security Policy.

## Run as a service

`setup` writes `~/.config/systemd/user/ai-collab-ui.service` (description "AI Collab UI") that runs `next start web -H 127.0.0.1 -p 8795` from the checkout with `NODE_ENV=production`, `Restart=on-failure`, and `UMask=0077`. It keeps an existing unit. A hand-written unit looks like this:

```ini
[Unit]
Description=AI Collab messaging UI

[Service]
WorkingDirectory=%h/ai-collab
Environment=NODE_ENV=production
Environment=AI_COLLAB_UI_WORKSPACE=%h/my-project
Environment=AI_COLLAB_UI_ORIGIN=https://ai-collab-ui.<tailnet>.ts.net
ExecStart=/usr/bin/node %h/ai-collab/node_modules/next/dist/bin/next start %h/ai-collab/web -H 127.0.0.1 -p 8795
Restart=on-failure
RestartSec=2
UMask=0077

[Install]
WantedBy=default.target
```

Run `npm ci && npm run build` in the checkout before `systemctl --user restart ai-collab-ui`. `next build` records the absolute path of `web/server/ui.mjs`; rebuild after moving the checkout.

## Live updates

The browser reads one AG-UI SSE stream from `/api/events` using `@ag-ui/client`. A `STATE_SNAPSHOT` refreshes the chat and session view. In an Activity view (`view=activity`), the same stream replays activity events and then sends new ones as they arrive. See the [AG-UI event protocol](ag-ui.md). The server holds a single ntfy streaming subscription (`/<topic1>,<topic2>/json`) shared by all browsers and by every project on the same ntfy server and account. It fetches a topic's history once (`poll=1&since=all`) when a browser first opens that project (broadcast, status, and each session inbox), and reconnects with `since=<last id>` after a drop, backing off 30 seconds on HTTP 429. The activity topic's history keeps the newest 3 MB of the cache, and the hub keeps 500 events per topic.

On a phone, drag the list down from its top, or up from its bottom, past 70 px to refresh: the app reconnects its stream like **Retry** and shows the same toasts. The gesture uses touch events only and is ignored while text is selected or the composer has focus; the page keeps `overscroll-none`, so the browser's own reload never fires.

After a deploy, an open page shows an "Update available" toast when it reconnects; tap Reload to load the new build. The page compares its build id with `GET /api/version`.

## Home

**Home** (`#home`, the landing page, the header's house button, or the sidebar logo) shows one card per session across every project: avatar, human name, `harness#label`, project, state, last action (tool and summary), last active, "started by …", and running subagents nested under the card. A child session whose registry `parent` is listed nests under its parent. Cards group by state; Offline starts collapsed:

| State | Rule (`web/lib/session-state.js`) |
|---|---|
| Waiting on you | an open approval or choice (not expired), or an unanswered important question |
| AFK hold | online, AFK mode not `off`, the latest row is `turn ended`, and no `stop` status after it: the Stop hook is waiting |
| Working | an open tool call or running subagent under 15 minutes old, or any activity in the last 60 seconds |
| Idle / Offline | the registry PID check |

Approvals, choices and questions are answered on the card. The browser opens `/api/events?view=home`; the server adds a `sessions` list to the pushed state and opens each project's status, broadcast and activity topics once on the shared hubs, so Home adds no polling. A project whose topics fail is listed as unavailable.

## Levels

The sidebar (a drawer on phones) lists the projects. Inside a project, pick a level:

| Level | Tabs | Composer sends to |
|---|---|---|
| Project | **Chat**: the broadcast topic, agent questions and approvals, a completion row per finished session turn, and a live row per busy session. | `all` |
| Sessions | A session selector. With no session picked, the project's session cards. A picked session has **Timeline** and **Subagents**; its ⋯ menu opens **Raw activity**. | The session directly; wakes it if offline. No composer on the session list. |

The hash records the view: `level=session&session=<addr>&tab=activity|subagents|raw`. `tab=activity` is the timeline and the default; old `tab=chat` links open it too.

Tapping a message's sender avatar or name, or an `@peer#session` tag, opens that session's timeline; an `@harness` tag opens the session list. Tapping a completion or live row opens its session. The operator's own messages stay plain.

**Session names** appear next to `harness#label` in the mention picker, the sidebar and the cards. Claude Code: the `session_title` field of its SessionStart and UserPromptSubmit hook input (in the Claude 2.1.330 hook schema). Codex: the thread's newest `thread_name` in `$CODEX_HOME/session_index.jsonl`. OpenCode: the session `title` from `ctx.session.get`, read when the plugin first sees the session. Hooks record it in the local registry at SessionStart, UserPromptSubmit and Stop (`lib/names.mjs`). Cursor gives none; the UI falls back to the folder name and the first six words of the session's earliest prompt still in the activity history.

Each session card shows **where it runs** after its address: `folder` (the project root), `worktree <name>` (under `<root>/.claude/worktrees/` or any other `worktrees/<name>` path), `sandbox` (a registry entry with a `sandbox` field; no hook writes one yet), else the cwd with `~` for home (`sessionPlace` in `lib/sessions.mjs`). A **⋯** menu on each card has **Dispose**, enabled only for an offline session with a registry file. It posts `/api/dispose`; the server checks the address (`peer#16-hex`), that the session belongs to the project and that its recorded process is not running, then deletes `<stateDir>/<project>/registry/<address>.json` (`disposeSession`). A session that still has messages in ntfy history can reappear as an offline card without a registry entry.

A **Go to agent** button sits on every Home card, its "started by" parent, each subagent run (in threads, the overview and on cards), each overview row's agent, and each agent's message. A session started by another shows **Back to parent** under its title; a subagent run's view has **Back to parent** to its session's thread.

## Chat and activity views

A session's **Timeline** interleaves its direct thread and broadcast posts with its activity rows by time: each finished turn folds into one **Working on … · N steps** row, and its final reply shows as a bubble. Live tool calls show while a turn runs. The composer sits below. The project chat shows the broadcast topic, with a **finished** row per completed session turn (its first line of the final reply) and a **working on** row per busy session; tool calls stay out of it. **Raw activity** (the session's ⋯ menu) lists every tool call unfolded.

Rows render by type: prompts as user bubbles, assistant text as Markdown, tool calls as an icon, the tool name, and a one-line summary (tap to see the input), results as a collapsed preview (tap to expand; **Full output** opens the attachment), and errors in red. A call and its result share a row when the harness supplies a call ID. A `compact` row marks a context compaction. **Working…** shows while an agent's latest event is a tool call without a result (for at most 15 minutes). The view follows the newest row like the chat and keeps the last 500 rows.

`/api/file/<name>` serves a `text/plain` file only when an activity event in memory references it; chat topics still serve images only.

### Subagents

Each subagent run folds into one collapsed row in its parent's thread, **Subagent · <type> · running/done · N steps** (N counts tool calls); tap it to show that run's rows indented below it. A step is one tool use: its call row, or its result alone. The page remembers which runs are open until it reloads.

A run is **running** while it has a row from the last 2 minutes, **idle** after that, and **done** at its stop row, at the parent's `<task-notification>` prompt with that `<task-id>` and a final `<status>`, or when the parent's Agent tool result says `"status": "completed"`; that result's `agentId` also gives the run its description. The "N subagents" badges on Home count running runs only.

The session's **Subagents** tab lists each run: type, parent session, running or done, step count, description, start time and last action. Tap one to see only its rows (`&tab=subagents&run=<id>`).

On 2026-11-21 the `ai-collab-ai-collab--activity` topic held only `tool_result` rows inside subagents and no `tool_call`, `text`, or subagent start/stop rows at all: none of Claude's `"async": true` registrations (PreToolUse, MessageDisplay, SubagentStart, SubagentStop) had published, so runs showed 0 steps before the step-counting rule above.

## Composer

Type `@` or tap **Mention** to tag a session or harness in a post. A tagged session also gets the post in its direct chat. A tagged harness (`@codex`) gets it in each of its running sessions; with none running, the UI starts one in the project folder with the post as its first prompt, at most one start per 10 seconds. The picker matches fuzzily on address, session name, harness and model, and lists `harness:model` options: `@codex:gpt-5-codex` always starts a new session with that model, if the harness lists it (else the toast says `unknown model`). The toast says what each tag did. Tap a session in the sidebar (the menu on a phone) to chat directly. A direct message its session has not read yet shows **queued** with **Send now**, which makes the session's next hook (its next tool call) poll at once. Tap **Reply from the composer** under a question to answer an MCP question on the broadcast topic. Mention options, the session picker, and the sidebar show when each session and harness last sent a `msg` envelope (`3m ago`, `never`), computed from history the server already holds.
The picker also lists each open subagent run as `@session/run`; the post goes to its session with `for_subagent`, and the session relays it to the run.

## Teams

Teams are named rosters of `harness` or `harness:model` members (for example `light-team: [claude:haiku, codex:gpt-5-codex]`). Create them with **Teams → Create** in the sidebar, `ai-collab team create`, or a `teams` object on the project's `projects.json` entry; global defaults come from `~/.config/ai-collab/teams.json` and project names override.

The mention picker lists configured teams. Post `@light-team <task>` in the project chat to start a new Claude orchestrator with the roster and instructions to split work using `team_start` / `team_status` (MCP or CLI). Post the same tag in a session chat to make that session the orchestrator; it receives a direct message with `for_team` set. The CLI mirrors MCP: `ai-collab team list|create|delete|start|status`. Member sessions are recorded under `$AI_COLLAB_STATE_DIR/<project>/teams/<name>.json`.

## Patterns

The Patterns page (sidebar **Patterns and teams**) lists patterns, teams and recent runs. Open a pattern to see its roles, graph, handoffs and runs; **Raw** shows its `team.dot` text. **Edit** opens the DOT editor for a project pattern: a graph above the text on a phone (390 px), side by side on desktop. The graph redraws about 300 ms after each edit; a parse error shows its line and that source line. **New team** starts from the shipped template. Details: [Teams and patterns](teams.md).

**Send now** adds `urgent: true` to the send request, and a message whose envelope has `urgent: true` shows ⚡. See [Urgent messages](messaging.md#urgent-messages-send-now).

The **AFK** switch in the header sets the operator mode to `on`, `off`, or `quiet`. Each change publishes a mode record to the broadcast topic of every project. The latest mode envelope in history is the current mode (none means `off`); the chat never shows mode envelopes. See [AFK mode](afk.md).

## Start a session from the phone

Each project in the sidebar has a **+** button (the **New session** panel), a chat whose composer starts the agent: type `@codex:gpt-5-codex fix the tests` (`@codex fix the tests` uses the default model) and send. The text after the tag is the prompt. The panel opens the session's chat once it reports. The server accepts only a project name from `projects.json` and one of `claude`, `codex`, `cursor`, `opencode` that is in the project's peers and on `PATH` (plus Node's directory and `~/.local/bin`). It never takes a path from the client. It spawns the harness detached, with `shell: false`, in the project's `root`, at most once every 10 seconds:

| Harness | argv |
|---|---|
| Claude Code | `claude --bg [--model <m>] <prompt>` |
| Codex | `codex exec --json [-m <m>] <prompt>` |
| Cursor | `cursor-agent -p --output-format stream-json --workspace <root> [--model <m>] <prompt>` |
| OpenCode 2 | `opencode run --format json [-m <provider/model>] <prompt>` (cwd is the root or worktree; the run uses OpenCode's background server, where the plugin runs) |

The start request body is `{project, harness, prompt, model?, worktree?, openshell?}` (`worktree: true` and `openshell: true` choose the place; both at once is rejected). A `model` must be in the harness's allowlist, which the `models` action (`POST /api/models`, body `{}`) returns as `{claude:[...], codex:[...], cursor:[...], opencode:[...]}` (`opencode` is empty unless the project's peers list it, or list nothing). The panel's composer takes the model from the `@harness:model` tag, which the mention picker lists from that action:

| Harness | Allowlist source |
|---|---|
| Claude Code | fixed: the aliases and full ids in the [model configuration docs](https://code.claude.com/docs/en/model-config#model-aliases) (`fable`, `opus`, `sonnet`, `haiku`, `best`, `opusplan`, `sonnet[1m]`, `opus[1m]`, `claude-…` ids) |
| Codex | slugs not marked `hide` in `$CODEX_HOME/models_cache.json` (Codex's model catalog cache), plus `model` from `config.toml` |
| Cursor | `cursor-agent --list-models`, cached a day in `$AI_COLLAB_STATE_DIR/models-cursor.json` |
| OpenCode 2 | first word of each `opencode models` line shaped `provider/model[#variant]`, cached a day in `models-opencode.json` |

Any other value is rejected with 400 before anything is spawned.

The prompt is one argv element, 1-4000 characters, and may not start with `-`. No flag skips permissions or trust (`--force`, `--trust`, `--dangerously-bypass-hook-trust` are never passed). Output goes to `$AI_COLLAB_STATE_DIR/<project>/starts/<time>-<harness>.log`. The child gets no `AI_COLLAB_*` settings, so its hooks find the project from `projects.json` by its cwd, like any session; it gets `AI_COLLAB_WAKE=1`, so its first prompt is not mistaken for the operator at a terminal. The server waits up to 15 seconds for the id the CLI prints (Claude: a UUID in its output; Codex: `thread.started` `thread_id`; Cursor: `session_id`; OpenCode: `sessionID` on its JSON events) and returns the session's public address `harness#label`; the raw id stays in the log. The UI links the session once its `SessionStart` status arrives. For Codex, the result warns when `config.toml` has no trust entry for the plugin's hooks; trust them in `/hooks`.

**Where to start.** A second picker offers only the places the server can use:

| Place | Shown when | argv |
|---|---|---|
| In the project folder | always | as above |
| In a new git worktree | `root/.git` exists and `git` is on `PATH` | Claude: `claude --bg --worktree ai-collab-claude-<UTC stamp> <prompt>` (Claude makes its own worktree). Codex, Cursor: `git -C <root> worktree add -b ai-collab/<harness>-<stamp> <root>/.claude/worktrees/ai-collab-<harness>-<stamp>`, then the harness argv with that folder as cwd (and Cursor's `--workspace`) |
| In the openshell sandbox | `AI_COLLAB_OPENSHELL_SANDBOX` is a valid name and `openshell` is on `PATH` | `openshell sandbox exec --name <sandbox> --workdir <root> --no-tty --no-login-shell -- <harness argv>`, the wrapper wake uses (`lib/controls.mjs`) |

The server validates the place against that list; a failed `git worktree add` starts nothing.

**Unverified.** Only fake executables were run (`test/start-places.test.mjs`, and the 390 px browser check). Whether `claude --bg --worktree` works together, whether the sandbox has the project at the same path, and whether hooks inside the sandbox reach `projects.json` and ntfy were not checked. Whether `claude --bg` prints the session ID that its hooks report, and whether `cursor-agent -p` runs in a workspace it has not trusted, were not checked.

## Wake, compact, and context alerts

Each hook records the harness process as its PID plus the process start time (field 22 of `/proc/<pid>/stat`), so a reused PID never counts as the session. A session counts as online only while that pair matches a live process.

| Action | Session running | Session exited |
|---|---|---|
| Direct message (wake) | `queued`: the next hook delivers it | Resume the exact session: `claude --print --resume`, `codex exec resume`, `agent --print --resume`, `opencode run --session <id>` |
| Compact | Codex: `thread/compact/start` over the local app-server daemon when the thread is loaded there and idle. OpenCode: as when exited. Otherwise `requested`: an urgent operator message asks the session to finish its step, and the operator runs `/compact` | Claude: `/compact` through the Claude Agent SDK (`query` with `resume`). Codex: `thread/compact/start` over `codex app-server`. OpenCode: `opencode api session.compact --param sessionID=<id> --data {}` (the server's `POST /api/session/:sessionID/compact`). Cursor: `unsupported` |

For OpenCode the recorded process is the OpenCode server that runs the plugin (the background service, or the TUI's private server with `--standalone`), so a session counts as online while that server runs, like an idle Claude session in its terminal.

The wake banner disappears once the session reports a hook or status after the wake began, or is online again after the wake finished; a failed wake keeps its Retry, hidden while the session is online. A direct message to a running session returns `wake: {status: "online"}` with no note; its ticks show delivery.

Compacting a running session, per harness:

| Harness | Outside trigger | What Compact does |
|---|---|---|
| Codex | The TUI attaches to the local app-server daemon (`daemon_auto_start` in `codex features list`); `codex app-server proxy` connects another client to it. The protocol (`codex app-server generate-json-schema`) has `thread/loaded/list`, `thread/read` (status `idle` or `active`), `thread/resume` ("If thread_id identifies a running thread, app-server rejoins that thread"), and `thread/compact/start`. | Lists loaded threads; if the thread is loaded and idle, rejoins it with only its id and compacts it. A busy thread or one outside the daemon gets the urgent request; press Compact again once its turn ends. |
| Claude Code | None documented. [Hook outputs](https://code.claude.com/docs/en/hooks#precompact-output) cannot start a compaction (PreCompact only shapes one), a Stop `reason` is text for the model, and `/compact` runs only when typed in the session or sent from [Remote Control](https://code.claude.com/docs/en/remote-control). | Urgent request; run `/compact` in the terminal or from Remote Control. |
| Cursor | None found. `cursor-agent --help` and `cursor-agent acp --help` list no compaction command or flag; the ACP handler bundled in cursor-agent 2026.11.22 dispatches `session/new`, `load`, `resume`, `fork`, `list`, `status`, `prompt`, `cancel`, `set_mode`, `set_model` and `set_config_option`, with no `session/compact`; no `/compact` command string appears in the bundle. Not run against a live session. | Urgent request; run `/compact` in the session. |

ai-collab never writes another process's transcript or rollout files.

**Unverified.** The live Codex path ran only against a fake daemon proxy; no real running thread was compacted, and whether the daemon rejects `thread/compact/start` when a turn starts between `thread/read` and the request was not checked.

Concurrent requests for one session share a single run. A wake and a compact never run at the same time. The child gets no `AI_COLLAB_*` variables. Its own hook reads the private project config.

| Variable | Default | Meaning |
|---|---|---|
| `AI_COLLAB_WAKE_RUNNER` | `host` | `host` runs the harness directly. `openshell` runs it with `openshell sandbox exec`. |
| `AI_COLLAB_OPENSHELL_SANDBOX` | — | Sandbox name, required when the runner is `openshell`. |

Context alerts post one context alert to the broadcast topic each time a session's current context rises above 200,000 tokens. A sample of 200,000 or fewer re-arms the alert, and a failed publish retries on the next sample. Agents skip these envelopes. The sources are the harnesses' own counters, read locally:

| Harness | Source |
|---|---|
| Claude Code | Last assistant `usage` in the transcript: `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` |
| Codex | Last `token_count` event in the rollout: `info.last_token_usage.total_tokens` |
| Cursor | `preCompact` hook `context_tokens` (sampled only before compaction) |
| OpenCode 2 | last `session.step.ended` event's `tokens`: `input + cache.read + cache.write`, passed as `context_tokens` |

## Usage-limit cards

When a session hits a subscription or usage limit, the phone gets one choice card per limit window. The card names the agent and its `harness:model`, the limit with its window when known, and the reset time when known: `Limit reached · claude:claude-opus-5-5 · 5-hour · resets 18:00`. A plain HTTP 429 with no window, reset or limit wording reads `Rate limited`. Nothing switches on its own.

Sessions that hit the same typed window (harness, window and reset time) share one card. The newer card lists every session on a `Sessions:` line and closes the older one (`approval-end`, reason `cancelled`). A Claude overage that is allowed or in use is not a limit.

The card offers up to four replacements, then **Wait for reset**:

- The pattern role's `fallback` (`harness:model`) comes first, when the session's pattern role defines one.
- Then the first listed model of each other available harness (`lib/models.mjs`).
- **Wait for reset** only acknowledges. Nothing else changes.
- A replacement starts a new session for each session on the card, in the folder that session ran in. A folder that is gone is refused with its path. The handoff prompt quotes the session title and last activity as data, not instructions. The original sessions keep running. Each session's timeline gets a row that links to its replacement.
- A pick closes the card on every phone (`approval-end`, reason `answered`), so no second pick is offered; a second pick returns 409.
- An untyped alert (the Claude `StopFailure` hook) and a typed one (the runner's `rate_limit_event`) for the same session make one card. A known reset time ends the silence at that time; an unknown reset keeps the card open for 5 hours.
- The alert never starts a harness CLI to list models. It reads the model cache only.

Detection (`lib/limits.mjs`). "Typed" means the pattern appears in a type definition; "UNVERIFIED" means no type or source in this repo names it, and the code comment says so.

| Harness | Source | Status |
|---|---|---|
| Claude | `rate_limit_event` with `status: "rejected"`, not on overage (`sdk.d.ts:6224`, `SDKRateLimitInfo` at `:6237`, overage fields `:6243-6246`) | Typed. The `resetsAt` unit is UNVERIFIED: values above 1e12 read as ms, else seconds. The window end is held to at least 5 minutes ahead. |
| Claude | `StopFailure` hook with `error: "rate_limit"` (`sdk.d.ts:10502`; enum at `:3995`) | Typed. It also fires for an API 429 with no plan limit; the card reads `Rate limited` unless its details name a limit. |
| Claude | Failed result text: "usage limit", "plan limit", "rate limit", "quota" | UNVERIFIED |
| Codex | Turn error with `codexErrorInfo: "usageLimitExceeded"`, forwarded in RUN_ERROR metadata by `runner/adapters/codex.mjs` | UNVERIFIED: the field name is not in the repo's schema snapshot. |
| Codex | Turn error text | UNVERIFIED |
| OpenCode | Provider error with HTTP 429 | UNVERIFIED. `runner/adapters/opencode.mjs` forwards the provider's HTTP status in `RUN_ERROR` metadata (`aiCollab.status`) and `limitFromRunError` passes it to the classifier. The field names it reads are UNVERIFIED. |
| OpenCode | Provider error text | UNVERIFIED |
| Cursor | ACP error text | UNVERIFIED |

Where detection runs:

- The Claude `StopFailure` hook (`scripts/ai-collab-hook.mjs`) covers every Claude session that reports to AI Collab, including `claude --bg` sessions the phone starts. Its own `error` timeline row is dropped, because the limit row says the same.
- The owned-session runner (`runner/runner.mjs`) covers Claude's `rate_limit_event` and every harness's run error.
- Detached `codex exec`, `opencode run` and `cursor-agent -p` sessions started from the phone have no error hook, so no card appears for them.

A reply typed in the ntfy app does nothing. Answer the card in the web UI, where the pick starts the replacement.

## Compaction map

The sidebar's **Compactions** entry, and **Compaction map** in a session's menu, open `#project=<name>&level=compactions`. It lists every agent in the project: harness, model, the context against the window (`tokens of window · N to window`), and its compactions, clears and model switches on one time axis shared by all rows. The axis runs from the oldest entry (or an hour ago) to now. Markers: amber auto, blue manual, red failed, sky clear, green model switch. The three newest entries follow each card with their times.

Headroom is `window - tokens` and shows only when the harness reported both (Codex does; Claude, Cursor and OpenCode report no window). No harness reports its auto-compact point, so the map shows no auto-compact headroom. The history is the activity kept in memory (500 events per project).

Timeline rows: `Compacted · auto · 182k → 31k · 4 files dropped`, `Cleared · 140k → 0`, `Model claude-haiku-5-5 → claude-opus-5-5`. A compaction's before count and dropped files come from its started row; the after count comes from the runner (Claude's `post_tokens`), so a hook-observed compaction shows no after count.

Phone Clear and Model switch: no new channel is verified. `/clear` stays `unsupported` on every harness. `/model` keeps its current support. The Claude Agent SDK has `Query.setModel` (sdk.d.ts:3227), but no phone route calls it. Cursor's ACP dispatcher serves `session/set_model`; `runner/adapters/cursor.mjs` `setModel` sends it, **unverified**: it has not run against a live cursor-agent, and no route calls it.

## Slash commands and context

A composer message is a command for the open session only when its first word is a known command (`compact`, `model`, `clear`) or a name the picker inserted; `/home/x is broken` is chat. Typing `/` opens the command list; Tab inserts the highlighted entry, and a name no known command matches is offered as a passthrough entry. Enter sends the whole message; Escape closes the list. Each entry shows its support for the session's harness: `partial` and `unverified` entries run and carry a badge, and `unsupported` entries are disabled with the reason in their tooltip. The draft clears only when the session ran the command (`succeeded`) or the compaction was `requested`; any other result keeps the draft. The project chat never runs commands.

`/compact` takes no instructions: each harness here either has no verified channel for them, or its request body is unchecked, so `/compact <text>` is refused with the reason.

| Command | Claude Code | Codex | OpenCode 2 | Cursor |
|---|---|---|---|---|
| `/compact` | `partial`: Agent SDK on a saved session; a running session gets the urgent request | `partial`: `thread/compact/start` when the thread is loaded and idle in the app-server daemon; otherwise the urgent request | `supported`: `POST /api/session/:sessionID/compact` | `unsupported` |
| `/model <provider/model>` | `unsupported`: the messaging socket delivers text only | `unsupported`: `turn/start` sets the model per turn, not on a thread | `unverified`: `POST /api/session/:sessionID/model`, body `{providerID, modelID}` not checked against a live service | `unsupported` |
| `/clear` | `unsupported`: no documented clear over the socket | `unsupported`: `thread/start` makes a new thread id | `unsupported`: `POST /api/session` creates another session | `unsupported` |
| any other `/name` | `unsupported`: the socket wraps each message in a `<cross-session-message>` envelope, so the name reaches Claude as text. Verified in the binary: `isSlashCommand` tests the raw value for a leading `/` | `unsupported`: no app-server method runs a slash command | `unverified`: `POST /api/session/:sessionID/command`, body `{command, arguments}` not checked | `unsupported` |

The table is the source in `web/lib/slash-commands.js`. Sources: the Claude binary (`claude`, resolved with `readlink -f`), `codex app-server generate-json-schema`, the OpenCode 2.2.5 binary's operation list (`session.command`, `session.compact`, `session.switchModel`), and `cursor-agent --help`.

The session header shows **Context** with the tokens in the session's last usage report (sources as in the table above). A window appears, with a percentage, only where the harness reports one: Codex, from `info.model_context_window` in the rollout's `token_count` event (also `ThreadTokenUsage.modelContextWindow` in the app-server schema). At 80% the meter turns amber ("near full"); at 95% red ("full"). Claude, Cursor and OpenCode show tokens without a percentage. Home session cards show the same meter on their metadata line once a token count is recorded.

The same panel lists:

- **Files in context**: the instruction files Claude loaded, from its `InstructionsLoaded` hook (`file_path`, `memory_type` User, Project, Local or Managed, `load_reason` session_start, nested_traversal, path_glob_match, include or compact). Codex and the other harnesses record none. A `compact` load drops the earlier `nested_traversal` and `path_glob_match` entries, since compaction removes on-demand files from the context; this takes effect only when a compact load arrives, so a compaction that reloads no file leaves the list unchanged.
- **Files read**: paths of `Read` (or `read_file`) tool calls in the activity loaded for the session, with a count each, most recent first. Only this session's rows in the loaded activity count. The section appears once that activity has loaded; before then it is hidden.

The tokens and files live in the session's `.context.json` state file beside its other state. Alerts above 200,000 tokens are unchanged.

## Tailscale

`setup` prints the short form:

```sh
tailscale serve --bg --https=443 http://127.0.0.1:8795
```

To serve the UI as a named Tailscale Service instead, define a Service named `ai-collab-ui` for TCP 443, then advertise the local listener:

```sh
tailscale serve --service=svc:ai-collab-ui --https=443 http://127.0.0.1:8795
```

Approve the host and grant the intended clients access in the Tailscale admin console. Either way, set `AI_COLLAB_UI_ORIGIN` to the HTTPS URL without a trailing slash in the UI service environment.

## Push notifications

The UI server sends a Web Push notification, even with every tab closed, for actions the operator must take:

| Event | Title | Important |
|---|---|---|
| Permission approval | `Approve <tool> · <peer#session>`, body is the command or path summary | yes |
| Choice card (`AskUserQuestion`) | `Choose · <peer#session>`, body is the first question | yes |
| `ask_question` | `Question · …` or `Important question · …`, body is the question | when the agent set `important` |
| Direct message to the operator | `Message · <peer#session>` | no |

Progress, activity, and status send nothing. The server keeps every project's broadcast and inbox topics open from startup (`web/instrumentation.js`) and notifies an item once: only while it is still pending and less than 15 minutes old, with sent IDs remembered for 24 hours across restarts. Important notifications replace the earlier one for the same item with a new alert (`renotify`) and stay on screen until dismissed. Tapping a notification focuses or opens the UI at that session's thread.

Enable it on an Android phone:

1. Open the Tailscale HTTPS URL (`AI_COLLAB_UI_ORIGIN`) in Chrome or Firefox. Push needs HTTPS; a plain `http://` tailnet address does not work.
2. Tap the bell in the header, then **Turn on**, and allow notifications when the browser asks. The browser asks only after this tap.
3. Tap the bell again and **Send test**.

The bell shows **off**, **on**, **blocked by browser** (re-allow in the site settings), or **unsupported**. On iPhone and iPad, Safari delivers Web Push only to a Home Screen app: share, **Add to Home Screen**, open AI Collab from there, then tap the bell. The web manifest (`/manifest.webmanifest`, standalone display) provides this; its only icon is `icon.svg`, so iOS may show a generic Home Screen icon.

State lives under `$AI_COLLAB_STATE_DIR/push/` (default `~/.local/state/ai-collab/push/`), each file mode 0600: `vapid.json` (the VAPID key pair, generated on first use), `subscriptions.json` (one entry per browser; removed when the push service answers 404 or 410, or when the bell turns off), and `sent.json` (recent item IDs). Delete `vapid.json` to rotate keys; browsers then need to turn notifications on again. The VAPID subject is `AI_COLLAB_UI_ORIGIN`.

Privacy: the server encrypts each payload end to end for the subscribed browser (RFC 8291, `aes128gcm`) and sends it through the browser vendor's free push service, Google FCM for Chrome and Mozilla autopush for Firefox. The vendor sees the ciphertext, its size, the delivery time, and the endpoint, not the contents. A payload holds the harness, session address, project, and a summary clipped to 200 characters (tool and command, or the question text), never file contents.

## Sidebar, projects, and notifications

A session row shows **N running** when it has running subagents, and the session header shows the same count. Subagent runs nest under their session in the sidebar; a run idle for more than 30 minutes (`IDLE_HIDE_MS` in `web/lib/subagent-state.js`) sits behind **Show N idle**. A subagent that resumes after its stop counts as running again on its next row.

The session view's **Working now** line names each agent running now: the session with an open tool call (`harness#label (session)`) and each running subagent (`<kind> subagent in <address>`). The activity data carries no model name, so the line shows no `:model`. Timeline groups and texts show the address of the agent that produced them.

Each project has a **⋯** menu. **Close** hides the project from the sidebar and Home; **Closed projects** lists them with **Reopen**. A closed project is a `"closed": true` flag on its `projects.json` entry. **Delete** asks first and removes the entry only; repo files, worktrees and ntfy history stay. The UI hides a deleted project until it restarts. Projects found by auto-join have no entry, so they cannot be closed or deleted here.

**Scheduled** lists the runner's schedules read-only: name, interval, command, last run, next run; tap a job for its recent runs. With no runner socket it shows **runner offline**.

A reply shows the replied message as a quote above its body (sender and the first 80 characters); tap it to scroll to the original. The composer shows the same quote with a × to cancel. A plain @mention shows no quote.

Notifications carry a link: ntfy's `click` field, built from `AI_COLLAB_UI_URL` (`lib/deep-link.mjs`). Without that variable no link is sent. An agent's reply opens its session thread; questions, approvals and broadcasts open the project chat.

**Phone alerts** (the bell in the header) chooses which notifications buzz: **All**, **Questions and direct replies**, **Questions only**, or **None**. The level is stored in `alerts.json` in the config directory, so hooks, the runner and the UI read the same setting. It applies only on the host where it was set: the file is local and is not published over ntfy, so a level set on one machine does not change alerts from sessions on another. A message the level silences still arrives; its ntfy priority is 1 (listed, no sound) and its Web Push is not sent. Questions cover `ask_question`, terminal question mirrors and approvals; direct replies are agent replies to the operator.

## Look and feel

The UI uses [shadcn/ui](https://ui.shadcn.com/docs) components with Tailwind CSS v4 and the [prompt-kit](https://www.prompt-kit.com/docs) chat components (`chat-container`, `message`, `prompt-input`, `scroll-button`), copied into `web/components/ui/` by the shadcn CLI. `web/app/shadcn.css` vendors the shadcn style's Tailwind variants. Code is highlighted with [shiki](https://shiki.style/guide/regex-engines#javascript-regexp-engine) through prompt-kit's `CodeBlockCode`: fenced blocks in chat Markdown, tool inputs (a shell command as bash, other input as JSON), and tool results whose language is clear (a diff, shell output, a read file by extension, JSON). Shiki loads on first use with its JavaScript regex engine, which needs no `'wasm-unsafe-eval'` in the CSP, and fetches each of its 12 languages (js, ts, jsx, tsx, json, bash, python, diff, markdown, yaml, css, html) on demand. Light and dark colours follow the theme. Only expanded blocks are highlighted, and blocks over 20 KB stay plain text. The theme defaults to dark; the header toggle switches to light or the system setting.
