-- up migration: cleanup_runs
--
-- One row per f/factory/cleanup_db.ts run (schedule "cleanup_db.schedule.yaml",
-- daily 03:30 Asia/Tokyo), recording how many rows each retention sweep
-- deleted. Read by f/factory/lib/summary_support.ts's getCleanupSummary for
-- the daily Discord summary embed.
BEGIN;

CREATE TABLE factory.cleanup_runs (
    id bigserial PRIMARY KEY,
    ran_at timestamptz NOT NULL DEFAULT now(),
    work_items_deleted integer NOT NULL,
    approval_requests_deleted integer NOT NULL,
    job_failures_deleted integer NOT NULL,
    deployments_deleted integer NOT NULL,
    notices_deleted integer NOT NULL,
    doc_dirs_deleted integer NOT NULL DEFAULT 0
);

COMMENT ON TABLE factory.cleanup_runs IS
    'One row per cleanup_db.ts run: how many rows each retention sweep deleted.';
COMMENT ON COLUMN factory.cleanup_runs.work_items_deleted IS
    'Terminal-status work_items rows past config.retention_work_items_days, deleted directly.';
COMMENT ON COLUMN factory.cleanup_runs.approval_requests_deleted IS
    'approval_requests rows removed as a side effect of the work_items delete cascading (ON DELETE CASCADE) -- not deleted independently, see cleanup_db.ts.';
COMMENT ON COLUMN factory.cleanup_runs.job_failures_deleted IS
    'job_failures rows past config.retention_logs_days (occurred_at), deleted independently.';
COMMENT ON COLUMN factory.cleanup_runs.deployments_deleted IS
    'deployments rows past config.retention_logs_days (occurred_at), deleted independently.';
COMMENT ON COLUMN factory.cleanup_runs.notices_deleted IS
    'Resolved (resolved = true) notices rows past config.retention_logs_days (created_at), deleted independently.';
COMMENT ON COLUMN factory.cleanup_runs.doc_dirs_deleted IS
    'Requirement-definition directories deleted. Always 0 for now -- that sweep is added in a follow-up PR.';

END;
