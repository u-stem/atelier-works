#!/usr/bin/env bash
# wmillのワークスペースのプロファイルが無いときの案内を標準出力に書く。
#
# `generate-metadata-staged.sh`と`check-metadata-fresh.sh`が、wmillの出力に
# 「No workspace profile found」があるときに呼ぶ。2つのスクリプトで案内を
# 揃えるため、文面をここに1か所だけ置く。
set -euo pipefail

cat <<'MESSAGE'
wmillのワークスペースのプロファイルがありません(`.wmill`にログイン情報がありません)。
`mise run bootstrap`でログインしてください。git worktreeの中では、`.wmill`がメイン作業ツリーの`.wmill`へのリンクになっているかを確かめてください(`scripts/link-worktree-wmill.sh`で張れます)。
MESSAGE
