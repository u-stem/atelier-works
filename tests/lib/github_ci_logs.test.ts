import { describe, expect, test } from "bun:test";
import {
  CI_JOB_LOG_MAX_BYTES,
  GitHubCiLogError,
  GitHubRateLimitError,
  getWorkflowJobLog,
  listWorkflowRunJobs,
} from "../../f/factory/lib/github.ts";
import { omittedMarker } from "../../f/factory/lib/workspace.ts";
import {
  createFakeCommandRunner,
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
});

describe("getWorkflowJobLog", () => {
  const get = (
    fake: ReturnType<typeof createFakeCommandRunner>,
    jobId = 9001,
  ) => getWorkflowJobLog(client(fake), "acme", "widgets", jobId);

  test("asks for the log of that job with the output cap", async () => {
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
    expect(await get(fake)).toEqual({
      kind: "ok",
      log: "2026-10-13T00:00:00.0000000Z hello\n{not json",
      truncated: false,
    });
  });

  test("marks a log whose middle was dropped as truncated", async () => {
    const stdout = ghApiStdout(200, `head${omittedMarker(9_000_000)}tail`);
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

  test("throws a status-only error for a server error", async () => {
    const fake = createFakeCommandRunner([
      ok(
        ghApiStdout(500, "secret-looking body ghp_abcdefghijklmnopqrstuvwxyz"),
      ),
      ok(
        ghApiStdout(500, "secret-looking body ghp_abcdefghijklmnopqrstuvwxyz"),
      ),
    ]);
    await expect(get(fake)).rejects.toBeInstanceOf(GitHubCiLogError);
  });

  test("keeps the response body out of the error message", async () => {
    const fake = createFakeCommandRunner([
      ok(ghApiStdout(500, "response body marker")),
      ok(ghApiStdout(500, "response body marker")),
    ]);
    const error = await get(fake).catch((caught: unknown) => caught);
    expect(String(error instanceof Error ? error.message : "")).not.toContain(
      "marker",
    );
  });

  test("keeps the redirect location out of the error", async () => {
    const location = "https://blob.example.net/logs?sig=SECRETSIGNATURE";
    const fake = createFakeCommandRunner([
      ok(ghApiStdout(302, "", { location })),
    ]);
    const error = await get(fake).catch((caught: unknown) => caught);
    expect(String(error instanceof Error ? error.message : "")).not.toContain(
      "SECRETSIGNATURE",
    );
  });

  test("throws a status-only error when no response came back", async () => {
    const fake = createFakeCommandRunner([ok(""), ok("")]);
    await expect(get(fake)).rejects.toMatchObject({ status: 0 });
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
