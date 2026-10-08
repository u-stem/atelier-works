#!/usr/bin/env bash
# コミットメッセージの1行目がConventional Commitsの形か検査する。
#   <type>(<scope>)?!?: <description>
# typeはfeat・fix・docs・refactor・test・choreのどれか。
# gitやlefthookが作る、"Merge "・"Revert "・"fixup! "・"squash! "で始まる
# 行は対象外。
set -euo pipefail

commit_msg_file="${1:-}"
if [ -z "$commit_msg_file" ]; then
  echo "Usage: check-commit-msg.sh <commit-msg-file>" >&2
  exit 1
fi

first_line="$(head -n 1 "$commit_msg_file")"

case "$first_line" in
  "Merge "* | "Revert "* | "fixup! "* | "squash! "*)
    exit 0
    ;;
esac

pattern='^(feat|fix|docs|refactor|test|chore)(\([a-z0-9._/-]+\))?!?: .+'
if [[ "$first_line" =~ $pattern ]]; then
  exit 0
fi

cat >&2 <<'MESSAGE'
コミットメッセージが規約(Conventional Commits)に沿っていません。

形式: <type>(<scope>)?: <説明>
  typeはfeat / fix / docs / refactor / test / choreのいずれか
  例:   feat: Issue取り込みスクリプトを追加
  例:   fix(scripts): 型アサーション検出の誤検知を修正

Merge / Revert / fixup! / squash! で始まるコミットは対象外です。
MESSAGE
exit 1
