-- up migration: design_drafts
--
-- 設計工程が生成した設計書の下書きを保存する表を足す。
-- 1行が、承認済みの要件定義の下書き(requirement_draft_id)から作った設計書の1回分である。
-- 図のXMLは保存せず、doc_dir の <name>.drawio に置く(requirement_drafts と同じ)。
--
-- 設計の試行(design_attempt)は1から数える。要件定義へ戻ると work_items.design_attempt は0に戻るが、
-- この表の行は残るので、同じ作業項目で同じ design_attempt の行が複数できうる。一意制約は付けず、最新の行(id が最大)を採る。
--
-- work_items への外部キーは作らない。作ると work_items に暗黙のロックがかかり、
-- cleanup_db が作業項目を消すときのロックの順と逆になる。
-- 代わりに (requirement_draft_id, work_item_id) で requirement_drafts を参照する。
-- そのために requirement_drafts へ (id, work_item_id) の一意制約を足す。id は主キーなので、既存の行は必ず満たす。
-- 作業項目を消すと、requirement_drafts を経由して2段で design_drafts の行も消える。
--
-- 制約の追加は ACCESS EXCLUSIVE のロックを取る。最初から同じ強さで取り、ロックの昇格を避ける。
-- ロックの待ちは最大30秒で、止まった書き込みがあればmigrationは失敗する(self_updateが再試行する)。
BEGIN;

SET LOCAL lock_timeout = '30s';
LOCK TABLE factory.requirement_drafts IN ACCESS EXCLUSIVE MODE;

ALTER TABLE factory.requirement_drafts
    ADD CONSTRAINT requirement_drafts_id_work_item_id_key UNIQUE (id, work_item_id);

CREATE TABLE factory.design_drafts (
    id bigserial PRIMARY KEY,
    work_item_id bigint NOT NULL,
    requirement_draft_id bigint NOT NULL,
    design_attempt integer NOT NULL CHECK (design_attempt >= 1),
    summary text NOT NULL,
    markdown text NOT NULL,
    diagrams jsonb NOT NULL DEFAULT '[]'::jsonb,
    open_questions jsonb NOT NULL DEFAULT '[]'::jsonb,
    doc_dir text,
    head_sha text,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (requirement_draft_id, work_item_id)
        REFERENCES factory.requirement_drafts (id, work_item_id) ON DELETE CASCADE
);

CREATE INDEX design_drafts_work_item_idx ON factory.design_drafts (work_item_id, id DESC);

COMMENT ON COLUMN factory.design_drafts.requirement_draft_id IS
    '設計書の元にした、承認済みの要件定義の下書き(requirement_drafts.id)。work_item_id と同じ作業項目の下書きだけを指せる。';
COMMENT ON COLUMN factory.design_drafts.design_attempt IS
    '設計の試行。1から数える。作業項目が要件定義へ戻ると work_items.design_attempt は0に戻るが、この列は戻らない。';
COMMENT ON COLUMN factory.design_drafts.head_sha IS
    '設計書が読んだ対象リポジトリの既定ブランチの先頭のsha。要件定義が読んだコミットと違いうるので、追えるように記録する。';

END;
