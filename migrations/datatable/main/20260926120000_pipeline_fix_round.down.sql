-- down migration: pipeline_fix_round
--
-- Reverses 20260926120000_pipeline_fix_round.up.sql. Restores v_pipeline to
-- its 20260925171034_pr_workflows.up.sql definition (kind / pr_number, no
-- fix_round). Dropped and recreated (not CREATE OR REPLACE): Postgres allows
-- CREATE OR REPLACE VIEW to append a column but never to remove one, and
-- this direction removes fix_round.
BEGIN;

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
    pr_number
FROM factory.work_items
ORDER BY updated_at DESC;

END;
