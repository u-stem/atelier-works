#!/usr/bin/env bash
# メインのcheckoutの`.claude/worktrees/`にあるworktreeのうち、マージ済みで何も失わないものを
# 消す。既定は乾燥実行で、消す対象を表示するだけにする。`--apply`を付けると実際に消す。
#
# 使い方: scripts/worktree-prune.sh [--apply]
# 終了コードは、残したworktreeがあっても0にする(情報を示すのが目的)。使い方の誤りは2。
#
# 消す条件は、すべてを満たすことである。
#   - メインのcheckoutの`.claude/worktrees/`の下にある。
#   - ロックされていない(Claude Codeは使用中のworktreeをロックする)。
#   - このスクリプトを実行したディレクトリが、その中ではない。
#   - HEADがブランチを指している(detachedは残す)。
#   - 作業ツリーに変更も未追跡のファイルも無い。
#   - ブランチの先頭が、`origin/main`の祖先か、マージ済みのPRの先頭のcommitと同じである。
#     後者はsquashマージに当たる。ローカルにpushしていないcommitがあれば一致しないので残る。
#     ghの失敗や認証切れは、未マージとして残す。
#     祖先の場合は、ブランチのreflogにcommitの記録もあるときに限る。作ったまま使っていない
#     ブランチは、origin/mainが進むと祖先に見えるため、残す。
# 消し方は、`git worktree remove`(強制しない)の後に、ブランチを確かめたcommitを期待値にして
# `git update-ref -d`で消す。確認の後にブランチが進んでいれば、gitが拒むのでブランチだけが残る。
# リモートのブランチには触れない。
set -euo pipefail

usage() {
  echo "usage: scripts/worktree-prune.sh [--apply]" >&2
  echo "  without --apply, only prints what would be removed" >&2
}

apply=0
if [ "$#" -gt 1 ]; then
  usage
  exit 2
fi
if [ "$#" -eq 1 ]; then
  if [ "$1" != "--apply" ]; then
    usage
    exit 2
  fi
  apply=1
fi

# 消す対象が、実行したディレクトリを含むかを後で調べるので、先に控える。
invoked_from="$(pwd -P)"

common_dir="$(git rev-parse --path-format=absolute --git-common-dir)"
# bareリポジトリなど`.git`でない場合は、メインのcheckoutの場所を決められない。
if [ "$(basename "$common_dir")" != ".git" ]; then
  echo "worktree-prune: cannot locate the main checkout from $common_dir" >&2
  exit 1
fi
main_root="$(cd "$(dirname "$common_dir")" && pwd -P)"
# ghは、カレントディレクトリのgitのリモートからリポジトリを決める。
cd "$main_root"
scope="$main_root/.claude/worktrees/"

removed=0
kept=0

keep() {
  echo "kept: $wt_path${wt_branch:+ ($wt_branch)}: $1"
  kept=$((kept + 1))
}

# `wt_*`の変数に入れた1件のworktreeを判定し、消せるものは消す(または予定を表示する)。
consider() {
  if [[ "$wt_path/" != "$scope"* ]]; then
    keep "outside"
    return
  fi
  if [ "$wt_locked" -eq 1 ]; then
    keep "locked"
    return
  fi
  if [[ "$invoked_from/" == "$wt_path/"* ]]; then
    keep "current directory"
    return
  fi
  if [ ! -d "$wt_path" ]; then
    keep "missing directory (git worktree prune clears the record)"
    return
  fi
  if [ -z "$wt_branch" ]; then
    keep "detached"
    return
  fi
  local status_out
  if ! status_out="$(git -C "$wt_path" status --porcelain)" || [ -n "$status_out" ]; then
    keep "dirty"
    return
  fi

  local how=""
  if git merge-base --is-ancestor "$wt_head" refs/remotes/origin/main 2>/dev/null; then
    # 作ったまま使っていないブランチは、origin/mainが進めば祖先に見える。
    # reflogが作成の記録だけ(または読めない)なら、commitがあった証拠が無いので残す。
    local reflog_out="" reflog_lines=0 reflog_line
    reflog_out="$(git reflog show --format=%H "refs/heads/$wt_branch" 2>/dev/null)" || reflog_out=""
    if [ -n "$reflog_out" ]; then
      while IFS= read -r reflog_line; do
        reflog_lines=$((reflog_lines + 1))
      done <<<"$reflog_out"
    fi
    if [ "$reflog_lines" -lt 2 ]; then
      keep "unused"
      return
    fi
    how="ancestor of origin/main"
  else
    local gh_status=0 gh_out=""
    gh_out="$(gh pr list --head "$wt_branch" --state merged --json headRefOid --jq '.[].headRefOid' 2>/dev/null)" || gh_status=$?
    if [ "$gh_status" -ne 0 ]; then
      keep "gh unavailable"
      return
    fi
    local oid
    while IFS= read -r oid; do
      if [ "$oid" = "$wt_head" ]; then
        how="merged pull request"
      fi
    done <<<"$gh_out"
    if [ -z "$how" ]; then
      keep "unmerged"
      return
    fi
  fi

  if [ "$apply" -ne 1 ]; then
    echo "would remove: $wt_path ($wt_branch): $how"
    removed=$((removed + 1))
    return
  fi
  if ! git worktree remove "$wt_path" >&2; then
    echo "failed: $wt_path ($wt_branch): could not remove the worktree" >&2
    kept=$((kept + 1))
    return
  fi
  if git update-ref -d "refs/heads/$wt_branch" "$wt_head" >&2; then
    echo "removed: $wt_path ($wt_branch): $how"
  else
    echo "removed: $wt_path, but branch $wt_branch remains (it moved from $wt_head or could not be deleted)"
  fi
  removed=$((removed + 1))
}

reset_record() {
  wt_path=""
  wt_head=""
  wt_branch=""
  wt_locked=0
}

list="$(git worktree list --porcelain)"
reset_record
# 最後の記録の後ろにも空行を足して、判定を漏らさない。
while IFS= read -r line; do
  case "$line" in
    "worktree "*) wt_path="${line#worktree }" ;;
    "HEAD "*) wt_head="${line#HEAD }" ;;
    "branch refs/heads/"*) wt_branch="${line#branch refs/heads/}" ;;
    "locked"*) wt_locked=1 ;;
    "")
      if [ -n "$wt_path" ]; then
        consider
      fi
      reset_record
      ;;
  esac
done <<<"$list"$'\n'

if [ "$apply" -eq 1 ]; then
  echo "removed $removed, kept $kept"
else
  echo "dry run: would remove $removed, keep $kept. Pass --apply to remove."
fi
