-- down migration: active_dependabot_key
BEGIN;

DROP INDEX factory.work_items_active_dependabot_key;

END;
