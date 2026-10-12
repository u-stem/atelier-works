// backendの"deployments"ビューの変換結果が、Console(console/)の型ガードを通ることを確かめる。
// 両者の型は別々に書かれているので、片方だけを変えたときにここで落とす。
// 表示の対応表(console/src/lib/labels.ts)が、backendの作り手の値を取りこぼしていないこともここで確かめる。

import { describe, expect, test } from "bun:test";
import { isDeploymentHistory } from "../../console/src/api/guards/deployments.ts";
import {
  deploymentResultLabel,
  pullRequestOriginLabel,
  UNKNOWN_STATUS_LABEL,
} from "../../console/src/lib/labels.ts";
import {
  failureReasonText,
  PULL_REQUEST_RECORD_LIMIT,
  pullRequestHref,
} from "../../console/src/lib/updateHistory.ts";
import type { SqlClient, SqlRow } from "../../f/factory/lib/db.ts";
import {
  MAX_PULL_REQUESTS_PER_DEPLOYMENT,
  parseMergedPullRequests,
} from "../../f/factory/lib/self_update_pull_requests.ts";
import { PULL_REQUEST_ORIGINS } from "../../f/factory/lib/types.ts";
import { runConsoleQuery } from "../../f/factory/steps/console_query.ts";

function sqlReturning(rows: SqlRow[]): SqlClient {
  return () => ({
    fetch: () => Promise.resolve(rows),
    execute: () => Promise.resolve(),
  });
}

const T0 = "2026-10-08T00:00:00.000Z";
const PARENTS = "p1 p2";
const REPO = "https://github.com/o/r";

/** `self_update`が記録するPRを、コミットのログから作る。 */
function recordedPullRequests() {
  const log =
    `${PARENTS}\x1fMerge pull request #7 from o/factory/issue-1-wi-2\x1ffeat: a\n\0` +
    `${PARENTS}\x1fMerge pull request #8 from o/fix/b\x1ffix: b\n\0` +
    "p1\x1ffeat: squashed (#9)\x1f\0";
  return parseMergedPullRequests(log, REPO);
}

const DEPLOYMENT_ROW: SqlRow = {
  deployment_id: "12",
  sha_from: "a".repeat(40),
  sha_to: "b".repeat(40),
  result: "success",
  needs_host_action: true,
  occurred_at: new Date(T0),
  pull_requests: recordedPullRequests(),
};

/** WindmillがscriptのResultをJSONにして返す経路を再現する。 */
async function historyAsDelivered(rows: SqlRow[]): Promise<unknown> {
  const result = await runConsoleQuery(
    "deployments",
    100,
    90,
    sqlReturning(rows),
  );
  return JSON.parse(JSON.stringify(result));
}

describe("deployments contract between console_query and the console guard", () => {
  test("accepts a deployment with pull requests of every origin", async () => {
    expect(
      isDeploymentHistory(await historyAsDelivered([DEPLOYMENT_ROW])),
    ).toBe(true);
  });

  test("accepts an empty history", async () => {
    expect(isDeploymentHistory(await historyAsDelivered([]))).toBe(true);
  });

  test("accepts a first deployment without a previous version", async () => {
    const delivered = await historyAsDelivered([
      { ...DEPLOYMENT_ROW, sha_from: null },
    ]);
    expect(isDeploymentHistory(delivered)).toBe(true);
  });

  test("accepts a failed deployment with a reason", async () => {
    const delivered = await historyAsDelivered([
      { ...DEPLOYMENT_ROW, result: "failed", error: "wmill sync push failed" },
    ]);
    expect(isDeploymentHistory(delivered)).toBe(true);
  });

  test("delivers the reason that the console shows", async () => {
    const delivered = await historyAsDelivered([
      { ...DEPLOYMENT_ROW, result: "failed", error: "wmill sync push failed" },
    ]);
    const first = isDeploymentHistory(delivered) ? delivered[0] : undefined;
    expect(first === undefined ? null : failureReasonText(first)).toBe(
      "wmill sync push failed",
    );
  });

  test("accepts a failed deployment recorded without a reason", async () => {
    const delivered = await historyAsDelivered([
      { ...DEPLOYMENT_ROW, result: "failed", error: null },
    ]);
    expect(isDeploymentHistory(delivered)).toBe(true);
  });

  test("carries a UTC offset on the timestamp", async () => {
    const delivered = await historyAsDelivered([DEPLOYMENT_ROW]);
    expect(JSON.stringify(delivered)).toContain(`"occurred_at":"${T0}"`);
  });

  test("keeps the pull request link that the console accepts", async () => {
    const delivered = await historyAsDelivered([DEPLOYMENT_ROW]);
    const first = isDeploymentHistory(delivered)
      ? delivered[0]?.pull_requests[0]
      : undefined;
    expect(first === undefined ? null : pullRequestHref(first)).toBe(
      "https://github.com/o/r/pull/7",
    );
  });
});

describe("label tables cover the backend values", () => {
  test.each(PULL_REQUEST_ORIGINS.filter((origin) => origin !== "unknown"))(
    "labels pull request origin %s",
    (origin) => {
      expect(pullRequestOriginLabel(origin)).not.toBe("不明");
    },
  );

  test.each([...PULL_REQUEST_ORIGINS])(
    "gives pull request origin %s a label",
    (origin) => {
      expect(pullRequestOriginLabel(origin).length).toBeGreaterThan(0);
    },
  );

  test("labels the origin that could not be read as unknown", () => {
    expect(pullRequestOriginLabel("unknown")).toBe("不明");
  });

  test.each(["success", "failed"])("labels deployment result %s", (result) => {
    expect(deploymentResultLabel(result)).not.toBe(UNKNOWN_STATUS_LABEL);
  });
});

describe("record limit", () => {
  test("the console knows the number of pull requests that the backend keeps", () => {
    expect(PULL_REQUEST_RECORD_LIMIT).toBe(MAX_PULL_REQUESTS_PER_DEPLOYMENT);
  });
});
