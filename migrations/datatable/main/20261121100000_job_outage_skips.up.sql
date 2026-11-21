-- up migration: job_outage_skips
--
-- GitHubへの通信断のために、定期ジョブの1回の処理が終えられなかったことを記録する。
-- job_failuresには入れない。失敗の件数に通信断が混ざると、Factory自身の不具合の件数として読めなくなるため。
-- 通信断の事象そのものは、noticesの種類github_unreachableに1件だけ残る。この表は、見送った回ごとに1行を残す。
BEGIN;

CREATE TABLE factory.job_outage_skips (
    id bigserial PRIMARY KEY,
    flow_path text NOT NULL,
    job_id text NOT NULL,
    root_job_id text,
    step text,
    occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX job_outage_skips_occurred_at_idx ON factory.job_outage_skips (occurred_at);

COMMENT ON TABLE factory.job_outage_skips IS
    'GitHubへの通信断のために、定期ジョブの1回の処理が終えられなかった回。失敗(job_failures)とは別に数える。';
COMMENT ON COLUMN factory.job_outage_skips.flow_path IS
    '見送った定期ジョブのscriptのパス(f/factory/poll_issuesなど)。';
COMMENT ON COLUMN factory.job_outage_skips.job_id IS
    '見送った回のジョブID(WM_JOB_ID)。ジョブIDが読めない場合はunknown。';
COMMENT ON COLUMN factory.job_outage_skips.step IS
    '通信断で止まった処理の名前。無ければNULL。';

END;
