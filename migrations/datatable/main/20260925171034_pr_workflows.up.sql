-- up migration: pr_workflows
--
-- Adds PR review/fix support on top of factory_init (spec-cycle2.md §2, §7
-- item 8): work_items grows a `kind` discriminator plus PR-specific columns,
-- its status CHECK gains the PR review/fix statuses, issue-only columns
-- become nullable (a pr_review/pr_fix work item has no issue_number), two
-- new tables (reviews, fix_rounds) record review/fix outcomes, and
-- v_pipeline / v_lead_time are updated additively (CREATE OR REPLACE,
-- columns only ever appended — never reordered or removed — so any reader
-- of the old column list keeps working).
BEGIN;

ALTER TABLE factory.work_items
    ADD COLUMN kind text NOT NULL DEFAULT 'issue',
    ADD COLUMN pr_number integer,
    ADD COLUMN head_sha text,
    -- last_review_id / last_comment_id track the highest GitHub review id /
    -- review comment id already processed by poll_prs.ts / pr_fix.flow, per
    -- the self-retrigger guard in spec-cycle2.md §7 item 1 — not a foreign
    -- key to factory.reviews (that table holds the factory's own posted
    -- reviews, not every human review seen on GitHub).
    ADD COLUMN last_review_id bigint,
    ADD COLUMN last_comment_id bigint,
    ADD COLUMN fix_round integer NOT NULL DEFAULT 0,
    ADD COLUMN parent_work_item_id bigint REFERENCES factory.work_items (id) ON DELETE SET NULL,
    ALTER COLUMN issue_number DROP NOT NULL,
    ALTER COLUMN issue_url DROP NOT NULL,
    ALTER COLUMN title DROP NOT NULL,
    ALTER COLUMN body DROP NOT NULL,
    ADD CONSTRAINT work_items_kind_check CHECK (kind IN ('issue', 'pr_review', 'pr_fix'));

-- Constraint drop/add (not ALTER CONSTRAINT — Postgres has no such form for
-- CHECK) to widen the allowed status set. Treated as additive: every
-- previously-valid status stays valid, only new ones are accepted.
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
        'reviewing',
        'reviewed',
        'fixing',
        'rereview_requested',
        'blocked',
        'needs_human',
        'failed',
        'expired',
        'cancelled'
    )
);

-- reviews: one row per pr_review.flow run (spec-cycle2.md §1 db.ts row /
-- §2). posted_review_id is the GitHub review id the factory posted (text,
-- matching how other external ids such as job_failures.job_id are stored).
CREATE TABLE factory.reviews (
    id bigserial PRIMARY KEY,
    work_item_id bigint NOT NULL REFERENCES factory.work_items (id) ON DELETE CASCADE,
    head_sha text NOT NULL,
    verdict text NOT NULL,
    summary text NOT NULL,
    findings jsonb NOT NULL DEFAULT '[]'::jsonb,
    posted_review_id text,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT reviews_verdict_check CHECK (verdict IN ('approve', 'comment', 'request_changes'))
);

CREATE INDEX reviews_work_item_id_idx ON factory.reviews (work_item_id);

-- fix_rounds: one row per pr_fix.flow run.
CREATE TABLE factory.fix_rounds (
    id bigserial PRIMARY KEY,
    work_item_id bigint NOT NULL REFERENCES factory.work_items (id) ON DELETE CASCADE,
    round integer NOT NULL,
    trigger_review_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
    outcome text NOT NULL,
    replies jsonb NOT NULL DEFAULT '[]'::jsonb,
    commit_shas jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fix_rounds_outcome_check CHECK (outcome IN ('done', 'requirements_gap', 'blocked'))
);

CREATE INDEX fix_rounds_work_item_id_idx ON factory.fix_rounds (work_item_id);

-- v_reviews: every review, most recent first. Read by a future App tab.
CREATE VIEW factory.v_reviews AS
SELECT
    r.id AS review_id,
    r.work_item_id,
    wi.owner,
    wi.repo,
    wi.pr_number,
    r.head_sha,
    r.verdict,
    r.summary,
    r.findings,
    r.posted_review_id,
    r.created_at
FROM factory.reviews r
JOIN factory.work_items wi ON wi.id = r.work_item_id
ORDER BY r.created_at DESC;

-- v_fix_rounds: every fix round, most recent first. Read by a future App tab.
CREATE VIEW factory.v_fix_rounds AS
SELECT
    fr.id AS fix_round_id,
    fr.work_item_id,
    wi.owner,
    wi.repo,
    wi.pr_number,
    fr.round,
    fr.trigger_review_ids,
    fr.outcome,
    fr.replies,
    fr.commit_shas,
    fr.created_at
FROM factory.fix_rounds fr
JOIN factory.work_items wi ON wi.id = fr.work_item_id
ORDER BY fr.created_at DESC;

-- v_pipeline: kind / pr_number appended at the end of the column list, per
-- spec-cycle2.md §7 item 9 ("view は列の末尾追加のみ").
CREATE OR REPLACE VIEW factory.v_pipeline AS
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

-- v_lead_time: 'reviewed' and 'blocked' added to the terminal status set
-- (spec-cycle2.md §7 item 8). Column list is unchanged.
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
WHERE status IN ('approved', 'rejected', 'needs_human', 'failed', 'expired', 'cancelled', 'reviewed', 'blocked');

END;
