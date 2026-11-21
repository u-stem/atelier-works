-- down migration: dependabot_no_required_check_notice
-- 索引だけを戻す。upで解決済みにした重複の通知は、未解決に戻さない。
BEGIN;

DROP INDEX factory.notices_unresolved_no_required_check_key;

END;
