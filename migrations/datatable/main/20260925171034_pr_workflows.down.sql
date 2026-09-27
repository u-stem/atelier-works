-- down migration: pr_workflows
--
-- Reverses 20260925171034_pr_workflows.up.sql. Restoring NOT NULL on
-- issue_number / issue_url / title / body requires no PR-kind row (which
-- has those columns NULL) to exist — true on a fresh/scratch database
-- (test-db.sh's use case) but not guaranteed once real pr_review/pr_fix
-- rows have been written; this is a schema-level rollback, not a
-- guaranteed-lossless one.
BEGIN;

-- Restore v_pipeline / v_lead_time to their factory_init definitions.
-- v_pipeline must be dropped and recreated (not CREATE OR REPLACE): Postgres
-- allows CREATE OR REPLACE VIEW to append columns but never to remove them,
-- and this direction removes the kind / pr_number columns the up migration
-- appended.
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
    updated_at
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
WHERE status IN ('approved', 'rejected', 'needs_human', 'failed', 'expired', 'cancelled');

DROP VIEW factory.v_fix_rounds;
DROP VIEW factory.v_reviews;

DROP TABLE factory.fix_rounds;
DROP TABLE factory.reviews;

ALTER TABLE factory.work_items DROP CONSTRAINT work_items_status_check;

ALTER TABLE factory.work_items ADD CONSTRAINT work_items_status_check CHECK (
    status IN (
        'picked',
        'requirements_generating',
        'awaiting_approval',
        'approved',
        'rejected',
        'implementing',
        'pr_open',
        'needs_human',
        'failed',
        'expired',
        'cancelled'
    )
);

ALTER TABLE factory.work_items
    DROP CONSTRAINT work_items_kind_check,
    ALTER COLUMN issue_number SET NOT NULL,
    ALTER COLUMN issue_url SET NOT NULL,
    ALTER COLUMN title SET NOT NULL,
    ALTER COLUMN body SET NOT NULL,
    DROP COLUMN parent_work_item_id,
    DROP COLUMN fix_round,
    DROP COLUMN last_comment_id,
    DROP COLUMN last_review_id,
    DROP COLUMN head_sha,
    DROP COLUMN pr_number,
    DROP COLUMN kind;

END;
