-- down migration: job_links
-- 遷移と失敗に結び付けたジョブIDの記録は失われる。
BEGIN;

ALTER TABLE factory.job_failures DROP COLUMN root_job_id;
ALTER TABLE factory.work_item_events DROP COLUMN root_job_id;
ALTER TABLE factory.work_item_events DROP COLUMN job_id;

END;
