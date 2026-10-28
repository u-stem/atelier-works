-- up migration: implement_rounds_design_gap
--
-- 実装のラウンドの結果に design_gap を足す。
-- 設計書がある実行の実装が、設計書の不足を報告して設計へ戻すときのラウンドが使う。
--
-- 制約の付け替えは ACCESS EXCLUSIVE のロックを取る。最初から同じ強さで取り、ロックの昇格を避ける。
-- ロックの待ちは最大30秒で、止まった書き込みがあればmigrationは失敗する(self_updateが再試行する)。
BEGIN;

SET LOCAL lock_timeout = '30s';
LOCK TABLE factory.implement_rounds IN ACCESS EXCLUSIVE MODE;

ALTER TABLE factory.implement_rounds DROP CONSTRAINT implement_rounds_outcome_check;
ALTER TABLE factory.implement_rounds ADD CONSTRAINT implement_rounds_outcome_check
    CHECK (outcome IN ('done', 'requirements_gap', 'design_gap', 'check_failed', 'checks_skipped', 'stalled', 'error'));

COMMENT ON COLUMN factory.implement_rounds.outcome IS
    'done / requirements_gap / design_gap (Claude output), check_failed / checks_skipped / stalled (verify loop), error (Claude run failed).';

END;
