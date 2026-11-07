-- down migration: work_items_pr_closed_at
-- 索引と列を落とす。印の値は失われ、マージ済みのPRは次の回から今までどおり巡回される。
BEGIN;

SET LOCAL lock_timeout = '30s';

DROP INDEX factory.work_items_pr_lookup_idx;

ALTER TABLE factory.work_items
    DROP COLUMN pr_closed_at;

END;
