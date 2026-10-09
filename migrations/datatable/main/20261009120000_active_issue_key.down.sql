-- down migration: active_issue_key
-- The cancelled rows are not restored: the up migration only cancels rows
-- that were duplicate active work items, or approved work items that a newer
-- cycle had already superseded.
BEGIN;

DROP INDEX factory.work_items_active_issue_key;

END;
