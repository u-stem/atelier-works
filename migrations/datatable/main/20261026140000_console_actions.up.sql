-- up migration: console_actions
--
-- Consoleから行った操作の記録の表を作る。「誰が、いつ、何を、どの対象に、どう変えようとして、どうなったか」を残す。
-- 操作の前にoutcome=attemptedの行を入れ、操作の後にoutcomeを更新する。
-- 行を入れられなければ、操作は拒否する(閉じる側に倒す)。更新に失敗しても操作は取り消さない。
--
-- actor: 操作者。ジョブの実行コンテキスト(WM_USERNAMEかWM_EMAIL)から導いた識別子で、呼び出し側の引数ではない。
-- action: 操作の名前。小文字の英数字と_。
-- target: 操作の対象。script path、owner/repo#number、設定のキーなど、識別子だけ。
-- changes: 変えたキーと値だけのJSONオブジェクト。設定の全体や、reasonなどの自由な文字列は入れない。
--   複数の段の操作では、段ごとの結果をキーにして入れる。
-- outcome: attempted(試みた。更新されないまま残った行は、画面で不明と出す)、succeeded、failed、
--   partial(複数の段の操作で、途中まで進んだ)。
-- occurred_at: 行を入れた時刻。保持は90日で、削除は記録を書き始めるPRがcleanup_dbに足す。
--
-- この表は、defaultのworkerと管理者が書ける。改ざんに耐える記録ではなく、誤操作の追跡のためである。
--
-- 反映はsync pushの後にmigrate upの順なので、コードが先に反映され、表の無い時間ができる。
-- 表を読み書きするコードは、表が無いこと(missing_table)を、操作の拒否か記録の失敗として扱う。
-- 新しい表の作成にロックの競合はほぼ無いが、止まった書き込みがあればmigrationは失敗する(self_updateが再試行する)。
BEGIN;

SET LOCAL lock_timeout = '30s';

CREATE TABLE factory.console_actions (
    id bigserial PRIMARY KEY,
    actor text NOT NULL,
    action text NOT NULL,
    target text NOT NULL,
    changes jsonb NOT NULL DEFAULT '{}'::jsonb,
    outcome text NOT NULL DEFAULT 'attempted',
    occurred_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT console_actions_actor_check CHECK (char_length(actor) BETWEEN 1 AND 100),
    CONSTRAINT console_actions_action_check CHECK (action ~ '^[a-z][a-z0-9_]{0,59}$'),
    CONSTRAINT console_actions_target_check CHECK (char_length(target) BETWEEN 1 AND 200),
    CONSTRAINT console_actions_changes_check CHECK (jsonb_typeof(changes) = 'object'),
    CONSTRAINT console_actions_outcome_check CHECK (outcome IN ('attempted', 'succeeded', 'failed', 'partial'))
);

CREATE INDEX console_actions_occurred_at_idx ON factory.console_actions (occurred_at);

CREATE INDEX console_actions_action_idx ON factory.console_actions (action, occurred_at DESC);

COMMENT ON TABLE factory.console_actions IS
    'Consoleから行った操作の記録。操作の前にattemptedの行を入れ、後でoutcomeを更新する。改ざんに耐えない。保持は90日。';

COMMENT ON COLUMN factory.console_actions.actor IS
    '操作者。ジョブの実行コンテキストから導いた識別子。';

COMMENT ON COLUMN factory.console_actions.changes IS
    '変えたキーと値だけ。自由な文字列と設定の全体は入れない。複数の段の操作では段ごとの結果。';

COMMENT ON COLUMN factory.console_actions.outcome IS
    'attempted(更新されないまま残ったものは不明)、succeeded、failed、partial(途中まで進んだ)。';

END;
