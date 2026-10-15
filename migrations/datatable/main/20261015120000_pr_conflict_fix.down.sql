-- down migration: pr_conflict_fix
-- 足した列の値は捨てる。
-- コードを戻し、競合を直す回が終端になってから実行する。
-- 列を落とすと、その作業項目が通常の修正回と見分けがつかなくなるため。
BEGIN;

SET LOCAL lock_timeout = '30s';

DROP INDEX factory.work_items_conflict_check_id_idx;

ALTER TABLE factory.work_items
    DROP CONSTRAINT work_items_conflict_episode_min_check,
    DROP CONSTRAINT work_items_conflict_check_id_min_check,
    DROP CONSTRAINT work_items_conflict_episode_check,
    DROP CONSTRAINT work_items_conflict_check_id_exclusive_check,
    DROP COLUMN conflict_episode,
    DROP COLUMN conflict_check_id;

ALTER TABLE factory.pr_conflict_checks
    DROP CONSTRAINT pr_conflict_checks_fix_hold_reason_check,
    DROP CONSTRAINT pr_conflict_checks_fix_hold_reason_length_check,
    DROP CONSTRAINT pr_conflict_checks_fix_attempts_check,
    DROP COLUMN episode_started_at,
    DROP COLUMN fix_hold_reason,
    DROP COLUMN fix_attempts,
    DROP COLUMN fix_work_item_id;

END;
