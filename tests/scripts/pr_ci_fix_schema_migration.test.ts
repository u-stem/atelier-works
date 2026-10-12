// `20261013100400_pr_ci_fix_schema`のmigrationが、CIの失敗を自動で直す仕組みの土台になる列と状態を足し、
// downが`fixing`の行を安全に落として戻すことを静的に確かめる。
// 実際に適用して戻せること、制約が効くことは`mise run test:db`が確かめる。

import { describe, expect, test } from "bun:test";
import { PR_CI_STATES } from "../../f/factory/lib/pr_ci_support.ts";

const DIR = "migrations/datatable/main";
const UP = `${DIR}/20261013100400_pr_ci_fix_schema.up.sql`;
const DOWN = `${DIR}/20261013100400_pr_ci_fix_schema.down.sql`;

function quotedValues(list: string): string[] {
  return [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1] ?? "");
}

function stateCheckStates(sql: string): string[] {
  const match = sql.match(
    /ADD CONSTRAINT pr_ci_checks_state_check\s+CHECK \(state IN \(([^)]*)\)\)/,
  );
  return quotedValues(match?.[1] ?? "");
}

describe("20261013100400_pr_ci_fix_schema.up.sql", () => {
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

  test("replaces the state check with one that accepts fixing", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "ADD CONSTRAINT pr_ci_checks_state_check\n    CHECK (state IN ('pending', 'passed', 'failed', 'superseded', 'expired', 'no_ci', 'observed', 'fixing'));",
    );
  });

  test("accepts exactly the states the code knows", async () => {
    const states = stateCheckStates(await Bun.file(UP).text());
    expect([...states].sort()).toEqual([...PR_CI_STATES].sort());
  });

  test("drops the old state check before adding the new one", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "DROP CONSTRAINT pr_ci_checks_state_check;",
    );
  });

  test("adds fix_work_item_id as a nullable bigint", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "ADD COLUMN fix_work_item_id bigint,",
    );
  });

  test("adds fix_attempts as a non-negative counter starting at zero", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "ADD COLUMN fix_attempts integer NOT NULL DEFAULT 0,",
    );
  });

  test("rejects a negative fix_attempts", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "ADD CONSTRAINT pr_ci_checks_fix_attempts_check CHECK (fix_attempts >= 0)",
    );
  });

  test("adds fix_hold_reason as nullable text", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "ADD COLUMN fix_hold_reason text,",
    );
  });

  test("limits fix_hold_reason to 64 characters", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "ADD CONSTRAINT pr_ci_checks_fix_hold_reason_length_check CHECK (char_length(fix_hold_reason) <= 64)",
    );
  });

  test("rejects an empty fix_hold_reason", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "ADD CONSTRAINT pr_ci_checks_fix_hold_reason_check CHECK (fix_hold_reason <> '')",
    );
  });

  test("adds ci_check_id to work_items as a nullable bigint", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "ALTER TABLE factory.work_items\n    ADD COLUMN ci_check_id bigint;",
    );
  });

  test("indexes only the work items that belong to a CI round", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "CREATE INDEX work_items_ci_check_id_idx ON factory.work_items (ci_check_id) WHERE ci_check_id IS NOT NULL;",
    );
  });

  test("has no foreign key", async () => {
    expect(await Bun.file(UP).text()).not.toContain("REFERENCES");
  });

  test("keeps the comments in Japanese", async () => {
    expect(await Bun.file(UP).text()).toMatch(/--.*[぀-ヿ一-鿿]/);
  });
});

describe("20261013100400_pr_ci_fix_schema.down.sql", () => {
  test("starts a transaction", async () => {
    expect(await Bun.file(DOWN).text()).toContain("BEGIN;");
  });

  test("ends the transaction", async () => {
    expect((await Bun.file(DOWN).text()).trimEnd().endsWith("END;")).toBe(true);
  });

  test("moves only fixing rows to failed", async () => {
    expect(await Bun.file(DOWN).text()).toContain("WHERE state = 'fixing'");
  });

  test("moves fixing rows to failed before narrowing the state check", async () => {
    const text = await Bun.file(DOWN).text();
    const update = text.indexOf("SET state = 'failed'");
    const narrow = text.indexOf("ADD CONSTRAINT pr_ci_checks_state_check");
    expect(update).toBeGreaterThanOrEqual(0);
    expect(update).toBeLessThan(narrow);
  });

  test("restores the state check without fixing", async () => {
    expect(await Bun.file(DOWN).text()).toContain(
      "ADD CONSTRAINT pr_ci_checks_state_check\n    CHECK (state IN ('pending', 'passed', 'failed', 'superseded', 'expired', 'no_ci', 'observed'));",
    );
  });

  test("drops the ci_check_id index", async () => {
    expect(await Bun.file(DOWN).text()).toContain(
      "DROP INDEX factory.work_items_ci_check_id_idx;",
    );
  });

  test("drops ci_check_id from work_items", async () => {
    expect(await Bun.file(DOWN).text()).toContain(
      "ALTER TABLE factory.work_items\n    DROP COLUMN ci_check_id;",
    );
  });

  test("drops the three columns of pr_ci_checks", async () => {
    expect(await Bun.file(DOWN).text()).toContain(
      "DROP COLUMN fix_hold_reason,\n    DROP COLUMN fix_attempts,\n    DROP COLUMN fix_work_item_id;",
    );
  });
});
