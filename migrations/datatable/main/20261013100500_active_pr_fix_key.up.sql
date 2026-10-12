-- up migration: active_pr_fix_key
--
-- pr_fixの作業項目は、(owner, repo, pr_number)ごとに、終端でないものを
-- 同時に1件までしか持てない。同じPRの修正が並んで動くと、同じブランチへ
-- 別々にpushして競合するためである。
--
-- 状態の一覧は、f/factory/lib/types.ts の TERMINAL_WORK_ITEM_STATUSES に
-- 入らない状態のすべてで、work_items_active_issue_key の一覧と同じである。
-- tests/scripts/active_pr_fix_migration.test.ts が、両者が食い違っていないことを確かめる。
-- 終端の状態を変えるときは、3つのインデックスを作り直す新しいmigrationが要る。
--
-- pr_fixの行は、必ず pr_number を持つ。pr_number が NULL の行は、
-- ユニークインデックスでは互いに別の値として扱われるので、衝突しない。
--
-- 索引を作る間、work_items への書き込みは待たされる。ロックの待ちは最大30秒で、
-- 止まった書き込みがあればmigrationは失敗する(self_updateが再試行する)。
--
-- このmigrationは行を書き換えない。稼働中の重複した行があれば、
-- CREATE UNIQUE INDEX が失敗し、migrationはエラーで止まる。
BEGIN;

SET LOCAL lock_timeout = '30s';

CREATE UNIQUE INDEX work_items_active_pr_fix_key
    ON factory.work_items (owner, repo, pr_number)
    WHERE kind = 'pr_fix' AND status IN (
        'picked', 'requirements_generating', 'awaiting_approval',
        'implementing', 'reviewing', 'fixing', 'auditing'
    );

END;
