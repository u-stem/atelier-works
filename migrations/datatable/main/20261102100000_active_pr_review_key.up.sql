-- up migration: active_pr_review_key
--
-- pr_reviewの作業項目は、同じPRについて、終端でないものを同時に1件までしか持てない。
-- ラベルの経路と、Consoleの投入の経路が、同じPRのレビューを重ねて始めないためである。
--
-- 索引は、ownerとrepoを小文字にして比べる。pr_reviewの行の綴りは、書き手によって揺れる。
-- 収集の表は小文字で書き、設定で明示したリポジトリは設定の綴りをそのまま使う。
-- 綴りが違うだけの同じPRを、別のPRとして数えないためである。
--
-- 状態の一覧は、f/factory/lib/types.ts の TERMINAL_WORK_ITEM_STATUSES に
-- 入らない状態のすべてで、work_items_active_pr_fix_key の一覧と同じである。
-- tests/scripts/active_pr_review_migration.test.ts が、両者が食い違っていないことを確かめる。
-- 終端の状態を変えるときは、4つのインデックスを作り直す新しいmigrationが要る。
--
-- 索引を作る前に、同じPRの稼働中のpr_reviewが複数あれば、id が最大の行を残して、
-- 古い行を cancelled にし、work_item_events に残す。
-- 重複は、ラベルの経路で作れる。重複があると CREATE UNIQUE INDEX が失敗して、
-- migrationが止まり続けるので、人の作業を挟まずに最初の反映で索引が入るようにする。
-- 「id が最大の行を残す」は自動の規則で、どの重複を残すかを人が確かめてはいない。
-- pr_review はリースを使わない。取り消された行のフローを止めるのは、
-- 投稿の直前に作業項目の状態を確かめる処理(steps/pr_review_post.ts)で、reviewing でなければ投稿しない。
--
-- 取り消しと索引の作成の間に挿入が入らないよう、先に表をロックする。
-- SHARE ROW EXCLUSIVE は並行する書き込みを止め、読み取りは許す。
-- ロックの待ちは最大30秒で、止まった書き込みがあればmigrationは失敗する(self_updateが再試行する)。
BEGIN;

SET LOCAL lock_timeout = '30s';

LOCK TABLE factory.work_items IN SHARE ROW EXCLUSIVE MODE;

WITH ranked AS (
    SELECT
        id,
        status,
        row_number() OVER (
            PARTITION BY lower(owner), lower(repo), pr_number
            ORDER BY id DESC
        ) AS rn
    FROM factory.work_items
    WHERE kind = 'pr_review'
      AND pr_number IS NOT NULL
      AND status IN (
        'picked', 'requirements_generating', 'awaiting_approval',
        'implementing', 'reviewing', 'fixing', 'auditing',
        'designing', 'awaiting_design_approval'
      )
),
cancelled AS (
    UPDATE factory.work_items AS wi
    SET status = 'cancelled', updated_at = now()
    FROM ranked
    WHERE wi.id = ranked.id AND ranked.rn > 1 AND wi.status = ranked.status
    RETURNING wi.id, ranked.status AS from_status
)
INSERT INTO factory.work_item_events (work_item_id, from_status, to_status, note)
SELECT id, from_status, 'cancelled', 'duplicate active pr_review work item cancelled by migration'
FROM cancelled;

CREATE UNIQUE INDEX work_items_active_pr_review_key
    ON factory.work_items (lower(owner), lower(repo), pr_number)
    WHERE kind = 'pr_review' AND status IN (
        'picked', 'requirements_generating', 'awaiting_approval',
        'implementing', 'reviewing', 'fixing', 'auditing',
        'designing', 'awaiting_design_approval'
    );

END;
