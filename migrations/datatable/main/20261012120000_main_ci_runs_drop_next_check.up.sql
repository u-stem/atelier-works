-- up migration: main_ci_runs_drop_next_check
--
-- 照会の間隔を延ばす仕組みは使わないので、next_check_atの列とその索引を落とす。
-- 判定待ちの行を最初に見た順に引く索引は、state = 'pending'の部分索引として作り直す。
BEGIN;

DROP INDEX factory.main_ci_runs_pending_idx;
ALTER TABLE factory.main_ci_runs DROP COLUMN next_check_at;
CREATE INDEX main_ci_runs_pending_idx ON factory.main_ci_runs (first_seen_at) WHERE state = 'pending';

END;
