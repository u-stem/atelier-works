#!/usr/bin/env bash
# メインのcheckoutの`.claude/worktrees/`にあるworktreeのうち、マージ済みで何も失わないものを
# 消す。既定は乾燥実行で、消す対象を表示するだけにする。`--apply`を付けると実際に消す。
#
# 使い方: scripts/worktree-prune.sh [--apply] [--min-idle-minutes N]
# 終了コードは、残したworktreeがあっても0にする(情報を示すのが目的)。使い方の誤りは2。
#
# 消す条件は、すべてを満たすことである。
#   - メインのcheckoutの`.claude/worktrees/`の下にある。
#   - ロックされていない。
#   - このスクリプトを実行したディレクトリが、その中ではない。
#   - HEADがブランチを指している(detachedは残す)。
#   - 作業ツリーに変更も未追跡のファイルも無い。
#   - 無視されたファイルが、node_modulesと`.wmill`以外に無い。`git worktree remove`は無視された
#     ファイルを黙って消すので、秘密値のローカルファイルなどを守るために残す(`ignored files`)。
#   - 使用中に見えない。使用中のworktreeはロックされるとは限らないため、ロックに頼らず、次の2つで調べる。
#       `recent`: node_modulesと`.git`を除くファイルが、直近N分(既定120)以内に更新されている。
#       `in use`: いずれかのプロセスのcwdがその中にある(`lsof`で調べる)。
#     `lsof`が無い環境では`in use`の判定を飛ばし、`recent`だけで守る。
#   - ブランチの先頭が、`origin/main`の祖先か、ベースが`main`のマージ済みPRの先頭のcommitと同じである。
#     後者はsquashマージに当たる。ローカルにpushしていないcommitがあれば一致しないので残る。
#     ghの失敗や認証切れは、未マージとして残す。
#   - 祖先の場合は、ブランチのreflogにcommitの記録もあるときに限る。作ったまま使っていない
#     ブランチ(`unused`)は、origin/mainが進むと祖先に見えるため、残す。ただし、作ってから
#     24時間以上、ファイルの更新も無いものは、放置されたもの(`abandoned`)として消す。
#     WorktreeRemoveフックを持たないので、subagentが作ったworktreeが溜まり続けるのを防ぐ。
#     この24時間は`--min-idle-minutes`と別に固定する。短くすると、作った直後の
#     worktreeを使い始める前に消してしまうおそれがあるため。
# 消し方は、`git worktree remove`(強制しない)の後に、ブランチを確かめたcommitを期待値にして
# `git update-ref -d`で消す。確認の後にブランチが進んでいれば、gitが拒むのでブランチだけが残る。
# 消したブランチの`branch.<name>`の設定も消す。同名のブランチを作り直したとき、
# 消えたリモートの上流を引き継がないようにするため。
# リモートのブランチには触れない。
set -euo pipefail

usage() {
  echo "usage: scripts/worktree-prune.sh [--apply] [--min-idle-minutes N]" >&2
  echo "  without --apply, only prints what would be removed" >&2
  echo "  --min-idle-minutes N: keep worktrees with files changed within N minutes (default 120)" >&2
}

# 作ったまま使っていないworktreeを放置とみなす時間(分)。
abandoned_minutes=1440

apply=0
idle_minutes=120
while [ "$#" -gt 0 ]; do
  case "$1" in
    --apply)
      apply=1
      shift
      ;;
    --min-idle-minutes)
      if [ "$#" -lt 2 ] || [[ ! "$2" =~ ^[0-9]+$ ]]; then
        usage
        exit 2
      fi
      idle_minutes="$2"
      shift 2
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

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

# 各プロセスのcwdの一覧。`lsof`は権限の無いプロセスで終了コード1になるが、読めた分は使う。
cwd_list=""
have_lsof=0
if command -v lsof >/dev/null 2>&1; then
  have_lsof=1
  cwd_list="$(lsof -a -d cwd -Fn 2>/dev/null)" || true
fi

removed=0
kept=0

keep() {
  echo "kept: $wt_path${wt_branch:+ ($wt_branch)}: $1"
  kept=$((kept + 1))
}

# node_modulesと`.git`を除くファイルのうち、直近`$2`分以内に更新されたものがあれば0を返す。
has_recent_file() {
  local found
  # 0分なら、どのファイルも新しくない。`-mmin -0`は境界の扱いが一定しないので使わない。
  [ "$2" -gt 0 ] || return 1
  found="$(find "$1" \( -name node_modules -o -name .git \) -prune -o -type f -mmin "-$2" -print -quit 2>/dev/null)" || true
  [ -n "$found" ]
}

# いずれかのプロセスのcwdが`$1`の中なら0を返す。
has_process_inside() {
  local line
  [ "$have_lsof" -eq 1 ] || return 1
  while IFS= read -r line; do
    case "$line" in
      "n$1" | "n$1/"*) return 0 ;;
    esac
  done <<<"$cwd_list"
  return 1
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

  # 変更と未追跡のファイルは`dirty`、node_modulesと`.wmill`以外の無視されたファイルは
  # `ignored files`として残す。
  local status_out status_line dirty=0 ignored=0
  if ! status_out="$(git -C "$wt_path" status --porcelain --ignored)"; then
    keep "dirty"
    return
  fi
  while IFS= read -r status_line; do
    case "$status_line" in
      "") ;;
      "!! node_modules/" | "!! "*"/node_modules/" | "!! .wmill" | "!! .wmill/") ;;
      "!! "*) ignored=1 ;;
      *) dirty=1 ;;
    esac
  done <<<"$status_out"
  if [ "$dirty" -eq 1 ]; then
    keep "dirty"
    return
  fi
  if [ "$ignored" -eq 1 ]; then
    keep "ignored files"
    return
  fi

  if has_recent_file "$wt_path" "$idle_minutes"; then
    keep "recent"
    return
  fi
  if has_process_inside "$wt_path"; then
    keep "in use"
    return
  fi

  local how=""
  if git merge-base --is-ancestor "$wt_head" refs/remotes/origin/main 2>/dev/null; then
    # reflogが作成の記録だけ(または読めない)なら、commitがあった証拠が無い。
    local reflog_out="" reflog_lines=0 reflog_line first_sha="" first_time=""
    reflog_out="$(git reflog show --date=unix --format='%H %gd' "refs/heads/$wt_branch" 2>/dev/null)" || reflog_out=""
    if [ -n "$reflog_out" ]; then
      while IFS= read -r reflog_line; do
        if [ "$reflog_lines" -eq 0 ]; then
          first_sha="${reflog_line%% *}"
          first_time="${reflog_line##*@\{}"
          first_time="${first_time%\}}"
        fi
        reflog_lines=$((reflog_lines + 1))
      done <<<"$reflog_out"
    fi
    if [ "$reflog_lines" -ge 2 ]; then
      how="ancestor of origin/main"
    else
      # 作ったまま使っていない。reflogの時刻が読めて、放置とみなす時間を過ぎ、
      # ファイルの更新も無いときだけ消す。
      local now
      now="$(date +%s)"
      if [ "$reflog_lines" -eq 1 ] && [ "$first_sha" = "$wt_head" ] \
        && [[ "$first_time" =~ ^[0-9]+$ ]] \
        && [ $((now - first_time)) -ge $((abandoned_minutes * 60)) ] \
        && ! has_recent_file "$wt_path" "$abandoned_minutes"; then
        how="abandoned"
      else
        keep "unused"
        return
      fi
    fi
  else
    local gh_status=0 gh_out=""
    gh_out="$(gh pr list --head "$wt_branch" --base main --state merged --json headRefOid --jq '.[].headRefOid' 2>/dev/null)" || gh_status=$?
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
    # 設定のセクションが無いと終了コード128になるので、失敗は無視する。
    git config --remove-section "branch.$wt_branch" 2>/dev/null || true
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
