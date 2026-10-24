#!/usr/bin/env bash
# git worktreeを作り、依存を入れて、作業ディレクトリの絶対パスを標準出力の最後の行に出す。
# 進捗は標準エラーへ出す。起点は`origin/main`(フックでは設定により`HEAD`)である。
#
# 使い方:
#   scripts/worktree-new.sh <type>/<name>   (例: feat/foo)
#     ブランチ名は`<type>/<name>`、ディレクトリ名は`<type>-<name>`になる。
#   scripts/worktree-new.sh --hook
#     ClaudeのWorktreeCreateフック。標準入力のJSONの`name`と`cwd`を読み、標準出力にはパスだけを出す。
# 既にブランチ(ローカルとorigin)かディレクトリがあれば、何も変えずに非ゼロで終わる。
# ただしフックは、登録済みで期待するブランチのworktreeが既にあれば、依存を入れ直して再利用し、
# ブランチだけがあってディレクトリが無ければ、そのブランチをチェックアウトして使う。
set -euo pipefail

usage() {
  echo "usage: scripts/worktree-new.sh <type>/<name>" >&2
  echo "       scripts/worktree-new.sh --hook   (reads the WorktreeCreate JSON on stdin)" >&2
  echo "  type: feat | fix | docs | refactor | test | chore" >&2
  echo "  name: lowercase letters, digits and hyphens" >&2
}

types='feat|fix|docs|refactor|test|chore'
# 自動の片付けに渡す呼び出し元のディレクトリ。後でcdするので、先に控える。
# 消えているディレクトリから呼ばれたときは空になり、起動のときにメインのcheckoutで代える。
caller_dir="$(pwd -P 2>/dev/null)" || caller_dir=""
# 相対パスで呼ばれても、後のcdで見失わないよう、このスクリプトのあるディレクトリを控える。
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
hook=0
hook_cwd=""
# 追加のgitの引数。フックのときだけ、通信の待ちを制限する。
net_opts=()

if [ "$#" -eq 1 ] && [ "$1" = "--hook" ]; then
  hook=1
  # Claudeがmiseを有効にしていないシェルから呼ぶので、jqとmiseがある場所を足す。
  # `WORKTREE_NEW_EXTRA_PATH`は足す場所を差し替える(テスト用)。空なら足さない。
  extra_path="${WORKTREE_NEW_EXTRA_PATH-/opt/homebrew/bin:/usr/local/bin}"
  if [ -n "$extra_path" ]; then
    PATH="$extra_path:$PATH"
    export PATH
  fi
  if ! command -v jq >/dev/null 2>&1; then
    echo "worktree-new: jq is required for --hook but was not found in PATH" >&2
    exit 1
  fi
  input="$(cat)"
  if ! name="$(printf '%s' "$input" | jq -er '.name | select(type == "string")')"; then
    echo "worktree-new: the hook input is not JSON with a string \"name\"" >&2
    exit 2
  fi
  hook_cwd="$(printf '%s' "$input" | jq -r '.cwd | select(type == "string")')"
  if [ -n "$hook_cwd" ] && [ -d "$hook_cwd" ]; then
    cd "$hook_cwd"
    caller_dir="$(pwd -P)"
  fi
  # オフラインや遅い回線でも、subagentの起動を長く止めないよう、fetchとls-remoteの待ちを制限する。
  # HTTPSは20秒間1KB/s未満なら諦める。sshは、つながらなければ15秒で諦め、パスワードを聞かない。
  # sshの設定は、利用者の`core.sshCommand`、`GIT_SSH`、`GIT_SSH_COMMAND`を上書きしないよう、
  # どれも無いときだけ足す。環境変数にはexportしない。子プロセス(bun install)に渡さないため。
  net_opts=(-c http.lowSpeedLimit=1000 -c http.lowSpeedTime=20)
  ssh_configured="$(git config --get core.sshCommand || true)"
  if [ -z "$ssh_configured" ] && [ -z "${GIT_SSH:-}" ] && [ -z "${GIT_SSH_COMMAND:-}" ]; then
    net_opts+=(-c "core.sshCommand=ssh -o ConnectTimeout=15 -o BatchMode=yes")
  fi
  # 名前を、ブランチ名とディレクトリ名に使える形にそろえる。
  # `/`、`.`、`..`は`-`になり、パスの区切りを含められない。
  slug="$(printf '%s' "$name" | LC_ALL=C tr 'A-Z' 'a-z' | LC_ALL=C sed -e 's/[^a-z0-9-]/-/g' -e 's/--*/-/g' -e 's/^-//' -e 's/-$//')"
  if [ -z "$slug" ]; then
    echo "worktree-new: the name has no usable characters: $name" >&2
    exit 2
  fi
  hook_pattern="^($types)-(.+)$"
  if [[ "$slug" =~ $hook_pattern ]]; then
    branch="${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
  else
    branch="worktree-$slug"
  fi
  dir_name="$slug"
else
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
fi

# 依存を入れるコマンド。`WORKTREE_NEW_BUN`は実行ファイルを差し替える(テスト用)。
# フックはmiseを有効にしていないシェルから呼ばれるので、miseがあれば`mise exec -- bun`で動かす。
# 引数は`mise run setup`と同じ。
if [ -n "${WORKTREE_NEW_BUN:-}" ]; then
  bun_cmd=("$WORKTREE_NEW_BUN")
elif [ "$hook" -eq 1 ] && command -v mise >/dev/null 2>&1; then
  bun_cmd=(mise exec -- bun)
else
  bun_cmd=(bun)
fi
if ! command -v "${bun_cmd[0]}" >/dev/null 2>&1; then
  echo "worktree-new: ${bun_cmd[0]} is required to install the dependencies but was not found in PATH" >&2
  exit 1
fi

# 置き場所は、相対パスではなくメインのcheckoutの絶対パスから決める。
# 別のworktreeの中から実行しても、その中に入れ子にならないようにするため。
common_dir="$(git rev-parse --path-format=absolute --git-common-dir)"
# bareリポジトリなど`.git`でない場合は、メインのcheckoutの場所を決められない。
if [ "$(basename "$common_dir")" != ".git" ]; then
  echo "worktree-new: cannot locate the main checkout from $common_dir" >&2
  exit 1
fi
# フックに返すパスはシンボリックリンクを通ってはならないので、実パスにそろえる。
main_root="$(cd "$(dirname "$common_dir")" && pwd -P)"
# メインのcheckout直下の`mise.local.toml`(秘密値)は、miseの親ディレクトリ探索で
# `.claude/worktrees/`の下にも引き継がれるので、秘密値を複製しない。
# ただし`mise.toml`にもあるキー(例: `WM_HTTP_PORT`)を`mise.local.toml`で上書きしても、
# worktree側の`mise.toml`のほうが近いので、worktreeには引き継がれない。
worktree_path="$main_root/.claude/worktrees/$dir_name"

# フックが作ったworktreeを、`claude --worktree foo`の2回目などで再び求められたときに、
# 起動を止めないよう再利用する。パスが登録済みで、期待するブランチのときだけ成功にする。
# 登録の無いディレクトリや、別のブランチのworktreeは、混ざるおそれがあるので失敗にする。
is_registered_with_branch() {
  local list line in_target=0
  list="$(git worktree list --porcelain)"
  while IFS= read -r line; do
    case "$line" in
      "worktree $worktree_path") in_target=1 ;;
      "worktree "*) in_target=0 ;;
      "branch refs/heads/$branch")
        if [ "$in_target" -eq 1 ]; then
          return 0
        fi
        ;;
    esac
  done <<<"$list"
  return 1
}

if [ -e "$worktree_path" ]; then
  if [ "$hook" -eq 1 ] && is_registered_with_branch; then
    # 依存の導入がKILLなどで途中で止まったworktreeを、依存が欠けたまま成功として返さないよう、
    # 導入をやり直す(すでに入っていれば速く終わる)。再利用したworktreeは自分が作ったものでは
    # ないので、失敗しても消さない。
    echo "worktree-new: reusing the existing worktree: $worktree_path" >&2
    cd "$worktree_path"
    "${bun_cmd[@]}" install --frozen-lockfile --ignore-scripts >&2
    "${bun_cmd[@]}" install --cwd console --frozen-lockfile --ignore-scripts >&2
    echo "$worktree_path"
    exit 0
  fi
  echo "worktree-new: directory already exists: $worktree_path" >&2
  exit 1
fi

# フックだけは、ブランチがあってディレクトリが無いとき(worktreeだけ消えた後など)に、
# 既存のローカルブランチをそのまま使う。別のworktreeがチェックアウト済みならgitが拒む。
# このブランチは自分が作ったものではないので、失敗しても消さない。
existing_branch=0
if git show-ref --verify --quiet "refs/heads/$branch"; then
  if [ "$hook" -ne 1 ]; then
    echo "worktree-new: branch already exists: $branch" >&2
    exit 1
  fi
  existing_branch=1
  echo "worktree-new: using the existing branch: $branch" >&2
fi

# Claude Codeの設定`worktree.baseRef`を読む。`head`ならフックのcwdの`HEAD`から作り、
# それ以外(未設定、`fresh`、不正な値)は`origin/main`から作る。
# 読む先は、メインのcheckoutの`.claude/settings.local.json`、`.claude/settings.json`、
# ユーザーの`~/.claude/settings.json`で、値が見つかった最初のファイルに従う。
# フックのcwdの設定は読まない。EnterWorktreeの後はcwdがworktreeになり、古い設定が先に効くため。
# 壊れて読めないファイルは、作成を止めずに飛ばす。
resolve_base_ref() {
  local file value
  for file in \
    "$main_root/.claude/settings.local.json" \
    "$main_root/.claude/settings.json" \
    "${HOME:-/nonexistent}/.claude/settings.json"; do
    if [ ! -f "$file" ]; then
      continue
    fi
    if value="$(jq -r '.worktree.baseRef // empty' "$file" 2>/dev/null)" && [ -n "$value" ]; then
      echo "$value"
      return
    fi
  done
  echo "fresh"
}

# 新しいブランチの起点`base_sha`を決め、originに同名のブランチが無いことを確かめる。
prepare_new_branch() {
  local base_ref="fresh"
  if [ "$hook" -eq 1 ]; then
    base_ref="$(resolve_base_ref)"
  fi

  if [ "$base_ref" = "head" ]; then
    # 現在の作業を起点にするので、fetchはしない。
    echo "worktree-new: worktree.baseRef is head; branching from HEAD" >&2
    if ! base_sha="$(git rev-parse --verify HEAD)"; then
      echo "worktree-new: HEAD does not resolve to a commit" >&2
      exit 1
    fi
  else
    # フックはsubagentの起動に使われる。オフラインでもsubagentを止めないよう、
    # フックのときだけ、fetchとoriginの検査の失敗を警告にして続ける。
    # 取り込み済みの`refs/remotes/origin/main`が無ければ、起点が決められないので失敗する。
    echo "worktree-new: fetching origin/main" >&2
    if ! git ${net_opts[@]+"${net_opts[@]}"} fetch origin main >&2; then
      if [ "$hook" -ne 1 ]; then
        exit 1
      fi
      echo "worktree-new: warning: fetch failed, using the existing refs/remotes/origin/main" >&2
    fi

    # 短い`origin/main`は同名のブランチやタグに解決されうるので、完全な名前で指す。
    if ! base_sha="$(git show-ref --verify --hash refs/remotes/origin/main)"; then
      echo "worktree-new: refs/remotes/origin/main does not exist" >&2
      exit 1
    fi
  fi

  # originに同名のブランチがあると、最初のpushが拒否されるか、他の作業に混ざる。
  # `ls-remote --exit-code`は、一致が無いと2、通信などの失敗はそれ以外で終わる。
  # この検査から最初のpushまでの間に、他の人が同名のブランチをpushするレースは受け入れる。
  local remote_status=0
  git ${net_opts[@]+"${net_opts[@]}"} ls-remote --exit-code --heads origin "refs/heads/$branch" >/dev/null || remote_status=$?
  if [ "$remote_status" -eq 0 ]; then
    echo "worktree-new: branch already exists on origin: $branch" >&2
    exit 1
  fi
  if [ "$remote_status" -ne 2 ]; then
    if [ "$hook" -ne 1 ]; then
      echo "worktree-new: cannot check the branch on origin (exit $remote_status)" >&2
      exit 1
    fi
    echo "worktree-new: warning: cannot check the branch on origin (exit $remote_status), continuing" >&2
  fi
}

base_sha=""
if [ "$existing_branch" -eq 0 ]; then
  prepare_new_branch
fi

# 新しいworktreeを作れたあとに、マージ済みのworktreeの自動の片付けを、バックグラウンドで起動する。
# 起動する側は待たない。フックの呼び出し元が子の終了まで標準出力を待たないよう、
# 標準入力、標準出力、標準エラーのすべてを切り離す。macOSには`setsid`が無い。
# 片付けは、呼び出し元のディレクトリで起動する。呼び出したセッションのworktreeを、
# 片付けが`current directory`として残すため。
# `gh`はmiseのツールで、フックのPATHから解決できない。miseのshimsを子のPATHの末尾にだけ足す。
# 末尾なので、システムのコマンドを覆わない。
# 既存のworktreeを再利用する経路では呼ばない。再利用したworktreeを、片付けが消しうるため。
# `WORKTREE_AUTO_PRUNE`が未設定か`1`のときだけ起動する。`WORKTREE_NEW_PRUNE_SCRIPT`は、
# 起動するスクリプトを差し替える(テスト用)。
start_auto_prune() {
  local prune_script state_dir failures value ancestors pid depth dir
  if [ "${WORKTREE_AUTO_PRUNE-1}" != "1" ]; then
    return 0
  fi

  # 前の自動の実行が続けて失敗しているときは、標準エラーに知らせる。標準出力はパスだけにする。
  # 数字だけを数として読み、数字でない中身は表示しない。
  state_dir="$common_dir/worktree-prune"
  failures="$state_dir/failures"
  if [ ! -L "$state_dir" ] && [ -f "$failures" ] && [ ! -L "$failures" ]; then
    value="$(cat -- "$failures" 2>/dev/null || true)"
    if [[ "$value" =~ ^[0-9]{1,9}$ ]] && [ "$((10#$value))" -ge 2 ]; then
      echo "worktree-new: automatic worktree cleanup failed $((10#$value)) times in a row; see $state_dir/log" >&2
    fi
  fi

  prune_script="${WORKTREE_NEW_PRUNE_SCRIPT:-$script_dir/worktree-prune.sh}"
  if [ ! -f "$prune_script" ]; then
    echo "worktree-new: warning: cannot start the automatic worktree cleanup; not found: $prune_script" >&2
    return 0
  fi

  # 自分から親をたどったPIDの一覧(PID 1は除く)。片付けは、lsofの出力にこのどれかが現れることを
  # 確かめ、lsofが呼び出し元の側を見られない環境で何も消さないようにする。
  ancestors=""
  pid="$$"
  depth=0
  while [[ "$pid" =~ ^[0-9]+$ ]] && [ "$pid" -gt 1 ] && [ "$depth" -lt 64 ]; do
    ancestors="${ancestors:+$ancestors,}$pid"
    pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')" || pid=""
    depth=$((depth + 1))
  done

  dir="$caller_dir"
  if [ -z "$dir" ] || [ ! -d "$dir" ]; then
    dir="$main_root"
  fi
  (
    (
      cd "$dir" && exec env PATH="$PATH:${HOME:-/nonexistent}/.local/share/mise/shims" \
        nohup "$BASH" "$prune_script" --auto --ancestors "$ancestors"
    ) </dev/null >/dev/null 2>&1 &
  ) || true
}

# 後始末の対象は、`git worktree add`の成功から依存の導入の完了までに限る。
# ここまでの検査で止まったときは、既存のブランチやディレクトリを消さない。
# 完成したあとの失敗や中断では、できあがったworktreeを消さない。
# worktreeは強制せずに消す。`git worktree remove`は、gitに無視されたファイル
# (node_modules、`*.local.*`、`.wmill`など)を黙って消す。ここで消してよいのは、
# 作ったばかりのworktreeに依存の導入が残したものだけ、という前提による。
# 未追跡のファイルや変更があれば、gitが拒む。
# ブランチは、作った時点の`base_sha`を指すままのときだけ消す。コミットが増えていれば、gitが拒む。
# 既存のブランチを使ったとき(`existing_branch`)は、自分が作ったものではないので、ブランチを消さない。
# 片付けの最中の中断で、worktreeだけが消えてブランチが残らないよう、INTとTERMは無視する。
# TERMは、前景で動くbunが終わるまでtrapが遅れる。KILLでは後始末が走らない。
# そうして残った作りかけは、`mise run worktree:prune`が放置されたものとして片付ける。
created=0
cleanup() {
  local rc=$?
  trap '' INT TERM
  trap - EXIT
  if [ "$created" -eq 1 ] && [ "$rc" -ne 0 ]; then
    echo "worktree-new: failed (exit $rc), removing $worktree_path" >&2
    cd "$main_root" || true
    if git worktree remove "$worktree_path" >&2; then
      if [ "$existing_branch" -eq 1 ]; then
        echo "worktree-new: removed. The existing branch $branch is kept. Fix the cause and rerun" >&2
      elif git update-ref -d "refs/heads/$branch" "$base_sha" >&2; then
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
if [ "$existing_branch" -eq 1 ]; then
  add_status=0
  git worktree add "$worktree_path" "$branch" >&2 || add_status=$?
else
  add_status=0
  git worktree add --no-track -b "$branch" "$worktree_path" "$base_sha" >&2 || add_status=$?
fi
if [ "$add_status" -ne 0 ]; then
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
cd "$worktree_path"
echo "worktree-new: installing dependencies" >&2
"${bun_cmd[@]}" install --frozen-lockfile --ignore-scripts >&2
"${bun_cmd[@]}" install --cwd console --frozen-lockfile --ignore-scripts >&2
created=0

# 起動に失敗しても、作成の結果(終了コードと標準出力のパス)は変えない。
start_auto_prune || true

echo "worktree-new: first push: git push -u origin HEAD" >&2
echo "$worktree_path"
