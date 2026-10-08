// `poll_issues.ts`の`claimIssueWithNotice`と`recordLabelerAssociationDenied`のテスト。
// 取得の所有は、トリガーラベルの削除が成功したことで決まる。
// 所有できたときは、assigneeが付かなくても作業を続ける。
// 人へ知らせるのは、所有したかどうかを自動で判断できないときだけである。
// 関係の検査で見送るIssueのnoticeは、ポーリングのたびに積み上がらない。

import { describe, expect, test } from "bun:test";
import type { NotifyEvent } from "../../f/factory/lib/discord.ts";
import {
  type ClaimIssueResult,
  ClaimOwnershipUnknownError,
} from "../../f/factory/lib/github.ts";
import type { Logger } from "../../f/factory/lib/log.ts";
import type { IssueCandidate } from "../../f/factory/lib/poll_support.ts";
import {
  type ClaimNoticeDeps,
  claimIssueWithNotice,
  type LabelerDeniedDeps,
  recordLabelerAssociationDenied,
} from "../../f/factory/poll_issues.ts";
import { ok } from "../lib/testSupport.ts";

const WEBHOOK = "https://discord.example/api/webhooks/1/token";
const CANDIDATE: IssueCandidate = {
  owner: "octo-owner",
  repo: "atelier-works",
  number: 12,
  title: "Add a thing",
  body: "please add a thing",
  htmlUrl: "https://github.com/octo-owner/atelier-works/issues/12",
  labelerAssociation: "NONE",
  hasActiveWorkItem: false,
};

const silentLog: Logger = { info() {}, warn() {}, error() {} };

type Notice = { kind: string; message: string };
type Sent = { webhookUrl: string; event: NotifyEvent };

type Fakes = {
  deps: ClaimNoticeDeps;
  notices: Notice[];
  sent: Sent[];
};

function fakeDeps(
  claim: () => Promise<ClaimIssueResult>,
  overrides: Partial<ClaimNoticeDeps> = {},
): Fakes {
  const notices: Notice[] = [];
  const sent: Sent[] = [];
  const deps: ClaimNoticeDeps = {
    claimIssue: claim,
    addNoticeUnlessUnresolved: async (record) => {
      notices.push({ kind: record.kind, message: record.message });
      return notices.length;
    },
    notifyBestEffort: async (webhookUrl, event) => {
      sent.push({ webhookUrl, event });
      return { status: "sent" };
    },
    ...overrides,
  };
  return { deps, notices, sent };
}

function run(deps: ClaimNoticeDeps): Promise<boolean> {
  return claimIssueWithNotice(
    {
      client: { run: async () => ok(), ghToken: "tok" },
      candidate: CANDIDATE,
      viewerLogin: "factory-bot",
      triggerLabel: "factory",
      instanceName: "local",
      discordWebhookUrl: WEBHOOK,
      log: silentLog,
    },
    deps,
  );
}

const CLAIMED_CONFIRMED = async (): Promise<ClaimIssueResult> => ({
  claimed: true,
  assignee: "confirmed",
});
const CLAIMED_MISSING = async (): Promise<ClaimIssueResult> => ({
  claimed: true,
  assignee: "missing",
});
const CLAIMED_UNKNOWN = async (): Promise<ClaimIssueResult> => ({
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
const OWNERSHIP_UNKNOWN = async (): Promise<ClaimIssueResult> => {
  throw new ClaimOwnershipUnknownError("DELETE issue label failed: HTTP 500");
};
const BEFORE_LABEL_FAILS = async (): Promise<ClaimIssueResult> => {
  throw new Error("POST assignees failed");
};

async function sentEvent(
  claim: () => Promise<ClaimIssueResult>,
): Promise<NotifyEvent | undefined> {
  const { deps, sent } = fakeDeps(claim);
  await run(deps).catch(() => undefined);
  return sent[0]?.event;
}

describe("claimIssueWithNotice when the claim is established", () => {
  test("returns true when the assignee is confirmed", async () => {
    const { deps } = fakeDeps(CLAIMED_CONFIRMED);
    expect(await run(deps)).toBe(true);
  });

  test("records no notice when the assignee is confirmed", async () => {
    const { deps, notices } = fakeDeps(CLAIMED_CONFIRMED);
    await run(deps);
    expect(notices).toEqual([]);
  });

  test("sends no notification when the assignee is confirmed", async () => {
    const { deps, sent } = fakeDeps(CLAIMED_CONFIRMED);
    await run(deps);
    expect(sent).toEqual([]);
  });

  test("returns true even when the assignee did not stick", async () => {
    const { deps } = fakeDeps(CLAIMED_MISSING);
    expect(await run(deps)).toBe(true);
  });

  test("records a claim_assignee_missing notice when the assignee did not stick", async () => {
    const { deps, notices } = fakeDeps(CLAIMED_MISSING);
    await run(deps);
    expect(notices.map((n) => n.kind)).toEqual(["claim_assignee_missing"]);
  });

  test("names the target and the viewer in the assignee notice", async () => {
    const { deps, notices } = fakeDeps(CLAIMED_MISSING);
    await run(deps);
    expect(notices[0]?.message).toContain(
      "octo-owner/atelier-works#12: assigneeにfactory-botを設定できませんでした",
    );
  });

  test("tells the operator to check the push access of the viewer in the assignee notice", async () => {
    const { deps, notices } = fakeDeps(CLAIMED_MISSING);
    await run(deps);
    expect(notices[0]?.message).toContain("push権限を持つcollaborator");
  });

  test("sends no needs_human notification when the assignee did not stick", async () => {
    const { deps, sent } = fakeDeps(CLAIMED_MISSING);
    await run(deps);
    expect(sent).toEqual([]);
  });

  test("returns true even when recording the assignee notice fails", async () => {
    const { deps } = fakeDeps(CLAIMED_MISSING, {
      addNoticeUnlessUnresolved: async () => {
        throw new Error("db down");
      },
    });
    expect(await run(deps)).toBe(true);
  });

  test("returns true when the confirmation read failed", async () => {
    const { deps } = fakeDeps(CLAIMED_UNKNOWN);
    expect(await run(deps)).toBe(true);
  });

  test("records no notice when the confirmation read failed", async () => {
    const { deps, notices } = fakeDeps(CLAIMED_UNKNOWN);
    await run(deps);
    expect(notices).toEqual([]);
  });
});

describe("claimIssueWithNotice when another instance won", () => {
  test("returns false", async () => {
    const { deps } = fakeDeps(LOST);
    expect(await run(deps)).toBe(false);
  });

  test("records a claim_race_lost notice with a stable message", async () => {
    const { deps, notices } = fakeDeps(LOST);
    await run(deps);
    expect(notices).toEqual([
      {
        kind: "claim_race_lost",
        message:
          "octo-owner/atelier-works#12: trigger label factory was already removed",
      },
    ]);
  });

  test("sends no notification", async () => {
    const { deps, sent } = fakeDeps(LOST);
    await run(deps);
    expect(sent).toEqual([]);
  });
});

describe("claimIssueWithNotice when the removal failed but the label remains", () => {
  test("returns false", async () => {
    const { deps } = fakeDeps(RETRY);
    expect(await run(deps)).toBe(false);
  });

  test("records no notice", async () => {
    const { deps, notices } = fakeDeps(RETRY);
    await run(deps);
    expect(notices).toEqual([]);
  });

  test("sends no notification", async () => {
    const { deps, sent } = fakeDeps(RETRY);
    await run(deps);
    expect(sent).toEqual([]);
  });
});

describe("claimIssueWithNotice when the ownership is unknown", () => {
  test("rethrows the error so that it is recorded as a failure", async () => {
    const { deps } = fakeDeps(OWNERSHIP_UNKNOWN);
    await expect(run(deps)).rejects.toBeInstanceOf(ClaimOwnershipUnknownError);
  });

  test("notifies a needs_human event", async () => {
    const event = await sentEvent(OWNERSHIP_UNKNOWN);
    expect(event?.kind).toBe("needs_human");
  });

  test("records no notice in the database", async () => {
    const { deps, notices } = fakeDeps(OWNERSHIP_UNKNOWN);
    await run(deps).catch(() => undefined);
    expect(notices).toEqual([]);
  });

  test("sends the notification to the configured webhook", async () => {
    const { deps, sent } = fakeDeps(OWNERSHIP_UNKNOWN);
    await run(deps).catch(() => undefined);
    expect(sent[0]?.webhookUrl).toBe(WEBHOOK);
  });

  test("links to the issue", async () => {
    const event = await sentEvent(OWNERSHIP_UNKNOWN);
    expect(event?.kind === "needs_human" ? event.url : null).toBe(
      CANDIDATE.htmlUrl,
    );
  });

  test("targets the issue by number", async () => {
    const event = await sentEvent(OWNERSHIP_UNKNOWN);
    expect(event?.kind === "needs_human" ? event.target : null).toEqual({
      kind: "issue",
      number: 12,
    });
  });

  test("tells the operator to re-add the trigger label if no work has started", async () => {
    const event = await sentEvent(OWNERSHIP_UNKNOWN);
    expect(event?.kind === "needs_human" ? event.next_action : "").toContain(
      "`factory`ラベルを付け直してください",
    );
  });

  test("explains in the reason that the ownership could not be determined", async () => {
    const event = await sentEvent(OWNERSHIP_UNKNOWN);
    expect(event?.kind === "needs_human" ? event.reason : "").toBe(
      "ラベルの削除の結果を確かめられず、Issueを取得できたか分かりません",
    );
  });

  test("does not put the raw error into the notification", async () => {
    const event = await sentEvent(OWNERSHIP_UNKNOWN);
    expect(JSON.stringify(event)).not.toContain("HTTP 500");
  });

  test("still rethrows when the notification fails", async () => {
    const { deps } = fakeDeps(OWNERSHIP_UNKNOWN, {
      notifyBestEffort: async () => ({
        status: "not_sent",
        reason: "discord down",
      }),
    });
    await expect(run(deps)).rejects.toBeInstanceOf(ClaimOwnershipUnknownError);
  });
});

describe("claimIssueWithNotice when the claim fails before the label is removed", () => {
  test("rethrows the original error", async () => {
    const { deps } = fakeDeps(BEFORE_LABEL_FAILS);
    await expect(run(deps)).rejects.toThrow("POST assignees failed");
  });

  test("sends no notification", async () => {
    const { deps, sent } = fakeDeps(BEFORE_LABEL_FAILS);
    await run(deps).catch(() => undefined);
    expect(sent).toEqual([]);
  });
});

describe("recordLabelerAssociationDenied", () => {
  function denyDeps(): { deps: LabelerDeniedDeps; recorded: Notice[] } {
    const recorded: Notice[] = [];
    const deps: LabelerDeniedDeps = {
      addNoticeUnlessUnresolved: async (record) => {
        recorded.push({ kind: record.kind, message: record.message });
        return null;
      },
    };
    return { deps, recorded };
  }

  const EXPECTED_MESSAGE =
    'octo-owner/atelier-works#12: 直近のラベル付与者のassociation "NONE" はallowed_labeler_associationsに含まれていません';

  test("records the notice through the unresolved-deduplicating path", async () => {
    const { deps, recorded } = denyDeps();
    await recordLabelerAssociationDenied(CANDIDATE, "NONE", deps);
    expect(recorded.map((n) => n.kind)).toEqual(["labeler_association_denied"]);
  });

  test("builds a message that holds only the target and the association", async () => {
    const { deps, recorded } = denyDeps();
    await recordLabelerAssociationDenied(CANDIDATE, "NONE", deps);
    expect(recorded[0]?.message).toBe(EXPECTED_MESSAGE);
  });

  test("builds the same message again on the next poll", async () => {
    const { deps, recorded } = denyDeps();
    await recordLabelerAssociationDenied(CANDIDATE, "NONE", deps);
    await recordLabelerAssociationDenied(CANDIDATE, "NONE", deps);
    expect(recorded[1]?.message).toBe(EXPECTED_MESSAGE);
  });

  test("falls back to unknown when the association is not known", async () => {
    const { deps, recorded } = denyDeps();
    await recordLabelerAssociationDenied(CANDIDATE, null, deps);
    expect(recorded[0]?.message).toContain('association "unknown"');
  });
});
