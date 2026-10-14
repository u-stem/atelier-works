-- up migration: pr_ci_fix_schema
--
-- PRのCIの失敗を自動で直す仕組みの土台として、状態と列を足す。
-- 新しい状態と列を読み書きする処理はまだ無い。列は使われるまで既定値かNULLのまま残る。
--
-- pr_ci_checks:
--   state に fixing を足す。失敗した行を直す作業項目を起動した後の、結果待ちの状態である。
--   fix_work_item_id  いま直している作業項目のID。直していなければNULL。
--   fix_attempts      同じheadで直す作業項目を起動した回数。
--   fix_hold_reason   直す作業項目を起動せず保留している理由コード。保留していなければNULL。
-- work_items:
--   ci_check_id       この作業項目が直しているpr_ci_checksの行のID。CIの失敗を直す作業項目だけが持つ。
--
-- 外部キーは持たない。pr_ci_checksは作業項目の削除に連なって消えず、作業項目も行の掃除に連なって消えない。
-- 値は参照先の行が無くても残り、参照先の削除で書き換わらない。
--
-- 列の追加はACCESS EXCLUSIVEのロックを取る。ロックの待ちは最大30秒で、
-- 止まった書き込みがあればmigrationは失敗する(self_updateが再試行する)。
BEGIN;

SET LOCAL lock_timeout = '30s';

ALTER TABLE factory.pr_ci_checks DROP CONSTRAINT pr_ci_checks_state_check;
ALTER TABLE factory.pr_ci_checks ADD CONSTRAINT pr_ci_checks_state_check
    CHECK (state IN ('pending', 'passed', 'failed', 'superseded', 'expired', 'no_ci', 'observed', 'fixing'));

ALTER TABLE factory.pr_ci_checks
    ADD COLUMN fix_work_item_id bigint,
    ADD COLUMN fix_attempts integer NOT NULL DEFAULT 0,
    ADD COLUMN fix_hold_reason text,
    ADD CONSTRAINT pr_ci_checks_fix_attempts_check CHECK (fix_attempts >= 0),
    ADD CONSTRAINT pr_ci_checks_fix_hold_reason_length_check CHECK (char_length(fix_hold_reason) <= 64),
    ADD CONSTRAINT pr_ci_checks_fix_hold_reason_check CHECK (fix_hold_reason <> '');

COMMENT ON COLUMN factory.pr_ci_checks.fix_work_item_id IS
    'いま失敗を直している作業項目のID。外部キーは持たず、値だけを参照する。直していなければNULL。';
COMMENT ON COLUMN factory.pr_ci_checks.fix_attempts IS
    '同じheadで、失敗を直す作業項目を起動した回数。';
COMMENT ON COLUMN factory.pr_ci_checks.fix_hold_reason IS
    '失敗を直す作業項目を起動せず保留している理由コード。保留していなければNULL。空文字は不可で、64字まで。';

ALTER TABLE factory.work_items
    ADD COLUMN ci_check_id bigint;

COMMENT ON COLUMN factory.work_items.ci_check_id IS
    'この作業項目が直しているpr_ci_checksの行のID。外部キーは持たず、値だけを参照する。CIの失敗を直す作業項目だけが持ち、それ以外はNULL。';

-- ci_check_id = <pr_ci_checksの行のID> で作業項目を引く照合に使う。値のある作業項目だけを索引に入れる。
CREATE INDEX work_items_ci_check_id_idx ON factory.work_items (ci_check_id) WHERE ci_check_id IS NOT NULL;

END;
