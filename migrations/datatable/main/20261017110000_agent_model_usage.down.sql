-- down migration: agent_model_usage
-- ビューと列を落とす。model_usageの内訳は失われるが、agent_runsのほかの列と行は変えない。
BEGIN;

SET LOCAL lock_timeout = '30s';

DROP VIEW factory.v_agent_model_usage_daily;

ALTER TABLE factory.agent_runs
    DROP COLUMN model_usage;

END;
