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

- Never run `systemctl --user restart ai-collab-runner` (or stop it): a runner restart kills the PM tick that the runner started, so the tick dies mid-work and no builders start. When merged runner code needs loading, say so in the tick status ("runner restart wanted") and the coordinator restarts it between ticks. Restarting ai-collab-ui is fine.
- Run `ai-collab merge start builder/<name>` on the PM host. It fetches `origin/main` from `/home/b/ai-collab`, creates a separate `merge/*` worktree, merges the local builder branch, installs dependencies and runs the isolated `npm test` gate against the merged files. The host gate runs about 1215 tests. Builder sandbox worktrees run about 875 tests and are not valid gates. Launch the CLI with the mise-installed Node binary so its bin directory supplies npm under the temporary HOME.
- On green, the command pushes the tested commit and prints the host pull, UI deploy and smoke commands. It leaves the merge worktree and branch for inspection. Never check out `main` in a second worktree (no `-f`): moving main from elsewhere leaves /home/b/ai-collab's files stale.
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
- After every web/UI deploy, run `node deploy/verify-ui.mjs` for the headless smoke and decision inbox check, or use `npm run build -- --deploy-and-verify` to build, restart the UI service, and verify. On failure, revert and redeploy. Builder briefs for web/ changes must say so.
- Isolated suite gate: use mise-installed node/npm binaries (not mise shims) when TMP HOME breaks mise trust.
- Do not git stash uncommitted work on main; leave it and notify the owner.
