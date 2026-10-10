// `poll_issues.ts`の`claimIssueWithNotice`、`notifyClaimOwnershipUnknown`、
// `recordLabelerAssociationDenied`のテスト。
// 取得の所有は、トリガーラベルの削除が成功したことで決まる。
// 所有できたときは、assigneeが付かなくても作業を続ける。
// 人へ知らせるのは、所有したかどうかを自動で判断できないときだけで、
// 1回のポーリングで該当したIssueは1件の通知にまとめる。
// 関係の検査で見送るIssueのnoticeは、ポーリングのたびに積み上がらない。
// Issueを取得できたら、そのIssueの見送りのnoticeを解決済みにする。

import { describe, expect, test } from "bun:test";
import type { NotifyEvent } from "../../f/factory/lib/discord.ts";
import {
  type ClaimIssueResult,
  ClaimOwnershipUnknownError,
} from "../../f/factory/lib/github.ts";
import type { Logger } from "../../f/factory/lib/log.ts";
import type {
  IssueCandidate,
  IssueDecision,
} from "../../f/factory/lib/poll_support.ts";
import {
  type ClaimNoticeDeps,
  type ClaimUnknownNotifyDeps,
  claimIssueWithNotice,
  type DecisionHandlers,
  type LabelerDeniedDeps,
  labelerDeniedMessagePrefix,
  notifyClaimOwnershipUnknown,
  processIssueDecisions,
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

type Resolved = { kind: string; prefix: string; resolvedBy: string };

type Fakes = {
  deps: ClaimNoticeDeps;
  notices: Notice[];
  resolved: Resolved[];
};

function fakeDeps(
  claim: () => Promise<ClaimIssueResult>,
  overrides: Partial<ClaimNoticeDeps> = {},
): Fakes {
  const notices: Notice[] = [];
  const resolved: Resolved[] = [];
  const deps: ClaimNoticeDeps = {
    claimIssue: claim,
    addNoticeUnlessUnresolved: async (record) => {
      notices.push({ kind: record.kind, message: record.message });
      return notices.length;
    },
    resolveUnresolvedNoticesByPrefix: async (kind, prefix, resolvedBy) => {
      resolved.push({ kind, prefix, resolvedBy });
      return 1;
    },
    ...overrides,
  };
  return { deps, notices, resolved };
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
        triggerLabel: "factory",
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
      `${SINGLE_REASON}(3件)\n- octo-owner/atelier-works#1 https://github.com/octo-owner/atelier-works/issues/1\n- octo-owner/atelier-works#2 https://github.com/octo-owner/atelier-works/issues/2\n- octo-owner/atelier-works#3 https://github.com/octo-owner/atelier-works/issues/3`,
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

  test("qualifies each listed issue with its repository", async () => {
    const { deps, sent } = sendDeps();
    const other: IssueCandidate = {
      ...candidateAt(7),
      owner: "other-owner",
      repo: "other-repo",
      htmlUrl: "https://github.com/other-owner/other-repo/issues/7",
    };
    await notify([candidateAt(1), other], deps);
    const event = sent[0]?.event;
    const lines = (event?.kind === "needs_human" ? event.reason : "").split(
      "\n",
    );
    expect(lines.slice(1)).toEqual([
      "- octo-owner/atelier-works#1 https://github.com/octo-owner/atelier-works/issues/1",
      "- other-owner/other-repo#7 https://github.com/other-owner/other-repo/issues/7",
    ]);
  });

  test("names the configured trigger label in the next action when several are affected", async () => {
    const { deps, sent } = sendDeps();
    await notifyClaimOwnershipUnknown(
      {
        candidates: [candidateAt(1), candidateAt(2)],
        triggerLabel: "factory-custom",
        instanceName: "local",
        discordWebhookUrl: WEBHOOK,
        log: silentLog,
      },
      deps,
    );
    const event = sent[0]?.event;
    expect(event?.kind === "needs_human" ? event.next_action : "").toContain(
      "`factory-custom`ラベルを付け直してください",
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
      "- octo-owner/atelier-works#10 https://github.com/octo-owner/atelier-works/issues/10",
      "ほか2件",
    ]);
  });
});

describe("claimIssueWithNotice resolves the labeler_association_denied notice", () => {
  test("resolves the notice of the claimed issue", async () => {
    const { deps, resolved } = fakeDeps(CLAIMED_CONFIRMED);
    await run(deps);
    expect(resolved).toEqual([
      {
        kind: "labeler_association_denied",
        prefix: "octo-owner/atelier-works#12: ",
        resolvedBy: "poll_issues",
      },
    ]);
  });

  test("resolves the notice even when the assignee did not stick", async () => {
    const { deps, resolved } = fakeDeps(CLAIMED_MISSING);
    await run(deps);
    expect(resolved).toHaveLength(1);
  });

  test("resolves the notice even when the confirmation read failed", async () => {
    const { deps, resolved } = fakeDeps(CLAIMED_UNKNOWN);
    await run(deps);
    expect(resolved).toHaveLength(1);
  });

  test("keeps the notice when another instance won", async () => {
    const { deps, resolved } = fakeDeps(LOST);
    await run(deps);
    expect(resolved).toEqual([]);
  });

  test("keeps the notice when the label remains", async () => {
    const { deps, resolved } = fakeDeps(RETRY);
    await run(deps);
    expect(resolved).toEqual([]);
  });

  test("returns true even when resolving the notice fails", async () => {
    const { deps } = fakeDeps(CLAIMED_CONFIRMED, {
      resolveUnresolvedNoticesByPrefix: async () => {
        throw new Error("db down");
      },
    });
    expect(await run(deps)).toBe(true);
  });

  test("logs a warning when resolving the notice fails", async () => {
    const { deps } = fakeDeps(CLAIMED_CONFIRMED, {
      resolveUnresolvedNoticesByPrefix: async () => {
        throw new Error("db down");
      },
    });
    const { log, warns } = recordingLog();
    await run(deps, log);
    expect(warns).toEqual([
      "labeler_association_denied notices could not be resolved",
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

  test("starts the message with the prefix used to resolve it", async () => {
    const { deps, recorded } = denyDeps();
    await recordLabelerAssociationDenied(CANDIDATE, "NONE", deps);
    expect(
      recorded[0]?.message.startsWith(labelerDeniedMessagePrefix(CANDIDATE)),
    ).toBe(true);
  });

  test("does not let the prefix of one issue match another issue number", async () => {
    const { deps, recorded } = denyDeps();
    await recordLabelerAssociationDenied(
      { ...CANDIDATE, number: 120 },
      "NONE",
      deps,
    );
    expect(
      recorded[0]?.message.startsWith(labelerDeniedMessagePrefix(CANDIDATE)),
    ).toBe(false);
  });

  test("falls back to unknown when the association is not known", async () => {
    const { deps, recorded } = denyDeps();
    await recordLabelerAssociationDenied(CANDIDATE, null, deps);
    expect(recorded[0]?.message).toContain('association "unknown"');
  });
});

describe("processIssueDecisions", () => {
  function candidateAt(number: number): IssueCandidate {
    return {
      ...CANDIDATE,
      number,
      htmlUrl: `https://github.com/octo-owner/atelier-works/issues/${String(number)}`,
    };
  }

  const claimDecision = (n: number): IssueDecision => ({
    action: "claim",
    candidate: candidateAt(n),
  });

  type Recorded = {
    failures: string[];
    denied: number[];
    notified: number[][];
  };

  function handlers(
    claim: (candidate: IssueCandidate) => Promise<"claimed" | "skipped">,
    overrides: Partial<DecisionHandlers> = {},
  ): { handlers: DecisionHandlers; recorded: Recorded } {
    const recorded: Recorded = { failures: [], denied: [], notified: [] };
    return {
      recorded,
      handlers: {
        claim,
        recordDenied: async (candidate) => {
          recorded.denied.push(candidate.number);
        },
        recordFailure: async (step) => {
          recorded.failures.push(step);
        },
        notifyOwnershipUnknown: async (candidates) => {
          recorded.notified.push(candidates.map((c) => c.number));
        },
        ...overrides,
      },
    };
  }

  const unknownFor =
    (...numbers: number[]) =>
    async (c: IssueCandidate) => {
      if (numbers.includes(c.number)) {
        throw new ClaimOwnershipUnknownError("unknown");
      }
      return "claimed" as const;
    };

  test("counts claimed issues", async () => {
    const { handlers: h } = handlers(async () => "claimed");
    const result = await processIssueDecisions(
      [claimDecision(1), claimDecision(2)],
      h,
    );
    expect(result.claimed).toBe(2);
  });

  test("counts skipped claims", async () => {
    const { handlers: h } = handlers(async () => "skipped");
    const result = await processIssueDecisions([claimDecision(1)], h);
    expect(result.skipped).toBe(1);
  });

  test("counts an active issue as skipped", async () => {
    const { handlers: h } = handlers(async () => "claimed");
    const result = await processIssueDecisions(
      [{ action: "skip_active", candidate: candidateAt(1) }],
      h,
    );
    expect(result.skipped).toBe(1);
  });

  test("does not claim an active issue", async () => {
    const { handlers: h } = handlers(async () => "claimed");
    const result = await processIssueDecisions(
      [{ action: "skip_active", candidate: candidateAt(1) }],
      h,
    );
    expect(result.claimed).toBe(0);
  });

  test("records no failure for an active issue", async () => {
    const { handlers: h, recorded } = handlers(async () => "claimed");
    await processIssueDecisions(
      [{ action: "skip_active", candidate: candidateAt(1) }],
      h,
    );
    expect(recorded.failures).toEqual([]);
  });

  const denied = (n: number): IssueDecision => ({
    action: "skip_association",
    candidate: candidateAt(n),
    association: "NONE",
  });

  test("counts a denied association as skipped", async () => {
    const { handlers: h } = handlers(async () => "claimed");
    const result = await processIssueDecisions([denied(4)], h);
    expect(result.skipped).toBe(1);
  });

  test("records the denied association of the issue", async () => {
    const { handlers: h, recorded } = handlers(async () => "claimed");
    await processIssueDecisions([denied(4)], h);
    expect(recorded.denied).toEqual([4]);
  });

  const failingDenial: Partial<DecisionHandlers> = {
    recordDenied: async () => {
      throw new Error("db down");
    },
  };

  test("counts a failing denial as failed", async () => {
    const { handlers: h } = handlers(async () => "claimed", failingDenial);
    const result = await processIssueDecisions(
      [denied(4), claimDecision(5)],
      h,
    );
    expect(result.failed).toBe(1);
  });

  test("goes on with the next issue after a failing denial", async () => {
    const { handlers: h } = handlers(async () => "claimed", failingDenial);
    const result = await processIssueDecisions(
      [denied(4), claimDecision(5)],
      h,
    );
    expect(result.claimed).toBe(1);
  });

  test("names the failing denial step after the issue", async () => {
    const { handlers: h, recorded } = handlers(
      async () => "claimed",
      failingDenial,
    );
    await processIssueDecisions([denied(4)], h);
    expect(recorded.failures).toEqual([
      "labeler_denied:octo-owner/atelier-works#4",
    ]);
  });

  const failingClaim = async (): Promise<"claimed" | "skipped"> => {
    throw new Error("claim failed");
  };

  test("counts a failing claim as failed", async () => {
    const { handlers: h } = handlers(failingClaim);
    const result = await processIssueDecisions([claimDecision(1)], h);
    expect(result.failed).toBe(1);
  });

  test("records a failing claim under the issue", async () => {
    const { handlers: h, recorded } = handlers(failingClaim);
    await processIssueDecisions([claimDecision(1)], h);
    expect(recorded.failures).toEqual([
      "claim_issue:octo-owner/atelier-works#1",
    ]);
  });

  test("notifies once with only the issues whose ownership is unknown", async () => {
    const { handlers: h, recorded } = handlers(unknownFor(1, 3));
    await processIssueDecisions(
      [claimDecision(1), claimDecision(2), claimDecision(3)],
      h,
    );
    expect(recorded.notified).toEqual([[1, 3]]);
  });

  test("does not list an issue whose claim failed for another reason", async () => {
    const { handlers: h, recorded } = handlers(async () => {
      throw new Error("claim failed");
    });
    await processIssueDecisions([claimDecision(1)], h);
    expect(recorded.notified).toEqual([[]]);
  });

  test("still notifies when recording a later failure throws", async () => {
    const { handlers: h, recorded } = handlers(
      async (c) => {
        if (c.number === 1) throw new ClaimOwnershipUnknownError("unknown");
        throw new Error("claim failed");
      },
      {
        recordFailure: async (step) => {
          if (step.endsWith("#2")) throw new Error("db down");
        },
      },
    );
    await processIssueDecisions([claimDecision(1), claimDecision(2)], h).catch(
      () => undefined,
    );
    expect(recorded.notified).toEqual([[1]]);
  });

  test("rethrows the error of a later failure after notifying", async () => {
    const { handlers: h } = handlers(
      async (c) => {
        if (c.number === 1) throw new ClaimOwnershipUnknownError("unknown");
        throw new Error("claim failed");
      },
      {
        recordFailure: async (step) => {
          if (step.endsWith("#2")) throw new Error("db down");
        },
      },
    );
    const processing = processIssueDecisions(
      [claimDecision(1), claimDecision(2)],
      h,
    );
    await expect(processing).rejects.toThrow("db down");
  });

  const failingNotify: Partial<DecisionHandlers> = {
    notifyOwnershipUnknown: async () => {
      throw new Error("discord down");
    },
  };

  const laterFailure = (): Partial<DecisionHandlers> => ({
    recordFailure: async (step) => {
      if (step.endsWith("#2")) throw new Error("db down");
    },
    ...failingNotify,
  });

  const unknownThenFailing = async (c: IssueCandidate) => {
    if (c.number === 1) throw new ClaimOwnershipUnknownError("unknown");
    throw new Error("claim failed");
  };

  test("rethrows the original loop error when the notification also throws", async () => {
    const { handlers: h } = handlers(unknownThenFailing, laterFailure());
    const processing = processIssueDecisions(
      [claimDecision(1), claimDecision(2)],
      h,
    );
    await expect(processing).rejects.toThrow("db down");
  });

  test("logs the notification failure when the loop already failed", async () => {
    const { handlers: h } = handlers(unknownThenFailing, laterFailure());
    const errors: string[] = [];
    const log: Logger = {
      info() {},
      warn() {},
      error(message) {
        errors.push(message);
      },
    };
    await processIssueDecisions(
      [claimDecision(1), claimDecision(2)],
      h,
      log,
    ).catch(() => undefined);
    expect(errors).toEqual(["failed to notify claims with unknown ownership"]);
  });

  test("rethrows the notification error when the loop itself succeeded", async () => {
    const { handlers: h } = handlers(async () => "claimed", failingNotify);
    const processing = processIssueDecisions([claimDecision(1)], h);
    await expect(processing).rejects.toThrow("discord down");
  });
});
