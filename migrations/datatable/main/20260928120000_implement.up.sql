-- up migration: implement (工程3 実装とPR作成)
--
-- One implement flow run works on an issue-kind work_items row: it checks
-- out `work_items.branch` (`factory/issue-<N>-wi-<work_item_id>`), runs
-- headless Claude in rounds (one `implement` round, then `fix` rounds until
-- the repo's check commands pass), and opens a PR recorded in
-- `work_items.pr_url`. Every round is one implement_rounds row. Every
-- change here is additive: new table, new nullable columns, views only
-- append columns at the end / widen a status set.
BEGIN;

ALTER TABLE factory.work_items
    ADD COLUMN branch text,
    ADD COLUMN pr_url text;

COMMENT ON COLUMN factory.work_items.branch IS
    'Implement branch name (factory/issue-<N>-wi-<id>) for kind = issue once 工程3 has created it; NULL before that and for every other kind. cleanup_workspaces.ts matches worktrees by this branch.';
COMMENT ON COLUMN factory.work_items.pr_url IS
    'HTML URL of the PR 工程3 opened for kind = issue (status pr_open); NULL until then. Not pr_number: activeItemsByPr / latestPrWorkItem / listTrackedPrs group by pr_number across kinds, so an issue row must not carry one.';

CREATE TABLE factory.implement_rounds (
    id bigserial PRIMARY KEY,
    work_item_id bigint NOT NULL REFERENCES factory.work_items (id) ON DELETE CASCADE,
    attempt integer NOT NULL,
    round integer NOT NULL,
    mode text NOT NULL,
    outcome text NOT NULL,
    summary text NOT NULL DEFAULT '',
    gap_report text,
    check_output text,
    checks_skipped_reason text,
    protected_changes jsonb NOT NULL DEFAULT '[]'::jsonb,
    diff_stat jsonb,
    agent_run_id bigint REFERENCES factory.agent_runs (id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT implement_rounds_mode_check CHECK (mode IN ('implement', 'fix')),
    CONSTRAINT implement_rounds_outcome_check CHECK (
        outcome IN ('done', 'requirements_gap', 'check_failed', 'checks_skipped', 'stalled', 'error')
    ),
    -- round is assigned as COALESCE(MAX(round), 0) + 1 per work item by
    -- db.ts's insertImplementRound; this key both enforces the sequence and
    -- serves as the (work_item_id) lookup index for listImplementRounds.
    CONSTRAINT implement_rounds_work_item_round_key UNIQUE (work_item_id, round)
);

COMMENT ON TABLE factory.implement_rounds IS
    'One row per headless Claude round of the implement flow (工程3): the first implement round, then fix rounds driven by check failures.';
COMMENT ON COLUMN factory.implement_rounds.attempt IS
    'work_items.attempt at the time of the round (which approved requirements attempt was implemented).';
COMMENT ON COLUMN factory.implement_rounds.mode IS
    'implement = first round against the approved requirements; fix = a round that repairs a failed check.';
COMMENT ON COLUMN factory.implement_rounds.outcome IS
    'done / requirements_gap (Claude output), check_failed / checks_skipped / stalled (verify loop), error (Claude run failed).';
COMMENT ON COLUMN factory.implement_rounds.check_output IS
    'First 16KB of the failed/passed check command output for this round, NULL when no check ran.';
COMMENT ON COLUMN factory.implement_rounds.checks_skipped_reason IS
    'Why the repo check commands were not run this round (e.g. "protected paths changed", "no check commands configured"); NULL when they ran.';
COMMENT ON COLUMN factory.implement_rounds.protected_changes IS
    'JSON array of strings: protected paths / new shell scripts / package.json scripts changes detected in the diff (recorded, never blocking).';
COMMENT ON COLUMN factory.implement_rounds.diff_stat IS
    'JSON object {files, added, deleted} of the worktree diff after this round; NULL when the round produced no diff (e.g. outcome error).';

-- v_lead_time: 'pr_open' joins the terminal status set (工程3's success end
-- state), matching TERMINAL_WORK_ITEM_STATUSES in f/factory/lib/types.ts.
-- Column list is unchanged, so CREATE OR REPLACE is sufficient.
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
WHERE status IN ('approved', 'rejected', 'needs_human', 'failed', 'expired', 'cancelled', 'reviewed', 'rereview_requested', 'blocked', 'audited', 'pr_open');

-- v_pipeline: branch / pr_url appended at the end of the column list, per
-- the "view は列の末尾追加のみ" convention (Console's Pipeline tab).
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
    pr_number,
    fix_round,
    branch,
    pr_url
FROM factory.work_items
ORDER BY updated_at DESC;

END;
