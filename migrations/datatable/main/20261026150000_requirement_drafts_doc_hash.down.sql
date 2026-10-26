-- down migration: requirement_drafts_doc_hash
--
-- doc_hash の列を落とす。保存済みの基準値は消え、当て直しても既存の下書きの値は空のままになる。
-- コードが doc_hash を読み書きするので、戻す前に、列を読み書きしないコードを反映しておくこと。
BEGIN;

SET LOCAL lock_timeout = '30s';
LOCK TABLE factory.requirement_drafts IN ACCESS EXCLUSIVE MODE;

ALTER TABLE factory.requirement_drafts DROP COLUMN doc_hash;

END;
