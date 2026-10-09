-- down migration: cleanup_info_notices
-- 解決済みにした通知の件数の記録は失われる。
BEGIN;

ALTER TABLE factory.cleanup_runs DROP COLUMN info_notices_resolved;

END;
