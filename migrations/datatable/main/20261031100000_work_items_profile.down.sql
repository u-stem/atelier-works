-- down migration: work_items_profile
--
-- profile の列を落とす。standard 以外の進め方を持つ行があっても、その値は消える。
-- 行の読みは、列が無いと standard として読むので、戻した後も失敗しない。
-- profile を書くコードが反映された後に戻すと、その書き込みが失敗する。
-- 戻す前に、profile を書かないコードを反映しておくこと。
BEGIN;

SET LOCAL lock_timeout = '30s';
LOCK TABLE factory.work_items IN ACCESS EXCLUSIVE MODE;

ALTER TABLE factory.work_items DROP COLUMN profile;

END;
