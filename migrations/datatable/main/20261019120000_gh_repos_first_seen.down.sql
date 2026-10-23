-- down migration: gh_repos_first_seen
-- 最初に見た時刻の値は失われる。
-- コードを戻してから実行する。
-- コードが残っていると、一覧の置き換えが消えた列に触れて失敗するため。
BEGIN;

SET LOCAL lock_timeout = '30s';

ALTER TABLE factory.gh_repos
    DROP COLUMN first_seen_at;

END;
