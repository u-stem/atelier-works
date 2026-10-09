-- down migration: active_issue_key
-- The cancelled duplicates are not restored: the up migration only cancels
-- rows that were already duplicate active work items.
BEGIN;

DROP INDEX factory.work_items_active_issue_key;

END;
