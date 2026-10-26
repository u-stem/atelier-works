-- up migration: requirement_drafts_doc_hash
--
-- 要件定義の下書きに、ディレクトリの内容のハッシュ(基準値)を足す。
-- 下書きを保存するとき、承認の前にディレクトリの内容のハッシュを保存し、
-- 設計の生成と実装の関門が、承認された内容が書き換わっていないことを、この値と比べて確かめる。
--
-- 既存の行は null のままで、基準値が無い行は照合を飛ばす。
-- コードの反映は migration より先に走るので、列が無い間は、コードが doc_hash を除いて保存する。
--
-- 列の追加は ACCESS EXCLUSIVE のロックを取る。
-- ロックの待ちは最大30秒で、止まった書き込みがあれば migration は失敗する(self_update が再試行する)。
BEGIN;

SET LOCAL lock_timeout = '30s';
LOCK TABLE factory.requirement_drafts IN ACCESS EXCLUSIVE MODE;

ALTER TABLE factory.requirement_drafts ADD COLUMN doc_hash text;

COMMENT ON COLUMN factory.requirement_drafts.doc_hash IS
    '承認前に保存した、doc_dir の内容(ファイル名の一覧と中身)の SHA-256。照合の基準値。null は基準値が無い下書き。';

END;
