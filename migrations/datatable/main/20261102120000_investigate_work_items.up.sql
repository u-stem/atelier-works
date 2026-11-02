-- up migration: investigate_work_items
--
-- 調査(investigate)の作業項目の土台として、種別と状態を足す。
-- 調査は、実装せずに調べて、結果をIssueのコメントで返す作業項目である。
-- これらの行を書く処理はまだ無い。値は使われるまで、どの行にも現れない。
--
--   kind    investigate。対象のIssueの番号を issue_number に持ち、pr_number は持たない。
--   status  investigating(調査している。終端でない)と investigated(調査を終えた。終端)。
--
-- 稼働中の一意インデックスの述語は、f/factory/lib/types.ts の TERMINAL_WORK_ITEM_STATUSES に
-- 入らない状態のすべてである。investigating は終端でないので、既存の4本を作り直して述語に足す。
-- 5本目の work_items_active_investigate_key は、同じIssueの終端でない investigate を1件までにする。
-- ownerとrepoは小文字にして比べる。pr_review の索引と同じく、綴りが違うだけの同じIssueを、
-- 別のIssueとして数えないためである。
-- tests/scripts/active_*_migration.test.ts と investigate_work_items_migration.test.ts が、
-- 述語と状態の定義が食い違っていないことを確かめる。
-- 終端の状態を変えるときは、5本のインデックスを作り直す新しいmigrationが要る。
--
-- v_lead_time の終端の一覧にも investigated を足す。列は変えないので、CREATE OR REPLACE で足りる。
--
-- 制約の付け替えとインデックスの作り直しは、どちらも ACCESS EXCLUSIVE のロックを取る。
-- 取るロックを最初から同じ強さにして、ロックの昇格を避ける。
-- ロックの待ちは最大30秒で、止まった書き込みがあればmigrationは失敗する(self_updateが再試行する)。
--
-- このmigrationは行を書き換えない。investigate の行も investigating の行も無いので、
-- インデックスの作り直しは重複で失敗しない。
BEGIN;

SET LOCAL lock_timeout = '30s';
LOCK TABLE factory.work_items IN ACCESS EXCLUSIVE MODE;

ALTER TABLE factory.work_items DROP CONSTRAINT work_items_kind_check;
ALTER TABLE factory.work_items ADD CONSTRAINT work_items_kind_check
    CHECK (kind IN ('issue', 'pr_review', 'pr_fix', 'audit', 'dependabot', 'investigate'));

ALTER TABLE factory.work_items DROP CONSTRAINT work_items_status_check;
ALTER TABLE factory.work_items ADD CONSTRAINT work_items_status_check CHECK (
    status IN (
        'picked', 'requirements_generating', 'awaiting_approval', 'approved',
        'rejected', 'implementing', 'pr_open', 'reviewing', 'reviewed',
        'fixing', 'rereview_requested', 'blocked', 'needs_human', 'failed',
        'expired', 'cancelled', 'auditing', 'audited', 'designing',
        'awaiting_design_approval', 'investigating', 'investigated'
    )
);

DROP INDEX factory.work_items_active_issue_key;
CREATE UNIQUE INDEX work_items_active_issue_key
    ON factory.work_items (owner, repo, issue_number)
    WHERE kind = 'issue' AND status IN (
        'picked', 'requirements_generating', 'awaiting_approval',
        'implementing', 'reviewing', 'fixing', 'auditing',
        'designing', 'awaiting_design_approval', 'investigating'
    );

DROP INDEX factory.work_items_active_pr_fix_key;
CREATE UNIQUE INDEX work_items_active_pr_fix_key
    ON factory.work_items (owner, repo, pr_number)
    WHERE kind = 'pr_fix' AND status IN (
        'picked', 'requirements_generating', 'awaiting_approval',
        'implementing', 'reviewing', 'fixing', 'auditing',
        'designing', 'awaiting_design_approval', 'investigating'
    );

DROP INDEX factory.work_items_active_dependabot_key;
CREATE UNIQUE INDEX work_items_active_dependabot_key
    ON factory.work_items (owner, repo, pr_number)
    WHERE kind = 'dependabot' AND status IN (
        'picked', 'requirements_generating', 'awaiting_approval',
        'implementing', 'reviewing', 'fixing', 'auditing',
        'designing', 'awaiting_design_approval', 'investigating'
    );

DROP INDEX factory.work_items_active_pr_review_key;
CREATE UNIQUE INDEX work_items_active_pr_review_key
    ON factory.work_items (lower(owner), lower(repo), pr_number)
    WHERE kind = 'pr_review' AND status IN (
        'picked', 'requirements_generating', 'awaiting_approval',
        'implementing', 'reviewing', 'fixing', 'auditing',
        'designing', 'awaiting_design_approval', 'investigating'
    );

CREATE UNIQUE INDEX work_items_active_investigate_key
    ON factory.work_items (lower(owner), lower(repo), issue_number)
    WHERE kind = 'investigate' AND status IN (
        'picked', 'requirements_generating', 'awaiting_approval',
        'implementing', 'reviewing', 'fixing', 'auditing',
        'designing', 'awaiting_design_approval', 'investigating'
    );

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
WHERE status IN ('approved', 'rejected', 'needs_human', 'failed', 'expired', 'cancelled', 'reviewed', 'rereview_requested', 'blocked', 'audited', 'pr_open', 'investigated');

END;
