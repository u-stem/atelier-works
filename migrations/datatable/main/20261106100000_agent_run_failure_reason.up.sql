-- up migration: agent_run_failure_reason
--
-- Claudeの実行が失敗したときの種類(`runClaude`の`reason`)を保存する。
-- モデルの昇格の集計が、失敗の文(`error`)の先頭に頼らず、種類で実行を見分けられるようにする。
-- 成功した実行と、この列を足す前の実行はNULLである。
BEGIN;

SET LOCAL lock_timeout = '30s';

ALTER TABLE factory.agent_runs
    ADD COLUMN failure_reason text;

COMMENT ON COLUMN factory.agent_runs.failure_reason IS
    'Claudeの実行が失敗したときの種類(runClaudeのreason)。成功した実行と、この列を足す前の実行はNULLである。';

END;
