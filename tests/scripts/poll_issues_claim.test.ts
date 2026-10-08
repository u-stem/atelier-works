// `poll_issues.ts`の`claimIssueWithNotice`、`notifyClaimOwnershipUnknown`、
// `recordLabelerAssociationDenied`のテスト。
// 取得の所有は、トリガーラベルの削除が成功したことで決まる。
// 所有できたときは、assigneeが付かなくても作業を続ける。
// 人へ知らせるのは、所有したかどうかを自動で判断できないときだけで、
// 1回のポーリングで該当したIssueは1件の通知にまとめる。
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
  type ClaimUnknownNotifyDeps,
  claimIssueWithNotice,
  type LabelerDeniedDeps,
  notifyClaimOwnershipUnknown,
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
};

function fakeDeps(
  claim: () => Promise<ClaimIssueResult>,
  overrides: Partial<ClaimNoticeDeps> = {},
): Fakes {
  const notices: Notice[] = [];
  const deps: ClaimNoticeDeps = {
    claimIssue: claim,
    addNoticeUnlessUnresolved: async (record) => {
      notices.push({ kind: record.kind, message: record.message });
      return notices.length;
    },
    ...overrides,
  };
  return { deps, notices };
}

function run(deps: ClaimNoticeDeps, log: Logger = silentLog): Promise<boolean> {
  return claimIssueWithNotice(
    {
      client: { run: async () => ok(), ghToken: "tok" },
      candidate: CANDIDATE,
      viewerLogin: "factory-bot",
      triggerLabel: "factory",
      log,
    },
    deps,
  );
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

  test("logs a warning when the confirmation read failed", async () => {
    const { deps } = fakeDeps(CLAIMED_UNKNOWN);
    const { log, warns } = recordingLog();
    await run(deps, log);
    expect(warns).toEqual(["claim assignee could not be confirmed"]);
  });

  test("passes the logger on to claimIssue", async () => {
    const { log } = recordingLog();
    const received: unknown[] = [];
    const { deps } = fakeDeps(CLAIMED_CONFIRMED, {
      claimIssue: async (_client, _owner, _repo, _number, opts) => {
        received.push(opts.log);
        return { claimed: true, assignee: "confirmed" };
      },
    });
    await run(deps, log);
    expect(received).toEqual([log]);
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
});

describe("claimIssueWithNotice when recording the lost race fails", () => {
  test("still returns false", async () => {
    const { deps } = fakeDeps(LOST, {
      addNoticeUnlessUnresolved: async () => {
        throw new Error("db down");
      },
    });
    expect(await run(deps)).toBe(false);
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
});

describe("claimIssueWithNotice when the ownership is unknown", () => {
  test("rethrows the error so that it is recorded as a failure", async () => {
    const { deps } = fakeDeps(OWNERSHIP_UNKNOWN);
    await expect(run(deps)).rejects.toBeInstanceOf(ClaimOwnershipUnknownError);
  });

  test("records no notice in the database", async () => {
    const { deps, notices } = fakeDeps(OWNERSHIP_UNKNOWN);
    await run(deps).catch(() => undefined);
    expect(notices).toEqual([]);
  });
});

describe("notifyClaimOwnershipUnknown", () => {
  const SINGLE_REASON =
    "ラベルの削除の結果を確かめられず、Issueを取得できたか分かりません";

  function candidateAt(number: number): IssueCandidate {
    return {
      ...CANDIDATE,
      number,
      htmlUrl: `https://github.com/octo-owner/atelier-works/issues/${String(number)}`,
    };
  }

  function sendDeps(): { deps: ClaimUnknownNotifyDeps; sent: Sent[] } {
    const sent: Sent[] = [];
    const deps: ClaimUnknownNotifyDeps = {
      notifyBestEffort: async (webhookUrl, event) => {
        sent.push({ webhookUrl, event });
        return { status: "sent" };
      },
    };
    return { deps, sent };
  }

  function notify(candidates: IssueCandidate[], deps: ClaimUnknownNotifyDeps) {
    return notifyClaimOwnershipUnknown(
      {
        candidates,
        instanceName: "local",
        discordWebhookUrl: WEBHOOK,
        log: silentLog,
      },
      deps,
    );
  }

  test("sends nothing when no issue is affected", async () => {
    const { deps, sent } = sendDeps();
    await notify([], deps);
    expect(sent).toEqual([]);
  });

  test("sends exactly one notification for one affected issue", async () => {
    const { deps, sent } = sendDeps();
    await notify([candidateAt(12)], deps);
    expect(sent).toHaveLength(1);
  });

  test("sends the notification to the configured webhook", async () => {
    const { deps, sent } = sendDeps();
    await notify([candidateAt(12)], deps);
    expect(sent[0]?.webhookUrl).toBe(WEBHOOK);
  });

  test("notifies a needs_human event", async () => {
    const { deps, sent } = sendDeps();
    await notify([candidateAt(12)], deps);
    expect(sent[0]?.event.kind).toBe("needs_human");
  });

  test("links to the issue", async () => {
    const { deps, sent } = sendDeps();
    await notify([candidateAt(12)], deps);
    const event = sent[0]?.event;
    expect(event?.kind === "needs_human" ? event.url : null).toBe(
      candidateAt(12).htmlUrl,
    );
  });

  test("targets the issue by number", async () => {
    const { deps, sent } = sendDeps();
    await notify([candidateAt(12)], deps);
    const event = sent[0]?.event;
    expect(event?.kind === "needs_human" ? event.target : null).toEqual({
      kind: "issue",
      number: 12,
    });
  });

  test("explains in the reason that the ownership could not be determined", async () => {
    const { deps, sent } = sendDeps();
    await notify([candidateAt(12)], deps);
    const event = sent[0]?.event;
    expect(event?.kind === "needs_human" ? event.reason : "").toBe(
      SINGLE_REASON,
    );
  });

  test("tells the operator to re-add the trigger label if no work has started", async () => {
    const { deps, sent } = sendDeps();
    await notify([candidateAt(12)], deps);
    const event = sent[0]?.event;
    expect(event?.kind === "needs_human" ? event.next_action : "").toContain(
      "`factory`ラベルを付け直してください",
    );
  });

  test("does not put a raw error into the notification", async () => {
    const { deps, sent } = sendDeps();
    await notify([candidateAt(12)], deps);
    expect(JSON.stringify(sent[0]?.event)).not.toContain("HTTP");
  });

  test("sends exactly one notification for several affected issues", async () => {
    const { deps, sent } = sendDeps();
    await notify([candidateAt(1), candidateAt(2), candidateAt(3)], deps);
    expect(sent).toHaveLength(1);
  });

  test("lists the link of every affected issue in the reason", async () => {
    const { deps, sent } = sendDeps();
    await notify([candidateAt(1), candidateAt(2), candidateAt(3)], deps);
    const event = sent[0]?.event;
    expect(event?.kind === "needs_human" ? event.reason : "").toBe(
      `${SINGLE_REASON}(3件)\n- https://github.com/octo-owner/atelier-works/issues/1\n- https://github.com/octo-owner/atelier-works/issues/2\n- https://github.com/octo-owner/atelier-works/issues/3`,
    );
  });

  test("targets the first affected issue when several are affected", async () => {
    const { deps, sent } = sendDeps();
    await notify([candidateAt(1), candidateAt(2)], deps);
    const event = sent[0]?.event;
    expect(event?.kind === "needs_human" ? event.target : null).toEqual({
      kind: "issue",
      number: 1,
    });
  });

  test("tells the operator to check each listed issue when several are affected", async () => {
    const { deps, sent } = sendDeps();
    await notify([candidateAt(1), candidateAt(2)], deps);
    const event = sent[0]?.event;
    expect(event?.kind === "needs_human" ? event.next_action : "").toBe(
      "一覧のIssueそれぞれについて、Consoleの作業項目で作業が始まっているか確かめてください。始まっていなければ、そのIssueに`factory`ラベルを付け直してください",
    );
  });

  test("lists at most ten issues and counts the rest", async () => {
    const { deps, sent } = sendDeps();
    const many = Array.from({ length: 12 }, (_, i) => candidateAt(i + 1));
    await notify(many, deps);
    const event = sent[0]?.event;
    const lines = (event?.kind === "needs_human" ? event.reason : "").split(
      "\n",
    );
    expect(lines.slice(-2)).toEqual([
      "- https://github.com/octo-owner/atelier-works/issues/10",
      "ほか2件",
    ]);
  });
});

describe("claimIssueWithNotice when the claim fails before the label is removed", () => {
  test("rethrows the original error", async () => {
    const { deps } = fakeDeps(BEFORE_LABEL_FAILS);
    await expect(run(deps)).rejects.toThrow("POST assignees failed");
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
