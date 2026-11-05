-- down migration: deploy_approvals
-- 承認の履歴は失われる。
-- 表を読むコードを戻してから実行する。
-- コードが残っていると、保護パスの変更を含む反映が、表の無いエラーで失敗し続けるため。
BEGIN;

SET LOCAL lock_timeout = '30s';

DROP TABLE factory.deploy_approvals;

END;
