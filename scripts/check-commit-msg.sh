#!/usr/bin/env bash
# コミットメッセージの1行目がConventional Commitsの形か検査する。
#   <type>(<scope>)?!?: <description>
# typeはfeat・fix・docs・refactor・test・choreのどれか。
# gitやlefthookが作る、"Merge "・"Revert "・"fixup! "・"squash! "で始まる
# 行は対象外。
# 環境変数CLAUDECODEが1のとき(Claude Codeのセッション)だけ、本文に
#   Co-Authored-By: Claude ... <noreply@anthropic.com>
# の行があるかも検査する。gitのトレーラーと同じく、メッセージの最後の段落
# (空行で区切られた最後のまとまり)にあるものだけを数える。1行目と同じ段落は
# 数えない。キー名の大文字小文字は区別しない。"#"で始まる行は、エディタが
# 足すコメントなので、段落の区切りにも数えず取り除いてから見る。
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
  if [ "${CLAUDECODE:-}" != "1" ]; then
    exit 0
  fi
  trailer_pattern='^[Cc][Oo]-[Aa][Uu][Tt][Hh][Oo][Rr][Ee][Dd]-[Bb][Yy]:[[:space:]]*Claude([[:space:]][^<]*)?<noreply@anthropic\.com>[[:space:]]*$'
  lines=()
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "#"*) continue ;;
    esac
    lines+=("$line")
  done <"$commit_msg_file"

  # 末尾の空行を飛ばし、最後の段落の先頭を探す。
  last=$((${#lines[@]} - 1))
  while [ "$last" -ge 0 ] && [[ "${lines[$last]}" =~ ^[[:space:]]*$ ]]; do
    last=$((last - 1))
  done
  first=$last
  while [ "$first" -gt 0 ] && ! [[ "${lines[$((first - 1))]}" =~ ^[[:space:]]*$ ]]; do
    first=$((first - 1))
  done

  # 先頭の段落は1行目を含むので、トレーラーの段落には数えない。
  if [ "$first" -gt 0 ]; then
    for ((i = first; i <= last; i++)); do
      if [[ "${lines[$i]}" =~ $trailer_pattern ]]; then
        exit 0
      fi
    done
  fi

  cat >&2 <<'MESSAGE'
Claude Codeのセッションでは、本文に次の行が要ります。

  Co-Authored-By: Claude <noreply@anthropic.com>

メッセージの最後の段落に、行頭から書きます。本文の途中にあるものと、
1行目に続けて書いたものは数えません。モデル名を間に入れてもかまいません
(例: Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>)。
キー名の大文字小文字は区別しません。"#"で始まる行は数えません。
MESSAGE
  exit 1
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
