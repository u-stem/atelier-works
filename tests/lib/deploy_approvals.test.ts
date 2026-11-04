// 承認の表の部品(`lib/deploy_approvals.ts`)の、値の束縛と行の解析と失敗の扱いを、偽の接続で確かめる。
// SQLの文そのものは、`scripts/test-db-deploy-approvals.ts`が実DBで確かめるので、ここでは照合しない。

import { describe, expect, test } from "bun:test";
import {
  defaultSqlClient,
  type SqlClient,
  type SqlRow,
} from "../../f/factory/lib/db.ts";
import {
  type DeployApprovalSqlClient,
  decideDeployApproval,
  deployApprovalNoticePrefix,
  findDeployApproval,
  isDeployHeldForApproval,
  isDeploySha,
  listPendingDeployApprovals,
  requestDeployApproval,
} from "../../f/factory/lib/deploy_approvals.ts";

type FakeCall = { readonly values: readonly unknown[] };

/** 呼ばれた順に応答を返す偽の接続。`Error`の応答は、その文を実行したときに投げる。 */
function fakeSql(responses: readonly (SqlRow[] | Error)[] = []): {
  sql: SqlClient;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  let index = 0;
  const sql: SqlClient = (_strings, ...values) => {
    const response = responses[index] ?? [];
    index += 1;
    const run = (): Promise<SqlRow[]> => {
      calls.push({ values });
      return response instanceof Error
        ? Promise.reject(response)
        : Promise.resolve(response);
    };
    return {
      fetch: run,
      execute: async () => {
        await run();
      },
    };
  };
  return { sql, calls };
}

const SHA = "0123456789abcdef0123456789abcdef01234567";
const PATHS = ["f/factory/self_update.ts", "infra/worker/Dockerfile"];
const ROW: SqlRow = {
  sha: SHA,
  protected_paths: PATHS,
  requested_at: new Date("2026-11-05T01:00:00.000Z"),
  decided_at: null,
  decision: null,
  decided_by: null,
};

describe("the connection type", () => {
  test("the connection of lib/db.ts fits the module's connection type", () => {
    const client: DeployApprovalSqlClient = defaultSqlClient;
    expect(typeof client).toBe("function");
  });
});

describe("isDeploySha", () => {
  test("accepts 40 lowercase hexadecimal characters", () => {
    expect(isDeploySha(SHA)).toBe(true);
  });

  test("rejects uppercase characters", () => {
    expect(isDeploySha(SHA.toUpperCase())).toBe(false);
  });

  test("rejects a short sha", () => {
    expect(isDeploySha(SHA.slice(0, 7))).toBe(false);
  });
});

describe("deployApprovalNoticePrefix", () => {
  test("ends with the sha and a full stop, so that it does not match another sha", () => {
    expect(deployApprovalNoticePrefix(SHA)).toBe(`反映を待つ版: ${SHA}。`);
  });
});

describe("findDeployApproval", () => {
  test("returns null when no row has the sha", async () => {
    const { sql } = fakeSql([[]]);
    expect(await findDeployApproval(SHA, sql)).toBeNull();
  });

  test("parses the row", async () => {
    const { sql } = fakeSql([[ROW]]);
    expect(await findDeployApproval(SHA, sql)).toEqual({
      sha: SHA,
      protected_paths: PATHS,
      requested_at: "2026-11-05T01:00:00.000Z",
      decided_at: null,
      decision: null,
      decided_by: null,
    });
  });

  test("reads the paths when the connection returns them as a JSON string", async () => {
    const { sql } = fakeSql([
      [{ ...ROW, protected_paths: JSON.stringify(PATHS) }],
    ]);
    expect((await findDeployApproval(SHA, sql))?.protected_paths).toEqual(
      PATHS,
    );
  });

  test("reads an approved row", async () => {
    const { sql } = fakeSql([
      [
        {
          ...ROW,
          decision: "approved",
          decided_at: "2026-11-05T02:00:00.000Z",
          decided_by: "human",
        },
      ],
    ]);
    expect((await findDeployApproval(SHA, sql))?.decision).toBe("approved");
  });

  test("binds only the sha", async () => {
    const { sql, calls } = fakeSql([[]]);
    await findDeployApproval(SHA, sql);
    expect(calls[0]?.values).toEqual([SHA]);
  });

  test("refuses a malformed sha without running SQL", async () => {
    const { sql, calls } = fakeSql();
    await expect(findDeployApproval("abc", sql)).rejects.toThrow(/sha/);
    expect(calls).toEqual([]);
  });

  test("rejects a row whose decision it does not know", async () => {
    const { sql } = fakeSql([[{ ...ROW, decision: "maybe" }]]);
    await expect(findDeployApproval(SHA, sql)).rejects.toThrow(/decision/);
  });

  test("rejects a row without paths", async () => {
    const { sql } = fakeSql([[{ ...ROW, protected_paths: [] }]]);
    await expect(findDeployApproval(SHA, sql)).rejects.toThrow(
      /protected_paths/,
    );
  });

  test("tells that the migration is missing when the table does not exist", async () => {
    const { sql } = fakeSql([Object.assign(new Error("x"), { code: "42P01" })]);
    await expect(findDeployApproval(SHA, sql)).rejects.toThrow(
      /mise run migrate/,
    );
  });
});

describe("requestDeployApproval", () => {
  test("returns true when it creates the row", async () => {
    const { sql } = fakeSql([[{ sha: SHA }]]);
    expect(await requestDeployApproval(SHA, PATHS, sql)).toBe(true);
  });

  test("returns false when the row already exists", async () => {
    const { sql } = fakeSql([[]]);
    expect(await requestDeployApproval(SHA, PATHS, sql)).toBe(false);
  });

  test("binds the sha and the paths as a list", async () => {
    const { sql, calls } = fakeSql([[{ sha: SHA }]]);
    await requestDeployApproval(SHA, PATHS, sql);
    expect(calls[0]?.values).toEqual([SHA, PATHS]);
  });

  test("refuses a request without paths", async () => {
    const { sql } = fakeSql();
    await expect(requestDeployApproval(SHA, [], sql)).rejects.toThrow(/path/);
  });
});

describe("decideDeployApproval", () => {
  test("returns true when it decides the pending request", async () => {
    const { sql } = fakeSql([[{ sha: SHA }]]);
    expect(await decideDeployApproval(SHA, "approved", "human", sql)).toBe(
      true,
    );
  });

  test("returns false when the request is not pending", async () => {
    const { sql } = fakeSql([[]]);
    expect(await decideDeployApproval(SHA, "rejected", "human", sql)).toBe(
      false,
    );
  });

  test("binds the decision, the decider and the sha", async () => {
    const { sql, calls } = fakeSql([[{ sha: SHA }]]);
    await decideDeployApproval(SHA, "approved", "human", sql);
    expect(calls[0]?.values).toEqual(["approved", "human", SHA]);
  });

  test("refuses an empty decider", async () => {
    const { sql } = fakeSql();
    await expect(
      decideDeployApproval(SHA, "approved", "", sql),
    ).rejects.toThrow(/decided_by/);
  });

  test("refuses a decider longer than 100 characters", async () => {
    const { sql } = fakeSql();
    await expect(
      decideDeployApproval(SHA, "approved", "x".repeat(101), sql),
    ).rejects.toThrow(/decided_by/);
  });
});

describe("listPendingDeployApprovals", () => {
  test("parses the pending request", async () => {
    const { sql } = fakeSql([[ROW]]);
    expect(
      (await listPendingDeployApprovals(sql)).map((row) => row.sha),
    ).toEqual([SHA]);
  });

  test("returns an empty list when nothing is pending", async () => {
    const { sql } = fakeSql([[]]);
    expect(await listPendingDeployApprovals(sql)).toEqual([]);
  });
});

describe("isDeployHeldForApproval", () => {
  test("returns true when the newest request is not approved", async () => {
    const { sql } = fakeSql([[{ held: true }]]);
    expect(await isDeployHeldForApproval(sql)).toBe(true);
  });

  test("returns false when nothing holds", async () => {
    const { sql } = fakeSql([[{ held: false }]]);
    expect(await isDeployHeldForApproval(sql)).toBe(false);
  });

  test("rejects an answer that is not a boolean", async () => {
    const { sql } = fakeSql([[{ held: "t" }]]);
    await expect(isDeployHeldForApproval(sql)).rejects.toThrow(/held/);
  });
});
