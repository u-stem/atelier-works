// GETの要求が、`gh`を起動せずに通信層(`github_http.ts`)の`fetch`で送られることのテスト。
// 書き込み(POST、PATCH、PUT、DELETE)の要求の中身は、`github.test.ts`の「a write request」が確かめる。
// 偽のrunnerは、GitHubのAPIへの`fetch`に、用意した応答の列から順に答える(`testSupport.ts`)。

import { afterEach, describe, expect, test } from "bun:test";
import { getRepoFileText } from "../../f/factory/lib/drawio_viewer_bump_github.ts";
import {
  callGhApi,
  ensureSuccess,
  GitHubHttpError,
  GitHubRateLimitError,
  GitHubRawBodyIncompleteError,
  GitHubResponseError,
  getPrDiff,
  getPrWithoutWait,
  getViewer,
  paginateGhApi,
} from "../../f/factory/lib/github.ts";
import { GITHUB_RESPONSE_MAX_BYTES } from "../../f/factory/lib/github_http.ts";
import { markTransientGitHubFailure } from "../../f/factory/lib/pr_review_retry.ts";
import type { CommandResult } from "../../f/factory/lib/workspace.ts";
import {
  createFakeCommandRunner,
  cutBody,
  ghApiOk,
  ghApiStdout,
  ok,
  restoreGlobalFetch,
  stubGlobalFetchWith,
} from "./testSupport.ts";

afterEach(restoreGlobalFetch);

function clientWith(responses: Parameters<typeof createFakeCommandRunner>[0]) {
  const fake = createFakeCommandRunner(responses);
  const sleeps: number[] = [];
  return {
    fake,
    sleeps,
    client: {
      ghToken: "tok",
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    },
  };
}

describe("callGhApi sends a GET through fetch", () => {
  test("does not start gh for a GET", async () => {
    const { client, fake } = clientWith([ghApiOk({})]);
    await callGhApi(client, "repos/o/r");
    expect(fake.calls[0]?.argv[0]).toBe("fetch");
  });

  test("sends a GET that names its method through fetch", async () => {
    const { client, fake } = clientWith([ghApiOk({})]);
    await callGhApi(client, "repos/o/r", { method: "GET" });
    expect(fake.calls[0]?.argv[0]).toBe("fetch");
  });

  test("sends the GET to the path on the API origin", async () => {
    const { client, fake } = clientWith([ghApiOk([])]);
    await callGhApi(client, "repos/o/r/issues?state=open");
    expect(fake.calls[0]?.request?.url).toBe(
      "https://api.github.com/repos/o/r/issues?state=open",
    );
  });

  test("carries the token in the Authorization header", async () => {
    const { client, fake } = clientWith([ghApiOk({})]);
    await callGhApi(client, "repos/o/r");
    expect(fake.calls[0]?.request?.headers.get("authorization")).toBe(
      "Bearer tok",
    );
  });

  test("does not let fetch follow a redirect by itself", async () => {
    const { client, fake } = clientWith([ghApiOk({})]);
    await callGhApi(client, "repos/o/r");
    expect(fake.calls[0]?.request?.redirect).toBe("manual");
  });

  test("sends the Accept header of the options", async () => {
    const { client, fake } = clientWith([ok(ghApiStdout(200, "diff"))]);
    await callGhApi(client, "repos/o/r/pulls/1", {
      acceptHeader: "application/vnd.github.v3.diff",
    });
    expect(fake.calls[0]?.request?.headers.get("accept")).toBe(
      "application/vnd.github.v3.diff",
    );
  });

  test("returns the status of the response", async () => {
    const { client } = clientWith([ok(ghApiStdout(404, { message: "x" }))]);
    const response = await callGhApi(client, "repos/o/r");
    expect(response.status).toBe(404);
  });

  test("sends a DELETE through fetch too", async () => {
    const { client, fake } = clientWith([ok(ghApiStdout(204, ""))]);
    await callGhApi(client, "repos/o/r/issues/1/labels/x", {
      method: "DELETE",
    });
    expect(fake.calls[0]?.request?.method).toBe("DELETE");
  });

  test("rejects a GET with a leading slash", async () => {
    const { client } = clientWith([ghApiOk({})]);
    await expect(callGhApi(client, "/repos/o/r")).rejects.toThrow(
      "GitHub API path is not allowed",
    );
  });

  test("rejects a GET written as an absolute URL", async () => {
    const { client } = clientWith([ghApiOk({})]);
    await expect(
      callGhApi(client, "https://api.github.com/repos/o/r"),
    ).rejects.toThrow("GitHub API path is not allowed");
  });

  test("does not send a rejected GET", async () => {
    const { client, fake } = clientWith([ghApiOk({})]);
    await callGhApi(client, "/repos/o/r").catch(() => undefined);
    expect(fake.calls).toHaveLength(0);
  });

  test("rejects a GET with a dot segment", async () => {
    const { client } = clientWith([ghApiOk({})]);
    await expect(callGhApi(client, "repos/o/r/../x")).rejects.toThrow(
      "GitHub API path is not allowed",
    );
  });

  test("does not wait for a rate limit through a client that must not wait", async () => {
    const { client, sleeps } = clientWith([
      ok(ghApiStdout(429, "{}", { "retry-after": "5" })),
    ]);
    await getPrWithoutWait(client, "o", "r", 1).catch(() => undefined);
    expect(sleeps).toEqual([]);
  });

  test("throws a rate limit error through a client that must not wait", async () => {
    const { client } = clientWith([
      ok(ghApiStdout(429, "{}", { "retry-after": "5" })),
    ]);
    await expect(getPrWithoutWait(client, "o", "r", 1)).rejects.toBeInstanceOf(
      GitHubRateLimitError,
    );
  });
});

describe("paginateGhApi through fetch", () => {
  test("sends the next page to the API origin when the link names another host", async () => {
    const { client, fake } = clientWith([
      ghApiOk([1], {
        link: '<https://evil.example/repositories/1/issues?page=2>; rel="next"',
      }),
      ghApiOk([2]),
    ]);
    await paginateGhApi(client, "repos/o/r/issues", (parsed) =>
      Array.isArray(parsed) ? parsed : [],
    );
    expect(fake.calls[1]?.request?.url).toBe(
      "https://api.github.com/repositories/1/issues?page=2",
    );
  });
});

describe("escape sequences in a GET body", () => {
  test("keeps the escape sequences of a PR diff for the reader to reveal", async () => {
    const { client } = clientWith([
      ok(ghApiStdout(200, "diff --git a/x b/x\n+\u001b[31mred\n")),
    ]);
    const diff = await getPrDiff(client, "o", "r", 1, 100);
    expect(diff.diff).toContain("<U+001B>");
  });

  test("throws for a file text with an escape sequence", async () => {
    const { client } = clientWith([
      ok(ghApiStdout(200, "a\u001b[31mb")),
      ok(ghApiStdout(200, "a\u001b[31mb")),
    ]);
    await expect(
      getRepoFileText(client, "o", "r", "viewer/index.html", "main"),
    ).rejects.toBeInstanceOf(GitHubRawBodyIncompleteError);
  });
});

describe("a JSON GET whose body was cut after a 2xx status", () => {
  /** 2xxの後で本文が切れる`gh api -i`の形の結果。偽のrunnerが、途中で切れる本文に写す。 */
  const cut = (body: string): CommandResult => ({
    stdout: ghApiStdout(200, body),
    stderr: "",
    exitCode: 1,
    timedOut: false,
  });

  const viewerError = async (responses: readonly CommandResult[]) => {
    const { client } = clientWith(responses);
    return getViewer(client).catch((err: unknown) => err);
  };

  test("fails with a status 0 http error", async () => {
    const error = await viewerError([cut('{"login"'), cut('{"login"')]);
    expect(error instanceof GitHubHttpError ? error.status : null).toBe(0);
  });

  test("is a failure that the transient check marks", async () => {
    const error = await viewerError([cut('{"login"'), cut('{"login"')]);
    expect(markTransientGitHubFailure(error)).not.toBe(error);
  });

  test("is not a response error that waiting does not fix", async () => {
    const error = await viewerError([cut('{"login"'), cut('{"login"')]);
    expect(error instanceof GitHubResponseError).toBe(false);
  });

  test("carries the deadline when the deadline cut the body", async () => {
    stubGlobalFetchWith(async () =>
      cutBody(200, new DOMException("timed out", "TimeoutError"), '{"a"'),
    );
    const error = await getViewer({
      ghToken: "tok",
      sleep: async () => {},
    }).catch((err: unknown) => err);
    expect(error instanceof GitHubHttpError ? error.timedOut : null).toBe(true);
  });

  test("keeps the cut body out of the message", async () => {
    const error = await viewerError([
      cut('{"login":"PARTIAL-BODY'),
      cut('{"login":"PARTIAL-BODY'),
    ]);
    expect(error instanceof Error ? error.message : "").not.toContain(
      "PARTIAL-BODY",
    );
  });

  test("ensureSuccess fails an incomplete 2xx response with status 0", () => {
    let status: number | null = null;
    try {
      ensureSuccess(
        {
          status: 200,
          headers: new Map(),
          bodyText: "",
          incomplete: true,
        },
        "GET x",
      );
    } catch (err) {
      status = err instanceof GitHubHttpError ? err.status : -1;
    }
    expect(status).toBe(0);
  });

  test("fails a body over the memory cap as a response error", async () => {
    const huge = `"${"x".repeat(GITHUB_RESPONSE_MAX_BYTES)}"`;
    const error = await viewerError([ok(ghApiStdout(200, huge))]);
    expect(error instanceof GitHubResponseError).toBe(true);
  });
});
