-- down migration: disk_usage_notice_single
-- 索引だけを戻す。upで解決済みにした重複の通知は、未解決に戻さない。
BEGIN;

DROP INDEX factory.notices_unresolved_disk_usage_key;

END;
