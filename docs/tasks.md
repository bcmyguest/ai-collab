# Tasks

The project task list is a store outside git: `$XDG_DATA_HOME/ai-collab/tasks/<project>.json` (default `~/.local/share/ai-collab/tasks/<project>.json`). One file per project, shared by every checkout and worktree. `docs/feature-requests.md` is a committed snapshot rendered from the store with `ai-collab task render`. Change tasks through `ai-collab task` or the MCP tools, not the markdown.

## Store

`{"v": 1, "tasks": [...]}`. A missing file reads as no tasks. An invalid file fails the CLI and MCP calls, and the UI shows the error. Writes take a lock, validate, then rename a temp file over the store.

| Field | Type |
|---|---|
| `id` | slug: lowercase letters, digits, single hyphens, at most 40 chars |
| `title` | 1-300 chars, no line breaks |
| `status` | `open`, `decided`, `building`, `blocked` or `done` |
| `priority` | optional `P0`, `P1`, `P2` or `P3`; a missing priority means `P2` |
| `detail` | optional text, at most 2000 chars, no line breaks |
| `blockers` | ids of tasks this one waits on; each must exist, no cycles |
| `owner` | optional session address, `peer#16-hex-label`, e.g. `claude#0123456789abcdef` |
| `run` | optional run id: 6-32 lowercase letters or digits |
| `progress` | `{at, by, text}` entries, `at` in epoch ms, text at most 500 code points |
| `created`, `updated` | epoch ms |

## Backends

Lib: `lib/tasks.mjs`. Every backend offers `list`, `get`, `add`, `update`, `addProgress` and `replaceAll`. Only `file` exists. A project picks its backend with `"tasks"` in its `projects.json` entry; the default is `file`. A GitHub Issues or Linear backend would implement the same methods.

## CLI

```
ai-collab task list [status]                sorted by priority, then status
ai-collab task show <id>
ai-collab task add "<title>" [--priority P1]  (P0-P3; default P2)
ai-collab task set <id> status=<status>      (also title=, detail=, run=, priority=)
ai-collab task block <id> <blocker-id>
ai-collab task progress <id> "<text>"
ai-collab task own <id> <address>
ai-collab task render                        rewrites docs/feature-requests.md
ai-collab task import <file>                 a feature-requests.md table or a store .json; runs once
```

`task import` refuses when the store exists. The migration from the in-repo `.ai-collab/tasks.json` and the docs table is one import into an empty store; the snapshot is then `task render`.

`task render` replaces only the table between `<!-- tasks:start -->` and `<!-- tasks:end -->`, so prose outside the markers stays. Without markers it writes the full document. The table has a Priority column and is sorted by priority, then status, then most recently updated first; so are `task list`, MCP `task_list` and the board's columns.

## Priority

`priority` is `P0`, `P1`, `P2` or `P3`. A task without one is `P2`, so stores written before priority existed stay valid and the field is never required. Set it with `task add "<title>" --priority P1`, `task set <id> priority=P1`, or MCP `task_update` (`priority`). The order everywhere is priority (P0 first), then status (building, blocked, open and decided share a rank, done), then most recently updated first.

## Status labels

The stored status `decided` displays as **Ready** in the UI: the operator approved the request and it waits for a builder. The store value stays `decided`, so the CLI, MCP and the markdown table keep the stored word.

Import reads the status word of a status cell only when it ends the cell or precedes a separator (`;`, `:`, `,`, `(`). A cell without a status word imports as `done` with the whole cell as `detail`. A two-cell `Request | Status` table (the old shape) still imports, at the default priority.

## MCP tools

- `task_list` (optional `status`): tasks with id, title, priority, status, owner, run, blockers and the last progress entry, sorted by priority then status.
- `task_update` (`id`, plus any of `priority`, `status`, `title`, `detail`, `run`, `owner`, `block_on`, `progress`): one change; the result returns the task and a note when progress text was clipped.

## Progress from agents

`send_to_all` with `progress=true` from a session appends its text to each `building` task that session owns. The attach runs after the post and does not delay the result. The result carries a note when the text was clipped to 500 code points, or when the session owns no building task.

## UI

The project view has a Tasks entry in the sidebar. The tab has two views:

- **Board**: columns open, Ready (stored `decided`), building, blocked, done, stacked on a phone and side by side from 768 px, with a status filter. Each card shows a priority badge, the title, id, detail, owner with online or offline, run, blockers and the last progress line with its age; cards in a column are sorted by priority. Tapping a card opens its owner's session timeline, or the active session of its team run when no owner is set.
- **Graph**: tasks as nodes, blockers as arrows, colour by status; done tasks collapse with a button. Under 600 px the graph is one node per row, in dependency order, with arcs in a left gutter. From 600 px it flows left to right, and an arrow that skips a layer routes around the nodes in between. The layout is `web/lib/task-graph.js`, self-contained, so a team-graph renderer can replace it.

The store file is polled once a second, so CLI and agent edits reach open views. The UI resolves each project's backend when it starts watching the project, so a changed `tasks` setting in projects.json takes effect after a UI restart.

## Limits

- The team run link opens the run's active session; there is no run page.
- The 600 px-and-up graph scrolls sideways when its layers are wider than the screen.
