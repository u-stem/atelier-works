-- down migration: main_ci_runs
-- コミットごとのCIの判定の記録は失われる。次の観測は、初回として既存のコミットを記録し直す。
BEGIN;

DROP TABLE factory.main_ci_runs;

END;
