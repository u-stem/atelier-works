-- up migration: investigate_singleton
--
-- 稼働中(investigating)の調査を、リポジトリやIssueを問わず、全体で1件までにする。
-- 調査は、worktreeの置き場の自分以外の項目をすべて消してから、自分のworktreeを作る。
-- 調査が並行すると、互いのworktreeを消し合うためである。
-- 隔離の測定も同じ置き場を掃除する。測定との排他は、この索引では守れず、アプリ側が受け持つ。
--
-- 索引は(kind)だけを持ち、述語で稼働中の調査の行に絞る。
-- 述語に入る行はどれも kind が同じなので、2件目が必ず衝突する。
-- 監査の索引(work_items_active_audit_key)と同じ形である。
-- 挿入は ON CONFLICT (kind) WHERE kind = 'investigate' AND status = 'investigating' DO NOTHING で、
-- 衝突を例外にせず、挿入しなかった結果として受ける(lib/db.ts の insertInvestigateWorkItemUnlessActive)。
-- 述語はこの文面と一致させる。tests/scripts/investigate_singleton_migration.test.ts が、両者の一致を確かめる。
--
-- 同じIssueの稼働中の調査を1件にする索引(work_items_active_investigate_key)は、そのまま残す。
-- そちらは終端でないすべての状態を対象にし、この索引は investigating だけを対象にする。
--
-- このmigrationは行を書き換えない。investigating の調査の行はまだ書かれないので、
-- 重複で索引の作成が失敗することは無い。
-- 索引の作成は SHARE のロックを取る。取るロックを最初から同じ強さにして、ロックの昇格を避ける。
-- ロックの待ちは最大30秒で、止まった書き込みがあればmigrationは失敗する(self_updateが再試行する)。
BEGIN;

SET LOCAL lock_timeout = '30s';
LOCK TABLE factory.work_items IN SHARE MODE;

CREATE UNIQUE INDEX work_items_active_investigate_singleton
    ON factory.work_items (kind)
    WHERE kind = 'investigate' AND status = 'investigating';

END;
