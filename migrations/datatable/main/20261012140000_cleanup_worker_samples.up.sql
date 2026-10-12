-- up migration: cleanup_worker_samples
--
-- 保持期間を過ぎた、workerの負荷の記録(worker_samples)をcleanup_dbが削除する。
-- その件数をcleanup_runsに残すため、列を足す。既存の行は0にする。
BEGIN;

ALTER TABLE factory.cleanup_runs
    ADD COLUMN worker_samples_deleted integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN factory.cleanup_runs.worker_samples_deleted IS
    '保持期間(retention_logs_days)を過ぎたworker_samplesの行を、cleanup_dbが削除した件数。';

END;
