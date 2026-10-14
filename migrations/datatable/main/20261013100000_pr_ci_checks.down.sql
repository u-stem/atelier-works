-- down migration: pr_ci_checks
-- PRのheadごとのCIの判定の記録は失われる。
BEGIN;

DROP TABLE factory.pr_ci_checks;

END;
