-- up migration: job_links
--
-- 作業項目の遷移と失敗に、動いたWindmillのジョブを結び付ける。
-- Consoleは、これらのIDからジョブの画面(/run/<job_id>)へのリンクを作る。
--
-- work_item_events.job_idは、遷移を起こしたステップ(またはscript)のジョブID(WM_JOB_ID)である。
-- work_item_events.root_job_idは、そのステップを含むフローのルートジョブID(WM_ROOT_FLOW_JOB_ID)である。
-- job_failures.root_job_idも、失敗を記録したジョブのルートジョブIDである。
-- job_failures.job_idは既存の列で、呼び出し側が渡した値を持つ。フローの失敗ではルートのフローのジョブIDになる。
--
-- 既存の行はジョブを記録していないため、NULLのままにする。
-- この移行そのものが書くwork_item_eventsの行も、ジョブを持たないのでNULLになる。
BEGIN;

ALTER TABLE factory.work_item_events ADD COLUMN job_id text;
ALTER TABLE factory.work_item_events ADD COLUMN root_job_id text;
ALTER TABLE factory.job_failures ADD COLUMN root_job_id text;

COMMENT ON COLUMN factory.work_item_events.job_id IS
    'この遷移を起こしたステップ(またはscript)のジョブID(WM_JOB_ID)。ジョブIDが読めない場合や、記録の無い行(移行前の行など)ではNULL。';
COMMENT ON COLUMN factory.work_item_events.root_job_id IS
    'この遷移を起こしたステップを含むフローのルートジョブID(WM_ROOT_FLOW_JOB_ID)。ジョブIDが読めない場合や、記録の無い行(移行前の行など)ではNULL。';
COMMENT ON COLUMN factory.job_failures.root_job_id IS
    'この失敗を記録したジョブのルートジョブID(WM_ROOT_FLOW_JOB_ID)。ジョブIDが読めない場合や、記録の無い行(移行前の行など)ではNULL。';

END;
