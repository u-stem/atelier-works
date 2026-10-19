import { describe, expect, spyOn, test } from "bun:test";
import { callGhApi, type GhClient } from "../../f/factory/lib/github.ts";
import type { LogFields, Logger } from "../../f/factory/lib/log.ts";
import {
  createFakeCommandRunner,
  ghApiOk,
  ghApiStdout,
  ok,
} from "./testSupport.ts";

type Warned = { readonly message: string; readonly fields: LogFields };

function recordingLogger(): { log: Logger; warned: Warned[] } {
  const warned: Warned[] = [];
  const log: Logger = {
    info: () => undefined,
    warn: (message, fields) => {
      warned.push({ message, fields: fields ?? {} });
    },
    error: () => undefined,
  };
  return { log, warned };
}

function limited(headers: Record<string, string>, status = 403) {
  return ok(ghApiStdout(status, { message: "limit" }, headers));
}

function setup(responses: Parameters<typeof createFakeCommandRunner>[0]) {
  const fake = createFakeCommandRunner(responses);
  const { log, warned } = recordingLogger();
  const client: GhClient = {
    run: fake.run,
    ghToken: "tok_secret_value",
    sleep: async () => undefined,
    log,
  };
  return { client, warned };
}

const ENDPOINT = "repos/o/r/issues?labels=x&per_page=100";

describe("callGhApi logs the rate limit responses", () => {
  test("logs one line when a limited request succeeds after waiting", async () => {
    const { client, warned } = setup([
      limited({ "retry-after": "1", "x-ratelimit-resource": "core" }),
      ghApiOk([]),
    ]);

    await callGhApi(client, ENDPOINT);

    expect(warned).toHaveLength(1);
  });

  test("logs the status of the limited response", async () => {
    const { client, warned } = setup([
      limited({ "retry-after": "1" }, 429),
      ghApiOk([]),
    ]);

    await callGhApi(client, ENDPOINT);

    expect(warned[0]?.fields.status).toBe(429);
  });

  test("logs the endpoint without its query", async () => {
    const { client, warned } = setup([
      limited({ "retry-after": "1" }),
      ghApiOk([]),
    ]);

    await callGhApi(client, ENDPOINT);

    expect(warned[0]?.fields.endpoint).toBe("repos/o/r/issues");
  });

  test("logs the endpoint of an absolute URL without the host", async () => {
    const { client, warned } = setup([
      limited({ "retry-after": "1" }),
      ghApiOk([]),
    ]);

    await callGhApi(client, "https://api.github.com/repos/o/r/pulls?page=2");

    expect(warned[0]?.fields.endpoint).toBe("repos/o/r/pulls");
  });

  test("logs the retry-after header", async () => {
    const { client, warned } = setup([
      limited({ "retry-after": "7" }),
      ghApiOk([]),
    ]);

    await callGhApi(client, ENDPOINT);

    expect(warned[0]?.fields.retry_after).toBe("7");
  });

  test("logs the x-ratelimit-resource header", async () => {
    const { client, warned } = setup([
      limited({ "retry-after": "1", "x-ratelimit-resource": "search" }),
      ghApiOk([]),
    ]);

    await callGhApi(client, ENDPOINT);

    expect(warned[0]?.fields.resource).toBe("search");
  });

  test("logs null for the headers the response does not have", async () => {
    const { client, warned } = setup([
      limited({ "x-ratelimit-remaining": "0" }),
      ghApiOk([]),
    ]);

    await callGhApi(client, ENDPOINT);

    expect([warned[0]?.fields.retry_after, warned[0]?.fields.resource]).toEqual(
      [null, null],
    );
  });

  test("logs a request that fails because the wait is too long", async () => {
    const { client, warned } = setup([
      limited({ "retry-after": "100000", "x-ratelimit-resource": "core" }),
    ]);

    await callGhApi(client, ENDPOINT).catch(() => undefined);

    expect(warned).toHaveLength(1);
  });

  test("logs each limited response when the retry is limited again", async () => {
    const { client, warned } = setup([
      limited({ "retry-after": "1" }),
      limited({ "retry-after": "1" }),
    ]);

    await callGhApi(client, ENDPOINT).catch(() => undefined);

    expect(warned).toHaveLength(2);
  });

  test("tells the outcome of each limited response", async () => {
    const { client, warned } = setup([
      limited({ "retry-after": "1" }),
      limited({ "retry-after": "1" }),
    ]);

    await callGhApi(client, ENDPOINT).catch(() => undefined);

    expect(warned.map((entry) => entry.fields.outcome)).toEqual([
      "waiting",
      "still_limited",
    ]);
  });

  test("tells a wait that is too long", async () => {
    const { client, warned } = setup([limited({ "retry-after": "100000" })]);

    await callGhApi(client, ENDPOINT).catch(() => undefined);

    expect(warned[0]?.fields.outcome).toBe("wait_too_long");
  });

  test("does not log a successful response", async () => {
    const { client, warned } = setup([ghApiOk([])]);

    await callGhApi(client, ENDPOINT);

    expect(warned).toHaveLength(0);
  });

  test("does not log a 403 that is not a rate limit", async () => {
    const { client, warned } = setup([limited({})]);

    await callGhApi(client, ENDPOINT);

    expect(warned).toHaveLength(0);
  });

  test("does not put the token in the log", async () => {
    const { client, warned } = setup([
      limited({ "retry-after": "1" }),
      ghApiOk([]),
    ]);

    await callGhApi(client, ENDPOINT);

    expect(JSON.stringify(warned).includes("tok_secret_value")).toBe(false);
  });

  test("does not put the query values in the log", async () => {
    const { client, warned } = setup([
      limited({ "retry-after": "1" }),
      ghApiOk([]),
    ]);

    await callGhApi(client, "repos/o/r/issues?labels=hidden-label");

    expect(JSON.stringify(warned).includes("hidden-label")).toBe(false);
  });

  test("writes to the console when the client has no logger", async () => {
    const fake = createFakeCommandRunner([
      limited({ "retry-after": "1", "x-ratelimit-resource": "core" }),
      ghApiOk([]),
    ]);
    const spy = spyOn(console, "log").mockImplementation(() => undefined);

    try {
      await callGhApi(
        { run: fake.run, ghToken: "tok", sleep: async () => undefined },
        ENDPOINT,
      );
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});
