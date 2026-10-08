// `poll_issues.ts`の`claimIssueWithNotice`と`recordLabelerAssociationDenied`のテスト。
// 取得でトリガーラベルが外れた後に確認できなかったときは、ラベルも作業項目も
// 無いまま止まるので、Issueへのリンクと次の操作を載せた通知を送る。
// 関係の検査で見送るIssueのnoticeは、ポーリングのたびに積み上がらない。

import { describe, expect, test } from "bun:test";
import type { NotifyEvent } from "../../f/factory/lib/discord.ts";
import {
  ClaimConfirmationError,
  type ClaimIssueResult,
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

function fakeDeps(claim: () => Promise<ClaimIssueResult>): {
  deps: ClaimNoticeDeps;
  notices: Notice[];
  sent: Sent[];
} {
  const notices: Notice[] = [];
  const sent: Sent[] = [];
  const deps: ClaimNoticeDeps = {
    claimIssue: claim,
    addNotice: async (record) => {
      notices.push({ kind: record.kind, message: record.message });
      return notices.length;
    },
    notifyBestEffort: async (webhookUrl, event) => {
      sent.push({ webhookUrl, event });
      return { status: "sent" };
    },
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

const CLAIMED = async (): Promise<ClaimIssueResult> => ({ claimed: true });
const ASSIGNEE_MISSING_LABEL_GONE = async (): Promise<ClaimIssueResult> => ({
  claimed: false,
  reason: "assignee factory-bot missing after claim",
  labelConsumed: true,
});
const LABEL_STILL_PRESENT = async (): Promise<ClaimIssueResult> => ({
  claimed: false,
  reason: "trigger label factory still present after claim",
  labelConsumed: false,
});
const CONFIRM_FAILS = async (): Promise<ClaimIssueResult> => {
  throw new ClaimConfirmationError("GET issue failed: HTTP 500");
};

async function sentEvent(
  claim: () => Promise<ClaimIssueResult>,
): Promise<NotifyEvent | undefined> {
  const { deps, sent } = fakeDeps(claim);
  await run(deps).catch(() => undefined);
  return sent[0]?.event;
}

describe("claimIssueWithNotice", () => {
  test("returns true when the claim succeeds", async () => {
    const { deps } = fakeDeps(CLAIMED);
    expect(await run(deps)).toBe(true);
  });

  test("sends no notification when the claim succeeds", async () => {
    const { deps, sent } = fakeDeps(CLAIMED);
    await run(deps);
    expect(sent).toEqual([]);
  });

  test("returns false when the claim was not established", async () => {
    const { deps } = fakeDeps(ASSIGNEE_MISSING_LABEL_GONE);
    expect(await run(deps)).toBe(false);
  });

  test("records a claim_race_lost notice when the claim was not established", async () => {
    const { deps, notices } = fakeDeps(ASSIGNEE_MISSING_LABEL_GONE);
    await run(deps);
    expect(notices.map((n) => n.kind)).toEqual(["claim_race_lost"]);
  });

  test("notifies a needs_human event when the label was consumed but the claim was not established", async () => {
    const event = await sentEvent(ASSIGNEE_MISSING_LABEL_GONE);
    expect(event?.kind).toBe("needs_human");
  });

  test("sends no notification when the trigger label is still present", async () => {
    const { deps, sent } = fakeDeps(LABEL_STILL_PRESENT);
    await run(deps);
    expect(sent).toEqual([]);
  });

  test("rethrows the confirmation error so that it is recorded as a failure", async () => {
    const { deps } = fakeDeps(CONFIRM_FAILS);
    await expect(run(deps)).rejects.toBeInstanceOf(ClaimConfirmationError);
  });

  test("notifies a needs_human event when the confirmation read fails", async () => {
    const event = await sentEvent(CONFIRM_FAILS);
    expect(event?.kind).toBe("needs_human");
  });

  test("sends the notification to the configured webhook", async () => {
    const { deps, sent } = fakeDeps(CONFIRM_FAILS);
    await run(deps).catch(() => undefined);
    expect(sent[0]?.webhookUrl).toBe(WEBHOOK);
  });

  test("links to the issue", async () => {
    const event = await sentEvent(CONFIRM_FAILS);
    expect(event?.kind === "needs_human" ? event.url : null).toBe(
      CANDIDATE.htmlUrl,
    );
  });

  test("targets the issue by number", async () => {
    const event = await sentEvent(CONFIRM_FAILS);
    expect(event?.kind === "needs_human" ? event.target : null).toEqual({
      kind: "issue",
      number: 12,
    });
  });

  test("tells the operator to re-add the trigger label as the next action", async () => {
    const event = await sentEvent(CONFIRM_FAILS);
    expect(event?.kind === "needs_human" ? event.next_action : "").toContain(
      "`factory`ラベルを付け直してください",
    );
  });

  test("explains in the reason that the claim could not be confirmed", async () => {
    const event = await sentEvent(CONFIRM_FAILS);
    expect(event?.kind === "needs_human" ? event.reason : "").toBe(
      "Issueを取得しましたが、取得後の状態を確認できませんでした",
    );
  });

  test("does not put the raw error into the notification", async () => {
    const event = await sentEvent(CONFIRM_FAILS);
    expect(JSON.stringify(event)).not.toContain("HTTP 500");
  });

  test("rethrows a failure that happened before the label was removed without notifying", async () => {
    const { deps, sent } = fakeDeps(async () => {
      throw new Error("POST assignees failed");
    });
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

  test("records the notice through the unresolved-deduplicating path", async () => {
    const { deps, recorded } = denyDeps();
    await recordLabelerAssociationDenied(CANDIDATE, "NONE", deps);
    expect(recorded.map((n) => n.kind)).toEqual(["labeler_association_denied"]);
  });

  test("builds the same message on every call for the same candidate", async () => {
    const { deps, recorded } = denyDeps();
    await recordLabelerAssociationDenied(CANDIDATE, "NONE", deps);
    await recordLabelerAssociationDenied(CANDIDATE, "NONE", deps);
    expect(recorded[0]?.message).toBe(recorded[1]?.message);
  });

  test("names the target and the association in the message", async () => {
    const { deps, recorded } = denyDeps();
    await recordLabelerAssociationDenied(CANDIDATE, "NONE", deps);
    expect(recorded[0]?.message).toContain(
      'octo-owner/atelier-works#12: 直近のラベル付与者のassociation "NONE"',
    );
  });

  test("falls back to unknown when the association is not known", async () => {
    const { deps, recorded } = denyDeps();
    await recordLabelerAssociationDenied(CANDIDATE, null, deps);
    expect(recorded[0]?.message).toContain('association "unknown"');
  });
});
