-- down migration: daily_views_jst
--
-- 日ごとに集計する4つのビューの日の区切りを、データベースの時刻帯の設定(既定はUTC)に戻す。
-- 列は変えないので、CREATE OR REPLACE VIEWで戻す。
BEGIN;

SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE VIEW factory.v_agent_cost_daily AS
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

CREATE OR REPLACE VIEW factory.v_agent_usage_daily AS
SELECT
    date_trunc('day', created_at) AS day,
    model,
    claude_version,
    stage,
    count(*) AS run_count,
    sum(cost_usd) AS total_cost_usd,
    sum(input_tokens) AS total_input_tokens,
    sum(output_tokens) AS total_output_tokens,
    sum(cache_read_tokens) AS total_cache_read_tokens,
    sum(num_turns) AS total_turns,
    avg(duration_ms) AS avg_duration_ms
FROM factory.agent_runs
GROUP BY date_trunc('day', created_at), model, claude_version, stage;

CREATE OR REPLACE VIEW factory.v_agent_model_usage_daily AS
WITH per_model AS (
    SELECT
        r.id,
        r.created_at,
        r.stage,
        r.claude_version,
        m.model,
        m.input_tokens,
        m.output_tokens,
        m.cache_read_tokens,
        m.cache_creation_tokens,
        m.cost_usd
    FROM factory.agent_runs AS r
    CROSS JOIN LATERAL jsonb_to_recordset(r.model_usage) AS m (
        model text,
        input_tokens bigint,
        output_tokens bigint,
        cache_read_tokens bigint,
        cache_creation_tokens bigint,
        cost_usd numeric
    )
    UNION ALL
    SELECT
        id,
        created_at,
        stage,
        claude_version,
        model,
        input_tokens::bigint,
        output_tokens::bigint,
        cache_read_tokens::bigint,
        NULL::bigint,
        cost_usd
    FROM factory.agent_runs
    WHERE jsonb_array_length(model_usage) = 0
)
SELECT
    date_trunc('day', created_at) AS day,
    model,
    claude_version,
    stage,
    count(DISTINCT id) AS run_count,
    sum(cost_usd) AS total_cost_usd,
    sum(input_tokens) AS total_input_tokens,
    sum(output_tokens) AS total_output_tokens,
    sum(cache_read_tokens) AS total_cache_read_tokens,
    sum(cache_creation_tokens) AS total_cache_creation_tokens
FROM per_model
GROUP BY date_trunc('day', created_at), model, claude_version, stage;

COMMENT ON VIEW factory.v_agent_cost_daily IS NULL;
COMMENT ON VIEW factory.v_approval_stats IS NULL;
COMMENT ON VIEW factory.v_agent_usage_daily IS
    'Claudeの実行の使用量を、日、モデル、claude_version、工程ごとに集計する。claude_versionがNULLの行は、版を記録していない実行である。';
COMMENT ON VIEW factory.v_agent_model_usage_daily IS
    'Claudeの実行の使用量を、日、実際に使われたモデル、claude_version、工程ごとに集計する。内訳を持たない実行は、渡したモデルで数える。';

END;
