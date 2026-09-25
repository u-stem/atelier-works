-- up migration: factory_init
BEGIN;

CREATE SCHEMA IF NOT EXISTS factory;

-- work_items: one row per (owner, repo, issue_number, cycle). Re-triggering a
-- terminal issue starts a new cycle rather than reusing the row.
CREATE TABLE factory.work_items (
    id bigserial PRIMARY KEY,
    cycle integer NOT NULL DEFAULT 1,
    source text NOT NULL,
    owner text NOT NULL,
    repo text NOT NULL,
    issue_number integer NOT NULL,
    issue_url text NOT NULL,
    title text NOT NULL,
    body text NOT NULL DEFAULT '',
    status text NOT NULL,
    attempt integer NOT NULL DEFAULT 1,
    claimed_by text,
    flow_job_id text,
    resume_url text,
    cancel_url text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT work_items_source_check CHECK (source IN ('issue', 'manual')),
    CONSTRAINT work_items_status_check CHECK (
        status IN (
            'picked',
            'requirements_generating',
            'awaiting_approval',
            'approved',
            'rejected',
            'implementing',
            'pr_open',
            'needs_human',
            'failed',
            'expired',
            'cancelled'
        )
    ),
    CONSTRAINT work_items_owner_repo_issue_cycle_key UNIQUE (owner, repo, issue_number, cycle)
);

-- work_item_events: append-only audit trail of status transitions.
CREATE TABLE factory.work_item_events (
    id bigserial PRIMARY KEY,
    work_item_id bigint NOT NULL REFERENCES factory.work_items (id) ON DELETE CASCADE,
    from_status text,
    to_status text NOT NULL,
    note text,
    occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX work_item_events_work_item_id_idx ON factory.work_item_events (work_item_id);

-- requirement_drafts: one row per (work_item, attempt) requirement-generation run.
-- diagrams / open_questions shapes documented in
-- migrations/datatable/main/requirement_drafts.diagrams.schema.json
CREATE TABLE factory.requirement_drafts (
    id bigserial PRIMARY KEY,
    work_item_id bigint NOT NULL REFERENCES factory.work_items (id) ON DELETE CASCADE,
    attempt integer NOT NULL,
    summary text NOT NULL,
    markdown text NOT NULL,
    diagrams jsonb NOT NULL DEFAULT '[]'::jsonb,
    open_questions jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX requirement_drafts_work_item_id_idx ON factory.requirement_drafts (work_item_id);

-- approvals: one row per approve/reject decision on a requirement draft attempt.
CREATE TABLE factory.approvals (
    id bigserial PRIMARY KEY,
    work_item_id bigint NOT NULL REFERENCES factory.work_items (id) ON DELETE CASCADE,
    attempt integer NOT NULL,
    decision text NOT NULL,
    reason text,
    approver text NOT NULL,
    decided_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT approvals_decision_check CHECK (decision IN ('approved', 'rejected'))
);

CREATE INDEX approvals_work_item_id_idx ON factory.approvals (work_item_id);

-- agent_runs: one row per Claude Code invocation, for cost/usage accounting.
CREATE TABLE factory.agent_runs (
    id bigserial PRIMARY KEY,
    work_item_id bigint NOT NULL REFERENCES factory.work_items (id) ON DELETE CASCADE,
    stage text NOT NULL,
    attempt integer NOT NULL,
    model text NOT NULL,
    claude_version text,
    input_tokens integer,
    output_tokens integer,
    cache_read_tokens integer,
    cost_usd numeric(10, 4),
    num_turns integer,
    duration_ms integer,
    session_id text,
    exit_code integer,
    error text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX agent_runs_work_item_id_idx ON factory.agent_runs (work_item_id);
CREATE INDEX agent_runs_created_at_idx ON factory.agent_runs (created_at);

-- job_failures: Windmill-level failures (flow/step errors), independent of
-- agent_runs which tracks Claude subprocess outcomes specifically.
CREATE TABLE factory.job_failures (
    id bigserial PRIMARY KEY,
    work_item_id bigint REFERENCES factory.work_items (id) ON DELETE SET NULL,
    flow_path text NOT NULL,
    job_id text NOT NULL,
    step text,
    error text NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX job_failures_work_item_id_idx ON factory.job_failures (work_item_id);
CREATE INDEX job_failures_occurred_at_idx ON factory.job_failures (occurred_at);

-- deployments: one row per self_update run against this repository.
CREATE TABLE factory.deployments (
    id bigserial PRIMARY KEY,
    sha_from text,
    sha_to text NOT NULL,
    changed_paths jsonb NOT NULL DEFAULT '[]'::jsonb,
    result text NOT NULL,
    needs_host_action boolean NOT NULL DEFAULT false,
    occurred_at timestamptz NOT NULL DEFAULT now()
);

-- notices: operator-facing notices (PAT expiry, SHA mismatch, needs host action).
CREATE TABLE factory.notices (
    id bigserial PRIMARY KEY,
    kind text NOT NULL,
    message text NOT NULL,
    resolved boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX notices_resolved_idx ON factory.notices (resolved);

-- v_inbox: awaiting_approval work items joined to their current attempt's
-- requirement draft. Read by the factory_console App's Inbox tab.
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

-- v_pipeline: all work items with their current status, most recently
-- updated first. Read by the App's Pipeline tab.
CREATE VIEW factory.v_pipeline AS
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
    updated_at
FROM factory.work_items
ORDER BY updated_at DESC;

-- v_agent_cost_daily: Claude usage/cost rolled up by day, stage, and model.
-- Read by the App's Analytics tab.
CREATE VIEW factory.v_agent_cost_daily AS
SELECT
    date_trunc('day', created_at) AS day,
    stage,
    model,
    count(*) AS run_count,
    sum(cost_usd) AS total_cost_usd,
    sum(input_tokens) AS total_input_tokens,
    sum(output_tokens) AS total_output_tokens,
    sum(cache_read_tokens) AS total_cache_read_tokens,
    sum(num_turns) AS total_turns,
    avg(duration_ms) AS avg_duration_ms
FROM factory.agent_runs
GROUP BY date_trunc('day', created_at), stage, model;

-- v_approval_stats: decision counts by day and attempt. attempt = 1 rows let
-- the App compute a one-shot approval rate without re-deriving it here.
CREATE VIEW factory.v_approval_stats AS
SELECT
    date_trunc('day', decided_at) AS day,
    decision,
    attempt,
    count(*) AS decision_count
FROM factory.approvals
GROUP BY date_trunc('day', decided_at), decision, attempt;

-- v_lead_time: seconds between a work item's creation and its terminal
-- status, for work items that have reached one.
CREATE VIEW factory.v_lead_time AS
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
WHERE status IN ('approved', 'rejected', 'needs_human', 'failed', 'expired', 'cancelled');

-- v_failures: job failures joined to their work item, most recent first.
-- Read by the App's Failures tab (retry_work_item.ts).
CREATE VIEW factory.v_failures AS
SELECT
    jf.id AS job_failure_id,
    jf.work_item_id,
    wi.owner,
    wi.repo,
    wi.issue_number,
    jf.flow_path,
    jf.job_id,
    jf.step,
    jf.error,
    jf.occurred_at
FROM factory.job_failures jf
LEFT JOIN factory.work_items wi ON wi.id = jf.work_item_id
ORDER BY jf.occurred_at DESC;

-- v_notices: unresolved notices, most recent first. Read by the App's
-- Notices tab.
CREATE VIEW factory.v_notices AS
SELECT
    id AS notice_id,
    kind,
    message,
    resolved,
    created_at
FROM factory.notices
WHERE resolved = false
ORDER BY created_at DESC;

END;
