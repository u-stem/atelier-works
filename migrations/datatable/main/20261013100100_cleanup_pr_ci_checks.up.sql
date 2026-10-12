-- up migration: cleanup_pr_ci_checks
--
-- 保持期間を過ぎた、PRのCIの判定済みの記録(pr_ci_checks)をcleanup_dbが削除する。
-- pendingの行は削除しない。その件数をcleanup_runsに残すため、列を足す。既存の行は0にする。
BEGIN;

ALTER TABLE factory.cleanup_runs
    ADD COLUMN pr_ci_checks_deleted integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN factory.cleanup_runs.pr_ci_checks_deleted IS
    '保持期間(retention_logs_days)を過ぎた、pending以外のpr_ci_checksの行を、cleanup_dbが削除した件数。';

END;
