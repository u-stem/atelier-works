-- up migration: fix_rounds_design_gap
--
-- PR修正のラウンドの結果に design_gap を足す。
-- 承認済みの設計書が渡ったレビュー回の修正が、設計書の不足を報告して親のIssueを設計へ戻すときのラウンドが使う。
--
-- 制約の付け替えは ACCESS EXCLUSIVE のロックを取る。最初から同じ強さで取り、ロックの昇格を避ける。
-- ロックの待ちは最大30秒で、止まった書き込みがあればmigrationは失敗する(self_updateが再試行する)。
BEGIN;

SET LOCAL lock_timeout = '30s';
LOCK TABLE factory.fix_rounds IN ACCESS EXCLUSIVE MODE;

ALTER TABLE factory.fix_rounds DROP CONSTRAINT fix_rounds_outcome_check;
ALTER TABLE factory.fix_rounds ADD CONSTRAINT fix_rounds_outcome_check
    CHECK (outcome IN ('done', 'requirements_gap', 'design_gap', 'blocked'));

END;
