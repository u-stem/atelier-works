#!/usr/bin/env bash
# migrationのmediumテスト。composeのPostgresのコンテナ内の使い捨ての
# `factory_test`データベースに`migrations/datatable/main/*.up.sql`をすべて
# 適用し、`factory`スキーマの各ビューからSELECTしてビューが成り立つことを
# 確かめる。次に対応する`*.down.sql`を新しい順に適用し、戻せることを確かめる。
# あわせて、最小の行を入れて`scripts/test-db-queries.ts`が、アプリのコードが組み立てるSQL文を実行する。
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
  (2, 'issue', 'issue', 'o', 'r', 2, 'https://github.com/o/r/issues/2', 't', 'picked'),
  (1, 'issue', 'issue', 'o', 'r', 8, 'https://github.com/o/r/issues/8', 't', 'approved'),
  (2, 'issue', 'issue', 'o', 'r', 8, 'https://github.com/o/r/issues/8', 't', 'failed'),
  (1, 'issue', 'issue', 'o', 'r', 9, 'https://github.com/o/r/issues/9', 't', 'approved');
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
  events="$(printf "SELECT count(*) FROM factory.work_item_events WHERE note LIKE 'duplicate active issue work item%%';\n" \
    | psql_exec "${SCRATCH_DB}" -q -t -A 2>/dev/null || true)"
  [ "$(printf '%s' "${events}" | tr -d '[:space:]')" = "1" ] \
    || die "expected one work_item_events row for the cancelled duplicate, got '${events}'"

  # 新しいサイクルのあるIssue(8)のapprovedの行だけが取り消され、イベントが残る。
  # 新しいサイクルの無いIssue(9)のapprovedの行は、そのまま残る。
  local migrated
  migrated="$(printf "SELECT string_agg(issue_number || ':' || cycle || ':' || status, ',' ORDER BY issue_number, cycle) FROM factory.work_items WHERE issue_number IN (8, 9);\n" \
    | psql_exec "${SCRATCH_DB}" -q -t -A)" \
    || die "could not read the migrated approved rows"
  [ "${migrated}" = "8:1:cancelled,8:2:failed,9:1:approved" ] \
    || die "unexpected statuses of the approved rows after the migration: ${migrated}"
  local migrated_events
  migrated_events="$(printf "SELECT count(*) FROM factory.work_item_events WHERE note LIKE 'approved work item cancelled by migration%%';\n" \
    | psql_exec "${SCRATCH_DB}" -q -t -A)" \
    || die "could not read the migration events"
  [ "$(printf '%s' "${migrated_events}" | tr -d '[:space:]')" = "1" ] \
    || die "expected one event for the approved row cancelled by the migration, got '${migrated_events}'"

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
  # `insertIssueWorkItemUnlessActive`の2つの文を、本物のPostgreSQLで確かめる。
  # 1つ目は挿入、2つ目は古いサイクルの承認済みの項目の取り消しである。
  # Issue(6): cycle 1がapproved、cycle 2がfailed。cycle 3の挿入が通り、cycle 1だけが取り消され、イベントが残る。
  # Issue(7): cycle 1がapproved、cycle 2が稼働中。cycle 3の挿入が負け、何も取り消されない。
  # Issue(10): cycle 5がapproved。cycle 3の挿入は通るが、cycle 5は新しいサイクルより後なので取り消されない。
  psql_exec "${SCRATCH_DB}" >/dev/null <<'SQL' || die "could not seed the intake scenarios"
INSERT INTO factory.work_items (cycle, source, kind, owner, repo, issue_number, issue_url, title, status) VALUES
  (1, 'issue', 'issue', 'o', 'r', 6, 'https://github.com/o/r/issues/6', 't', 'approved'),
  (2, 'issue', 'issue', 'o', 'r', 6, 'https://github.com/o/r/issues/6', 't', 'failed'),
  (1, 'issue', 'issue', 'o', 'r', 7, 'https://github.com/o/r/issues/7', 't', 'approved'),
  (2, 'issue', 'issue', 'o', 'r', 7, 'https://github.com/o/r/issues/7', 't', 'picked'),
  (5, 'issue', 'issue', 'o', 'r', 10, 'https://github.com/o/r/issues/10', 't', 'approved');
SQL
  intake_issue() {
    local issue="$1" new_id
    new_id="$(printf "INSERT INTO factory.work_items (cycle, source, kind, owner, repo, issue_number, issue_url, title, status) VALUES (3, 'issue', 'issue', 'o', 'r', %s, 'https://github.com/o/r/issues/%s', 't', 'picked') ON CONFLICT DO NOTHING RETURNING id;\n" "${issue}" "${issue}" \
      | psql_exec "${SCRATCH_DB}" -q -t -A)" \
      || die "the intake insert failed for issue ${issue}"
    new_id="$(printf '%s' "${new_id}" | tr -d '[:space:]')"
    [ -n "${new_id}" ] || return 0
    psql_exec "${SCRATCH_DB}" -q -t -A -v owner=o -v repo=r -v issue="${issue}" -v cycle=3 -v new_id="${new_id}" >/dev/null <<'SQL' \
      || die "the sweep statement failed for issue ${issue}"
WITH cancelled AS (
      UPDATE factory.work_items AS wi
      SET status = 'cancelled', updated_at = now()
      WHERE wi.kind = 'issue' AND wi.status = 'approved'
        AND wi.owner = :'owner' AND wi.repo = :'repo'
        AND wi.issue_number = :'issue'::integer
        AND wi.cycle < :'cycle'::integer
      RETURNING wi.id, wi.attempt
    ),
    recorded AS (
      INSERT INTO factory.work_item_events (work_item_id, from_status, to_status, note)
      SELECT id, 'approved', 'cancelled', 'superseded by a newer cycle (work item ' || :'new_id'::bigint || ')'
      FROM cancelled
      RETURNING work_item_id
    )
    SELECT id, attempt FROM cancelled
SQL
  }
  intake_issue 6
  intake_issue 7
  intake_issue 10
  local statuses
  statuses="$(printf "SELECT string_agg(issue_number || ':' || cycle || ':' || status, ',' ORDER BY issue_number, cycle) FROM factory.work_items WHERE issue_number IN (6, 7, 10);\n" \
    | psql_exec "${SCRATCH_DB}" -q -t -A)" \
    || die "could not read the intake result"
  [ "${statuses}" = "6:1:cancelled,6:2:failed,6:3:picked,7:1:approved,7:2:picked,10:3:picked,10:5:approved" ] \
    || die "unexpected statuses after the intake statements: ${statuses}"
  # `newestNewerIssueCycle`の問い合わせを、Issue(6)(cycle 1から3)で確かめる。
  # 大きいcycleがあれば最新の1行を返し、同じか小さいcycleだけなら何も返さない。
  newest_newer() {
    psql_exec "${SCRATCH_DB}" -q -t -A -v owner=o -v repo=r -v issue=6 -v cycle="$1" <<'SQL' \
      || die "the newest newer cycle query failed for cycle $1"
SELECT id, status FROM factory.work_items
    WHERE kind = 'issue' AND owner = :'owner' AND repo = :'repo'
      AND issue_number = :'issue'::integer AND cycle > :'cycle'::integer
    ORDER BY cycle DESC
    LIMIT 1
SQL
  }
  local newer_from_2 newer_from_3 newer_from_4
  newer_from_2="$(newest_newer 2 | tr -d '[:space:]')"
  newer_from_3="$(newest_newer 3 | tr -d '[:space:]')"
  newer_from_4="$(newest_newer 4 | tr -d '[:space:]')"
  case "${newer_from_2}" in
    *'|picked') ;;
    *) die "expected the newest cycle (picked) after cycle 2, got '${newer_from_2}'" ;;
  esac
  [ -z "${newer_from_3}" ] || die "expected no newer cycle after cycle 3, got '${newer_from_3}'"
  [ -z "${newer_from_4}" ] || die "expected no newer cycle after cycle 4, got '${newer_from_4}'"
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

# 通知の解決の記録(resolved_by / resolved_at)の列に値を書け、未解決の通知を返すビューが変わらないことを確かめる。
notice_row="$(printf "INSERT INTO factory.notices (kind, message) VALUES ('probe', 'm'); UPDATE factory.notices SET resolved = true, resolved_by = 'op', resolved_at = now() WHERE kind = 'probe'; SELECT resolved_by FROM factory.notices WHERE kind = 'probe';\n" \
  | psql_exec "${SCRATCH_DB}" -q -t -A | tail -n 1)" \
  || die "could not write the notice resolution columns"
[ "${notice_row}" = "op" ] || die "expected resolved_by to be 'op', got '${notice_row}'"
log "notices resolution columns are writable"

# アプリのコードが組み立てるSQL文(`resolveNoticeIfUnresolved`、summaryの失敗のクエリ、
# system_status、work_item_detail、通知の掃除、失敗の数え上げ)を、最小の行を入れた
# 使い捨てデータベースで本物のPostgreSQLに流して確かめる。手書きの別の文は流さない。
log "running the application queries against '${SCRATCH_DB}'"
COMPOSE_FILE="${COMPOSE_FILE}" SCRATCH_DB="${SCRATCH_DB}" \
  bun run "${REPO_ROOT}/scripts/test-db-queries.ts" \
  || die "the application queries failed against the real PostgreSQL"

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
