-- up migration: approval_requests
--
-- Stage 1 of generalizing approval waiting away from pipeline.flow's
-- suspend step: adds factory.approval_requests as a schema-only,
-- kind-polymorphic replacement for both factory.approvals (kind
-- "requirements") and factory.issue_proposals' pending/approved/rejected
-- status column (kind "issue_proposal"). This migration only adds the
-- table/views and backfills history from the two existing sources — no
-- script switches its writes over yet (a follow-up PR does that once db.ts's
-- accessors have callers). factory.approvals is kept as-is (its own
-- factory.v_approval_stats-feeding role is superseded here, but the table
-- itself is not touched — see the down migration's restoration of the
-- original view). factory.issue_proposals is also left untouched: it
-- remains the source of truth for title/body/review_comment_id/thread_id,
-- which approval_requests does not duplicate.
BEGIN;

CREATE TABLE factory.approval_requests (
    id bigserial PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN ('requirements', 'issue_proposal')),
    work_item_id bigint NOT NULL REFERENCES factory.work_items (id) ON DELETE CASCADE,
    subject_id bigint NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    decision_options jsonb NOT NULL DEFAULT '{}'::jsonb,
    requested_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz,
    decided_at timestamptz,
    decided_by text,
    reason text,
    CONSTRAINT approval_requests_kind_subject_key UNIQUE (kind, subject_id)
);

COMMENT ON COLUMN factory.approval_requests.kind IS
    'what this request is waiting a decision on: "requirements" (subject_id -> requirement_drafts.id) or "issue_proposal" (subject_id -> issue_proposals.id).';
COMMENT ON COLUMN factory.approval_requests.subject_id IS
    'requirement_drafts.id when kind = requirements, issue_proposals.id when kind = issue_proposal. Not a foreign key: which table it points into depends on kind.';
COMMENT ON COLUMN factory.approval_requests.payload IS
    'requester-side metadata, e.g. {"attempt": n} for kind = requirements.';
COMMENT ON COLUMN factory.approval_requests.decision_options IS
    'decider-side options, e.g. {"with_factory_label": bool} for kind = issue_proposal, filled in once decided.';
COMMENT ON COLUMN factory.approval_requests.expires_at IS
    'deadline after which a still-pending request should be swept to expired. NULL means no deadline (e.g. issue_proposal).';

CREATE INDEX approval_requests_status_idx ON factory.approval_requests (status);
CREATE INDEX approval_requests_work_item_id_idx ON factory.approval_requests (work_item_id);
-- Partial index for the pending-deadline sweep (listExpiredPendingApprovalRequests:
-- status = 'pending' AND expires_at <= now()).
CREATE INDEX approval_requests_pending_expires_idx ON factory.approval_requests (expires_at) WHERE status = 'pending';

-- Backfill (a): factory.approvals x factory.requirement_drafts, joined on
-- (work_item_id, attempt). DISTINCT ON (rd.id) with ORDER BY ..., decided_at
-- DESC keeps only the most recent approvals row when more than one exists
-- for the same (work_item_id, attempt) pair (a re-decision).
INSERT INTO factory.approval_requests (
    kind, work_item_id, subject_id, status, payload, requested_at, decided_at, decided_by, reason
)
SELECT DISTINCT ON (rd.id)
    'requirements',
    rd.work_item_id,
    rd.id,
    a.decision,
    jsonb_build_object('attempt', rd.attempt),
    rd.created_at,
    a.decided_at,
    a.approver,
    a.reason
FROM factory.requirement_drafts rd
JOIN factory.approvals a ON a.work_item_id = rd.work_item_id AND a.attempt = rd.attempt
ORDER BY rd.id, a.decided_at DESC
ON CONFLICT (kind, subject_id) DO NOTHING;

-- Backfill (b): every factory.issue_proposals row, any status. payload is
-- left at its '{}'::jsonb default (issue_proposals carries no attempt).
INSERT INTO factory.approval_requests (
    kind, work_item_id, subject_id, status, decision_options, requested_at, decided_at, decided_by, reason
)
SELECT
    'issue_proposal',
    ip.work_item_id,
    ip.id,
    ip.status,
    CASE
        WHEN ip.status = 'approved'
            THEN jsonb_build_object('with_factory_label', coalesce(ip.with_factory_label, false))
        ELSE '{}'::jsonb
    END,
    ip.created_at,
    ip.decided_at,
    ip.decided_by,
    ip.decision_reason
FROM factory.issue_proposals ip
ON CONFLICT (kind, subject_id) DO NOTHING;

-- Backfill (c): work items currently awaiting a human decision get a
-- pending approval_requests row for their current (highest-attempt)
-- requirement draft, with a 7-day deadline from when they were last
-- updated — mirroring pipeline.flow's suspend timeout. Runs after (a) so it
-- only ever inserts a new subject_id (an awaiting_approval work item has no
-- decided factory.approvals row yet for its current attempt).
INSERT INTO factory.approval_requests (
    kind, work_item_id, subject_id, status, payload, requested_at, expires_at
)
SELECT
    'requirements',
    wi.id,
    rd.id,
    'pending',
    jsonb_build_object('attempt', rd.attempt),
    wi.updated_at,
    wi.updated_at + interval '7 days'
FROM factory.work_items wi
JOIN LATERAL (
    SELECT *
    FROM factory.requirement_drafts rd
    WHERE rd.work_item_id = wi.id
    ORDER BY rd.attempt DESC
    LIMIT 1
) rd ON true
WHERE wi.status = 'awaiting_approval'
ON CONFLICT (kind, subject_id) DO NOTHING;

-- v_approval_requests: every approval request joined to its work item and
-- (depending on kind) its requirement draft or issue proposal. No status
-- filter — a future Console Inbox tab filters at query time, same rationale
-- as v_inbox / v_issue_proposals.
CREATE VIEW factory.v_approval_requests AS
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
    ip.is_inline
FROM factory.approval_requests ar
JOIN factory.work_items wi ON wi.id = ar.work_item_id
LEFT JOIN factory.requirement_drafts rd ON ar.kind = 'requirements' AND rd.id = ar.subject_id
LEFT JOIN factory.issue_proposals ip ON ar.kind = 'issue_proposal' AND ip.id = ar.subject_id;

-- v_approval_stats: now reads factory.approval_requests instead of
-- factory.approvals. The first 4 columns keep their original name and type
-- (day timestamptz, decision text, attempt integer, decision_count bigint)
-- so an existing Analytics-tab consumer keeps working; kind is appended
-- (CREATE OR REPLACE VIEW can only add columns at the end, never reorder or
-- drop them).
CREATE OR REPLACE VIEW factory.v_approval_stats AS
SELECT
    date_trunc('day', decided_at) AS day,
    status AS decision,
    coalesce((payload ->> 'attempt')::integer, 1) AS attempt,
    count(*) AS decision_count,
    kind
FROM factory.approval_requests
WHERE status IN ('approved', 'rejected')
GROUP BY date_trunc('day', decided_at), status, coalesce((payload ->> 'attempt')::integer, 1), kind;

END;
