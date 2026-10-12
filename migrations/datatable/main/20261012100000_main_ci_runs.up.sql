-- up migration: main_ci_runs
--
-- 対象リポジトリの既定ブランチへのpushごとに、GitHub Actionsの実行をコミット単位で判定した結果を記録する。
-- 作業項目(work_items)とは独立した読み取り専用の記録で、作業項目の状態、終端、リードタイムには影響しない。
-- 外部キーは持たない。作業項目の削除に連なって消えず、掃除は自身のupdated_atで行う。
--
-- state:
--   pending  実行の完了と確定を待っている。掃除の対象にしない。
--   passed   すべての実行が完了し、success、skipped、neutralだけだった。
--   failed   すべての実行が完了し、それ以外の結論があった。
--   expired  期限までに完了しなかった。
--   no_ci    実行が1件も現れなかった。
--   baseline 初回の観測で、既存のコミットとして記録しただけ。判定も通知もしない。
BEGIN;

CREATE TABLE factory.main_ci_runs (
    id bigserial PRIMARY KEY,
    owner text NOT NULL,
    repo text NOT NULL,
    head_sha text NOT NULL,
    state text NOT NULL DEFAULT 'pending',
    summary text NOT NULL DEFAULT '',
    prev_failed boolean NOT NULL DEFAULT false,
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    run_created_at timestamptz,
    next_check_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT main_ci_runs_head_sha_check CHECK (head_sha ~ '^[0-9a-f]{40}$'),
    CONSTRAINT main_ci_runs_state_check
        CHECK (state IN ('pending', 'passed', 'failed', 'expired', 'no_ci', 'baseline')),
    UNIQUE (owner, repo, head_sha)
);

COMMENT ON TABLE factory.main_ci_runs IS
    '既定ブランチのコミットごとのCI(GitHub Actionsのpushの実行)の判定結果。読み取り専用の記録で、作業項目には影響しない。';
COMMENT ON COLUMN factory.main_ci_runs.summary IS
    '失敗したworkflowの名前と結論を整形した文字列。外部由来の文字列はここだけに置き、通知の本文には載せない。';
COMMENT ON COLUMN factory.main_ci_runs.prev_failed IS
    '1つ前のコミットも失敗だったか。原因のPRは断定せず、失敗が続いていることを示すだけに使う。';
COMMENT ON COLUMN factory.main_ci_runs.run_created_at IS
    'そのコミットの実行のうち、最も古い実行の作成時刻。実行をまだ見ていなければNULL。';
COMMENT ON COLUMN factory.main_ci_runs.next_check_at IS
    'この時刻より前には照会しない。権限エラーの後に照会の間隔を延ばすために使う。';

-- 照会の対象(pendingで、次の照会の時刻が来ているもの)を引く。
CREATE INDEX main_ci_runs_pending_idx ON factory.main_ci_runs (next_check_at) WHERE state = 'pending';
-- 掃除の対象(pending以外で、更新から保持期間を過ぎたもの)を引く。
CREATE INDEX main_ci_runs_settled_idx ON factory.main_ci_runs (updated_at) WHERE state <> 'pending';

END;
