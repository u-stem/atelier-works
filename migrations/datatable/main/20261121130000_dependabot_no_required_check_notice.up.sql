-- up migration: dependabot_no_required_check_notice
--
-- 対象ブランチに必須チェックが無いdependabotの通知(dependabot_no_required_check)の未解決を、
-- リポジトリごとに1件までにする。本文の先頭は`owner/repo: `で、受けているPRの数を含む。
-- 種類と本文の組の索引(notices_unresolved_key)では、数が変わるたびに別の通知になる。
-- recordNoRequiredCheckNoticeは、この索引をON CONFLICTの衝突先にして、未解決の1件の本文を更新する。
-- 取得が同時に2つ動いても、同じリポジトリの2件目の未解決の通知はDBが拒む。
--
-- 既存の重複は、索引を作る前に解決済みにする。
-- 残すのは、リポジトリごとに作成時刻が最も新しい1件(同時刻ならidが大きい方)である。
-- 解決した行には、解決者に'migration'、解決時刻に現在時刻を記録する。
--
-- 解決と索引の作成の間に挿入が入らないよう、先に表をロックする。
-- ロックの待ちは最大30秒で、止まった書き込みがあればmigrationは失敗する(self_updateが再試行する)。
BEGIN;

SET LOCAL lock_timeout = '30s';

LOCK TABLE factory.notices IN SHARE ROW EXCLUSIVE MODE;

WITH ranked AS (
    SELECT
        id,
        row_number() OVER (
            PARTITION BY lower(split_part(message, ': ', 1))
            ORDER BY created_at DESC, id DESC
        ) AS rn
    FROM factory.notices
    WHERE kind = 'dependabot_no_required_check' AND resolved = false
)
UPDATE factory.notices AS n
SET resolved = true, resolved_by = 'migration', resolved_at = now()
FROM ranked
WHERE n.id = ranked.id AND ranked.rn > 1;

CREATE UNIQUE INDEX notices_unresolved_no_required_check_key
    ON factory.notices ((lower(split_part(message, ': ', 1))))
    WHERE resolved = false AND kind = 'dependabot_no_required_check';

END;
