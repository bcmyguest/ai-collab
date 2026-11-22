# Ship the phone loop

Give the operator one place to run, watch and steer a coding agents from a phone.

## Goals

- [x] Runner-owned sessions and durable delivery
- [x] PM mission file read each scheduled tick
- [x] Task board, priorities, and builder units
- [x] OpenShell sandbox for every new builder (ai-collab builder start)
- [x] Code-mode A tool client in sandbox
- [x] Honest job meters for building status
- [ ] Standing goal: keep 4 sandbox builders running each tick; Ready/operator-yes tasks first; top up after merges.

## Rules

- Merge and resolve conflicts in a worktree (`git worktree add`), never in /home/b/ai-collab: the CLI, hooks and OpenCode load code from that checkout, so conflict markers there break every agent. Push the merged result; then pull in /home/b/ai-collab.
- Never hold the builder pool for a merge; merge in parallel.
- Every tick ends with a send_to_all status line: merged, started, running count, and what is waiting on the operator.
- New builders: `ai-collab builder start --task <id> --harness codex --model gpt-6.2-sol --brief <file>` (operator: Codex gpt-6.2-sol for every worker for now; no Cursor or Claude builders) (OpenShell sandbox). Do not start builders on the host. Leave existing host builders alone until they finish.
- Run the isolated suite in a subshell `( ... )` so its HOME/CODEX_HOME never leak into later commands like builder start.
- Gate merges on isolated HOME: `H=$(mktemp -d); PATH=… HOME=$H CODEX_HOME=$H/.codex TMPDIR=$(mktemp -d -p /dev/shm) npm test`.
- Update test assertions when behaviour changes; never weaken tests. No ask_question for test edits.
- Talk to the operator with send_to_all; never route through Claude coordinator. A decision about a task goes on the task: `task_update ask` (with options), not ask_question. Each tick, read answered questions in task_list, act on them, then clear_question.
- Track tasks with task_update + ai-collab task render; do not hand-edit docs/feature-requests.md.
- Before marking done: oncebitten check --base main (when rules exist).
- After every web/UI deploy: `node scripts/smoke-ui.mjs` (headless page load); if it fails, revert and redeploy. Builder briefs for web/ changes must say so.
- Isolated suite gate: use mise-installed node/npm binaries (not mise shims) when TMP HOME breaks mise trust.
- Do not git stash uncommitted work on main; leave it and notify the owner.
