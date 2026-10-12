-- down migration: active_pr_fix_key
BEGIN;

DROP INDEX factory.work_items_active_pr_fix_key;

END;
