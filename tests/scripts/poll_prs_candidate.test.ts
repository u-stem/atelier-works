// `poll_prs.ts`の`buildPrCandidate`が、PRのトリガーラベルの付与者と作成者を
// 候補に載せるまでの経路のテスト。
// GitHubの応答は本物のAPIの形にする。イベントの`labeled`は
// `author_association`を持たない。

import { describe, expect, test } from "bun:test";
import {
  LabelerCheckLimitError,
  type PrSearchItem,
} from "../../f/factory/lib/github.ts";
import type { CommandResult } from "../../f/factory/lib/workspace.ts";
import {
  type BuildPrCandidateDeps,
  buildPrCandidate,
} from "../../f/factory/poll_prs.ts";
import { ghApiOk, ghApiStdout, ok } from "../lib/testSupport.ts";

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

function labeled(login: string | null, label: string) {
  return {
    id: 1,
    node_id: "LE_1",
    url: "https://api.github.com/repos/octo-owner/atelier-works/issues/events/1",
    event: "labeled",
    actor: login === null ? null : { login },
    commit_id: null,
    commit_url: null,
    created_at: "2026-10-01T00:00:00Z",
    label: { name: label, color: "ededed" },
    performed_via_github_app: null,
  };
}

type World = {
  readonly labels: readonly string[];
  readonly author?: string | null;
  readonly timeline: CommandResult;
};

/** エンドポイントごとに応答する偽のrunner。イベントの取得回数を数える。 */
function world(w: World) {
  let timelineCalls = 0;
  const run = async (argv: readonly string[]): Promise<CommandResult> => {
    const endpoint = argv.find((arg) => arg.startsWith("repo")) ?? "";
    if (endpoint.includes("/events")) {
      timelineCalls += 1;
      return w.timeline;
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
        head: { sha: "aaaaaaa", ref: "feature", repo: null },
        base: { ref: "main", repo: null },
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
  return { run, timelineCalls: () => timelineCalls };
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
  const BOTH = ghApiOk([
    labeled("alice", "factory:review"),
    labeled("bob", "factory:fix"),
  ]);

  test("takes the review label's labeler for the review label", async () => {
    const { candidate } = await build({
      labels: ["factory:review", "factory:fix"],
      timeline: BOTH,
    });
    expect(candidate.reviewLabelerLogin).toBe("alice");
  });

  test("takes the fix label's labeler for the fix label", async () => {
    const { candidate } = await build({
      labels: ["factory:review", "factory:fix"],
      timeline: BOTH,
    });
    expect(candidate.fixLabelerLogin).toBe("bob");
  });

  test("leaves the fix labeler empty when only the review label is on the PR", async () => {
    const { candidate } = await build({
      labels: ["factory:review"],
      timeline: BOTH,
    });
    expect(candidate.fixLabelerLogin).toBeNull();
  });

  test("does not fetch the timeline when no trigger label is on the PR", async () => {
    const { fake } = await build({ labels: ["documentation"], timeline: BOTH });
    expect(fake.timelineCalls()).toBe(0);
  });

  test("fetches the timeline once per trigger label on the PR", async () => {
    const { fake } = await build({
      labels: ["factory:review", "factory:fix"],
      timeline: BOTH,
    });
    expect(fake.timelineCalls()).toBe(2);
  });

  test("finds a trigger label whose case differs from the config", async () => {
    const { candidate } = await build({
      labels: ["Factory:Review"],
      timeline: ghApiOk([labeled("alice", "Factory:Review")]),
    });
    expect(candidate.reviewLabelerLogin).toBe("alice");
  });

  test("leaves the labeler empty when the label's event has no actor", async () => {
    const { candidate } = await build({
      labels: ["factory:review"],
      timeline: ghApiOk([labeled(null, "factory:review")]),
    });
    expect(candidate.reviewLabelerLogin).toBeNull();
  });

  test("throws LabelerCheckLimitError when the events exceed the page limit", async () => {
    const overflowing = ok(
      ghApiStdout(200, [labeled("alice", "factory:review")], {
        link: '<https://api.github.com/repositories/1/issues/7/events?per_page=100&page=2>; rel="next"',
      }),
    );
    const result = build({ labels: ["factory:review"], timeline: overflowing });
    await expect(result).rejects.toThrow(LabelerCheckLimitError);
  });

  test("throws when the timeline cannot be fetched", async () => {
    const result = build({
      labels: ["factory:review"],
      timeline: ok(ghApiStdout(500, { message: "boom" })),
    });
    await expect(result).rejects.toThrow();
  });
});

describe("buildPrCandidate author", () => {
  test("carries the PR author's login", async () => {
    const { candidate } = await build({
      labels: [],
      author: "mallory",
      timeline: ghApiOk([]),
    });
    expect(candidate.authorLogin).toBe("mallory");
  });

  test("leaves the author empty when the PR has no user", async () => {
    const { candidate } = await build({
      labels: [],
      author: null,
      timeline: ghApiOk([]),
    });
    expect(candidate.authorLogin).toBeNull();
  });
});
