-- down migration: gh_collect_detail
-- 収集した詳細(PRとIssueの行)と、足した列の値は失われる。
-- コードを戻してから実行する。
-- コードが残っていると、一覧の置き換えが新しい表と列に触れて失敗するため。
BEGIN;

SET LOCAL lock_timeout = '30s';

DROP TABLE factory.gh_pull_requests;
DROP TABLE factory.gh_issues;

ALTER TABLE factory.gh_repos
    DROP COLUMN last_collected_at,
    DROP COLUMN last_attempted_at,
    DROP COLUMN truncated,
    DROP COLUMN detail_failed;

ALTER TABLE factory.gh_collect_runs
    DROP COLUMN stage,
    DROP COLUMN detail_targets,
    DROP COLUMN detail_requests,
    DROP COLUMN detail_done,
    DROP COLUMN detail_incomplete;

END;
