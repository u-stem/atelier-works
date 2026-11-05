-- down migration: agent_run_failure_reason
-- 列を落とす。失敗の種類は失われるが、agent_runsのほかの列と行は変えない。
BEGIN;

SET LOCAL lock_timeout = '30s';

ALTER TABLE factory.agent_runs
    DROP COLUMN failure_reason;

END;
