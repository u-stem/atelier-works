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
#   - 無視されたファイルが、再生成できるもの(node_modules、`.wmill`のリンク、`console/dist/`、
#     `console/.cache/`、`__pycache__/`、`.DS_Store`)以外に無い。`git worktree remove`は無視された
#     ファイルを黙って消すので、秘密値のローカルファイルなどを守るために残す(`ignored files`)。
#   - 使用中に見えない。使用中のworktreeはロックされるとは限らないため、ロックに頼らず、次の2つで調べる。
#       `recent`: node_modulesと`.git`を除くファイルが、直近N分(既定120)以内に更新されている。
#       `in use`: いずれかのプロセスのcwdがその中にある(`lsof`で調べる)。
#     `lsof`が無い環境や、出力が空の環境では`in use`の判定を飛ばし、`recent`だけで守る。
#     `in use`はcwdを持つプロセスだけを見るので、エディタで開いているだけのworktreeは検出できない。
#   - ブランチの先頭が、`origin/main`の祖先か、ベースが`main`のマージ済みPRの先頭のcommitと同じである。
#     後者はsquashマージに当たる。ローカルにpushしていないcommitがあれば一致しないので残る。
#     ghの失敗や認証切れは、未マージとして残す。
#   - 祖先の場合は、ブランチのreflogにcommitの記録もあるときに限る。作ったまま使っていない
#     ブランチ(`unused`)は、origin/mainが進むと祖先に見えるため、残す。ただし、作ってから
#     24時間以上、ファイルの更新も無いものは、放置されたもの(`abandoned`)として消す。
#     `abandoned`は起点がorigin/mainの祖先でなくてもよい。独自のcommitが無いので何も失わない。
#   - ブランチのreflogと、worktreeのHEADのreflogにあるすべてのcommitが、消してよい根拠の先から
#     到達できる(`reflog has unreachable commits`)。根拠の先は、祖先ならorigin/main、PRの一致と
#     `abandoned`ならブランチの先頭である。`git reset --hard`で外したcommitは、削除でreflogごと
#     失われるので、残す。reflogが読めないときも残す。
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
  # 自分自身のcwdが必ず出るので、空なら失敗とみなす。空のまま照合すると、何も使われていないことになる。
  if [ -z "$cwd_list" ]; then
    have_lsof=0
    echo "worktree-prune: warning: lsof returned nothing; skipped the in use check" >&2
  fi
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

# ブランチのreflogと、worktreeのHEADのreflogにあるすべてのcommitが、`$1`から到達できれば0を返す。
# `git reset --hard`で外したcommitは、worktreeとブランチの削除でreflogごと失われるため、
# 到達できないcommitがあれば消さない。reflogが読めないときも同じ。
reflogs_reachable() {
  local target="$1" branch_log head_log sha
  branch_log="$(git reflog show --format=%H "refs/heads/$wt_branch" 2>/dev/null)" || return 1
  head_log="$(git -C "$wt_path" reflog show --format=%H HEAD 2>/dev/null)" || return 1
  [ -n "$branch_log" ] && [ -n "$head_log" ] || return 1
  while IFS= read -r sha; do
    git merge-base --is-ancestor "$sha" "$target" 2>/dev/null || return 1
  done <<<"$branch_log"$'\n'"$head_log"
  return 0
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

  # 変更と未追跡のファイルは`dirty`、再生成できるもの以外の無視されたファイルは
  # `ignored files`として残す。再生成できるものは、node_modules、`.wmill`のリンク、
  # `console/dist/`、`console/.cache/`、`__pycache__/`、`.DS_Store`である。
  # `.wmill`は実体のディレクトリを許さない。ログインの情報が入りうるため。
  # 利用者の`status.showUntrackedFiles=no`で未追跡のファイルが隠れないよう、明示する。
  local status_out status_line dirty=0 ignored=0
  if ! status_out="$(git -C "$wt_path" status --porcelain --ignored --untracked-files=all)"; then
    keep "dirty"
    return
  fi
  while IFS= read -r status_line; do
    case "$status_line" in
      "") ;;
      "!! node_modules/"* | "!! "*"/node_modules/"*) ;;
      "!! .wmill") ;;
      "!! console/dist/"* | "!! console/.cache/"*) ;;
      "!! __pycache__/"* | "!! "*"/__pycache__/"*) ;;
      "!! .DS_Store" | "!! "*"/.DS_Store") ;;
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

  # ブランチのreflogの行数と、先頭の記録のshaと時刻。
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

  # 消してよい根拠ごとに、reflogのすべてのcommitが到達できなければならない先(`reach_target`)が違う。
  local how="" reach_target="" now
  now="$(date +%s)"
  if [ "$reflog_lines" -eq 1 ] && [ "$first_sha" = "$wt_head" ] \
    && [[ "$first_time" =~ ^[0-9]+$ ]] \
    && [ $((now - first_time)) -ge $((abandoned_minutes * 60)) ] \
    && ! has_recent_file "$wt_path" "$abandoned_minutes"; then
    # 作ったまま使っていない。ブランチに独自のcommitが無いので、起点が
    # origin/mainの祖先でなくても(機能ブランチから作った場合など)、何も失わない。
    how="abandoned"
    reach_target="$wt_head"
  elif git merge-base --is-ancestor "$wt_head" refs/remotes/origin/main 2>/dev/null; then
    if [ "$reflog_lines" -lt 2 ]; then
      keep "unused"
      return
    fi
    how="ancestor of origin/main"
    reach_target="refs/remotes/origin/main"
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
    # PRの先頭とブランチの先頭が一致済みなので、ローカルの先頭から到達できればよい。
    reach_target="$wt_head"
  fi

  if ! reflogs_reachable "$reach_target"; then
    keep "reflog has unreachable commits"
    return
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
