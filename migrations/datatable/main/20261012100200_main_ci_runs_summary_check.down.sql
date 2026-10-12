-- down migration: main_ci_runs_summary_check
BEGIN;

ALTER TABLE factory.main_ci_runs DROP CONSTRAINT main_ci_runs_summary_length_check;

END;
