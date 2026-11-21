-- down migration: resolve_deploy_decided_notices
-- 解決済みにした行を未解決に戻すと、Consoleで解決した行と区別できないので、何も変えない。
BEGIN;

SET LOCAL lock_timeout = '30s';

END;
