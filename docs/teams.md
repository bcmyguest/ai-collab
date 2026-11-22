# Teams and patterns

A pattern names roles and the handoffs between them. A team is a legacy pattern: one role per member, no handoffs, no runs.

## Model

Abbreviated; the shipped `fix-and-review` is in `lib/patterns.mjs` (`BUILT_IN_PATTERNS`).

```json
{
  "name": "fix-and-review",
  "roles": [
    { "id": "lead", "responsibility": "Scope the task.", "harness": "claude", "model": "claude-haiku-5-5" }
  ],
  "handoffs": [
    { "from": "reviewer", "to": "implementer", "on": "changes requested", "required": false, "cap": 3 },
    { "from": "reviewer", "to": "lead", "on": "approved", "required": true },
    { "from": "lead", "to": "done", "on": "finished", "required": false }
  ]
}
```

- `roles`: 1-8 roles. `id` is `[a-z][a-z0-9-]{0,23}`; `responsibility` is 1-1000 characters; `harness` is `claude`, `codex`, `cursor` or `opencode`; `model` is optional and checked against `listModels`.
- `handoffs`: `from` and `to` name a role (`to` may be `done`); `on` is the event name (1-60 characters, unique per `from`); `required` is `true` or `false`; `cap` (1-10) limits how often a role-to-role handoff fires in one run.
- The first role is the entry role. Every role must be reachable from it, and at least one handoff must go to `done`.
- Names: a pattern may not use `all`, `operator`, `done`, a harness name, or a peer in `AI_COLLAB_PEERS`. A pattern and a team may not share a name.
- Saved patterns are validated on every listing. A pattern that fails shows `invalid: <reason>` in `pattern list` and cannot start.

## Enforcement

- `required: true`: the run finishes only after this handoff has fired in the run. `finished` before that is refused and names the missing handoff.
- `required: false` (guidance): the active role may skip it; the runtime does not require it.
- A handoff past its `cap` fails the run and notifies the operator.
- A role whose session cannot start fails the run with the reason and notifies the operator.
- Only the active role's session can advance a run. The operator's UI can override and records the operator's login on the handoff.
- A run uses the pattern snapshot taken at start; later edits to the saved pattern do not change it.
- Handoff notes reach the next role labeled as untrusted data.
- A finished or failed run sends each role's session a closing message ("Stop work on this run"). The operator gets a project broadcast on failure.
- Starts, including handoff launches, share one 10-second gate per project. `pattern start`, `@pattern` chats and the UI all use it.

## Runs

`pattern start <name> "<task>"` creates a run with the entry role active and starts that role's session with the task and its allowed events. `pattern advance <run> "<event>" ["note"]` takes the active role's handoff named by the event, from the active role's own session. The next role's session receives an ai-collab message; a role with no session yet starts one.

Run state: `<stateDir>/<project>/pattern-runs/<run>.json`. `pattern status <run>` lists the role sessions, notes and handoff log.

## Storage

- Project: a `patterns` map in the project's entry in `projects.json`.
- Global: `patterns.json` in the config directory.
- Built-in: `fix-and-review`. Lead and implementer on `claude:claude-haiku-5-5`; reviewer on `cursor:deepseek-v41-flash-1017-high`. The cursor id is not in the repo's model lists and was not checked against `cursor-agent --list-models`. A saved pattern with the same name overrides the built-in.
- Teams stay in the `teams` maps and appear in pattern listings with `source: team`.

## Surfaces

- CLI: `ai-collab pattern list|show|create|delete|start|runs|status|advance`. `pattern start` is for the operator's shell.
- MCP: `pattern_list` and `pattern_status` read; `pattern_advance` acts for the calling session; `pattern_start` returns an error to agents (operator-only).
- Chat: `@<pattern> <task>` starts a run; the text after the tag is the task.
- Web: the sidebar section "Patterns and teams" has a Create button that opens the pattern builder: roles, handoffs, a required/guidance toggle, and an optional cap. Renaming a role updates its handoffs. The sidebar lists patterns, teams and runs (active role and handoff log).

## Legacy team roster in the UI

The UI no longer has a roster form for teams. Teams still work: `ai-collab team create|list|delete|start|status`, the MCP `team_*` tools, and `@team` chats. Create new coordination as a pattern.
