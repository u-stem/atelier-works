-- down migration: holds
-- 保留の履歴は失われる。
-- 表を読むコードを戻してから実行する。
-- コードが残っていると、読み取りが表の無いエラーで失敗するため。
BEGIN;

SET LOCAL lock_timeout = '30s';

DROP TABLE factory.holds;

END;
