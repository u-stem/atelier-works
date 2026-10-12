// `poll_prs.ts`の`buildPrCandidate`が、PRのトリガーラベルの付与者と作成者を
// 候補に載せるまでの経路のテスト。
// GitHubの応答は本物のAPIの形にする。ラベルの`labeled`イベントは
// `author_association`を持たない。

import { describe, expect, test } from "bun:test";
import {
  LabelerCheckLimitError,
  type PrSearchItem,
} from "../../f/factory/lib/github.ts";
import {
  decidePrActions,
  type LabelerPolicy,
} from "../../f/factory/lib/poll_support.ts";
import type { WorkItem } from "../../f/factory/lib/types.ts";
import type { CommandResult } from "../../f/factory/lib/workspace.ts";
import {
  type BuildPrCandidateDeps,
  buildPrCandidate,
} from "../../f/factory/poll_prs.ts";
import {
  ghApiOk,
  ghApiStdout,
  labelEventNode,
  labelEventsOk,
  ok,
} from "../lib/testSupport.ts";

const FOUND: PrSearchItem = {
  owner: "octo-owner",
  repo: "atelier-works",
  number: 7,
  title: "Fix the thing",
  htmlUrl: "https://github.com/octo-owner/atelier-works/pull/7",
};
const LABELS = { reviewLabel: "factory:review", fixLabel: "factory:fix" };
const DEPS: BuildPrCandidateDeps = {
  latestPrWorkItem: async () => null,
  findApprovedWorkItemForIssue: async () => null,
};

const labeled = (login: string | null, label: string) =>
  labelEventNode("labeled", login, label);

type World = {
  readonly labels: readonly string[];
  readonly author?: string | null;
  /** PRのheadのリポジトリの`full_name`。省略は`null`(取得できない)。 */
  readonly headRepo?: string;
  readonly baseRepo?: string;
  readonly events: CommandResult;
};

/** エンドポイントごとに応答する偽のrunner。イベントの取得回数を数える。 */
function world(w: World) {
  let eventCalls = 0;
  const run = async (argv: readonly string[]): Promise<CommandResult> => {
    const endpoint = argv.find((arg) => arg.startsWith("repo")) ?? "";
    if (argv.includes("graphql")) {
      eventCalls += 1;
      return w.events;
    }
    if (endpoint.includes("/reviews") || endpoint.includes("/comments")) {
      return ghApiOk([]);
    }
    if (endpoint.endsWith("/pulls/7")) {
      return ghApiOk({
        number: 7,
        title: "Fix the thing",
        body: "",
        draft: false,
        state: "open",
        merged: false,
        head: {
          sha: "aaaaaaa",
          ref: "feature",
          repo: w.headRepo === undefined ? null : { full_name: w.headRepo },
        },
        base: {
          ref: "main",
          repo: w.baseRepo === undefined ? null : { full_name: w.baseRepo },
        },
        mergeable_state: "clean",
        user: w.author === null ? null : { login: w.author ?? "octo-owner" },
      });
    }
    if (endpoint.endsWith("/issues/7")) {
      return ghApiOk({
        number: 7,
        title: "Fix the thing",
        body: "",
        html_url: FOUND.htmlUrl,
        state: "open",
        user: { login: "octo-owner" },
        labels: w.labels.map((name) => ({ name })),
        assignees: [],
      });
    }
    return ok(ghApiStdout(404, { message: "Not Found" }));
  };
  return { run, eventCalls: () => eventCalls };
}

async function build(w: World) {
  const fake = world(w);
  const context = await buildPrCandidate(
    { run: fake.run, ghToken: "tok" },
    FOUND,
    "octo-owner",
    [],
    LABELS,
    DEPS,
  );
  return { candidate: context.candidate, fake };
}

describe("buildPrCandidate labelers", () => {
  const BOTH = labelEventsOk([
    labelEventNode(
      "labeled",
      "alice",
      "factory:review",
      "2026-10-01T00:00:01Z",
    ),
    labelEventNode("labeled", "bob", "factory:fix", "2026-10-01T00:00:02Z"),
  ]);

  test("takes the review label's labeler for the review label", async () => {
    const { candidate } = await build({
      labels: ["factory:review", "factory:fix"],
      events: BOTH,
    });
    expect(candidate.reviewLabelerLogin).toBe("alice");
  });

  test("takes the fix label's labeler for the fix label", async () => {
    const { candidate } = await build({
      labels: ["factory:review", "factory:fix"],
      events: BOTH,
    });
    expect(candidate.fixLabelerLogin).toBe("bob");
  });

  test("leaves the fix labeler empty when only the review label is on the PR", async () => {
    const { candidate } = await build({
      labels: ["factory:review"],
      events: BOTH,
    });
    expect(candidate.fixLabelerLogin).toBeNull();
  });

  test("does not fetch the label events when no trigger label is on the PR", async () => {
    const { fake } = await build({ labels: ["documentation"], events: BOTH });
    expect(fake.eventCalls()).toBe(0);
  });

  test("fetches the label events once per trigger label on the PR", async () => {
    const { fake } = await build({
      labels: ["factory:review", "factory:fix"],
      events: BOTH,
    });
    expect(fake.eventCalls()).toBe(2);
  });

  test("finds a trigger label whose case differs from the config", async () => {
    const { candidate } = await build({
      labels: ["Factory:Review"],
      events: labelEventsOk([labeled("alice", "Factory:Review")]),
    });
    expect(candidate.reviewLabelerLogin).toBe("alice");
  });

  test("leaves the labeler empty when the label's event has no actor", async () => {
    const { candidate } = await build({
      labels: ["factory:review"],
      events: labelEventsOk([labeled(null, "factory:review")]),
    });
    expect(candidate.reviewLabelerLogin).toBeNull();
  });

  test("throws LabelerCheckLimitError when the label is not among the latest events", async () => {
    const result = build({
      labels: ["factory:review"],
      events: labelEventsOk([labeled("alice", "documentation")], true),
    });
    await expect(result).rejects.toThrow(LabelerCheckLimitError);
  });

  test("throws when the label events cannot be fetched", async () => {
    const result = build({
      labels: ["factory:review"],
      events: ok(ghApiStdout(500, { message: "boom" })),
    });
    await expect(result).rejects.toThrow();
  });
});

describe("buildPrCandidate author", () => {
  test("carries the PR author's login", async () => {
    const { candidate } = await build({
      labels: [],
      author: "mallory",
      events: labelEventsOk([]),
    });
    expect(candidate.authorLogin).toBe("mallory");
  });

  test("leaves the author empty when the PR has no user", async () => {
    const { candidate } = await build({
      labels: [],
      author: null,
      events: labelEventsOk([]),
    });
    expect(candidate.authorLogin).toBeNull();
  });
});

describe("buildPrCandidate head branch", () => {
  test("carries the head branch name", async () => {
    const { candidate } = await build({
      labels: [],
      events: labelEventsOk([]),
    });
    expect(candidate.headRef).toBe("feature");
  });
});

describe("buildPrCandidate head repository", () => {
  test("marks a head in the base repository", async () => {
    const { candidate } = await build({
      labels: [],
      headRepo: "octo-owner/atelier-works",
      baseRepo: "octo-owner/atelier-works",
      events: labelEventsOk([]),
    });
    expect(candidate.headInBaseRepo).toBe(true);
  });

  test("does not mark a head in a fork", async () => {
    const { candidate } = await build({
      labels: [],
      headRepo: "mallory/atelier-works",
      baseRepo: "octo-owner/atelier-works",
      events: labelEventsOk([]),
    });
    expect(candidate.headInBaseRepo).toBe(false);
  });

  test("does not mark a head whose repository is unavailable", async () => {
    const { candidate } = await build({
      labels: [],
      baseRepo: "octo-owner/atelier-works",
      events: labelEventsOk([]),
    });
    expect(candidate.headInBaseRepo).toBe(false);
  });
});

// dependabotの作業項目は、同じPRのpr_reviewとpr_fixの判断に混ぜない。
// 実行中のレビューの有無と修正のラウンドは、それぞれの種別の行だけから決まることを確かめる。
describe("buildPrCandidate with dependabot work items", () => {
  const DEPENDABOT_ROW: WorkItem = {
    id: 50,
    cycle: 1,
    source: "issue",
    kind: "dependabot",
    owner: "octo-owner",
    repo: "atelier-works",
    issue_number: null,
    issue_url: null,
    pr_number: 7,
    title: null,
    body: null,
    status: "picked",
    attempt: 1,
    claimed_by: null,
    flow_job_id: null,
    resume_url: null,
    cancel_url: null,
    head_sha: "b".repeat(40),
    last_review_id: null,
    last_comment_id: null,
    last_review_comment_id: null,
    observed_review_id: null,
    observed_comment_id: null,
    observed_review_comment_id: null,
    fix_round: 3,
    parent_work_item_id: null,
    branch: null,
    pr_url: null,
    created_at: new Date("2026-10-12T00:00:00Z"),
    updated_at: new Date("2026-10-12T00:00:00Z"),
  };

  /** 種類を問わない最新の行はdependabotの行で、pr_fixの行は無いDB。 */
  const DEPENDABOT_ONLY: BuildPrCandidateDeps = {
    latestPrWorkItem: async (_owner, _repo, _number, opts) =>
      opts?.kind === undefined || opts.kind === "dependabot"
        ? DEPENDABOT_ROW
        : null,
    findApprovedWorkItemForIssue: async () => null,
  };

  async function buildWithDependabot() {
    const fake = world({ labels: [], events: labelEventsOk([]) });
    return (
      await buildPrCandidate(
        { run: fake.run, ghToken: "tok" },
        FOUND,
        "octo-owner",
        [DEPENDABOT_ROW],
        LABELS,
        DEPENDABOT_ONLY,
      )
    ).candidate;
  }

  test("does not count a running dependabot item as a running review", async () => {
    expect((await buildWithDependabot()).hasActiveReviewingItem).toBe(false);
  });

  test("takes the fix round only from pr_fix rows", async () => {
    expect((await buildWithDependabot()).previousFixRound).toBe(0);
  });

  // 種類を問わない最新の行のheadを見る。自動検出のレビューは作成者が許可されたアカウントのPRに限るので、
  // dependabotが作ったPRでは、この値がレビューを起こさない(poll_prs_decisions.test.tsで確かめる)。
  test("reads the head of the latest row even when it is a dependabot row", async () => {
    expect((await buildWithDependabot()).lastKnownHeadSha).toBe("b".repeat(40));
  });
});

// `poll_dependabot`が作る行(取得したアカウントの名義、PRの題名、取得したhead)があっても、
// 人が付けたトリガーラベルによるレビューと修正は始まり、dependabotが作ったPRの自動検出は変わらない。
describe("pr_review and pr_fix decisions with a row created by poll_dependabot", () => {
  const POLICY: LabelerPolicy = {
    viewerLogin: "octo-owner",
    allowedLogins: [],
  };
  const HEAD_OF_WORLD = "aaaaaaa";

  function pollRow(status: WorkItem["status"]): WorkItem {
    return {
      id: 60,
      cycle: 1,
      source: "issue",
      kind: "dependabot",
      owner: FOUND.owner,
      repo: FOUND.repo,
      issue_number: null,
      issue_url: null,
      pr_number: FOUND.number,
      title: "Bump left-pad from 1.3.0 to 1.3.1",
      body: null,
      status,
      attempt: 1,
      claimed_by: "octo-owner",
      flow_job_id: null,
      resume_url: null,
      cancel_url: null,
      head_sha: HEAD_OF_WORLD,
      last_review_id: null,
      last_comment_id: null,
      last_review_comment_id: null,
      observed_review_id: null,
      observed_comment_id: null,
      observed_review_comment_id: null,
      fix_round: 0,
      parent_work_item_id: null,
      branch: null,
      pr_url: null,
      created_at: new Date("2026-10-12T00:00:00Z"),
      updated_at: new Date("2026-10-12T00:00:00Z"),
    };
  }

  async function decide(options: {
    readonly row: WorkItem | null;
    readonly labels: readonly string[];
    readonly author?: string;
  }) {
    const fake = world({
      labels: options.labels,
      ...(options.author === undefined ? {} : { author: options.author }),
      headRepo: "octo-owner/atelier-works",
      baseRepo: "octo-owner/atelier-works",
      events: labelEventsOk(
        options.labels.map((label) => labeled("octo-owner", label)),
      ),
    });
    const row = options.row;
    const context = await buildPrCandidate(
      { run: fake.run, ghToken: "tok" },
      FOUND,
      "octo-owner",
      row !== null && row.status === "picked" ? [row] : [],
      LABELS,
      {
        latestPrWorkItem: async (_owner, _repo, _number, opts) =>
          opts?.kind === undefined || opts.kind === "dependabot" ? row : null,
        findApprovedWorkItemForIssue: async () => null,
      },
    );
    const [decision] = decidePrActions(
      [context.candidate],
      LABELS.reviewLabel,
      LABELS.fixLabel,
      POLICY,
    );
    return decision;
  }

  test("starts a review by the label while the dependabot flow runs", async () => {
    const decision = await decide({
      row: pollRow("picked"),
      labels: ["factory:review"],
    });

    expect(decision?.review.kind).toBe("trigger_review");
  });

  test("starts a fix by the label after the dependabot flow handed the pull request to a person", async () => {
    const decision = await decide({
      row: pollRow("needs_human"),
      labels: ["factory:fix"],
    });

    expect(decision?.fix.kind).toBe("trigger_fix");
  });

  test("keeps the detection of a dependabot pull request the same as without the row", async () => {
    const withRow = await decide({
      row: pollRow("needs_human"),
      labels: [],
      author: "dependabot[bot]",
    });
    const withoutRow = await decide({
      row: null,
      labels: [],
      author: "dependabot[bot]",
    });

    expect(withRow?.review).toEqual(withoutRow?.review);
  });
});

// 動いているpr_fixの有無は、同じPRの稼働中の行のうち、pr_fixの行だけから決まる。
describe("buildPrCandidate with active pr_fix work items", () => {
  const ROW: WorkItem = {
    id: 60,
    cycle: 1,
    source: "issue",
    kind: "pr_fix",
    owner: "octo-owner",
    repo: "atelier-works",
    issue_number: null,
    issue_url: null,
    pr_number: 7,
    title: null,
    body: null,
    status: "fixing",
    attempt: 1,
    claimed_by: null,
    flow_job_id: null,
    resume_url: null,
    cancel_url: null,
    head_sha: "b".repeat(40),
    last_review_id: null,
    last_comment_id: null,
    last_review_comment_id: null,
    observed_review_id: null,
    observed_comment_id: null,
    observed_review_comment_id: null,
    fix_round: 1,
    parent_work_item_id: null,
    branch: null,
    pr_url: null,
    created_at: new Date("2026-10-12T00:00:00Z"),
    updated_at: new Date("2026-10-12T00:00:00Z"),
  };

  async function buildWith(active: readonly WorkItem[]) {
    const fake = world({ labels: [], events: labelEventsOk([]) });
    return (
      await buildPrCandidate(
        { run: fake.run, ghToken: "tok" },
        FOUND,
        "octo-owner",
        active,
        LABELS,
        DEPS,
      )
    ).candidate;
  }

  test("marks a pull request that has an active pr_fix", async () => {
    expect((await buildWith([ROW])).activeFixItemId).toBe(60);
  });

  test("does not mark a pull request without active rows", async () => {
    expect((await buildWith([])).activeFixItemId).toBeNull();
  });

  test("does not count an active pr_review as an active fix", async () => {
    expect(
      (await buildWith([{ ...ROW, kind: "pr_review", status: "reviewing" }]))
        .activeFixItemId,
    ).toBeNull();
  });

  test("does not count an active dependabot row as an active fix", async () => {
    expect(
      (await buildWith([{ ...ROW, kind: "dependabot", status: "picked" }]))
        .activeFixItemId,
    ).toBeNull();
  });

  test("does not count a terminal pr_fix as an active fix", async () => {
    expect(
      (await buildWith([{ ...ROW, status: "rereview_requested" }]))
        .activeFixItemId,
    ).toBeNull();
  });
});
