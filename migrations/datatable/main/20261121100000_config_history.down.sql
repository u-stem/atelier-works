-- down migration: config_history
-- 設定の履歴の表と、トリガー、関数を落とす。設定の履歴は失われる。
BEGIN;

SET LOCAL lock_timeout = '30s';

DROP TABLE factory.config_history;

DROP FUNCTION factory.config_history_verify();

DROP FUNCTION factory.config_history_guard();

DROP FUNCTION factory.config_history_append(text, text, jsonb, jsonb, text, text, timestamptz);

DROP FUNCTION factory.config_history_lock_key();

DROP FUNCTION factory.config_history_row_hash(text, integer, text, text, jsonb, jsonb, text, text, timestamptz);

DROP FUNCTION factory.config_history_field(text);

DROP FUNCTION factory.config_history_reason_codes();

END;
