-- down migration: active_pr_review_key
-- 上のmigrationが cancelled にした重複の行は、元に戻さない。
BEGIN;

SET LOCAL lock_timeout = '30s';

DROP INDEX factory.work_items_active_pr_review_key;

END;
