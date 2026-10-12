-- down migration: main_ci_runs_drop_next_check
BEGIN;

DROP INDEX factory.main_ci_runs_pending_idx;
ALTER TABLE factory.main_ci_runs ADD COLUMN next_check_at timestamptz NOT NULL DEFAULT now();
COMMENT ON COLUMN factory.main_ci_runs.next_check_at IS
    'この時刻より前には照会しない。権限エラーの後に照会の間隔を延ばすために使う。';
CREATE INDEX main_ci_runs_pending_idx ON factory.main_ci_runs (next_check_at) WHERE state = 'pending';

END;
