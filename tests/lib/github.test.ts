import { describe, expect, test } from "bun:test";
import {
  addLabels,
  type ClaimIssueResult,
  ClaimOwnershipUnknownError,
  claimIssue,
  commentIssue,
  createIssue,
  createPrReview,
  createPullRequest,
  ensureLabel,
  type FetchLike,
  fetchIssueContent,
  fetchIssueState,
  findIssueByMarker,
  findOpenPullRequestByHead,
  type GhClient,
  GITHUB_RATE_LIMIT_MAX_WAIT_MS,
  GITHUB_TRANSIENT_RETRY_DELAY_MS,
  GitHubHttpError,
  GitHubRateLimitError,
  getBranchProtected,
  getIssue,
  getLabelerLogin,
  getPr,
  getPrDiff,
  getPrFiles,
  getViewer,
  gitIdentityForViewer,
  hasMarker,
  isFactoryPost,
  isOwnPost,
  LabelerCheckLimitError,
  listIssueComments,
  listPrReviewComments,
  listPrReviews,
  listPullRequestNumbersByHead,
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
import type { Logger } from "../../f/factory/lib/log.ts";
import { isRecord } from "../../f/factory/lib/types.ts";
import {
  type CommandResult,
  SpawnError,
} from "../../f/factory/lib/workspace.ts";
import {
  createFakeCommandRunner,
  fail,
  ghApiOk,
  ghApiStdout,
  labelEventNode,
  labelEventsOk,
  ok,
  timeout,
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
  test("points TMPDIR at the given job directory", async () => {
    const fake = createFakeCommandRunner([ghApiOk({ login: "bot", id: 1 })]);
    await getViewer({
      run: fake.run,
      ghToken: "tok",
      tmpDir: "/tmp/windmill/fj-x",
    });
    expect(fake.calls[0]?.options?.env?.TMPDIR).toBe("/tmp/windmill/fj-x");
  });

  test("leaves TMPDIR unset outside a job", async () => {
    const fake = createFakeCommandRunner([ghApiOk({ login: "bot", id: 1 })]);
    await getViewer({ run: fake.run, ghToken: "tok" });
    expect(fake.calls[0]?.options?.env?.TMPDIR).toBeUndefined();
  });

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
      ok(ghApiStdout(500, { message: "boom" })),
    ]);
    await expect(
      getViewer({ run: fake.run, ghToken: "tok", sleep: async () => {} }),
    ).rejects.toThrow(/HTTP 500/);
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

describe("rate limit wait cap", () => {
  const NOW = new Date("2026-10-08T00:00:00Z");
  const nowEpochSeconds = NOW.getTime() / 1000;

  /** `x-ratelimit-reset`が今から`seconds`秒後を指す一次レート制限の応答。 */
  function primaryLimited(seconds: number): CommandResult {
    return ok(
      ghApiStdout(
        403,
        { message: "API rate limit exceeded" },
        {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(nowEpochSeconds + seconds),
        },
      ),
    );
  }

  /** `retry-after`が`seconds`秒の二次レート制限の応答。 */
  function secondaryLimited(seconds: number): CommandResult {
    return ok(
      ghApiStdout(
        403,
        { message: "secondary rate limit" },
        { "retry-after": String(seconds) },
      ),
    );
  }

  /** 解除の時刻を示すヘッダーが無いrate limitの応答。 */
  const limitedWithoutReset = ok(
    ghApiStdout(
      403,
      { message: "API rate limit exceeded" },
      { "x-ratelimit-remaining": "0" },
    ),
  );

  const viewerOk = ghApiOk({ login: "factory-bot", id: 12345 });

  /** 時計と待機を差し替えたクライアント。`sleeps`に待った時間を記録する。 */
  function fakeClient(
    responses: readonly CommandResult[],
    sleeps: number[] = [],
  ): { client: GhClient; calls: readonly unknown[] } {
    const fake = createFakeCommandRunner(responses);
    return {
      client: {
        run: fake.run,
        ghToken: "tok",
        now: () => NOW,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
      calls: fake.calls,
    };
  }

  /** `promise`が拒否されたらその理由を、解決したら`null`を返す。 */
  function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
      () => null,
      (err: unknown) => err,
    );
  }

  test("waits the retry-after duration when it is within the cap", async () => {
    const sleeps: number[] = [];
    const { client } = fakeClient([secondaryLimited(30), viewerOk], sleeps);
    await getViewer(client);
    expect(sleeps).toEqual([30_000]);
  });

  test("adds a 1s margin to the wait computed from x-ratelimit-reset", async () => {
    const sleeps: number[] = [];
    const { client } = fakeClient([primaryLimited(30), viewerOk], sleeps);
    await getViewer(client);
    expect(sleeps).toEqual([31_000]);
  });

  test("waits exactly the cap when the reset plus the margin equals the cap", async () => {
    const sleeps: number[] = [];
    const { client } = fakeClient(
      [primaryLimited(GITHUB_RATE_LIMIT_MAX_WAIT_MS / 1000 - 1), viewerOk],
      sleeps,
    );
    await getViewer(client);
    expect(sleeps).toEqual([GITHUB_RATE_LIMIT_MAX_WAIT_MS]);
  });

  test("throws GitHubRateLimitError when the reset plus the margin exceeds the cap", async () => {
    const { client } = fakeClient([
      primaryLimited(GITHUB_RATE_LIMIT_MAX_WAIT_MS / 1000),
    ]);
    await expect(getViewer(client)).rejects.toBeInstanceOf(
      GitHubRateLimitError,
    );
  });

  test("throws GitHubRateLimitError when the reset is far beyond the cap", async () => {
    const { client } = fakeClient([primaryLimited(3600)]);
    await expect(getViewer(client)).rejects.toBeInstanceOf(
      GitHubRateLimitError,
    );
  });

  test("rejects without sleeping when the reset is beyond the cap", async () => {
    const sleeps: number[] = [];
    const { client } = fakeClient([primaryLimited(3600)], sleeps);
    const error = await rejectionOf(getViewer(client));
    expect({
      rateLimited: error instanceof GitHubRateLimitError,
      sleeps,
    }).toEqual({ rateLimited: true, sleeps: [] });
  });

  test("rejects without resending a POST when the wait is beyond the cap", async () => {
    const { client, calls } = fakeClient([primaryLimited(3600)]);
    const error = await rejectionOf(
      createPrReview(client, "acme", "widgets", 7, {
        event: "COMMENT",
        body: "review",
        comments: [],
      }),
    );
    expect({
      rateLimited: error instanceof GitHubRateLimitError,
      calls: calls.length,
    }).toEqual({ rateLimited: true, calls: 1 });
  });

  test("throws GitHubRateLimitError when retry-after is beyond the cap", async () => {
    const { client } = fakeClient([
      secondaryLimited(GITHUB_RATE_LIMIT_MAX_WAIT_MS / 1000 + 1),
    ]);
    await expect(getViewer(client)).rejects.toBeInstanceOf(
      GitHubRateLimitError,
    );
  });

  test("throws GitHubRateLimitError when the retry is rate limited again", async () => {
    const { client } = fakeClient([secondaryLimited(1), secondaryLimited(1)]);
    await expect(getViewer(client)).rejects.toBeInstanceOf(
      GitHubRateLimitError,
    );
  });

  test("does not send a third request when the retry is rate limited again", async () => {
    const { client, calls } = fakeClient([
      secondaryLimited(1),
      secondaryLimited(1),
    ]);
    await rejectionOf(getViewer(client));
    expect(calls.length).toBe(2);
  });

  test("names the endpoint, the wait and the cap in the error message", async () => {
    const { client } = fakeClient([primaryLimited(3600)]);
    await expect(getViewer(client)).rejects.toThrow(
      /^GitHub rate limit on user: needs a 3601s wait, longer than the 120s wait cap \(rerun after the limit resets\)$/,
    );
  });

  test("says the request was retried once when the retry is rate limited again", async () => {
    const { client } = fakeClient([secondaryLimited(1), secondaryLimited(5)]);
    await expect(getViewer(client)).rejects.toThrow(
      /^GitHub rate limit on user: still limited after waiting once \(needs a 5s wait\) \(rerun after the limit resets\)$/,
    );
  });

  test("leaves out the wait when the second response gives no reset time", async () => {
    const { client } = fakeClient([secondaryLimited(1), limitedWithoutReset]);
    await expect(getViewer(client)).rejects.toThrow(
      /^GitHub rate limit on user: still limited after waiting once \(rerun after the limit resets\)$/,
    );
  });

  test("sets the error name so on_error_flow can tell it apart", () => {
    const err = new GitHubRateLimitError("user", 3_600_000, false);
    expect(err.name).toBe("GitHubRateLimitError");
  });

  describe("GraphQL", () => {
    /** GraphQLの一次レート制限の応答(HTTP 200で、`errors[].type`が`RATE_LIMITED`)。 */
    const graphqlLimited = ok(
      ghApiStdout(
        200,
        {
          data: null,
          errors: [
            {
              type: "RATE_LIMITED",
              message: "API rate limit exceeded for user ID 1.",
            },
          ],
        },
        {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(nowEpochSeconds + 600),
        },
      ),
    );

    test("throws GitHubRateLimitError for an HTTP 200 RATE_LIMITED response", async () => {
      const { client } = fakeClient([graphqlLimited]);
      await expect(
        resolveReviewThread(client, "PRRT_1"),
      ).rejects.toBeInstanceOf(GitHubRateLimitError);
    });

    test("names graphql and the wait until the reset in the message", async () => {
      const { client } = fakeClient([graphqlLimited]);
      await expect(resolveReviewThread(client, "PRRT_1")).rejects.toThrow(
        /^GitHub rate limit on graphql: needs a 601s wait, longer than the 120s wait cap \(rerun after the limit resets\)$/,
      );
    });

    test("does not resend the mutation", async () => {
      const { client, calls } = fakeClient([graphqlLimited]);
      await rejectionOf(resolveReviewThread(client, "PRRT_1"));
      expect(calls.length).toBe(1);
    });

    test("still rejects as a GraphQL error when an error's type is not a string", async () => {
      const { client } = fakeClient([
        ok(
          ghApiStdout(200, {
            data: null,
            errors: [{ message: "x", type: null }],
          }),
        ),
      ]);
      await expect(resolveReviewThread(client, "PRRT_1")).rejects.toThrow(
        /GraphQL error/,
      );
    });
  });
});

describe("transient failure retry", () => {
  const viewerOk = ghApiOk({ login: "factory-bot", id: 12345 });
  const issueCreated = ghApiOk({
    number: 5,
    title: "t",
    body: "b",
    html_url: "https://github.com/acme/widgets/issues/5",
    state: "open",
    user: { login: "factory-bot" },
    labels: [],
    assignees: [],
  });
  /** 応答が返る前に接続が切れたときの`gh api -i`の結果(標準出力が空で、終了コードが1)。 */
  const connectionReset = fail(
    'Get "https://api.github.com/user": read tcp 10.0.0.2:51234->140.82.112.5:443: read: connection reset by peer',
  );

  function spawnError(code: string): Error {
    return new SpawnError(
      Object.assign(
        new Error(`${code}: resource unavailable, posix_spawn 'gh'`),
        { code },
      ),
    );
  }

  /** プロセスの起動後に起きた失敗。`SpawnError`ではないが、コードは資源不足を示す。 */
  function postSpawnError(code: string): Error {
    return Object.assign(new Error(`${code}: read failed`), { code });
  }

  function fakeClient(
    responses: readonly (CommandResult | Error)[],
    sleeps: number[] = [],
    transientRetryDelayMs?: number,
  ): { client: GhClient; calls: readonly unknown[] } {
    const fake = createFakeCommandRunner(responses);
    return {
      client: {
        run: fake.run,
        ghToken: "tok",
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        ...(transientRetryDelayMs !== undefined
          ? { transientRetryDelayMs }
          : {}),
      },
      calls: fake.calls,
    };
  }

  function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
      () => null,
      (err: unknown) => err,
    );
  }

  describe("when the gh process fails to start", () => {
    test("succeeds on the retry after an EAGAIN failure", async () => {
      const { client } = fakeClient([spawnError("EAGAIN"), viewerOk]);
      const viewer = await getViewer(client);
      expect(viewer.login).toBe("factory-bot");
    });

    test("waits the injected delay once before retrying", async () => {
      const sleeps: number[] = [];
      const { client } = fakeClient(
        [spawnError("EAGAIN"), viewerOk],
        sleeps,
        250,
      );
      await getViewer(client);
      expect(sleeps).toEqual([250]);
    });

    test("waits the default delay when none is injected", async () => {
      const sleeps: number[] = [];
      const { client } = fakeClient([spawnError("EAGAIN"), viewerOk], sleeps);
      await getViewer(client);
      expect(sleeps).toEqual([GITHUB_TRANSIENT_RETRY_DELAY_MS]);
    });

    test.each(["EMFILE", "ENFILE", "ENOMEM"])(
      "retries after an %s failure",
      async (code) => {
        const { client, calls } = fakeClient([spawnError(code), viewerOk]);
        await getViewer(client);
        expect(calls.length).toBe(2);
      },
    );

    test("throws the second failure when the retry fails to start too", async () => {
      const { client } = fakeClient([
        spawnError("EAGAIN"),
        spawnError("EMFILE"),
      ]);
      await expect(getViewer(client)).rejects.toThrow(/EMFILE/);
    });

    test("does not start a third process", async () => {
      const { client, calls } = fakeClient([
        spawnError("EAGAIN"),
        spawnError("EAGAIN"),
      ]);
      await rejectionOf(getViewer(client));
      expect(calls.length).toBe(2);
    });

    test("does not retry a spawn failure that is not transient", async () => {
      const { client, calls } = fakeClient([spawnError("ENOENT"), viewerOk]);
      await rejectionOf(getViewer(client));
      expect(calls.length).toBe(1);
    });

    test("does not retry an EAGAIN rejection that is not a SpawnError", async () => {
      const { client, calls } = fakeClient([
        postSpawnError("EAGAIN"),
        issueCreated,
      ]);
      await rejectionOf(
        createIssue(client, "acme", "widgets", { title: "t", body: "b" }),
      );
      expect(calls.length).toBe(1);
    });

    test("does not retry an error without a code", async () => {
      const { client, calls } = fakeClient([new Error("boom"), viewerOk]);
      await rejectionOf(getViewer(client));
      expect(calls.length).toBe(1);
    });

    test("retries a POST because the request never reached GitHub", async () => {
      const { client, calls } = fakeClient([
        spawnError("EAGAIN"),
        issueCreated,
      ]);
      await createIssue(client, "acme", "widgets", { title: "t", body: "b" });
      expect(calls.length).toBe(2);
    });
  });

  describe("when no response arrives", () => {
    test("succeeds on the retry of a GET", async () => {
      const { client } = fakeClient([connectionReset, viewerOk]);
      const viewer = await getViewer(client);
      expect(viewer.login).toBe("factory-bot");
    });

    test("waits the injected delay once before retrying a GET", async () => {
      const sleeps: number[] = [];
      const { client } = fakeClient([connectionReset, viewerOk], sleeps, 250);
      await getViewer(client);
      expect(sleeps).toEqual([250]);
    });

    test("records the second failure when no response arrives again", async () => {
      const { client } = fakeClient([connectionReset, connectionReset]);
      await expect(getViewer(client)).rejects.toThrow(/HTTP 0/);
    });

    test("does not send a third request", async () => {
      const { client, calls } = fakeClient([
        connectionReset,
        connectionReset,
        viewerOk,
      ]);
      await rejectionOf(getViewer(client));
      expect(calls.length).toBe(2);
    });

    test("does not resend a POST that may have reached GitHub", async () => {
      const { client, calls } = fakeClient([connectionReset, issueCreated]);
      await rejectionOf(
        createIssue(client, "acme", "widgets", { title: "t", body: "b" }),
      );
      expect(calls.length).toBe(1);
    });

    test("reports HTTP 0 for a POST without resending it", async () => {
      const { client } = fakeClient([connectionReset, issueCreated]);
      await expect(
        createIssue(client, "acme", "widgets", { title: "t", body: "b" }),
      ).rejects.toThrow(/HTTP 0/);
    });

    test("does not resend a DELETE", async () => {
      const { client, calls } = fakeClient([connectionReset, ok("")]);
      await rejectionOf(removeLabel(client, "acme", "widgets", 7, "bug"));
      expect(calls.length).toBe(1);
    });

    test("does not resend a PUT", async () => {
      const { client, calls } = fakeClient([connectionReset, ok("")]);
      await rejectionOf(setLabels(client, "acme", "widgets", 7, ["bug"]));
      expect(calls.length).toBe(1);
    });

    test("does not resend a PATCH", async () => {
      const { client, calls } = fakeClient([connectionReset, ok("")]);
      await rejectionOf(
        updatePullRequest(client, "acme", "widgets", 7, { title: "t" }),
      );
      expect(calls.length).toBe(1);
    });

    test("throws the spawn error when the retry fails to start", async () => {
      const { client } = fakeClient([connectionReset, spawnError("EAGAIN")]);
      await expect(getViewer(client)).rejects.toBeInstanceOf(SpawnError);
    });

    test("retries a GraphQL query that reads review threads", async () => {
      const { client, calls } = fakeClient([
        connectionReset,
        ghApiOk(reviewThreadsGraphqlPayload([])),
      ]);
      await listReviewThreads(client, "acme", "widgets", 7);
      expect(calls.length).toBe(2);
    });

    test("does not resend the resolveReviewThread mutation", async () => {
      const { client, calls } = fakeClient([connectionReset, ok("")]);
      await rejectionOf(resolveReviewThread(client, "PRRT_1"));
      expect(calls.length).toBe(1);
    });

    test("does not retry a GET whose process timed out", async () => {
      const { client, calls } = fakeClient([timeout(), viewerOk]);
      await rejectionOf(getViewer(client));
      expect(calls.length).toBe(1);
    });
  });

  describe("HTTP error responses", () => {
    const serverError = ok(ghApiStdout(500, { message: "boom" }));
    const createArgs = { title: "t", body: "b" };

    test("succeeds on the retry of a GET after a 500", async () => {
      const { client } = fakeClient([serverError, viewerOk]);
      const viewer = await getViewer(client);
      expect(viewer.login).toBe("factory-bot");
    });

    test("waits the injected delay once before retrying a GET after a 500", async () => {
      const sleeps: number[] = [];
      const { client } = fakeClient([serverError, viewerOk], sleeps, 250);
      await getViewer(client);
      expect(sleeps).toEqual([250]);
    });

    test("retries a GET after a 599", async () => {
      const { client, calls } = fakeClient([
        ok(ghApiStdout(599, { message: "edge" })),
        viewerOk,
      ]);
      await getViewer(client);
      expect(calls.length).toBe(2);
    });

    test("reports the second 5xx when the retry fails too", async () => {
      const { client } = fakeClient([
        serverError,
        ok(ghApiStdout(502, { message: "bad gateway" })),
      ]);
      await expect(getViewer(client)).rejects.toThrow(/HTTP 502/);
    });

    test("does not send a third request after two 5xx responses", async () => {
      const { client, calls } = fakeClient([
        serverError,
        serverError,
        viewerOk,
      ]);
      await rejectionOf(getViewer(client));
      expect(calls.length).toBe(2);
    });

    test("retries a GraphQL query that reads review threads after a 502", async () => {
      const { client, calls } = fakeClient([
        ok(ghApiStdout(502, { message: "bad gateway" })),
        ghApiOk(reviewThreadsGraphqlPayload([])),
      ]);
      await listReviewThreads(client, "acme", "widgets", 7);
      expect(calls.length).toBe(2);
    });

    test("does not resend the resolveReviewThread mutation after a 500", async () => {
      const { client, calls } = fakeClient([serverError, ok("")]);
      await rejectionOf(resolveReviewThread(client, "PRRT_1"));
      expect(calls.length).toBe(1);
    });

    test("does not retry a POST after a 500", async () => {
      const { client, calls } = fakeClient([serverError, issueCreated]);
      await rejectionOf(createIssue(client, "acme", "widgets", createArgs));
      expect(calls.length).toBe(1);
    });

    test("does not retry a DELETE after a 500", async () => {
      const { client, calls } = fakeClient([serverError, ok("")]);
      await rejectionOf(removeLabel(client, "acme", "widgets", 7, "bug"));
      expect(calls.length).toBe(1);
    });

    test("does not retry a PATCH after a 500", async () => {
      const { client, calls } = fakeClient([serverError, ok("")]);
      await rejectionOf(
        updatePullRequest(client, "acme", "widgets", 7, { title: "t" }),
      );
      expect(calls.length).toBe(1);
    });

    test("does not retry a 404", async () => {
      const { client, calls } = fakeClient([
        ok(ghApiStdout(404, { message: "Not Found" })),
        viewerOk,
      ]);
      await rejectionOf(getViewer(client));
      expect(calls.length).toBe(1);
    });

    test("does not wait before reporting a 500 for a POST", async () => {
      const sleeps: number[] = [];
      const { client } = fakeClient([serverError], sleeps);
      await rejectionOf(createIssue(client, "acme", "widgets", createArgs));
      expect(sleeps).toEqual([]);
    });
  });

  describe("together with the rate limit retry", () => {
    const limited = ok(
      ghApiStdout(403, { message: "secondary" }, { "retry-after": "30" }),
    );

    test("keeps the rate limit wait and adds no transient wait", async () => {
      const sleeps: number[] = [];
      const { client } = fakeClient([limited, viewerOk], sleeps);
      await getViewer(client);
      expect(sleeps).toEqual([30_000]);
    });

    test("retries a transient failure after the rate limit wait", async () => {
      const sleeps: number[] = [];
      const { client } = fakeClient(
        [limited, spawnError("EAGAIN"), viewerOk],
        sleeps,
        250,
      );
      await getViewer(client);
      expect(sleeps).toEqual([30_000, 250]);
    });
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

describe("fetchIssueState", () => {
  function fakeFetch(status: number, body: unknown) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return { status, json: async () => body };
    };
    return { fetchFn, calls };
  }

  test("returns the state of the issue", async () => {
    const { fetchFn } = fakeFetch(200, { state: "closed" });
    expect(await fetchIssueState(fetchFn, "tok", "acme", "widgets", 5)).toBe(
      "closed",
    );
  });

  test("reads the issues endpoint", async () => {
    const { fetchFn, calls } = fakeFetch(200, { state: "open" });
    await fetchIssueState(fetchFn, "tok", "acme", "widgets", 5);
    expect(calls[0]?.url).toBe(
      "https://api.github.com/repos/acme/widgets/issues/5",
    );
  });

  test("sends the token in the authorization header", async () => {
    const { fetchFn, calls } = fakeFetch(200, { state: "open" });
    await fetchIssueState(fetchFn, "tok", "acme", "widgets", 5);
    expect(calls[0]?.init.headers).toMatchObject({
      Authorization: "Bearer tok",
    });
  });

  test("throws an http error carrying the status", async () => {
    const { fetchFn } = fakeFetch(404, { message: "Not Found" });
    const error = await fetchIssueState(
      fetchFn,
      "tok",
      "acme",
      "widgets",
      5,
    ).catch((err: unknown) => err);
    expect(error instanceof GitHubHttpError && error.status).toBe(404);
  });

  test("does not follow redirects", async () => {
    const { fetchFn, calls } = fakeFetch(200, { state: "open" });
    await fetchIssueState(fetchFn, "tok", "acme", "widgets", 5);
    expect(calls[0]?.init.redirect).toBe("manual");
  });

  test("treats a redirect as a failed check", async () => {
    const { fetchFn } = fakeFetch(301, {});
    const error = await fetchIssueState(
      fetchFn,
      "tok",
      "acme",
      "widgets",
      5,
    ).catch((err: unknown) => err);
    expect(error instanceof GitHubHttpError && error.status).toBe(301);
  });

  test("does not put the token in the error message", async () => {
    const { fetchFn } = fakeFetch(500, {});
    const error = await fetchIssueState(
      fetchFn,
      "secret-token",
      "acme",
      "widgets",
      5,
    ).catch((err: unknown) => err);
    expect(String(error)).not.toContain("secret-token");
  });

  test("rejects a response without a state", async () => {
    const { fetchFn } = fakeFetch(200, { title: "x" });
    await expect(
      fetchIssueState(fetchFn, "tok", "acme", "widgets", 5),
    ).rejects.toThrow("unexpected response shape");
  });

  test("rejects an owner that isn't a valid GitHub name", async () => {
    const { fetchFn } = fakeFetch(200, { state: "open" });
    await expect(
      fetchIssueState(fetchFn, "tok", "../etc", "widgets", 5),
    ).rejects.toThrow();
  });
});

describe("fetchIssueContent", () => {
  function fakeFetch(status: number, body: unknown) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return { status, json: async () => body };
    };
    return { fetchFn, calls };
  }
  const issue = { title: "Add feature", body: "Original body", state: "open" };

  test("returns the title and body", async () => {
    const { fetchFn } = fakeFetch(200, issue);
    expect(
      await fetchIssueContent(fetchFn, "tok", "acme", "widgets", 5),
    ).toEqual({
      title: "Add feature",
      body: "Original body",
    });
  });

  test("treats a null body as empty", async () => {
    const { fetchFn } = fakeFetch(200, { ...issue, body: null });
    expect(
      (await fetchIssueContent(fetchFn, "tok", "acme", "widgets", 5)).body,
    ).toBe("");
  });

  test("reads the issues endpoint on api.github.com", async () => {
    const { fetchFn, calls } = fakeFetch(200, issue);
    await fetchIssueContent(fetchFn, "tok", "acme", "widgets", 5);
    expect(calls[0]?.url).toBe(
      "https://api.github.com/repos/acme/widgets/issues/5",
    );
  });

  test("sends the token in the authorization header", async () => {
    const { fetchFn, calls } = fakeFetch(200, issue);
    await fetchIssueContent(fetchFn, "tok", "acme", "widgets", 5);
    expect(calls[0]?.init.headers).toMatchObject({
      Authorization: "Bearer tok",
    });
  });

  test("does not follow redirects", async () => {
    const { fetchFn, calls } = fakeFetch(200, issue);
    await fetchIssueContent(fetchFn, "tok", "acme", "widgets", 5);
    expect(calls[0]?.init.redirect).toBe("manual");
  });

  test("passes a deadline signal", async () => {
    const { fetchFn, calls } = fakeFetch(200, issue);
    await fetchIssueContent(fetchFn, "tok", "acme", "widgets", 5);
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  test.each([301, 404, 500])("throws an http error for %d", async (status) => {
    const { fetchFn } = fakeFetch(status, {});
    const error = await fetchIssueContent(
      fetchFn,
      "tok",
      "acme",
      "widgets",
      5,
    ).catch((err: unknown) => err);
    expect(error instanceof GitHubHttpError && error.status).toBe(status);
  });

  test("does not put the token or the issue text in the error message", async () => {
    const { fetchFn } = fakeFetch(500, { title: "secret title" });
    const error = await fetchIssueContent(
      fetchFn,
      "secret-token",
      "acme",
      "widgets",
      5,
    ).catch((err: unknown) => String(err));
    expect(error).not.toMatch(/secret-token|secret title/);
  });

  test("rejects a response whose title is not a string", async () => {
    const { fetchFn } = fakeFetch(200, { ...issue, title: 1 });
    await expect(
      fetchIssueContent(fetchFn, "tok", "acme", "widgets", 5),
    ).rejects.toThrow("unexpected response shape");
  });

  test("rejects a response whose body is not a string or null", async () => {
    const { fetchFn } = fakeFetch(200, { ...issue, body: 1 });
    await expect(
      fetchIssueContent(fetchFn, "tok", "acme", "widgets", 5),
    ).rejects.toThrow("unexpected response shape");
  });

  test("rejects an owner that isn't a valid GitHub name", async () => {
    const { fetchFn } = fakeFetch(200, issue);
    await expect(
      fetchIssueContent(fetchFn, "tok", "../etc", "widgets", 5),
    ).rejects.toThrow();
  });
});

describe("getIssue closing fields", () => {
  const closedIssue = {
    number: 5,
    title: "t",
    body: "b",
    html_url: "https://github.com/acme/widgets/issues/5",
    state: "closed",
    user: { login: "alice" },
    author_association: "CONTRIBUTOR",
    closed_by: { login: "maintainer", type: "User" },
    labels: [],
    assignees: [],
  };
  const read = (payload: unknown) =>
    getIssue(
      { run: createFakeCommandRunner([ghApiOk(payload)]).run, ghToken: "tok" },
      "acme",
      "widgets",
      5,
    );

  test("reads who closed the issue", async () => {
    expect((await read(closedIssue)).closedByLogin).toBe("maintainer");
  });

  test("reads the association of the author", async () => {
    expect((await read(closedIssue)).authorAssociation).toBe("CONTRIBUTOR");
  });

  test("reads the closer of a merged pull request", async () => {
    const merged = {
      ...closedIssue,
      pull_request: { merged_at: "2026-10-01T00:00:00Z" },
      closed_by: { login: "maintainer" },
    };
    expect((await read(merged)).closedByLogin).toBe("maintainer");
  });

  test("reads the type of the closer", async () => {
    expect((await read(closedIssue)).closedByType).toBe("User");
  });

  test("reads a bot closer", async () => {
    const bot = {
      ...closedIssue,
      closed_by: { login: "github-actions[bot]", type: "Bot" },
    };
    expect((await read(bot)).closedByType).toBe("Bot");
  });

  test("reads the merge time of a merged pull request", async () => {
    const merged = {
      ...closedIssue,
      pull_request: { merged_at: "2026-10-01T00:00:00Z" },
      closed_by: null,
    };
    expect((await read(merged)).mergedAt).toBe("2026-10-01T00:00:00Z");
  });

  test("reads a pull request closed without merging as not merged", async () => {
    const closed = { ...closedIssue, pull_request: { merged_at: null } };
    expect((await read(closed)).mergedAt).toBeNull();
  });

  test("reads an issue as not merged", async () => {
    expect((await read(closedIssue)).mergedAt).toBeNull();
  });

  test("reads an empty closed_by login as no closer", async () => {
    const empty = { ...closedIssue, closed_by: { login: "", type: "User" } };
    expect((await read(empty)).closedByLogin).toBeNull();
  });

  test("accepts a null user", async () => {
    expect((await read({ ...closedIssue, user: null })).authorLogin).toBe("");
  });

  test("rejects a response without a user", async () => {
    const { user: _omitted, ...withoutUser } = closedIssue;
    await expect(read(withoutUser)).rejects.toThrow(
      "unexpected response shape",
    );
  });

  test("rejects a user of the wrong shape", async () => {
    await expect(read({ ...closedIssue, user: "alice" })).rejects.toThrow(
      "unexpected response shape",
    );
  });

  test("reads a null closed_by as no closer", async () => {
    expect(
      (await read({ ...closedIssue, closed_by: null })).closedByLogin,
    ).toBeNull();
  });

  test("reads a missing closed_by as no closer", async () => {
    const { closed_by: _omitted, ...withoutCloser } = closedIssue;
    expect((await read(withoutCloser)).closedByLogin).toBeNull();
  });

  test("ignores a closed_by that is not a user object", async () => {
    expect(
      (await read({ ...closedIssue, closed_by: "maintainer" })).closedByLogin,
    ).toBeNull();
  });

  test("reads a missing association as null", async () => {
    const { author_association: _omitted, ...without } = closedIssue;
    expect((await read(without)).authorAssociation).toBeNull();
  });
});

describe("getLabelerLogin", () => {
  const at = (n: number) => `2026-10-01T00:00:${String(n).padStart(2, "0")}Z`;
  const labeled = (login: string | null, label: string, n = 1) =>
    labelEventNode("labeled", login, label, at(n));
  const unlabeled = (login: string, label: string, n = 2) =>
    labelEventNode("unlabeled", login, label, at(n));

  async function loginOf(responses: readonly CommandResult[], label: string) {
    const fake = createFakeCommandRunner(responses);
    return {
      fake,
      login: await getLabelerLogin(
        { run: fake.run, ghToken: "tok" },
        "acme",
        "widgets",
        5,
        label,
      ),
    };
  }

  test("reads the label events through GraphQL", async () => {
    const { fake } = await loginOf([labelEventsOk([])], "factory");
    expect(fake.calls[0]?.argv).toContain("graphql");
  });

  async function sentQuery(): Promise<string> {
    const { fake } = await loginOf([labelEventsOk([])], "factory");
    const stdin = fake.calls[0]?.options?.stdin;
    const body: unknown = JSON.parse(stdin ?? "{}");
    return isRecord(body) && typeof body.query === "string" ? body.query : "";
  }

  test("asks only for labeled and unlabeled events", async () => {
    expect(await sentQuery()).toContain(
      "itemTypes: [LABELED_EVENT, UNLABELED_EVENT]",
    );
  });

  test("asks for the latest hundred label events", async () => {
    expect(await sentQuery()).toContain("timelineItems(last: 100");
  });

  test("returns the actor of the last labeled event for the label", async () => {
    const { login } = await loginOf(
      [
        labelEventsOk([
          labeled("alice", "factory", 1),
          labeled("carol", "factory", 3),
        ]),
      ],
      "factory",
    );
    expect(login).toBe("carol");
  });

  test("picks the last event by createdAt, not by array order", async () => {
    const { login } = await loginOf(
      [
        labelEventsOk([
          labeled("carol", "factory", 3),
          labeled("mallory", "factory", 1),
        ]),
      ],
      "factory",
    );
    expect(login).toBe("carol");
  });

  /** 同じ秒のイベント。`id`の辞書順では、`labeled`が`unlabeled`より後になる。 */
  const sameSecondLabeled = {
    ...labeled("alice", "factory", 5),
    id: "LE_z",
  };
  const sameSecondUnlabeled = {
    ...unlabeled("alice", "factory", 5),
    id: "UNLE_a",
  };

  test("returns null when events share the latest second, earlier one first", async () => {
    const { login } = await loginOf(
      [labelEventsOk([sameSecondUnlabeled, sameSecondLabeled])],
      "factory",
    );
    expect(login).toBeNull();
  });

  test("returns null when events share the latest second, later one first", async () => {
    const { login } = await loginOf(
      [labelEventsOk([sameSecondLabeled, sameSecondUnlabeled])],
      "factory",
    );
    expect(login).toBeNull();
  });

  test("returns null when two users labeled in the latest second", async () => {
    const { login } = await loginOf(
      [
        labelEventsOk([
          labeled("alice", "factory", 5),
          labeled("mallory", "factory", 5),
        ]),
      ],
      "factory",
    );
    expect(login).toBeNull();
  });

  test("decides by the latest second even when an earlier second has two events", async () => {
    const { login } = await loginOf(
      [
        labelEventsOk([
          labeled("mallory", "factory", 1),
          labeled("bob", "factory", 1),
          labeled("alice", "factory", 2),
        ]),
      ],
      "factory",
    );
    expect(login).toBe("alice");
  });

  test("ignores the labeled events of other labels", async () => {
    const { login } = await loginOf(
      [
        labelEventsOk([
          labeled("alice", "factory", 1),
          labeled("mallory", "documentation", 2),
        ]),
      ],
      "factory",
    );
    expect(login).toBe("alice");
  });

  test("returns the re-added label's actor after an unlabeled event", async () => {
    const { login } = await loginOf(
      [
        labelEventsOk([
          labeled("alice", "factory", 1),
          unlabeled("alice", "factory", 2),
          labeled("mallory", "factory", 3),
        ]),
      ],
      "factory",
    );
    expect(login).toBe("mallory");
  });

  test("returns null when the label's last event is unlabeled", async () => {
    const { login } = await loginOf(
      [
        labelEventsOk([
          labeled("alice", "factory", 1),
          unlabeled("alice", "factory", 2),
        ]),
      ],
      "factory",
    );
    expect(login).toBeNull();
  });

  test("ignores an unlabeled event of another label", async () => {
    const { login } = await loginOf(
      [
        labelEventsOk([
          labeled("alice", "factory", 1),
          unlabeled("alice", "documentation", 2),
        ]),
      ],
      "factory",
    );
    expect(login).toBe("alice");
  });

  test("matches the label name case-insensitively", async () => {
    const { login } = await loginOf(
      [labelEventsOk([labeled("alice", "Factory")])],
      "factory",
    );
    expect(login).toBe("alice");
  });

  test("returns null when the labeled event has no actor", async () => {
    const { login } = await loginOf(
      [
        labelEventsOk([
          labeled("alice", "factory", 1),
          labeled(null, "factory", 2),
        ]),
      ],
      "factory",
    );
    expect(login).toBeNull();
  });

  test("returns null when the actor is not a user", async () => {
    const bot = labelEventNode("labeled", "alice", "factory", at(1), "Bot");
    const { login } = await loginOf([labelEventsOk([bot])], "factory");
    expect(login).toBeNull();
  });

  test("returns null when no event labeled the label and nothing older remains", async () => {
    const { login } = await loginOf(
      [labelEventsOk([labeled("alice", "documentation")])],
      "factory",
    );
    expect(login).toBeNull();
  });

  test("throws LabelerCheckLimitError when older events remain and none labeled the label", async () => {
    const result = loginOf(
      [labelEventsOk([labeled("alice", "documentation")], true)],
      "factory",
    );
    await expect(result).rejects.toThrow(LabelerCheckLimitError);
  });

  test("names the label in the LabelerCheckLimitError", async () => {
    const error = await loginOf([labelEventsOk([], true)], "factory").catch(
      (err: unknown) => err,
    );
    expect(error instanceof LabelerCheckLimitError && error.label).toBe(
      "factory",
    );
  });

  test("decides from the window when older events remain but the label is in it", async () => {
    const { login } = await loginOf(
      [labelEventsOk([labeled("alice", "factory")], true)],
      "factory",
    );
    expect(login).toBe("alice");
  });

  test("retries a 5xx response once", async () => {
    const { login } = await loginOf(
      [
        ok(ghApiStdout(502, { message: "bad gateway" })),
        labelEventsOk([labeled("alice", "factory")]),
      ],
      "factory",
    );
    expect(login).toBe("alice");
  });

  test("throws when the issue or pull request does not exist", async () => {
    const result = loginOf(
      [
        ghApiOk({
          data: { repository: { issueOrPullRequest: null } },
          errors: [{ type: "NOT_FOUND", message: "Could not resolve" }],
        }),
      ],
      "factory",
    );
    await expect(result).rejects.toThrow("GraphQL error");
  });

  test("throws on a response of an unexpected shape", async () => {
    const result = loginOf(
      [ghApiOk({ data: { repository: null } })],
      "factory",
    );
    await expect(result).rejects.toThrow("unexpected response shape");
  });

  test("throws on a label event without createdAt instead of skipping it", async () => {
    const { createdAt: _createdAt, ...broken } = labeled(
      "mallory",
      "factory",
      3,
    );
    const result = loginOf(
      [labelEventsOk([labeled("alice", "factory", 1), broken])],
      "factory",
    );
    await expect(result).rejects.toThrow("unexpected response shape");
  });

  test("throws on a label event without a label instead of skipping it", async () => {
    const result = loginOf(
      [
        labelEventsOk([
          labeled("alice", "factory", 1),
          { ...labeled("mallory", "factory", 3), label: null },
        ]),
      ],
      "factory",
    );
    await expect(result).rejects.toThrow("unexpected response shape");
  });

  test("skips null nodes", async () => {
    const { login } = await loginOf(
      [labelEventsOk([null, labeled("alice", "factory", 1)])],
      "factory",
    );
    expect(login).toBe("alice");
  });

  test("skips nodes of other kinds", async () => {
    const { login } = await loginOf(
      [
        labelEventsOk([
          { __typename: "IssueComment", body: "hi" },
          labeled("alice", "factory", 1),
        ]),
      ],
      "factory",
    );
    expect(login).toBe("alice");
  });

  test("rejects when the request fails", async () => {
    const fake = createFakeCommandRunner([
      ok(ghApiStdout(400, { message: "bad" })),
    ]);
    await expect(
      getLabelerLogin(
        { run: fake.run, ghToken: "tok" },
        "acme",
        "widgets",
        5,
        "factory",
      ),
    ).rejects.toThrow();
  });
});

describe("claimIssue", () => {
  const OPTS = { triggerLabel: "factory", assignee: "factory-bot" };
  const RETRY_LOG = "claim deferred: trigger label is still present";
  const UNKNOWN_LOG = "claim ownership could not be determined";
  const ATTEMPT_LOG = "claim re-read attempt failed";
  /** 冪等な読み取りの5xxを1回再送する前の待機。試行の間の待機と見分けるため、他と異なる値にする。 */
  const TRANSIENT_DELAY_MS = 5;

  function setup(responses: readonly CommandResult[]) {
    const fake = createFakeCommandRunner(responses);
    const sleeps: number[] = [];
    const warns: string[] = [];
    const log: Logger = {
      info() {},
      warn(message) {
        warns.push(message);
      },
      error() {},
    };
    const client: GhClient = {
      run: fake.run,
      ghToken: "tok",
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      transientRetryDelayMs: TRANSIENT_DELAY_MS,
    };
    return { fake, client, sleeps, warns, opts: { ...OPTS, log } };
  }

  function issueBody(labels: string[], assignees: string[]) {
    return {
      number: 5,
      title: "t",
      body: "b",
      html_url: "https://x/5",
      state: "open",
      user: { login: "alice" },
      labels,
      assignees: assignees.map((login) => ({ login })),
    };
  }

  function unlabeled(actor: string, label = "factory") {
    return {
      event: "unlabeled",
      actor: { login: actor },
      label: { name: label },
      created_at: "2026-10-09T00:00:00Z",
    };
  }

  function labeled(actor: string, label = "factory") {
    return {
      event: "labeled",
      actor: { login: actor },
      label: { name: label },
      created_at: "2026-10-09T00:00:00Z",
    };
  }

  const assigned = ok(ghApiStdout(200, {})); // POST: 担当者を追加する
  const deleted = ok(ghApiStdout(200, {})); // DELETE: トリガーラベルを外す
  const labelGone = ok(ghApiStdout(404, { message: "Not Found" }));
  const forbidden = ok(ghApiStdout(403, { message: "forbidden" }));
  const serverError = ok(ghApiStdout(500, { message: "boom" }));
  const noResponse = ok("");
  const rateLimited = ok(
    ghApiStdout(403, { message: "rate limited" }, { "retry-after": "1" }),
  );

  describe("when the removal succeeds", () => {
    test("succeeds with the assignee confirmed when the re-fetched issue is assigned", async () => {
      const { client, opts } = setup([
        assigned,
        deleted,
        ghApiOk(issueBody([], ["factory-bot"])),
      ]);
      const result = await claimIssue(client, "acme", "widgets", 5, opts);
      expect(result).toEqual({ claimed: true, assignee: "confirmed" });
    });

    test("still claims when the assignment did not stick, reporting the assignee as missing", async () => {
      const { client, opts } = setup([
        assigned,
        deleted,
        ghApiOk(issueBody([], [])),
      ]);
      const result = await claimIssue(client, "acme", "widgets", 5, opts);
      expect(result).toEqual({ claimed: true, assignee: "missing" });
    });

    test("still claims when the trigger label was re-added by another actor after our removal", async () => {
      const { client, opts } = setup([
        assigned,
        deleted,
        ghApiOk(issueBody(["factory"], ["factory-bot"])),
      ]);
      const result = await claimIssue(client, "acme", "widgets", 5, opts);
      expect(result).toEqual({ claimed: true, assignee: "confirmed" });
    });

    test("still claims when the confirmation read fails, reporting the assignee as unknown", async () => {
      const { client, opts } = setup([assigned, deleted, serverError]);
      const result = await claimIssue(client, "acme", "widgets", 5, opts);
      expect(result).toEqual({ claimed: true, assignee: "unknown" });
    });
  });

  describe("when the label was already gone (404)", () => {
    test("reports a lost race", async () => {
      const { client, opts } = setup([assigned, labelGone]);
      const result = await claimIssue(client, "acme", "widgets", 5, opts);
      expect(result).toEqual({
        claimed: false,
        outcome: "lost",
        reason: "trigger label factory was already removed",
      });
    });

    test("does not read the issue again", async () => {
      const { fake, client, opts } = setup([assigned, labelGone]);
      await claimIssue(client, "acme", "widgets", 5, opts);
      expect(fake.calls).toHaveLength(2);
    });
  });

  describe("when the removal is undetermined and the label is still present", () => {
    const labelPresent = () => ghApiOk(issueBody(["factory"], ["factory-bot"]));
    const retryResult: ClaimIssueResult = {
      claimed: false,
      outcome: "retry",
      reason:
        "trigger label factory removal failed and the label is still present",
    };

    test("asks to retry later after a server error", async () => {
      const { client, opts } = setup([assigned, serverError, labelPresent()]);
      const result = await claimIssue(client, "acme", "widgets", 5, opts);
      expect(result).toEqual(retryResult);
    });

    test("asks to retry later when the remaining label differs only in case", async () => {
      const { client, opts } = setup([
        assigned,
        serverError,
        ghApiOk(issueBody(["Factory"], ["factory-bot"])),
      ]);
      const result = await claimIssue(client, "acme", "widgets", 5, opts);
      expect(result).toEqual(retryResult);
    });

    test("asks to retry later after a response-less failure (HTTP 0)", async () => {
      const { client, opts } = setup([assigned, noResponse, labelPresent()]);
      const result = await claimIssue(client, "acme", "widgets", 5, opts);
      expect(result).toEqual(retryResult);
    });

    test("asks to retry later when a later re-read attempt succeeds", async () => {
      const { client, opts } = setup([
        assigned,
        serverError,
        serverError,
        serverError,
        labelPresent(),
      ]);
      const result = await claimIssue(client, "acme", "widgets", 5, opts);
      expect(result).toEqual(retryResult);
    });

    test("waits one second before the second re-read attempt", async () => {
      const { client, sleeps, opts } = setup([
        assigned,
        serverError,
        serverError,
        serverError,
        labelPresent(),
      ]);
      await claimIssue(client, "acme", "widgets", 5, opts);
      expect(sleeps).toEqual([TRANSIENT_DELAY_MS, 1000]);
    });

    test("logs a warning that the claim is deferred", async () => {
      const { client, warns, opts } = setup([
        assigned,
        serverError,
        labelPresent(),
      ]);
      await claimIssue(client, "acme", "widgets", 5, opts);
      expect(warns).toContain(RETRY_LOG);
    });
  });

  describe("when the removal is undetermined and the label is gone", () => {
    const labelAbsent = (assignees: string[] = ["factory-bot"]) =>
      ghApiOk(issueBody([], assignees));

    test("treats the claim as ours when our login removed the label last", async () => {
      const { client, opts } = setup([
        assigned,
        serverError,
        labelAbsent(),
        ghApiOk([unlabeled("someone-else"), unlabeled("factory-bot")]),
      ]);
      const result = await claimIssue(client, "acme", "widgets", 5, opts);
      expect(result).toEqual({ claimed: true, assignee: "confirmed" });
    });

    test("matches our login regardless of letter case", async () => {
      const { client, opts } = setup([
        assigned,
        serverError,
        labelAbsent(),
        ghApiOk([unlabeled("Factory-Bot")]),
      ]);
      const result = await claimIssue(client, "acme", "widgets", 5, opts);
      expect(result).toEqual({ claimed: true, assignee: "confirmed" });
    });

    test("reports the assignee as missing when our removal is confirmed but the assignee is not set", async () => {
      const { client, opts } = setup([
        assigned,
        noResponse,
        labelAbsent([]),
        ghApiOk([unlabeled("factory-bot")]),
      ]);
      const result = await claimIssue(client, "acme", "widgets", 5, opts);
      expect(result).toEqual({ claimed: true, assignee: "missing" });
    });

    test("reports a lost race when another actor removed the label last", async () => {
      const { client, opts } = setup([
        assigned,
        serverError,
        labelAbsent(),
        ghApiOk([unlabeled("factory-bot"), unlabeled("alice")]),
      ]);
      const result = await claimIssue(client, "acme", "widgets", 5, opts);
      expect(result).toEqual({
        claimed: false,
        outcome: "lost",
        reason: "trigger label factory was removed by another actor",
      });
    });

    test("ignores unlabeled events of other labels", async () => {
      const { client, opts } = setup([
        assigned,
        serverError,
        labelAbsent(),
        ghApiOk([unlabeled("factory-bot"), unlabeled("alice", "other")]),
      ]);
      const result = await claimIssue(client, "acme", "widgets", 5, opts);
      expect(result).toEqual({ claimed: true, assignee: "confirmed" });
    });

    test("throws ClaimOwnershipUnknownError when a human re-added the label after our stale removal", async () => {
      const { client, opts } = setup([
        assigned,
        serverError,
        labelAbsent(),
        ghApiOk([unlabeled("factory-bot"), labeled("alice")]),
      ]);
      const claiming = claimIssue(client, "acme", "widgets", 5, opts);
      await expect(claiming).rejects.toBeInstanceOf(ClaimOwnershipUnknownError);
    });

    test("claims when our removal comes after the latest labeling", async () => {
      const { client, opts } = setup([
        assigned,
        serverError,
        labelAbsent(),
        ghApiOk([
          unlabeled("alice"),
          labeled("alice"),
          unlabeled("factory-bot"),
        ]),
      ]);
      const result = await claimIssue(client, "acme", "widgets", 5, opts);
      expect(result).toEqual({ claimed: true, assignee: "confirmed" });
    });

    test("ignores labeled events of other labels", async () => {
      const { client, opts } = setup([
        assigned,
        serverError,
        labelAbsent(),
        ghApiOk([unlabeled("factory-bot"), labeled("alice", "other")]),
      ]);
      const result = await claimIssue(client, "acme", "widgets", 5, opts);
      expect(result).toEqual({ claimed: true, assignee: "confirmed" });
    });

    test("throws ClaimOwnershipUnknownError when a later removal has no actor", async () => {
      const { client, opts } = setup([
        assigned,
        serverError,
        labelAbsent(),
        ghApiOk([
          unlabeled("factory-bot"),
          { event: "unlabeled", label: { name: "factory" } },
        ]),
      ]);
      const claiming = claimIssue(client, "acme", "widgets", 5, opts);
      await expect(claiming).rejects.toBeInstanceOf(ClaimOwnershipUnknownError);
    });

    test("uses the decisive event on the last page of the timeline", async () => {
      const { client, opts } = setup([
        assigned,
        serverError,
        labelAbsent(),
        ok(
          ghApiStdout(200, [unlabeled("alice")], {
            link: '<https://api.github.com/repos/acme/widgets/issues/5/timeline?page=2>; rel="next"',
          }),
        ),
        ghApiOk([unlabeled("factory-bot")]),
      ]);
      const result = await claimIssue(client, "acme", "widgets", 5, opts);
      expect(result).toEqual({ claimed: true, assignee: "confirmed" });
    });

    function timelinePage(n: number, hasNext: boolean) {
      const link = `<https://api.github.com/repos/acme/widgets/issues/5/timeline?page=${String(n + 1)}>; rel="next"`;
      return ok(
        ghApiStdout(
          200,
          [unlabeled(n === 20 && !hasNext ? "factory-bot" : "alice")],
          hasNext ? { link } : {},
        ),
      );
    }

    test("reads up to twenty timeline pages", async () => {
      const pages = Array.from({ length: 20 }, (_, i) =>
        timelinePage(i + 1, i + 1 < 20),
      );
      const { client, opts } = setup([
        assigned,
        serverError,
        labelAbsent(),
        ...pages,
      ]);
      const result = await claimIssue(client, "acme", "widgets", 5, opts);
      expect(result).toEqual({ claimed: true, assignee: "confirmed" });
    });

    test("throws ClaimOwnershipUnknownError when the timeline has more than twenty pages", async () => {
      const pages = Array.from({ length: 20 }, (_, i) =>
        timelinePage(i + 1, true),
      );
      const { client, opts } = setup([
        assigned,
        serverError,
        labelAbsent(),
        ...pages,
      ]);
      const claiming = claimIssue(client, "acme", "widgets", 5, opts);
      await expect(claiming).rejects.toBeInstanceOf(ClaimOwnershipUnknownError);
    });

    test("stops reading at the twenty-page cap without retrying", async () => {
      const pages = Array.from({ length: 20 }, (_, i) =>
        timelinePage(i + 1, true),
      );
      const { fake, client, opts } = setup([
        assigned,
        serverError,
        labelAbsent(),
        ...pages,
      ]);
      await claimIssue(client, "acme", "widgets", 5, opts).catch(
        () => undefined,
      );
      expect(fake.calls).toHaveLength(23);
    });

    test("retries the timeline read before giving up on it", async () => {
      const { client, opts } = setup([
        assigned,
        serverError,
        labelAbsent(),
        serverError,
        ghApiOk([unlabeled("factory-bot")]),
      ]);
      const result = await claimIssue(client, "acme", "widgets", 5, opts);
      expect(result).toEqual({ claimed: true, assignee: "confirmed" });
    });

    test("throws ClaimOwnershipUnknownError when the timeline has no matching event", async () => {
      const { client, opts } = setup([
        assigned,
        serverError,
        labelAbsent(),
        ghApiOk([unlabeled("factory-bot", "other")]),
      ]);
      const claiming = claimIssue(client, "acme", "widgets", 5, opts);
      await expect(claiming).rejects.toBeInstanceOf(ClaimOwnershipUnknownError);
    });

    test("throws ClaimOwnershipUnknownError when every timeline read fails", async () => {
      const { client, opts } = setup([
        assigned,
        serverError,
        labelAbsent(),
        serverError,
        serverError,
        serverError,
      ]);
      const claiming = claimIssue(client, "acme", "widgets", 5, opts);
      await expect(claiming).rejects.toBeInstanceOf(ClaimOwnershipUnknownError);
    });
  });

  describe("when every re-read fails", () => {
    test("makes exactly three re-read attempts, each sending the read twice", async () => {
      const { fake, client, opts } = setup([
        assigned,
        serverError,
        ...Array(6).fill(serverError),
      ]);
      await claimIssue(client, "acme", "widgets", 5, opts).catch(
        () => undefined,
      );
      expect(fake.calls).toHaveLength(8);
    });

    test("rejects with ClaimOwnershipUnknownError", async () => {
      const { client, opts } = setup([
        assigned,
        noResponse,
        serverError,
        serverError,
        serverError,
      ]);
      const claiming = claimIssue(client, "acme", "widgets", 5, opts);
      await expect(claiming).rejects.toBeInstanceOf(ClaimOwnershipUnknownError);
    });

    test("backs off one and two seconds between the attempts", async () => {
      const { client, sleeps, opts } = setup([
        assigned,
        serverError,
        ...Array(6).fill(serverError),
      ]);
      await claimIssue(client, "acme", "widgets", 5, opts).catch(
        () => undefined,
      );
      expect(sleeps.filter((ms) => ms !== TRANSIENT_DELAY_MS)).toEqual([
        1000, 2000,
      ]);
    });

    test("keeps the removal failure in the error message", async () => {
      const { client, opts } = setup([
        assigned,
        serverError,
        serverError,
        serverError,
        serverError,
      ]);
      const claiming = claimIssue(client, "acme", "widgets", 5, opts);
      await expect(claiming).rejects.toThrow(/DELETE issue label.*HTTP 500/);
    });

    test("logs a warning that the ownership is unknown", async () => {
      const { client, warns, opts } = setup([
        assigned,
        serverError,
        serverError,
        serverError,
        serverError,
      ]);
      await claimIssue(client, "acme", "widgets", 5, opts).catch(
        () => undefined,
      );
      expect(warns).toContain(UNKNOWN_LOG);
    });

    test("makes a single issue re-read attempt when it is rate limited", async () => {
      const { fake, client, opts } = setup([
        assigned,
        serverError,
        rateLimited,
        rateLimited,
      ]);
      await claimIssue(client, "acme", "widgets", 5, opts).catch(
        () => undefined,
      );
      expect(fake.calls).toHaveLength(4);
    });

    test("does not back off after a rate limited issue re-read", async () => {
      const { client, sleeps, opts } = setup([
        assigned,
        serverError,
        rateLimited,
        rateLimited,
      ]);
      await claimIssue(client, "acme", "widgets", 5, opts).catch(
        () => undefined,
      );
      expect(sleeps).toEqual([1000]); // callGhApi自身のレート制限の待機だけ
    });

    test("throws ClaimOwnershipUnknownError when the issue re-read is rate limited", async () => {
      const { client, opts } = setup([
        assigned,
        serverError,
        rateLimited,
        rateLimited,
      ]);
      const claiming = claimIssue(client, "acme", "widgets", 5, opts);
      await expect(claiming).rejects.toBeInstanceOf(ClaimOwnershipUnknownError);
    });

    test("makes a single timeline read attempt when it is rate limited", async () => {
      const { fake, client, opts } = setup([
        assigned,
        serverError,
        ghApiOk(issueBody([], ["factory-bot"])),
        rateLimited,
        rateLimited,
      ]);
      await claimIssue(client, "acme", "widgets", 5, opts).catch(
        () => undefined,
      );
      expect(fake.calls).toHaveLength(5);
    });

    test("throws ClaimOwnershipUnknownError when the timeline read is rate limited", async () => {
      const { client, opts } = setup([
        assigned,
        serverError,
        ghApiOk(issueBody([], ["factory-bot"])),
        rateLimited,
        rateLimited,
      ]);
      const claiming = claimIssue(client, "acme", "widgets", 5, opts);
      await expect(claiming).rejects.toBeInstanceOf(ClaimOwnershipUnknownError);
    });

    test("logs a warning for each failed issue re-read attempt", async () => {
      const { client, warns, opts } = setup([
        assigned,
        serverError,
        serverError,
        serverError,
        serverError,
      ]);
      await claimIssue(client, "acme", "widgets", 5, opts).catch(
        () => undefined,
      );
      expect(warns.filter((w) => w === ATTEMPT_LOG)).toHaveLength(3);
    });

    test("logs a warning for each failed timeline read attempt", async () => {
      const { client, warns, opts } = setup([
        assigned,
        serverError,
        ghApiOk(issueBody([], ["factory-bot"])),
        serverError,
        serverError,
        serverError,
      ]);
      await claimIssue(client, "acme", "widgets", 5, opts).catch(
        () => undefined,
      );
      expect(warns.filter((w) => w === ATTEMPT_LOG)).toHaveLength(3);
    });
  });

  describe("when the failure is definitive", () => {
    test("rethrows a client error from the removal as GitHubHttpError", async () => {
      const { client, opts } = setup([assigned, forbidden]);
      const claiming = claimIssue(client, "acme", "widgets", 5, opts);
      await expect(claiming).rejects.toBeInstanceOf(GitHubHttpError);
    });

    test("keeps the status in the rethrown client error", async () => {
      const { client, opts } = setup([assigned, forbidden]);
      const claiming = claimIssue(client, "acme", "widgets", 5, opts);
      await expect(claiming).rejects.toThrow(/HTTP 403/);
    });

    test("does not read the issue after a client error from the removal", async () => {
      const { fake, client, opts } = setup([assigned, forbidden]);
      await claimIssue(client, "acme", "widgets", 5, opts).catch(
        () => undefined,
      );
      expect(fake.calls).toHaveLength(2);
    });

    test("rethrows a rate limit on the removal as GitHubRateLimitError", async () => {
      const { client, opts } = setup([assigned, rateLimited, rateLimited]);
      const claiming = claimIssue(client, "acme", "widgets", 5, opts);
      await expect(claiming).rejects.toBeInstanceOf(GitHubRateLimitError);
    });

    test("does not read the issue after a rate limit on the removal", async () => {
      const { fake, client, opts } = setup([
        assigned,
        rateLimited,
        rateLimited,
      ]);
      await claimIssue(client, "acme", "widgets", 5, opts).catch(
        () => undefined,
      );
      expect(fake.calls).toHaveLength(3);
    });

    test("rethrows a failure of the assignment as GitHubHttpError", async () => {
      const { client, opts } = setup([serverError]);
      const claiming = claimIssue(client, "acme", "widgets", 5, opts);
      await expect(claiming).rejects.toBeInstanceOf(GitHubHttpError);
    });

    test("rejects an assignee that isn't a valid GitHub name before making any call", async () => {
      const { client } = setup([]);
      await expect(
        claimIssue(client, "acme", "widgets", 5, {
          triggerLabel: "factory",
          assignee: "-evil",
        }),
      ).rejects.toThrow();
    });
  });
});

describe("commentIssue", () => {
  test("posts a new comment with a marker when none exists yet", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk([]), // GET: 既存のコメントは無い
      ghApiOk({ id: 123 }), // POST: コメントを投稿する
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
      ghApiOk({ id: 200 }), // POST: この場合も投稿は呼ばれる
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

  test("removeLabel reports absent without throwing when the label is already gone (404)", async () => {
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
    ).resolves.toBe("absent");
  });

  test("removeLabel reports removed when the DELETE succeeds (2xx)", async () => {
    const fake = createFakeCommandRunner([ok(ghApiStdout(200, []))]);
    await expect(
      removeLabel(
        { run: fake.run, ghToken: "tok" },
        "acme",
        "widgets",
        5,
        "factory:wip",
      ),
    ).resolves.toBe("removed");
  });

  test("removeLabel throws on a server error", async () => {
    const fake = createFakeCommandRunner([
      ok(ghApiStdout(500, { message: "boom" })),
    ]);
    await expect(
      removeLabel(
        { run: fake.run, ghToken: "tok" },
        "acme",
        "widgets",
        5,
        "factory:wip",
      ),
    ).rejects.toThrow(/HTTP 500/);
  });

  test("removeLabel throws on a response-less failure (HTTP 0)", async () => {
    const fake = createFakeCommandRunner([ok("")]);
    await expect(
      removeLabel(
        { run: fake.run, ghToken: "tok" },
        "acme",
        "widgets",
        5,
        "factory:wip",
      ),
    ).rejects.toThrow(/HTTP 0/);
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

  test("does not resend after a 500 by default", async () => {
    const fake = createFakeCommandRunner([
      ok(ghApiStdout(500, { message: "boom" })),
      ok(ghApiStdout(200, [])),
    ]);
    await addLabels(
      { run: fake.run, ghToken: "tok", sleep: async () => {} },
      "acme",
      "widgets",
      5,
      ["a"],
    ).catch(() => undefined);
    expect(fake.calls).toHaveLength(1);
  });

  test("resends once after a 500 when idempotent", async () => {
    const fake = createFakeCommandRunner([
      ok(ghApiStdout(500, { message: "boom" })),
      ok(ghApiStdout(200, [])),
    ]);
    await addLabels(
      { run: fake.run, ghToken: "tok", sleep: async () => {} },
      "acme",
      "widgets",
      5,
      ["a"],
      { idempotent: true },
    );
    expect(fake.calls).toHaveLength(2);
  });

  test("resends once after a lost connection when idempotent", async () => {
    const fake = createFakeCommandRunner([ok(""), ok(ghApiStdout(200, []))]);
    await addLabels(
      { run: fake.run, ghToken: "tok", sleep: async () => {} },
      "acme",
      "widgets",
      5,
      ["a"],
      { idempotent: true },
    );
    expect(fake.calls).toHaveLength(2);
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

  // クエリは4本: レビュー依頼、担当者、レビューラベル、修正ラベル。
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

  // GitHubの`/search/issues`は括弧でまとめたORに対応しない。
  // 実際に`(review-requested:X OR assignee:X OR label:Y)`は常に0件を返し、
  // 修飾子を1つずつ指定すると一致した。
  // そのため`searchPrs`は修飾子ごとに1本ずつ問い合わせて結果をまとめる。
  // 対象はレビュー依頼、担当者、レビューラベル、修正ラベルの4つ。
  // トリガーラベルを消費済みのPRは、この検索ではなく
  // `poll_prs.ts`の`listTrackedPrs`が拾い直す。

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
    expect(fake.calls).toHaveLength(QUERY_COUNT); // 用意した応答をすべて消費した
    for (const call of fake.calls) {
      expect(call.argv.join(" ")).toContain("per_page=100");
    }
  });

  test("de-duplicates by PR id when the same PR matches more than one query", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk({ items: [prItem(1, 10)] }), // レビュー依頼
      ghApiOk({ items: [prItem(1, 10)] }), // 担当者(同じPRがもう一度一致する)
      ghApiOk({ items: [] }), // レビューラベル
      ghApiOk({ items: [] }), // 修正ラベル
    ]);
    const items = await searchPrs(
      { run: fake.run, ghToken: "tok" },
      SEARCH_PRS_OPTS,
    );
    expect(fake.calls).toHaveLength(QUERY_COUNT); // 用意した応答をすべて消費した
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
    expect(fake.calls).toHaveLength(QUERY_COUNT + 1); // 1本目のクエリの2ページ分と残りのクエリ
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

describe("listPullRequestNumbersByHead", () => {
  test("asks for open and closed pull requests", async () => {
    const fake = createFakeCommandRunner([ghApiOk([])]);
    await listPullRequestNumbersByHead(
      { run: fake.run, ghToken: "tok" },
      "acme",
      "widgets",
      "factory/issue-7-wi-3",
    );
    expect(fake.calls[0]?.argv.some((arg) => arg.includes("state=all"))).toBe(
      true,
    );
  });

  test("returns the numbers of every pull request with that head", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk([
        { number: 12, html_url: "https://github.com/acme/widgets/pull/12" },
        { number: 9, html_url: "https://github.com/acme/widgets/pull/9" },
      ]),
    ]);
    expect(
      await listPullRequestNumbersByHead(
        { run: fake.run, ghToken: "tok" },
        "acme",
        "widgets",
        "factory/issue-7-wi-3",
      ),
    ).toEqual([12, 9]);
  });

  test("refuses a page that may not hold every pull request", async () => {
    const page = Array.from({ length: 100 }, (_, i) => ({
      number: i + 1,
      html_url: `https://github.com/acme/widgets/pull/${String(i + 1)}`,
    }));
    const fake = createFakeCommandRunner([ghApiOk(page)]);
    await expect(
      listPullRequestNumbersByHead(
        { run: fake.run, ghToken: "tok" },
        "acme",
        "widgets",
        "factory/issue-7-wi-3",
      ),
    ).rejects.toThrow("100 or more");
  });

  test("throws on an unexpected item", async () => {
    const fake = createFakeCommandRunner([ghApiOk([{ title: "x" }])]);
    await expect(
      listPullRequestNumbersByHead(
        { run: fake.run, ghToken: "tok" },
        "acme",
        "widgets",
        "factory/issue-7-wi-3",
      ),
    ).rejects.toThrow("unexpected response shape");
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
      ok(ghApiStdout(500, { message: "boom" })),
    ]);
    await expect(
      ensureLabel(
        { run: fake.run, ghToken: "tok", sleep: async () => {} },
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
