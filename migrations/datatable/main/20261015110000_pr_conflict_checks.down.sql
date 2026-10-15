-- down migration: pr_conflict_checks
-- PRの競合の記録は失われる。
BEGIN;

DROP TABLE factory.pr_conflict_checks;

END;
