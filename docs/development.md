# Development

## Tests

```sh
npm ci
H=$(mktemp -d); HOME=$H CODEX_HOME=$H/.codex npm test
npm run build
```

Tests use an in-process fake ntfy server (`test/helpers/fake-ntfy.mjs`) and need no network or API access. The empty `HOME` keeps them away from your agent configs, as CI does.

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
