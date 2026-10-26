-- down migration: console_actions
-- 操作の記録は失われる。
-- 表を書くコードを戻してから実行する。
-- コードが残っていると、記録の挿入が表の無いエラーで失敗し、操作が拒否されるため。
BEGIN;

SET LOCAL lock_timeout = '30s';

DROP TABLE factory.console_actions;

END;
