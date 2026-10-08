#!/bin/sh
# Claude Codeのフック(scripts/claude-hooks/<名前>.ts)をbunで起動する。
# Claude Codeは終了コード2だけをツールの呼び出しの拒否として扱い、ほかの失敗では呼び出しを通す。
# bunが見つからないとき、フックが見つからないとき、フックが異常終了したときは、
# 終了コード2で拒否する側に倒す。
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
elif command -v mise >/dev/null 2>&1; then
  mise exec -- bun "$script"
else
  echo "claude hook $hook: bun is not installed; denying the tool call" >&2
  exit 2
fi
status=$?
if [ "$status" -ne 0 ]; then
  echo "claude hook $hook: exited with status $status; denying the tool call" >&2
  exit 2
fi
