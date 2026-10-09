import { describe, expect, test } from "bun:test";
import {
  checkInstanceCustomTag,
  parseCustomTags,
  planCustomTag,
} from "../../scripts/custom-tags.ts";

describe("parseCustomTags", () => {
  test("returns an array of strings as is", () => {
    expect(parseCustomTags(["chromium", "console"])).toEqual([
      "chromium",
      "console",
    ]);
  });

  test("rejects null", () => {
    expect(parseCustomTags(null)).toBeUndefined();
  });

  test("rejects an array that holds a non-string", () => {
    expect(parseCustomTags(["chromium", 1])).toBeUndefined();
  });

  test("rejects an object", () => {
    expect(parseCustomTags({ tags: ["chromium"] })).toBeUndefined();
  });
});

describe("planCustomTag", () => {
  test("keeps the stored tags and appends the missing one", () => {
    expect(planCustomTag(["chromium"], null, "console")).toEqual({
      kind: "add",
      tags: ["chromium", "console"],
    });
  });

  test("starts from the effective tags when nothing is stored", () => {
    expect(planCustomTag(null, ["chromium"], "console")).toEqual({
      kind: "add",
      tags: ["chromium", "console"],
    });
  });

  test("ignores the effective tags when the stored value exists", () => {
    expect(planCustomTag(["gpu"], ["chromium"], "console")).toEqual({
      kind: "add",
      tags: ["gpu", "console"],
    });
  });

  test("keeps an empty stored list and adds the tag to it", () => {
    expect(planCustomTag([], ["chromium"], "console")).toEqual({
      kind: "add",
      tags: ["console"],
    });
  });

  test("reports present when the stored tags already hold the tag", () => {
    expect(planCustomTag(["chromium", "console"], null, "console")).toEqual({
      kind: "present",
    });
  });

  test("reports present when only the effective tags hold the tag", () => {
    expect(planCustomTag(null, ["console"], "console")).toEqual({
      kind: "present",
    });
  });

  test("reports unreadable when the stored value is malformed", () => {
    expect(planCustomTag("chromium", ["chromium"], "console")).toEqual({
      kind: "unreadable",
    });
  });

  test("reports unreadable when nothing is stored and the effective value is malformed", () => {
    expect(planCustomTag(null, undefined, "console")).toEqual({
      kind: "unreadable",
    });
  });

  test("does not mutate the stored array", () => {
    const stored = ["chromium"];

    planCustomTag(stored, null, "console");

    expect(stored).toEqual(["chromium"]);
  });
});

describe("checkInstanceCustomTag", () => {
  function serve(tags: unknown, loginStatus = 200) {
    const calls: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        calls.push(`${request.method} ${url.pathname}`);
        if (url.pathname === "/api/auth/login") {
          return loginStatus === 200
            ? new Response("session-token")
            : new Response("denied", { status: loginStatus });
        }
        if (url.pathname === "/api/workers/custom_tags") {
          return request.headers.get("authorization") === "Bearer session-token"
            ? Response.json(tags)
            : new Response("Unauthorized", { status: 401 });
        }
        return new Response("ok");
      },
    });
    return { server, calls, baseUrl: `http://127.0.0.1:${server.port}` };
  }

  const credentials = { email: "admin@example.com", password: "pw" };

  test("reports present when the instance allows the tag", async () => {
    const { server, baseUrl } = serve(["chromium", "console"]);

    const result = await checkInstanceCustomTag(
      baseUrl,
      credentials,
      "console",
    );

    server.stop(true);
    expect(result).toBe("present");
  });

  test("reports missing when the instance does not allow the tag", async () => {
    const { server, baseUrl } = serve(["chromium"]);

    const result = await checkInstanceCustomTag(
      baseUrl,
      credentials,
      "console",
    );

    server.stop(true);
    expect(result).toBe("missing");
  });

  test("reports unknown when the login is refused", async () => {
    const { server, baseUrl } = serve(["chromium"], 401);

    const result = await checkInstanceCustomTag(
      baseUrl,
      credentials,
      "console",
    );

    server.stop(true);
    expect(result).toBe("unknown");
  });

  test("reports unknown when the response is not a list of strings", async () => {
    const { server, baseUrl } = serve({ oops: true });

    const result = await checkInstanceCustomTag(
      baseUrl,
      credentials,
      "console",
    );

    server.stop(true);
    expect(result).toBe("unknown");
  });

  test("logs the session out after the check", async () => {
    const { server, calls, baseUrl } = serve(["chromium"]);

    await checkInstanceCustomTag(baseUrl, credentials, "console");

    server.stop(true);
    expect(calls.at(-1)).toBe("POST /api/auth/logout");
  });

  test("reports unknown when the instance is unreachable", async () => {
    const result = await checkInstanceCustomTag(
      "http://127.0.0.1:1",
      credentials,
      "console",
    );

    expect(result).toBe("unknown");
  });
});
