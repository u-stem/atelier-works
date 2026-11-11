#!/usr/bin/env bash
# migrationのmediumテスト。composeのPostgresのコンテナ内の使い捨ての
# `factory_test_<パスのハッシュ>`データベースに`migrations/datatable/main/*.up.sql`をすべて
# 適用し、`factory`スキーマの各ビューからSELECTしてビューが成り立つことを
# 確かめる。次に対応する`*.down.sql`を新しい順に適用し、戻せることを確かめる。
# あわせて、最小の行を入れて`scripts/test-db-queries.ts`が、アプリのコードが組み立てるSQL文を実行する。
# 保留の表の制約と、`lib/holds.ts`のSQL文は、`scripts/test-db-holds.ts`が実行して確かめる。
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
# 使い捨てのデータベースの名前は、作業ツリーのパスから決める。複数のworktreeが同時に流しても、
# 互いのデータベースを消さないためである。
SCRATCH_DB="factory_test_$(printf '%s' "${REPO_ROOT}" | cksum | cut -d' ' -f1)"

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
  docker exec -i "${db_id}" psql -v ON_ERROR_STOP=1 -U postgres -d "${db}" "$@"
}

cleanup() {
  docker exec -i "${db_id}" psql -v ON_ERROR_STOP=1 -U postgres -d windmill \
    -c "DROP DATABASE IF EXISTS ${SCRATCH_DB};" >/dev/null 2>&1 || true
}
trap cleanup EXIT

log "creating scratch database '${SCRATCH_DB}'"
docker exec -i "${db_id}" psql -v ON_ERROR_STOP=1 -U postgres -d windmill \
  -c "DROP DATABASE IF EXISTS ${SCRATCH_DB};" >/dev/null
docker exec -i "${db_id}" psql -v ON_ERROR_STOP=1 -U postgres -d windmill \
  -c "CREATE DATABASE ${SCRATCH_DB};" >/dev/null

shopt -s nullglob
up_files=("${MIGRATIONS_DIR}"/*.up.sql)
shopt -u nullglob
[ ${#up_files[@]} -gt 0 ] || die "no migrations found in ${MIGRATIONS_DIR}"

ACTIVE_ISSUE_MIGRATION="20261009120000_active_issue_key.up.sql"
NOTICES_DEDUP_MIGRATION="20261011170000_notices_unresolved_dedup.up.sql"
DISK_USAGE_NOTICE_MIGRATION="20261013100300_disk_usage_notice_single.up.sql"
PR_CI_FIX_SCHEMA_MIGRATION="20261013100400_pr_ci_fix_schema.up.sql"
ACTIVE_PR_FIX_MIGRATION="20261013100500_active_pr_fix_key.up.sql"
PR_CONFLICT_FIX_MIGRATION="20261015120000_pr_conflict_fix.up.sql"
GH_COLLECT_DETAIL_MIGRATION="20261018100000_gh_collect_detail.up.sql"
DESIGN_STAGE_ITEMS_MIGRATION="20261026120000_design_stage_work_items.up.sql"
DESIGN_STAGE_KIND_MIGRATION="20261026120100_design_stage_approval_kind.up.sql"
DESIGN_DRAFTS_MIGRATION="20261026130000_design_drafts.up.sql"
DOC_HASH_MIGRATION="20261026150000_requirement_drafts_doc_hash.up.sql"
IMPLEMENT_ROUNDS_DESIGN_GAP_MIGRATION="20261028100000_implement_rounds_design_gap.up.sql"
FIX_ROUNDS_DESIGN_GAP_MIGRATION="20261028110000_fix_rounds_design_gap.up.sql"
ACTIVE_PR_REVIEW_MIGRATION="20261102100000_active_pr_review_key.up.sql"
INVESTIGATE_MIGRATION="20261102120000_investigate_work_items.up.sql"
INVESTIGATE_SINGLETON_MIGRATION="20261104100000_investigate_singleton.up.sql"

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

# CIの失敗を直す仕組みの土台のmigrationが、状態`fixing`を受け入れ、不正な状態、負の回数、長すぎる保留の理由を拒み、
# 戻したときに`fixing`の行だけを`failed`へ移して列と索引を落とし、もう一度適用できることを確かめる。
# このmigrationの適用直後に呼ぶ。もう一度適用し直すので、最新のmigrationでなくなったときは呼ぶ位置を見直すこと。
verify_pr_ci_fix_schema() {
  local up_file="${MIGRATIONS_DIR}/${PR_CI_FIX_SCHEMA_MIGRATION}"
  local down_file="${MIGRATIONS_DIR}/${PR_CI_FIX_SCHEMA_MIGRATION%.up.sql}.down.sql"
  [ -f "${up_file}" ] || die "missing migration: ${up_file}"
  [ -f "${down_file}" ] || die "missing migration: ${down_file}"
  local sha
  sha="$(printf 'a%.0s' $(seq 1 40))"
  local insert_prefix="INSERT INTO factory.pr_ci_checks (owner, repo, pr_number, head_sha, state"

  # 値を1つ返すSELECTを実行し、空白を除いて返す。
  scalar() {
    printf '%s;\n' "$1" | psql_exec "${SCRATCH_DB}" -q -t -A | tr -d '[:space:]'
  }
  # 文が制約名つきで拒まれることを確かめる。
  expect_rejected() {
    local statement="$1" constraint="$2" rejected
    if rejected="$(printf '%s;\n' "${statement}" | psql_exec "${SCRATCH_DB}" 2>&1)"; then
      die "the statement was accepted, expected ${constraint} to reject it: ${statement}"
    fi
    case "${rejected}" in
      *"${constraint}"*) ;;
      *) die "the statement was rejected, but not by ${constraint}: ${rejected}" ;;
    esac
  }

  printf "%s, fix_work_item_id, fix_attempts, fix_hold_reason) VALUES ('fixprobe', 'r', 1, '%s', 'fixing', 7, 1, 'probe');\n" "${insert_prefix}" "${sha}" \
    | psql_exec "${SCRATCH_DB}" >/dev/null || die "a fixing row was rejected"
  printf "%s) VALUES ('fixprobe', 'r', 2, '%s', 'failed');\n" "${insert_prefix}" "${sha}" \
    | psql_exec "${SCRATCH_DB}" >/dev/null || die "a failed row without the fix columns was rejected"
  local defaults
  defaults="$(scalar "SELECT fix_attempts || ':' || COALESCE(fix_work_item_id::text, '-') || ':' || COALESCE(fix_hold_reason, '-') FROM factory.pr_ci_checks WHERE owner = 'fixprobe' AND pr_number = 2")"
  [ "${defaults}" = "0:-:-" ] || die "unexpected defaults of the fix columns: ${defaults}"
  expect_rejected "${insert_prefix}) VALUES ('fixprobe', 'r', 3, '${sha}', 'bogus')" pr_ci_checks_state_check
  expect_rejected "${insert_prefix}, fix_attempts) VALUES ('fixprobe', 'r', 3, '${sha}', 'failed', -1)" pr_ci_checks_fix_attempts_check
  expect_rejected "${insert_prefix}, fix_hold_reason) VALUES ('fixprobe', 'r', 3, '${sha}', 'failed', repeat('x', 65))" pr_ci_checks_fix_hold_reason_length_check
  expect_rejected "${insert_prefix}, fix_hold_reason) VALUES ('fixprobe', 'r', 3, '${sha}', 'failed', '')" pr_ci_checks_fix_hold_reason_check
  printf "%s, fix_hold_reason) VALUES ('fixprobe', 'r', 6, '%s', 'failed', repeat('x', 64));\n" "${insert_prefix}" "${sha}" \
    | psql_exec "${SCRATCH_DB}" >/dev/null || die "a fix_hold_reason of exactly 64 characters was rejected"
  printf "INSERT INTO factory.work_items (cycle, source, kind, owner, repo, issue_number, issue_url, title, status, ci_check_id) VALUES (1, 'issue', 'issue', 'fixprobe', 'r', 1, 'https://github.com/fixprobe/r/issues/1', 't', 'failed', 5);\n" \
    | psql_exec "${SCRATCH_DB}" >/dev/null || die "a work item with ci_check_id was rejected"
  local stored_ci_check_id
  stored_ci_check_id="$(scalar "SELECT ci_check_id FROM factory.work_items WHERE owner = 'fixprobe'")"
  [ "${stored_ci_check_id}" = "5" ] || die "expected ci_check_id to be stored, got '${stored_ci_check_id}'"
  local index_def
  index_def="$(scalar "SELECT indexdef FROM pg_indexes WHERE schemaname = 'factory' AND indexname = 'work_items_ci_check_id_idx'")"
  case "${index_def}" in
    *"WHERE(ci_check_idISNOTNULL)"*) ;;
    *) die "work_items_ci_check_id_idx is not a partial index over ci_check_id: ${index_def}" ;;
  esac
  printf "DELETE FROM factory.work_items WHERE owner = 'fixprobe';\n" | psql_exec "${SCRATCH_DB}" >/dev/null

  # 戻すと、fixingの行だけがfailedになり、足した列と索引が消える。
  printf "%s) VALUES ('fixprobe', 'r', 5, '%s', 'passed');\n" "${insert_prefix}" "${sha}" \
    | psql_exec "${SCRATCH_DB}" >/dev/null || die "a passed row was rejected"
  log "rolling back pr_ci_fix_schema"
  psql_exec "${SCRATCH_DB}" -q <"${down_file}" >/dev/null || die "could not roll back pr_ci_fix_schema"
  local moved
  moved="$(scalar "SELECT state FROM factory.pr_ci_checks WHERE owner = 'fixprobe' AND pr_number = 1")"
  [ "${moved}" = "failed" ] || die "expected the fixing row to become failed after the rollback, got '${moved}'"
  local kept
  kept="$(scalar "SELECT state FROM factory.pr_ci_checks WHERE owner = 'fixprobe' AND pr_number = 5")"
  [ "${kept}" = "passed" ] || die "expected the passed row to stay passed after the rollback, got '${kept}'"
  local remaining
  remaining="$(scalar "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'factory' AND ((table_name = 'pr_ci_checks' AND column_name IN ('fix_work_item_id', 'fix_attempts', 'fix_hold_reason')) OR (table_name = 'work_items' AND column_name = 'ci_check_id'))")"
  [ "${remaining}" = "0" ] || die "expected the four columns to be dropped by the rollback, ${remaining} remain"
  local indexes
  indexes="$(scalar "SELECT count(*) FROM pg_indexes WHERE schemaname = 'factory' AND indexname = 'work_items_ci_check_id_idx'")"
  [ "${indexes}" = "0" ] || die "expected the index to be dropped by the rollback, ${indexes} remain"
  expect_rejected "${insert_prefix}) VALUES ('fixprobe', 'r', 4, '${sha}', 'fixing')" pr_ci_checks_state_check

  # もう一度適用すると、足した列が戻り、fixingを再び受け入れる。
  log "re-applying pr_ci_fix_schema"
  psql_exec "${SCRATCH_DB}" -q <"${up_file}" >/dev/null || die "could not re-apply pr_ci_fix_schema"
  remaining="$(scalar "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'factory' AND ((table_name = 'pr_ci_checks' AND column_name IN ('fix_work_item_id', 'fix_attempts', 'fix_hold_reason')) OR (table_name = 'work_items' AND column_name = 'ci_check_id'))")"
  [ "${remaining}" = "4" ] || die "expected the four columns after re-applying, found ${remaining}"
  indexes="$(scalar "SELECT count(*) FROM pg_indexes WHERE schemaname = 'factory' AND indexname = 'work_items_ci_check_id_idx'")"
  [ "${indexes}" = "1" ] || die "expected the index after re-applying, found ${indexes}"
  printf "%s) VALUES ('fixprobe', 'r', 4, '%s', 'fixing');\n" "${insert_prefix}" "${sha}" \
    | psql_exec "${SCRATCH_DB}" >/dev/null || die "a fixing row was rejected after re-applying"
  printf "DELETE FROM factory.pr_ci_checks WHERE owner = 'fixprobe';\n" | psql_exec "${SCRATCH_DB}" >/dev/null
  log "pr_ci_fix_schema accepts fixing, rejects invalid values, and round-trips"
}

# 同じPRの終端でない2件目のpr_fixを拒み、終端の行、pr_review、別のPR、別のリポジトリ、
# pr_numberがNULLの行とは共存できることを確かめる。拒否の文に制約名が含まれること
# (`isActivePrFixUniqueViolation`が頼る形)と、終端の行を稼働中へ戻す更新も拒まれることも確かめる。
# このmigrationの適用直後に呼ぶ。
verify_active_pr_fix_index() {
  local insert_prefix="INSERT INTO factory.work_items (cycle, source, kind, owner, repo, pr_number, title, status) VALUES (1, 'issue',"
  # 文を実行して成功を確かめる。
  expect_accepted() {
    printf '%s;\n' "$1" | psql_exec "${SCRATCH_DB}" >/dev/null || die "the statement was rejected: $1"
  }
  # 文が制約名つきで拒まれることを確かめる。
  expect_rejected() {
    local statement="$1" constraint="work_items_active_pr_fix_key" rejected
    if rejected="$(printf '%s;\n' "${statement}" | psql_exec "${SCRATCH_DB}" 2>&1)"; then
      die "the statement was accepted, expected ${constraint} to reject it: ${statement}"
    fi
    case "${rejected}" in
      *"${constraint}"*) ;;
      *) die "the statement was rejected, but not by ${constraint}: ${rejected}" ;;
    esac
  }

  expect_accepted "${insert_prefix} 'pr_fix', 'fixprobe', 'r', 1, 't', 'fixing')"
  expect_rejected "${insert_prefix} 'pr_fix', 'fixprobe', 'r', 1, 't', 'fixing')"
  expect_rejected "${insert_prefix} 'pr_fix', 'fixprobe', 'r', 1, 't', 'picked')"
  expect_accepted "${insert_prefix} 'pr_fix', 'fixprobe', 'r', 1, 't', 'rereview_requested')"
  expect_accepted "${insert_prefix} 'pr_fix', 'fixprobe', 'r', 1, 't', 'blocked')"
  expect_accepted "${insert_prefix} 'pr_review', 'fixprobe', 'r', 1, 't', 'reviewing')"
  expect_accepted "${insert_prefix} 'pr_fix', 'fixprobe', 'r', 2, 't', 'fixing')"
  expect_accepted "${insert_prefix} 'pr_fix', 'fixprobe', 'other', 1, 't', 'fixing')"
  expect_accepted "${insert_prefix} 'pr_fix', 'fixprobe', 'r', NULL, 't', 'fixing')"
  expect_accepted "${insert_prefix} 'pr_fix', 'fixprobe', 'r', NULL, 't', 'fixing')"

  # 終端の行を稼働中へ戻す更新(retry_work_itemの再開)も、同じPRの稼働中の行に拒まれる。
  expect_rejected "UPDATE factory.work_items SET status = 'fixing' WHERE owner = 'fixprobe' AND repo = 'r' AND pr_number = 1 AND kind = 'pr_fix' AND status = 'blocked'"
  # 稼働中の行が終端になれば、同じPRに新しい稼働中の行を入れられる。
  expect_accepted "UPDATE factory.work_items SET status = 'failed' WHERE owner = 'fixprobe' AND repo = 'r' AND pr_number = 1 AND kind = 'pr_fix' AND status = 'fixing'"
  expect_accepted "${insert_prefix} 'pr_fix', 'fixprobe', 'r', 1, 't', 'fixing')"
  printf "DELETE FROM factory.work_items WHERE owner = 'fixprobe';\n" | psql_exec "${SCRATCH_DB}" >/dev/null
  log "pr_fix work items are limited to one active row per pull request"
}

# 稼働中のpr_reviewの一意索引を足す前に、同じPRの稼働中のpr_reviewを、綴りの違う行を含めて入れておく。
# migrationが、id が最大の行だけを残して古い行を取り消し、events に残してから索引を作れることを確かめるため。
seed_active_pr_review_duplicates() {
  psql_exec "${SCRATCH_DB}" <<'SQL' >/dev/null
INSERT INTO factory.work_items (cycle, source, kind, owner, repo, pr_number, title, status) VALUES
  (1, 'issue', 'pr_review', 'Reviewprobe', 'Widgets', 7, 't', 'reviewing'),
  (1, 'issue', 'pr_review', 'reviewprobe', 'widgets', 7, 't', 'reviewing'),
  (1, 'issue', 'pr_review', 'reviewprobe', 'widgets', 8, 't', 'reviewing'),
  (1, 'issue', 'pr_review', 'reviewprobe', 'widgets', 9, 't', 'failed'),
  (1, 'issue', 'pr_review', 'reviewprobe', 'widgets', 9, 't', 'reviewing'),
  (1, 'issue', 'pr_review', 'reviewprobe', 'widgets', NULL, 't', 'reviewing'),
  (1, 'issue', 'pr_review', 'reviewprobe', 'widgets', NULL, 't', 'reviewing');
SQL
}

# migrationが、同じPRの古い稼働中の行(綴りの違う行を含む)だけを取り消し、events を1件残し、
# 終端の行、重複の無いPR、pr_number が NULL の行には触れないことを確かめる。
# そのうえで、索引が小文字にそろえた2件目の稼働中の行を拒み(拒否の文に制約名が含まれること。
# `isActivePrReviewUniqueViolation`が頼る形)、ON CONFLICT DO NOTHING では挿入せず、
# 終端の行、ほかのPR、ほかの種類の行は拒まないことを確かめる。このmigrationの適用直後に呼ぶ。
verify_active_pr_review_index() {
  local migrated
  migrated="$(printf "SELECT string_agg(pr_number || ':' || status, ',' ORDER BY pr_number, id) FROM factory.work_items WHERE lower(owner) = 'reviewprobe' AND pr_number IS NOT NULL;\n" \
    | psql_exec "${SCRATCH_DB}" -q -t -A)" \
    || die "could not read the migrated pr_review rows"
  [ "${migrated}" = "7:cancelled,7:reviewing,8:reviewing,9:failed,9:reviewing" ] \
    || die "unexpected pr_review rows after the migration: ${migrated}"
  local kept
  kept="$(printf "SELECT owner FROM factory.work_items WHERE lower(owner) = 'reviewprobe' AND pr_number = 7 AND status = 'reviewing';\n" \
    | psql_exec "${SCRATCH_DB}" -q -t -A)" \
    || die "could not read the kept pr_review row"
  [ "${kept}" = "reviewprobe" ] \
    || die "expected the row with the highest id to be kept, got '${kept}'"
  local events
  events="$(printf "SELECT count(*) FROM factory.work_item_events WHERE from_status = 'reviewing' AND to_status = 'cancelled' AND note LIKE 'duplicate active pr_review work item%%';\n" \
    | psql_exec "${SCRATCH_DB}" -q -t -A)" \
    || die "could not read the events of the cancelled duplicate"
  [ "$(printf '%s' "${events}" | tr -d '[:space:]')" = "1" ] \
    || die "expected one work_item_events row for the cancelled duplicate, got '${events}'"
  local untouched
  untouched="$(printf "SELECT count(*) FROM factory.work_items WHERE lower(owner) = 'reviewprobe' AND pr_number IS NULL AND status = 'reviewing';\n" \
    | psql_exec "${SCRATCH_DB}" -q -t -A)" \
    || die "could not read the rows without a pull request number"
  [ "$(printf '%s' "${untouched}" | tr -d '[:space:]')" = "2" ] \
    || die "expected the rows without a pull request number to be left alone, got '${untouched}'"

  local insert_prefix="INSERT INTO factory.work_items (cycle, source, kind, owner, repo, pr_number, title, status) VALUES (1, 'issue',"
  expect_accepted() {
    printf '%s;\n' "$1" | psql_exec "${SCRATCH_DB}" >/dev/null || die "the statement was rejected: $1"
  }
  expect_rejected() {
    local statement="$1" constraint="work_items_active_pr_review_key" rejected
    if rejected="$(printf '%s;\n' "${statement}" | psql_exec "${SCRATCH_DB}" 2>&1)"; then
      die "the statement was accepted, expected ${constraint} to reject it: ${statement}"
    fi
    case "${rejected}" in
      *"${constraint}"*) ;;
      *) die "the statement was rejected, but not by ${constraint}: ${rejected}" ;;
    esac
  }

  expect_rejected "${insert_prefix} 'pr_review', 'reviewprobe', 'widgets', 7, 't', 'reviewing')"
  expect_rejected "${insert_prefix} 'pr_review', 'REVIEWPROBE', 'WIDGETS', 7, 't', 'picked')"
  local skipped
  skipped="$(printf "INSERT INTO factory.work_items (cycle, source, kind, owner, repo, pr_number, title, status) VALUES (1, 'issue', 'pr_review', 'Reviewprobe', 'Widgets', 7, 't', 'reviewing') ON CONFLICT DO NOTHING RETURNING id;\n" \
    | psql_exec "${SCRATCH_DB}" -q -t -A)" \
    || die "ON CONFLICT DO NOTHING failed instead of skipping the pr_review insert"
  [ -z "$(printf '%s' "${skipped}" | tr -d '[:space:]')" ] \
    || die "ON CONFLICT DO NOTHING inserted a second active pr_review for the pull request"
  expect_accepted "${insert_prefix} 'pr_review', 'reviewprobe', 'widgets', 7, 't', 'reviewed')"
  expect_accepted "${insert_prefix} 'pr_review', 'reviewprobe', 'widgets', 10, 't', 'reviewing')"
  expect_accepted "${insert_prefix} 'pr_review', 'reviewprobe', 'other', 7, 't', 'reviewing')"
  expect_accepted "${insert_prefix} 'pr_fix', 'reviewprobe', 'widgets', 7, 't', 'fixing')"
  expect_accepted "${insert_prefix} 'dependabot', 'reviewprobe', 'widgets', 7, 't', 'picked')"
  # 終端の行を稼働中へ戻す更新(retry_work_itemの再開)も、同じPRの稼働中の行に拒まれる。
  expect_rejected "UPDATE factory.work_items SET status = 'reviewing' WHERE owner = 'reviewprobe' AND repo = 'widgets' AND pr_number = 7 AND kind = 'pr_review' AND status = 'reviewed'"
  # 稼働中の行が終端になれば、同じPRに新しい稼働中の行を入れられる。
  expect_accepted "UPDATE factory.work_items SET status = 'failed' WHERE owner = 'reviewprobe' AND repo = 'widgets' AND pr_number = 7 AND kind = 'pr_review' AND status = 'reviewing'"
  expect_accepted "${insert_prefix} 'pr_review', 'reviewprobe', 'widgets', 7, 't', 'reviewing')"
  printf "DELETE FROM factory.work_items WHERE lower(owner) = 'reviewprobe';\n" | psql_exec "${SCRATCH_DB}" >/dev/null
  log "pr_review work items are limited to one active row per pull request, whatever the case of the name"
}

# 調査(investigate)の土台のmigrationが、種別と状態を受け付け、稼働中の一意インデックスを5本そろえることを確かめる。
# 同じIssueの2件目の稼働中のinvestigateは、綴りが違っても拒まれる(拒否の文に制約名が含まれること)。
# ON CONFLICT DO NOTHING では挿入されず、終端の行、別のIssue、別のリポジトリ、別の種類の行は拒まれない。
# 終端の行を稼働中へ戻す更新(retry_work_itemの再開)は、同じIssueの稼働中の行に拒まれる。
# 作り直した既存のインデックスの述語にも、investigatingが入っている。
# `v_lead_time`は終端のinvestigatedを含み、investigatingを含まない。このmigrationの適用直後に呼ぶ。
# (owner, repo, issue_number, cycle)の一意制約に当たらないよう、同じIssueの行はcycleを変えて入れる。
verify_investigate_work_items() {
  # cycle, kind, owner, repo, issue_number, statusから、行を入れる文を作る。
  investigate_row() {
    printf "INSERT INTO factory.work_items (cycle, source, kind, owner, repo, issue_number, issue_url, title, status) VALUES (%s, 'manual', '%s', '%s', '%s', %s, 'https://github.com/investigateprobe/r/issues/%s', 't', '%s')" "$1" "$2" "$3" "$4" "$5" "$5" "$6"
  }
  investigate_accepted() {
    printf '%s;\n' "$1" | psql_exec "${SCRATCH_DB}" >/dev/null || die "the statement was rejected: $1"
  }
  # 文が制約名つきで拒まれることを確かめる。
  investigate_rejected() {
    local statement="$1" constraint="$2" rejected
    if rejected="$(printf '%s;\n' "${statement}" | psql_exec "${SCRATCH_DB}" 2>&1)"; then
      die "the statement was accepted, expected ${constraint} to reject it: ${statement}"
    fi
    case "${rejected}" in
      *"${constraint}"*) ;;
      *) die "the statement was rejected, but not by ${constraint}: ${rejected}" ;;
    esac
  }
  # 値を1つ返すSELECTを実行し、空白を除いて返す。
  investigate_scalar() {
    printf '%s;\n' "$1" | psql_exec "${SCRATCH_DB}" -q -t -A | tr -d '[:space:]'
  }

  local key="work_items_active_investigate_key"
  investigate_accepted "$(investigate_row 1 investigate investigateprobe r 1 investigating)"
  investigate_rejected "$(investigate_row 2 investigate investigateprobe r 1 investigating)" "${key}"
  investigate_rejected "$(investigate_row 3 investigate investigateprobe r 1 picked)" "${key}"
  investigate_rejected "$(investigate_row 4 investigate INVESTIGATEPROBE R 1 investigating)" "${key}"
  local skipped
  skipped="$(printf '%s ON CONFLICT DO NOTHING RETURNING id;\n' "$(investigate_row 5 investigate Investigateprobe R 1 investigating)" \
    | psql_exec "${SCRATCH_DB}" -q -t -A)" \
    || die "ON CONFLICT DO NOTHING failed instead of skipping the investigate insert"
  [ -z "$(printf '%s' "${skipped}" | tr -d '[:space:]')" ] \
    || die "ON CONFLICT DO NOTHING inserted a second active investigate for the Issue"
  investigate_accepted "$(investigate_row 6 investigate investigateprobe r 1 investigated)"
  investigate_accepted "$(investigate_row 7 investigate investigateprobe r 1 failed)"
  investigate_accepted "$(investigate_row 1 investigate investigateprobe r 2 investigating)"
  investigate_accepted "$(investigate_row 1 investigate investigateprobe other 1 investigating)"
  investigate_accepted "$(investigate_row 9 issue investigateprobe r 1 picked)"
  investigate_rejected "$(investigate_row 1 bogus investigateprobe r 4 picked)" work_items_kind_check
  investigate_rejected "$(investigate_row 1 investigate investigateprobe r 4 bogus)" work_items_status_check

  # 作り直した既存のインデックスの述語にも、investigatingが入っている。
  investigate_accepted "$(investigate_row 1 issue investigateprobe r 3 investigating)"
  investigate_rejected "$(investigate_row 2 issue investigateprobe r 3 investigating)" work_items_active_issue_key

  # 終端の行を稼働中へ戻す更新も、同じIssueの稼働中の行に拒まれる。
  investigate_rejected "UPDATE factory.work_items SET status = 'investigating' WHERE kind = 'investigate' AND owner = 'investigateprobe' AND repo = 'r' AND issue_number = 1 AND status = 'investigated'" "${key}"
  # 稼働中の行が終端になれば、同じIssueに新しい稼働中の行を入れられる。
  investigate_accepted "UPDATE factory.work_items SET status = 'investigated' WHERE kind = 'investigate' AND owner = 'investigateprobe' AND repo = 'r' AND issue_number = 1 AND status = 'investigating'"
  investigate_accepted "$(investigate_row 10 investigate investigateprobe r 1 investigating)"

  # 終端のinvestigatedはリードタイムのビューに出て、稼働中のinvestigatingは出ない。
  [ "$(investigate_scalar "SELECT count(*) FROM factory.v_lead_time WHERE owner = 'investigateprobe' AND status = 'investigated'")" = "2" ] \
    || die "expected the two investigated rows in v_lead_time"
  [ "$(investigate_scalar "SELECT count(*) FROM factory.v_lead_time WHERE owner = 'investigateprobe' AND status = 'investigating'")" = "0" ] \
    || die "expected no investigating row in v_lead_time"
  printf "DELETE FROM factory.work_items WHERE lower(owner) = 'investigateprobe';\n" | psql_exec "${SCRATCH_DB}" >/dev/null
  log "investigate work items are limited to one active row per Issue, whatever the case of the name"
}

# 稼働中の調査を全体で1件にする索引の検査。
# 稼働中(investigating)のinvestigateは、Issueやリポジトリ、ownerの綴りが違っても2件目が拒まれる(拒否の文に制約名が含まれること)。
# ON CONFLICT (kind) WHERE ... DO NOTHING では挿入されず、終端の行と、種別の違う行は拒まれない。
# 終端の行を稼働中へ戻す更新も拒まれ、稼働中の行が終端になれば、次の稼働中の行を入れられる。
# 同じIssueの索引が先に拒まないよう、2件目は別のIssueで入れる。このmigrationの適用直後に呼ぶ。
verify_investigate_singleton() {
  # cycle, kind, owner, repo, issue_number, statusから、行を入れる文を作る。
  singleton_row() {
    printf "INSERT INTO factory.work_items (cycle, source, kind, owner, repo, issue_number, issue_url, title, status) VALUES (%s, 'manual', '%s', '%s', '%s', %s, 'https://github.com/singletonprobe/r/issues/%s', 't', '%s')" "$1" "$2" "$3" "$4" "$5" "$5" "$6"
  }
  singleton_accepted() {
    printf '%s;\n' "$1" | psql_exec "${SCRATCH_DB}" >/dev/null || die "the statement was rejected: $1"
  }
  # 文が制約名つきで拒まれることを確かめる。
  singleton_rejected() {
    local statement="$1" constraint="$2" rejected
    if rejected="$(printf '%s;\n' "${statement}" | psql_exec "${SCRATCH_DB}" 2>&1)"; then
      die "the statement was accepted, expected ${constraint} to reject it: ${statement}"
    fi
    case "${rejected}" in
      *"${constraint}"*) ;;
      *) die "the statement was rejected, but not by ${constraint}: ${rejected}" ;;
    esac
  }

  local key="work_items_active_investigate_singleton"
  singleton_accepted "$(singleton_row 1 investigate singletonprobe r 1 investigating)"
  singleton_rejected "$(singleton_row 1 investigate singletonprobe r 2 investigating)" "${key}"
  singleton_rejected "$(singleton_row 1 investigate singletonprobe other 1 investigating)" "${key}"
  singleton_rejected "$(singleton_row 1 investigate SINGLETONPROBE R 3 investigating)" "${key}"
  local skipped
  skipped="$(printf '%s ON CONFLICT (kind) WHERE kind = '"'"'investigate'"'"' AND status = '"'"'investigating'"'"' DO NOTHING RETURNING id;\n' "$(singleton_row 1 investigate singletonprobe r 4 investigating)" \
    | psql_exec "${SCRATCH_DB}" -q -t -A)" \
    || die "ON CONFLICT (kind) WHERE ... DO NOTHING failed instead of skipping the investigate insert"
  [ -z "$(printf '%s' "${skipped}" | tr -d '[:space:]')" ] \
    || die "ON CONFLICT (kind) WHERE ... DO NOTHING inserted a second investigating investigate row"

  # 終端の行と、種別の違う行は拒まれない。
  singleton_accepted "$(singleton_row 1 investigate singletonprobe r 5 investigated)"
  singleton_accepted "$(singleton_row 1 investigate singletonprobe r 6 failed)"
  singleton_accepted "$(singleton_row 1 investigate singletonprobe r 7 needs_human)"
  singleton_accepted "$(singleton_row 1 issue singletonprobe r 8 investigating)"

  # 終端の行を稼働中へ戻す更新も拒まれる。
  singleton_rejected "UPDATE factory.work_items SET status = 'investigating' WHERE kind = 'investigate' AND owner = 'singletonprobe' AND issue_number = 5 AND status = 'investigated'" "${key}"
  # 稼働中の行が終端になれば、次の稼働中の行を入れられる。
  singleton_accepted "UPDATE factory.work_items SET status = 'investigated' WHERE kind = 'investigate' AND owner = 'singletonprobe' AND issue_number = 1 AND status = 'investigating'"
  singleton_accepted "$(singleton_row 2 investigate singletonprobe r 1 investigating)"
  printf "DELETE FROM factory.work_items WHERE lower(owner) = 'singletonprobe';\n" | psql_exec "${SCRATCH_DB}" >/dev/null
  log "investigate work items are limited to one investigating row overall"
}

# 稼働中の調査を全体で1件にする索引のmigrationを戻す検査。戻すと索引が消えて2件目が入り、
# 重複が残るうちはupが索引を作れずに失敗し、重複を消せばupし直せて、また2件目を拒む。
# 全downを当てる検査の前に呼ぶ。
verify_investigate_singleton_rollback() {
  local up="${MIGRATIONS_DIR}/${INVESTIGATE_SINGLETON_MIGRATION}"
  local down="${MIGRATIONS_DIR}/${INVESTIGATE_SINGLETON_MIGRATION%.up.sql}.down.sql"
  local file
  for file in "${up}" "${down}"; do
    [ -f "${file}" ] || die "missing migration: ${file}"
  done
  singleton_scalar() {
    printf '%s;\n' "$1" | psql_exec "${SCRATCH_DB}" -q -t -A | tr -d '[:space:]'
  }
  local insert_prefix="INSERT INTO factory.work_items (cycle, source, kind, owner, repo, issue_number, issue_url, title, status) VALUES (1, 'manual', 'investigate', 'singletonback', 'r',"
  local indexes="SELECT count(*) FROM pg_indexes WHERE schemaname = 'factory' AND indexname = 'work_items_active_investigate_singleton'"

  [ "$(singleton_scalar "${indexes}")" = "1" ] || die "expected the singleton index before the rollback"
  log "rolling back investigate_singleton"
  psql_exec "${SCRATCH_DB}" -q <"${down}" >/dev/null || die "could not roll back investigate_singleton"
  [ "$(singleton_scalar "${indexes}")" = "0" ] || die "expected the singleton index to be dropped by the rollback"
  printf "%s 1, 'https://github.com/singletonback/r/issues/1', 't', 'investigating'), (1, 'manual', 'investigate', 'singletonback', 'r', 2, 'https://github.com/singletonback/r/issues/2', 't', 'investigating');\n" "${insert_prefix}" \
    | psql_exec "${SCRATCH_DB}" >/dev/null || die "two investigating rows were rejected after the rollback"

  local refused
  if refused="$(psql_exec "${SCRATCH_DB}" -q <"${up}" 2>&1)"; then
    die "investigate_singleton was applied over two investigating rows"
  fi
  case "${refused}" in
    *work_items_active_investigate_singleton*) ;;
    *) die "investigate_singleton was refused, but not for the singleton index: ${refused}" ;;
  esac
  [ "$(singleton_scalar "${indexes}")" = "0" ] || die "the refused migration left the singleton index"

  printf "DELETE FROM factory.work_items WHERE owner = 'singletonback' AND issue_number = 2;\n" | psql_exec "${SCRATCH_DB}" >/dev/null
  log "re-applying investigate_singleton"
  psql_exec "${SCRATCH_DB}" -q <"${up}" >/dev/null || die "could not re-apply investigate_singleton"
  [ "$(singleton_scalar "${indexes}")" = "1" ] || die "expected the singleton index after re-applying"
  if printf "%s 3, 'https://github.com/singletonback/r/issues/3', 't', 'investigating');\n" "${insert_prefix}" \
    | psql_exec "${SCRATCH_DB}" >/dev/null 2>&1; then
    die "a second investigating row was accepted after re-applying"
  fi
  printf "DELETE FROM factory.work_items WHERE owner = 'singletonback';\n" | psql_exec "${SCRATCH_DB}" >/dev/null
  log "investigate_singleton drops its index, refuses to apply over duplicates, and round-trips"
}

# 調査の土台のmigrationを戻す検査。investigateの行と、その子の行を入れてから、downを当てる。
# 戻すと、investigateの行が消え、連鎖して子の行(作業項目の履歴と実行の記録)も消える。
# 参照を空にする表(失敗の記録と、子の作業項目の親の参照)の行は残る。ほかの種別の行と履歴は残る。
# 旧い制約は種別investigateと状態investigatingを拒み、稼働中の一意インデックスは5本から4本になり、
# 述語からinvestigatingが消える。最後にupを当て直して、investigateの行を受け付けることを確かめる。
# 全downを当てる検査の前に呼ぶ。
verify_investigate_rollback() {
  local up="${MIGRATIONS_DIR}/${INVESTIGATE_MIGRATION}"
  local down="${MIGRATIONS_DIR}/${INVESTIGATE_MIGRATION%.up.sql}.down.sql"
  local file
  for file in "${up}" "${down}"; do
    [ -f "${file}" ] || die "missing migration: ${file}"
  done

  # 値を1つ返すSELECTを実行し、空白を除いて返す。
  rollback_scalar() {
    printf '%s;\n' "$1" | psql_exec "${SCRATCH_DB}" -q -t -A | tr -d '[:space:]'
  }
  # 文が制約名つきで拒まれることを確かめる。
  rollback_rejected() {
    local statement="$1" constraint="$2" rejected
    if rejected="$(printf '%s;\n' "${statement}" | psql_exec "${SCRATCH_DB}" 2>&1)"; then
      die "the statement was accepted, expected ${constraint} to reject it: ${statement}"
    fi
    case "${rejected}" in
      *"${constraint}"*) ;;
      *) die "the statement was rejected, but not by ${constraint}: ${rejected}" ;;
    esac
  }
  # 稼働中の一意インデックスの述語に、investigatingが入っている数を返す。
  rollback_indexed() {
    rollback_scalar "SELECT count(*) FROM pg_indexes WHERE schemaname = 'factory' AND indexname IN ('work_items_active_issue_key', 'work_items_active_pr_fix_key', 'work_items_active_dependabot_key', 'work_items_active_pr_review_key', 'work_items_active_investigate_key') AND indexdef LIKE '%investigating%'"
  }

  psql_exec "${SCRATCH_DB}" >/dev/null <<'SQL' || die "could not seed the investigate rows"
INSERT INTO factory.work_items (cycle, source, kind, owner, repo, issue_number, issue_url, title, status) VALUES
  (1, 'manual', 'investigate', 'rollbackprobe', 'r', 1, 'https://github.com/rollbackprobe/r/issues/1', 't', 'investigating'),
  (1, 'issue', 'issue', 'rollbackprobe', 'r', 2, 'https://github.com/rollbackprobe/r/issues/2', 't', 'implementing');
INSERT INTO factory.work_items (cycle, source, kind, owner, repo, pr_number, title, status, parent_work_item_id)
  SELECT 1, 'issue', 'pr_fix', 'rollbackprobe', 'r', 3, 't', 'fixing', id
  FROM factory.work_items WHERE owner = 'rollbackprobe' AND kind = 'investigate';
INSERT INTO factory.work_item_events (work_item_id, from_status, to_status)
  SELECT id, 'picked', status FROM factory.work_items WHERE owner = 'rollbackprobe' AND kind IN ('investigate', 'issue');
INSERT INTO factory.agent_runs (work_item_id, stage, attempt, model)
  SELECT id, 'investigate', 1, 'probe-model' FROM factory.work_items WHERE owner = 'rollbackprobe' AND kind = 'investigate';
INSERT INTO factory.job_failures (work_item_id, flow_path, job_id, error)
  SELECT id, 'f/factory/investigate', 'rollbackprobe-job', 'boom' FROM factory.work_items WHERE owner = 'rollbackprobe' AND kind = 'investigate';
SQL
  [ "$(rollback_indexed)" = "5" ] || die "expected investigating in the five active indexes, found $(rollback_indexed)"

  log "rolling back investigate_work_items"
  psql_exec "${SCRATCH_DB}" -q <"${down}" >/dev/null || die "could not roll back investigate_work_items"
  [ "$(rollback_scalar "SELECT count(*) FROM factory.work_items WHERE owner = 'rollbackprobe' AND kind = 'investigate'")" = "0" ] \
    || die "expected the rollback to delete the investigate rows"
  [ "$(rollback_scalar "SELECT string_agg(kind, ',' ORDER BY kind) FROM factory.work_items WHERE owner = 'rollbackprobe'")" = "issue,pr_fix" ] \
    || die "expected the rollback to keep the rows of the other kinds"
  [ "$(rollback_scalar "SELECT count(*) FROM factory.work_item_events e JOIN factory.work_items w ON w.id = e.work_item_id WHERE w.owner = 'rollbackprobe'")" = "1" ] \
    || die "expected the rollback to delete only the events of the investigate rows"
  [ "$(rollback_scalar "SELECT count(*) FROM factory.agent_runs WHERE stage = 'investigate' AND model = 'probe-model'")" = "0" ] \
    || die "expected the rollback to delete the agent runs of the investigate rows"
  [ "$(rollback_scalar "SELECT count(*) FROM factory.job_failures WHERE job_id = 'rollbackprobe-job' AND work_item_id IS NULL")" = "1" ] \
    || die "expected the rollback to keep the failure record with an empty reference"
  [ "$(rollback_scalar "SELECT count(*) FROM factory.work_items WHERE owner = 'rollbackprobe' AND kind = 'pr_fix' AND parent_work_item_id IS NULL")" = "1" ] \
    || die "expected the rollback to keep the child work item with an empty parent"
  rollback_rejected "INSERT INTO factory.work_items (cycle, source, kind, owner, repo, issue_number, issue_url, title, status) VALUES (1, 'manual', 'investigate', 'rollbackprobe', 'r', 4, 'https://github.com/rollbackprobe/r/issues/4', 't', 'picked')" work_items_kind_check
  rollback_rejected "INSERT INTO factory.work_items (cycle, source, kind, owner, repo, issue_number, issue_url, title, status) VALUES (1, 'issue', 'issue', 'rollbackprobe', 'r', 5, 'https://github.com/rollbackprobe/r/issues/5', 't', 'investigating')" work_items_status_check
  [ "$(rollback_indexed)" = "0" ] || die "expected investigating to leave the active indexes after the rollback"
  [ "$(rollback_scalar "SELECT count(*) FROM pg_indexes WHERE schemaname = 'factory' AND indexname = 'work_items_active_investigate_key'")" = "0" ] \
    || die "expected the investigate index to be dropped by the rollback"
  [ "$(rollback_scalar "SELECT count(*) FROM pg_indexes WHERE schemaname = 'factory' AND indexname IN ('work_items_active_issue_key', 'work_items_active_pr_fix_key', 'work_items_active_dependabot_key', 'work_items_active_pr_review_key')")" = "4" ] \
    || die "expected the four active indexes to remain after the rollback"
  [ "$(rollback_scalar "SELECT position('investigated' in pg_get_viewdef('factory.v_lead_time'::regclass))")" = "0" ] \
    || die "expected investigated to leave v_lead_time after the rollback"

  log "re-applying investigate_work_items"
  psql_exec "${SCRATCH_DB}" -q <"${up}" >/dev/null || die "could not re-apply investigate_work_items"
  [ "$(rollback_indexed)" = "5" ] || die "expected investigating in the five active indexes after re-applying, found $(rollback_indexed)"
  printf "INSERT INTO factory.work_items (cycle, source, kind, owner, repo, issue_number, issue_url, title, status) VALUES (1, 'manual', 'investigate', 'rollbackprobe', 'r', 4, 'https://github.com/rollbackprobe/r/issues/4', 't', 'investigating');\n" \
    | psql_exec "${SCRATCH_DB}" >/dev/null || die "an investigate row was rejected after re-applying"
  printf "DELETE FROM factory.work_items WHERE owner = 'rollbackprobe'; DELETE FROM factory.job_failures WHERE job_id = 'rollbackprobe-job';\n" | psql_exec "${SCRATCH_DB}" >/dev/null
  log "investigate_work_items deletes the investigate rows with their children, narrows the checks and the indexes, and round-trips"
}

# 競合を直す仕組みの土台のmigrationが、列の既定値と制約を効かせ、部分索引を作り、
# 戻したときに列、制約、索引を落とし、既存の行を壊さずにもう一度適用できることを確かめる。
# このmigrationの適用直後に呼ぶので、後のmigrationの影響を受けない。もう一度適用し直す。
# 補助の関数は、ほかの検証が同じ名前を別の形で定義しているため、固有の名前にする。
verify_pr_conflict_fix() {
  local up_file="${MIGRATIONS_DIR}/${PR_CONFLICT_FIX_MIGRATION}"
  local down_file="${MIGRATIONS_DIR}/${PR_CONFLICT_FIX_MIGRATION%.up.sql}.down.sql"
  [ -f "${up_file}" ] || die "missing migration: ${up_file}"
  [ -f "${down_file}" ] || die "missing migration: ${down_file}"
  local sha
  sha="$(printf 'b%.0s' $(seq 1 40))"
  local check_prefix="INSERT INTO factory.pr_conflict_checks (owner, repo, pr_number, head_sha"
  local item_prefix="INSERT INTO factory.work_items (cycle, source, kind, owner, repo, issue_number, issue_url, title, status"
  local item_values="1, 'issue', 'issue', 'conflictprobe', 'r', 1, 'https://github.com/conflictprobe/r/issues/1', 't', 'failed'"
  local fix_columns="column_name IN ('fix_work_item_id', 'fix_attempts', 'fix_hold_reason', 'episode_started_at')"
  local item_columns="column_name IN ('conflict_check_id', 'conflict_episode')"

  # 値を1つ返すSELECTを実行し、空白を除いて返す。
  conflict_fix_scalar() {
    printf '%s;\n' "$1" | psql_exec "${SCRATCH_DB}" -q -t -A | tr -d '[:space:]'
  }
  # 文が成功することを確かめる。
  conflict_fix_accepted() {
    printf '%s;\n' "$1" | psql_exec "${SCRATCH_DB}" >/dev/null || die "the statement was rejected: $1"
  }
  # 文が制約名つきで拒まれることを確かめる。
  conflict_fix_rejected() {
    local statement="$1" constraint="$2" rejected
    if rejected="$(printf '%s;\n' "${statement}" | psql_exec "${SCRATCH_DB}" 2>&1)"; then
      die "the statement was accepted, expected ${constraint} to reject it: ${statement}"
    fi
    case "${rejected}" in
      *"${constraint}"*) ;;
      *) die "the statement was rejected, but not by ${constraint}: ${rejected}" ;;
    esac
  }
  # 足した6列の数を数える。
  conflict_fix_columns() {
    conflict_fix_scalar "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'factory' AND ((table_name = 'pr_conflict_checks' AND ${fix_columns}) OR (table_name = 'work_items' AND ${item_columns}))"
  }
  conflict_fix_indexes() {
    conflict_fix_scalar "SELECT count(*) FROM pg_indexes WHERE schemaname = 'factory' AND indexname = 'work_items_conflict_check_id_idx'"
  }

  # 適用の直後は、足した列が既定値で入り、制約が不正な値を拒む。
  conflict_fix_accepted "${check_prefix}) VALUES ('conflictprobe', 'r', 1, '${sha}')"
  local defaults
  defaults="$(conflict_fix_scalar "SELECT fix_attempts || ':' || COALESCE(fix_work_item_id::text, '-') || ':' || COALESCE(fix_hold_reason, '-') || ':' || (episode_started_at IS NOT NULL) FROM factory.pr_conflict_checks WHERE owner = 'conflictprobe' AND pr_number = 1")"
  [ "${defaults}" = "0:-:-:true" ] || die "unexpected defaults of the conflict fix columns: ${defaults}"
  conflict_fix_rejected "${check_prefix}, fix_attempts) VALUES ('conflictprobe', 'r', 2, '${sha}', -1)" pr_conflict_checks_fix_attempts_check
  conflict_fix_rejected "${check_prefix}, fix_hold_reason) VALUES ('conflictprobe', 'r', 2, '${sha}', '')" pr_conflict_checks_fix_hold_reason_check
  conflict_fix_rejected "${check_prefix}, fix_hold_reason) VALUES ('conflictprobe', 'r', 2, '${sha}', repeat('x', 65))" pr_conflict_checks_fix_hold_reason_length_check
  conflict_fix_accepted "${check_prefix}, fix_hold_reason) VALUES ('conflictprobe', 'r', 3, '${sha}', repeat('x', 64))"
  conflict_fix_rejected "${item_prefix}, conflict_check_id, conflict_episode, ci_check_id) VALUES (${item_values}, 1, 1, 2)" work_items_conflict_check_id_exclusive_check
  conflict_fix_rejected "${item_prefix}, conflict_check_id) VALUES (${item_values}, 1)" work_items_conflict_episode_check
  conflict_fix_rejected "${item_prefix}, conflict_episode) VALUES (${item_values}, 1)" work_items_conflict_episode_check
  conflict_fix_rejected "${item_prefix}, conflict_check_id, conflict_episode) VALUES (${item_values}, 5, 0)" work_items_conflict_episode_min_check
  conflict_fix_rejected "${item_prefix}, conflict_check_id, conflict_episode) VALUES (${item_values}, 5, -1)" work_items_conflict_episode_min_check
  conflict_fix_rejected "${item_prefix}, conflict_check_id, conflict_episode) VALUES (${item_values}, 0, 1)" work_items_conflict_check_id_min_check
  conflict_fix_rejected "${item_prefix}, conflict_check_id, conflict_episode) VALUES (${item_values}, -1, 1)" work_items_conflict_check_id_min_check
  conflict_fix_accepted "${item_prefix}, conflict_check_id, conflict_episode) VALUES (${item_values}, 5, 2)"
  local stored
  stored="$(conflict_fix_scalar "SELECT conflict_check_id || ':' || conflict_episode FROM factory.work_items WHERE owner = 'conflictprobe'")"
  [ "${stored}" = "5:2" ] || die "expected conflict_check_id and conflict_episode to be stored, got '${stored}'"
  conflict_fix_accepted "DELETE FROM factory.work_items WHERE owner = 'conflictprobe'"
  conflict_fix_accepted "${item_prefix}, ci_check_id) VALUES (${item_values}, 5)"
  conflict_fix_accepted "DELETE FROM factory.work_items WHERE owner = 'conflictprobe'"
  conflict_fix_accepted "DELETE FROM factory.pr_conflict_checks WHERE owner = 'conflictprobe'"

  # 部分索引は、値のある行だけを対象にする。
  local index_def
  index_def="$(conflict_fix_scalar "SELECT indexdef FROM pg_indexes WHERE schemaname = 'factory' AND indexname = 'work_items_conflict_check_id_idx'")"
  case "${index_def}" in
    *"WHERE(conflict_check_idISNOTNULL)"*) ;;
    *) die "work_items_conflict_check_id_idx is not a partial index over conflict_check_id: ${index_def}" ;;
  esac
  local remaining
  remaining="$(conflict_fix_columns)"
  [ "${remaining}" = "6" ] || die "expected the six columns after applying, found ${remaining}"
  local constraint_names="'pr_conflict_checks_fix_attempts_check', 'pr_conflict_checks_fix_hold_reason_check', 'pr_conflict_checks_fix_hold_reason_length_check', 'work_items_conflict_check_id_exclusive_check', 'work_items_conflict_episode_check', 'work_items_conflict_check_id_min_check', 'work_items_conflict_episode_min_check'"
  local constraints
  constraints="$(conflict_fix_scalar "SELECT count(*) FROM pg_constraint WHERE conname IN (${constraint_names})")"
  [ "${constraints}" = "7" ] || die "expected the seven constraints after applying, found ${constraints}"

  # 戻すと、足した列と索引が消える。
  log "rolling back pr_conflict_fix"
  psql_exec "${SCRATCH_DB}" -q <"${down_file}" >/dev/null || die "could not roll back pr_conflict_fix"
  remaining="$(conflict_fix_columns)"
  [ "${remaining}" = "0" ] || die "expected the six columns to be dropped by the rollback, ${remaining} remain"
  local indexes
  indexes="$(conflict_fix_indexes)"
  [ "${indexes}" = "0" ] || die "expected the index to be dropped by the rollback, ${indexes} remain"
  constraints="$(conflict_fix_scalar "SELECT count(*) FROM pg_constraint WHERE conname IN (${constraint_names})")"
  [ "${constraints}" = "0" ] || die "expected the seven constraints to be dropped by the rollback, ${constraints} remain"

  # 戻した状態で入れた既存の行は、もう一度適用しても壊れず、新しい列は既定値かNULLになる。
  conflict_fix_accepted "${check_prefix}) VALUES ('conflictprobe', 'r', 4, '${sha}')"
  conflict_fix_accepted "${item_prefix}, ci_check_id) VALUES (${item_values}, 9)"
  log "re-applying pr_conflict_fix"
  psql_exec "${SCRATCH_DB}" -q <"${up_file}" >/dev/null || die "could not re-apply pr_conflict_fix over existing rows"
  remaining="$(conflict_fix_columns)"
  [ "${remaining}" = "6" ] || die "expected the six columns after re-applying, found ${remaining}"
  indexes="$(conflict_fix_indexes)"
  [ "${indexes}" = "1" ] || die "expected the index after re-applying, found ${indexes}"
  defaults="$(conflict_fix_scalar "SELECT fix_attempts || ':' || COALESCE(fix_work_item_id::text, '-') || ':' || COALESCE(fix_hold_reason, '-') || ':' || (episode_started_at IS NOT NULL) FROM factory.pr_conflict_checks WHERE owner = 'conflictprobe' AND pr_number = 4")"
  [ "${defaults}" = "0:-:-:true" ] || die "unexpected defaults of an existing row after re-applying: ${defaults}"
  stored="$(conflict_fix_scalar "SELECT ci_check_id || ':' || COALESCE(conflict_check_id::text, '-') || ':' || COALESCE(conflict_episode::text, '-') FROM factory.work_items WHERE owner = 'conflictprobe'")"
  [ "${stored}" = "9:-:-" ] || die "unexpected columns of an existing work item after re-applying: ${stored}"
  conflict_fix_accepted "DELETE FROM factory.work_items WHERE owner = 'conflictprobe'"
  conflict_fix_accepted "DELETE FROM factory.pr_conflict_checks WHERE owner = 'conflictprobe'"
  log "pr_conflict_fix applies over existing rows, rejects invalid values, and round-trips"
}

# 収集の詳細の列を足す前に、旧い形のリポジトリの行と、成功と失敗の実行の行を入れておく。
# 旧いコードが書く行(stageを持たない失敗の行を含む)があっても、新しい制約に反さずにmigrationが当たることを確かめるため。
seed_gh_collect_rows() {
  psql_exec "${SCRATCH_DB}" <<'SQL' >/dev/null
INSERT INTO factory.gh_repos (owner, owner_id, repo, repo_id, allowed) VALUES ('seedprobe', 1, 'r', 2, true);
INSERT INTO factory.gh_collect_runs (owner, ok, finished_at) VALUES ('seedprobe', true, now());
INSERT INTO factory.gh_collect_runs (owner, ok, error_code, finished_at) VALUES ('seedprobe', false, 'timeout', now());
SQL
}

# 収集の詳細のmigrationが、既存の行を変えず、足した列を既定値かNULLにすることを確かめる。
# このmigrationの適用直後に呼ぶ。
verify_gh_collect_detail() {
  # 値を1つ返すSELECTを実行し、空白を除いて返す。
  gh_detail_scalar() {
    printf '%s;\n' "$1" | psql_exec "${SCRATCH_DB}" -q -t -A | tr -d '[:space:]'
  }
  local repos runs unmarked_repos unmarked_runs failed_runs
  repos="$(gh_detail_scalar "SELECT count(*) FROM factory.gh_repos WHERE owner = 'seedprobe'")"
  [ "${repos}" = "1" ] || die "expected the seeded gh_repos row to remain, found ${repos}"
  runs="$(gh_detail_scalar "SELECT count(*) FROM factory.gh_collect_runs WHERE owner = 'seedprobe'")"
  [ "${runs}" = "2" ] || die "expected the seeded gh_collect_runs rows to remain, found ${runs}"
  unmarked_repos="$(gh_detail_scalar "SELECT count(*) FROM factory.gh_repos WHERE owner = 'seedprobe' AND (last_collected_at IS NOT NULL OR last_attempted_at IS NOT NULL OR truncated OR detail_failed)")"
  [ "${unmarked_repos}" = "0" ] || die "expected the seeded gh_repos row to have no collection time and no marks, ${unmarked_repos} differ"
  unmarked_runs="$(gh_detail_scalar "SELECT count(*) FROM factory.gh_collect_runs WHERE owner = 'seedprobe' AND (stage IS NOT NULL OR detail_targets <> 0 OR detail_requests <> 0 OR detail_done <> 0 OR detail_incomplete <> 0)")"
  [ "${unmarked_runs}" = "0" ] || die "expected the seeded gh_collect_runs rows to have no stage and zero counts, ${unmarked_runs} differ"
  failed_runs="$(gh_detail_scalar "SELECT count(*) FROM factory.gh_collect_runs WHERE owner = 'seedprobe' AND NOT ok AND error_code = 'timeout' AND stage IS NULL")"
  [ "${failed_runs}" = "1" ] || die "expected the seeded failed run to keep its error_code and no stage, found ${failed_runs}"
  printf "DELETE FROM factory.gh_collect_runs WHERE owner = 'seedprobe'; DELETE FROM factory.gh_repos WHERE owner = 'seedprobe';\n" \
    | psql_exec "${SCRATCH_DB}" >/dev/null
  log "gh_collect_detail applies over existing rows and leaves the new columns at their defaults"
}

# 稼働中の一意インデックス5本の述語が、アプリの終端でない状態の一覧と一致することを確かめる。
# 一覧は`f/factory/lib/types.ts`から読む。migrationの文面の検査(`tests/scripts/active_*_migration.test.ts`)と違い、
# PostgreSQLが実際に持つインデックスの定義を読む。全migrationの適用後に呼ぶ。
verify_active_index_predicates() {
  local expected
  expected="$(bun --eval 'import { TERMINAL_WORK_ITEM_STATUSES, WORK_ITEM_STATUSES } from "'"${REPO_ROOT}"'/f/factory/lib/types.ts"; console.log(WORK_ITEM_STATUSES.filter((status) => !TERMINAL_WORK_ITEM_STATUSES.includes(status)).sort().join(","));')" \
    || die "could not read the non-terminal statuses from types.ts"
  [ -n "${expected}" ] || die "the non-terminal statuses read from types.ts are empty"
  local index actual
  for index in work_items_active_issue_key work_items_active_pr_fix_key work_items_active_dependabot_key work_items_active_pr_review_key work_items_active_investigate_key; do
    actual="$(psql_exec "${SCRATCH_DB}" -q -t -A -v index="${index}" <<'SQL' | tr -d '[:space:]'
SELECT string_agg(m[1], ',' ORDER BY m[1] COLLATE "C")
FROM (
  SELECT regexp_matches(substring(indexdef from 'ARRAY\[(.*)\]'), '''([a-z_]+)''', 'g') AS m
  FROM pg_indexes
  WHERE schemaname = 'factory' AND indexname = :'index'
) t
SQL
)" || die "could not read the definition of ${index}"
    [ "${actual}" = "${expected}" ] \
      || die "the predicate of ${index} differs from the non-terminal statuses: expected '${expected}', got '${actual}'"
  done
  log "the active work item indexes list every non-terminal status"
}

# 設計工程の土台の2つのmigrationを戻す検査。新しい状態の行と`design`の承認依頼を入れてから、downを新しい順に当てる。
# 1回目は`design`の承認依頼が残っているので、先に走る承認依頼側のdownが、旧い種類の制約を足す文で失敗する。
# 失敗すると作業項目側のdownは走らないので、作業項目も履歴も変わらないことを確かめる。
# 2回目は依頼を消してから両方を当て、新状態の行が`needs_human`へ移って元の状態が履歴に残り、旧い定義へ戻ることを確かめる。
# 最後に両方のupを古い順に当て直す。全downを当てる検査の前に呼ぶ。
verify_design_stage_rollback() {
  local items_up="${MIGRATIONS_DIR}/${DESIGN_STAGE_ITEMS_MIGRATION}"
  local items_down="${MIGRATIONS_DIR}/${DESIGN_STAGE_ITEMS_MIGRATION%.up.sql}.down.sql"
  local kind_up="${MIGRATIONS_DIR}/${DESIGN_STAGE_KIND_MIGRATION}"
  local kind_down="${MIGRATIONS_DIR}/${DESIGN_STAGE_KIND_MIGRATION%.up.sql}.down.sql"
  local file
  for file in "${items_up}" "${items_down}" "${kind_up}" "${kind_down}"; do
    [ -f "${file}" ] || die "missing migration: ${file}"
  done

  # 値を1つ返すSELECTを実行し、空白を除いて返す。
  design_scalar() {
    printf '%s;\n' "$1" | psql_exec "${SCRATCH_DB}" -q -t -A | tr -d '[:space:]'
  }
  # 文が制約名つきで拒まれることを確かめる。
  design_rejected() {
    local statement="$1" constraint="$2" rejected
    if rejected="$(printf '%s;\n' "${statement}" | psql_exec "${SCRATCH_DB}" 2>&1)"; then
      die "the statement was accepted, expected ${constraint} to reject it: ${statement}"
    fi
    case "${rejected}" in
      *"${constraint}"*) ;;
      *) die "the statement was rejected, but not by ${constraint}: ${rejected}" ;;
    esac
  }
  design_columns() {
    design_scalar "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'factory' AND table_name = 'work_items' AND column_name = 'design_attempt'"
  }
  design_statuses() {
    design_scalar "SELECT string_agg(issue_number || ':' || status, ',' ORDER BY issue_number) FROM factory.work_items WHERE owner = 'designprobe'"
  }
  # 稼働中の一意インデックスの述語に、設計工程の状態が入っている数を返す。
  design_indexed() {
    design_scalar "SELECT count(*) FROM pg_indexes WHERE schemaname = 'factory' AND indexname IN ('work_items_active_issue_key', 'work_items_active_pr_fix_key', 'work_items_active_dependabot_key') AND indexdef LIKE '%designing%' AND indexdef LIKE '%awaiting_design_approval%'"
  }

  # 調査の土台のmigrationは設計工程より新しく、同じ制約とインデックスを作り直している。
  # 新しい順に当てるため、先に戻し、検査の最後に当て直す。
  local investigate_up="${MIGRATIONS_DIR}/${INVESTIGATE_MIGRATION}"
  local investigate_down="${MIGRATIONS_DIR}/${INVESTIGATE_MIGRATION%.up.sql}.down.sql"
  log "rolling back investigate_work_items before the design stage"
  psql_exec "${SCRATCH_DB}" -q <"${investigate_down}" >/dev/null || die "could not roll back investigate_work_items"

  psql_exec "${SCRATCH_DB}" >/dev/null <<'SQL' || die "could not seed the design stage rows"
INSERT INTO factory.work_items (cycle, source, kind, owner, repo, issue_number, issue_url, title, status) VALUES
  (1, 'issue', 'issue', 'designprobe', 'r', 1, 'https://github.com/designprobe/r/issues/1', 't', 'designing'),
  (1, 'issue', 'issue', 'designprobe', 'r', 2, 'https://github.com/designprobe/r/issues/2', 't', 'awaiting_design_approval'),
  (1, 'issue', 'issue', 'designprobe', 'r', 3, 'https://github.com/designprobe/r/issues/3', 't', 'implementing');
INSERT INTO factory.approval_requests (kind, work_item_id, subject_id, status)
  SELECT 'design', id, 9001, 'pending' FROM factory.work_items
  WHERE owner = 'designprobe' AND issue_number = 2;
SQL
  [ "$(design_indexed)" = "3" ] || die "expected the design statuses in the three active indexes, found $(design_indexed)"

  # 依頼が残っている間は、承認依頼側のdownが失敗する。`wmill datatable migrate down`と同じく、
  # 失敗したら作業項目側のdownは当てない。行の状態、履歴、列、インデックスは変わらない。
  log "rolling back design_stage_approval_kind while a design approval request remains"
  local refused
  if refused="$(psql_exec "${SCRATCH_DB}" -q <"${kind_down}" 2>&1)"; then
    die "design_stage_approval_kind was rolled back while a design approval request remained"
  fi
  case "${refused}" in
    *approval_requests_kind_check*) ;;
    *) die "design_stage_approval_kind was refused, but not by approval_requests_kind_check: ${refused}" ;;
  esac
  [ "$(design_statuses)" = "1:designing,2:awaiting_design_approval,3:implementing" ] \
    || die "the refused rollback changed the work item statuses: $(design_statuses)"
  [ "$(design_scalar "SELECT count(*) FROM factory.work_item_events e JOIN factory.work_items w ON w.id = e.work_item_id WHERE w.owner = 'designprobe'")" = "0" ] \
    || die "the refused rollback left work item events"
  [ "$(design_columns)" = "1" ] || die "the refused rollback dropped design_attempt"
  [ "$(design_indexed)" = "3" ] || die "the refused rollback changed the active indexes"

  # 依頼を消せば戻せる。新状態の行は`needs_human`へ移り、元の状態が履歴に残る。
  printf "DELETE FROM factory.approval_requests WHERE kind = 'design';\n" | psql_exec "${SCRATCH_DB}" >/dev/null \
    || die "could not delete the design approval request"
  log "rolling back design_stage_approval_kind and design_stage_work_items"
  psql_exec "${SCRATCH_DB}" -q <"${kind_down}" >/dev/null || die "could not roll back design_stage_approval_kind"
  psql_exec "${SCRATCH_DB}" -q <"${items_down}" >/dev/null || die "could not roll back design_stage_work_items"
  [ "$(design_statuses)" = "1:needs_human,2:needs_human,3:implementing" ] \
    || die "unexpected work item statuses after the rollback: $(design_statuses)"
  local moved
  moved="$(design_scalar "SELECT string_agg(w.issue_number || ':' || e.from_status || '>' || e.to_status, ',' ORDER BY w.issue_number) FROM factory.work_item_events e JOIN factory.work_items w ON w.id = e.work_item_id WHERE w.owner = 'designprobe'")"
  [ "${moved}" = "1:designing>needs_human,2:awaiting_design_approval>needs_human" ] \
    || die "unexpected events after the rollback: ${moved}"
  [ "$(design_columns)" = "0" ] || die "expected design_attempt to be dropped by the rollback"
  [ "$(design_indexed)" = "0" ] || die "expected the design statuses to leave the active indexes after the rollback"
  design_rejected "INSERT INTO factory.work_items (cycle, source, kind, owner, repo, issue_number, issue_url, title, status) VALUES (1, 'issue', 'issue', 'designprobe', 'r', 4, 'https://github.com/designprobe/r/issues/4', 't', 'designing')" work_items_status_check
  design_rejected "INSERT INTO factory.approval_requests (kind, work_item_id, subject_id) SELECT 'design', id, 9002 FROM factory.work_items WHERE owner = 'designprobe' AND issue_number = 3" approval_requests_kind_check

  # 戻した後にupを古い順に当て直せる。
  log "re-applying design_stage_work_items and design_stage_approval_kind"
  psql_exec "${SCRATCH_DB}" -q <"${items_up}" >/dev/null || die "could not re-apply design_stage_work_items"
  psql_exec "${SCRATCH_DB}" -q <"${kind_up}" >/dev/null || die "could not re-apply design_stage_approval_kind"
  [ "$(design_columns)" = "1" ] || die "expected design_attempt after re-applying"
  [ "$(design_indexed)" = "3" ] || die "expected the design statuses in the active indexes after re-applying"
  printf "INSERT INTO factory.approval_requests (kind, work_item_id, subject_id) SELECT 'design', id, 9003 FROM factory.work_items WHERE owner = 'designprobe' AND issue_number = 3;\n" \
    | psql_exec "${SCRATCH_DB}" >/dev/null || die "a design approval request was rejected after re-applying"
  printf "DELETE FROM factory.work_items WHERE owner = 'designprobe';\n" | psql_exec "${SCRATCH_DB}" >/dev/null
  log "re-applying investigate_work_items after the design stage"
  psql_exec "${SCRATCH_DB}" -q <"${investigate_up}" >/dev/null || die "could not re-apply investigate_work_items"
  log "design_stage refuses to roll back over a design request without touching work items, moves design work items to needs_human, and round-trips"
}

# 設計書の下書きの表のmigrationを戻す検査。下書きの行を入れてから、downを当てる。
# 1回目は下書きが残っているので、先頭の「行が無ければ通る制約」の追加で失敗する。
# 失敗すると全体が戻るので、表、行、要件定義の下書きの一意制約が残ることを確かめる。
# 2回目は下書きを消してから当て、表と一意制約が無くなることを確かめる。
# 最後にupを当て直す。全downを当てる検査の前に呼ぶ。
verify_design_drafts_rollback() {
  local up="${MIGRATIONS_DIR}/${DESIGN_DRAFTS_MIGRATION}"
  local down="${MIGRATIONS_DIR}/${DESIGN_DRAFTS_MIGRATION%.up.sql}.down.sql"
  local file
  for file in "${up}" "${down}"; do
    [ -f "${file}" ] || die "missing migration: ${file}"
  done

  # 値を1つ返すSELECTを実行し、空白を除いて返す。
  drafts_scalar() {
    printf '%s;\n' "$1" | psql_exec "${SCRATCH_DB}" -q -t -A | tr -d '[:space:]'
  }
  drafts_table() {
    drafts_scalar "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'factory' AND table_name = 'design_drafts'"
  }
  drafts_unique() {
    drafts_scalar "SELECT count(*) FROM pg_constraint WHERE conrelid = 'factory.requirement_drafts'::regclass AND conname = 'requirement_drafts_id_work_item_id_key'"
  }

  psql_exec "${SCRATCH_DB}" >/dev/null <<'SQL' || die "could not seed the design drafts"
INSERT INTO factory.work_items (cycle, source, kind, owner, repo, issue_number, issue_url, title, status) VALUES
  (1, 'issue', 'issue', 'draftsprobe', 'r', 1, 'https://github.com/draftsprobe/r/issues/1', 't', 'designing');
INSERT INTO factory.requirement_drafts (work_item_id, attempt, summary, markdown)
  SELECT id, 1, 's', 'm' FROM factory.work_items WHERE owner = 'draftsprobe';
INSERT INTO factory.design_drafts (work_item_id, requirement_draft_id, design_attempt, summary, markdown)
  SELECT work_item_id, id, 1, 's', 'm' FROM factory.requirement_drafts
  WHERE work_item_id IN (SELECT id FROM factory.work_items WHERE owner = 'draftsprobe');
SQL
  [ "$(drafts_table)" = "1" ] || die "expected the design_drafts table to exist"
  [ "$(drafts_unique)" = "1" ] || die "expected the unique constraint on requirement_drafts to exist"

  log "rolling back design_drafts while a design draft remains"
  local refused
  if refused="$(psql_exec "${SCRATCH_DB}" -q <"${down}" 2>&1)"; then
    die "design_drafts was rolled back while a design draft remained"
  fi
  case "${refused}" in
    *design_drafts_must_be_empty*) ;;
    *) die "design_drafts was refused, but not by design_drafts_must_be_empty: ${refused}" ;;
  esac
  [ "$(drafts_table)" = "1" ] || die "the refused rollback dropped the design_drafts table"
  [ "$(drafts_unique)" = "1" ] || die "the refused rollback dropped the unique constraint on requirement_drafts"
  [ "$(drafts_scalar "SELECT count(*) FROM factory.design_drafts d JOIN factory.work_items w ON w.id = d.work_item_id WHERE w.owner = 'draftsprobe'")" = "1" ] \
    || die "the refused rollback changed the design drafts"
  [ "$(drafts_scalar "SELECT count(*) FROM pg_constraint WHERE conrelid = 'factory.design_drafts'::regclass AND conname = 'design_drafts_must_be_empty'")" = "0" ] \
    || die "the refused rollback left its check constraint behind"

  printf "DELETE FROM factory.design_drafts;\n" | psql_exec "${SCRATCH_DB}" >/dev/null \
    || die "could not delete the design drafts"
  log "rolling back design_drafts"
  psql_exec "${SCRATCH_DB}" -q <"${down}" >/dev/null || die "could not roll back design_drafts"
  [ "$(drafts_table)" = "0" ] || die "expected the design_drafts table to be dropped by the rollback"
  [ "$(drafts_unique)" = "0" ] || die "expected the unique constraint on requirement_drafts to be dropped by the rollback"

  log "re-applying design_drafts"
  psql_exec "${SCRATCH_DB}" -q <"${up}" >/dev/null || die "could not re-apply design_drafts"
  [ "$(drafts_table)" = "1" ] || die "expected the design_drafts table after re-applying"
  [ "$(drafts_unique)" = "1" ] || die "expected the unique constraint on requirement_drafts after re-applying"
  printf "DELETE FROM factory.work_items WHERE owner = 'draftsprobe';\n" | psql_exec "${SCRATCH_DB}" >/dev/null
  log "design_drafts refuses to roll back over a design draft without dropping the table, and round-trips"
}

# 要件定義の下書きの基準値の列を足すmigrationを、値の入った行ごと戻して当て直す。
# 戻すと列と値が消え、当て直した列は既存の行でnullになることを確かめる。全downを当てる検査の前に呼ぶ。
verify_doc_hash_rollback() {
  local up="${MIGRATIONS_DIR}/${DOC_HASH_MIGRATION}"
  local down="${MIGRATIONS_DIR}/${DOC_HASH_MIGRATION%.up.sql}.down.sql"
  local file
  for file in "${up}" "${down}"; do
    [ -f "${file}" ] || die "missing migration: ${file}"
  done

  hash_scalar() {
    printf '%s;\n' "$1" | psql_exec "${SCRATCH_DB}" -q -t -A | tr -d '[:space:]'
  }
  hash_columns() {
    hash_scalar "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'factory' AND table_name = 'requirement_drafts' AND column_name = 'doc_hash'"
  }

  psql_exec "${SCRATCH_DB}" >/dev/null <<'SQL' || die "could not seed the requirement draft with a doc hash"
INSERT INTO factory.work_items (cycle, source, kind, owner, repo, issue_number, issue_url, title, status) VALUES
  (1, 'issue', 'issue', 'hashprobe', 'r', 1, 'https://github.com/hashprobe/r/issues/1', 't', 'awaiting_approval');
INSERT INTO factory.requirement_drafts (work_item_id, attempt, summary, markdown, doc_hash)
  SELECT id, 1, 's', 'm', repeat('a', 64) FROM factory.work_items WHERE owner = 'hashprobe';
SQL
  [ "$(hash_columns)" = "1" ] || die "expected the doc_hash column"

  log "rolling back requirement_drafts_doc_hash"
  psql_exec "${SCRATCH_DB}" -q <"${down}" >/dev/null || die "could not roll back requirement_drafts_doc_hash"
  [ "$(hash_columns)" = "0" ] || die "expected the doc_hash column to be dropped by the rollback"

  log "re-applying requirement_drafts_doc_hash"
  psql_exec "${SCRATCH_DB}" -q <"${up}" >/dev/null || die "could not re-apply requirement_drafts_doc_hash"
  [ "$(hash_columns)" = "1" ] || die "expected the doc_hash column after re-applying"
  [ "$(hash_scalar "SELECT count(*) FROM factory.requirement_drafts d JOIN factory.work_items w ON w.id = d.work_item_id WHERE w.owner = 'hashprobe' AND d.doc_hash IS NULL")" = "1" ] \
    || die "expected the existing draft to have no doc hash after re-applying"
  printf "DELETE FROM factory.work_items WHERE owner = 'hashprobe';\n" | psql_exec "${SCRATCH_DB}" >/dev/null
  log "requirement_drafts_doc_hash round-trips and leaves existing drafts without a baseline"
}

# 実装ラウンドの結果に`design_gap`を足すmigrationを、既存の行ごと戻して当て直す。
# 戻す前に`design_gap`の行があると、旧い一覧の制約を足す文が失敗し、全体が戻ることを確かめる。
# 行を消せば戻せて、旧い一覧は`design_gap`を拒み、当て直せば受け入れる。全downを当てる検査の前に呼ぶ。
verify_implement_rounds_design_gap_rollback() {
  local up="${MIGRATIONS_DIR}/${IMPLEMENT_ROUNDS_DESIGN_GAP_MIGRATION}"
  local down="${MIGRATIONS_DIR}/${IMPLEMENT_ROUNDS_DESIGN_GAP_MIGRATION%.up.sql}.down.sql"
  local file
  for file in "${up}" "${down}"; do
    [ -f "${file}" ] || die "missing migration: ${file}"
  done

  gap_scalar() {
    printf '%s;\n' "$1" | psql_exec "${SCRATCH_DB}" -q -t -A | tr -d '[:space:]'
  }
  gap_rejected() {
    local statement="$1" constraint="$2" rejected
    if rejected="$(printf '%s;\n' "${statement}" | psql_exec "${SCRATCH_DB}" 2>&1)"; then
      die "the statement was accepted, expected ${constraint} to reject it: ${statement}"
    fi
    case "${rejected}" in
      *"${constraint}"*) ;;
      *) die "the statement was rejected, but not by ${constraint}: ${rejected}" ;;
    esac
  }
  gap_outcomes() {
    gap_scalar "SELECT string_agg(r.outcome, ',' ORDER BY r.round) FROM factory.implement_rounds r JOIN factory.work_items w ON w.id = r.work_item_id WHERE w.owner = 'gapprobe'"
  }

  psql_exec "${SCRATCH_DB}" >/dev/null <<'SQL' || die "could not seed the implement rounds"
INSERT INTO factory.work_items (cycle, source, kind, owner, repo, issue_number, issue_url, title, status) VALUES
  (1, 'issue', 'issue', 'gapprobe', 'r', 1, 'https://github.com/gapprobe/r/issues/1', 't', 'implementing');
INSERT INTO factory.implement_rounds (work_item_id, attempt, round, mode, outcome, gap_report)
  SELECT id, 1, 1, 'implement', 'requirements_gap', 'r' FROM factory.work_items WHERE owner = 'gapprobe';
INSERT INTO factory.implement_rounds (work_item_id, attempt, round, mode, outcome, gap_report)
  SELECT id, 1, 2, 'implement', 'design_gap', 'd' FROM factory.work_items WHERE owner = 'gapprobe';
SQL
  [ "$(gap_outcomes)" = "requirements_gap,design_gap" ] || die "unexpected rounds before the rollback: $(gap_outcomes)"

  log "rolling back implement_rounds_design_gap while a design_gap round remains"
  local refused
  if refused="$(psql_exec "${SCRATCH_DB}" -q <"${down}" 2>&1)"; then
    die "implement_rounds_design_gap was rolled back while a design_gap round remained"
  fi
  case "${refused}" in
    *implement_rounds_outcome_check*) ;;
    *) die "implement_rounds_design_gap was refused, but not by implement_rounds_outcome_check: ${refused}" ;;
  esac
  [ "$(gap_outcomes)" = "requirements_gap,design_gap" ] || die "the refused rollback changed the rounds: $(gap_outcomes)"
  gap_rejected "INSERT INTO factory.implement_rounds (work_item_id, attempt, round, mode, outcome) SELECT id, 1, 3, 'implement', 'bogus' FROM factory.work_items WHERE owner = 'gapprobe'" implement_rounds_outcome_check

  printf "DELETE FROM factory.implement_rounds WHERE outcome = 'design_gap';\n" | psql_exec "${SCRATCH_DB}" >/dev/null \
    || die "could not delete the design_gap round"
  log "rolling back implement_rounds_design_gap"
  psql_exec "${SCRATCH_DB}" -q <"${down}" >/dev/null || die "could not roll back implement_rounds_design_gap"
  [ "$(gap_outcomes)" = "requirements_gap" ] || die "unexpected rounds after the rollback: $(gap_outcomes)"
  gap_rejected "INSERT INTO factory.implement_rounds (work_item_id, attempt, round, mode, outcome) SELECT id, 1, 3, 'implement', 'design_gap' FROM factory.work_items WHERE owner = 'gapprobe'" implement_rounds_outcome_check

  log "re-applying implement_rounds_design_gap"
  psql_exec "${SCRATCH_DB}" -q <"${up}" >/dev/null || die "could not re-apply implement_rounds_design_gap"
  printf "INSERT INTO factory.implement_rounds (work_item_id, attempt, round, mode, outcome, gap_report) SELECT id, 1, 3, 'implement', 'design_gap', 'd' FROM factory.work_items WHERE owner = 'gapprobe';\n" \
    | psql_exec "${SCRATCH_DB}" >/dev/null || die "a design_gap round was rejected after re-applying"
  gap_rejected "INSERT INTO factory.implement_rounds (work_item_id, attempt, round, mode, outcome) SELECT id, 1, 4, 'implement', 'bogus' FROM factory.work_items WHERE owner = 'gapprobe'" implement_rounds_outcome_check
  printf "DELETE FROM factory.work_items WHERE owner = 'gapprobe';\n" | psql_exec "${SCRATCH_DB}" >/dev/null
  log "implement_rounds_design_gap refuses to roll back over a design_gap round, and round-trips"
}

# 修正ラウンドの結果に`design_gap`を足すmigrationの前に、既存の結果の行を入れておく。
# 制約の付け替えが、既存の行の上で通り、行を変えないことを確かめるため。
seed_fix_rounds_rows() {
  psql_exec "${SCRATCH_DB}" >/dev/null <<'SQL' || die "could not seed the fix rounds"
INSERT INTO factory.work_items (cycle, source, kind, owner, repo, pr_number, title, status) VALUES
  (1, 'issue', 'pr_fix', 'fixgapprobe', 'r', 1, 't', 'needs_human');
INSERT INTO factory.fix_rounds (work_item_id, round, outcome)
  SELECT id, 1, 'done' FROM factory.work_items WHERE owner = 'fixgapprobe';
INSERT INTO factory.fix_rounds (work_item_id, round, outcome)
  SELECT id, 2, 'blocked' FROM factory.work_items WHERE owner = 'fixgapprobe';
INSERT INTO factory.fix_rounds (work_item_id, round, outcome)
  SELECT id, 3, 'requirements_gap' FROM factory.work_items WHERE owner = 'fixgapprobe';
SQL
}

fix_scalar() {
  printf '%s;\n' "$1" | psql_exec "${SCRATCH_DB}" -q -t -A | tr -d '[:space:]'
}
fix_outcomes() {
  fix_scalar "SELECT string_agg(r.outcome, ',' ORDER BY r.round) FROM factory.fix_rounds r JOIN factory.work_items w ON w.id = r.work_item_id WHERE w.owner = 'fixgapprobe'"
}

# 付け替えた後も、入れておいた行がそのまま残り、`design_gap`を受け入れることを確かめる。
verify_fix_rounds_rows_survive() {
  [ "$(fix_outcomes)" = "done,blocked,requirements_gap" ] || die "the fix rounds changed while the check was replaced: $(fix_outcomes)"
  log "fix_rounds_design_gap kept the existing rounds"
}

# 修正ラウンドの結果に`design_gap`を足すmigrationを、既存の行ごと戻して当て直す。
# 戻す前に`design_gap`の行があると、旧い一覧の制約を足す文が失敗し、全体が戻ることを確かめる。
# 行を消せば戻せて、旧い一覧は`design_gap`を拒み、当て直せば受け入れる。全downを当てる検査の前に呼ぶ。
verify_fix_rounds_design_gap_rollback() {
  local up="${MIGRATIONS_DIR}/${FIX_ROUNDS_DESIGN_GAP_MIGRATION}"
  local down="${MIGRATIONS_DIR}/${FIX_ROUNDS_DESIGN_GAP_MIGRATION%.up.sql}.down.sql"
  local file
  for file in "${up}" "${down}"; do
    [ -f "${file}" ] || die "missing migration: ${file}"
  done

  fix_rejected() {
    local statement="$1" constraint="$2" rejected
    if rejected="$(printf '%s;\n' "${statement}" | psql_exec "${SCRATCH_DB}" 2>&1)"; then
      die "the statement was accepted, expected ${constraint} to reject it: ${statement}"
    fi
    case "${rejected}" in
      *"${constraint}"*) ;;
      *) die "the statement was rejected, but not by ${constraint}: ${rejected}" ;;
    esac
  }

  printf "INSERT INTO factory.fix_rounds (work_item_id, round, outcome) SELECT id, 4, 'design_gap' FROM factory.work_items WHERE owner = 'fixgapprobe';\n" \
    | psql_exec "${SCRATCH_DB}" >/dev/null || die "a design_gap round was rejected after the migration"
  [ "$(fix_outcomes)" = "done,blocked,requirements_gap,design_gap" ] || die "unexpected rounds before the rollback: $(fix_outcomes)"
  fix_rejected "INSERT INTO factory.fix_rounds (work_item_id, round, outcome) SELECT id, 5, 'bogus' FROM factory.work_items WHERE owner = 'fixgapprobe'" fix_rounds_outcome_check

  log "rolling back fix_rounds_design_gap while a design_gap round remains"
  local refused
  if refused="$(psql_exec "${SCRATCH_DB}" -q <"${down}" 2>&1)"; then
    die "fix_rounds_design_gap was rolled back while a design_gap round remained"
  fi
  case "${refused}" in
    *fix_rounds_outcome_check*) ;;
    *) die "fix_rounds_design_gap was refused, but not by fix_rounds_outcome_check: ${refused}" ;;
  esac
  [ "$(fix_outcomes)" = "done,blocked,requirements_gap,design_gap" ] || die "the refused rollback changed the rounds: $(fix_outcomes)"

  printf "DELETE FROM factory.fix_rounds WHERE outcome = 'design_gap';\n" | psql_exec "${SCRATCH_DB}" >/dev/null \
    || die "could not delete the design_gap round"
  log "rolling back fix_rounds_design_gap"
  psql_exec "${SCRATCH_DB}" -q <"${down}" >/dev/null || die "could not roll back fix_rounds_design_gap"
  [ "$(fix_outcomes)" = "done,blocked,requirements_gap" ] || die "unexpected rounds after the rollback: $(fix_outcomes)"
  fix_rejected "INSERT INTO factory.fix_rounds (work_item_id, round, outcome) SELECT id, 4, 'design_gap' FROM factory.work_items WHERE owner = 'fixgapprobe'" fix_rounds_outcome_check

  log "re-applying fix_rounds_design_gap"
  psql_exec "${SCRATCH_DB}" -q <"${up}" >/dev/null || die "could not re-apply fix_rounds_design_gap"
  [ "$(fix_outcomes)" = "done,blocked,requirements_gap" ] || die "the re-applied migration changed the rounds: $(fix_outcomes)"
  printf "INSERT INTO factory.fix_rounds (work_item_id, round, outcome) SELECT id, 4, 'design_gap' FROM factory.work_items WHERE owner = 'fixgapprobe';\n" \
    | psql_exec "${SCRATCH_DB}" >/dev/null || die "a design_gap round was rejected after re-applying"
  fix_rejected "INSERT INTO factory.fix_rounds (work_item_id, round, outcome) SELECT id, 5, 'bogus' FROM factory.work_items WHERE owner = 'fixgapprobe'" fix_rounds_outcome_check
  printf "DELETE FROM factory.work_items WHERE owner = 'fixgapprobe';\n" | psql_exec "${SCRATCH_DB}" >/dev/null
  log "fix_rounds_design_gap refuses to roll back over a design_gap round, and round-trips"
}

for up_file in "${up_files[@]}"; do
  up_name="$(basename "${up_file}")"
  if [ "${up_name}" = "${ACTIVE_ISSUE_MIGRATION}" ]; then
    seed_active_issue_duplicates
  fi
  if [ "${up_name}" = "${NOTICES_DEDUP_MIGRATION}" ]; then
    seed_notice_duplicates
  fi
  if [ "${up_name}" = "${GH_COLLECT_DETAIL_MIGRATION}" ]; then
    seed_gh_collect_rows
  fi
  if [ "${up_name}" = "${DISK_USAGE_NOTICE_MIGRATION}" ]; then
    seed_disk_usage_notices
  fi
  if [ "${up_name}" = "${FIX_ROUNDS_DESIGN_GAP_MIGRATION}" ]; then
    seed_fix_rounds_rows
  fi
  if [ "${up_name}" = "${ACTIVE_PR_REVIEW_MIGRATION}" ]; then
    seed_active_pr_review_duplicates
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
  if [ "${up_name}" = "${PR_CI_FIX_SCHEMA_MIGRATION}" ]; then
    verify_pr_ci_fix_schema
  fi
  if [ "${up_name}" = "${ACTIVE_PR_FIX_MIGRATION}" ]; then
    verify_active_pr_fix_index
  fi
  if [ "${up_name}" = "${PR_CONFLICT_FIX_MIGRATION}" ]; then
    verify_pr_conflict_fix
  fi
  if [ "${up_name}" = "${GH_COLLECT_DETAIL_MIGRATION}" ]; then
    verify_gh_collect_detail
  fi
  if [ "${up_name}" = "${FIX_ROUNDS_DESIGN_GAP_MIGRATION}" ]; then
    verify_fix_rounds_rows_survive
  fi
  if [ "${up_name}" = "${ACTIVE_PR_REVIEW_MIGRATION}" ]; then
    verify_active_pr_review_index
  fi
  if [ "${up_name}" = "${INVESTIGATE_MIGRATION}" ]; then
    verify_investigate_work_items
  fi
  if [ "${up_name}" = "${INVESTIGATE_SINGLETON_MIGRATION}" ]; then
    verify_investigate_singleton
  fi
done

verify_issue_intake
verify_active_index_predicates

views=(v_inbox v_pipeline v_agent_cost_daily v_agent_usage_daily v_agent_model_usage_daily v_approval_stats v_lead_time v_failures v_notices v_reviews v_fix_rounds v_issue_proposals v_approval_requests)
for view in "${views[@]}"; do
  log "SELECT * FROM factory.${view} LIMIT 1;"
  printf 'SELECT * FROM factory.%s LIMIT 1;\n' "${view}" | psql_exec "${SCRATCH_DB}" >/dev/null
done
log "all ${#views[@]} views selected successfully"

# 日別のビューが、日本時間の0時で日を切ることを確かめる。
# 日本時間の10月7日の最後の1秒と10月8日の最初の1秒の実行を入れ、別の日に数えることを見る。
# 接続の時刻帯をUTCから離れた値にして読み、時刻帯の設定に左右されないことも確かめる。
jst_rows="$(printf "INSERT INTO factory.work_items (cycle, source, kind, owner, repo, issue_number, issue_url, title, status) VALUES (1, 'issue', 'issue', 'jstprobe', 'r', 1, 'https://github.com/jstprobe/r/issues/1', 't', 'failed');
INSERT INTO factory.agent_runs (work_item_id, stage, attempt, model, created_at)
SELECT id, 'implement', a.attempt, 'jst-probe', a.created_at::timestamptz
FROM factory.work_items, (VALUES (1, '2026-10-07T14:59:59Z'), (2, '2026-10-07T15:00:00Z')) AS a (attempt, created_at)
WHERE owner = 'jstprobe';
SET TIME ZONE 'America/Los_Angeles';
SELECT to_char(day AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD') || '=' || run_count
FROM factory.v_agent_cost_daily WHERE model = 'jst-probe' ORDER BY day;\n" \
  | psql_exec "${SCRATCH_DB}" -q -t -A | grep -v -e '^INSERT' -e '^SET' | paste -sd ',' -)" \
  || die "could not read v_agent_cost_daily"
[ "${jst_rows}" = "2026-10-07=1,2026-10-08=1" ] \
  || die "unexpected v_agent_cost_daily days: '${jst_rows}'"
printf "DELETE FROM factory.work_items WHERE owner = 'jstprobe';\n" | psql_exec "${SCRATCH_DB}" -q >/dev/null
log "v_agent_cost_daily cuts the day at Japan time regardless of the session time zone"

# バージョン別の使用量のビューが、版の違う実行を別の行にし、版の記録が無い実行をNULLのまま1つにまとめることを確かめる。
usage_rows="$(printf "INSERT INTO factory.work_items (cycle, source, kind, owner, repo, issue_number, issue_url, title, status) VALUES (1, 'issue', 'issue', 'usageprobe', 'r', 1, 'https://github.com/usageprobe/r/issues/1', 't', 'failed');
INSERT INTO factory.agent_runs (work_item_id, stage, attempt, model, claude_version, input_tokens, output_tokens, cache_read_tokens, cost_usd, num_turns, duration_ms)
SELECT id, 'implement', a.attempt, 'probe-model', a.version, 10, 20, 30, 0.5, 4, 100
FROM factory.work_items, (VALUES (1, NULL), (2, NULL), (3, '9.9.9')) AS a (attempt, version)
WHERE owner = 'usageprobe';
SELECT COALESCE(claude_version, '-') || '=' || run_count || ':' || total_cost_usd || ':' || total_input_tokens || ':' || total_output_tokens || ':' || total_cache_read_tokens || ':' || total_turns || ':' || round(avg_duration_ms)
FROM factory.v_agent_usage_daily WHERE model = 'probe-model' ORDER BY claude_version NULLS LAST;\n" \
  | psql_exec "${SCRATCH_DB}" -q -t -A | grep -v '^INSERT' | paste -sd ',' -)" \
  || die "could not read v_agent_usage_daily"
[ "${usage_rows}" = "9.9.9=1:0.5000:10:20:30:4:100,-=2:1.0000:20:40:60:8:100" ] \
  || die "unexpected v_agent_usage_daily rows: '${usage_rows}'"
printf "DELETE FROM factory.work_items WHERE owner = 'usageprobe';\n" | psql_exec "${SCRATCH_DB}" -q >/dev/null
log "v_agent_usage_daily groups runs by claude_version and keeps a missing version as NULL"

# モデル別の使用量のビューが、渡したモデルではなく実際に使われたモデルで数え、
# 内訳を持たない実行を渡したモデルで数えることを確かめる。
# 1回目の実行は渡したモデルと別のモデルを使い、2回目は内訳を持たない。
model_rows="$(printf "INSERT INTO factory.work_items (cycle, source, kind, owner, repo, issue_number, issue_url, title, status) VALUES (1, 'issue', 'issue', 'modelprobe', 'r', 1, 'https://github.com/modelprobe/r/issues/1', 't', 'failed');
INSERT INTO factory.agent_runs (work_item_id, stage, attempt, model, claude_version, input_tokens, output_tokens, cache_read_tokens, cost_usd, model_usage)
SELECT id, 'implement', 1, 'probe-requested', NULL, 10, 20, 30, 0.5,
  '[{\"model\":\"probe-actual\",\"input_tokens\":7,\"output_tokens\":8,\"cache_read_tokens\":9,\"cache_creation_tokens\":1,\"cost_usd\":0.3},{\"model\":\"probe-helper\",\"input_tokens\":3,\"output_tokens\":12,\"cache_read_tokens\":21,\"cache_creation_tokens\":2,\"cost_usd\":0.2}]'::jsonb
FROM factory.work_items WHERE owner = 'modelprobe';
INSERT INTO factory.agent_runs (work_item_id, stage, attempt, model, claude_version, input_tokens, output_tokens, cache_read_tokens, cost_usd)
SELECT id, 'implement', 2, 'probe-requested', NULL, 10, 20, 30, 0.5
FROM factory.work_items WHERE owner = 'modelprobe';
SELECT model || '=' || run_count || ':' || total_cost_usd || ':' || total_input_tokens || ':' || total_output_tokens || ':' || total_cache_read_tokens || ':' || COALESCE(total_cache_creation_tokens::text, '-')
FROM factory.v_agent_model_usage_daily WHERE left(model, 6) = 'probe-' ORDER BY model;\n" \
  | psql_exec "${SCRATCH_DB}" -q -t -A | grep -v '^INSERT' | paste -sd ',' -)" \
  || die "could not read v_agent_model_usage_daily"
[ "${model_rows}" = "probe-actual=1:0.3:7:8:9:1,probe-helper=1:0.2:3:12:21:2,probe-requested=1:0.5000:10:20:30:-" ] \
  || die "unexpected v_agent_model_usage_daily rows: '${model_rows}'"
# 配列でないmodel_usageは、列の検査が拒む。
if printf "INSERT INTO factory.agent_runs (work_item_id, stage, attempt, model, model_usage) SELECT id, 'implement', 3, 'probe-requested', '{}'::jsonb FROM factory.work_items WHERE owner = 'modelprobe';\n" \
  | psql_exec "${SCRATCH_DB}" -q >/dev/null 2>&1; then
  die "expected agent_runs to reject a model_usage that is not an array"
fi
printf "DELETE FROM factory.work_items WHERE owner = 'modelprobe';\n" | psql_exec "${SCRATCH_DB}" -q >/dev/null
log "v_agent_model_usage_daily counts the models actually used and falls back to the requested model"

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

# 保留の表の制約と、`lib/holds.ts`が組み立てるSQL文を、本物のPostgreSQLで確かめる。
log "running the holds checks against '${SCRATCH_DB}'"
COMPOSE_FILE="${COMPOSE_FILE}" SCRATCH_DB="${SCRATCH_DB}" \
  bun run "${REPO_ROOT}/scripts/test-db-holds.ts" \
  || die "the holds checks failed against the real PostgreSQL"

# 操作の記録の表の制約と、`lib/console_actions.ts`が組み立てるSQL文を、本物のPostgreSQLで確かめる。
log "running the console actions checks against '${SCRATCH_DB}'"
COMPOSE_FILE="${COMPOSE_FILE}" SCRATCH_DB="${SCRATCH_DB}" \
  bun run "${REPO_ROOT}/scripts/test-db-console-actions.ts" \
  || die "the console actions checks failed against the real PostgreSQL"

# 反映の承認の表の制約と、`lib/deploy_approvals.ts`が組み立てるSQL文を、本物のPostgreSQLで確かめる。
log "running the deploy approvals checks against '${SCRATCH_DB}'"
COMPOSE_FILE="${COMPOSE_FILE}" SCRATCH_DB="${SCRATCH_DB}" \
  bun run "${REPO_ROOT}/scripts/test-db-deploy-approvals.ts" \
  || die "the deploy approvals checks failed against the real PostgreSQL"

verify_investigate_singleton_rollback
verify_investigate_rollback
verify_design_stage_rollback
verify_design_drafts_rollback
verify_doc_hash_rollback
verify_implement_rounds_design_gap_rollback
verify_fix_rounds_design_gap_rollback

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
