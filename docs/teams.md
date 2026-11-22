# Teams and patterns

A pattern names roles and the handoffs between them. A team is a legacy pattern: one role per member, no handoffs.

## Model

Abbreviated; `fix-and-review` ships in full in `lib/patterns.mjs`.

```json
{
  "name": "fix-and-review",
  "roles": [
    { "id": "lead", "responsibility": "Scope the task.", "harness": "claude", "model": "haiku" }
  ],
  "handoffs": [
    { "from": "reviewer", "to": "implementer", "on": "changes requested", "required": false, "cap": 3 },
    { "from": "reviewer", "to": "lead", "on": "approved", "required": true },
    { "from": "lead", "to": "done", "on": "finished", "required": false }
  ]
}
```

- `roles`: 1-8 roles. `id` is `[a-z][a-z0-9-]{0,23}`; `responsibility` is 1-1000 characters; `harness` is `claude`, `codex`, `cursor` or `opencode`; `model` is optional and checked against the model list.
- `handoffs`: `from` and `to` name a role (`to` may be `done`); `on` is the event name (1-60 characters, unique per `from`); `required` is a boolean; `cap` (1-10) limits how often a role-to-role handoff fires in one run.
- The first role is the entry role. Every role must be reachable from it, and at least one handoff must go to `done`.

## Enforcement

- A run finishes only through a handoff to `done`, and only after every `required` handoff has fired at least once in that run. Otherwise the run refuses the finish and names the missing handoff.
- A handoff past its `cap` fails the run.
- `guidance` handoffs are advisory: the active role may take any of its handoffs, and the runtime does not require them.

## Runs

`pattern start <name> "<task>"` creates a run with the entry role active and starts that role's session with the task and its allowed events. `pattern advance <run> "<event>" ["note"]` takes the active role's handoff named by the event. The next role's session receives an ai-collab message; a role with no session yet starts one. State lives under `<stateDir>/<project>/pattern-runs/<run>.json`.

## Storage

- Project: `patterns` map in the project's entry in `projects.json`.
- Global: `patterns.json` in the config directory.
- Built-in: `fix-and-review`: lead and implementer on `claude:claude-haiku-5-5`, reviewer on `cursor:deepseek-v41-flash-1017-high`. A saved pattern with the same name overrides it.
- Teams stay in `teams` maps and appear in pattern listings with `source: team`.

## Surfaces

- CLI: `ai-collab pattern list|show|create|delete|start|runs|status|advance`.
- MCP: `pattern_list`, `pattern_start`, `pattern_status`, `pattern_advance`.
- Chat: `@<pattern> <task>` starts a run in any chat.
- Web: Teams → Create builds a pattern (roles, handoffs, required/guidance toggle, cap) with a handoff list; the sidebar lists runs with the active role and the handoff log.
