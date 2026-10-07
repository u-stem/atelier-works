#!/usr/bin/env bash
# Windmillのメタデータ(ロック、scriptのスキーマ、`wmill-lock.yaml`のハッシュ)が
# 古ければpushを失敗させる。メタデータはpre-commitの`wmill-metadata`で
# 最新になっているはずで、これはlefthookを通らなかったコミット(このリポジトリで
# 禁止している`--no-verify`や、フックを飛ばすクライアント)の取りこぼしを止める。
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

# `mise run metadata:check`から呼ぶので、wmillはPATHにある。
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
