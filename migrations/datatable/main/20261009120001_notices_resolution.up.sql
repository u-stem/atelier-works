-- up migration: notices_resolution
--
-- 運用者がConsoleから通知を解決したときに、誰がいつ解決したかを残す。
-- resolved_byは承認者の識別子、resolved_atは解決した時刻である。
-- 解決済みの通知を消す掃除(cleanup_db)は、resolved_atを基準にする。
--
-- 既存の行は解決の記録を持たないため、どちらもNULLのままにする。
-- 未解決の通知を返すビューは、列を明示して選んでいるので変えない。
BEGIN;

ALTER TABLE factory.notices ADD COLUMN resolved_by text;
ALTER TABLE factory.notices ADD COLUMN resolved_at timestamptz;

COMMENT ON COLUMN factory.notices.resolved_by IS
    'この通知を解決した承認者。Console以外で解決した行と、移行前の行ではNULL。';
COMMENT ON COLUMN factory.notices.resolved_at IS
    'この通知を解決した時刻。Console以外で解決した行と、移行前の行ではNULL。';

END;
