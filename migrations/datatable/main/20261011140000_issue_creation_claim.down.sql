-- down migration: issue_creation_claim
-- Issueを作る処理の印は失われる。
BEGIN;

ALTER TABLE factory.issue_proposals DROP COLUMN issue_creation_claimed_at;

END;
