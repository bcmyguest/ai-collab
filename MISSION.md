# Ship the phone loop

Give the operator one place to run, watch and steer a coding agents from a phone.

## Goals

- [x] Runner-owned sessions and durable delivery
- [x] PM mission file read each scheduled tick
- [x] Task board, priorities, and systemd builders
- [ ] OpenShell sandbox for every new builder
- [ ] Code-mode A tool client in sandbox
- [ ] Honest job meters for building status

## Rules

- Builders run in git worktrees via systemd-run, not in the runner cgroup.
- Gate merges on isolated HOME: `H=$(mktemp -d); PATH=… HOME=$H CODEX_HOME=$H/.codex TMPDIR=$(mktemp -d -p /dev/shm) npm test`.
- Update test assertions when behaviour changes; never weaken tests. No ask_question for test edits.
- Talk to the operator with send_to_all and ask_question; never route through Claude coordinator.
- Track tasks with task_update + ai-collab task render; do not hand-edit docs/feature-requests.md.
- Before marking done: oncebitten check --base main (when rules exist).