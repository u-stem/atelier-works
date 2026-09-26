-- down migration: v_lead_time_rereview_requested
--
-- Reverses 20260926120001_v_lead_time_rereview_requested.up.sql: restores
-- v_lead_time to its 20260925171034_pr_workflows.up.sql definition (without
-- 'rereview_requested'). Column list is unchanged, so CREATE OR REPLACE is
-- sufficient.
BEGIN;

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
WHERE status IN ('approved', 'rejected', 'needs_human', 'failed', 'expired', 'cancelled', 'reviewed', 'blocked');

END;
