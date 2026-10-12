-- up migration: cleanup_main_ci_runs
--
-- 保持期間を過ぎた、mainのCIの判定済みの記録(main_ci_runs)をcleanup_dbが削除する。
-- pendingの行は削除しない。その件数をcleanup_runsに残すため、列を足す。既存の行は0にする。
BEGIN;

ALTER TABLE factory.cleanup_runs
    ADD COLUMN main_ci_runs_deleted integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN factory.cleanup_runs.main_ci_runs_deleted IS
    '保持期間(retention_logs_days)を過ぎた、判定済み(pending以外)のmain_ci_runsの行を、cleanup_dbが削除した件数。';

END;
