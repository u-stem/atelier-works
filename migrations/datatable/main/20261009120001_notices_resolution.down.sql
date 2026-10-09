-- down migration: notices_resolution
-- 解決者と解決時刻の記録は失われる。
BEGIN;

ALTER TABLE factory.notices DROP COLUMN resolved_at;
ALTER TABLE factory.notices DROP COLUMN resolved_by;

END;
