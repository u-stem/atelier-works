-- up migration: notices_unresolved_dedup
--
-- 同じ種類(kind)と本文(message)の未解決の通知を、1件までにする。
-- addNoticeUnlessUnresolvedは確認と挿入を1つの文で行うが、並行して実行すると重複しうる。
-- 部分一意索引で、並行した挿入の重複もDBが拒む。挿入側はON CONFLICTで受ける。
--
-- 本文は長さに上限が無く、btreeの索引の1件の大きさの上限を超えうる。
-- そのため索引の対象は本文そのものではなく、本文のmd5にする。
--
-- 既存の重複は、索引を作る前に解決済みにする。
-- 残すのは、作成時刻が最古の1件(同時刻ならidが小さい方)である。
-- 解決した行には、解決者に'migration'、解決時刻に現在時刻を記録する。
-- 「最古を残す」は自動の規則で、人が確かめたものではない。
-- 通知は一覧で見分けが付かないだけで、本文は同じなので、残す1件を選んでも情報は失われない。
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
        row_number() OVER (PARTITION BY kind, message ORDER BY created_at ASC, id ASC) AS rn
    FROM factory.notices
    WHERE resolved = false
)
UPDATE factory.notices AS n
SET resolved = true, resolved_by = 'migration', resolved_at = now()
FROM ranked
WHERE n.id = ranked.id AND ranked.rn > 1;

CREATE UNIQUE INDEX notices_unresolved_key
    ON factory.notices (kind, md5(message))
    WHERE resolved = false;

END;
