-- up migration: deploy_approvals
--
-- 保護パスに触れた変更の反映を、人の承認まで止めるための、HEADのshaごとの承認の表を作る。
-- self_updateは、反映する範囲(deployed_sha..HEAD)に保護パスの変更があると、HEADのshaの行を作り(decisionはNULL)、
-- その行のdecisionがapprovedになるまで反映しない。rejectedとNULLは、どちらも反映しない。
-- 判断の対象は、最後に成功した反映(factory.deployments)より後に作られた行のうち、最も新しい1行だけである。
-- mainが進んで新しい行ができた古い行と、承認を待たずに反映が進んだ行は、残したまま対象から外れる。
-- 行は消さず、履歴として残す。
-- 読み書きはlib/deploy_approvals.tsだけが行う。tests/scripts/deploy_approvals_wiring.test.tsが参照を検出する。
--
-- sha: HEADのsha(40桁の小文字の16進)。
-- protected_paths: 反映する範囲で反映を止めたファイル(migrationと、f/とwmill.yamlのうち保護パスに当たるもの)。1件以上。
-- requested_at: 行を作った時刻。最も新しい依頼と、最後に成功した反映との前後をこの列で決める。
-- decided_at / decision / decided_by: 判断の時刻、結果、判断した人。3つとも同時にNULLか、同時にNULLでない。
--
-- 反映はsync pushの後にmigrate upの順なので、この表を読むself_updateが先に反映され、次の回から表を読む。
-- この表を作る変更は、判定を持たない旧版のself_updateが反映する。
-- 新しい表の作成にロックの競合はほぼ無いが、止まった書き込みがあればmigrationは失敗する(self_updateが再試行する)。
BEGIN;

SET LOCAL lock_timeout = '30s';

CREATE TABLE factory.deploy_approvals (
    sha char(40) PRIMARY KEY,
    protected_paths text[] NOT NULL,
    requested_at timestamptz NOT NULL DEFAULT now(),
    decided_at timestamptz,
    decision text,
    decided_by text,
    CONSTRAINT deploy_approvals_sha_check CHECK (sha ~ '^[0-9a-f]{40}$'),
    CONSTRAINT deploy_approvals_paths_check CHECK (cardinality(protected_paths) > 0),
    CONSTRAINT deploy_approvals_decision_check CHECK (decision IN ('approved', 'rejected')),
    CONSTRAINT deploy_approvals_decided_check CHECK (
        (decision IS NULL) = (decided_at IS NULL) AND (decision IS NULL) = (decided_by IS NULL)
    ),
    CONSTRAINT deploy_approvals_decided_by_check CHECK (
        decided_by IS NULL OR char_length(decided_by) BETWEEN 1 AND 100
    )
);

CREATE INDEX deploy_approvals_requested_at_idx ON factory.deploy_approvals (requested_at);

COMMENT ON TABLE factory.deploy_approvals IS
    '保護パスに触れた変更の反映の、HEADのshaごとの承認。self_updateはapprovedの行の版だけを反映する。判断の対象は、最後に成功した反映より後の、最も新しい行だけである。';

END;
