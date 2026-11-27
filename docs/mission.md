# PM mission file

`MISSION.md` at the project root is the file the PM owns and edits: its mission, its goals and the rules it works under. It is committed to git, so every version of the plan is in the history, and the runner appends it to the prompt of every scheduled tick, so the PM reads the current file each time instead of working from a prompt copied into `schedules.json`. After the mission, each tick also gets the [run review](#the-run-review): a closing instruction to review the run and keep its lessons in openmem and this file.

The file is the PM's to write. Any agent or a human can edit it with an editor; `ai-collab mission` changes it without hand-writing the format.

## Format

````markdown
# Ship the phone loop

Give the operator one place to run, watch and steer a team of coding agents from a phone.

## Goals

- [x] Runner-owned sessions
- [ ] PM reads a mission file each tick
- [ ] Hand off a task without a timer

## Rules

- Builders run in git worktrees, never in the main checkout.
- Run tests with an empty `HOME`.
- Do not edit an existing test assertion without the operator's approval.
````

| Part | Shape |
|---|---|
| Title | `# <title>`, the first line, 1-200 characters |
| Mission | The prose from the title to `## Goals`; a blank line separates paragraphs |
| `## Goals` | A `- [ ] text` or `- [x] text` line per goal; at most 40 |
| `## Rules` | A `- text` line per rule; at most 40 |

Each line of the prose, a goal and a rule is at most 300 characters and has no control characters. The file is at most 16 KB, since the whole of it goes into a prompt. A heading other than the title, `## Goals` and `## Rules` is an error, as is a second copy of either section or `## Rules` before `## Goals`.

A missing file is not an error: the tick runs without it and logs that. An invalid file is not an error either: the tick logs the file and line and runs without it, so a typo in the mission cannot stop the PM.

## CLI

```
ai-collab mission show                    # the parsed file as JSON
ai-collab mission check                   # the file parses, with its counts
ai-collab mission add-goal "<text>"
ai-collab mission done-goal <n>           # 1-based, as `mission show` lists them
ai-collab mission open-goal <n>
ai-collab mission remove-goal <n>
ai-collab mission add-rule "<text>"
ai-collab mission remove-rule <n>
```

Every command except `show` and `check` rewrites the file in its canonical form: goals then rules, one trailing newline, no trailing spaces. The rewrite is a temp file and a rename under a lock, so a reader never sees half a file. Each `add` and `done` prints the new file, which is the diff a commit message needs.

## The tick

`runner/schedules.ts` resolves which project a schedule's `cwd` lies in (`projectOfFolder`) and appends the rendered mission to the last argument of the command — the prompt, for a harness command. A command whose binary is not a harness (`node`, `npx`, a shell script) is left exactly as `schedules.json` wrote it, because its argv is not a prompt. A `pm` schedule with `workspace` reads `MISSION.md` from that clone instead of the registered project root, and runs the command there. `cwd` still names the project.

The result: edit `MISSION.md`, commit it, and the next tick sees it. Nothing in `schedules.json` has to change, and the prompt is never two versions behind the file.

## The run review

Every scheduled harness command gets one more block after the mission: the run review (`lib/pm-review.ts`, `withReview`). The mission says what to aim at; the review asks for a closing account of how the run went:

- A short review of the run — at most three lines: what worked, what did not, what to do differently — posted last, so the operator reads it in the phone chat.
- Lessons kept before the run stops: a fact about the setup goes to openmem under the project's bank (`coding-agent::<project>`), and a standing rule goes into `MISSION.md` with `ai-collab mission add-rule` (or a new file when the project has none). Work left open becomes a task.
- Each lesson recorded once. At 40 rules the file is full, so a lesson replaces or drops a rule instead of adding another.

The review is appended after the mission, so it is the last thing the prompt says, and a plain script (`node`, a shell script) gets neither block. `reviewBlock()` is the text; `withReview()` is what `tickFn` calls. The runner records no copy of a review: the review is a chat post and the lessons live in openmem and git.

## Limits

- One mission file per project, at the root. A schedule whose `cwd` is outside every registered project gets no mission appended.
- The file goes into the prompt at the size it is; a 16 KB mission is 16 KB of every tick's prompt.
- No history of its own. Use `git log -p MISSION.md` and `git blame`; the runner keeps no copy.
