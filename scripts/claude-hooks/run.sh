#!/bin/sh
# Claude Codeのフック(scripts/claude-hooks/<名前>.ts)をbunかnodeで起動する。
# Claude Codeは終了コード2だけをツールの呼び出しの拒否として扱い、ほかの失敗では呼び出しを通す。
# フックが見つからないとき、フックが異常終了したときは、終了コード2で拒否する側に倒す。
# bunもnodeも無い環境(依存をまだ入れていないコンテナなど)では、すべてのBashを止めてしまうので、
# 警告を出して通す。この場合は、設定ファイルの拒否ルールだけが残る。
# 使い方: sh scripts/claude-hooks/run.sh <フックの名前>(標準入力にフックの入力のJSONを渡す)
set -u

hook="${1:-}"
case "$hook" in
  "" | *[!a-z-]*)
    echo "claude hook: invalid hook name '$hook'; denying the tool call" >&2
    exit 2
    ;;
esac

# PATHに何も無くても動くよう、dirnameを使わずに自分の置き場所を求める。
case "$0" in
  */*) dir="${0%/*}" ;;
  *) dir="." ;;
esac
script="$dir/$hook.ts"
if [ ! -f "$script" ]; then
  echo "claude hook: $script not found; denying the tool call" >&2
  exit 2
fi

if command -v bun >/dev/null 2>&1; then
  bun "$script"
elif command -v node >/dev/null 2>&1; then
  node "$script"
else
  echo "claude hook $hook: neither bun nor node is on PATH, so the command was not checked; allowing the tool call." >&2
  echo "Install bun to enable the guard." >&2
  exit 0
fi
status=$?
if [ "$status" -ne 0 ]; then
  echo "claude hook $hook: exited with status $status; denying the tool call" >&2
  exit 2
fi
