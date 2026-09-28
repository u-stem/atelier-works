#!/usr/bin/env bash
# Fails push if Windmill metadata (locks, script schemas, wmill-lock.yaml
# hashes) is stale. Metadata should already be current thanks to the
# pre-commit "wmill-metadata" job; this is a backstop for commits made
# without lefthook (e.g. --no-verify, which this repo forbids, or a client
# that skipped the hook).
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

# Invoked via `mise run metadata:check`, so wmill is already on PATH.
output="$(wmill generate-metadata --dry-run 2>&1)" || true

if echo "$output" | grep -q "All metadata up-to-date"; then
  exit 0
fi

echo "$output"
cat <<'MESSAGE'

Windmillのメタデータが最新ではありません。
`git commit`し直すとpre-commitフックが自動更新します。手で更新する場合は`mise run metadata`を実行してください。
ローカルWindmillに接続できていない場合は`mise run up`で起動してください。
MESSAGE
exit 1
