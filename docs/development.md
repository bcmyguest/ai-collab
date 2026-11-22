# Development

## Tests

```sh
npm ci
H=$(mktemp -d); HOME=$H CODEX_HOME=$H/.codex npm test
npm run build
```

Tests use an in-process fake ntfy server (`test/helpers/fake-ntfy.mjs`) and need no network or API access. The empty `HOME` keeps them away from your agent configs, as CI does.

## Owned-session runner

`runner/` holds the `ai-collab-runner` service skeleton: the adapter contract, a SQLite workflow log, the control socket and a fake adapter. Adapters code against [the owned-sessions contract](owned-sessions-contract.md). Run it with `npm run runner`; `deploy/ai-collab-runner.service` is the user-unit template.

### Schedules

The runner runs the commands in `~/.config/ai-collab/schedules.json` on a timer: a JSON array of `{name, everyMinutes, cwd, command, timeoutSec, wakeOnTasks}`. `wakeOnTasks` names a project: when one of its tasks moves to `done` or `blocked`, the runner starts the schedule at once (checked every 15 s, retried while a tick still runs), so the PM hands off the next task without waiting for the timer. Each tick is a durable workflow whose id starts at most once while `runner.db` is intact; a start after downtime runs only the latest due tick. An invalid entry is reported in `configError` and skipped. Keys, the skip and cut rules, and the control routes are in [Scheduled workflows](owned-sessions-contract.md#scheduled-workflows). `GET /v1/schedules` and `POST /v1/schedules/:name/run` on the control socket show and trigger them.

A tick's command runs in its own transient systemd user scope, the same wrapper a start from the phone uses (`runner/schedules.mjs` calls `lib/scope.mjs`), so an agent a tick started survives `systemctl --user restart ai-collab-runner`. `timeoutSec` is passed to the scope as `RuntimeMaxSec` as well as enforced by the runner, so a command cut off by a restart is still held to its deadline. The runner's timeout and abort still send SIGTERM to the command's process group, which reaches a scoped payload because the scope execs in place. Without systemd, or with `AI_COLLAB_SCOPE=off`, the command is spawned detached exactly as before.

Migrate the feature-request PM tick from the `ai-collab-pm.timer` systemd user timer. The runner must run first: its unit is a template and not installed.

1. Read the timer and its service without changing them: `systemctl --user cat ai-collab-pm.timer ai-collab-pm.service`.
2. Write `~/.config/ai-collab/schedules.json` with one entry named `pm`. Set `everyMinutes` to the timer's interval, and copy `cwd` and `command` from the service's `WorkingDirectory` and `ExecStart`. Set `timeoutSec` to at least the service's `TimeoutStartSec`.
3. Disable the timer before the schedule runs, so the PM tick does not run twice: `systemctl --user disable --now ai-collab-pm.timer`.
4. Restart the runner to load the file: `systemctl --user restart ai-collab-runner.service`.
5. Check the schedule: `curl --unix-socket "$XDG_RUNTIME_DIR/ai-collab/runner.sock" http://runner/v1/schedules`. `configError` must be empty.
6. Run a tick now: `curl -X POST --unix-socket "$XDG_RUNTIME_DIR/ai-collab/runner.sock" "http://runner/v1/schedules/pm/run?caller=migration"`. Check that `last.status` is `SUCCESS` and `last.output.ok` is `true`.
7. After a clean tick, remove the timer and service units and run `systemctl --user daemon-reload`.

Rollback: remove the `pm` entry, then re-enable the timer with `systemctl --user enable --now ai-collab-pm.timer`.

## Git hooks

Run `./setup_prek.sh` once. It installs [prek](https://github.com/j178/prek) (through `uv`), runs `npm ci`, and installs two git hooks from `.pre-commit-config.yaml`: whitespace and JSON/YAML checks on `pre-commit`, and [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) on `commit-msg` (`feat:`, `fix:`, `docs:`, `ci:`, `chore:` ...). Run `prek run --all-files` to check the whole repo as CI does.

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

`scripts/demo/record.mjs` runs the built UI against the in-process fake ntfy (`test/helpers/fake-ntfy.mjs`) with a throwaway `HOME` and project `calc-demo`, so it touches no real topic, config or session. Real hook processes (`scripts/ai-collab-hook.mjs` with fake payloads) and `sendMessage` drive `scripts/demo/scenario.mjs`; a screenshot loop records a 390×844 dark phone viewport at 2× and `scripts/demo/encode.mjs` adds captions, zooms and 3× fast-forward and writes the GIF (10 fps, changed pixels only). Beats the UI lacks (approval card, Home) are skipped and listed. Options: `node scripts/demo/record.mjs --out /tmp/demo.gif --keep` keeps the frames; `node scripts/demo/encode.mjs <frames-dir> out.gif --stills 5,12` re-encodes them and writes PNG stills to check. Set `DEMO_CHROME` to pick a Chromium binary; by default it uses `~/.cache/ms-playwright/chromium-*`.
