import { describe, expect, test } from "bun:test";
import {
  ownersWithUnderscore,
  readEnvironment,
  readFactoryOwnerNames,
} from "../../scripts/factory-owners.ts";

describe("ownersWithUnderscore", () => {
  test("lists the owners whose login has an underscore", () => {
    expect(
      ownersWithUnderscore({
        owners: [{ name: "emu_user" }, { name: "acme" }, { name: "a_b_c" }],
      }),
    ).toEqual(["emu_user", "a_b_c"]);
  });

  test("lists nothing when no login has an underscore", () => {
    expect(ownersWithUnderscore({ owners: [{ name: "acme" }] })).toEqual([]);
  });

  test("lists nothing for a config without owners", () => {
    expect(ownersWithUnderscore({})).toEqual([]);
  });

  test("lists nothing for a value that is not an object", () => {
    expect(ownersWithUnderscore("x")).toEqual([]);
  });

  test("skips an owner that has no string name", () => {
    expect(
      ownersWithUnderscore({ owners: [{ name: 5 }, null, "x_y"] }),
    ).toEqual([]);
  });

  test("skips a name that would be unsafe to print", () => {
    expect(
      ownersWithUnderscore({ owners: [{ name: "a_b\u001b[31m" }] }),
    ).toEqual([]);
  });
});

type Call = { method: string; path: string; authorization: string | null };

function fakeFetch(options: {
  owners?: unknown;
  version?: string;
  versionStatus?: number;
  loginStatus?: number;
  loginBody?: string;
  resourceStatus?: number;
  // このパスへのリクエストで投げる例外。
  throwAt?: { path: string; error: unknown };
}): { fetchFn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({
      method: init?.method ?? "GET",
      path: url.pathname,
      authorization: new Headers(init?.headers).get("authorization"),
    });
    if (
      options.throwAt !== undefined &&
      url.pathname === options.throwAt.path
    ) {
      throw options.throwAt.error;
    }
    if (url.pathname === "/api/version") {
      return new Response(options.version ?? "CE v1.817.0", {
        status: options.versionStatus ?? 200,
      });
    }
    if (url.pathname === "/api/auth/login") {
      return new Response(options.loginBody ?? "session-token", {
        status: options.loginStatus ?? 200,
      });
    }
    if (url.pathname.startsWith("/api/w/factory/resources/get_value/")) {
      return Response.json(options.owners ?? { owners: [] }, {
        status: options.resourceStatus ?? 200,
      });
    }
    return new Response("ok");
  };
  return {
    fetchFn: Object.assign(fetchFn, { preconnect: () => undefined }),
    calls,
  };
}

const CREDENTIALS = {
  email: "admin@example.com",
  password: "not-a-real-password",
};

const BASE_URL = "http://127.0.0.1:8080";

describe("readFactoryOwnerNames", () => {
  test("returns the names of the owners", async () => {
    const { fetchFn } = fakeFetch({
      owners: { owners: [{ name: "acme" }, { name: "emu_user" }] },
    });
    expect(await readFactoryOwnerNames(BASE_URL, CREDENTIALS, fetchFn)).toEqual(
      { names: ["acme", "emu_user"] },
    );
  });

  test("reads factory_config of the factory workspace", async () => {
    const { fetchFn, calls } = fakeFetch({});
    await readFactoryOwnerNames(BASE_URL, CREDENTIALS, fetchFn);
    expect(
      calls.some(
        (call) =>
          call.path ===
          "/api/w/factory/resources/get_value/f/factory/factory_config",
      ),
    ).toBe(true);
  });

  test("checks that the peer is Windmill before it logs in", async () => {
    const { fetchFn, calls } = fakeFetch({ version: "something else" });
    await readFactoryOwnerNames(BASE_URL, CREDENTIALS, fetchFn);
    expect(calls.map((call) => call.path)).not.toContain("/api/auth/login");
  });

  test("logs out after reading", async () => {
    const { fetchFn, calls } = fakeFetch({});
    await readFactoryOwnerNames(BASE_URL, CREDENTIALS, fetchFn);
    expect(calls.at(-1)?.path).toBe("/api/auth/logout");
  });

  test("logs out even when the config cannot be read", async () => {
    const { fetchFn, calls } = fakeFetch({ resourceStatus: 500 });
    await readFactoryOwnerNames(BASE_URL, CREDENTIALS, fetchFn);
    expect(calls.at(-1)?.path).toBe("/api/auth/logout");
  });

  test("sends the session token to the config request", async () => {
    const { fetchFn, calls } = fakeFetch({});
    await readFactoryOwnerNames(BASE_URL, CREDENTIALS, fetchFn);
    expect(
      calls.find((call) => call.path.includes("/resources/get_value/"))
        ?.authorization,
    ).toBe("Bearer session-token");
  });
});

describe("readFactoryOwnerNames reasons", () => {
  test("names the version stage when the peer is not Windmill", async () => {
    const { fetchFn } = fakeFetch({ version: "something else" });
    expect(await readFactoryOwnerNames(BASE_URL, CREDENTIALS, fetchFn)).toEqual(
      { reason: "version: unexpected response" },
    );
  });

  test("names the version stage and the status when the version check fails", async () => {
    const { fetchFn } = fakeFetch({ versionStatus: 503 });
    expect(await readFactoryOwnerNames(BASE_URL, CREDENTIALS, fetchFn)).toEqual(
      { reason: "version: status 503" },
    );
  });

  test("names the login stage and the status when the login is refused", async () => {
    const { fetchFn } = fakeFetch({ loginStatus: 401 });
    expect(await readFactoryOwnerNames(BASE_URL, CREDENTIALS, fetchFn)).toEqual(
      { reason: "login: status 401" },
    );
  });

  test("names the factory_config stage and the status when the config cannot be read", async () => {
    const { fetchFn } = fakeFetch({ resourceStatus: 404 });
    expect(await readFactoryOwnerNames(BASE_URL, CREDENTIALS, fetchFn)).toEqual(
      { reason: "factory_config: status 404" },
    );
  });

  test("names the factory_config stage when the config has no owner list", async () => {
    const { fetchFn } = fakeFetch({ owners: { other: 1 } });
    expect(await readFactoryOwnerNames(BASE_URL, CREDENTIALS, fetchFn)).toEqual(
      { reason: "factory_config: no owner list" },
    );
  });

  test("names the exception and the stage when a request throws", async () => {
    const { fetchFn } = fakeFetch({
      throwAt: {
        path: "/api/auth/login",
        error: new DOMException("timed out", "TimeoutError"),
      },
    });
    expect(await readFactoryOwnerNames(BASE_URL, CREDENTIALS, fetchFn)).toEqual(
      { reason: "exception: TimeoutError (login)" },
    );
  });

  test("names the exception without a name as unknown", async () => {
    const { fetchFn } = fakeFetch({
      throwAt: { path: "/api/version", error: "plain string" },
    });
    expect(await readFactoryOwnerNames(BASE_URL, CREDENTIALS, fetchFn)).toEqual(
      { reason: "exception: unknown (version)" },
    );
  });

  test("leaves the message of an exception out of the reason", async () => {
    const { fetchFn } = fakeFetch({
      throwAt: {
        path: "/api/auth/login",
        error: new Error(`failed for ${CREDENTIALS.password}`),
      },
    });
    const read = await readFactoryOwnerNames(BASE_URL, CREDENTIALS, fetchFn);
    expect(JSON.stringify(read)).not.toContain(CREDENTIALS.password);
  });

  test("leaves the credentials out of the reason when the login is refused", async () => {
    const { fetchFn } = fakeFetch({
      loginStatus: 401,
      loginBody: `refused ${CREDENTIALS.email} ${CREDENTIALS.password}`,
    });
    const read = await readFactoryOwnerNames(BASE_URL, CREDENTIALS, fetchFn);
    expect(JSON.stringify(read)).not.toMatch(
      new RegExp(`${CREDENTIALS.email}|${CREDENTIALS.password}`),
    );
  });

  test("leaves the session token out of the reason when the config cannot be read", async () => {
    const { fetchFn } = fakeFetch({
      owners: { echoed: "session-token" },
      resourceStatus: 500,
    });
    const read = await readFactoryOwnerNames(BASE_URL, CREDENTIALS, fetchFn);
    expect(JSON.stringify(read)).not.toContain("session-token");
  });

  test("leaves the response body out of the reason when the config has no owner list", async () => {
    const { fetchFn } = fakeFetch({ owners: { secret: "body-marker" } });
    const read = await readFactoryOwnerNames(BASE_URL, CREDENTIALS, fetchFn);
    expect(JSON.stringify(read)).not.toContain("body-marker");
  });
});

describe("readEnvironment", () => {
  const COMPLETE = {
    WM_CHECK_BASE_URL: "http://127.0.0.1:8080",
    WM_ADMIN_EMAIL: "admin@example.com",
    WM_ADMIN_PASSWORD: "not-a-real-password",
  };

  test("returns the destination and the credentials when every variable is set", () => {
    expect(readEnvironment(COMPLETE)).toEqual({
      baseUrl: "http://127.0.0.1:8080",
      email: "admin@example.com",
      password: "not-a-real-password",
    });
  });

  test("names the variables that are missing or empty", () => {
    expect(
      readEnvironment({
        ...COMPLETE,
        WM_ADMIN_EMAIL: undefined,
        WM_ADMIN_PASSWORD: "",
      }),
    ).toEqual({
      reason: "missing environment: WM_ADMIN_EMAIL, WM_ADMIN_PASSWORD",
    });
  });

  test("leaves the values of the variables out of the reason", () => {
    const read = readEnvironment({ ...COMPLETE, WM_ADMIN_EMAIL: "" });
    expect(JSON.stringify(read)).not.toContain(COMPLETE.WM_ADMIN_PASSWORD);
  });
});
