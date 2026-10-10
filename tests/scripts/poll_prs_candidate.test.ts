// `poll_prs.ts`の`buildPrCandidate`が、PRのトリガーラベルの付与者と作成者を
// 候補に載せるまでの経路のテスト。
// GitHubの応答は本物のAPIの形にする。ラベルの`labeled`イベントは
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
