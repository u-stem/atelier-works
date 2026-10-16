-- down migration: agent_usage_view
-- ビューを落とすだけで、agent_runsの行は変えない。
BEGIN;

SET LOCAL lock_timeout = '30s';

DROP VIEW factory.v_agent_usage_daily;

END;
