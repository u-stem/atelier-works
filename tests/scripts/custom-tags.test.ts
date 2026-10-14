import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
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

interface ServeOptions {
  tags: unknown;
  loginStatus?: number;
  tagsStatus?: number;
  // /api/versionの本文。Windmill以外の応答を模すときに変える。
  version?: string;
  // 指定すると、ログインをこの宛先への307で答える。
  loginRedirectTo?: string;
}

function serve(options: ServeOptions) {
  const { tags, loginStatus = 200, tagsStatus = 200 } = options;
  const version = options.version ?? "CE v1.817.0";
  const calls: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      calls.push(`${request.method} ${url.pathname}`);
      if (url.pathname === "/api/version") {
        return new Response(version);
      }
      if (url.pathname === "/api/auth/login") {
        if (options.loginRedirectTo !== undefined) {
          return new Response(null, {
            status: 307,
            headers: { Location: options.loginRedirectTo },
          });
        }
        return loginStatus === 200
          ? new Response("session-token")
          : new Response("denied", { status: loginStatus });
      }
      if (url.pathname === "/api/workers/custom_tags") {
        if (request.headers.get("authorization") !== "Bearer session-token") {
          return new Response("Unauthorized", { status: 401 });
        }
        return tagsStatus === 200
          ? Response.json(tags)
          : new Response("failure", { status: tagsStatus });
      }
      return new Response("ok");
    },
  });
  return { server, calls, baseUrl: `http://127.0.0.1:${server.port}` };
}

const credentials = { email: "admin@example.com", password: "pw" };

describe("checkInstanceCustomTag", () => {
  test("reports present when the instance allows the tag", async () => {
    const { server, baseUrl } = serve({ tags: ["chromium", "console"] });

    const result = await checkInstanceCustomTag(
      baseUrl,
      credentials,
      "console",
    );

    server.stop(true);
    expect(result).toBe("present");
  });

  test("reports missing when the instance does not allow the tag", async () => {
    const { server, baseUrl } = serve({ tags: ["chromium"] });

    const result = await checkInstanceCustomTag(
      baseUrl,
      credentials,
      "console",
    );

    server.stop(true);
    expect(result).toBe("missing");
  });

  test("reports unknown when the login is refused", async () => {
    const { server, baseUrl } = serve({ tags: ["chromium"], loginStatus: 401 });

    const result = await checkInstanceCustomTag(
      baseUrl,
      credentials,
      "console",
    );

    server.stop(true);
    expect(result).toBe("unknown");
  });

  test("reports unknown when the custom tags request fails", async () => {
    const { server, baseUrl } = serve({ tags: ["console"], tagsStatus: 500 });

    const result = await checkInstanceCustomTag(
      baseUrl,
      credentials,
      "console",
    );

    server.stop(true);
    expect(result).toBe("unknown");
  });

  test("reports unknown when the response is not a list of strings", async () => {
    const { server, baseUrl } = serve({ tags: { oops: true } });

    const result = await checkInstanceCustomTag(
      baseUrl,
      credentials,
      "console",
    );

    server.stop(true);
    expect(result).toBe("unknown");
  });

  test("logs the session out after the check", async () => {
    const { server, calls, baseUrl } = serve({ tags: ["chromium"] });

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

  test("reports unknown when the peer does not answer as Windmill", async () => {
    const { server, baseUrl } = serve({
      tags: ["console"],
      version: "<html>some other service</html>",
    });

    const result = await checkInstanceCustomTag(
      baseUrl,
      credentials,
      "console",
    );

    server.stop(true);
    expect(result).toBe("unknown");
  });

  test("does not send the credentials to a peer that does not answer as Windmill", async () => {
    const { server, calls, baseUrl } = serve({
      tags: ["console"],
      version: "<html>some other service</html>",
    });

    await checkInstanceCustomTag(baseUrl, credentials, "console");

    server.stop(true);
    expect(calls).toEqual(["GET /api/version"]);
  });

  test("does not follow a redirect of the login to another destination", async () => {
    const other = serve({ tags: ["console"] });
    const { server, baseUrl } = serve({
      tags: ["console"],
      loginRedirectTo: `${other.baseUrl}/api/auth/login`,
    });

    await checkInstanceCustomTag(baseUrl, credentials, "console");

    server.stop(true);
    other.server.stop(true);
    expect(other.calls).toEqual([]);
  });

  test("stops after the login when the login is redirected", async () => {
    const other = serve({ tags: ["console"] });
    const { server, calls, baseUrl } = serve({
      tags: ["console"],
      loginRedirectTo: `${other.baseUrl}/api/auth/login`,
    });

    await checkInstanceCustomTag(baseUrl, credentials, "console");

    server.stop(true);
    other.server.stop(true);
    expect(calls).toEqual(["GET /api/version", "POST /api/auth/login"]);
  });

  test("probes the version before it logs in", async () => {
    const { server, calls, baseUrl } = serve({ tags: ["console"] });

    await checkInstanceCustomTag(baseUrl, credentials, "console");

    server.stop(true);
    expect(calls.slice(0, 2)).toEqual([
      "GET /api/version",
      "POST /api/auth/login",
    ]);
  });

  test("explains a refused login without echoing the body", async () => {
    const { server, baseUrl } = serve({ tags: [], loginStatus: 401 });
    const messages: string[] = [];

    await checkInstanceCustomTag(baseUrl, credentials, "console", (message) =>
      messages.push(message),
    );

    server.stop(true);
    expect(messages).toEqual(["login was refused (status 401)"]);
  });

  test("explains a failed custom tags request", async () => {
    const { server, baseUrl } = serve({ tags: [], tagsStatus: 500 });
    const messages: string[] = [];

    await checkInstanceCustomTag(baseUrl, credentials, "console", (message) =>
      messages.push(message),
    );

    server.stop(true);
    expect(messages).toEqual(["reading the custom tags failed (status 500)"]);
  });
});

describe("custom-tags.ts check", () => {
  const SCRIPT = resolve(import.meta.dir, "../../scripts/custom-tags.ts");

  async function runCheck(
    env: Record<string, string>,
  ): Promise<{ code: number; stderr: string }> {
    const proc = Bun.spawn(
      [process.execPath, "run", SCRIPT, "check", "console"],
      {
        env: { PATH: process.env.PATH ?? "", ...env },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stderr] = await Promise.all([
      new Response(proc.stderr).text(),
      new Response(proc.stdout).text(),
    ]);
    return { code: await proc.exited, stderr };
  }

  function adminEnv(baseUrl: string): Record<string, string> {
    return {
      WM_CHECK_BASE_URL: baseUrl,
      WM_ADMIN_EMAIL: "admin@example.com",
      WM_ADMIN_PASSWORD: "pw",
    };
  }

  test("exits 0 when the tag is allowed", async () => {
    const { server, baseUrl } = serve({ tags: ["console"] });

    const { code } = await runCheck(adminEnv(baseUrl));

    server.stop(true);
    expect(code).toBe(0);
  });

  test("exits with the dedicated code when the tag is not allowed", async () => {
    const { server, baseUrl } = serve({ tags: ["chromium"] });

    const { code } = await runCheck(adminEnv(baseUrl));

    server.stop(true);
    expect(code).toBe(10);
  });

  test("exits 2 when the login is refused", async () => {
    const { server, baseUrl } = serve({ tags: ["console"], loginStatus: 401 });

    const { code } = await runCheck(adminEnv(baseUrl));

    server.stop(true);
    expect(code).toBe(2);
  });

  test("prints the reason on stderr when the login is refused", async () => {
    const { server, baseUrl } = serve({ tags: ["console"], loginStatus: 401 });

    const { stderr } = await runCheck(adminEnv(baseUrl));

    server.stop(true);
    expect(stderr).toContain("login was refused (status 401)");
  });

  test("does not print the password on stderr", async () => {
    const { server, baseUrl } = serve({ tags: ["console"], loginStatus: 401 });

    const { stderr } = await runCheck({
      ...adminEnv(baseUrl),
      WM_ADMIN_PASSWORD: "very-secret-password",
    });

    server.stop(true);
    expect(stderr).not.toContain("very-secret-password");
  });

  test("exits 2 when the destination is not set", async () => {
    const { code } = await runCheck({
      WM_ADMIN_EMAIL: "admin@example.com",
      WM_ADMIN_PASSWORD: "pw",
    });

    expect(code).toBe(2);
  });

  test("does not fall back to WM_BASE_URL", async () => {
    const { server, calls, baseUrl } = serve({ tags: ["console"] });

    await runCheck({
      WM_BASE_URL: baseUrl,
      WM_ADMIN_EMAIL: "admin@example.com",
      WM_ADMIN_PASSWORD: "pw",
    });

    server.stop(true);
    expect(calls).toEqual([]);
  });

  test("exits 2 when the credentials are not set", async () => {
    const { server, baseUrl } = serve({ tags: ["console"] });

    const { code } = await runCheck({ WM_CHECK_BASE_URL: baseUrl });

    server.stop(true);
    expect(code).toBe(2);
  });
});
