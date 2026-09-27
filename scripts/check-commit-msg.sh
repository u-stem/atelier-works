#!/usr/bin/env bash
# Enforces Conventional Commits on the first line of a commit message:
#   <type>(<scope>)?!?: <description>
# type is one of: feat, fix, docs, refactor, test, chore.
# Lines starting with "Merge ", "Revert ", "fixup! ", or "squash! " are
# exempt (git- and lefthook-generated commits).
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
  type は feat / fix / docs / refactor / test / chore のいずれか
  例:   feat: Issue 取り込みスクリプトを追加
  例:   fix(scripts): 型アサーション検出の誤検知を修正

Merge / Revert / fixup! / squash! で始まるコミットは対象外です。
MESSAGE
exit 1
