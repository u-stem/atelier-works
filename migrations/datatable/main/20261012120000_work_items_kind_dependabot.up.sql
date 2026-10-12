-- up migration: work_items_kind_dependabot
--
-- dependabotのセキュリティ更新PRを扱う作業項目の種別(dependabot)を足す。
-- kindのCHECK制約は作り直すしかないので、広げた制約で置き換える。
-- 既存の行はすべて新しい制約を満たすため、行は変えない。
BEGIN;

ALTER TABLE factory.work_items DROP CONSTRAINT work_items_kind_check;
ALTER TABLE factory.work_items ADD CONSTRAINT work_items_kind_check
    CHECK (kind IN ('issue', 'pr_review', 'pr_fix', 'audit', 'dependabot'));

END;
