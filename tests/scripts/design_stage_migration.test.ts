// 設計工程の土台のmigration(`20261026120000_design_stage_work_items`と`20261026120100_design_stage_approval_kind`)が、
// アプリの状態と承認依頼の種類の定義と食い違っていないかを、SQLの文面から静的に確かめる。
// 表ごとに2つに分けているのは、1つのトランザクションが2つの表のロックを取らないためである。
// 実際に適用して戻せること、制約とインデックスが効くことは`mise run test:db`が確かめる。

import { describe, expect, test } from "bun:test";
import { AUTO_RETRY_REASON_PREFIXES } from "../../f/factory/lib/auto_retry_reasons.ts";
import {
  APPROVAL_REQUEST_KINDS,
  TERMINAL_WORK_ITEM_STATUSES,
  WORK_ITEM_STATUSES,
} from "../../f/factory/lib/types.ts";

const DIR = "migrations/datatable/main";
const ITEMS_UP = `${DIR}/20261026120000_design_stage_work_items.up.sql`;
const ITEMS_DOWN = `${DIR}/20261026120000_design_stage_work_items.down.sql`;
const KIND_UP = `${DIR}/20261026120100_design_stage_approval_kind.up.sql`;
const KIND_DOWN = `${DIR}/20261026120100_design_stage_approval_kind.down.sql`;

const DESIGN_STATUSES = ["designing", "awaiting_design_approval"];
const ACTIVE_INDEXES = [
  "work_items_active_issue_key",
  "work_items_active_pr_fix_key",
  "work_items_active_dependabot_key",
];

/** 行コメントを除き、空白を1つにまとめたSQLの文面。 */
function code(sql: string): string {
  return sql.replace(/--.*$/gm, "").replace(/\s+/g, " ").trim();
}

function quotedValues(list: string): string[] {
  return [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1] ?? "");
}

/** `ADD CONSTRAINT <name>`の後ろにある最初の`IN (...)`の値を返す。 */
function checkValues(sql: string, constraint: string): string[] {
  const match = code(sql).match(
    new RegExp(`ADD CONSTRAINT ${constraint} [^()]*\\([^()]*IN \\(([^)]*)\\)`),
  );
  return quotedValues(match?.[1] ?? "");
}

/** `CREATE UNIQUE INDEX <name>`の述語にある状態の一覧を返す。 */
function indexStatuses(sql: string, indexName: string): string[] {
  const match = code(sql).match(
    new RegExp(`CREATE UNIQUE INDEX ${indexName} .*?status IN \\(([^)]*)\\)`),
  );
  return quotedValues(match?.[1] ?? "");
}

function withoutDesignStatuses(values: readonly string[]): string[] {
  return values.filter((value) => !DESIGN_STATUSES.includes(value));
}

function opening(table: string): string {
  return `BEGIN; SET LOCAL lock_timeout = '30s'; LOCK TABLE factory.${table} IN ACCESS EXCLUSIVE MODE;`;
}

describe("20261026120000_design_stage_work_items.up.sql", () => {
  test("opens with the lock timeout and one lock on work_items", async () => {
    expect(
      code(await Bun.file(ITEMS_UP).text()).startsWith(opening("work_items")),
    ).toBe(true);
  });

  test("does not touch approval_requests", async () => {
    expect(code(await Bun.file(ITEMS_UP).text())).not.toContain(
      "approval_requests",
    );
  });

  test("does not build an index concurrently", async () => {
    expect(code(await Bun.file(ITEMS_UP).text())).not.toMatch(
      /\bCONCURRENTLY\b/,
    );
  });

  test("does not use a DO block", async () => {
    expect(code(await Bun.file(ITEMS_UP).text())).not.toMatch(/\bDO\b/);
  });

  test("does not raise", async () => {
    expect(code(await Bun.file(ITEMS_UP).text())).not.toMatch(/\bRAISE\b/);
  });

  test("adds a non-negative design_attempt that starts at zero", async () => {
    expect(code(await Bun.file(ITEMS_UP).text())).toContain(
      "ADD COLUMN design_attempt integer NOT NULL DEFAULT 0 CHECK (design_attempt >= 0)",
    );
  });

  test("accepts exactly the work item statuses the code knows", async () => {
    const values = checkValues(
      await Bun.file(ITEMS_UP).text(),
      "work_items_status_check",
    );
    expect([...values].sort()).toEqual([...WORK_ITEM_STATUSES].sort());
  });

  test.each(ACTIVE_INDEXES)(
    "lists the non-terminal statuses in %s",
    async (indexName) => {
      const nonTerminal = WORK_ITEM_STATUSES.filter(
        (status) => !TERMINAL_WORK_ITEM_STATUSES.includes(status),
      );
      expect(
        indexStatuses(await Bun.file(ITEMS_UP).text(), indexName).sort(),
      ).toEqual([...nonTerminal].sort());
    },
  );

  test.each(ACTIVE_INDEXES)(
    "drops %s before it is created again",
    async (indexName) => {
      const sql = code(await Bun.file(ITEMS_UP).text());
      expect(sql.indexOf(`DROP INDEX factory.${indexName};`)).toBeLessThan(
        sql.indexOf(`CREATE UNIQUE INDEX ${indexName} `),
      );
    },
  );

  test("leaves the audit index alone", async () => {
    expect(await Bun.file(ITEMS_UP).text()).not.toContain(
      "work_items_active_audit_key",
    );
  });
});

describe("20261026120000_design_stage_work_items.down.sql", () => {
  test("opens with the lock timeout and one lock on work_items", async () => {
    expect(
      code(await Bun.file(ITEMS_DOWN).text()).startsWith(opening("work_items")),
    ).toBe(true);
  });

  test("does not touch approval_requests", async () => {
    expect(code(await Bun.file(ITEMS_DOWN).text())).not.toContain(
      "approval_requests",
    );
  });

  test("does not build an index concurrently", async () => {
    expect(code(await Bun.file(ITEMS_DOWN).text())).not.toMatch(
      /\bCONCURRENTLY\b/,
    );
  });

  test("does not use a DO block", async () => {
    expect(code(await Bun.file(ITEMS_DOWN).text())).not.toMatch(/\bDO\b/);
  });

  test("does not raise", async () => {
    expect(code(await Bun.file(ITEMS_DOWN).text())).not.toMatch(/\bRAISE\b/);
  });

  test("reads the previous status of the rows it moves under a row lock", async () => {
    expect(code(await Bun.file(ITEMS_DOWN).text())).toContain("FOR UPDATE");
  });

  test("records the previous status as from_status", async () => {
    expect(code(await Bun.file(ITEMS_DOWN).text())).toContain(
      "previous.status AS from_status",
    );
  });

  test("moves both design statuses to needs_human", async () => {
    expect(code(await Bun.file(ITEMS_DOWN).text())).toContain(
      "WHERE status IN ('designing', 'awaiting_design_approval')",
    );
  });

  test("writes a fixed note that no automatic restart recognizes", async () => {
    const note = code(await Bun.file(ITEMS_DOWN).text()).match(
      /'needs_human', '([^']+)'/,
    )?.[1];
    expect(
      AUTO_RETRY_REASON_PREFIXES.some((prefix) => note?.startsWith(prefix)),
    ).toBe(false);
  });

  test("writes a fixed note", async () => {
    const note = code(await Bun.file(ITEMS_DOWN).text()).match(
      /'needs_human', '([^']+)'/,
    )?.[1];
    expect(note).toBeDefined();
  });

  test("accepts the work item statuses without the design statuses", async () => {
    const values = checkValues(
      await Bun.file(ITEMS_DOWN).text(),
      "work_items_status_check",
    );
    expect([...values].sort()).toEqual(
      withoutDesignStatuses(WORK_ITEM_STATUSES).sort(),
    );
  });

  test("drops design_attempt", async () => {
    expect(code(await Bun.file(ITEMS_DOWN).text())).toContain(
      "DROP COLUMN design_attempt",
    );
  });

  test.each(ACTIVE_INDEXES)(
    "lists the statuses of %s without the design statuses",
    async (indexName) => {
      const nonTerminal = WORK_ITEM_STATUSES.filter(
        (status) => !TERMINAL_WORK_ITEM_STATUSES.includes(status),
      );
      expect(
        indexStatuses(await Bun.file(ITEMS_DOWN).text(), indexName).sort(),
      ).toEqual(withoutDesignStatuses(nonTerminal).sort());
    },
  );
});

describe("20261026120100_design_stage_approval_kind.up.sql", () => {
  test("opens with the lock timeout and one lock on approval_requests", async () => {
    expect(
      code(await Bun.file(KIND_UP).text()).startsWith(
        opening("approval_requests"),
      ),
    ).toBe(true);
  });

  test("does not touch work_items", async () => {
    expect(code(await Bun.file(KIND_UP).text())).not.toContain("work_items");
  });

  test("does not use a DO block", async () => {
    expect(code(await Bun.file(KIND_UP).text())).not.toMatch(/\bDO\b/);
  });

  test("does not raise", async () => {
    expect(code(await Bun.file(KIND_UP).text())).not.toMatch(/\bRAISE\b/);
  });

  test("accepts exactly the approval kinds the code knows", async () => {
    const values = checkValues(
      await Bun.file(KIND_UP).text(),
      "approval_requests_kind_check",
    );
    expect([...values].sort()).toEqual([...APPROVAL_REQUEST_KINDS].sort());
  });
});

describe("20261026120100_design_stage_approval_kind.down.sql", () => {
  test("opens with the lock timeout and one lock on approval_requests", async () => {
    expect(
      code(await Bun.file(KIND_DOWN).text()).startsWith(
        opening("approval_requests"),
      ),
    ).toBe(true);
  });

  test("does not touch work_items", async () => {
    expect(code(await Bun.file(KIND_DOWN).text())).not.toContain("work_items");
  });

  test("does not use a DO block", async () => {
    expect(code(await Bun.file(KIND_DOWN).text())).not.toMatch(/\bDO\b/);
  });

  test("does not raise", async () => {
    expect(code(await Bun.file(KIND_DOWN).text())).not.toMatch(/\bRAISE\b/);
  });

  test("does not delete approval requests", async () => {
    expect(code(await Bun.file(KIND_DOWN).text())).not.toMatch(/\bDELETE\b/);
  });

  test("accepts the approval kinds without design", async () => {
    const values = checkValues(
      await Bun.file(KIND_DOWN).text(),
      "approval_requests_kind_check",
    );
    expect([...values].sort()).toEqual(
      APPROVAL_REQUEST_KINDS.filter((kind) => kind !== "design").sort(),
    );
  });

  test("says that the kind check stops the migration while a design request remains", async () => {
    expect(await Bun.file(KIND_DOWN).text()).toContain(
      "design の承認依頼が残っていると",
    );
  });
});
