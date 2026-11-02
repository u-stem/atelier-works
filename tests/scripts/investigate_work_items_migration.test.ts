// 調査(`investigate`)の作業項目の土台のmigration(`20261102120000_investigate_work_items`)が、
// アプリの種別と状態の定義と食い違っていないかを、SQLの文面から静的に確かめる。
// 実際に適用して戻せること、制約とインデックスが効くことは`mise run test:db`が確かめる。

import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import {
  TERMINAL_WORK_ITEM_STATUSES,
  WORK_ITEM_KINDS,
  WORK_ITEM_STATUSES,
} from "../../f/factory/lib/types.ts";

const DIR = "migrations/datatable/main";
const NAME = "20261102120000_investigate_work_items";
const UP = `${DIR}/${NAME}.up.sql`;
const DOWN = `${DIR}/${NAME}.down.sql`;

const INVESTIGATE_STATUSES = ["investigating", "investigated"];

/** 稼働中(終端でない)の状態。一意インデックスの述語に書き写す一覧。 */
const ACTIVE_STATUSES = [
  "picked",
  "requirements_generating",
  "awaiting_approval",
  "implementing",
  "reviewing",
  "fixing",
  "auditing",
  "designing",
  "awaiting_design_approval",
  "investigating",
];

/** このmigrationが作り直す稼働中の一意インデックス。 */
const REBUILT_INDEXES = [
  {
    name: "work_items_active_issue_key",
    columns: "owner, repo, issue_number",
    kind: "issue",
  },
  {
    name: "work_items_active_pr_fix_key",
    columns: "owner, repo, pr_number",
    kind: "pr_fix",
  },
  {
    name: "work_items_active_dependabot_key",
    columns: "owner, repo, pr_number",
    kind: "dependabot",
  },
  {
    name: "work_items_active_pr_review_key",
    columns: "lower(owner), lower(repo), pr_number",
    kind: "pr_review",
  },
];

/** 行を消すと連鎖して消える子の表。`ON DELETE CASCADE`の外部キーを持つ表と、それを経由して消える表。 */
const CASCADED_TABLES = [
  "work_item_events",
  "requirement_drafts",
  "approvals",
  "agent_runs",
  "reviews",
  "fix_rounds",
  "issue_proposals",
  "approval_requests",
  "audit_reports",
  "implement_rounds",
  "design_drafts",
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

/** `CREATE UNIQUE INDEX <name>`の文を返す。 */
function indexStatement(sql: string, indexName: string): string {
  const match = code(sql).match(
    new RegExp(`CREATE UNIQUE INDEX ${indexName} [^;]*;`),
  );
  return match?.[0] ?? "";
}

/** `CREATE UNIQUE INDEX <name>`の述語にある状態の一覧を返す。 */
function indexStatuses(sql: string, indexName: string): string[] {
  const match = indexStatement(sql, indexName).match(/status IN \(([^)]*)\)/);
  return quotedValues(match?.[1] ?? "");
}

/** `v_lead_time`の`WHERE status IN (...)`にある状態の一覧を返す。 */
function leadTimeStatuses(sql: string): string[] {
  const match = code(sql).match(
    /CREATE OR REPLACE VIEW factory\.v_lead_time .*? WHERE status IN \(([^)]*)\)/,
  );
  return quotedValues(match?.[1] ?? "");
}

function opening(): string {
  return "BEGIN; SET LOCAL lock_timeout = '30s'; LOCK TABLE factory.work_items IN ACCESS EXCLUSIVE MODE;";
}

function withoutInvestigate(values: readonly string[]): string[] {
  return values.filter(
    (value) => value !== "investigate" && !INVESTIGATE_STATUSES.includes(value),
  );
}

describe("the work item vocabulary the migration is written against", () => {
  test("has the ten active statuses", () => {
    const nonTerminal = WORK_ITEM_STATUSES.filter(
      (status) => !TERMINAL_WORK_ITEM_STATUSES.includes(status),
    );
    expect([...nonTerminal].sort()).toEqual([...ACTIVE_STATUSES].sort());
  });
});

describe(`${NAME}.up.sql`, () => {
  test("opens with the lock timeout and one lock on work_items", async () => {
    expect(code(await Bun.file(UP).text()).startsWith(opening())).toBe(true);
  });

  test("alters only work_items", async () => {
    const tables = [
      ...code(await Bun.file(UP).text()).matchAll(/ALTER TABLE (\S+)/g),
    ].map((m) => m[1]);
    expect([...new Set(tables)]).toEqual(["factory.work_items"]);
  });

  test("does not build an index concurrently", async () => {
    expect(code(await Bun.file(UP).text())).not.toMatch(/\bCONCURRENTLY\b/);
  });

  test("does not use a DO block", async () => {
    expect(code(await Bun.file(UP).text())).not.toMatch(/\bDO\b/);
  });

  test("does not raise", async () => {
    expect(code(await Bun.file(UP).text())).not.toMatch(/\bRAISE\b/);
  });

  test("does not rewrite any row", async () => {
    expect(code(await Bun.file(UP).text())).not.toMatch(
      /\b(INSERT|UPDATE|DELETE)\b/,
    );
  });

  test("accepts exactly the work item kinds the code knows", async () => {
    const values = checkValues(
      await Bun.file(UP).text(),
      "work_items_kind_check",
    );
    expect([...values].sort()).toEqual([...WORK_ITEM_KINDS].sort());
  });

  test("accepts exactly the work item statuses the code knows", async () => {
    const values = checkValues(
      await Bun.file(UP).text(),
      "work_items_status_check",
    );
    expect([...values].sort()).toEqual([...WORK_ITEM_STATUSES].sort());
  });

  test.each(REBUILT_INDEXES)(
    "lists the ten active statuses in $name",
    async ({ name }) => {
      expect(indexStatuses(await Bun.file(UP).text(), name).sort()).toEqual(
        [...ACTIVE_STATUSES].sort(),
      );
    },
  );

  test.each(REBUILT_INDEXES)(
    "keeps the key and the kind of $name",
    async ({ name, columns, kind }) => {
      const statement = indexStatement(await Bun.file(UP).text(), name);
      expect(statement).toContain(
        `ON factory.work_items (${columns}) WHERE kind = '${kind}' AND status IN (`,
      );
    },
  );

  test.each(REBUILT_INDEXES)(
    "drops $name before it is created again",
    async ({ name }) => {
      const sql = code(await Bun.file(UP).text());
      expect(sql.indexOf(`DROP INDEX factory.${name};`)).toBeLessThan(
        sql.indexOf(`CREATE UNIQUE INDEX ${name} `),
      );
    },
  );

  test("creates the investigate index over the lowercased owner and repo and the issue number", async () => {
    expect(
      indexStatement(
        await Bun.file(UP).text(),
        "work_items_active_investigate_key",
      ),
    ).toContain(
      "ON factory.work_items (lower(owner), lower(repo), issue_number) WHERE kind = 'investigate' AND status IN (",
    );
  });

  test("lists the ten active statuses in the investigate index", async () => {
    expect(
      indexStatuses(
        await Bun.file(UP).text(),
        "work_items_active_investigate_key",
      ).sort(),
    ).toEqual([...ACTIVE_STATUSES].sort());
  });

  test("does not drop the investigate index it creates", async () => {
    expect(code(await Bun.file(UP).text())).not.toContain(
      "DROP INDEX factory.work_items_active_investigate_key",
    );
  });

  test("leaves the audit index alone", async () => {
    expect(await Bun.file(UP).text()).not.toContain(
      "work_items_active_audit_key",
    );
  });

  test("lists exactly the terminal statuses in v_lead_time", async () => {
    expect(leadTimeStatuses(await Bun.file(UP).text()).sort()).toEqual(
      [...TERMINAL_WORK_ITEM_STATUSES].sort(),
    );
  });

  test("keeps the columns of v_lead_time", async () => {
    expect(code(await Bun.file(UP).text())).toContain(
      "SELECT id AS work_item_id, owner, repo, issue_number, status, created_at, updated_at, extract(epoch FROM (updated_at - created_at)) AS lead_time_seconds FROM factory.work_items",
    );
  });
});

describe(`${NAME}.down.sql`, () => {
  test("opens with the lock timeout and one lock on work_items", async () => {
    expect(code(await Bun.file(DOWN).text()).startsWith(opening())).toBe(true);
  });

  test("alters only work_items", async () => {
    const tables = [
      ...code(await Bun.file(DOWN).text()).matchAll(/ALTER TABLE (\S+)/g),
    ].map((m) => m[1]);
    expect([...new Set(tables)]).toEqual(["factory.work_items"]);
  });

  test("does not build an index concurrently", async () => {
    expect(code(await Bun.file(DOWN).text())).not.toMatch(/\bCONCURRENTLY\b/);
  });

  test("does not use a DO block", async () => {
    expect(code(await Bun.file(DOWN).text())).not.toMatch(/\bDO\b/);
  });

  test("does not raise", async () => {
    expect(code(await Bun.file(DOWN).text())).not.toMatch(/\bRAISE\b/);
  });

  test("deletes the investigate rows, and only those", async () => {
    const deletes = [
      ...code(await Bun.file(DOWN).text()).matchAll(/DELETE [^;]*;/g),
    ].map((m) => m[0]);
    expect(deletes).toEqual([
      "DELETE FROM factory.work_items WHERE kind = 'investigate';",
    ]);
  });

  test("deletes the investigate rows before it narrows the kind check", async () => {
    const sql = code(await Bun.file(DOWN).text());
    expect(sql.indexOf("DELETE FROM factory.work_items")).toBeLessThan(
      sql.indexOf("ADD CONSTRAINT work_items_kind_check"),
    );
  });

  test("deletes the investigate rows before it narrows the status check", async () => {
    const sql = code(await Bun.file(DOWN).text());
    expect(sql.indexOf("DELETE FROM factory.work_items")).toBeLessThan(
      sql.indexOf("ADD CONSTRAINT work_items_status_check"),
    );
  });

  test("accepts the work item kinds without investigate", async () => {
    const values = checkValues(
      await Bun.file(DOWN).text(),
      "work_items_kind_check",
    );
    expect([...values].sort()).toEqual(
      withoutInvestigate(WORK_ITEM_KINDS).sort(),
    );
  });

  test("accepts the work item statuses without the investigate statuses", async () => {
    const values = checkValues(
      await Bun.file(DOWN).text(),
      "work_items_status_check",
    );
    expect([...values].sort()).toEqual(
      withoutInvestigate(WORK_ITEM_STATUSES).sort(),
    );
  });

  test.each(REBUILT_INDEXES)(
    "lists the nine statuses of $name without investigating",
    async ({ name }) => {
      expect(indexStatuses(await Bun.file(DOWN).text(), name).sort()).toEqual(
        withoutInvestigate(ACTIVE_STATUSES).sort(),
      );
    },
  );

  test.each(REBUILT_INDEXES)(
    "restores the key and the kind of $name",
    async ({ name, columns, kind }) => {
      expect(indexStatement(await Bun.file(DOWN).text(), name)).toContain(
        `ON factory.work_items (${columns}) WHERE kind = '${kind}' AND status IN (`,
      );
    },
  );

  test("drops the investigate index", async () => {
    expect(code(await Bun.file(DOWN).text())).toContain(
      "DROP INDEX factory.work_items_active_investigate_key;",
    );
  });

  test("does not create the investigate index again", async () => {
    expect(code(await Bun.file(DOWN).text())).not.toContain(
      "CREATE UNIQUE INDEX work_items_active_investigate_key",
    );
  });

  test("lists the terminal statuses without investigated in v_lead_time", async () => {
    expect(leadTimeStatuses(await Bun.file(DOWN).text()).sort()).toEqual(
      withoutInvestigate(TERMINAL_WORK_ITEM_STATUSES).sort(),
    );
  });

  test.each(CASCADED_TABLES)(
    "names %s, whose rows go with the work items, in the comment",
    async (table) => {
      const comment = (await Bun.file(DOWN).text())
        .split("\n")
        .filter((line) => line.startsWith("--"))
        .join("\n");
      expect(comment).toContain(table);
    },
  );

  test("names the table whose rows keep a null reference in the comment", async () => {
    expect(await Bun.file(DOWN).text()).toContain("job_failures");
  });

  test("warns that the history of the daily budget goes with the agent runs", async () => {
    expect(await Bun.file(DOWN).text()).toContain("日次予算");
  });
});

describe("the tables that the down migration names", () => {
  /** `ON DELETE CASCADE`で`work_items`を直接参照する表を、`CREATE TABLE`のmigrationから集める。 */
  async function directlyCascadedTables(): Promise<string[]> {
    const files = readdirSync(DIR)
      .filter((name) => name.endsWith(".up.sql"))
      .sort();
    const tables = new Set<string>();
    for (const file of files) {
      let current: string | null = null;
      const sql = await Bun.file(`${DIR}/${file}`).text();
      for (const line of sql.split("\n")) {
        const table = line.match(/^(?:CREATE|ALTER) TABLE factory\.(\w+)/);
        if (table !== null) current = table[1] ?? null;
        if (
          current !== null &&
          /REFERENCES factory\.work_items \(id\) ON DELETE CASCADE/.test(line)
        ) {
          tables.add(current);
        }
      }
    }
    return [...tables];
  }

  test("include every table that references work_items with ON DELETE CASCADE", async () => {
    const missing = (await directlyCascadedTables()).filter(
      (table) => !CASCADED_TABLES.includes(table),
    );
    expect(missing).toEqual([]);
  });
});
