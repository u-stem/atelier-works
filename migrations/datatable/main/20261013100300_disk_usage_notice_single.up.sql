-- up migration: disk_usage_notice_single
--
-- 作業領域のディスク使用量の通知(workspace_disk_usage)の未解決を、本文に関わらず1件までにする。
-- 本文は測った使用量を含むので、種類と本文の組の索引(notices_unresolved_key)では、値が変わるたびに別の通知になる。
-- recordWorkspaceDiskUsageNoticeは、この索引をON CONFLICTの衝突先にして、未解決の1件の本文と作成時刻を更新する。
-- 作業領域の掃除が同時に2つ動いても、2件目の未解決の通知はDBが拒む。
--
-- 既存の重複は、索引を作る前に解決済みにする。
-- 残すのは、作成時刻が最も新しい1件(同時刻ならidが大きい方)である。
-- 次の記録で、残した1件の本文が最新の使用量に更新される。
-- 解決した行には、解決者に'migration'、解決時刻に現在時刻を記録する。
--
-- 解決と索引の作成の間に挿入が入らないよう、先に表をロックする。
-- SHARE ROW EXCLUSIVEは並行した書き込みを止め、読み取りは許す。
-- ロックの待ちは最大30秒で、止まった書き込みがあればmigrationは失敗する(self_updateが再試行する)。
BEGIN;

SET LOCAL lock_timeout = '30s';

LOCK TABLE factory.notices IN SHARE ROW EXCLUSIVE MODE;

WITH ranked AS (
    SELECT
        id,
        row_number() OVER (ORDER BY created_at DESC, id DESC) AS rn
    FROM factory.notices
    WHERE kind = 'workspace_disk_usage' AND resolved = false
)
UPDATE factory.notices AS n
SET resolved = true, resolved_by = 'migration', resolved_at = now()
FROM ranked
WHERE n.id = ranked.id AND ranked.rn > 1;

CREATE UNIQUE INDEX notices_unresolved_disk_usage_key
    ON factory.notices (kind)
    WHERE resolved = false AND kind = 'workspace_disk_usage';

END;
