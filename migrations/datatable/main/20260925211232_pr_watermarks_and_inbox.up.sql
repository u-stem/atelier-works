-- up migration: pr_watermarks_and_inbox
--
-- Part 1 - PR review/comment watermark columns (M6 security review).
--
-- pr_review.flow / pr_fix.flow need to tell "what poll_prs observed when it
-- claimed this work item" apart from "what pr_fix_finish has actually
-- processed", so the two get separate columns instead of overloading one:
--   - observed_* : the highest id poll_prs saw at claim time (a snapshot).
--   - last_*     : the highest id pr_fix_finish has replied to / processed
--                  (bumped only by finish, once work on it is done).
-- Inline PR review comments live in a different GitHub id space from issue
-- comments, so they also get their own column pair rather than sharing one
-- with the existing (now issue-comment-only) last_comment_id /
-- observed_comment_id.
BEGIN;

ALTER TABLE factory.work_items
    ADD COLUMN last_review_comment_id bigint,
    ADD COLUMN observed_review_id bigint,
    ADD COLUMN observed_comment_id bigint,
    ADD COLUMN observed_review_comment_id bigint;

COMMENT ON COLUMN factory.work_items.last_review_comment_id IS
    'processed watermark: highest inline PR review comment id pr_fix_finish has replied to. Separate id space from issue comments (see last_comment_id).';
COMMENT ON COLUMN factory.work_items.observed_review_id IS
    'poll-observed watermark: highest PR review id poll_prs saw when it claimed this work item.';
COMMENT ON COLUMN factory.work_items.observed_comment_id IS
    'poll-observed watermark: highest issue comment id poll_prs saw when it claimed this work item.';
COMMENT ON COLUMN factory.work_items.observed_review_comment_id IS
    'poll-observed watermark: highest inline PR review comment id poll_prs saw when it claimed this work item.';

-- Part 2 - factory.v_inbox no longer exposes resume_url / cancel_url
-- (M6 security review).
--
-- These are the signed getResumeUrls() capability URLs. Anyone who could
-- read this view (or the factory_console App's Inbox tab backed by it)
-- could resume or cancel the suspended pipeline flow directly, bypassing
-- approval_decide.ts entirely - so no factory.approvals row gets recorded
-- for that decision. approval_decide.ts itself reads factory.work_items
-- directly (not this view), so it is unaffected by removing these two
-- columns.
--
-- CREATE OR REPLACE VIEW cannot drop columns, so this drops and recreates
-- the view instead. The down migration restores the original definition
-- from migrations/datatable/main/20260925153414_factory_init.up.sql:149-170
-- (unchanged by 20260925171034_pr_workflows.up.sql, which does not touch
-- v_inbox).
DROP VIEW factory.v_inbox;

CREATE VIEW factory.v_inbox AS
SELECT
    wi.id AS work_item_id,
    wi.owner,
    wi.repo,
    wi.issue_number,
    wi.issue_url,
    wi.title,
    wi.attempt,
    wi.claimed_by,
    rd.id AS requirement_draft_id,
    rd.summary,
    rd.markdown,
    rd.diagrams,
    rd.open_questions,
    wi.created_at,
    wi.updated_at
FROM factory.work_items wi
JOIN LATERAL (
    SELECT *
    FROM factory.requirement_drafts rd
    WHERE rd.work_item_id = wi.id
      AND rd.attempt = wi.attempt
    ORDER BY rd.created_at DESC
    LIMIT 1
) rd ON true
WHERE wi.status = 'awaiting_approval';

END;
