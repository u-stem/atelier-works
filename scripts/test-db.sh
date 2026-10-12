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
NOTICES_DEDUP_MIGRATION="20261011170000_notices_unresolved_dedup.up.sql"
DISK_USAGE_NOTICE_MIGRATION="20261013100200_disk_usage_notice_single.up.sql"

# ディスク使用量の未解決の通知を1件までにする索引を足す前に、本文の異なる未解決の通知を3件入れておく。
# migrationが最も新しい1件だけを残して解決済みにし、索引を作れることを確かめるため。
seed_disk_usage_notices() {
  psql_exec "${SCRATCH_DB}" <<'SQL' >/dev/null
INSERT INTO factory.notices (kind, message, resolved, created_at) VALUES
  ('workspace_disk_usage', 'oldest', false, '2026-10-01 00:00:00+00'),
  ('workspace_disk_usage', 'newest', false, '2026-10-03 00:00:00+00'),
  ('workspace_disk_usage', 'middle', false, '2026-10-02 00:00:00+00'),
  ('workspace_disk_usage', 'history', true, '2026-09-30 00:00:00+00');
SQL
}

# migrationが最も新しい1件だけを残し、残りを解決者migrationで解決済みにし、
# 解決済みの履歴には触れず、索引が本文の異なる2件目の未解決を拒むことを確かめる。
verify_disk_usage_notice_index() {
  local kept
  kept="$(printf "SELECT string_agg(message || ':' || resolved || ':' || COALESCE(resolved_by, '-'), ',' ORDER BY message) FROM factory.notices WHERE kind = 'workspace_disk_usage';\n" \
    | psql_exec "${SCRATCH_DB}" -q -t -A)" \
    || die "could not read the disk usage notices"
  [ "${kept}" = "history:true:-,middle:true:migration,newest:false:-,oldest:true:migration" ] \
    || die "unexpected disk usage notices after the migration: ${kept}"
  local rejected
  if rejected="$(printf "INSERT INTO factory.notices (kind, message) VALUES ('workspace_disk_usage', 'another');\n" | psql_exec "${SCRATCH_DB}" 2>&1)"; then
    die "a second unresolved disk usage notice was accepted"
  fi
  case "${rejected}" in
    *notices_unresolved_disk_usage_key*) ;;
    *) die "the second disk usage notice was rejected, but not by notices_unresolved_disk_usage_key: ${rejected}" ;;
  esac
  printf "DELETE FROM factory.notices WHERE kind = 'workspace_disk_usage';\n" | psql_exec "${SCRATCH_DB}" >/dev/null
  log "unresolved disk usage notices are unique per kind"
}

# 未解決の通知の部分一意索引を足す前に、重複した未解決の通知を入れておく。
# migrationが最古の1件だけを残して解決済みにし、索引を作れることを確かめるため。
seed_notice_duplicates() {
  psql_exec "${SCRATCH_DB}" <<'SQL' >/dev/null
INSERT INTO factory.notices (kind, message, resolved, created_at) VALUES
  ('dup_probe', 'same', false, '2026-10-01 00:00:00+00'),
  ('dup_probe', 'same', false, '2026-10-02 00:00:00+00'),
  ('dup_probe', 'same', false, '2026-10-02 00:00:00+00'),
  ('dup_probe', 'other', false, '2026-10-03 00:00:00+00'),
  ('dup_probe', 'done', true, '2026-10-01 00:00:00+00'),
  ('dup_probe', 'done', false, '2026-10-02 00:00:00+00');
SQL
}

# migrationが最古の1件だけを残し、残りを解決者migrationで解決済みにし、
# 解決済みの履歴には触れず、索引が2件目の未解決を拒み、ON CONFLICT DO NOTHINGでは挿入しないことを確かめる。
verify_notice_dedup_index() {
  local kept
  kept="$(printf "SELECT string_agg(message || ':' || resolved || ':' || COALESCE(resolved_by, '-'), ',' ORDER BY message, id) FROM factory.notices WHERE kind = 'dup_probe';\n" \
    | psql_exec "${SCRATCH_DB}" -q -t -A)" \
    || die "could not read the deduplicated notices"
  [ "${kept}" = "done:true:-,done:false:-,other:false:-,same:false:-,same:true:migration,same:true:migration" ] \
    || die "unexpected notices after the dedup migration: ${kept}"
  local oldest
  oldest="$(printf "SELECT created_at::date FROM factory.notices WHERE kind = 'dup_probe' AND message = 'same' AND resolved = false;\n" \
    | psql_exec "${SCRATCH_DB}" -q -t -A)" \
    || die "could not read the kept notice"
  [ "$(printf '%s' "${oldest}" | tr -d '[:space:]')" = "2026-10-01" ] \
    || die "expected the oldest notice to be kept, got '${oldest}'"
  local rejected
  if rejected="$(printf "INSERT INTO factory.notices (kind, message) VALUES ('dup_probe', 'same');\n" | psql_exec "${SCRATCH_DB}" 2>&1)"; then
    die "a second unresolved notice with the same kind and message was accepted"
  fi
  case "${rejected}" in
    *notices_unresolved_key*) ;;
    *) die "the duplicate notice was rejected, but not by notices_unresolved_key: ${rejected}" ;;
  esac
  # アプリのコードは`ON CONFLICT DO NOTHING`を使わない(競合は`DO UPDATE`で受ける)。
  # ここでは、索引が`ON CONFLICT`の衝突先として働くことだけを確かめる。
  local skipped
  skipped="$(printf "INSERT INTO factory.notices (kind, message) VALUES ('dup_probe', 'same') ON CONFLICT DO NOTHING RETURNING id;\n" \
    | psql_exec "${SCRATCH_DB}" -q -t -A)" \
    || die "ON CONFLICT DO NOTHING failed instead of skipping the notice insert"
  [ -z "$(printf '%s' "${skipped}" | tr -d '[:space:]')" ] \
    || die "ON CONFLICT DO NOTHING inserted a second unresolved notice"
  printf "INSERT INTO factory.notices (kind, message, resolved) VALUES ('dup_probe', 'same', true);\n" \
    | psql_exec "${SCRATCH_DB}" >/dev/null \
    || die "a resolved notice with the same kind and message was rejected"
  printf "DELETE FROM factory.notices WHERE kind = 'dup_probe';\n" | psql_exec "${SCRATCH_DB}" >/dev/null
  log "unresolved notices are unique per kind and message"
}

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
}

# `insertIssueWorkItemUnlessActive`の2つの文を、全migrationの適用後に確かめる。
# 取り消しの文は、後のmigrationが足す列(work_item_eventsのジョブID)にも書くため。
verify_issue_intake() {
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
    psql_exec "${SCRATCH_DB}" -q -t -A -v owner=o -v repo=r -v issue="${issue}" -v cycle=3 -v new_id="${new_id}" \
      -v job_id=0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b -v root_job_id=0198a1b2-0000-7000-8000-000000000001 >/dev/null <<'SQL' \
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
      INSERT INTO factory.work_item_events (work_item_id, from_status, to_status, note, job_id, root_job_id)
      SELECT id, 'approved', 'cancelled', 'superseded by a newer cycle (work item ' || :'new_id'::bigint || ')',
        :'job_id'::text, :'root_job_id'::text
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
  local superseded_root
  superseded_root="$(printf "SELECT root_job_id FROM factory.work_item_events WHERE note LIKE 'superseded by a newer cycle%%';\n" \
    | psql_exec "${SCRATCH_DB}" -q -t -A)" \
    || die "could not read the root job id of the superseded event"
  [ "$(printf '%s' "${superseded_root}" | tr -d '[:space:]')" = "0198a1b2-0000-7000-8000-000000000001" ] \
    || die "expected the superseded event to record the root job id, got '${superseded_root}'"
  log "issue intake supersedes only the older approved work items and records the job ids"
}

for up_file in "${up_files[@]}"; do
  up_name="$(basename "${up_file}")"
  if [ "${up_name}" = "${ACTIVE_ISSUE_MIGRATION}" ]; then
    seed_active_issue_duplicates
  fi
  if [ "${up_name}" = "${NOTICES_DEDUP_MIGRATION}" ]; then
    seed_notice_duplicates
  fi
  if [ "${up_name}" = "${DISK_USAGE_NOTICE_MIGRATION}" ]; then
    seed_disk_usage_notices
  fi
  log "applying ${up_name}"
  psql_exec "${SCRATCH_DB}" <"${up_file}"
  if [ "${up_name}" = "${ACTIVE_ISSUE_MIGRATION}" ]; then
    verify_active_issue_index
  fi
  if [ "${up_name}" = "${NOTICES_DEDUP_MIGRATION}" ]; then
    verify_notice_dedup_index
  fi
  if [ "${up_name}" = "${DISK_USAGE_NOTICE_MIGRATION}" ]; then
    verify_disk_usage_notice_index
  fi
done

verify_issue_intake

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

# 通知の種類名を改めるmigrationが、未解決の旧い種類だけを書き換え、解決済みの履歴には触れないことを確かめる。
# 全migrationの適用後は旧い種類の行が無いので、行を入れてからmigrationを適用し直す。
rename_sql="${MIGRATIONS_DIR}/20261011120000_rename_labeler_notice_kind.up.sql"
[ -f "${rename_sql}" ] || die "missing migration: ${rename_sql}"
printf "INSERT INTO factory.notices (kind, message, resolved) VALUES ('labeler_association_denied', 'o/r#1: open', false), ('labeler_association_denied', 'o/r#2: done', true);\n" \
  | psql_exec "${SCRATCH_DB}" -q >/dev/null || die "could not insert the legacy notices"
psql_exec "${SCRATCH_DB}" -q <"${rename_sql}" >/dev/null || die "could not re-apply the rename migration"
rename_rows="$(printf "SELECT message || '=' || kind FROM factory.notices WHERE message IN ('o/r#1: open', 'o/r#2: done') ORDER BY message;\n" \
  | psql_exec "${SCRATCH_DB}" -q -t -A | paste -sd ',' -)" \
  || die "could not read the renamed notices"
[ "${rename_rows}" = "o/r#1: open=labeler_denied,o/r#2: done=labeler_association_denied" ] \
  || die "unexpected notice kinds after the rename migration: '${rename_rows}'"
printf "DELETE FROM factory.notices WHERE message IN ('o/r#1: open', 'o/r#2: done');\n" \
  | psql_exec "${SCRATCH_DB}" -q >/dev/null
log "notice kind rename rewrites only unresolved rows"

# アプリのコードが組み立てるSQL文(`resolveNoticeIfUnresolved`、summaryの失敗のクエリ、
# system_status、work_item_detail、通知の掃除)を、最小の行を入れた
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
