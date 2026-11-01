// 承認の行を作らない進め方(direct / bugfix / docs)の、手動投入の登録のテスト。
// 登録は、キーの表の行が引数と一致し、リポジトリの許可とオーナーの照合を再び通ることを確かめてから挿入する。
// 挿入の後は、`picked`から`implementing`へ移して、実装フローを直接起動する。

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  InsertedIssueWorkItem,
  NewWorkItem,
} from "../../f/factory/lib/db.ts";
import { IMPLEMENT_FLOW_PATH } from "../../f/factory/lib/implement_launch_support.ts";
import type { Logger } from "../../f/factory/lib/log.ts";
import {
  buildPostedIssueBody,
  computeIntakeContentHash,
  issueHtmlUrl,
  type ManualIntakeFields,
} from "../../f/factory/lib/manual_intake_support.ts";
import { decideReconcileAction } from "../../f/factory/lib/poll_support.ts";
import {
  type FailureRecord,
  TERMINAL_WORK_ITEM_STATUSES,
} from "../../f/factory/lib/types.ts";
import {
  type ApprovalFreeIntakeDeps,
  type ApprovalFreeIntakeInput,
  buildStartImplementFromPicked,
  EXISTING_WORK_ITEM_REASON,
  type PickedStartPorts,
  registerApprovalFreeIntake,
  shouldSkipReusedStandard,
} from "../../f/factory/steps/manual_intake_register.ts";

const INTAKE_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const JOB_ID = "0190aaaa-0000-7000-8000-000000000001";

const FIELDS: ManualIntakeFields = {
  owner: "octo-owner",
  repo: "widgets",
  title: "Fix the typo",
  body: "Fix the typo in the readme.",
  acceptance_criteria: "The typo is gone.",
  profile: "direct",
  intake_key: INTAKE_ID,
};

const INPUT: ApprovalFreeIntakeInput = {
  owner: "octo-owner",
  repo: "widgets",
  issueNumber: 41,
  title: "Fix the typo",
  body: buildPostedIssueBody(
    {
      body: "Fix the typo in the readme.",
      acceptance_criteria: "The typo is gone.",
    },
    INTAKE_ID,
  ),
  viewerLogin: "factory-bot",
  profile: "direct",
  reused: false,
  intakeKey: INTAKE_ID,
  intakeBody: "Fix the typo in the readme.",
  acceptanceCriteria: "The typo is gone.",
};

function silentLog(): Logger {
  return { info() {}, warn() {}, error() {} };
}

type Harness = {
  readonly deps: ApprovalFreeIntakeDeps;
  readonly events: string[];
  readonly inserted: NewWorkItem[];
  readonly started: number[];
  readonly notices: { kind: string; message: string }[];
};

function harness(
  options: {
    implementEnabled?: boolean;
    repoAllowed?: boolean;
    ownerOk?: boolean;
    row?: Awaited<ReturnType<ApprovalFreeIntakeDeps["readIntakeKey"]>>;
    cycle?: number;
    insertResult?: InsertedIssueWorkItem | null;
  } = {},
): Harness {
  const events: string[] = [];
  const inserted: NewWorkItem[] = [];
  const started: number[] = [];
  const notices: { kind: string; message: string }[] = [];
  const row =
    options.row === undefined
      ? {
          intake_key: INTAKE_ID,
          content_hash: computeIntakeContentHash(FIELDS),
          owner: "octo-owner",
          repo: "widgets",
          issue_number: 41,
          holder: JOB_ID,
          reserved_at: new Date("2026-10-31T03:00:00.000Z"),
        }
      : options.row;
  const deps: ApprovalFreeIntakeDeps = {
    implementEnabled: options.implementEnabled ?? true,
    isRepoAllowed: () => options.repoAllowed ?? true,
    verifyRepoOwner: async () => {
      events.push("verifyRepoOwner");
      return options.ownerOk === false
        ? { ok: false, reason: "owner id mismatch" }
        : { ok: true };
    },
    readIntakeKey: async () => {
      events.push("readIntakeKey");
      return row;
    },
    nextCycle: async () => options.cycle ?? 1,
    insertWorkItem: async (item) => {
      events.push("insert");
      inserted.push(item);
      return options.insertResult === undefined
        ? { id: 77, superseded: [] }
        : options.insertResult;
    },
    addNoticeUnlessUnresolved: async (record) => {
      notices.push({ kind: record.kind, message: record.message });
      return notices.length;
    },
    startImplement: async (id) => {
      events.push("startImplement");
      started.push(id);
      return "started";
    },
    log: silentLog(),
  };
  return { deps, events, inserted, started, notices };
}

describe("registerApprovalFreeIntake", () => {
  test("inserts the work item with the profile of the input", async () => {
    const { deps, inserted } = harness();
    await registerApprovalFreeIntake(INPUT, deps);
    expect(inserted[0]?.profile).toBe("direct");
  });

  test("inserts the work item as a picked manual issue claimed by the viewer", async () => {
    const { deps, inserted } = harness();
    await registerApprovalFreeIntake(INPUT, deps);
    expect([
      inserted[0]?.source,
      inserted[0]?.kind,
      inserted[0]?.status,
      inserted[0]?.claimed_by,
    ]).toEqual(["manual", "issue", "picked", "factory-bot"]);
  });

  test("inserts the issue body as the specification", async () => {
    const { deps, inserted } = harness();
    await registerApprovalFreeIntake(INPUT, deps);
    expect(inserted[0]?.body).toBe(INPUT.body);
  });

  test("starts the implement flow for the inserted work item", async () => {
    const { deps, started } = harness();
    await registerApprovalFreeIntake(INPUT, deps);
    expect(started).toEqual([77]);
  });

  test("starts the implement flow after the insert", async () => {
    const { deps, events } = harness();
    await registerApprovalFreeIntake(INPUT, deps);
    expect(events.indexOf("startImplement")).toBeGreaterThan(
      events.indexOf("insert"),
    );
  });

  test("verifies the key row and the owner before the insert", async () => {
    const { deps, events } = harness();
    await registerApprovalFreeIntake(INPUT, deps);
    expect(events.slice(0, 3)).toEqual([
      "readIntakeKey",
      "verifyRepoOwner",
      "insert",
    ]);
  });

  test("returns the work item and the outcome of the start", async () => {
    const { deps } = harness();
    expect(await registerApprovalFreeIntake(INPUT, deps)).toEqual({
      skipped: false,
      work_item_id: 77,
      issue_number: 41,
      issue_url: issueHtmlUrl("octo-owner", "widgets", 41),
      implement: "started",
    });
  });

  test("uses the next cycle of the issue", async () => {
    const { deps, inserted } = harness({ cycle: 1 });
    await registerApprovalFreeIntake(INPUT, deps);
    expect(inserted[0]?.cycle).toBe(1);
  });
});

describe("registerApprovalFreeIntake refusals", () => {
  test("throws when the body is not the one the create step posts", async () => {
    const { deps } = harness();
    await expect(
      registerApprovalFreeIntake({ ...INPUT, body: "### 目的\n\nother" }, deps),
    ).rejects.toThrow(
      "manual_intake: the intake key does not match the request",
    );
  });

  test("throws when the body lacks the end line and the marker", async () => {
    const { deps } = harness();
    await expect(
      registerApprovalFreeIntake(
        {
          ...INPUT,
          body: buildPostedIssueBody(
            {
              body: INPUT.intakeBody,
              acceptance_criteria: INPUT.acceptanceCriteria,
            },
            undefined,
          ),
        },
        deps,
      ),
    ).rejects.toThrow(
      "manual_intake: the intake key does not match the request",
    );
  });

  test("inserts nothing for a body that does not match", async () => {
    const { deps, inserted } = harness();
    await registerApprovalFreeIntake({ ...INPUT, body: "x" }, deps).catch(
      () => undefined,
    );
    expect(inserted).toEqual([]);
  });

  test("throws intake_key_required without a key", async () => {
    const { deps } = harness();
    await expect(
      registerApprovalFreeIntake({ ...INPUT, intakeKey: undefined }, deps),
    ).rejects.toThrow("manual_intake: intake_key_required");
  });

  test("throws implement_disabled while the implementation is off", async () => {
    const { deps } = harness({ implementEnabled: false });
    await expect(registerApprovalFreeIntake(INPUT, deps)).rejects.toThrow(
      "manual_intake: implement_disabled",
    );
  });

  test("throws for a repository that the config does not allow", async () => {
    const { deps } = harness({ repoAllowed: false });
    await expect(registerApprovalFreeIntake(INPUT, deps)).rejects.toThrow(
      "is not allowed",
    );
  });

  test("throws when the owner id check does not pass", async () => {
    const { deps } = harness({ ownerOk: false });
    await expect(registerApprovalFreeIntake(INPUT, deps)).rejects.toThrow(
      "owner id mismatch",
    );
  });

  test("throws for a profile that is not accepted", async () => {
    const { deps } = harness();
    await expect(
      registerApprovalFreeIntake({ ...INPUT, profile: "unknown" }, deps),
    ).rejects.toThrow("manual_intake: the profile is not accepted");
  });

  test("throws for the standard profile, which belongs to the other path", async () => {
    const { deps } = harness();
    await expect(
      registerApprovalFreeIntake({ ...INPUT, profile: "standard" }, deps),
    ).rejects.toThrow("manual_intake: the profile needs approvals");
  });

  test.each([
    ["no row", { row: null }],
    ["a different issue number", { row: rowWith({ issue_number: 42 }) }],
    ["no issue number", { row: rowWith({ issue_number: null }) }],
    ["a different owner", { row: rowWith({ owner: "someone" }) }],
    ["a different repo", { row: rowWith({ repo: "gadgets" }) }],
    [
      "the hash of another profile",
      {
        row: rowWith({
          content_hash: computeIntakeContentHash({
            ...FIELDS,
            profile: "standard",
          }),
        }),
      },
    ],
    [
      "the hash of another title",
      {
        row: rowWith({
          content_hash: computeIntakeContentHash({ ...FIELDS, title: "Other" }),
        }),
      },
    ],
  ])("throws when the key table has %s", async (_name, options) => {
    const { deps } = harness(options);
    await expect(registerApprovalFreeIntake(INPUT, deps)).rejects.toThrow(
      "manual_intake: the intake key does not match the request",
    );
  });

  test("inserts nothing for a failed owner check", async () => {
    const { deps, inserted } = harness({ ownerOk: false });
    await registerApprovalFreeIntake(INPUT, deps).catch(() => undefined);
    expect(inserted).toEqual([]);
  });

  test("starts nothing for a failed owner check", async () => {
    const { deps, started } = harness({ ownerOk: false });
    await registerApprovalFreeIntake(INPUT, deps).catch(() => undefined);
    expect(started).toEqual([]);
  });

  test("inserts nothing without a key", async () => {
    const { deps, inserted } = harness();
    await registerApprovalFreeIntake(
      { ...INPUT, intakeKey: undefined },
      deps,
    ).catch(() => undefined);
    expect(inserted).toEqual([]);
  });

  test("inserts nothing while the implementation is off", async () => {
    const { deps, inserted } = harness({ implementEnabled: false });
    await registerApprovalFreeIntake(INPUT, deps).catch(() => undefined);
    expect(inserted).toEqual([]);
  });

  test("inserts nothing for a repository that the config does not allow", async () => {
    const { deps, inserted } = harness({ repoAllowed: false });
    await registerApprovalFreeIntake(INPUT, deps).catch(() => undefined);
    expect(inserted).toEqual([]);
  });
});

function rowWith(
  change: Partial<
    NonNullable<Awaited<ReturnType<ApprovalFreeIntakeDeps["readIntakeKey"]>>>
  >,
) {
  return {
    intake_key: INTAKE_ID,
    content_hash: computeIntakeContentHash(FIELDS),
    owner: "octo-owner",
    repo: "widgets",
    issue_number: 41,
    holder: JOB_ID,
    reserved_at: new Date("2026-10-31T03:00:00.000Z"),
    ...change,
  };
}

describe("registerApprovalFreeIntake for an issue that an earlier request created", () => {
  const REUSED = { ...INPUT, reused: true };

  test("registers when the issue has no work item", async () => {
    const { deps, inserted } = harness({ cycle: 1 });
    await registerApprovalFreeIntake(REUSED, deps);
    expect(inserted).toHaveLength(1);
  });

  test("starts the implement flow when the issue has no work item", async () => {
    const { deps, started } = harness({ cycle: 1 });
    await registerApprovalFreeIntake(REUSED, deps);
    expect(started).toEqual([77]);
  });

  test("registers nothing when the issue already has a work item", async () => {
    const { deps, inserted } = harness({ cycle: 2 });
    await registerApprovalFreeIntake(REUSED, deps);
    expect(inserted).toEqual([]);
  });

  test("starts nothing when the issue already has a work item", async () => {
    const { deps, started } = harness({ cycle: 2 });
    await registerApprovalFreeIntake(REUSED, deps);
    expect(started).toEqual([]);
  });

  test("returns a skipped result when the issue already has a work item", async () => {
    const { deps } = harness({ cycle: 2 });
    expect(await registerApprovalFreeIntake(REUSED, deps)).toMatchObject({
      skipped: true,
      issue_number: 41,
    });
  });

  test("registers nothing when the issue has a work item even if the flow did not call it a reuse", async () => {
    const { deps, inserted } = harness({ cycle: 2 });
    await registerApprovalFreeIntake({ ...INPUT, reused: false }, deps);
    expect(inserted).toEqual([]);
  });

  test("returns the same skipped reason for a request that is not a reuse", async () => {
    const { deps } = harness({ cycle: 2 });
    expect(
      await registerApprovalFreeIntake({ ...INPUT, reused: false }, deps),
    ).toMatchObject({ skipped: true, reason: EXISTING_WORK_ITEM_REASON });
  });

  test("verifies the key row even when it registers nothing", async () => {
    const { deps } = harness({ cycle: 2, row: null });
    await expect(registerApprovalFreeIntake(REUSED, deps)).rejects.toThrow(
      "manual_intake: the intake key does not match the request",
    );
  });
});

describe("registerApprovalFreeIntake when another work item is active", () => {
  test("returns a skipped result when the insert conflicts", async () => {
    const { deps } = harness({ insertResult: null });
    expect(await registerApprovalFreeIntake(INPUT, deps)).toMatchObject({
      skipped: true,
    });
  });

  test("records a claim_race_lost notice when the insert conflicts", async () => {
    const { deps, notices } = harness({ insertResult: null });
    await registerApprovalFreeIntake(INPUT, deps);
    expect(notices.map((notice) => notice.kind)).toEqual(["claim_race_lost"]);
  });

  test("starts nothing when the insert conflicts", async () => {
    const { deps, started } = harness({ insertResult: null });
    await registerApprovalFreeIntake(INPUT, deps);
    expect(started).toEqual([]);
  });
});

describe("registerApprovalFreeIntake for names that GitHub spells differently", () => {
  const MIXED = { owner: "Octo-Owner", repo: "Widgets" };
  const MIXED_FIELDS = { ...FIELDS, ...MIXED };
  const MIXED_INPUT = {
    ...INPUT,
    ...MIXED,
  };
  const MIXED_ROW = rowWith({
    ...MIXED,
    content_hash: computeIntakeContentHash(MIXED_FIELDS),
  });

  test("registers although GitHub spells the names in lower case", async () => {
    const { deps, inserted } = harness({ row: MIXED_ROW });
    await registerApprovalFreeIntake(MIXED_INPUT, deps);
    expect(inserted).toHaveLength(1);
  });

  test("stores the address built from the names of the request", async () => {
    const { deps, inserted } = harness({ row: MIXED_ROW });
    await registerApprovalFreeIntake(MIXED_INPUT, deps);
    expect(inserted[0]?.issue_url).toBe(
      issueHtmlUrl("Octo-Owner", "Widgets", 41),
    );
  });

  test("returns the address built from the names of the request", async () => {
    const { deps } = harness({ row: MIXED_ROW });
    expect(await registerApprovalFreeIntake(MIXED_INPUT, deps)).toMatchObject({
      issue_url: issueHtmlUrl("Octo-Owner", "Widgets", 41),
    });
  });
});

describe("shouldSkipReusedStandard", () => {
  test("skips a reused issue of the standard profile", () => {
    expect(shouldSkipReusedStandard("standard", true)).toBe(true);
  });

  test("does not skip a new issue of the standard profile", () => {
    expect(shouldSkipReusedStandard("standard", false)).toBe(false);
  });

  test("does not skip a reused issue of an approval-free profile", () => {
    expect(shouldSkipReusedStandard("direct", true)).toBe(false);
  });

  test("does not skip when the flow did not tell whether the issue was reused", () => {
    expect(shouldSkipReusedStandard("standard", undefined)).toBe(false);
  });
});

type Recorded = {
  readonly cas: [number, string, string][];
  readonly flows: [string, Record<string, unknown>][];
  readonly jobIds: string[];
  readonly failures: FailureRecord[];
  readonly notices: string[];
  readonly needsHuman: string[];
};

function ports(overrides: Partial<PickedStartPorts> = {}): {
  ports: PickedStartPorts;
  recorded: Recorded;
} {
  const recorded: Recorded = {
    cas: [],
    flows: [],
    jobIds: [],
    failures: [],
    notices: [],
    needsHuman: [],
  };
  return {
    recorded,
    ports: {
      compareAndSwap: async (id, from, to) => {
        recorded.cas.push([id, from, to]);
        return true;
      },
      runFlowAsync: async (path, args) => {
        recorded.flows.push([path, args]);
        return JOB_ID;
      },
      setFlowJobIdIfUnset: async (_id, jobId) => {
        recorded.jobIds.push(jobId);
        return true;
      },
      moveToNeedsHuman: async () => true,
      recordFailure: async (record) => {
        recorded.failures.push(record);
        return 1;
      },
      addNotice: async (message) => {
        recorded.notices.push(message);
      },
      notifyNeedsHuman: async (reason) => {
        recorded.needsHuman.push(reason);
      },
      ...overrides,
    },
  };
}

const CTX = {
  workItemId: 77,
  owner: "octo-owner",
  repo: "widgets",
  issueNumber: 41,
  log: silentLog(),
};

describe("buildStartImplementFromPicked", () => {
  test("moves the work item from picked to implementing", async () => {
    const { ports: p, recorded } = ports();
    await buildStartImplementFromPicked(CTX, p)();
    expect(recorded.cas).toEqual([[77, "picked", "implementing"]]);
  });

  test("starts the implement flow with the work item id", async () => {
    const { ports: p, recorded } = ports();
    await buildStartImplementFromPicked(CTX, p)();
    expect(recorded.flows).toEqual([
      [IMPLEMENT_FLOW_PATH, { work_item_id: 77 }],
    ]);
  });

  test("records the job id of the flow", async () => {
    const { ports: p, recorded } = ports();
    await buildStartImplementFromPicked(CTX, p)();
    expect(recorded.jobIds).toEqual([JOB_ID]);
  });

  test("returns started", async () => {
    const { ports: p } = ports();
    expect(await buildStartImplementFromPicked(CTX, p)()).toBe("started");
  });

  test("starts nothing when another run moved the work item", async () => {
    const { ports: p, recorded } = ports({ compareAndSwap: async () => false });
    await buildStartImplementFromPicked(CTX, p)();
    expect(recorded.flows).toEqual([]);
  });

  test("returns not_moved when another run moved the work item", async () => {
    const { ports: p } = ports({ compareAndSwap: async () => false });
    expect(await buildStartImplementFromPicked(CTX, p)()).toBe("not_moved");
  });

  test("returns cas_failed when the swap throws", async () => {
    const { ports: p } = ports({
      compareAndSwap: async () => {
        throw new Error("db down");
      },
    });
    expect(await buildStartImplementFromPicked(CTX, p)()).toBe("cas_failed");
  });

  test("records the failure of the swap at the cas step", async () => {
    const { ports: p, recorded } = ports({
      compareAndSwap: async () => {
        throw new Error("db down");
      },
    });
    await buildStartImplementFromPicked(CTX, p)();
    expect(recorded.failures.map((record) => record.step)).toEqual(["cas"]);
  });

  test("adds a notice for the failure of the swap", async () => {
    const { ports: p, recorded } = ports({
      compareAndSwap: async () => {
        throw new Error("db down");
      },
    });
    await buildStartImplementFromPicked(CTX, p)();
    expect(recorded.notices).toHaveLength(1);
  });

  test("starts no flow when the swap throws", async () => {
    const { ports: p, recorded } = ports({
      compareAndSwap: async () => {
        throw new Error("db down");
      },
    });
    await buildStartImplementFromPicked(CTX, p)();
    expect(recorded.flows).toEqual([]);
  });

  test("returns launch_failed when the flow does not start", async () => {
    const { ports: p } = ports({
      runFlowAsync: async () => {
        throw new Error("windmill down");
      },
    });
    expect(await buildStartImplementFromPicked(CTX, p)()).toBe("launch_failed");
  });

  test("tells a person when the flow does not start", async () => {
    const { ports: p, recorded } = ports({
      runFlowAsync: async () => {
        throw new Error("windmill down");
      },
    });
    await buildStartImplementFromPicked(CTX, p)();
    expect(recorded.needsHuman).toHaveLength(1);
  });
});

// 起動の比較交換が例外で終わると、作業項目は`picked`のまま残る。
// 終端でない`picked`は、`poll_issues`の照合が拾い、実行中のジョブが無いまま猶予を過ぎると失敗に移す。
describe("a work item that stays picked after a failed start", () => {
  const GRACE_MS = 10 * 60_000;
  const UPDATED = new Date("2026-10-31T03:00:00.000Z");

  test("is not a terminal status, so the reconcile reads it", () => {
    expect(TERMINAL_WORK_ITEM_STATUSES).not.toContain("picked");
  });

  test("is left alone while the grace period lasts", () => {
    expect(
      decideReconcileAction(
        { updated_at: UPDATED },
        { kind: "issue", open: true },
        { state: "absent" },
        new Date(UPDATED.getTime() + GRACE_MS - 1),
        GRACE_MS,
      ),
    ).toEqual({ action: "none" });
  });

  test("is failed as an orphan after the grace period", () => {
    expect(
      decideReconcileAction(
        { updated_at: UPDATED },
        { kind: "issue", open: true },
        { state: "absent" },
        new Date(UPDATED.getTime() + GRACE_MS),
        GRACE_MS,
      ).action,
    ).toBe("fail_orphan");
  });
});

describe("the entry point of the registration for the approval-free profiles", () => {
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync(
    readFileSync(
      join(import.meta.dir, "../../f/factory/steps/manual_intake_register.ts"),
      "utf8",
    ),
  );
  const entry = code.slice(code.indexOf("async function main("));

  test("takes the facts that the key table row is checked against", () => {
    expect(entry.slice(0, entry.indexOf(")"))).toMatch(
      /reused[\s\S]*intake_key[\s\S]*intake_body[\s\S]*acceptance_criteria/,
    );
  });

  test("requires the intake key before it reads the config", () => {
    expect(entry.slice(0, entry.indexOf("factory_config"))).toContain(
      "assertIntakeKeyForProfile(profile, key)",
    );
  });

  test("branches on the profile through skipsApprovals", () => {
    expect(entry).toContain("skipsApprovals(profile)");
  });

  test("passes the repository allow list into the check", () => {
    expect(entry).toMatch(
      /isRepoAllowed:\s*\(owner, repo\)\s*=>\s*isRepoAllowed\(config/,
    );
  });

  test("passes the owner id gate into the check", () => {
    expect(entry).toContain("verifyRepoOwnerId(config");
  });

  test("hands the implementation switch of the config to the check", () => {
    expect(entry).toContain("implementEnabled: config.implement_enabled");
  });

  test("leaves the label claim to the standard path", () => {
    expect(entry.indexOf("registerApprovalFreeIntake(")).toBeLessThan(
      entry.indexOf("claimManualIntakeIssue("),
    );
  });
});
