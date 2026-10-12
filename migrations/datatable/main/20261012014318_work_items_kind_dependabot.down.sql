-- down migration: work_items_kind_dependabot
-- 制約を戻す前に、dependabotの作業項目を削除する。
-- 子の表の行の多くは、外部キーのON DELETE CASCADEで一緒に消える。
-- job_failuresの参照と、子の作業項目のparent_work_item_idはSET NULLで空になる。
-- 削除した行は戻さない。
BEGIN;

DELETE FROM factory.work_items WHERE kind = 'dependabot';
ALTER TABLE factory.work_items DROP CONSTRAINT work_items_kind_check;
ALTER TABLE factory.work_items ADD CONSTRAINT work_items_kind_check
    CHECK (kind IN ('issue', 'pr_review', 'pr_fix', 'audit'));

END;
