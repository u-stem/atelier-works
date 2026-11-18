-- down migration: pr_review_trigger
-- 列と制約を落とす。きっかけの記録は失われるが、work_itemsとagent_runsのほかの列と行は変えない。
BEGIN;

SET LOCAL lock_timeout = '30s';

ALTER TABLE factory.agent_runs
    DROP CONSTRAINT agent_runs_trigger_check,
    DROP COLUMN trigger;

ALTER TABLE factory.work_items
    DROP CONSTRAINT work_items_review_trigger_check,
    DROP COLUMN review_trigger;

END;
