#!/usr/bin/env bash
# 夜間のバックアップ(`f/factory/backup`)の最新の世代を、defaultのworkerからホストのディレクトリへ写す。
#
# `mise run backup:export -- <保存先>`から呼ぶ。保存先は既にあるディレクトリで、
# その下に世代の名前(`YYYYMMDDTHHMMSSZ`)のディレクトリを作って写す。
# 書きかけの世代(`.partial-`で始まる名前)は写さない。
# 控えはDBの全体を含むので、写した後に所有者だけが読めるようにする。
# 別の媒体に移すのは人が行う。
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." >/dev/null 2>&1 && pwd -P)"
COMPOSE_FILE="${REPO_ROOT}/infra/docker-compose.yml"
# `f/factory/lib/backup_support.ts`の`BACKUP_ROOT`と同じ値にする。
BACKUP_ROOT="/var/lib/factory-backups"

log() { printf '[backup-export] %s\n' "$*" >&2; }
die() {
  printf '[backup-export] ERROR: %s\n' "$*" >&2
  exit 1
}

[ "$#" -eq 1 ] || die "usage: mise run backup:export -- <destination directory>"
[ -d "$1" ] || die "destination is not a directory: $1"
dest="$(cd -- "$1" >/dev/null 2>&1 && pwd -P)"

compose() {
  docker compose -f "${COMPOSE_FILE}" "$@"
}

names="$(compose exec -T windmill_worker ls -1 "${BACKUP_ROOT}")" \
  || die "could not list ${BACKUP_ROOT} in windmill_worker (is the stack running?)"
latest="$(printf '%s\n' "${names}" | grep -E '^[0-9]{8}T[0-9]{6}Z$' | sort | tail -n 1 || true)"
[ -n "${latest}" ] || die "no complete backup generation in ${BACKUP_ROOT}"
[ ! -e "${dest}/${latest}" ] || die "already exists: ${dest}/${latest}"

log "copying ${latest} to ${dest}"
compose cp "windmill_worker:${BACKUP_ROOT}/${latest}" "${dest}/${latest}"
chmod -R go-rwx "${dest}/${latest}"
printf '%s\n' "${dest}/${latest}"
