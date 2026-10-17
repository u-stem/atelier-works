-- down migration: gh_collect
-- 収集したリポジトリの状態と実行の記録は失われる。
BEGIN;

DROP TABLE factory.gh_repos;
DROP TABLE factory.gh_collect_runs;

END;
