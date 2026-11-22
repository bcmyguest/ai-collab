# Tasks

The project task list lives in `<project root>/.ai-collab/tasks.json`. `docs/feature-requests.md` is rendered from it; change tasks through `ai-collab task`, not the markdown.

## File

`{"v": 1, "tasks": [...]}`. A missing file reads as no tasks. An invalid file fails the CLI and the UI shows the error; writes go through a temp file and rename.

| Field | Type |
|---|---|
| `id` | slug: lowercase letters, digits, single hyphens, at most 40 chars |
| `title` | 1-200 chars |
| `status` | `open`, `decided`, `building`, `blocked` or `done` |
| `detail` | optional text, at most 2000 chars |
| `blockers` | ids of tasks this one waits on; each must exist, no cycles |
| `owner` | optional session address, `peer#16-hex-label`, e.g. `claude#0123456789abcdef` |
| `run` | optional team or pattern run id |
| `progress` | `{at, by, text}` entries, `at` in epoch ms |
| `created`, `updated` | epoch ms |

## CLI

```
ai-collab task list [status]
ai-collab task show <id>
ai-collab task add "<title>"
ai-collab task set <id> status=<status>      (also title=, detail=)
ai-collab task block <id> <blocker-id>
ai-collab task progress <id> "<text>"
ai-collab task own <id> <address>
ai-collab task render                        rewrites docs/feature-requests.md
ai-collab task import <feature-requests.md>  refuses when tasks.json exists
```

`task import` ran once for this repo: its table rows became tasks, with the first word of the status cell as the status and the rest as `detail`. A status cell whose first word is no status keeps the whole cell as `detail` under `open`.

## Progress from agents

`send_to_all` with `progress=true` from a session appends its text as a progress entry to each `building` task that session owns. Other statuses and other owners are untouched, and a task-store fault does not fail the post.

## UI

The project view has a Tasks entry in the sidebar. The tab shows:

- **Board**: columns open, decided, building, blocked, done, stacked on a phone and side by side from 768 px. A status filter sits above them. Each card shows the title, id, detail, owner with online or offline, team run, blockers, and the last progress line with its age.
- **Graph**: tasks as nodes, blockers as arrows, colour by status. Layers run down on a phone and right on a wide screen. Done tasks collapse with a button. Tapping a node with an owner or run opens it.

Tapping a card opens its owner's session timeline, or the active session of its team run when no owner is set.

The store is polled once a second, so CLI and agent edits reach open views.

## Limits

- No MCP tools for tasks yet: `test/mcp.test.mjs` pins the tool list.
- A three-wide layer on a 390 px screen scrolls sideways in the graph.
- The team run link opens the run's active session; there is no run page.
- The graph layout is `web/lib/task-graph.js`, self-contained, so a team-graph renderer can replace it.
