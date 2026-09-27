-- down migration: audit
BEGIN;

DROP VIEW factory.v_audit_reports;

-- CREATE OR REPLACE cannot drop columns (origin, audit_report_id were
-- appended by the up migration): recreate v_approval_requests too.
DROP VIEW factory.v_approval_requests;
CREATE VIEW factory.v_approval_requests AS
SELECT
    ar.*,
    wi.owner, wi.repo, wi.issue_number, wi.issue_url, wi.pr_number, wi.title,
    wi.status AS work_item_status, wi.claimed_by, wi.attempt AS work_item_attempt,
    rd.attempt AS draft_attempt, rd.summary, rd.markdown, rd.diagrams, rd.open_questions,
    ip.title AS proposal_title, ip.body AS proposal_body, ip.status AS proposal_status,
    ip.created_issue_number, ip.created_issue_url, ip.is_inline
FROM factory.approval_requests ar
JOIN factory.work_items wi ON wi.id = ar.work_item_id
LEFT JOIN factory.requirement_drafts rd ON ar.kind = 'requirements' AND rd.id = ar.subject_id
LEFT JOIN factory.issue_proposals ip ON ar.kind = 'issue_proposal' AND ip.id = ar.subject_id;

-- CREATE OR REPLACE cannot drop columns: recreate v_issue_proposals.
DROP VIEW factory.v_issue_proposals;
CREATE VIEW factory.v_issue_proposals AS
SELECT
    ip.id AS issue_proposal_id, ip.work_item_id, wi.owner, wi.repo, wi.pr_number,
    wi.title AS pr_title, wi.claimed_by, ip.review_comment_id, ip.thread_id,
    ip.title, ip.body, ip.status, ip.decided_by, ip.decision_reason,
    ip.with_factory_label, ip.created_issue_number, ip.created_issue_url,
    ip.is_inline, ip.created_at, ip.decided_at
FROM factory.issue_proposals ip
JOIN factory.work_items wi ON wi.id = ip.work_item_id
ORDER BY ip.created_at DESC;

CREATE OR REPLACE VIEW factory.v_lead_time AS
SELECT
    id AS work_item_id, owner, repo, issue_number, status, created_at, updated_at,
    extract(epoch FROM (updated_at - created_at)) AS lead_time_seconds
FROM factory.work_items
WHERE status IN ('approved', 'rejected', 'needs_human', 'failed', 'expired', 'cancelled', 'reviewed', 'rereview_requested', 'blocked');

DELETE FROM factory.issue_proposals WHERE origin = 'audit';
DROP INDEX factory.issue_proposals_audit_report_position_key;
ALTER TABLE factory.issue_proposals
    DROP CONSTRAINT issue_proposals_origin_shape_check,
    DROP CONSTRAINT issue_proposals_origin_check,
    DROP COLUMN position,
    DROP COLUMN audit_report_id,
    DROP COLUMN origin,
    ALTER COLUMN review_comment_id SET NOT NULL;

DROP TABLE factory.audit_reports;
DROP INDEX factory.work_items_active_audit_key;

DELETE FROM factory.work_items WHERE kind = 'audit';
ALTER TABLE factory.work_items DROP CONSTRAINT work_items_status_check;
ALTER TABLE factory.work_items ADD CONSTRAINT work_items_status_check CHECK (
    status IN (
        'picked', 'requirements_generating', 'awaiting_approval', 'approved',
        'rejected', 'implementing', 'pr_open', 'reviewing', 'reviewed',
        'fixing', 'rereview_requested', 'blocked', 'needs_human', 'failed',
        'expired', 'cancelled'
    )
);
ALTER TABLE factory.work_items DROP CONSTRAINT work_items_source_check;
ALTER TABLE factory.work_items ADD CONSTRAINT work_items_source_check
    CHECK (source IN ('issue', 'manual'));
ALTER TABLE factory.work_items DROP CONSTRAINT work_items_kind_check;
ALTER TABLE factory.work_items ADD CONSTRAINT work_items_kind_check
    CHECK (kind IN ('issue', 'pr_review', 'pr_fix'));

END;
