-- down migration: pr_watermarks_and_inbox
BEGIN;

-- Part 2 - restore factory.v_inbox to its original definition
-- (20260925153414_factory_init.up.sql:149-170), including resume_url /
-- cancel_url.
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
    wi.resume_url,
    wi.cancel_url,
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

-- Part 1 - drop the PR review/comment watermark columns.
ALTER TABLE factory.work_items
    DROP COLUMN last_review_comment_id,
    DROP COLUMN observed_review_id,
    DROP COLUMN observed_comment_id,
    DROP COLUMN observed_review_comment_id;

END;
