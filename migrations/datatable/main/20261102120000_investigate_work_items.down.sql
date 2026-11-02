-- down migration: investigate_work_items
--
-- 戻す前に、investigate の作業項目を削除する。
-- 行が1件でもあると、種別と状態の制約を戻す文が失敗して、戻せなくなるためである。
-- 削除は調査の記録を失う。調査の答えは、Issueのコメントに残る。
-- 種別が investigate でない行に investigating と investigated の状態が残っていると、
-- 状態の制約を戻す文が失敗して、全体が戻る。コードはそのような行を書かない。
--
-- 作業項目の削除は、次の表の行を連鎖して消す(外部キーが ON DELETE CASCADE)。
--   work_item_events、requirement_drafts、approvals、agent_runs、reviews、fix_rounds、
--   issue_proposals、approval_requests、audit_reports、implement_rounds、
--   design_drafts(requirement_drafts を経由して消える)
-- 調査の作業項目が持つのは、主に work_item_events と agent_runs の行である。
-- agent_runs の行が消えるので、日次予算の集計(今日の費用の合計)から、調査に使った費用が外れる。
-- 戻した日は、予算の検査が調査に使った分だけ少なく数える。
--
-- 参照を空にする(ON DELETE SET NULL)ものは、行を残す。
--   job_failures.work_item_id と、work_items.parent_work_item_id(子の作業項目の親の参照)
--
-- 戻す順は、up の逆である。5本目の索引を落とし、4本を元の述語(investigating を除いた9状態)で作り直す。
-- 制約の付け替えとインデックスの作り直しは、どちらも ACCESS EXCLUSIVE のロックを取るので、
-- up と同じく最初から同じ強さのロックを取る。
BEGIN;

SET LOCAL lock_timeout = '30s';
LOCK TABLE factory.work_items IN ACCESS EXCLUSIVE MODE;

DELETE FROM factory.work_items WHERE kind = 'investigate';

CREATE OR REPLACE VIEW factory.v_lead_time AS
SELECT
    id AS work_item_id,
    owner,
    repo,
    issue_number,
    status,
    created_at,
    updated_at,
    extract(epoch FROM (updated_at - created_at)) AS lead_time_seconds
FROM factory.work_items
WHERE status IN ('approved', 'rejected', 'needs_human', 'failed', 'expired', 'cancelled', 'reviewed', 'rereview_requested', 'blocked', 'audited', 'pr_open');

DROP INDEX factory.work_items_active_investigate_key;

DROP INDEX factory.work_items_active_pr_review_key;
CREATE UNIQUE INDEX work_items_active_pr_review_key
    ON factory.work_items (lower(owner), lower(repo), pr_number)
    WHERE kind = 'pr_review' AND status IN (
        'picked', 'requirements_generating', 'awaiting_approval',
        'implementing', 'reviewing', 'fixing', 'auditing',
        'designing', 'awaiting_design_approval'
    );

DROP INDEX factory.work_items_active_dependabot_key;
CREATE UNIQUE INDEX work_items_active_dependabot_key
    ON factory.work_items (owner, repo, pr_number)
    WHERE kind = 'dependabot' AND status IN (
        'picked', 'requirements_generating', 'awaiting_approval',
        'implementing', 'reviewing', 'fixing', 'auditing',
        'designing', 'awaiting_design_approval'
    );

DROP INDEX factory.work_items_active_pr_fix_key;
CREATE UNIQUE INDEX work_items_active_pr_fix_key
    ON factory.work_items (owner, repo, pr_number)
    WHERE kind = 'pr_fix' AND status IN (
        'picked', 'requirements_generating', 'awaiting_approval',
        'implementing', 'reviewing', 'fixing', 'auditing',
        'designing', 'awaiting_design_approval'
    );

DROP INDEX factory.work_items_active_issue_key;
CREATE UNIQUE INDEX work_items_active_issue_key
    ON factory.work_items (owner, repo, issue_number)
    WHERE kind = 'issue' AND status IN (
        'picked', 'requirements_generating', 'awaiting_approval',
        'implementing', 'reviewing', 'fixing', 'auditing',
        'designing', 'awaiting_design_approval'
    );

ALTER TABLE factory.work_items DROP CONSTRAINT work_items_status_check;
ALTER TABLE factory.work_items ADD CONSTRAINT work_items_status_check CHECK (
    status IN (
        'picked', 'requirements_generating', 'awaiting_approval', 'approved',
        'rejected', 'implementing', 'pr_open', 'reviewing', 'reviewed',
        'fixing', 'rereview_requested', 'blocked', 'needs_human', 'failed',
        'expired', 'cancelled', 'auditing', 'audited', 'designing',
        'awaiting_design_approval'
    )
);

ALTER TABLE factory.work_items DROP CONSTRAINT work_items_kind_check;
ALTER TABLE factory.work_items ADD CONSTRAINT work_items_kind_check
    CHECK (kind IN ('issue', 'pr_review', 'pr_fix', 'audit', 'dependabot'));

END;
