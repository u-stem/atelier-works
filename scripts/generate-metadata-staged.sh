#!/usr/bin/env bash
# `f/`の下でステージされたファイルについてWindmillのメタデータ(ロック、
# scriptのスキーマ、`wmill-lock.yaml`のハッシュ)を作り直し、
# `wmill generate-metadata`が変更・作成したファイルをステージして、
# コミットに最新のメタデータを含める。
#
# lefthookのpre-commitの`wmill-metadata`(`lefthook.yml`を参照)として、
# `glob: "f/**"`の条件付きで動かす前提。下のステージ済みの変更の確認は、
# 直接・手で呼んだときの安全策。
#
# 移植性: bash 3.2(macOSの`/bin/bash`)向けに書いており、`mapfile`も連想配列も
# 使わない。パスは一貫してNUL区切りで扱う。`f/`の下のWindmillのパスは
# 普通のASCIIの識別子なのでエスケープの問題は起きないはずだが、それに頼らない。
#
# 既知の制限(lefthookの`stage_fixed`と同じ): 変更されたファイルは、作業ツリーの
# 内容ごとステージする。`f/`の下の追跡中のファイルに、意図してステージしていない
# 無関係な編集があり、かつ`generate-metadata`が同じファイルを書き換えると、
# その編集もコミットに入る。ロックやスキーマのファイルは実際には手で編集しないので、
# 防がずに受け入れている。
set -euo pipefail

# 追跡中のファイル(`wmill-lock.yaml`と`f/`)ごとに`<path>\t<hash>`を
# `git ls-files`の順で書き、前後のファイルを行ごとに比べられるようにする。
# 消えたファイルのハッシュは空になる。
#
# 数百件に1件ずつ`git hash-object`を起動すると数秒かかるので、存在するパスだけを
# 1回の`git hash-object --stdin-paths`に渡す。一括にするときの落とし穴は次のとおり。
# - 2回の取得の間に消えたパスが一括処理全体を止める。先に`-e`で絞り、
#   それでも失敗したら1件ずつに戻る。
# - `--stdin-paths`は行区切りで読み、行末のCRを落とす。改行かCRを含むパスが
#   あれば1件ずつに戻る。先頭が二重引用符のパスは引用符付きとして解釈されるが、
#   対象の`git ls-files -- wmill-lock.yaml f`は`f`か`wmill-lock.yaml`で始まる
#   パスしか返さないので、その分岐は置かない。
# - 出力は入力と1対1なので、存在したパスの順に出力の行を割り当てる。
#   行数が合わなければ1件ずつに戻る。
hash_tracked_files_one_by_one() {
  local out_file="$1"
  local path hash
  : >"$out_file"
  while IFS= read -r -d '' path; do
    hash="$(git hash-object -- "$path" 2>/dev/null || true)"
    printf '%s\t%s\n' "$path" "$hash" >>"$out_file"
  done < <(git ls-files -z -- wmill-lock.yaml f)
}

hash_tracked_files() {
  local out_file="$1"
  local paths=() present=() existing=() hashes=()
  local path hash batch_output index=0 next=0
  local newline=$'\n' carriage_return=$'\r'

  while IFS= read -r -d '' path; do
    case "$path" in
      *"$newline"* | *"$carriage_return"*)
        hash_tracked_files_one_by_one "$out_file"
        return 0
        ;;
    esac
    paths+=("$path")
    if [ -e "$path" ]; then
      present+=(1)
      existing+=("$path")
    else
      present+=(0)
    fi
  done < <(git ls-files -z -- wmill-lock.yaml f)

  if [ "${#paths[@]}" -eq 0 ]; then
    : >"$out_file"
    return 0
  fi

  if [ "${#existing[@]}" -gt 0 ]; then
    if ! batch_output="$(printf '%s\n' "${existing[@]}" | git hash-object --stdin-paths 2>/dev/null)"; then
      hash_tracked_files_one_by_one "$out_file"
      return 0
    fi
    while IFS= read -r hash; do
      hashes+=("$hash")
    done <<<"$batch_output"
    if [ "${#hashes[@]}" -ne "${#existing[@]}" ]; then
      hash_tracked_files_one_by_one "$out_file"
      return 0
    fi
  fi

  for path in "${paths[@]}"; do
    if [ "${present[$index]}" -eq 1 ]; then
      hash="${hashes[$next]}"
      next=$((next + 1))
    else
      hash=""
    fi
    printf '%s\t%s\n' "$path" "$hash"
    index=$((index + 1))
  done >"$out_file"
}

# テストが関数だけを`source`できるように、直接実行されたときだけ以降を動かす。
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  return 0
fi

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

if [ -z "$(git diff --cached --name-only -- f)" ]; then
  exit 0
fi

before_hashes_file="$(mktemp)"
after_hashes_file="$(mktemp)"
before_untracked_file="$(mktemp)"
after_untracked_file="$(mktemp)"
wmill_output_file="$(mktemp)"
trap 'rm -f "$before_hashes_file" "$after_hashes_file" "$before_untracked_file" "$after_untracked_file" "$wmill_output_file"' EXIT

hash_tracked_files "$before_hashes_file"
git ls-files --others --exclude-standard -z -- f >"$before_untracked_file"

# 失敗の原因を出力から見分けるため、出力を残しながらそのまま表示する。
if ! wmill generate-metadata --yes 2>&1 | tee "$wmill_output_file"; then
  if grep -q "No workspace profile found" "$wmill_output_file"; then
    "$repo_root/scripts/print-wmill-profile-hint.sh" >&2
  else
    cat >&2 <<'MESSAGE'
ローカルWindmillに接続できませんでした。`mise run up`で起動してから再度コミットしてください。
MESSAGE
  fi
  cat >&2 <<'MESSAGE'
このpre-commitフックを一時的に飛ばす場合は`LEFTHOOK_EXCLUDE=wmill-metadata git commit ...`を使ってください(push前に`mise run metadata`で追従させること)。
MESSAGE
  exit 1
fi

hash_tracked_files "$after_hashes_file"
git ls-files --others --exclude-standard -z -- f >"$after_untracked_file"

staged_paths=()

# 内容のハッシュが変わった追跡中のファイルを集める。前後の一覧は同じパスを
# 同じ順で並べるので、`paste`だけで突き合わせられる。
while IFS=$'\t' read -r path before_hash after_path after_hash; do
  if [ "$path" != "$after_path" ]; then
    echo "generate-metadata-staged: tracked file list changed during regeneration; aborting" >&2
    exit 1
  fi
  if [ "$before_hash" != "$after_hash" ]; then
    staged_paths+=("$path")
  fi
done < <(paste "$before_hashes_file" "$after_hashes_file")

# `f/`の下に新しく作られたファイル(前は未追跡で、後にある)を集める。
while IFS= read -r -d '' path; do
  if ! grep -qzxF -- "$path" "$before_untracked_file"; then
    staged_paths+=("$path")
  fi
done <"$after_untracked_file"

if [ "${#staged_paths[@]}" -eq 0 ]; then
  echo "メタデータは最新でした"
  exit 0
fi

for path in "${staged_paths[@]}"; do
  if [ -e "$path" ]; then
    git add -- "$path"
  else
    # `generate-metadata`が追跡中だったファイル(古いロックなど)を削除した。
    git rm --ignore-unmatch --quiet -- "$path"
  fi
done
printf '%s\n' "${staged_paths[@]}"
