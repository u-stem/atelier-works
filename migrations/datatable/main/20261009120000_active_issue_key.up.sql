-- up migration: active_issue_key
--
-- At most one issue-kind work item may be active (not terminal) per
-- (owner, repo, issue_number). poll_issues.ts and manual_intake_register.ts
-- insert with ON CONFLICT DO NOTHING, so two instances that share this
-- database cannot both start the same issue even though
-- nextCycleForIssue() reads MAX(cycle) outside the insert transaction.
--
-- The status list is every status that is not in TERMINAL_WORK_ITEM_STATUSES
-- (f/factory/lib/types.ts). tests/scripts/active_issue_migration.test.ts
-- checks that the two stay in sync. Changing the terminal set needs a new
-- migration that recreates this index.
--
-- Existing duplicates would make CREATE UNIQUE INDEX fail, so the older
-- duplicate active rows (all but the highest cycle, then the highest id) are
-- cancelled first, each with a work_item_events row. A cancelled row is
-- terminal, so a running flow for it stops at its next lease check.
BEGIN;

WITH ranked AS (
    SELECT
        id,
        status,
        row_number() OVER (
            PARTITION BY owner, repo, issue_number
            ORDER BY cycle DESC, id DESC
        ) AS rn
    FROM factory.work_items
    WHERE kind = 'issue'
      AND status IN (
        'picked', 'requirements_generating', 'awaiting_approval',
        'implementing', 'reviewing', 'fixing', 'auditing'
      )
),
cancelled AS (
    UPDATE factory.work_items AS wi
    SET status = 'cancelled', updated_at = now()
    FROM ranked
    WHERE wi.id = ranked.id AND ranked.rn > 1
    RETURNING wi.id, ranked.status AS from_status
)
INSERT INTO factory.work_item_events (work_item_id, from_status, to_status, note)
SELECT id, from_status, 'cancelled', 'duplicate active issue work item cancelled by migration'
FROM cancelled;

CREATE UNIQUE INDEX work_items_active_issue_key
    ON factory.work_items (owner, repo, issue_number)
    WHERE kind = 'issue' AND status IN (
        'picked', 'requirements_generating', 'awaiting_approval',
        'implementing', 'reviewing', 'fixing', 'auditing'
    );

END;
