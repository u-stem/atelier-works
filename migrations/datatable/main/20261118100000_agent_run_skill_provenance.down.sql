-- down migration: agent_run_skill_provenance
-- 列を落とす。スキルの版の記録は失われるが、agent_runsのほかの列と行は変えない。
BEGIN;

SET LOCAL lock_timeout = '30s';

ALTER TABLE factory.agent_runs
    DROP COLUMN skills,
    DROP COLUMN skill_clone_sha;

END;
