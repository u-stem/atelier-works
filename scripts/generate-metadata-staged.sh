#!/usr/bin/env bash
# Regenerates Windmill metadata (locks, script schemas, wmill-lock.yaml hashes)
# for files staged under f/, then stages whatever `wmill generate-metadata`
# changed or created so the commit includes fresh metadata.
#
# Intended to run as the lefthook pre-commit job "wmill-metadata" (see
# lefthook.yml), gated by `glob: "f/**"`. The staged-changes check below is a
# safety net for direct/manual invocation.
#
# Portability: written for bash 3.2 (macOS /bin/bash) — no mapfile, no
# associative arrays. Paths are handled NUL-delimited throughout; Windmill
# paths under f/ are plain ASCII identifiers, so no escaping edge cases are
# expected, but nothing here relies on that.
#
# Known limitation (same as lefthook's `stage_fixed`): a changed file is
# staged with its whole working-tree content. If a tracked file under f/ had
# unrelated, deliberately unstaged edits AND generate-metadata rewrote that
# same file, those edits are swept into the commit. Lock/schema files are not
# hand-edited in practice, so this is accepted rather than guarded against.
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

if [ -z "$(git diff --cached --name-only -- f)" ]; then
  exit 0
fi

before_hashes_file="$(mktemp)"
after_hashes_file="$(mktemp)"
before_untracked_file="$(mktemp)"
after_untracked_file="$(mktemp)"
trap 'rm -f "$before_hashes_file" "$after_hashes_file" "$before_untracked_file" "$after_untracked_file"' EXIT

# Writes "<path>\t<hash>" per tracked file (wmill-lock.yaml + f/), in
# `git ls-files` order, so before/after files can be compared line by line.
# Each file is hashed individually (not via one `git hash-object
# --stdin-paths` call) so a path that disappears between snapshots cannot
# abort the whole batch and desync the path/hash pairing; a vanished file
# yields an empty hash.
hash_tracked_files() {
  local out_file="$1"
  local path hash
  : >"$out_file"
  while IFS= read -r -d '' path; do
    hash="$(git hash-object -- "$path" 2>/dev/null || true)"
    printf '%s\t%s\n' "$path" "$hash" >>"$out_file"
  done < <(git ls-files -z -- wmill-lock.yaml f)
}

hash_tracked_files "$before_hashes_file"
git ls-files --others --exclude-standard -z -- f >"$before_untracked_file"

if ! wmill generate-metadata --yes; then
  cat >&2 <<'MESSAGE'
ローカルWindmillに接続できませんでした。`mise run up`で起動してから再度コミットしてください。
このpre-commitフックを一時的に飛ばす場合は`LEFTHOOK_EXCLUDE=wmill-metadata git commit ...`を使ってください(push前に`mise run metadata`で追従させること)。
MESSAGE
  exit 1
fi

hash_tracked_files "$after_hashes_file"
git ls-files --others --exclude-standard -z -- f >"$after_untracked_file"

staged_paths=()

# Tracked files whose content hash changed. Both snapshots list the same
# paths in the same order, so `paste` lines them up without any lookup.
while IFS=$'\t' read -r path before_hash after_path after_hash; do
  if [ "$path" != "$after_path" ]; then
    echo "generate-metadata-staged: tracked file list changed during regeneration; aborting" >&2
    exit 1
  fi
  if [ "$before_hash" != "$after_hash" ]; then
    staged_paths+=("$path")
  fi
done < <(paste "$before_hashes_file" "$after_hashes_file")

# Files newly created under f/ (untracked before, present after).
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
    # generate-metadata removed a previously tracked file (e.g. a stale lock).
    git rm --ignore-unmatch --quiet -- "$path"
  fi
done
printf '%s\n' "${staged_paths[@]}"
