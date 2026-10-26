-- down migration: design_drafts
--
-- 設計書の下書きの表と、requirement_drafts の一意制約を消す。
-- 下書きは設計の成果物で、消すと戻せない。
-- そこで、最初の ADD CONSTRAINT で、行が1件でもあれば検証に失敗する制約(CHECK (false))を足す。
-- 設計書の下書きが残っていると、この文の検証が失敗し、トランザクションごと戻る。
-- 下書きを消さずに止める役をこの文が持つ。NOT VALID は付けない。
-- 止まったら、運用者が下書きを手で扱ってから、もう一度戻す。
-- 行が無ければ制約は検証を通り、後続の DROP TABLE が表ごと制約を消す。
BEGIN;

SET LOCAL lock_timeout = '30s';
LOCK TABLE factory.requirement_drafts IN ACCESS EXCLUSIVE MODE;

ALTER TABLE factory.design_drafts ADD CONSTRAINT design_drafts_must_be_empty CHECK (false);

DROP TABLE factory.design_drafts;

ALTER TABLE factory.requirement_drafts DROP CONSTRAINT requirement_drafts_id_work_item_id_key;

END;
