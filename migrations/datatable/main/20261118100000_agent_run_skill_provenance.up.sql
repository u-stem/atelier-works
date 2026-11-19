-- up migration: agent_run_skill_provenance
--
-- Claudeの実行ごとに、システムプロンプトへ注入したスキルの版を保存する。
-- `skills`は、要素が{path, sha256, bundle_sha256}のjsonbの配列である。
-- `path`はFactoryのcloneからの相対パス、`sha256`はSKILL.mdの本文、`bundle_sha256`は同梱ファイル(template.mdなど)のハッシュで、同梱ファイルが無いスキルはnullである。
-- `skill_clone_sha`は、そのときのcloneのHEADのコミットSHAである。
-- スキルの記録を持たない実行(この列を足す前の実行と、`buildSystemPrompt`を通さなかった実行)は、どちらもNULLである。
BEGIN;

SET LOCAL lock_timeout = '30s';

ALTER TABLE factory.agent_runs
    ADD COLUMN skills jsonb,
    ADD COLUMN skill_clone_sha text;

COMMENT ON COLUMN factory.agent_runs.skills IS
    '注入したスキルの版の配列。要素は{path, sha256, bundle_sha256}。記録を持たない実行はNULLである。';

COMMENT ON COLUMN factory.agent_runs.skill_clone_sha IS
    'スキルを読んだときのFactoryのcloneのHEADのコミットSHA。取れなかった実行と、記録を持たない実行はNULLである。';

END;
