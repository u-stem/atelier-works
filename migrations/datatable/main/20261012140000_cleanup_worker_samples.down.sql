-- down migration: cleanup_worker_samples
-- 削除した件数の記録は失われる。
BEGIN;

ALTER TABLE factory.cleanup_runs DROP COLUMN worker_samples_deleted;

END;
