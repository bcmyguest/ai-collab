#!/usr/bin/env bash
# Install the reference-transaction hook (prek cannot manage it) and make a plain git pull fast-forward only.
set -euo pipefail

cd "$(dirname "$0")/.."
hooks="$(git rev-parse --path-format=absolute --git-path hooks)"
mkdir -p "$hooks"
install -m 755 scripts/git-hooks/reference-transaction "$hooks/reference-transaction"
# A global pull.rebase=true would otherwise rebase main and leave HEAD detached when the hook refuses it.
git config pull.rebase false
git config pull.ff only
echo "Installed $hooks/reference-transaction: main moves only forward; git pull is fast-forward only."
