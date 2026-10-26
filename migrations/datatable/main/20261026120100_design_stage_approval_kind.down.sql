-- down migration: design_stage_approval_kind
--
-- approval_requests の kind の制約を、design を除いた一覧で足し直す。
-- design の承認依頼が残っていると、この ADD CONSTRAINT の検証が失敗し、トランザクションごと戻る。
-- 決定済みの依頼は承認の記録(decided_by、reason)で、DELETE で戻せない形で失わないために、
-- 依頼を消さずにこの文で止める役を持たせている。
-- down は新しい順に当たるので、この down が design_stage_work_items の down より先に走る。
-- ここで失敗すれば、作業項目側の down は走らず、作業項目も履歴も変わらない。
-- 止まったら、運用者が design の依頼を手で扱ってから、もう一度戻す。
BEGIN;

SET LOCAL lock_timeout = '30s';
LOCK TABLE factory.approval_requests IN ACCESS EXCLUSIVE MODE;

ALTER TABLE factory.approval_requests DROP CONSTRAINT approval_requests_kind_check;
ALTER TABLE factory.approval_requests ADD CONSTRAINT approval_requests_kind_check
    CHECK (kind IN ('requirements', 'issue_proposal'));

END;
