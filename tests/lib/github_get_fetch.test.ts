// GETの要求が、`gh`を起動せずに通信層(`github_http.ts`)の`fetch`で送られることのテスト。
// 書き込み(POST、PATCH、PUT、DELETE)は、まだ`gh`で送る。
// 偽のrunnerは、`gh`の起動とGitHubのAPIへの`fetch`の両方に、同じ応答の列から答える(`testSupport.ts`)。

import { describe, expect, test } from "bun:test";
import { getRepoFileText } from "../../f/factory/lib/drawio_viewer_bump_github.ts";
import {
  callGhApi,
  GitHubRateLimitError,
  GitHubRawBodyIncompleteError,
  getPrDiff,
  getPrWithoutWait,
  paginateGhApi,
} from "../../f/factory/lib/github.ts";
import {
  createFakeCommandRunner,
  ghApiOk,
  ghApiStdout,
  ok,
} from "./testSupport.ts";

function clientWith(responses: Parameters<typeof createFakeCommandRunner>[0]) {
  const fake = createFakeCommandRunner(responses);
  const sleeps: number[] = [];
  return {
    fake,
    sleeps,
    client: {
      run: fake.run,
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

  test("keeps a POST on gh", async () => {
    const { client, fake } = clientWith([ghApiOk({})]);
    await callGhApi(client, "repos/o/r/issues", { method: "POST", body: {} });
    expect(fake.calls[0]?.argv[0]).toBe("gh");
  });

  test("keeps a DELETE on gh", async () => {
    const { client, fake } = clientWith([ok(ghApiStdout(204, ""))]);
    await callGhApi(client, "repos/o/r/issues/1/labels/x", {
      method: "DELETE",
    });
    expect(fake.calls[0]?.argv[0]).toBe("gh");
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
