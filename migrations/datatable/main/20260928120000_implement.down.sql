-- down migration: implement
BEGIN;

-- CREATE OR REPLACE cannot drop columns (branch / pr_url were appended by
-- the up migration): recreate v_pipeline at its
-- 20260926120000_pipeline_fix_round.up.sql definition. Must run before the
-- columns are dropped below (the view depends on them).
DROP VIEW factory.v_pipeline;
CREATE VIEW factory.v_pipeline AS
SELECT
    id AS work_item_id,
    cycle,
    source,
    owner,
    repo,
    issue_number,
    issue_url,
    title,
    status,
    attempt,
    claimed_by,
    flow_job_id,
    created_at,
    updated_at,
    kind,
    pr_number,
    fix_round
FROM factory.work_items
ORDER BY updated_at DESC;

CREATE OR REPLACE VIEW factory.v_lead_time AS
SELECT
    id AS work_item_id,
    owner,
    repo,
    issue_number,
    status,
    created_at,
    updated_at,
    extract(epoch FROM (updated_at - created_at)) AS lead_time_seconds
FROM factory.work_items
WHERE status IN ('approved', 'rejected', 'needs_human', 'failed', 'expired', 'cancelled', 'reviewed', 'rereview_requested', 'blocked', 'audited');

DROP TABLE factory.implement_rounds;

ALTER TABLE factory.work_items
    DROP CONSTRAINT work_items_implement_columns_issue_only;

ALTER TABLE factory.work_items
    DROP COLUMN pr_url,
    DROP COLUMN branch;

END;
