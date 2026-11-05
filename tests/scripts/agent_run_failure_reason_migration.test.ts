// `agent_run_failure_reason`のmigrationが、失敗の種類の列を足し、downが戻すことを静的に確かめる。
// 列に書けることは`mise run test:db`が確かめる。

import { describe, expect, test } from "bun:test";

const DIR = "migrations/datatable/main";
const UP = `${DIR}/20261106100000_agent_run_failure_reason.up.sql`;
const DOWN = `${DIR}/20261106100000_agent_run_failure_reason.down.sql`;

describe("20261106100000_agent_run_failure_reason.up.sql", () => {
  test("gives up waiting for a lock after 30 seconds", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "SET LOCAL lock_timeout = '30s';",
    );
  });

  test("adds failure_reason to agent_runs as a nullable text", async () => {
    expect(await Bun.file(UP).text()).toMatch(
      /ALTER TABLE factory\.agent_runs\s+ADD COLUMN failure_reason text;/,
    );
  });
});

describe("20261106100000_agent_run_failure_reason.down.sql", () => {
  test("drops failure_reason from agent_runs", async () => {
    expect(await Bun.file(DOWN).text()).toMatch(
      /ALTER TABLE factory\.agent_runs\s+DROP COLUMN failure_reason;/,
    );
  });
});
