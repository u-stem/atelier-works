import { describe, expect, test } from "bun:test";
import {
  claimIssue,
  commentIssue,
  createIssue,
  createPrReview,
  getIssue,
  getIssueTimeline,
  getPr,
  getPrDiff,
  getPrFiles,
  getViewer,
  hasMarker,
  isOwnPost,
  listIssueComments,
  listPrReviewComments,
  listPrReviews,
  removeLabel,
  replyReviewComment,
  requestReviewers,
  searchIssues,
  searchPrs,
  setLabels,
  withMarker,
} from "../../f/factory/lib/github.ts";
import {
  createFakeCommandRunner,
  ghApiOk,
  ghApiStdout,
  ok,
} from "./testSupport.ts";

describe("withMarker / hasMarker", () => {
  test("withMarker appends a factory marker with kind and work item id", () => {
    const body = withMarker("comment", 42, "hello");
    expect(body).toBe("hello\n\n<!-- factory:comment:42 -->");
  });

  test("hasMarker finds a marker matching kind and work item id", () => {
    const body = withMarker("comment", 42, "hello");
    expect(hasMarker(body, "comment", 42)).toBe(true);
  });

  test("hasMarker returns false when the work item id does not match", () => {
    const body = withMarker("comment", 42, "hello");
    expect(hasMarker(body, "comment", 99)).toBe(false);
  });

  test("hasMarker returns false for plain text with no marker", () => {
    expect(hasMarker("just a human comment")).toBe(false);
  });

  test("hasMarker ignores a quoted marker line (blockquote reply)", () => {
    const quoted = `> ${withMarker("claim", 9, "hi").split("\n").pop()}\n\nnot really from the factory`;
    expect(hasMarker(quoted, "claim", 9)).toBe(false);
  });

  test("hasMarker ignores a marker that isn't the last line", () => {
    const embedded = "<!-- factory:claim:9 -->\n\nsome more text after it";
    expect(hasMarker(embedded, "claim", 9)).toBe(false);
  });

  test("hasMarker matches when the marker is the trailing line after trailing whitespace", () => {
    const trailingWhitespace = `${withMarker("claim", 9, "hi")}\n\n  `;
    expect(hasMarker(trailingWhitespace, "claim", 9)).toBe(true);
  });
});

describe("isOwnPost", () => {
  test("matches case-insensitively", () => {
    expect(isOwnPost("Factory-Bot", "factory-bot")).toBe(true);
  });

  test("returns false for a different login", () => {
    expect(isOwnPost("alice", "factory-bot")).toBe(false);
  });
});

describe("getViewer", () => {
  test("returns the authenticated login", async () => {
    const fake = createFakeCommandRunner([ghApiOk({ login: "factory-bot" })]);
    const viewer = await getViewer({ run: fake.run, ghToken: "tok" });
    expect(viewer.login).toBe("factory-bot");
  });

  test("retries once after a rate-limited response then succeeds", async () => {
    const fake = createFakeCommandRunner([
      ok(ghApiStdout(403, { message: "rate limited" }, { "retry-after": "1" })),
      ghApiOk({ login: "factory-bot" }),
    ]);
    const viewer = await getViewer({
      run: fake.run,
      ghToken: "tok",
      sleep: async () => {},
    });
    expect(viewer.login).toBe("factory-bot");
  });

  test("throws with a masked message on a non-rate-limit HTTP error", async () => {
    const fake = createFakeCommandRunner([
      ok(ghApiStdout(500, { message: "boom" })),
    ]);
    await expect(getViewer({ run: fake.run, ghToken: "tok" })).rejects.toThrow(
      /HTTP 500/,
    );
  });
});

describe("searchIssues", () => {
  test("derives owner/repo from repository_url", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk({
        items: [
          {
            number: 7,
            title: "do the thing",
            body: "body text",
            html_url: "https://github.com/acme/widgets/issues/7",
            repository_url: "https://api.github.com/repos/acme/widgets",
            user: { login: "alice" },
          },
        ],
      }),
    ]);
    const items = await searchIssues(
      { run: fake.run, ghToken: "tok" },
      {
        owner: "acme",
        ownerKind: "user",
        label: "factory",
        notLabel: "factory:wip",
      },
    );
    expect(items).toEqual([
      {
        owner: "acme",
        repo: "widgets",
        number: 7,
        title: "do the thing",
        body: "body text",
        htmlUrl: "https://github.com/acme/widgets/issues/7",
        authorLogin: "alice",
      },
    ]);
  });

  test("uses an org: qualifier when ownerKind is org", async () => {
    const fake = createFakeCommandRunner([ghApiOk({ items: [] })]);
    await searchIssues(
      { run: fake.run, ghToken: "tok" },
      {
        owner: "acme-org",
        ownerKind: "org",
        label: "factory",
        notLabel: "factory:wip",
      },
    );
    const argv = fake.calls[0]?.argv.join(" ") ?? "";
    expect(decodeURIComponent(argv)).toContain("org:acme-org");
  });

  test("requests per_page=100", async () => {
    const fake = createFakeCommandRunner([ghApiOk({ items: [] })]);
    await searchIssues(
      { run: fake.run, ghToken: "tok" },
      {
        owner: "acme",
        ownerKind: "user",
        label: "factory",
        notLabel: "factory:wip",
      },
    );
    expect(fake.calls[0]?.argv.join(" ")).toContain("per_page=100");
  });

  test("follows the link header's rel=next page and combines both pages' items", async () => {
    const fake = createFakeCommandRunner([
      ok(
        ghApiStdout(
          200,
          {
            items: [
              {
                number: 1,
                title: "first page",
                body: "b1",
                html_url: "https://github.com/acme/widgets/issues/1",
                repository_url: "https://api.github.com/repos/acme/widgets",
                user: { login: "alice" },
              },
            ],
          },
          {
            link: '<https://api.github.com/search/issues?q=x&page=2>; rel="next"',
          },
        ),
      ),
      ghApiOk({
        items: [
          {
            number: 2,
            title: "second page",
            body: "b2",
            html_url: "https://github.com/acme/widgets/issues/2",
            repository_url: "https://api.github.com/repos/acme/widgets",
            user: { login: "bob" },
          },
        ],
      }),
    ]);
    const items = await searchIssues(
      { run: fake.run, ghToken: "tok" },
      {
        owner: "acme",
        ownerKind: "user",
        label: "factory",
        notLabel: "factory:wip",
      },
    );
    expect(items.map((item) => item.number)).toEqual([1, 2]);
  });
});

describe("getIssue", () => {
  test("normalizes string and object label shapes", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk({
        number: 5,
        title: "t",
        body: "b",
        html_url: "https://github.com/acme/widgets/issues/5",
        state: "open",
        user: { login: "alice" },
        labels: ["factory", { name: "priority:high" }],
      }),
    ]);
    const issue = await getIssue(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      5,
    );
    expect(issue.labels).toEqual(["factory", "priority:high"]);
  });

  test("rejects an owner that isn't a valid GitHub name", async () => {
    const fake = createFakeCommandRunner([]);
    await expect(
      getIssue({ run: fake.run, ghToken: "tok" }, "../etc", "widgets", 5),
    ).rejects.toThrow();
  });
});

describe("getIssueTimeline", () => {
  test("returns only the last labeled event", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk([
        {
          event: "labeled",
          actor: { login: "alice" },
          label: { name: "factory" },
          author_association: "OWNER",
        },
        { event: "commented", actor: { login: "bob" } },
        {
          event: "labeled",
          actor: { login: "carol" },
          label: { name: "factory" },
          author_association: "NONE",
        },
      ]),
    ]);
    const last = await getIssueTimeline(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      5,
    );
    expect(last?.actorLogin).toBe("carol");
  });

  test("returns null when there is no labeled event", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk([{ event: "commented", actor: { login: "bob" } }]),
    ]);
    const last = await getIssueTimeline(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      5,
    );
    expect(last).toBeNull();
  });

  test("follows the link header's rel=next page", async () => {
    const fake = createFakeCommandRunner([
      ok(
        ghApiStdout(
          200,
          [
            {
              event: "labeled",
              actor: { login: "alice" },
              label: { name: "factory" },
            },
          ],
          {
            link: '<https://api.github.com/repos/acme/widgets/issues/5/timeline?page=2>; rel="next"',
          },
        ),
      ),
      ghApiOk([
        {
          event: "labeled",
          actor: { login: "carol" },
          label: { name: "factory" },
        },
      ]),
    ]);
    const last = await getIssueTimeline(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      5,
    );
    expect(last?.actorLogin).toBe("carol");
  });

  test("the second (paginated) call targets the URL from the link header", async () => {
    const fake = createFakeCommandRunner([
      ok(
        ghApiStdout(
          200,
          [
            {
              event: "labeled",
              actor: { login: "alice" },
              label: { name: "factory" },
            },
          ],
          {
            link: '<https://api.github.com/repos/acme/widgets/issues/5/timeline?page=2>; rel="next"',
          },
        ),
      ),
      ghApiOk([]),
    ]);
    await getIssueTimeline(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      5,
    );
    expect(fake.calls[1]?.argv).toContain(
      "repos/acme/widgets/issues/5/timeline?page=2",
    );
  });
});

describe("claimIssue", () => {
  test("succeeds when the re-fetched issue carries the wip label", async () => {
    const fake = createFakeCommandRunner([
      ok(ghApiStdout(200, {})), // POST labels
      ok(ghApiStdout(200, {})), // POST assignees
      ghApiOk({
        number: 5,
        title: "t",
        body: "b",
        html_url: "https://x/5",
        state: "open",
        user: { login: "alice" },
        labels: ["factory:wip"],
      }),
    ]);
    const result = await claimIssue(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      5,
      {
        wipLabel: "factory:wip",
        assignee: "factory-bot",
      },
    );
    expect(result).toEqual({ claimed: true });
  });

  test("reports not claimed when the wip label did not stick (lost a race)", async () => {
    const fake = createFakeCommandRunner([
      ok(ghApiStdout(200, {})),
      ok(ghApiStdout(200, {})),
      ghApiOk({
        number: 5,
        title: "t",
        body: "b",
        html_url: "https://x/5",
        state: "open",
        user: { login: "alice" },
        labels: [],
      }),
    ]);
    const result = await claimIssue(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      5,
      {
        wipLabel: "factory:wip",
        assignee: "factory-bot",
      },
    );
    expect(result.claimed).toBe(false);
  });

  test("rejects an assignee that isn't a valid GitHub name before making any call", async () => {
    const fake = createFakeCommandRunner([]);
    await expect(
      claimIssue({ run: fake.run, ghToken: "tok" }, "acme", "widgets", 5, {
        wipLabel: "factory:wip",
        assignee: "-evil",
      }),
    ).rejects.toThrow();
  });
});

describe("commentIssue", () => {
  test("posts a new comment with a marker when none exists yet", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk([]), // GET existing comments: none
      ghApiOk({ id: 123 }), // POST comment
    ]);
    const result = await commentIssue(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      5,
      "claim",
      9,
      "hi",
      "factory-bot",
    );
    expect(result).toEqual({ id: 123, created: true });
  });

  test("is idempotent: reuses an existing marker comment posted by the viewer itself", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk([
        {
          id: 55,
          body: withMarker("claim", 9, "hi"),
          user: { login: "factory-bot" },
        },
      ]),
    ]);
    const result = await commentIssue(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      5,
      "claim",
      9,
      "hi",
      "factory-bot",
    );
    expect(result).toEqual({ id: 55, created: false });
  });

  test("does NOT treat a marker-bearing comment from someone else as already posted (security fix)", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk([
        {
          id: 55,
          body: withMarker("claim", 9, "hi"),
          user: { login: "someone-else" },
        },
      ]),
      ghApiOk({ id: 200 }), // POST comment — must still be called
    ]);
    const result = await commentIssue(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      5,
      "claim",
      9,
      "hi",
      "factory-bot",
    );
    expect(result).toEqual({ id: 200, created: true });
  });
});

describe("listIssueComments", () => {
  test("excludes the viewer's own comment and a marker-bearing comment, keeps a plain human comment", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk([
        { id: 1, body: "please fix this", user: { login: "alice" } },
        {
          id: 2,
          body: "factory reply",
          user: { login: "factory-bot" },
        },
        {
          id: 3,
          body: withMarker("comment", 9, "auto note"),
          user: { login: "bob" },
        },
      ]),
    ]);
    const result = await listIssueComments(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      5,
      { viewer: "factory-bot" },
    );
    expect(result.items).toEqual([
      { id: 1, authorLogin: "alice", body: "please fix this" },
    ]);
  });

  test("only returns comments with an id greater than sinceId", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk([
        { id: 10, body: "old comment", user: { login: "alice" } },
        { id: 20, body: "/factory fix", user: { login: "alice" } },
      ]),
    ]);
    const result = await listIssueComments(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      5,
      { viewer: "factory-bot", sinceId: 10 },
    );
    expect(result.items.map((c) => c.id)).toEqual([20]);
  });

  test("returns maxId across all comments, including filtered-out ones", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk([
        { id: 1, body: "human comment", user: { login: "alice" } },
        { id: 9, body: "factory reply", user: { login: "factory-bot" } },
      ]),
    ]);
    const result = await listIssueComments(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      5,
      { viewer: "factory-bot" },
    );
    expect(result.maxId).toBe(9);
  });

  test("rejects an invalid viewer before making any call", async () => {
    const fake = createFakeCommandRunner([]);
    await expect(
      listIssueComments(
        { run: fake.run, ghToken: "tok" },
        "acme",
        "widgets",
        5,
        { viewer: "not valid!" },
      ),
    ).rejects.toThrow();
    expect(fake.calls).toHaveLength(0);
  });
});

describe("setLabels / removeLabel", () => {
  test("setLabels PUTs the full label list", async () => {
    const fake = createFakeCommandRunner([ok(ghApiStdout(200, []))]);
    await setLabels({ run: fake.run, ghToken: "tok" }, "acme", "widgets", 5, [
      "a",
      "b",
    ]);
    expect(fake.calls[0]?.argv).toContain("PUT");
  });

  test("removeLabel does not throw when the label is already absent (404)", async () => {
    const fake = createFakeCommandRunner([
      ok(ghApiStdout(404, { message: "Not Found" })),
    ]);
    await expect(
      removeLabel(
        { run: fake.run, ghToken: "tok" },
        "acme",
        "widgets",
        5,
        "factory:wip",
      ),
    ).resolves.toBeUndefined();
  });
});

describe("createIssue", () => {
  test("returns the created issue number and URL", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk({
        number: 99,
        title: "t",
        body: "b",
        html_url: "https://github.com/acme/widgets/issues/99",
        state: "open",
        user: null,
        labels: [],
      }),
    ]);
    const result = await createIssue(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      {
        title: "t",
        body: "b",
      },
    );
    expect(result).toEqual({
      number: 99,
      htmlUrl: "https://github.com/acme/widgets/issues/99",
    });
  });
});

describe("searchPrs", () => {
  test("builds a query combining review-requested / assignee / label", async () => {
    const fake = createFakeCommandRunner([ghApiOk({ items: [] })]);
    await searchPrs(
      { run: fake.run, ghToken: "tok" },
      {
        owner: "acme",
        ownerKind: "user",
        viewer: "factory-bot",
        reviewLabel: "factory:review",
        wipLabel: "factory:wip",
      },
    );
    const decoded = decodeURIComponent(fake.calls[0]?.argv.join(" ") ?? "");
    expect(decoded).toContain("review-requested:factory-bot");
  });

  test("requests per_page=100", async () => {
    const fake = createFakeCommandRunner([ghApiOk({ items: [] })]);
    await searchPrs(
      { run: fake.run, ghToken: "tok" },
      {
        owner: "acme",
        ownerKind: "user",
        viewer: "factory-bot",
        reviewLabel: "factory:review",
        wipLabel: "factory:wip",
      },
    );
    expect(fake.calls[0]?.argv.join(" ")).toContain("per_page=100");
  });

  test("follows the link header's rel=next page and combines both pages' items", async () => {
    const fake = createFakeCommandRunner([
      ok(
        ghApiStdout(
          200,
          {
            items: [
              {
                number: 10,
                title: "first page pr",
                body: null,
                html_url: "https://github.com/acme/widgets/pull/10",
                repository_url: "https://api.github.com/repos/acme/widgets",
                user: null,
              },
            ],
          },
          {
            link: '<https://api.github.com/search/issues?q=x&page=2>; rel="next"',
          },
        ),
      ),
      ghApiOk({
        items: [
          {
            number: 11,
            title: "second page pr",
            body: null,
            html_url: "https://github.com/acme/widgets/pull/11",
            repository_url: "https://api.github.com/repos/acme/widgets",
            user: null,
          },
        ],
      }),
    ]);
    const items = await searchPrs(
      { run: fake.run, ghToken: "tok" },
      {
        owner: "acme",
        ownerKind: "user",
        viewer: "factory-bot",
        reviewLabel: "factory:review",
        wipLabel: "factory:wip",
      },
    );
    expect(items.map((item) => item.number)).toEqual([10, 11]);
  });
});

describe("getPr", () => {
  test("parses head/base/draft/mergeable_state/state/merged", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk({
        number: 12,
        title: "t",
        body: "b",
        draft: false,
        state: "open",
        merged: false,
        head: {
          sha: "abc123",
          ref: "feature-x",
          repo: { full_name: "acme/widgets-fork" },
        },
        base: { ref: "main", repo: { full_name: "acme/widgets" } },
        mergeable_state: "clean",
        user: { login: "alice" },
      }),
    ]);
    const pr = await getPr(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      12,
    );
    expect(pr).toEqual({
      number: 12,
      title: "t",
      body: "b",
      draft: false,
      state: "open",
      merged: false,
      headSha: "abc123",
      headRef: "feature-x",
      headRepoFullName: "acme/widgets-fork",
      baseRepoFullName: "acme/widgets",
      baseRef: "main",
      mergeableState: "clean",
      authorLogin: "alice",
    });
  });

  test("parses a merged, closed PR", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk({
        number: 13,
        title: "t2",
        body: null,
        draft: false,
        state: "closed",
        merged: true,
        head: { sha: "def456", ref: "feature-y", repo: null },
        base: { ref: "main", repo: { full_name: "acme/widgets" } },
        mergeable_state: null,
        user: null,
      }),
    ]);
    const pr = await getPr(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      13,
    );
    expect(pr.state).toBe("closed");
    expect(pr.merged).toBe(true);
    expect(pr.headRef).toBe("feature-y");
  });
});

describe("getPrFiles", () => {
  test("returns the changed-file list", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk([
        {
          filename: "src/a.ts",
          status: "modified",
          additions: 3,
          deletions: 1,
          changes: 4,
        },
      ]),
    ]);
    const files = await getPrFiles(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      12,
    );
    expect(files).toEqual([
      {
        filename: "src/a.ts",
        status: "modified",
        additions: 3,
        deletions: 1,
        changes: 4,
      },
    ]);
  });

  test("follows the link header's rel=next page and combines both pages' files", async () => {
    const fake = createFakeCommandRunner([
      ok(
        ghApiStdout(
          200,
          [
            {
              filename: "a.ts",
              status: "added",
              additions: 10,
              deletions: 0,
              changes: 10,
            },
          ],
          {
            link: '<https://api.github.com/repos/acme/widgets/pulls/12/files?page=2>; rel="next"',
          },
        ),
      ),
      ghApiOk([
        {
          filename: "b.ts",
          status: "removed",
          additions: 0,
          deletions: 5,
          changes: 5,
        },
      ]),
    ]);
    const files = await getPrFiles(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      12,
    );
    expect(files.map((f) => f.filename)).toEqual(["a.ts", "b.ts"]);
  });
});

describe("getPrDiff", () => {
  test("returns the full diff when under the line limit", async () => {
    const fake = createFakeCommandRunner([
      ok(ghApiStdout(200, "line1\nline2\nline3")),
    ]);
    const diff = await getPrDiff(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      12,
      100,
    );
    expect(diff).toEqual({
      diff: "line1\nline2\nline3",
      truncated: false,
      totalLines: 3,
    });
  });

  test("truncates to maxLines and reports truncated: true", async () => {
    const fake = createFakeCommandRunner([
      ok(ghApiStdout(200, "l1\nl2\nl3\nl4\nl5")),
    ]);
    const diff = await getPrDiff(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      12,
      2,
    );
    expect(diff).toEqual({ diff: "l1\nl2", truncated: true, totalLines: 5 });
  });
});

const VIEWER = "factory-bot";

describe("listPrReviews", () => {
  test("filters out the viewer's own review", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk([
        {
          id: 1,
          user: { login: "alice" },
          state: "COMMENTED",
          body: "looks fine",
        },
        {
          id: 2,
          user: { login: VIEWER },
          state: "COMMENTED",
          body: "factory review",
        },
      ]),
    ]);
    const result = await listPrReviews(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      12,
      VIEWER,
    );
    expect(result.items.map((r) => r.id)).toEqual([1]);
  });

  test("does NOT filter out a marker-bearing review from a different login (security fix: marker alone is not proof of authorship)", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk([
        {
          id: 3,
          user: { login: "someone-else" },
          state: "COMMENTED",
          body: withMarker("review", 1, "auto"),
        },
      ]),
    ]);
    const result = await listPrReviews(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      12,
      VIEWER,
    );
    expect(result.items).toHaveLength(1);
  });

  test("returns maxId across all reviews, including filtered-out ones", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk([
        { id: 1, user: { login: "alice" }, state: "COMMENTED", body: "x" },
        { id: 9, user: { login: VIEWER }, state: "COMMENTED", body: "y" },
      ]),
    ]);
    const result = await listPrReviews(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      12,
      VIEWER,
    );
    expect(result.maxId).toBe(9);
  });
});

describe("listPrReviewComments", () => {
  test("filters out the viewer's own comment", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk([
        {
          id: 1,
          user: { login: "alice" },
          path: "a.ts",
          line: 10,
          body: "fix this",
        },
        {
          id: 2,
          user: { login: VIEWER },
          path: "a.ts",
          line: 12,
          body: "factory comment",
        },
      ]),
    ]);
    const result = await listPrReviewComments(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      12,
      VIEWER,
    );
    expect(result.items.map((c) => c.id)).toEqual([1]);
  });
});

describe("createPrReview", () => {
  test("posts a COMMENT-event review with inline comments", async () => {
    const fake = createFakeCommandRunner([ghApiOk({ id: 77 })]);
    const result = await createPrReview(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      12,
      {
        event: "COMMENT",
        body: "summary",
        comments: [{ path: "a.ts", line: 10, side: "RIGHT", body: "nit" }],
      },
    );
    expect(result).toEqual({ id: 77 });
  });
});

describe("replyReviewComment", () => {
  test("returns the reply's id", async () => {
    const fake = createFakeCommandRunner([ghApiOk({ id: 88 })]);
    const result = await replyReviewComment(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      12,
      1,
      "done",
    );
    expect(result).toEqual({ id: 88 });
  });
});

describe("requestReviewers", () => {
  test("rejects an invalid authorLogin before making any call", async () => {
    const fake = createFakeCommandRunner([]);
    await expect(
      requestReviewers(
        { run: fake.run, ghToken: "tok" },
        "acme",
        "widgets",
        12,
        {
          reviewers: ["alice"],
          authorLogin: "-evil",
          viewer: VIEWER,
        },
      ),
    ).rejects.toThrow();
  });

  test("excludes the PR author and the viewer", async () => {
    const fake = createFakeCommandRunner([ghApiOk({})]);
    const result = await requestReviewers(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      12,
      {
        reviewers: ["alice", "the-author", VIEWER],
        authorLogin: "the-author",
        viewer: VIEWER,
      },
    );
    expect(result).toEqual({ outcome: "requested", reviewers: ["alice"] });
  });

  test("skips the API call entirely when the filtered list is empty", async () => {
    const fake = createFakeCommandRunner([]);
    const result = await requestReviewers(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      12,
      {
        reviewers: [VIEWER],
        authorLogin: "the-author",
        viewer: VIEWER,
      },
    );
    expect(result).toEqual({ outcome: "skipped_empty" });
  });

  test("is non-fatal: returns a failed outcome instead of throwing", async () => {
    const fake = createFakeCommandRunner([
      ok(ghApiStdout(422, { message: "invalid reviewer" })),
    ]);
    const result = await requestReviewers(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      12,
      {
        reviewers: ["alice"],
        authorLogin: "the-author",
        viewer: VIEWER,
      },
    );
    expect(result.outcome).toBe("failed");
  });
});
