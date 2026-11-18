-- up migration: pr_review_trigger
--
-- PRレビューの実行を始めたきっかけを記録する。
-- work_items.review_triggerは、pr_reviewの作業項目を最後に起動したきっかけで、起動の経路が起動のたびに書き換える。
-- agent_runs.triggerは、その実行のきっかけで、生成のステップが作業項目の値を写す。
-- 作業項目の値は後の起動で上書きされるため、過去の実行のきっかけは実行の記録の側に残す。
-- 既存の行と、PRレビュー以外の行はNULLである。監査の証跡パックはNULLを不明として数える。
BEGIN;

SET LOCAL lock_timeout = '30s';

ALTER TABLE factory.work_items
    ADD COLUMN review_trigger text,
    ADD CONSTRAINT work_items_review_trigger_check CHECK (
        review_trigger IS NULL
        OR review_trigger IN ('label', 'rereview_request', 'tracked_push', 'console', 'auto_retry')
    );

COMMENT ON COLUMN factory.work_items.review_trigger IS
    'pr_reviewの作業項目を最後に起動したきっかけ。label、rereview_request、tracked_push、console、auto_retryのいずれか。既存の行とpr_review以外の行はNULLである。';

ALTER TABLE factory.agent_runs
    ADD COLUMN trigger text,
    ADD CONSTRAINT agent_runs_trigger_check CHECK (
        trigger IS NULL
        OR trigger IN ('label', 'rereview_request', 'tracked_push', 'console', 'auto_retry')
    );

COMMENT ON COLUMN factory.agent_runs.trigger IS
    'PRレビューの実行のきっかけ(work_items.review_triggerの写し)。PRレビュー以外の実行、きっかけを読めなかった実行、この列を足す前の実行はNULLである。';

END;
