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
-- あわせて、同じPRで終端でないpr_fixの作業項目を同時に1件までにする部分一意索引を足す。
-- CIの失敗を直す作業項目と、レビュー指摘を直す作業項目が、同じPRを同時に書き換えないようにするためである。
-- 状態の一覧は、f/factory/lib/types.ts の TERMINAL_WORK_ITEM_STATUSES に入らない状態のすべてで、
-- work_items_active_dependabot_key の一覧と同じである。
-- tests/scripts/pr_ci_fix_schema_migration.test.ts が、両者が食い違っていないことを確かめる。
-- 終端の状態を変えるときは、この索引も作り直す新しいmigrationが要る。
-- pr_numberがNULLの行は、ユニーク索引では互いに別の値として扱われるので、衝突しない。
-- 終端でないpr_fixの行が同じPRに重なっていれば、CREATE UNIQUE INDEXが失敗し、migrationはエラーで止まる。
--
-- 外部キーは持たない。pr_ci_checksは作業項目の削除に連なって消えず、作業項目も行の掃除に連なって消えない。
-- 参照先が消えても、値が空になって回復の条件が崩れることはない。
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

CREATE UNIQUE INDEX work_items_active_pr_fix_key
    ON factory.work_items (owner, repo, pr_number)
    WHERE kind = 'pr_fix' AND status IN (
        'picked', 'requirements_generating', 'awaiting_approval',
        'implementing', 'reviewing', 'fixing', 'auditing'
    );

END;
