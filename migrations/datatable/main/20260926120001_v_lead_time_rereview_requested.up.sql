-- up migration: v_lead_time_rereview_requested
--
-- Adds 'rereview_requested' (pr_fix's success end state) to v_lead_time's
-- terminal status set, matching TERMINAL_WORK_ITEM_STATUSES in
-- f/factory/lib/types.ts and docs/architecture.md. Column list is unchanged,
-- so CREATE OR REPLACE is sufficient.
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
WHERE status IN ('approved', 'rejected', 'needs_human', 'failed', 'expired', 'cancelled', 'reviewed', 'rereview_requested', 'blocked');

END;
