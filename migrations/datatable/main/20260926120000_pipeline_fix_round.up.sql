-- up migration: pipeline_fix_round
--
-- factory_console (M8, spec §OP-0-1) Pipeline tab needs work_items.fix_round
-- (added by 20260925171034_pr_workflows.up.sql, but never surfaced on
-- v_pipeline) alongside the columns v_pipeline already exposes. Appended at
-- the end of the column list per the "view は列の末尾追加のみ" convention
-- (see that migration's own v_pipeline comment) — CREATE OR REPLACE VIEW can
-- append a column without dropping the view, since nothing is removed or
-- reordered.
BEGIN;

CREATE OR REPLACE VIEW factory.v_pipeline AS
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

END;
