#!/usr/bin/env bash
# `origin/main`からgit worktreeを作り、依存を入れて、作業ディレクトリの絶対パスを
# 標準出力の最後の行に出す。進捗は標準エラーへ出す。
#
# 使い方:
#   scripts/worktree-new.sh <type>/<name>   (例: feat/foo)
# ブランチ名は`<type>/<name>`、ディレクトリ名は`<type>-<name>`になる。
# 既にブランチ(ローカルとorigin)かディレクトリがあれば、何も変えずに非ゼロで終わる。
set -euo pipefail

usage() {
  echo "usage: scripts/worktree-new.sh <type>/<name>" >&2
  echo "  type: feat | fix | docs | refactor | test | chore" >&2
  echo "  name: lowercase letters, digits and hyphens" >&2
}

types='feat|fix|docs|refactor|test|chore'

if [ "$#" -ne 1 ]; then
  usage
  exit 2
fi
pattern="^($types)/([a-z0-9-]+)\$"
if [[ ! "$1" =~ $pattern ]]; then
  echo "worktree-new: invalid argument: $1" >&2
  usage
  exit 2
fi
branch="$1"
dir_name="${BASH_REMATCH[1]}-${BASH_REMATCH[2]}"

# 置き場所は、相対パスではなくメインのcheckoutの絶対パスから決める。
# 別のworktreeの中から実行しても、その中に入れ子にならないようにするため。
common_dir="$(git rev-parse --path-format=absolute --git-common-dir)"
# bareリポジトリなど`.git`でない場合は、メインのcheckoutの場所を決められない。
if [ "$(basename "$common_dir")" != ".git" ]; then
  echo "worktree-new: cannot locate the main checkout from $common_dir" >&2
  exit 1
fi
main_root="$(dirname "$common_dir")"
# メインのcheckout直下の`mise.local.toml`(秘密値)は、miseの親ディレクトリ探索で
# `.claude/worktrees/`の下にも引き継がれるので、秘密値を複製しない。
# ただし`mise.toml`にもあるキー(例: `WM_HTTP_PORT`)を`mise.local.toml`で上書きしても、
# worktree側の`mise.toml`のほうが近いので、worktreeには引き継がれない。
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
if ! base_sha="$(git show-ref --verify --hash refs/remotes/origin/main)"; then
  echo "worktree-new: refs/remotes/origin/main does not exist" >&2
  exit 1
fi

# originに同名のブランチがあると、最初のpushが拒否されるか、他の作業に混ざる。
# `ls-remote --exit-code`は、一致が無いと2、通信などの失敗はそれ以外で終わる。
# この検査から最初のpushまでの間に、他の人が同名のブランチをpushするレースは受け入れる。
remote_status=0
git ls-remote --exit-code --heads origin "refs/heads/$branch" >/dev/null || remote_status=$?
if [ "$remote_status" -eq 0 ]; then
  echo "worktree-new: branch already exists on origin: $branch" >&2
  exit 1
fi
if [ "$remote_status" -ne 2 ]; then
  echo "worktree-new: cannot check the branch on origin (exit $remote_status)" >&2
  exit 1
fi

# 後始末の対象は、`git worktree add`の成功から依存の導入の完了までに限る。
# ここまでの検査で止まったときは、既存のブランチやディレクトリを消さない。
# 完成したあとの失敗や中断では、できあがったworktreeを消さない。
# worktreeは強制せずに消す。依存の導入が作るのはgitignore済みの`node_modules`だけなので、
# 通常のremoveが通る。未追跡のファイルや変更があれば、gitが拒む。
# ブランチは、作った時点の`base_sha`を指すままのときだけ消す。コミットが増えていれば、gitが拒む。
# 片付けの最中の中断で、worktreeだけが消えてブランチが残らないよう、INTとTERMは無視する。
created=0
cleanup() {
  local rc=$?
  trap '' INT TERM
  trap - EXIT
  if [ "$created" -eq 1 ] && [ "$rc" -ne 0 ]; then
    echo "worktree-new: failed (exit $rc), removing $worktree_path and branch $branch" >&2
    cd "$main_root" || true
    if git worktree remove "$worktree_path" >&2; then
      if git update-ref -d "refs/heads/$branch" "$base_sha" >&2; then
        echo "worktree-new: removed. Fix the cause and rerun" >&2
      else
        echo "worktree-new: the worktree is removed, but branch $branch remains" >&2
        echo "  it no longer points at $base_sha or could not be deleted; check it with git log $base_sha..$branch" >&2
        echo "  delete it by hand only if it holds nothing you need, then rerun" >&2
      fi
    else
      echo "worktree-new: could not remove $worktree_path (untracked files, changes or a lock)" >&2
      echo "  check its contents with git status --short inside it;" >&2
      echo "  if you judge it unneeded, remove it by hand and rerun. Branch $branch remains" >&2
    fi
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# `--no-track`を付けないと、新ブランチの上流がorigin/mainになる。名前の違う上流への
# pushは、gitが拒否する。
# `git worktree add`自身が失敗しても`created`は立てない。並行して同名を作った別の実行の
# 成果物かもしれず、自分が作ったと言い切れないためである。残っているものだけを示す。
echo "worktree-new: creating $worktree_path on $branch" >&2
if ! git worktree add --no-track -b "$branch" "$worktree_path" "$base_sha" >&2; then
  echo "worktree-new: git worktree add failed; nothing was removed" >&2
  git worktree list >&2 || true
  if git show-ref --verify --quiet "refs/heads/$branch"; then
    echo "worktree-new: branch $branch exists" >&2
  fi
  if [ -e "$worktree_path" ]; then
    echo "worktree-new: directory exists: $worktree_path" >&2
  fi
  exit 1
fi
created=1

# `.wmill`のリンクは、`git worktree add`が起こすlefthookのpost-checkout
# (`scripts/link-worktree-wmill.sh`)が張る。
# `lefthook install`は実行しない。フックは共通の`.git/hooks`に入り、すべてのworktreeで
# 共有されるので、メインのcheckoutの`mise run setup`で入っていれば足りるためである。
# `WORKTREE_NEW_BUN`は、bunの実行ファイルを差し替える(テスト用)。引数は`mise run setup`と同じ。
bun="${WORKTREE_NEW_BUN:-bun}"
cd "$worktree_path"
echo "worktree-new: installing dependencies" >&2
"$bun" install --frozen-lockfile --ignore-scripts >&2
"$bun" install --cwd console --frozen-lockfile --ignore-scripts >&2
created=0

echo "worktree-new: first push: git push -u origin HEAD" >&2
echo "$worktree_path"
