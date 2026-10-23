import { describe, expect, test } from "bun:test";
import {
  callGhApi,
  callGhApiRawBody,
  paginateGhApi,
} from "../../f/factory/lib/github.ts";
import {
  createFakeCommandRunner,
  ghApiOk,
  ghApiStdout,
  ok,
} from "./testSupport.ts";

const REJECTION = "GitHub REST search endpoints are not allowed";

function clientWith(responses: Parameters<typeof createFakeCommandRunner>[0]) {
  const fake = createFakeCommandRunner(responses);
  return { fake, client: { run: fake.run, ghToken: "tok" } };
}

describe("callGhApi rejects the REST search endpoints", () => {
  test("rejects an endpoint with a leading slash", async () => {
    const { client } = clientWith([ghApiOk({})]);

    await expect(callGhApi(client, "/search/issues?q=x")).rejects.toThrow(
      REJECTION,
    );
  });

  test("rejects an endpoint without a leading slash", async () => {
    const { client } = clientWith([ghApiOk({})]);

    await expect(callGhApi(client, "search/issues?q=x")).rejects.toThrow(
      REJECTION,
    );
  });

  test("rejects an endpoint in upper case", async () => {
    const { client } = clientWith([ghApiOk({})]);

    await expect(callGhApi(client, "SEARCH/issues?q=x")).rejects.toThrow(
      REJECTION,
    );
  });

  test("rejects an endpoint written as an absolute URL", async () => {
    const { client } = clientWith([ghApiOk({})]);

    await expect(
      callGhApi(client, "https://api.github.com/search/issues?q=x"),
    ).rejects.toThrow(REJECTION);
  });

  test("rejects an absolute URL whose host is in upper case", async () => {
    const { client } = clientWith([ghApiOk({})]);

    await expect(
      callGhApi(client, "HTTPS://API.GITHUB.COM/Search/Issues?q=x"),
    ).rejects.toThrow(REJECTION);
  });

  test("rejects another search resource under the same prefix", async () => {
    const { client } = clientWith([ghApiOk({})]);

    await expect(callGhApi(client, "search/code?q=x")).rejects.toThrow(
      REJECTION,
    );
  });

  test("rejects an endpoint with several leading slashes", async () => {
    const { client } = clientWith([ghApiOk({})]);

    await expect(callGhApi(client, "//search/issues")).rejects.toThrow(
      REJECTION,
    );
  });

  test("does not start gh for a rejected endpoint", async () => {
    const { client, fake } = clientWith([ghApiOk({})]);

    await callGhApi(client, "search/issues?q=x").catch(() => undefined);

    expect(fake.calls).toHaveLength(0);
  });

  test("does not put the endpoint in the message", async () => {
    const { client } = clientWith([ghApiOk({})]);

    const error = await callGhApi(client, "search/issues?q=hidden-query").catch(
      (caught: unknown) => caught,
    );

    expect(
      error instanceof Error && !error.message.includes("hidden-query"),
    ).toBe(true);
  });

  test("rejects through callGhApiRawBody", async () => {
    const { client } = clientWith([ghApiOk({})]);

    await expect(
      callGhApiRawBody(client, "search/issues?q=x", {}, "GET search"),
    ).rejects.toThrow(REJECTION);
  });
});

describe("callGhApi does not reject the other endpoints", () => {
  test("passes a repository whose name starts with search", async () => {
    const { client } = clientWith([ghApiOk([])]);

    const response = await callGhApi(client, "repos/o/search-x/issues");

    expect(response.status).toBe(200);
  });

  test("passes a repository named search", async () => {
    const { client } = clientWith([ghApiOk([])]);

    const response = await callGhApi(client, "repos/o/search/issues");

    expect(response.status).toBe(200);
  });

  test("passes a plain issue list", async () => {
    const { client } = clientWith([ghApiOk([])]);

    const response = await callGhApi(client, "repos/o/r/issues");

    expect(response.status).toBe(200);
  });

  test("passes a pull request read with a leading slash", async () => {
    const { client } = clientWith([ghApiOk({})]);

    const response = await callGhApi(client, "/repos/o/r/pulls/1");

    expect(response.status).toBe(200);
  });

  test("passes an absolute URL of a repository endpoint", async () => {
    const { client } = clientWith([ghApiOk([])]);

    const response = await callGhApi(
      client,
      "https://api.github.com/repos/o/r/pulls?state=open",
    );

    expect(response.status).toBe(200);
  });

  test("passes a query that mentions the search prefix", async () => {
    const { client } = clientWith([ghApiOk([])]);

    const response = await callGhApi(
      client,
      "repos/o/r/issues?labels=search/issues",
    );

    expect(response.status).toBe(200);
  });

  test("passes the viewer endpoint", async () => {
    const { client } = clientWith([ghApiOk({})]);

    const response = await callGhApi(client, "user");

    expect(response.status).toBe(200);
  });

  test("passes the viewer teams endpoint", async () => {
    const { client } = clientWith([ghApiOk([])]);

    const response = await callGhApi(client, "user/teams?per_page=100");

    expect(response.status).toBe(200);
  });

  test("passes an endpoint that merely starts with the word search", async () => {
    const { client } = clientWith([ghApiOk({})]);

    const response = await callGhApi(client, "searchable/x");

    expect(response.status).toBe(200);
  });

  test("passes a non-GET merge request", async () => {
    const { client, fake } = clientWith([ghApiOk({ merged: true })]);

    await callGhApi(client, "repos/o/r/pulls/1/merge", {
      method: "PUT",
      body: { sha: "abc" },
    });

    expect(fake.calls).toHaveLength(1);
  });
});

describe("paginateGhApi passes every page through the same entry", () => {
  test("rejects a next page URL that points at a search endpoint", async () => {
    const { client } = clientWith([
      ok(
        ghApiStdout(200, [], {
          link: '<https://api.github.com/search/issues?q=x&page=2>; rel="next"',
        }),
      ),
      ghApiOk([]),
    ]);

    await expect(
      paginateGhApi(client, "repos/o/r/issues", (parsed) =>
        Array.isArray(parsed) ? parsed : [],
      ),
    ).rejects.toThrow(REJECTION);
  });

  test("does not request the rejected next page", async () => {
    const { client, fake } = clientWith([
      ok(
        ghApiStdout(200, [], {
          link: '<https://api.github.com/search/issues?q=x&page=2>; rel="next"',
        }),
      ),
      ghApiOk([]),
    ]);

    await paginateGhApi(client, "repos/o/r/issues", (parsed) =>
      Array.isArray(parsed) ? parsed : [],
    ).catch(() => undefined);

    expect(fake.calls).toHaveLength(1);
  });

  test("follows an ordinary next page", async () => {
    const { client } = clientWith([
      ok(
        ghApiStdout(200, [1], {
          link: '<https://api.github.com/repos/o/r/issues?page=2>; rel="next"',
        }),
      ),
      ghApiOk([2]),
    ]);

    const items = await paginateGhApi(client, "repos/o/r/issues", (parsed) =>
      Array.isArray(parsed) ? parsed : [],
    );

    expect(items).toEqual([1, 2]);
  });
});
