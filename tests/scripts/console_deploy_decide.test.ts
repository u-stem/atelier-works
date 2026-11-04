import { describe, expect, test } from "bun:test";
import {
  type DeployDecideDeps,
  decideDeployRecorded,
  decidedNoticeMessage,
} from "../../f/factory/console_deploy_decide.ts";
import type { ActionSqlClient } from "../../f/factory/lib/console_actions.ts";
import type { NoticeRecord } from "../../f/factory/lib/types.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";

/** 操作の記録の行を入れて更新できる接続。 */
const RECORDING: ActionSqlClient = () => ({
  fetch: () => Promise.resolve([{ id: 1 }]),
  execute: () => Promise.resolve(),
});

/** 操作の記録の行を入れられない接続。 */
const UNRECORDABLE: ActionSqlClient = () => ({
  fetch: () => Promise.reject(new Error("connection refused")),
  execute: () => Promise.reject(new Error("connection refused")),
});

type Seen = {
  decided: { sha: string; decision: string; decidedBy: string }[];
  resolved: { sha: string; resolvedBy: string }[];
  notices: NoticeRecord[];
  warnings: string[];
};

function deps(overrides: Partial<DeployDecideDeps> = {}): {
  deps: DeployDecideDeps;
  seen: Seen;
} {
  const seen: Seen = { decided: [], resolved: [], notices: [], warnings: [] };
  const base: DeployDecideDeps = {
    deriveApprover: () => "operator",
    decide: (sha, decision, decidedBy) => {
      seen.decided.push({ sha, decision, decidedBy });
      return Promise.resolve(true);
    },
    resolveRequiredNotice: (sha, resolvedBy) => {
      seen.resolved.push({ sha, resolvedBy });
      return Promise.resolve(1);
    },
    addNotice: (record) => {
      seen.notices.push(record);
      return Promise.resolve(1);
    },
    warn: (message) => {
      seen.warnings.push(message);
    },
  };
  return { deps: { ...base, ...overrides }, seen };
}

describe("decideDeployRecorded refusals", () => {
  test("refuses a sha that is not 40 lowercase hexadecimal characters", async () => {
    const { deps: d } = deps();
    expect(await decideDeployRecorded("ABC", "approve", d, RECORDING)).toEqual({
      refused: true,
      reason: "invalid_sha",
    });
  });

  test("refuses a decision it does not know", async () => {
    const { deps: d } = deps();
    expect(await decideDeployRecorded(SHA, "approved", d, RECORDING)).toEqual({
      refused: true,
      reason: "invalid_decision",
    });
  });

  test("refuses when the operator cannot be determined", async () => {
    const { deps: d } = deps({
      deriveApprover: () => {
        throw new Error("no user");
      },
    });
    expect(await decideDeployRecorded(SHA, "approve", d, RECORDING)).toEqual({
      refused: true,
      reason: "actor_unknown",
    });
  });

  test("refuses when the attempt cannot be recorded", async () => {
    const { deps: d } = deps();
    expect(await decideDeployRecorded(SHA, "approve", d, UNRECORDABLE)).toEqual(
      {
        refused: true,
        reason: "audit_unavailable",
      },
    );
  });

  test("does not decide when the attempt cannot be recorded", async () => {
    const { deps: d, seen } = deps();
    await decideDeployRecorded(SHA, "approve", d, UNRECORDABLE);
    expect(seen.decided).toEqual([]);
  });

  test("refuses with not_pending when the request is not pending", async () => {
    const { deps: d } = deps({ decide: () => Promise.resolve(false) });
    expect(await decideDeployRecorded(SHA, "approve", d, RECORDING)).toEqual({
      refused: true,
      reason: "not_pending",
    });
  });

  test("does not resolve the notice when the request is not pending", async () => {
    const { deps: d, seen } = deps({ decide: () => Promise.resolve(false) });
    await decideDeployRecorded(SHA, "approve", d, RECORDING);
    expect(seen.resolved).toEqual([]);
  });
});

describe("decideDeployRecorded decisions", () => {
  test("records an approval as approved by the operator", async () => {
    const { deps: d, seen } = deps();
    await decideDeployRecorded(SHA, "approve", d, RECORDING);
    expect(seen.decided).toEqual([
      { sha: SHA, decision: "approved", decidedBy: "operator" },
    ]);
  });

  test("records a rejection as rejected", async () => {
    const { deps: d, seen } = deps();
    await decideDeployRecorded(SHA, "reject", d, RECORDING);
    expect(seen.decided[0]?.decision).toBe("rejected");
  });

  test("returns the decision and the audits", async () => {
    const { deps: d } = deps();
    expect(await decideDeployRecorded(SHA, "approve", d, RECORDING)).toEqual({
      refused: false,
      sha: SHA,
      decision: "approved",
      notice: "recorded",
      action_audit: "recorded",
    });
  });

  test("resolves the notice of the sha as the operator", async () => {
    const { deps: d, seen } = deps();
    await decideDeployRecorded(SHA, "approve", d, RECORDING);
    expect(seen.resolved).toEqual([{ sha: SHA, resolvedBy: "operator" }]);
  });

  test("leaves an info notice of the decision", async () => {
    const { deps: d, seen } = deps();
    await decideDeployRecorded(SHA, "reject", d, RECORDING);
    expect(seen.notices).toEqual([
      {
        kind: "deploy_approval_decided",
        message: decidedNoticeMessage(SHA, "rejected", "operator"),
      },
    ]);
  });

  test("keeps the decision when the info notice cannot be recorded", async () => {
    const { deps: d } = deps({
      addNotice: () => Promise.reject(new Error("db down")),
    });
    const result = await decideDeployRecorded(SHA, "approve", d, RECORDING);
    expect(result.refused === false ? result.notice : null).toBe("failed");
  });

  test("keeps the decision when the required notice cannot be resolved", async () => {
    const { deps: d } = deps({
      resolveRequiredNotice: () => Promise.reject(new Error("db down")),
    });
    expect(
      (await decideDeployRecorded(SHA, "approve", d, RECORDING)).refused,
    ).toBe(false);
  });

  test("warns when the required notice cannot be resolved", async () => {
    const { deps: d, seen } = deps({
      resolveRequiredNotice: () => Promise.reject(new Error("db down")),
    });
    await decideDeployRecorded(SHA, "approve", d, RECORDING);
    expect(seen.warnings).toEqual([
      "console_deploy_decide: could not resolve the required notice",
    ]);
  });
});

describe("decidedNoticeMessage", () => {
  test("names the sha and the approval", () => {
    expect(decidedNoticeMessage(SHA, "approved", "operator")).toContain(
      `版 ${SHA}を承認しました`,
    );
  });

  test("tells that a rejection keeps the deploy stopped", () => {
    expect(decidedNoticeMessage(SHA, "rejected", "operator")).toContain(
      "mainへ戻すPR",
    );
  });

  test("clips a long operator name", () => {
    expect(
      decidedNoticeMessage(SHA, "approved", "x".repeat(150)),
    ).not.toContain("x".repeat(101));
  });
});

describe("the entry point", () => {
  test("main decides through the recorded form", async () => {
    const source = await Bun.file("f/factory/console_deploy_decide.ts").text();
    expect(source.slice(source.indexOf("export async function main("))).toMatch(
      /await decideDeployRecorded\(/,
    );
  });

  test("main writes the decision through the approvals module", async () => {
    const source = await Bun.file("f/factory/console_deploy_decide.ts").text();
    expect(
      source.slice(source.indexOf("export async function main(")),
    ).toContain(
      "decideDeployApproval(target, verdict, decidedBy, defaultSqlClient)",
    );
  });
});
