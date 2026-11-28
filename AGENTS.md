# Agent skills

Load `antislop` on every session. It is a filter.

- `antislop-ui` when the change is visible UI.
- `antislop-layoutmobile` when layout must reflow across phone and desktop.
- `antislop-human` when the work is accessibility or focus.
- `antislop-code` when cleaning comments.
- `ui-sdk` for web UI component work. Read `node_modules/@ui-sdk/react/docs/llms.txt` for the installed version's API, then the relevant component docs.

# Local notes

If `AGENTS.local.md` exists at the repo root, read it and follow it. It holds this machine's private notes and is not committed.

# Child agents

A session started with `spawn_agent` follows these rules. The oncebitten rules in `.oncebitten/rules/` enforce the first four for every agent in this repo.

- Never restart, stop or kill `ai-collab-bus`, `ai-collab-ui` or `ai-collab-runner`: it ends every running agent's turn. Ask your parent or the operator; auto-deploy restarts after a land once no turn is in flight (`no-service-restart`).
- Never push `main`. Push your branch, rebased onto `origin/main` (`no-push-main`).
- You may change the live config under `~/.config/ai-collab/`: first copy the file to `<file>.bak-<unix time>`, then report the file, the change and the backup path to your parent and the operator (`live-config-backup`).
- Add new test files freely. To change an existing test or golden, write a patch under `$CLAUDE_JOB_DIR/tmp/` (else `/tmp/dbg/tmp/`), say why the old assertion is wrong, and report its path (`existing-test-patch`).
- Work in a worktree (`spawn_agent` with `worktree: true`). The child's branch starts from the parent's branch, and the runner merges each successful run back into it; see [One branch per thread](docs/threads.md#one-branch-per-thread). Commit before your run ends, or the merge waits.
- End each run with a report: the branch, the commits, and the pass and fail counts of the tests you ran.
