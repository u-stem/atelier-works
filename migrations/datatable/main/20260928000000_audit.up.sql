-- up migration: audit (工程5 自己改善)
--
-- One audit run is a work_items row (kind 'audit', owner/repo = factory_repo,
-- issue_number NULL). Its report lives in audit_reports; its proposals reuse
-- issue_proposals (origin 'audit') and the existing 'issue_proposal'
-- approval kind. Every change here is additive: CHECKs only widen, views
-- only append columns at the end.
BEGIN;

ALTER TABLE factory.work_items DROP CONSTRAINT work_items_kind_check;
ALTER TABLE factory.work_items ADD CONSTRAINT work_items_kind_check
    CHECK (kind IN ('issue', 'pr_review', 'pr_fix', 'audit'));

ALTER TABLE factory.work_items DROP CONSTRAINT work_items_source_check;
ALTER TABLE factory.work_items ADD CONSTRAINT work_items_source_check
    CHECK (source IN ('issue', 'manual', 'schedule'));

ALTER TABLE factory.work_items DROP CONSTRAINT work_items_status_check;
ALTER TABLE factory.work_items ADD CONSTRAINT work_items_status_check CHECK (
    status IN (
        'picked', 'requirements_generating', 'awaiting_approval', 'approved',
        'rejected', 'implementing', 'pr_open', 'reviewing', 'reviewed',
        'fixing', 'rereview_requested', 'blocked', 'needs_human', 'failed',
        'expired', 'cancelled', 'auditing', 'audited'
    )
);

-- At most one audit may be picked/auditing at a time. audit_kickoff.ts
-- inserts with ON CONFLICT (kind) WHERE ... DO NOTHING against this index,
-- so a concurrent schedule + Console kickoff cannot start two audits.
CREATE UNIQUE INDEX work_items_active_audit_key
    ON factory.work_items (kind)
    WHERE kind = 'audit' AND status IN ('picked', 'auditing');

CREATE TABLE factory.audit_reports (
    id bigserial PRIMARY KEY,
    work_item_id bigint NOT NULL UNIQUE REFERENCES factory.work_items (id) ON DELETE CASCADE,
    period_start timestamptz NOT NULL,
    period_end timestamptz NOT NULL,
    summary text NOT NULL,
    markdown text NOT NULL,
    metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT audit_reports_period_check CHECK (period_start < period_end)
);

ALTER TABLE factory.issue_proposals
    ADD COLUMN origin text NOT NULL DEFAULT 'pr_fix',
    ADD COLUMN audit_report_id bigint REFERENCES factory.audit_reports (id) ON DELETE CASCADE,
    ADD COLUMN position integer,
    ALTER COLUMN review_comment_id DROP NOT NULL,
    ADD CONSTRAINT issue_proposals_origin_check CHECK (origin IN ('pr_fix', 'audit')),
    ADD CONSTRAINT issue_proposals_origin_shape_check CHECK (
        (origin = 'pr_fix' AND review_comment_id IS NOT NULL)
        OR (origin = 'audit' AND audit_report_id IS NOT NULL AND position IS NOT NULL)
    );

CREATE UNIQUE INDEX issue_proposals_audit_report_position_key
    ON factory.issue_proposals (audit_report_id, position);

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

CREATE OR REPLACE VIEW factory.v_issue_proposals AS
SELECT
    ip.id AS issue_proposal_id,
    ip.work_item_id,
    wi.owner,
    wi.repo,
    wi.pr_number,
    wi.title AS pr_title,
    wi.claimed_by,
    ip.review_comment_id,
    ip.thread_id,
    ip.title,
    ip.body,
    ip.status,
    ip.decided_by,
    ip.decision_reason,
    ip.with_factory_label,
    ip.created_issue_number,
    ip.created_issue_url,
    ip.is_inline,
    ip.created_at,
    ip.decided_at,
    ip.origin,
    ip.audit_report_id
FROM factory.issue_proposals ip
JOIN factory.work_items wi ON wi.id = ip.work_item_id
ORDER BY ip.created_at DESC;

CREATE OR REPLACE VIEW factory.v_approval_requests AS
SELECT
    ar.*,
    wi.owner,
    wi.repo,
    wi.issue_number,
    wi.issue_url,
    wi.pr_number,
    wi.title,
    wi.status AS work_item_status,
    wi.claimed_by,
    wi.attempt AS work_item_attempt,
    rd.attempt AS draft_attempt,
    rd.summary,
    rd.markdown,
    rd.diagrams,
    rd.open_questions,
    ip.title AS proposal_title,
    ip.body AS proposal_body,
    ip.status AS proposal_status,
    ip.created_issue_number,
    ip.created_issue_url,
    ip.is_inline,
    ip.origin,
    ip.audit_report_id
FROM factory.approval_requests ar
JOIN factory.work_items wi ON wi.id = ar.work_item_id
LEFT JOIN factory.requirement_drafts rd ON ar.kind = 'requirements' AND rd.id = ar.subject_id
LEFT JOIN factory.issue_proposals ip ON ar.kind = 'issue_proposal' AND ip.id = ar.subject_id;

CREATE VIEW factory.v_audit_reports AS
SELECT
    ar.id AS audit_report_id,
    ar.work_item_id,
    wi.status AS work_item_status,
    wi.title,
    wi.source,
    ar.period_start,
    ar.period_end,
    ar.summary,
    ar.metrics,
    ar.created_at,
    count(ip.id) FILTER (WHERE ip.status = 'pending') AS pending_count,
    count(ip.id) FILTER (WHERE ip.status = 'approved') AS approved_count,
    count(ip.id) FILTER (WHERE ip.status = 'rejected') AS rejected_count
FROM factory.audit_reports ar
JOIN factory.work_items wi ON wi.id = ar.work_item_id
LEFT JOIN factory.issue_proposals ip ON ip.audit_report_id = ar.id
GROUP BY ar.id, wi.id;

END;
