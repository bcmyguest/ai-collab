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

- Leave ai-collab-runner active so the current PM tick can finish. When merged runner code needs loading, report that a runner restart is wanted. The coordinator restarts it between ticks.
- Restarting ai-collab-ui is fine.
- Run `ai-collab merge start builder/<name>` on the PM host. It fetches origin/main, creates a fresh merge worktree, merges the builder branch and runs the isolated host gate.
- Run the host gate with the installed Node and npm binaries. The smaller sandbox test suite is insufficient for the host gate.
- On green, the command pushes the tested commit and prints the host pull, UI deploy and smoke commands. It cleans up the merge worktree and branch on success. Never check out `main` in a second worktree (no `-f`): moving main from elsewhere leaves /home/b/ai-collab's files stale.
- Merge and resolve conflicts in a worktree (`git worktree add`), never in /home/b/ai-collab: the CLI, hooks and OpenCode load code from that checkout, so conflict markers there break every agent. Push the merged result; then pull in /home/b/ai-collab.
- If the merge gate refuses after creating a worktree, hand it to the coordinator. See [merge gate triage](docs/development.md#merge-gate-triage). Resolve conflicts there or in a fresh worktree from origin/main, then rerun the isolated gate before pushing.
- After landing, verify origin/main, mark tasks done, render the board and clean up stale builder worktrees.
- Never hold the builder pool for a merge; merge in parallel.
- Read the builder failure before retrying. Keep a usage-limit verdict and reset time on the existing task. Retry with another operator-approved model or after reset, and continue landing eligible changes.
- The operator has approved moving eligible reviews to done while the coordinator lands their branches asynchronously. Verify origin/main before reporting a branch as shipped.
- Every tick ends with a send_to_all status line: merged, started, running count, and what is waiting on the operator.
- New builders: `ai-collab builder start --task <id> --harness codex --model gpt-6.2-sol --brief <file>` (operator: Codex gpt-6.2-sol for every worker for now; no Cursor or Claude builders) (OpenShell sandbox). Do not start builders on the host. Leave existing host builders alone until they finish.
- Each task starts with `ai-collab team start product pm "<task>"`: the PM checks the vision, engineering does the work, and review reports to the PM. Every few tasks the PM hands notes to the CEO, who does not see every task.
- If `ai-collab pattern runs` shows no running review, start one with `ai-collab team start review reviewer "<task>"` on a Ready task that has a diff to review. Do not start a team for a task id ending in -wt and a number. Do not replace a builder that committed nothing.
- Run the isolated suite in a subshell `( ... )` so its HOME/CODEX_HOME never leak into later commands like builder start.
- Gate merges on isolated HOME: `H=$(mktemp -d); PATH=… HOME=$H CODEX_HOME=$H/.codex TMPDIR=$(mktemp -d -p /dev/shm) npm test`.
- Update test assertions when behaviour changes; never weaken tests. No ask_question for test edits.
- Talk to the operator with send_to_all; never route through Claude coordinator. A decision about a task goes on the task: `task_update ask` (with options), not ask_question. Each tick, read answered questions in task_list, act on them, then clear_question.
- Track tasks with task_update + ai-collab task render; do not hand-edit docs/feature-requests.md.
- Before marking done: oncebitten check --base main (when rules exist).
- After every web/UI deploy, run `node deploy/verify-ui.mjs` for the headless smoke and decision inbox check, or use `npm run build -- --deploy-and-verify` to build, restart the UI service, and verify. On failure, revert and redeploy. Builder briefs for web/ changes must say so.
- Isolated suite gate: use mise-installed node/npm binaries (not mise shims) when TMP HOME breaks mise trust.
- Run `git -C /home/b/ai-collab stash` only when the operator explicitly requests it in a DM or broadcast. Otherwise, leave uncommitted work on main in place and notify the owner.
