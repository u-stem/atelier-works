-- up migration: work_items_profile
--
-- 作業項目に、進め方を表す profile の列を足す。
-- 進め方は、要件定義と設計の承認を要するか、どの工程を通るかを決める。
-- 既存の行と、列を指定せずに作る行は、すべて standard になる。
-- 列を書く処理はまだ無い。
--
-- コードの反映は migration より先に走るので、列が無い間は、行の読みが profile を standard として読む。
--
-- 値の一覧は、f/factory/lib/types.ts の WORK_ITEM_PROFILES と同じである。
-- tests/scripts/profile_migration.test.ts が、一覧が食い違っていないことを確かめる。
-- インデックスと view は触らない。
--
-- 列の追加は ACCESS EXCLUSIVE のロックを取る。
-- ロックの待ちは最大30秒で、止まった書き込みがあれば migration は失敗する(self_update が再試行する)。
BEGIN;

SET LOCAL lock_timeout = '30s';
LOCK TABLE factory.work_items IN ACCESS EXCLUSIVE MODE;

ALTER TABLE factory.work_items
    ADD COLUMN profile text NOT NULL DEFAULT 'standard'
        CHECK (profile IN ('standard', 'direct', 'bugfix', 'docs'));

COMMENT ON COLUMN factory.work_items.profile IS
    '作業項目の進め方。承認の要否と通る工程を決める。既定は standard。issue 以外の種別でも既定値で埋まるが、意味を持たない。';

END;
