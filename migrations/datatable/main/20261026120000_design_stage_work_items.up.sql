-- up migration: design_stage_work_items
--
-- 設計工程の土台として、作業項目の状態と列を足す。
-- これらを書く処理はまだ無い。値は使われるまで既定値のまま残る。
--
--   status に designing と awaiting_design_approval を足す。設計書を生成している間と、その承認を待つ間の状態である。
--   design_attempt  設計書を生成した回数。
--
-- 承認依頼の種類を足す設計工程のもう1つのmigration(design_stage_approval_kind)とは、表ごとに分けている。
-- 1つのトランザクションが2つの表のロックを取ると、アプリの1文(承認依頼を先に、外部キーの検査で作業項目を後に取る)と
-- ロックの待ちが閉路になりうるためである。
--
-- 稼働中の一意インデックスの述語は、f/factory/lib/types.ts の TERMINAL_WORK_ITEM_STATUSES に
-- 入らない状態のすべてである。2つの状態は終端でないので、3本とも作り直して述語に足す。
-- tests/scripts/active_{issue,pr_fix,dependabot}_migration.test.ts が、述語と状態の定義が食い違っていないことを確かめる。
--
-- 制約の付け替えとインデックスの作り直しは、どちらも ACCESS EXCLUSIVE のロックを取る。
-- 取るロックを最初から同じ強さにして、ロックの昇格を避ける。
-- ロックの待ちは最大30秒で、止まった書き込みがあればmigrationは失敗する(self_updateが再試行する)。
--
-- このmigrationは行を書き換えない。新しい状態の行は無いので、インデックスの作り直しは重複で失敗しない。
BEGIN;

SET LOCAL lock_timeout = '30s';
LOCK TABLE factory.work_items IN ACCESS EXCLUSIVE MODE;

ALTER TABLE factory.work_items
    ADD COLUMN design_attempt integer NOT NULL DEFAULT 0 CHECK (design_attempt >= 0);

COMMENT ON COLUMN factory.work_items.design_attempt IS
    '設計工程で設計書を生成した回数。生成していなければ0。';

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

DROP INDEX factory.work_items_active_issue_key;
CREATE UNIQUE INDEX work_items_active_issue_key
    ON factory.work_items (owner, repo, issue_number)
    WHERE kind = 'issue' AND status IN (
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

DROP INDEX factory.work_items_active_dependabot_key;
CREATE UNIQUE INDEX work_items_active_dependabot_key
    ON factory.work_items (owner, repo, pr_number)
    WHERE kind = 'dependabot' AND status IN (
        'picked', 'requirements_generating', 'awaiting_approval',
        'implementing', 'reviewing', 'fixing', 'auditing',
        'designing', 'awaiting_design_approval'
    );

END;
