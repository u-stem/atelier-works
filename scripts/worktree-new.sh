#!/usr/bin/env bash
# `origin/main`から規約のブランチ名でgit worktreeを作り、依存を入れて、作業ディレクトリの
# 絶対パスを標準出力の最後の行に出す。進捗は標準エラーへ出す。
#
# 使い方: scripts/worktree-new.sh <type>/<name>   (例: feat/foo)
#   ブランチ名は`<type>/<name>`、ディレクトリ名は`<type>-<name>`になる。
#
# 置き場所は、相対パスではなくメインのcheckoutの絶対パスから決める。
# 別のworktreeの中から実行しても、その中に入れ子にならないようにするため。
# メインのcheckoutの下(`.claude/worktrees/`)に置くのは、直下の`mise.local.toml`(秘密値)が
# miseの親ディレクトリ探索で引き継がれ、秘密値を複製せずに済むからである。
#
# `.wmill`のリンクは、`git worktree add`が起こすlefthookのpost-checkout
# (`scripts/link-worktree-wmill.sh`)が張る。
# `lefthook install`は実行しない。フックは共通の`.git/hooks`に入り、すべてのworktreeで
# 共有されるので、メインのcheckoutの`mise run setup`で入っていれば足りるためである。
#
# 既にブランチかディレクトリがあれば、何も変えずに非ゼロで終わる。
#
# `WORKTREE_NEW_BUN`は、依存を入れるbunの実行ファイルを差し替える(テスト用)。
# 未設定なら`bun`を使い、実行する引数は`mise run setup`と同じである。
set -euo pipefail

usage() {
  echo "usage: scripts/worktree-new.sh <type>/<name>" >&2
  echo "  type: feat | fix | docs | refactor | test | chore" >&2
  echo "  name: lowercase letters, digits and hyphens" >&2
}

if [ "$#" -ne 1 ]; then
  usage
  exit 2
fi

pattern='^(feat|fix|docs|refactor|test|chore)/([a-z0-9-]+)$'
if [[ ! "$1" =~ $pattern ]]; then
  echo "worktree-new: invalid argument: $1" >&2
  usage
  exit 2
fi
type="${BASH_REMATCH[1]}"
name="${BASH_REMATCH[2]}"
branch="$type/$name"
dir_name="$type-$name"

common_dir="$(git rev-parse --path-format=absolute --git-common-dir)"
# bareリポジトリなど`.git`でない場合は、メインのcheckoutの場所を決められない。
if [ "$(basename "$common_dir")" != ".git" ]; then
  echo "worktree-new: cannot locate the main checkout from $common_dir" >&2
  exit 1
fi
main_root="$(dirname "$common_dir")"
worktree_path="$main_root/.claude/worktrees/$dir_name"

if [ -e "$worktree_path" ]; then
  echo "worktree-new: directory already exists: $worktree_path" >&2
  exit 1
fi
if git show-ref --verify --quiet "refs/heads/$branch"; then
  echo "worktree-new: branch already exists: $branch" >&2
  exit 1
fi

echo "worktree-new: fetching origin/main" >&2
git fetch origin main >&2

# 短い`origin/main`は同名のブランチやタグに解決されうるので、完全な名前で指す。
# 追跡の設定は付けない。付けると、`git push`の先がorigin/mainになってしまう。
echo "worktree-new: creating $worktree_path on $branch" >&2
git worktree add --no-track -b "$branch" "$worktree_path" refs/remotes/origin/main >&2

bun="${WORKTREE_NEW_BUN:-bun}"
cd "$worktree_path"
echo "worktree-new: installing dependencies" >&2
"$bun" install --frozen-lockfile --ignore-scripts >&2
"$bun" install --cwd console --frozen-lockfile --ignore-scripts >&2

echo "$worktree_path"
