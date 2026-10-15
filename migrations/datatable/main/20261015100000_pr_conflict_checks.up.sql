-- up migration: pr_conflict_checks
--
-- FactoryのPRのマージの競合を、PRごとに1行で記録する。競合を見つけたPRだけが行を持つ。
-- 作業項目(work_items)とは独立した記録で、作業項目の状態には影響しない。
-- 外部キーは持たない。作業項目の削除に連なって消えず、掃除は自身のupdated_atで行う。
--
-- state:
--   conflicted 競合している。head_shaとbase_shaは、競合を見た時点の値である。
--              どちらかが変わったら、同じ行を書き換えて通知し直す。
--   resolved   競合が解けた。再び競合したら、同じ行をconflictedに戻す。
--   closed     PRが閉じられたか、マージされた。
--
-- 掃除は、conflicted以外の行を、最後の更新から保持期間を過ぎたら削除する。
-- 競合したままの行は、通知が未解決である間は削除しない。
--
-- 既存の表は書き換えない。ロックの待ちは最大30秒で、
-- 止まった書き込みがあればmigrationは失敗する(self_updateが再試行する)。
BEGIN;

SET LOCAL lock_timeout = '30s';

CREATE TABLE factory.pr_conflict_checks (
    id bigserial PRIMARY KEY,
    owner text NOT NULL,
    repo text NOT NULL,
    pr_number integer NOT NULL,
    head_sha text NOT NULL,
    base_sha text NOT NULL,
    state text NOT NULL DEFAULT 'conflicted',
    fix_attempts integer NOT NULL DEFAULT 0,
    notified_at timestamptz,
    checked_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pr_conflict_checks_pr_number_check CHECK (pr_number > 0),
    CONSTRAINT pr_conflict_checks_head_sha_check CHECK (head_sha ~ '^[0-9a-f]{40}$'),
    CONSTRAINT pr_conflict_checks_base_sha_check CHECK (base_sha ~ '^[0-9a-f]{40}$'),
    CONSTRAINT pr_conflict_checks_state_check
        CHECK (state IN ('conflicted', 'resolved', 'closed')),
    CONSTRAINT pr_conflict_checks_fix_attempts_check CHECK (fix_attempts >= 0),
    UNIQUE (owner, repo, pr_number)
);

COMMENT ON TABLE factory.pr_conflict_checks IS
    'FactoryのPRのマージの競合の記録。PRごとに1行で、作業項目には影響しない。';
COMMENT ON COLUMN factory.pr_conflict_checks.head_sha IS
    '競合を見た時点のPRのheadのコミット。';
COMMENT ON COLUMN factory.pr_conflict_checks.base_sha IS
    '競合を見た時点のベースブランチの先頭のコミット。';
COMMENT ON COLUMN factory.pr_conflict_checks.fix_attempts IS
    '競合を解消する作業を起動した回数。検知だけの間は0のまま。';
COMMENT ON COLUMN factory.pr_conflict_checks.notified_at IS
    '今のhead_shaとbase_shaの組で通知した時刻。通知していなければNULL。同じ組で通知を重ねないために使う。';
COMMENT ON COLUMN factory.pr_conflict_checks.checked_at IS
    '最後にPRを読み直した時刻。競合している行を、読み直していない順に巡回するために使う。';

-- 掃除の対象(conflicted以外で、更新から保持期間を過ぎたもの)を引く。
CREATE INDEX pr_conflict_checks_settled_idx ON factory.pr_conflict_checks (updated_at) WHERE state <> 'conflicted';
-- 競合している行を、読み直していない順に引く。
CREATE INDEX pr_conflict_checks_conflicted_idx ON factory.pr_conflict_checks (checked_at) WHERE state = 'conflicted';

END;
