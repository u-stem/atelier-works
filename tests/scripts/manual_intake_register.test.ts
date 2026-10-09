// `manual_intake_register.ts`の`claimManualIntakeIssue`のテスト。
// 手動投入のIssueも、取得の所有はトリガーラベルの削除の成否で決まる。
// ほかが先に外した、または外せなかったIssueは、`poll_issues`が扱うので
// 失敗にせず見送る。assigneeが付かなくても作業を続け、noticeを残す。

import { describe, expect, test } from "bun:test";
import type { InsertedIssueWorkItem } from "../../f/factory/lib/db.ts";
import {
  type ClaimIssueResult,
  ClaimOwnershipUnknownError,
} from "../../f/factory/lib/github.ts";
import type { Logger } from "../../f/factory/lib/log.ts";
import {
  claimManualIntakeIssue,
  type ManualIntakeClaimDeps,
  type ManualIntakeInsertDeps,
  manualIntakeSkippedResult,
  registerManualIntakeWorkItem,
} from "../../f/factory/steps/manual_intake_register.ts";
import { ok } from "../lib/testSupport.ts";

type Notice = { kind: string; message: string };

function fakeDeps(claim: () => Promise<ClaimIssueResult>): {
  deps: ManualIntakeClaimDeps;
  notices: Notice[];
} {
  const notices: Notice[] = [];
  const deps: ManualIntakeClaimDeps = {
    claimIssue: claim,
    addNoticeUnlessUnresolved: async (record) => {
      notices.push({ kind: record.kind, message: record.message });
      return notices.length;
    },
  };
  return { deps, notices };
}

function recordingLog(): { log: Logger; warns: string[] } {
  const warns: string[] = [];
  const log: Logger = {
    info() {},
    warn(message) {
      warns.push(message);
    },
    error() {},
  };
  return { log, warns };
}

function run(deps: ManualIntakeClaimDeps, log: Logger) {
  return claimManualIntakeIssue(
    {
      client: { run: async () => ok(), ghToken: "tok" },
      owner: "octo-owner",
      repo: "atelier-works",
      issueNumber: 12,
      triggerLabel: "factory",
      viewerLogin: "factory-bot",
      log,
    },
    deps,
  );
}

const CONFIRMED = async (): Promise<ClaimIssueResult> => ({
  claimed: true,
  assignee: "confirmed",
});
const MISSING = async (): Promise<ClaimIssueResult> => ({
  claimed: true,
  assignee: "missing",
});
const UNKNOWN = async (): Promise<ClaimIssueResult> => ({
  claimed: true,
  assignee: "unknown",
});
const LOST = async (): Promise<ClaimIssueResult> => ({
  claimed: false,
  outcome: "lost",
  reason: "trigger label factory was already removed",
});
const RETRY = async (): Promise<ClaimIssueResult> => ({
  claimed: false,
  outcome: "retry",
  reason: "trigger label factory removal failed and the label is still present",
});

describe("claimManualIntakeIssue", () => {
  test("proceeds when the claim is established", async () => {
    const { deps } = fakeDeps(CONFIRMED);
    const { log } = recordingLog();
    expect(await run(deps, log)).toEqual({ claimed: true });
  });

  test("records no notice when the assignee is confirmed", async () => {
    const { deps, notices } = fakeDeps(CONFIRMED);
    const { log } = recordingLog();
    await run(deps, log);
    expect(notices).toEqual([]);
  });

  test("proceeds when the assignee did not stick", async () => {
    const { deps } = fakeDeps(MISSING);
    const { log } = recordingLog();
    expect(await run(deps, log)).toEqual({ claimed: true });
  });

  test("records a claim_assignee_missing notice when the assignee did not stick", async () => {
    const { deps, notices } = fakeDeps(MISSING);
    const { log } = recordingLog();
    await run(deps, log);
    expect(notices.map((n) => n.kind)).toEqual(["claim_assignee_missing"]);
  });

  test("names the target and the viewer in the assignee notice", async () => {
    const { deps, notices } = fakeDeps(MISSING);
    const { log } = recordingLog();
    await run(deps, log);
    expect(notices[0]?.message).toContain(
      "octo-owner/atelier-works#12: assigneeにfactory-botを設定できませんでした",
    );
  });

  test("proceeds without a notice when the confirmation read failed", async () => {
    const { deps, notices } = fakeDeps(UNKNOWN);
    const { log } = recordingLog();
    await run(deps, log);
    expect(notices).toEqual([]);
  });

  test("skips without failing when another actor removed the label first", async () => {
    const { deps } = fakeDeps(LOST);
    const { log } = recordingLog();
    expect(await run(deps, log)).toEqual({
      claimed: false,
      reason: "trigger label factory was already removed",
    });
  });

  test("logs a warning when another actor removed the label first", async () => {
    const { deps } = fakeDeps(LOST);
    const { log, warns } = recordingLog();
    await run(deps, log);
    expect(warns).toEqual(["manual intake skipped the claim"]);
  });

  test("records a claim_race_lost notice when another actor removed the label first", async () => {
    const { deps, notices } = fakeDeps(LOST);
    const { log } = recordingLog();
    await run(deps, log);
    expect(notices).toEqual([
      {
        kind: "claim_race_lost",
        message:
          "octo-owner/atelier-works#12: trigger label factory was already removed",
      },
    ]);
  });

  test("records no notice when the label removal failed and the label remains", async () => {
    const { deps, notices } = fakeDeps(RETRY);
    const { log } = recordingLog();
    await run(deps, log);
    expect(notices).toEqual([]);
  });

  test("still skips when recording the lost race fails", async () => {
    const { deps } = fakeDeps(LOST);
    const failing: ManualIntakeClaimDeps = {
      ...deps,
      addNoticeUnlessUnresolved: async () => {
        throw new Error("db down");
      },
    };
    const { log } = recordingLog();
    expect(await run(failing, log)).toEqual({
      claimed: false,
      reason: "trigger label factory was already removed",
    });
  });

  test("skips without failing when the label removal failed and the label remains", async () => {
    const { deps } = fakeDeps(RETRY);
    const { log } = recordingLog();
    expect(await run(deps, log)).toEqual({
      claimed: false,
      reason:
        "trigger label factory removal failed and the label is still present",
    });
  });

  test("rethrows when the ownership could not be determined", async () => {
    const { deps } = fakeDeps(async () => {
      throw new ClaimOwnershipUnknownError("unknown");
    });
    const { log } = recordingLog();
    await expect(run(deps, log)).rejects.toBeInstanceOf(
      ClaimOwnershipUnknownError,
    );
  });
});

describe("manualIntakeSkippedResult", () => {
  test("builds the skipped result with the issue and the reason", () => {
    expect(
      manualIntakeSkippedResult(
        12,
        "https://github.com/octo-owner/atelier-works/issues/12",
        "trigger label factory was already removed",
      ),
    ).toEqual({
      skipped: true,
      issue_number: 12,
      issue_url: "https://github.com/octo-owner/atelier-works/issues/12",
      reason: "trigger label factory was already removed",
    });
  });
});

describe("registerManualIntakeWorkItem", () => {
  function insertDeps(insert: () => Promise<InsertedIssueWorkItem | null>): {
    deps: ManualIntakeInsertDeps;
    notices: Notice[];
    inserted: Parameters<ManualIntakeInsertDeps["insertWorkItem"]>[0][];
  } {
    const notices: Notice[] = [];
    const inserted: Parameters<ManualIntakeInsertDeps["insertWorkItem"]>[0][] =
      [];
    const deps: ManualIntakeInsertDeps = {
      insertWorkItem: async (item) => {
        inserted.push(item);
        return insert();
      },
      addNoticeUnlessUnresolved: async (record) => {
        notices.push({ kind: record.kind, message: record.message });
        return notices.length;
      },
    };
    return { deps, notices, inserted };
  }

  const INPUT = {
    owner: "octo-owner",
    repo: "atelier-works",
    issueNumber: 12,
    issueUrl: "https://github.com/octo-owner/atelier-works/issues/12",
    title: "Add a thing",
    body: "please add a thing",
    viewerLogin: "factory-bot",
  };

  test("returns the id of the registered work item", async () => {
    const { deps } = insertDeps(async () => ({ id: 77, superseded: [] }));
    const { log } = recordingLog();
    expect(await registerManualIntakeWorkItem({ ...INPUT, log }, deps)).toBe(
      77,
    );
  });

  test("registers a manual issue work item", async () => {
    const { deps, inserted } = insertDeps(async () => ({
      id: 77,
      superseded: [],
    }));
    const { log } = recordingLog();
    await registerManualIntakeWorkItem({ ...INPUT, log }, deps);
    expect(inserted[0]?.source).toBe("manual");
  });

  test("starts the work item as picked and claimed by the viewer", async () => {
    const { deps, inserted } = insertDeps(async () => ({
      id: 77,
      superseded: [],
    }));
    const { log } = recordingLog();
    await registerManualIntakeWorkItem({ ...INPUT, log }, deps);
    expect([inserted[0]?.status, inserted[0]?.claimed_by]).toEqual([
      "picked",
      "factory-bot",
    ]);
  });

  test("records no notice when the registration succeeds", async () => {
    const { deps, notices } = insertDeps(async () => ({
      id: 77,
      superseded: [],
    }));
    const { log } = recordingLog();
    await registerManualIntakeWorkItem({ ...INPUT, log }, deps);
    expect(notices).toEqual([]);
  });

  test("returns null when another active work item already exists for the issue", async () => {
    const { deps } = insertDeps(async () => null);
    const { log } = recordingLog();
    expect(
      await registerManualIntakeWorkItem({ ...INPUT, log }, deps),
    ).toBeNull();
  });

  test("records a claim_race_lost notice when the insert conflicts", async () => {
    const { deps, notices } = insertDeps(async () => null);
    const { log } = recordingLog();
    await registerManualIntakeWorkItem({ ...INPUT, log }, deps);
    expect(notices).toEqual([
      {
        kind: "claim_race_lost",
        message:
          "octo-owner/atelier-works#12: another work item is already active for the issue",
      },
    ]);
  });

  test("rethrows a failing insert", async () => {
    const { deps } = insertDeps(async () => {
      throw new Error("db down");
    });
    const { log } = recordingLog();
    await expect(
      registerManualIntakeWorkItem({ ...INPUT, log }, deps),
    ).rejects.toThrow("db down");
  });
});
