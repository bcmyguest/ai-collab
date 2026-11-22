# Ship the phone loop

Give the operator one place to run, watch and steer a coding agents from a phone.

## Goals

- [x] Runner-owned sessions and durable delivery
- [x] PM mission file read each scheduled tick
- [x] Task board, priorities, and builder units
- [x] OpenShell sandbox for every new builder (ai-collab builder start)
- [x] Code-mode A tool client in sandbox
- [ ] Honest job meters for building status

## Rules

- New builders: `ai-collab builder start --task <id> --harness codex --brief <file>` (OpenShell sandbox). Do not start builders on the host. Leave existing host builders alone until they finish.
- Gate merges on isolated HOME: `H=$(mktemp -d); PATH=… HOME=$H CODEX_HOME=$H/.codex TMPDIR=$(mktemp -d -p /dev/shm) npm test`.
- Update test assertions when behaviour changes; never weaken tests. No ask_question for test edits.
- Talk to the operator with send_to_all and ask_question; never route through Claude coordinator.
- Track tasks with task_update + ai-collab task render; do not hand-edit docs/feature-requests.md.
- Before marking done: oncebitten check --base main (when rules exist).
- After every web/UI deploy: `node scripts/smoke-ui.mjs` (headless page load); if it fails, revert and redeploy. Builder briefs for web/ changes must say so.