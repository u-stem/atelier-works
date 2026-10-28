-- down migration: implement_rounds_design_gap
--
-- implement_rounds の outcome の制約を、design_gap を除いた一覧で足し直す。
-- design_gap のラウンドが残っていると、この ADD CONSTRAINT の検証が失敗し、トランザクションごと戻る。
-- ラウンドは実装の記録で、DELETE や UPDATE で戻せない形で失わないために、
-- ラウンドを消さずにこの文で止める役を持たせている。
-- 止まったら、運用者が design_gap のラウンドを手で扱ってから、もう一度戻す。
BEGIN;

SET LOCAL lock_timeout = '30s';
LOCK TABLE factory.implement_rounds IN ACCESS EXCLUSIVE MODE;

ALTER TABLE factory.implement_rounds DROP CONSTRAINT implement_rounds_outcome_check;
ALTER TABLE factory.implement_rounds ADD CONSTRAINT implement_rounds_outcome_check
    CHECK (outcome IN ('done', 'requirements_gap', 'check_failed', 'checks_skipped', 'stalled', 'error'));

COMMENT ON COLUMN factory.implement_rounds.outcome IS
    'done / requirements_gap (Claude output), check_failed / checks_skipped / stalled (verify loop), error (Claude run failed).';

END;
