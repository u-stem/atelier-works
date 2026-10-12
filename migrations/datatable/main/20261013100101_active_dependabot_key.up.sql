-- up migration: active_dependabot_key
--
-- At most one dependabot-kind work item may be active (not terminal) per
-- (owner, repo, pr_number). The dependabot poller inserts with
-- ON CONFLICT DO NOTHING, so two instances that share this database cannot
-- both start the same pull request.
--
-- The status list is every status that is not in TERMINAL_WORK_ITEM_STATUSES
-- (f/factory/lib/types.ts) and is the same list as work_items_active_issue_key.
-- tests/scripts/active_dependabot_migration.test.ts checks that they stay in
-- sync. Changing the terminal set needs a new migration that recreates both
-- indexes.
--
-- A dependabot row always has a pr_number. A NULL pr_number would never
-- conflict (NULLs are distinct in a unique index), as with issue_number in
-- work_items_active_issue_key.
--
-- This migration does not rewrite rows. If duplicate active rows existed,
-- CREATE UNIQUE INDEX would fail and the migration would stop loudly.
BEGIN;

CREATE UNIQUE INDEX work_items_active_dependabot_key
    ON factory.work_items (owner, repo, pr_number)
    WHERE kind = 'dependabot' AND status IN (
        'picked', 'requirements_generating', 'awaiting_approval',
        'implementing', 'reviewing', 'fixing', 'auditing'
    );

END;
