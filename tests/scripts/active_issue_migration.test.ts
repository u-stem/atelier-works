// `20261009120000_active_issue_key`のmigrationが、アプリの状態の定義と食い違っていないかを確かめる。
// 部分一意インデックスの述語は、終端でない状態の一覧をSQLに書き写したものである。
// `TERMINAL_WORK_ITEM_STATUSES`を変えたのにmigrationを足さないと、
// 新しく稼働中になる状態がインデックスの対象から漏れる。
// 述語の検査は、インデックスを最後に作り直した`20261026120000_design_stage`のmigrationを読む。
// 後のmigrationがこのインデックスをまた作り直したときは、読む対象と期待する述語をそれに合わせて更新すること。
// 述語以外の検査は、最初に作ったmigrationのファイルを読む。

import { describe, expect, test } from "bun:test";
import {
  TERMINAL_WORK_ITEM_STATUSES,
  WORK_ITEM_STATUSES,
} from "../../f/factory/lib/types.ts";

const UP = "migrations/datatable/main/20261009120000_active_issue_key.up.sql";
const DOWN =
  "migrations/datatable/main/20261009120000_active_issue_key.down.sql";
const INDEXES_UP =
  "migrations/datatable/main/20261026120000_design_stage.up.sql";

async function upSql(): Promise<string> {
  return Bun.file(UP).text();
}

function indexPredicateStatuses(sql: string): string[] {
  const match = sql.match(
    /CREATE UNIQUE INDEX work_items_active_issue_key[\s\S]*?status IN \(([^)]*)\)/,
  );
  const list = match?.[1] ?? "";
  return [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1] ?? "");
}

describe("20261009120000_active_issue_key.up.sql", () => {
  test("creates the partial unique index over owner, repo and issue_number", async () => {
    expect(await upSql()).toContain(
      "ON factory.work_items (owner, repo, issue_number)",
    );
  });

  test("limits the index to issue-kind work items", async () => {
    expect(await upSql()).toContain("WHERE kind = 'issue' AND status IN (");
  });

  test("lists exactly the statuses that are not terminal", async () => {
    const nonTerminal = WORK_ITEM_STATUSES.filter(
      (status) => !TERMINAL_WORK_ITEM_STATUSES.includes(status),
    );
    expect(
      indexPredicateStatuses(await Bun.file(INDEXES_UP).text()).sort(),
    ).toEqual([...nonTerminal].sort());
  });

  test("cancels older duplicate active rows before creating the index", async () => {
    const sql = await upSql();
    expect(sql.indexOf("'cancelled'")).toBeLessThan(
      sql.indexOf("CREATE UNIQUE INDEX work_items_active_issue_key"),
    );
  });
});

describe("20261009120000_active_issue_key.up.sql safeguards", () => {
  test("fails loudly instead of waiting forever for the table lock", async () => {
    const sql = await upSql();
    const afterBegin = sql
      .slice(sql.indexOf("BEGIN;") + "BEGIN;".length)
      .trim();
    expect(afterBegin.startsWith("SET LOCAL lock_timeout = '30s';")).toBe(true);
  });

  test("locks the table right after the lock timeout so that no insert slips in before the index exists", async () => {
    const sql = await upSql();
    const afterTimeout = sql
      .slice(sql.indexOf("SET LOCAL lock_timeout = '30s';") + 31)
      .trim();
    expect(
      afterTimeout.startsWith(
        "LOCK TABLE factory.work_items IN SHARE ROW EXCLUSIVE MODE;",
      ),
    ).toBe(true);
  });

  test("cancels only rows that still have the status it ranked", async () => {
    expect(await upSql()).toContain("wi.status = ranked.status");
  });

  test("expires the pending approval requests of the rows it cancels", async () => {
    expect(await upSql()).toContain("UPDATE factory.approval_requests");
  });

  test("restricts the expiry to pending requests", async () => {
    expect(await upSql()).toContain("ar.status = 'pending'");
  });

  test("says that the cancel rule is automatic and not confirmed by a person", async () => {
    expect(await upSql()).toContain("not confirmed by a person");
  });
});

describe("20261009120000_active_issue_key.down.sql", () => {
  test("drops the index", async () => {
    expect(await Bun.file(DOWN).text()).toContain(
      "DROP INDEX factory.work_items_active_issue_key",
    );
  });
});

describe("the migration for approved rows with a newer cycle", () => {
  test("cancels approved issue rows that have a newer cycle of the same issue", async () => {
    expect(await upSql()).toContain("n.cycle > wi.cycle");
  });

  test("restricts that cancelling to approved issue rows", async () => {
    expect(await upSql()).toContain(
      "wi.kind = 'issue' AND wi.status = 'approved'",
    );
  });

  test("records an event for each approved row it cancels", async () => {
    expect(await upSql()).toContain(
      "approved work item cancelled by migration: a newer cycle exists",
    );
  });

  test("runs that cancelling before the index is created", async () => {
    const sql = await upSql();
    expect(sql.indexOf("n.cycle > wi.cycle")).toBeLessThan(
      sql.indexOf("CREATE UNIQUE INDEX work_items_active_issue_key"),
    );
  });
});

describe("the down migration", () => {
  test("says that the cancelled rows are not restored", async () => {
    expect(await Bun.file(DOWN).text()).toContain("not restored");
  });
});

describe("the sweep statement checked by scripts/test-db.sh", () => {
  // `scripts/test-db.sh`は、`supersedeApprovedIssueWorkItems`の文を本物のPostgreSQLで
  // 確かめるために、同じ文を書き写している。バインド値をpsqlの変数に置き換えたうえで、
  // 文の全体が一致することを確かめ、食い違いを防ぐ。
  const SWEEP_START = "WITH cancelled AS (";

  // アプリの文のバインド値の書き方(ドル記号と波括弧)をリテラルで書くと、lintの警告が出るため組み立てる。
  const bound = (expression: string): string => `$\{${expression}}`;

  const PLACEHOLDERS: readonly [string, string][] = [
    [bound("target.owner"), ":'owner'"],
    [bound("target.repo"), ":'repo'"],
    [`${bound("target.issue_number")}::integer`, ":'issue'::integer"],
    [`${bound("target.cycle")}::integer`, ":'cycle'::integer"],
    [`${bound("newWorkItemId")}::bigint`, ":'new_id'::bigint"],
    [`${bound("jobIds.job_id")}::text`, ":'job_id'::text"],
    [`${bound("jobIds.root_job_id")}::text`, ":'root_job_id'::text"],
  ];

  function normalize(text: string): string {
    return text.replace(/\s+/g, " ").replace(/;\s*$/, "").trim();
  }

  function sweepFromApp(source: string): string {
    const start = source.indexOf(SWEEP_START);
    const end = source.indexOf("`.fetch()", start);
    let text = source.slice(start, end);
    for (const [from, to] of PLACEHOLDERS) text = text.split(from).join(to);
    return normalize(text);
  }

  function sweepFromScript(source: string): string {
    const start = source.indexOf(SWEEP_START);
    const end = source.indexOf("\nSQL", start);
    return normalize(source.slice(start, end));
  }

  test("is the same statement as the application code", async () => {
    const app = await Bun.file("f/factory/lib/db.ts").text();
    const script = await Bun.file("scripts/test-db.sh").text();
    expect(sweepFromScript(script)).toBe(sweepFromApp(app));
  });

  test("keeps the cycle comparison that states the intent of the sweep", async () => {
    const app = await Bun.file("f/factory/lib/db.ts").text();
    expect(sweepFromApp(app)).toContain("wi.cycle < :'cycle'::integer");
  });

  test("replaces every bound value in the application statement", async () => {
    const app = await Bun.file("f/factory/lib/db.ts").text();
    expect(sweepFromApp(app)).not.toContain("$" + "{");
  });
});

describe("the newest newer cycle query checked by scripts/test-db.sh", () => {
  // `scripts/test-db.sh`は、`newestNewerIssueCycle`の問い合わせを本物のPostgreSQLで
  // 確かめるために、同じ文を書き写している。バインド値をpsqlの変数に置き換えて、全体の一致を確かめる。
  const START = "SELECT id, status FROM factory.work_items";

  const bound = (expression: string): string => `$\{${expression}}`;

  const PLACEHOLDERS: readonly [string, string][] = [
    [bound("owner"), ":'owner'"],
    [bound("repo"), ":'repo'"],
    [`${bound("issueNumber")}::integer`, ":'issue'::integer"],
    [`${bound("cycle")}::integer`, ":'cycle'::integer"],
  ];

  function normalize(text: string): string {
    return text.replace(/\s+/g, " ").replace(/;\s*$/, "").trim();
  }

  test("is the same statement as the application code", async () => {
    const app = await Bun.file("f/factory/lib/db.ts").text();
    const script = await Bun.file("scripts/test-db.sh").text();
    let fromApp = app.slice(
      app.indexOf(
        START,
        app.indexOf("export async function newestNewerIssueCycle"),
      ),
    );
    fromApp = fromApp.slice(0, fromApp.indexOf("`.fetch()"));
    for (const [from, to] of PLACEHOLDERS)
      fromApp = fromApp.split(from).join(to);
    const fromScript = script.slice(script.indexOf(START));
    expect(normalize(fromScript.slice(0, fromScript.indexOf("\nSQL")))).toBe(
      normalize(fromApp),
    );
  });
});
