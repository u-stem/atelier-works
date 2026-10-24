#!/bin/sh
# Claude Codeのフック(scripts/claude-hooks/<名前>.ts)を、動くbunかnodeで起動する。
# Claude Codeは終了コード2だけをツールの呼び出しの拒否として扱い、ほかの失敗では呼び出しを通す。
# フックが見つからないとき、フックが異常終了したときは、終了コード2で拒否する側に倒す。
# 動くbunもnodeも無い環境(依存をまだ入れていないコンテナなど)では、すべてのBashを止めてしまうので、
# 警告を出して通す。bash-guardでは設定ファイルの拒否ルールだけが残り、merge-guardでは保留が確かめられなくなる。
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

# 入っているだけでなく、動くランタイムを選ぶ。
# proto/miseのshimのように、PATHにあっても中身が無いbunは使えない。
# nodeは、型を取り除いて.tsを実行できる24以上が要る。
runtime=""
if command -v bun >/dev/null 2>&1 && bun --version >/dev/null 2>&1; then
  runtime="bun"
elif command -v node >/dev/null 2>&1 &&
  node -e 'process.exit(+process.versions.node.split(".")[0] >= 24 ? 0 : 1)' >/dev/null 2>&1; then
  runtime="node"
elif [ -n "${HOME:-}" ] && [ -x "$HOME/.bun/bin/bun" ] && "$HOME/.bun/bin/bun" --version >/dev/null 2>&1; then
  # GUIから起動したセッションは、ログインシェルのPATHを持たないことがある。
  runtime="$HOME/.bun/bin/bun"
fi

if [ -z "$runtime" ]; then
  echo "claude hook $hook: no working bun or node 24+ was found, so the command was not checked; allowing the tool call." >&2
  echo "Install bun to enable the guard." >&2
  # 終了コード0のときstderrは表示されないので、利用者にはJSONのsystemMessageで知らせる。
  # フックごとに、何が確かめられなくなったかを伝える。
  case "$hook" in
    merge-guard)
      echo '{"systemMessage":"The merge guard hook did not run (no working bun or node 24+), so merges and deploys were not checked against holds."}'
      ;;
    bash-guard)
      echo '{"systemMessage":"The bash guard hook did not run (no working bun or node 24+), so the command was not checked; only the deny rules of .claude/settings.json apply."}'
      ;;
    *)
      echo "{\"systemMessage\":\"The $hook hook did not run (no working bun or node 24+), so the command was not checked.\"}"
      ;;
  esac
  exit 0
fi

"$runtime" "$script"
status=$?
if [ "$status" -ne 0 ]; then
  echo "claude hook $hook: exited with status $status; denying the tool call" >&2
  exit 2
fi
