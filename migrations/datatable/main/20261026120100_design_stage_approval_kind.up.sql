-- up migration: design_stage_approval_kind
--
-- 設計工程の土台として、承認依頼の種類 design を足す。
-- この種類の依頼を書く処理はまだ無い。
--
-- 作業項目の状態と列を足す design_stage_work_items とは、表ごとに分けている。
-- 1つのトランザクションが2つの表のロックを取ると、アプリの1文(承認依頼を先に、外部キーの検査で作業項目を後に取る)と
-- ロックの待ちが閉路になりうるためである。
--
-- 制約の付け替えは ACCESS EXCLUSIVE のロックを取る。最初から同じ強さで取り、ロックの昇格を避ける。
-- ロックの待ちは最大30秒で、止まった書き込みがあればmigrationは失敗する(self_updateが再試行する)。
BEGIN;

SET LOCAL lock_timeout = '30s';
LOCK TABLE factory.approval_requests IN ACCESS EXCLUSIVE MODE;

ALTER TABLE factory.approval_requests DROP CONSTRAINT approval_requests_kind_check;
ALTER TABLE factory.approval_requests ADD CONSTRAINT approval_requests_kind_check
    CHECK (kind IN ('requirements', 'issue_proposal', 'design'));

END;
