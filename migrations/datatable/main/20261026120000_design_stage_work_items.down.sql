-- down migration: design_stage_work_items
--
-- designing と awaiting_design_approval の作業項目は、needs_human へ移す。
-- 元の状態は work_item_events の from_status に残す。
-- 元の状態は、更新前の行を FOR UPDATE で読んだ previous から取る。
-- UPDATE ... RETURNING は更新後の値を返すので、元の状態には使えない。
-- note は固定の文で、自動の再開(AUTO_RETRY_REASON_PREFIXES)のどの接頭辞でも始めない。
-- 始めると、設計を経ていない作業項目が実装へ自動で再開されてしまう。
--
-- down は新しい順に当たる。承認依頼の種類を戻す design_stage_approval_kind の down が先に走り、
-- design の承認依頼が残っていればそこで失敗する。失敗すると、この down は走らず、作業項目も履歴も変わらない。
-- design の作業項目のジョブが動いている間に戻すと、そのフローの後の状態の書き込みが制約に当たって失敗する。
-- 戻す前にフローを止めること。
BEGIN;

SET LOCAL lock_timeout = '30s';
LOCK TABLE factory.work_items IN ACCESS EXCLUSIVE MODE;

WITH previous AS MATERIALIZED (
    SELECT id, status FROM factory.work_items
    WHERE status IN ('designing', 'awaiting_design_approval')
    FOR UPDATE
),
updated AS (
    UPDATE factory.work_items AS wi
    SET status = 'needs_human', updated_at = now()
    FROM previous
    WHERE wi.id = previous.id
    RETURNING wi.id, previous.status AS from_status
)
INSERT INTO factory.work_item_events (work_item_id, from_status, to_status, note)
SELECT id, from_status, 'needs_human', 'design stage rolled back by migration: the status no longer exists'
FROM updated;

ALTER TABLE factory.work_items DROP CONSTRAINT work_items_status_check;
ALTER TABLE factory.work_items ADD CONSTRAINT work_items_status_check CHECK (
    status IN (
        'picked', 'requirements_generating', 'awaiting_approval', 'approved',
        'rejected', 'implementing', 'pr_open', 'reviewing', 'reviewed',
        'fixing', 'rereview_requested', 'blocked', 'needs_human', 'failed',
        'expired', 'cancelled', 'auditing', 'audited'
    )
);

ALTER TABLE factory.work_items DROP COLUMN design_attempt;

DROP INDEX factory.work_items_active_issue_key;
CREATE UNIQUE INDEX work_items_active_issue_key
    ON factory.work_items (owner, repo, issue_number)
    WHERE kind = 'issue' AND status IN (
        'picked', 'requirements_generating', 'awaiting_approval',
        'implementing', 'reviewing', 'fixing', 'auditing'
    );

DROP INDEX factory.work_items_active_pr_fix_key;
CREATE UNIQUE INDEX work_items_active_pr_fix_key
    ON factory.work_items (owner, repo, pr_number)
    WHERE kind = 'pr_fix' AND status IN (
        'picked', 'requirements_generating', 'awaiting_approval',
        'implementing', 'reviewing', 'fixing', 'auditing'
    );

DROP INDEX factory.work_items_active_dependabot_key;
CREATE UNIQUE INDEX work_items_active_dependabot_key
    ON factory.work_items (owner, repo, pr_number)
    WHERE kind = 'dependabot' AND status IN (
        'picked', 'requirements_generating', 'awaiting_approval',
        'implementing', 'reviewing', 'fixing', 'auditing'
    );

END;
