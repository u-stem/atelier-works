-- down migration: job_outage_skips
-- 通信断による見送りの記録を落とす。通信断の事象(notices)と失敗(job_failures)の行は変えない。
BEGIN;

SET LOCAL lock_timeout = '30s';

DROP TABLE factory.job_outage_skips;

END;
