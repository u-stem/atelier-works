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
#     `abandoned`は起点がorigin/mainの祖先でなくてもよい。ただし、reflogの唯一の行が作成の記録
#     (件名が`branch: Created from`)で、消すブランチ以外のrefがHEADのcommitを含むときに限る。
#     `git gc`のreflog expireで古い行が消えると、pushしていない最後のcommitの行だけが残り、
#     1行のreflogと区別できなくなる。他のrefが辿れるcommitなら、消しても何も失わない。
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
  echo "       scripts/worktree-prune.sh --auto --ancestors <pid,pid,...>" >&2
  echo "  without --apply, only prints what would be removed" >&2
  echo "  --min-idle-minutes N: keep worktrees with files changed within N minutes (default 120)" >&2
  echo "  --auto: unattended mode started by worktree-new.sh; cannot be combined with --apply or --min-idle-minutes" >&2
}

# 作ったまま使っていないworktreeを放置とみなす時間(分)。
abandoned_minutes=1440

apply=0
apply_given=0
auto=0
ancestors=""
ancestors_given=0
idle_minutes=120
idle_given=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --apply)
      apply=1
      apply_given=1
      shift
      ;;
    --auto)
      auto=1
      shift
      ;;
    --ancestors)
      # 値の検査は、`--auto`の実行の中で行う。不正な値は、何も消さずに失敗として数える。
      if [ "$#" -lt 2 ]; then
        usage
        exit 2
      fi
      ancestors="$2"
      ancestors_given=1
      shift 2
      ;;
    --min-idle-minutes)
      if [ "$#" -lt 2 ] || [[ ! "$2" =~ ^[0-9]+$ ]]; then
        usage
        exit 2
      fi
      idle_minutes="$2"
      idle_given=1
      shift 2
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done
# `--auto`は`--apply`を含み、`recent`の閾値を既定に固定する。
if [ "$auto" -eq 1 ]; then
  if [ "$apply_given" -eq 1 ] || [ "$idle_given" -eq 1 ]; then
    usage
    exit 2
  fi
  apply=1
elif [ "$ancestors_given" -eq 1 ]; then
  usage
  exit 2
fi

# 消す対象が、実行したディレクトリを含むかを後で調べるので、先に控える。
invoked_from="$(pwd -P)"

common_dir=""
rev_status=0
common_dir="$(git rev-parse --path-format=absolute --git-common-dir)" || rev_status=$?
# --autoは、状態を残せない場所では何もせず、終了コード0で終える。
if [ "$rev_status" -ne 0 ]; then
  if [ "$auto" -eq 1 ]; then
    exit 0
  fi
  exit "$rev_status"
fi
# bareリポジトリなど`.git`でない場合は、メインのcheckoutの場所を決められない。
if [ "$(basename "$common_dir")" != ".git" ]; then
  echo "worktree-prune: cannot locate the main checkout from $common_dir" >&2
  if [ "$auto" -eq 1 ]; then
    exit 0
  fi
  exit 1
fi
main_root="$(cd "$(dirname "$common_dir")" && pwd -P)"
# ghは、カレントディレクトリのgitのリモートからリポジトリを決める。
cd "$main_root"
scope="$main_root/.claude/worktrees/"

# --autoの状態は`<git-common-dir>/worktree-prune/`にまとめる(`log`、`lock/`、`stamp`、`failures`)。
# 書き込みはすべて、ディレクトリの中に作った一時ファイルへ書いてから`mv`で置き換える。
# 追記や`touch`は、既存のシンボリックリンクを辿って別の場所に書くおそれがあるので使わない。
state_dir="$common_dir/worktree-prune"
log_file="$state_dir/log"
lock_dir="$state_dir/lock"
stamp_file="$state_dir/stamp"
failures_file="$state_dir/failures"
# ログがこの大きさ(バイト)を超えたら、書き換えのときに末尾の半分だけを残す。
log_limit_bytes=102400

# 状態のファイルを読む。通常のファイルでなければ(シンボリックリンクを含む)何も出さない。
read_state() {
  if [ -f "$1" ] && [ ! -L "$1" ]; then
    cat -- "$1" 2>/dev/null || true
  fi
}

# 状態のファイル`$1`を、内容`$2`で置き換える。置き換え先がシンボリックリンクやディレクトリなら書かない。
# `mv`はシンボリックリンクがディレクトリを指すと、その中へ移すので、`mv`の直前にも確かめる。
write_state() {
  local dest="$1" tmp
  if [ -L "$dest" ] || [ -d "$dest" ]; then
    return 1
  fi
  tmp="$(mktemp "$state_dir/.tmp.XXXXXX")" || return 1
  if ! printf '%s\n' "$2" >"$tmp" || [ -L "$dest" ] || [ -d "$dest" ] || ! mv -f -- "$tmp" "$dest"; then
    rm -f -- "$tmp"
    return 1
  fi
}

# ログに1行足す。ログ全体を書き換えるので、大きくなりすぎたら末尾の半分だけを残す。
log_line() {
  local tmp
  if [ -L "$log_file" ] || [ -d "$log_file" ]; then
    return 0
  fi
  tmp="$(mktemp "$state_dir/.tmp.XXXXXX")" || return 0
  if [ -f "$log_file" ]; then
    if [ "$(($(wc -c <"$log_file")))" -gt "$log_limit_bytes" ]; then
      # 先頭は行の途中で切れるので捨てる。
      tail -c "$((log_limit_bytes / 2))" -- "$log_file" | sed '1d' >"$tmp" || true
    else
      cat -- "$log_file" >"$tmp" || true
    fi
  fi
  printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$1" >>"$tmp"
  if [ -L "$log_file" ] || [ -d "$log_file" ] || ! mv -f -- "$tmp" "$log_file"; then
    rm -f -- "$tmp"
  fi
}

# 更新時刻(epoch秒)を返す。GNUとBSDのstatのどちらでも動かす。
file_mtime() {
  local value
  value="$(stat -c %Y -- "$1" 2>/dev/null)" || value=""
  if [[ ! "$value" =~ ^[0-9]+$ ]]; then
    value="$(stat -f %m -- "$1" 2>/dev/null)" || value=""
  fi
  [[ "$value" =~ ^[0-9]+$ ]] || return 1
  echo "$value"
}

# 前回の成功から30分以内なら0を返す。今より未来の値や数字でない値は、古いものとして扱う。
stamp_is_fresh() {
  local value now
  value="$(read_state "$stamp_file")"
  [[ "$value" =~ ^[0-9]{1,12}$ ]] || return 1
  now="$(date +%s)"
  [ "$value" -le "$now" ] && [ $((now - value)) -le 1800 ]
}

# ロックの持ち主の識別(乱数)。自分が取ったロックだけを、終了時に消すために使う。
# 持ち主のPIDの生死は使わない。PIDの再利用や空のPIDで誤るため。
lock_owner=""

# `lock/`を作れたので、持ち主の識別を書く。書けなければロックを放す。
claim_lock() {
  lock_owner="$$-$RANDOM-$RANDOM-$RANDOM"
  if ! write_state "$lock_dir/owner" "$lock_owner"; then
    rmdir "$lock_dir" 2>/dev/null || true
    lock_owner=""
    return 1
  fi
}

# `lock/`の更新時刻が10分より古いか、今より未来なら0を返す(放置されたロック)。
lock_is_stale() {
  local mtime now
  mtime="$(file_mtime "$1")" || return 1
  now="$(date +%s)"
  [ "$mtime" -gt "$now" ] || [ $((now - mtime)) -gt 600 ]
}

# ロックを取る。取れたら0、他の実行が動いていて取れなければ1を返す。
# 取れなかったときの`lock/`が放置されたものなら、一意の名前へ移し、移した先がまだ古いことを
# 確かめてから消し、取り直す。移した先が新しければ、他の実行が取り直した直後なので、元に戻す。
acquire_lock() {
  local moved
  if mkdir "$lock_dir" 2>/dev/null; then
    claim_lock
    return
  fi
  if [ -L "$lock_dir" ] || [ ! -d "$lock_dir" ] || ! lock_is_stale "$lock_dir"; then
    return 1
  fi
  moved="$state_dir/lock.stale.$$.$RANDOM"
  mv -- "$lock_dir" "$moved" 2>/dev/null || return 1
  if ! lock_is_stale "$moved"; then
    if [ ! -e "$lock_dir" ]; then
      mv -- "$moved" "$lock_dir" 2>/dev/null || true
    fi
    return 1
  fi
  # 消すのは、いま自分が一意の名前へ移した、状態のディレクトリの中のものに限る。
  if [ -d "$moved" ] && [ ! -L "$moved" ]; then
    rm -rf -- "$moved"
  fi
  if mkdir "$lock_dir" 2>/dev/null; then
    claim_lock
    return
  fi
  return 1
}

# 自分の識別が`owner`にあるときだけ、`lock/`を消す。
release_lock() {
  [ -n "$lock_owner" ] || return 0
  if [ -d "$lock_dir" ] && [ ! -L "$lock_dir" ] && [ "$(read_state "$lock_dir/owner")" = "$lock_owner" ]; then
    rm -rf -- "$lock_dir"
  fi
  lock_owner=""
}

# 失敗の回数。数字でない中身は0として扱う。
read_failures() {
  local value
  value="$(read_state "$failures_file")"
  if [[ "$value" =~ ^[0-9]{1,9}$ ]]; then
    echo "$((10#$value))"
  else
    echo 0
  fi
}

# `gh`の時間の上限(秒)。`timeout`はmacOSに無いので、別のプロセスグループで動かして自分で測る。
# 環境変数は、1以上30以下の数字のときだけ使う。延ばせないのは、無人の実行が
# 10分のロックの期限を超えないようにするため。短くするのはテスト用。
gh_limit=30
if [[ "${WORKTREE_PRUNE_GH_TIMEOUT-}" =~ ^[0-9]{1,2}$ ]]; then
  gh_limit_env=$((10#$WORKTREE_PRUNE_GH_TIMEOUT))
  if [ "$gh_limit_env" -ge 1 ] && [ "$gh_limit_env" -le 30 ]; then
    gh_limit="$gh_limit_env"
  fi
fi

gh_pid=""
gh_out=""
gh_out_file=""
# 1件でも時間切れになったら、その実行の残りの候補はghに聞かずに打ち切る。
gh_timed_out=0
gh_asked=0
gh_unavailable=0

# 動いているghを、プロセスグループごと止める。
stop_gh() {
  if [ -n "$gh_pid" ]; then
    kill -TERM -- "-$gh_pid" 2>/dev/null || true
    sleep 1
    kill -KILL -- "-$gh_pid" 2>/dev/null || true
    wait "$gh_pid" 2>/dev/null || true
    gh_pid=""
  fi
}

# `wt_branch`のマージ済みPRの先頭のcommitを`gh_out`に入れる。成功なら0を返す。
# --autoでは、時間の上限を課す。上限を超えたらプロセスグループごと止めて、1を返す。
ask_gh() {
  local waited=0 status=0
  gh_out=""
  if [ "$auto" -ne 1 ]; then
    gh_out="$(gh pr list --head "$wt_branch" --base main --state merged --json headRefOid --jq '.[].headRefOid' 2>/dev/null)" || status=$?
    return "$status"
  fi
  if [ "$gh_timed_out" -eq 1 ]; then
    return 1
  fi
  gh_out_file="$(mktemp "$state_dir/.tmp.XXXXXX")" || return 1
  set -m
  gh pr list --head "$wt_branch" --base main --state merged --json headRefOid --jq '.[].headRefOid' \
    >"$gh_out_file" 2>/dev/null </dev/null &
  gh_pid=$!
  set +m
  while kill -0 "$gh_pid" 2>/dev/null; do
    if [ "$waited" -ge "$gh_limit" ]; then
      gh_timed_out=1
      stop_gh
      rm -f -- "$gh_out_file"
      gh_out_file=""
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
  wait "$gh_pid" || status=$?
  gh_pid=""
  if [ "$status" -eq 0 ]; then
    gh_out="$(cat -- "$gh_out_file")"
  fi
  rm -f -- "$gh_out_file"
  gh_out_file=""
  return "$status"
}

# --autoの終了時の後始末。終了コードは常に0にする。
auto_cleanup() {
  trap '' INT TERM
  trap - EXIT
  stop_gh
  if [ -n "$gh_out_file" ]; then
    rm -f -- "$gh_out_file"
  fi
  release_lock
  exit 0
}

if [ "$auto" -eq 1 ]; then
  # 標準出力には何も出さない。結果はログに書く。
  exec >/dev/null
  # 状態のディレクトリがシンボリックリンクなら、辿らずに何もしない。
  if [ -L "$state_dir" ]; then
    exit 0
  fi
  if [ ! -e "$state_dir" ]; then
    mkdir -m 700 "$state_dir" 2>/dev/null || true
  fi
  if [ -L "$state_dir" ] || [ ! -d "$state_dir" ] || [ ! -O "$state_dir" ]; then
    exit 0
  fi
  for state_name in lock log stamp failures; do
    if [ -L "$state_dir/$state_name" ]; then
      exit 0
    fi
  done
  trap auto_cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  # 順序: stampを見る → ロックを取る → 失敗の回数を先に1増やす → 片付ける。
  # 先に増やすので、途中で死んだ実行も失敗として数えられる。成功した実行が0に戻す。
  # stampが新しいときと、他の実行がロックを持っているときは、何もせず、失敗にも数えない。
  if stamp_is_fresh; then
    exit 0
  fi
  if ! acquire_lock; then
    exit 0
  fi
  write_state "$failures_file" "$(($(read_failures) + 1))" || true
  log_line "start (gh time limit ${gh_limit}s)"
fi

# lsofの実行ファイル。`WORKTREE_PRUNE_LSOF`は差し替える(テスト用)。
# 無ければ絶対パスの`/usr/sbin/lsof`、それも無ければPATHから探す。
# フックから起動されたときのPATHに`/usr/sbin`が無くても、見つけられるようにするため。
lsof_cmd=""
if [ -n "${WORKTREE_PRUNE_LSOF+x}" ]; then
  lsof_cmd="$WORKTREE_PRUNE_LSOF"
elif [ -x /usr/sbin/lsof ]; then
  lsof_cmd="/usr/sbin/lsof"
else
  lsof_cmd="$(command -v lsof || true)"
fi
if [ -n "$lsof_cmd" ] && [ ! -x "$lsof_cmd" ]; then
  lsof_cmd=""
fi

# 各プロセスのcwdの一覧。`lsof`は権限の無いプロセスで終了コード1になるが、読めた分は使う。
cwd_list=""
have_lsof=0

# lsofを実行して`cwd_list`を更新する。lsofが使えないか出力が空なら、更新せずに1を返す。
# 自分自身のcwdが必ず出るので、空なら失敗とみなす。空のまま照合すると、何も使われていないことになる。
read_cwd_list() {
  local out=""
  [ -n "$lsof_cmd" ] || return 1
  out="$("$lsof_cmd" -a -d cwd -Fpcn 2>/dev/null)" || true
  [ -n "$out" ] || return 1
  cwd_list="$out"
}

# `--ancestors`のPIDのうち、1つでも`cwd_list`にpの行として現れれば0を返す(陽性の対照)。
# lsofが呼び出し元の側を見られない環境では、何も使われていないように見える。その検出に使う。
callers_visible() {
  local line
  while IFS= read -r line; do
    case "$line" in
      p[0-9]*)
        case ",$ancestors," in
          *",${line#p},"*) return 0 ;;
        esac
        ;;
    esac
  done <<<"$cwd_list"
  return 1
}

removed=0
kept=0
# 失敗として数える事象があれば1にする。--autoでは、成功しなかった実行の印になる。
run_failed=0
# 1なら、worktreeの判定に進まずに終える。
run_aborted=0

# 標準出力の行。--autoでは標準出力に出さず、ログに書く。
emit() {
  if [ "$auto" -eq 1 ]; then
    log_line "$1"
  else
    echo "$1"
  fi
}

fail_run() {
  run_failed=1
  emit "failed: $1"
}

if [ "$auto" -eq 1 ]; then
  if [[ ! "$ancestors" =~ ^[0-9]+(,[0-9]+)*$ ]]; then
    fail_run "the ancestors are missing or malformed; removed nothing"
    run_aborted=1
  elif ! read_cwd_list; then
    fail_run "lsof is unavailable or printed nothing; removed nothing"
    run_aborted=1
  elif ! callers_visible; then
    fail_run "lsof does not show the callers; removed nothing"
    run_aborted=1
  else
    have_lsof=1
  fi
elif read_cwd_list; then
  have_lsof=1
elif [ -n "$lsof_cmd" ]; then
  echo "worktree-prune: warning: lsof returned nothing; skipped the in use check" >&2
fi

keep() {
  emit "kept: $wt_path${wt_branch:+ ($wt_branch)}: $1"
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

# 消すブランチ以外のrefが、commit `$1`を含めば0を返す(`refs/remotes/*`やタグを含む)。
# 失敗したときは含まないものとして扱い、消さない側に倒す。
has_other_ref_containing() {
  local refs ref
  refs="$(git for-each-ref --contains "$1" --format='%(refname)' 2>/dev/null)" || return 1
  while IFS= read -r ref; do
    if [ -n "$ref" ] && [ "$ref" != "refs/heads/$wt_branch" ]; then
      return 0
    fi
  done <<<"$refs"
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

  # ブランチのreflogの行数と、先頭の記録のshaと時刻と件名。
  # reflogが作成の記録だけ(または読めない)なら、commitがあった証拠が無い。
  local reflog_out="" reflog_lines=0 reflog_line first_sha="" first_time="" first_subject="" reflog_head
  reflog_out="$(git reflog show --date=unix --format='%H %gd%x09%gs' "refs/heads/$wt_branch" 2>/dev/null)" || reflog_out=""
  if [ -n "$reflog_out" ]; then
    while IFS= read -r reflog_line; do
      if [ "$reflog_lines" -eq 0 ]; then
        reflog_head="${reflog_line%%$'\t'*}"
        first_subject="${reflog_line#*$'\t'}"
        first_sha="${reflog_head%% *}"
        first_time="${reflog_head##*@\{}"
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
    # reflogの1行だけでは、作ったまま使っていないとは言い切れない。`git gc`のreflog expireで
    # 古い行が消えると、pushしていない最後のcommitの行だけが残り、同じ形になる。
    # そのため、行の件名が作成の記録で、かつ消すブランチ以外のrefがHEADのcommitを
    # 含むときに限って、独自のcommitが無いとみなす。起点がorigin/mainの祖先でなくても
    # (機能ブランチから作った場合など)、他のrefが辿れるので何も失わない。
    if [[ "$first_subject" != "branch: Created from"* ]] || ! has_other_ref_containing "$wt_head"; then
      keep "unused"
      return
    fi
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
    gh_asked=$((gh_asked + 1))
    if ! ask_gh; then
      gh_unavailable=$((gh_unavailable + 1))
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
    emit "would remove: $wt_path ($wt_branch): $how"
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
    emit "removed: $wt_path ($wt_branch): $how"
  else
    emit "removed: $wt_path, but branch $wt_branch remains (it moved from $wt_head or could not be deleted)"
  fi
  removed=$((removed + 1))
}

reset_record() {
  wt_path=""
  wt_head=""
  wt_branch=""
  wt_locked=0
}

list=""
if [ "$run_aborted" -eq 0 ]; then
  list="$(git worktree list --porcelain)"
fi
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

# マージ済みかもしれない候補が、すべてghに聞けずに残ったときは、失敗として数える。
if [ "$auto" -eq 1 ] && [ "$gh_asked" -gt 0 ] && [ "$gh_unavailable" -eq "$gh_asked" ]; then
  fail_run "gh was unavailable for every candidate that might be merged"
fi

if [ "$apply" -eq 1 ]; then
  emit "removed $removed, kept $kept"
else
  echo "dry run: would remove $removed, keep $kept. Pass --apply to remove."
fi

# 失敗として数える事象が無かった実行だけが、失敗の回数を0に戻し、実行の時刻を残す。
if [ "$auto" -eq 1 ] && [ "$run_failed" -eq 0 ]; then
  write_state "$failures_file" 0 || true
  write_state "$stamp_file" "$(date +%s)" || true
fi
