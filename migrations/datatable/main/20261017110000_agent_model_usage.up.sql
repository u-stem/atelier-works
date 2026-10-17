-- up migration: agent_model_usage
--
-- Claudeの実行ごとに、実際に使われたモデルごとの内訳(`claude -p`の結果の`modelUsage`)を保存する。
-- `agent_runs.model`は`claude --model`に渡した値で、実行の途中で別のモデルが使われても変わらない。
-- 内訳は、要素が{model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd}の
-- jsonbの配列として、`model_usage`に入れる。内訳を持たない実行(Claudeが結果を返さなかった実行と、
-- この列を足す前の実行)は、空の配列である。
-- あわせて、実際に使われたモデルで数えるビューを足す。既存のv_agent_usage_dailyは、渡した値で数えるので変えない。
BEGIN;

SET LOCAL lock_timeout = '30s';

ALTER TABLE factory.agent_runs
    ADD COLUMN model_usage jsonb NOT NULL DEFAULT '[]'::jsonb
        CHECK (jsonb_typeof(model_usage) = 'array');

COMMENT ON COLUMN factory.agent_runs.model_usage IS
    '実際に使われたモデルごとの使用量の配列。要素は{model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd}。内訳を持たない実行は空の配列である。';

-- 内訳を持つ実行は、内訳の要素ごとに1行にする。持たない実行は、渡したモデルと実行全体の値で1行にする。
-- run_countは、そのモデルを使った実行の数である。1回の実行が複数のモデルを使うと、それぞれに1回ずつ数える。
-- 内訳を持たない実行のcache_creation_tokensは、記録が無いのでNULLのままにする。
CREATE VIEW factory.v_agent_model_usage_daily AS
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

COMMENT ON VIEW factory.v_agent_model_usage_daily IS
    'Claudeの実行の使用量を、日、実際に使われたモデル、claude_version、工程ごとに集計する。内訳を持たない実行は、渡したモデルで数える。';

END;
