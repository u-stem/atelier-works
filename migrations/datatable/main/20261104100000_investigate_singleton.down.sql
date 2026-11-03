-- down migration: investigate_singleton
--
-- 全体で1件にする索引を落とす。行は書き換えない。
-- 戻した後は、稼働中の調査を複数入れられる。
BEGIN;

SET LOCAL lock_timeout = '30s';

DROP INDEX factory.work_items_active_investigate_singleton;

END;
