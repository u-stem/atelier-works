-- down migration: history_events
-- 履歴の表と、トリガー、関数を落とす。遷移の履歴は失われるが、work_item_eventsの行は変えない。
BEGIN;

SET LOCAL lock_timeout = '30s';

DROP TRIGGER history_events_record ON factory.work_item_events;

DROP TABLE factory.history_events;

DROP FUNCTION factory.history_prune_chains(timestamptz);

DROP FUNCTION factory.history_verify(bigint);

DROP FUNCTION factory.history_guard();

DROP FUNCTION factory.history_record_transition();

DROP FUNCTION factory.history_append(bigint, text, text, text, text, text, jsonb, timestamptz);

DROP FUNCTION factory.history_row_hash(text, bigint, integer, text, text, text, text, text, jsonb, timestamptz);

DROP FUNCTION factory.history_lock_key(bigint);

DROP FUNCTION factory.history_field(text);

DROP FUNCTION factory.history_reason_code(text, text);

DROP FUNCTION factory.history_reason_codes();

END;
