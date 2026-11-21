-- down migration: config_snapshot
-- 理由コードの一覧を、元の4つに戻す。
-- 追記専用の表の行は消せないので、足した理由コードの行が残る。残った行は、表のCHECKを再び評価されないので、そのまま読める。
-- その状態で、元の4つの一覧では、同じ理由コードの行を新しく足せない。
BEGIN;

SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION factory.config_history_reason_codes() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $fn$
    SELECT ARRAY[
        'console_update',
        'console_update_unverified',
        'stop_all_flag_off',
        'unspecified'
    ]::text[]
$fn$;

COMMENT ON COLUMN factory.config_history.source IS
    '書いた経路。console(Consoleの設定の更新)、stop_all(Consoleの全停止)、out_of_band(Consoleの外の変更。定期の照合が書くために予約)。';

END;
