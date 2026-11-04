// 調査の投稿のstep(`steps/investigate_post.ts`)の手順を固定する。
// 保護パスに置く。投稿の前の秘密値の検査、投稿先の確認、冪等性を緩める変更が、このテストを書き換えて通らないようにするため。
// 投稿のstepが受けるのは、生成のstepが作った最終の本文か、本文を作れなかった理由の符号だけである。

import { describe, expect, test } from "bun:test";
import type { Issue } from "../../f/factory/lib/github.ts";
import { GitHubHttpError } from "../../f/factory/lib/github_errors.ts";
import {
  type EscalationSpec,
  INVESTIGATE_ROLE_TAG,
  withheldEscalation,
} from "../../f/factory/lib/investigate_flow.ts";
import type { WorkItem } from "../../f/factory/lib/types.ts";
import {
  type InvestigatePostDeps,
  runInvestigatePost,
} from "../../f/factory/steps/investigate_post.ts";
import {
  INVESTIGATE_ROOT_JOB,
  investigationItem,
} from "../lib/investigateTestSupport.ts";

const BODY = `${INVESTIGATE_ROLE_TAG}\n\nThe build is slow because of the cache.`;
const INPUT = {
  workItemId: 7,
  rootJobId: INVESTIGATE_ROOT_JOB,
  commentBody: BODY,
  withheld: null,
};

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 42,
    title: "Slow build",
    body: "",
    htmlUrl: "https://github.com/acme/widgets/issues/42",
    state: "open",
    authorLogin: "operator",
    closedByLogin: null,
    closedByType: null,
    mergedAt: null,
    authorAssociation: "OWNER",
    labels: [],
    assignees: [],
    repository: { owner: "acme", repo: "widgets" },
    isPullRequest: false,
    ...overrides,
  };
}

type ScanResult = { readonly ok: boolean; readonly output: string };

type World = {
  readonly enabled?: boolean;
  readonly item?: WorkItem | null;
  readonly issue?: () => Promise<Issue>;
  readonly scans?: readonly (ScanResult | Error)[];
  readonly post?: { id: number; created: boolean };
  readonly marked?: boolean;
};

function fake(world: World = {}) {
  const calls: string[] = [];
  const escalations: EscalationSpec[] = [];
  const cancels: string[] = [];
  const posted: string[] = [];
  const scanned: string[] = [];
  const deps: InvestigatePostDeps = {
    readEnabled: () => {
      calls.push("enabled");
      return world.enabled ?? true;
    },
    getWorkItem: async () => {
      calls.push("item");
      return world.item === undefined ? investigationItem() : world.item;
    },
    getIssue: async () => {
      calls.push("issue");
      return world.issue === undefined ? issue() : world.issue();
    },
    scan: async (text) => {
      calls.push("scan");
      scanned.push(text);
      const next = world.scans?.[scanned.length - 1] ?? {
        ok: true,
        output: "",
      };
      if (next instanceof Error) throw next;
      return next;
    },
    postComment: async (_item, body) => {
      calls.push("post");
      posted.push(body);
      return world.post ?? { id: 99, created: true };
    },
    markInvestigated: async () => {
      calls.push("mark");
      return world.marked ?? true;
    },
    cancel: async (note) => {
      calls.push("cancel");
      cancels.push(note);
      return true;
    },
    escalate: async (_item, spec) => {
      calls.push("escalate");
      escalations.push(spec);
      return true;
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  };
  return { deps, calls, escalations, cancels, posted, scanned };
}

describe("runInvestigatePost", () => {
  describe("the order of the steps", () => {
    test("reads the setting, the row and the issue, then scans, posts and closes the investigation", async () => {
      const f = fake();
      await runInvestigatePost(INPUT, f.deps);
      expect(f.calls).toEqual([
        "item",
        "enabled",
        "issue",
        "scan",
        "post",
        "mark",
      ]);
    });

    test("returns the id of the comment that it posted", async () => {
      const f = fake();
      const result = await runInvestigatePost(INPUT, f.deps);
      expect(result).toEqual({ outcome: "posted", comment_id: 99 });
    });
  });

  describe("what it takes from the generate step", () => {
    test("throws when it has neither a body nor a code", async () => {
      const f = fake();
      await expect(
        runInvestigatePost({ ...INPUT, commentBody: null }, f.deps),
      ).rejects.toThrow("body");
    });

    test("throws when the body does not open with the role tag", async () => {
      const f = fake();
      await expect(
        runInvestigatePost(
          { ...INPUT, commentBody: "$var:f/factory/github_token" },
          f.deps,
        ),
      ).rejects.toThrow("body");
    });

    test("throws when the code is unknown", async () => {
      const f = fake();
      await expect(
        runInvestigatePost(
          { ...INPUT, commentBody: null, withheld: "other" },
          f.deps,
        ),
      ).rejects.toThrow("body");
    });

    test("throws when it has both a body and a code", async () => {
      const f = fake();
      await expect(
        runInvestigatePost({ ...INPUT, withheld: "secret_detected" }, f.deps),
      ).rejects.toThrow("body");
    });

    test("does not put the body in the message of the exception", async () => {
      const f = fake();
      const failure = await runInvestigatePost(
        { ...INPUT, commentBody: "secret-looking text" },
        f.deps,
      ).catch((error: unknown) => String(error));
      expect(failure).not.toContain("secret-looking text");
    });
  });

  describe("the setting that opens the investigation", () => {
    test("cancels the investigation when the setting is off", async () => {
      const f = fake({ enabled: false });
      const result = await runInvestigatePost(INPUT, f.deps);
      expect(result).toEqual({ outcome: "cancelled", comment_id: null });
      expect(f.calls).toEqual(["item", "enabled", "cancel"]);
    });
  });

  describe("the row", () => {
    test("skips a run that does not hold the lease", async () => {
      const f = fake({ item: investigationItem({ flow_job_id: "another" }) });
      const result = await runInvestigatePost(INPUT, f.deps);
      expect(result).toEqual({ outcome: "skipped", comment_id: null });
      expect(f.calls).toEqual(["item"]);
    });

    test("does nothing for a row that the generate step already sent to a person", async () => {
      const f = fake({ item: investigationItem({ status: "needs_human" }) });
      const result = await runInvestigatePost(
        { ...INPUT, commentBody: null, withheld: "secret_detected" },
        f.deps,
      );
      expect(result).toEqual({ outcome: "skipped", comment_id: null });
      expect(f.escalations).toEqual([]);
    });

    test("throws when the work item does not exist", async () => {
      const f = fake({ item: null });
      await expect(runInvestigatePost(INPUT, f.deps)).rejects.toThrow(
        "no work item",
      );
    });
  });

  describe("the place to post", () => {
    test.each([
      ["a closed issue", () => issue({ state: "closed" })],
      ["a pull request", () => issue({ isPullRequest: true })],
      [
        "an issue of another repository",
        () => issue({ repository: { owner: "acme", repo: "other" } }),
      ],
      [
        "an issue whose repository is unknown",
        () => issue({ repository: null }),
      ],
    ])(
      "cancels the investigation for %s and posts nothing",
      async (_name, make) => {
        const f = fake({ issue: async () => make() });
        const result = await runInvestigatePost(INPUT, f.deps);
        expect(result).toEqual({ outcome: "cancelled", comment_id: null });
        expect(f.calls).not.toContain("post");
        expect(f.cancels).toHaveLength(1);
      },
    );

    test("cancels the investigation for an issue that no longer exists", async () => {
      const f = fake({
        issue: async () => {
          throw new GitHubHttpError("GET issue failed with HTTP 404", 404);
        },
      });
      const result = await runInvestigatePost(INPUT, f.deps);
      expect(result.outcome).toBe("cancelled");
    });

    test("rethrows another failure to read the issue", async () => {
      const f = fake({
        issue: async () => {
          throw new GitHubHttpError("GET issue failed with HTTP 502", 502);
        },
      });
      await expect(runInvestigatePost(INPUT, f.deps)).rejects.toThrow("502");
    });

    test("does not scan the body before it knows where to post", async () => {
      const f = fake({ issue: async () => issue({ state: "closed" }) });
      await runInvestigatePost(INPUT, f.deps);
      expect(f.calls).not.toContain("scan");
    });
  });

  describe("the scan just before the post", () => {
    test("scans the body that it posts", async () => {
      const f = fake();
      await runInvestigatePost(INPUT, f.deps);
      expect(f.scanned).toEqual([BODY]);
      expect(f.posted).toEqual([BODY]);
    });

    test("posts nothing and escalates a detection with its own next action", async () => {
      const f = fake({ scans: [{ ok: false, output: "- rule" }] });
      const result = await runInvestigatePost(INPUT, f.deps);
      expect(result).toEqual({ outcome: "withheld", comment_id: null });
      expect(f.calls).not.toContain("post");
      expect(f.calls).not.toContain("mark");
      expect(f.escalations).toEqual([withheldEscalation("secret_detected")]);
    });

    test("posts nothing and escalates when the scan fails", async () => {
      const f = fake({ scans: [new Error("gitleaks timed out")] });
      const result = await runInvestigatePost(INPUT, f.deps);
      expect(result.outcome).toBe("withheld");
      expect(f.escalations).toEqual([withheldEscalation("scan_failed")]);
    });

    test("puts no text of the body in the escalation or in the result", async () => {
      const f = fake({ scans: [{ ok: false, output: "- rule" }] });
      const result = await runInvestigatePost(INPUT, f.deps);
      expect(JSON.stringify([result, f.escalations])).not.toContain("cache");
    });
  });

  describe("a code of the generate step", () => {
    test.each(["secret_detected", "scan_failed"] as const)(
      "escalates %s without scanning or posting",
      async (code) => {
        const f = fake();
        const result = await runInvestigatePost(
          { ...INPUT, commentBody: null, withheld: code },
          f.deps,
        );
        expect(result).toEqual({ outcome: "withheld", comment_id: null });
        expect(f.escalations).toEqual([withheldEscalation(code)]);
        expect(f.calls).not.toContain("scan");
        expect(f.calls).not.toContain("post");
      },
    );

    test("notifies a detection even when the issue is closed", async () => {
      const f = fake({ issue: async () => issue({ state: "closed" }) });
      const result = await runInvestigatePost(
        { ...INPUT, commentBody: null, withheld: "secret_detected" },
        f.deps,
      );
      expect(result.outcome).toBe("withheld");
      expect(f.escalations).toEqual([withheldEscalation("secret_detected")]);
    });

    test("notifies a detection even when the setting is off", async () => {
      const f = fake({ enabled: false });
      await runInvestigatePost(
        { ...INPUT, commentBody: null, withheld: "secret_detected" },
        f.deps,
      );
      expect(f.escalations).toEqual([withheldEscalation("secret_detected")]);
    });

    test("does not read the issue for a code", async () => {
      const f = fake();
      await runInvestigatePost(
        { ...INPUT, commentBody: null, withheld: "scan_failed" },
        f.deps,
      );
      expect(f.calls).not.toContain("issue");
    });
  });

  describe("a comment that was already posted", () => {
    test("closes the investigation without posting again", async () => {
      const f = fake({ post: { id: 55, created: false } });
      const result = await runInvestigatePost(INPUT, f.deps);
      expect(result).toEqual({ outcome: "already_posted", comment_id: 55 });
      expect(f.calls.at(-1)).toBe("mark");
    });
  });

  describe("the end of the investigation", () => {
    test("reports a change of the state that happened in the meantime", async () => {
      const f = fake({ marked: false });
      const result = await runInvestigatePost(INPUT, f.deps);
      expect(result).toEqual({ outcome: "state_changed", comment_id: 99 });
    });
  });
});
