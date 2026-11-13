// `scripts/test-db.sh`が本物のPostgreSQLで流す2つのSQL文が、アプリの文(`f/factory/lib/db.ts`)と同じであることを確かめる。
// `test-db.sh`は、アプリの文をバインド値だけpsqlの変数に置き換えて書き写している。
// 書き写しが食い違うと、実DBの検査が、アプリの使わない文を確かめて通ってしまう。
// migrationの文面(索引の述語、取り消しの順序、ロック)は、`mise run test:db`が実DBで確かめる。

import { describe, expect, test } from "bun:test";

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
