-- up migration: cleanup_info_notices
--
-- 保持期間を過ぎた「情報」の未解決の通知は、削除せず解決済みにする(resolved_byはcleanup_db)。
-- 解決済みの履歴に痕跡が残り、その後は通常の保持期間で消える。
-- その件数をcleanup_runsに残すため、列を足す。既存の行は0にする。
BEGIN;

ALTER TABLE factory.cleanup_runs
    ADD COLUMN info_notices_resolved integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN factory.cleanup_runs.info_notices_resolved IS
    '保持期間(retention_logs_days)を過ぎた「情報」の未解決の通知を、cleanup_dbが解決済みにした件数。削除はしない。';

END;
