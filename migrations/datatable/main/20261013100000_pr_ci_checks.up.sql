-- up migration: pr_ci_checks
--
-- FactoryのPRのheadごとに、GitHub ActionsのCIの実行を判定した結果を記録する。
-- 判定の単位は(owner, repo, pr_number, head_sha)である。
-- 作業項目(work_items)とは独立した記録で、作業項目の状態、終端、リードタイムには影響しない。
-- 外部キーは持たない。作業項目の削除に連なって消えず、掃除は自身のupdated_atで行う。
--
-- state:
--   pending    実行の完了と確定を待っている。掃除の対象にしない。
--   passed     すべての実行が完了し、success、skipped、neutralだけだった。
--   failed     すべての実行が完了し、それ以外の結論があった。同じheadの再実行で通れば、passedに戻る。
--   superseded PRのheadが進み、このheadの判定は不要になった。headが以前の値に戻ったら、pendingに戻して判定し直す。
--   expired    期限までに完了しなかった。
--   no_ci      実行が1件も現れなかった。
--   observed   判定を記録しただけで、通知も修正の起動もしない。
BEGIN;

CREATE TABLE factory.pr_ci_checks (
    id bigserial PRIMARY KEY,
    owner text NOT NULL,
    repo text NOT NULL,
    pr_number integer NOT NULL,
    head_sha text NOT NULL,
    state text NOT NULL DEFAULT 'pending',
    run_created_at timestamptz,
    summary text NOT NULL DEFAULT '',
    notified_reason text,
    work_item_id bigint,
    checked_at timestamptz NOT NULL DEFAULT now(),
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pr_ci_checks_pr_number_check CHECK (pr_number > 0),
    CONSTRAINT pr_ci_checks_head_sha_check CHECK (head_sha ~ '^[0-9a-f]{40}$'),
    CONSTRAINT pr_ci_checks_state_check
        CHECK (state IN ('pending', 'passed', 'failed', 'superseded', 'expired', 'no_ci', 'observed')),
    CONSTRAINT pr_ci_checks_summary_length_check CHECK (char_length(summary) <= 400),
    UNIQUE (owner, repo, pr_number, head_sha)
);

COMMENT ON TABLE factory.pr_ci_checks IS
    'FactoryのPRのheadごとのCI(GitHub Actionsのpull_requestとpushの実行)の判定結果。作業項目には影響しない。';
COMMENT ON COLUMN factory.pr_ci_checks.summary IS
    '失敗したworkflowの名前と結論を整形した文字列。外部由来の文字列はここだけに置き、通知の本文には載せない。';
COMMENT ON COLUMN factory.pr_ci_checks.run_created_at IS
    'そのheadの実行のうち、最も古い実行の作成時刻。実行をまだ見ていなければNULL。';
COMMENT ON COLUMN factory.pr_ci_checks.notified_reason IS
    '通知した理由コード。同じ理由を重ねて通知しないために使う。通知していなければNULL。';
COMMENT ON COLUMN factory.pr_ci_checks.work_item_id IS
    'このPRを作ったFactoryの作業項目のID。外部キーは持たず、値だけを参照する。';
COMMENT ON COLUMN factory.pr_ci_checks.checked_at IS
    '最後に実行を読み直した時刻。判定待ちと失敗の行を、読み直していない順に巡回するために使う。保持期間には影響しない。';
COMMENT ON COLUMN factory.pr_ci_checks.first_seen_at IS
    'そのheadを最初に見た時刻。headが以前の値に戻ったときは、戻った時刻に更新する。PRの最新の行を決める鍵に使う。';

-- 照会の対象(pendingのもの)を、読み直していない順に引く。
CREATE INDEX pr_ci_checks_pending_idx ON factory.pr_ci_checks (checked_at) WHERE state = 'pending';
-- 掃除の対象(pending以外で、更新から保持期間を過ぎたもの)を引く。
CREATE INDEX pr_ci_checks_settled_idx ON factory.pr_ci_checks (updated_at) WHERE state <> 'pending';

END;
