// `issue_proposal_apply.ts`を支える`pr_workflow_support.ts`の純粋関数と、
// `issue_proposal_apply.ts`自身の`readWithFactoryLabel`のテスト。
// 冪等性のための判断の分類、承認済みの提案のIssueを見つけて
// 二重に作らないための印の生成と判定、`is_inline`による返信先の決定を確かめる。

import { describe, expect, test } from "bun:test";
import type { RepoOwnerGateResult } from "../../f/factory/lib/repo_owner_gate.ts";
import { factoryRepoIdCheckReason } from "../../f/factory/lib/repo_owner_gate.ts";
import {
  ensureProposalRepoOwner,
  proposalRepoOwnerStop,
  readWithFactoryLabel,
  rejectionReplyStop,
  resolveFactoryLabel,
} from "../../f/factory/steps/issue_proposal_apply.ts";
import {
  appendIssueProposalMarker,
  chooseIssueProposalReplyTarget,
  classifyIssueProposalDecision,
  hasIssueProposalMarker,
  issueProposalMarkerSearchTerm,
  issueProposalMarkerText,
} from "../../f/factory/steps/pr_workflow_support.ts";

describe("readWithFactoryLabel", () => {
  test("reads a boolean with_factory_label from decision_options", () => {
    expect(readWithFactoryLabel({ with_factory_label: true })).toBe(true);
  });

  test("defaults to false when absent", () => {
    expect(readWithFactoryLabel({})).toBe(false);
  });

  test("defaults to false when not a boolean", () => {
    expect(readWithFactoryLabel({ with_factory_label: "true" })).toBe(false);
  });
});

describe("resolveFactoryLabel", () => {
  test("applies the label for a pr_fix proposal when requested", () => {
    expect(
      resolveFactoryLabel({
        requested: true,
        origin: "pr_fix",
        repoAllowed: true,
      }).apply,
    ).toBe(true);
  });

  test("refuses the label for an audit proposal when factory_repo is not allowed", () => {
    expect(
      resolveFactoryLabel({
        requested: true,
        origin: "audit",
        repoAllowed: false,
      }),
    ).toEqual({
      apply: false,
      reason:
        "factory_repo is not allowed by factory_config (owners / repo_allowlist)",
    });
  });

  test("does nothing when not requested", () => {
    expect(
      resolveFactoryLabel({
        requested: false,
        origin: "audit",
        repoAllowed: true,
      }).apply,
    ).toBe(false);
  });

  test("applies the label for a pr_fix proposal even when repoAllowed is false", () => {
    expect(
      resolveFactoryLabel({
        requested: true,
        origin: "pr_fix",
        repoAllowed: false,
      }).apply,
    ).toBe(true);
  });
});

describe("classifyIssueProposalDecision", () => {
  test("proceeds when the row is still pending", () => {
    const result = classifyIssueProposalDecision(
      { status: "pending", created_issue_number: null },
      { decision: "approve", reason: "", with_factory_label: false },
    );
    expect(result).toEqual({ action: "proceed" });
  });

  test("reposts only when already approved but the Issue was not yet created", () => {
    const result = classifyIssueProposalDecision(
      { status: "approved", created_issue_number: null },
      { decision: "approve", reason: "", with_factory_label: false },
    );
    expect(result).toEqual({ action: "repost_only" });
  });

  // `IssueProposalDecisionRow`は`with_factory_label`を持たないため、
  // 再試行で渡した`with_factory_label`はこの分類を変えない。
  // `issue_proposal_apply.ts`もIssueの作成をやり直すときは、
  // 再試行で渡した値ではなく、最初の承認で記録した`current.with_factory_label`を読む。
  // 後の再試行が何を求めても、最初の承認の選択が優先される。
  test("reposts only regardless of the retry's with_factory_label value", () => {
    const result = classifyIssueProposalDecision(
      { status: "approved", created_issue_number: null },
      { decision: "approve", reason: "", with_factory_label: true },
    );
    expect(result).toEqual({ action: "repost_only" });
  });

  test("reposts only when a reject decision is retried", () => {
    const result = classifyIssueProposalDecision(
      { status: "rejected", created_issue_number: null },
      {
        decision: "reject",
        reason: "scope外のため",
        with_factory_label: false,
      },
    );
    expect(result).toEqual({ action: "repost_only" });
  });

  test("refuses when already decided differently (approved, now asked to reject)", () => {
    const result = classifyIssueProposalDecision(
      { status: "approved", created_issue_number: 42 },
      {
        decision: "reject",
        reason: "scope外のため",
        with_factory_label: false,
      },
    );
    expect(result.action).toBe("refuse");
  });

  test("refuses when already decided differently (rejected, now asked to approve)", () => {
    const result = classifyIssueProposalDecision(
      { status: "rejected", created_issue_number: null },
      { decision: "approve", reason: "", with_factory_label: false },
    );
    expect(result.action).toBe("refuse");
  });

  test("classifies as already_done when approved and the Issue was already created", () => {
    const result = classifyIssueProposalDecision(
      { status: "approved", created_issue_number: 42 },
      { decision: "approve", reason: "", with_factory_label: false },
    );
    expect(result).toEqual({
      action: "already_done",
      created_issue_number: 42,
    });
  });

  test("refuse messages are Japanese and mention the conflicting decision", () => {
    const result = classifyIssueProposalDecision(
      { status: "approved", created_issue_number: null },
      {
        decision: "reject",
        reason: "scope外のため",
        with_factory_label: false,
      },
    );
    if (result.action !== "refuse") {
      throw new Error("expected a refuse classification");
    }
    expect(result.message).toContain("承認");
    expect(result.message).toContain("却下");
  });
});

describe("issueProposalMarkerSearchTerm / issueProposalMarkerText", () => {
  test("the search term has no HTML comment syntax", () => {
    expect(issueProposalMarkerSearchTerm(5)).toBe("factory:issue_proposal:5");
  });

  test("the marker text wraps the search term in an HTML comment", () => {
    expect(issueProposalMarkerText(5)).toBe(
      "<!-- factory:issue_proposal:5 -->",
    );
  });
});

describe("appendIssueProposalMarker / hasIssueProposalMarker", () => {
  test("appends the marker after a blank line", () => {
    const body = appendIssueProposalMarker("背景\n提案", 5);
    expect(body).toBe("背景\n提案\n\n<!-- factory:issue_proposal:5 -->");
  });

  test("hasIssueProposalMarker finds a marker built by appendIssueProposalMarker", () => {
    const body = appendIssueProposalMarker("背景", 5);
    expect(hasIssueProposalMarker(body, 5)).toBe(true);
  });

  test("hasIssueProposalMarker does not match a different proposal id", () => {
    const body = appendIssueProposalMarker("背景", 5);
    expect(hasIssueProposalMarker(body, 50)).toBe(false);
  });

  test("hasIssueProposalMarker returns false for plain text with no marker", () => {
    expect(hasIssueProposalMarker("just an issue body", 5)).toBe(false);
  });
});

describe("chooseIssueProposalReplyTarget", () => {
  test("chooses inline for an inline review comment", () => {
    expect(chooseIssueProposalReplyTarget(true)).toBe("inline");
  });

  test("chooses issue_comment for a plain issue comment", () => {
    expect(chooseIssueProposalReplyTarget(false)).toBe("issue_comment");
  });
});

describe("the owner check of an issue proposal", () => {
  const STOPPED_REASON =
    "repository owner id differs from factory_config owners: acme/widgets (expected 1, actual 2)";
  const STOPPED: RepoOwnerGateResult = { ok: false, reason: STOPPED_REASON };

  function verifyReturning(gate: RepoOwnerGateResult) {
    const calls: string[] = [];
    const verify = async () => {
      calls.push("verify");
      return gate;
    };
    return { verify, calls };
  }

  describe("proposalRepoOwnerStop", () => {
    test("returns null when the owner check passes", async () => {
      const { verify } = verifyReturning({ ok: true });
      expect(await proposalRepoOwnerStop(verify)).toBeNull();
    });

    test("returns the reason when the owner check stops the proposal", async () => {
      const { verify } = verifyReturning(STOPPED);
      expect(await proposalRepoOwnerStop(verify)).toBe(STOPPED_REASON);
    });

    test("checks once", async () => {
      const { verify, calls } = verifyReturning(STOPPED);
      await proposalRepoOwnerStop(verify);
      expect(calls).toEqual(["verify"]);
    });
  });

  describe("ensureProposalRepoOwner", () => {
    test("returns when the owner check passes", async () => {
      const { verify } = verifyReturning({ ok: true });
      await expect(ensureProposalRepoOwner(verify)).resolves.toBeUndefined();
    });

    test("rejects with the reason when the owner check stops the approval", async () => {
      const { verify } = verifyReturning(STOPPED);
      await expect(ensureProposalRepoOwner(verify)).rejects.toThrow(
        STOPPED_REASON,
      );
    });

    test("tells the next action in the error", async () => {
      const { verify } = verifyReturning(STOPPED);
      await expect(ensureProposalRepoOwner(verify)).rejects.toThrow("再度承認");
    });

    test("points an owner mismatch at owners", async () => {
      const { verify } = verifyReturning(STOPPED);
      await expect(ensureProposalRepoOwner(verify)).rejects.toThrow(
        "factory_configのownersを見直して",
      );
    });

    test("points a factory repository id mismatch at factory_repo and factory_repo_id", async () => {
      const { verify } = verifyReturning({
        ok: false,
        reason: factoryRepoIdCheckReason("acme/factory"),
      });
      await expect(ensureProposalRepoOwner(verify)).rejects.toThrow(
        "factory_configのfactory_repoとfactory_repo_idを見直して",
      );
    });

    test("propagates a failure of the check as it is", async () => {
      const failure = new Error("HTTP 502");
      await expect(
        ensureProposalRepoOwner(() => Promise.reject(failure)),
      ).rejects.toBe(failure);
    });

    test("checks once", async () => {
      const { verify, calls } = verifyReturning(STOPPED);
      await ensureProposalRepoOwner(verify).catch(() => undefined);
      expect(calls).toEqual(["verify"]);
    });
  });

  describe("rejectionReplyStop", () => {
    test("returns null when the owner check passes", async () => {
      const { verify } = verifyReturning({ ok: true });
      expect(await rejectionReplyStop(verify)).toBeNull();
    });

    test("returns the reason when the owner check stops the reply", async () => {
      const { verify } = verifyReturning(STOPPED);
      expect(await rejectionReplyStop(verify)).toBe(STOPPED_REASON);
    });

    test("stops the reply instead of throwing when the check fails", async () => {
      const stop = await rejectionReplyStop(() =>
        Promise.reject(new Error("HTTP 502")),
      );
      expect(stop).not.toBeNull();
    });

    test("names the failure of the check in the stop", async () => {
      const stop = await rejectionReplyStop(() =>
        Promise.reject(new Error("HTTP 502")),
      );
      expect(stop).toContain("HTTP 502");
    });

    test("masks secrets in the failure of the check", async () => {
      const token = `ghp_${"a".repeat(36)}`;
      const stop = await rejectionReplyStop(() =>
        Promise.reject(new Error(`failed with ${token}`)),
      );
      expect(stop).not.toContain(token);
    });
  });
});
