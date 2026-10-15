// `20261015120000_pr_conflict_fix`のmigrationが、競合を直す回のために、競合の記録と作業項目へ列、制約、索引を足し、
// downが逆順に落とすことを静的に確かめる。
// 実際に適用して戻せること、制約が効くことは`mise run test:db`が確かめる。

import { describe, expect, test } from "bun:test";

const DIR = "migrations/datatable/main";
const UP = `${DIR}/20261015120000_pr_conflict_fix.up.sql`;
const DOWN = `${DIR}/20261015120000_pr_conflict_fix.down.sql`;

describe("20261015120000_pr_conflict_fix.up.sql", () => {
  test("starts a transaction", async () => {
    expect(await Bun.file(UP).text()).toContain("BEGIN;");
  });

  test("ends the transaction", async () => {
    expect((await Bun.file(UP).text()).trimEnd().endsWith("END;")).toBe(true);
  });

  test("gives up waiting for a lock after 30 seconds", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "SET LOCAL lock_timeout = '30s';",
    );
  });

  test("adds fix_work_item_id as a nullable bigint", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "ADD COLUMN fix_work_item_id bigint,",
    );
  });

  test("adds fix_attempts as a counter starting at zero", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "ADD COLUMN fix_attempts integer NOT NULL DEFAULT 0,",
    );
  });

  test("rejects a negative fix_attempts", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "ADD CONSTRAINT pr_conflict_checks_fix_attempts_check CHECK (fix_attempts >= 0)",
    );
  });

  test("adds fix_hold_reason as nullable text", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "ADD COLUMN fix_hold_reason text,",
    );
  });

  test("limits fix_hold_reason to 64 characters", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "ADD CONSTRAINT pr_conflict_checks_fix_hold_reason_length_check CHECK (char_length(fix_hold_reason) <= 64)",
    );
  });

  test("rejects an empty fix_hold_reason", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "ADD CONSTRAINT pr_conflict_checks_fix_hold_reason_check CHECK (fix_hold_reason <> '')",
    );
  });

  test("adds episode_started_at defaulting to the time of insertion", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "ADD COLUMN episode_started_at timestamptz NOT NULL DEFAULT now(),",
    );
  });

  test("adds conflict_check_id to work_items as a nullable bigint", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "ADD COLUMN conflict_check_id bigint,",
    );
  });

  test("adds conflict_episode to work_items as a nullable integer", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "ADD COLUMN conflict_episode integer,",
    );
  });

  test("forbids a work item from belonging to both a CI round and a conflict round", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "ADD CONSTRAINT work_items_conflict_check_id_exclusive_check CHECK (conflict_check_id IS NULL OR ci_check_id IS NULL)",
    );
  });

  test("requires conflict_check_id and conflict_episode to be set together", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "ADD CONSTRAINT work_items_conflict_episode_check CHECK ((conflict_check_id IS NULL) = (conflict_episode IS NULL))",
    );
  });

  test("requires conflict_check_id to be positive", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "ADD CONSTRAINT work_items_conflict_check_id_min_check CHECK (conflict_check_id > 0)",
    );
  });

  test("requires conflict_episode to be at least 1", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "ADD CONSTRAINT work_items_conflict_episode_min_check CHECK (conflict_episode >= 1)",
    );
  });

  test("indexes only the work items that belong to a conflict round", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "CREATE INDEX work_items_conflict_check_id_idx ON factory.work_items (conflict_check_id) WHERE conflict_check_id IS NOT NULL;",
    );
  });

  test("does not change the state check", async () => {
    expect(await Bun.file(UP).text()).not.toContain(
      "pr_conflict_checks_state_check",
    );
  });

  test("has no foreign key", async () => {
    expect(await Bun.file(UP).text()).not.toContain("REFERENCES");
  });

  test("keeps the comments in Japanese", async () => {
    expect(await Bun.file(UP).text()).toMatch(/--.*[぀-ヿ一-鿿]/);
  });
});

describe("20261015120000_pr_conflict_fix.down.sql", () => {
  test("starts a transaction", async () => {
    expect(await Bun.file(DOWN).text()).toContain("BEGIN;");
  });

  test("ends the transaction", async () => {
    expect((await Bun.file(DOWN).text()).trimEnd().endsWith("END;")).toBe(true);
  });

  test("gives up waiting for a lock after 30 seconds", async () => {
    expect(await Bun.file(DOWN).text()).toContain(
      "SET LOCAL lock_timeout = '30s';",
    );
  });

  test("drops the conflict_check_id index", async () => {
    expect(await Bun.file(DOWN).text()).toContain(
      "DROP INDEX factory.work_items_conflict_check_id_idx;",
    );
  });

  test("drops the constraints of work_items before its columns", async () => {
    expect(await Bun.file(DOWN).text()).toContain(
      "ALTER TABLE factory.work_items\n    DROP CONSTRAINT work_items_conflict_episode_min_check,\n    DROP CONSTRAINT work_items_conflict_check_id_min_check,\n    DROP CONSTRAINT work_items_conflict_episode_check,\n    DROP CONSTRAINT work_items_conflict_check_id_exclusive_check,\n    DROP COLUMN conflict_episode,\n    DROP COLUMN conflict_check_id;",
    );
  });

  test("drops the constraints of pr_conflict_checks before its columns", async () => {
    expect(await Bun.file(DOWN).text()).toContain(
      "ALTER TABLE factory.pr_conflict_checks\n    DROP CONSTRAINT pr_conflict_checks_fix_hold_reason_check,\n    DROP CONSTRAINT pr_conflict_checks_fix_hold_reason_length_check,\n    DROP CONSTRAINT pr_conflict_checks_fix_attempts_check,\n    DROP COLUMN episode_started_at,\n    DROP COLUMN fix_hold_reason,\n    DROP COLUMN fix_attempts,\n    DROP COLUMN fix_work_item_id;",
    );
  });

  test("says when the rollback may run", async () => {
    expect(await Bun.file(DOWN).text()).toContain(
      "-- コードを戻し、競合を直す回が終端になってから実行する。",
    );
  });

  test("drops the conflict_check_id index before altering any table", async () => {
    const text = await Bun.file(DOWN).text();
    expect(text.indexOf("DROP INDEX")).toBeLessThan(
      text.indexOf("ALTER TABLE"),
    );
  });
});
