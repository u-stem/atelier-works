import { describe, expect, test } from "bun:test";
import {
  CI_JOB_LOG_MAX_BYTES,
  GitHubCiLogError,
  GitHubPaginationLimitError,
  GitHubRateLimitError,
  getWorkflowJobLog,
  listWorkflowRunJobs,
  WORKFLOW_RUN_JOBS_MAX_PAGES,
} from "../../f/factory/lib/github.ts";
import { omittedMarker } from "../../f/factory/lib/workspace.ts";
import {
  createFakeCommandRunner,
  fail,
  ghApiOk,
  ghApiStdout,
  ok,
} from "./testSupport.ts";

const SHA = "a".repeat(40);

const client = (fake: ReturnType<typeof createFakeCommandRunner>) => ({
  run: fake.run,
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
  const get = (
    fake: ReturnType<typeof createFakeCommandRunner>,
    jobId = 9001,
  ) => getWorkflowJobLog(client(fake), "acme", "widgets", jobId);

  /** 例外の文面。例外でなければ空文字。 */
  const messageOf = async (
    fake: ReturnType<typeof createFakeCommandRunner>,
  ): Promise<string> => {
    const error = await get(fake).catch((caught: unknown) => caught);
    return error instanceof Error ? error.message : "";
  };

  test("asks for the log of that job", async () => {
    const fake = createFakeCommandRunner([ok(ghApiStdout(200, "line"))]);
    await get(fake);
    expect(fake.calls[0]?.argv).toContain(
      "repos/acme/widgets/actions/jobs/9001/logs",
    );
  });

  test("passes the byte cap to the runner", async () => {
    const fake = createFakeCommandRunner([ok(ghApiStdout(200, "line"))]);
    await get(fake);
    expect(fake.calls[0]?.options?.maxOutputBytes).toBe(CI_JOB_LOG_MAX_BYTES);
  });

  test("returns the log text as is, not parsed as JSON", async () => {
    const fake = createFakeCommandRunner([
      ok(ghApiStdout(200, "2026-10-13T00:00:00.0000000Z hello\n{not json")),
    ]);
    const result = await get(fake);
    expect(result.kind === "ok" ? result.log.reveal() : null).toBe(
      "2026-10-13T00:00:00.0000000Z hello\n{not json",
    );
  });

  test("wraps the log in a volatile value that refuses JSON", async () => {
    const fake = createFakeCommandRunner([ok(ghApiStdout(200, "RAW-LOG"))]);
    const result = await get(fake);
    expect(() => JSON.stringify(result)).toThrow("must not be serialized");
  });

  test("does not mark a log within the cap as truncated", async () => {
    const fake = createFakeCommandRunner([ok(ghApiStdout(200, "line"))]);
    expect(await get(fake)).toMatchObject({ kind: "ok", truncated: false });
  });

  test("does not trust a marker inside a small log to mean truncation", async () => {
    const forged = `head${omittedMarker(9_000_000)}tail`;
    const fake = createFakeCommandRunner([ok(ghApiStdout(200, forged))]);
    expect(await get(fake)).toMatchObject({ kind: "ok", truncated: false });
  });

  test("marks an output that went past the byte cap as truncated", async () => {
    const stdout = ghApiStdout(
      200,
      `head${omittedMarker(9_000_000)}${"x".repeat(CI_JOB_LOG_MAX_BYTES)}`,
    );
    const fake = createFakeCommandRunner([ok(stdout)]);
    expect(await get(fake)).toMatchObject({ kind: "ok", truncated: true });
  });

  test("returns forbidden for 403", async () => {
    const fake = createFakeCommandRunner([
      ok(ghApiStdout(403, { message: "Resource not accessible" })),
    ]);
    expect(await get(fake)).toEqual({ kind: "forbidden" });
  });

  test("returns log_unavailable for 404", async () => {
    const fake = createFakeCommandRunner([
      ok(ghApiStdout(404, { message: "Not Found" })),
    ]);
    expect(await get(fake)).toEqual({ kind: "log_unavailable" });
  });

  test("returns log_unavailable for 410", async () => {
    const fake = createFakeCommandRunner([
      ok(ghApiStdout(410, { message: "Gone" })),
    ]);
    expect(await get(fake)).toEqual({ kind: "log_unavailable" });
  });

  test("rejects a non-positive job id before calling the API", async () => {
    const fake = createFakeCommandRunner([]);
    await expect(get(fake, 0)).rejects.toThrow("invalid job id");
  });

  test("rejects an unsafe-integer job id before calling the API", async () => {
    const fake = createFakeCommandRunner([]);
    await expect(get(fake, Number.MAX_SAFE_INTEGER + 1)).rejects.toThrow(
      "invalid job id",
    );
  });

  test("throws a GitHubCiLogError for a server error", async () => {
    const body = ghApiStdout(500, "response body marker");
    const fake = createFakeCommandRunner([ok(body), ok(body)]);
    await expect(get(fake)).rejects.toBeInstanceOf(GitHubCiLogError);
  });

  test("states only the status in the message of a server error", async () => {
    const body = ghApiStdout(500, "response body marker");
    const fake = createFakeCommandRunner([ok(body), ok(body)]);
    expect(await messageOf(fake)).toBe(
      "GET workflow job log failed with HTTP 500",
    );
  });

  test("states only the status in the message of an unexpected 4xx", async () => {
    const fake = createFakeCommandRunner([
      ok(ghApiStdout(422, "unprocessable body marker")),
    ]);
    expect(await messageOf(fake)).toBe(
      "GET workflow job log failed with HTTP 422",
    );
  });

  test("keeps a signed URL from stderr out of the error when gh fails", async () => {
    const url = "https://blob.example.net/logs?sig=SECRETSIGNATURE";
    const failure = fail(`Get "${url}": dial tcp: lookup failed`);
    const fake = createFakeCommandRunner([failure, failure]);
    expect(await messageOf(fake)).not.toContain("SECRETSIGNATURE");
  });

  test("reports a status 0 error when gh fails without a response", async () => {
    const fake = createFakeCommandRunner([
      fail("Get https://blob.example.net/?sig=S: boom"),
      fail("Get https://blob.example.net/?sig=S: boom"),
    ]);
    await expect(get(fake)).rejects.toMatchObject({ status: 0 });
  });

  test("keeps the redirect location out of the error of an unfollowed redirect", async () => {
    const location = "https://blob.example.net/logs?sig=SECRETSIGNATURE";
    const fake = createFakeCommandRunner([
      ok(ghApiStdout(302, "", { location })),
    ]);
    expect(await messageOf(fake)).not.toContain("SECRETSIGNATURE");
  });

  test("lets a rate limit error through", async () => {
    const limited = ok(ghApiStdout(429, "slow down", { "retry-after": "999" }));
    const fake = createFakeCommandRunner([limited]);
    await expect(get(fake)).rejects.toBeInstanceOf(GitHubRateLimitError);
  });

  test("never puts the token on the command line", async () => {
    const fake = createFakeCommandRunner([ok(ghApiStdout(200, "line"))]);
    await get(fake);
    expect(fake.calls[0]?.argv.join(" ")).not.toContain("tok");
  });
});
