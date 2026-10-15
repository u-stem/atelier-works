// 一時的なGitHubの失敗で止まったpr_reviewの自動の再開を確かめる。
// 印の付け方、通知の判定、再開の巡回の3つを、外部への依存を差し替えて確かめる。

import { describe, expect, test } from "bun:test";
import {
  AUTO_RETRY_LIMIT_PER_RUN,
  AUTO_RETRY_MAX_RESTARTS,
  AUTO_RETRY_NOTE_PREFIX,
} from "../../f/factory/lib/auto_retry.ts";
import { TRANSIENT_GITHUB_REASON_PREFIX } from "../../f/factory/lib/auto_retry_reasons.ts";
import { GitHubHttpError } from "../../f/factory/lib/github.ts";
import type { Logger } from "../../f/factory/lib/log.ts";
import {
  decideTransientFailureAction,
  markTransientGitHubFailure,
  notifyStalledTransientReviews,
  PR_REVIEW_FLOW_PATH,
  retryTransientPrReviews,
  type StalledTransientDeps,
  TRANSIENT_RETRY_DELAYS_SECONDS,
  type TransientReviewCandidate,
  type TransientReviewDeps,
  transientReviewExhaustedNotice,
  transientReviewQuery,
  transientReviewStalledNotice,
} from "../../f/factory/lib/pr_review_retry.ts";

const SILENT: Logger = { info: () => {}, warn: () => {}, error: () => {} };

function candidate(id: number): TransientReviewCandidate {
  return {
    id,
    owner: "acme",
    repo: "widgets",
    pr_number: 12,
    flow_job_id: null,
  };
}

describe("markTransientGitHubFailure", () => {
  test("marks a 502 response with the transient prefix", () => {
    const err = new GitHubHttpError("POST pr review failed with HTTP 502", 502);
    const marked = markTransientGitHubFailure(err);
    expect(marked instanceof Error && marked.message).toBe(
      `${TRANSIENT_GITHUB_REASON_PREFIX}POST pr review failed with HTTP 502`,
    );
  });

  test("marks a failure without a response (status 0)", () => {
    const err = new GitHubHttpError("POST pr review failed with HTTP 0", 0);
    const marked = markTransientGitHubFailure(err);
    expect(
      marked instanceof Error &&
        marked.message.startsWith(TRANSIENT_GITHUB_REASON_PREFIX),
    ).toBe(true);
  });

  test("marks a timeout", () => {
    const err = new GitHubHttpError("failed with HTTP 0", 0, {
      exitCode: 1,
      timedOut: true,
    });
    expect(markTransientGitHubFailure(err)).not.toBe(err);
  });

  test("marks a connection failure of gh", () => {
    const err = new GitHubHttpError("failed with HTTP 0", 0, { exitCode: 1 });
    expect(markTransientGitHubFailure(err)).not.toBe(err);
  });

  test("keeps an authentication failure of gh as it is", () => {
    const err = new GitHubHttpError("failed with HTTP 0", 0, { exitCode: 4 });
    expect(markTransientGitHubFailure(err)).toBe(err);
  });

  test("keeps a 422 as it is, because the same input fails again", () => {
    const err = new GitHubHttpError("failed with HTTP 422", 422);
    expect(markTransientGitHubFailure(err)).toBe(err);
  });

  test("keeps a 403 as it is", () => {
    const err = new GitHubHttpError("failed with HTTP 403", 403);
    expect(markTransientGitHubFailure(err)).toBe(err);
  });

  test("keeps an error that is not an HTTP failure as it is", () => {
    const err = new Error("unexpected response shape");
    expect(markTransientGitHubFailure(err)).toBe(err);
  });
});

describe("decideTransientFailureAction", () => {
  const marked = `${TRANSIENT_GITHUB_REASON_PREFIX}failed with HTTP 502`;

  test("recovers silently while restarts remain", () => {
    expect(
      decideTransientFailureAction(PR_REVIEW_FLOW_PATH, marked, true, 0),
    ).toBe("recover");
  });

  test("still recovers on the last allowed restart", () => {
    expect(
      decideTransientFailureAction(
        PR_REVIEW_FLOW_PATH,
        marked,
        true,
        AUTO_RETRY_MAX_RESTARTS - 1,
      ),
    ).toBe("recover");
  });

  test("asks a human once the restarts are used up", () => {
    expect(
      decideTransientFailureAction(
        PR_REVIEW_FLOW_PATH,
        marked,
        true,
        AUTO_RETRY_MAX_RESTARTS,
      ),
    ).toBe("needs_human");
  });

  test("reports the failure when the work item was not marked failed", () => {
    expect(
      decideTransientFailureAction(PR_REVIEW_FLOW_PATH, marked, false, 0),
    ).toBe("job_failed");
  });

  test("reports a failure without the transient prefix", () => {
    expect(
      decideTransientFailureAction(
        PR_REVIEW_FLOW_PATH,
        "failed with HTTP 422",
        true,
        0,
      ),
    ).toBe("job_failed");
  });

  test("reports a transient failure of another flow", () => {
    expect(
      decideTransientFailureAction("f/factory/pr_fix", marked, true, 0),
    ).toBe("job_failed");
  });
});

describe("transientReviewExhaustedNotice", () => {
  const notice = transientReviewExhaustedNotice({
    instanceName: "test",
    owner: "acme",
    repo: "widgets",
    prNumber: 12,
    workItemId: 7,
    message: `${TRANSIENT_GITHUB_REASON_PREFIX}failed with HTTP 502`,
  });

  test("links to the pull request", () => {
    expect(notice.url).toBe("https://github.com/acme/widgets/pull/12");
  });

  test("names the pull request as the target", () => {
    expect(notice.target).toEqual({ kind: "pr", number: 12 });
  });

  test("tells the next action with the work item id", () => {
    expect(notice.next_action).toContain("retry_work_item");
    expect(notice.next_action).toContain("7");
  });
});

type Fake = {
  readonly deps: TransientReviewDeps;
  readonly launched: string[];
  readonly restarted: number[];
  readonly notified: number[];
};

function fakeDeps(
  candidates: readonly TransientReviewCandidate[],
  overrides: Partial<TransientReviewDeps> = {},
): Fake {
  const launched: string[] = [];
  const restarted: number[] = [];
  const notified: number[] = [];
  const deps: TransientReviewDeps = {
    listCandidates: async () => candidates,
    isFlowJobFinished: async () => true,
    restart: async (c) => {
      restarted.push(c.id);
      return true;
    },
    launchFlow: async (path) => {
      launched.push(path);
      return "01234567-89ab-cdef-0123-456789abcdef";
    },
    recordFlowJobId: async () => true,
    rollBack: async () => true,
    notifyRollBack: async (c) => {
      notified.push(c.id);
    },
    log: SILENT,
    ...overrides,
  };
  return { deps, launched, restarted, notified };
}

describe("retryTransientPrReviews", () => {
  test("starts the pr_review flow for a failed review", async () => {
    const fake = fakeDeps([candidate(7)]);
    await retryTransientPrReviews(fake.deps);
    expect(fake.launched).toEqual([PR_REVIEW_FLOW_PATH]);
  });

  test("counts the restarted work item", async () => {
    const fake = fakeDeps([candidate(7)]);
    const result = await retryTransientPrReviews(fake.deps);
    expect(result).toEqual({ restarted: 1, skipped: 0, failed: 0 });
  });

  test("skips a work item whose previous flow job is still running", async () => {
    const fake = fakeDeps([candidate(7)], {
      isFlowJobFinished: async () => false,
    });
    await retryTransientPrReviews(fake.deps);
    expect(fake.restarted).toEqual([]);
  });

  test("does not launch when the compare-and-swap loses", async () => {
    const fake = fakeDeps([candidate(7)], { restart: async () => false });
    await retryTransientPrReviews(fake.deps);
    expect(fake.launched).toEqual([]);
  });

  test("tells a human when the flow cannot be started", async () => {
    const fake = fakeDeps([candidate(7)], {
      launchFlow: async () => {
        throw new Error("windmill is down");
      },
    });
    await retryTransientPrReviews(fake.deps);
    expect(fake.notified).toEqual([7]);
  });

  test("writes a launch failure note that is not counted as a restart", async () => {
    const reasons: string[] = [];
    const fake = fakeDeps([candidate(7)], {
      launchFlow: async () => {
        throw new Error("windmill is down");
      },
      rollBack: async (_c, reason) => {
        reasons.push(reason);
        return true;
      },
    });
    await retryTransientPrReviews(fake.deps);
    expect(reasons[0]?.startsWith(AUTO_RETRY_NOTE_PREFIX)).toBe(false);
  });

  test("counts a launch failure as failed", async () => {
    const fake = fakeDeps([candidate(7)], {
      launchFlow: async () => {
        throw new Error("windmill is down");
      },
    });
    const result = await retryTransientPrReviews(fake.deps);
    expect(result.failed).toBe(1);
  });

  // 失敗の通知は、この巡回が再開することを前提に控えている。
  // 候補を取得できないことを握りつぶすと、誰にも届かないまま止まる。
  test("rejects when the candidates cannot be listed", async () => {
    const fake = fakeDeps([], {
      listCandidates: async () => {
        throw new Error("db down");
      },
    });
    await expect(retryTransientPrReviews(fake.deps)).rejects.toThrow("db down");
  });

  test("stops after the per-run limit", async () => {
    const many = Array.from({ length: AUTO_RETRY_LIMIT_PER_RUN + 2 }, (_, i) =>
      candidate(i + 1),
    );
    const fake = fakeDeps(many);
    await retryTransientPrReviews(fake.deps);
    expect(fake.restarted).toHaveLength(AUTO_RETRY_LIMIT_PER_RUN);
  });
});

describe("notifyStalledTransientReviews", () => {
  function stalledDeps(
    stalled: readonly TransientReviewCandidate[],
    overrides: Partial<StalledTransientDeps> = {},
  ) {
    const notified: number[] = [];
    const recorded: number[] = [];
    const deps: StalledTransientDeps = {
      listStalled: async () => stalled,
      notify: async (c) => {
        notified.push(c.id);
        return true;
      },
      recordStall: async (c) => {
        recorded.push(c.id);
        return true;
      },
      log: SILENT,
      ...overrides,
    };
    return { deps, notified, recorded };
  }

  test("tells a human about a work item that was not restarted", async () => {
    const fake = stalledDeps([candidate(7)]);
    await notifyStalledTransientReviews(fake.deps);
    expect(fake.notified).toEqual([7]);
  });

  test("records the stall after the notice was delivered", async () => {
    const fake = stalledDeps([candidate(7)]);
    await notifyStalledTransientReviews(fake.deps);
    expect(fake.recorded).toEqual([7]);
  });

  test("does not record the stall when the notice was not delivered", async () => {
    const fake = stalledDeps([candidate(7)], { notify: async () => false });
    await notifyStalledTransientReviews(fake.deps);
    expect(fake.recorded).toEqual([]);
  });

  test("does not record the stall when sending the notice throws", async () => {
    const fake = stalledDeps([candidate(7)], {
      notify: async () => {
        throw new Error("variable missing");
      },
    });
    await notifyStalledTransientReviews(fake.deps);
    expect(fake.recorded).toEqual([]);
  });

  test("counts only the notices that were delivered", async () => {
    const fake = stalledDeps([candidate(7), candidate(8)], {
      notify: async (c) => c.id === 8,
    });
    expect(await notifyStalledTransientReviews(fake.deps)).toBe(1);
  });

  test("continues with the next work item after a failure", async () => {
    const fake = stalledDeps([candidate(7), candidate(8)], {
      notify: async (c) => {
        if (c.id === 7) throw new Error("variable missing");
        return true;
      },
    });
    await notifyStalledTransientReviews(fake.deps);
    expect(fake.recorded).toEqual([8]);
  });

  test("rejects when the stalled candidates cannot be listed", async () => {
    const fake = stalledDeps([], {
      listStalled: async () => {
        throw new Error("db down");
      },
    });
    await expect(notifyStalledTransientReviews(fake.deps)).rejects.toThrow(
      "db down",
    );
  });
});

describe("transientReviewStalledNotice", () => {
  const notice = transientReviewStalledNotice({
    instanceName: "test",
    candidate: candidate(7),
  });

  test("links to the pull request", () => {
    expect(notice.url).toBe("https://github.com/acme/widgets/pull/12");
  });

  test("tells the next action with the work item id", () => {
    expect(notice.next_action).toContain("ID7");
  });
});

describe("retry delays", () => {
  test("cover every allowed restart", () => {
    expect(TRANSIENT_RETRY_DELAYS_SECONDS.length).toBeGreaterThanOrEqual(
      AUTO_RETRY_MAX_RESTARTS,
    );
  });

  test("grow with the number of restarts", () => {
    const sorted = [...TRANSIENT_RETRY_DELAYS_SECONDS].sort((a, b) => a - b);
    expect(TRANSIENT_RETRY_DELAYS_SECONDS).toEqual(sorted);
  });

  test("are shared with the queries through one object", () => {
    expect(transientReviewQuery().delaysSeconds).toBe(
      TRANSIENT_RETRY_DELAYS_SECONDS,
    );
  });
});
