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
INSERT INTO factory.approval_requests (kind, work_item_id, subject_id, status)
  SELECT 'requirements', id, 1, 'pending' FROM factory.work_items
  WHERE issue_number = 1 AND cycle = 1;
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

  local expired
  expired="$(printf "SELECT count(*) FROM factory.approval_requests WHERE status = 'expired';\n" \
    | psql_exec "${SCRATCH_DB}" -q -t -A 2>/dev/null || true)"
  [ "$(printf '%s' "${expired}" | tr -d '[:space:]')" = "1" ] \
    || die "expected the pending approval request of the cancelled duplicate to be expired, got '${expired}'"

  local insert_active="INSERT INTO factory.work_items (cycle, source, kind, owner, repo, issue_number, issue_url, title, status) VALUES (9, 'issue', 'issue', 'o', 'r', 1, 'https://github.com/o/r/issues/1', 't', 'picked')"
  local rejected
  if rejected="$(printf '%s;\n' "${insert_active}" | psql_exec "${SCRATCH_DB}" 2>&1)"; then
    die "a second active issue work item was accepted"
  fi
  case "${rejected}" in
    *work_items_active_issue_key*) ;;
    *) die "the second active issue work item was rejected, but not by work_items_active_issue_key: ${rejected}" ;;
  esac
  local skipped
  skipped="$(printf '%s ON CONFLICT DO NOTHING RETURNING id;\n' "${insert_active}" \
    | psql_exec "${SCRATCH_DB}" -q -t -A)" \
    || die "ON CONFLICT DO NOTHING failed instead of skipping the insert"
  [ -z "$(printf '%s' "${skipped}" | tr -d '[:space:]')" ] \
    || die "ON CONFLICT DO NOTHING inserted a second active issue work item"
  printf "INSERT INTO factory.work_items (cycle, source, kind, owner, repo, issue_number, issue_url, title, status) VALUES (9, 'issue', 'issue', 'o', 'r', 3, 'https://github.com/o/r/issues/3', 't', 'failed');\n" \
    | psql_exec "${SCRATCH_DB}" >/dev/null \
    || die "a terminal issue work item was rejected"
  # 終端の`approved`を稼働中へ戻す更新が、同じIssueの稼働中の行に拒まれ、
  # エラーの文に制約名が含まれること(`isActiveIssueUniqueViolation`が頼る形)を確かめる。
  printf "INSERT INTO factory.work_items (cycle, source, kind, owner, repo, issue_number, issue_url, title, status) VALUES (1, 'issue', 'issue', 'o', 'r', 4, 'https://github.com/o/r/issues/4', 't', 'approved'), (2, 'issue', 'issue', 'o', 'r', 4, 'https://github.com/o/r/issues/4', 't', 'picked');\n" \
    | psql_exec "${SCRATCH_DB}" >/dev/null \
    || die "could not seed the approved and active rows"
  local reverted
  if reverted="$(printf "UPDATE factory.work_items SET status = 'implementing' WHERE issue_number = 4 AND cycle = 1;\n" \
    | psql_exec "${SCRATCH_DB}" 2>&1)"; then
    die "an approved work item was moved to implementing next to an active one"
  fi
  case "${reverted}" in
    *work_items_active_issue_key*) ;;
    *) die "moving the approved work item was rejected, but not by work_items_active_issue_key: ${reverted}" ;;
  esac
  # `insertIssueWorkItemUnlessActive`の取り込みの文(挿入と、承認済みの古い項目の取り消しを
  # 1つの文で行う)を、本物のPostgreSQLで確かめる。
  # Issue(6): approvedとfailedの行がある。挿入が通り、approvedだけが取り消され、イベントが残る。
  # Issue(7): approvedと稼働中の行がある。挿入が負け、何も取り消されない。
  psql_exec "${SCRATCH_DB}" >/dev/null <<'SQL' || die "could not seed the intake scenarios"
INSERT INTO factory.work_items (cycle, source, kind, owner, repo, issue_number, issue_url, title, status) VALUES
  (1, 'issue', 'issue', 'o', 'r', 6, 'https://github.com/o/r/issues/6', 't', 'approved'),
  (2, 'issue', 'issue', 'o', 'r', 6, 'https://github.com/o/r/issues/6', 't', 'failed'),
  (1, 'issue', 'issue', 'o', 'r', 7, 'https://github.com/o/r/issues/7', 't', 'approved'),
  (2, 'issue', 'issue', 'o', 'r', 7, 'https://github.com/o/r/issues/7', 't', 'picked');
SQL
  local intake_sql="WITH inserted AS (INSERT INTO factory.work_items (cycle, source, kind, owner, repo, issue_number, issue_url, title, status) VALUES (3, 'issue', 'issue', 'o', 'r', %s, 'https://github.com/o/r/issues/%s', 't', 'picked') ON CONFLICT DO NOTHING RETURNING id, owner, repo, issue_number), cancelled AS (UPDATE factory.work_items AS wi SET status = 'cancelled', updated_at = now() FROM inserted WHERE wi.status = 'approved' AND wi.kind = 'issue' AND wi.owner = inserted.owner AND wi.repo = inserted.repo AND wi.issue_number = inserted.issue_number AND wi.id <> inserted.id RETURNING wi.id, wi.attempt, inserted.id AS new_id), recorded AS (INSERT INTO factory.work_item_events (work_item_id, from_status, to_status, note) SELECT id, 'approved', 'cancelled', 'superseded by a newer cycle (work item ' || new_id || ')' FROM cancelled RETURNING work_item_id) SELECT inserted.id AS id, cancelled.id AS superseded_id, cancelled.attempt AS superseded_attempt FROM inserted LEFT JOIN cancelled ON true;\n"
  local won lost
  won="$(printf "${intake_sql}" 6 6 | psql_exec "${SCRATCH_DB}" -q -t -A)" \
    || die "the intake statement failed for the winning insert"
  lost="$(printf "${intake_sql}" 7 7 | psql_exec "${SCRATCH_DB}" -q -t -A)" \
    || die "the intake statement failed for the losing insert"
  [ -n "$(printf '%s' "${won}" | tr -d '[:space:]')" ] \
    || die "the winning intake insert returned no row"
  [ -z "$(printf '%s' "${lost}" | tr -d '[:space:]')" ] \
    || die "the losing intake insert returned a row"
  local statuses
  statuses="$(printf "SELECT string_agg(issue_number || ':' || cycle || ':' || status, ',' ORDER BY issue_number, cycle) FROM factory.work_items WHERE issue_number IN (6, 7);\n" \
    | psql_exec "${SCRATCH_DB}" -q -t -A)" \
    || die "could not read the intake result"
  [ "${statuses}" = "6:1:cancelled,6:2:failed,6:3:picked,7:1:approved,7:2:picked" ] \
    || die "unexpected statuses after the intake statements: ${statuses}"
  local superseded_events
  superseded_events="$(printf "SELECT count(*) FROM factory.work_item_events WHERE note LIKE 'superseded by a newer cycle%%';\n" \
    | psql_exec "${SCRATCH_DB}" -q -t -A)" \
    || die "could not read the superseded events"
  [ "$(printf '%s' "${superseded_events}" | tr -d '[:space:]')" = "1" ] \
    || die "expected exactly one superseded event, got '${superseded_events}'"
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
