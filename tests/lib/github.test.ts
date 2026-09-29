import { describe, expect, test } from "bun:test";
import {
  addLabels,
  claimIssue,
  commentIssue,
  createIssue,
  createPrReview,
  createPullRequest,
  ensureLabel,
  findIssueByMarker,
  findOpenPullRequestByHead,
  getBranchProtected,
  getIssue,
  getIssueTimeline,
  getPr,
  getPrDiff,
  getPrFiles,
  getViewer,
  gitIdentityForViewer,
  hasMarker,
  isFactoryPost,
  isOwnPost,
  listIssueComments,
  listPrReviewComments,
  listPrReviews,
  listReviewThreads,
  parseGitHubRepoUrl,
  postIssueComment,
  removeLabel,
  replyReviewComment,
  requestReviewers,
  resolveReviewThread,
  searchIssues,
  searchPrs,
  setLabels,
  updatePullRequest,
  updatePullRequestBody,
  withMarker,
} from "../../f/factory/lib/github.ts";
import { isRecord } from "../../f/factory/lib/types.ts";
import type { CommandResult } from "../../f/factory/lib/workspace.ts";
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

describe("isFactoryPost", () => {
  test("returns true when login matches viewer and body carries any marker", () => {
    const body = withMarker("pr_review", 1, "findings");
    expect(isFactoryPost("factory-bot", "factory-bot", body)).toBe(true);
  });

  test("returns false when login matches viewer but body carries no marker (shared operator account)", () => {
    expect(
      isFactoryPost("factory-bot", "factory-bot", "READMEも直してください"),
    ).toBe(false);
  });

  test("returns false when body carries a marker but login is a different user (marker alone is not proof)", () => {
    const body = withMarker("pr_fix", 1, "reply");
    expect(isFactoryPost("someone-else", "factory-bot", body)).toBe(false);
  });

  test("returns false when login matches viewer but the marker kind does not match the requested kind", () => {
    const body = withMarker("pr_review", 1, "findings");
    expect(isFactoryPost("factory-bot", "factory-bot", body, "pr_fix")).toBe(
      false,
    );
  });

  test("returns false when login is undefined", () => {
    expect(
      isFactoryPost(undefined, "factory-bot", "READMEも直してください"),
    ).toBe(false);
  });
});

describe("getViewer", () => {
  test("returns the authenticated login", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk({ login: "factory-bot", id: 12345 }),
    ]);
    const viewer = await getViewer({ run: fake.run, ghToken: "tok" });
    expect(viewer.login).toBe("factory-bot");
  });

  test("returns the authenticated user's numeric id", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk({ login: "factory-bot", id: 12345 }),
    ]);
    const viewer = await getViewer({ run: fake.run, ghToken: "tok" });
    expect(viewer.id).toBe(12345);
  });

  test("retries once after a rate-limited response then succeeds", async () => {
    const fake = createFakeCommandRunner([
      ok(ghApiStdout(403, { message: "rate limited" }, { "retry-after": "1" })),
      ghApiOk({ login: "factory-bot", id: 12345 }),
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

  test("rejects a response whose id is not a number", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk({ login: "factory-bot", id: "not-a-number" }),
    ]);
    await expect(getViewer({ run: fake.run, ghToken: "tok" })).rejects.toThrow(
      /unexpected response shape/,
    );
  });
});

describe("gitIdentityForViewer", () => {
  test("uses the viewer's login as the git identity name", () => {
    const identity = gitIdentityForViewer({ login: "factory-bot", id: 12345 });
    expect(identity.name).toBe("factory-bot");
  });

  test("builds a GitHub noreply email from the numeric id and login", () => {
    const identity = gitIdentityForViewer({ login: "factory-bot", id: 12345 });
    expect(identity.email).toBe("12345+factory-bot@users.noreply.github.com");
  });
});

describe("searchIssues", () => {
  test("derives owner/repo from repository_url", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk({
        items: [
          {
            id: 101,
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
                id: 201,
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
            id: 202,
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
      },
    );
    expect(items.map((item) => item.number)).toEqual([1, 2]);
  });

  test('quotes the label qualifier (a label name can contain a colon, e.g. "factory:review")', async () => {
    const fake = createFakeCommandRunner([ghApiOk({ items: [] })]);
    await searchIssues(
      { run: fake.run, ghToken: "tok" },
      {
        owner: "acme",
        ownerKind: "user",
        label: "factory:review",
      },
    );
    const decoded = decodeURIComponent(fake.calls[0]?.argv.join(" ") ?? "");
    expect(decoded).toContain('label:"factory:review"');
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
        assignees: [],
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

  test("collects assignee logins", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk({
        number: 5,
        title: "t",
        body: "b",
        html_url: "https://github.com/acme/widgets/issues/5",
        state: "open",
        user: { login: "alice" },
        labels: [],
        assignees: [{ login: "factory-bot" }, { login: "alice" }],
      }),
    ]);
    const issue = await getIssue(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      5,
    );
    expect(issue.assignees).toEqual(["factory-bot", "alice"]);
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
  test("succeeds when the re-fetched issue is assigned and the trigger label is gone", async () => {
    const fake = createFakeCommandRunner([
      ok(ghApiStdout(200, {})), // POST assignees
      ok(ghApiStdout(200, {})), // DELETE trigger label
      ghApiOk({
        number: 5,
        title: "t",
        body: "b",
        html_url: "https://x/5",
        state: "open",
        user: { login: "alice" },
        labels: [],
        assignees: [{ login: "factory-bot" }],
      }),
    ]);
    const result = await claimIssue(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      5,
      {
        triggerLabel: "factory",
        assignee: "factory-bot",
      },
    );
    expect(result).toEqual({ claimed: true });
  });

  test("reports not claimed when the assignment did not stick (lost a race)", async () => {
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
        assignees: [],
      }),
    ]);
    const result = await claimIssue(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      5,
      {
        triggerLabel: "factory",
        assignee: "factory-bot",
      },
    );
    expect(result.claimed).toBe(false);
  });

  test("reports not claimed when the trigger label is still present after removal (re-added by another actor)", async () => {
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
        labels: ["factory"],
        assignees: [{ login: "factory-bot" }],
      }),
    ]);
    const result = await claimIssue(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      5,
      {
        triggerLabel: "factory",
        assignee: "factory-bot",
      },
    );
    expect(result.claimed).toBe(false);
  });

  test("rejects an assignee that isn't a valid GitHub name before making any call", async () => {
    const fake = createFakeCommandRunner([]);
    await expect(
      claimIssue({ run: fake.run, ghToken: "tok" }, "acme", "widgets", 5, {
        triggerLabel: "factory",
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
  test("keeps the viewer's plain instruction comment (shared operator account, no marker)", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk([
        {
          id: 1,
          body: "READMEも直してください",
          user: { login: "factory-bot" },
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
    expect(result.items.map((c) => c.id)).toEqual([1]);
  });

  test("drops the viewer's marker-bearing comment (factory's own post)", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk([
        {
          id: 2,
          body: withMarker("pr_review", 9, "review started"),
          user: { login: "factory-bot" },
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
    expect(result.items).toEqual([]);
  });

  test("keeps another user's marker-bearing comment (marker alone is not proof of factory authorship)", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk([
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
    expect(result.items.map((c) => c.id)).toEqual([3]);
  });

  test("parses author_association when present", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk([
        {
          id: 1,
          body: "please fix this",
          user: { login: "alice" },
          author_association: "CONTRIBUTOR",
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
    expect(result.items[0]?.authorAssociation).toBe("CONTRIBUTOR");
  });

  test("only returns comments with an id greater than sinceId", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk([
        { id: 10, body: "old comment", user: { login: "alice" } },
        { id: 20, body: "READMEも直してください", user: { login: "alice" } },
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
        {
          id: 9,
          body: withMarker("pr_review", 9, "review started"),
          user: { login: "factory-bot" },
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

describe("addLabels", () => {
  test("POSTs (additive — unlike setLabels's PUT, which replaces the whole set)", async () => {
    const fake = createFakeCommandRunner([ok(ghApiStdout(200, []))]);
    await addLabels({ run: fake.run, ghToken: "tok" }, "acme", "widgets", 5, [
      "a",
      "b",
    ]);
    expect(fake.calls[0]?.argv).toContain("POST");
    expect(fake.calls[0]?.argv).toContain("repos/acme/widgets/issues/5/labels");
  });

  test("sends labels as the request body", async () => {
    const fake = createFakeCommandRunner([ok(ghApiStdout(200, []))]);
    await addLabels({ run: fake.run, ghToken: "tok" }, "acme", "widgets", 5, [
      "a",
      "b",
    ]);
    expect(fake.calls[0]?.options?.stdin).toBe(
      JSON.stringify({ labels: ["a", "b"] }),
    );
  });

  test("throws on a non-2xx response", async () => {
    const fake = createFakeCommandRunner([
      ok(ghApiStdout(422, { message: "Validation Failed" })),
    ]);
    await expect(
      addLabels({ run: fake.run, ghToken: "tok" }, "acme", "widgets", 5, ["a"]),
    ).rejects.toThrow();
  });

  test("masks a secret-looking value in the thrown error", async () => {
    const secret = "github_pat_11ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const fake = createFakeCommandRunner([
      ok(ghApiStdout(422, { message: secret })),
    ]);
    let caught: unknown;
    try {
      await addLabels({ run: fake.run, ghToken: "tok" }, "acme", "widgets", 5, [
        "a",
      ]);
    } catch (err) {
      caught = err;
    }
    expect(caught instanceof Error && !caught.message.includes(secret)).toBe(
      true,
    );
  });

  test("validates owner/repo before making any request", async () => {
    const fake = createFakeCommandRunner([]);
    await expect(
      addLabels(
        { run: fake.run, ghToken: "tok" },
        "not a valid owner",
        "widgets",
        5,
        ["a"],
      ),
    ).rejects.toThrow();
    expect(fake.calls).toHaveLength(0);
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
        assignees: [],
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

describe("findIssueByMarker", () => {
  test("returns the first match's number/htmlUrl/body", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk({
        items: [
          {
            id: 1,
            number: 7,
            title: "Extract a shared helper",
            body: "背景\n\n<!-- factory:issue_proposal:3 -->",
            html_url: "https://github.com/acme/widgets/issues/7",
            repository_url: "https://api.github.com/repos/acme/widgets",
            user: { login: "alice" },
          },
        ],
      }),
    ]);
    const result = await findIssueByMarker(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      "factory:issue_proposal:3",
    );
    expect(result).toEqual({
      number: 7,
      htmlUrl: "https://github.com/acme/widgets/issues/7",
      body: "背景\n\n<!-- factory:issue_proposal:3 -->",
    });
  });

  test("returns null when nothing matches", async () => {
    const fake = createFakeCommandRunner([ghApiOk({ items: [] })]);
    const result = await findIssueByMarker(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      "factory:issue_proposal:3",
    );
    expect(result).toBeNull();
  });

  test("quotes the marker phrase in the search query", async () => {
    const fake = createFakeCommandRunner([ghApiOk({ items: [] })]);
    await findIssueByMarker(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      "factory:issue_proposal:3",
    );
    const decoded = decodeURIComponent(fake.calls[0]?.argv.join(" ") ?? "");
    expect(decoded).toContain('"factory:issue_proposal:3" in:body');
  });

  test("scopes the search to the given repo", async () => {
    const fake = createFakeCommandRunner([ghApiOk({ items: [] })]);
    await findIssueByMarker(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      "factory:issue_proposal:3",
    );
    const decoded = decodeURIComponent(fake.calls[0]?.argv.join(" ") ?? "");
    expect(decoded).toContain("is:issue repo:acme/widgets");
  });
});

describe("searchPrs", () => {
  const SEARCH_PRS_OPTS = {
    owner: "acme",
    ownerKind: "user" as const,
    viewer: "factory-bot",
    reviewLabel: "factory:review",
    fixLabel: "factory:fix",
  };

  // 4 queries: review-requested, assignee, review label, fix label.
  const QUERY_COUNT = 4;

  function emptyResponses(count: number): CommandResult[] {
    return Array.from({ length: count }, () => ghApiOk({ items: [] }));
  }

  function prItem(id: number, number: number): unknown {
    return {
      id,
      number,
      title: `pr ${String(number)}`,
      body: null,
      html_url: `https://github.com/acme/widgets/pull/${String(number)}`,
      repository_url: "https://api.github.com/repos/acme/widgets",
      user: null,
    };
  }

  // GitHub's /search/issues does not support parenthesized OR grouping
  // (confirmed empirically: `(review-requested:X OR assignee:X OR
  // label:Y)` always returned 0 results, while each qualifier alone
  // matched) — so searchPrs issues one query per qualifier and merges them:
  // review-requested, assignee, review label, fix label (2026-09-27 PR
  // label cleanup: no more wip/state labels — see searchPrs's doc comment;
  // a PR whose trigger label was already consumed is rediscovered by
  // poll_prs.ts's listTrackedPrs instead, not by this search).

  test("issues one query per qualifier — review-requested, assignee, review label, fix label — instead of one OR-grouped query", async () => {
    const fake = createFakeCommandRunner(emptyResponses(QUERY_COUNT));
    await searchPrs({ run: fake.run, ghToken: "tok" }, SEARCH_PRS_OPTS);
    expect(fake.calls).toHaveLength(QUERY_COUNT);
    const decoded = fake.calls.map((call) =>
      decodeURIComponent(call.argv.join(" ")),
    );
    expect(decoded[0]).toContain("review-requested:factory-bot");
    expect(decoded[0]).not.toContain("OR");
    expect(decoded[1]).toContain("assignee:factory-bot");
    expect(decoded[2]).toContain('label:"factory:review"');
    expect(decoded[3]).toContain('label:"factory:fix"');
  });

  test("issues no commenter: query", async () => {
    const fake = createFakeCommandRunner(emptyResponses(QUERY_COUNT));
    await searchPrs({ run: fake.run, ghToken: "tok" }, SEARCH_PRS_OPTS);
    for (const call of fake.calls) {
      expect(decodeURIComponent(call.argv.join(" "))).not.toContain(
        "commenter:",
      );
    }
  });

  test("issues no wip-label exclusion (there is no wip label any more)", async () => {
    const fake = createFakeCommandRunner(emptyResponses(QUERY_COUNT));
    await searchPrs({ run: fake.run, ghToken: "tok" }, SEARCH_PRS_OPTS);
    for (const call of fake.calls) {
      expect(decodeURIComponent(call.argv.join(" "))).not.toContain("-label:");
    }
  });

  test("quotes the label qualifiers (a label name can contain a colon)", async () => {
    const fake = createFakeCommandRunner(emptyResponses(QUERY_COUNT));
    await searchPrs({ run: fake.run, ghToken: "tok" }, SEARCH_PRS_OPTS);
    const decoded = fake.calls.map((call) =>
      decodeURIComponent(call.argv.join(" ")),
    );
    expect(decoded[2]).toContain('label:"factory:review"');
    expect(decoded[3]).toContain('label:"factory:fix"');
  });

  test("requests per_page=100 on every query", async () => {
    const fake = createFakeCommandRunner(emptyResponses(QUERY_COUNT));
    await searchPrs({ run: fake.run, ghToken: "tok" }, SEARCH_PRS_OPTS);
    expect(fake.calls).toHaveLength(QUERY_COUNT); // all canned responses consumed
    for (const call of fake.calls) {
      expect(call.argv.join(" ")).toContain("per_page=100");
    }
  });

  test("de-duplicates by PR id when the same PR matches more than one query", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk({ items: [prItem(1, 10)] }), // review-requested
      ghApiOk({ items: [prItem(1, 10)] }), // assignee — same PR again
      ghApiOk({ items: [] }), // review label
      ghApiOk({ items: [] }), // fix label
    ]);
    const items = await searchPrs(
      { run: fake.run, ghToken: "tok" },
      SEARCH_PRS_OPTS,
    );
    expect(fake.calls).toHaveLength(QUERY_COUNT); // all canned responses consumed
    expect(items.map((item) => item.number)).toEqual([10]);
  });

  test("combines distinct PRs across every query", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk({ items: [prItem(1, 10)] }),
      ghApiOk({ items: [prItem(2, 11)] }),
      ghApiOk({ items: [prItem(3, 12)] }),
      ghApiOk({ items: [prItem(4, 13)] }),
    ]);
    const items = await searchPrs(
      { run: fake.run, ghToken: "tok" },
      SEARCH_PRS_OPTS,
    );
    expect(items.map((item) => item.number)).toEqual([10, 11, 12, 13]);
  });

  test("follows the link header's rel=next page within a single query", async () => {
    const fake = createFakeCommandRunner([
      ok(
        ghApiStdout(
          200,
          { items: [prItem(1, 10)] },
          {
            link: '<https://api.github.com/search/issues?q=x&page=2>; rel="next"',
          },
        ),
      ),
      ghApiOk({ items: [prItem(2, 11)] }),
      ...emptyResponses(QUERY_COUNT - 1),
    ]);
    const items = await searchPrs(
      { run: fake.run, ghToken: "tok" },
      SEARCH_PRS_OPTS,
    );
    expect(fake.calls).toHaveLength(QUERY_COUNT + 1); // 2 pages of query 1 + the rest
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
  test("keeps the viewer's review whose body carries a pr_review marker (factory's own review is feedback for pr_fix)", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk([
        {
          id: 2,
          user: { login: VIEWER },
          state: "COMMENTED",
          body: withMarker("pr_review", 1, "factory review findings"),
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
    expect(result.items.map((r) => r.id)).toEqual([2]);
  });

  test("drops the viewer's review carrying a pr_fix marker (factory's own reply)", async () => {
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
          body: withMarker("pr_fix", 1, "fixed"),
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

  test("parses author_association when present", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk([
        {
          id: 1,
          user: { login: "alice" },
          state: "COMMENTED",
          body: "looks fine",
          author_association: "MEMBER",
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
    expect(result.items[0]?.authorAssociation).toBe("MEMBER");
  });

  test("returns maxId across all reviews, including filtered-out ones", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk([
        { id: 1, user: { login: "alice" }, state: "COMMENTED", body: "x" },
        {
          id: 9,
          user: { login: VIEWER },
          state: "COMMENTED",
          body: withMarker("pr_fix", 1, "y"),
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
    expect(result.maxId).toBe(9);
  });
});

describe("listPrReviewComments", () => {
  test("keeps the viewer's unmarked inline comment (factory's own pr_review-pass finding is feedback for pr_fix)", async () => {
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
          body: "factory finding, no marker",
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
    expect(result.items.map((c) => c.id)).toEqual([1, 2]);
  });

  test("drops the viewer's pr_fix-marked reply (factory's own reply)", async () => {
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
          body: withMarker("pr_fix", 1, "fixed"),
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

  test("parses author_association when present", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk([
        {
          id: 1,
          user: { login: "alice" },
          path: "a.ts",
          line: 10,
          body: "fix this",
          author_association: "OWNER",
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
    expect(result.items[0]?.authorAssociation).toBe("OWNER");
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

  test("omits start_line/start_side for a single-line comment", async () => {
    const fake = createFakeCommandRunner([ghApiOk({ id: 77 })]);
    await createPrReview(
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
    const stdin = fake.calls[0]?.options?.stdin ?? "";
    expect(stdin).not.toContain("start_line");
    expect(stdin).not.toContain("start_side");
  });

  test("includes start_line and a fixed start_side: RIGHT for a multi-line comment", async () => {
    const fake = createFakeCommandRunner([ghApiOk({ id: 77 })]);
    await createPrReview(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      12,
      {
        event: "COMMENT",
        body: "summary",
        comments: [
          {
            path: "a.ts",
            line: 12,
            start_line: 10,
            side: "RIGHT",
            body: "spans multiple lines",
          },
        ],
      },
    );
    const stdin = fake.calls[0]?.options?.stdin ?? "";
    const parsed: unknown = JSON.parse(stdin);
    if (!isRecord(parsed) || !Array.isArray(parsed.comments)) {
      throw new Error("expected a comments array in the request body");
    }
    const comment = parsed.comments[0];
    expect(comment).toMatchObject({
      line: 12,
      start_line: 10,
      side: "RIGHT",
      start_side: "RIGHT",
    });
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

describe("getBranchProtected", () => {
  test("returns true for a protected branch", async () => {
    const fake = createFakeCommandRunner([ghApiOk({ protected: true })]);
    const protectedFlag = await getBranchProtected(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      "main",
    );
    expect(protectedFlag).toBe(true);
  });

  test("returns false for an unprotected branch (the endpoint returns 200, not 404)", async () => {
    const fake = createFakeCommandRunner([ghApiOk({ protected: false })]);
    const protectedFlag = await getBranchProtected(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      "main",
    );
    expect(protectedFlag).toBe(false);
  });
});

describe("postIssueComment", () => {
  test("always posts a new comment (non-idempotent, no marker added)", async () => {
    const fake = createFakeCommandRunner([ghApiOk({ id: 55 })]);
    const result = await postIssueComment(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      5,
      "plain reply, no marker",
    );
    expect(result).toEqual({ id: 55 });
  });

  test("does not append a marker to the posted body", async () => {
    const fake = createFakeCommandRunner([ghApiOk({ id: 55 })]);
    await postIssueComment(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      5,
      "plain reply, no marker",
    );
    expect(fake.calls[0]?.options?.stdin).not.toContain("factory:");
  });
});

function reviewThreadNode(overrides: {
  readonly id: string;
  readonly isResolved: boolean;
  readonly path?: string;
  readonly line?: number | null;
  readonly firstComment: unknown;
  readonly lastComment?: unknown;
  readonly allCommentDatabaseIds?: readonly (number | null)[];
}): unknown {
  return {
    id: overrides.id,
    isResolved: overrides.isResolved,
    path: overrides.path ?? "a.ts",
    line: overrides.line ?? 10,
    firstComments: { nodes: [overrides.firstComment] },
    lastComments: { nodes: [overrides.lastComment ?? overrides.firstComment] },
    allComments: {
      nodes: (overrides.allCommentDatabaseIds ?? []).map((databaseId) => ({
        databaseId,
      })),
    },
  };
}

function reviewThreadsGraphqlPayload(nodes: unknown[]): unknown {
  return {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: { nodes },
        },
      },
    },
  };
}

describe("listReviewThreads", () => {
  test("parses each thread's id, isResolved, and first comment's author/body", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk(
        reviewThreadsGraphqlPayload([
          reviewThreadNode({
            id: "PRRT_1",
            isResolved: false,
            firstComment: {
              author: { login: VIEWER },
              body: "[pr_review 自動レビュー] @alice\n[MUST] fix this",
            },
          }),
        ]),
      ),
    ]);
    const threads = await listReviewThreads(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      12,
    );
    expect(threads).toEqual([
      {
        id: "PRRT_1",
        isResolved: false,
        path: "a.ts",
        line: 10,
        firstCommentAuthorLogin: VIEWER,
        firstCommentBody: "[pr_review 自動レビュー] @alice\n[MUST] fix this",
        lastCommentAuthorLogin: VIEWER,
        lastCommentBody: "[pr_review 自動レビュー] @alice\n[MUST] fix this",
        firstCommentDatabaseId: null,
        allCommentIds: [],
      },
    ]);
  });

  test("parses the first comment's databaseId and every comment's id in allCommentIds", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk(
        reviewThreadsGraphqlPayload([
          reviewThreadNode({
            id: "PRRT_1",
            isResolved: false,
            firstComment: {
              author: { login: VIEWER },
              body: "[pr_review 自動レビュー] @alice\n[MUST] fix this",
              databaseId: 501,
            },
            allCommentDatabaseIds: [501, 502],
          }),
        ]),
      ),
    ]);
    const threads = await listReviewThreads(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      12,
    );
    expect(threads[0]).toMatchObject({
      firstCommentDatabaseId: 501,
      allCommentIds: [501, 502],
    });
  });

  test("drops a null databaseId from allCommentIds", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk(
        reviewThreadsGraphqlPayload([
          reviewThreadNode({
            id: "PRRT_1",
            isResolved: false,
            firstComment: {
              author: { login: VIEWER },
              body: "hi",
            },
            allCommentDatabaseIds: [null, 502],
          }),
        ]),
      ),
    ]);
    const threads = await listReviewThreads(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      12,
    );
    expect(threads[0]?.allCommentIds).toEqual([502]);
  });

  test("parses the last comment's author/body separately from the first", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk(
        reviewThreadsGraphqlPayload([
          reviewThreadNode({
            id: "PRRT_1",
            isResolved: false,
            firstComment: {
              author: { login: VIEWER },
              body: "[pr_review 自動レビュー] @alice\n[MUST] fix this",
            },
            lastComment: { author: { login: "alice" }, body: "done, thanks" },
          }),
        ]),
      ),
    ]);
    const threads = await listReviewThreads(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      12,
    );
    expect(threads[0]).toMatchObject({
      lastCommentAuthorLogin: "alice",
      lastCommentBody: "done, thanks",
    });
  });

  test("throws when the response is HTTP 200 with a GraphQL errors envelope", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk({ errors: [{ message: "Resource not accessible" }] }),
    ]);
    await expect(
      listReviewThreads(
        { run: fake.run, ghToken: "tok" },
        "acme",
        "widgets",
        12,
      ),
    ).rejects.toThrow(/Resource not accessible/);
  });

  test("calls gh api graphql", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk(reviewThreadsGraphqlPayload([])),
    ]);
    await listReviewThreads(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      12,
    );
    expect(fake.calls[0]?.argv).toContain("graphql");
  });

  test("passes owner/repo/number as GraphQL variables", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk(reviewThreadsGraphqlPayload([])),
    ]);
    await listReviewThreads(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      12,
    );
    const stdin = fake.calls[0]?.options?.stdin ?? "";
    const parsed: unknown = JSON.parse(stdin);
    if (!isRecord(parsed)) {
      throw new Error("expected a JSON request body");
    }
    expect(parsed.variables).toEqual({
      owner: "acme",
      repo: "widgets",
      number: 12,
    });
  });

  test("skips a thread with no comments rather than throwing", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk(
        reviewThreadsGraphqlPayload([
          {
            id: "PRRT_1",
            isResolved: false,
            path: "a.ts",
            line: 10,
            firstComments: { nodes: [] },
            lastComments: { nodes: [] },
            allComments: { nodes: [] },
          },
        ]),
      ),
    ]);
    const threads = await listReviewThreads(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      12,
    );
    expect(threads).toEqual([]);
  });

  test("returns an empty firstCommentAuthorLogin when the first comment's author is null", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk(
        reviewThreadsGraphqlPayload([
          reviewThreadNode({
            id: "PRRT_1",
            isResolved: true,
            firstComment: { author: null, body: "hi" },
          }),
        ]),
      ),
    ]);
    const threads = await listReviewThreads(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      12,
    );
    expect(threads[0]?.firstCommentAuthorLogin).toBe("");
  });
});

describe("resolveReviewThread", () => {
  test("posts the resolveReviewThread mutation with the thread id", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk({
        data: {
          resolveReviewThread: { thread: { id: "PRRT_1", isResolved: true } },
        },
      }),
    ]);
    await resolveReviewThread({ run: fake.run, ghToken: "tok" }, "PRRT_1");
    const stdin = fake.calls[0]?.options?.stdin ?? "";
    const parsed: unknown = JSON.parse(stdin);
    if (!isRecord(parsed)) {
      throw new Error("expected a JSON request body");
    }
    expect(parsed.variables).toEqual({ id: "PRRT_1" });
  });

  test("calls gh api graphql", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk({
        data: {
          resolveReviewThread: { thread: { id: "PRRT_1", isResolved: true } },
        },
      }),
    ]);
    await resolveReviewThread({ run: fake.run, ghToken: "tok" }, "PRRT_1");
    expect(fake.calls[0]?.argv).toContain("graphql");
  });

  test("throws when the GraphQL call returns an error status", async () => {
    const fake = createFakeCommandRunner([
      ok(ghApiStdout(400, { message: "bad" })),
    ]);
    await expect(
      resolveReviewThread({ run: fake.run, ghToken: "tok" }, "PRRT_1"),
    ).rejects.toThrow();
  });

  test("throws when the response is HTTP 200 with a GraphQL errors envelope", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk({ errors: [{ message: "Could not resolve to a node" }] }),
    ]);
    await expect(
      resolveReviewThread({ run: fake.run, ghToken: "tok" }, "PRRT_1"),
    ).rejects.toThrow(/Could not resolve to a node/);
  });
});

describe("parseGitHubRepoUrl", () => {
  test("parses an https URL", () => {
    expect(
      parseGitHubRepoUrl("https://github.com/octo-owner/atelier-works"),
    ).toEqual({
      owner: "octo-owner",
      repo: "atelier-works",
    });
  });

  test("strips a trailing .git", () => {
    expect(
      parseGitHubRepoUrl("https://github.com/octo-owner/atelier-works.git")
        .repo,
    ).toBe("atelier-works");
  });

  test("rejects a non-GitHub URL", () => {
    expect(() => parseGitHubRepoUrl("https://example.com/a/b")).toThrow();
  });

  test("normalizes an uppercase .GIT suffix and trailing slash", () => {
    expect(parseGitHubRepoUrl("https://github.com/o/r.GIT/").repo).toBe("r");
  });

  test("never includes the raw URL (which may carry credentials) in the error message", () => {
    expect(() =>
      parseGitHubRepoUrl("https://user:secret@github.com/o/r"),
    ).toThrow(/^(?!.*secret).*$/);
  });
});

describe("createPullRequest", () => {
  test("returns the created PR's number and URL", async () => {
    const fake = createFakeCommandRunner([
      ok(
        ghApiStdout(201, {
          number: 12,
          html_url: "https://github.com/acme/widgets/pull/12",
        }),
      ),
    ]);
    const result = await createPullRequest(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      {
        head: "factory/issue-7-wi-3",
        base: "main",
        title: "feat: CSV出力を追加する",
        body: "## 概要",
      },
    );
    expect(result).toEqual({
      number: 12,
      htmlUrl: "https://github.com/acme/widgets/pull/12",
    });
  });

  test("POSTs to the pulls endpoint", async () => {
    const fake = createFakeCommandRunner([
      ok(ghApiStdout(201, { number: 12, html_url: "https://x/12" })),
    ]);
    await createPullRequest(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      {
        head: "factory/issue-7-wi-3",
        base: "main",
        title: "t",
        body: "b",
      },
    );
    expect(fake.calls[0]?.argv).toEqual(
      expect.arrayContaining(["repos/acme/widgets/pulls", "POST"]),
    );
  });

  test("sends head/base/title/body and draft: false by default", async () => {
    const fake = createFakeCommandRunner([
      ok(ghApiStdout(201, { number: 12, html_url: "https://x/12" })),
    ]);
    await createPullRequest(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      {
        head: "factory/issue-7-wi-3",
        base: "main",
        title: "t",
        body: "b",
      },
    );
    expect(fake.calls[0]?.options?.stdin).toBe(
      JSON.stringify({
        title: "t",
        body: "b",
        head: "factory/issue-7-wi-3",
        base: "main",
        draft: false,
      }),
    );
  });

  test("sends draft: true when requested", async () => {
    const fake = createFakeCommandRunner([
      ok(ghApiStdout(201, { number: 12, html_url: "https://x/12" })),
    ]);
    await createPullRequest(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      {
        head: "factory/issue-7-wi-3",
        base: "main",
        title: "t",
        body: "b",
        draft: true,
      },
    );
    expect(fake.calls[0]?.options?.stdin).toContain('"draft":true');
  });

  test("does not spawn anything for a head branch name starting with a dash", async () => {
    const fake = createFakeCommandRunner([]);
    await createPullRequest(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      {
        head: "-evil",
        base: "main",
        title: "t",
        body: "b",
      },
    ).catch(() => undefined);
    expect(fake.calls).toHaveLength(0);
  });

  test("throws on a 422 (a PR for this head already exists)", async () => {
    const fake = createFakeCommandRunner([
      ok(ghApiStdout(422, { message: "A pull request already exists" })),
    ]);
    await expect(
      createPullRequest({ run: fake.run, ghToken: "tok" }, "acme", "widgets", {
        head: "factory/issue-7-wi-3",
        base: "main",
        title: "t",
        body: "b",
      }),
    ).rejects.toThrow(/HTTP 422/);
  });

  test("rejects a response without number/html_url", async () => {
    const fake = createFakeCommandRunner([ok(ghApiStdout(201, { id: 1 }))]);
    await expect(
      createPullRequest({ run: fake.run, ghToken: "tok" }, "acme", "widgets", {
        head: "factory/issue-7-wi-3",
        base: "main",
        title: "t",
        body: "b",
      }),
    ).rejects.toThrow(/unexpected response shape/);
  });
});

describe("findOpenPullRequestByHead", () => {
  test("returns the first open PR whose head matches", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk([
        { number: 12, html_url: "https://github.com/acme/widgets/pull/12" },
      ]),
    ]);
    const result = await findOpenPullRequestByHead(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      "factory/issue-7-wi-3",
    );
    expect(result).toEqual({
      number: 12,
      htmlUrl: "https://github.com/acme/widgets/pull/12",
    });
  });

  test("returns null when no open PR has that head", async () => {
    const fake = createFakeCommandRunner([ghApiOk([])]);
    const result = await findOpenPullRequestByHead(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      "factory/issue-7-wi-3",
    );
    expect(result).toBeNull();
  });

  test("queries pulls with head=<owner>:<branch> and state=open", async () => {
    const fake = createFakeCommandRunner([ghApiOk([])]);
    await findOpenPullRequestByHead(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      "factory/issue-7-wi-3",
    );
    const decoded = decodeURIComponent(fake.calls[0]?.argv.join(" ") ?? "");
    expect(decoded).toContain(
      "repos/acme/widgets/pulls?head=acme:factory/issue-7-wi-3&state=open",
    );
  });

  test("throws when the response is not an array", async () => {
    const fake = createFakeCommandRunner([ghApiOk({ message: "nope" })]);
    await expect(
      findOpenPullRequestByHead(
        { run: fake.run, ghToken: "tok" },
        "acme",
        "widgets",
        "factory/issue-7-wi-3",
      ),
    ).rejects.toThrow(/expected an array/);
  });

  test("throws when the first element lacks html_url", async () => {
    const fake = createFakeCommandRunner([ghApiOk([{ number: 12 }])]);
    await expect(
      findOpenPullRequestByHead(
        { run: fake.run, ghToken: "tok" },
        "acme",
        "widgets",
        "factory/issue-7-wi-3",
      ),
    ).rejects.toThrow(/unexpected response shape/);
  });
});

describe("updatePullRequest", () => {
  test("sends the title and the body", async () => {
    const fake = createFakeCommandRunner([ghApiOk({ number: 12 })]);
    await updatePullRequest(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      12,
      {
        title: "新しいタイトル",
        body: "new body",
      },
    );
    expect(fake.calls[0]?.options?.stdin).toBe(
      JSON.stringify({ title: "新しいタイトル", body: "new body" }),
    );
  });

  test("sends only the fields given", async () => {
    const fake = createFakeCommandRunner([ghApiOk({ number: 12 })]);
    await updatePullRequest(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      12,
      {
        title: "新しいタイトル",
      },
    );
    expect(fake.calls[0]?.options?.stdin).toBe(
      JSON.stringify({ title: "新しいタイトル" }),
    );
  });

  test("throws on a non-2xx response", async () => {
    const fake = createFakeCommandRunner([
      ok(ghApiStdout(422, { message: "Validation Failed" })),
    ]);
    await expect(
      updatePullRequest(
        { run: fake.run, ghToken: "tok" },
        "acme",
        "widgets",
        12,
        {
          title: "t",
        },
      ),
    ).rejects.toThrow(/HTTP 422/);
  });
});

describe("updatePullRequestBody", () => {
  test("PATCHes the pull request endpoint", async () => {
    const fake = createFakeCommandRunner([ghApiOk({ number: 12 })]);
    await updatePullRequestBody(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      12,
      "new body",
    );
    expect(fake.calls[0]?.argv).toEqual(
      expect.arrayContaining(["repos/acme/widgets/pulls/12", "PATCH"]),
    );
  });

  test("sends only the body field", async () => {
    const fake = createFakeCommandRunner([ghApiOk({ number: 12 })]);
    await updatePullRequestBody(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      12,
      "new body",
    );
    expect(fake.calls[0]?.options?.stdin).toBe(
      JSON.stringify({ body: "new body" }),
    );
  });

  test("throws on a non-2xx response", async () => {
    const fake = createFakeCommandRunner([
      ok(ghApiStdout(404, { message: "Not Found" })),
    ]);
    await expect(
      updatePullRequestBody(
        { run: fake.run, ghToken: "tok" },
        "acme",
        "widgets",
        12,
        "new body",
      ),
    ).rejects.toThrow(/HTTP 404/);
  });
});

describe("ensureLabel", () => {
  const LABEL_OPTS = {
    color: "0e8a16",
    description: "Factoryの自動レビュー対象",
  };

  test("returns created: false without POSTing when the label already exists", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk({ name: "factory:review", color: "0e8a16" }),
    ]);
    const result = await ensureLabel(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      "factory:review",
      LABEL_OPTS,
    );
    expect(result).toEqual({ created: false });
  });

  test("makes only the GET call when the label already exists", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk({ name: "factory:review", color: "0e8a16" }),
    ]);
    await ensureLabel(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      "factory:review",
      LABEL_OPTS,
    );
    expect(fake.calls).toHaveLength(1);
  });

  test("creates the label after a 404 and returns created: true", async () => {
    const fake = createFakeCommandRunner([
      ok(ghApiStdout(404, { message: "Not Found" })),
      ok(ghApiStdout(201, { name: "factory:review" })),
    ]);
    const result = await ensureLabel(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      "factory:review",
      LABEL_OPTS,
    );
    expect(result).toEqual({ created: true });
  });

  test("POSTs name/color/description to the labels endpoint", async () => {
    const fake = createFakeCommandRunner([
      ok(ghApiStdout(404, { message: "Not Found" })),
      ok(ghApiStdout(201, { name: "factory:review" })),
    ]);
    await ensureLabel(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      "factory:review",
      LABEL_OPTS,
    );
    expect(fake.calls[1]?.options?.stdin).toBe(
      JSON.stringify({
        name: "factory:review",
        color: "0e8a16",
        description: "Factoryの自動レビュー対象",
      }),
    );
  });

  test("URL-encodes the label name in the GET (a label can contain a colon)", async () => {
    const fake = createFakeCommandRunner([ghApiOk({ name: "factory:review" })]);
    await ensureLabel(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      "factory:review",
      LABEL_OPTS,
    );
    expect(fake.calls[0]?.argv).toContain(
      "repos/acme/widgets/labels/factory%3Areview",
    );
  });

  test("treats a 422 on create as already existing (raced with another job)", async () => {
    const fake = createFakeCommandRunner([
      ok(ghApiStdout(404, { message: "Not Found" })),
      ok(
        ghApiStdout(422, {
          message: "Validation Failed",
          errors: [{ code: "already_exists" }],
        }),
      ),
    ]);
    const result = await ensureLabel(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      "factory:review",
      LABEL_OPTS,
    );
    expect(result).toEqual({ created: false });
  });

  test("throws when the existence check fails with a non-404 error", async () => {
    const fake = createFakeCommandRunner([
      ok(ghApiStdout(500, { message: "boom" })),
    ]);
    await expect(
      ensureLabel(
        { run: fake.run, ghToken: "tok" },
        "acme",
        "widgets",
        "factory:review",
        LABEL_OPTS,
      ),
    ).rejects.toThrow(/HTTP 500/);
  });

  test("throws on a 422 that is not an already_exists validation error", async () => {
    const fake = createFakeCommandRunner([
      ok(ghApiStdout(404, { message: "Not Found" })),
      ok(
        ghApiStdout(422, {
          message: "Validation Failed",
          errors: [{ code: "invalid", field: "color" }],
        }),
      ),
    ]);
    await expect(
      ensureLabel(
        { run: fake.run, ghToken: "tok" },
        "acme",
        "widgets",
        "factory:review",
        LABEL_OPTS,
      ),
    ).rejects.toThrow(/HTTP 422/);
  });

  test("throws when the create POST fails with a 500", async () => {
    const fake = createFakeCommandRunner([
      ok(ghApiStdout(404, { message: "Not Found" })),
      ok(ghApiStdout(500, { message: "boom" })),
    ]);
    await expect(
      ensureLabel(
        { run: fake.run, ghToken: "tok" },
        "acme",
        "widgets",
        "factory:review",
        LABEL_OPTS,
      ),
    ).rejects.toThrow(/HTTP 500/);
  });
});
