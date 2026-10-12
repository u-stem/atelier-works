-- down migration: cleanup_main_ci_runs
-- 削除した件数の記録は失われる。
BEGIN;

ALTER TABLE factory.cleanup_runs DROP COLUMN main_ci_runs_deleted;

END;
