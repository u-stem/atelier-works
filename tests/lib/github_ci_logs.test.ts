import { afterEach, describe, expect, test } from "bun:test";
import {
  CI_JOB_LOG_MAX_BYTES,
  GitHubCiLogError,
  GitHubPaginationLimitError,
  GitHubRateLimitError,
  GitHubRawBodyIncompleteError,
  getWorkflowJobLog,
  listWorkflowRunJobs,
  WORKFLOW_RUN_JOBS_MAX_PAGES,
} from "../../f/factory/lib/github.ts";
import { omittedMarker } from "../../f/factory/lib/workspace.ts";
import {
  createFakeCommandRunner,
  cutBody,
  ghApiOk,
  ghApiStdout,
  ok,
  redirectTo,
  restoreGlobalFetch,
  stubGlobalFetch,
} from "./testSupport.ts";

afterEach(restoreGlobalFetch);

const SHA = "a".repeat(40);

const client = (_fake: ReturnType<typeof createFakeCommandRunner>) => ({
  ghToken: "tok",
  sleep: async () => {},
});

const rawJob = (overrides: Record<string, unknown> = {}) => ({
  id: 9001,
  run_id: 555,
  run_attempt: 1,
  head_sha: SHA,
  name: "check",
  status: "completed",
  conclusion: "failure",
  steps: [
    {
      name: "Set up job",
      status: "completed",
      conclusion: "success",
      number: 1,
    },
    { name: "Run lint", status: "completed", conclusion: "failure", number: 2 },
  ],
  ...overrides,
});

describe("listWorkflowRunJobs", () => {
  const list = (
    fake: ReturnType<typeof createFakeCommandRunner>,
    runId = 555,
    headSha = SHA,
  ) => listWorkflowRunJobs(client(fake), "acme", "widgets", runId, headSha);

  test("asks for the latest attempt jobs of that run", async () => {
    const fake = createFakeCommandRunner([ghApiOk({ jobs: [rawJob()] })]);
    await list(fake);
    expect(fake.calls[0]?.argv).toContain(
      "repos/acme/widgets/actions/runs/555/jobs?filter=latest&per_page=100",
    );
  });

  test("returns the jobs with their steps parsed", async () => {
    const fake = createFakeCommandRunner([ghApiOk({ jobs: [rawJob()] })]);
    expect(await list(fake)).toEqual([
      {
        id: 9001,
        runId: 555,
        headSha: SHA,
        name: "check",
        status: "completed",
        conclusion: "failure",
        steps: [
          { name: "Set up job", conclusion: "success", number: 1 },
          { name: "Run lint", conclusion: "failure", number: 2 },
        ],
      },
    ]);
  });

  test("treats a missing steps array as no steps", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk({ jobs: [rawJob({ steps: undefined })] }),
    ]);
    expect((await list(fake))[0]?.steps).toEqual([]);
  });

  test("rejects a non-positive run id before calling the API", async () => {
    const fake = createFakeCommandRunner([]);
    await expect(list(fake, 0)).rejects.toThrow("invalid run id");
  });

  test("rejects a fractional run id before calling the API", async () => {
    const fake = createFakeCommandRunner([]);
    await expect(list(fake, 1.5)).rejects.toThrow("invalid run id");
  });

  test("rejects an unsafe-integer run id before calling the API", async () => {
    const fake = createFakeCommandRunner([]);
    await expect(list(fake, 2 ** 60)).rejects.toThrow("invalid run id");
  });

  test("rejects a short head sha before calling the API", async () => {
    const fake = createFakeCommandRunner([]);
    await expect(list(fake, 555, "abc1234")).rejects.toThrow(
      "invalid commit sha",
    );
  });

  test("rejects a job of another run", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk({ jobs: [rawJob({ run_id: 556 })] }),
    ]);
    await expect(list(fake)).rejects.toThrow("another run");
  });

  test("rejects a job of another commit", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk({ jobs: [rawJob({ head_sha: "b".repeat(40) })] }),
    ]);
    await expect(list(fake)).rejects.toThrow("another commit");
  });

  test("rejects a job whose id is not a positive safe integer", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk({ jobs: [rawJob({ id: -3 })] }),
    ]);
    await expect(list(fake)).rejects.toThrow("unexpected response shape");
  });

  test("rejects a job whose name is not a string", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk({ jobs: [rawJob({ name: 5 })] }),
    ]);
    await expect(list(fake)).rejects.toThrow("unexpected response shape");
  });

  test("rejects a step whose number is not an integer", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk({
        jobs: [
          rawJob({ steps: [{ name: "x", conclusion: null, number: "1" }] }),
        ],
      }),
    ]);
    await expect(list(fake)).rejects.toThrow("unexpected response shape");
  });

  test("rejects a response without a jobs array", async () => {
    const fake = createFakeCommandRunner([ghApiOk({ total_count: 0 })]);
    await expect(list(fake)).rejects.toThrow("unexpected response shape");
  });

  test("surfaces a permission error with its status", async () => {
    const fake = createFakeCommandRunner([
      ok(ghApiStdout(403, { message: "Resource not accessible" })),
    ]);
    await expect(list(fake)).rejects.toMatchObject({ status: 403 });
  });

  test("follows the next link to the following page", async () => {
    const next = {
      link: '<https://api.github.com/repos/acme/widgets/actions/runs/555/jobs?page=2>; rel="next"',
    };
    const fake = createFakeCommandRunner([
      ghApiOk({ jobs: [rawJob({ id: 1 })] }, next),
      ghApiOk({ jobs: [rawJob({ id: 2 })] }),
    ]);
    expect((await list(fake)).map((job) => job.id)).toEqual([1, 2]);
  });

  test("throws a pagination limit error past the page cap", async () => {
    const next = {
      link: '<https://api.github.com/repos/acme/widgets/actions/runs/555/jobs?page=2>; rel="next"',
    };
    const fake = createFakeCommandRunner(
      Array.from({ length: WORKFLOW_RUN_JOBS_MAX_PAGES + 1 }, (_, i) =>
        ghApiOk({ jobs: [rawJob({ id: i + 1 })] }, next),
      ),
    );
    await expect(list(fake)).rejects.toBeInstanceOf(GitHubPaginationLimitError);
  });
});

describe("getWorkflowJobLog", () => {
  // 実際のジョブのログの302が指したホスト。
  const LOG_URL =
    "https://productionresultssa10.blob.core.windows.net/logs/9001.txt?sig=SECRETSIGNATURE";
  const API_URL =
    "https://api.github.com/repos/acme/widgets/actions/jobs/9001/logs";

  const get = (jobId = 9001, sleeps: number[] = []) =>
    getWorkflowJobLog(
      {
        ghToken: "tok",
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
      "acme",
      "widgets",
      jobId,
    );

  /** 例外の文面。例外でなければ空文字。 */
  const messageOf = async (): Promise<string> => {
    const error = await get().catch((caught: unknown) => caught);
    return error instanceof Error ? error.message : "";
  };

  const logOf = async (): Promise<string | null> => {
    const result = await get();
    return result.kind === "ok" ? result.log.reveal() : null;
  };

  test("asks the API for the log of that job", async () => {
    const stub = stubGlobalFetch([redirectTo(LOG_URL), new Response("line")]);
    await get();
    expect(stub.sent[0]?.url).toBe(API_URL);
  });

  test("does not start gh", async () => {
    stubGlobalFetch([redirectTo(LOG_URL), new Response("line")]);
    const fake = createFakeCommandRunner([]);
    await getWorkflowJobLog({ ghToken: "tok" }, "acme", "widgets", 9001).catch(
      () => undefined,
    );
    expect(fake.calls).toHaveLength(0);
  });

  test("fetches the signed URL of the redirect", async () => {
    const stub = stubGlobalFetch([redirectTo(LOG_URL), new Response("line")]);
    await get();
    expect(stub.sent[1]?.url).toBe(LOG_URL);
  });

  test("does not send the token to the signed URL", async () => {
    const stub = stubGlobalFetch([redirectTo(LOG_URL), new Response("line")]);
    await get();
    expect(new Headers(stub.sent[1]?.init.headers).has("authorization")).toBe(
      false,
    );
  });

  test("returns the log text as is, not parsed as JSON", async () => {
    stubGlobalFetch([
      redirectTo(LOG_URL),
      new Response("2026-10-13T00:00:00.0000000Z hello\n{not json"),
    ]);
    expect(await logOf()).toBe("2026-10-13T00:00:00.0000000Z hello\n{not json");
  });

  test("keeps the terminal escape sequences of the log", async () => {
    stubGlobalFetch([redirectTo(LOG_URL), new Response("a\u001b[31mb")]);
    expect(await logOf()).toBe("a\u001b[31mb");
  });

  test("wraps the log in a volatile value that refuses JSON", async () => {
    stubGlobalFetch([redirectTo(LOG_URL), new Response("RAW-LOG")]);
    const result = await get();
    expect(() => JSON.stringify(result)).toThrow("must not be serialized");
  });

  test("does not mark a log within the cap as truncated", async () => {
    stubGlobalFetch([redirectTo(LOG_URL), new Response("line")]);
    expect(await get()).toMatchObject({ kind: "ok", truncated: false });
  });

  test("does not trust a marker inside a small log to mean truncation", async () => {
    const forged = `head${omittedMarker(9_000_000)}tail`;
    stubGlobalFetch([redirectTo(LOG_URL), new Response(forged)]);
    expect(await get()).toMatchObject({ kind: "ok", truncated: false });
  });

  test("marks a log over the byte cap as truncated", async () => {
    stubGlobalFetch([
      redirectTo(LOG_URL),
      new Response("x".repeat(CI_JOB_LOG_MAX_BYTES + 1)),
    ]);
    expect(await get()).toMatchObject({ kind: "ok", truncated: true });
  });

  test("keeps the tail of a log over the byte cap", async () => {
    stubGlobalFetch([
      redirectTo(LOG_URL),
      new Response(`${"x".repeat(CI_JOB_LOG_MAX_BYTES)}FAILURE-AT-THE-END`),
    ]);
    expect((await logOf())?.endsWith("FAILURE-AT-THE-END")).toBe(true);
  });

  test("returns forbidden for a 403 from the API", async () => {
    stubGlobalFetch([
      new Response('{"message":"Resource not accessible"}', { status: 403 }),
    ]);
    expect(await get()).toEqual({ kind: "forbidden" });
  });

  test("returns log_unavailable for a 404 from the API", async () => {
    stubGlobalFetch([new Response('{"message":"Not Found"}', { status: 404 })]);
    expect(await get()).toEqual({ kind: "log_unavailable" });
  });

  test("returns log_unavailable for a 410 from the API", async () => {
    stubGlobalFetch([new Response('{"message":"Gone"}', { status: 410 })]);
    expect(await get()).toEqual({ kind: "log_unavailable" });
  });

  test("states only the status in the message of an unexpected 4xx", async () => {
    stubGlobalFetch([
      new Response("unprocessable body marker", { status: 422 }),
    ]);
    expect(await messageOf()).toBe("GET workflow job log failed with HTTP 422");
  });

  test("states only the status in the message of a server error", async () => {
    // APIの5xxは1回だけ送り直すので、2回とも5xxを返す。
    stubGlobalFetch([
      new Response("response body marker", { status: 500 }),
      new Response("response body marker", { status: 500 }),
    ]);
    expect(await messageOf()).toBe("GET workflow job log failed with HTTP 500");
  });

  test("throws a status 0 GitHubCiLogError when the API does not answer", async () => {
    stubGlobalFetch([
      new TypeError("connection refused"),
      new TypeError("connection refused"),
    ]);
    await expect(get()).rejects.toMatchObject({
      name: "GitHubCiLogError",
      status: 0,
    });
  });

  test("throws a GitHubCiLogError when the API answers without a redirect", async () => {
    stubGlobalFetch([new Response("line", { status: 200 })]);
    await expect(get()).rejects.toBeInstanceOf(GitHubCiLogError);
  });

  test("throws a GitHubCiLogError for a redirect to a host that is not allowed", async () => {
    stubGlobalFetch([
      redirectTo("https://blob.example.net/logs?sig=SECRETSIGNATURE"),
    ]);
    await expect(get()).rejects.toBeInstanceOf(GitHubCiLogError);
  });

  test("keeps the redirect location out of the error of a refused redirect", async () => {
    stubGlobalFetch([
      redirectTo("https://blob.example.net/logs?sig=SECRETSIGNATURE"),
    ]);
    expect(await messageOf()).not.toContain("SECRETSIGNATURE");
  });

  test("throws a GitHubCiLogError with the status of a refused signed URL", async () => {
    stubGlobalFetch([
      redirectTo(LOG_URL),
      new Response("AuthenticationFailed", { status: 403 }),
    ]);
    await expect(get()).rejects.toMatchObject({
      name: "GitHubCiLogError",
      status: 403,
    });
  });

  test("keeps the signed URL out of the error when the signed URL fails", async () => {
    stubGlobalFetch([
      redirectTo(LOG_URL),
      new TypeError(`fetch failed for ${LOG_URL}`),
    ]);
    expect(await messageOf()).not.toContain("SECRETSIGNATURE");
  });

  test("throws a status 0 GitHubCiLogError when the signed URL does not answer", async () => {
    stubGlobalFetch([redirectTo(LOG_URL), new TypeError("connection refused")]);
    await expect(get()).rejects.toMatchObject({
      name: "GitHubCiLogError",
      status: 0,
    });
  });

  test("throws a status 0 GitHubCiLogError when the signed URL passes the deadline", async () => {
    stubGlobalFetch([
      redirectTo(LOG_URL),
      new DOMException("timed out", "TimeoutError"),
    ]);
    await expect(get()).rejects.toMatchObject({
      name: "GitHubCiLogError",
      status: 0,
    });
  });

  test("throws a GitHubRawBodyIncompleteError when the log is cut", async () => {
    stubGlobalFetch([
      redirectTo(LOG_URL),
      cutBody(200, new TypeError("terminated"), "line 1"),
    ]);
    await expect(get()).rejects.toBeInstanceOf(GitHubRawBodyIncompleteError);
  });

  test("states a fixed message for the incomplete log error", async () => {
    stubGlobalFetch([
      redirectTo(LOG_URL),
      cutBody(200, new TypeError("terminated"), "PARTIAL-BODY-MARKER"),
    ]);
    expect(await messageOf()).toBe(
      "GET workflow job log ended incomplete: the body was cut after a 2xx status",
    );
  });

  test("does not fetch the log again after a cut", async () => {
    const stub = stubGlobalFetch([
      redirectTo(LOG_URL),
      cutBody(200, new TypeError("terminated")),
    ]);
    await get().catch(() => undefined);
    expect(stub.sent).toHaveLength(2);
  });

  test("lets a rate limit error through", async () => {
    stubGlobalFetch([
      new Response("slow down", {
        status: 429,
        headers: { "Retry-After": "999" },
      }),
    ]);
    await expect(get()).rejects.toBeInstanceOf(GitHubRateLimitError);
  });

  test("does not wait for a rate limit", async () => {
    stubGlobalFetch([
      new Response("slow down", {
        status: 429,
        headers: { "Retry-After": "5" },
      }),
    ]);
    const sleeps: number[] = [];
    await get(9001, sleeps).catch(() => undefined);
    expect(sleeps).toEqual([]);
  });

  test("rejects a non-positive job id before calling the API", async () => {
    await expect(get(0)).rejects.toThrow("invalid job id");
  });

  test("rejects an unsafe-integer job id before calling the API", async () => {
    await expect(get(Number.MAX_SAFE_INTEGER + 1)).rejects.toThrow(
      "invalid job id",
    );
  });
});
