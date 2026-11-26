# Development

## Tests

```sh
npm ci
H=$(mktemp -d); HOME=$H CODEX_HOME=$H/.codex npm test
npm run build
```

## Publish build

`npm run build:package` (`tools/build-package.mjs`) writes `dist/`, a complete package with the same paths. It copies the `files` entries, then `tsc -p tsconfig.build.json` replaces each `.ts` module's importers with `.js` and emits the `.mjs` code. Node refuses to strip types under `node_modules`, so the published tarball holds no `.ts` file. The release workflow publishes `./dist`, and `npm pack ./dist` builds the same tarball locally.

Tests use an in-process fake ntfy server (`test/helpers/fake-ntfy.mjs`) and need no network or API access. The empty `HOME` keeps them away from your agent configs, as CI does.

### UI SDK smoke test

```sh
NEXT_PUBLIC_AI_COLLAB_TEST_BRIDGE=1 AI_COLLAB_NEXT_DIST=.next-demo npm run build
AI_COLLAB_NEXT_DIST=.next-demo node tools/smoke-ui.mjs --ui-sdk
```

The browser runs the SDK's `snapshot()` and `act()` against the outcome form, then submits it to a local fixture. The flag exposes `window.aiCollabTestBridge` for test builds. For deployment, run `npm run build` with the flag unset.

### Chat browser checks

```sh
npm run build
AI_COLLAB_BROWSER_TEST=1 node --test --test-concurrency=1 test/chat-*-browser.test.mjs
```

The checks use a 390-pixel viewport and the in-process bus fixture. They cover message routing, urgent sends, edits and cancellation in the queue, draft isolation between project and session chats, image uploads and replies, and send confirmation during a slow team start. Set `CHROME_PATH` if Chromium is outside the Playwright cache.

### celld workflow smoke test

With `celld` and `esbuild` on PATH, run:

```sh
node tools/smoke-celld.mjs
```

Set `CELLD_BIN` to use a specific binary. The smoke test runs the product DOT interpreter in [local celld development mode](https://celld.dev/docs/#develop-an-application-locally) with temporary storage and a loopback fake role gateway. It kills celld after the gateway accepts a role launch and before the workflow records the result, restarts celld, delivers a duplicate handoff event, and checks the completed trace against the compiler. It runs without a bucket, model, credentials or production services.

[celld replays an uncommitted step](https://celld.dev/docs/services/workflows/#replay). The fake gateway deduplicates the retry in memory while celld restarts. A production adapter would have to persist those launch keys across host restarts before taking live traffic.

## Owned-session runner

`runner/` holds the `ai-collab-runner` service skeleton: the adapter contract, a SQLite workflow log, the control socket and a fake adapter. Adapters code against [the owned-sessions contract](owned-sessions-contract.md). Run it with `npm run runner`; `deploy/ai-collab-runner.service` is the user-unit template.

### Schedules

The runner runs the commands in `~/.config/ai-collab/schedules.json` on a timer: a JSON array of `{name, everyMinutes, cwd, command, timeoutSec, wakeOnTasks, workspace}`. `wakeOnTasks` names a project: when one of its tasks moves to `done` or `blocked`, the runner starts the schedule at once (checked every 15 s, retried while a tick still runs), so the PM hands off the next task without waiting for the timer. Each tick is a durable workflow whose id starts at most once while `runner.db` is intact; a start after downtime runs only the latest due tick. An invalid entry is reported in `configError` and skipped. Keys, the skip and cut rules, and the control routes are in [Scheduled workflows](owned-sessions-contract.md#scheduled-workflows). `GET /v1/schedules` and `POST /v1/schedules/:name/run` on the control socket show and trigger them.

A tick's command runs in its own transient systemd user scope, the same wrapper a start from the phone uses (`runner/schedules.mjs` calls `lib/sessions.ts`), so an agent a tick started survives `systemctl --user restart ai-collab-runner`. `timeoutSec` is passed to the scope as `RuntimeMaxSec` as well as enforced by the runner, so a command cut off by a restart is still held to its deadline. The runner's timeout and abort still send SIGTERM to the command's process group, which reaches a scoped payload because the scope execs in place. Without systemd, or with `AI_COLLAB_SCOPE=off`, the command is spawned detached exactly as before.

Migrate the feature-request PM tick from the `ai-collab-pm.timer` systemd user timer. The runner must run first: its unit is a template and not installed.

1. Read the timer and its service without changing them: `systemctl --user cat ai-collab-pm.timer ai-collab-pm.service`.
2. Write `~/.config/ai-collab/schedules.json` with one entry named `pm`. Set `everyMinutes` to the timer's interval, and copy `cwd` and `command` from the service's `WorkingDirectory` and `ExecStart`. Set `timeoutSec` to at least the service's `TimeoutStartSec`.
3. Disable the timer before the schedule runs, so the PM tick does not run twice: `systemctl --user disable --now ai-collab-pm.timer`.
4. Restart the runner to load the file: `systemctl --user restart ai-collab-runner.service`.
5. Check the schedule: `curl --unix-socket "$XDG_RUNTIME_DIR/ai-collab/runner.sock" http://runner/v1/schedules`. `configError` must be empty.
6. Run a tick now: `curl -X POST --unix-socket "$XDG_RUNTIME_DIR/ai-collab/runner.sock" "http://runner/v1/schedules/pm/run?caller=migration"`. Check that `last.status` is `SUCCESS` and `last.output.ok` is `true`.
7. After a clean tick, remove the timer and service units and run `systemctl --user daemon-reload`.

Rollback: remove the `pm` entry, then re-enable the timer with `systemctl --user enable --now ai-collab-pm.timer`.

### Starting builders from the PM

Allow the `builder_start` tool on the `ai-collab` MCP server in the host PM's tool guard. Pass the task ID as `task`, the brief itself as `brief` (up to 4,000 characters), and the calling PM's 16-character lowercase hexadecimal hook label as `session`. Start the brief with a heading or sentence. For Codex, the brief and the appended sandbox notes must fit within 4,000 characters.

```json
{"task":"fix-build","brief":"Fix the failing build and run the test suite.","session":"0123456789abcdef","harness":"codex","model":"gpt-6.2-sol"}
```

To read a brief from a file, use `ai-collab builder start --task <id> --brief <file>` on the host.

`harness` and `model` use the CLI defaults when omitted. The tool uses the PM's configured project and returns the task, sandbox, worktree, branch, and either the runner session or the systemd unit. It applies the same project pause and sandbox capacity checks as `ai-collab builder start`. The tool is available through direct host MCP calls. The code-mode allowlists exclude builder launches, and sandboxed builders and scheduled ticks have no direct `builder_start` tool.

## Git hooks

Run `./setup_prek.sh` once. It installs [prek](https://github.com/j178/prek) (through `uv`), runs `npm ci`, and installs two git hooks from `.pre-commit-config.yaml`: whitespace and JSON/YAML checks on `pre-commit`, and [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) on `commit-msg` (`feat:`, `fix:`, `docs:`, `ci:`, `chore:` ...). Run `prek run --all-files` to check the whole repo as CI does.

### Protected main

`./setup_prek.sh` also runs `scripts/install-git-hooks.sh`, which prek cannot do. It copies `scripts/git-hooks/reference-transaction` into the repository's hooks directory (`.git/hooks/`, shared by every worktree) and sets `pull.rebase=false` and `pull.ff=only` in the repository config. The hook aborts any update of `refs/heads/main` whose new commit does not descend from the current one, and any delete of it, so `git update-ref`, `git reset`, `git commit --amend` and a rebase cannot move main backward or drop unpushed commits. Commits on top of main, `git pull --ff-only`, `git pack-refs` and `git gc` still work, and other branches are not checked. Without the pull settings, a global `pull.rebase=true` would turn a plain `git pull` into a rebase that the hook refuses halfway, leaving HEAD detached.

Rerun `scripts/install-git-hooks.sh` after the hook changes.

The PM lands builder branches with `ai-collab merge start <branch>...` on the host. The command fetches `origin/main`, merges the requested branches in order in a fresh worktree, and runs `npm ci` and `npm test` with isolated `HOME`, `CODEX_HOME`, and `TMPDIR`. After the gate passes, it pushes the tested commit, verifies the remote tip, attempts `git pull --ff-only` in `/home/b/ai-collab`, and cleans up the merge worktree. When that pull succeeds, it runs `npm run build -- --deploy-and-verify` in the host checkout, which builds the UI, restarts `ai-collab-ui`, and verifies it. When the pull is skipped, it does not deploy the stale checkout and prints why. A refusal after worktree creation reports the retained worktree path. Once npm starts, the refusal also includes the path to a log with stdout and stderr from each npm step.

### Merge gate triage

- **Branch moved past the submitted commit.** Review the current builder tip before submitting it for landing. The gate checks the expected tip before creating a worktree.
- **Branch does not merge cleanly.** The gate attempts to abort the failed merge and retains the worktree with any earlier successful merges from the batch. Give the coordinator the worktree path and failed branch. After resolving the conflict, rerun the isolated host gate on the resulting commit before pushing.
- **npm missing or install failed.** Check the PM service's Node installation and PATH. The gate prefers npm bundled with Node and can resolve mise's Node before replacing HOME. Read the `npm ci` output for registry, dependency, or lockfile errors. If temporary directory creation fails, check that the service can write to `/dev/shm`.
- **Tests failed or modified tracked files.** Inspect the npm output and retained worktree. Fix the failing test or the step that changes tracked files, then rerun the host gate for the corrected commit. Builder tests serve as a preflight.
- **Push or remote verification failed.** Fetch and inspect `origin/main` before retrying. A verification failure can follow a successful push if another update advances the remote. If the tested commit is already in the remote history, it has landed. Otherwise, rebuild and retest against the current remote tip.
- **Host pull skipped.** The remote push has been verified. The UI deploy does not run. Use the reported Git error to diagnose the host checkout and preserve local edits while reconciling it.

To land other work by hand, use a worktree:

```sh
git worktree add -b fix/<name> ~/ai-collab-wt-<name> origin/main
git -C ~/ai-collab-wt-<name> push origin HEAD:main
git -C /home/b/ai-collab pull --ff-only
git -C /home/b/ai-collab ls-remote origin refs/heads/main   # confirm the pushed sha
```

## CI

`.github/workflows/tests.yml` runs prek, `npm test` with an empty `HOME`, and `npm run build` on every push and pull request.

`.github/workflows/pages.yml` builds this site from `docs/*.md` with Astro and Starlight in `site/` and deploys it to GitHub Pages on a push to `main` that touches `docs/`, `site/`, or the workflow. Build it locally with Node 24 and pnpm:

```sh
cd site
pnpm install
pnpm test     # sync and link-checker unit tests
pnpm build    # sync docs, check theme contrast, build, check every internal link
```

`pnpm build` fails on a broken relative link in `docs/*.md`, a theme colour pair under WCAG AA contrast, or a broken link or anchor in `dist/`. Add a page by writing `docs/<name>.md` and listing it in `PAGES` in `site/scripts/lib/docs.mjs`.

## Releases

Releases are manual. Run the **Prepare release** workflow on `main` (tick `dry_run` to preview). git-cliff (`cliff.toml`) computes the next version from the commits since the last tag: `feat` bumps the minor version, `fix` the patch, and `!` or `BREAKING CHANGE` the minor version below 1.0.0. The workflow writes that version into `package.json`, `package-lock.json`, and the three `*-plugin/plugin.json` manifests, commits `chore(release): vX.Y.Z`, tags it, and dispatches **Release**, which checks the manifests against the tag, re-runs tests and build, publishes a GitHub Release with git-cliff notes, and publishes the package to npm. The npm job uses npm trusted publishing: npm accepts the OIDC token of `release.yml` on `bcmyguest/ai-collab`, so the repository holds no npm token. npm already has 0.9.0, so the next release must bump past it.

## Re-record the demo

```sh
npm ci
npm run demo                  # next build web, then scripts/demo/record.mjs → docs/demo.gif
```

`scripts/demo/record.mjs` runs the built UI against the in-process bus (`test/helpers/fake-ntfy.mjs`) with a throwaway `HOME` and project `calc-demo`, so it touches no real topic, config or session. Real hook processes (`scripts/ai-collab-hook.mjs` with fake payloads) and `sendMessage` drive `scripts/demo/scenario.mjs`; a screenshot loop records a 390×844 dark phone viewport at 2× and `scripts/demo/encode.mjs` adds captions, zooms and 3× fast-forward and writes the GIF (10 fps, changed pixels only). Beats the UI lacks (approval card, Home) are skipped and listed. Options: `node scripts/demo/record.mjs --out /tmp/demo.gif --keep` keeps the frames; `node scripts/demo/encode.mjs <frames-dir> out.gif --stills 5,12` re-encodes them and writes PNG stills to check. Set `DEMO_CHROME` to pick a Chromium binary; by default it uses `~/.cache/ms-playwright/chromium-*`.
