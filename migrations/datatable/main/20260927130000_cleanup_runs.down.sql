-- down migration: cleanup_runs
BEGIN;

DROP TABLE factory.cleanup_runs;

END;
