-- up migration: cleanup_pr_ci_checks
--
-- 保持期間を過ぎた、PRのCIの記録(pr_ci_checks)をcleanup_dbが削除する。
-- pendingの行は削除しない。pending以外のうち、各PRの最新の行は保持期間の4倍まで残し、
-- 最新でない行は保持期間を過ぎたら削除する。
-- その件数をcleanup_runsに残すため、列を足す。既存の行は0にする。
BEGIN;

ALTER TABLE factory.cleanup_runs
    ADD COLUMN pr_ci_checks_deleted integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN factory.cleanup_runs.pr_ci_checks_deleted IS
    '保持期間(retention_logs_days)を過ぎた、最新でないpending以外のpr_ci_checksの行と、保持期間の4倍を過ぎた各PRの最新の行を、cleanup_dbが削除した件数。';

END;
