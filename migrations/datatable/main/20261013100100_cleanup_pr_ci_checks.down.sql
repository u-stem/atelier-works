-- down migration: cleanup_pr_ci_checks
-- 削除した件数の記録は失われる。
BEGIN;

ALTER TABLE factory.cleanup_runs DROP COLUMN pr_ci_checks_deleted;

END;
