-- down migration: approval_requests
BEGIN;

DROP VIEW factory.v_approval_requests;

-- Restore v_approval_stats' original definition (factory.approvals-backed),
-- from migrations/datatable/main/20260925153414_factory_init.up.sql.
-- CREATE OR REPLACE VIEW cannot drop the up migration's trailing `kind`
-- column, so this drops and recreates the view instead (same reasoning as
-- migrations/datatable/main/20260925211232_pr_watermarks_and_inbox.up.sql's
-- v_inbox rewrite).
DROP VIEW factory.v_approval_stats;

CREATE VIEW factory.v_approval_stats AS
SELECT
    date_trunc('day', decided_at) AS day,
    decision,
    attempt,
    count(*) AS decision_count
FROM factory.approvals
GROUP BY date_trunc('day', decided_at), decision, attempt;

DROP TABLE factory.approval_requests;

END;
