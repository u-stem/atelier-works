-- up migration: agent_usage_view
--
-- Claudeのバージョンとモデル別の使用量を、日と工程ごとに集計するビューを足す。
-- バージョンを上げた前後で、モデルごとの費用とトークン数を比べるためである。
-- claude_versionは、記録の無い行をNULLのまま別のグループにする。
-- 'unknown'のような文字列に寄せると、実在する値と区別できず、
-- 記録が無いことを集計の利用者から隠すため。
-- 既存のv_agent_cost_dailyは変えない。
BEGIN;

SET LOCAL lock_timeout = '30s';

CREATE VIEW factory.v_agent_usage_daily AS
SELECT
    date_trunc('day', created_at) AS day,
    model,
    claude_version,
    stage,
    count(*) AS run_count,
    sum(cost_usd) AS total_cost_usd,
    sum(input_tokens) AS total_input_tokens,
    sum(output_tokens) AS total_output_tokens,
    sum(cache_read_tokens) AS total_cache_read_tokens
FROM factory.agent_runs
GROUP BY date_trunc('day', created_at), model, claude_version, stage;

COMMENT ON VIEW factory.v_agent_usage_daily IS
    'Claudeの実行の使用量を、日、モデル、claude_version、工程ごとに集計する。claude_versionがNULLの行は、版を記録していない実行である。';

END;
