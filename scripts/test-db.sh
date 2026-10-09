#!/usr/bin/env bash
# migrationのmediumテスト。composeのPostgresのコンテナ内の使い捨ての
# `factory_test`データベースに`migrations/datatable/main/*.up.sql`をすべて
# 適用し、`factory`スキーマの各ビューからSELECTしてビューが成り立つことを
# 確かめる。次に対応する`*.down.sql`を新しい順に適用し、戻せることを確かめる。
# 使い捨てのデータベースは成否を問わず終了時に削除し、本物の`windmill`
# データベースには触れない。
#
# ローカルのスタックが動いている必要がある(`mise run up`)。
# `mise run test:db`から呼ぶ。
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." >/dev/null 2>&1 && pwd -P)"
COMPOSE_FILE="${REPO_ROOT}/infra/docker-compose.yml"
MIGRATIONS_DIR="${REPO_ROOT}/migrations/datatable/main"
SCRATCH_DB="factory_test"

log() { printf '[test-db] %s\n' "$*" >&2; }
die() {
  printf '[test-db] ERROR: %s\n' "$*" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || die "docker not found"
[ -f "${COMPOSE_FILE}" ] || die "compose file not found: ${COMPOSE_FILE}"

compose() {
  docker compose -f "${COMPOSE_FILE}" "$@"
}

db_id="$(compose ps -q db 2>/dev/null || true)"
[ -n "${db_id}" ] || die "the 'db' service is not running (run 'mise run up' first)"
[ "$(docker inspect -f '{{.State.Running}}' "${db_id}" 2>/dev/null || echo false)" = "true" ] \
  || die "the 'db' service is not running (run 'mise run up' first)"

# psql_exec DBNAME: 標準入力からSQLを読み、DBNAMEに対してpsqlを実行する。
psql_exec() {
  local db="$1"
  shift
  compose exec -T db psql -v ON_ERROR_STOP=1 -U postgres -d "${db}" "$@"
}

cleanup() {
  compose exec -T db psql -v ON_ERROR_STOP=1 -U postgres -d windmill \
    -c "DROP DATABASE IF EXISTS ${SCRATCH_DB};" >/dev/null 2>&1 || true
}
trap cleanup EXIT

log "creating scratch database '${SCRATCH_DB}'"
compose exec -T db psql -v ON_ERROR_STOP=1 -U postgres -d windmill \
  -c "DROP DATABASE IF EXISTS ${SCRATCH_DB};" >/dev/null
compose exec -T db psql -v ON_ERROR_STOP=1 -U postgres -d windmill \
  -c "CREATE DATABASE ${SCRATCH_DB};" >/dev/null

shopt -s nullglob
up_files=("${MIGRATIONS_DIR}"/*.up.sql)
shopt -u nullglob
[ ${#up_files[@]} -gt 0 ] || die "no migrations found in ${MIGRATIONS_DIR}"

ACTIVE_ISSUE_MIGRATION="20261009120000_active_issue_key.up.sql"

# 稼働中のIssueの作業項目の部分一意インデックスを足す前に、重複した稼働中の行を入れておく。
# migrationが古い方を取り消し、インデックスを作れることを確かめるため。
seed_active_issue_duplicates() {
  psql_exec "${SCRATCH_DB}" <<'SQL' >/dev/null
INSERT INTO factory.work_items (cycle, source, kind, owner, repo, issue_number, issue_url, title, status) VALUES
  (1, 'issue', 'issue', 'o', 'r', 1, 'https://github.com/o/r/issues/1', 't', 'picked'),
  (2, 'issue', 'issue', 'o', 'r', 1, 'https://github.com/o/r/issues/1', 't', 'requirements_generating'),
  (1, 'issue', 'issue', 'o', 'r', 2, 'https://github.com/o/r/issues/2', 't', 'failed'),
  (2, 'issue', 'issue', 'o', 'r', 2, 'https://github.com/o/r/issues/2', 't', 'picked');
SQL
}

# 部分一意インデックスが、同じIssueの2件目の稼働中の行を拒み、
# ON CONFLICT DO NOTHINGでは行を挿入せず、終端の行は拒まないことを確かめる。
verify_active_issue_index() {
  local cancelled
  cancelled="$(printf "SELECT count(*) FROM factory.work_items WHERE issue_number = 1 AND status = 'cancelled';\n" \
    | psql_exec "${SCRATCH_DB}" -q -t -A 2>/dev/null || true)"
  [ "$(printf '%s' "${cancelled}" | tr -d '[:space:]')" = "1" ] \
    || die "expected exactly one duplicate active row to be cancelled, got '${cancelled}'"
  local events
  events="$(printf "SELECT count(*) FROM factory.work_item_events WHERE to_status = 'cancelled';\n" \
    | psql_exec "${SCRATCH_DB}" -q -t -A 2>/dev/null || true)"
  [ "$(printf '%s' "${events}" | tr -d '[:space:]')" = "1" ] \
    || die "expected one work_item_events row for the cancelled duplicate, got '${events}'"

  local insert_active="INSERT INTO factory.work_items (cycle, source, kind, owner, repo, issue_number, issue_url, title, status) VALUES (9, 'issue', 'issue', 'o', 'r', 1, 'https://github.com/o/r/issues/1', 't', 'picked')"
  if printf '%s;\n' "${insert_active}" | psql_exec "${SCRATCH_DB}" >/dev/null 2>&1; then
    die "a second active issue work item was accepted"
  fi
  local skipped
  skipped="$(printf '%s ON CONFLICT DO NOTHING RETURNING id;\n' "${insert_active}" \
    | psql_exec "${SCRATCH_DB}" -q -t -A 2>/dev/null || true)"
  [ -z "$(printf '%s' "${skipped}" | tr -d '[:space:]')" ] \
    || die "ON CONFLICT DO NOTHING inserted a second active issue work item"
  printf "INSERT INTO factory.work_items (cycle, source, kind, owner, repo, issue_number, issue_url, title, status) VALUES (9, 'issue', 'issue', 'o', 'r', 3, 'https://github.com/o/r/issues/3', 't', 'failed');\n" \
    | psql_exec "${SCRATCH_DB}" >/dev/null \
    || die "a terminal issue work item was rejected"
  log "active issue index rejects a second active work item"
}

for up_file in "${up_files[@]}"; do
  up_name="$(basename "${up_file}")"
  if [ "${up_name}" = "${ACTIVE_ISSUE_MIGRATION}" ]; then
    seed_active_issue_duplicates
  fi
  log "applying ${up_name}"
  psql_exec "${SCRATCH_DB}" <"${up_file}"
  if [ "${up_name}" = "${ACTIVE_ISSUE_MIGRATION}" ]; then
    verify_active_issue_index
  fi
done

views=(v_inbox v_pipeline v_agent_cost_daily v_approval_stats v_lead_time v_failures v_notices v_reviews v_fix_rounds v_issue_proposals v_approval_requests)
for view in "${views[@]}"; do
  log "SELECT * FROM factory.${view} LIMIT 1;"
  printf 'SELECT * FROM factory.%s LIMIT 1;\n' "${view}" | psql_exec "${SCRATCH_DB}" >/dev/null
done
log "all ${#views[@]} views selected successfully"

shopt -s nullglob
down_files=("${MIGRATIONS_DIR}"/*.down.sql)
shopt -u nullglob
if [ ${#down_files[@]} -gt 0 ]; then
  # `wmill datatable migrate down`と同じく、downのmigrationは新しい順に適用する。
  for ((i = ${#down_files[@]} - 1; i >= 0; i--)); do
    down_file="${down_files[${i}]}"
    log "applying $(basename "${down_file}") (rollback check)"
    psql_exec "${SCRATCH_DB}" <"${down_file}"
  done
  log "down migrations applied cleanly"
fi

log "OK"
