-- up migration: resolve_deploy_decided_notices
--
-- 反映の承認か却下を記録した決定済み通知(deploy_approval_decided)は、運用者の対応が要らない。
-- 以後は作成の時点で解決済みにするので、既に未解決で残っている行も解決済みにする。
-- resolved_byは、作成の時点で解決するscript(console_deploy_decide)と同じ値にする。
-- 他の種類の通知は変えない。
BEGIN;

SET LOCAL lock_timeout = '30s';

UPDATE factory.notices
SET resolved = true, resolved_by = 'console_deploy_decide', resolved_at = now()
WHERE kind = 'deploy_approval_decided'
  AND resolved = false;

END;
