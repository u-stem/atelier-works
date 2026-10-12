-- down migration: pr_ci_fix_schema
-- 足した列の値は捨てる。
-- fixingの行は状態の制約を戻せないので、先にfailedへ移す。failedは同じheadの再実行で判定し直される。
BEGIN;

SET LOCAL lock_timeout = '30s';

DROP INDEX factory.work_items_ci_check_id_idx;

ALTER TABLE factory.work_items
    DROP COLUMN ci_check_id;

UPDATE factory.pr_ci_checks
SET state = 'failed', updated_at = now()
WHERE state = 'fixing';

ALTER TABLE factory.pr_ci_checks DROP CONSTRAINT pr_ci_checks_state_check;
ALTER TABLE factory.pr_ci_checks ADD CONSTRAINT pr_ci_checks_state_check
    CHECK (state IN ('pending', 'passed', 'failed', 'superseded', 'expired', 'no_ci', 'observed'));

ALTER TABLE factory.pr_ci_checks
    DROP COLUMN fix_hold_reason,
    DROP COLUMN fix_attempts,
    DROP COLUMN fix_work_item_id;

END;
