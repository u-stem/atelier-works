-- down migration: active_pr_fix_key
BEGIN;

SET LOCAL lock_timeout = '30s';

DROP INDEX factory.work_items_active_pr_fix_key;

END;
