#!/usr/bin/env bash
# Install prek git hooks (hygiene on pre-commit, Conventional Commits on commit-msg).
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v prek >/dev/null 2>&1; then
  if command -v uv >/dev/null 2>&1; then
    uv tool install --force "prek>=0.5,<0.6"
  else
    echo "Error: install uv (https://docs.astral.sh/uv/) or prek (https://github.com/j178/prek)" >&2
    exit 1
  fi
fi
command -v prek >/dev/null 2>&1 || { echo "Error: prek is not on PATH" >&2; exit 1; }
echo "prek: $(prek --version)"

npm ci
prek install --prepare-hooks --hook-type pre-commit --hook-type commit-msg -f

if prek run --all-files; then
  echo "prek checks passed."
else
  echo "Some checks failed or auto-fixed files; review and commit." >&2
  exit 1
fi
echo "Commit messages: feat:, fix:, docs:, ci:, chore: ... (see cliff.toml)"
