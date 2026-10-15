-- up migration: pr_conflict_fix
--
-- PRのマージの競合を自動で直す仕組みの土台として、列と制約と索引を足す。
-- 新しい列を読み書きする処理はまだ無い。列は使われるまで既定値かNULLのまま残る。
--
-- pr_conflict_checks:
--   fix_work_item_id    いま競合を直している作業項目のID。直していなければNULL。
--   fix_attempts        今の競合(episode)で、直す作業項目を起動した回数。
--   fix_hold_reason     直す作業項目を起動せず保留している理由コード。保留していなければNULL。
--   episode_started_at  今の競合が始まった時刻。通知の猶予と、自動で直す対象にする時刻の基準である。
--                       checked_atは読み直すたびに、updated_atは書くたびに進むので、基準にしない。
-- work_items:
--   conflict_check_id   この作業項目が直しているpr_conflict_checksの行のID。競合を直す作業項目だけが持つ。
--   conflict_episode    直している競合のepisode。競合の1回は、行のidとこの値の組で指す。
--
-- 外部キーは持たない。pr_conflict_checksは作業項目の削除に連なって消えず、作業項目も行の掃除に連なって消えない。
-- 値は参照先の行が無くても残り、参照先の削除で書き換わらない。
-- 既存の行は、新しい列が既定値かNULLになるので、足した制約に違反しない。
-- 既存の行のepisode_started_atは、このmigrationを適用した時刻になる。
--
-- 列の追加はACCESS EXCLUSIVEのロックを取る。ロックの待ちは最大30秒で、
-- 止まった書き込みがあればmigrationは失敗する(self_updateが再試行する)。
BEGIN;

SET LOCAL lock_timeout = '30s';

ALTER TABLE factory.pr_conflict_checks
    ADD COLUMN fix_work_item_id bigint,
    ADD COLUMN fix_attempts integer NOT NULL DEFAULT 0,
    ADD COLUMN fix_hold_reason text,
    ADD COLUMN episode_started_at timestamptz NOT NULL DEFAULT now(),
    ADD CONSTRAINT pr_conflict_checks_fix_attempts_check CHECK (fix_attempts >= 0),
    ADD CONSTRAINT pr_conflict_checks_fix_hold_reason_length_check CHECK (char_length(fix_hold_reason) <= 64),
    ADD CONSTRAINT pr_conflict_checks_fix_hold_reason_check CHECK (fix_hold_reason <> '');

COMMENT ON COLUMN factory.pr_conflict_checks.fix_work_item_id IS
    'いま競合を直している作業項目のID。外部キーは持たず、値だけを参照する。直していなければNULL。';
COMMENT ON COLUMN factory.pr_conflict_checks.fix_attempts IS
    '今の競合(episode)で、競合を直す作業項目を起動した回数。新しい競合が始まると0に戻る。';
COMMENT ON COLUMN factory.pr_conflict_checks.fix_hold_reason IS
    '競合を直す作業項目を起動せず保留している理由コード。保留していなければNULL。空文字は不可で、64字まで。';
COMMENT ON COLUMN factory.pr_conflict_checks.episode_started_at IS
    '今の競合が始まった時刻。通知の猶予と、自動で直す対象にする時刻の基準。checked_atとupdated_atは基準にしない。';

ALTER TABLE factory.work_items
    ADD COLUMN conflict_check_id bigint,
    ADD COLUMN conflict_episode integer,
    ADD CONSTRAINT work_items_conflict_check_id_exclusive_check CHECK (conflict_check_id IS NULL OR ci_check_id IS NULL),
    ADD CONSTRAINT work_items_conflict_episode_check CHECK ((conflict_check_id IS NULL) = (conflict_episode IS NULL));

COMMENT ON COLUMN factory.work_items.conflict_check_id IS
    'この作業項目が直しているpr_conflict_checksの行のID。外部キーは持たず、値だけを参照する。競合を直す作業項目だけが持ち、それ以外はNULL。ci_check_idとは同時に持たない。';
COMMENT ON COLUMN factory.work_items.conflict_episode IS
    '直している競合のepisode。conflict_check_idと同時に値を持ち、同時にNULLになる。';

-- conflict_check_id = <pr_conflict_checksの行のID> で作業項目を引く照合に使う。値のある作業項目だけを索引に入れる。
CREATE INDEX work_items_conflict_check_id_idx ON factory.work_items (conflict_check_id) WHERE conflict_check_id IS NOT NULL;
-- 直す作業項目を持つ行を、回復のために引く。値のある行だけを索引に入れる。
CREATE INDEX pr_conflict_checks_fix_work_item_id_idx ON factory.pr_conflict_checks (fix_work_item_id) WHERE fix_work_item_id IS NOT NULL;

END;
