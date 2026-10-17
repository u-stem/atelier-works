import { describe, expect, test } from "bun:test";
import {
  ownersWithUnderscore,
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
  loginStatus?: number;
  resourceStatus?: number;
}): { fetchFn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({
      method: init?.method ?? "GET",
      path: url.pathname,
      authorization: new Headers(init?.headers).get("authorization"),
    });
    if (url.pathname === "/api/version") {
      return new Response(options.version ?? "CE v1.817.0");
    }
    if (url.pathname === "/api/auth/login") {
      return new Response("session-token", {
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

describe("readFactoryOwnerNames", () => {
  test("returns the names of the owners", async () => {
    const { fetchFn } = fakeFetch({
      owners: { owners: [{ name: "acme" }, { name: "emu_user" }] },
    });
    expect(
      await readFactoryOwnerNames(
        "http://127.0.0.1:8080",
        CREDENTIALS,
        fetchFn,
      ),
    ).toEqual(["acme", "emu_user"]);
  });

  test("reads factory_config of the factory workspace", async () => {
    const { fetchFn, calls } = fakeFetch({});
    await readFactoryOwnerNames("http://127.0.0.1:8080", CREDENTIALS, fetchFn);
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
    await readFactoryOwnerNames("http://127.0.0.1:8080", CREDENTIALS, fetchFn);
    expect(calls.map((call) => call.path)).not.toContain("/api/auth/login");
  });

  test("returns null when the peer is not Windmill", async () => {
    const { fetchFn } = fakeFetch({ version: "something else" });
    expect(
      await readFactoryOwnerNames(
        "http://127.0.0.1:8080",
        CREDENTIALS,
        fetchFn,
      ),
    ).toBeNull();
  });

  test("returns null when the login is refused", async () => {
    const { fetchFn } = fakeFetch({ loginStatus: 401 });
    expect(
      await readFactoryOwnerNames(
        "http://127.0.0.1:8080",
        CREDENTIALS,
        fetchFn,
      ),
    ).toBeNull();
  });

  test("returns null when the config cannot be read", async () => {
    const { fetchFn } = fakeFetch({ resourceStatus: 404 });
    expect(
      await readFactoryOwnerNames(
        "http://127.0.0.1:8080",
        CREDENTIALS,
        fetchFn,
      ),
    ).toBeNull();
  });

  test("returns null when the config has no owner list", async () => {
    const { fetchFn } = fakeFetch({ owners: { other: 1 } });
    expect(
      await readFactoryOwnerNames(
        "http://127.0.0.1:8080",
        CREDENTIALS,
        fetchFn,
      ),
    ).toBeNull();
  });

  test("logs out after reading", async () => {
    const { fetchFn, calls } = fakeFetch({});
    await readFactoryOwnerNames("http://127.0.0.1:8080", CREDENTIALS, fetchFn);
    expect(calls.at(-1)?.path).toBe("/api/auth/logout");
  });

  test("logs out even when the config cannot be read", async () => {
    const { fetchFn, calls } = fakeFetch({ resourceStatus: 500 });
    await readFactoryOwnerNames("http://127.0.0.1:8080", CREDENTIALS, fetchFn);
    expect(calls.at(-1)?.path).toBe("/api/auth/logout");
  });

  test("sends the session token to the config request", async () => {
    const { fetchFn, calls } = fakeFetch({});
    await readFactoryOwnerNames("http://127.0.0.1:8080", CREDENTIALS, fetchFn);
    expect(
      calls.find((call) => call.path.includes("/resources/get_value/"))
        ?.authorization,
    ).toBe("Bearer session-token");
  });
});
