#!/usr/bin/env bash
# リンクされたgit worktreeで、メイン作業ツリーの`.wmill`(wmillのログインプロファイル)へ
# シンボリックリンクを張る。
#
# `mise.toml`の`WMILL_CONFIG_DIR=.wmill`は作業ツリーからの相対パスで、
# `.wmill`はgitignore済みなので、`git worktree add`で作った作業ツリーには存在しない。
# このままだとpre-commitの`wmill-metadata`が「No workspace profile found」で失敗する。
#
# lefthookのpost-checkout(`lefthook.yml`を参照)として動かす。`git worktree add`も
# post-checkoutを起こす。認証情報は複製せず、リンクだけを張る。
#
# 何もしない場合: メイン作業ツリーで動いたとき、メイン側に`.wmill`が無いとき、
# 作業ツリーの`.wmill`が空でないディレクトリか、リンク先がある有効なシンボリックリンクのとき。
# 空のディレクトリはwmillが自動で作った可能性があり、リンク先が無いシンボリックリンクは
# 使えないので、どちらもリンクに置き換える。
#
# このフックが非ゼロで終わると`git worktree add`や`git switch`まで失敗する。
# リンクは補助にすぎないため、コマンドの失敗、未定義変数の参照、非ゼロの終了の
# どれでも、警告だけを出して0で終わる。EXITのtrapで終了コードを0に置き換える。
set -euo pipefail

finish() {
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "link-worktree-wmill: skipped (exit $rc)" >&2
  fi
  exit 0
}
trap finish EXIT

worktree_root="$(git rev-parse --show-toplevel)"
cd "$worktree_root"

# `--git-dir`と`--git-common-dir`は相対パスで返ることがあるので、
# 実在するディレクトリへ移って絶対パスにそろえてから比べる。
git_dir="$(cd "$(git rev-parse --git-dir)" && pwd -P)"
common_dir="$(cd "$(git rev-parse --git-common-dir)" && pwd -P)"

# メイン作業ツリーでは、リンクの必要が無い。
if [ "$git_dir" = "$common_dir" ]; then
  exit 0
fi

# メイン作業ツリーは共通の`.git`ディレクトリの親。bareリポジトリなど
# `.git`でない場合は、メインの場所を決められないので何もしない。
if [ "$(basename "$common_dir")" != ".git" ]; then
  exit 0
fi
main_root="$(dirname "$common_dir")"
main_wmill="$main_root/.wmill"

if [ ! -d "$main_wmill" ]; then
  exit 0
fi

# リンク先がある既存のシンボリックリンクには触れない。
# リンク先が無いリンクは使えないので、消して張り直す。
if [ -L .wmill ]; then
  if [ -e .wmill ]; then
    exit 0
  fi
  rm .wmill
fi

if [ -e .wmill ]; then
  if [ -d .wmill ] && [ -z "$(ls -A .wmill)" ]; then
    rmdir .wmill
  else
    exit 0
  fi
fi

ln -s "$main_wmill" .wmill
echo "link-worktree-wmill: linked .wmill -> $main_wmill"
