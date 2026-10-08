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
# CIでは`ci-metadata-login.sh`がプロファイルを登録するので、プロファイル不在の案内は
# ローカルの分岐にだけ置く。
if [ "${CI:-}" = "true" ]; then
  cat <<'MESSAGE'

Windmillのメタデータが最新ではありません。
ローカルでWindmillを起動した状態(`mise run up`)で`mise run metadata`を実行し、更新されたファイルをコミットしてpushし直してください。
上の出力が古い項目の一覧ではなく、接続やログインのエラーのときは、`Show diagnostics`ステップのサーバーのログを確かめてください。
MESSAGE
elif echo "$output" | grep -q "No workspace profile found"; then
  echo
  "$repo_root/scripts/print-wmill-profile-hint.sh"
else
  cat <<'MESSAGE'

Windmillのメタデータが最新ではありません。
`git commit`し直すとpre-commitフックが自動更新します。手で更新する場合は`mise run metadata`を実行してください。
ローカルWindmillに接続できていない場合は`mise run up`で起動してください。
MESSAGE
fi
exit 1
