-- up migration: pr_conflict_checks
--
-- FactoryのPRのマージの競合を、PRごとに1行で記録する。競合を見つけたPRだけが行を持つ。
-- 作業項目(work_items)とは独立した記録で、作業項目の状態には影響しない。
-- 外部キーは持たない。作業項目の削除に連なって消えず、掃除は自身のupdated_atで行う。
--
-- 通知は競合の1回につき1回である。競合は、行が無い状態か、resolvedかclosedの状態から
-- conflictedに移った時点で始まる。始まったときだけ、notified_atを空にする。
-- 競合のままheadが進んでも、head_shaを書き換えるだけで、notified_atは残す。
-- 競合が始まるたびにepisodeを1つ増やし、PRの何回目の競合かを区別する。
--
-- state:
--   conflicted 競合している。head_shaは、競合を最後に見た時点のheadである。
--   resolved   競合が解けた。再び競合したら、同じ行をconflictedに戻して新しい競合を始める。
--   closed     PRが閉じられたか、マージされたか、監視の対象から外れた。
--
-- 掃除は、conflicted以外の行を、最後の更新から保持期間を過ぎたら削除する。
-- conflictedの行は、古くても削除しない。通知が未解決のままの行を消さないためである。
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
    state text NOT NULL DEFAULT 'conflicted',
    episode integer NOT NULL DEFAULT 1,
    notified_at timestamptz,
    checked_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pr_conflict_checks_pr_number_check CHECK (pr_number > 0),
    CONSTRAINT pr_conflict_checks_head_sha_check CHECK (head_sha ~ '^[0-9a-f]{40}$'),
    CONSTRAINT pr_conflict_checks_episode_check CHECK (episode >= 1),
    CONSTRAINT pr_conflict_checks_state_check
        CHECK (state IN ('conflicted', 'resolved', 'closed')),
    UNIQUE (owner, repo, pr_number)
);

COMMENT ON TABLE factory.pr_conflict_checks IS
    'FactoryのPRのマージの競合の記録。PRごとに1行で、作業項目には影響しない。';
COMMENT ON COLUMN factory.pr_conflict_checks.head_sha IS
    '競合を最後に見た時点のPRのheadのコミット。通知の鍵ではない。';
COMMENT ON COLUMN factory.pr_conflict_checks.episode IS
    'PRの何回目の競合か。1から始まり、競合が始まるたびに1つ増える。競合のままheadが進んでも増えない。';
COMMENT ON COLUMN factory.pr_conflict_checks.notified_at IS
    '今の競合で通知した時刻。通知していなければNULL。新しい競合が始まるとNULLに戻り、同じ競合では通知を重ねない。';
COMMENT ON COLUMN factory.pr_conflict_checks.checked_at IS
    '最後にPRを読み直した時刻。競合している行を、読み直していない順に巡回するために使う。';

-- 掃除の対象(conflicted以外で、更新から保持期間を過ぎたもの)を引く。
CREATE INDEX pr_conflict_checks_settled_idx ON factory.pr_conflict_checks (updated_at) WHERE state <> 'conflicted';
-- 競合している行を、読み直していない順に引く。
CREATE INDEX pr_conflict_checks_conflicted_idx ON factory.pr_conflict_checks (checked_at) WHERE state = 'conflicted';

END;
