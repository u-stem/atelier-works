-- up migration: active_dependabot_key
--
-- dependabotの作業項目は、(owner, repo, pr_number)ごとに、終端でないものを
-- 同時に1件までしか持てない。dependabotの取得は ON CONFLICT DO NOTHING で
-- 挿入するので、DBを共有する2つのインスタンスが、同じPRを二重に始めることはない。
--
-- 状態の一覧は、f/factory/lib/types.ts の TERMINAL_WORK_ITEM_STATUSES に
-- 入らない状態のすべてで、work_items_active_issue_key の一覧と同じである。
-- tests/scripts/active_dependabot_migration.test.ts が、両者が食い違っていないことを確かめる。
-- 終端の状態を変えるときは、両方のインデックスを作り直す新しいmigrationが要る。
--
-- dependabotの行は、必ず pr_number を持つ。pr_number が NULL の行は、
-- ユニークインデックスでは互いに別の値として扱われるので、衝突しない。
-- work_items_active_issue_key の issue_number と同じ扱いである。
--
-- このmigrationは行を書き換えない。稼働中の重複した行があれば、
-- CREATE UNIQUE INDEX が失敗し、migrationはエラーで止まる。
BEGIN;

CREATE UNIQUE INDEX work_items_active_dependabot_key
    ON factory.work_items (owner, repo, pr_number)
    WHERE kind = 'dependabot' AND status IN (
        'picked', 'requirements_generating', 'awaiting_approval',
        'implementing', 'reviewing', 'fixing', 'auditing'
    );

END;
