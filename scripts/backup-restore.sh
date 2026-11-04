#!/usr/bin/env bash
# バックアップの世代を、使い捨てのcomposeのプロジェクト`factory-restore`に戻して、戻せることを確かめる。
#
# `mise run backup:restore -- <世代のディレクトリ>`から呼ぶ。
# ディレクトリには`cluster.sql`(`pg_dumpall`の出力)と`factory_state.tar`が要る。
# プロジェクトの名前が違うので、volumeは`factory-restore_*`になり、本番の`infra`のvolumeには触れない。
# `db`だけを起動し、`cluster.sql`を流し、`factory_state.tar`を同じプロジェクトの`factory_state`に展開する。
# 終わりに、作業項目と通知の行数と、要件定義書のファイル数を出す。
# 使い捨てのプロジェクトは消さない。`down -v`を自動で実行しないため、消すコマンドを出して人に任せる。
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." >/dev/null 2>&1 && pwd -P)"
COMPOSE_FILE="${REPO_ROOT}/infra/docker-compose.yml"
PROJECT="factory-restore"
# `pg_dumpall`は、接続したsuperuserのロールにも`CREATE ROLE`を出す。
# 戻し先には同じロールが既にあり、`ON_ERROR_STOP`で止まるので、この1行だけを除く。
SKIP_LINE='CREATE ROLE postgres;'
# Data Tableのデータベース。`scripts/check-idle.ts`の`DATATABLE_DB`と同じ値にする。
DATATABLE_DB="datatable_db"
CLEANUP_COMMAND="mise exec -- docker compose -p ${PROJECT} -f infra/docker-compose.yml down -v"

log() { printf '[backup-restore] %s\n' "$*" >&2; }
die() {
  printf '[backup-restore] ERROR: %s\n' "$*" >&2
  exit 1
}

[ "$#" -eq 1 ] || die "usage: mise run backup:restore -- <generation directory>"
[ -d "$1" ] || die "not a directory: $1"
gen_dir="$(cd -- "$1" >/dev/null 2>&1 && pwd -P)"
for name in cluster.sql factory_state.tar; do
  [ -f "${gen_dir}/${name}" ] || die "missing ${name} in ${gen_dir}"
done

compose() {
  docker compose -p "${PROJECT}" -f "${COMPOSE_FILE}" "$@"
}

# 前の実行の残りに流し直すと、既にある行で止まるか、混ざった結果を数えるため、残りがあれば止まる。
# コンテナが消えてもvolumeだけが残ることがあるので、volumeも調べる。
[ -z "$(compose ps -a -q db)" ] \
  || die "the throwaway project ${PROJECT} already has a db container; remove it with: ${CLEANUP_COMMAND}"
[ -z "$(docker volume ls -q --filter "label=com.docker.compose.project=${PROJECT}")" ] \
  || die "the throwaway project ${PROJECT} already has volumes; remove them with: ${CLEANUP_COMMAND}"

log "starting db in the throwaway project ${PROJECT}"
compose up -d --wait db

# 初回の起動では、公式のイメージが一時的なサーバーをソケットだけで動かして初期化する。
# その間もソケットへの確かめは通るので、TCPで受け付けるまで待つ。
ready=0
for _ in $(seq 1 60); do
  if compose exec -T db pg_isready -q -h 127.0.0.1 -U postgres; then
    ready=1
    break
  fi
  sleep 1
done
[ "${ready}" -eq 1 ] || die "db did not accept TCP connections within 60 seconds"

# イメージが`POSTGRES_DB`で作った空の`windmill`を消す。`cluster.sql`が`CREATE DATABASE windmill`を含むため。
log "dropping the empty windmill database"
compose exec -T db psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres -c 'DROP DATABASE windmill'

log "restoring cluster.sql"
grep -v -x -F "${SKIP_LINE}" "${gen_dir}/cluster.sql" \
  | compose exec -T db psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres >/dev/null

# `factory_state_init`はケーパビリティをすべて落としているので、所有者だけが読めるホストのファイルを
# bindで読めない。アーカイブは標準入力で渡す。所有者はコンテナのrootにそろえる。
# サービスの`pull_policy: always`を引き継がないよう`--pull missing`を付け、レジストリに問い合わせない。
log "extracting factory_state.tar"
compose run --pull missing --rm --no-deps -T --entrypoint tar factory_state_init \
  --no-same-owner -xf - -C /var/lib/factory <"${gen_dir}/factory_state.tar"

count_rows() {
  compose exec -T db psql -X -A -t -v ON_ERROR_STOP=1 -U postgres -d "${DATATABLE_DB}" \
    -c "SELECT count(*) FROM $1"
}
work_items="$(count_rows factory.work_items)"
notices="$(count_rows factory.notices)"
requirements="$(compose run --pull missing --rm --no-deps -T --entrypoint find factory_state_init \
  /var/lib/factory/requirements -type f | wc -l | tr -d ' ')"

printf 'factory.work_items rows: %s\n' "${work_items}"
printf 'factory.notices rows: %s\n' "${notices}"
printf 'requirements files: %s\n' "${requirements}"
printf 'remove the throwaway project with: %s\n' "${CLEANUP_COMMAND}"
