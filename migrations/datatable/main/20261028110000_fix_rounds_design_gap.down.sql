-- down migration: fix_rounds_design_gap
--
-- fix_rounds の outcome の制約を、design_gap を除いた一覧で足し直す。
-- design_gap のラウンドが残っていると、この ADD CONSTRAINT の検証が失敗し、トランザクションごと戻る。
-- ラウンドは修正の記録で、DELETE や UPDATE で戻せない形で失わないために、
-- ラウンドを消さずにこの文で止める役を持たせている。
-- 止まったら、運用者が design_gap のラウンドを手で扱ってから、もう一度戻す。
BEGIN;

SET LOCAL lock_timeout = '30s';
LOCK TABLE factory.fix_rounds IN ACCESS EXCLUSIVE MODE;

ALTER TABLE factory.fix_rounds DROP CONSTRAINT fix_rounds_outcome_check;
ALTER TABLE factory.fix_rounds ADD CONSTRAINT fix_rounds_outcome_check
    CHECK (outcome IN ('done', 'requirements_gap', 'blocked'));

END;
