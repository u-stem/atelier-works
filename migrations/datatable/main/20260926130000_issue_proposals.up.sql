-- up migration: issue_proposals
--
-- User decision (2026-09-26): pr_fix's `FixReply.decision` gains a third
-- value, `propose_issue`, for a finding that is valid but out of the PR's
-- scope. Claude drafts a candidate GitHub Issue (title + body) instead of
-- fixing or skipping it; a human approves or rejects it from the Console
-- Inbox (same framework as requirement-draft approval, factory.approvals).
-- On approval, issue_proposal_decide.ts creates the Issue (optionally with
-- factory_config.trigger_label, entering the requirements pipeline) and
-- resolves the review thread; on rejection it leaves the thread open.
--
-- review_comment_id is NOT a foreign key into any factory table — it is the
-- id of the GitHub review comment (or plain issue comment) the proposal's
-- reply is threaded under, the same id space as FixReply.review_comment_id
-- elsewhere in this schema (also not a foreign key there). thread_id is the
-- GraphQL review-thread node id, when pr_fix_finish.ts could resolve one via
-- matchReviewThreadForComment (id-based: the thread whose first or any of
-- its first 50 comments' REST id equals review_comment_id) — null for a
-- plain issue comment, or when no thread contains that id.
BEGIN;

CREATE TABLE factory.issue_proposals (
    id bigserial PRIMARY KEY,
    work_item_id bigint NOT NULL REFERENCES factory.work_items (id) ON DELETE CASCADE,
    review_comment_id bigint NOT NULL,
    thread_id text,
    title text NOT NULL,
    body text NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    decided_by text,
    decision_reason text,
    with_factory_label boolean,
    created_issue_number integer,
    created_issue_url text,
    -- Whether review_comment_id is a PR review comment (replyReviewComment)
    -- or a plain issue comment (postIssueComment) — team-lead fix round,
    -- [MUST] #4: issue_proposal_decide.ts used to guess this with a
    -- try/replyReviewComment-then-fallback-to-postIssueComment dance, since
    -- the two ids live in disjoint GitHub id spaces and neither call fails
    -- cleanly against the other's id in every case. Set by pr_fix_finish.ts
    -- from the same signal it already reads to pick a reply target itself
    -- (the original comment's `path` being non-empty).
    is_inline boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    decided_at timestamptz,
    CONSTRAINT issue_proposals_status_check CHECK (status IN ('pending', 'approved', 'rejected'))
);

-- Composite (work_item_id, status) covers listPendingIssueProposals /
-- countPendingIssueProposals's (work_item_id, status = 'pending') lookups;
-- the plain (status) index remains for the Inbox's status = 'pending' scan
-- across every work item (factory.v_issue_proposals / console_query.ts).
CREATE INDEX issue_proposals_work_item_id_status_idx ON factory.issue_proposals (work_item_id, status);
CREATE INDEX issue_proposals_status_idx ON factory.issue_proposals (status);

-- v_issue_proposals: every proposal (any status), most recent first. Read by
-- a future App tab's Inbox (backend: console_query.ts's "issue_proposals"
-- view case filters to status = 'pending' at query time, same rationale as
-- v_inbox not being time-windowed: a pending proposal must never silently
-- disappear).
CREATE VIEW factory.v_issue_proposals AS
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
    ip.decided_at
FROM factory.issue_proposals ip
JOIN factory.work_items wi ON wi.id = ip.work_item_id
ORDER BY ip.created_at DESC;

END;
